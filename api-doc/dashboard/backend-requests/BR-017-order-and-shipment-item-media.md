# BR-017 · Product images and titles on order and shipment items

**Verified against source on 2026-09-08** — `items[].image` on the order detail and
`items[].title` / `price` / `image` on the shipment detail against
[`orders.md`](../../api/orders.md), [`shipments.md`](../../api/shipments.md) and their DTOs.

> ### ✅ BUILT — both screens; drop the client-side N+1
>
> **Answered in [`RESPONSE-2026-08-26.md`](RESPONSE-2026-08-26.md).** `GET /orders/:orderId` gained
> `items[].image` (**variant-preferred**, keeping `access` and `mimeType` so a both-conditions
> render gate still works); `GET /shipments/:shipmentId` gained `items[].title`, `items[].price` +
> `currency` and `items[].image`. **Cost is three reads per screen regardless of line count**, not
> one per distinct product. The resolver mirrors jovi-mall's `resolveProductImages` exactly:
> variant-first as a *fallback*, never a merge, `image/*` only, live rather than snapshotted.
>
> § C was confirmed as needing no change — `order.vendorId` + `items[].productId` and `order.id` +
> `items[].orderItemId` were already on the shipment wire.

**Priority: medium.** Unlike the rest of this round, **this one has a working client-side answer**
— it just costs one delegated request per distinct product on the screen. We are asking you to
fold it in, not to unblock us.

## The ask

> Orders → **Items**: we need the image of the products.
>
> Shipments → **Overview**: under the item card, if it will not be readily possible to display the
> name of the product and the price, we need a link that directs us straight to the parcel in the
> order and to the product itself.

---

## What exists today

**An order item is a snapshot with no picture.** `GET /orders/:orderId` returns
`items[] = { id, productId, variantId, sku, title, variantTitle, optionsSnapshot, productType,
quantity, price, currency, delivery }`.

Confirmed at the source: jovi-mall's `order.model.ts` stores `product_id`, `title`, `sku`,
`variant_title` and the money on the line — and **zero `image`, `thumbnail` or `media` fields**.
The snapshot was built to survive the product changing, and an image was never part of it.

**A shipment item is narrower still.** `GET /shipments/:shipmentId` returns
`items[] = { orderItemId, productId, variantId, quantity }` — no title, no price, no image.

So the order screen has a title and a price but no picture; the shipment screen has neither.

---

## The client-side path, and why it is not free

**`GET /vendors/:vendorId/products/:productId` already returns everything both screens want.**
Added at [BR-005](BR-005-product-detail.md), it carries:

```jsonc
"media": {
  "images": [ { "id", "key", "url", "mimeType", "size", "originalName" } ],
  "primaryImage": { /* images[0], or null */ }
},
"pricing": { "amount": 4500, "compareAtAmount": 5200, "currency": "XAF", "range": null }
```

and `media.images` is documented as *"Resolved `FileDetail` objects **with URLs**, thumbnail
first, `image/*` only"*.

Both screens can reach it:

| Screen | Has `vendorId`? | Has `productId`? |
|---|---|---|
| Order detail | ✅ on the order itself | ✅ on each item |
| Shipment detail | ✅ `order.vendorId` | ✅ on each item |

**So we will build it that way, and the two screens ship complete.** The cost is one delegated
request per distinct product — three items means three round trips, each of which is a wi-admin
hop plus a jovi-mall hop, and each of which resolves a full product payload (variants, storage
tariff, inventory) to read one image and one price.

That is affordable on a three-line order. It is poor on a twelve-line one, and it is the same
N+1 shape BR-006 was granted to remove from a different screen.

---

## What we are asking for

### A · `items[].image` on `GET /orders/:orderId`

One field, resolved the way `media.primaryImage` already is:

```jsonc
"items": [
  {
    "id": "6670…40",
    "productId": "66601122334455667788990a",
    "title": "Plantain — 1 kg",
    "image": {
      "id": "6612…",
      "url": "https://cdn.example.com/…",
      "access": "public",
      "mimeType": "image/jpeg"
    }
  }
]
```

| Point | |
|---|---|
| **`null` is expected and fine** | A product whose media was swept, a digital line, a product deleted since the order — all `null`, and we render the title alone |
| **The variant's image where there is one** | `media` on the product resolves *"from the default variant, falling back to the product's own media"*; an order line names a specific `variantId`, so **that** variant's image is the more correct answer here |
| **Primary only, not the gallery** | One image per line. An items table does not want four |
| ⚠ **Please keep `access` and `mimeType`** | Our render is gated on `access === 'public' && url !== null && mimeType.startsWith('image/')`, per `files.md`'s both-conditions rule. A bare `url` string would make us guess |

### B · `items[].title`, `items[].price` and `items[].image` on `GET /shipments/:shipmentId`

The shipment item is the thinnest row on the platform and it is on a screen an operator opens
mid-dispute. `orderItemId` is already there, so the join is to a document you have already loaded
if the order is being read — and `GET /orders/:orderId` proves the projection exists.

If only one of the three is cheap, **`title` is the one worth having**: a parcel described as
`6670aabbccddeeff00112240 × 3` is not a description.

### C · Nothing is being asked for on the *linking*

For completeness: the "link to the parcel and to the product" half of the ask **needs no backend
change** and ships now. `order.vendorId` + `items[].productId` is a complete
`/dashboard/vendors/:vendorId/products/:productId` address, and `orderId` + `orderItemId` is a
complete deep link into the order's items tab.

---

## Summary

| Endpoint | Add | Blocking? |
|---|---|---|
| `GET /orders/:orderId` | `items[].image` — variant-preferred, `null`-able, with `access` + `mimeType` | No — N+1 workaround ships |
| `GET /shipments/:shipmentId` | `items[].title`, `items[].price` + `currency`, `items[].image` | No — same workaround, and the links ship regardless |

**What we would lose by your declining:** nothing an operator can see — only request count. That
is why this is medium and not high. But it is a request count that scales with the size of the
order, on two of the busiest screens in the product.
