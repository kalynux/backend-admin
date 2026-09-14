import { createAppError } from '../../../core/errors/app-error';
import { ERROR_CODES } from '../../../core/errors/error-codes';
import {
    AdminIdentity,
    AdminStatus,
    AdminTier,
    ADMIN_TIER_LABELS,
} from '../../admin-identity/domain/admin-identity.types';
import { IAdminAccount } from '../../admin-identity/models/admin-account.model';
import {
    AdminAccountRepository,
    ListAdminsFilter,
    UpdateAdminProfileInput,
} from '../../admin-identity/repositories/admin-account.repository';
import { generateStrongPassword, hash } from '../../admin-identity/domain/password.service';
import * as sessions from '../../admin-identity/domain/session.service';
import { assertMayActOn, assertMayCreate } from '../../authorization/domain/escalation.rules';
import { recordAuthorizationDenial } from '../../authorization/domain/denial.recorder';
import { AppError } from '../../../core/errors/app-error';
import * as approvals from '../../dual-control/domain/approval.service';
import { registerDualControlHandler } from '../../dual-control/domain/dual-control.registry';
import { IApprovalRequest } from '../../dual-control/models/approval-request.model';
import {
    appendOutcomeFacts,
    auditedAttempt,
    auditedQueue,
    auditedTransaction,
    auditedTransactionWithRow,
} from '../../audit/domain/audit.writer';
import { AuditAction } from '../../audit/domain/audit.catalog';
import { PermissionName } from '../../authorization/domain/permission.catalog';
import { AuditActor, AuditContext, AuditIntent } from '../../audit/domain/audit.types';
import { auditActorOf } from '../../audit/domain/audit-context';

/**
 * Administrator management — creating, levelling, suspending and signing out other
 * administrators.
 *
 * ── Why this is the riskiest module in the service ────────────────────────────
 * Every other surface acts on platform data. This one acts on the thing that decides who
 * may act at all, so a mistake here is not a bad write, it is a permanent unauthorized
 * administrator. That is why every write below goes through `assertMayActOn` /
 * `assertMayCreate` in addition to its permission, and why the check is a pure function
 * exhaustively tested rather than a condition inline in a controller.
 *
 * ── The two-layer rule, in one sentence ───────────────────────────────────────
 * The permission answers "may you manage administrators"; the escalation rules answer
 * "may you manage THIS one" — and neither is sufficient alone.
 *
 * ── Sessions are ended on every consequential change ──────────────────────────
 * Suspension, level change and password reset all destroy the target's live sessions.
 * `requireAdmin` re-reads status and tier on every request, so access is already correct
 * without this; what it buys is that the session's own record of itself
 * (`tier_at_login`, the token's `tier` claim) never outlives the fact it recorded.
 */

const accounts = new AdminAccountRepository();

// ─────────────────────────────────────────────────────────────────────────────
// DTO
// ─────────────────────────────────────────────────────────────────────────────

export interface AdministratorDto {
    id: string;
    email: string;
    displayName: string;
    tier: AdminTier;
    tierLabel: string;
    status: AdminStatus;
    jobTitle: string | null;
    department: string | null;
    timezone: string;
    preferredLanguage: string;
    mfaEnrolled: boolean;
    lastLoginAt: string | null;
    createdBy: string | null;
    suspendedAt: string | null;
    suspendedBy: string | null;
    suspendedReason: string | null;
    tierChangedAt: string | null;
    tierChangedBy: string | null;
    /** Null while pending, and null forever on the bootstrapped first administrator. */
    activatedAt: string | null;
    activatedBy: string | null;
    /** An id into `jovi_mall.files`, never a URL. Resolve through `GET /api/v1/files`. */
    avatarFileId: string | null;
    createdAt: string;
}

/**
 * Never returns `password_hash` or `mfa_secret`.
 *
 * The model's `toJSON` strips both as a backstop, but the DTO is the primary control:
 * this function decides what a response contains, and it is built by naming fields rather
 * than by deleting them from a spread.
 */
export function toAdministratorDto(admin: IAdminAccount): AdministratorDto {
    return {
        id: admin._id.toString(),
        email: admin.email,
        displayName: admin.display_name,
        tier: admin.tier,
        tierLabel: ADMIN_TIER_LABELS[admin.tier],
        status: admin.status,
        jobTitle: admin.job_title,
        department: admin.department,
        timezone: admin.timezone,
        preferredLanguage: admin.preferred_language,
        mfaEnrolled: admin.mfa_enrolled,
        lastLoginAt: admin.last_login_at ? admin.last_login_at.toISOString() : null,
        createdBy: admin.created_by ? admin.created_by.toString() : null,
        suspendedAt: admin.suspended_at ? admin.suspended_at.toISOString() : null,
        suspendedBy: admin.suspended_by ? admin.suspended_by.toString() : null,
        suspendedReason: admin.suspended_reason,
        tierChangedAt: admin.tier_changed_at ? admin.tier_changed_at.toISOString() : null,
        tierChangedBy: admin.tier_changed_by ? admin.tier_changed_by.toString() : null,
        activatedAt: admin.activated_at ? admin.activated_at.toISOString() : null,
        activatedBy: admin.activated_by ? admin.activated_by.toString() : null,
        avatarFileId: admin.avatar_file_id ? admin.avatar_file_id.toString() : null,
        createdAt: admin.created_at.toISOString(),
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

async function loadTarget(adminId: string): Promise<IAdminAccount> {
    const target = await accounts.findById(adminId);
    if (!target) {
        throw createAppError(ERROR_CODES.ADMIN_ACCOUNT_NOT_FOUND, 404);
    }
    return target;
}

/**
 * Queue an administrator action for a second pair of eyes, recording that it was queued.
 *
 * ── Why this wrapper exists ───────────────────────────────────────────────────
 * These three paths queued silently until Phase 12: `requestApproval` wrote the approval
 * row and nothing else, so a suspension or a promotion waiting on a second administrator
 * left no audit row at all — and if it then expired unapproved, no trace that anybody had
 * ever asked. The action performed on approval was audited; the *asking* was not.
 *
 * `auditedQueue` (built by the money port, which hit this first) commits the approval row
 * and the row recording it in ONE transaction. That pairing is the point: an audit-store
 * failure must not leave a pending request nobody can account for.
 *
 * The row it writes is the QUEUED ACTION at `status: 'queued'`, re-targeted at the
 * approval request with the administrator as the related target — so `searchByTarget`,
 * which `$or`s across both, still finds it on the account's history. There is deliberately
 * no separate `approvals.requested` row: it would say the same thing twice.
 *
 * ── Why the action and the permission are two parameters ──────────────────────
 * They are usually the same name and here they are not, which is the whole reason to pass
 * both. `administrators.suspend` and `administrators.reinstate` are two opposite acts under
 * ONE permission and one dual-control spec — the queue keys on the permission, the audit
 * row must name the act. Collapsing them would make a suspension and a reinstatement
 * indistinguishable in the feed, which is exactly the distinction a reviewer opens it for.
 */
function queueForApproval(
    action: AuditAction,
    permission: PermissionName,
    actor: AdminIdentity,
    context: AuditContext,
    target: { adminId: string; label?: string | null },
    payload: Record<string, unknown>,
): Promise<{ approval: approvals.ApprovalDto; created: boolean }> {
    return auditedQueue(
        {
            action,
            actor: auditActorOf(actor),
            target: { type: 'administrator', id: target.adminId, label: target.label ?? null },
            context,
            payload,
        },
        async (session) => {
            const result = await approvals.requestApproval({
                action: permission,
                requester: actor,
                targetType: 'administrator',
                targetId: target.adminId,
                payload,
                session,
            });
            return { result, approvalId: result.approval.id };
        },
    );
}

/** An audit intent for an action on another administrator. */
function intentFor(
    action: AuditAction,
    actor: AdminIdentity,
    context: AuditContext,
    target: { id: string | null; label?: string | null },
): AuditIntent {
    return {
        action,
        actor: auditActorOf(actor),
        target: { type: 'administrator', id: target.id, label: target.label ?? null },
        context,
    };
}

/**
 * Run the escalation rules, recording a denial through the one call site when they refuse.
 *
 * Wrapping rather than calling directly so that every refusal on this surface is logged
 * identically — an escalation attempt is the single most interesting thing this service
 * can observe, and it must not depend on each call site remembering to record it.
 */
function checkEscalation<T>(
    actor: AdminIdentity,
    targetId: string,
    context: AuditContext,
    run: () => T,
): T {
    try {
        return run();
    } catch (error) {
        if (error instanceof AppError && error.statusCode === 403) {
            recordAuthorizationDenial({
                kind: 'escalation',
                adminId: actor.adminId,
                tier: actor.tier,
                sessionId: actor.sessionId,
                required: [],
                reason: error.code,
                targetId,
                method: context.method,
                path: context.path,
                requestId: context.requestId,
                ip: context.ip,
                userAgent: context.userAgent,
            });
        }
        throw error;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────────────

export async function listAdministrators(
    filter: ListAdminsFilter,
): Promise<{ items: AdministratorDto[]; total: number }> {
    const { items, total } = await accounts.list(filter);
    return { items: items.map(toAdministratorDto), total };
}

export async function getAdministrator(adminId: string): Promise<AdministratorDto> {
    return toAdministratorDto(await loadTarget(adminId));
}

// ─────────────────────────────────────────────────────────────────────────────
// Create
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateAdministratorInput {
    email: string;
    displayName: string;
    tier: AdminTier;
    jobTitle?: string | null;
    department?: string | null;
    /** Supplied only in tests; production always generates and shows it once. */
    password?: string;
}

export interface CreatedAdministrator {
    administrator: AdministratorDto;
    /**
     * Shown ONCE, in this response, and stored nowhere else — same contract as the
     * bootstrap CLI. There is no email delivery in this service, so the creating
     * administrator is the delivery channel; making that explicit is better than a
     * password-reset link this service cannot send.
     */
    oneTimePassword: string;
}

export async function createAdministrator(
    actor: AdminIdentity,
    input: CreateAdministratorInput,
    context: AuditContext,
): Promise<CreatedAdministrator> {
    // Rule 4: an Admin can only ever mint Support. Only a Developer can create a peer
    // Developer, and only through the approval queue.
    const verdict = checkEscalation(actor, 'new', context, () => assertMayCreate(actor, input.tier));

    if (verdict.dualControlRequired) {
        // Creating a Developer is dual-controlled by the same rule that governs promoting
        // one. Rather than a second approval path, the account is created at the lowest
        // level and promoted through the queue — one reviewed step instead of two.
        throw createAppError(
            ERROR_CODES.AUTHZ_APPROVAL_REQUIRED,
            409,
            'Create the administrator at a lower level, then request a promotion to Developer — ' +
            'that path is reviewed by a second Developer',
        );
    }

    const password = input.password ?? generateStrongPassword();
    // Hashed OUTSIDE the transaction: bcrypt at cost 12 takes ~250 ms, and holding a
    // transaction open across it would pin a snapshot for no reason.
    const passwordHash = await hash(password);

    const administrator = await auditedTransaction(
        {
            ...intentFor('administrators.create', actor, context, { id: null, label: input.email }),
            // The generated password is NOT in the payload. `sanitiseState` would redact it
            // by name anyway; not putting it there is the first of the two locks.
            payload: { email: input.email, displayName: input.displayName, tier: input.tier },
        },
        async (session) => {
            // Inside the transaction, so two concurrent creations of the same email cannot
            // both pass the check. The unique index on `email` is the real guarantee; this
            // turns its 11000 into the specific code.
            if (await accounts.findByEmail(input.email, session)) {
                throw createAppError(ERROR_CODES.ADMIN_ACCOUNT_ALREADY_EXISTS, 409);
            }

            const created = await accounts.create({
                email: input.email,
                displayName: input.displayName,
                passwordHash,
                tier: input.tier,
                jobTitle: input.jobTitle ?? null,
                department: input.department ?? null,
                createdBy: actor.adminId,
            }, session);

            return {
                result: toAdministratorDto(created),
                target: { id: created._id.toString(), label: created.email },
                after: {
                    email: created.email,
                    displayName: created.display_name,
                    tier: created.tier,
                    jobTitle: created.job_title,
                    department: created.department,
                },
            };
        },
    );

    return { administrator, oneTimePassword: password };
}

// ─────────────────────────────────────────────────────────────────────────────
// Profile
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The five editable fields, before and after — never the whole account.
 *
 * ADR-005 D-8's named-field rule applied to storage: an audit row records what moved, not
 * a copy of the record. A whole-document snapshot would put a password hash one widened
 * projection away from the audit log.
 */
function profileState(account: IAdminAccount): Record<string, unknown> {
    return {
        displayName: account.display_name,
        jobTitle: account.job_title,
        department: account.department,
        timezone: account.timezone,
        preferredLanguage: account.preferred_language,
    };
}

/** Only the keys that actually differ, so a PATCH of one field audits one field. */
function changedFields(
    before: Record<string, unknown>,
    after: Record<string, unknown>,
): { before: Record<string, unknown>; after: Record<string, unknown> } {
    const changedBefore: Record<string, unknown> = {};
    const changedAfter: Record<string, unknown> = {};

    for (const key of Object.keys(after)) {
        if (before[key] === after[key]) continue;
        changedBefore[key] = before[key];
        changedAfter[key] = after[key];
    }

    return { before: changedBefore, after: changedAfter };
}

/** The caller editing their OWN profile. No permission and no escalation check needed. */
export async function updateOwnProfile(
    actor: AdminIdentity,
    input: UpdateAdminProfileInput,
    context: AuditContext,
): Promise<AdministratorDto> {
    return auditedTransaction(
        {
            ...intentFor('administrators.profile.update_self', actor, context, {
                id: actor.adminId,
                label: actor.email,
            }),
            payload: { ...input },
        },
        async (session) => {
            // Read inside the transaction — a `before` captured outside it may already have
            // been overwritten by the time the change commits.
            const current = await accounts.findById(actor.adminId, session);
            if (!current) throw createAppError(ERROR_CODES.ADMIN_ACCOUNT_NOT_FOUND, 404);

            const updated = await accounts.updateProfile(actor.adminId, input, session);
            if (!updated) throw createAppError(ERROR_CODES.ADMIN_ACCOUNT_NOT_FOUND, 404);

            const changed = changedFields(profileState(current), profileState(updated));
            return { result: toAdministratorDto(updated), before: changed.before, after: changed.after };
        },
    );
}

export async function updateAdministrator(
    actor: AdminIdentity,
    adminId: string,
    input: UpdateAdminProfileInput,
    context: AuditContext,
): Promise<AdministratorDto> {
    const target = await loadTarget(adminId);

    checkEscalation(actor, adminId, context, () =>
        assertMayActOn(actor, { adminId, tier: target.tier }, 'update'),
    );

    return auditedTransaction(
        {
            ...intentFor('administrators.update', actor, context, { id: adminId, label: target.email }),
            payload: { ...input },
        },
        async (session) => {
            const current = await accounts.findById(adminId, session);
            if (!current) throw createAppError(ERROR_CODES.ADMIN_ACCOUNT_NOT_FOUND, 404);

            const updated = await accounts.updateProfile(adminId, input, session);
            if (!updated) throw createAppError(ERROR_CODES.ADMIN_ACCOUNT_NOT_FOUND, 404);

            const changed = changedFields(profileState(current), profileState(updated));
            return { result: toAdministratorDto(updated), before: changed.before, after: changed.after };
        },
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Suspension
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every write on this surface either happens now or is queued for a second administrator.
 * One shape for both, so a controller answers 200 or 202 from the same value rather than
 * from a guess about which path it took.
 */
export type WriteOutcome =
    | { kind: 'applied'; administrator: AdministratorDto }
    | { kind: 'queued'; approval: approvals.ApprovalDto; created: boolean };

export async function suspendAdministrator(
    actor: AdminIdentity,
    adminId: string,
    reason: string,
    context: AuditContext,
): Promise<WriteOutcome> {
    const target = await loadTarget(adminId);

    const verdict = checkEscalation(actor, adminId, context, () =>
        assertMayActOn(actor, { adminId, tier: target.tier }, 'suspend'),
    );

    // A Developer suspending another Developer — the containment path. Queued, because
    // one compromised Developer must not be able to remove the others unilaterally.
    if (verdict.dualControlRequired) {
        // `administrators.suspend` is the PERMISSION; the audit action is the specific act,
        // so the queued row says which of the two opposite verbs was asked for.
        const result = await queueForApproval(
            'administrators.suspend',
            'administrators.suspend',
            actor,
            context,
            { adminId, label: target.email },
            { adminId, targetTier: target.tier, suspend: true, reason },
        );
        return { kind: 'queued', approval: result.approval, created: result.created };
    }

    return {
        kind: 'applied',
        administrator: await applySuspension(auditActorOf(actor), context, adminId, actor.adminId, reason),
    };
}

export async function reinstateAdministrator(
    actor: AdminIdentity,
    adminId: string,
    context: AuditContext,
): Promise<WriteOutcome> {
    const target = await loadTarget(adminId);

    const verdict = checkEscalation(actor, adminId, context, () =>
        assertMayActOn(actor, { adminId, tier: target.tier }, 'reinstate'),
    );

    // Restoring a suspended Developer grants Developer access to an account that has none
    // right now — as consequential as promoting one, and reviewed the same way.
    if (verdict.dualControlRequired) {
        const result = await queueForApproval(
            'administrators.reinstate',
            'administrators.suspend',
            actor,
            context,
            { adminId, label: target.email },
            { adminId, targetTier: target.tier, suspend: false },
        );
        return { kind: 'queued', approval: result.approval, created: result.created };
    }

    return {
        kind: 'applied',
        administrator: await applyReinstatement(auditActorOf(actor), context, adminId),
    };
}

/**
 * The write itself, shared by the direct path and the approval handler.
 *
 * ── Why the session revocation is AFTER the commit, not inside it ────────────
 * It used to sit inside this function, immediately after the account write. Wrapping that
 * in a transaction unchanged would have been wrong twice over:
 *
 *  1. Redis is not transactional. A rolled-back suspension — because the audit row failed,
 *     say — would still have signed the target out of every device. The account would be
 *     active and the person locked out, with nothing recording why.
 *  2. `withTransaction` RE-RUNS its callback on a transient error, so the Redis call would
 *     fire twice.
 *
 * So the transaction contains only `wi-admin` writes, and the revocation runs once the
 * commit has returned. The window between them is bounded by one round trip, and
 * `requireAdmin` re-reads the account on every request — so a suspended administrator is
 * refused on their very next call regardless, which is what makes the ordering safe.
 */
async function applySuspension(
    actor: AuditActor,
    context: AuditContext,
    adminId: string,
    by: string,
    reason: string,
    viaApprovalId?: string,
): Promise<AdministratorDto> {
    const { result: updated, auditId } = await auditedTransactionWithRow(
        {
            action: 'administrators.suspend',
            actor,
            target: { type: 'administrator', id: adminId, label: null },
            context: context,
            payload: { reason },
            viaApprovalId: viaApprovalId ?? null,
        },
        async (session) => {
            const current = await accounts.findById(adminId, session);
            if (!current) throw createAppError(ERROR_CODES.ADMIN_ACCOUNT_NOT_FOUND, 404);

            const result = await accounts.setSuspension(adminId, { by, reason }, session, current.status);
            if (!result) throw createAppError(ERROR_CODES.ADMIN_ACCOUNT_NOT_FOUND, 404);

            return {
                result,
                target: { label: result.email },
                before: { status: current.status },
                after: { status: result.status, reason },
            };
        },
    );

    // Post-commit. Immediate across every device: `requireAdmin` would refuse the next
    // request from a suspended account anyway, but leaving the sessions alive means the
    // suspension is enforced one request late on each of them.
    const sessionsEnded = await sessions.destroyAllSessions(adminId, 'account_suspended');

    // The count is only knowable here, so it is appended to the committed row rather than
    // lost. "How many devices did this cut off" is a question incident review always asks
    // and the row could not previously answer.
    await appendOutcomeFacts(auditId, { sessionsEnded });

    return toAdministratorDto(updated);
}

async function applyReinstatement(
    actor: AuditActor,
    context: AuditContext,
    adminId: string,
    viaApprovalId?: string,
): Promise<AdministratorDto> {
    const updated = await auditedTransaction(
        {
            action: 'administrators.reinstate',
            actor,
            target: { type: 'administrator', id: adminId, label: null },
            context: context,
            viaApprovalId: viaApprovalId ?? null,
        },
        async (session) => {
            const current = await accounts.findById(adminId, session);
            if (!current) throw createAppError(ERROR_CODES.ADMIN_ACCOUNT_NOT_FOUND, 404);

            // Put back what was there, not `active` — see the repository's ⚠ on this method.
            const result = await accounts.setSuspension(
                adminId,
                null,
                session,
                current.suspended_from_status ?? 'active',
            );
            if (!result) throw createAppError(ERROR_CODES.ADMIN_ACCOUNT_NOT_FOUND, 404);

            // The suspension columns are about to be cleared, taking with them the only
            // record that it happened. Capturing them here is what makes the audit trail
            // strictly better than the account row it describes.
            return {
                result,
                target: { label: result.email },
                before: {
                    status: current.status,
                    suspendedReason: current.suspended_reason,
                    suspendedAt: current.suspended_at?.toISOString() ?? null,
                },
                after: { status: result.status },
            };
        },
    );

    // No sessions to destroy — a suspended administrator has none.
    return toAdministratorDto(updated);
}

// ─────────────────────────────────────────────────────────────────────────────
// Level
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Change an administrator's level.
 *
 * Promoting to Developer returns `queued` rather than `applied`: the request is recorded
 * and a second Developer commits it. The caller answers 202 in that case — the action was
 * accepted, not refused, and conflating the two would make four-eyes look like a bug.
 */
export async function setAdministratorTier(
    actor: AdminIdentity,
    adminId: string,
    tier: AdminTier,
    context: AuditContext,
): Promise<WriteOutcome> {
    const target = await loadTarget(adminId);

    const verdict = checkEscalation(actor, adminId, context, () =>
        assertMayActOn(actor, { adminId, tier: target.tier }, 'set_tier', { newTier: tier }),
    );

    if (tier === target.tier) {
        // Not an error — the requested state is the current state. Returning it keeps the
        // endpoint idempotent instead of making a retry look like a failure.
        return { kind: 'applied', administrator: toAdministratorDto(target) };
    }

    if (verdict.dualControlRequired) {
        const result = await queueForApproval(
            'administrators.tier.set',
            'administrators.tier.set',
            actor,
            context,
            { adminId, label: target.email },
            { adminId, tier },
        );
        return { kind: 'queued', approval: result.approval, created: result.created };
    }

    return {
        kind: 'applied',
        administrator: await applyTierChange(
            auditActorOf(actor), context, adminId, tier, target.tier, actor.adminId,
        ),
    };
}

/**
 * The write itself, shared by the direct path and the approval handler.
 *
 * `expectedTier` makes it a compare-and-set: an approval can sit in the queue for a day,
 * and the target's level may have moved in the meantime. Applying blindly would silently
 * overwrite whatever happened while the request waited.
 */
async function applyTierChange(
    actor: AuditActor,
    context: AuditContext,
    adminId: string,
    tier: AdminTier,
    expectedTier: AdminTier,
    changedBy: string,
    viaApprovalId?: string,
): Promise<AdministratorDto> {
    const { result: updated, auditId } = await auditedTransactionWithRow(
        {
            action: 'administrators.tier.set',
            actor,
            target: { type: 'administrator', id: adminId, label: null },
            context: context,
            payload: { tier, expectedTier },
            viaApprovalId: viaApprovalId ?? null,
        },
        async (session) => {
            const result = await accounts.setTier(adminId, tier, expectedTier, changedBy, session);
            if (!result) {
                throw createAppError(
                    ERROR_CODES.AUTHZ_APPROVAL_ALREADY_RESOLVED,
                    409,
                    'This administrator’s level changed since the request was made',
                );
            }

            // `expectedTier` came from the compare-and-set filter, so it IS the level the
            // row held — no second read needed to know the `before`.
            return {
                result,
                target: { label: result.email },
                before: { tier: expectedTier },
                after: { tier: result.tier },
            };
        },
    );

    // Post-commit, and outside the transaction for the same reason as the suspension path:
    // Redis cannot roll back, and `withTransaction` may run its callback twice.
    //
    // The session's `tier_at_login` and its token's `tier` claim both describe the old
    // level. Access is already correct — the guard reads the account — but a session that
    // misdescribes itself is a bad thing to hand an audit trail.
    const sessionsEnded = await sessions.destroyAllSessions(adminId, 'tier_changed');
    await appendOutcomeFacts(auditId, { sessionsEnded });

    return toAdministratorDto(updated);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sessions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * List another administrator's sessions.
 *
 * ── The escalation check here is new, and it closes a real leak ──────────────
 * This ran `loadTarget` and nothing else, unlike every other operation on this surface.
 * `administrators.sessions.read` is swept into tier 2, so an Admin could enumerate a
 * **Developer's** live sessions — IP addresses and user agents included — while the
 * revoke route immediately below correctly refused to touch that same Developer.
 *
 * @param includeEnded merge in the durable history from `admin_sessions`. That collection
 *        is written on every login and stamped with one of nine end reasons, and until now
 *        **nothing read it**: an ended session vanished from every response, so "when was
 *        this person last signed in, and why did it end" was unanswerable from the API.
 */
export async function listAdministratorSessions(
    actor: AdminIdentity,
    adminId: string,
    context: AuditContext,
    options: { includeEnded?: boolean } = {},
): Promise<sessions.SessionSummary[]> {
    const target = await loadTarget(adminId);

    checkEscalation(actor, adminId, context, () =>
        assertMayActOn(actor, { adminId, tier: target.tier }, 'read_sessions'),
    );

    // No "current" session from another administrator's point of view — every one of
    // these belongs to someone else.
    if (!options.includeEnded) {
        return (await sessions.listSessions(adminId, '')).map(sessions.toSessionSummary);
    }

    return sessions.listSessionHistory(adminId);
}

export async function revokeAdministratorSessions(
    actor: AdminIdentity,
    adminId: string,
    context: AuditContext,
): Promise<{ revoked: number }> {
    const target = await loadTarget(adminId);

    checkEscalation(actor, adminId, context, () =>
        assertMayActOn(actor, { adminId, tier: target.tier }, 'revoke_sessions'),
    );

    // `auditedAttempt`, not `auditedTransaction`: the state lives in Redis, which cannot
    // join a Mongo transaction. The intent row is committed first, so an action that
    // cannot be recorded is not performed — and a crash mid-flight leaves a row at
    // `attempted` rather than no trace at all.
    const revoked = await auditedAttempt(
        intentFor('administrators.sessions.revoke', actor, context, {
            id: adminId,
            label: target.email,
        }),
        async () => {
            const count = await sessions.destroyAllSessions(adminId, 'revoked_by_admin');
            return { result: count, after: { sessionsEnded: count } };
        },
    );

    return { revoked };
}

/**
 * End ONE of another administrator's sessions.
 *
 * `destroyAllSessions` was the only option before this, which meant a single compromised
 * device could not be cut off without signing the person out everywhere. Same permission
 * and the same escalation rule as the bulk revoke — it is the same act, narrower.
 */
export async function revokeAdministratorSession(
    actor: AdminIdentity,
    adminId: string,
    sessionId: string,
    context: AuditContext,
): Promise<{ revoked: number }> {
    const target = await loadTarget(adminId);

    checkEscalation(actor, adminId, context, () =>
        assertMayActOn(actor, { adminId, tier: target.tier }, 'revoke_sessions'),
    );

    const revoked = await auditedAttempt(
        {
            action: 'administrators.sessions.revoke_one',
            actor: auditActorOf(actor),
            target: { type: 'admin_session', id: sessionId, label: null },
            context: context,
            // The administrator whose session this is — without it, an account history
            // would not show that one of their devices was cut off.
            relatedTarget: { type: 'administrator', id: adminId, label: target.email },
        },
        async () => {
            // Scoped to the named administrator: a session id alone must not be enough to
            // end an arbitrary session, or the escalation check above would be bypassable
            // by anyone who learned an id.
            const live = await sessions.listSessions(adminId, '');
            if (!live.some((entry) => entry.sessionId === sessionId)) {
                throw createAppError(ERROR_CODES.ADMIN_SESSION_NOT_FOUND, 404);
            }

            await sessions.destroySession(sessionId, adminId, 'revoked_by_admin');
            return { result: 1, after: { sessionsEnded: 1 } };
        },
    );

    return { revoked };
}

// ─────────────────────────────────────────────────────────────────────────────
// Password reset
// ─────────────────────────────────────────────────────────────────────────────

export async function resetAdministratorPassword(
    actor: AdminIdentity,
    adminId: string,
    context: AuditContext,
): Promise<{ administrator: AdministratorDto; oneTimePassword: string; sessionsEnded: number }> {
    const target = await loadTarget(adminId);

    checkEscalation(actor, adminId, context, () =>
        assertMayActOn(actor, { adminId, tier: target.tier }, 'reset_password'),
    );

    const password = generateStrongPassword();
    const passwordHash = await hash(password);

    const { result: updated, auditId } = await auditedTransactionWithRow(
        // No payload at all. The generated password is the entire input, and the one place
        // it may appear is the response body shown once to the caller.
        intentFor('administrators.password.reset', actor, context, {
            id: adminId,
            label: target.email,
        }),
        async (session) => {
            const result = await accounts.setPasswordHash(adminId, passwordHash, session);
            if (!result) throw createAppError(ERROR_CODES.ADMIN_ACCOUNT_NOT_FOUND, 404);

            // `passwordRotated`, not the password, not the hash — the fact is what an
            // auditor needs and the value is what they must never find here.
            return { result, after: { passwordRotated: true } };
        },
    );

    // Post-commit, like every other Redis call on this surface. Every existing session
    // dies: a reset that leaves the old sessions alive does not recover an account, it
    // just adds a second way in.
    const sessionsEnded = await sessions.destroyAllSessions(adminId, 'password_reset');
    await appendOutcomeFacts(auditId, { sessionsEnded });

    return {
        administrator: toAdministratorDto(updated),
        oneTimePassword: password,
        sessionsEnded,
    };
}

export interface ResetMfaResult {
    administrator: AdministratorDto;
    sessionsEnded: number;
}

/**
 * Clear another administrator's two-factor enrolment.
 *
 * ── The gap this closes ───────────────────────────────────────────────────────
 * A lost or wiped authenticator was terminal. `POST /auth/mfa/enroll` 409s once
 * `mfa_enrolled` is set, nothing cleared it, and MFA is mandatory for the senior tiers — so
 * the account became permanently unusable and the only remedy was editing Mongo by hand.
 * Phase 12 makes that an audited endpoint instead of an undocumented database operation.
 *
 * ── Why the sessions die ──────────────────────────────────────────────────────
 * Post-commit, like every other Redis call here. An administrator holding a live session
 * that was minted WITH a second factor keeps the benefit of a factor that no longer exists;
 * worse, if the reset is being used to recover a compromised account, the attacker's
 * session would survive the recovery. So the account is put back to "sign in, then enrol".
 *
 * The escalation rules run first, as on every write on this surface, and the permission is
 * `escalation`-flagged — so tier 1 only, and never on a peer whose level is not lower.
 */
export async function resetAdministratorMfa(
    actor: AdminIdentity,
    adminId: string,
    context: AuditContext,
): Promise<ResetMfaResult> {
    const target = await loadTarget(adminId);

    checkEscalation(actor, adminId, context, () =>
        assertMayActOn(actor, { adminId, tier: target.tier }, 'reset_mfa'),
    );

    const { result: updated, auditId } = await auditedTransactionWithRow<IAdminAccount>(
        {
            ...intentFor('administrators.mfa.reset', actor, context, { id: adminId, label: target.email }),
            // No payload: there is nothing to say beyond who and whom, and the one thing
            // this touches — the TOTP secret — must never appear in a row.
        },
        async (session) => {
            const result = await accounts.clearMfa(adminId, session);
            if (!result) throw createAppError(ERROR_CODES.ADMIN_ACCOUNT_NOT_FOUND, 404);

            return {
                result,
                before: { mfaEnrolled: target.mfa_enrolled },
                // `mfaCleared`, never the secret — the same rule `passwordRotated` follows.
                after: { mfaEnrolled: false, mfaCleared: true },
            };
        },
    );

    const sessionsEnded = await sessions.destroyAllSessions(adminId, 'mfa_reset');
    await appendOutcomeFacts(auditId, { sessionsEnded });

    return { administrator: toAdministratorDto(updated), sessionsEnded };
}

// ─────────────────────────────────────────────────────────────────────────────
// Dual-control handler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What a second Developer's approval actually does.
 *
 * Registered at module scope so it exists before `createApp()` asserts that every
 * dual-controlled action has a handler.
 *
 * Note what it re-checks. The approval may have waited a day: the target could have been
 * suspended, demoted or deleted, and the APPROVER's own level may differ from the
 * requester's. So the escalation rules run again, against the approver and against current
 * state — the verdict recorded at request time says nothing about the world now.
 */
registerDualControlHandler(
    'administrators.tier.set',
    async (approval: IApprovalRequest, approver, context) => {
        const adminId = String(approval.payload.adminId);
        const tier = Number(approval.payload.tier) as AdminTier;

        const target = await loadTarget(adminId);

        assertMayActOn(approver, { adminId, tier: target.tier }, 'set_tier', { newTier: tier });

        if (tier === target.tier) return;

        // The actor on the resulting audit row is the APPROVER, not the requester — they
        // are the one who performed it. `via_approval_id` is what ties the row back to the
        // request, so the pair reads as "X asked, Y did it".
        await applyTierChange(
            auditActorOf(approver), context, adminId, tier, target.tier, approver.adminId,
            approval._id.toString(),
        );
    },
);

/**
 * Suspending or reinstating a peer Developer, once a second Developer agrees.
 *
 * One handler for both directions: the payload says which, and the rules that permit
 * either are identical. Re-checked against current state for the same reason as the
 * promotion handler — a day can pass between the request and the approval.
 */
registerDualControlHandler(
    'administrators.suspend',
    async (approval: IApprovalRequest, approver, context) => {
        const adminId = String(approval.payload.adminId);
        const suspend = approval.payload.suspend === true;
        const approvalId = approval._id.toString();

        const target = await loadTarget(adminId);

        assertMayActOn(approver, { adminId, tier: target.tier }, suspend ? 'suspend' : 'reinstate');

        if (suspend) {
            const reason = typeof approval.payload.reason === 'string'
                ? approval.payload.reason
                : 'Suspended by administrator approval';
            await applySuspension(auditActorOf(approver), context, adminId, approver.adminId, reason, approvalId);
            return;
        }

        await applyReinstatement(auditActorOf(approver), context, adminId, approvalId);
    },
);
