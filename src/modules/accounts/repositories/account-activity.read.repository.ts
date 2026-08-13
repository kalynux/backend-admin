import { Document, Filter, ObjectId } from 'mongodb';
import { Types } from 'mongoose';
import { COLLECTIONS } from '../../../infra/platform/collections';
import { PlatformReadRepository } from '../../../infra/platform/platform.repository';

/**
 * The merge behind `GET /accounts/:ownerType/:ownerId/activity`.
 *
 * ── Five collections, one feed, and no query that can express it ──────────────
 * Plan purchases, credit top-ups, credit-ledger rows, earnings-ledger rows and payout
 * requests. `$unionWith` is not available to this service: `PlatformReadRepository` takes one
 * collection and one projection at construction, so a five-way union would need a single
 * repository projecting the union of five schemas — the widened projection the two-lock
 * convention exists to prevent. So each source is read through its own repository, with its
 * own whitelist, and the merge happens here in application code.
 *
 * ── Why it is cursor-paged (ADR-005 D-13 · plan D-6) ──────────────────────────
 * Offset paging over a merge is not merely expensive, it is WRONG: `skip(40)` applied to
 * five sources independently does not compose into rows 40–60 of the merged order. And an
 * exact `total` costs five `countDocuments` per page. A page count that drifts as you walk
 * it is silent truncation dressed as a number, so this endpoint reports neither — it is the
 * one list in the service without `total` and `pages`, and `cursorMeta` says so on the wire.
 *
 * ── The tie rule, which is the subtle part ────────────────────────────────────
 * The cursor is a timestamp and it is strictly-older-than, because an inclusive one repeats
 * the boundary row on every page — on a money feed that reads as a duplicate transaction.
 * But a bare `$lt` DROPS rows when two of them share the boundary instant, and here that is
 * not theoretical: activating a plan writes the purchase and its credit allowance in ONE
 * transaction, so two rows in two collections carry the same `created_at` routinely.
 *
 * A dropped money row is the failure this codebase cares most about, so `mergeActivity`
 * never splits a tie group: it takes `limit` rows and then keeps taking while the next row
 * shares the last one's instant. A page may therefore come back slightly LONGER than
 * `limit`, and that is the intended trade — an over-long page is visible, a missing
 * transaction is not.
 */

// ─────────────────────────────────────────────────────────────────────────────
// The merge — pure, and the reason this file is testable without a database
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One row on its way to the feed: the wire shape, plus the two sort keys read from the
 * SOURCE document rather than re-parsed out of the DTO.
 *
 * Generic over the row so this function knows nothing about the DTO — the merge is an
 * ordering problem, and keeping it that way is what lets `test-accounts.ts` exercise every
 * branch with three-line fixtures.
 */
export interface ActivityCandidate<T> {
    row: T;
    /** `created_at`, as a Date. Never an ISO string: string ordering is a coincidence. */
    at: Date;
    /** The source `_id`, for a deterministic tiebreak within one instant. */
    id: string;
}

export interface ActivityPage<T> {
    items: T[];
    /** Pass back as `?before=`. `null` at the end of the feed. */
    nextCursor: string | null;
}

/**
 * Merge pre-sorted sources into one chronological page.
 *
 * Each source is expected newest-first and already limited; nothing here re-reads the
 * database. The result is sorted by instant descending with an id tiebreak, sliced to
 * `limit`, and then EXTENDED to the end of the boundary tie group — see the header.
 *
 * `nextCursor` is the instant of the last row on the page, so the next request resumes
 * strictly older than it: nothing repeats, and because the whole tie group is on this page,
 * nothing is skipped either. When the sources between them returned no more than `limit`
 * rows, the feed is exhausted and the cursor is `null`.
 *
 * A final page may come back empty — the tie extension can consume the lookahead that told
 * us there was more. An extra round trip is a fair price for never dropping a row.
 */
export function mergeActivity<T>(
    sources: ActivityCandidate<T>[][],
    limit: number,
): ActivityPage<T> {
    const all = sources.flat().sort(byNewestFirst);

    if (all.length <= limit) {
        return { items: all.map((candidate) => candidate.row), nextCursor: null };
    }

    let end = limit;
    const boundary = all[end - 1].at.getTime();
    while (end < all.length && all[end].at.getTime() === boundary) end++;

    return {
        items: all.slice(0, end).map((candidate) => candidate.row),
        nextCursor: all[end - 1].at.toISOString(),
    };
}

/**
 * Newest first, with the id as a deterministic tiebreak.
 *
 * The tiebreak is not about ordering being *meaningful* within one instant — it is about it
 * being STABLE. Two rows at the same millisecond ordered differently on two requests would
 * make the cursor's guarantee unprovable.
 */
function byNewestFirst<T>(a: ActivityCandidate<T>, b: ActivityCandidate<T>): number {
    const difference = b.at.getTime() - a.at.getTime();
    if (difference !== 0) return difference;
    return b.id.localeCompare(a.id);
}

// ─────────────────────────────────────────────────────────────────────────────
// The one field this surface reads off `earnings_accounts`
// ─────────────────────────────────────────────────────────────────────────────

export interface EarningsCurrencyReadModel extends Document {
    _id: ObjectId;
    owner_type: string;
    owner_id: ObjectId;
    currency?: string | null;
}

/**
 * **The projection is the argument.** Four names are absent and cannot be added without a
 * visible diff: `pending_balance`, `available_balance`, `reserve_balance`,
 * `requested_balance`.
 *
 * D-7 says `earnings_accounts` is never read directly, because doing so would show balances
 * without the reconciliation `getBalances` performs — a second opinion about how much money
 * exists. That reasoning is about the BALANCES. This reads the account's `currency`, which
 * is a label: it is not derived, not reconciled, and jovi-mall's own `getBalances` returns
 * it verbatim from the same field.
 *
 * It is read because `earnings_ledgers` rows do not carry a currency of their own —
 * jovi-mall's `VendorTransactionService` has the same gap and fills it by calling
 * `getBalances` for the one string. Doing that here would put an HTTP call to jovi-mall on a
 * feed that is otherwise entirely direct, and the whole point of the direct half is that it
 * keeps answering when jovi-mall is down. So: one field, one projection that cannot express
 * a balance, and `test-accounts.ts` scans this module's source for the four banned names.
 */
const EARNINGS_CURRENCY_PROJECTION = {
    _id: 1,
    owner_type: 1,
    owner_id: 1,
    currency: 1,
} as const;

export class EarningsCurrencyReadRepository extends PlatformReadRepository<EarningsCurrencyReadModel> {
    constructor() {
        super(COLLECTIONS.EARNINGS_ACCOUNT, EARNINGS_CURRENCY_PROJECTION);
    }

    /**
     * The owner's earnings currency, or `null` when they have no account yet.
     *
     * A caller that gets `null` renders `currency: null` on those rows rather than assuming
     * `'XAF'`. An owner with no earnings account has no earnings-ledger rows either, so in
     * practice the pair is consistent: no currency, and nothing needing one.
     */
    async findCurrency(ownerType: string, ownerId: string): Promise<string | null> {
        if (!Types.ObjectId.isValid(ownerId)) return null;
        const account = await this.findOneBy({
            owner_type: ownerType,
            owner_id: new ObjectId(ownerId),
        } as Filter<EarningsCurrencyReadModel>);
        return account?.currency ?? null;
    }
}
