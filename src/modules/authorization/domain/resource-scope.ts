import { AdminIdentity, AdminTier } from '../../admin-identity/domain/admin-identity.types';
import { ScopedResource } from './permission.types';

/**
 * Narrowing a permission to a SUBSET of the records it covers.
 *
 * `support.tickets.read` says a Support administrator may read tickets. It does not say
 * WHICH tickets, and "the whole queue including every payout dispute" is not the intended
 * answer. This is the third layer of the decision, after the permission and after the
 * escalation rules:
 *
 *   permission  → may you do this kind of thing at all
 *   escalation  → may you do it to this administrator
 *   scope       → which records of this kind are yours to see
 *
 * PHASE-0:269-270 found the platform has no row-level scoping mechanism anywhere — "there
 * is no existing mechanism to restrict a Support-tier admin to a subset". This is that
 * mechanism.
 *
 * ── The shape, and why it is a descriptor rather than a check ─────────────────
 * `resolveScope` returns a value the REPOSITORY folds into its query, mirroring
 * jovi-mall's `findByIdAndAgency` convention: the scope becomes part of the filter, so a
 * record outside it is not found rather than found-and-refused. Two consequences, both
 * wanted:
 *
 *   - no controller can forget it, because the query cannot be written without it
 *   - a scope miss is a 404, not a 403. A 403 confirms the record exists, which is
 *     exactly what a Support administrator probing for someone else's ticket wants to
 *     learn. Permission misses are 403; scope misses are 404.
 *
 * ── Honest status ─────────────────────────────────────────────────────────────
 * Tickets are ported at Phase 5, so nothing consumes this yet. It ships now, tested, with
 * the policy declared on the ticket permissions (`scope: 'tickets'` in the catalog), so
 * that phase wires a decided rule instead of inventing one per endpoint.
 */

export type ResourceScope =
    /** No narrowing — the caller sees every record of this kind. */
    | { kind: 'all' }
    /**
     * Only records assigned to one of these administrators, plus the unassigned queue, plus
     * anything held by an administrator of a tier in `alsoTiers`.
     *
     * Unassigned is included deliberately: an administrator who cannot see unclaimed work has
     * nothing to claim, and the queue stops moving. Every system ticket — payout, dispute,
     * booking refund — starts there.
     *
     * `alsoTiers` is what lets an Admin supervise Support without seeing a Developer's work.
     * It is a LIST rather than a "tier N and below" threshold because the tier numbers are
     * inverted (1 is the most privileged), so a threshold reads backwards at every call site
     * and is wrong the first time somebody adds a fourth tier in the middle.
     */
    | {
        kind: 'assigned';
        adminIds: readonly string[];
        includeUnassigned: boolean;
        /** Assignee tiers this administrator may also reach. Empty means own-only. */
        alsoTiers: readonly AdminTier[];
    }
    /**
     * Audit rows about the platform, plus anything this administrator did themselves.
     *
     * The complement is this service's own machinery — administrators, sessions,
     * approvals, exports — which stays invisible. The filter is built by
     * `audit/domain/audit-subject.ts`; this variant is the policy, that function is the
     * query.
     */
    | { kind: 'own_or_platform_subject'; adminId: string }
    /** Nothing. Returned for a resource the caller has no business reading at all. */
    | { kind: 'none' };

/**
 * Which records of `resource` this administrator may see.
 *
 * Mirrors jovi-mall's `VisibleAgentsService.resolve(role, entityId)` — the one place in
 * that codebase where a visibility policy is a resolver rather than a condition scattered
 * through queries.
 */
export function resolveScope(identity: AdminIdentity, resource: ScopedResource): ResourceScope {
    switch (resource) {
        case 'tickets':
            // A Developer runs the whole board: reassigning work, auditing a handling, and
            // seeing the payout-request tickets that back the payout queue.
            if (identity.tier === 1) {
                return { kind: 'all' };
            }

            /**
             * An Admin supervises Support, and stops there.
             *
             * This used to be `{ kind: 'all' }` alongside tier 1, and Phase 17 narrowed it:
             * an Admin sees their own tickets, the unclaimed queue, and anything a Support
             * administrator holds — but not a Developer's. Escalating to a Developer has to
             * mean something, and it means nothing if the person who escalated can still act
             * on the ticket afterwards.
             */
            if (identity.tier === 2) {
                return {
                    kind: 'assigned',
                    adminIds: [identity.adminId],
                    includeUnassigned: true,
                    alsoTiers: [3],
                };
            }

            // Support sees its own tickets and the unclaimed queue, and nothing else — not
            // even a peer's. Note this is also what stops a blanket "Support owns tickets"
            // rule from handing tier 3 indirect reach into the payout queue, which is backed
            // by PAYOUT_REQUEST tickets.
            return {
                kind: 'assigned',
                adminIds: [identity.adminId],
                includeUnassigned: true,
                alsoTiers: [],
            };

        case 'audit':
            // Developer and Admin read the whole trail — investigating an incident means
            // following it wherever it goes, including across administrator accounts.
            if (identity.tier === 1 || identity.tier === 2) {
                return { kind: 'all' };
            }
            // Support reads platform activity and its own actions. This is what lets
            // `audit.read` be granted to tier 3 at all: without it the feed would expose
            // the administrator directory that `tier-grants.ts` withholds from them.
            return { kind: 'own_or_platform_subject', adminId: identity.adminId };

        default: {
            // Exhaustiveness: adding a ScopedResource without a policy fails to compile
            // rather than silently defaulting to `all`.
            const unreachable: never = resource;
            return unreachable;
        }
    }
}

/**
 * Who holds a ticket — the id AND the tier, because the scope is decided by both.
 *
 * The tier is read from the SNAPSHOT stored on the ticket, not looked up: administrators
 * live in this service's database and tickets live in jovi-mall's, so no query can join
 * them. That is also why the tier is denormalised onto the row in the first place — without
 * it, `alsoTiers` is not expressible as a filter, and a scope that is not a filter is one a
 * controller can forget.
 */
export interface TicketAssignee {
    adminId: string;
    tier: AdminTier;
}

/**
 * Whether a single TICKET falls inside a scope.
 *
 * ── Renamed from `isInScope`, and the rename is the point ────────────────────
 * Its parameter is `assignedTo` — an assignment, which only tickets have. Behind the
 * generic name it looked like it could answer the question for any scoped resource, and
 * the `audit` scope is one it cannot answer at all: an audit row has no assignee, and
 * feeding one `null` would return `includeUnassigned` — a value that means nothing here
 * and happens to be `true`. A function that silently returns the wrong answer is worse
 * than one that does not exist, so the name now says what it is for.
 *
 * The audit scope is applied as a query filter instead (`audit-subject.ts`), which is the
 * preferred form anyway: a scope folded into the query is one nobody can forget.
 */
export function isTicketInScope(scope: ResourceScope, assignee: TicketAssignee | null): boolean {
    switch (scope.kind) {
        case 'all':
            return true;
        case 'none':
            return false;
        case 'assigned':
            if (assignee === null) return scope.includeUnassigned;
            if (scope.adminIds.includes(assignee.adminId)) return true;
            return scope.alsoTiers.includes(assignee.tier);
        case 'own_or_platform_subject':
            // Not answerable from an assignee. Reaching here means a caller passed an
            // audit scope to the ticket predicate, which is a programming error — fail
            // closed rather than guess.
            return false;
    }
}
