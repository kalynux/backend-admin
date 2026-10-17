# `/money/transactions` — every money movement in one list

**Added 2026-10-12** (BR-027). **Amended 2026-10-15** (BR-030): two more kinds —
`cod_collection` and `earnings_adjustment` — two more `links` keys (`agentId`, `payoutId`), and
the platform's own rows now gated on `money.earnings.platform.read` rather than on the tier.
Not deployed yet. Verified against source, against `test:transactions` (165 assertions, no
database) and against `verify:transactions` (70 assertions on a real MongoDB, all three tiers).

Base path: `/api/v1/money/transactions`

| Method | Path | Permission | Transport | Audited |
|---|---|---|---|---|
| `GET` | `/money/transactions` | **any one of five existing reads** — see [Access](#access) | direct read | — |
| `GET` | `/money/transactions/summary` | the same | direct read | — |
| `GET` | `/money/transactions/:kind/:id` | the same, then the kind's own reads | direct read | — |

**The row shape is `admin/src/modules/money/read-models/transaction.dto.ts`.** Mirror that file;
this page explains it. The rules behind it (what each kind is, how each filter is applied) are
`admin/src/modules/money/domain/transaction-sources.ts`.

---

## What a row is

One row per money movement. `(kind, id)` names the source document — `id` is that document's
own id, never a synthetic one.

| `kind` | What it is | `group` | `direction` | Who is `party` | Full read of the record |
|---|---|---|---|---|---|
| `payment` | A customer paying for an order, a cart, a booking, a booking balance or a delivery top-up | `provider` | `in` | the customer | `GET /money/payments/:id` |
| `plan_purchase` | A vendor, agency or agent buying a plan | `provider` | `in` | the buyer | *(none — see `record`)* |
| `credit_topup` | The same, buying credits | `provider` | `in` | the buyer | *(none — see `record`)* |
| `refund` | Money returned to a customer | `provider` | `out` | the customer | *(none — see `record`)* |
| `delivery_fee_refund` | Delivery money returned to a customer **by hand**, or still owed and waiting for a person | `provider` | `out` | the customer | `GET /money/delivery-fee-refunds/:id` |
| `payout` | Earnings paid out to a vendor, agency or agent | `provider` | `out` | the owner | `GET /money/payouts/:id` |
| `cod_deposit` | An agent handing COD cash back | `cash` | `in` if paid to the platform, **`internal`** if paid to their agency | the agent | `GET /cod/deposits/:id` |
| `cod_remittance` | An agency handing COD cash to the platform | `cash` | `in` | the agency | `GET /cod/remittances/:id` |
| `cod_collection` | A customer paying cash at the door, to the agent | `cash` | **`internal`** | the customer | *(none — see `record`)* |
| `ledger_entry` | A movement on an earnings account: hold, release, reversal, reserve, refund debt | `internal` | `internal` | the account's owner | *(none — see `record`)* |
| `earnings_adjustment` | Refund debt **forgiven**, or **paid down by a payout that came back** — the two debt movements that write no ledger entry | `internal` | `internal` | the owner whose debt it is | *(none — see `record`)* |

**Eleven kinds.** BR-027 listed eight; `delivery_fee_refund` is the ninth (D-3 below), and the
owner added `cod_collection` and `earnings_adjustment` on 2026-10-13 (BR-030).

### ⚠ One banknote can be three rows, and only one of them is `in`

A customer pays 10 000 cash at the door, the agent hands it to their agency, the agency hands it
to the platform:

| Row | `direction` | Why |
|---|---|---|
| `cod_collection` | `internal` | the cash is in the agent's hands, not the platform's |
| `cod_deposit` to the agency | `internal` | still not the platform's |
| `cod_remittance` | **`in`** | the cash reached the platform |

If the agent pays the platform directly, the deposit is the `in` row and there is no
remittance. Either way **exactly one** row is `in`. A screen that adds `internal` rows to
anything counts the same cash two or three times — see the rules under [`/summary`](#get-moneytransactionssummary).

### `cod_collection` — what its amount is

`expected_amount`, the only amount the record has. A collection is all or nothing: the agent
enters the customer's code and the row turns `collected`. So on a `collected` row it **is** what
was collected; on a `pending` one it is what is due; on a `cancelled` one nothing changed hands.
`record` splits it into goods and delivery fee.

### `earnings_adjustment` — which debt movements are this kind

A refund can leave an owner owing the platform money. Five things move that debt, and every one
of them is on this list exactly once:

| Movement | It is listed as |
|---|---|
| A refund takes money back from an owner's share of a sale | `ledger_entry`, reason `refund_clawback` |
| A later release of that owner's money pays the debt down | `ledger_entry`, reason `clawback_recovery` |
| A refund charges a vendor beyond their share of that sale | `ledger_entry`, reason `refund_clawback` (filed under the vendor's share) |
| **An administrator forgives the debt** | **`earnings_adjustment`**, reason `debt_write_off` |
| **A payout is rejected, or its ticket fails, and the money comes back and pays the debt** | **`earnings_adjustment`**, reason `debt_recovered_from_payout` |

For an operator: *a write-off and a debt paid by a returned payout are adjustments; everything
else a refund does to someone's earnings is a ledger entry.*

⚠ **One rare case is on neither.** When a refund charges a vendor beyond their share and the
vendor has **no share at all** on that sale to file it under, nothing writes a ledger entry and
this kind does not list it either (listing every overflow charge would repeat the common case).
That charge is still on the order's money split, under `adjustments`.

### The fields

```jsonc
{
  "kind": "payment",
  "id": "66f0a1b2c3d4e5f601234567",
  "group": "provider",
  "direction": "in",
  "party": { "role": "customer", "id": "665c…", "name": "Awa N." },
  "amount": 20000,
  "currency": "XAF",
  "status": "SUCCEEDED",
  "outcome": "succeeded",
  "gateway": "NOTCHPAY",
  "provider": "MTN",
  "method": "mobile_money",
  "reason": { "code": "order_payment", "text": null },
  "reference": "trx.AbC123",
  "merchantRef": "jm_pt_5f0c…",
  "links": {
    "orderIds": ["66ef…"], "bookingId": null, "shipmentId": null,
    "paymentTransactionId": null, "refundRequestId": null, "ticketId": null,
    "allocationId": null, "planId": null, "vendorId": null, "agencyId": null,
    "agentId": null, "payoutId": null
  },
  "createdAt": "2026-10-11T09:14:02.000Z",
  "completedAt": "2026-10-11T09:14:40.000Z"
}
```

Every field is always present. A value a kind does not have is `null` (`orderIds` is `[]`).

| Field | Notes |
|---|---|
| `direction` | **From the platform's side, and a property of the kind — never of the status.** A failed payment is still `in`; `outcome` says it failed. So "pay-ins that failed" is `direction=in&outcome=failed` |
| `party.role` | `customer` · `vendor` · `agency` · `agent` · `platform` · **`platform_ai`** (the platform's bargain-fee account; `?role=platform` matches both). Treat as an open string |
| `party.name` | A vendor's Store name, an agency's Magazin name, an agent's or customer's own name. `null` when it could not be resolved; never a guess. `null` for the platform's accounts, which also have `id: null` |
| `amount` | A positive number. ⚠ On a `refund` it is the **gross**; what the customer received is `record.netAmount` on the detail read |
| `currency` | `null` on a `ledger_entry` whose account could not be read. Never assume `XAF` |
| `status` | The source's own word, unchanged. On a `ledger_entry` it is the entry type (`hold`, `release`, `clawback`, …) |
| `outcome` | `succeeded` · `pending` · `failed` · `reversed` · `unknown`. The table below maps every status |
| `gateway` | The aggregator. `null` when none carried it: a COD or external refund, a hand settlement, a payout never sent or marked paid by hand, every `cash` and `internal` row |
| `provider` | `MTN` · `ORANGE` · `MOOV` · `CARD` on a charge. ⚠ On a **payout** it is the destination's own label as its owner typed it (`"Orange"`). `null` on refunds, cash and ledger rows — and on every charge written before payment routing (D-9) |
| `method` | A payment's method · a payout's destination type (`mobile_money`, `bank`, `card`) · a refund's **channel** (`card_refund`, `payout`, `external`) · a hand settlement's method (`mobile_money`, `cash`, `bank`, `other`) |
| `reason.code` | Why the money moved — table below |
| `reason.text` | Stored human text where there is one: a refund's reason, a payout's rejection or transfer-failure reason, a deposit's or remittance's rejection reason or note, a hand settlement's note. For a plan purchase it is the plan code, for a top-up the pack code |
| `reference` | The provider's or payer's reference. On a payout, the gateway's transfer id, else the reference typed when it was marked paid |
| `merchantRef` | Ours (`jm_pt_…`, `jm_pp_…`), on payments, plan purchases and top-ups only |
| `completedAt` | When the money actually moved. `null` until it has. On a `ledger_entry` it equals `createdAt` |

Never returned, for anyone: raw gateway payloads, the payload hash, the idempotency key, a
payout's transfer reference, a payout's account name, and the three payout routing values. The
source projections do not read them. A payout's destination stays behind
`GET /money/payouts/:payoutId/destination`.

### `outcome`, per kind

| Kind | `succeeded` | `pending` | `failed` | `reversed` |
|---|---|---|---|---|
| `payment` | `SUCCEEDED` | `INITIATED` `PENDING` | `FAILED` `CANCELLED` | `REFUNDED` |
| `plan_purchase` · `credit_topup` | `paid` | `pending` | `failed` | `reversed` |
| `refund` | `completed` | `pending` | `failed` | — |
| `delivery_fee_refund` | `completed` | `manual_required` | — | — |
| `payout` | `paid` | `pending` `processing` | `failed` `rejected` | — |
| `cod_deposit` · `cod_remittance` | `confirmed` | `declared` | `rejected` | — |
| `cod_collection` | `collected` | `pending` | `cancelled` | — |
| `ledger_entry` | every entry type | — | — | — |
| `earnings_adjustment` | `write_off` · `clawback_recovery` (its `status` is the adjustment's kind) | — | — | — |

A status this service does not know yet reads **`unknown`**, never another word, and
`?outcome=unknown` finds exactly those rows. `test:transactions` § 4 reads jovi-mall's status
lists out of its source and fails when one has no bucket.

⚠ A payout that is `failed` still holds the owner's money and can be retried. It is `failed`
here because that is the row an operator filtering for failures is looking for.

### `reason.code`

| Kind | Codes |
|---|---|
| `payment` | `order_payment` · `booking_payment` · `booking_balance` · `delivery_topup` |
| `plan_purchase` | `plan_purchase` |
| `credit_topup` | `credit_topup` |
| `refund` | `refund` |
| `delivery_fee_refund` | `delivery_fee_refund` |
| `payout` | `payout_manual` · `payout_auto_threshold` |
| `cod_deposit` | `cod_deposit_to_platform` · `cod_deposit_to_agency` |
| `cod_remittance` | `cod_remittance` |
| `cod_collection` | `cod_order_payment` (the goods, with any delivery fee) · `cod_delivery_fee` (a delivery fee alone, on an order paid online) |
| `earnings_adjustment` | `debt_write_off` (`reason.text` is the administrator's stated reason) · `debt_recovered_from_payout` |
| `ledger_entry` | jovi-mall's own, passed through: `order_split` · `cod_split` · `delivery_split` · `hold_release` · `refund_reversal` · `cod_rolling_reserve` · `reserve_matured` · `delivery_fee_adjustment` · `refund_clawback` · `clawback_recovery` — and `clawback_write_off`, which is in the model's vocabulary and **written by nothing**: a write-off is an `earnings_adjustment` |

---

## `GET /money/transactions`

### Filters

Every filter is applied in the database. None is applied to a page.

| Parameter | Comparison | Notes |
|---|---|---|
| `kind` · `group` · `direction` · `role` · `outcome` | is · is any of | Our vocabularies: a value outside them is a `400` |
| `status` · `gateway` · `provider` · `method` · `reasonCode` | is · is any of | jovi-mall's vocabularies: any 1–40 character value is accepted and simply matches or does not |
| `partyId` | is | The party's id, in that party's own id space |
| `amount` | equal to | |
| `amountMin` · `amountMax` | at least · at most (inclusive) | |
| `amountGt` · `amountLt` | greater than · less than (exclusive) | Use these — do **not** send `n ± 1` (D-10 below) |
| `from` · `to` | the half-open `[from, to)` on `createdAt` | ISO instants with a zone. See [the window](#the-window) |
| `reference` | exact | Matched against every reference the kind carries, ours and the provider's. No "contains" |
| `orderId` · `bookingId` | is | |

**"Is any of"** is a comma list (`?kind=payment,refund`) or the key repeated; up to 20 values.

**`gateway`, `provider` and `method` are case-insensitive.** `?gateway=notchpay` matches
`NOTCHPAY`, and `?provider=ORANGE` matches a payout whose owner typed `Orange`.

**A filter on a column a kind does not carry excludes that kind.** `?provider=MTN` returns
payments, plan purchases, top-ups and payouts paid with MTN, and no refund, cash or ledger row,
because those have no provider. It never means "ignore the term for kinds that lack it".

**The query is strict.** An unknown parameter is `400 VALIDATION_ERROR`. So are amount bounds
that exclude everything (`amountMin=100&amountMax=50`), which would otherwise look like an
empty result.

### Sorting

`sort=-createdAt` (default) · `createdAt` · `-amount` · `amount`.

### Paging — a cursor, and no `page`

```
GET /money/transactions?limit=20
→ meta.nextCursor = "WyItY3JlYXRlZEF0Iiwx…"
GET /money/transactions?limit=20&cursor=WyItY3JlYXRlZEF0Iiwx…
```

- `limit` 1–100, default 20. A page is exactly `limit` rows while more remain.
- `cursor` is opaque. Send back `meta.nextCursor` unchanged, **with the same filters and the
  same sort**. A cursor sent with a different `sort` is a `400`; start again without it.
- `meta.hasMore` is `false` and `meta.nextCursor` is `null` on the last page.
- Walking the list returns every matching row once, in order, under either sort — rows that
  share a millisecond or an amount included. There is **no `total`** and no `pages`; ask
  `/summary` for a count.

Why not offset paging: eleven collections are merged, and `skip(40)` applied to eleven sources is
not rows 40–60 of the merged order. A cursor is the same question to every source, so the merge
of their answers is exact.

### The window

The list always has a date window and reports the one it used in `meta.window`.

| You send | Window used |
|---|---|
| neither | the last 366 days, ending now |
| `to` only | the 366 days before `to` |
| `from` only | from `from` to now, or to `from + 366 days` if that is earlier |
| both | exactly that; more than 366 days apart is a `400` |

To read further back, send an earlier `to`.

### `meta`

```jsonc
{
  "limit": 20,
  "nextCursor": "WyItY3JlYXRlZEF0Iiwx…",
  "hasMore": true,
  "sort": "-createdAt",
  "window": { "from": "2025-10-11T10:00:00.000Z", "to": "2026-10-12T10:00:00.000Z" },
  "withheld": { "kinds": ["plan_purchase", "credit_topup", "ledger_entry"], "platformAccounts": true }
}
```

---

## Access

**No new permission.** The route opens to a caller holding **any one** of:
`money.payments.read` · `money.payouts.read` · `cod.deposits.read` · `cod.remittances.read` ·
`money.earnings.read`. Every tier holds at least one, so every tier opens the screen.

Each **kind** is then sent only to a caller who holds the reads that kind's own screens already
require:

| Kind | Needs | Developer | Admin | Support |
|---|---|---|---|---|
| `payment` · `refund` · `delivery_fee_refund` | `money.payments.read` | ● | ● | ● |
| `payout` | `money.payouts.read` | ● | ● | ● |
| `cod_deposit` | `cod.deposits.read` | ● | ● | ● |
| `cod_remittance` | `cod.remittances.read` | ● | ● | ● |
| `cod_collection` | `shipments.read` — the shipment detail is the one screen that already shows this record | ● | ● | ● |
| `plan_purchase` · `credit_topup` | `money.earnings.read` **and** `billing.plans.read` | ● | ● | · |
| `ledger_entry` · `earnings_adjustment` — a seller's, an agency's, an agent's | `money.earnings.read` | ● | ● | · |
| `ledger_entry` · `earnings_adjustment` — the platform's own (`platform`, `platform_ai`) | **`money.earnings.platform.read`** (tier 1 only — see [permissions.md](permissions.md)) | ● | · | · |

So the list cannot show a caller a row their other screens would refuse. A grant change moves
this table with no code change.

**`meta.withheld`** says what the caller was not sent: `kinds` (no read for them) and
`platformAccounts` (the platform's ledger rows were left out). Show it; a list that is partial
should not look complete.

**Filtering for a kind you may not read is an empty page, not a `403`** — `?kind=ledger_entry`
for Support answers `[]` with `withheld.kinds` naming it. One rule covers the single-kind and
the mixed case (`?kind=payment,ledger_entry`). The **detail** read is different: see below.

The platform's own rows are excluded in the query, for every filter, including a caller
asking for them by `role=platform`. Nothing hides them after the fact. Since 2026-10-15 the rule
is the permission `money.earnings.platform.read` rather than a tier comparison — the same name that
guards `/money/earnings/platform*` and withholds the platform's amounts on the order split — so one
grant change moves all three.

---

## `GET /money/transactions/summary`

The same filters. No `limit`, `cursor` or `sort` — each is a `400` here.

```jsonc
{
  "count": 14,
  "groups": [
    { "kind": "payment", "direction": "in",  "outcome": "succeeded", "currency": "XAF", "count": 1, "amount": 20000 },
    { "kind": "payout",  "direction": "out", "outcome": "succeeded", "currency": "XAF", "count": 1, "amount": 100000 },
    { "kind": "payout",  "direction": "out", "outcome": "failed",    "currency": "XAF", "count": 1, "amount": 30000 },
    { "kind": "ledger_entry", "direction": "internal", "outcome": "succeeded", "currency": null, "count": 3, "amount": 20500 }
  ],
  "window": { "from": "…", "to": "…" },
  "withheld": { "kinds": [], "platformAccounts": false }
}
```

One cell per `(kind, direction, outcome, currency)`, with a row count and the sum of the
`amount` column over those rows. `count` is the number of rows the list would return.

The service nets nothing. When you roll cells up:

- **Never add across currencies.**
- **Never add `internal` to anything, or `internal` cells to each other.** A hold and its
  release are the same money twice, and a deposit to an agency is cash that has not reached the
  platform. Ledger cells carry `currency: null` for this reason too.
- **`in` minus `out` is not revenue.** A `reversed` payment's refund is its own `out` row, a
  refund's amount is the gross, and COD cash arriving is a liability being settled, not income.
  What the platform earned is `GET /money/earnings/platform/summary`.

Graded exactly like the list.

---

## `GET /money/transactions/:kind/:id`

```jsonc
{
  "transaction": { /* the row, as above */ },
  "record": { "kind": "refund", "channel": "payout", "feeAmount": 100, "netAmount": 4900,
              "initiatedBy": { "id": "…", "role": "support" },
              "vendor": { "id": "…", "name": "Boutique Verify" } },
  "recordPath": null,
  "related": {
    "orders": [{ "id": "66ef…", "orderNumber": "ORD-2026-000123" }],
    "transactions": [ /* rows */ ],
    "truncated": false
  }
}
```

**`related.transactions`** is every *other* transaction on the same order(s) or booking that
the caller may read, oldest first, in the row shape. A payment opens with its refunds, its
delivery top-ups, any delivery-fee refund and — for tiers 1–2 — the earnings movements it
caused, and a COD order opens with its cash collection. It is graded like the list, so Support's
copy has no ledger rows. Capped at 50; `truncated: true` means filter the list by `orderId` for the
rest. Empty for kinds with no order or booking (payouts, plan purchases, top-ups, COD deposits and
remittances, debt adjustments).

**`recordPath`** is the existing full read of the record, relative to `/api/v1`, for the five
kinds that have one. Use the detail screen you already have. `record` is `null` for those.

**`record`** carries what the other six kinds have beyond the row:

| Kind | `record` |
|---|---|
| `refund` | `channel`, `feeAmount` (kept by the platform), `netAmount` (received by the customer), `initiatedBy { id, role }` (who asked, not who approved), `vendor { id, name }` |
| `plan_purchase` | `planId`, `planCode`, `subscriberPlanId` — `null` on a `paid` purchase means the plan was never applied |
| `credit_topup` | `packCode`, `credits` — ⚠ credits are not money; never add them to `amount` |
| `ledger_entry` | `accountId`, `entryType`, `balancesAfter { pending, available }`, `source { type, id }`, `allocation` — the full [allocation](money.md) with its hold and release dates |
| `cod_collection` | `collects` (`order` · `delivery_fee`), `itemsAmount`, `deliveryFeeAmount`, `settledAmount` (how much has reached the platform through confirmed remittances), `settledAt`, `agent { id, name }` — who is holding the cash. **Never** the delivery code, its hash, or the verification block (the agent's location, device and IP): the source does not read them |
| `earnings_adjustment` | `adjustment` (`write_off` · `clawback_recovery`), `actor { id, name }` — the administrator who forgave it, `null` on a recovery — and `payoutEvent` (`rejected` · `ticket_failed`) on a recovery. **Not stored, so not returned:** whether a write-off went through four-eyes approval, and the debt before and after. Both are in the audit log under `money.earnings.clawback.write_off_<vendor/agency/agent>` |

Follow `links` for the rest: `refundRequestId` → `/refunds/:id`, `ticketId` → the ticket,
`paymentTransactionId` → `/money/payments/:id`, `allocationId` →
`/money/earnings/allocations/:id`, `payoutId` → `/money/payouts/:id`, `agentId` → `/agents/:id`.

A debt adjustment names **no order and no refund request**: a debt is an owner's running
balance, not one refund's, and neither movement records which refund created what it settles.

### Errors

| Status | Code | When |
|---|---|---|
| `400` | `VALIDATION_ERROR` | `kind` is not one of the eleven, or `id` is not an id |
| `403` | `AUTHZ_PERMISSION_DENIED` | The caller holds no read for this kind. `details.required` names what is missing |
| `404` | `NOT_FOUND` | No such row of this kind — **including** a platform-owned row for a caller without `money.earnings.platform.read`, a `delivery_fee_refunds` row that is not a hand-settled or still-owed one, and an `earnings_adjustments` row that is a ledger entry's twin |

No new error code.

---

## The nine questions (BR-027 D-1 … D-9), and a tenth

| # | Answer |
|---|---|
| **D-1** | **No.** A plan purchase or credit top-up writes no `payment_transactions` row. `credit_topups.payment_transaction_id` is declared and set by nothing. One row each, no double count |
| **D-2** | **No.** A refund sent by mobile-money transfer is carried by the refund request itself; no `payout_requests` row is created. It is one `refund` row with `method: "payout"` |
| **D-3** | **Not a `refund_transactions` row — so it is a ninth kind.** Settling a delivery-fee refund by hand writes only the `delivery_fee_refunds` row. `delivery_fee_refund` is exactly the rows with no other record: still owed (`manual_required`) and settled by hand with `mobile_money` / `cash` / `bank` / `other`. A row the gateway or a refund request settled is already a `refund` row and is **not** repeated; a row settled as `covered_by_order_refund` moved no money and is not listed |
| **D-4** | **Left out, as proposed.** `credit_transactions` move credits. A top-up's credits are on its `record` |
| **D-5** | **`internal`.** A deposit to the agency never reached the platform. The same cash becomes `in` on the agency's remittance |
| **D-6** | **Direction does not depend on status.** It is fixed per kind (and per recipient for a deposit); `outcome` carries the state. A pending, processing, failed or rejected payout is `out`; a failed payment is `in`; a reversed purchase is `in` with `outcome: reversed` |
| **D-7** | **Yes, safely.** The payer id is looked up as a customer id, then as a user id. An id exists in one collection, so a hit names the right person; a miss is `null` |
| **D-8** | **On `/summary`, not on `meta`** — per kind, direction, outcome and currency, computed by the service, never netted and never summed across `internal`. Kept off the list so paging does not pay for eleven aggregations a turn |
| **D-9** | **Confirmed.** `provider` is `null` on charges written before payment routing, so `?provider=MTN` does not find them. The page should say so; `?gateway=` does find them |
| **D-10** | **Amounts are not guaranteed whole numbers.** Commission is rounded down to a whole unit, but nothing forces every stored amount to be an integer. Use `amountGt` / `amountLt` |

---

## What is not on this list

- **Credit movements** (`credit_transactions`) — credits are not money (D-4).
- **The rare vendor overflow charge with no share to file it under** — see
  [`earnings_adjustment`](#earnings_adjustment--which-debt-movements-are-this-kind). It is on the
  order's money split.

Both items this section used to list — a customer's cash paid on delivery, and refund-debt
write-offs and payout recoveries — are on the list since 2026-10-15 (BR-030).

## Indexes

The date walk is served by `{created, _id}` indexes declared on ten jovi-mall models
(`admin_transactions_feed` — eight on 2026-10-12, `cash_collections` and `earnings_adjustments`
on 2026-10-15 — plus `earnings_ledger_by_source` for `?orderId=`). They
are built by jovi-mall's `migrate:declared-indexes`. Without them the list still answers
correctly, by scanning the window. An amount sort always sorts the window in memory, which is
why the window is capped.
