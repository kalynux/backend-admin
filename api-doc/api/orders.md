# `/orders` — order administration

**Verified against source on 2026-09-08** — all nine routes and their guards against the live route manifest, and every query parameter, sort allowlist, pinned-versus-format-validated status decision, all four write bodies and the 366-day span against `orders/validators/order.validator.ts`.

Base path: `/api/v1/orders`

The directory, the detail, both histories, a refund ceiling, and the four interventions.

Design record: [`../../docs/ADR-010-ORDERS-AND-SHIPMENTS.md`](../../docs/ADR-010-ORDERS-AND-SHIPMENTS.md).

| Method | Path | Permission | Transport | Audited |
|---|---|---|---|---|
| `GET` | `/orders` | `orders.read` | direct read | — |
| `GET` | `/orders/disputes` | `orders.disputes.read` | direct read | — |
| `GET` | `/orders/:orderId` | `orders.read` | direct read | — |
| `GET` | `/orders/:orderId/timeline` | `orders.read` | direct read | — |
| `GET` | `/orders/:orderId/activity` | `orders.read` **+** `audit.read` | direct read | — |
| `GET` | `/orders/:orderId/refund-eligibility` | **`orders.refund`** | **delegated** | — |
| `POST` | `/orders/:orderId/dispute/resolve` | `orders.disputes.resolve` | **delegated** | ✅ |
| `POST` | `/orders/:orderId/cancel` | `orders.intervene` | **delegated** | ✅ |
| `POST` | `/orders/:orderId/dispatch` | `orders.intervene` | **delegated** | ✅ |
| `POST` | `/orders/:orderId/refund` | `orders.refund` | **delegated** | ✅ |

`orders.read` and `orders.disputes.read` are Support-level lookups. The interventions are not:
`orders.refund` and `orders.disputes.resolve` are flagged `financial` and had to be granted to
Admin by name rather than by family expansion.

Note `refund-eligibility` sits behind **`orders.refund`**, not `orders.read` — its answer is a
**ceiling on money**, not a record, so a copy of that arithmetic anywhere else would be a second
definition of what a customer is owed.

## Two status vocabularies, and they are the platform's

`paymentStatus` and `fulfillmentStatus` are validated by **format, not membership** — jovi-mall
owns both state machines and adds to them without asking. An unrecognised value returns an empty
page rather than a `400` telling an administrator their own platform's status does not exist.

Values in use today, for reference only:

| Axis | Values |
|---|---|
| `paymentStatus` | `pending`, **`AWAITING_PAYMENT`**, `partially_paid`, `paid`, `disputed`, `failed`, `refunded` |
| `fulfillmentStatus` | `pending`, `processing`, `partially_shipped`, `shipped`, `partially_delivered`, `delivered`, `fulfilled`, `cancelled`, `returned` |

> `AWAITING_PAYMENT` really is stored in SCREAMING_SNAKE beside snake_case values. The filter
> accepts `[A-Za-z_]`, so it can express both.

---

## `GET /orders`

| | |
|---|---|
| **Permission** | `orders.read` |
| **Pagination** | `page`, `limit` |
| **Sorting** | `createdAt` only. Default **`-createdAt`** |

`totalAmount` and `updatedAt` are deliberately not sortable — no index backs them, and adding
one to a collection this size to serve a sort nobody has asked for is the wrong trade.

### Query parameters

| Parameter | Type | Notes |
|---|---|---|
| `search` | string, 1–120 | Order-number **prefix**, or a 24-hex id of an order, customer, vendor or checkout group |
| `orderType` | `physical` \| `digital` | Pinned — a closed two-value set the platform enforces |
| `paymentMethod` | `online` \| `cash_on_delivery` | |
| `paymentStatus` | status token | Format-validated, see above |
| `fulfillmentStatus` | status token | |
| `vendorId` | 24-hex | |
| `customerId` | 24-hex | |
| `disputed` | boolean flag | Frozen by a payment dispute, or already flagged `disputed` |
| `completed` | boolean flag | **The escrow gate** (`completion.confirmedAt` set) — orthogonal to fulfilment, not derivable from it |
| `from` / `to` | ISO-8601 instant | Creation range. **Max span 366 days** |

### Response (200)

```jsonc
{
  "success": true,
  "data": [
    {
      "id": "6670aabbccddeeff00112233",
      "orderNumber": "ORD-2026-008841",
      "type": "physical",
      "checkoutGroupId": "6670aabbccddeeff00112200",
      "vendorId": "6650aa11bb22cc33dd44ee55",
      "vendorName": "Douala Fresh Market",
      "customerId": "665f1c2a9b3e4a91c7d2e5f0",
      "customerName": "Amina B.",
      "currency": "XAF",
      "totalAmount": 27500,
      "deliveryPayer": "customer",
      "paymentMethod": "cash_on_delivery",
      "paymentStatus": "pending",
      "fulfillmentStatus": "processing",
      "disputeHeld": false,
      "completedAt": null,
      "itemCount": 3,
      "createdAt": "2026-08-12T09:14:00.000Z",
      "updatedAt": "2026-08-13T07:02:00.000Z"
    }
  ],
  "meta": { "total": 12043, "page": 1, "limit": 20, "pages": 603 }
}
```

| Field | Notes |
|---|---|
| `checkoutGroupId` | The cart id. **One checkout splits into one order per vendor, all sharing it** — this is how a customer's single purchase is reassembled |
| `disputeHeld` | The order is frozen by a payment dispute |
| `completedAt` | The escrow gate. `null` while funds are still held |
| `vendorName` | ⚠ **This is `vendors.display_name` — the vendor's PERSONAL name, not the business.** `vendor.model.ts` says so at the field: "the public BUSINESS name … live on the vendor's Store". The business name is `stores.name`, and it is what [`GET /shipments/:shipmentId`](shipments.md#get-shipmentsshipmentid)'s `order.vendorName` returns and what the vendor directory's `businessName` returns. **The two `vendorName` fields share a name and answer different questions.** Recorded here rather than changed: correcting this list would be a breaking wire change to a paginated endpoint, and is a decision for its own request |
| `customerName` | `customers.name` |

---

## `GET /orders/disputes`

The dispute queue. **A literal path declared before `/:orderId`.**

| | |
|---|---|
| **Permission** | `orders.disputes.read` |
| **Pagination** | `page`, `limit` |
| **Sorting** | `disputedAt`, `createdAt`. Default **`-disputedAt`** |
| **Filters** | `from` / `to` (max 366 days) |

### Response (200)

The same order list-item shape, filtered to orders under dispute.

---

## `GET /orders/:orderId`

| | |
|---|---|
| **Permission** | `orders.read` |
| **Path parameter** | `orderId` — 24-hex |

### Response (200)

Every list field, plus:

```jsonc
{
  "success": true,
  "data": {
    "…all list fields…": "…",

    "priceBreakdown": { "base": 25000, "delivery": 2500, "tax": 0, "discount": 0, "total": 27500 },
    "deliveryPayerReason": "threshold_not_met",
    "freeDeliveryShortfall": 5000,
    "paymentIntentId": "pi_9f2b8c1a…",

    "dispute": {
      "active": false,
      "disputedAt": "2026-08-01T10:00:00.000Z",
      "resolvedAt": "2026-08-04T16:20:00.000Z",
      "gatewayDisputeId": "dp_44127",
      "reason": "item_not_received"
    },

    "completion": { "confirmedAt": null, "confirmedBy": null, "auto": false },

    "deliveryAddress": {
      "formattedAddress": "Rue Njo-Njo 14, Bonapriso, Douala, Littoral, CM",
      "components": { "city": "Douala", "state": "Littoral", "country": "CM" }
    },

    "items": [
      {
        "id": "6670aabbccddeeff00112240",
        "productId": "66601122334455667788990a",
        "variantId": null,
        "sku": "PLT-1KG",
        "title": "Plantain — 1 kg",
        "variantTitle": null,
        "optionsSnapshot": null,
        "productType": "physical",
        "quantity": 3,
        "price": 2500,
        "currency": "XAF",
        "weightGrams": 1000,
        "weightSource": "variant",
        "image": {
          "id": "6612aabbccddeeff00112233",
          "key": "products/6660.../plantain-1kg.jpg",
          "url": "https://cdn.example.com/products/6660.../plantain-1kg.jpg",
          "access": "public",
          "mimeType": "image/jpeg",
          "size": 84213,
          "originalName": "plantain.jpg"
        },
        "delivery": {
          "agencyId": "665c0011223344556677889a",
          "agencyName": "Littoral Express Delivery",
          "shipmentId": "6671aabbccddeeff00112233",
          "trackingNumber": "WM-2026-0088412",
          "status": "assigned",
          "hold": null,
          "pickup": { "source": "vendor_address", "vendorAddressId": "6650…", "agencyAddressId": null }
        }
      }
    ]
  }
}
```

#### Field notes

| Field | Notes |
|---|---|
| **`totalAmount`** (list and detail) | What the customer was charged: **the goods plus any delivery the customer paid** (jovi-mall ADR-A11, 2026-10-03). It is not the vendor's gross — that is `priceBreakdown.base` |
| **`deliveryPayer`** (list and detail) | `vendor` · `customer` — who paid this order's delivery, decided **per vendor order** at checkout from the shop's delivery terms. **`null`** on a digital order and on every order placed before customer-paid delivery existed — the shop paid all of those |
| **`priceBreakdown.delivery`** | What the customer was charged for delivery: Σ the order's shipment fees when `deliveryPayer` is `customer`, **`0`** when the shop paid (and on older orders, which never wrote it). `total = base + delivery` |
| **`deliveryPayerReason`** | Why: `shop_always` (shop offers free delivery) · `shop_never` (shop never does) · `shop_threshold_met` / `threshold_not_met` (shop offers it above an amount) · **`cap_fallback`** (the shop would have paid, but that failed the 30% delivery-cost cap, so the customer paid). `null` where `deliveryPayer` is |
| **`freeDeliveryShortfall`** | How much more of this shop's goods would have made delivery free at checkout. `null` when not applicable |
| **`items[].weightGrams`** / **`weightSource`** | Per-unit weight the delivery fee was priced on, snapshotted at checkout. `weightSource`: `variant` · `shipping_config` · `default` (no weight recorded — counted as 1 kg per unit). `null` on digital lines and older orders |
| **`deliveryFee`** (detail only) | Fee changes after checkout — top-ups, proposals, refunds owed back. **Read-only.** See [below](#deliveryfee--fee-changes-after-checkout-read-only-2026-10-04) |
| **`deliveryFee`** (detail only) | Fee changes after checkout — top-ups, proposals, refunds owed back. **Read-only.** See [`deliveryFee`](#deliveryfee--fee-changes-after-checkout-read-only-2026-10-04) below |
| ~~`items[].delivery.freeDelivery`~~ | **Removed 2026-10-04.** The product-level flag no longer exists upstream; who pays delivery is the order's `deliveryPayer` |
| `dispute` | **`null` when the order has never been disputed** — absent entirely rather than a block of nulls that reads as "unknown". Present (with `active: false`) once resolved, because a resolved dispute is exactly what an administrator opens this screen for |
| `completion.auto` | Whether the escrow released automatically or a person confirmed |
| **`deliveryAddress`** | **Textual only.** `coordinates` and the customer's raw input are excluded by projection *and* by the mapping — the sharpest PII in the collection |
| **`items[].image`** | The **primary** image of what was sold, never the gallery. A full `FileDetail`, or `null` — see below |
| **`items[].delivery.agencyName`** | The agency's **business name**, from the Magazin. `null` where the item has no agency, the agency row is gone, or the Magazin has no name — **never `display_name`**, which is the agency's contact *person* |
| **`items[].delivery.trackingNumber`** | ⚠ **The handle an operator actually works with.** `shipmentId` is an internal id that cannot be typed into anything; [`GET /shipments`](shipments.md#get-shipments)'s `search` takes a tracking-number **prefix**, and a customer on the phone quotes a tracking number. `null` while the item is unfulfilled — the ordinary state, not an error |
| `items[].delivery.hold` | Set when an agency deactivation put this item on hold |

#### `deliveryFee` — fee changes after checkout (read-only, 2026-10-04)

jovi-mall ADR-A11 W-E/W-E2. A shipment's delivery fee can move after checkout (an agency proposal,
a change of agency, a combined-price answer). On a customer-paid order an **increase** is paid by
the customer as a separate **top-up** payment and a **decrease** is refunded to them. This block is
everything this order holds about that — **read-only**; administrators write none of it (owner
decision D-11), except settling a manual refund, which lives on
[`POST /money/delivery-fee-refunds/:refundId/settle`](money.md#post-moneydelivery-fee-refundsrefundidsettle).

```jsonc
"deliveryFee": {
  "payments": {
    "checkout": { "id": "66a5…", "status": "SUCCEEDED", "gateway": "NOTCHPAY", "amount": 11500, "currency": "XAF",
                  "sharedWithOtherOrders": false, "shipmentId": null, "proposalId": null, "createdAt": "…" },
    "deliveryTopUps": [
      { "id": "66a6…", "status": "SUCCEEDED", "gateway": "NOTCHPAY", "amount": 700, "currency": "XAF",
        "sharedWithOtherOrders": false, "shipmentId": "6671…", "proposalId": "6680…", "createdAt": "…" }
    ],
    "deliveryTopUpsPaid": 700
  },
  "proposals": [
    { "id": "6680…", "shipmentId": "6671…", "agencyId": "665c…", "proposedByRole": "agency",
      "origin": "agency", "approver": "customer", "direction": "increase",
      "feeBefore": 1500, "proposedFee": 2200, "currency": "XAF", "reason": "Second parcel",
      "status": "approved", "respondedByRole": "customer", "respondedAt": "…",
      "rejectionNote": null, "withdrawalReason": null,
      "topUp": { "amount": 700, "status": "paid", "paymentId": "66a6…", "paidAt": "…" },
      "customerEffect": { "feeBefore": 1500, "feeAfter": 2200, "topUpAmount": 700, "refundDue": null },
      "createdAt": "…" }
  ],
  "refunds": [ /* the order's whole delivery_fee_refunds ledger — the DeliveryFeeRefund shape of money.md */ ],
  "owedManually": 0,
  "returned": 0
}
```

| Field | Notes |
|---|---|
| **`payments.checkout`** | **How the order was paid** — the settled non-top-up payment (else the latest attempt). `null` on a COD order or one never paid. `sharedWithOtherOrders: true` = a cart checkout: `amount` is the **group's** charge, not this order's share |
| **`payments.deliveryTopUps`** | Every `order_delivery_topup` attempt, oldest first, each naming the shipment and proposal it settles |
| `payments.deliveryTopUpsPaid` | Σ of the top-ups that succeeded. **What the customer paid for this order = the checkout share + this**; `totalAmount` already includes applied top-ups (jovi-mall grows `total_amount` and `priceBreakdown.delivery` when it applies one) |
| `proposals[]` | Newest first. `approver`: `vendor` (vendor-paid) · `customer` (an increase the customer pays) · `none` (a customer-paid decrease, applied on creation). `origin`: `agency` · `change_agency` · `combined_request`. `status`: `pending` · `approved` · `rejected` · `withdrawn` |
| `refunds[]` | Every delivery-fee refund row of the order — automatic and manual. A row with `settleable: true` is the one the settle button acts on |
| **`owedManually`** | Σ `manual_required` rows — still owed, a person must send it |
| `returned` | Σ delivery money returned: completed gateway refunds + manual rows paid by hand. A `covered_by_order_refund` settlement moved nothing and is **not** counted |

#### `items[].image` — how it resolves, and when it is `null`

Resolved **live** against the product's current media rather than snapshotted. The line
snapshots `title`, `sku` and `price` because those are the terms of the sale and must not
drift; an image is not a term of the sale, it is an aid to recognising the object, so the
*current* picture is the more useful one — and every order that already exists has one with no
backfill.

**Variant-preferred, as a fallback and never a merge.** The line names a specific `variantId`,
so that variant's own media is the truthful answer — a red T-shirt must not show the blue one.
Where the variant carries no image (the normal case) the product's own media is used. This is
the same rule jovi-mall's `media.primaryImage` applies, deliberately, so this screen and the
customer's own order page cannot show different pictures.

Only `image/*` files qualify: `fileIds` is generic product media and legitimately holds a video
or a spec sheet, and the first slot is the thumbnail *by convention*, not by type.

⚠ **Gate rendering on all three of `access === 'public'`, `url !== null` and
`mimeType.startsWith('image/')`** — the both-conditions rule in [files.md](files.md). The field
is a full `FileDetail` rather than a bare URL string exactly so a client is not left guessing at
the first two.

`null` is expected and fine: a digital line, a product whose media was swept by the orphan
cleanup, a product deleted since the order. Render the title alone.

**Batched.** One resolution for the whole `items` array — three reads regardless of how many
lines the order has, never one per line.

### Errors

| Status | Code |
|---|---|
| 400 | `VALIDATION_ERROR` — "Not a valid order id" |
| 404 | `NOT_FOUND` — "Order not found" |

---

## `GET /orders/:orderId/timeline`

The platform's own event log for this order — what the vendor, the customer, the system and
administrators did.

| | |
|---|---|
| **Permission** | `orders.read` |
| **Pagination** | `page`, `limit` |
| **Sorting** | `occurredAt` only. Default **`-occurredAt`** |

### Query parameters

| Parameter | Type | Notes |
|---|---|---|
| `actorType` | `vendor` \| `customer` \| `system` \| `admin` | Pinned — this service writes `admin` itself |
| `eventType` | string, 2–60 | Dotted tokens like `payment.updated`. **Format-validated here; a closed set of nine at the platform** — see below |

#### `eventType` — the nine, and where the set is closed

The vocabulary is a **closed Mongoose enum of nine values** on jovi-mall's
`order-timeline.model.ts`: the `TimelineEventType` union and the schema's own
`event_type: { enum: [...], required: true }` list the same nine, so a value outside them
cannot be written through Mongoose at all.

| `eventType` | Written when |
|---|---|
| `order.created` | The order was placed |
| `payment.updated` | The payment status moved |
| `fulfillment.updated` | The fulfilment status moved |
| `delivery.agency_updated` | The delivery agency on an item was assigned or changed |
| `order.completed` | The customer confirmed delivery, or the escrow auto-confirmed |
| `note.added` | A vendor note was appended |
| `entitlement.revoked` | A digital entitlement was revoked |
| `entitlement.restored` | A digital entitlement was restored |
| `earnings.paused` | The order's earnings were paused (2026-10-05) — `metadata.reason`, `metadata.note`; see [money.md § Earnings pauses](./money.md) |
| `earnings.resumed` | The order's earnings were resumed; their hold continues where it stopped — `metadata.note`, `metadata.pausedReason` |
| `system.action` | An automated action with no more specific type |

⚠ **This service still validates the token by SHAPE, not membership** (ADR-005 D-17): the
vocabulary is jovi-mall's to grow, and a pinned copy here is how a filter goes stale silently
and matches nothing while looking correct. A client may rely on the nine for rendering and
should treat an unrecognised token as plain text.

The collection is **append-only, and it is enforced rather than merely intended**: the schema
declares `timestamps: { createdAt: 'created_at', updatedAt: false }` and registers five `pre`
hooks — `updateOne`, `updateMany`, `findOneAndUpdate`, `deleteOne`, `deleteMany` — each of
which calls `next(new Error(...))`. Nothing on this service writes it in any case (`orders`
and `order_timeline` are both `access: 'read'`), and wi-admin reads with the raw driver, which
those hooks do not reach.

### Response (200)

```jsonc
{
  "success": true,
  "data": [
    {
      "id": "6672aabbccddeeff00112233",
      "eventType": "payment.updated",
      "description": "Payment marked paid via MTN MoMo",
      "actorType": "system",
      "actorId": null,
      "actorName": null,
      "metadata": { "gateway": "mtn_momo", "reference": "MP260812.1402.A44127" },
      "occurredAt": "2026-08-12T14:02:31.000Z"
    },
    {
      "id": "6672aabbccddeeff00112240",
      "eventType": "fulfillment.updated",
      "description": "Order cancelled by administrator",
      "actorType": "admin",
      "actorId": "665a11223344556677889900",
      "actorName": "Nadège M.",
      "metadata": { "reason": "Customer changed their mind" },
      "occurredAt": "2026-08-12T15:10:04.000Z"
    }
  ],
  "meta": { "total": 18, "page": 1, "limit": 20, "pages": 1 }
}
```

#### `actorName` — three id spaces, two databases

⚠ **`actorId` is not a user id for any actor type**, whatever
`order-timeline.model.ts`'s "User ID if applicable" comment says. Which collection it resolves
in is decided by `actorType`:

| `actorType` | `actorId` is | Resolved in |
|---|---|---|
| `admin` | a **wi-admin `admin_accounts._id`** | **this service's own database, with no hop** |
| `vendor` | a `vendors._id` | `jovi_mall.stores` by `vendor_id` → the **business** name |
| `customer` | a `customers._id` | `jovi_mall.customers` |
| `system` | always `null` | — |

The `admin` row is the one no other service could answer. jovi-mall's admin-caller middleware
stamps `X-Actor-Id` — a wi-admin administrator id — into a column declared `ref: MODELS.USER`,
where it dereferences to nothing (ADR-004 D-1). "Which of us did this" is the question an order
timeline is opened for, and the platform database cannot answer it.

The `vendor` row resolves to the **Store's** name, matching jovi-mall's own resolution on the
vendor-facing timeline, so the two surfaces name the same vendor the same way.
`vendors.display_name` is a *person* and is not used.

`actorName` is `null` for `system` and wherever the record is gone. **`null`, never the id.**
Resolution is three batched reads for the page, never one per row.

`metadata` is an opaque object written by every transition path — treat it as free-form.

---

## `GET /orders/:orderId/activity`

What **administrators** did to this order. The sibling of `/timeline`, which is what everyone
did.

| | |
|---|---|
| **Permission** | `orders.read` **+** `audit.read` |
| **Sorting** | `occurredAt` only. Default `-occurredAt` |
| **Filters** | `action` (only `orders.*`, derived from the catalog — includes `orders.delivery_fee_refund.settle`, the delivery-fee refund settled on `/money`), `status`, `from`/`to` (max 366 days) |
| **Response** | Audit entries — see [audit.md](audit.md#get-audit) |

---

## `GET /orders/:orderId/refund-eligibility`

How much may be refunded, and whose policy that would break.

| | |
|---|---|
| **Permission** | **`orders.refund`** — the answer is a ceiling on money, not a record |
| **Transport** | **Delegated.** A copy of this arithmetic here would be a second definition of what a customer is owed |
| **Parameters** | None |

### Response (200)

```jsonc
{
  "success": true,
  "data": {
    "eligible": true,
    "maxRefundable": 27500,
    "remaining": 27500,
    "currency": "XAF",
    "gateway": "mtn_momo",
    "gatewayRefundSupported": true,
    "isCod": false,
    "vendorPolicy": {
      "eligible": false,
      "maxRefundable": 13750,
      "remaining": 13750,
      "currency": "XAF",
      "reasonCode": "RETURN_WINDOW_EXPIRED",
      "refundProcessingDays": 7,
      "returnShippingPayer": "customer"
    },
    "overrides": ["return_window_expired"],
    "openRefundRequest": null,          // { id, status } when a refund request is already open on the order
    "legacyRouteCeiling": 2000000       // POST /orders/:orderId/refund refuses at or above this
  }
}
```

| Field | Notes |
|---|---|
| `maxRefundable` / `remaining` | **The platform's money invariant.** Never waivable |
| `vendorPolicy` | **The vendor's commercial terms**, which are waivable with `overridePolicy` |
| `overrides` | Exactly which vendor gates a full refund would cross. **Show these before asking an operator to confirm** — a specific override beats a general one |
| `gatewayRefundSupported` | Kept under its old name: **will the money go back on its own once approved?** True for a card, and for mobile money whose paying number is on record (a payout to it). False for COD and for a payment with no number — those wait in the refund queue for a typed number |
| `isCod` | A cash order — its refund waits in the refund queue (`awaiting_approval`) for a typed number, its proof and a second administrator |
| `overrides` values | `return_window_expired` · `policy_disabled` · `order_not_paid` · `above_policy_maximum` |
| `openRefundRequest` | A refund request already open on the order (`{ id, status }`) — `POST /refund` is then `409 REFUND_ALREADY_OPEN`; open it at `GET /refunds/:refundId` |
| `legacyRouteCeiling` | `2000000`. At or above it `POST /orders/:orderId/refund` is refused — use `POST /refunds` |

Read the two blocks as two different ceilings: the outer one is what the platform will permit,
the inner one is what the vendor agreed to.

---

## `POST /orders/:orderId/dispute/resolve`

Decide a payment dispute.

| | |
|---|---|
| **Permission** | `orders.disputes.resolve` — `financial` |
| **Transport** | Delegated |
| **Body** | **Strict** |

### Request body

| Field | Type | Rules |
|---|---|---|
| `outcome` | `won` \| `lost` | Required |

`won` and `lost` are from the platform's point of view.

```json
{ "outcome": "won" }
```

### Response (200)

**The order, in exactly the shape [`GET /orders/:orderId`](#get-ordersorderid) returns** —
`data` is an `OrderDetailDto`, camelCase, re-read through the same projection. Message
`"Dispute resolved as won"`.

`deliveryAddress` is textual only here as well: the write answers through the same mapper as
the read, so the coordinates and the customer's raw input are excluded on both.

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Not `won`/`lost`, or an unknown field |
| 404 | `NOT_FOUND` | |
| 409 / 422 | `PLATFORM_OPERATION_REJECTED` | No active dispute, or already resolved |
| 502 / 503 | `SERVICE_DEPENDENCY_UNAVAILABLE` | |

### Audit

`orders.disputes.resolve`

---

## `POST /orders/:orderId/cancel`

Cancel an order. **This runs six guards spanning three collections and notifies two
audiences** — it is not a status column.

| | |
|---|---|
| **Permission** | `orders.intervene` |
| **Transport** | Delegated |
| **Body** | **Strict** |

### Request body

| Field | Type | Rules |
|---|---|---|
| `reason` | string | **Required.** 3–500 characters |

```json
{ "reason": "Customer requested cancellation before dispatch — ticket TCK-2026-1192" }
```

### Response (200)

**The order, in exactly the shape [`GET /orders/:orderId`](#get-ordersorderid) returns** —
`data` is an `OrderDetailDto`, camelCase, re-read through the same projection. Message
`"Order cancelled"`.

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | |
| 404 | `NOT_FOUND` | |
| 409 / 422 | `PLATFORM_OPERATION_REJECTED` | A guard refused — already shipped, already cancelled, funds released. `details.platformCode` names which |
| 502 / 503 | `SERVICE_DEPENDENCY_UNAVAILABLE` | |

### Audit

`orders.cancel`

---

## `POST /orders/:orderId/dispatch`

Mint shipments and start the auto-assignment broadcast.

| | |
|---|---|
| **Permission** | `orders.intervene` |
| **Transport** | Delegated |
| **Body** | **Strict** |

### Request body

| Field | Type | Rules |
|---|---|---|
| `reason` | string | **Optional**, ≤ 500 characters |

### Response (200)

```jsonc
{
  "success": true,
  "data": {
    "shipmentsAssigned": 2,
    "order": { "id": "6670…", "orderNumber": "ORD-2026-008841",
               "fulfillmentStatus": "processing", "…": "…" }
  },
  "message": "Dispatched 2 shipment(s) to the delivery agency"
}
```

`order` is an **`OrderDetailDto`** — the same shape
[`GET /orders/:orderId`](#get-ordersorderid) returns, camelCase, re-read through the same
projection. Only the `order` half changed; `shipmentsAssigned` is unchanged and is still what
you branch on.

When nothing was pending, `shipmentsAssigned` is `0` and the message is
`"Nothing to dispatch — no shipment on this order was pending"`. **That is a `200`, not an
error** — branch on the count.

### Audit

`orders.dispatch`

---

## `POST /orders/:orderId/refund`

> ⚠ **Superseded by the refund queue ([refunds.md](refunds.md), 2026-10-05).** The route, its permission and its audit action are unchanged; **what it does behind them changed.** jovi-mall now **opens a refund request** and approves it in the same call when there is somewhere to send the money (the administrator is the approver). New screens should use `POST /refunds` (with `approveNow`) instead.
>
> ⛔ **At or above 2 000 000 it is refused** — `422 REFUND_USE_REFUND_QUEUE`, before the audit row and before jovi-mall is asked. This route has no second administrator; the four-eyes approval lives on the queue. The line is **cumulative per order**: what the order already returned (its completed refunds, read from `refund_transactions`) **plus** this amount — so 1 999 999 twice cannot pass it in pieces. With no `amount`, this amount is jovi-mall's `maxRefundable` (one extra read).

Refund an order, in full or in part — **below 2 000 000**. What happens to the money depends on how
it was paid:

| Paid by | Answer `status` | What happened |
|---|---|---|
| card | `completed` | Refunded through the card gateway in the call |
| mobile money, payer's number on record | `sending` (then `completed` on the gateway's callback) — or `failed`, or `approved` with `transferFailureReason` | A transfer to the number that paid, **minus the refund fee** (`feeAmount`; the customer receives `netAmount`) |
| cash on delivery, or no paying number | `awaiting_approval` | **Nothing was sent.** The request waits in the refund queue for a typed number, its proof picture and a second administrator |

Every case opens a refund request (one per order at a time) and pauses the order's earnings until
it completes, when they are clawed back.

| | |
|---|---|
| **Permission** | `orders.refund` — `financial` |
| **Transport** | Delegated |
| **Body** | **Strict** |

### Request body

| Field | Type | Rules |
|---|---|---|
| `amount` | integer | Optional, **whole** XAF, positive. Together with what the order already refunded it must stay **below 2 000 000** (`422 REFUND_USE_REFUND_QUEUE` otherwise). **Absent means the full remaining refundable balance — not the vendor's policy cap.** An administrator asking to "refund this order" means the order |
| `reason` | string | **Required.** 3–500 characters |
| `overridePolicy` | boolean flag | Acknowledges going beyond the **vendor's** commercial terms — the return window, the refund percentage. **It never waives a money invariant**: an amount above the remaining balance is refused whatever this says |
| `itemDefective` | boolean flag | Optional (C-1). Under the vendor's "customer pays, reimbursed if defective" return-shipping setting, also returns the delivery money |

```json
{ "amount": 27500, "reason": "Parcel never arrived; agent confirmed loss", "overridePolicy": true }
```

### Recommended flow

1. `GET /orders/:orderId/refund-eligibility`
2. If `overrides` is non-empty, show the operator **exactly which vendor gates** would be
   crossed and ask them to confirm.
3. `POST /orders/:orderId/refund` with `overridePolicy: true`.

Without the flag, a refund beyond the vendor's terms is a **`422`** carrying exactly which gates
it would cross — so an operator confirms a specific override rather than a general one.

### Response (200)

```jsonc
{
  "success": true,
  "data": {
    "refundId": "6720a1b2c3d4e5f6a7b8c901",        // ⚠ DEPRECATED alias of refundRequestId (it used to be a refund_transactions id)
    "refundRequestId": "6720a1b2c3d4e5f6a7b8c901", // open it at GET /refunds/:refundId
    "status": "sending",                           // the REQUEST's status — no longer always "completed"
    "amount": 27500,                               // GROSS — what the order loses (= grossAmount)
    "grossAmount": 27500,
    "feeAmount": 550,                              // the refund fee (0 on a card refund)
    "netAmount": 26950,                            // what the customer receives
    "currency": "XAF",
    "paymentChannel": "mobile_money",              // card | mobile_money | cod | billing
    "channel": "payout",                           // card_refund | payout | external | null
    "transferFailureReason": null,
    "totalRefunded": 0,                            // COMPLETED refunds on the order so far
    "fullyRefunded": false,                        // true only once a refund COMPLETED and squared the order
    "withinVendorPolicy": false,
    "overrides": ["return_window_expired"]
  },
  "message": "Refund approved and being sent — the vendor’s return policy was overridden"
}
```

The message follows `status`: `completed` → "Refund completed" · `awaiting_approval` → "Refund
request opened — it waits in the refund queue for a destination number" · `failed` → "…the transfer
failed — retry or settle it from the refund queue" · `waiting_for_cash` → "…sent once the cash on
delivery reaches the platform" · otherwise "Refund approved and being sent". A suffix says when the
vendor's policy was overridden. **Branch on `status`, never on the message.**

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Missing reason, non-positive or fractional amount, unknown field |
| 404 | `NOT_FOUND` | |
| **422** | **`REFUND_USE_REFUND_QUEUE`** | Already refunded on the order + this refund is **2 000 000 or more** (`details: { requested, alreadyRefunded, ceiling, queue: "/api/v1/refunds" }`). Raised here before anything is written; raise it from the refund queue instead |
| **422** | `PLATFORM_OPERATION_REJECTED` · `details.platformCode: REFUND_POLICY_OVERRIDE_REQUIRED` | **The refund would cross the vendor's policy and `overridePolicy` was not set.** `details.overrides` names the gates (also `requested`, `vendorMaxRefundable`, `maxRefundable`) |
| 409 | `PLATFORM_OPERATION_REJECTED` · `details.platformCode: REFUND_ALREADY_OPEN` | A refund request is already open on the order — `details.refundRequestId`, `details.status`. Work it in the queue |
| 423 | `PLATFORM_OPERATION_REJECTED` · `details.platformCode: ORDER_DISPUTE_HOLD` | A card dispute holds the order; resolve the dispute instead |
| 409 / 404 / 400 | `PLATFORM_OPERATION_REJECTED` | `REFUND_ALREADY_FULLY_REFUNDED`, `REFUND_NOT_ELIGIBLE`, `REFUND_PAYMENT_NOT_FOUND`, `REFUND_AMOUNT_EXCEEDS_MAX` |
| 502 / 503 | `SERVICE_DEPENDENCY_UNAVAILABLE` | |

### Audit

`orders.refund`
