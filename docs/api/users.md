# `/users` — platform user management

Base path: `/api/v1/users`

The account behind every role. A `users` row is the sign-in identity; a vendor, agency, agent
or customer *profile* hangs off it.

Design record: [`../ADR-007-USER-MANAGEMENT.md`](../ADR-007-USER-MANAGEMENT.md).

| Method | Path | Permission | Transport | Audited |
|---|---|---|---|---|
| `GET` | `/users` | `users.read` | direct read | — |
| `GET` | `/users/:userId` | `users.read` | direct read | — |
| `GET` | `/users/:userId/activity` | `users.read` **+** `audit.read` | direct read | — |
| `PATCH` | `/users/:userId` | `users.update` | **delegated** | ✅ |
| `POST` | `/users/:userId/suspend` | `users.suspend` | **delegated** | ✅ |
| `POST` | `/users/:userId/restore` | `users.suspend` | **delegated** | ✅ |

Reads go straight to the platform database; every write is executed by jovi-mall. A suspension
is only meaningful because jovi-mall's auth path refuses a non-active account, and a login
identifier is only safe because that service owns its uniqueness index and its format rule.

`users.read` is a Support-level lookup. The two writes are **Admin and above**.

## What this surface deliberately does not offer

| Missing | Why |
|---|---|
| **Role changes** (`users.roles.manage` exists with no route) | Adding a role provisions a role entity (a Store, a Magazin); removing one strands every record that entity owns. There is no code path in jovi-mall that removes a role, and inventing the semantics from the admin side is how a vendor's products end up belonging to nobody |
| **Forced sign-out** (`users.sessions.revoke`) | jovi-mall issues stateless JWTs with no session store — there is nothing to revoke. Suspension covers the need: it blocks the next request on every device |
| **Password reset** (`users.password.reset`) | jovi-mall has no administrator-initiated password flow |

---

## `GET /users`

Search and filter across every role.

| | |
|---|---|
| **Permission** | `users.read` |
| **Pagination** | `page`, `limit` |
| **Sorting** | `createdAt`, `updatedAt`, `email`. Default **`-createdAt`** |

Every sortable field is index-backed. A field with no index would be a collection scan a client
could request by query string.

### Query parameters

| Parameter | Type | Notes |
|---|---|---|
| `search` | string, 1–120 | Matches **email**, **phone**, or — when the term is itself a 24-hex id — the **user id**. That last branch is what makes a support conversation work: an id copied out of an order, a ticket or an audit row finds the person |
| `role` | `vendor` \| `agency` \| `agent` \| `customer` | **`admin` is deliberately absent** — no `users` row can hold that role, so offering it would advertise a search that can only return nothing |
| `status` | `active` \| `suspended` | |
| `from` / `to` | ISO-8601 instant | Creation range, half-open `[from, to)`. **Maximum span 366 days** |
| `page`, `limit`, `sort` | | |

### Example

```
GET /api/v1/users?role=agent&status=active&search=+237670112233&sort=-createdAt&limit=25
```

### Response (200)

```jsonc
{
  "success": true,
  "data": [
    {
      "id": "665f1c2a9b3e4a91c7d2e5f0",
      "email": "amina@example.cm",
      "phone": "+237670112233",
      "roles": ["customer", "agent"],
      "status": "active",
      "suspension": null,
      "createdAt": "2026-02-14T10:05:31.220Z",
      "updatedAt": "2026-08-01T08:12:44.907Z"
    }
  ],
  "meta": { "total": 8412, "page": 1, "limit": 25, "pages": 337 }
}
```

| Field | Type | Notes |
|---|---|---|
| `email`, `phone` | string \| null | The **login identifiers**. Either may be absent |
| `roles` | string[] | Every role the account holds |
| `status` | `active` \| `suspended` | |
| `suspension` | object \| null | **Present only while suspended.** An active account carrying a stale reason would read as suspended on any screen that renders the block without checking `status` first |
| `suspension.by` | `{ id, source, name }` | `source` distinguishes a platform actor from an administrator |

---

## `GET /users/:userId`

The account plus one entry per role it holds.

| | |
|---|---|
| **Permission** | `users.read` |
| **Path parameter** | `userId` — 24-hex |

### Response (200)

Every list field, plus `profiles`:

```jsonc
{
  "success": true,
  "data": {
    "id": "665f1c2a9b3e4a91c7d2e5f0",
    "email": "amina@example.cm",
    "phone": "+237670112233",
    "roles": ["customer", "agent"],
    "status": "active",
    "suspension": null,
    "createdAt": "2026-02-14T10:05:31.220Z",
    "updatedAt": "2026-08-01T08:12:44.907Z",
    "profiles": [
      {
        "role": "customer",
        "id": "665f1c2a9b3e4a91c7d2e5f1",
        "name": "Amina B.",
        "status": "active",
        "verified": null,
        "kycStatus": null,
        "createdAt": "2026-02-14T10:05:31.400Z"
      },
      {
        "role": "agent",
        "id": null, "name": null, "status": null,
        "verified": null, "kycStatus": null, "createdAt": null,
        "missing": true
      }
    ]
  }
}
```

#### The `profiles` array

One entry per role, in `roles` order.

| Field | Type | Notes |
|---|---|---|
| `role` | `vendor` \| `agency` \| `agent` \| `customer` | |
| `name` | string \| null | The display name on that role, when the role carries one |
| `verified` | boolean \| null | Business verification — **vendor and agency only**; `null` where the role has none |
| `kycStatus` | string \| null | Identity verification — **agent only** |
| `missing` | `true` | **Present only on a broken entry.** The role is on the `users` row but its entity does not exist — **this stops the person signing in**, and would otherwise be invisible |

Render `missing: true` prominently. It is a real, recoverable-only-by-hand fault.

### Errors

| Status | Code |
|---|---|
| 400 | `VALIDATION_ERROR` — "Not a valid user id" |
| 404 | `NOT_FOUND` — "User not found" |

---

## `GET /users/:userId/activity`

What **administrators have done to** this account: every suspension, reinstatement and
identifier change, who made it, from where, and whether it succeeded.

**This is not the person's own platform activity.** Their orders, shipments and tickets live in
other domains behind other permissions; assembling them here would let `users.read` alone reach
data those permissions exist to gate.

| | |
|---|---|
| **Permission** | `users.read` **+** `audit.read` (both required) |
| **Pagination** | `page`, `limit` |
| **Sorting** | `occurredAt` only. Default **`-occurredAt`** |

Requiring both is not a cost — every level holding either holds both. It states the dependency
so a future grant change cannot quietly open a side door onto the audit trail.

### Query parameters

A deliberate subset of the audit query: no `targetType`/`targetId` (the path fixes both), no
`actorId` (an account's history is not filtered by who acted), no `search`.

| Parameter | Type | Notes |
|---|---|---|
| `action` | enum | Only `users.*` actions — **derived from the audit catalog**, so it widens automatically when a new one is added |
| `status` | `attempted` \| `succeeded` \| `failed` \| `denied` \| `queued` | |
| `from` / `to` | ISO-8601 instant | Max span 366 days |
| `page`, `limit`, `sort` | | |

### Response (200)

A paginated array of audit entries — identical shape to `GET /audit`. See
[audit.md](audit.md#get-audit).

The audit read scope applies on top of the path filter. `user` rows are `platform_actor`, which
every level may read, so a Support administrator sees this feed deliberately.

### Errors

| Status | Code | When |
|---|---|---|
| 404 | `NOT_FOUND` | No such user — checked **first**, so a feed for a nonexistent user says so rather than answering an empty page that looks like "nothing ever happened" |

---

## `PATCH /users/:userId`

Change the login identifiers. **The only user fields an administrator may edit.**

| | |
|---|---|
| **Permission** | `users.update` |
| **Transport** | Delegated to jovi-mall |
| **Body** | **Strict** — unknown fields are a `400`, not silently ignored |

### Request body

At least one of `email` or `phone` is required.

| Field | Type | Rules |
|---|---|---|
| `email` | string \| null | Trimmed, 3–254 characters. **Clearable** — `""` or `null` removes it |
| `phone` | string \| null | Trimmed, 4–24 characters. **Clearable** |

**Format is not validated here, deliberately.** jovi-mall owns the login identifiers and holds
one definition of what each may be (RFC 5322 for email, strict E.164 for phone). A copy of
those rules here would be a second definition of a rule this service does not own, and the
failure mode of drift is silent — an address accepted at this door that every later edit by its
owner would refuse.

So this schema validates **shape**; jovi-mall validates **format** and returns its own `400`
with `details.platformCode`.

```json
{ "email": "amina.b@example.cm", "phone": null }
```

### Response (200)

```jsonc
{
  "success": true,
  "data": {
    "id": "665f1c2a9b3e4a91c7d2e5f0",
    "email": "amina.b@example.cm",
    "phone": null,
    "roles": ["customer", "agent"],
    "status": "active",
    "suspendedAt": null,
    "suspendedReason": null,
    "suspendedBy": null,
    "createdAt": "2026-02-14T10:05:31.220Z",
    "updatedAt": "2026-08-13T09:31:02.118Z"
  },
  "message": "Login details updated"
}
```

> Note the write response is jovi-mall's own user DTO — flat `suspendedAt` / `suspendedReason` /
> `suspendedBy` fields, rather than the nested `suspension` object the **read** endpoints
> return. They carry the same facts.

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Empty body ("Nothing to update — send `email`, `phone`, or both"), an unknown field, or out-of-bounds length |
| 400 | `PLATFORM_OPERATION_REJECTED` | jovi-mall refused the **format**. `details.platformCode` names its code |
| 404 | `NOT_FOUND` | No such user |
| 409 | `PLATFORM_OPERATION_REJECTED` | The identifier is already in use. `details.platformCode` names the collision |
| 502 / 503 | `SERVICE_DEPENDENCY_UNAVAILABLE` | jovi-mall unreachable |

### Audit

`users.update`, with a `before`/`after` diff over `{ email, phone, status, suspendedReason }`.

---

## `POST /users/:userId/suspend`

Block sign-in on every device.

**Takes effect on the suspended person's next request, not at their next login** — jovi-mall
re-reads the account on every authenticated request and refuses a non-active one, and its
refresh rotation refuses too. A live session cannot outlive this call.

| | |
|---|---|
| **Permission** | `users.suspend` |
| **Transport** | Delegated |

### Request body

| Field | Type | Rules |
|---|---|---|
| `reason` | string | **Required.** 3–500 characters, trimmed |

```json
{ "reason": "Fraudulent chargebacks on orders ORD-2026-8841 and ORD-2026-8902" }
```

### Response (200)

jovi-mall's user DTO, `status: "suspended"`, with the message
`"Account suspended — every device is signed out"`.

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Missing or too-short reason |
| 404 | `NOT_FOUND` | |
| 409 | `PLATFORM_OPERATION_REJECTED` | Already suspended — a compare-and-set, so the loser of two concurrent screens is told the state moved rather than overwriting the winner's reason |
| 502 / 503 | `SERVICE_DEPENDENCY_UNAVAILABLE` | |

### Audit

`users.suspend`

---

## `POST /users/:userId/restore`

Lift a suspension.

| | |
|---|---|
| **Permission** | `users.suspend` (the same one — the permission governs both directions; the *audit actions* differ) |
| **Request body** | None |
| **Response** | jovi-mall's user DTO, `status: "active"`, message `"Account restored"` |

### Errors

Same as suspend, minus the validation error. `409` when the account is not suspended.

### Audit

`users.reinstate`

---

## Why suspend/restore are POST sub-resources, not `PATCH { status }`

The permission and the audit row attach to the **action**. `users.suspend` governs both
directions, but they are separate audit actions — `users.suspend` and `users.reinstate` — and a
status field on a PATCH body could not carry the required reason on one direction and forbid it
on the other. The same pattern holds across vendors, agencies and agents.
