# BR-033 · Doc gaps left by the 2026-10-27 bookings round

**Opened 2026-10-28. Status: ✅ ANSWERED 2026-11-01 — [`RESPONSE-2026-11-01-BR-032-033.md`](RESPONSE-2026-11-01-BR-032-033.md). Documentation only — no wire change asked for, one question (which became one new field).**

Found while building the Bookings section from
[`FRONTEND-CHANGELOG-bookings.md`](../../FRONTEND-CHANGELOG-bookings.md) and
[`bookings.md`](../../api/bookings.md), copied byte-for-byte from `backend/admin/api-doc` on
2026-10-28. Measured the same day against `backend/admin`: `dump-routes.js` printed **`TOTAL 333`**
(332 routes, the 13 `/bookings` routes among them) and `npm run authz:matrix` printed
**149 / 126 / 49**. In every case below the source is right and a page lags it.

---

## 1 · `permissions.md` — the composite-guard section does not list the bookings activity feed

`GET /bookings/:bookingId/activity` is declared `permission('bookings.read', 'audit.read')` in
`bookings/routes/booking.routes.ts` — an `all`-mode composite guard, like
`GET /orders/:orderId/activity` and `GET /refunds/:refundId/activity`. The section
*"Composite guards"* in [`permissions.md`](../../api/permissions.md) does not list it, and its
prose counts were not moved.

**Ask:** add the row to the `all`-mode table and move the counts (the dashboard's own route map now
reads **19 `all` + 8 `any` = 27**, from source).

**Why it matters here:** `permissions.types.test.ts` checks that section's prose against its own
table, so it stays green while both are one short — nothing on our side catches it. Our
`route-map.test.ts` pins the set from source instead.

## 2 · `support.md` — still says a `BOOKING` ticket cannot be routed

[`bookings.md` § Tickets](../../api/bookings.md#tickets) and the changelog say a ticket about a
booking *"now resolves a label (the booking number) and routes to `/bookings/:id`"*. But
[`support.md`](../../api/support.md) still says, in three places:

- the `entityType` table: *"`BOOKING` · `DELIVERY` | ❌ no administrative surface to link to"*;
- *"Link `CUSTOMER` to … `BOOKING` and `DELIVERY` stay plain text"*;
- *Making `about` navigable*: `entity.label` is the order number, tracking number or title, and
  *"`null` for every other type"*; and *"the other four have no administrative surface …
  `BOOKING`, `DELIVERY`, `OTHER`, `CUSTOMER`"*.

**Ask:** move `BOOKING` to the routable rows, name the booking number as its `entity.label`, and
keep `DELIVERY` as the only type with no surface.

## 3 · `bookings.md` — five blocks are named without their fields

The page shows these as `null` or `[]` in the worked JSON, or names them only in prose. We took
every field from source (`bookings/read-models/booking.dto.ts`,
`bookings/repositories/booking.read.repository.ts`, `bookings/gateways/booking.gateway.ts`), as
`content.md` taught us to — but a page is the contract, and a client written from this one alone
would have to guess.

| Block | Shape in source, which we now read |
|---|---|
| `proposal` | `status` · `proposedBy` · `startAt` · `endAt` · `previousStartAt` · `previousEndAt` · `proposedAt` · `expiresAt` · `answeredAt?` · `live` |
| `settlement` | `finalPrice` · `pricingMode` · `settledAt` · `balanceDue` · `balancePaid` · `balancePaidAt?` · `balancePaymentMethod?` · `creditDue` |
| `refunds[]` | `id` · `status` · `reasonKind` · `grossAmount` · `feeAmount` · `netAmount` · `feesPaidBy` · `currency` · `requestedBy` (a name, or a role) · `createdAt` |
| `sessionSeats[]` | the list item, in full |
| `earnings.pause` | `reason` · `note` · `pausedAt`, or `null` |
| `result` per write | cancel / complete / cash / withdraw: `{ id, bookingNumber, status, paymentStatus, rescheduleProposalStatus }`; session cancel: `{ productId, startAt, cancelled[], failed[] }` (each `{ bookingId, bookingNumber }`, `failed` adds `code`); re-check: `{ outcome, paymentStatusBefore, paymentStatusAfter, transaction }`; reminder: `{ sent, reason }` |

**Ask:** add field tables for these, as `refunds.md` and `transactions.md` have. Two facts worth a
sentence each:

- **`booking` in a write's answer can be `null`.** `readBookingDetail` returns `null` when the
  re-read misses after the write committed, and `respondAfterWrite` sends it as is. The page says
  only *"`booking` is the same shape as the detail"*.
- **The refusal statuses.** The writes table lists codes without statuses, and the page says only
  *"(mostly `409`)"*. Source has `BOOKING_SESSION_EMPTY` and `BOOKING_PROPOSAL_NOT_FOUND` at
  **404**; `BOOKING_PAYMENT_NOT_REQUIRED`, `BOOKING_INVALID_PAYMENT_METHOD` and
  `BOOKING_INVALID_STATUS_TRANSITION` at **400**; the rest at **409**. (The dashboard branches on
  `details.platformCode`, never the status, so this is for readers, not for us.)

## 4 · A question — what does the screen see when the refund behind a cancel fails?

The changelog says *"Cancel refunds at once"*. In jovi-mall, `cancelAsAdmin` saves the cancellation
and then calls `refundIfPaid`, which **catches and logs** any failure; `refundCancelledBooking`
falls back to `markPendingManualRefund` when no request can be opened, and always does so for a
**cash** booking. So a cancel can answer `200` with the booking cancelled and no refund request in
`refunds[]`.

The dialog now says: a paid online booking is refunded at once, with no second approver, and the
request appears under Refunds on the page; a cash booking sends nothing and is marked for the shop
to hand the cash back; an unpaid one refunds nothing.

**Questions:**
1. After a cancel whose refund could not be opened, what does the detail show — `paymentStatus:
   "refund_pending"` with an empty `refunds[]`? Is that the signal to send the operator to *Raise a
   refund* in the refund queue?
2. Should the write's `result` say which of these happened (refund requested, refunded, manual)?
   It would let the dialog's toast say so instead of the operator having to look.

---

Not asked: the dashboard's own README mirror (`api-doc/admin/README.md`) now links
`FRONTEND-CHANGELOG-payment-code.md` and `FRONTEND-CHANGELOG-wi-mall-protection.md`, which this
repository does not mirror. That is ours to decide, not the backend's.
