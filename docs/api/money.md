# `/money` — earnings, payouts and settlements

Base path: `/api/v1/money`

Fourteen routes; eight had no legacy equivalent at all.

Design record: [`../ADR-011-ACCOUNTS-AND-FINANCE.md`](../ADR-011-ACCOUNTS-AND-FINANCE.md).

| Method | Path | Permission | Transport | Audited |
|---|---|---|---|---|
| `GET` | `/money/earnings/platform` | `money.earnings.read` | **delegated** | — |
| `GET` | `/money/earnings/platform/ledger` | `money.earnings.read` | direct read | — |
| `GET` | `/money/earnings/accounts` | `money.earnings.read` | **delegated** | — |
| `GET` | `/money/earnings/allocations` | `money.earnings.read` | direct read | — |
| `GET` | `/money/earnings/allocations/:allocationId` | `money.earnings.read` | direct read | — |
| `GET` | `/money/payouts` | `money.payouts.read` | direct read | — |
| `GET` | `/money/payouts/:payoutId` | `money.payouts.read` | direct read | — |
| `GET` | `/money/payouts/:payoutId/destination` | **`money.payouts.destination.read`** | direct read | ✅ **audited read** |
| `GET` | `/money/payouts/:payoutId/activity` | `money.payouts.read` **+** `audit.read` | direct read | — |
| `POST` | `/money/payouts/:payoutId/mark-paid` | `money.payouts.mark_paid` | **delegated** | ✅ **dual-controlled** |
| `POST` | `/money/payouts/:payoutId/reject` | `money.payouts.reject` | **delegated** | ✅ |
| `GET` | `/money/payments` | `money.payments.read` | direct read | — |
| `GET` | `/money/payments/:transactionId` | `money.payments.read` | direct read | — |
| `GET` | `/money/refunds` | `money.payments.read` | direct read | — |

## The transport rule

**Read the record; delegate the balance and every write.**

An earnings-ledger row is append-only and says what *moved*. A **balance** is a reconciliation
of four sub-balances that only the platform's transactions move, and a second implementation of
that arithmetic would be a second opinion about how much money exists.

## What Support can see here

Only **`money.payments.read`** — gateway payments and refunds. *"Did my payment go through, and
was I refunded"* is one of the commonest ticket questions, and the sharp fields (raw gateway
payload, payload hash, idempotency key) are removed by **projection**, for everyone, rather than
by permission.

Everything else on this mount is Admin and above.

## Vocabularies

Every platform vocabulary here is a **bounded string, not a pinned enum** — this service writes
against none of them. The cost is that `?status=PAID` (wrong case) answers an empty page rather
than a `400`. That is honest: it is a filter matching nothing.

---

# Earnings

## `GET /money/earnings/platform`

The platform's own commission account.

| | |
|---|---|
| **Permission** | `money.earnings.read` |
| **Transport** | **Delegated** — a balance is a verdict |
| **Parameters** | None |

### Response (200)

`data` is the platform's earnings-account object (pending, available, reserved, withdrawn).

---

## `GET /money/earnings/platform/ledger`

The movements behind that account. A **direct read** of the same account the route above
delegates.

| | |
|---|---|
| **Permission** | `money.earnings.read` |
| **Pagination** | `page`, `limit` |
| **Sorting** | `createdAt`, `amount`. Default **`-createdAt`** |

### Query parameters

| Parameter | Type | Notes |
|---|---|---|
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
| `entryType` | `hold` · `release` · `reversal` · `reserve_hold` · `reserve_release` |
| **`amount`** | **The positive magnitude moved — never signed.** Direction is `entryType`'s job. A client that subtracts on the sign alone gets `reserve_hold` backwards: it moves money *sideways* (pending → reserve), not in or out |
| `balancesAfter` | The balances immediately after this entry. **What makes the ledger checkable** |

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
| `snapshots` | **The split's inputs, frozen at the moment it ran.** `amount` alone says what a beneficiary got; with the gross and the rate it says whether that was *right* |
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
      "destination": {
        "method": "mobile_money",
        "isPreferred": true,
        "masked": {
          "mobileMoney": { "provider": "MTN", "phoneNumberMasked": null, "accountName": "Nadège Mbarga" },
          "bank": null,
          "card": null
        },
        "full": { "mobileMoney": null, "bank": null, "card": null }
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
| **`full.*`** | **Always present as a key, always `null` here.** A key that appeared only on the disclosure endpoint would make "this was not disclosed" and "this client is out of date" indistinguishable |

**An operator recognises a destination by its provider and account name** — "MTN · Nadège
Mbarga" — not by its last four digits. To see the digits, call the audited disclosure endpoint
below.

| Field | Notes |
|---|---|
| `destination` | **`null` on legacy rows predating the snapshot** — a different fact from a destination with no details |
| `resolvedBy` | `null` while pending. Nobody has resolved it, which is not the same as unknown |

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
    }
  }
}
```

**`full.card` is permanently `null`, by design.** Nobody sends money *to* a card token, and the
platform never stores a PAN.

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
| `purpose` | string, 1–40 | `primary` or `booking_balance` — a booking can be paid twice |
| `orderId` | 24-hex | |
| `bookingId` | 24-hex | |
| `userId` | 24-hex | **The payer — not one kind of id.** An order payment stores a *customer* id and a booking payment a *user* id. The filter matches whichever is stored, which is the only thing it can honestly do |
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
        "purpose": "primary"
      },
      "payer": { "id": "665f1c2a9b3e4a91c7d2e5f0", "kind": "customer_or_user" },
      "gateway": "mtn_momo",
      "method": "mobile_money",
      "gatewayRef": "MP260812.1402.A44127",
      "status": "succeeded",
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
| `payer.kind` | Always `"customer_or_user"` — **a deliberate `unknown` rather than a guess.** Nothing on the row says which |
| `gatewayRef` | **The string quoted in a dispute** |
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
| `initiatedBy.role` | **Who *asked* — `vendor`, `admin` or `customer`. Not who approved it** |
| `completedAt` | **When the money actually went back.** `null` on a `pending` or `failed` refund |
