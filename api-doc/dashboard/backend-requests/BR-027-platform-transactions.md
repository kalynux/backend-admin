# BR-027 · One platform-wide transactions list, filterable column by column, with a detail read

**Opened 2026-10-12, from an owner request. Status: open — nothing is built on the dashboard.**

Read against `backend/admin` at `ad8f399` and `backend/jovi-mall` as checked out the same day.
Every claim under *What exists today* names the file it was read from. Everything under *What we
are asking for* is a proposal: the need is fixed, the shape is yours.

---

## The ask

The owner's words:

> Can we have a transaction tab that will show us all transactions that happened on the platform
> (pay-in, pay-out, reason, provider, amount). Selecting a transaction should open a detail page
> showing everything related to that transaction. The page should be filterable by role, provider,
> date, etc. The same on each column — for example the amount can be filtered to equal to, greater
> than, or less than.

Three decisions the owner made on 2026-10-12, when asked:

| Question | Decision |
|---|---|
| What counts as a transaction | **Everything.** Money carried by a payment provider (customer payments, plan purchases, credit top-ups, seller payouts, customer refunds), **plus** cash-on-delivery cash handed over (agent deposits, agency remittances), **plus** internal movements (the earnings ledger: holds, releases, reversals, refund debt) |
| Who opens the screen | **Every level** — Developer, Admin and Support |
| What the dashboard does meanwhile | **Nothing.** No interim screen. It is built once, against your answer |

So the screen is one table, newest first, one row per money movement, and a detail page per row.

---

## What exists today

Eight collections hold these movements. Where one has a list, no two lists share a shape, a
vocabulary or a filter set.

| Movement | Collection | List today | Single read today | Permission | Tier 3 |
|---|---|---|---|---|---|
| Customer payment | `payment_transactions` | [`GET /money/payments`](../../api/money.md) | `GET /money/payments/:transactionId` | `money.payments.read` | ● |
| Customer refund | `refund_transactions` | `GET /money/refunds` | **none** | `money.payments.read` | ● |
| Seller payout | `payout_requests` | `GET /money/payouts` | `GET /money/payouts/:payoutId` | `money.payouts.read` | ● |
| Plan purchase | `plan_purchases` | **none platform-wide** — only inside one owner's [`/accounts/…/activity`](../../api/accounts.md) | **none** | `money.earnings.read` + `billing.plans.read` | · |
| Credit top-up | `credit_topups` | **none platform-wide** — same | **none** | same | · |
| COD deposit | `agent_deposits` | [`GET /cod/deposits`](../../api/cod.md) | `GET /cod/deposits/:depositId` | `cod.deposits.read` | ● |
| COD remittance | `agency_remittances` | `GET /cod/remittances` | `GET /cod/remittances/:remittanceId` | `cod.remittances.read` | ● |
| Ledger entry | `earnings_ledgers` | `GET /money/earnings/platform/ledger` — **the platform's two accounts only**; a seller's entries only inside that seller's `/accounts/…/activity` | **none** | `money.earnings.read` | · |

What an operator cannot do with those, and why the dashboard cannot fake it:

1. **No list crosses two of them.** The only merged feed is
   `GET /accounts/:ownerType/:ownerId/activity`, which is scoped to one owner, has no filter and
   leaves out payments, refunds and COD.
2. **No list can compare an amount.** `ListPaymentsQuerySchema`, `ListPayoutsQuerySchema` and
   `ListRefundsQuerySchema` (`money/validators/money.validator.ts`) accept exact-match terms and
   a date window. There is no minimum, no maximum and no equality on `amount` anywhere. A dashboard can
   only filter the 20–100 rows of the page it holds, which would show "3 payments above 50 000"
   on a page drawn from 30 000.
3. **`provider` is returned and cannot be filtered.** `buildPaymentFilter`
   (`payment-transaction.read.repository.ts`) matches `gateway` and `method`, not `provider`.
   Payouts cannot be filtered by aggregator or provider at all.
4. **Role exists on one list only.** `ownerType` on payouts. Payments say
   `payer.kind: "customer_or_user"`, refunds carry no role, COD lists filter by `agencyId`.
5. **The vocabularies do not line up**, so the dashboard cannot merge them honestly either:
   `SUCCEEDED` · `paid` · `completed` · `confirmed` are four spellings of one outcome, and
   `payment_transactions` is camelCase and upper-case while the rest are snake_case and lower-case.
6. **Four kinds have no single read**, so a detail page for a refund, a plan purchase, a credit
   top-up or a ledger entry has nothing to load.

The dashboard will not merge three paged lists in the browser. `accounts.md` already says why:
*"`skip(40)` applied to five sources independently does not compose into rows 40–60 of the merged
order."*

---

## What we are asking for

### A · A platform-wide list — `GET /money/transactions` (the name is yours)

One row per movement, in one shape. Proposed fields, all read as **possibly `null`** by the
dashboard:

| Field | What the screen needs it for |
|---|---|
| `kind` | Which record this is: `payment` · `plan_purchase` · `credit_topup` · `refund` · `payout` · `cod_deposit` · `cod_remittance` · `ledger_entry`. An open string to us |
| `id` | **The source document's id**, as on the account feed, so `(kind, id)` opens the record where it lives |
| `group` | `provider` · `cash` · `internal` — the three families in the owner's decision. The screen's first filter |
| `direction` | `in` · `out` · `internal`, **from the platform's side** — the opposite reading from the account feed, which is the owner's side. Please state the rule per kind and per status (see D-6) |
| `party` | `{ role, id, name }` — who paid or was paid. `role` is `customer` · `vendor` · `agency` · `agent` · `platform`. This is the "role" column and filter |
| `amount` · `currency` | Positive magnitude, as on every other money list. The sign lives in `direction` |
| `status` | The source's own word, unchanged (`SUCCEEDED`, `paid`, `confirmed`, …) |
| `outcome` | **One normalised word across all kinds**: `succeeded` · `pending` · `failed` · `reversed` (or your set). `GATEWAY_STATS_SOURCES` already buckets three collections this way; this is the same idea made a field. Without it "show me everything that failed" is eight filters |
| `gateway` · `provider` · `method` | Aggregator, what the payer paid with, and the method. `null` where the row is not a provider charge |
| `reason` | `{ code, text }`. `code` says why the money moved (`order_payment` · `booking_balance` · `delivery_topup` · `plan_purchase` · `credit_topup` · `refund` · `payout_manual` · `payout_auto_threshold` · a ledger `reasonCode` …). `text` is the human sentence where one is stored — a refund's `reason`, a payout's `rejectionReason` or `transferFailureReason` — and `null` otherwise |
| `reference` · `merchantRef` | The provider's reference and ours, where the kind has them |
| `links` | Ids of what the row touches: `orderIds[]`, `bookingId`, `paymentTransactionId`, `refundRequestId`, `ticketId`, `allocationId`, `planId` — whichever apply. The detail page turns these into links |
| `createdAt` · `completedAt` | When it was opened and when the money actually moved (`paidAt`, `completedAt`, `resolvedAt`) |

Still never returned, for anyone: `rawGatewayPayloads`, `gatewayPayloadHash`, `idempotencyKey`,
`transfer_reference`, and the three payout routing values. A payout's destination stays behind its
own audited reveal.

### B · Filters — one per column, with the comparison that column needs

| Column | Parameters | Comparison |
|---|---|---|
| Kind, group, direction | `kind`, `group`, `direction` | is · is any of (comma list or repeated key, your convention) |
| Role | `role` | is · is any of |
| Party | `partyId` | is |
| Provider, aggregator, method | `provider`, `gateway`, `method` | is · is any of. **Case-insensitive, or refused when the case is wrong** — today a lower-cased `?gateway=` is a silent empty page |
| Outcome, status | `outcome`, `status` | is · is any of |
| **Amount** | `amount`, `amountMin`, `amountMax` | **equal to · at least · at most · between** |
| **Date** | `from`, `to` | the existing half-open `[from, to)` on `createdAt`; "on a day", "before" and "after" are all this pair |
| Reason | `reasonCode` | is · is any of |
| Reference | `reference` | exact, against `reference` **or** `merchantRef`, as `/money/payments` does. We are **not** asking for a "contains" search on a money collection |
| Linked record | `orderId`, `bookingId` | is |

On the amount: the dashboard will offer *greater than* and *less than* by sending
`amountMin = n + 1` and `amountMax = n − 1`. That is only right if every `amount` is a whole
number. **Please confirm it, or give exclusive bounds** (`amountGt` / `amountLt`) instead.

Sorting: `createdAt` and `amount`, default `-createdAt`.

**Please make the query schema strict.** On a money list a misspelt filter that returns the
unfiltered page is the worst outcome available, and this route is new, so nothing depends on it
being lenient.

### C · Paging — the hard part, and yours to decide

`accounts.md` explains why the one merged feed is cursor-paged and takes no filter. This request
needs filters and an amount order on a merge, so one of those two decisions has to give. What the
screen requires, in order:

1. **Every filter is applied in the database**, never to a page.
2. **A stable order with no repeated and no skipped row** while walking it, under either sort.
3. `meta.total` is wanted and is **not** required. The dashboard already walks one cursor-paged
   list (the account Activity feed) and can walk another.

We would accept a required date window (the existing 366-day cap, or tighter) and a default one.
`plan_purchases` and `credit_topups` are indexed by owner only, and `earnings_ledgers` by
`{owner_type, owner_id, created_at}`, so a platform-wide window is a scan on three of the eight
today — your call whether that needs indexes in jovi-mall's migration ledger.

### D · A detail read — `GET /money/transactions/:kind/:id`

The row, plus **everything related to it**:

| Kind | Related records the page should show |
|---|---|
| `payment` | the orders or booking it settled, the delivery top-up it paid for, every refund against it (as `/money/payments/:transactionId` already returns), the payer |
| `refund` | the payment it reversed, the refund request it completed, the order or booking, the vendor, who asked, the fee kept and the net sent |
| `payout` | the owner, the ticket, the endorsement, the transfer's aggregator and reference, who resolved it. **Not** the destination digits |
| `plan_purchase` · `credit_topup` | the owner, the plan or pack, the subscription or credits it produced |
| `cod_deposit` · `cod_remittance` | the agent and agency, the proof as a `FileDetail` (`url: null`, opened through the audited content route), the cash movements it caused |
| `ledger_entry` | the account's owner, the allocation, the source order or booking, `balancesAfter` |

If one composed read is more than you want to build, the smaller form works too: **`links` on the
row (§ A), plus a single read for the four kinds that have none** — refund transaction, plan
purchase, credit top-up, ledger entry. The dashboard already has detail screens for payments,
payouts, deposits and remittances and would reuse them.

### E · Access — every level opens it, and nobody sees more than they do today

The owner's decision is that all three levels open the screen. Two existing rules cut across
"every level", and we ask that the server, not the dashboard, hold both:

1. **Support does not hold `billing.plans.read` or `money.earnings.read`.** A list that sent plan
   purchases, credit top-ups and seller ledger entries to tier 3 would widen Support's reach as a
   side effect of a new screen. We propose **grading the rows by the reads the caller already
   holds** — the `/system/errors` and `/automation` pattern — so tier 3 gets payments, refunds,
   payouts and the two COD kinds, and tiers 1–2 get all eight.
2. **Owner rule, 2026-10-04: Admin and Support never see the platform's own take in FCFA.** The
   ledger rows of the `platform` and `platform_ai` accounts are exactly that. Today
   `GET /money/earnings/platform/ledger` sends them to tier 2 and the dashboard merely hides the
   screen — in the dashboard's own notes, *"it hides, it does not protect"*. On this new list
   please **omit those rows below tier 1** rather than send them.

When rows are withheld, please say so — a `meta` member naming the kinds the caller was not sent —
so the screen can state that the list is partial instead of looking complete. And please decide
what `?kind=ledger_entry` answers for a caller who may not see that kind: `403`, or an empty page
with that same `meta`.

Whether the route gets its own permission (`money.transactions.read`, every tier) or a composite
of existing reads is yours. If the owner later wants Support to see more, that is a grant change
and a separate request.

---

## Questions we cannot answer from source, and the screen depends on each

| # | Question | Why it matters |
|---|---|---|
| D-1 | `credit_topups.payment_transaction_id` exists. Does a credit top-up (or a plan purchase) **also** write a `payment_transactions` row? | If so the same money is two rows, and the list double-counts it. We found nothing under `jovi-mall/src/modules/billing` that sets the field, but did not read every writer |
| D-2 | A refund on channel `payout` is "sent by mobile-money transfer". Does it also create a `payout_requests` row? | Same double count, on the way out |
| D-3 | A delivery-fee refund settled by hand (`POST /money/delivery-fee-refunds/:refundId/settle`, method `mobile_money` / `cash` / `bank` / `other`) — is it a `refund_transactions` row? | If not, money returned to customers is missing from "all transactions" and is a ninth kind |
| D-4 | `credit_transactions` move **credits, not money**. We propose leaving them out | A column mixing XAF and credit units cannot carry an amount filter |
| D-5 | A COD deposit with `recipient: "agency"` never reaches the platform. Is it `internal`, or left out? | `in` would overstate the platform's cash |
| D-6 | `direction` for a payout that is `pending`, `processing`, `failed` or `rejected`; for a `FAILED` payment; for a `reversed` purchase | The account feed answered this once (a pending payout is `internal`); the platform-side rule needs stating too |
| D-7 | On a payment the payer id is a customer id **or** a user id and nothing says which. Can `party.name` be resolved? | A null name is acceptable; a wrong one is not |
| D-8 | Should `meta` carry totals? If so, **per direction and per currency, never across `internal`**, and computed by the service | The dashboard sums nothing. A hold and its release are the same money twice, and COD cash is a liability, not income — `accounts.md` keeps it out of the account feed for that reason |
| D-9 | `provider` is `null` on every charge written before payment routing (jovi-mall ADR-A08) | `?provider=MTN` will silently miss them; the page should say so |

---

## Acceptance

- [ ] One list returns all eight kinds in one documented shape, with `kind`, `group`, `direction`,
      `party.role`, `outcome`, `reason` and `links` on every row
- [ ] Every filter in § B is applied in the database; an unknown parameter is a `400`
- [ ] `amount` can be filtered equal to, at least, at most and between; whole-number amounts are
      confirmed, or exclusive bounds exist
- [ ] `provider`, `gateway` and `role` filter across every kind that carries them
- [ ] The order is stable under both sorts, and the page says how it is paged
- [ ] A detail read (or `links` plus the four missing single reads) lets the dashboard show
      everything related to one row
- [ ] Tier 3 receives no kind it cannot read today; no caller below tier 1 receives a `platform`
      or `platform_ai` ledger row; withheld kinds are named in `meta`
- [ ] D-1 … D-9 are answered on the contract page
- [ ] A contract page (`money.md` section or its own), a `FRONTEND-CHANGELOG`, the route in the
      manifest and in `permissions.md`, and the **source path of the row DTO** named on the page —
      the dashboard will mirror that file rather than transcribe the table

---

## What the dashboard does while this is open

Nothing new. **Money › Payments**, **Payouts**, **Refund queue**, the COD screens and the
platform ledger stay as they are, each with the filters its own endpoint supports. No Transactions
entry is added to the navigation until there is a route to give it.
