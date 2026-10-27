# Frontend changelog — service bookings (2026-10-27)

**For: the admin dashboard.** Not deployed yet; ships with jovi-mall. Endpoint reference:
[api/bookings.md](api/bookings.md). Record: `../../PRODUCTION-READINESS/ADMIN-BOOKINGS-PLAN.md`.

No other dashboard changes. Customer, vendor, agency and agent responses are byte-identical.

## What is new

1. **A Bookings section** on `/api/v1/bookings`. It has a list with search and filters, seven
   "needs attention" queues with counts (`GET /bookings/queues`), and a detail screen. The detail
   shows the customer, shop and service, the place, the meeting link (tiers 1 + 2), the proposal of
   a new time, **who changed the status and when**, where the vendor's money stands, payments,
   refunds, the other seats of a class, and the administrators' activity.
2. **Two lookup panels** on the detail: "Can the customer see the link yet?"
   (`GET /bookings/:id/access`) and the service's bookable times
   (`GET /bookings/services/:productId/availability`).
3. **Seven actions**: cancel (with fault), cancel the whole class, complete, record cash, re-check
   payment, withdraw proposal, resend reminder. Each answers `{ booking, result }`. Re-render from
   `booking`.
4. **A paid no-show waits for an administrator.** It shows in `?queue=paid_no_show`. The only two
   ways out are Complete (the vendor is paid after the hold) or Cancel (the customer is refunded).
5. **Tickets about a booking** (`about.type: BOOKING`) now carry a label (the booking number). Route
   them to the booking detail.

## Permissions — 144 → 149, tiers 149 / 126 / 49

New family `bookings`: `bookings.read`, `bookings.remind` (all tiers) · `bookings.access.read`,
`bookings.intervene` (tiers 1 + 2) · `bookings.settle` (financial, tiers 1 + 2). See
[api/permissions.md § bookings](api/permissions.md#bookings). Add the five names to your
permission type. Your copy of `permissions.md` is parsed by your tests, so refresh it in the same
change.

## Rules the screens must respect

- ⛔ The meeting link and instructions are **absent** from the detail for Support. Show "has a
  link" from `access.hasMeetingUrl`, never an empty field.
- ⚠ The **cancel reason is shown to the customer and the vendor**. Say so on the form. Every other
  reason is internal.
- ⚠ Cancel refunds at once, with **no second approver**. Show the amount and the fault's effect on
  fees before confirming.
- Complete is refused for an unpaid booking (`BOOKING_ADMIN_COMPLETE_UNPAID`): offer Record cash
  first. The full refusal list is in the writes table.
- An empty `statusHistory` means "not recorded" (bookings from before 2026-10-27), not "nothing
  happened".
- `earnings.state` has no amounts. Link to `/money` for callers holding `money.earnings.read`.
- Branch refusals on `error.details.platformCode`, never on the message.
