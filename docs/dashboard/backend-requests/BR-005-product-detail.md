# BR-005 · A product detail endpoint

**Priority: high.** This is the largest gap in the round — most of the ask has no data behind it at all.

## The ask

> On the catalogue section, we should be able to open the product in a detail page to see the image
> of the product and the amount left in stock and all its related info, including the amount the
> vendor has to pay for storing the product in the agency store. (Display the business name of the
> agency responsible for the product.) Also we should be able to perform administrative actions on
> their products.

## What exists today

**Three routes. Products are not a route group; they are a sub-resource of a vendor.**

| Method | Path | Permission |
|---|---|---|
| `GET` | `/vendors/:vendorId/products` | `vendors.read` |
| `POST` | `/vendors/:vendorId/products/:productId/suspend` | `vendors.products.manage` |
| `POST` | `/vendors/:vendorId/products/:productId/restore` | `vendors.products.manage` |

**There is no `GET /vendors/:vendorId/products/:productId`.** The suspend and restore routes live at
that path, but only as `POST` sub-resources. The only way to read a product is to find it in a page of
the list.

The complete row — thirteen fields, and this is the entire universe:

```jsonc
{
  "id", "title", "slug", "category", "type", "status", "mode", "hasVariants",
  "suspension": { "reason", "previousStatus", "at", "byAgencyId", "note" },
  "deliveryAgencyId", "lastOrderedAt", "createdAt", "updatedAt"
}
```

Checked against the ask, field by field:

| Asked for | Status |
|---|---|
| **Image** | **Absent.** No `images`, no `imageFileIds`, no `thumbnail`. And gap **D2** applies even if there were: *"This service resolves no file URLs"* ([ADR-008 D-6](../../ADR-008-VENDOR-MANAGEMENT.md)) — an id alone renders nothing |
| **Stock / inventory** | **Absent.** Zero occurrences of `stock`, `inventory` or `quantity` on any product field |
| **Price** | **Absent** from the product row |
| **Storage fee the vendor pays the agency** | **Absent as a charge** — see below, the *tariff* exists but nothing joins it to a product |
| **The responsible agency's business name** | **Absent.** `deliveryAgencyId` only — an id, no nested object |
| **Variants** | `hasVariants: boolean` only. No variant list, no variant detail |
| **Administrative actions** | ✅ suspend and restore exist, and are the whole set |

Also refused by design, and not disputed here: *"a catalogue search **across** vendors — this is a
per-vendor view, scoped by the path. A cross-vendor catalogue is a different surface with a different
permission."*

## The storage-fee finding

Worth stating precisely, because the ingredients exist and only the join is missing.

The fee is not on the product and not on the vendor. It is on the **agency**, inside its commercial
terms:

```jsonc
// GET /agencies/:agencyId → policies.pricing.storage_based
{ "enabled": true, "monthly_storage_fee_per_sku": 500, "pick_pack_fee_per_order": 250,
  "local_delivery_fee": 1000, "out_of_region_delivery_fee": 2500 }
```

`VendorProduct.deliveryAgencyId` reaches that in one request. So the dashboard can honestly say
*"this agency charges 500 per SKU per month"* — **a published rate, not a charge computed on this
listing**. It cannot say what the vendor actually owes for this product, because that needs the SKU
count, the period, and the platform's own billing arithmetic. Doing that multiplication in a browser
would be inventing an invoice.

## What the dashboard does in the meantime

An **expandable detail card** below the catalogue row, not a route — a route would have to re-fetch
the whole catalogue page and scan for the id on every refresh or deep link. It is factored as a
standalone card so it becomes the body of a real route with no rework once this endpoint lands.

It renders the thirteen fields properly, including five the table drops today — `slug`, the copyable
`id`, `hasVariants`, and crucially **`suspension.previousStatus`** (*what it returns to, if it
returns*) and **`suspension.byAgencyId`** (*which agency did this*), the two most actionable fields on
a suspended listing.

The agency name is resolved client-side from `deliveryAgencyId`, **gated on `agencies.read`** — the
catalogue tab requires only `vendors.read`, so an operator without it sees the id and no request is
made. See [BR-006](BR-006-agency-name-on-contract-rows.md) for the general form of that problem.

**Fields the API does not provide are named and marked unavailable rather than omitted**, so the gap
is visible on screen instead of looking like a design choice. No placeholder image, no `Stock: —`.

## The proposed contract

### `GET /api/v1/vendors/:vendorId/products/:productId`

Permission `vendors.read`. Nested under `/:vendorId` for the same reason the writes are — *"the
ownership is the authorisation"* — so a `404` covers both "no such vendor" and "the product does not
belong to this vendor".

Every list field, plus:

```jsonc
{
  …,
  "media": {
    "imageFileIds": ["6612…", "6612…"],
    "primaryImageFileId": "6612…"
  },
  "pricing": { "amount": 4500, "currency": "XAF", "compareAtAmount": null },
  "inventory": {
    "tracked": true,
    "available": 42,
    "reserved": 6,
    "location": { "agencyId": "665c…", "label": "Bonabéri warehouse" }
  },
  "deliveryAgency": { "id": "665c…", "businessName": "Littoral Express Delivery", "status": "active" },
  "storage": {
    "billable": true,
    "skuCount": 3,
    "ratePerSkuPerMonth": 500,
    "accruedThisPeriod": 1500,
    "currency": "XAF",
    "periodStart": "2026-08-01T00:00:00.000Z"
  },
  "variants": [ { "id", "title", "sku", "available", "amount" } ]
}
```

Notes on each, in the order they matter:

- **`storage` is the part only you can compute.** `ratePerSkuPerMonth` is the agency's published
  tariff; `accruedThisPeriod` is what the vendor actually owes for this listing. If the second cannot
  be computed, ship the first alone and say so — a rate we can attribute is far better than a number
  we invent. `billable: false` when the vendor is on a pickup-based arrangement, so the block is not
  silently zero.
- **`inventory.tracked: false`** distinguishes *"we do not track stock for this product"* from
  *"stock is zero"*. Those have opposite remedies and `available: 0` alone conflates them.
- **`media.imageFileIds` is worthless without gap D2.** File ids are opaque and this service resolves
  no URLs, so shipping ids alone moves the problem rather than solving it. Either a
  `GET /files/:fileId` (or a signed-URL field on the product) lands with this, or the image half of
  the ask stays blocked. **Please treat D2 as part of this request.**
- **`deliveryAgency` as an object**, not an id, removes an N+1 and removes the permission question —
  the name arrives under `vendors.read` rather than requiring the caller to reach into `/agencies`.
- **`variants`** only if `hasVariants`; `[]` otherwise, never `null`.
- `pricing.amount` is a plain number in `currency`. Never minor units.

### On administrative actions

The existing two are enough for the read screen and are already wired. Two smaller things:

1. `POST …/suspend` sets `suspension.reason: "platform_oversight"` and requires `note` (3–500). The
   interaction worth documenting more prominently: **a product suspended by `platform_oversight` is
   never republished by `POST /vendors/:vendorId/restore`** — only the product's own restore lifts it.
   That is stated once and is easy to miss.
2. If a broader set is wanted later (relocate to another agency, force-archive), it belongs in its own
   request — this one is about being able to *see* a product.

## Acceptance

- [ ] `GET /vendors/:vendorId/products/:productId` exists under `vendors.read`, scoped by both ids.
- [ ] It returns `media`, `pricing`, `inventory`, `deliveryAgency`, `storage` and `variants`.
- [ ] `inventory.tracked` distinguishes untracked from zero.
- [ ] `storage` carries at least the agency's rate, and states whether the listing is billable.
- [ ] `deliveryAgency` is an object carrying `businessName`, not an id.
- [ ] Either file-URL resolution ships alongside (gap **D2**), or the response says images are not
      renderable yet.
- [ ] `vendors.md` documents the response, and the `platform_oversight` / vendor-restore interaction
      is stated on both routes.
