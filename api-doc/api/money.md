# `/money` — earnings, payouts and settlements

**Verified against source on 2026-09-08** — all fourteen routes and their guards against the live route manifest; every query parameter, sort allowlist, bounded-string decision and the 366-day span against `money/validators/money.validator.ts`; and both `PayoutDestination` shapes — including `full` being the literal `null` on the masked path and the `revealed` discriminator, which the examples had wrong — against `money/read-models/payout-destination.dto.ts:82-240`.

⚠ The payout row's **`verification`** field was added on 2026-09-15 and is NOT covered by that
verification date — see the section under `GET /money/payouts` (BR-026 § 1).

Base path: `/api/v1/money`

Twenty-two routes on the mount (`test:money` § 10 pins the count — re-measured 2026-10-04, when the platform summary and the order split were added).

Design record: [`../../docs/ADR-011-ACCOUNTS-AND-FINANCE.md`](../../docs/ADR-011-ACCOUNTS-AND-FINANCE.md).

| Method | Path | Permission | Transport | Audited |
|---|---|---|---|---|
| `GET` | `/money/earnings/platform` | `money.earnings.read` | **delegated** | — |
| `GET` | `/money/earnings/platform/ledger` | `money.earnings.read` | direct read | — |
| `GET` | `/money/earnings/platform/summary` | `money.earnings.read` | direct read | — |
| `GET` | `/money/orders/:orderId/split` | **`money.splits.read`** (every tier) | **delegated** | — |
| `GET` | `/money/earnings/accounts` | `money.earnings.read` | **delegated** | — |
| `GET` | `/money/earnings/allocations` | `money.earnings.read` | direct read | — |
| `GET` | `/money/earnings/allocations/:allocationId` | `money.earnings.read` | direct read | — |
| `GET` | `/money/payouts` | `money.payouts.read` | direct read | — |
| `GET` | `/money/payouts/:payoutId` | `money.payouts.read` | direct read | — |
| `GET` | `/money/payouts/:payoutId/destination` | **`money.payouts.destination.read`** | direct read | ✅ **audited read** |
| `GET` | `/money/payouts/:payoutId/activity` | `money.payouts.read` **+** `audit.read` | direct read | — |
| `POST` | `/money/payouts/:payoutId/triage` | `money.payouts.triage` | **delegated** | ✅ |
| `POST` | `/money/payouts/:payoutId/send` | `money.payouts.mark_paid` | **delegated** | ✅ **dual-controlled** |
| `POST` | `/money/payouts/:payoutId/mark-paid` | `money.payouts.mark_paid` | **delegated** | ✅ **dual-controlled** |
| `POST` | `/money/payouts/:payoutId/reject` | `money.payouts.reject` | **delegated** | ✅ |
| `POST` | `/money/payouts/:payoutId/resolve-unknown` | `paid`: `money.payouts.mark_paid` · `failed`: `money.payouts.triage` | **delegated** | ✅ `paid` **dual-controlled** |

### Payout review is two stages, and only one of them moves money

**`/triage` is the pre-screen.** A reviewer endorses the request as genuine; it moves no money,
changes no status and gates nothing. `money.payouts.triage` is the **only** permission a
Support (tier 3) administrator holds on this surface, and the only `financial` permission that
tier holds anywhere — admitted by a named exemption in the grant table, on the grounds that its
one money-touching verdict (rejecting) merely releases a hold back to the owner it belongs to.

⛔ **Endorsement is advisory. A payout nobody has endorsed is exactly as payable as one that
has been.** Do not disable an approve control on a missing `triage`. The pre-screen exists to
save the approving administrator work, not to gate them — an empty Support queue must never
stall payments.

**There is no "reject" verdict on `/triage`.** A reviewer who rejects calls `/reject`, the same
terminal write anyone else makes. One outcome, one code path.

**`/send` and `/mark-paid` are two ways to perform one action** — assert that money left — so
they share `money.payouts.mark_paid` and therefore share the 2,000,000 XAF four-eyes threshold.
Giving `/send` its own permission would have created a second threshold free to drift from the
first.

| | `/send` | `/mark-paid` |
|---|---|---|
| Who moves the money | the platform, through the payment gateway | a human, out of band |
| Body | none | `{ reference? }` |
| Usual result | **`processing`** — confirmed later by callback | `paid` immediately |
| Works for | mobile-money destinations only | any destination, including bank and card |
| Available when the gateway is down | no | **yes** |

⚠ **A 200 from `/send` does not mean the money arrived.** Only `paid` is settled. `failed`
means the transfer was refused **and the funds are still held** — retry or reject.

⛔ **`processing` cannot be rejected** (`409`). Releasing a hold while a transfer may still be
in flight is how an owner gets paid twice.

**A payout stuck in `processing` has one manual exit: `/resolve-unknown`.** When the transfer
request timed out, nobody knows whether the money left, and the platform cannot ask the provider
without its transfer id. Such a row shows `transferFailureReason` starting `"Outcome unknown: …"`
and naming the reference to look up. An administrator checks the provider's own dashboard, then
records what they found — `paid` or `failed` — with a reason. See the endpoint below.
| `GET` | `/money/payments` | `money.payments.read` | direct read | — |
| `GET` | `/money/payments/:transactionId` | `money.payments.read` | direct read | — |
| `GET` | `/money/refunds` | `money.payments.read` | direct read | — |

## The transport rule

**Read the record; delegate the balance and every write.**

An earnings-ledger row is append-only and says what *moved*. A **balance** is a reconciliation
of four sub-balances that only the platform's transactions move, and a second implementation of
that arithmetic would be a second opinion about how much money exists.

## What Support can see here

**`money.payments.read`** — gateway payments and refunds. *"Did my payment go through, and
was I refunded"* is one of the commonest ticket questions, and the sharp fields (raw gateway
payload, payload hash, idempotency key) are removed by **projection**, for everyone, rather than
by permission.

**`money.splits.read`** (2026-10-04) — one order's money split, `GET /money/orders/:orderId/split`.
*"Why did I receive this amount?"* arrives as a vendor's ticket, and this answers it for one
order the way a statement answers it in bulk.

Everything else on this mount is Admin and above.

## Vocabularies

Every platform vocabulary here is a **bounded string, not a pinned enum** — this service writes
against none of them. The cost is that `?status=PAID` (wrong case) answers an empty page rather
than a `400`. That is honest: it is a filter matching nothing.

---

# Earnings

## `GET /money/earnings/platform`

What the marketplace holds: its **two** earnings accounts and their total.

⚠ **Until 2026-10-04 this returned the commission account alone**, so every answer to "how much
has the platform made" left out the **bargain fee** — 30% of what each bargainable line sold for
above the vendor's minimum. That fee is credited to a second platform account (`platform_ai`),
kept separate on purpose so it can be reported on its own. Read **`total`** for what the platform
made; read `accounts` to see the two parts.

| | |
|---|---|
| **Permission** | `money.earnings.read` |
| **Transport** | **Delegated** — a balance is a verdict |
| **Parameters** | None |

### Response (200)

```jsonc
{
  "success": true,
  "data": {
    // The COMMISSION account, at the top level — unchanged, so an older client keeps working.
    "pending": 6050, "available": 120000, "reserve": 0, "requested": 0, "currency": "XAF",
    "accounts": {
      "commission": { "pending": 6050, "available": 120000, "reserve": 0, "requested": 0, "currency": "XAF" },
      "bargainFee": { "pending": 4500, "available": 30000, "reserve": 0, "requested": 0, "currency": "XAF" }
    },
    "total": { "pending": 10550, "available": 150000, "earned": 160550, "currency": "XAF" }
  }
}
```

| Field | Notes |
|---|---|
| `accounts.commission` | The vendor's plan rate, taken from the items after the bargain fee |
| `accounts.bargainFee` | The bargain fee. 0 on a marketplace with no bargainable products sold |
| `pending` | Earned, still in escrow (the order has not completed, or its hold window has not passed) |
| `available` | Earned and final. Platform accounts are never paid out, so it only grows |
| `total.earned` | **What the platform has made, to date**, net of anything a refund reversed. The sum of all four sub-balances of both accounts |
| `total` | `null` if the two accounts ever hold different currencies — never a cross-currency sum |

For "what did we make **this month**", use `/money/earnings/platform/summary` — a balance cannot
answer a question about a period.

---

## `GET /money/earnings/platform/summary`

What the marketplace earned in a window, commission and bargain fee side by side. A **direct
read**: the sum of the platform's allocation records, dated by when each split ran — payment for
a prepaid order, the cash hand-over for COD (the same "date the money was received" rule the
vendor analytics use).

| | |
|---|---|
| **Permission** | `money.earnings.read` |
| **Parameters** | `from`, `to` — ISO-8601, both optional, half-open `[from, to)`. Neither ⇒ since the beginning. **No span cap.** ⚠ **Strict**: any other key is a `400` |

### Response (200)

```jsonc
{
  "success": true,
  "data": {
    "from": "2026-10-01T00:00:00.000Z",
    "to": null,
    "currencies": [
      {
        "currency": "XAF",
        "commission": { "held": 6050, "released": 1000, "reversed": 0,   "earned": 7050,  "count": 3 },
        "bargainFee": { "held": 4500, "released": 0,    "reversed": 300, "earned": 4500,  "count": 1 },
        "total":      { "held": 10550, "released": 1000, "reversed": 300, "earned": 11550, "count": 4 }
      }
    ]
  }
}
```

| Field | Notes |
|---|---|
| `currencies` | One entry per currency, ordered by code. `[]` when nothing was earned in the window |
| `held` | Earned, still in escrow |
| `released` | Earned and final |
| `reversed` | Taken back by a refund. **Not** part of `earned` |
| `earned` | `held + released` |
| `count` | Allocations behind `earned` |

---

## `GET /money/earnings/platform/ledger`

The movements behind those accounts. A **direct read** of the same accounts the route above
delegates — **both of them by default** since 2026-10-04.

| | |
|---|---|
| **Permission** | `money.earnings.read` |
| **Pagination** | `page`, `limit` |
| **Sorting** | `createdAt`, `amount`. Default **`-createdAt`** |

### Query parameters

| Parameter | Type | Notes |
|---|---|---|
| `account` | `all` · `commission` · `bargain_fee` | Default **`all`**. Each row names its own account in `owner.type` (`platform` = commission, `platform_ai` = bargain fee). ⚠ `balancesAfter` is **that row's account's** balance — on an `all` page, consecutive rows can belong to different accounts, so do not chain them |
| `entryType` | string, 1–40 | **The filter this endpoint exists for.** A `hold` is money arriving in escrow and a `release` is the same money becoming withdrawable — reading a page that mixes them without being able to separate them is how a ledger gets double-counted by eye |
| `reasonCode` | string, 1–40 | |
| `sourceType` | string, 1–40 | |
| `from` / `to` | ISO-8601 instant | **Max span 366 days** |

### Response (200)

```jsonc
{
  "success": true,
  "data": [
    {
      "id": "66a0aabbccddeeff00112233",
      "accountId": "66a0aabbccddeeff00112200",
      "owner": { "type": "platform", "id": null, "name": null },
      "entryType": "release",
      "amount": 2338,
      "balancesAfter": { "pending": 184220, "available": 902118 },
      "source": { "type": "order", "id": "6670aabbccddeeff00112233" },
      "allocationId": "66a1aabbccddeeff00112233",
      "reasonCode": "hold_elapsed",
      "createdAt": "2026-08-13T00:05:00.000Z"
    }
  ],
  "meta": { "total": 41208, "page": 1, "limit": 20, "pages": 2061 }
}
```

| Field | Notes |
|---|---|
| `entryType` | `hold` · `release` · `reversal` · `reserve_hold` · `reserve_release` · 🆕 `clawback` (a refund took back part of a share — out) · `clawback_recovery` (an inflow to available paid a refund debt down — out of available) · `clawback_write_off` (an administrator forgave a refund debt — no balance moves). Since the refund flow, 2026-10-05 |
| **`amount`** | **The positive magnitude moved — never signed.** Direction is `entryType`'s job. A client that subtracts on the sign alone gets `reserve_hold` backwards: it moves money *sideways* (pending → reserve), not in or out |
| `balancesAfter` | The balances immediately after this entry. **What makes the ledger checkable** |

---

## `GET /money/orders/:orderId/split`

**Who gets what from one order, and on what basis**, as early as it can be known. Built so
support can explain to a vendor why they received the amount they see.

| | |
|---|---|
| **Permission** | `money.splits.read` — **every tier, Support included** |
| **Transport** | **Delegated** to jovi-mall (`GET /api/internal/admin/earnings/orders/:orderId/split`). Before a split runs, its figures exist only as jovi-mall's own split arithmetic, so a copy here would be a second formula. Names are added here |
| **Errors** | `404 NOT_FOUND` — no such order |

### How an order is split — the sections

One order's money moves at up to three kinds of moment. Each is a **section**:

| `moment` | When | Who is in it |
|---|---|---|
| `payment` | prepaid order paid | the items: **bargain fee** (platform), **commission** (platform), **vendor net** |
| `delivery` | one prepaid parcel delivered (or returned) | that parcel's delivery fee: **agency**, **agent**, any **refund** of an unused fee |
| `cash_collection` | one COD parcel's cash handed over | everything at once: the items **and** the delivery fee for that parcel |

A prepaid order has one `payment` section plus one `delivery` section per parcel. A COD order has
one `cash_collection` section per parcel. A digital order has `payment` only.

| `state` | Meaning |
|---|---|
| `allocated` | The split ran. Every figure is the **real** amount, read from the money records |
| `projected` | Not yet. Every figure is what the split **would** write now. ⚠ An **estimate**: the commission rate is read again when the money moves, an agent's share is unknown until an agent accepts, and an agency can still re-price the delivery |
| `none` | Nothing will be split here — see `noneReason` |
| `unavailable` | The projection failed (logged on jovi-mall). Retry; report if persistent |

| `noneReason` | Meaning |
|---|---|
| `order_void` | The order was cancelled, failed or refunded before this moment |
| `returned_without_cash` | A COD parcel (or a cash-paid delivery fee) came back: no cash, nothing to split |
| `agency_paid_at_payment` | An old order whose agency was paid at payment (shown in the `payment` section) |

### Response (200) — the owner's example, prepaid, before payment

Sold at 65 000 over a 50 000 minimum, vendor on a 10% plan, vendor pays a 2 000 delivery.

```jsonc
{
  "success": true,
  "data": {
    "order": {
      "id": "…", "orderNumber": "ORD-2026-000123", "vendorId": "…", "vendorName": "Chez Ama",
      "customerId": "…", "currency": "XAF", "orderType": "physical",
      "paymentMethod": "mobile_money", "paymentStatus": "AWAITING_PAYMENT",
      "fulfillmentStatus": "pending", "deliveryPayer": "vendor",
      "completedAt": null, "createdAt": "2026-10-04T09:00:00.000Z"
    },
    "charged": { "items": 65000, "delivery": 0, "deliveryInCash": 0, "total": 65000 },
    "sections": [
      {
        "key": "payment", "moment": "payment",
        "source": { "type": "order", "id": "…" },
        "state": "projected", "noneReason": null, "shipment": null,
        "goods": {
          "gross": 65000,
          "bargainFee": {
            "percent": 30, "amount": 4500,
            "lines": [
              { "orderItemId": "…", "title": "Phone — Black", "unitPrice": 65000, "floorPrice": 50000,
                "quantity": 1, "uplift": 15000, "fee": 4500 }
            ]
          },
          "commission": { "percent": 10, "base": 60500, "amount": 6050 },
          "deliveryFeeCharged": 2000,
          "codHandlingFee": 0,
          "vendorNet": 52450
        },
        "delivery": null,
        "lines": [
          { "role": "vendor_net", "beneficiary": { "type": "vendor", "id": "…", "name": "Chez Ama" },
            "amount": 52450, "status": "projected", "allocationId": null, "holdReleaseAt": null,
            "releasedAt": null, "requiresCashSettlement": false, "cashSettledAt": null, "waitingOn": [] },
          { "role": "commission", "beneficiary": { "type": "platform", "id": null, "name": null }, "amount": 6050, "status": "projected", "…": "…" },
          { "role": "bargain_fee", "beneficiary": { "type": "platform_ai", "id": null, "name": null }, "amount": 4500, "status": "projected", "…": "…" }
        ],
        "notes": ["commission_rate_may_change"]
      },
      {
        "key": "shipment:…", "moment": "delivery",
        "source": { "type": "shipment", "id": "…" },
        "state": "projected", "noneReason": null,
        "shipment": { "id": "…", "trackingNumber": "DLX-261004-…", "status": "pending",
                      "agencyId": "…", "agencyName": "Douala Express", "agentId": null, "agentName": null },
        "goods": null,
        "delivery": {
          "fee": 2000, "feeSource": "snapshot", "payer": "vendor", "customerPaid": 0, "vendorBorne": 2000,
          "outcome": "expected", "earnedFee": 2000, "codHandlingFee": 0,
          "agentCut": null, "agentSplit": null, "refundToVendor": 0, "refundToCustomer": 0
        },
        "lines": [
          { "role": "delivery_agency", "beneficiary": { "type": "agency", "id": "…", "name": "Douala Express" }, "amount": 2000, "status": "projected", "…": "…" }
        ],
        "notes": ["agent_not_assigned"]
      }
    ],
    "totals": {
      "platform": { "commission": 6050, "bargainFee": 4500, "total": 10550 },
      "vendor": 52450, "agencies": 2000, "agents": 0, "customerRefunds": 0, "reversed": 0
    },
    "reconciliation": { "charged": 65000, "distributed": 65000, "difference": 0, "complete": true },
    "estimated": true,
    "holdDays": 7,
    "bargainFeePercent": 30
  }
}
```

### The fields that explain the money

| Field | Notes |
|---|---|
| `goods.gross` | What the items sold for. **Never** includes a delivery fee the customer paid |
| `goods.bargainFee.lines[]` | Per item: price paid, the vendor's **minimum** at checkout (`floorPrice`, `null` = not a bargainable item), `uplift` = (price − minimum) × quantity, `fee` = `percent`% of the uplift, rounded down |
| `goods.commission.base` | `gross − bargainFee`. **No commission is taken on the bargain fee** |
| `goods.deliveryFeeCharged` | The part of the delivery the **vendor** pays. 0 when the customer pays delivery |
| `goods.codHandlingFee` | COD only: the agency's fee for handling cash, paid by the vendor, on the goods only |
| `goods.vendorNet` | `gross − bargainFee − commission − deliveryFeeCharged − codHandlingFee` |
| `delivery.fee` | The agency's fee for the parcel. `feeSource`: `vendor_approved` (a fee change the vendor accepted) · `snapshot` (the price at checkout, or at cash collection) · `formula` (priced live — no snapshot) |
| `delivery.payer` | `vendor` or `customer`. `customerPaid` and `vendorBorne` split the fee between them |
| `delivery.outcome` | `expected` (not over, shown as if delivered) · `delivered` · `returned` |
| `delivery.earnedFee` | What the run earned — the whole fee if delivered, the agency's return fee if returned |
| `delivery.agentCut` | The agent's share. **`null` = no agent has accepted yet**, and the agency line then **includes** the agent's future share |
| `delivery.agentSplit` | The agent's contract: `{ model: percentage \| flat \| monthly_salary, percent, flatAmount }` |
| `delivery.refundToVendor` / `refundToCustomer` | The unused fee going back when a parcel is returned (or a customer paid above a lowered fee) |

### Lines — who gets what

| `role` | Beneficiary | What it is |
|---|---|---|
| `bargain_fee` | `platform_ai` | 30% of the uplift above the vendor's minimum |
| `commission` | `platform` | The vendor's plan rate on `gross − bargainFee` |
| `vendor_net` | `vendor` | What the vendor keeps from the items |
| `delivery_agency` | `agency` | The fee the run earned − the agent's cut + any COD handling fee |
| `delivery_agent` | `agent` | The agent's contracted share |
| `delivery_refund_vendor` | `vendor` | Unused vendor-paid fee returned |
| `delivery_refund_customer` | `customer` | Owed to the customer. **Not** an earnings line — it is settled through `/money/delivery-fee-refunds` |

| `status` | Meaning |
|---|---|
| `projected` | Not split yet |
| `held` | Split, in escrow. `waitingOn` says why it is not released: `order_not_completed` (escrow starts when the order completes) · `hold_window` (completed; releases at `holdReleaseAt`, `holdDays` after) · `cash_not_settled` (COD cash not yet back at the platform) |
| `released` | Final; in the beneficiary's withdrawable balance |
| `reversed` | Taken back by a refund. Excluded from `totals`, counted in `totals.reversed` |
| `owed` | A customer refund recorded and not yet paid |

`beneficiary.name` is the business name (a vendor's store, an agency's magazin) or an agent's
name. `null` for the two platform accounts and, deliberately, for the customer.

### `notes` — read the numbers right

| Note | Meaning |
|---|---|
| `commission_rate_may_change` | Projected: the vendor's plan rate is read again when the money moves |
| `agent_not_assigned` | The agent's share is inside the agency line until an agent accepts |
| `vendor_net_negative` | The costs exceed the items: **the split will refuse this order** (`EARNINGS_INVALID_SPLIT`). Escalate |
| `fee_not_charged_to_vendor` | A parcel created after payment: its fee was never deducted from the vendor |
| `legacy_agency_on_order` | An order paid before delivery fees were deferred: the agency was paid at payment |

### `reconciliation` — the check

`charged` is what the customer paid (online, plus any delivery fee handed to the rider in cash);
`distributed` is the sum of every non-reversed line. **On a normal order `difference` is 0**,
projected or allocated — the splits are built to add up exactly. A non-zero `difference` is a real
finding worth escalating. `complete` is `false` while any section is `none` / `unavailable` or a
line is reversed; the difference then means little.

---

## `GET /money/earnings/accounts`

Every owner's balances, ranked by what is withdrawable.

| | |
|---|---|
| **Permission** | `money.earnings.read` |
| **Transport** | **Delegated** |
| **Pagination** | `page`, `limit` |
| **Sorting** | **None offered** — the platform ranks these itself, over rows this service never sees. A `sort` parameter would be a promise it cannot keep |
| **Body/query** | **Strict** |

### Query parameters

| Parameter | Type |
|---|---|
| `ownerType` | string, 1–40 |
| `page`, `limit` | integer |

**No `search` either, and that is a recorded decision rather than an omission.** The
platform pages this by `available_balance` over rows this service never sees; a search term
would have to be pushed through the delegated call and matched against a name that lives in
a third collection (`stores`, `agency_magazins`, `delivery_agents`), which is the join the
`ownerName` below performs *after* paging. Searching before paging would mean joining
before paging, which is what makes the agency directory the one list on this service that
cannot use an index for its sort. An operator with a specific owner in mind should go
through that owner's directory and follow the link to
`/accounts/:ownerType/:ownerId`, which is the complete, server-side answer for one party.

### Response `200`

```jsonc
{
  "success": true,
  "data": [
    {
      "owner": { "type": "vendor", "id": "665a…", "name": "Douala Fresh Market" },
      "pending": 120000,
      "available": 480000,
      "reserve": 25000,
      "requested": 0,
      "clawback": 0,
      "currency": "XAF",
      "updatedAt": "2026-08-16T09:12:04.000Z"
    }
  ],
  "meta": {
    "total": 431, "page": 1, "limit": 20, "pages": 22,
    "totals": [
      { "currency": "XAF", "pending": 4120000, "available": 38900000, "reserve": 250000, "requested": 1200000 }
    ]
  }
}
```

| Field | Notes |
|---|---|
| `owner.name` | The **business** name where there is one — a Store, a Magazin — the contact name where there is not. **`null`, never `""`.** The same rule `billing.md` documents for `owner.name` on a subscription |
| `owner.id` | `null` only for the platform singleton, which this list excludes — so in practice always present here |
| `pending` · `available` · `reserve` · `requested` | Plain numbers in `currency` |
| `clawback` | **Since 2026-10-05 (refund flow).** Refund **debt**: what the owner owes BACK after a refund recovered more than their held earnings. Read directly from `earnings_accounts.clawback_balance`; `0` when they owe nothing. ⚠ The **opposite** direction from the four above — never add it to them. While it is above 0, `available` is 0 (every inflow pays it down first). Not in `meta.totals`; the per-currency debt total is on [`GET /money/earnings/clawbacks`](#refund-debt--moneyearningsclawbacks-2026-10-05) |
| `updatedAt` | ISO instant, `null` if the platform reports none |

> ### ⚠️ Never sum the four balances together
>
> They are stages of one pipeline, not four pots: `requested` is a claim already staked
> against `available`, so a per-owner total double-counts. `accounts.md` states the rule
> ("no grand total exists, at any level") and it still holds.

### `meta.totals` — the other axis, and the one only the platform can answer

One field, summed **across owners**, per currency. Same unit, same direction
(`owed_to_owner`), no cross-field addition.

- **An array**, one entry per currency present in the result set. A single object would
  force a currency choice the data does not support, and a client seeing one would
  reasonably assume every row shared it.
- **It respects `?ownerType=`**, so it can never disagree with the table above it — the
  totals and the page are computed over the same filter, in the same service, by
  construction.
- `[]` when the filtered set is empty.

It is computed by jovi-mall rather than by this service or the client for one reason: it is
the only party that can see past page 1.

---

## `GET /money/earnings/allocations`

**The collection that had no admin surface anywhere.** One row per `(source, beneficiary)` pair
— the unit every split is computed from.

| | |
|---|---|
| **Permission** | `money.earnings.read` |
| **Pagination** | `page`, `limit` |
| **Sorting** | `createdAt`, `amount`, `holdReleaseAt`. Default **`-createdAt`** |

### Query parameters

Three of these carry the whole point of the endpoint, and they answer one question in three
ways: **why has this money not been released?**

| Parameter | Type | Notes |
|---|---|---|
| `status` + sort by `holdReleaseAt` | | The hold window has not elapsed |
| `requiresCashSettlement` | boolean flag | COD — the platform has not physically received the cash yet |
| **`unsettledOnly`** | boolean flag, default `false` | The narrow form: cash is required **and** `cashSettledAt` is still null — the state a stuck remittance produces. A filter rather than something a client derives, because "required AND not yet settled" is a two-field predicate and a client composing it wrongly gets a plausible page instead of an error |
| `beneficiaryType` | string, 1–40 | |
| `beneficiaryId` | 24-hex | |
| `sourceType` | string, 1–40 | |
| `sourceId` | 24-hex | |
| `from` / `to` | ISO-8601 instant | Max span 366 days |

### Response (200)

```jsonc
{
  "success": true,
  "data": [
    {
      "id": "66a1aabbccddeeff00112233",
      "source": { "type": "order", "id": "6670aabbccddeeff00112233" },
      "beneficiary": { "type": "vendor", "id": "6650aa11bb22cc33dd44ee55", "name": "Douala Fresh Market" },
      "amount": 25162,
      "clawedAmount": 0,
      "currency": "XAF",
      "status": "held",
      "snapshots": { "gross": 27500, "commissionPercent": 8.5 },
      "release": {
        "completedAt": "2026-08-12T18:00:00.000Z",
        "holdReleaseAt": "2026-08-19T18:00:00.000Z",
        "releasedAt": null,
        "reversedAt": null,
        "requiresCashSettlement": true,
        "cashSettledAt": null
      },
      "createdAt": "2026-08-12T18:00:00.000Z",
      "updatedAt": "2026-08-12T18:00:00.000Z"
    }
  ],
  "meta": { "total": 903, "page": 1, "limit": 20, "pages": 46 }
}
```

| Field | Notes |
|---|---|
| `clawedAmount` | **Since 2026-10-05 (refund flow).** How much of `amount` refunds have taken back, cumulatively. `amount` is never edited; what is left to release is `amount − clawedAmount`, and the row turns `reversed` when nothing is left (from `held` **or** `released`). `0` on a row from before |
| `snapshots` | **The split's inputs, frozen at the moment it ran.** `amount` alone says what a beneficiary got; with the gross and the rate it says whether that was *right* |
| `snapshots.gross` | On `order` and `cod_collection` rows: the **goods** gross. Since jovi-mall ADR-A11 (customer-paid delivery, 2026-10-03) it is **not** the order total or the COD cash expected, either of which may include delivery the customer paid. On a `shipment` row it is the delivery fee reserved |
| **`release`** | **The reason this endpoint exists** — none of these four fields had an admin surface before |
| `release.holdReleaseAt` | `completedAt + HOLD_DAYS`. **`null` means the source has not completed at all** |
| `release.requiresCashSettlement` | COD: the money is physical cash, and release waits for it to arrive |
| `release.cashSettledAt` | **`null` alongside `requiresCashSettlement: true` is exactly "the cash is not here"** |

---

## `GET /money/earnings/allocations/:allocationId`

The allocation, what it actually moved, and its siblings on the same sale.

| | |
|---|---|
| **Permission** | `money.earnings.read` |
| **Path parameter** | `allocationId` — 24-hex |

### Response (200)

Every list field, plus:

| Field | Type | Notes |
|---|---|---|
| `movements` | ledger entries | **What it did**, as opposed to what it says. **A `held` allocation with no ledger rows is a real and alarming state**: money was allocated and never entered anybody's balance |
| `siblings` | allocations | **Every allocation cut from the same sale, this one included.** The only place the split is visible as a whole — a prepaid order produces a platform commission row and a vendor net row; a delivery adds the agency and the agent. *Do the parts sum to the gross?* is a question no other endpoint can ask |

---

# Payouts — where money leaves the platform

## Earnings pauses — `/money/earnings/pauses` (2026-10-05)

**Paused money is never paid out.** The platform pauses an order's or booking's earnings on its own
in four situations, and an administrator may pause any order or booking by hand:

| `pause.reason` | When | Also |
|---|---|---|
| `seller_cancelled_paid_order` | the seller cancelled an order the customer had already paid | a HIGH-priority `ORDER_REFUND` support ticket is opened |
| `booking_cancelled_unrefunded` | a paid booking was cancelled from the seller's **status menu** | a HIGH-priority `BOOKING_CANCELLATION` ticket is opened |
| `card_dispute` | the customer disputed the card payment with their bank | lifts **itself** when the dispute is won (or lost — the earnings are then reversed) |
| `admin` | an administrator paused it | — |
| 🆕 `refund_in_progress` | a **refund request** is open on it (any status before `completed` — even a small partial refund; REFUND-FLOW-PLAN C-4) | lifts **itself**: closed when the refund completes (after the earnings were clawed back), resumed when the request is rejected. Find the request with `GET /refunds?sourceId=<id>&open=true`. Resuming it by hand while the refund still holds it is refused (`409 EARNINGS_PAUSE_HELD_BY_REFUND`) |

A **completed** refund also closes a `seller_cancelled_paid_order` or `booking_cancelled_unrefunded`
pause on the same order or booking — the refund was what it was waiting for. `card_dispute` and
`admin` are never closed by a refund. Label suggestion: `refund_in_progress` → "Refund in progress".

**Closing a refund ticket:** refund the customer (raise a refund request at `POST /refunds` — completing it claws the earnings back), or,
if no refund is owed, **resume** the earnings. Resuming continues the hold where it stopped: the
paused time never counts. Since 2026-10-05 the hold is **3 days from delivery**
(the courier finishing the order's last parcel).

| Route | Permission | Audit |
|---|---|---|
| `GET /money/earnings/pauses` — the queue, newest pause first. Query `kind?` (`order`/`booking`), `page`, `limit` | `money.earnings.read` (tiers 1 + 2) | — |
| `GET /money/earnings/pauses/:kind/:id` — one record; `pause: null` if never paused | `money.earnings.read` | — |
| `POST /money/earnings/pauses/:kind/:id/pause` — body `{ "note": string (3–500) }` | `money.earnings.pause` (financial — tiers 1 + 2, **never Support**) | `money.earnings.pause_order` / `pause_booking`, fail-closed |
| `POST /money/earnings/pauses/:kind/:id/resume` — body `{ "note"?: string (1–500) }` | `money.earnings.pause` | `money.earnings.resume_order` / `resume_booking`, fail-closed |

All four are **delegated** to jovi-mall, which holds the pause record and the hold arithmetic.

**Queue row:** `{ kind, id, reference, vendorId, amount, currency, pause }` — `reference` is the order
number (`ORD-…`) or booking number (`BKG-…`); `amount` is what the customer paid.

**`pause`:** `{ active, reason, note, paused_at, paused_by_user_id, paused_by_source, paused_by_name,
resumed_at, resumed_by_user_id, resumed_by_source, resumed_by_name, resume_note }`. A pause the
platform raised has `paused_by_user_id: null` and `paused_by_name: "system"`; one an administrator
raised has `paused_by_source: "admin"` and their id and name.

**Errors:** `404 EARNINGS_PAUSE_TARGET_NOT_FOUND` (unknown id), `409 EARNINGS_ALREADY_PAUSED` (pause
twice — the first pause's reason is kept), `409 EARNINGS_NOT_PAUSED` (resume something not paused),
🆕 **`409 EARNINGS_PAUSE_HELD_BY_REFUND`** on resume (`details.refundRequestId`,
`details.refundRequestStatus`): a refund request on this order/booking is **open**, or a completed one
has **not finished recovering its earnings** (`earningsSettledAt: null`). Resuming would release
money the refund is about to claw back; the refund lifts or closes the pause itself. Raised **here**
before the audit row (jovi-mall answers the same as a backstop). Link to `GET /refunds/:refundId`.
A stale `refund_in_progress` pause with no such request stays resumable.

## Refund debt — `/money/earnings/clawbacks` (2026-10-05)

A refund recovers the seller's (and, after a lost dispute, everyone's) earnings from what is still held, then from `available`; what neither covers becomes **debt** (`clawback_balance`), paid down automatically by the owner's next earnings (REFUND-FLOW-PLAN § 6). When there will be no next earnings — the owner left, the account is closed — an administrator writes it off and the platform absorbs the loss (owner decision C-6). The refund queue itself is [refunds.md](refunds.md).

### `GET /money/earnings/clawbacks` — `money.earnings.read`

Every owner who owes something now, largest first. A **direct** read.

| Query | Notes |
|---|---|
| `ownerType` | `vendor` · `agency` · `agent` |
| `sort` | `amount` (the debt) · `updatedAt`, `-` for descending. Default `-amount` |
| `page`, `limit` | Standard pagination |

```jsonc
{
  "success": true,
  "data": [
    { "owner": { "type": "vendor", "id": "665a…", "name": "Chez Awa" }, "clawback": 4900, "currency": "XAF", "updatedAt": "2026-10-05T11:00:00.000Z" }
  ],
  "meta": { "total": 3, "page": 1, "limit": 20, "pages": 1,
            "totals": [ { "currency": "XAF", "clawback": 152000, "owners": 3 } ] }
}
```

`meta.totals` is the whole filtered debt per currency, not the page's.

### `POST /money/earnings/clawbacks/:ownerType/:ownerId/write-off` — `money.earnings.clawback.write_off`

```json
{ "amount": 4900, "reason": "Vendor closed their shop; nothing left to recover" }
```

`amount` whole and > 0, at most the current debt; `reason` 10–500 characters. Strict body.
`ownerType` is `vendor` · `agency` · `agent`.

- **`200`** — written off; `data` is the owner's remaining debt row (`clawback` may be `0`).
- **`202`** — `amount ≥ 2 000 000`: `data` is the pending approval. A second administrator holding `money.earnings.clawback.write_off` commits it at `/approvals`; the debt is re-checked then.

Errors: `409 EARNINGS_CLAWBACK_WRITE_OFF_EXCEEDS_DEBT` (`details.owed`, `details.requested`) — also raised when the owner owes nothing · `PLATFORM_OPERATION_REJECTED` with `details.platformCode` `EARNINGS_CLAWBACK_WRITE_OFF_EXCEEDS_DEBT` / `EARNINGS_CLAWBACK_NOTHING_OWED` if the debt moved in between.

Audit: `money.earnings.clawback.write_off_vendor` · `_agency` · `_agent`, filed against the owner, fail-closed. Financial, tiers 1 + 2; never Support.

## `GET /money/payouts`

The queue.

| | |
|---|---|
| **Permission** | `money.payouts.read` |
| **Pagination** | `page`, `limit` |
| **Sorting** | `createdAt`, `amount`, `resolvedAt`. Default **`-createdAt`** |

### Query parameters

| Parameter | Type | Notes |
|---|---|---|
| `status` | string, 1–40 | |
| `ownerType` | string, 1–40 | |
| `ownerId` | 24-hex | |
| `origin` | string, 1–40 | `manual` (the owner asked) or `auto_threshold` (the platform opened it for them) |
| `from` / `to` | ISO-8601 instant | Max span 366 days |

### Response (200)

```jsonc
{
  "success": true,
  "data": [
    {
      "id": "66a2aabbccddeeff00112233",
      "owner": { "type": "agency", "id": "665c0011223344556677889a", "name": "Littoral Express" },
      "amount": 3400000,
      "currency": "XAF",
      "status": "pending",
      "origin": "auto_threshold",
      "verification": { "verified": false, "verdict": "pending" },
      "destination": {
        "method": "mobile_money",
        "isPreferred": true,
        "masked": {
          "mobileMoney": { "provider": "MTN", "phoneNumberMasked": null, "accountName": "Nadège Mbarga" },
          "bank": null,
          "card": null
        },
        "full": null,
        "revealed": false
      },
      "ticketId": "66a3aabbccddeeff00112233",
      "requestedByUserId": null,
      "resolvedAt": null,
      "resolvedBy": null,
      "paidReference": null,
      "rejectionReason": null,
      "createdAt": "2026-08-13T00:10:00.000Z",
      "updatedAt": "2026-08-13T00:10:00.000Z"
    }
  ],
  "meta": { "total": 17, "page": 1, "limit": 20, "pages": 1 }
}
```

### ⚠️ `verification` — read it on every row before releasing funds

```jsonc
"verification": { "verified": false, "verdict": "pending" }
```

**Has a human vetted the business this money is going to?** Payout review is the platform's one
human checkpoint on money leaving it, and **`owner` being `active` stopped answering this on
2026-09-15**: accounts now activate themselves by verifying a phone number. Without this field an
active vendor with a plausible destination is indistinguishable from a stranger who registered
this morning.

| Member | |
|---|---|
| `verified` | **The only field to branch on.** `true` only when an administrator approved the business |
| `verdict` | `unverified` · `pending` · `verified` · `rejected` — **the role's own word**, for display |

- **Show it on every row**, not behind a detail click.
- ⛔ **Never read verified-ness as `verdict !== "rejected"`.** "Never reviewed" is not approval,
  and on a young platform that is most accounts.
- ⚠ **Do not flatten the vocabulary.** Vendor and agency default to `pending`; an **agent**
  defaults to `unverified` and reaches `pending` only once documents are submitted, so on an
  agent the two words separate "nothing submitted" from "submitted, waiting" — which is what
  tells a reviewer whether there is anything to chase. Render the word; branch on the boolean.
- ⚠ **It is information, not enforcement.** The platform does not refuse these payouts — working
  with an unverified counterparty is a business judgement. **Do not disable the pay action on
  it.**
- **Read fresh on every request**, unlike `destination` beside it. The snapshot there exists so a
  later profile edit cannot redirect money already in flight; a frozen verdict would do the
  opposite kind of harm, sending a reviewer to chase documents approved an hour ago.
- An owner that resolves in no directory reads as `{ verified: false, verdict: "unverified" }`.
  A missing row never renders as a silent approval.

> ⚠ **There is no filter or sort on it, deliberately — and this is the one thing here that is a
> refusal rather than a design.** BR-026 § 1 asked for one "if the list query will take one", and
> it does not. The verdict lives in `vendors` / `delivery_agencies` / `delivery_agents`; the queue
> pages over `payout_requests`. Filtering across them means a three-way `$lookup` keyed on
> `owner_type`, which would take the sort off its index and — more to the point — widen this
> repository past the projection that is the queue's security control (see `destination` above).
> The queue is scoped by `status` first and the pending page is small, so filter in the client.
> If the pending queue ever stops being small, the right answer is a denormalised verdict on the
> payout row, not a join here.

> **The same field appears on `GET /accounts/:ownerType/:ownerId/payouts`**, hydrated from the
> account being viewed.

> ⚠ **wi-admin computes this; it does not forward jovi-mall's.** jovi-mall added a `verification`
> field to its own admin payout DTO in the same release, and the two are deliberately identical in
> name and shape — but nothing passes between them. This queue reads `payout_requests` directly
> (ADR-009 D-1), so jovi-mall's DTO never crosses this wire. The consequence worth knowing: the
> field works as soon as **wi-admin** ships and does not wait on jovi-mall. The consequence worth
> watching: there is no shared package, so the two definitions of "what counts as verified" are
> held together only by `test:money` § 11 and jovi-mall's `test:payout-verification`.

### ⚠️ How to read `destination` on this endpoint

**The digits are absent because they were never read** — the query projection does not name
them. Not masked by a mapper that somebody could forget on the next endpoint; absent as a
property of every query the repository can run.

Consequently:

| Field | On this endpoint |
|---|---|
| `masked.mobileMoney.phoneNumberMasked` | **`null`** — not `••••3456` |
| `masked.bank.accountNumberMasked` | **`null`** |
| `masked.*.accountName`, `provider`, `bankName` | Present |
| `masked.card` | Present in full — `last4` is the entire number the platform holds, so rendering it is not a disclosure |
| **`full`** | **Always present as a key, and its value here is the literal `null`** — not an object whose members are null. A key that appeared only on the disclosure endpoint would make "this was not disclosed" and "this client is out of date" indistinguishable, so it is always sent |
| **`revealed`** | **`false` here, always.** This is the discriminator between the two shapes. **Never infer it from `full`** — a mapper that forgot to set it would then look like a masked one, which is the wrong direction for a mistake to fail in |

**An operator recognises a destination by its provider and account name** — "MTN · Nadège
Mbarga" — not by its last four digits. To see the digits, call the audited disclosure endpoint
below.

| Field | Notes |
|---|---|
| `destination` | **`null` on legacy rows predating the snapshot** — a different fact from a destination with no details |
| `resolvedBy` | `null` while pending. Nobody has resolved it, which is not the same as unknown |
| `transferGateway` | The aggregator the transfer went through, **stamped on the first attempt**; retries and callbacks follow the stamp, never the current routing switch. `null` means **either** no transfer was attempted **or** it was sent before the stamp existed — in which case it was `NOTCHPAY`, the only payout aggregator then. Passed through as stored, not resolved, because only the second meaning has an answer. An open string |
| `transferGatewayRef` | The aggregator's own transfer id, when one was issued. Never our merchant reference |

---

## `GET /money/payouts/:payoutId`

| | |
|---|---|
| **Permission** | `money.payouts.read` |
| **Response** | A single payout, same shape as the list |
| **Errors** | `400 VALIDATION_ERROR`, `404 NOT_FOUND` |

---

## `GET /money/payouts/:payoutId/destination`

**The one route on this service that emits a beneficiary's account number.**

| | |
|---|---|
| **Permission** | **`money.payouts.destination.read`** — the only `financial` **read** in the catalog. The flag keeps it out of family expansion and refuses it to Support at boot |
| **Parameters** | None |
| **Audited** | ✅ **Every call.** The row commits **before** the value is read, so with the audit store down nothing is disclosed |

This is the deliberate exception to "reads are not audited": the **disclosure is the action**.
Every call is answerable on `GET /money/payouts/:payoutId/activity`.

### Response (200)

The same `destination` object, with `full` populated for the method on file:

```jsonc
{
  "success": true,
  "data": {
    "method": "mobile_money",
    "isPreferred": true,
    "masked": {
      "mobileMoney": { "provider": "MTN", "phoneNumberMasked": "••••3456", "accountName": "Nadège Mbarga" },
      "bank": null,
      "card": null
    },
    "full": {
      "mobileMoney": { "phoneNumber": "+237677003456" },
      "bank": null,
      "card": null
    },
    "revealed": true
  }
}
```

**Here — and only here — `full` is an object rather than `null`,** and `revealed` is `true`.
Its members say what there *was*: a bank destination fills `bank.accountNumber` and leaves
`mobileMoney` null. **`full.card` is permanently `null`, by design** — nobody sends money *to* a
card token, and the platform never stores a PAN — so a card destination discloses
`{ mobileMoney: null, bank: null, card: null }` **with `revealed: true`**. That reads correctly:
this *was* the disclosure, and there was nothing further to give. Branch on `revealed`, never on
whether `full` is null.

### Errors

| Status | Code | When |
|---|---|---|
| 403 | `AUTHZ_PERMISSION_DENIED` | |
| 404 | `NOT_FOUND` | No such payout |
| 422 | **`PAYOUT_DESTINATION_ABSENT`** | **The payout exists and carries no destination.** Distinct from `NOT_FOUND` on purpose — a broken link and a legacy row an operator must resolve by asking the beneficiary are different problems |

### Audit

`money.payouts.destination.read`

---

## `GET /money/payouts/:payoutId/activity`

The audit trail for this payout — **including every destination disclosure**.

| | |
|---|---|
| **Permission** | `money.payouts.read` **+** `audit.read` |
| **Sorting** | `occurredAt` only. Default `-occurredAt` |
| **Filters** | `action` (only `money.payouts.*`, derived from the catalog), `status`, `from`/`to` (max 366 days) |
| **Response** | Audit entries — see [audit.md](audit.md#get-audit) |

This is where somebody reads back **who saw a beneficiary's account number**.

---

## `POST /money/payouts/:payoutId/mark-paid`

Record that money has left the platform. **The one dual-controlled action outside the
administrator directory.**

| | |
|---|---|
| **Permission** | `money.payouts.mark_paid` — `financial` + `dual-control` |
| **Transport** | Delegated |
| **Body** | **Strict** |

### Request body

| Field | Type | Rules |
|---|---|---|
| `reference` | string, 1–200 | Optional. The bank/transfer reference |

**The amount is not in the body, and that is load-bearing.** The controller reads the payout and
builds the dual-control payload from the row, so the threshold is evaluated against the money
that will actually move. A client that could name the amount could name `1999999` and skip the
second administrator — which is why an `amount` key is a **`400`**, not a silently ignored
field.

```json
{ "reference": "AFRILAND/TRF/2026-08-13/00412" }
```

### Response — under the threshold (200)

```json
{ "success": true, "data": { "…the payout, now paid…": "…" }, "message": "Payout marked paid" }
```

### Response — at or above 2 000 000 XAF (202)

**Nothing has been paid.** A second administrator must approve it.

```jsonc
{
  "success": true,
  "data": {
    "id": "66a4aabbccddeeff00112233",
    "action": "money.payouts.mark_paid",
    "description": "Mark payout request 66a2… PAID — XAF 3,400,000 to agency 665c…",
    "status": "pending",
    "expiresAt": "2026-08-14T09:14:02.331Z",
    "…": "…"
  },
  "message": "This payout is above the four-eyes threshold — submitted for a second administrator’s approval"
}
```

Repeating an identical request returns the same approval with
`"An identical request is already awaiting approval"`.

The threshold is **2 000 000 XAF** — the platform's own auto-payout threshold. See
[authorization.md](authorization.md) for the approval flow.

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | An `amount` key, or any unknown field |
| 404 | `NOT_FOUND` | |
| **409** | **`PAYOUT_NOT_PENDING`** | Already resolved. Raised on the **pre-flight**, so a doomed action is never queued in front of a second administrator, and **again** when an approval is committed — a payout resolved while the request sat in the queue is refused rather than paid twice |
| 502 / 503 | `SERVICE_DEPENDENCY_UNAVAILABLE` | |

### Audit

`money.payouts.mark_paid` — recorded at `status: "queued"` when it is queued, and again when it
is performed.

---

## `POST /money/payouts/:payoutId/reject`

The funds return to the owner's available balance.

| | |
|---|---|
| **Permission** | `money.payouts.reject` — `financial` |
| **Dual control** | **None, at any amount.** This direction is reversible — the owner simply requests again — and nothing leaves the platform. A quorum belongs on the irreversible direction only |
| **Body** | **Strict** |

### Request body

| Field | Type | Rules |
|---|---|---|
| `reason` | string | **Required**, 1–500 characters |

```json
{ "reason": "Destination account name does not match the registered business" }
```

### Response (200)

The updated payout, message
`"Payout request rejected — the funds returned to the owner's available balance"`.

### Audit

`money.payouts.reject`

---

## `POST /money/payouts/:payoutId/resolve-unknown`

Decide a transfer whose outcome is **unknown**. The payout is `processing`, the transfer request
timed out or gave no readable answer, and there is no callback and no provider transfer id to ask
about. An administrator checks the provider's dashboard for the reference in
`transferFailureReason`, and records the result.

| | |
|---|---|
| **Permission** | Depends on `outcome`. **`paid`** needs `money.payouts.mark_paid` (`financial` + `dual-control`). **`failed`** needs `money.payouts.triage`, so Support can record it |
| **Dual control** | **`paid` only**, on the same 2 000 000 XAF threshold as `/mark-paid` → **`202`** with an approval. `failed` moves no money and is never queued |
| **When** | `processing` only, **and** at least the reconciliation sweep's quiet period (default **15 min**) after the transfer was sent. Before that, a callback may still arrive |
| **Transport** | Delegated |
| **Body** | **Strict** |

### Request body

| Field | Type | Rules |
|---|---|---|
| `outcome` | `"paid"` \| `"failed"` | **Required** |
| `reason` | string | **Required**, 10–500 characters. What you checked and what it showed. It goes on the ticket and in the audit row. For `failed`, it is also stored as `transferFailureReason` |
| `evidence` | string, 1–500 | Optional. What the decision rests on: the provider's transaction id, a statement line, a support reply |

```json
{ "outcome": "paid", "reason": "MyCoolPay dashboard shows jm_po_8f2… SUCCESS at 14:02", "evidence": "MCP txn 77812" }
```

### What each outcome does

| `outcome` | Result | Money |
|---|---|---|
| `paid` | `paid`, settled exactly as a gateway confirmation. `resolvedBy` is **the administrator** (source `admin`, with a name snapshot), not the platform. The ticket is resolved with a note naming them and the reason | Debited from the held balance |
| `failed` | `failed`, the same state as a transfer the provider refused. Retry with `/send`, which reuses the same reference so the provider can deduplicate it, or `/reject` to release the funds | **Still held** — nothing is released |

⚠ **Choose `failed` only when you have confirmed the money did NOT leave.** Choosing `failed`
and then retrying a transfer that actually succeeded pays the owner twice. The stored reference
makes a provider that deduplicates refuse the second transfer, but do not rely on it. If you
cannot tell, wait.

### Response — applied (200)

The updated payout. Its message is `"Transfer confirmed as paid — the payout is settled"`, or
`"Transfer recorded as failed — the funds remain held; retry the transfer or reject the request"`.

### Response — `paid` at or above 2 000 000 XAF (202)

An `Approval`, as for `/mark-paid`. **Nothing has been settled yet.** The approval's
`description` ends `(transfer outcome was unknown; confirming it arrived: <reason>)`, so the
second administrator can see it is a judgement on evidence. When they approve, the payout is
checked **again** for `processing`.

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Missing or short `reason`, an unknown `outcome`, or any unknown field (`amount` included) |
| 403 | `AUTHZ_PERMISSION_DENIED` | `outcome: "paid"` without `money.payouts.mark_paid`, as a Support administrator has. `details.required` names the permission |
| 404 | `NOT_FOUND` | |
| **409** | **`PAYOUT_NOT_PROCESSING`** | The payout is not `processing` (`details.status`). Raised before anything is queued, and again when an approval is committed |
| **409** | `PLATFORM_OPERATION_REJECTED` + `platformCode: "EARNINGS_PAYOUT_TRANSFER_IN_FLIGHT"` | **Too soon.** `details.settleAfter` (ISO time) says when to try again, and `details.minAgeMinutes` gives the quiet period |
| 409 | `PLATFORM_OPERATION_REJECTED` + `platformCode: "EARNINGS_PAYOUT_NOT_PROCESSING"` | A callback or the reconciliation sweep settled it between your read and your write. **Reload the payout.** Nothing was written twice |
| 502 / 503 | `SERVICE_DEPENDENCY_UNAVAILABLE` | |

### Audit

`money.payouts.resolve_unknown_paid` or `money.payouts.resolve_unknown_failed`. The payload
carries `outcome`, `reason` and `evidence`. A queued `paid` is recorded at `status: "queued"`,
and again when it is performed, like `/mark-paid`. Both appear on
`GET /money/payouts/:payoutId/activity`, and the `action` filter accepts them.

---

# Gateway settlements

## `GET /money/payments`

What a customer actually paid.

| | |
|---|---|
| **Permission** | `money.payments.read` — **held by all three levels** |
| **Pagination** | `page`, `limit` |
| **Sorting** | `createdAt`, `amount`. Default **`-createdAt`** |

### Query parameters

| Parameter | Type | Notes |
|---|---|---|
| `status` | string, 1–40 | |
| `gateway` | string, 1–40 | |
| `method` | string, 1–40 | |
| `purpose` | string, 1–40 | `primary` · `booking_balance` (a booking can be paid twice) · `order_delivery_topup` (a higher delivery fee the customer approved after checkout — jovi-mall ADR-A11). **`?orderId=` returns an order's top-ups too**, deliberately: this list answers "what was paid for this order" — tell the halves apart by `settles.purpose`. ⚠ `?purpose=primary` is an exact match and misses any older row stored with no `purpose` at all |
| `orderId` | 24-hex | |
| `bookingId` | 24-hex | |
| `userId` | 24-hex | **The payer — not one kind of id.** An order payment stores a *customer* id and a booking payment a *user* id. The filter matches whichever is stored, which is the only thing it can honestly do |
| `reference` | string, 1–128 | **A payment reference, matched exactly against `gatewayRef` OR `merchantRef`.** One parameter for both because the person pasting one cannot tell which kind they hold: a customer reads *ours* off their record, a provider's dispute email quotes *theirs*. Exact equality, never a prefix — both fields are indexed and both values are quoted in full |
| `from` / `to` | ISO-8601 instant | Max span 366 days |

### Response (200)

```jsonc
{
  "success": true,
  "data": [
    {
      "id": "66a5aabbccddeeff00112233",
      "settles": {
        "orderId": null,
        "orderIds": ["6670aabbccddeeff00112233", "6670aabbccddeeff00112240"],
        "bookingId": null,
        "cartId": "6670aabbccddeeff00112200",
        "purpose": "primary",
        "deliveryTopup": null
      },
      "payer": { "id": "665f1c2a9b3e4a91c7d2e5f0", "kind": "customer_or_user" },
      "gateway": "NOTCHPAY",
      "provider": "MTN",
      "method": "MOBILE",
      "gatewayRef": "trx.p8Kq2mFh3xR7",
      "merchantRef": "jm_pt_9f2c41ab77e0463d8a15c6be02d7f318",
      "status": "SUCCEEDED",
      "amount": 54200,
      "currency": "XAF",
      "refunds": { "totalRefunded": 27500, "netAmount": 26700, "hasPartialRefund": true },
      "createdAt": "2026-08-12T14:02:31.000Z",
      "updatedAt": "2026-08-13T09:50:00.000Z"
    }
  ],
  "meta": { "total": 30411, "page": 1, "limit": 20, "pages": 1521 }
}
```

| Field | Notes |
|---|---|
| **`settles`** | Exactly one of the three is set. **`cartId` with `orderIds` is the common case and the one that surprises people**: a multi-vendor checkout is *one* payment settling *N* orders, so a row whose `orderId` is `null` is not an incomplete record |
| `settles.purpose` / `settles.deliveryTopup` | `order_delivery_topup` rows carry `deliveryTopup: { shipmentId, proposalId, appliedAt }` — the shipment and the fee proposal the top-up settles (`appliedAt` null = paid, not yet applied). **`null` on every other row.** A top-up links by `orderId` like a single-order payment, so it is **not the order's checkout charge** — see [`GET /orders/:orderId`](orders.md) → `deliveryFee.payments` for the two halves split |
| `payer.kind` | Always `"customer_or_user"` — **a deliberate `unknown` rather than a guess.** Nothing on the row says which |
| `gateway` | **Which aggregator carried it; informational.** An open, uppercase string — today `NOTCHPAY` · `MYCOOLPAY` · `STRIPE`, with `CAMPAY` and `FLUTTERWAVE` coming. **Never branch on it** and never validate it against a closed list: the active aggregator is switched at runtime ([`PUT /dev-tools/payments`](dev-tools.md#put-dev-toolspayments)), and a row keeps the one that actually carried it. `?gateway=` filters by exact value |
| `provider` | What the customer paid **with** — `MTN` · `ORANGE` · `MOOV` · `CARD`. **`null` on every row written before payment routing** (jovi-mall ADR-A08); there is no backfill. Also an open string |
| `method` | `MOBILE` · `CARD` · `CASH` |
| `gatewayRef` | **The provider's own reference — the string quoted in a dispute** |
| `merchantRef` | **Ours**, `jm_pt_<32 hex>`, minted per attempt and echoed back by the provider on its callback. `null` on rows written before the field existed and on any row whose provider never returned one. Searchable through `?reference=` |
| `status` | `INITIATED` · `PENDING` · `SUCCEEDED` · `FAILED` · `CANCELLED` · `REFUNDED`, uppercase |
| `amount` | The amount **at payment time**, never re-read off the order |
| `refunds.netAmount` | `amount − totalRefunded`, computed on the way out |

**Never returned, for anyone:** the raw gateway payload, the payload hash, the idempotency key.

---

## `GET /money/payments/:transactionId`

| | |
|---|---|
| **Permission** | `money.payments.read` |
| **Path parameter** | `transactionId` — 24-hex |

### Response (200)

Every list field, plus `refundTransactions` — the refunds against this payment.

`refunds.totalRefunded` says how much came back; these say **when, through which gateway and at
whose request**. A `pending` or `failed` row here beside a `totalRefunded` that has not moved is
what a **stuck refund** looks like.

---

## `GET /money/refunds`

The refund records. Under `money.payments.read`, deliberately **not** `orders.refund`:
`orders.refund` is the verb that *creates* one, and gating a read on the write's permission
would mean nobody could check a refund without being able to issue one.

| | |
|---|---|
| **Permission** | `money.payments.read` |
| **Pagination** | `page`, `limit` |
| **Sorting** | `createdAt`, `completedAt`, `amount`. Default **`-createdAt`** |

### Query parameters

| Parameter | Type |
|---|---|
| `status` | string, 1–40 |
| `gateway` | string, 1–40 |
| `vendorId` | 24-hex |
| `orderId` | 24-hex |
| `bookingId` | 24-hex |
| `paymentTransactionId` | 24-hex |
| `channel` | `card_refund` · `payout` · `external` (since 2026-10-05) |
| `refundRequestId` | 24-hex — the [refund request](refunds.md) the row completed |
| `from` / `to` | ISO-8601 instant, max 366 days |

**The date range filters `createdAt`, not `completedAt`** — ranging on the completion instant
would silently drop exactly the `pending` and `failed` rows somebody opens this list to find.

### Response (200)

```jsonc
{
  "success": true,
  "data": [
    {
      "id": "66a6aabbccddeeff00112233",
      "paymentTransactionId": "66a5aabbccddeeff00112233",
      "source": { "orderId": "6670aabbccddeeff00112233", "bookingId": null },
      "vendorId": "6650aa11bb22cc33dd44ee55",
      "userId": "665f1c2a9b3e4a91c7d2e5f0",
      "amount": 27500,
      "currency": "XAF",
      "reason": "Parcel never arrived; agent confirmed loss",
      "status": "completed",
      "gateway": "mtn_momo",
      "gatewayRefundRef": "MR260813.0950.B10233",
      "channel": null,
      "refundRequestId": null,
      "feeAmount": null,
      "netAmount": null,
      "initiatedBy": { "id": "665f…", "role": "admin" },
      "createdAt": "2026-08-13T09:48:00.000Z",
      "completedAt": "2026-08-13T09:50:00.000Z"
    }
  ],
  "meta": { "total": 402, "page": 1, "limit": 20, "pages": 21 }
}
```

| Field | Notes |
|---|---|
| `initiatedBy.role` | **Who *asked* — `vendor`, `admin`, `support` or `customer`. Not who approved it** |
| `amount` | The **gross** refunded — what analytics deduct. Unchanged meaning |
| `paymentTransactionId` · `gateway` | **`null` on a COD or externally-settled refund** (since 2026-10-05): no gateway payment was reversed. Branch on `channel`, not on these |
| `channel` | `card_refund` (Stripe) · `payout` (sent by mobile-money transfer) · `external` (paid outside the platform). `null` on a row from before the refund flow |
| `feeAmount` · `netAmount` | The refund transfer fee the platform kept, and what the customer received (`amount − feeAmount`). `null` on a legacy row (the customer received `amount`) |
| `refundRequestId` | The refund request this row completed — open it at `/refunds/:refundId`. `null` on a legacy row |
| `completedAt` | **When the money actually went back.** `null` on a `pending` or `failed` refund |

---

# Delivery-fee refunds — delivery money owed back to a customer

**Added 2026-10-04 (jovi-mall ADR-A11 W-E2 / wi-admin W-G2, owner decision D-12).**

When delivery money is owed back to a customer — a customer-paid fee lowered after they paid it,
the unspent fee of a returned parcel — jovi-mall refunds it through the payment gateway on its own.
When the gateway **cannot or will not** (a cash-on-delivery order, mobile money, an account with
refunds disabled) the ledger row becomes **`manual_required`**: a HIGH support ticket is opened and
the customer is told a person is sending it. **A person sends the money, then records it here.**

> 🆕 **Folded into the refund queue (REFUND-FLOW-PLAN § 7, 2026-10-05).** Delivery money owed back is
> now raised as a **refund request** and worked in [`/refunds`](refunds.md): approving it sends it,
> `settle-external` records a hand payment **with its picture proof**, and a reject puts the row back
> here. A row carries the request in **`refundRequestId`** — while it is set the row is **not
> settleable here** (`settleable: false`; jovi-mall refuses a settle with `409`
> `DELIVERY_FEE_REFUND_NOT_SETTLEABLE` + `details.refundRequestId`), so the button should link to
> `GET /refunds/:refundId` instead. This screen stays for rows that never had a request (written
> before the change, or where none could be opened) and rows whose request was **rejected**
> (`rejectedRefundRequestId`). ⚠ **Also not settleable while a refund of the whole ORDER is open**
> (`orderRefundRequest: { id, status }`): both come out of the same refundable ceiling. Finish or
> reject that request first.

| Route | Permission | Transport | Audited |
|---|---|---|---|
| `GET /money/delivery-fee-refunds` | `money.payments.read` (all three levels) | direct read of `delivery_fee_refunds` | — |
| `GET /money/delivery-fee-refunds/:refundId` | `money.payments.read` | direct | — |
| `POST /money/delivery-fee-refunds/:refundId/settle` | **`orders.refund`** (Developer + Admin; **never Support**) | **delegated** to jovi-mall | ✅ `orders.delivery_fee_refund.settle`, fail-closed |

**Why `orders.refund`.** Settling is a **customer refund** — money leaving the platform to the
person who paid for the order — which is exactly what `orders.refund` governs (`financial`). The
payout permissions govern money owed to vendors, agencies and agents. Support can **see** the queue
(to answer "where is my delivery refund") and cannot settle it.

## `GET /money/delivery-fee-refunds`

| | |
|---|---|
| **Pagination** | `page`, `limit` |
| **Sorting** | `createdAt`, `amount`. Default **`-createdAt`** |

| Parameter | Type | Notes |
|---|---|---|
| `status` | `manual_required` (default) · `settled` · `all` | **The queue, not the row status.** `manual_required` = still owed; `settled` = settled by an administrator; `all` = both. Automatic refunds (the gateway returned the money) are not the queue's — they appear on the order detail. An unknown value is a `400` |
| `orderId` · `vendorId` · `customerId` | 24-hex | |

### Response (200)

```jsonc
{
  "success": true,
  "data": [
    {
      "id": "6700aabbccddeeff00112233",
      "orderId": "66f0aabbccddeeff00112233",
      "orderNumber": "WM-2026-000123",
      "shipmentId": "66f1aabbccddeeff00112233",
      "customerId": "66a0aabbccddeeff00112233",
      "vendorId": "66b0aabbccddeeff00112233",
      "amount": 1500,
      "currency": "XAF",
      "status": "manual_required",
      "cause": "fee_decrease",
      "note": "The order was paid in cash at delivery — there is no charge to refund",
      "ticketId": "6701aabbccddeeff00112233",
      "refundRequestId": null,
      "rejectedRefundRequestId": null,
      "orderRefundRequest": null,
      "settleable": true,
      "refundTransactionIds": [],
      "settledAt": null,
      "settlement": null,
      "createdAt": "2026-10-04T10:00:00.000Z",
      "updatedAt": "2026-10-04T10:00:00.000Z"
    }
  ],
  "meta": { "total": 1, "page": 1, "limit": 20, "pages": 1 }
}
```

| Field | Notes |
|---|---|
| `status` | `manual_required` (owed) · `completed` · `processing` · `failed` (the last two only on automatic rows, via the detail or the order) |
| **`settleable`** | **The one flag the settle button needs** — `status === 'manual_required'`, **no `refundRequestId`**, and **no `orderRefundRequest`** |
| `orderRefundRequest` | 🆕 `{ id, status }` of an OPEN refund request of the whole order, or `null` — read from `refund_requests` (jovi-mall's own DTO does not carry it). While set, nothing on this order is settled by hand |
| `refundRequestId` | 🆕 The refund **request** returning this money, or `null`. When set, work it in the refund queue (`GET /refunds/:refundId`) — not here |
| `rejectedRefundRequestId` | 🆕 A request that was **rejected** for this money (history). The row is back on this screen, settleable again |
| `cause` | `fee_decrease` · `rto_leftover` (a returned parcel's unspent fee) · `sweep` |
| `note` | Why it is manual. **Operator-facing — never show it to the customer** |
| `ticketId` | The HIGH ticket the manual row opened; settling resolves it |
| `settlement` | Once settled: `{ method, reference, note, settledBy: { id, source, name }, settledAt }`. `settledBy.id` is a wi-admin administrator id when `source` is `admin` |

## `GET /money/delivery-fee-refunds/:refundId`

One row, same shape — **any** row, automatic ones included (`settleable: false`). `404 NOT_FOUND`
for an unknown id.

## `POST /money/delivery-fee-refunds/:refundId/settle`

```json
{ "method": "mobile_money", "reference": "MP241004.1234.A56789", "note": "Sent to the order's MTN number" }
```

| Field | | |
|---|---|---|
| `method` | **required** | `mobile_money` · `cash` · `bank` · `other` — the money was **sent by hand**. `covered_by_order_refund` — **no money moved**: a refund of the whole order already returned it |
| `reference` | optional, ≤ 200, nullable | the transfer's own reference |
| `note` | optional, ≤ 1000, nullable | lands on the ticket |

**`.strict()`** — any other key is a `400`. There is **no `amount`** (the row's amount is what is
settled) and **no `settledBy`** (the caller is the administrator).

**Rules — all jovi-mall's**, refused as **`409 PLATFORM_OPERATION_REJECTED`** with
`details.platformCode`:

| `details.platformCode` | When | What to do |
|---|---|---|
| `DELIVERY_FEE_REFUND_NOT_SETTLEABLE` | not `manual_required` — settled already, automatic, or another administrator won the race. **Or** the row is linked to a refund request that is still open, **or a refund of the whole order is open**: then `details.refundRequestId` and `details.refundRequestStatus` are set | reload the row; with `refundRequestId`, approve, settle or reject it in the refund queue instead |
| `DELIVERY_FEE_REFUND_ALREADY_COVERED` | online order: a refund of the whole order already returned this money, so paying again would pay it twice (`details` may carry `amount`, `stillReturnable`) | settle it `covered_by_order_refund` instead |
| `DELIVERY_FEE_REFUND_NOT_COVERED` | `covered_by_order_refund` on money the order still covers — or on a COD order, where nothing else can have returned it | send the money and use a paying method |

If the order could still return **part** of the money, `covered_by_order_refund` settles the covered
part and jovi-mall opens a **new `manual_required` row for the rest** on the same ticket — returned
as `remainder` (message: *"Partly covered by a refund of the whole order — the rest is still
owed"*). Pay that one by hand.

### Response (200)

```jsonc
{
  "success": true,
  "message": "Delivery-fee refund marked settled",
  "data": {
    "refund": { "id": "6700…", "status": "completed", "settleable": false, "amount": 1500,
                "settlement": { "method": "mobile_money", "reference": "MP241004.1234.A56789",
                                "note": "Sent to the order's MTN number",
                                "settledBy": { "id": "ad01…", "source": "admin", "name": "Awa N." },
                                "settledAt": "2026-10-04T12:00:00.000Z" }, "…": "…" },
    "remainder": null
  }
}
```

Both halves are this service's own read of the rows after the write — the same shape as the GET.

### Errors

| Code | Status | When |
|---|---|---|
| `VALIDATION_ERROR` | 400 | bad id, bad body, unknown key |
| `NOT_FOUND` | 404 | unknown refund |
| `PLATFORM_OPERATION_REJECTED` | jovi-mall's own 4xx (409; 404 with `platformCode: ORDER_NOT_FOUND` if the order is gone) | jovi-mall refused — see the table above |
| `SERVICE_DEPENDENCY_UNAVAILABLE` | 502 / 503 | jovi-mall unreachable or 5xx |

### Audit

`orders.delivery_fee_refund.settle` — `target: order` (so it appears on
`GET /orders/:orderId/activity`), payload `{ refundId, amount, currency, method, reference, note }`,
before/after `{ status, amount, settlementMethod, remainderRefundId, remainderOwed }`. **Fail-closed**: if the audit store is down the request fails and nothing reaches jovi-mall —
the intent row commits **before** the call. jovi-mall writes its own `admin_action_log` row
(`DELIVERY_FEE_REFUND_SETTLED`) in the settling transaction, then resolves the ticket and sends the
customer `order.delivery_fee.refund_settled` (not for `covered_by_order_refund`).
