# Admin dashboard — customer-paid delivery (2026-10-04)

**Not deployed yet**; ships with jovi-mall. Platform record:
[jovi-mall ADR-A11](../../jovi-mall/docs/ADR-A11-CUSTOMER-PAID-DELIVERY.md).

A shop can now make the **customer** pay delivery. Each shop has delivery terms — `always` (the
shop pays; the default), `never` (the customer pays) or `above` (free from an amount). At checkout
each vendor order gets a **payer**, and every shipment carries it. The delivery fee also now grows
with weight and with an out-of-region drop-off. Commission and the COD fee stay on the **goods**
only.

Everything below is **read-only** — except **one new write**, the delivery-fee refund settle button
([§ Delivery-fee changes after checkout](#delivery-fee-changes-after-checkout--new-w-g2-2026-10-04)). No existing admin write changed.

## ⚠ One breaking change

`GET /orders/:orderId` → `items[].delivery.freeDelivery` is **removed**. The product-level flag no
longer exists upstream. Use the order's `deliveryPayer` instead (`vendor` = free for the customer).

## Orders — `GET /orders`, `GET /orders/:orderId`

| Field | Where | What |
|---|---|---|
| `totalAmount` | list + detail | **Meaning widened:** goods **plus** delivery the customer paid. Not the vendor's gross |
| `deliveryPayer` | list + detail, **new** | `vendor` · `customer` · `null` (digital, or placed before this change — the shop paid) |
| `priceBreakdown.delivery` | detail, **new** | What the customer paid for delivery. `0` when the shop paid. `total = base + delivery` |
| `deliveryPayerReason` | detail, **new** | `shop_always` · `shop_never` · `shop_threshold_met` · `threshold_not_met` · `cap_fallback` |
| `freeDeliveryShortfall` | detail, **new** | How much more of this shop's goods would have made delivery free. `null` = n/a |
| `items[].weightGrams`, `items[].weightSource` | detail, **new** | Per-unit weight the fee was priced on; source `variant` · `shipping_config` · `default` (1 kg per unit fallback) |

`cap_fallback` means the shop offers free delivery but paying it would have broken the 30%
delivery-cost cap, so the customer paid. Worth a tooltip.

## Shipments — `GET /shipments`, `GET /shipments/:shipmentId`

| Field | Where | What |
|---|---|---|
| `deliveryFeeSnapshot` | list + detail | Unchanged meaning: what the **agency** is paid. Now set at checkout, so rarely `null` |
| `deliveryPayer` | list + detail, **new** | `vendor` · `customer` · `null` (older — the shop paid) |
| `customerDeliveryFee` | list + detail, **new** | What the **customer** paid for this run. `0` when the shop pays. Can differ from `deliveryFeeSnapshot` while a fee change awaits the customer |
| `feeComponents` | detail, **new** | `{ pickupBase, weightExtra, regionSurcharge, storage, capApplied, kg, weightGrams, outOfRegion, flatFallback }` or `null`. Display only |
| `customerFeeRefundable` | detail, **new** | Delivery money owed **back** to the customer (customer-paid return, overpayment). `0` = none |
| `cod.itemsAmount`, `cod.deliveryFeeAmount` | detail, **new** | `cod.expectedAmount = itemsAmount + deliveryFeeAmount`. Older collections read as all goods |

## Agencies — `GET /agencies/:agencyId`

`policies.pricing` gains two fields:

- `maxFeePerShipment` — ceiling on one shipment's posted fee. `null` = no ceiling.
- `acceptsCashDeliveryFee` — the customer may pay delivery in cash to the rider on an online
  order. `false` when never set.

`pickupBased.additionalPerKg` and `.outOfRegionSurcharge` are now actually charged.

## Vendors — `GET /vendors/:vendorId`

`settings.deliveryTerms: { mode: 'always' | 'never' | 'above', freeAboveAmount: number | null }`.
Default `{ mode: 'always', freeAboveAmount: null }`. **Read-only** — the settings `PATCH` refuses
it with `400`. The vendor sets it in their own dashboard.

## Money — `GET /money/earnings/allocations…`

`snapshots.gross` on `order` / `cod_collection` rows is the **goods** gross. It no longer equals
the order total or the COD cash expected when the customer paid delivery. No shape change.

## Account statements — `POST /accounts/:ownerType/:ownerId/statements`

No request change. The file now:

- splits a customer-paid COD sale correctly (delivery `0`, COD fee shown) instead of merging the
  two columns;
- labels the sales column **"Delivery fee (yours)"** — the shop's part of the fee only;
- adds goods / customer-delivery / payer columns to the vendor Orders, Deliveries and Cash tables,
  and goods / delivery-fee columns to the agency and agent cash tables, plus "Fee paid by" on their
  earnings;
- adds one informational summary line, **"Delivery paid by customers (to agencies)"**, outside the
  net arithmetic.

The net formula is unchanged and still matches the vendor's own dashboard.

## Delivery-fee changes after checkout — NEW (W-G2, 2026-10-04)

A shipment's fee can now move **after** checkout. On a customer-paid order an increase is paid by
the customer as a separate **top-up**, and a decrease (or a returned parcel's unspent fee) is
**refunded** to them — automatically through the gateway when it can, **by a person** when it
cannot (cash on delivery, mobile money). Additive; nothing existing changed shape.

### One new write — the settle button

| Route | Permission | What |
|---|---|---|
| `GET /money/delivery-fee-refunds` | `money.payments.read` (all levels) | The queue. `?status=manual_required` (default — still owed) · `settled` · `all`; `?orderId` `?vendorId` `?customerId`; sort `createdAt` · `amount` |
| `GET /money/delivery-fee-refunds/:refundId` | `money.payments.read` | One row (any, automatic included) |
| **`POST /money/delivery-fee-refunds/:refundId/settle`** | **`orders.refund`** (Developer + Admin, **not Support**) | Record the money was returned. Body `{ method, reference?, note? }`, `.strict()` |

- Show the button when **`settleable: true`**. Hide it for anyone without `orders.refund`.
- `method`: `mobile_money` · `cash` · `bank` · `other` (sent by hand) or `covered_by_order_refund`
  (a refund of the whole order already returned it — nothing moved).
- Refusals arrive as **`409 PLATFORM_OPERATION_REJECTED`**; branch on `details.platformCode`:
  `DELIVERY_FEE_REFUND_NOT_SETTLEABLE` (reload — settled already or someone else won),
  `DELIVERY_FEE_REFUND_ALREADY_COVERED` (offer `covered_by_order_refund` instead),
  `DELIVERY_FEE_REFUND_NOT_COVERED` (the money is still owed — pay it by hand).
- A response with `data.remainder` ≠ `null` means part is still owed: a new row to pay by hand.
- `note` on a refund row is **operator-facing** — never show it to the customer.
- Audited as `orders.delivery_fee_refund.settle` on the **order** — it appears on
  `GET /orders/:orderId/activity`.

### Order detail — `GET /orders/:orderId` gains `deliveryFee` (read-only)

`{ payments: { checkout, deliveryTopUps[], deliveryTopUpsPaid }, proposals[], refunds[], owedManually, returned }`.
`checkout` is how the order was paid; `deliveryTopUps` are the later delivery payments. Render
`owedManually > 0` as a call to action linking the settle button. Full shape:
[orders → `deliveryFee`](./api/orders.md#deliveryfee--fee-changes-after-checkout-read-only-2026-10-04).

### Payments — `GET /money/payments[/:id]`

- `settles.purpose` gains **`order_delivery_topup`**, and `settles.deliveryTopup`
  (`{ shipmentId, proposalId, appliedAt }` on a top-up, **`null`** otherwise) is **new**.
- `?orderId=` **includes** an order's top-ups (it answers "what was paid for this order"). Do not
  treat the first row as the checkout charge — use `settles.purpose`, or the order detail's
  `deliveryFee.payments.checkout`.

### Account statements

The vendor statement's payment columns (means, reference, payer, paid at) now always describe the
**checkout** payment, never a top-up. The total column already includes top-ups.

Full reference: [money → delivery-fee refunds](./api/money.md#delivery-fee-refunds--delivery-money-owed-back-to-a-customer) ·
[orders](./api/orders.md) · [shipments](./api/shipments.md) ·
[agencies](./api/agencies.md) · [vendors](./api/vendors.md) · [money](./api/money.md) ·
[accounts → statements](./api/accounts.md#post-accountsownertypeowneridstatements--account-statement).
