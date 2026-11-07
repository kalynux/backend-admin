# FRONTEND CHANGELOG — delivery pause, and agencies held by their own terms (2026-10-22)

## What changed in the backend

1. **Agencies and riders are no longer held like sellers.** An agency's share of a delivery (and its
   rider's) is held 3 days if the agency pays for returns, otherwise for its damage-claim deadline
   capped at 3 days. With neither, it is released the night after the delivery is **confirmed**.
2. ⚠ **An administrator's ORDER pause no longer stops such a "free" agency or its rider.** It still
   stops the seller, the platform and any agency that is held. Every *other* order pause (refund,
   customer problem report, seller cancel, card dispute) still stops everyone.
3. **New: pause one delivery.** `:kind` on the four `/money/earnings/pauses` routes now accepts
   **`shipment`**. It stops only that parcel's agency and rider shares, never the seller's. Same
   permission (`money.earnings.pause`), same note rule, two new audit actions
   (`money.earnings.pause_shipment` / `resume_shipment`, filed against the shipment).

Contract: [api/money.md § Earnings pauses](./api/money.md).

## What to change in the admin dashboard

1. **Shipment / delivery detail:** add **"Pause this delivery's payment"** / **"Resume"**:
   - `GET /api/v1/money/earnings/pauses/shipment/:shipmentId` → current record (`pause: null` if never paused);
   - `POST …/shipment/:shipmentId/pause` with `{ "note": "…" }` (3–500 chars, required);
   - `POST …/shipment/:shipmentId/resume` with `{ "note"?: "…" }`.
   Errors are those of the order pause (`409 EARNINGS_ALREADY_PAUSED`, `409 EARNINGS_NOT_PAUSED`, `404`).
   `EARNINGS_PAUSE_HELD_BY_REFUND` never occurs on a delivery.
2. **Paused-money queue:** add `shipment` to the kind filter. A `shipment` row has
   `reference` = tracking number, `amount` = delivery fee, plus `orderId` and `agencyId`. Link it to
   the shipment, and show the order and agency next to it.
3. **Order "Pause earnings" confirmation:** add one line so nobody expects it to stop every courier:

   | EN | FR |
   |---|---|
   | This does not stop agencies whose terms release them without a hold. To stop one, pause its delivery. | Cela n'arrête pas les agences dont les conditions les libèrent sans retenue. Pour en arrêter une, suspendez sa livraison. |
