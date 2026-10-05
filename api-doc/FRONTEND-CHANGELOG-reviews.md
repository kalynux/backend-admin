# FRONTEND-CHANGELOG — admin dashboard: review moderation (2026-10-05)

Endpoint reference: [api/reviews.md](./api/reviews.md). Permissions:
[api/permissions.md § reviews](./api/permissions.md#reviews). Audit filter values:
[api/audit.md](./api/audit.md).

## In one paragraph

Customers rate products they bought. Customers, shops and delivery agencies rate deliveries.
Until now, a review with written words waited for an administrator to approve it, but no
screen existed to do that, so **every written review stayed invisible**. That has changed:
**every review now goes public the moment it is written**, and the ones that were waiting have
been published. The admin dashboard gets a **Reviews screen** to act afterwards:
- **unpublish** (hide) a review;
- **republish** (show again) a hidden one;
- **delete** one for good.

All three administrator levels can do all three, Support included.

## What to build

### 1. A Reviews screen: `GET /api/v1/reviews` (`reviews.read`)

- **Default view:** newest first, both statuses.
- **Tabs or a filter:** All · Published · Hidden (`status=published` / `status=unpublished`).
  The counts come from `meta.total` of each filtered call.
- **Filters:**
  - `subjectType` (Products / Deliveries)
  - `authorRole` (Customer / Shop / Agency)
  - `rating` (1–5)
  - `hasText` ("With comments only": the reviews that can contain abuse)
  - `search` (words in the title or body)
- **Sort:** `-createdAt` (default), `createdAt`, `-rating`, `rating`.
- **Row:**
  - stars;
  - title and body, truncated;
  - a status badge (`published` → "Public", `unpublished` → "Hidden");
  - a **Products / Deliveries** label;
  - what it is about: `product.name` for a product, otherwise `agent.name` · `agency.name`;
  - the shop (`vendor.name`);
  - the author (`author.name` + role);
  - `createdAt`.
- **⚠ Delivery reviews are never public, even when published.** Use `publiclyVisible` for any
  "visible on the site" indicator, never `status`. For a delivery row, say "Internal: counts
  towards the agent's and agency's rating" instead of "Public".
- **Deep links from other screens:** the same endpoint takes `productId`, `vendorId`,
  `agentId` and `agencyId`. A "Reviews" tab on the product, vendor, agent and agency detail
  pages is one call each.

Detail: `GET /api/v1/reviews/:reviewId`, same shape. `lastModeration` holds the most recent
action: `action`, `at`, `reason`, and who did it (`byAdministratorId`). For the full history,
link to the audit log filtered to `targetType=review&targetId=<id>`.

### 2. Actions

Show a button when **both** of these hold:
1. the review's `availableActions` contains the verb (it is derived from the status);
2. the signed-in administrator has the permission.

| Button | Call | Permission | Body |
|---|---|---|---|
| **Hide** | `POST /api/v1/reviews/:id/unpublish` | `reviews.moderate` | `{ reason }`, **required**, 3–500 chars |
| **Show again** | `POST /api/v1/reviews/:id/republish` | `reviews.moderate` | `{}` or `{ reason }`, optional |
| **Delete** | `DELETE /api/v1/reviews/:id` | `reviews.delete` | `{ reason }`, **required**, 3–500 chars, a JSON body on the DELETE |

- **Every action needs a dialog.** Hide and Delete need a reason field.
- **The reason is never shown to the author or the public.** Label the field "Note for other
  administrators (not shown to the author)".
- **Hide / Show again** answer the updated review. Replace the row.
- **Delete** answers `{ id, deleted: true }`. Remove the row.
- **Delete confirmation copy has to say the two things that differ from Hide:**
  - it cannot be undone;
  - the author will be able to write a new review.

  Suggested: *"Delete this review permanently? It can't be restored, and its author will be
  able to write a new one. To hide it while keeping it on record, use Hide instead."*
- **The effect on ratings is immediate:** a hidden or deleted review's stars stop counting, and
  showing it again restores them. Refresh any rating you display after an action.

### 3. Errors

| What comes back | Meaning | UI |
|---|---|---|
| `400 VALIDATION_ERROR` | reason missing / too short / too long, or an unknown body key | Inline on the reason field |
| `404 NOT_FOUND` | the review was already deleted | Remove the row, toast "This review was already deleted" |
| `409 PLATFORM_OPERATION_REJECTED`, `details.platformCode: REVIEW_STATUS_CONFLICT` | someone already hid / showed it; `details.status` has the current status | Refresh the row, toast "Someone else already changed this review" |
| `404 PLATFORM_OPERATION_REJECTED`, `details.platformCode: REVIEW_NOT_FOUND` | deleted between your read and your click | Remove the row |
| `502` / `503` | the platform backend is unreachable; nothing changed | "Try again" |

### 4. Permissions and audit

- Add `reviews.read`, `reviews.moderate` and `reviews.delete` to any local permission mirror,
  plus the new family `reviews`. Every level holds all three.
- Add `review` to any audit `targetType` filter list. Add the three actions
  `reviews.unpublish`, `reviews.republish` and `reviews.delete` to any audit action labels.

### 5. What is gone

- The statuses **`pending`** and **`rejected`** no longer exist anywhere. Sending them as a
  filter is a `400`.
- **There is no approval queue.** Do not build an "Approve" or "Reject" button.
