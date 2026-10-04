/**
 * What the marketplace earned in a window — the shape of `GET /money/earnings/platform/summary`.
 *
 * PURE: grouped allocation rows in, a summary out. Exported for `test-money.ts`.
 *
 * ── Why this exists (owner, 2026-10-04) ───────────────────────────────────────────────────
 * "How much has the platform made" used to be answered with the `platform` account alone —
 * COMMISSION ONLY. The bargain fee (30% of what a bargainable line sold for above the vendor's
 * minimum) is credited to a second singleton, `platform_ai`, and no administrative surface
 * added the two. The summary names both and totals them; `/money/earnings/platform` (the
 * balances, delegated) now does the same.
 *
 * Statuses are kept apart rather than netted: `held` is earned but still in escrow, `released`
 * is earned and final, `reversed` is money a refund took back. `earned` is held + released.
 */

export type PlatformAccountKey = 'commission' | 'bargainFee';

export interface PlatformAccountFigures {
    /** In escrow — the order has not completed, or its hold window has not elapsed. */
    held: number;
    /** Final. */
    released: number;
    /** Taken back by a refund. Excluded from `earned`. */
    reversed: number;
    /** `held + released`. */
    earned: number;
    /** Allocations behind `earned`. */
    count: number;
}

export interface PlatformEarnedSummary {
    currency: string;
    commission: PlatformAccountFigures;
    bargainFee: PlatformAccountFigures;
    total: PlatformAccountFigures;
}

interface GroupedRow {
    _id: { account: string; status: string; currency: string };
    amount: number;
    count: number;
}

const ACCOUNT_OF: Record<string, PlatformAccountKey | undefined> = {
    platform: 'commission',
    platform_ai: 'bargainFee',
};

const empty = (): PlatformAccountFigures => ({ held: 0, released: 0, reversed: 0, earned: 0, count: 0 });

/**
 * One summary per currency present, ordered by currency code. An ARRAY, for the reason
 * `/earnings/accounts`' `totals` is one: a single object would force a currency choice the data
 * does not support. A window with no platform allocations at all answers `[]`.
 */
export function toPlatformEarnedSummaries(rows: GroupedRow[]): PlatformEarnedSummary[] {
    const byCurrency = new Map<string, PlatformEarnedSummary>();

    for (const row of rows) {
        const account = ACCOUNT_OF[row._id.account];
        if (!account) continue;
        const currency = row._id.currency;
        const summary =
            byCurrency.get(currency) ?? { currency, commission: empty(), bargainFee: empty(), total: empty() };
        byCurrency.set(currency, summary);

        for (const figures of [summary[account], summary.total]) {
            if (row._id.status === 'held') figures.held += row.amount;
            else if (row._id.status === 'released') figures.released += row.amount;
            else if (row._id.status === 'reversed') figures.reversed += row.amount;
            else continue;
            if (row._id.status !== 'reversed') {
                figures.earned += row.amount;
                figures.count += row.count;
            }
        }
    }

    return [...byCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

/** `?account=` on the platform ledger → the owner types it reads. */
export const PLATFORM_LEDGER_ACCOUNTS = ['all', 'commission', 'bargain_fee'] as const;
export type PlatformLedgerAccount = (typeof PLATFORM_LEDGER_ACCOUNTS)[number];

export function ledgerOwnerTypesOf(account: PlatformLedgerAccount | undefined): readonly string[] {
    if (account === 'commission') return ['platform'];
    if (account === 'bargain_fee') return ['platform_ai'];
    return ['platform', 'platform_ai'];
}
