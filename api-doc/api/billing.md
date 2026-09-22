# `/billing` — pricing plans and subscriptions

**Verified against source on 2026-09-08** — all ten routes and their guards against the live route manifest; every query parameter, sort allowlist, plan-code rule, `null`-versus-absent limit rule and the 366-day span against `billing/validators/billing.validator.ts`; the `201`, the four response messages and the two distinct `404` codes against `billing/controllers/billing.controller.ts:93,200,426,447,471,516`.

Base path: `/api/v1/billing`

The subscription catalog, and who is on it.

Design record: [`../../docs/ADR-011-ACCOUNTS-AND-FINANCE.md`](../../docs/ADR-011-ACCOUNTS-AND-FINANCE.md).

| Method | Path | Permission | Transport | Audited |
|---|---|---|---|---|
| `GET` | `/billing/plans` | `billing.plans.read` | direct read | — |
| `GET` | `/billing/plans/:planId` | `billing.plans.read` | direct read | — |
| `GET` | `/billing/plans/:planId/subscribers` | `billing.plans.read` | direct read | — |
| `POST` | `/billing/plans` | `billing.plans.manage` | **delegated** | ✅ |
| `PATCH` | `/billing/plans/:planId` | `billing.plans.manage` | **delegated** | ✅ |
| `DELETE` | `/billing/plans/:planId` | `billing.plans.delete` | **delegated** | ✅ |
| `GET` | `/billing/subscriptions` | `billing.plans.read` | direct read | — |
| `GET` | `/billing/subscriptions/:subscriptionId` | `billing.plans.read` | direct read | — |
| `GET` | `/billing/subscriptions/:ownerType/:ownerId` | `billing.plans.read` | direct read | — |
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
        "maxCodPool": null,
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
| `maxCodPool` | integer \| null | Optional. **Agent plans** (2026-09-21): the COD pool a KYC-verified agent on this tier may carry, in XAF. ⚠ **`null` = NO COD**, not unlimited, the one limit that fails closed. Values above 5 000 000 are clamped by jovi-mall. Editing it on an existing plan **re-syncs every agent immediately**; no reassignment needed |
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
| 404 | **`ACCOUNT_OWNER_NOT_FOUND`** | No such vendor, agency or agent. `details` names the `ownerType` and `ownerId` |
| 404 | **`NOT_FOUND`** | No such plan (message: *"Pricing plan not found"*). **A different code from the owner miss** — check which one you got before telling the operator what to fix |
| 409 | `PLATFORM_OPERATION_REJECTED` | `details.platformCode: "BILLING_PLAN_INACTIVE"` — the plan is not purchasable |
| 409 | `PLATFORM_OPERATION_REJECTED` | `details.platformCode: "BILLING_PLAN_ROLE_MISMATCH"` — **the plan's role does not match the owner** |
| 409 | `PLATFORM_OPERATION_REJECTED` | `details.platformCode: "BILLING_PENDING_PLAN_EXISTS"` — **the owner already has a plan queued behind their current one.** Reachable on a completely ordinary path: assigning to an owner whose paid term has not lapsed produces a *queued* row rather than replacing the live one, so a second attempt hits this. Pre-empt it by checking `queued` on the owner-scoped read below |
| 502 / 503 | `SERVICE_DEPENDENCY_UNAVAILABLE` | |

None of those rules is pre-checked here: they are the platform's verdicts to make, and a
copy would be a second opinion about what a plan may be assigned to.

### Audit

One of `billing.subscriptions.assign_vendor`, `billing.subscriptions.assign_agency`,
`billing.subscriptions.assign_agent` — chosen by `:ownerType`, so the row is visible on that
owner's activity feed.

---

## The subscription status vocabulary

`status` is the platform's to write and this service never writes one, so it stays an **open**
list on the wire — an unrecognised value must be rendered, never dropped.

The four members jovi-mall's model carries today, written down so every client stops guessing
differently:

| Status | Meaning |
|---|---|
| `active` | The live term. **At most one per owner** — a partial unique index upstream enforces it |
| `pending_activation` | Queued behind the live one. **At most one per owner**, same mechanism. This is the state that silently becomes active without anybody acting |
| `expired` | The term lapsed |
| `cancelled` | It was ended before it lapsed |

**Known members, open for a fifth.** Rank an unrecognised value as history and keep it on
screen.

---

## `GET /billing/subscriptions/:ownerType/:ownerId`

Every term one owner holds, partitioned by the platform's own determination of which is live.

| | |
|---|---|
| **Permission** | `billing.plans.read` |
| **Transport** | Direct read |
| **Pagination** | **None** |

### Why this exists beside `GET /billing/subscriptions?ownerId=`

An owner holds several rows at once: one `active`, optionally one `pending_activation`, plus
the history. The cross-owner list can be filtered to them, but it is **server-paginated** — so
an owner's rows can straddle a page boundary, and a client grouping them groups *some* of their
terms with no way to know that it did.

And deciding which row is live is not a judgement a client should be making. `status` is an open
vocabulary this service never writes, so a client ranking it guesses, and its guess changes
silently when a fifth value appears upstream. Here the answer comes from the row that says
`active`.

Unpaginated on purpose: an owner accumulates one term per renewal — single digits over a
platform's lifetime — so paging would add a cursor to answer a question that fits in one
response, and would reintroduce the straddling problem it exists to remove.

### Response `200`

```jsonc
{
  "success": true,
  "data": {
    "owner":   { "type": "vendor", "id": "665a…", "name": "Douala Fresh Market" },
    "current": { /* subscription */ },
    "queued":  { /* subscription */ },
    "history": [ /* subscriptions, newest first */ ]
  },
  "meta": { "total": 7 }
}
```

| Field | Notes |
|---|---|
| `current` | The row whose `status` is `active`. **`null` means the owner has no active plan** — not "we could not determine it". The same fact `GET /accounts/:ownerType/:ownerId` reports by setting the subscription block's fields to `null` together |
| `queued` | The `pending_activation` row, or `null`. **Check this before assigning** — a non-null value means the assign route will answer `BILLING_PENDING_PLAN_EXISTS` |
| `history` | Everything else, newest first by `createdAt`. A row with an **unrecognised** status lands here rather than being dropped |
| `meta.total` | The count of all rows, not a page size |

Ordered by `createdAt` rather than `startedAt`, because `startedAt` is `null` on a queued row —
sorting on it would put the thing that has not started yet among the oldest. `expiresAt` is not
consulted at all: `null` there is the never-expiring free tier rather than "unknown".

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Bad `ownerType` or malformed id |
| 404 | `ACCOUNT_OWNER_NOT_FOUND` | No such vendor, agency or agent. **An owner who has never had a plan is not this** — that answers `current: null` with an empty `history` |

---

## `GET /billing/subscriptions/:subscriptionId`

One term, by its own id — so an operator can link a colleague to one, and a `paymentReference`
quoted in a support ticket has somewhere to point.

| | |
|---|---|
| **Permission** | `billing.plans.read` |
| **Transport** | Direct read |

Returns the same subscription shape the lists return.

No collision with the owner-scoped read above: that one takes two path segments and this takes
one, so Express separates them structurally rather than by declaration order.

### Errors

| Status | Code |
|---|---|
| 400 | `VALIDATION_ERROR` |
| 404 | `NOT_FOUND` |
