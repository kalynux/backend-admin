import { createAppError } from '../../../core/errors/app-error';
import { ERROR_CODES } from '../../../core/errors/error-codes';
import { AdminTier, ADMIN_TIERS, ADMIN_TIER_LABELS } from '../../admin-identity/domain/admin-identity.types';
import { PERMISSION_NAMES, PermissionName, isPermissionName, permissionSpec } from './permission.catalog';
import { PermissionAction, PermissionFamily, isSensitive } from './permission.types';

/**
 * Which permissions each administrator level holds.
 *
 * This file IS the authorization policy. Nothing else decides who may do what — there
 * are no per-admin overrides, no database rows, and no runtime editing, by ADR-003.
 * Changing what a level can do means changing this file and shipping it, which is the
 * property ADR-001 Decision 5 was protecting and this design keeps.
 *
 * ── Remember the inversion ────────────────────────────────────────────────────
 * Lower tier number = MORE privilege. 1 Developer, 2 Admin, 3 Support.
 *
 * ── Why there is no wildcard ──────────────────────────────────────────────────
 * A `'*'` grant would silently hand a tier every permission added later, including one
 * introduced next quarter for a job nobody has thought about yet. `allInFamily()` is the
 * bounded version: it expands a family at module load, and it REFUSES to expand anything
 * flagged financial, escalation, destructive or dual-controlled. Those must be typed out
 * by hand, so a tier only holds a sharp permission because a human wrote its name down.
 *
 * That is the mechanical form of the rule "a read-family grant must never sweep in a
 * write that moves money" — PHASE-0:274 found exactly that defect in the legacy service,
 * where `GET /admin/cod/overview` and `POST /admin/cod/deposits` share one guard.
 */

/**
 * Every non-sensitive permission in a family, optionally narrowed to one action.
 *
 * Expanded once, at module load. Sensitive entries are excluded — see the header. Use it
 * for the bulk of a family and name the sharp edges explicitly beside it.
 */
export function allInFamily(family: PermissionFamily, action?: PermissionAction): PermissionName[] {
    return PERMISSION_NAMES.filter((name) => {
        const spec = permissionSpec(name);
        if (spec.family !== family) return false;
        if (action !== undefined && spec.action !== action) return false;
        return !isSensitive(spec);
    });
}

/**
 * Combine grant sources, keeping first-seen order and dropping repeats.
 *
 * A higher tier is built from the tier below it plus its own families, and the two
 * legitimately overlap — `SUPPORT` names `agents.read` explicitly, and
 * `allInFamily('agents')` produces it again. Deduplicating here keeps a tier's list a
 * clean statement of what it holds rather than a list with nine incidental repeats in it.
 */
function union(...sources: readonly (readonly PermissionName[])[]): PermissionName[] {
    return [...new Set(sources.flat())];
}

// ─────────────────────────────────────────────────────────────────────────────
// Tier 3 — Support
//
// Ticket work, plus the lookups needed to answer a ticket: who is this customer, what
// happened to their order, which agent has the shipment. Nothing financial, nothing
// destructive, no sight of the administrator directory.
//
// Those lookups were the whole of it until Phase 5 A.6, which added editorial write on
// articles and bylines — the one write surface here that is not a ticket. It is still
// nothing financial and nothing destructive: what it adds is prose, and the decision of
// what the public sees stays a tier above (`content.articles.publish`).
// ─────────────────────────────────────────────────────────────────────────────
const SUPPORT: readonly PermissionName[] = union(allInFamily('support'), [

    // The lookups a support conversation needs. Read-only, every one of them.
    // `customers.read` sat between these two until Phase 5 Part D deleted it (ADR-017 D-1).
    // Nothing was lost here: `users.read` answers the same question with `?role=customer`,
    // and it is the permission the route actually checks.
    'users.read',
    'vendors.read',
    'agents.read',
    'agencies.read',

    /**
     * Live tracking data from geo-tracker — the sharpest read on this surface, and it is
     * here on purpose (Phase 6.I).
     *
     * "Where is my delivery right now" is one of the commonest things a ticket asks, and
     * it is the question Support opens the screen for. Withholding it means every such
     * ticket escalates to a tier that has no more context than the person already holding
     * it — the same argument that put `money.payments.read` on this list.
     *
     * What bounds it is not this grant. It is the record: every read under this permission
     * that emits coordinates commits an audit row BEFORE the disclosure and does not catch
     * a failure of that write, so with the audit store down nothing is disclosed. That is
     * the `money.payouts.destination.read` posture, applied one tier lower because the
     * question is one tier lower. See `agents/domain/tracking-disclosure.ts`.
     *
     * The other bound is on the far side: geo-tracker's own scope model refuses a trail
     * that is not scoped to one shipment, so no permission here can produce "where has
     * this person been this week".
     *
     * The two halves are separate permissions because they are separate exposures — live
     * surveillance of a person, versus a case file about a delivery. Support holds both;
     * an operator can still grant them apart, which is the point of the split.
     */
    'agents.tracking.read',
    'shipments.tracking.read',
    'orders.read',
    'orders.disputes.read',
    'shipments.read',
    'notifications.read',

    /**
     * Turning a file id into a picture.
     *
     * Held at every tier, including this one, because it discloses nothing the caller did
     * not already have: they are holding an id that arrived on a record they were allowed
     * to read. Withholding it would mean a Support agent looking at a vendor sees the
     * shop's name and a grey square where its logo is, which helps nobody and looks like
     * a fault rather than a policy.
     *
     * It RESOLVES an explicit id set and cannot enumerate — `files.orphans.read` is the
     * listing, and it is not here.
     */
    'files.resolve',

    /**
     * Opening the file itself — and the reasoning above does **not** stretch to cover it,
     * which is why it is a second name rather than part of the first (BR-011).
     *
     * `files.resolve` discloses a name and a size. This discloses **the picture**, and for
     * a private tree that means a delivery-proof photograph: a place, a time, usually a
     * residence, sometimes a person. Resolving is the second half of a read the caller
     * already made; opening is a new disclosure.
     *
     * It is here anyway, and for the same reason `agents.tracking.read` is: "the courier
     * says they delivered it and I never got it" is a Support ticket, the proof photo is
     * the answer to it, and a Support agent who cannot see it escalates a ticket to
     * somebody who knows less about it than they do.
     *
     * **What bounds it is not this grant — it is the record.** Every read commits an audit
     * row BEFORE the bytes are fetched, and the write is not caught, so with the audit
     * store unreachable nothing is disclosed. That is the
     * `money.payouts.destination.read` posture, applied one tier lower because the
     * question is one tier lower — the same trade, and the same wording, as the tracking
     * grants above. Widening the audience and adding the record were one decision.
     */
    'files.content.read',

    /**
     * Gateway settlements. "Did my payment go through, and was I refunded" is one of the
     * commonest things a ticket asks, and answering it from the order alone is guesswork —
     * `payment_status` says what the order believes, not what the gateway did.
     *
     * Safe at this tier because the sharp fields are removed by PROJECTION rather than by
     * permission: the raw gateway payload, the payload hash and the idempotency key never
     * leave the repository, for anyone. What Support sees is an amount, a status, a
     * gateway name and a reference — the same facts the customer is holding a receipt for.
     *
     * Note this is a settlement READ and grants nothing over money: refunds are
     * `orders.refund`, which is Admin and flagged `financial`.
     */
    'money.payments.read',

    /**
     * The audit trail — and the one entry here that is not a plain lookup.
     *
     * What Support actually sees is decided PER ROW by `auditScopeFilter`, not by this
     * grant: platform activity (the four actor types, orders, shipments, tickets, and the
     * COD cash chain) plus anything they did themselves. Rows about this service's own
     * machinery — administrators, approvals, exports — are invisible to them, so the feed
     * cannot become a side door onto the administrator directory withheld above.
     *
     * Note what this does and does not grant: Support can SEE the record of a money action
     * without holding any permission to perform one. That is a read of history, not a
     * capability, so the assertion below that refuses `financial` to tier 3 is untouched.
     *
     * `audit.export` is deliberately NOT here — it is flagged `destructive` because an
     * export is the precondition for deletion, and the boot check refuses it to tier 3.
     */
    'audit.read',

    /**
     * Editorial work — the one WRITE surface at this tier (Phase 17 D-2, Phase 5 A.6).
     *
     * Support may write prose and may not decide what the public sees. Reading and editing
     * an article or a byline is copy work; `content.articles.publish` is an editorial
     * decision and `content.articles.delete` / `content.authors.delete` remove a record.
     * None of those three is here.
     *
     * ── Why these are typed out rather than `allInFamily('content')` ──────────
     * The instinct is that the family form would be safe because `allInFamily()` refuses to
     * expand anything sensitive, and the two `delete` names are `destructive: true`. It
     * refuses those two — and it does NOT refuse `content.articles.publish`, which carries
     * no flag at all. `allInFamily('content')` expands to five names, publish among them,
     * so the family form would hand Support the one permission D-2 exists to withhold.
     *
     * The flag is not the mechanism here. Typing four names is.
     *
     * ── Support may edit a PUBLISHED article (O-1) ────────────────────────────
     * `content.articles.write` is not narrowed to drafts, deliberately. A "write" that
     * stops at a state boundary is a rule nobody can infer from the permission's name, and
     * the boundary defends nothing that is not already defended: pulling a live article
     * down requires `publish`, which Support does not hold. What is left is a Support
     * administrator fixing a typo in live prose, which is the reason to grant this at all.
     */
    'content.articles.read',
    'content.articles.write',
    'content.authors.read',
    'content.authors.write',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Tier 2 — Admin
//
// The operational tier: runs the platform day to day, including the money. Everything
// Support has, plus the write surface of every business domain.
//
// Withheld deliberately: `administrators.tier.set` (changing anyone's level is a
// Developer act), `files.delete` (unrecoverable), `users.roles.manage` (re-grants
// platform-wide capability), and all of `developer_tools`.
// ─────────────────────────────────────────────────────────────────────────────
const ADMIN: readonly PermissionName[] = union(
    // Nesting is deliberate and asserted below: an Admin can do anything Support can.
    // The overlap with the families below is why this is a union rather than a spread.
    SUPPORT,

    // Bulk, non-sensitive, by family.
    allInFamily('agents'),
    allInFamily('agencies'),
    allInFamily('billing'),
    allInFamily('cod'),
    allInFamily('money'),
    allInFamily('orders'),
    allInFamily('content'),
    allInFamily('files'),
    allInFamily('messaging'),
    allInFamily('users'),
    allInFamily('vendors'),
    // `allInFamily('customers')` was here. Deleted with the family at Phase 5 Part D
    // (ADR-017 D-1) — it was the tier-2 half of a grant that backed no route.
    allInFamily('shipments'),
    allInFamily('notifications'),
    allInFamily('system'),
    allInFamily('audit'),
    allInFamily('approvals'),
    allInFamily('permissions'),
    // Expands to read, create, update, sessions.read, sessions.revoke and password.reset.
    // `administrators.tier.set` is escalation-flagged and `administrators.suspend` is
    // dual-controlled, so neither is swept in — the second is granted by name below.
    allInFamily('administrators'),

    // ── Sensitive, named one by one. This block is the money surface. ────────
    // An Admin confirms remittances, resolves discrepancies and marks payouts paid —
    // that IS the operational job. What stops it being unbounded is that each name had
    // to be written here, and that Phase 5 endpoints carrying an amount threshold will
    // additionally queue for a second approver via their `dualControl` spec.
    [
        'agents.cod_threshold.set',
        'agents.ban',
        'agencies.deactivate',
        'billing.subscriptions.assign',
        'cod.remittances.confirm',
        'cod.remittances.reject',
        'cod.deposits.create',
        'cod.deposits.confirm',
        'cod.deposits.reject',
        'cod.discrepancies.resolve',
        'cod.trust.adjust',
        'money.payouts.mark_paid',
        'money.payouts.reject',

        // Revealing a beneficiary's account number. Flagged `financial` — so it is here
        // by name rather than by family, and the assertion below refuses it to Support.
        //
        // Granted to Admin because an Admin is who actually sends the money: they hold
        // `money.payouts.mark_paid`, and marking a payout paid without being able to see
        // where it goes is a workflow that sends people back to jovi-mall, which is what
        // the cutover exists to stop. What bounds it is not the grant but the record —
        // every reveal writes an audit row naming the payout.
        'money.payouts.destination.read',
        'orders.disputes.resolve',
        'orders.refund',
        'content.articles.delete',
        'content.authors.delete',
        'shipments.cancel',

        /**
         * Named at Phase 11, when the route that needs it was built.
         *
         * It was catalogued as `destructive` at Phase 3 and left out of this block — with
         * no route declaring it, nobody noticed that `allInFamily('billing')` refuses to
         * expand a destructive entry, so it reached tier 1 and nothing else. Shipping
         * `DELETE /billing/plans/:planId` on that footing would have put a button on the
         * Admin dashboard that 403s for every Admin: "a route declares it, every caller is
         * refused, and the endpoint looks broken rather than forbidden" — the same failure
         * the granted-to-no-tier assertion below exists to prevent, one tier up.
         *
         * Granted here because archiving a tier is ordinary catalog work and the exact
         * analogue of `content.articles.delete` two lines above. It is also the mildest
         * `destructive` in the catalog: jovi-mall soft-deletes, existing subscribers keep
         * running on the plan until their term ends, and `?includeArchived=true` reads the
         * row back. What bounds it is that the name had to be typed here.
         */
        'billing.plans.delete',

        // Dual-controlled, and granted here deliberately. An Admin suspending a Support
        // administrator is ordinary work and happens immediately; the approval only
        // engages when the target is a Developer, which rule 2 already puts out of an
        // Admin's reach.
        'administrators.suspend',

        // Named by hand because it is flagged `destructive`, so `allInFamily('audit')`
        // refuses to expand it. Granted to Admin because running a compliance export is
        // operational work — and withheld from Support because the same act is what makes
        // an audit row eligible for deletion.
        'audit.export',
    ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Tier 1 — Developer
//
// Everything, derived from the catalog rather than enumerated.
//
// Deriving is safe HERE and only here. The danger a wildcard creates is a LOWER tier
// silently acquiring a permission added later; tier 1 is defined as "holds everything",
// so deriving it states that definition instead of re-encoding it as ninety names that
// can drift. Tiers 2 and 3 are explicit for exactly the opposite reason.
// ─────────────────────────────────────────────────────────────────────────────
const DEVELOPER: readonly PermissionName[] = [...PERMISSION_NAMES];

export const TIER_GRANTS: Readonly<Record<AdminTier, readonly PermissionName[]>> = Object.freeze({
    1: DEVELOPER,
    2: ADMIN,
    3: SUPPORT,
});

/**
 * Refuse to start on an inconsistent policy.
 *
 * Called from `createApp()` before any route mounts. A service running with a broken
 * grant table is worse than a service that is down: it looks like it is working, and the
 * failure is someone reaching something they should not.
 *
 * Every check here encodes a rule stated in the catalog's flags, so the flags are load
 * bearing rather than documentation.
 */
export function assertGrantTableValid(): void {
    const problems: string[] = [];

    const granted = new Set<PermissionName>();

    for (const tier of ADMIN_TIERS) {
        const names = TIER_GRANTS[tier];
        const label = `tier ${tier} (${ADMIN_TIER_LABELS[tier]})`;
        const seen = new Set<string>();

        for (const name of names) {
            if (!isPermissionName(name)) {
                problems.push(`${label} grants "${String(name)}", which is not in the catalog`);
                continue;
            }
            if (seen.has(name)) {
                problems.push(`${label} lists "${name}" more than once`);
                continue;
            }
            seen.add(name);
            granted.add(name);

            const spec = permissionSpec(name);

            // Privilege changes are a Developer act. Nothing else may hold one.
            if (spec.escalation && tier !== 1) {
                problems.push(`${label} grants the escalation permission "${name}" — tier 1 only`);
            }
            // Support never touches money, and never does anything unrecoverable.
            if (tier === 3 && spec.financial) {
                problems.push(`${label} grants the financial permission "${name}"`);
            }
            if (tier === 3 && spec.destructive) {
                problems.push(`${label} grants the destructive permission "${name}"`);
            }
            // Developer tools re-run side effects against live data or reveal how the
            // platform is wired. Neither belongs below tier 1.
            if (spec.family === 'developer_tools' && tier !== 1) {
                problems.push(`${label} grants "${name}" — the developer_tools family is tier 1 only`);
            }
        }
    }

    // A permission nobody holds is dead policy: a route declares it, every caller is
    // refused, and the endpoint looks broken rather than forbidden.
    for (const name of PERMISSION_NAMES) {
        if (!granted.has(name)) {
            problems.push(`"${name}" is in the catalog but granted to no tier`);
        }
    }

    // Privilege nests: anything Support can do, an Admin can do, and a Developer can do
    // everything. A hole here means a lower tier reaching something a higher one cannot,
    // which is always a mistake rather than a policy.
    const admin = new Set<PermissionName>(TIER_GRANTS[2]);
    const developer = new Set<PermissionName>(TIER_GRANTS[1]);
    for (const name of TIER_GRANTS[3]) {
        if (!admin.has(name)) problems.push(`tier 3 holds "${name}" but tier 2 does not`);
    }
    for (const name of TIER_GRANTS[2]) {
        if (!developer.has(name)) problems.push(`tier 2 holds "${name}" but tier 1 does not`);
    }

    // A dual-controlled action whose approver permission does not exist can never be
    // approved — the request would queue forever.
    for (const name of PERMISSION_NAMES) {
        const spec = permissionSpec(name);
        if (spec.dualControl && !isPermissionName(spec.dualControl.approverPermission)) {
            problems.push(
                `"${name}" requires approval from "${spec.dualControl.approverPermission}", which is not in the catalog`,
            );
        }
    }

    if (problems.length > 0) {
        throw createAppError(
            ERROR_CODES.AUTHZ_GRANT_TABLE_INVALID,
            500,
            `The tier permission table is inconsistent:\n  - ${problems.join('\n  - ')}`,
            { problemCount: problems.length, problems },
        );
    }
}
