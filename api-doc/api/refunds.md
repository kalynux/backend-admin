# `/api/v1/refunds` — the refund queue

**Since 2026-10-05 (refund flow, plan step R8).** Dashboard hand-off:
[../FRONTEND-CHANGELOG-refund-flow.md](../FRONTEND-CHANGELOG-refund-flow.md). Design record:
`PRODUCTION-READINESS/REFUND-FLOW-PLAN.md` (§ 2 decisions, § 7 this queue, § 11 the contract).

⚠ **Not live until jovi-mall ships its half.** Every write, the eligibility read and the proof
bytes are delegated to jovi-mall `/api/internal/admin/refunds/*`, which is being built in the same
release. Until it is deployed those routes answer `404`/`502` from the far side; the list and the
detail read `refund_requests` directly and work as soon as the collection exists.

## What a refund request is

Every refund to a customer — an order, a booking, a plan purchase or a credit top-up — is now a
**refund request** with a lifecycle. It is the step *before* money moves; `GET /money/refunds`
remains the ledger of money that already went back (`refund_transactions`).

```
awaiting_approval ──approve──▶ approved ──(COD, cash not yet at the platform)──▶ waiting_for_cash ──covered──▶ approved
      │                           │
      └──reject──▶ rejected       └──▶ sending ──gateway confirms──▶ completed
                                           │
                                           └──▶ failed ──retry──▶ sending
                                                   └──settle externally──▶ completed
```

| Status | Meaning | Open? |
|---|---|:-:|
| `awaiting_approval` | Raised; waiting for an approver. The seller's earnings on it are **paused** | ● |
| `approved` | Approved; the platform is about to send — or the send was refused **before** it was claimed (payouts switched off, the payout account short of float — see `transfer.failureReason`). Then **retry** it, or settle it externally | ● |
| `waiting_for_cash` | Cash on delivery: the cash is still with the agent or agency. Sends by itself once deposits cover the shipment | ● |
| `sending` | The transfer is with the gateway. Confirmed by callback or by the 15-minute sweep | ● |
| `failed` | The gateway refused or failed the transfer. Retry it, settle it externally, or reject | ● |
| `completed` | The money arrived (or was recorded as paid outside the platform). Earnings were clawed back | |
| `rejected` | Refused by an approver. The earnings pause lifts | |

One source can have **one open request** at a time (`409 REFUND_ALREADY_OPEN`).

### Money

| Field | Meaning |
|---|---|
| `grossAmount` | What the refund is worth. What analytics deduct and what is clawed back from earnings |
| `feeRate` / `feeAmount` | The refund transfer fee the platform keeps — 2 % by default (owner decision R-3), **0 on a card refund** |
| `netAmount` | What the customer receives: `grossAmount − feeAmount`. 5 000 → **4 900** |
| `attribution` | `{ goods, delivery }` — which part is goods and which is delivery money (sums to `grossAmount`) |

### Destination and proofs (R-7, R-7b)

- A mobile-money refund goes to **the number that paid** (`destination.source: 'payer'`).
- When no paying number is stored (COD, billing, some bookings) an administrator **types** one
  (`destination.source: 'typed'`) and must attach a **picture of the customer's message giving
  that number**. A typed number then needs a **second administrator** to approve it
  (`secondApproverRequired: true`).
- A refund **paid outside the platform** needs a **picture proof** of the payment.

Proof pictures go to jovi-mall's **private** `refund-proofs` tree through
`POST /refunds/proofs` — never `/files/upload`, whose trees are public — and are read back through
`GET /refunds/proofs/:fileId`, which writes an audit row before every read.

## Permissions

| Permission | Lets you | Tiers |
|---|---|---|
| `orders.refund.read` | the list, the detail, the activity feed (with `audit.read`), and opening proof pictures (audited) | 1 · 2 · 3 |
| `orders.refund.request` | the eligibility read, raising a request, uploading a proof | 1 · 2 · 3 (**financial** — Support holds it by name) |
| `orders.refund` | approve (four-eyes ≥ 2 000 000), reject, retry, resolve a stuck transfer | 1 · 2 |
| `orders.refund.settle_external` | record a refund as paid outside the platform, with proof | 1 · 2 |

**Support may hold, never send.** Raising a request pauses the seller's earnings, which is why
`orders.refund.request` is flagged `financial`; it is the second name on
`TIER_3_FINANCIAL_ALLOWLIST` beside `money.payouts.triage`. Nothing Support can do makes money
leave the platform. See [permissions.md § orders](permissions.md#orders).

Writing off a refund **debt** is on `/money`: [money.md § Refund debt](money.md#refund-debt--moneyearningsclawbacks-2026-10-05).

## Four-eyes

Two rules, and they are independent:

| Rule | When | Answer |
|---|---|---|
| **Large refund** | Approving a request whose `grossAmount` (read off the request, never the body) is **≥ 2 000 000** | **`202`** with a pending approval. A second administrator holding `orders.refund` approves it at `POST /approvals/:id/approve`, and **their** request performs the approval. Find it with `GET /approvals?targetId=<refundId>` |
| **Typed number (R-7)** | Approving a request whose destination was **typed**, by the administrator who typed it — at **any** amount | `409 REFUND_SECOND_APPROVER_REQUIRED`. Another administrator must approve |

Both can apply: a large refund to a typed number needs a second administrator for the approval
AND that approver must not be the one who typed the number. Both rules are re-checked when a
queued approval is committed (status still `awaiting_approval`, amount and currency unchanged,
approver not the typist).

**The older `POST /orders/:orderId/refund` refuses `≥ 2 000 000`** (`422 REFUND_USE_REFUND_QUEUE`,
`details: { requested, ceiling, queue: "/api/v1/refunds" }`) — before anything is written. That
route creates **and** approves a refund request in one call, so it has no second administrator;
the four-eyes line lives here. The line is **cumulative per order** — what the order already
returned (completed refunds) plus this amount (`details.alreadyRefunded`), so two refunds of
1 999 999 cannot pass it in pieces. With no `amount` the refusal is decided against jovi-mall's
`maxRefundable`. jovi-mall refuses the same as a backstop. See [orders.md](orders.md).

## Common response shape — the refund request

```json
{
  "id": "6701a0b2c3d4e5f6a7b8c901",
  "source": { "kind": "order", "id": "66f3…44", "number": "WM-2026-001234" },
  "vendor": { "id": "66f2…33", "name": "Chez Awa" },
  "customerId": "66f0…01",
  "reasonKind": "return",
  "reason": "Sandals arrived with a broken strap",
  "itemDefective": true,
  "overridePolicy": false,
  "earningsImpact": "clawback",
  "attribution": { "goods": 5000, "delivery": 0 },
  "grossAmount": 5000,
  "feeRate": 2,
  "feeAmount": 100,
  "netAmount": 4900,
  "currency": "XAF",
  "paymentChannel": "mobile_money",
  "channel": "payout",
  "destination": { "phone": "+2376••••4417", "name": "Awa N.", "source": "payer" },
  "destinationProofFileId": null,
  "secondApproverRequired": false,
  "codCollectionIds": [],
  "status": "awaiting_approval",
  "requestedBy": { "id": "6650…aa", "role": "support", "name": "Support Agent" },
  "approvedBy": null,
  "rejectedBy": null,
  "rejectionReason": null,
  "transfer": { "gateway": null, "gatewayRef": null, "failureReason": null, "note": null, "legs": [] },
  "externalSettlement": null,
  "ticketId": "66f9…77",
  "refundTransactionIds": [],
  "completedAt": null,
  "earningsSettledAt": null,
  "billingReversedAt": null,
  "createdAt": "2026-10-05T10:00:00.000Z",
  "updatedAt": "2026-10-05T10:00:00.000Z"
}
```

- **`destination.phone` is masked in the list** (`+2376••••4417`) and **in full on the detail**
  and on every write's answer — the approver of a typed number compares it with the proof.
- `transfer.legs[]` — one per paying number when the payments came from different numbers:
  `{ phone (masked), amount (NET sent), gross, gatewayRef, status, failureReason }`.
- `approvedBy` / `rejectedBy` — `{ id, name, at }`; an administrator id is a wi-admin id.
- `externalSettlement` — `{ method, reference, proofFileId, settledBy: { id, name }, settledAt, grossAmount, netAmount }`.
  `grossAmount` / `netAmount` are the part **paid by hand**: the whole request, or — after a
  multi-transfer refund part of which already arrived — **only the unpaid remainder**. A row settled
  before 2026-10-05 has no value of its own and reports the request's totals. Show these, not the
  request's, as "paid by hand".
- `earningsSettledAt` — a completed order/booking refund with `earningsImpact: 'clawback'`: when the
  earnings recovery finished. `null` = still due (a nightly sweep retries it; the earnings pause
  stays until then).
- `billingReversedAt` — a completed `plan_purchase` / `credit_topup` refund: when the plan was
  downgraded or the credits debited back. `null` = still due (the same sweep retries it).
- `transfer.failureReason: "exceeds_refundable"` — money left the source by another road since the
  request was raised (e.g. a delivery-fee refund paid by hand). The send was refused before any
  money moved and an `approved` request was moved to `failed`: **reject it and raise a smaller one**.
- `requestedBy.role` — `vendor` · `admin` · `support` · `system` · `customer`.
- `earningsImpact` — `clawback` (completing it recovers the earnings it touches; they are **paused** while it is open) or `none` (delivery money that was never allocated to anybody, e.g. a delivery-fee decrease refunded through the queue: nothing is paused or clawed back). An older row reads `clawback`.
- `ticketId` — the support ticket the request was raised from, when there is one.
- Every key is present; absent data is `null` (never omitted). Our merchant transfer reference
  is never on the wire — `transfer.gatewayRef` is the provider's own id.

## GET /api/v1/refunds — `orders.refund.read`

The queue, newest first.

| Query | Notes |
|---|---|
| `status` | One of the seven statuses above. An unknown value is a `400` |
| `open` | `true`: the five open statuses (the working queue). Ignored when `status` is given |
| `sourceKind` | `order` · `booking` · `plan_purchase` · `credit_topup` |
| `sourceId` · `vendorId` · `customerId` | ids |
| `requesterRole` | `vendor` · `admin` · `support` · `system` · `customer` |
| `requesterId` | an administrator's id (wi-admin) or a vendor's user id |
| `channel` | `card_refund` · `payout` · `external` |
| `paymentChannel` | `card` · `mobile_money` · `cod` · `billing` |
| `from`, `to` | ISO instants on `createdAt`, half-open `[from, to)`, ≤ 366 days |
| `sort` | `createdAt` · `updatedAt` · `grossAmount`, `-` for descending. Default `-createdAt` |
| `page`, `limit` | Standard pagination (`limit` ≤ 100) |

Unknown query keys are ignored (the list convention). Answer: `{ data: RefundRequest[], meta: { total, page, limit, pages } }`.

## GET /api/v1/refunds/eligibility — `orders.refund.request`

**Delegated** to jovi-mall `GET /api/internal/admin/refunds/eligibility` and passed through
unchanged: what may be refunded, how, and what the customer would receive. Use it to fill the
"raise a refund" form, and call it again as the administrator changes the reason or the amount.

| Query | Notes |
|---|---|
| `sourceKind` | **required** — `order` · `booking` · `plan_purchase` · `credit_topup` |
| `sourceId` | **required** — id |
| `reasonKind` | optional — selects which row `maxRefundable` reports. Default: `return` if the order was delivered, else `cancellation` |
| `itemDefective` | optional, `true` / `false` — only matters under the vendor's "customer pays, reimbursed if defective" return-shipping setting |
| `amount` | optional, whole XAF — decides whether `above_policy_maximum` is in `overrides` (default: `maxRefundable`) |

Only these five are forwarded (jovi-mall's query is strict); any other key is dropped here.

```jsonc
{
  "sourceKind": "order", "sourceId": "66f3…44",
  "maxRefundable": 6000,                 // GROSS: min(attribution rule, money still refundable)
  "currency": "XAF", "paymentChannel": "mobile_money",
  "hasPayerPhone": true, "payerPhoneMasked": "+•••••••••417",
  "attributionPreview": {
    "reasonKind": "cancellation", "itemDefective": null,
    "goods": 5000, "delivery": 1000,     // of maxRefundable
    "goodsAmount": 5000, "deliveryAmountPaid": 1000, "delivered": false,
    "remaining": 6000,                   // money still refundable, before the attribution rule
    "feeAmount": 120, "netAmount": 5880, // of maxRefundable
    "byReasonKind": {                    // the same five numbers for EVERY reason — switch without a second call
      "cancellation": { "maxRefundable": 6000, "goods": 5000, "delivery": 1000, "feeAmount": 120, "netAmount": 5880 },
      "return":       { "maxRefundable": 5000, "goods": 5000, "delivery": 0,    "feeAmount": 100, "netAmount": 4900 },
      "goodwill": { … }, "dispute_settlement": { … }
    }
  },
  "returnShippingPayer": "customer",     // vendor | customer | customer_reimbursed_if_defect | null
  "overrides": [],                       // vendor return-policy gates a refund would cross (orders only)
  "codCoverage": [],                     // COD: one row per cash collection
  "feePercent": 2                        // 0 for a card payment
}
```

- `overrides` — `return_window_expired` · `policy_disabled` · `order_not_paid` ·
  `above_policy_maximum`. **Non-empty means `POST /refunds` needs `overridePolicy: true`** — show the
  list and let the administrator confirm it; this service never sets the flag for them. Always `[]`
  for bookings and billing.
- `codCoverage[]` — `{ collectionId, shipmentId, kind: 'order'|'delivery_fee', expected, settled,
  settledAt, status }`. A COD refund sends only once every collected row has `settledAt`.
- Errors: `PLATFORM_OPERATION_REJECTED` with `details.platformCode` `REFUND_ORDER_NOT_FOUND` (404),
  `REFUND_PAYMENT_NOT_FOUND` (404), `REFUND_ORDER_NOT_PAID` (409).

## GET /api/v1/refunds/:refundId — `orders.refund.read`

One request, destination in full. `404 NOT_FOUND` for an unknown id.

## GET /api/v1/refunds/:refundId/activity — `orders.refund.read` + `audit.read`

The audit rows filed against this request (raised, approved, rejected, settled, …), with the same
query and shape as `GET /money/payouts/:payoutId/activity` (`action` limited to `orders.refund.*`).
A request still waiting for a second administrator is at `GET /approvals?targetId=<refundId>`.

## POST /api/v1/refunds — `orders.refund.request`

Raise a request. It is created `awaiting_approval` and the seller's earnings are paused.

```json
{
  "sourceKind": "order",
  "sourceId": "66f3…44",
  "amount": 5000,
  "reasonKind": "return",
  "reason": "Sandals arrived with a broken strap",
  "itemDefective": true,
  "overridePolicy": false,
  "destination": { "phone": "+237 6XX XXX XXX", "name": "Awa N." },
  "destinationProofFileId": "6702…99",
  "approveNow": false,
  "ticketId": "66f9…77"
}
```

| Field | Rule |
|---|---|
| `amount` | Whole XAF, > 0. **Omit** to refund the maximum refundable. ⛔ **Not accepted for `plan_purchase` / `credit_topup`** (`400` on `amount`): a billing refund takes the plan or the credits back, which cannot be done in part, so it is **full only** — omit `amount` |
| `reasonKind` | `cancellation` · `return` · `goodwill` · `dispute_settlement` |
| `reason` | Required, 3–1000 characters |
| `itemDefective` | Only matters when the vendor reimburses return shipping "if defective" (C-1) |
| `overridePolicy` | Confirms going past the **vendor's return policy** (the eligibility read's `overrides[]`). Sent only when the administrator confirmed it — never automatically. Without it, an order refund beyond the policy is `422` `REFUND_POLICY_OVERRIDE_REQUIRED` with `details.overrides` |
| `destination` | Only when typing a number: `{ phone, name? }` — `phone` in international form (`+237…`), spaces allowed; `name` optional. **Requires** `destinationProofFileId` |
| `destinationProofFileId` | A file from `POST /refunds/proofs` — it must be a live file in the private `refund-proofs` tree (else `422 REFUND_DESTINATION_PROOF_REQUIRED`, `details.reason: "proof_not_found"`). Refused without a typed `destination` |
| `ticketId` | Optional — the support ticket this refund was raised from |
| `approveNow` | Approve straight after creating. Needs `orders.refund` (else `403`). Goes through the same approve path, four-eyes included |

The body is strict: an unknown key is a `400`. There is no `requestedByRole` — it is `admin` when
the caller holds `orders.refund` and `support` otherwise.

**Response `201`** — the request (full destination), and `meta.approveNow`:

| `meta.approveNow.status` | Meaning |
|---|---|
| `not_requested` | Created, waiting for an approver |
| `applied` | Created and approved — the platform is sending (or waiting for COD cash) |
| `queued` | Created; the approval is **≥ 2 000 000** and waits for a second administrator (`meta.approveNow.approval` is the pending approval) |
| `second_approver_required` | Created; the number was typed, so another administrator must approve |
| `failed` | Created; approving it failed. `meta.approveNow.error` is `{ code, message, details }` of the approve call. The request exists — do not retry the create |

Errors: `400 VALIDATION_ERROR` · `403 AUTHZ_PERMISSION_DENIED` (`approveNow` without `orders.refund`) ·
and jovi-mall's refusals as `PLATFORM_OPERATION_REJECTED` with `details.platformCode`:

| Status | `details.platformCode` | When / what else is in `details` |
|---|---|---|
| 422 | `REFUND_POLICY_OVERRIDE_REQUIRED` | An order refund beyond the vendor's return policy without `overridePolicy: true`. `details.overrides` names the gates — show them, and re-send with `overridePolicy: true` once confirmed |
| 422 | `REFUND_DESTINATION_PROOF_REQUIRED` | The proof id is not a live file in the `refund-proofs` tree (`details.reason: "proof_not_found"`) — upload it through `POST /refunds/proofs` |
| 422 | `REFUND_NO_DESTINATION` | The typed number could not be read (`details.reason: "typed_phone_invalid"`) |
| 400 | `REFUND_AMOUNT_EXCEEDS_MAX` | `details.maxRefundable` |
| 409 | `REFUND_ALREADY_OPEN` | One open request per source |
| 422 | `REFUND_NOT_ELIGIBLE` | `details.reason: "billing_full_refund_only"` (`details.required`): a billing refund for less than the full amount. Refused here first (above), so normally unseen |
| 409 | `REFUND_ORDER_NOT_PAID` · `REFUND_ALREADY_FULLY_REFUNDED` | Nothing to refund |
| 404 | `REFUND_ORDER_NOT_FOUND` · `REFUND_PAYMENT_NOT_FOUND` | No such source / no settled payment |

## POST /api/v1/refunds/:refundId/approve — `orders.refund`

Body `{}` (strict). Only from `awaiting_approval`.

- **`200`** — approved; the answer is the request (usually `sending`, or `waiting_for_cash`,
  `completed` for a card refund, `approved` with `transfer.failureReason: insufficient_gateway_balance`).
- **`202`** — `grossAmount ≥ 2 000 000`: `data` is the pending approval (`id`, `action: "orders.refund"`,
  `description`, `expiresAt`, …). Nothing has been approved yet.

Errors: `404 NOT_FOUND` · `409 REFUND_REQUEST_STATUS_CONFLICT` (`details.status`, `details.allowedFrom`) ·
`409 REFUND_SECOND_APPROVER_REQUIRED` · platform codes `REFUND_PAYOUT_UNAVAILABLE` (422),
`REFUND_INSUFFICIENT_GATEWAY_BALANCE` (409), `REFUND_NO_DESTINATION` (422).

## POST /api/v1/refunds/:refundId/reject — `orders.refund`

`{ "reason": "…" }` (3–500, required). Only from `awaiting_approval` or `failed` — **never from
`sending`**: the transfer may already be in flight. The earnings pause lifts. Never four-eyed.

## POST /api/v1/refunds/:refundId/retry — `orders.refund`

Body `{}`. From `failed`, or from `approved` when the send was refused **before** it was claimed
(payouts off, a short float — `transfer.failureReason` says which). jovi-mall sends again **with the
same transfer reference** (none was minted for an `approved` one), so a retry can never pay twice.
Never four-eyed — the money was already approved. Platform codes: `REFUND_REQUEST_STATUS_CONFLICT` (409)
with `details.reason: "exceeds_refundable"` (`details.remaining`, `details.grossAmount` — the source no
longer holds this much; nothing was sent: reject and raise a smaller one), `REFUND_PAYOUT_UNAVAILABLE` (422),
`REFUND_INSUFFICIENT_GATEWAY_BALANCE` (409, `details.required` / `available`), `REFUND_NO_DESTINATION` (422).

## POST /api/v1/refunds/:refundId/settle-external — `orders.refund.settle_external`

Record that the refund was paid **outside the platform** — it completes the request (earnings are
clawed back, the customer is told).

```json
{ "method": "mobile_money", "reference": "MP241005.1234.A00001", "proofFileId": "6702…99" }
```

`method`: `mobile_money` · `cash` · `bank` · `other`. `proofFileId` is **required** (R-7b) and must be a
live file in the `refund-proofs` tree — otherwise `422` `details.platformCode: REFUND_EXTERNAL_PROOF_REQUIRED`
(`details.reason: "proof_not_found"`). The refund fee still applies.

**After a multi-transfer refund part of which already arrived**, the administrator pays **only the
remainder**: the answer's `externalSettlement.grossAmount` / `netAmount` are that remainder — show
them as what to hand over. `409` `REFUND_REQUEST_STATUS_CONFLICT` also when nothing is left to pay by
hand, or with `details.reason: "exceeds_refundable"` (the source no longer holds this much).
Allowed from `awaiting_approval`, `approved`, `waiting_for_cash` and `failed` — **never `sending`**.

## POST /api/v1/refunds/:refundId/resolve-unknown — `orders.refund`

A transfer stuck in `sending` that nobody can ask the gateway about.

```json
{ "outcome": "arrived", "note": "Provider statement line 42 shows it paid" }
```

`arrived` completes it; `failed` puts it in `failed` (retry, settle externally or reject).
Approving can also land a request in `failed` with `transfer.failureReason: "exceeds_refundable"` (see the response shape).
`note` ≥ 10 characters. Only from `sending`, and jovi-mall also refuses a request younger than its
reconciliation sweep's minimum age (a callback may still arrive).

## POST /api/v1/refunds/proofs — `orders.refund.request`

Upload **one** proof picture. `multipart/form-data`, field **`file`**. The body is streamed to
jovi-mall's private `refund-proofs` tree and never stored here; `ADMIN_UPLOAD_MAX_BYTES` applies.

**Response `201`**: `{ "data": { "fileId": "6702…99" }, "meta": { "maxBytes": …, "fieldName": "file" } }`.
Use the `fileId` as `destinationProofFileId` or `proofFileId`.

Errors: `415 FILE_UPLOAD_NOT_MULTIPART` · `413 FILE_UPLOAD_TOO_LARGE` · jovi-mall's type/size refusals.

## GET /api/v1/refunds/proofs/:fileId — `orders.refund.read`

The picture's **bytes** (not an envelope), with jovi-mall's `Content-Type`, `Cache-Control:
private, no-store`. Served **only when a refund request names the file** (as its destination proof
or its external-settlement proof) — otherwise `404 FILE_NOT_FOUND`. **Every read is audited
first** (`orders.refund.proof.read`); with the audit store down, nothing is shown.

## Audit

Every write is recorded **fail-closed** — the row commits before jovi-mall is asked, and if that
fails nothing happens.

| Action | Route | Target |
|---|---|---|
| `orders.refund.request` | `POST /refunds` | the request (related: the order / booking) |
| `orders.refund.approve` | `POST /:refundId/approve` (and the approver's commit of a queued one, with `viaApprovalId`) | the request |
| `orders.refund.reject` · `.retry` · `.resolve_unknown` · `.settle_external` | the verbs above | the request |
| `orders.refund.proof.upload` | `POST /refunds/proofs` | the file |
| `orders.refund.proof.read` | `GET /refunds/proofs/:fileId` | the file (related: the request) |

No row ever carries the destination phone.
