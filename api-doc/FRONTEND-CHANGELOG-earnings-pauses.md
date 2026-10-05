# FRONTEND CHANGELOG — earnings pauses, and the hold starting at delivery (2026-10-05)

**Audience:** the admin dashboard. **Backend:** wi-admin `/api/v1/money` + jovi-mall. Owner decisions of 2026-10-05.

## What changed

1. **Money can be paused.** Paused money is never paid out to anyone on the order or booking. The
   platform pauses it automatically in three situations, and an administrator can pause any order or
   booking by hand:

   | `pause.reason` | When | What else happens |
   |---|---|---|
   | `seller_cancelled_paid_order` | the seller cancelled an order the customer had already paid | a **HIGH-priority `ORDER_REFUND` ticket** opens on the order |
   | `booking_cancelled_unrefunded` | a paid booking was cancelled from the seller's status menu | a **HIGH-priority `BOOKING_CANCELLATION` ticket** opens on the booking |
   | `card_dispute` | the customer disputed the card payment with their bank | lifts **itself** when the dispute ends |
   | `admin` | an administrator paused it | — |

   An administrator closes those refund tickets in one of two ways: **refund** the customer (the
   existing `orders.refund` flow, which reverses the earnings), or, if no refund is owed, **resume**
   the earnings. Resuming continues the hold where it stopped: the paused time never counts.

2. **The hold starts at DELIVERY and lasts 3 days.** It used to start at the order's *completion*
   (customer confirmation, or auto-confirmation 7 days after delivery) and last 7 days. "Delivered"
   means the courier finished the order's **last** parcel (cash on delivery: its code was entered);
   a digital order counts as delivered when paid; a booking when the service is marked completed.

## Endpoints (full contract: `api/money.md` § Earnings pauses)

| Route | Permission |
|---|---|
| `GET /api/v1/money/earnings/pauses?kind=&page=&limit=` — the queue, newest first | `money.earnings.read` |
| `GET /api/v1/money/earnings/pauses/:kind/:id` — one record (`pause: null` = never paused) | `money.earnings.read` |
| `POST /api/v1/money/earnings/pauses/:kind/:id/pause` — `{ "note": string 3–500 }` | `money.earnings.pause` |
| `POST /api/v1/money/earnings/pauses/:kind/:id/resume` — `{ "note"?: string 1–500 }` | `money.earnings.pause` |

`:kind` is `order` or `booking`. `money.earnings.pause` is **new**: financial, tiers 1 + 2, never
Support. Errors: `404 EARNINGS_PAUSE_TARGET_NOT_FOUND`, `409 EARNINGS_ALREADY_PAUSED`,
`409 EARNINGS_NOT_PAUSED`.

## What to build

1. **"Paused earnings" queue** (under Money): rows of `{ kind, reference, vendorId, amount,
   currency, pause }`. Columns: order/booking number (link to its detail), vendor, amount, reason
   (labels below), paused at, paused by (`paused_by_name`; "System" when `paused_by_user_id` is
   null), note. Filter by kind. A **Resume** action per row (needs `money.earnings.pause`) opening a
   dialog with an optional note.
2. **Order detail and booking detail:** a "Payout" status chip from `GET …/pauses/:kind/:id`:
   *Paused* (reason, who, when, note) with a **Resume** button, or a **Pause payout** button (note
   required, 3–500 characters). After a refund, the chip may still say paused; resuming is then a
   no-op for the reversed money and is safe.
3. **Allocations list** (`GET /money/earnings/allocations`): `release.pausedAt` is new. When set,
   show a *Paused* badge instead of the release date.
4. **Order money split** (`GET /money/orders/:orderId/split`): `waitingOn` can now contain
   `"paused"` (label it "Paused"). Relabel `"order_not_completed"` as **"Not delivered yet"**: the
   value is unchanged, its meaning moved with the hold.
5. **Order timeline:** two new `event_type`s, `earnings.paused` and `earnings.resumed`.
6. **Tickets:** the two refund tickets arrive with `priority: "high"` and `importance: "high"`,
   created by the system admin account, linked to the order or booking.
7. **Permission mirror:** add `money.earnings.pause` (Pause or resume the payout of an order's or
   booking's earnings).

**Reason labels:** `seller_cancelled_paid_order` → "Seller cancelled after payment" ·
`booking_cancelled_unrefunded` → "Booking cancelled without refund" · `card_dispute` → "Card
payment disputed" · `admin` → "Paused by an administrator".
