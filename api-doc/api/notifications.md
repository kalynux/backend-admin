# `/notifications` — the administrator inbox

Base path: `/api/v1/notifications`

The fifth notification stack. The platform has carried four — vendor, agency, agent, customer —
since long before this service existed; the administrator, alone among the five roles, had none.

Design record: [`../../docs/ADR-013-NOTIFICATIONS.md`](../../docs/ADR-013-NOTIFICATIONS.md).

| Method | Path | Access | Audited |
|---|---|---|---|
| `GET` | `/notifications` | `notifications.read` | — |
| `GET` | `/notifications/unread-count` | `notifications.read` | — |
| `GET` | `/notifications/sources` | `notifications.read` | — |
| `GET` | `/notifications/preferences` | *self* | — |
| `PATCH` | `/notifications/preferences` | *self* | ✅ |
| `POST` | `/notifications/read-all` | `notifications.read` | **❌ deliberately** |
| `PATCH` | `/notifications/:notificationId/read` | `notifications.read` | **❌** |
| `PATCH` | `/notifications/:notificationId/unread` | `notifications.read` | **❌** |
| `POST` | `/notifications/:notificationId/archive` | `notifications.read` | **❌** |
| `POST` | `/notifications/:notificationId/unarchive` | `notifications.read` | **❌** |

`notifications.read` is held by **all three levels**. Preferences are *self*-service — gating an
administrator's own configuration behind a level permission would stop a Support administrator
configuring theirs, and a preference nobody can set is not a preference.

## Three properties to build against

### 1. Nothing here creates a notification

**There is no `POST /notifications`.** Every row is *derived* by a background projector from a
row some other part of the platform already committed. An endpoint that manufactured one would be
exactly the hole this design was asked not to open.

A declared type with no producing source **stops the service from booting** — which is what makes
"do not invent notification events" a property of the code rather than a promise.

### 2. The permission does not decide *which* notifications you see

Holding `notifications.read` gets you the inbox. **Which rows are in it is decided per row**,
from the permission each source declares, checked both at fan-out and again on every read.

Two administrators at the same level can legitimately have different inboxes.

### 3. Five writes are deliberately unaudited

Marking read, unread, archived, unarchived, and bulk read-all record **nothing**.

Reads are not audited, and a read receipt is on the far side of that line — it records that
somebody *looked*, not that anybody *did* anything. Auditing them would also actively damage the
trail: an administrator triaging a morning's alerts would generate dozens of rows saying nothing
about what they did, diluting the record a security review reads.

**What the administrator then does about the notification is audited by the endpoint that does
it.**

The one audited write is the **preference change**, because that is durable configuration that
changes what the service does in future.

---

## The vocabulary

### Notification types

Ten, and the list is closed.

| Type | Severity family |
|---|---|
| `cod.discrepancy.opened` | COD |
| `cod.remittance.declared` | COD |
| `money.payout.requested` | Money |
| `orders.dispute.opened` | Orders |
| `agencies.verification.pending` | Onboarding awaiting a decision |
| `vendors.kyc.pending` | Onboarding awaiting a decision |
| `system.tracking_dispatch.failed` | Platform health |
| `approvals.requested` | This service's own machinery |
| `approvals.decided` | This service's own machinery |
| `audit.export.finished` | This service's own machinery |

### Severities

`info` · `warning` · `critical`

### Source ids

`cod_discrepancy_opened` · `cod_remittance_declared` · `payout_requested` · `order_disputed` ·
`agency_verification_pending` · `vendor_kyc_pending` · `tracking_dispatch_failed` ·
`approval_requested` · `approval_decided` · `audit_export_finished`

Get the authoritative list, with what each is derived from, at `GET /notifications/sources`.

---

## `GET /notifications`

| | |
|---|---|
| **Permission** | `notifications.read` |
| **Pagination** | `page`, `limit` |
| **Sorting** | `occurredAt`, `createdAt`, `severity`. Default **`-occurredAt`** |

**`occurredAt`, not `createdAt`, is the default and the two genuinely differ**: `createdAt` is
when the projector noticed, `occurredAt` is when the thing happened. An inbox ordered by when a
background sweep ran would reorder itself for reasons that have nothing to do with the platform —
a slow tick, a restart, a source added later.

### Query parameters

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `status` | `unread` \| `read` \| `archived` \| `all` | **`unread`** | Derived, not stored. The default is `unread` because the question somebody opens an inbox asking is *"what have I not dealt with"* |
| `type` | enum | — | One of the ten |
| `severity` | `info` \| `warning` \| `critical` | — | |
| `source` | enum | — | **Bounded by the registry** — a source id that produces nothing would be a filter that can only ever return an empty page |
| `from` / `to` | ISO-8601 instant | — | **Max span 366 days** |

### Response (200)

```jsonc
{
  "success": true,
  "data": [
    {
      "id": "66c0aabbccddeeff00112233",
      "type": "cod.discrepancy.opened",
      "severity": "warning",
      "title": "Cash discrepancy opened",
      "body": "Eric T. — late deposit, XAF 84,500 held 6 days past the remittance window",
      "source": "cod_discrepancy_opened",
      "target": { "type": "discrepancy", "id": "6683aabbccddeeff00112233", "label": "late_deposit" },
      "actionPath": "/cod/discrepancies/6683aabbccddeeff00112233",
      "occurredAt": "2026-08-11T00:05:00.000Z",
      "readAt": null,
      "archivedAt": null,
      "isRead": false,
      "isArchived": false
    }
  ],
  "meta": { "total": 41, "page": 1, "limit": 20, "pages": 3, "unreadCount": 12 }
}
```

| Field | Notes |
|---|---|
| `target` | The record it is about |
| **`actionPath`** | Where to send the administrator. **A dashboard route, relative** |
| `readAt` / `archivedAt` | **Always present, `null` when unset** — never absent, so a client never has to feature-detect |
| **`meta.unreadCount`** | Rides alongside the pagination fields and is computed with **the same filters** — the badge and the list must not be two requests that can disagree |

`source_row_id` and `required_permission` are internal and never returned: the first would invite
a client to construct its own platform URLs, the second describes the authorization model to
whoever holds a session.

---

## `GET /notifications/unread-count`

The badge. A dashboard polling for a number should not have to fetch twenty rows to get it.

| | |
|---|---|
| **Permission** | `notifications.read` |
| **Pagination** | None |

### Query parameters

The same narrowing vocabulary as the list, minus paging, sorting and `status` (the endpoint's
whole subject is unread):

| Parameter | Type |
|---|---|
| `type` | enum |
| `severity` | `info` \| `warning` \| `critical` |
| `source` | enum |

### Response (200)

```json
{ "success": true, "data": { "unreadCount": 12 } }
```

---

## `GET /notifications/sources`

What this inbox can **ever** say, and what each answer is derived from.

It exists so that "do not invent notification events" is legible from outside the code — and so
an administrator who has never seen a `cod.discrepancy.opened` can tell **"none have happened"**
from **"I am not entitled to them"**.

| | |
|---|---|
| **Permission** | `notifications.read` |
| **Parameters** | None |
| **Pagination** | None |

### Response (200)

```jsonc
{
  "success": true,
  "data": {
    "sources": [
      {
        "id": "cod_discrepancy_opened",
        "describe": "A cash discrepancy was opened against an agent or agency",
        "collection": "cod_discrepancies",
        "produces": ["cod.discrepancy.opened"],
        "requiredPermission": "cod.discrepancies.read",
        "severity": ["warning"]
      },
      {
        "id": "approval_requested",
        "describe": "An action was queued for a second administrator",
        "collection": "approval_requests",
        "produces": ["approvals.requested"],
        "requiredPermission": "approvals.read",
        "severity": ["info"]
      }
    ]
  }
}
```

| Field | Notes |
|---|---|
| `collection` | The committed rows this source is derived from |
| `produces` | Which notification types it can raise |
| **`requiredPermission`** | **What you must hold to receive it.** `null` when ungated. This is the field that answers "why do I never see these" |

---

## `GET /notifications/preferences`

| | |
|---|---|
| **Access** | *self* — no permission |
| **Parameters** | None |

### Response (200)

One entry per notification type, always all ten:

```jsonc
{
  "success": true,
  "data": {
    "preferences": [
      {
        "type": "cod.discrepancy.opened",
        "summary": "A cash discrepancy was opened against an agent or agency",
        "severity": "warning",
        "enabled": true,
        "defaultEnabled": true,
        "overridden": false
      },
      {
        "type": "audit.export.finished",
        "summary": "An audit export finished",
        "severity": "info",
        "enabled": false,
        "defaultEnabled": true,
        "overridden": true
      }
    ]
  }
}
```

| Field | Notes |
|---|---|
| `enabled` | The **effective** value |
| `defaultEnabled` | The catalog's value |
| `overridden` | Whether this administrator has set an explicit override. **`enabled === defaultEnabled` does not imply `overridden === false`** |

---

## `PATCH /notifications/preferences`

| | |
|---|---|
| **Access** | *self* |
| **CSRF** | Required for cookie clients |
| **Body** | **Strict** |
| **Audited** | ✅ — the one audited write on this surface |

### Request body

| Field | Type | Rules |
|---|---|---|
| `overrides` | object | **Required.** Keys are notification types; values are `boolean` **or `null`** |

**Three states, and the third is the important one:**

| Value | Means |
|---|---|
| **key absent** | Leave whatever it had |
| `true` / `false` | Set an explicit override |
| **`null`** | **Remove the override** — the type falls back to the catalog's default and *tracks it* from then on |

Without the third state there is no way to say "stop overriding this" — only "override it to the
value that happens to be the default today", which silently stops tracking the catalog.

```json
{ "overrides": { "audit.export.finished": false, "cod.remittance.declared": null } }
```

### Response (200)

```jsonc
{
  "success": true,
  "data": { "preferences": [ /* the full list, as above */ ] },
  "message": "Saved. Preferences apply to notifications raised from now on; anything already in your inbox stays there."
}
```

> **⚠️ Preferences apply at fan-out.** Muting a type stops the **next** one; it does not hide the
> ones already delivered. The obvious reading — *"this cleans up my inbox"* — is wrong, which is
> why the message says so. **Show it.**

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | An unknown notification type, a non-boolean value, or an unknown top-level field |

### Audit

`notifications.preferences.update_self`

---

## `POST /notifications/read-all`

Bulk mark-read, **scoped by the same filters the list takes**.

| | |
|---|---|
| **Permission** | `notifications.read` |
| **Body** | **Strict** |
| **Audited** | ❌ |

### Request body

All optional.

| Field | Type | Notes |
|---|---|---|
| `type` | enum | |
| `severity` | enum | |
| `source` | enum | |
| **`before`** | date | **Only rows at or before this instant.** Send the `occurredAt` of the newest row you rendered |

An unscoped "mark everything read" is a button that silently discards whatever arrived between
the page rendering and the click. Taking the filter **and** `before` makes the gesture mean
*"mark read what I was looking at"* — which is what it means to the person making it.

```json
{ "severity": "info", "before": "2026-08-13T09:00:00.000Z" }
```

### Response (200)

```json
{ "success": true, "data": { "marked": 7 }, "message": "7 notifications marked read" }
```

---

## `PATCH /notifications/:notificationId/read`

| | |
|---|---|
| **Permission** | `notifications.read` |
| **Path parameter** | `notificationId` — 24-hex |
| **Request body** | None |
| **Response** | The updated notification |
| **Audited** | ❌ |

---

## `PATCH /notifications/:notificationId/unread`

The undo. Present because the alternative to a reversible read receipt is an administrator who
mis-clicks losing track of something the platform is waiting on them for, with no way back.

| | |
|---|---|
| **Permission** | `notifications.read` |
| **Request body** | None |
| **Response** | The updated notification |
| **Audited** | ❌ |

---

## `POST /notifications/:notificationId/archive`

**A soft stamp, and the only deletion path there is.**

| | |
|---|---|
| **Permission** | `notifications.read` |
| **Request body** | None |
| **Audited** | ❌ |

### Response (200)

```jsonc
{
  "success": true,
  "data": { "id": "…", "archivedAt": "2026-08-13T10:00:00.000Z", "isArchived": true, "…": "…" },
  "message": "Archived. It will be removed after 30 days; what it was about is unaffected."
}
```

**There is no `DELETE`.** Archiving stamps `archivedAt` and a purge date; a TTL removes the row
later. Nothing on this surface destroys anything on demand.

**What the notification was *about* is untouched either way** — it lives in the audit log and in
the platform row the projector derived it from, both of which outlive the receipt.

Retention default: **30 days** (`ADMIN_NOTIFICATIONS_RETENTION_DAYS`).

---

## `POST /notifications/:notificationId/unarchive`

| | |
|---|---|
| **Permission** | `notifications.read` |
| **Request body** | None |
| **Response** | The updated notification |
| **Audited** | ❌ |

---

## Errors on this surface

**One code, and only one:**

| Status | Code | Covers |
|---|---|---|
| 404 | `NOTIFICATION_NOT_FOUND` | No such notification · **exists, addressed to somebody else** · **exists, but your level no longer holds the permission it is gated on** |

All three are **404, never 403**, deliberately. Answering *"that exists but is not yours"* on an
inbox tells the caller that a notification was raised, which type it was, and that somebody else
received it — a disclosure the permission model exists to prevent.

Plus the usual `400 VALIDATION_ERROR` for a malformed id or body.

There is no create to reject, no state machine to conflict with, and no delegated call to be
refused — which is why the list is this short.

---

## `notifications.manage` is catalogued and unrouted

The permission exists and is granted; **no endpoint uses it.**

It reads *"configure which events raise an administrator alert"*, which is **service-wide** by
its wording. What ships today is **per-administrator** preferences. A global switch over the
source registry is the natural thing to put behind it later; repurposing it to gate self-service
preferences would make the name describe something it does not do.
