# Frontend changelog — what the platform earns, and one order's money split (2026-10-04)

**For:** the admin dashboard. **Status:** built in jovi-mall + wi-admin, **not deployed yet.**
**Contract:** [`api/money.md`](./api/money.md) — § `GET /money/earnings/platform`,
§ `…/platform/summary`, § `…/platform/ledger` (`account`), § `GET /money/orders/:orderId/split`.

Two owner asks, answered in two changes:

1. **"When the platform checks what it has earned, the bargain fee is missing."** It was. The
   bargain fee (30% of what each bargainable item sold for above the vendor's minimum) is held
   in a second platform account, and the platform earnings screen read only the commission one.
2. **"On each order, show who gets what and based on what, as soon as it can be known, so we
   can explain to a vendor why they got the amount they see."** New endpoint.

**Render what the API returns. Never compute money in the dashboard.** Every figure, including
the projected ones, comes from the backend's own split arithmetic.

---

## 1. Platform earnings — now commission AND bargain fee

### `GET /api/v1/money/earnings/platform` — additive, nothing removed

The top-level `pending` / `available` / `reserve` / `requested` / `currency` are **still the
commission account** (unchanged, so the current screen keeps working — but it is understating
what the platform made). New:

- `accounts.commission` and `accounts.bargainFee` — the two accounts, same four fields each.
- `total` — `{ pending, available, earned, currency }`. **`total.earned` is the headline number**
  for "what has the platform made". `total` is `null` only if the accounts ever hold two
  currencies (show the two accounts separately then).

### `GET /api/v1/money/earnings/platform/summary` — new

What was earned in a period: `?from=…&to=…` (both optional, ISO, half-open; none = all time).
Returns `currencies[]`, each with `commission`, `bargainFee` and `total`, each split into
`held` (in escrow), `released` (final), `reversed` (refunded, **not** in `earned`), `earned` and
`count`. ⚠ **Strict:** an unknown query key is a `400`.

### `GET /api/v1/money/earnings/platform/ledger` — default changed

New `?account=all|commission|bargain_fee`. **The default is now `all`**, so bargain-fee rows
appear in the feed where they did not before. Each row's `owner.type` says which account:
`platform` = commission, `platform_ai` = bargain fee. ⚠ `balancesAfter` belongs to that row's own
account — on an `all` page, do not chain it from one row to the next.

## 2. One order's money split — new

`GET /api/v1/money/orders/:orderId/split` · permission **`money.splits.read`** — **every tier,
Support included**.

- `charged` — what the customer paid: items, delivery charged with the order, delivery handed to
  the rider in cash, total.
- `sections[]` — one per moment the money moves: `payment` (prepaid items), `delivery` (one
  prepaid parcel's fee), `cash_collection` (one COD parcel, everything at once). Each has a
  `state`: `allocated` (real amounts) · `projected` (what it will be — **an estimate**) · `none`
  (`noneReason` says why) · `unavailable`.
- `sections[].goods` — the items' basis: `gross`, `bargainFee` (with **per-item lines**: price
  paid, vendor minimum, uplift, fee), `commission` (`percent`, `base` = gross − bargain fee,
  amount), `deliveryFeeCharged` (what the vendor pays of delivery), `codHandlingFee`, `vendorNet`.
- `sections[].delivery` — the parcel's basis: `fee` and where it came from, who paid it,
  `earnedFee`, the agent's `agentCut` (**`null` = no agent yet; the agency line includes it**)
  and contract (`agentSplit`), refunds.
- `sections[].lines[]` — **who gets what**: `role`, `beneficiary` (`type`, `id`, `name`),
  `amount`, `status` (`projected` · `held` · `released` · `reversed` · `owed`), and for a held
  line **`waitingOn`** — why it is not released yet (`order_not_completed` · `hold_window` with
  `holdReleaseAt` · `cash_not_settled`).
- `sections[].notes[]` — read these next to the numbers (see the table in money.md).
- `totals` — platform (commission, bargain fee, total), vendor, agencies, agents, customer
  refunds, reversed.
- `reconciliation` — `charged`, `distributed`, `difference`, `complete`. **`difference` is 0 on a
  normal order.**

---

## Your checklist

- [ ] **Platform earnings screen:** show `total.earned` as the headline, with commission and
      bargain fee beside it (`accounts.*`). Stop reading the top-level fields as "what we made".
- [ ] **Period view:** a date-range control over `/earnings/platform/summary` — commission,
      bargain fee, total; held / released / reversed.
- [ ] **Ledger:** an account filter (All · Commission · Bargain fee); label each row by
      `owner.type`.
- [ ] **Order detail → "Money" panel** (or tab), gated on `money.splits.read`: one block per
      section, with its state badge; the lines (who, amount, status, why it is waiting); an
      expandable "how this was calculated" from `goods` / `delivery`; the totals; and the
      reconciliation. Show a warning for `notes` `vendor_net_negative` and for any
      `difference ≠ 0`.
- [ ] **Projected sections must look projected** (e.g. an "Estimate" badge) — the rate and the
      agent's share can still change.
- [ ] **Permission vocabulary +1:** add `money.splits.read` to the local permission mirrors.
- [ ] Unknown values (`role`, `status`, `noneReason`, `notes`, `feeSource`) must render as plain
      text, never crash.
