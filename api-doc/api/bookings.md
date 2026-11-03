# `/api/v1/bookings` — service bookings

**Since 2026-10-27, not deployed yet.** Record: `../../../PRODUCTION-READINESS/ADMIN-BOOKINGS-PLAN.md`.
jovi-mall's half: `jovi-mall/api-doc/admin/bookings.md`.

This is the orders screen's counterpart for **bookable services** (appointments, sessions,
classes). Before it, a booking could only be seen from the side (a refund about it, a payment
filtered by it, its earnings pause), and a ticket pointing at one linked nowhere.

`bookings` is a **direct read**. Every write is **delegated** to jovi-mall and audited
fail-closed, so with the audit store down nothing changes. Two reads are delegated as well,
because they are verdicts jovi-mall acts on: whether the customer can see the meeting link yet,
and which times can be booked.

## Permissions

| Permission | 1 | 2 | 3 | Guards |
|---|:-:|:-:|:-:|---|
| `bookings.read` | ● | ● | ● | the list, the queues, the detail, `/access`, `/services/:id/availability`, `/activity` (with `audit.read`) |
| `bookings.remind` | ● | ● | ● | `POST /:id/reminder` · `POST /:id/reminder/vendor` |
| `bookings.access.read` | ● | ● | · | the meeting link and instructions **on the detail** — no route of its own |
| `bookings.intervene` | ● | ● | · | `POST /:id/payment/recheck`, `POST /:id/proposal/withdraw` |
| `bookings.settle` | ● | ● | · | `POST /:id/cancel`, `/:id/session/cancel`, `/:id/complete`, `/:id/payment/cash` — **financial** |

Support answers "I can't see my link" with `GET /:id/access` (why it is locked) and a resent
reminder. It never reads the link out.

## GET /api/v1/bookings — `bookings.read`

| Query | Notes |
|---|---|
| `search` | A booking number prefix (`BKG-2026-…`, case-insensitive input), a 24-hex booking / user / vendor / service id, or a customer's or shop's name, phone or email |
| `status` | `pending` · `confirmed` · `completed` · `no-show` · `cancelled` |
| `paymentStatus` | `unpaid` · `pending` · `paid` · `disputed` · `failed` · `refund_pending` · `refunded` |
| `queue` | One of the "needs attention" lists below |
| `vendorId`, `userId`, `productId` | `userId` is the customer's **user** id (what a booking stores) |
| `from`, `to` | ISO instants with a zone, on the **appointment time** (`startAt`), half-open, at most 366 days |
| `sort` | `startAt` / `-startAt` (default: newest appointment first) |
| `page`, `limit` | Standard pagination |

`meta.searchMatchesTruncated: true` means the term matched more than 200 customers or shops and
the page may be incomplete. Narrow the term.

```json
{
  "success": true,
  "data": [{
    "id": "671e2a…",
    "bookingNumber": "BKG-2026-000123",
    "status": "confirmed",
    "paymentStatus": "paid",
    "paymentMethod": "online",
    "startAt": "2026-10-28T09:00:00.000Z",
    "endAt": "2026-10-28T10:00:00.000Z",
    "price": 10000,
    "currency": "XAF",
    "requiresPayment": true,
    "locationKind": "online",
    "proposalOpen": false,
    "service": { "id": "66f0…", "name": "Hair braiding (1 h)" },
    "vendor": { "id": "66a1…", "name": "Salon Amina" },
    "customer": { "id": "66b2…", "customerId": "66b3…", "name": "Paul N.", "phone": "+237…", "email": null },
    "createdAt": "2026-10-20T08:14:00.000Z"
  }],
  "meta": { "total": 1, "page": 1, "limit": 20, "pages": 1 }
}
```

`customer.id` is the **user** id (route to `/users/:id`). `customer.customerId` is the customer
profile id, `null` when the account has none.

## GET /api/v1/bookings/queues — `bookings.read`

How many bookings sit in each "needs attention" list right now. Pass the same name as `?queue=`.

```json
{ "success": true, "data": {
  "payment_stuck": 2, "awaiting_confirmation": 1, "unfinished": 5, "open_proposal": 0,
  "refund_open": 1, "paid_no_show": 3, "completed_unpaid": 4
} }
```

| Queue | Means | Usual action |
|---|---|---|
| `payment_stuck` | payment `pending` for more than 30 minutes | **Re-check payment** |
| `awaiting_confirmation` | a booking the vendor must accept, starting within 24 h (or already past) | contact the vendor, or **Cancel** (fault: vendor) |
| `unfinished` | still `confirmed` after its end time | **Complete** (if paid), or ask the vendor |
| `open_proposal` | a new time is waiting for an answer | **Withdraw proposal** if it is stale |
| `refund_open` | `refund_pending` or `disputed` | open the refund in the refund queue |
| `paid_no_show` | marked no-show **after payment** — its money is held until an administrator decides | **Complete** (vendor paid) or **Cancel** (customer refunded) |
| `completed_unpaid` | completed, payment required, still not paid | usually cash nobody recorded: **Record cash** |

## GET /api/v1/bookings/:bookingId — `bookings.read`

The list item, plus:

```json
{
  "paidAt": "2026-10-20T08:15:00.000Z",
  "completedAt": null,
  "cancelledAt": null,
  "cancelledReason": null,
  "customerNote": "First visit",
  "calendarEventId": "abc123",
  "settlement": null,
  "location": { "kind": "vendor_address", "label": "Salon", "addressLine1": "…", "addressLine2": null,
                "city": "Douala", "state": null, "country": "CM", "formattedAddress": "…" },
  "access": { "visible": true, "hasMeetingUrl": true, "hasInstructions": false, "revealMinutesBefore": 30,
              "meetingUrl": "https://meet.example.com/x", "instructions": null },
  "proposal": null,
  "statusHistory": [
    { "from": null, "to": "confirmed", "at": "…", "actorRole": "customer", "actorId": "66b2…", "actorName": "Paul N.", "reason": null }
  ],
  "earnings": { "state": "waiting", "holdReleaseAt": null, "releasedAt": null, "pause": null },
  "payments": [
    { "id": "…", "purpose": "primary", "gateway": "notchpay", "method": "MOBILE", "status": "SUCCEEDED",
      "amount": 10000, "currency": "XAF", "reference": "…", "createdAt": "…", "updatedAt": "…" }
  ],
  "refunds": [],
  "sessionSeats": []
}
```

- **`access`**: `null` when the booking carries no link and no instructions. ⛔ `meetingUrl` and
  `instructions` are **absent** (not `null`) unless the caller holds `bookings.access.read`, and
  then `visible` is `false`. Whether the **customer** can see them yet is `GET /:id/access`.
- **`location`** never carries coordinates. On a `customer_address` service it is the customer's
  own address.
- **`pricing`**: `{ originalPrice, proposal, topup, history }`. `price` above is the **agreed** price, and `originalPrice` is what the customer booked at. On a `manual` service the vendor can propose a higher one before approving, and propose again with a new time, never below `originalPrice`. `proposal` is the latest (`status`: `open` · `accepted` · `declined` · `withdrawn` · `lapsed`; a stored `open` past `expiresAt` has lapsed). `topup` is what a paid booking owes after the price went up (`status`: `due` · `paid` · `superseded`). `history` is every agreed change, oldest first. **Read-only: administrators do not set prices.**
- **`partyReminders`**: `{ toCustomerAt, toVendorAt }`, when each side was sent the other's one-time
  reminder, `null` until then. `POST /:id/reminder` below neither sets nor is limited by these.
- **`statusHistory`**: oldest first. `actorRole` is `customer` · `vendor` · `admin` · `system`.
  `actorName` is the customer's name, the shop's name or the administrator's display name.
  ⚠ An **empty list means "not recorded"**: bookings created before 2026-10-27 have no history.
- **`earnings.state`** says where the vendor's money stands, without amounts:
  `none` (nothing split: unpaid, free, or cash not recorded) · `waiting` (held, not completed;
  a paid no-show sits here) · `holding` (released at `holdReleaseAt`) · `paused` (see `pause`) ·
  `released` · `reversed`. Amounts are on `/money` for callers holding `money.earnings.read`.
- **`payments`**: every attempt, oldest first, including balance payments (`purpose:
  "booking_balance"`).
- **`refunds`**: every refund request on this booking, newest first. The destination number is
  not here; open the request in the refund queue.
- **`sessionSeats`**: the other live bookings of the same class (same service, same start).
  Empty for a one-to-one service.

### The nested blocks, field by field

Added 2026-10-28 (BR-033 § 3). Taken from `bookings/read-models/booking.dto.ts` and the stored
shapes in `bookings/repositories/booking.read.repository.ts`, checked against jovi-mall's
`booking.model.ts`. Dates are ISO strings.

#### `proposal` — `null` when none was ever made

The booking's **latest** proposal of a new time, in whatever state it ended. It is not cleared
when answered, so a non-null `proposal` does not mean one is waiting. `live` is what says that.

| Field | Type | Notes |
|---|---|---|
| `status` | `open` · `accepted` · `declined` · `withdrawn` · `lapsed` | `lapsed` is written lazily, on the next write that reads it. Until then an expired one still reads `open`, so use `live` |
| `live` | boolean | **Computed here**: `status === "open"` and `expiresAt` is in the future. Same value as the list item's `proposalOpen` |
| `proposedBy` | `vendor` · `customer` | |
| `startAt`, `endAt` | date | The proposed new time |
| `previousStartAt`, `previousEndAt` | date | The time it would replace. This is still the booking's time unless the proposal was `accepted` |
| `proposedAt`, `expiresAt` | date | |
| `answeredAt` | date \| `null` | Set on `accepted`, `declined` and `withdrawn` (an administrator's withdrawal included); `null` while open and on `lapsed` |
| `slotId` | string | ⚠ **Also present, and not in wi-admin's own type.** The stored sub-document is passed through whole. It is jovi-mall's opaque slot handle and has no use on this surface, so do not depend on it |

#### `settlement` — `null` unless the vendor settled a final price

Written when the vendor closes a booking at a final price (`fixed`, or by `duration` actually
spent). Absent on most bookings, and never written by an administrator's **Complete**, which
completes at the booked price.

| Field | Type | Notes |
|---|---|---|
| `finalPrice` | number | The settled price. May be above or below `price` |
| `pricingMode` | `fixed` · `duration` | |
| `settledAt` | date | |
| `balanceDue` | number | `max(0, finalPrice − amount paid)` at settlement: what the customer still owes. Never charged automatically |
| `balancePaid` | number | How much of `balanceDue` has since been collected |
| `balancePaidAt` | date | **Absent** (not `null`) until a balance payment lands |
| `balancePaymentMethod` | `cash` · `online` | **Absent** until a balance payment lands |
| `creditDue` | number | `max(0, amount paid − finalPrice)`: the customer overpaid. **Recorded, not refunded**, by product decision |
| `balanceTransactionId` | string | ⚠ **Also present, and not in wi-admin's own type.** Passed through whole, like `slotId`. Absent unless the balance was paid online; the same payment is in `payments[]` with `purpose: "booking_balance"` |

#### `refunds[]` — every refund request on the booking, newest first

A summary. Open the request in the refund queue ([refunds.md](refunds.md)) for its destination,
fee breakdown and history.

| Field | Type | Notes |
|---|---|---|
| `id` | string | The refund **request** id: `/refunds/:refundId` |
| `status` | string | The refund request's status ([refunds.md](refunds.md)) |
| `reasonKind` | string | e.g. `cancellation` for one opened by a cancel |
| `grossAmount` | number | |
| `feeAmount`, `netAmount` | number \| `null` | `null` until the fees are worked out |
| `feesPaidBy` | `customer` · `vendor` \| `null` | Set by the cancel's `fault` on a cancellation refund |
| `currency` | string | |
| `requestedBy` | string \| `null` | The requester's **name**, else their **role**. A cancellation refund is the system's and is named after who cancelled, e.g. `"booking cancelled by admin"` |
| `createdAt` | date | |

#### `sessionSeats[]` — the list item, in full

Each element is exactly a [`GET /bookings`](#get-apiv1bookings--bookingsread) list item (`id`,
`bookingNumber`, `status`, `paymentStatus`, `paymentMethod`, `startAt`, `endAt`, `price`,
`currency`, `requiresPayment`, `locationKind`, `proposalOpen`, `service`, `vendor`, `customer`,
`createdAt`). Only `pending` and `confirmed` seats are included, and the booking itself is not.

#### `earnings`

| Field | Type | Notes |
|---|---|---|
| `state` | see the list above | |
| `holdReleaseAt` | date \| `null` | |
| `releasedAt` | date \| `null` | |
| `pause` | object \| `null` | `null` unless a pause is **active** on the booking |
| `pause.reason` | string \| `null` | One of jovi-mall's closed set. On a booking: `booking_cancelled_unrefunded` (cancelled after payment and no refund request could be opened, see [What a cancel's refund did](#what-a-cancels-refund-did)) · `refund_in_progress` · `card_dispute` · `customer_problem_reported` · `admin` |
| `pause.note` | string \| `null` | |
| `pause.pausedAt` | date \| `null` | |

`state` can read `paused` while `pause` is `null`: the state is also derived from the allocation
rows' own pause stamp.

## GET /api/v1/bookings/:bookingId/access — `bookings.read`

Whether the **customer** can see the meeting link and instructions right now. Never the text.

```json
{ "success": true, "data": {
  "state": "locked", "reason": "not_paid",
  "opensAt": "2026-10-28T08:30:00.000Z", "closesAt": "2026-10-28T11:00:00.000Z",
  "hasInstructions": false, "hasMeetingUrl": true, "revealMinutesBefore": 30
} }
```

`reason`: `not_confirmed` (the vendor has not accepted) · `not_paid` (an unpaid cash booking stays
locked until the vendor records the cash) · `too_early` (opens at `opensAt`) · `ended` · `null`
when `open`. `data: null` when the booking has no access details at all.

## GET /api/v1/bookings/services/:productId/availability?from&to — `bookings.read`

The times a customer would be offered for a service, computed by the storefront's own code. `from`
and `to` are ISO instants, at most 31 days apart. A service that is not bookable (draft, archived,
suspended) answers the storefront's `404`, which is itself the answer to "why can't I book this?".

```json
{ "success": true, "data": { "productId": "66f0…", "from": "…", "to": "…",
  "slots": [{ "id": "…", "start": "…", "end": "…", "available": true }] } }
```

## GET /api/v1/bookings/:bookingId/activity — `bookings.read` + `audit.read`

What **administrators** did to this booking (audit rows, newest first), filtered to the
`bookings.*` actions and the earnings pause/resume of this booking.

## The writes

Every write answers `{ booking, result }`. `result` is jovi-mall's own answer (shapes below).
`booking` is the **same shape as the detail**, re-read after the write. ⚠ **`booking` can be
`null`**: the re-read runs after jovi-mall committed, and if it misses, the write still answers
`200` with `booking: null`. The write happened, so do not show it as a failure. Re-fetch the
detail, or fall back to `result`.

Bodies are strict (an unknown field is a `400`). An unknown booking id is this service's own
`404` before anything is sent. jovi-mall's refusals reach you as `PLATFORM_OPERATION_REJECTED`,
at jovi-mall's original status, with jovi-mall's own code in `details.platformCode`. Branch on the
code, not the status. The status of each code is in the table (from jovi-mall's
`booking.service.ts` and `admin-booking.service.ts`).

| Route | Permission | Body | Effect | `details.platformCode` refusals |
|---|---|---|---|---|
| `POST /:id/cancel` | `bookings.settle` | `{ reason, fault: "vendor" \| "customer" }` | Cancels from `pending`, `confirmed` or `no-show`, ignoring the vendor's cancellation policy. A paid booking is refunded through the ordinary cancellation refund; [`result.refund`](#what-a-cancels-refund-did) says what it did. `fault: "vendor"` → the vendor bears the fees (customer gets 100% back); `"customer"` → the customer bears them. The customer is told "cancelled by Wi-Mall support" | **409** `BOOKING_ALREADY_CANCELLED`, **409** `BOOKING_TERMINAL_STATE` (completed: use the refund queue) |
| `POST /:id/session/cancel` | `bookings.settle` | `{ reason, fault }` | Every live seat of **this booking's class**. `result.cancelled[]` / `result.failed[]` (a failed seat does not stop the others; retry picks up what is left) | **404** `BOOKING_SESSION_EMPTY` |
| `POST /:id/complete` | `bookings.settle` | `{ reason }` | `confirmed` or `no-show` → `completed` at the booked price. The vendor is paid when the ordinary hold ends; the customer keeps their protection window | **409** `BOOKING_ADMIN_COMPLETE_UNPAID` (record cash first), **409** `BOOKING_NOT_STARTED`, **400** `BOOKING_INVALID_STATUS_TRANSITION` |
| `POST /:id/payment/cash` | `bookings.settle` | `{ reason }` (how it was confirmed) | Records that the customer paid the vendor in cash. The vendor's own rules apply | **409** `BOOKING_ALREADY_PAID`, **400** `BOOKING_PAYMENT_NOT_REQUIRED`, **400** `BOOKING_INVALID_PAYMENT_METHOD` |
| `POST /:id/payment/recheck` | `bookings.intervene` | `{ reason? }` | For `paymentStatus: "pending"`. `result.outcome`: `settled` (now `paid` or `failed`) · `still_pending` · `released` (the last attempt had failed; the customer can pay again) | **409** `BOOKING_PAYMENT_NOT_PENDING`, **409** `BOOKING_PAYMENT_STATE_MISMATCH` (escalate to an engineer) |
| `POST /:id/proposal/withdraw` | `bookings.intervene` | `{ reason? }` | Withdraws the open proposal of a new time, either side's. The original time stands; nobody is notified | **404** `BOOKING_PROPOSAL_NOT_FOUND` (none open, it expired, or the booking is no longer `pending`/`confirmed`) |
| `POST /:id/reminder` | `bookings.remind` | `{ reason? }` | Sends the customer the appointment reminder again. `result.sent: false` when the account has no customer profile | **409** `BOOKING_REMINDER_NOT_APPLICABLE` (not confirmed, or already started) |
| `POST /:id/reminder/vendor` | `bookings.remind` | `{ reason? }` | Reminds the vendor of the appointment. Audited as `bookings.reminder.vendor` | **409** `BOOKING_REMINDER_NOT_APPLICABLE` (not confirmed, or already started) |

Any of them can also answer **404** `BOOKING_NOT_FOUND` if the booking is deleted between this
service's read and jovi-mall's.

### `result`, per write

**The acknowledgement**: cancel, complete, cash, withdraw. jovi-mall's thin answer, never the
booking document.

| Field | Type | Notes |
|---|---|---|
| `id` | string | The booking id |
| `bookingNumber` | string \| `null` | |
| `status` | string | After the write |
| `paymentStatus` | string | After the write. On a cancel, this is read **after** the refund step ran: `refund_pending` or `refunded` when a refund was owed. See [below](#what-a-cancels-refund-did) |
| `rescheduleProposalStatus` | string \| `null` | The proposal's status, `null` when none was ever made. `withdrawn` after a withdrawal |
| `refund` | see [below](#what-a-cancels-refund-did) | **Cancel only.** What the refund did. Since 2026-11-01 |

**Session cancel**

| Field | Type | Notes |
|---|---|---|
| `productId` | string | The service |
| `startAt` | date | The class's start |
| `cancelled[]` | `{ bookingId, bookingNumber, refund }` | Seats cancelled by this call, this booking among them. Each seat is refunded on its own, so each carries its own [`refund`](#what-a-cancels-refund-did) |
| `failed[]` | `{ bookingId, bookingNumber, code }` | Seats that could not be cancelled. `code` is jovi-mall's error code, `UNEXPECTED` when it had none. Retrying the same call picks up only the seats still live |

**Payment re-check**

| Field | Type | Notes |
|---|---|---|
| `outcome` | `settled` · `still_pending` · `released` | |
| `paymentStatusBefore` | string | Always `pending`. Anything else was refused |
| `paymentStatusAfter` | string | `paid` or `failed` when `settled`; `pending` when `still_pending`; `failed` when `released` (still `pending` in the rare race where something else moved the booking first) |
| `transaction` | `{ id, status, gateway }` \| `null` | The attempt that was asked about. `status` is its status **after** the provider was asked. `null` when the booking had no attempt at all (then `released`) |

**Reminder**

| Field | Type | Notes |
|---|---|---|
| `sent` | boolean | |
| `reason` | `"no_customer_profile"` \| `null` | Why it was not sent; `null` when `sent: true` |

### What a cancel's refund did

jovi-mall commits the cancellation **first** and runs the refund after it, best-effort: freeing the
slot is the more urgent of the two, and money owed can be recovered. So a `200` says nothing about
the money on its own. `result.refund` says what happened, and the response `message` follows it
(since 2026-11-01, BR-033 § 4):

| `result.refund` | Means | `paymentStatus` | `refunds[]` | `earnings.pause.reason` | What the operator does |
|---|---|---|---|---|---|
| `none` | Nothing owed (free, unpaid, pending, failed) | unchanged | nothing new | — | Nothing |
| `requested` | A request is open: a new one (the usual case for a paid online booking), or one that was already open | `refund_pending` | the request | `refund_in_progress` | Nothing. It is in the refund queue, sending or awaiting approval |
| `refunded` | The money is already back | `refunded` | a new request, `completed` | — | Nothing |
| `manual` | A **cash** booking (always), or no request could be opened | `refund_pending` | **nothing new** | `booking_cancelled_unrefunded` | Follow the **HIGH** `PAYMENT_ISSUE` ticket jovi-mall raises against the booking (it links here, see [Tickets](#tickets)) |
| `failed` | The refund step threw before recording anything | `paid` | nothing new | — | **No ticket and no flag exist.** Handle the refund by hand, as below |

⚠ **`refund` is absent** while jovi-mall runs a version older than this field. Treat absent as "not
known" and read the other columns, which tell the same story from the re-read `booking`.

So the manual case reads as **`paymentStatus: "refund_pending"` with no open request in
`refunds[]`**, with earnings paused as `booking_cancelled_unrefunded` and a ticket raised.

**Cash.** There is nothing to refund from. The vendor holds the money and hands it back, which the
ticket records. Do not send the operator to *Raise a refund*: the refund queue refunds a payment
that went through a gateway, a cash booking has none, and it answers `404
REFUND_PAYMENT_NOT_FOUND`.

**Online, but no request could be opened.** This happens when no payment is on record, the payment
is already fully refunded, or something unexpected went wrong. *Raise a refund* from the refund
queue is the right next step: it either opens the request, or refuses with the same reason, which
the ticket also names.

**A cancelled booking that still reads `paid`** always means a refund is owed and was not flagged.
`refund: "failed"` is one way to get there. The other is `refund: "manual"` when only the write that
flags `refund_pending` failed: jovi-mall logs it and carries on, and the ticket is raised
independently, so it is usually there. Both are handled by hand: `manual` from its ticket, `failed`
from the refund queue for an online payment, or with the vendor for cash.

The pause reason in the table is the usual one. A booking that was already paused for another
reason (a customer's problem report, an administrator) shows that pause instead, because one
booking holds one pause.

⚠ **The cancel `reason` is public.** It becomes the booking's `cancelledReason`, which the customer
and the vendor both read on their own booking screens. Say so on the form. The other reasons
(complete, cash, re-check, withdraw, reminder) stay with administrators: the audit trail and the
status history, which is never sent to a customer or a vendor.

⚠ **Cancel has no second administrator.** A refund opened by a cancellation follows the same path
as a customer's own cancellation, and that path is not four-eyes. The 2,000,000 line applies on the
refund queue.

### A paid no-show

When a vendor marks a **paid** booking `no-show`, its money stays held with no release date
(`earnings.state: "waiting"`) and the booking appears in `?queue=paid_no_show`. Decide it with
**Complete** (the vendor is paid after the hold) or **Cancel** (the customer is refunded; choose
the fault). Only an administrator can move a `no-show` to `completed`.

## Audit actions (target `booking`)

`bookings.cancel` · `bookings.cancel_session` · `bookings.complete` · `bookings.payment.mark_cash`
· `bookings.payment.recheck` · `bookings.proposal.withdraw` · `bookings.reminder.resend`, beside
the existing `money.earnings.pause_booking` / `resume_booking`.

## Tickets

A ticket whose `about` is `BOOKING` now resolves a label (the booking number) and routes to
`/bookings/:id`. [support.md](support.md#the-entitytype-vocabulary-is-closed-at-eleven) says the
same since 2026-10-28. The manual-refund ticket a cancel raises is one of these.
