# `/orders` — order administration

Base path: `/api/v1/orders`

The directory, the detail, both histories, a refund ceiling, and the four interventions.

Design record: [`../ADR-010-ORDERS-AND-SHIPMENTS.md`](../ADR-010-ORDERS-AND-SHIPMENTS.md).

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

    "priceBreakdown": { "base": 25000, "tax": 1250, "discount": 0, "total": 27500 },
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
          "freeDelivery": false,
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
| `dispute` | **`null` when the order has never been disputed** — absent entirely rather than a block of nulls that reads as "unknown". Present (with `active: false`) once resolved, because a resolved dispute is exactly what an administrator opens this screen for |
| `completion.auto` | Whether the escrow released automatically or a person confirmed |
| **`deliveryAddress`** | **Textual only.** `coordinates` and the customer's raw input are excluded by projection *and* by the mapping — the sharpest PII in the collection |
| **`items[].image`** | The **primary** image of what was sold, never the gallery. A full `FileDetail`, or `null` — see below |
| **`items[].delivery.agencyName`** | The agency's **business name**, from the Magazin. `null` where the item has no agency, the agency row is gone, or the Magazin has no name — **never `display_name`**, which is the agency's contact *person* |
| **`items[].delivery.trackingNumber`** | ⚠ **The handle an operator actually works with.** `shipmentId` is an internal id that cannot be typed into anything; [`GET /shipments`](shipments.md#get-shipments)'s `search` takes a tracking-number **prefix**, and a customer on the phone quotes a tracking number. `null` while the item is unfulfilled — the ordinary state, not an error |
| `items[].delivery.hold` | Set when an agency deactivation put this item on hold |

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
| **Filters** | `action` (only `orders.*`, derived from the catalog), `status`, `from`/`to` (max 366 days) |
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
    "overrides": ["RETURN_WINDOW_EXPIRED", "PARTIAL_REFUND_PERCENTAGE"]
  }
}
```

| Field | Notes |
|---|---|
| `maxRefundable` / `remaining` | **The platform's money invariant.** Never waivable |
| `vendorPolicy` | **The vendor's commercial terms**, which are waivable with `overridePolicy` |
| `overrides` | Exactly which vendor gates a full refund would cross. **Show these before asking an operator to confirm** — a specific override beats a general one |
| `isCod` | A cash order refunds differently |

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

Refund an order, in full or in part. **Calls a payment gateway, writes its ledger row before
the call, and reverses escrow across every actor on the order.**

| | |
|---|---|
| **Permission** | `orders.refund` — `financial` |
| **Transport** | Delegated |
| **Body** | **Strict** |

### Request body

| Field | Type | Rules |
|---|---|---|
| `amount` | number | Optional, positive, ≤ 1 000 000 000. **Absent means the full remaining refundable balance — not the vendor's policy cap.** An administrator asking to "refund this order" means the order |
| `reason` | string | **Required.** 3–500 characters |
| `overridePolicy` | boolean flag | Acknowledges going beyond the **vendor's** commercial terms — the return window, the refund percentage. **It never waives a money invariant**: an amount above the remaining balance is refused whatever this says |

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
    "refundId": "rf_66739911",
    "status": "completed",
    "amount": 27500,
    "currency": "XAF",
    "totalRefunded": 27500,
    "fullyRefunded": true,
    "withinVendorPolicy": false,
    "overrides": ["RETURN_WINDOW_EXPIRED"]
  },
  "message": "Refund completed — the vendor’s return policy was overridden"
}
```

When nothing was overridden the message is simply `"Refund completed"`.

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Missing reason, non-positive amount, unknown field |
| 404 | `NOT_FOUND` | |
| **422** | `PLATFORM_OPERATION_REJECTED` | **The refund would cross the vendor's policy and `overridePolicy` was not set.** `details` names the gates |
| 409 / 422 | `PLATFORM_OPERATION_REJECTED` | Amount above the remaining balance, gateway refuses, order not refundable |
| 502 / 503 | `SERVICE_DEPENDENCY_UNAVAILABLE` | |

### Audit

`orders.refund`
