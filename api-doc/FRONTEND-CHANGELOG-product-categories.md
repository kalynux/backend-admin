# FRONTEND-CHANGELOG — admin dashboard: product categories (2026-10-04)

Endpoint reference: [api/categories.md](./api/categories.md). Permissions:
[api/permissions.md § catalog](./api/permissions.md). Vendor catalogue rows:
[api/vendors.md](./api/vendors.md).

## In one paragraph

jovi-mall now keeps **one marketplace-wide product-category list**, and every product holds
**1 to 5** of its entries. Vendors create categories themselves while editing a product, and a
duplicate check handles what they type:
- spelling variants are reused silently;
- probable typos get "Did you mean …?".

Some duplicates still slip through, such as translations ("Chaussures" / "Shoes") and
synonyms. The admin dashboard cleans those up with **rename, merge and delete**. A merge moves
every product to the surviving category, and is **remembered**: vendors who later type the
merged spelling land on the survivor.

## What to build

### 1. A Categories screen: `GET /api/v1/categories` (`catalog.categories.read`)

- **Table columns:** name, slug, `productCount`, `activeProductCount`, `createdSource`
  (`vendor` / `admin` / `migration`), `createdAt`.
- **Filters:** `search` (name or slug) and `createdSource`.
- **Sorts:** `name` (default), `createdAt`, `updatedAt`. Pagination uses the usual `meta`
  (`total`, `page`, `limit`, `pages`).
- **`aliasKeys`:** normalised spellings that also resolve here. Show them under "Also matches"
  in a detail drawer, or not at all. They are not display names.
- **Visibility:** Support (tier 3) can see this screen. Hide the action buttons unless the
  admin holds `catalog.categories.manage`, which tiers 1 and 2 have.

Detail: `GET /api/v1/categories/:categoryId`, same row shape.

### 2. Rename: `PATCH /api/v1/categories/:categoryId`, body `{ name }`

The old spelling stays as an alias automatically. On `409` with
`details.platformCode === 'CATEGORY_NAME_TAKEN'`, the name already belongs to
`details.existingName` (`details.existingId`). **Offer "Merge into ‹existingName› instead"**
rather than an error toast.

### 3. Merge: `POST /api/v1/categories/:categoryId/merge`, body `{ targetId }`

- **Pick the target** from the same list. Exclude the source itself.
- **Confirm first** with a dialog: "Move ‹productCount› products from ‹source› to ‹target›?
  This cannot be undone."
- **On success:** the response is `{ source, target, productsUpdated }`. Show the count,
  remove the source row, and refresh the target.

### 4. Delete: `DELETE /api/v1/categories/:categoryId`

Only enable it when `productCount === 0`. If it is refused anyway (`409`,
`platformCode: 'CATEGORY_IN_USE'`, `details.productCount`), offer **Merge** instead.

There is **no "create category"** in admin. Categories come into existence when a vendor names
one on a product.

### 5. Errors

A refusal from jovi-mall arrives as `error.code: "PLATFORM_OPERATION_REJECTED"`, with the same
status. Branch on **`error.details.platformCode`**:

| `platformCode` | Status | UI |
|---|---|---|
| `CATEGORY_NAME_TAKEN` | 409 | Offer merge into `details.existingName` |
| `CATEGORY_IN_USE` | 409 | Offer merge (`details.productCount`) |
| `CATEGORY_MERGE_INVALID` | 422 | "Choose a different, existing category" (`details.reason`) |
| `CATEGORY_NAME_INVALID` | 400 | "2–60 characters, at least one letter or digit" |
| `CATEGORY_NOT_FOUND` | 404 | "This category was just changed by someone else". Refresh |

`404 NOT_FOUND`, from wi-admin itself, means the category was already gone before the call.

### 6. Vendor catalogue rows

`GET /api/v1/vendors/:vendorId/products` rows now carry
`categories: Array<{ id, name, slug }>`, where the first is the primary. They also keep the
deprecated `category` (`categories[0].name`). Show `categories` as chips and stop reading
`category`.

## Audit

Every rename, merge and delete is audited against a `category` target:
`catalog.categories.rename`, `catalog.categories.merge` and `catalog.categories.delete`. A
merge row's `after` carries `productsUpdated`. If the audit screen filters by target type, add
`category`.
