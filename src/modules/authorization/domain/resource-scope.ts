import { AdminIdentity } from '../../admin-identity/domain/admin-identity.types';
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
     * Only records assigned to one of these administrators, plus the unassigned queue.
     * Unassigned is included deliberately: a Support administrator who cannot see
     * unclaimed work has nothing to claim, and the queue stops moving.
     */
    | { kind: 'assigned'; adminIds: readonly string[]; includeUnassigned: boolean }
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
            // Developer and Admin run the support function and need the whole board:
            // reassigning work, auditing a handling, and seeing the payout-request tickets
            // that back the payout queue.
            if (identity.tier === 1 || identity.tier === 2) {
                return { kind: 'all' };
            }
            // Support sees its own tickets and the unclaimed queue. Note this is what
            // stops a blanket "Support owns tickets" rule from handing tier 3 indirect
            // reach into the payout queue, which is backed by PAYOUT_REQUEST tickets.
            return { kind: 'assigned', adminIds: [identity.adminId], includeUnassigned: true };

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
export function isTicketInScope(scope: ResourceScope, assignedTo: string | null): boolean {
    switch (scope.kind) {
        case 'all':
            return true;
        case 'none':
            return false;
        case 'assigned':
            if (assignedTo === null) return scope.includeUnassigned;
            return scope.adminIds.includes(assignedTo);
        case 'own_or_platform_subject':
            // Not answerable from an assignee. Reaching here means a caller passed an
            // audit scope to the ticket predicate, which is a programming error — fail
            // closed rather than guess.
            return false;
    }
}
