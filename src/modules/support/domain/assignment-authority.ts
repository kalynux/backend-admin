import { AdminTier } from '../../admin-identity/domain/admin-identity.types';

/**
 * Who may hand a ticket to whom.
 *
 * ── One table, two readers, and that is the whole point ───────────────────────
 * The service reads it to ENFORCE and the DTO reads it to RENDER the buttons. A second copy
 * — a `canAssign` in a controller, an `availableActions` in a mapper — is how a dashboard
 * offers a verb the API refuses, and the user finds out by clicking it. jovi-mall's
 * `resolveAvailableActions` in `stock-requests` is the same pattern for the same reason.
 *
 * ── Remember the inversion ────────────────────────────────────────────────────
 * Lower tier number = MORE privilege. 1 Developer, 2 Admin, 3 Support.
 *
 * ── The rules, as agreed ──────────────────────────────────────────────────────
 *
 *   Tier 1 Developer  may act on everything, and assign to any tier including its own.
 *   Tier 2 Admin      may act on their own, on unassigned, and on anything a Tier 3 holds.
 *                     May assign to Tier 1 and Tier 3 — EXCEPT that a ticket a Tier 1 gave
 *                     them may only go to Tier 3.
 *   Tier 3 Support    may act on their own and on unassigned, and may escalate their own
 *                     to Tier 2. Nothing else.
 *
 * ── Why the Tier 2 exception needs `assignedByTier` ───────────────────────────
 * "Cannot send back to a Developer a ticket a Developer gave you" is a fact about who
 * assigned it, not about who holds it — so the ticket carries an `assigned_by` stamp with
 * its tier. Without that stamp the rule is unenforceable, which is why the stamp exists.
 *
 * A Developer escalating downward and having it bounced straight back is the loop this
 * closes: the Developer has already decided the ticket belongs at Tier 2, and re-escalating
 * it is the one move that undoes their decision without anybody deciding anything.
 *
 * ── There is no unassign ──────────────────────────────────────────────────────
 * A ticket leaves an administrator only by being assigned onward, which every rule above
 * governs. Returning one to the pool would be a way around the Tier 3 rule — drop it, let
 * anyone claim it — so the verb does not exist. Claiming FROM the pool is open to every
 * tier: unclaimed work nobody may pick up is a queue that stops moving.
 */

/** What a ticket's assignment state is, as far as these rules are concerned. */
export interface TicketAssignmentState {
    /** The administrator holding it, or null for the unassigned pool. */
    holderId: string | null;
    holderTier: AdminTier | null;
    /** The tier of whoever assigned it. Null when it was claimed, or never assigned. */
    assignedByTier: AdminTier | null;
}

/** Every tier a caller may hand a ticket to, given who holds it now. */
export function assignableTiers(
    callerTier: AdminTier,
    callerId: string,
    state: TicketAssignmentState,
): readonly AdminTier[] {
    if (!mayActOnTicket(callerTier, callerId, state)) return [];

    switch (callerTier) {
        case 1:
            return [1, 2, 3];

        case 2: {
            // The exception: handed down by a Developer, it may only go on to Support.
            const handedDownByDeveloper = state.holderId === callerId && state.assignedByTier === 1;
            return handedDownByDeveloper ? [3] : [1, 3];
        }

        case 3:
            // Support escalates upward only, and only what is already theirs. Claiming from
            // the pool is a different act — see `mayClaim`.
            return state.holderId === callerId ? [2] : [];
    }
}

/**
 * Whether this caller may act on the ticket at all — read it, update it, note it, close it.
 *
 * Mirrors `resolveScope('tickets')` exactly, and must keep mirroring it. The scope is the
 * QUERY form of this predicate (which rows come back), this is the single-record form (may
 * I touch the one I already have). They answer the same question and a divergence would
 * show up as a row a list returns and a detail refuses.
 */
export function mayActOnTicket(
    callerTier: AdminTier,
    callerId: string,
    state: TicketAssignmentState,
): boolean {
    if (callerTier === 1) return true;
    if (state.holderId === null) return true;          // the unassigned pool, open to all
    if (state.holderId === callerId) return true;      // your own
    return callerTier === 2 && state.holderTier === 3; // an Admin supervising Support
}

/**
 * Whether this caller may claim an unassigned ticket for themselves.
 *
 * Separate from `assignableTiers` because claiming is not assigning: it names no target,
 * records no assigner, and is open to every tier by design. Folding it into the assignment
 * rules would make a Support administrator unable to pick up their own queue, since Tier 3
 * may only assign to Tier 2.
 */
export function mayClaim(state: TicketAssignmentState): boolean {
    return state.holderId === null;
}
