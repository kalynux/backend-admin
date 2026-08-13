import { z } from 'zod';
import { cursorFields, listQuery } from '../../../core/http/list-query';
import { objectId } from '../../../core/validation/common.schemas';
import { PAYOUT_SORT } from '../../money/validators/money.validator';

/** Request shapes for `/api/v1/accounts`. */

/**
 * **Ours, so it is a pinned enum** (ADR-005 D-17) — the opposite call from the money
 * validator's bounded strings, and for the reason that rule actually turns on.
 *
 * Which owner kinds get an account page is THIS surface's decision, not jovi-mall's. The
 * platform's `BillingOwnerType` happens to hold the same three today, but the two lists
 * answer different questions and are free to diverge: if jovi-mall ever bills a fourth kind,
 * that does not oblige this service to render an account for it.
 *
 * **`platform` is excluded deliberately.** The marketplace's own commission account is a
 * singleton with no directory row, no plan, no credit wallet and no COD liability — every
 * block on this DTO would be `null` except one, and that one already has a home at
 * `/money/earnings/platform`. A page that is 90% "does not apply" is not an account page.
 */
export const ACCOUNT_OWNER_TYPES = ['vendor', 'agency', 'agent'] as const;
export type AccountOwnerType = (typeof ACCOUNT_OWNER_TYPES)[number];

/**
 * `:ownerType/:ownerId` — validated as a pair, because neither half means anything alone.
 *
 * A bad `ownerType` is a 400 here rather than an empty account somewhere downstream: every
 * collection on this surface is keyed `(owner_type, owner_id)`, so an unrecognised type
 * would match nothing in five places and render as an account whose every block is empty.
 */
export const AccountOwnerParamsSchema = z
    .object({
        ownerType: z.enum(ACCOUNT_OWNER_TYPES),
        ownerId: objectId,
    })
    .strict();

/**
 * The cash ledger's narrower pair: **agent and agency only.**
 *
 * A vendor never collects cash, so `cod_cash_ledgers` cannot hold a row for one. Scoping
 * that here makes it a 400 naming the reason, where the natural alternative — running the
 * query and returning the empty page it produces — would read as "this vendor has no cash
 * movements" when the truth is "a vendor cannot have any". That is precisely the distinction
 * `account.dto.ts` spends its fourth mechanism on (`codCash: null` vs `{ held: 0 }`), and a
 * list endpoint that quietly loses it would undo the point of making it.
 */
export const CashLedgerOwnerParamsSchema = z
    .object({
        ownerType: z.enum(['agent', 'agency'], {
            errorMap: () => ({ message: 'A cash ledger exists for agent and agency accounts only' }),
        }),
        ownerId: objectId,
    })
    .strict();

// ─────────────────────────────────────────────────────────────────────────────
// The activity feed — the one cursor-paged list in the service
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `?before=<ISO instant>&limit=` and nothing else.
 *
 * No `sort`: the feed has exactly one meaningful order, and the cursor IS that order. A
 * `sort=amount` over five merged sources would have to load every row of all five to be
 * correct, which is the unbounded read this endpoint's whole design avoids.
 *
 * No category filter either. It would be cheap to implement — skip the sources that do not
 * match — but it changes what a cursor means: the same `?before=` would return different
 * rows depending on a filter the cursor does not encode, and a client that changed the
 * filter mid-walk would silently resume in the wrong place. One feed, one order, one cursor.
 */
export const ListActivityQuerySchema = z.object({ ...cursorFields }).strict();

// ─────────────────────────────────────────────────────────────────────────────
// The three offset-paged sub-lists
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `credit_transactions` carries `{owner_type, owner_id, created_at: -1}` and this list is
 * always owner-scoped, so `-createdAt` is served by that index end to end. `amount` is
 * offered for "the largest movement", an in-memory sort over the matched set rather than a
 * scan — the owner terms still select through the index first.
 */
export const CREDIT_SORT = {
    createdAt: 'created_at',
    amount: 'amount',
} as const;

/**
 * `GET /accounts/:ownerType/:ownerId/credits`.
 *
 * `type` and `reasonCode` are bounded strings rather than enums: they are jovi-mall's
 * vocabulary, this service writes neither, and a value added on that side would turn a
 * filter into a 400 for a row the list is already showing (ADR-005 D-17).
 */
export const ListCreditsQuerySchema = listQuery(CREDIT_SORT, '-createdAt', {
    type: z.string().trim().min(1).max(40).optional(),
    reasonCode: z.string().trim().min(1).max(40).optional(),
});

/** `cod_cash_ledgers` carries `{owner_type, owner_id, created_at: -1}`. Same reasoning. */
export const CASH_LEDGER_SORT = {
    createdAt: 'created_at',
    amount: 'amount',
} as const;

export const ListCashLedgerQuerySchema = listQuery(CASH_LEDGER_SORT, '-createdAt', {
    entryType: z.string().trim().min(1).max(40).optional(),
});

/**
 * `GET /accounts/:ownerType/:ownerId/payouts` — the owner-scoped view of the queue
 * `/money/payouts` shows across everybody.
 *
 * The sort allowlist is **imported from the money validator, not restated**: it is the same
 * collection read through the same repository, and a second copy is how one surface ends up
 * able to order by a field the other cannot.
 */
export const ListAccountPayoutsQuerySchema = listQuery(PAYOUT_SORT, '-createdAt', {
    status: z.string().trim().min(1).max(40).optional(),
});

export type AccountOwnerParams = z.infer<typeof AccountOwnerParamsSchema>;
export type ListActivityQuery = z.infer<typeof ListActivityQuerySchema>;
export type ListCreditsQuery = z.infer<typeof ListCreditsQuerySchema>;
export type ListCashLedgerQuery = z.infer<typeof ListCashLedgerQuerySchema>;
export type ListAccountPayoutsQuery = z.infer<typeof ListAccountPayoutsQuerySchema>;
