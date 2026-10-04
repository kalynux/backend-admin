# Admin dashboard — customer-paid delivery (2026-10-04)

**Not deployed yet**; ships with jovi-mall. Platform record:
[jovi-mall ADR-A11](../../jovi-mall/docs/ADR-A11-CUSTOMER-PAID-DELIVERY.md).

A shop can now make the **customer** pay delivery. Each shop has delivery terms — `always` (the
shop pays; the default), `never` (the customer pays) or `above` (free from an amount). At checkout
each vendor order gets a **payer**, and every shipment carries it. The delivery fee also now grows
with weight and with an out-of-region drop-off. Commission and the COD fee stay on the **goods**
only.

Everything below is **read-only**. No admin write changed.

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

Full reference: [orders](./api/orders.md) · [shipments](./api/shipments.md) ·
[agencies](./api/agencies.md) · [vendors](./api/vendors.md) · [money](./api/money.md) ·
[accounts → statements](./api/accounts.md#post-accountsownertypeowneridstatements--account-statement).
