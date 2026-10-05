import { ObjectId } from 'mongodb';
import {
    AdjustmentRow,
    AllocationRow,
    Range,
    StatementAdjustmentRepository,
    StatementAllocationRepository,
} from '../repositories/statement.read.repository';

/**
 * Money taken back from an owner's earnings in a period — read from `earnings_adjustments`
 * (REFUND-FLOW-PLAN § 6.1), with the pre-ledger reversals kept.
 *
 * ── Why the source changed ────────────────────────────────────────────────────
 * Statements used to list allocations whose `reversed_at` fell in the period, at their full
 * `amount`. That was right while a refund could only reverse a HELD row whole. The clawback
 * changed both halves:
 *  - a PARTIAL refund claws part of a row and leaves it `held`/`released` — `reversed_at` never
 *    moves, so it was invisible;
 *  - a FULL claw may arrive in several steps (a partial now, the rest later) and ends `reversed`
 *    — counting `reversed_at` beside the adjustment rows would count it twice.
 * So each `refund_clawback` row is one line at its own amount, and a reversed allocation is
 * listed only when NO clawback row ever touched it (reversed before the ledger existed).
 *
 * `amount` on an allocation is never edited (§ 6.1 #2), so NET_FORMULA and the sales tables
 * keep reading it unchanged; this is the separate "taken back" line beside them.
 *
 * `write_off` rows are returned apart: forgiving debt is not an earning, so it never enters
 * "Net earnings in period" — it is shown as information beside it.
 */

export interface ReversalLine {
    at: Date | null;
    /** What the line is about, for resolving it to an order / shipment. */
    sourceType: string | null;
    sourceId: ObjectId | null;
    /** Positive: the money taken back. */
    amount: number;
    /** `clawback` — from the ledger; `legacy` — a whole-row reversal from before it existed. */
    kind: 'clawback' | 'legacy';
    /** How much of `amount` became debt the owner now owes (0 on a legacy line). */
    toDebt: number;
    currency: string | null;
}

export interface WriteOffLine {
    at: Date | null;
    amount: number;
    currency: string | null;
}

/** Pure — `test-statements.ts` asserts it without a database. */
export function toReversalLines(
    reversedAllocations: AllocationRow[],
    adjustments: AdjustmentRow[],
    clawedAllocationIds: ReadonlySet<string>,
): { reversals: ReversalLine[]; writeOffs: WriteOffLine[] } {
    const reversals: ReversalLine[] = [];
    const writeOffs: WriteOffLine[] = [];

    for (const adj of adjustments) {
        if (adj.kind === 'write_off') {
            writeOffs.push({ at: adj.created_at, amount: adj.amount, currency: adj.currency ?? null });
            continue;
        }
        if (adj.kind !== 'refund_clawback') continue;
        reversals.push({
            at: adj.created_at,
            sourceType: adj.source_type,
            sourceId: adj.source_id,
            amount: adj.amount,
            kind: 'clawback',
            toDebt: adj.taken_from?.debt ?? 0,
            currency: adj.currency ?? null,
        });
    }

    for (const a of reversedAllocations) {
        if (clawedAllocationIds.has(a._id.toHexString())) continue;
        reversals.push({
            at: a.reversed_at ?? null,
            sourceType: a.source_type,
            sourceId: a.source_id,
            amount: a.amount,
            kind: 'legacy',
            toDebt: 0,
            currency: a.currency,
        });
    }

    reversals.sort((x, y) => (x.at?.getTime() ?? 0) - (y.at?.getTime() ?? 0));
    return { reversals, writeOffs };
}

const allocations = new StatementAllocationRepository();
const adjustments = new StatementAdjustmentRepository();

/** Read both sources for one owner and merge them. */
export async function reversalsFor(
    ownerType: string,
    ownerId: string,
    range: Range,
): Promise<{ reversals: ReversalLine[]; writeOffs: WriteOffLine[] }> {
    const [reversed, adjustmentRows] = await Promise.all([
        allocations.reversedFor(ownerType, ownerId, range),
        adjustments.clawbacksFor(ownerType, ownerId, range),
    ]);
    const clawed = await adjustments.clawedAllocationIds(reversed.map((a) => a._id));
    return toReversalLines(reversed, adjustmentRows, clawed);
}

/** The label a statement prints for a line. */
export function reversalLabel(line: ReversalLine): string {
    if (line.kind === 'legacy') return 'Earnings reversed';
    return line.toDebt > 0 ? 'Refund clawback (part owed back)' : 'Refund clawback';
}
