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
| `bookings.remind` | ● | ● | ● | `POST /:id/reminder` |
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

Every write answers `{ booking, result }`: `booking` is the **same shape as the detail**, re-read
after the write, and `result` is jovi-mall's own answer. Bodies are strict (an unknown field is a
`400`). jovi-mall's refusals reach you as `PLATFORM_OPERATION_REJECTED`, at jovi-mall's original
status (mostly `409`), with jovi-mall's own code in `details.platformCode`. Branch on that.

| Route | Permission | Body | Effect | `details.platformCode` refusals |
|---|---|---|---|---|
| `POST /:id/cancel` | `bookings.settle` | `{ reason, fault: "vendor" \| "customer" }` | Cancels from `pending`, `confirmed` or `no-show`, ignoring the vendor's cancellation policy. A paid booking is refunded through the ordinary cancellation refund. `fault: "vendor"` → the vendor bears the fees (customer gets 100% back); `"customer"` → the customer bears them. The customer is told "cancelled by Wi-Mall support" | `BOOKING_ALREADY_CANCELLED`, `BOOKING_TERMINAL_STATE` (completed: use the refund queue) |
| `POST /:id/session/cancel` | `bookings.settle` | `{ reason, fault }` | Every live seat of **this booking's class**. `result.cancelled[]` / `result.failed[]` (a failed seat does not stop the others; retry picks up what is left) | `BOOKING_SESSION_EMPTY` |
| `POST /:id/complete` | `bookings.settle` | `{ reason }` | `confirmed` or `no-show` → `completed` at the booked price. The vendor is paid when the ordinary hold ends; the customer keeps their protection window | `BOOKING_ADMIN_COMPLETE_UNPAID` (record cash first), `BOOKING_NOT_STARTED`, `BOOKING_INVALID_STATUS_TRANSITION` |
| `POST /:id/payment/cash` | `bookings.settle` | `{ reason }` (how it was confirmed) | Records that the customer paid the vendor in cash. The vendor's own rules apply | `BOOKING_ALREADY_PAID`, `BOOKING_PAYMENT_NOT_REQUIRED`, `BOOKING_INVALID_PAYMENT_METHOD` |
| `POST /:id/payment/recheck` | `bookings.intervene` | `{ reason? }` | For `paymentStatus: "pending"`. `result.outcome`: `settled` (now `paid` or `failed`) · `still_pending` · `released` (the last attempt had failed; the customer can pay again) | `BOOKING_PAYMENT_NOT_PENDING`, `BOOKING_PAYMENT_STATE_MISMATCH` (escalate to an engineer) |
| `POST /:id/proposal/withdraw` | `bookings.intervene` | `{ reason? }` | Withdraws the open proposal of a new time, either side's. The original time stands; nobody is notified | `BOOKING_PROPOSAL_NOT_FOUND` |
| `POST /:id/reminder` | `bookings.remind` | `{ reason? }` | Sends the appointment reminder again. `result.sent: false` when the account has no customer profile | `BOOKING_REMINDER_NOT_APPLICABLE` (not confirmed, or already started) |

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
`/bookings/:id`.
