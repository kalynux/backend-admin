# Frontend changelog — platform transactions (2026-10-12)

**Not deployed yet.** Answers BR-027. Additive: no existing route, field, permission or error
code changed.

Contract: [`api/transactions.md`](api/transactions.md). Row shape to mirror:
`admin/src/modules/money/read-models/transaction.dto.ts`.

## New routes

| Route | What |
|---|---|
| `GET /money/transactions` | Every money movement in one list. Nine kinds, one row shape, a filter per column, cursor-paged |
| `GET /money/transactions/summary` | Count and Σ amount per kind · direction · outcome · currency, for the same filters |
| `GET /money/transactions/:kind/:id` | One row, its record, and every other transaction on the same order or booking |

## What to build against

- **Navigation gate:** show the entry to a caller holding any one of `money.payments.read`,
  `money.payouts.read`, `cod.deposits.read`, `cod.remittances.read`, `money.earnings.read`.
  There is no new permission; `permissions.types.ts` does not change.
- **Paging is a cursor.** `limit` + `cursor`; no `page`, no `total`, no `pages`. Send
  `meta.nextCursor` back with the same filters and sort. Changing the sort means dropping the
  cursor.
- **The query is strict.** An unknown parameter is a `400`.
- **A date window always applies** — the last 366 days when you send none. Render
  `meta.window`.
- **Render `meta.withheld`.** Support is sent six of the nine kinds, and only tier 1 is sent
  the platform's own ledger rows.
- **Amount filters:** `amount` (equal), `amountMin` / `amountMax` (inclusive), `amountGt` /
  `amountLt` (exclusive). Do not compute `n ± 1`.
- **`direction` is the platform's side** and does not change with the status. Use `outcome` for
  the state.
- **`outcome` can be `unknown`.** Give it a label.
- **Do not add `/summary` cells across currencies, and never add `internal` cells to anything.**
- **Detail:** for `payment`, `payout`, `cod_deposit`, `cod_remittance` and
  `delivery_fee_refund`, `recordPath` is the read your existing detail screen already uses. For
  `refund`, `plan_purchase`, `credit_topup` and `ledger_entry`, render `record`.
- **Errors:** no new code. Detail answers `403 AUTHZ_PERMISSION_DENIED` for a kind the caller
  may not read and `404 NOT_FOUND` for a row out of scope.

## Not on the list

A customer's cash-on-delivery payment, and refund-debt write-offs. Both are open owner
decisions — see `dashboard/backend-requests/RESPONSE-2026-10-12-BR-027.md`.
