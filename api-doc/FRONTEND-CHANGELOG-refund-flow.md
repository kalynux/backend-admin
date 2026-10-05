# Frontend changelog — the refund queue (admin dashboard)

**2026-10-05 · wi-admin plan step R8 of `PRODUCTION-READINESS/REFUND-FLOW-PLAN.md`.**
⚠ **Not deployed yet.** It ships with jovi-mall's refund work (same release). The full contract is
[api/refunds.md](./api/refunds.md); this page is what to build and what changed.

## Why

Until now only card payments could be refunded. Mobile money and cash on delivery answered
`REFUND_GATEWAY_NOT_SUPPORTED` / `REFUND_ORDER_IS_COD`, and money returned by hand could not be
recorded. Now **every** refund is a **refund request** that an approver decides, and the platform
sends mobile-money refunds itself by transfer (cards still go back through Stripe).

## 1 · A new screen: the refund queue — `/api/v1/refunds`

| Call | What for | Who sees the control |
|---|---|---|
| `GET /refunds?open=true` | The working queue (the five open statuses) | `orders.refund.read` — all tiers |
| `GET /refunds?status=…` | One tab per status | same |
| `GET /refunds/:refundId` | The detail page | same |
| `GET /refunds/:refundId/activity` | Who raised / approved / rejected it | `orders.refund.read` **and** `audit.read` |
| `GET /refunds/eligibility?sourceKind=&sourceId=` | Fill the "Raise a refund" form | `orders.refund.request` — all tiers |
| `POST /refunds` | Raise a request | `orders.refund.request` — all tiers |
| `POST /refunds/:id/approve` | Approve | `orders.refund` — Developer, Admin |
| `POST /refunds/:id/reject` | Reject, with a reason | `orders.refund` |
| `POST /refunds/:id/retry` | Retry a failed transfer | `orders.refund` |
| `POST /refunds/:id/resolve-unknown` | A transfer stuck in `sending`: arrived / failed | `orders.refund` |
| `POST /refunds/:id/settle-external` | Paid outside the platform, with proof | `orders.refund.settle_external` — Developer, Admin |
| `POST /refunds/proofs` | Upload a proof picture (multipart, field `file`) | `orders.refund.request` |
| `GET /refunds/proofs/:fileId` | Show a proof picture (bytes) | `orders.refund.read` |

Gate every control on the permission from `GET /auth/me` / `GET /permissions/me`, never on the tier.

**Support can raise, never send.** A Support administrator sees the queue and the "Raise a refund"
form, and nothing that approves, settles or writes off. Raising a request **holds the seller's
earnings** until it is decided — say so on the confirmation ("The seller's earnings for this order
are now on hold until an administrator decides").

## 2 · Statuses — one tab each

| `status` | Label suggestion | Actions offered |
|---|---|---|
| `awaiting_approval` | Waiting for approval | Approve · Reject · Settle outside the platform |
| `approved` | Approved — sending | Settle outside the platform. If `transfer.failureReason` is set (`insufficient_gateway_balance`, `payout_unavailable`) the send was refused before it started: show "Payout account short of funds" / "Payouts are switched off" and offer **Retry** (allowed from `approved` too) |
| `waiting_for_cash` | Waiting for COD cash | Settle outside the platform. Show **"Cash still with the agent/agency"** — it sends by itself once the agency's deposit covers it |
| `sending` | Sending | **Nothing but** Resolve (arrived / failed). Never reject or settle a `sending` refund — the money may already be on its way |
| `failed` | Transfer failed | Retry · Settle outside the platform · Reject. Show `transfer.failureReason` |
| `completed` | Refunded | — |
| `rejected` | Rejected | — (show `rejectionReason`, `rejectedBy`) |

A source has at most one open request (`409` + `platformCode: REFUND_ALREADY_OPEN` on a second).

## 3 · Money — always show all three

`grossAmount` (what the refund is worth), `feeAmount` (the transfer fee the platform keeps — 2 % by default, set on the payments screen as `refundFeePercent` —
`0` on a card refund) and **`netAmount` — what the customer receives**. 5 000 → 4 900. The
eligibility read gives `feePercent` and `maxRefundable` so the form can preview the net before
submitting.

## 4 · Destination and proofs

- `destination.source === 'payer'`: the number that paid. Nothing to type.
- No paying number (COD, plan purchases, credit top-ups, some bookings): the form must let the
  administrator **type** a number (international form, `+237…`) and **attach a picture of the
  customer's message giving it**. Upload it first with `POST /refunds/proofs` (one file, field
  `file`), then send its `fileId` as `destinationProofFileId`. Without the picture the create is a
  `400` on `destinationProofFileId`.
- **The list masks the phone** (`+2376••••4417`); **the detail shows it in full**. On a typed
  number, show the proof picture next to the full number so the approver can compare them.
- Proof pictures are shown through `GET /refunds/proofs/:fileId` (bytes, not JSON). **Every view is
  recorded in the audit trail** — load the image only when the approver opens it, not on every
  render of the list.
- "Settle outside the platform" requires a proof picture too (`proofFileId`), plus a `method`
  (`mobile_money` · `cash` · `bank` · `other`) and an optional `reference`.

## 5 · Four-eyes — two rules

1. **≥ 2 000 000.** Approving a refund whose `grossAmount` is 2 000 000 or more answers **`202`**
   with a pending approval instead of approving. Show "Sent for a second administrator's approval"
   and link to the approvals queue (`GET /approvals?targetId=<refundId>`). Nothing moved yet.
2. **Typed numbers.** `secondApproverRequired: true` means the number was typed. The administrator
   who typed it (`requestedBy.id === me.id`) **cannot** approve it — hide or disable Approve for
   them and say "Another administrator must approve a typed number". If they try anyway:
   `409 REFUND_SECOND_APPROVER_REQUIRED`.

Both can apply to one refund.

## 6 · "Approve now" when raising

An administrator holding `orders.refund` may tick **Approve now** on the create form
(`approveNow: true`). The answer is always **`201`** with the created request; read
`meta.approveNow.status`:

| Value | Show |
|---|---|
| `applied` | "Refund approved" |
| `queued` | "Raised — sent for a second administrator's approval (≥ 2 000 000)" |
| `second_approver_required` | "Raised — another administrator must approve a typed number" |
| `failed` | "Raised, but approving failed: …" (`meta.approveNow.error`). **Do not resubmit** the create |
| `not_requested` | "Raised — waiting for approval" |

Do not show the checkbox to Support (they would get a `403`).

## 7 · Refund debt — new on `/money`

A refund now recovers **released** earnings too. When an owner has nothing left to give back, the
rest becomes **debt**, repaid automatically from their next earnings.

- `GET /money/earnings/accounts` rows gain **`clawback`** — what the owner owes back. ⚠ It is the
  opposite direction from `pending`/`available`/`reserve`/`requested`: never add it to them. Show it
  as a separate red figure.
- `GET /money/earnings/allocations` rows gain **`clawedAmount`** — how much of `amount` refunds took
  back.
- **New:** `GET /money/earnings/clawbacks` — every owner who owes something, largest first, with
  `meta.totals` (debt per currency). Under `money.earnings.read`.
- **New:** `POST /money/earnings/clawbacks/:ownerType/:ownerId/write-off` `{ amount, reason }` —
  forgive debt (the platform absorbs it). `money.earnings.clawback.write_off`, Developer and Admin
  only; **`202`** at ≥ 2 000 000 (second administrator). `409 EARNINGS_CLAWBACK_WRITE_OFF_EXCEEDS_DEBT`
  if it is more than what is owed.

## 8 · Changed shapes elsewhere

- `GET /money/refunds` (and the refund rows inside `GET /money/payments/:id`): `gateway` and
  `paymentTransactionId` can now be **`null`** (COD and externally-settled refunds). New fields
  `channel` (`card_refund` · `payout` · `external`), `feeAmount`, `netAmount`, `refundRequestId`;
  new filters `channel`, `refundRequestId`. `initiatedBy.role` can be `support`. **Branch on
  `channel`, not on `gateway`.**
- Account statements: the adjustments table now shows **refund clawbacks** (partial ones too, and
  the part owed back); the refunds table gains "Customer received" and "Paid by".
- `POST /orders/:orderId/refund` still works **below 2 000 000** but its answer changed — see § 11.
  Move the order page's refund button to `POST /refunds` (with `approveNow` for administrators).

## 9 · Permissions — four new names

| Permission | Tiers | Flag |
|---|---|---|
| `orders.refund.read` | 1 · 2 · 3 | — |
| `orders.refund.request` | 1 · 2 · 3 | financial (holds earnings; Support holds it by name) |
| `orders.refund.settle_external` | 1 · 2 | financial |
| `money.earnings.clawback.write_off` | 1 · 2 | financial, four-eyes |

`orders.refund` is now also dual-controlled (approve ≥ 2 000 000). Totals: 140 permissions,
tiers 140 / 118 / 47 — [api/permissions.md](./api/permissions.md).

## 10 · Error codes to translate

`REFUND_REQUEST_STATUS_CONFLICT` · `REFUND_SECOND_APPROVER_REQUIRED` ·
`EARNINGS_CLAWBACK_WRITE_OFF_EXCEEDS_DEBT` (as `error.code`), and, as `details.platformCode` on a
`PLATFORM_OPERATION_REJECTED`: `REFUND_ALREADY_OPEN`, `REFUND_NO_DESTINATION`,
`REFUND_PAYOUT_UNAVAILABLE`, `REFUND_INSUFFICIENT_GATEWAY_BALANCE`,
`REFUND_DESTINATION_PROOF_REQUIRED`, `REFUND_EXTERNAL_PROOF_REQUIRED`, `REFUND_REQUEST_NOT_FOUND`,
`EARNINGS_CLAWBACK_NOTHING_OWED`. Meanings in [api/errors.md](./api/errors.md#refund-queue-refund-flow-plan--7).
Since § 11 also: `REFUND_USE_REFUND_QUEUE`, `EARNINGS_PAUSE_HELD_BY_REFUND` (as `error.code`) and
`REFUND_POLICY_OVERRIDE_REQUIRED`, `REFUND_NOT_ELIGIBLE` (as `details.platformCode`).

## 11 · Changes since the first draft (same day, against jovi-mall's final contract)

1. **Vendor return policy is now enforced on order refunds.** `POST /refunds` for an order beyond the
   vendor's policy answers `422` `PLATFORM_OPERATION_REJECTED`, `details.platformCode:
   REFUND_POLICY_OVERRIDE_REQUIRED`, `details.overrides: [...]`. Show the eligibility read's
   `overrides` on the form; when non-empty, require an explicit "Override the vendor's policy"
   checkbox that sends `overridePolicy: true`. Nothing sets it for you.
2. **Proof ids must be real refund proofs.** A `destinationProofFileId` / `proofFileId` that is not
   a live file uploaded through `POST /refunds/proofs` is `422` `REFUND_DESTINATION_PROOF_REQUIRED`
   / `REFUND_EXTERNAL_PROOF_REQUIRED` with `details.reason: "proof_not_found"`. Upload again.
3. **Create body:** `destination.name` is now **optional**; new optional `ticketId` (the support
   ticket the refund was raised from).
4. **Eligibility:** new optional query keys `reasonKind`, `itemDefective`, `amount` (re-query as the
   form changes); the answer gained `sourceKind`, `sourceId` and a richer `attributionPreview`
   (`byReasonKind` gives every reason's ceiling, fee and net in one call). See
   [api/refunds.md](./api/refunds.md#get-apiv1refundseligibility--ordersrefundrequest).
5. **Retry** is allowed from `approved` as well as `failed` (a send refused before it was claimed).
6. **Refund DTO:** new `earningsImpact` — `clawback` (default) or `none` (delivery money nobody was
   paid: nothing is held or clawed back). Say "Seller's earnings on hold" only when it is `clawback`.
7. **Legacy `POST /orders/:orderId/refund`** — ⛔ **refused at ≥ 2 000 000** (`422
   REFUND_USE_REFUND_QUEUE`, `details: { requested, ceiling, queue }`): send the administrator to the
   refund queue. Below that it now **opens a refund request**: the answer's `status` is the
   request's (`completed` card · `sending` mobile money · `awaiting_approval` COD / no number ·
   `failed` …), `refundId` is the **request** id (deprecated alias of the new `refundRequestId`), and
   `grossAmount` / `feeAmount` / `netAmount` / `paymentChannel` / `channel` /
   `transferFailureReason` were added. `amount` must be a whole number; `itemDefective` is
   accepted. `409` `REFUND_ALREADY_OPEN` carries `details.refundRequestId`. Branch on `status`.
   `GET /orders/:orderId/refund-eligibility` gained `openRefundRequest` and `legacyRouteCeiling`.
8. **Delivery-fee refunds** (`/money/delivery-fee-refunds`): rows gained `refundRequestId` and
   `rejectedRefundRequestId`; `settleable` is `false` while `refundRequestId` is set — link to
   `/refunds/:refundId` instead of the settle button. A settle on such a row is `409`
   `DELIVERY_FEE_REFUND_NOT_SETTLEABLE` with `details.refundRequestId`.
9. **Payments screen** (`/dev-tools/payments`): `settings.refundFeePercent` (0–20, default 2) is shown
   on the GET and editable on the PUT. It applies to new refund requests only.
10. **Vocabularies:** earnings pause reason `refund_in_progress` ("Refund in progress" — lifts by
    itself; don't offer Resume while the request is open) · ledger `entryType` `clawback` ·
    `clawback_recovery` · `clawback_write_off` · role-closure blocker `earnings_clawback_outstanding`
    · booking `paymentStatus: refund_pending` now means "a refund request is open".
11. **Review fixes (later the same day):**
    - Refund DTO: `earningsSettledAt` (completed clawback refund: recovery finished; null = still
      due) and `billingReversedAt` (completed billing refund: plan/credits taken back; null = still
      due). `externalSettlement.grossAmount` / `netAmount` = the part **paid by hand** — after a
      partly-sent multi-transfer refund only the **remainder**; show that as "paid by hand".
    - **Billing refunds are full only**: no `amount` for `plan_purchase` / `credit_topup` (400 here;
      jovi-mall's `422 REFUND_NOT_ELIGIBLE` reason `billing_full_refund_only`). Hide the amount field.
    - `transfer.failureReason: "exceeds_refundable"` and `409 REFUND_REQUEST_STATUS_CONFLICT` with
      `details.reason: "exceeds_refundable"` on retry / settle-external: the source no longer holds
      that much — offer **Reject** and "raise a smaller one".
    - **Resume** on `/money/earnings/pauses` is refused with `409 EARNINGS_PAUSE_HELD_BY_REFUND`
      (`details.refundRequestId`, `refundRequestStatus`) while a refund holds the pause — hide Resume
      on a `refund_in_progress` pause and link to the request.
    - Delivery-fee refund rows gained `orderRefundRequest` (`{ id, status }` of an open refund of the
      whole order); `settleable` is false while it is set.
    - Legacy `REFUND_USE_REFUND_QUEUE` is **cumulative per order** (`details.alreadyRefunded`).
