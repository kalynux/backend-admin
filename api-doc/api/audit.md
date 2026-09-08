# `/audit` — the audit trail

**Verified against source on 2026-09-08** — all seven routes and their guards against the live route manifest; every query parameter, the 92-day span cap and the required export range against `audit/validators/audit.validator.ts`; the action, target-type, status and transport vocabularies re-derived by running the catalog (**114** actions and **23** target types, not 80 and 22 — `file` was missing) and `PERMISSION_FAMILIES` (**20**, not 21); the subject-class map against `audit/domain/audit-subject.ts:19-43`; and the retention default against `admin/src/config/env.ts:182`.

Base path: `/api/v1/audit`

Every administrator action, who did it, to what, and how it ended. Rows are **immutable** and
written in the same transaction as the change they describe wherever the change lands in this
service's own database.

Design records: [`../../docs/ADR-006-AUDIT.md`](../../docs/ADR-006-AUDIT.md),
[`../../docs/ADR-012-AUDIT-COMPLETION.md`](../../docs/ADR-012-AUDIT-COMPLETION.md).

| Method | Path | Permission | Audited |
|---|---|---|---|
| `GET` | `/audit` | `audit.read` | — |
| `GET` | `/audit/actions` | `audit.read` | — |
| `GET` | `/audit/:auditId` | `audit.read` | — |
| `POST` | `/audit/exports` | `audit.export` | ✅ |
| `GET` | `/audit/exports` | `audit.export` | — |
| `GET` | `/audit/exports/:exportId` | `audit.export` | — |
| `GET` | `/audit/exports/:exportId/download` | `audit.export` | — |

Two other endpoints serve the same collection, filtered to one administrator:
`GET /administrators/:adminId/activity` (what they **did**) and
`GET /administrators/:adminId/history` (what was done **to** them). Same query and response
shape as `GET /audit`. See [administrators.md](administrators.md).

`GET /administrators/me/activity` is the self-service variant and needs no permission at all —
an audit trail people cannot see their own entry in is one they have no way to challenge.

---

## Read scope — what Support sees

`audit.read` is held by **all three levels**, but what a Support administrator sees is narrowed
**per row**, in the query, not in the controller:

| Level | Sees |
|---|---|
| 1 Developer, 2 Admin | Every row |
| 3 Support | Rows whose subject is a **platform actor or record** (users, vendors, agencies, agents, customers, orders, shipments, remittances, deposits, discrepancies, payouts, tickets, articles, plans, **files**) — **plus anything they did themselves** |

Rows classed `internal` — administrators, admin sessions, approval requests, audit exports,
feature flags, workers, maintenance windows — are invisible to Support. Without that narrowing,
the audit feed would be a side door onto the administrator directory that the grant table
withholds from them.

**A row outside your scope answers `404`, not `403`.** A 403 would confirm the row exists,
which is an existence oracle over exactly the rows the scope hides.

---

## `GET /audit`

The feed.

| | |
|---|---|
| **Method / Path** | `GET /api/v1/audit` |
| **Permission** | `audit.read` |
| **Pagination** | `page`, `limit` |
| **Sorting** | `occurredAt` only. Default **`-occurredAt`** |

Only one sort key is offered, deliberately: an audit feed is a chronology, and sorting by actor
or action would invite full-collection scans on the largest collection in the database for an
ordering nobody reads a trail in. Filter by those instead.

### Query parameters

| Parameter | Type | Notes |
|---|---|---|
| `actorId` | 24-hex | The administrator who performed the action |
| `action` | enum | One of the catalogued action names — **114 on 2026-09-08, and this number moves every phase**. Get the list from `GET /audit/actions` rather than hardcoding it |
| `actionFamily` | enum | One of the **20** permission families |
| `status` | enum | `attempted` \| `succeeded` \| `failed` \| `denied` \| `queued` |
| `targetType` | enum | See the target-type list below |
| `targetId` | string | 1–128 characters. **Not** validated as an ObjectId — a target may be a session UUID or a composite key |
| `correlationId` | string | 1–128 characters. The `requestId` of the originating request |
| `sensitiveOnly` | boolean flag | `true` → only money, escalation, destructive and four-eyes rows |
| `search` | string | 1–120 characters |
| `from` / `to` | ISO-8601 instant | Half-open `[from, to)`. **Maximum span 92 days** |
| `page` | integer | Default 1 |
| `limit` | integer | Default 20, max 100 |
| `sort` | string | `occurredAt` or `-occurredAt` |

`action`, `actionFamily`, `status` and `targetType` are **pinned enums**: a typo is a `400`
naming the valid values, rather than a filter that silently matches nothing.

#### `targetType` values

`user`, `vendor`, `agency`, `agent`, `customer`, `order`, `shipment`, `remittance`, `deposit`,
`discrepancy`, `payout`, `ticket`, `article`, `plan`, `file`, `administrator`, `admin_session`,
`approval_request`, `audit_export`, `feature_flag`, `worker`, `maintenance_window`, `none`

**23 values.** An unrecognised value stored in a row falls back to `none`, which classifies as
`internal` — so an unclassifiable row is withheld from Support rather than leaked to them.

### Example request

```
GET /api/v1/audit?actionFamily=money&sensitiveOnly=true
    &from=2026-08-01T00:00:00.000Z&to=2026-08-13T00:00:00.000Z
    &sort=-occurredAt&limit=50
```

### Response (200)

```jsonc
{
  "success": true,
  "data": [
    {
      "id": "66bc4f0a1d2e3f4a5b6c7d8e",
      "occurredAt": "2026-08-12T14:22:09.117Z",
      "completedAt": "2026-08-12T14:22:09.884Z",
      "correlationId": "8f14c2a0-6b3e-4a91-9c7d-2e5f0a1b3c4d",

      "action": "money.payouts.mark_paid",
      "actionSummary": "Mark a payout request as paid — records that money has left the platform",
      "actionFamily": "money",
      "status": "succeeded",
      "sensitive": true,

      "actor": {
        "kind": "administrator",
        "id": "665f1c2a9b3e4a91c7d2e5f0",
        "email": "ada@wimall.cm",
        "displayName": "Ada Nkemelu",
        "tier": 2,
        "sessionId": "0f9c8b7a-6d5e-4c3b-2a19-8f7e6d5c4b3a"
      },

      "target": {
        "type": "payout",
        "id": "66a1b2c3d4e5f60718293a4b",
        "label": "PR-2026-004182",
        "subjectClass": "platform_record"
      },

      "relatedTarget": { "type": "agency", "id": "665c0011223344556677889a" },

      "request": {
        "method": "POST",
        "path": "/api/v1/money/payouts/66a1b2c3d4e5f60718293a4b/mark-paid",
        "ip": "102.244.18.7",
        "userAgent": "Mozilla/5.0 …"
      },

      "outcome": {
        "code": null,
        "statusCode": 200,
        "message": null,
        "denialKind": null,
        "requiredPermissions": [],
        "platformCode": null
      },

      "viaApprovalId": "66a0f31c8b2d4e5f60718293",
      "delegated": true,

      "exportedAt": null,
      "purgeAfter": null
    }
  ],
  "meta": {
    "total": 4127,
    "page": 1,
    "limit": 50,
    "pages": 83,
    "retentionDays": 365,
    "oldestRetainedAt": "2025-08-14T09:00:00.000Z"
  }
}
```

#### Extra `meta` fields

| Field | Notes |
|---|---|
| `retentionDays` | The configured retention window |
| `oldestRetainedAt` | The oldest row still in the collection, or `null`. **Render this** — it is why the feed stops where it does, rather than the feed looking broken at the boundary |

#### Entry fields

| Field | Type | Notes |
|---|---|---|
| `occurredAt` | ISO-8601 | When the intent was recorded |
| `completedAt` | ISO-8601 \| null | When the outcome landed. Null on an `attempted` row that never resolved |
| `correlationId` | string | The originating request's id. **Join on this to follow one action across rows** |
| `action` | string | The catalogued action name |
| `actionSummary` | string \| null | The catalog's one-line description, so a feed reads without a lookup table. `null` for a row whose action is no longer catalogued |
| `actionFamily` | string | |
| `status` | enum | `attempted` (intent recorded, outcome unknown) · `succeeded` · `failed` · `denied` (an authorization refusal) · `queued` (sent for four-eyes approval) |
| `sensitive` | boolean | Money, escalation, destructive or four-eyes |
| `actor.kind` | `administrator` \| `system` \| `anonymous` | `system` = the approval-expiry sweep, the purge, the bootstrap CLI. `anonymous` = a login attempt against an address matching no account |
| `actor.tier` | number \| null | **The level held at the time**, not the level now |
| `target.subjectClass` | `platform_actor` \| `platform_record` \| `internal` | The read-scoping axis |
| `relatedTarget` | object \| null | A second record the action also concerned |
| `outcome.denialKind` | string \| null | Present on `denied` rows |
| `outcome.requiredPermissions` | string[] | `[]` when not a denial |
| `outcome.platformCode` | string \| null | jovi-mall's own error code, on a failed delegated write |
| `viaApprovalId` | string \| null | Set when the action was committed through four eyes |
| `delegated` | boolean | Whether the change was executed by jovi-mall rather than written here |
| `exportedAt` | ISO-8601 \| null | |
| `purgeAfter` | ISO-8601 \| null | When the row becomes eligible for deletion. **Null until it has been exported** — retention is exported-AND-aged, not aged alone |

`payload`, `before` and `after` are **not** on list rows. Fetch the entry detail for those.

---

## `GET /audit/actions`

The action vocabulary, so a dashboard builds its filter from the catalog instead of discovering
it by collecting 400s.

| | |
|---|---|
| **Permission** | `audit.read` |
| **Parameters** | None |
| **Pagination** | None |

### Response (200)

```jsonc
{
  "success": true,
  "data": {
    "actions": [
      {
        "name": "money.payouts.mark_paid",
        "family": "money",
        "target": "payout",
        "transport": "delegated",
        "permission": "money.payouts.mark_paid",
        "summary": "Mark a payout request as paid — records that money has left the platform"
      }
    ],
    "total": 114
  }
}
```

| Field | Notes |
|---|---|
| `target` | The `targetType` rows for this action carry |
| `transport` | Where the change lands, which decides how it can be audited: `wi_admin_txn` (row and change commit in one transaction — an unaudited action is impossible) · `delegated` (jovi-mall over HTTP; intent → outcome) · `external` (Redis or the platform connection; intent → outcome) · `observation` (nothing to roll back — a login happened; best-effort) |
| `permission` | The permission that governs the action |

---

## `GET /audit/:auditId`

One entry, with the state the list omits.

| | |
|---|---|
| **Permission** | `audit.read` |
| **Path parameter** | `auditId` — 24-hex |

### Response (200)

Every field of a list entry, **plus**:

| Field | Type | Notes |
|---|---|---|
| `payload` | object \| null | The request payload, with credential-shaped fields redacted by name |
| `before` | object \| null | The changed fields as they were |
| `after` | object \| null | The changed fields as they became |
| `stateTruncated` | boolean | True when a value was too large to store and was replaced by a summary |

```jsonc
{
  "success": true,
  "data": {
    "id": "66bc4f0a1d2e3f4a5b6c7d8e",
    "…": "…all list fields…",
    "payload": { "tier": 2 },
    "before":  { "tier": 3 },
    "after":   { "tier": 2 },
    "stateTruncated": false
  }
}
```

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Malformed id |
| 404 | `AUDIT_ENTRY_NOT_FOUND` | No such row — **or the row is outside your read scope** |

---

# Exports

An export writes an **NDJSON** file and marks the rows it covers as exported. **It does not
purge.** Deletion from a dashboard would be one misclick from irreversible; purging lives in the
CLI (`npm run audit:export -- --purge`).

Retention is **exported-AND-aged**: a row's `purgeAfter` stays `null` until an export has
stamped it, so nothing can age out of the trail without first having been written to a file.

---

## `POST /audit/exports`

| | |
|---|---|
| **Permission** | `audit.export` — Developer and Admin. Flagged `destructive`, because an export is the precondition for deletion |
| **Status** | `201` |

### Request body

| Field | Type | Rules |
|---|---|---|
| `from` | ISO-8601 instant | **Required** |
| `to` | ISO-8601 instant | **Required.** Must be after `from` |

Both are required here, unlike the feed's. An export with no range means "the whole
collection", and the API path is bounded by row count — asking for it here is almost always a
mistake. The CLI takes an open range.

```json
{ "from": "2026-07-01T00:00:00.000Z", "to": "2026-08-01T00:00:00.000Z" }
```

### Response (201)

```jsonc
{
  "success": true,
  "data": {
    "id": "66bd1122334455667788990a",
    "status": "complete",
    "source": "api",
    "requestedBy": "665f1c2a9b3e4a91c7d2e5f0",
    "requestedByName": "Ada Nkemelu",
    "rangeFrom": "2026-07-01T00:00:00.000Z",
    "rangeTo": "2026-08-01T00:00:00.000Z",
    "fileName": "audit-2026-07-01_2026-08-01-66bd1122.ndjson",
    "byteSize": 8412330,
    "rowCount": 12043,
    "sha256": "9f2b8c1a…",
    "retentionDays": 365,
    "startedAt": "2026-08-13T09:20:00.000Z",
    "completedAt": "2026-08-13T09:20:07.442Z",
    "stampedAt": "2026-08-13T09:20:07.501Z",
    "stampedCount": 12043,
    "purgedAt": null,
    "purgedCount": null,
    "failureReason": null,
    "downloadable": true
  },
  "message": "Exported 12043 row(s). Nothing was deleted — use the CLI with --purge for that."
}
```

| Field | Notes |
|---|---|
| `source` | `"api"` here; `"cli"` for CLI-produced exports |
| `sha256` | Checksum of the file, so a client can verify what it downloaded |
| `stampedAt` / `stampedCount` | When the covered rows were marked exported, and how many |
| `purgedAt` / `purgedCount` | Always `null` for an API export |
| `downloadable` | True once the file is durable |
| **`fileName`, never a path** | A server filesystem path is nothing a dashboard can use and something an attacker can |

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Missing `from` or `to` ("An export needs both `from` and `to`. Use the CLI for an open-ended export."), or `to` not after `from` |
| 422 | `AUDIT_EXPORT_TOO_LARGE` | The range covers more than `ADMIN_AUDIT_EXPORT_API_MAX_ROWS` (default **50 000**). `details` carries the row count and points at the CLI. Narrow the range |

### Audit

`audit.export`

---

## `GET /audit/exports`

| | |
|---|---|
| **Permission** | `audit.export` |
| **Pagination** | `page`, `limit` |
| **Sorting** | `startedAt` only. Default **`-startedAt`** |
| **Filters** | None |

### Response (200)

A paginated array of the export objects shown above, with the standard
`{ total, page, limit, pages }` meta.

---

## `GET /audit/exports/:exportId`

| | |
|---|---|
| **Permission** | `audit.export` |
| **Path parameter** | `exportId` — 24-hex |
| **Response** | A single export object |
| **Errors** | `400 VALIDATION_ERROR`, `404 AUDIT_EXPORT_NOT_FOUND` |

---

## `GET /audit/exports/:exportId/download`

Stream the file.

**The one endpoint in this service that does not answer with the JSON envelope**, because the
payload is a file.

| | |
|---|---|
| **Permission** | `audit.export` |
| **Response** | The NDJSON file body |

### Response headers

| Header | Value |
|---|---|
| `Content-Type` | `application/x-ndjson` |
| `Content-Disposition` | `attachment; filename="audit-….ndjson"` |
| `X-Content-SHA256` | The manifest's checksum, when recorded — verify the download against it |

### Errors

These **do** use the JSON envelope.

| Status | Code | When |
|---|---|---|
| 404 | `AUDIT_EXPORT_NOT_FOUND` | No such export |
| 409 | `AUDIT_EXPORT_INCOMPLETE` | The export did not finish, so its file is not durable |
| 410 | `AUDIT_EXPORT_FILE_MISSING` | The record exists; the file is gone. `details.fileName` names it |

> **Deployment caveat.** The file lives on the instance that wrote it. Behind a load balancer
> with more than one instance this returns `410` unless `ADMIN_AUDIT_EXPORT_DIR` points at
> shared storage.

---

# `GET /audit/legacy` — **DELETED at Phase 5 Part D**

This route served the interim feed of administrative actions still performed **on jovi-mall**
rather than through this service: a second router on the `/audit` prefix, reading
`admin_action_log` in the platform database with a vocabulary of its own.

It was built to be deleted, and the deletion was **enforced rather than remembered**.
`test-authz.ts` carried a tripwire reading *"the legacy-audit module is deleted once the legacy
surface is"* — the moment Phase 5 Part C ported the last legacy endpoint and
`LEGACY_ENDPOINT_COUNT` reached 0, the suite went red and stayed red until the module was gone.

## What a client should do

Nothing calls this any more, and nothing should. It answers **404** like any unknown path — the
`AUDIT_LEGACY_FEED_DISABLED` code that used to mean *"the feed is switched off by its flag"* is
deleted too, along with the flag.

The dashboard's log screen reads `GET /audit`, which is the compliance record and always was.
The legacy feed was never that: every page it returned carried `"legacy": true` and
`"retiresAtCutover": true` precisely so a dashboard could not render it as the audit trail by
omission.

## Where the history went — nowhere

**The rows are still in Mongo.** `admin_action_log` survives cutover and is still written:
`AuditLogger` routes any entry whose actor role is `admin` into it, and `AdminAgencyService`
reaches it over `/api/internal/admin/agencies`. What was deleted is *this service's read* of it.

The reason is that after cutover the collection stops being a distinct record. Every new row in
it duplicates a wi-admin audit row for the same operation, written with a real administrator
identity, the same correlation id and a catalogued action — so the feed would report the same
events twice in two vocabularies, one of them worse. If the historical rows are ever needed,
they are reachable through the developer tools.

Design records: [ADR-017](../../docs/ADR-017-PHASE-17-CLOSEOUT.md) D-8 (the deletion) and
[Phase 5 § C-10](../../../PRODUCTION-READINESS/PHASE-5-LEGACY-CLOSEOUT-PLAN.md) (why the
collection itself must not be deleted with it).
