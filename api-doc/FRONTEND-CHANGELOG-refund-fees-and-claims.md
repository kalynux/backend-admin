# FRONTEND CHANGELOG — refund fees, delivery at fault, damage claims (2026-10-22)

Contracts: [api/refunds.md](./api/refunds.md) (§ Money → "The two fees", "Delivery at fault"),
[api/agency-claims.md](./api/agency-claims.md), [api/dev-tools.md](./api/dev-tools.md) (`payinFeePercent`).

## What changed

1. **Two refund fees.** A refund deducts the **payment fee** (2%, kept by the aggregator when the
   customer paid) and the **transfer fee** (2% of what is left). Card: payment fee only. COD: transfer
   fee only. `feeAmount` is now both together; the parts are in the new `fees` object.
2. **The seller pays them** when the request came from the seller cancelling after payment
   (`fees.paidBy: "vendor"`, `fees.vendorCharge`): the customer receives 100%.
3. **Delivery at fault.** `POST /refunds` accepts `deliveryFaultShipmentIds`: parcels whose delivery
   was at fault. Each is judged against its agency's window (`deliveryFault[]` on the request and on
   the eligibility preview); inside it, the agency and rider fund that parcel's delivery money.
4. **Damage claims** — new `/api/v1/agency-claims`, new permission `agencies.claims.charge`
   (financial, tiers 1 + 2, never Support), new audit action `agencies.claims.charge`.
5. **Payment settings** gain `payinFeePercent` (default 2) beside `refundFeePercent`.

## What to change in the admin dashboard

1. **Refund detail and queue:** show the fee lines from `fees`, e.g. "Payment fee 2% — 100 ·
   Transfer fee 2% — 98 · Customer receives 4,802". When `fees.paidBy = vendor`: "Fees charged to the
   seller: 480 · Customer receives 12,000". `fees: null` (older request) → one transfer-fee line.
2. **Create-refund form (orders):** a "Delivery at fault" multi-select of the order's parcels →
   `deliveryFaultShipmentIds`. Re-read `GET /refunds/eligibility?…&deliveryFaultShipmentIds=a,b` when it
   changes and show each parcel's verdict: inside → "The agency and rider will refund this delivery
   (X)"; outside → "Outside the agency's N-day window — the agency keeps its fee". Explain under the
   field: "Only when the parcel was damaged or lost in delivery".
3. **Refund detail:** list `deliveryFault[]` with the verdict and the window.
4. **Shipment detail → "Charge a damage claim"** (needs `agencies.claims.charge`): read
   `GET /agency-claims/eligibility?shipmentId=`; if `eligible`, a form with items damaged, amount (max
   `maxPerItem × items`, shown), note; show "+ investigation fee X". If not, say why from `reason`
   (`outside_window` → show `windowEndsAt`). After charging, show the claim's `explanation`.
5. **Agency detail → "Damage claims"** list (`GET /agency-claims?agencyId=`), and on the vendor detail
   (`?vendorId=`).
6. **Developer tools → Payments:** a "Payment fee kept on refunds (%)" field → `payinFeePercent`.
