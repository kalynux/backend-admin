# `/api/v1/categories` — the shared product-category list

**Since 2026-10-04.** Record: `../../../PRODUCTION-READINESS/PRODUCT-CATEGORIES-PLAN.md` (C-4).
Cross-dashboard contract: `jovi-mall/api-doc/FRONTEND-CHANGELOG-product-categories.md`.

jovi-mall keeps **one marketplace-wide category list**, and every product holds 1–5 entries of
it. Vendors create entries themselves while editing a product, through jovi-mall's duplicate
check:
- spelling variants are merged silently: case, accents, spacing, `&`/`and`/`et`, and
  singular/plural in English and French;
- probable typos get a "Did you mean …?" prompt.

What no spelling rule can catch, such as a **translation** ("Chaussures" / "Shoes") or a
**synonym**, is cleaned up here.

The list is a **direct read** of `product_categories`. Every write is **delegated** to jovi-mall
and audited fail-closed. A merge rewrites every product holding the category, in one jovi-mall
transaction, and records the merged spelling as an **alias** that the vendor-side duplicate
check reads from then on. A second writer would do neither.

There is no create endpoint: a category comes into existence when a vendor names it on a
product.

## GET /api/v1/categories — `catalog.categories.read`

| Query | Notes |
|---|---|
| `search` | Matches name or slug, case-insensitive |
| `createdSource` | `vendor` \| `admin` \| `migration` |
| `sort` | `name` (default) \| `createdAt` \| `updatedAt`, prefix `-` for descending |
| `page`, `limit` | Standard pagination |

```json
{
  "success": true,
  "data": [
    {
      "id": "66ff0c1e2a4b5c6d7e8f9a01",
      "name": "Shoes",
      "slug": "shoes",
      "aliasKeys": ["chaussure"],
      "createdSource": "vendor",
      "createdByVendorId": "66aa…",
      "productCount": 41,
      "activeProductCount": 37,
      "createdAt": "2026-10-04T09:12:00.000Z",
      "updatedAt": "2026-10-05T14:30:00.000Z"
    }
  ],
  "meta": { "total": 214, "page": 1, "limit": 20, "pages": 11 }
}
```

- `productCount` counts every non-deleted product that holds the category, drafts included.
  It is what a merge will move, and it is why a delete is refused.
- `activeProductCount` counts what shoppers see.
- `aliasKeys` are **normalised** spellings that also resolve to this category: its previous
  names and every category merged into it. They are not display names.
- `createdByVendorId` is audit only. It confers no ownership.

## GET /api/v1/categories/:categoryId — `catalog.categories.read`

One row, same shape. `404 NOT_FOUND` for a merged-away or deleted category.

## PATCH /api/v1/categories/:categoryId — `catalog.categories.manage`

Body `{ "name": "Shoes" }`, strict. Answers `{ category, previousName }`.
- The name is judged by jovi-mall: 2–60 characters, at least one letter or digit.
- The slug is re-derived from the new name.
- The old spelling becomes an alias, so vendors typing it still land here.

Audit: `catalog.categories.rename`.

## POST /api/v1/categories/:categoryId/merge — `catalog.categories.manage`

Body `{ "targetId": "<id>" }`, strict. Moves **every** product holding `:categoryId` to
`targetId`, keeping each product's order and removing duplicates. Then `:categoryId` is
retired and its spellings become `targetId`'s aliases. There is no un-merge.

Answers `{ source, target, productsUpdated }`. Audit: `catalog.categories.merge`, whose
`after` carries `productsUpdated`.

## DELETE /api/v1/categories/:categoryId — `catalog.categories.manage`

Only an unused category, typically one a vendor created on a save that then failed. A used one
is refused, and **merge** is how to retire it. Audit: `catalog.categories.delete`.

## Errors

A refusal from jovi-mall arrives as `PLATFORM_OPERATION_REJECTED` with jovi-mall's status. The
reason is in `details.platformCode`:

| `platformCode` | Status | Meaning |
|---|---|---|
| `CATEGORY_NAME_TAKEN` | 409 | Another category already has that name or a spelling of it (`details.existingId`, `details.existingName`). Offer a merge |
| `CATEGORY_IN_USE` | 409 | Delete refused because products use it (`details.productCount`) |
| `CATEGORY_MERGE_INVALID` | 422 | Into itself, or into a category that is not live (`details.reason`) |
| `CATEGORY_NAME_INVALID` | 400 | Unusable name |
| `CATEGORY_NOT_FOUND` | 404 | Retired between this service's read and jovi-mall's write |

## Elsewhere

`GET /api/v1/vendors/:vendorId/products` rows carry
`categories: [{ id, name, slug }]` (vendor's order) and the deprecated
`category` (`categories[0].name`).
