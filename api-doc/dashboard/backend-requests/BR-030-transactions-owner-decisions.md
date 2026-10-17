# BR-030 · The owner's three answers to BR-027: two more kinds of transaction, and the platform's own amounts held back on the server

**Opened 2026-10-13. Status: open.** Follows
[`RESPONSE-2026-10-12-BR-027.md`](RESPONSE-2026-10-12-BR-027.md) § *Two decisions that are the
owner's, not ours*, which put three questions to the owner. The owner answered **yes to all
three** on 2026-10-13. This request carries those answers back, with what the dashboard needs from
each.

The Transactions screen itself is built against
[`transactions.md`](../../api/transactions.md) as it stands and needs nothing from this request to
work. Each part below is additive.

| # | The question you asked | The owner's answer | Your recommendation |
|---|---|---|---|
| 1 | Is a customer's cash-on-delivery payment a row? | **Yes** | Yes, as `internal` — adopted |
| 2 | Are refund-debt write-offs and payout-driven debt recoveries rows? | **Yes** | Yes, can follow — adopted |
| 3 | Should the four existing platform-earnings routes follow the tier-1 rule? | **Yes** | You left it open |

---

## 1 · A customer's cash-on-delivery payment — a tenth kind

**What exists.** `cash_collections` (`jovi-mall/src/modules/cod/models/cash-collection.model.ts`)
holds one row per parcel paid in cash: `order_id`, `shipment_id`, `agency_id`, `agent_id`,
`customer_id`, `vendor_id`, `kind`, `expected_amount`, `items_amount`, `delivery_fee_amount`,
`currency`, `status` (`pending` · `collected` · `cancelled`), `collected_at`, `settled_amount`,
`settled_at`. Today a COD order has no pay-in row on the list at all.

**What we ask for.** A kind — `cod_collection` in your reply — in the same row shape, with:

| Field | What the screen needs |
|---|---|
| `group` | `cash` |
| `direction` | **`internal`**, as you recommended: the cash is in the agent's hands, not the platform's, so `in` keeps meaning money the platform holds |
| `party` | The **customer**, who paid. They are who an operator searches for |
| `amount` | Please say which figure it is — `expected_amount`, or what was actually collected — and say so on the page |
| `outcome` | `collected` → `succeeded` · `pending` → `pending` · `cancelled` → `failed`, or your mapping |
| `reason.code` | One code, or one per `kind` if a collection of the items and a collection of a delivery fee are different rows |
| `links` | `orderIds`, `shipmentId`, `vendorId`, `agencyId` — and **the agent**. `TransactionLinksDto` has no `agentId`; the agent is the person holding the cash, so the detail page needs it as a link. A new key, or the agent on `record` |
| `completedAt` | `collected_at` |
| `record` | No screen of ours shows this record, so: `itemsAmount`, `deliveryFeeAmount`, `settledAmount`, `settledAt`, the agent `{ id, name }` |

Three things we need stated on the contract page:

1. **Which existing read sends it.** The list grades each kind by the reads its own screens
   already require. This kind has no screen of its own; the nearest are the order's `cod` block
   (`orders.read`) and the COD reads. Your call — we need the row in the Access table.
2. **That the same cash is now three rows, and only one is `in`.** A collection (`internal`), the
   agent's deposit (`internal` to the agency, or `in` to the platform), the agency's remittance
   (`in`). The `/summary` warning *"never add `internal` cells to anything"* then covers it, and
   the page should say so in words.
3. **What is never returned.** `code_hash`, `code_plain` and `verification` (a location, a device
   and an IP address) must not be projected, on the list or on `record`.

---

## 2 · Refund-debt write-offs and payout-driven recoveries — an eleventh kind

**What exists.** Your reply: these *"write no ledger row; their record is
`earnings_adjustments`"*, and the kind would be *"limited to the adjustments with no ledger entry,
so nothing repeats"*. The owner is content for this to follow part 1.

**What we ask for.** A kind in the same row shape, with:

| Field | What the screen needs |
|---|---|
| `group` · `direction` | `internal` · `internal` |
| `party` | The owner whose debt it is |
| `reason.code` | One per sort of adjustment (a write-off, a recovery from a returned payout, …) |
| `reason.text` | The administrator's stated reason for a write-off, where one is stored |
| `links` | The refund request or order the debt came from, and — for a payout-driven recovery — **the payout**. `TransactionLinksDto` has no payout key either |
| `record` | Who wrote it off and when; whether it went through approval (a write-off at or above 2 000 000 is dual-controlled); the debt before and after, if stored |

Two things we need stated on the contract page:

1. **Access.** We assume `money.earnings.read`, as for `ledger_entry` — so tiers 1–2, not
   Support — and that an adjustment on a `platform` / `platform_ai` account follows the tier-1
   rule like the ledger rows do. Please confirm.
2. **That no adjustment appears twice.** `clawback_recovery` and `clawback_write_off` are already
   `ledger_entry` reason codes in [`transactions.md`](../../api/transactions.md), so some of these
   events do write a ledger row. The page should say which adjustments are this kind and which
   remain ledger entries, in a sentence an operator could be told.

---

## 3 · The platform's own amounts, held back on the server

**The owner's rule** (2026-10-04, restated 2026-10-13): Admin and Support see the platform's
commission and bargain fee as **rates**, never as amounts. Only a Developer sees the amounts.

**Where it stands.** The new list enforces it in the query. Four older routes do not, as your
reply says, and on those the dashboard only hides what it was sent:

| Route | Permission | Sent today | What hides it now |
|---|---|---|---|
| `GET /money/earnings/platform` | `money.earnings.read` (tiers 1–2) | the commission and bargain-fee accounts and their total | a `developerOnly` flag on the dashboard's nav entry and route |
| `GET /money/earnings/platform/ledger` | same | every movement on both accounts | same |
| `GET /money/earnings/platform/summary` | same | what the platform earned in a period | same |
| `GET /money/orders/:orderId/split` | `money.splits.read` (every tier) | the `commission` and `bargain_fee` lines' `amount`, `totals.platform { commission, bargainFee, total }`, each `bargainFee` item's `fee` | a tier check inside one component |

### 3a · The three platform-earnings routes — refuse below tier 1

Tier 2 keeps `money.earnings.read`; it needs it for Accounts and Allocations. So this is either a
tier rule on the three routes, as on the new list, or a permission of their own held by tier 1
alone. **We would prefer the permission**: the dashboard would then gate the screen with the same
`can()` it uses everywhere, and `developerOnly` — the one place it checks a level instead of a
permission — could go. It costs a row in `permissions.md` and a count. Your call.

Either way the dashboard's screen does not change for anyone: it is already shown to Developers
only.

### 3b · The order split — send the rates, not the amounts, below tier 1

Support and Admin still need this route: *"why did the vendor receive this amount"* is theirs to
answer. So the route stays open to every tier, and below tier 1:

- `amount` on the `commission` and `bargain_fee` lines is `null`. The type already allows it
  (`line.amount` is `number | null` in jovi-mall, for an agent's share not yet known).
- `totals.platform` and each bargain-fee item's `fee` are `null` or absent.
- **The rates stay**: the commission percentage and the bargain-fee share are what the owner
  wants those tiers to see.
- **A flag says the figures were withheld** — on the line, or once on the response. `null`
  already means *not known yet* on this route, and the screen must not print *"not known yet"*
  for a figure that is known and not shown.

⚠ **This cannot be a complete boundary, and the owner has been told.** What the customer paid,
less what the vendor keeps, less the delivery lines, is the platform's share — and the first two
are exactly what Support is there to read. We are **not** asking for the vendor's figure to be
hidden. The ask is that the service stops stating the platform's amounts outright.

### 3c · Reported, not requested — please do not build this part yet

While reading for 3a we found one more place the platform's amounts reach tier 2:
`GET /money/earnings/allocations` and `GET /money/earnings/allocations/:allocationId` return rows
whose beneficiary is `platform` or `platform_ai`, with their `amount`. The owner has **not** been
asked about those; the dashboard's own notes say to ask first. We are asking them now and will
follow up.

What would help in the meantime: **a list of every route that states the platform's take to a
caller below tier 1** — these two, anything in `/money/earnings/accounts`' `meta.totals`, and any
we have not found — so the owner decides once.

---

## What the dashboard will do when each part lands

| Part | Change here |
|---|---|
| 1 · 2 | Re-copy the mirror `transaction-dto.ts`. `transactions.types.test.ts` goes red on the new kind, which is its job; the kind then gets a label, a family and a `record` section, and the screen's *"not on this list"* note loses that sentence |
| 3a | Nothing visible. If it is a permission: the nav entry gates on it and `developerOnly` is removed |
| 3b | `OrderMoneySplitPanel` reads the withheld flag instead of the caller's level, and the *"hides, does not protect"* notes come out |

Until then nothing changes: the list says a customer's cash paid on delivery and written-off
refund debt are not on it, and the two screens keep hiding what they are sent.

---

## Acceptance

- [ ] `cod_collection` (or your name for it) is a tenth kind: `cash`, `internal`, the customer as
      `party`, the agent reachable from the row or its `record`
- [ ] Its row in the Access table names the read that sends it, and the page says the same cash
      appears as up to three rows of which only one is `in`
- [ ] `code_hash`, `code_plain` and `verification` are never returned
- [ ] The adjustments with no ledger entry are an eleventh kind, with the payout reachable from a
      payout-driven recovery, and the page says which adjustments are this kind
- [ ] Below tier 1, the three `/money/earnings/platform*` routes are refused
- [ ] Below tier 1, the order split sends no platform amount — lines, `totals.platform`, item
      fees — keeps the rates, and says the figures were withheld
- [ ] A list of every other route that states the platform's take below tier 1 (§ 3c)
- [ ] `transactions.md`, `money.md` and `permissions.md` updated, and a `FRONTEND-CHANGELOG`
