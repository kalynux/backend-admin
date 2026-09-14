import { createAppError } from '../../../core/errors/app-error';
import { ERROR_CODES } from '../../../core/errors/error-codes';
import { AdminIdentity } from '../../admin-identity/domain/admin-identity.types';
import { AdminAccountRepository } from '../../admin-identity/repositories/admin-account.repository';
import { auditedTransaction } from '../../audit/domain/audit.writer';
import { auditActorOf } from '../../audit/domain/audit-context';
import { AuditContext } from '../../audit/domain/audit.types';
import { EmployeeRecordRepository } from '../../employees/repositories/employee-record.repository';
import { assessReadiness } from '../../employees/domain/employee-readiness';
import { AdministratorDto, toAdministratorDto } from './administrator.service';

/**
 * ─── Letting somebody in ─────────────────────────────────────────────────────
 *
 * The one act that turns a `pending` administrator into a working one (ADR-023 D-1).
 *
 * ── ⚠ TIER 1 ONLY, and the reason is the visibility rule rather than seniority ──
 * `administrators.activate` is `escalation: true`, so `allInFamily('administrators')` — which
 * tier 2 holds — cannot sweep it in, and the boot assertion keeps it off tiers 2 and 3.
 *
 * That is not because activation is an especially senior act. It is because activation
 * REQUIRES READING THE EMPLOYEE RECORD, and only tier 1 may read one. An Admin able to
 * activate would be an Admin waving through a person whose file they are not allowed to open
 * — a rubber stamp dressed as a decision, which is precisely the defect the applicant-side
 * KYC module was built to fix.
 *
 * The consequence is real and was accepted deliberately: a tier-2 Admin can still CREATE a
 * Support account (they hold `administrators.create`) and cannot turn it on. Every new hire
 * waits on a Developer.
 *
 * ── ⚠ NOT dual-controlled, unlike promoting to Developer ────────────────────
 * Promotion to tier 1 takes two Developers, because it creates a peer who could remove them.
 * Activation does not: it lets somebody hold the level they were CREATED at, and that level
 * was already chosen by whoever created them under `assertMayCreate`. Requiring a quorum here
 * would put four eyes on admitting a Support agent while one pair still admits them to the
 * level in the first place — a control in the wrong place, paid for on every hire.
 *
 * ── ⚠ There is deliberately NO REJECT ───────────────────────────────────────
 * "Do not let this person in" is already expressible, and `suspend` expresses it: it takes a
 * mandatory reason, it is audited under its own action, it destroys sessions, and it is
 * reversible by a named act with its own permission. A second refusal verb would be a second
 * state to reason about — and the question "is this account `rejected` or `suspended`, and
 * which routes does each reach" has no good answer.
 */

const accounts = new AdminAccountRepository();
const records = new EmployeeRecordRepository();

export async function activateAdministrator(
    actor: AdminIdentity,
    adminId: string,
    context: AuditContext,
): Promise<AdministratorDto> {
    const target = await accounts.findById(adminId);
    if (!target) throw createAppError(ERROR_CODES.ADMIN_ACCOUNT_NOT_FOUND, 404);

    /**
     * ⚠ **Self-activation is refused, and it is checked HERE rather than left to the
     * escalation rules.**
     *
     * `assertMayActOn` already carries a no-self-action rule, and it is not reached on this
     * path — activation takes no `assertMayActOn` call, because the rules are written about
     * suspending, reinstating and re-levelling an account, and activation is none of those.
     * Rather than widen a pure function that is exhaustively tested against three verbs, the
     * one rule that matters here is stated where it applies.
     *
     * Why it matters at all: a tier-1 Developer created `pending` by another Developer could
     * otherwise sign in and activate themselves, which would make the whole gate decorative.
     */
    if (adminId === actor.adminId) {
        throw createAppError(
            ERROR_CODES.ADMIN_ACTIVATION_SELF,
            403,
            'You cannot activate your own account — another Developer must do it',
        );
    }

    if (target.status === 'active') {
        /**
         * Idempotent, not an error.
         *
         * Two Developers clicking the same button, or one retrying after a timeout, is not a
         * fault and must not read as one. `setTier` takes the same position for the same
         * reason. Nothing is written and nothing is audited — the row belongs to the
         * activation that actually happened.
         */
        return toAdministratorDto(target);
    }

    if (target.status === 'suspended') {
        /**
         * ⚠ Refused, and this is the guard the repository's compare-and-set would enforce
         * anyway — stated here so the caller gets a message naming the right act.
         *
         * Re-admitting a suspended administrator is a REINSTATEMENT: a different permission, a
         * different audit action, and one that is dual-controlled when the target is a
         * Developer. Activation must never become a back door around that.
         */
        throw createAppError(
            ERROR_CODES.ADMIN_ACTIVATION_SUSPENDED,
            409,
            'This account is suspended. Reinstate it instead — activation does not lift a suspension',
        );
    }

    /**
     * The required set (ADR-023 D-5).
     *
     * ⚠ Read BEFORE the transaction and re-read inside it. The outer read produces the
     * message; the inner one is the guarantee, because an employee could finish their record
     * — or a field could be cleared — between the two. Without the re-read, the gate would be
     * checking a state the write does not commit against.
     */
    const gaps = assessReadiness(target, await records.findByAdminId(adminId));
    if (!gaps.ready) {
        throw createAppError(
            ERROR_CODES.ADMIN_ACTIVATION_INCOMPLETE,
            422,
            'This administrator’s employee record is not complete enough to activate',
            {
                /**
                 * The gaps are in `details`, which reaches the client for a `business_rule`
                 * error. That is the point: a Developer who cannot see WHAT is missing has to
                 * go and compare two screens, and the employee is the person who can fix it.
                 * The codes are stable, so the dashboard renders the same checklist the
                 * employee sees on their own record.
                 */
                gaps: gaps.gaps,
            },
        );
    }

    return auditedTransaction(
        {
            action: 'administrators.activate',
            actor: auditActorOf(actor),
            target: { type: 'administrator', id: adminId, label: target.email },
            context,
            payload: { tier: target.tier },
        },
        async (session) => {
            const fresh = await accounts.findById(adminId, session);
            if (!fresh) throw createAppError(ERROR_CODES.ADMIN_ACCOUNT_NOT_FOUND, 404);

            // Re-read inside the transaction — see the ⚠ above.
            const inner = assessReadiness(fresh, await records.findByAdminId(adminId, session));
            if (!inner.ready) {
                throw createAppError(
                    ERROR_CODES.ADMIN_ACTIVATION_INCOMPLETE,
                    422,
                    'This administrator’s employee record is not complete enough to activate',
                    { gaps: inner.gaps },
                );
            }

            const activated = await accounts.activate(adminId, actor.adminId, session);
            if (!activated) {
                /**
                 * The compare-and-set missed: somebody else moved the status between the
                 * checks above and this write. A conflict, not a 404 — the account exists and
                 * the caller's view of it is simply stale.
                 */
                throw createAppError(
                    ERROR_CODES.ADMIN_ACTIVATION_CONFLICT,
                    409,
                    'This account is no longer pending — reload it and check its current status',
                );
            }

            return {
                result: toAdministratorDto(activated),
                target: { id: adminId, label: activated.email },
                before: { status: 'pending' },
                after: { status: activated.status, tier: activated.tier },
            };
        },
    );
}
