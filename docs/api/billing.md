# `/billing` — pricing plans and subscriptions

Base path: `/api/v1/billing`

The subscription catalog, and who is on it.

Design record: [`../ADR-011-ACCOUNTS-AND-FINANCE.md`](../ADR-011-ACCOUNTS-AND-FINANCE.md).

| Method | Path | Permission | Transport | Audited |
|---|---|---|---|---|
| `GET` | `/billing/plans` | `billing.plans.read` | direct read | — |
| `GET` | `/billing/plans/:planId` | `billing.plans.read` | direct read | — |
| `GET` | `/billing/plans/:planId/subscribers` | `billing.plans.read` | direct read | — |
| `POST` | `/billing/plans` | `billing.plans.manage` | **delegated** | ✅ |
| `PATCH` | `/billing/plans/:planId` | `billing.plans.manage` | **delegated** | ✅ |
| `DELETE` | `/billing/plans/:planId` | `billing.plans.delete` | **delegated** | ✅ |
| `GET` | `/billing/subscriptions` | `billing.plans.read` | direct read | — |
| `POST` | `/billing/subscriptions/:ownerType/:ownerId` | `billing.subscriptions.assign` | **delegated** | ✅ |

**Nothing here is Support's.** The writes split three ways: `billing.plans.manage` for create and
edit, `billing.plans.delete` (`destructive`), and `billing.subscriptions.assign` (`financial` —
it changes what somebody is billed).

## Three owner types, one catalog

A plan belongs to exactly one role: **`vendor`**, **`agency`** or **`agent`**. A plan carries
only the limits its role uses, so about half the `limits` block is `null` on any given plan.

## Why the writes are delegated

Creating a plan collides against a partial unique index the platform turns into a specific code.
Editing one moves `commissionPercent`, **the multiplier every future order's split uses**.
Assigning one expires the current term, grants a credit allowance exactly once inside the same
transaction that activates it, and emits an event that resizes an agent's shipment capacity — a
second writer would move the rows and leave every agent on that plan at their old cap.

---

## `GET /billing/plans`

The catalog.

| | |
|---|---|
| **Permission** | `billing.plans.read` |
| **Pagination** | `page`, `limit` |
| **Sorting** | `sortOrder`, `price`, `name`, `createdAt`. Default **`sortOrder`** (ascending) |

The default is `sortOrder`, not `-createdAt`: `sortOrder` is the field the platform put there to
say what order these belong in, and a catalog listed newest-first shows the tiers in whatever
order somebody happened to create them.

### Query parameters

| Parameter | Type | Notes |
|---|---|---|
| `role` | `vendor` \| `agency` \| `agent` | |
| `isActive` | boolean flag | `false` is a **defined-but-not-purchasable** tier — a real state |
| `includeArchived` | boolean flag, default **`false`** | Soft-deleted plans. **They are excluded, not gone** — existing subscribers keep running on an archived tier, so "which plan is this vendor on" can name a row this list would not otherwise show |
| `search` | string, 1–120 | Matches the plan code or display name — or, for a 24-hex term, the plan id |

### Response (200)

```jsonc
{
  "success": true,
  "data": [
    {
      "id": "6690aabbccddeeff00112233",
      "role": "vendor",
      "code": "vendor_growth",
      "name": "Growth",
      "price": 25000,
      "currency": "XAF",
      "termDays": 30,
      "creditAllowance": 500,
      "limits": {
        "maxActiveProducts": 500,
        "maxStorageBytes": 5368709120,
        "commissionPercent": 8.5,
        "maxUnterminatedShipments": null,
        "liveTrackingEnabled": null
      },
      "isActive": true,
      "sortOrder": 2,
      "archivedAt": null,
      "createdAt": "2025-06-01T00:00:00.000Z",
      "updatedAt": "2026-03-14T11:00:00.000Z"
    }
  ],
  "meta": { "total": 9, "page": 1, "limit": 20, "pages": 1 }
}
```

| Field | Notes |
|---|---|
| `termDays` | **`null` = never expires** — every role's free tier |
| `limits` | Grouped rather than flattened, because at any moment about half are inapplicable to the role. Nested, that reads as "the limits block, partly inapplicable"; flattened beside `price`, it reads as a plan with half its fields missing |
| `limits.*` | **`null` means unlimited**, the platform's own meaning for these columns |
| `limits.commissionPercent` | **What every future order's split multiplies by.** The reason the plan detail endpoint exists |
| **`archivedAt`** | The wire name for the soft-delete stamp. `null` on a live plan, **always present** so a client reading `includeArchived=true` can tell the two apart without inferring it from a missing key. "Deleted" is what the column is called and not what it means — the row stays and its subscribers stay on it |

---

## `GET /billing/plans/:planId`

One plan. **Net-new** — the legacy catalog was list-only, so `commissionPercent` could only be
read by finding the row in a page.

| | |
|---|---|
| **Permission** | `billing.plans.read` |
| **Response** | A single plan object |
| **Errors** | `400 VALIDATION_ERROR`, `404 NOT_FOUND` |

---

## `GET /billing/plans/:planId/subscribers`

Who is on this plan. **Net-new, and the read that belongs immediately before an edit to its
commission.**

| | |
|---|---|
| **Permission** | `billing.plans.read` **alone** — the rows name owners the way a subscription does (id, type, display name) and carry nothing from the vendor, agency or agent record that those permissions exist to gate |
| **Pagination** | `page`, `limit` |
| **Sorting** | `createdAt`, `startedAt`, `expiresAt`, `updatedAt`. Default **`-createdAt`** |

### Query parameters

| Parameter | Type | Notes |
|---|---|---|
| `status` | string, 1–40 | The platform's vocabulary; **not pinned** — this service never writes a status |
| `ownerType` | `vendor` \| `agency` \| `agent` | |
| `from` / `to` | ISO-8601 instant | **Max span 366 days** |

### Response (200)

Subscription objects — see the shape under `GET /billing/subscriptions` below.

---

## `GET /billing/subscriptions`

The **cross-owner** queue. Net-new, and it answers two questions nothing in the platform could:

1. **Which terms are about to lapse** — `expiringBefore`.
2. **Which owners have a plan queued behind their current one** — `status=pending_activation`.
   That is the state that silently becomes active without anybody acting.

| | |
|---|---|
| **Permission** | `billing.plans.read` |
| **Pagination** | `page`, `limit` |
| **Sorting** | `createdAt`, `startedAt`, `expiresAt`, `updatedAt`. Default **`-createdAt`** |

### Query parameters

| Parameter | Type | Notes |
|---|---|---|
| `status` | string, 1–40 | |
| `ownerType` | `vendor` \| `agency` \| `agent` | |
| `ownerId` | 24-hex | |
| `planId` | 24-hex | |
| `planCode` | string, 1–40 | |
| **`expiringBefore`** | ISO-8601 instant | **The filter this endpoint exists for.** An instant rather than a day count: "the next seven days" is a different seven days in Douala than in Lisbon, and only the client knows which |
| `from` / `to` | ISO-8601 instant | Max span 366 days |

### Response (200)

```jsonc
{
  "success": true,
  "data": [
    {
      "id": "6691aabbccddeeff00112233",
      "owner": { "type": "vendor", "id": "6650aa11bb22cc33dd44ee55", "name": "Douala Fresh Market" },
      "plan": { "id": "6690aabbccddeeff00112233", "code": "vendor_growth", "name": "Growth" },
      "status": "active",
      "startedAt": "2026-07-15T00:00:00.000Z",
      "expiresAt": "2026-08-14T00:00:00.000Z",
      "assignedBy": { "id": "665f…", "source": "wi-admin", "name": "Ada Nkemelu" },
      "paymentReference": "MTN-MOMO-2026-07-15-88412",
      "allowanceGranted": true,
      "createdAt": "2026-07-15T09:02:00.000Z",
      "updatedAt": "2026-07-15T09:02:00.000Z"
    }
  ],
  "meta": { "total": 214, "page": 1, "limit": 20, "pages": 11 }
}
```

| Field | Notes |
|---|---|
| `owner.name` | The **business** name where there is one (a Store, a Magazin). `null`, never `""` |
| `plan.code` | Comes off the subscription row itself — the platform denormalises it there — **so it answers even when the plan lookup found nothing**. `plan.name` is `null` in that case, and the difference between the two is how a dangling plan reference makes itself visible |
| `expiresAt` | **`null` on the never-expiring free tier** — not "unknown" |
| `assignedBy` | **`null` when nobody assigned it**: the self-service purchase path and the lazily created free default both leave it unset. That is a different fact from an administrator whose name failed to snapshot |
| `allowanceGranted` | Whether the one-time credit allowance has been granted. Guards a double grant |

---

## `POST /billing/plans`

Create a tier.

| | |
|---|---|
| **Permission** | `billing.plans.manage` |
| **Transport** | Delegated |
| **Status** | **`201`** — the only route on this mount that genuinely creates a resource |
| **Body** | **Strict.** A mistyped field is a `400`, not a silent no-op — `commissionPercent` misspelled would be a plan that quietly prices every order at the platform default |

### Request body

| Field | Type | Rules |
|---|---|---|
| `role` | `vendor` \| `agency` \| `agent` | **Required.** The platform defaults it to `vendor`; this does not — an agency plan filed under `vendor` is invisible on the agency catalog and is only noticed when somebody tries to assign it |
| `code` | string | Required. 2–40 characters, **lower-cased at the edge**, `[a-z0-9_-]` only. Immutable after creation |
| `name` | string | Required, 2–80 characters |
| `price` | number | Required, ≥ 0 |
| `currency` | string | Optional, exactly 3 letters, upper-cased |
| `termDays` | integer \| null | **Required.** `null` = never expires |
| `creditAllowance` | integer | Required, ≥ 0 |
| `maxActiveProducts` | integer \| null | Optional. `null` = unlimited |
| `maxStorageBytes` | integer \| null | Optional. `null` = unlimited |
| `commissionPercent` | number \| null | Optional, 0–100. Vendor plans in practice |
| `maxUnterminatedShipments` | integer \| null | Optional. `null` = unlimited |
| `liveTrackingEnabled` | boolean | Optional |
| `isActive` | boolean | Optional |
| `sortOrder` | integer | Optional |

> **`null` and *absent* are not the same thing.** `null` sets "unlimited"; omitting the key
> leaves the stored value alone on a `PATCH`. Collapsing them would make "remove this cap"
> unexpressible.

```json
{
  "role": "agency",
  "code": "agency_standard",
  "name": "Standard",
  "price": 40000,
  "currency": "XAF",
  "termDays": 30,
  "creditAllowance": 0,
  "maxUnterminatedShipments": 200,
  "liveTrackingEnabled": true,
  "isActive": true,
  "sortOrder": 2
}
```

### Response (201)

The created plan, message `"Plan agency_standard created"`.

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Missing `role`/`termDays`, a bad code, an unknown field |
| 409 | `PLATFORM_OPERATION_REJECTED` | Duplicate code. `details.platformCode: "BILLING_PLAN_CODE_EXISTS"` |
| 502 / 503 | `SERVICE_DEPENDENCY_UNAVAILABLE` | |

### Audit

`billing.plans.create`

---

## `PATCH /billing/plans/:planId`

Edit a tier.

| | |
|---|---|
| **Permission** | `billing.plans.manage` |
| **Body** | **Strict**, and at least one field is required |

### Request body

Every field of `POST /billing/plans` **except `role` and `code`** — both are immutable, and
sending either is a **`400`**, not a silent discard. An operator who sent `code` believes they
renamed the plan; a `200` that quietly dropped it is how they find out months later.

```json
{ "commissionPercent": 7.5, "isActive": false }
```

### Response (200)

The updated plan, message `"Plan updated"`.

> Changing `commissionPercent` affects **future** order splits. It does not retroactively
> re-price anything.

### Audit

`billing.plans.update`

---

## `DELETE /billing/plans/:planId`

**A soft delete.** The row stays, `archivedAt` is stamped, and every owner already on the tier
keeps running on it until their term ends.

| | |
|---|---|
| **Permission** | `billing.plans.delete` — flagged `destructive` |
| **Transport** | Delegated |
| **Request body** | None |

### Response (200)

```json
{
  "success": true,
  "data": null,
  "message": "Plan vendor_growth archived — existing subscribers keep it until their term ends"
}
```

`data` is `null` — the platform answers no body. Read the row afterwards with
`?includeArchived=true`.

### Audit

`billing.plans.delete`

---

## `POST /billing/subscriptions/:ownerType/:ownerId`

Assign a plan to a vendor, agency or agent. **One route where the platform keeps three.**

| | |
|---|---|
| **Permission** | `billing.subscriptions.assign` — flagged `financial` |
| **Transport** | Delegated |
| **Body** | **Strict** |

`:ownerType` is a **path segment rather than a body field** because it selects both which
platform path is called and **which of three audit actions the row carries** — and which action
is recorded is not something a request body should pick.

### Path parameters

| Parameter | Type | Rules |
|---|---|---|
| `ownerType` | `vendor` \| `agency` \| `agent` | Required |
| `ownerId` | 24-hex | Required |

### Request body

| Field | Type | Rules |
|---|---|---|
| `planId` | 24-hex | Required |
| `paymentReference` | string, 1–200 | Optional — this endpoint exists for payment confirmed out of band, which sometimes has a reference and sometimes is a bank transfer somebody eyeballed |

```json
{ "planId": "6690aabbccddeeff00112233", "paymentReference": "MTN-MOMO-2026-08-13-91204" }
```

### What this does

Expires the current term, grants the credit allowance **exactly once** inside the same
transaction that activates the new one, and emits the event that resizes an agent's shipment
capacity.

### Response (200)

The created subscription, message `"Plan vendor_growth assigned to the vendor"`.

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Bad `ownerType`, malformed id, unknown field |
| 404 | `NOT_FOUND` | No such plan or owner |
| 409 | `PLATFORM_OPERATION_REJECTED` | `details.platformCode: "BILLING_PLAN_INACTIVE"` — the plan is not purchasable |
| 409 | `PLATFORM_OPERATION_REJECTED` | `details.platformCode: "BILLING_PLAN_ROLE_MISMATCH"` — **the plan's role does not match the owner** |
| 502 / 503 | `SERVICE_DEPENDENCY_UNAVAILABLE` | |

Neither of those two rules is pre-checked here: they are the platform's verdicts to make, and a
copy would be a second opinion about what a plan may be assigned to.

### Audit

One of `billing.subscriptions.assign_vendor`, `billing.subscriptions.assign_agency`,
`billing.subscriptions.assign_agent` — chosen by `:ownerType`, so the row is visible on that
owner's activity feed.
