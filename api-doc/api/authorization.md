# `/permissions` and `/approvals` — the policy and the four-eyes queue

**Verified against source on 2026-09-08** — all eight routes and their guards against the live route manifest; the permission and tier totals re-derived by running the catalog and grant table (118 · 118 / 101 / 31, not 116 · 116 / 99 / 30); the `Approval` shape against `dual-control/domain/approval.service.ts:36-73`; the four queueing conditions against the three `DualControlSpec`s in `authorization/domain/permission.catalog.ts:44-113`; and every error code against its throw site.

Two small route groups that together let a dashboard render itself correctly: what the caller
may do, and what is waiting for a second signature.

| Method | Path | Permission | Audited |
|---|---|---|---|
| `GET` | `/permissions/catalog` | *self* | — |
| `GET` | `/permissions/me` | *self* | — |
| `GET` | `/permissions/tiers` | `permissions.read` | — |
| `GET` | `/approvals` | `approvals.read` | — |
| `GET` | `/approvals/:approvalId` | `approvals.read` | — |
| `POST` | `/approvals/:approvalId/approve` | *dynamic — see below* | ✅ |
| `POST` | `/approvals/:approvalId/reject` | *dynamic — see below* | ✅ |
| `DELETE` | `/approvals/:approvalId` | *self, scoped to own requests* | ✅ |

The full policy — every permission, every flag, the level matrix — is in
[permissions.md](permissions.md). This page documents the endpoints that serve it.

---

# `/permissions`

Base path: `/api/v1/permissions`

None of this is secret. The catalog and the matrix describe **policy, not data**: knowing that
`cod.remittances.confirm` exists and that Admins hold it tells an attacker nothing they could
not learn by trying, and it is the difference between a usable dashboard and a guessing game.

---

## `GET /permissions/catalog`

Every permission that exists, with its metadata.

| | |
|---|---|
| **Method / Path** | `GET /api/v1/permissions/catalog` |
| **Authentication** | Required |
| **Permission** | None — the vocabulary is what a dashboard is written against |
| **Parameters** | None |
| **Pagination / sorting / filters** | None. The catalog is static and complete |

### Response (200)

```jsonc
{
  "success": true,
  "data": {
    "families": [
      { "family": "agents",   "permissions": ["agents.read", "agents.status.set", "…"] },
      { "family": "agencies", "permissions": ["agencies.read", "…"] }
    ],
    "permissions": [
      {
        "name": "agents.cod_threshold.set",
        "family": "agents",
        "action": "write",
        "summary": "Set how much cash on delivery an agent may hold before remitting",
        "financial": true,
        "escalation": false,
        "destructive": false,
        "dualControl": false,
        "scoped": false,
        "phase": 5
      }
    ],
    "total": 118
  }
}
```

| Field | Type | Notes |
|---|---|---|
| `families[]` | array | The 21 families in declaration order, each listing its permission names |
| `permissions[]` | array | All 124 permissions |
| `permissions[].action` | `"read"` \| `"write"` \| `"approve"` | |
| `permissions[].summary` | string | Written for an administrator, not an engineer — safe to render in a UI |
| `permissions[].financial` etc. | boolean | The four sensitivity flags. **The dual-control *predicate* is never exposed** — only whether one exists |
| `permissions[].scoped` | boolean | Whether reads behind it are additionally narrowed row-by-row |
| `permissions[].phase` | number | The build phase. Includes permissions whose endpoints are **not built yet**, so the dashboard can be written against the finished vocabulary rather than a moving one |

4 of the 124 have no endpoint yet — see the `†` markers in [permissions.md](permissions.md).

---

## `GET /permissions/me`

The caller's own effective permission set. **This is what a dashboard builds its navigation
from.**

| | |
|---|---|
| **Method / Path** | `GET /api/v1/permissions/me` |
| **Authentication** | Required |
| **Permission** | None — an administrator who cannot discover what they may do cannot use the service |
| **Parameters** | None |

### Response (200)

```jsonc
{
  "success": true,
  "data": {
    "adminId": "665f1c2a9b3e4a91c7d2e5f0",
    "tier": 2,
    "tierLabel": "Admin",
    "permissions": [
      "agencies.read", "agents.read", "audit.read", "billing.plans.read",
      "cod.overview.read", "money.earnings.read", "orders.read", "users.read", "…"
    ]
  }
}
```

`permissions` is the resolved set for the caller's **current** level, **sorted alphabetically** —
re-read on every request, so it reflects a demotion immediately.

Call this after login and again after any `/auth/refresh` that follows a level change.

---

## `GET /permissions/tiers`

The full level → permission matrix. For the administrator-management screen: what changes when
you move someone from Support to Admin.

| | |
|---|---|
| **Method / Path** | `GET /api/v1/permissions/tiers` |
| **Permission** | `permissions.read` — Developer and Admin. Support does not hold it, not because it is sensitive but because Support has no screen that renders it |
| **Parameters** | None |

### Response (200)

```jsonc
{
  "success": true,
  "data": {
    "tiers": [
      { "tier": 1, "label": "Developer", "permissions": ["administrators.create", "…"], "total": 124 },
      { "tier": 2, "label": "Admin",     "permissions": ["agencies.read", "…"],          "total": 104 },
      { "tier": 3, "label": "Support",   "permissions": ["agencies.read", "…"],          "total": 38  }
    ]
  }
}
```

`permissions` is sorted alphabetically within each level. **These three totals move**: they were
116 / 99 / 30 three rounds ago, 118 / 101 / 31, then 121 / 101 / 31, and are **124 / 104 / 38**
today. Read them from this response, never from a constant — and if you need the numbers for
prose, derive them with `npm run authz:matrix`.

⚠ **The tier-3 total jumped by seven since 31, and only three of those are new permissions.**
`users.bot_memory.reset`, `cod.triage` and `money.payouts.triage` were genuinely added. The other
four — `cod.overview.read`, `cod.remittances.read`, `cod.deposits.read` and `money.payouts.read` —
were **already granted in code** and merely mis-documented until 2026-09-22. A dashboard that
hard-coded the old matrix was under-reporting what Support could reach, which is the argument for
reading this response instead.

---

# `/approvals`

Base path: `/api/v1/approvals`

Actions one administrator requested and a **different** one must commit.

## How a request gets here

Three endpoints queue instead of executing when their condition holds. They answer **`202`**
with the approval object; nothing has happened yet.

| Origin endpoint | Queued when | `action` | Approver must hold |
|---|---|---|---|
| `PUT /administrators/:adminId/tier` | requested tier is 1 | `administrators.tier.set` | `administrators.tier.set` |
| `POST /administrators/:adminId/suspend` | target is a Developer | `administrators.suspend` | `administrators.suspend` |
| `POST /administrators/:adminId/reinstate` | target is a Developer | `administrators.suspend` | `administrators.suspend` |
| `POST /money/payouts/:payoutId/mark-paid` | amount ≥ 2 000 000 XAF | `money.payouts.mark_paid` | `money.payouts.mark_paid` |
| `POST /money/payouts/:payoutId/send` | amount ≥ 2 000 000 XAF | `money.payouts.mark_paid` | `money.payouts.mark_paid` |

⚠ **The last two rows are the same action in two modes, not two actions.** Both assert that
money left the platform — one by instructing the gateway, one by recording that a human already
did — so they share a permission and therefore one threshold. The queued approval carries a
`mode` (`gateway` or `manual`) and it participates in the idempotency key, so **an approval for
one can never be spent on the other**: an administrator who agreed to record an out-of-band
payment has not thereby authorised a live transfer.

⚠ Neither `money.payouts.triage` nor `cod.triage` is dual-controlled at any amount. Nothing
moves on either, so there is nothing for a quorum to protect.

**There is no `approvals.approve` permission, deliberately.** The approver must hold the
permission the *pending action* names, checked per request. A single "may approve things"
permission would let someone commit an action they could not have performed themselves, which
turns four eyes from a second signature into an escalation path.

## The `Approval` object

| Field | Type | Notes |
|---|---|---|
| `id` | string | 24-hex |
| `action` | string | The permission name of the queued action |
| `description` | string | One line, written for the approver: *"Mark payout request 66a1… PAID — XAF 3,400,000 to agency 665c…"* |
| `status` | `"pending"` \| `"approved"` \| `"rejected"` \| `"expired"` \| `"withdrawn"` | |
| `requestedBy` | string | Administrator id |
| `requestedByTier` | `1` \| `2` \| `3` | |
| `requestedByTierLabel` | string | |
| `targetType` | string | e.g. `"administrator"`, `"payout_request"` |
| `targetId` | string | Whatever the queued action operates on — **not necessarily a Mongo id** |
| `payload` | object | The validated payload the action will be performed with |
| `approverId` | string \| null | Null while pending |
| `decidedAt` | ISO-8601 \| null | |
| `decisionNote` | string \| null | |
| `failureReason` | string \| null | Set when the approved action was attempted and **refused** — e.g. the payout was resolved while the request sat in the queue |
| `expiresAt` | ISO-8601 | `createdAt` + `ADMIN_APPROVAL_TTL_S` (default 24 h) |
| `createdAt` | ISO-8601 | |

**Idempotency:** an identical request (same action, target and canonical payload) returns the
existing pending row rather than queueing a second one. A double-clicked dashboard button
produces one approval, not two.

---

## `GET /approvals`

The queue.

| | |
|---|---|
| **Permission** | `approvals.read` (Developer, Admin) |
| **Pagination** | `page`, `limit` |
| **Sorting** | None offered — newest first |

### Query parameters

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `status` | `pending` \| `approved` \| `rejected` \| `expired` \| `withdrawn` | **`pending`** | Defaults to the pending queue — "what is waiting" is the overwhelmingly common read, which keeps the dashboard's polling call trivial |
| `action` | string | — | Filter to one queued action, e.g. `money.payouts.mark_paid` |
| `targetId` | string | — | Free-form; not validated as an ObjectId |
| `page` | integer | 1 | |
| `limit` | integer | 20 | Max 100 |

### Response (200)

```jsonc
{
  "success": true,
  "data": [ { "id": "…", "action": "money.payouts.mark_paid", "status": "pending", "…": "…" } ],
  "meta": { "total": 2, "page": 1, "limit": 20, "pages": 1 }
}
```

---

## `GET /approvals/:approvalId`

One approval request.

| | |
|---|---|
| **Permission** | `approvals.read` |
| **Path parameter** | `approvalId` — 24-hex |
| **Response** | A single `Approval` |
| **Errors** | `400 VALIDATION_ERROR`, `404 AUTHZ_APPROVAL_NOT_FOUND` |

---

## `POST /approvals/:approvalId/approve`

**Approving performs the action.** A `200` here means the promotion happened, the payout was
marked paid — not that it was scheduled.

| | |
|---|---|
| **Method / Path** | `POST /api/v1/approvals/:approvalId/approve` |
| **Authentication** | Required |
| **Permission** | **Dynamic** — the caller must hold the permission named by the pending action's `dualControl.approverPermission`, checked at request time |
| **CSRF** | Required for cookie clients |

### Request body

| Field | Type | Rules |
|---|---|---|
| `note` | string | Optional. 1–500 characters, trimmed. **This is the field a later audit review actually reads — an approval with no note is a signature with no reason** |

```json
{ "note": "Verified the bank instruction with Finance on a call, 13/08 10:02" }
```

### Response (200)

```jsonc
{
  "success": true,
  "data": {
    "id": "66a0f31c8b2d4e5f60718293",
    "action": "money.payouts.mark_paid",
    "status": "approved",
    "approverId": "6650aabbccddeeff00112233",
    "decidedAt": "2026-08-13T10:04:11.220Z",
    "decisionNote": "Verified the bank instruction with Finance on a call, 13/08 10:02",
    "failureReason": null,
    "…": "…"
  },
  "message": "Approved and performed"
}
```

### The precondition is re-checked

An approval may sit for up to 24 hours. The queued action's precondition is evaluated **again**
at approval time, so a payout that was resolved in the meantime is refused rather than paid
twice — `409 PAYOUT_NOT_PENDING`.

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Note too long |
| 403 | `AUTHZ_APPROVAL_SELF_APPROVAL` | **You are the requester.** That is the entire point |
| 403 | `AUTHZ_PERMISSION_DENIED` | You do not hold the permission the pending action names |
| 404 | `AUTHZ_APPROVAL_NOT_FOUND` | |
| 409 | `AUTHZ_APPROVAL_ALREADY_RESOLVED` | Already approved, rejected or withdrawn |
| 409 | `PAYOUT_NOT_PENDING` | The re-check failed |
| 409 | `AUTHZ_APPROVAL_EXPIRED` | Past `expiresAt` |

### Audit

**Dynamic.** Two rows: `approvals.approved` for the decision, plus a row naming whatever action
was actually performed. The approval endpoint cannot know in advance which.

---

## `POST /approvals/:approvalId/reject`

Refuse a queued action. **Rejecting is never itself queued** — that direction is reversible,
and a quorum belongs on the irreversible one.

| | |
|---|---|
| **Permission** | **Dynamic** — the caller must hold the pending action's permission, **or** be its requester |
| **Request body** | `{ "note": "…" }` — optional, 1–500 characters |

### Response (200)

The `Approval`, now `status: "rejected"` with `approverId`, `decidedAt` and `decisionNote` set,
and the message `"Rejected"`.

### Errors

| Status | Code |
|---|---|
| 400 | `VALIDATION_ERROR` |
| 403 | `AUTHZ_PERMISSION_DENIED` |
| 404 | `AUTHZ_APPROVAL_NOT_FOUND` |
| 409 | `AUTHZ_APPROVAL_ALREADY_RESOLVED` |
| 409 | `AUTHZ_APPROVAL_EXPIRED` |

### Audit

`approvals.rejected`

---

## `DELETE /approvals/:approvalId`

The requester takes their own request back.

| | |
|---|---|
| **Permission** | *self* — scoped to the caller's **own** requests. Withdrawing someone else's is not possible |
| **Request body** | None |

### Response (200)

The `Approval`, now `status: "withdrawn"`, with the message `"Withdrawn"`.

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | `approvalId` is not 24-hex |
| 403 | `AUTHZ_PERMISSION_DENIED` | Not your request |
| 404 | `AUTHZ_APPROVAL_NOT_FOUND` | |
| 409 | `AUTHZ_APPROVAL_ALREADY_RESOLVED` | Already decided |
| 409 | `AUTHZ_APPROVAL_EXPIRED` | |

### Audit

`approvals.withdrawn`

---

## Client flow

```
1. Write endpoint answers 202 with an Approval
        → show "Waiting for a second administrator", not an error
        → keep data.id

2. Poll GET /approvals?status=pending (or the specific id)
        → a second administrator sees it in their queue

3. That administrator POSTs /approve or /reject
        → approve performs the action immediately

4. Requester's view refreshes:
        status: "approved"  → done. Reload the underlying record
        status: "rejected"  → read decisionNote
        status: "expired"   → 24 h elapsed. Re-submit if still wanted
        failureReason != null → approved, but the action was refused on re-check
```
