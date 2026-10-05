# `/api/v1/reviews` — ratings and reviews (products and deliveries)

**Since 2026-10-05.** Dashboard hand-off: [../FRONTEND-CHANGELOG-reviews.md](../FRONTEND-CHANGELOG-reviews.md).
Platform contract: `jovi-mall/api-doc/reviews.md` (what customers, vendors and agencies write)
and `jovi-mall/api-doc/admin/reviews.md` (the internal endpoints this module delegates to).

## What a review is

A review is a 1–5 star rating, plus an optional title and body, written by one person about one
thing. There are two kinds:

| `subjectType` | About | Written by | Who can see it |
|---|---|---|---|
| `product` | a product | the **customer** who bought it | **public**: the storefront's product page and its average rating |
| `delivery` | one **shipment** | the **customer**, the **vendor** and the **agency** | **internal only**: it feeds the delivery agent's and the agency's rating; no page ever shows the review itself |

**Every review is public the moment it is written** (owner decision, 2026-10-05). Nothing waits
for approval. Moderation happens **afterwards**, here, with three actions:

| Action | Effect | Reversible? | The author… |
|---|---|---|---|
| **Unpublish** | Hidden from the public; its star leaves the rating | yes: **republish** | sees it marked hidden in their own list (no reason shown), and **cannot** write another review of the same thing |
| **Republish** | Back on public view; its star counts again | yes: unpublish | sees it published again |
| **Delete** | Gone from every list and every rating | **no** | no longer sees it, and **may write a new review** of the same thing |

The list is a **direct read** of jovi-mall's `reviews` collection. The three actions are
**delegated** to jovi-mall, which recomputes the product's, agent's or agency's rating with each
one. Each action is audited fail-closed: the audit row commits before the change is made, and
if the audit store is down, nothing changes.

## Permissions

| Permission | Lets you | Tiers |
|---|---|---|
| `reviews.read` | the list and the detail | 1 · 2 · 3 |
| `reviews.moderate` | unpublish, republish | 1 · 2 · 3 |
| `reviews.delete` | delete (**destructive**) | 1 · 2 · 3 |

Support holds all three by the owner's decision, including delete. That is the one named
exception to "Support holds nothing destructive". See [permissions.md § reviews](permissions.md).

## GET /api/v1/reviews — `reviews.read`

Every live (not deleted) review, newest first.

| Query | Notes |
|---|---|
| `status` | `published` \| `unpublished`. Omit for both |
| `subjectType` | `product` \| `delivery` |
| `authorRole` | `customer` \| `vendor` \| `agency` |
| `rating` | `1`–`5` |
| `hasText` | `true`: only reviews with a title or body (the ones that can contain abuse) · `false`: stars only |
| `search` | Case-insensitive substring of the title or body |
| `productId` · `vendorId` · `agentId` · `agencyId` | Reviews about that product / that shop's products and deliveries / that agent / that agency |
| `sort` | `createdAt` \| `rating`, prefix `-` for descending. Default `-createdAt` |
| `page`, `limit` | Standard pagination (`limit` ≤ 100) |

The old statuses `pending` and `rejected` no longer exist and answer `400 VALIDATION_ERROR`.

```json
{
  "success": true,
  "data": [
    {
      "id": "6700a1b2c3d4e5f6a7b8c901",
      "subjectType": "product",
      "status": "published",
      "publiclyVisible": true,
      "rating": 2,
      "title": "Arrived late",
      "body": "The shoes were fine but took two weeks.",
      "hasText": true,
      "author": { "userId": "66f0…01", "role": "customer", "name": "Awa N." },
      "product": { "id": "66f1…22", "name": "Leather sandals" },
      "vendor": { "id": "66f2…33", "name": "Chez Awa" },
      "agent": null,
      "agency": null,
      "orderId": "66f3…44",
      "shipmentId": null,
      "lastModeration": null,
      "availableActions": ["unpublish", "delete"],
      "publishedAt": "2026-10-05T09:12:00.000Z",
      "createdAt": "2026-10-05T09:12:00.000Z",
      "updatedAt": "2026-10-05T09:12:00.000Z"
    }
  ],
  "meta": { "total": 1, "page": 1, "limit": 20, "pages": 1 }
}
```

| Field | Meaning |
|---|---|
| `status` | `published` or `unpublished` |
| `publiclyVisible` | `true` only for a **published product** review. A delivery review is always `false`, because no page shows delivery reviews, even when `status` is `published` |
| `hasText` | the review has a non-blank title or body |
| `author.name` | Customer: their name. Vendor: their **shop** name. Agency: its **business** name. `null` if unknown |
| `product` | product reviews only. `name` is the product title, and stays filled in even if the product was later deleted |
| `vendor` | the shop that sold it. Set on both kinds |
| `agent`, `agency` | delivery reviews only: who carried the parcel. `null` on product reviews |
| `orderId` | the purchase that made the author eligible. Also set on delivery reviews (the parcel's order) |
| `shipmentId` | delivery reviews: the shipment rated |
| `lastModeration` | the most recent action, or `null`. `{ action: "unpublished" \| "republished", at, reason, bySource, byAdministratorId }`. `reason` is visible to administrators only. **Only the last action is kept here**; the full history is the audit log (`GET /api/v1/audit?targetType=review&targetId=<id>`) |
| `availableActions` | which actions fit the review's **status**: `["unpublish","delete"]` when published, `["republish","delete"]` when unpublished. It does **not** check your permissions; combine it with `reviews.moderate` / `reviews.delete` |
| `publishedAt` | when it first went public. Unpublish does not clear it; republish keeps the original date |

## GET /api/v1/reviews/:reviewId — `reviews.read`

One review, same shape. `404 NOT_FOUND` if it does not exist or was deleted.

## POST /api/v1/reviews/:reviewId/unpublish — `reviews.moderate`

Body `{ "reason": "Abusive language" }`. **Required**, 3–500 characters. Never shown to the
author or the public. Answers the updated review (`status: "unpublished"`).

## POST /api/v1/reviews/:reviewId/republish — `reviews.moderate`

Body `{}` or `{ "reason": "…" }` (optional, 3–500). Answers the updated review
(`status: "published"`).

## DELETE /api/v1/reviews/:reviewId — `reviews.delete`

Body `{ "reason": "Spam" }`. **Required**, 3–500 characters, sent as a JSON body on the `DELETE`.
Works in any status. Answers:

```json
{ "success": true, "data": { "id": "6700a1b2c3d4e5f6a7b8c901", "deleted": true }, "message": "Review deleted" }
```

There is no undelete, and every later read of that id answers `404`.

## Errors

All three writes run the same checks:
- **Request shape (wi-admin):** the reason is missing or outside 3–500 characters, or the body
  has an unknown key → `400 VALIDATION_ERROR`.
- **Review gone (wi-admin):** the review does not exist or is already deleted when wi-admin
  reads it → `404 NOT_FOUND`.
- **Refused by jovi-mall:** arrives as `error.code: "PLATFORM_OPERATION_REJECTED"`. Branch on
  `error.details.platformCode`:

| `platformCode` | Status | Meaning | UI |
|---|---|---|---|
| `REVIEW_STATUS_CONFLICT` | 409 | Already hidden (unpublish) or already visible (republish). Usually another administrator acted first. The current status is in `details.status` | Refresh the row |
| `REVIEW_NOT_FOUND` | 404 | Deleted by someone else between your read and your action | Remove the row |

If jovi-mall is down or unreachable, the three writes answer `502`/`503` like every delegated
route, and nothing was changed. The list and detail keep working, because they read the
database directly.

## Audit actions

| Action | Permission | Target |
|---|---|---|
| `reviews.unpublish` | `reviews.moderate` | `review` |
| `reviews.republish` | `reviews.moderate` | `review` |
| `reviews.delete` | `reviews.delete` | `review` |

A `review` audit row is a `platform_record`, so Support can read it.
