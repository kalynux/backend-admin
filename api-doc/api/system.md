# `/system` — operations reads

Base path: `/api/v1/system`

What an operator needs to answer *"is this thing working"*.

**Every route is a `GET`, and none is audited.** Nothing here changes anything, and nothing here
discloses something a Developer could not read out of a config file.

Design records: [`../../docs/ADR-014-SYSTEM-OPERATIONS.md`](../../docs/ADR-014-SYSTEM-OPERATIONS.md),
[`../../docs/ADR-015-DEVELOPER-TOOLS.md`](../../docs/ADR-015-DEVELOPER-TOOLS.md),
[`../../docs/ADR-016-ERROR-SYSTEM.md`](../../docs/ADR-016-ERROR-SYSTEM.md).

| Method | Path | Permission | Subject | Transport |
|---|---|---|---|---|
| `GET` | `/system/health` | `system.health.read` | **wi-admin** | direct |
| `GET` | `/system/outbox` | `system.outbox.read` | platform | direct read |
| `GET` | `/system/config` | `developer_tools.config.read` | **wi-admin** | local |
| `GET` | `/system/workers` | `system.workers.read` | platform | **delegated** |
| `GET` | `/system/dependencies` | `system.health.read` | platform | **delegated** |
| `GET` | `/system/integrations` | `system.health.read` | platform | **delegated** |
| `GET` | `/system/cache` | `system.health.read` | platform | **delegated** |
| `GET` | `/system/queues` | `system.outbox.read` | platform | **delegated** |
| `GET` | `/system/metrics` | `system.metrics.read` | platform | **delegated** |
| `GET` | `/system/maintenance` | `system.maintenance.read` | platform | **delegated** |
| `GET` | `/system/errors` | **any of** `developer_tools.logs.read`, `system.errors.read`, `support.errors.lookup` | platform | **delegated** |
| `GET` | `/system/platform/config` | `developer_tools.config.read` | platform | **delegated** |
| `GET` | `/system/platform/logs` | `developer_tools.logs.read` | platform | **delegated** |
| `GET` | `/system/platform/cache/keys` | `developer_tools.cache.inspect` | platform | **delegated** |
| `GET` | `/system/platform/database` | `developer_tools.database.inspect` | platform | **delegated** |
| `GET` | `/system/geo-tracker` | `system.health.read` | **geo-tracker** | direct probe |
| `GET` | `/system/geo-tracker/metrics` | `system.metrics.read` | **geo-tracker** | direct probe |

## Naming: `/system/x` vs `/system/platform/x`

`/system/platform/*` is used where **this service has, or plausibly will have, its own answer to
the same question**. `/system/config` already means wi-admin's config, so the platform's takes a
segment.

The seven `/system/*` platform reads deliberately **do not move** — wi-admin has no competing
answer to any of them, and relocating them would break a live dashboard for no benefit. The
inconsistency is deliberate.

## `/system/health` does not replace `/health`

| | `/health/*` | `/system/health` |
|---|---|---|
| Versioned | No | Yes |
| Authenticated | No | Yes |
| Rate limited | **Never** | Yes |
| Audience | An orchestrator's probe | A person |

See [health.md](health.md). Both must keep existing.

---

## `GET /system/health`

**wi-admin's own** health, plus two facts only meaningful to a person.

| | |
|---|---|
| **Permission** | `system.health.read` |
| **Parameters** | None |

### Response (200)

```jsonc
{
  "success": true,
  "data": {
    "dependencies": {
      "admin":    { "ok": true, "durationMs": 3, "database": "wi_admin" },
      "platform": { "ok": true, "durationMs": 4, "database": "jovi_mall" },
      "redis":    { "ok": true, "durationMs": 1 },
      "joviMall": { "configured": true, "ok": true, "durationMs": 27 }
    },
    "audit": {
      "danglingIntents": 2,
      "danglingIntentsCappedAt": 100,
      "oldestDanglingAt": "2026-08-12T22:41:03.118Z",
      "retentionDays": 365
    }
  }
}
```

### `audit.danglingIntents` — what to do about it

A **dangling intent** is an `attempted` audit row whose outcome never landed: a delegated call
crashed mid-flight. The action may or may not have happened on the platform side.

Resolve one by grepping jovi-mall for the same `correlationId` — it travels as `X-Request-Id` on
every delegated call.

`danglingIntentsCappedAt: 100` is stated so `100` is never mistaken for "exactly a hundred".

---

## `GET /system/outbox`

The tracking-outbox depth, read **directly** from the platform database.

| | |
|---|---|
| **Permission** | `system.outbox.read` |
| **Parameters** | None |

### Response (200)

```jsonc
{
  "success": true,
  "data": {
    "depth": { "pending": 3, "failed": 1, "sent": 412088 },
    "oldestPendingAt": "2026-08-13T09:12:44.000Z",
    "maxAttempts": 4,
    "totalUnsent": 4
  }
}
```

`failed > 0` means events for geo-tracker were not delivered. Replay them with
[`POST /dev-tools/outbox/replay`](dev-tools.md#post-dev-toolsoutboxreplay).

**This route and `/system/queues` are both kept on purpose.** `/queues` is delegated and returns
`503` during a platform incident — exactly when an operator wants queue depth. This one reads the
collection directly and still answers.

---

## `GET /system/config`

**wi-admin's own** whitelisted runtime configuration.

| | |
|---|---|
| **Permission** | `developer_tools.config.read` — **Developer only.** Runtime configuration says how the service is wired, which is Developer-tier information; the `system.*` reads reach Admin |
| **Parameters** | None |

### Response (200)

```jsonc
{
  "success": true,
  "data": {
    "config": {
      "NODE_ENV": "production",
      "PORT": 8033,
      "LOG_LEVEL": "info",
      "TRUST_PROXY": 1,
      "ADMIN_DASHBOARD_ORIGINS": ["https://admin.wimall.cm"],
      "ADMIN_APPROVAL_TTL_S": 86400,
      "ADMIN_APPROVAL_SWEEP_MIN_INTERVAL_MS": 60000,
      "ADMIN_AUDIT_RETENTION_DAYS": 365,
      "ADMIN_AUDIT_MAX_STATE_BYTES": 16384,
      "ADMIN_AUDIT_DANGLING_INTENT_S": 300,
      "ADMIN_AUDIT_EXPORT_API_MAX_ROWS": 50000,
      "ADMIN_AUDIT_EXPORT_DIR": "./var/audit-exports",
      "SHUTDOWN_TIMEOUT_MS": 15000
    }
  }
}
```

**The key list is a closed allowlist**, built by naming keys and re-checked at boot: a key whose
name contains `URI`, `URL`, `SECRET`, `TOKEN`, `KEY`, `PASSWORD`, `PASS`, `DSN` or `CREDENTIAL`
in any underscore-separated position **stops the service from starting**. There is no spread of
the environment here.

---

# The platform's operations reads

All delegated. All return `502`/`503 SERVICE_DEPENDENCY_UNAVAILABLE` when the platform is
unreachable.

## `GET /system/workers`

All twelve background workers: three distinct state booleans, structured schedules, the `enabled`
master switch and `pausedByMaintenance`.

| | |
|---|---|
| **Permission** | `system.workers.read` |
| **Parameters** | None |

> `GET /dev-tools/workers` still exists and returns a **narrower legacy shape** — four fields and
> a single `running` flag that conflates three conditions. Prefer this one.

---

## `GET /system/dependencies`

The platform's Mongo and Redis, as **its** process sees them — connection topology, pool state.

| | |
|---|---|
| **Permission** | `system.health.read` |
| **Parameters** | None |

---

## `GET /system/integrations`

Every third-party integration: **configured vs reachable, never conflated.**

| | |
|---|---|
| **Permission** | `system.health.read` |

### Query parameters

| Parameter | Type | Notes |
|---|---|---|
| `probe` | comma-separated string, ≤ 200 chars | Opt into the checks that are safe but not free — e.g. `?probe=smtp,telegram` |

Everything not probed reports either a free health path or what real traffic last learned.
**Several providers cannot be probed at all**: a health check against a payment gateway is an
authenticated call on a live merchant account, and against WhatsApp it is a message to a real
person. The response carries the per-provider reasoning.

---

## `GET /system/cache`

Redis key counts per logical database, plus instance-wide memory.

| | |
|---|---|
| **Permission** | `system.health.read` |
| **Parameters** | None |

**The response is two-scoped deliberately.** Redis does not report hits and misses per logical
database, and presenting an instance figure as a per-database one would send an operator hunting
a caching bug that does not exist.

---

## `GET /system/queues`

The tracking outbox **and** the assignment backlog, with the platform's own notion of "due".

| | |
|---|---|
| **Permission** | `system.outbox.read` |
| **Parameters** | None |

Sits **beside** `/system/outbox`, not in front of it — see that endpoint.

---

## `GET /system/metrics`

The JSON projection of the platform's Prometheus registry.

| | |
|---|---|
| **Permission** | **`system.metrics.read`** — its own, not `system.health.read`. This carries **per-route request volumes** (order rate, payment rate), which is business information rather than health. Somebody who should see whether Redis is up does not automatically need to see how many orders an hour the platform takes |
| **Parameters** | None |

---

## `GET /system/maintenance`

The maintenance window, if there is one.

| | |
|---|---|
| **Permission** | `system.maintenance.read` |
| **Parameters** | None |

### Response (200)

Reports **`storedMode` and `effectiveMode` separately.** They differ exactly when a window has
passed its expiry — a read path must never write, so an expired window is still *stored* until
something clears it. **Render `effectiveMode`.**

To change it, see [`PUT /dev-tools/maintenance`](dev-tools.md#put-dev-toolsmaintenance).

---

## `GET /system/errors`

The platform error journal, **graded by level inside the handler**.

One route, three answers. The route is reachable by **any** of three permissions, and the
projection decides what comes back. Splitting it into three URLs would make a dashboard choose
based on the administrator's own level — which is exactly what a server should be deciding.

| | |
|---|---|
| **Permission** | **any** of `developer_tools.logs.read` (T1), `system.errors.read` (T2), `support.errors.lookup` (T3) |
| **Not audited** | A `GET`, and diagnostics by nature |

### Query parameters

| Parameter | Type | Notes |
|---|---|---|
| `since` / `until` | ISO-8601 instant with zone | |
| `requestId` | string, 1–200 | |
| `category` | string, 1–40 | One of the [nine categories](errors.md#the-nine-categories) |
| `code` | string, 1–100 | An error code |
| `source` | `ring` \| `persisted` | The in-memory ring buffer, or the durable store |
| `limit` | integer | 1–500 |
| `before` | 24-char id | **A cursor, not an offset** — the capped collection evicts from the front as it is written |

There is deliberately **no `level`** (every error is warn or above) and **no free-text search**
(the two taxonomy filters replace it, as equality matches rather than a regex against an
unindexed collection).

### ⚠️ Support-level queries must be narrow

A tier-3 caller must supply **either a `requestId`, or a `code` *and* a `since`**. Otherwise:

```jsonc
{
  "success": false,
  "requestId": "…",
  "error": {
    "code": "SYSTEM_ERROR_QUERY_TOO_BROAD",
    "message": "Narrow the search: supply a request reference, or an error code with a start date",
    "statusCode": 400,
    "category": "validation"
  }
}
```

**400, not 403** — the caller *holds* the permission and the request is simply too broad. The
remedy is a narrower query, not a different grant.

The projection alone would not make an open feed safe: even the Support view names a route group,
a role and a timestamp for every failure, and a scrollable list of those is a reconnaissance feed
however little each row says.

### Response (200) — the three projections

Every response carries **`view`**, naming which rung answered. That is not decoration: without it
a Support agent reading a thin row cannot tell *"there is nothing more to know"* from *"I am not
being shown it"*, and would escalate a resolved incident.

#### `view: "support"` (tier 3)

```jsonc
{
  "success": true,
  "data": {
    "view": "support",
    "entries": [
      {
        "at": "2026-08-13T09:14:02.331Z",
        "requestId": "8f14c2a0-6b3e-4a91-9c7d-2e5f0a1b3c4d",
        "category": "external_service",
        "code": "PAYMENT_GATEWAY_TIMEOUT",
        "statusCode": 502,
        "method": "POST",
        "routeGroup": "/api/payments",
        "actorRole": "customer",
        "message": "A required dependency is unavailable",
        "hint": "A service we depend on did not respond. Not the caller's fault and not fixable by them — escalate with the reference."
      }
    ]
  }
}
```

`message` is the **client** message — the sentence already shown to that person — never the
internal one. `hint` is the per-category support line from [errors.md](errors.md#support-hints).

Support additionally sees **only rows whose actor was a vendor, agency, agent or customer, or
anonymous traffic**. Administrator-caused errors are invisible to them.

#### `view: "admin"` (tier 2)

Everything above, plus:

| Field | Notes |
|---|---|
| `path` | The full path, not just the route group |
| `actorId` | |
| `errorType` | |
| `masked` | Whether the client message was substituted |
| **`internalMessage`** | The operational diagnosis — **for every category, including the masked ones.** *"What did the payment gateway actually say"* is precisely the question a masked 502 leaves unanswered, and answering it is why this surface exists |
| **`details`** | The **unmasked** details |

Tiers 1 and 2 see **every** error the platform recorded.

#### `view: "developer"` (tier 1)

Everything above, plus `stack`, `causeMessage`, and `raw` — the complete record.

A stack names our files, our functions and our call graph. That is the shape of the codebase
rather than the state of the platform, and it is the one thing a Developer needs that an Admin
does not.

---

## `GET /system/platform/config`

The platform's whitelisted runtime configuration. Its own allowlist lives on its side.

| | |
|---|---|
| **Permission** | `developer_tools.config.read` — **Developer only** |
| **Parameters** | None |

---

## `GET /system/platform/logs`

Search the platform's logs.

| | |
|---|---|
| **Permission** | **`developer_tools.logs.read` — Developer only.** A log line is free text and can carry personal data. A `system.*` name would reach the Admin level through family expansion, and an unfiltered feed of every warning is a broader disclosure than any individual scoped read |
| **Not audited** | A log search is diagnostics and high-volume; auditing it would flood the trail with rows saying nothing about what anybody *did* |

### Query parameters

| Parameter | Type | Notes |
|---|---|---|
| `level` | `trace` \| `debug` \| `info` \| `warn` \| `error` \| `fatal` | |
| `since` / `until` | ISO-8601 instant with zone | |
| `requestId` | string, 1–200 | |
| `q` | string, **1–100** | Free text. **Bounded as a pattern-length defence** — the term is escaped and applied literally, and an unbounded one would be a scan amplifier against a collection with no text index |
| `source` | `ring` \| `persisted` | |
| `limit` | integer | 1–500 |
| `before` | 24-char id | A cursor, not an offset |

### Response (200)

```jsonc
{
  "success": true,
  "data": {
    "sourceUsed": "ring",
    "sourceReason": null,
    "entries": [ /* log lines — see below */ ],
    "nextBefore": "66a1…",
    "meta": {
      "persistence": { "…": "…" },
      "ring": { "…": "…" },
      "warning": "Log lines may contain personal data …"
    }
  }
}
```

`nextBefore` is the cursor for the next page, `null` at the end. **Cursor, not offset, and
correctly so** — the persisted collection is capped and evicts from the front, so an offset
would yield duplicates and gaps.

### The shape of a log entry

A **partial** declaration. Closing the shape would defeat the point of a log; what a reader
needs is to know which keys are guaranteed and that the rest are the writer's own context.

```jsonc
{
  "at": "2026-08-17T09:12:04.000Z",     // always
  "level": "error",                      // always
  "msg": "…",                            // always
  "requestId": "…" | null,
  "err": { "type": "…", "message": "…", "stack": "…" },   // when the line carries an error
  "res": { "statusCode": 500 },                            // when the line closes a request
  "…": "any further keys the writer attached"
}
```

| Key | Guaranteed | Notes |
|---|---|---|
| `at` | ✅ | ISO-8601 instant |
| `level` | ✅ | ⚠️ **The `level` filter is at-or-above**, so `?level=warn` returns `warn`, `error` and `fatal` |
| `msg` | ✅ | |
| `requestId` | — | Present on request-scoped lines; correlates with the `X-Request-Id` a client sent |
| `err` | — | `type`, `message`, `stack` |
| `res` | — | `statusCode` |
| anything else | — | **The writer's context.** Render it raw as text; do not assume a shape |

The same posture the contract takes on unknown enum members: an unrecognised key is data, not
an error.

**Nothing is truncated server-side.** There is no `stateTruncated` equivalent here and none is
needed — a line is stored as the writer emitted it, so a long `err.stack` arrives whole. (Audit
rows *are* truncated, and say so with `stateTruncated`; log lines are not.)

> ### ⚠️ `meta.warning` is load-bearing — render it from `meta`, not from prose
>
> Log lines carry personal data: an email address in an SMTP failure, a phone number in a send
> error. The scrubber removes **credential shapes only** — tokens, keys, passwords — and makes
> no attempt at PII.
>
> It stays on the **response** deliberately, so a client renders the current wording rather than
> a copy of it that drifts. Expanding a row shows strictly more of what the warning is about.

---

## `GET /system/platform/cache/keys`

Key **names**, types and TTLs. **Never values.**

| | |
|---|---|
| **Permission** | **`developer_tools.cache.inspect`** — not `cache.flush`. **Looking is not clearing**, and one permission for both would mean an operator who may inspect may also delete |

### Query parameters

| Parameter | Type | Rules |
|---|---|---|
| `db` | string | **Required.** The database **NAME**, upper-case (e.g. `SLOT_LOCK_DB`) — never its index |
| `prefix` | string, 1–200 | Optional |
| `limit` | integer | 1–500 |
| `withSize` | `"true"` \| `"false"` | |

**Note what is absent relative to the flush endpoint: there is no `confirm`.** Requiring an
operator to type a database name in order to *look* trains reflexive confirmation-typing, which
would hollow out the guard on the path that deletes.

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | `db` given as an index rather than a name |
| 404 | `PLATFORM_OPERATION_REJECTED` | Unknown database name. The platform lists the valid ones |

---

## `GET /system/platform/database`

Collection stats, sizes and index drift.

| | |
|---|---|
| **Permission** | `developer_tools.database.inspect` — Developer only |

### Query parameters

| Parameter | Type | Notes |
|---|---|---|
| `collection` | string or string[] | Optional. Lower-case snake_case names. Repeat the parameter or send an array; it is joined into a comma-separated list |

---

# geo-tracker

**The narrow, service-level exception.** wi-admin has **no data door into geo-tracker**: every
geo-tracker *data* read requires a real platform user JWT and resolves per-agent visibility by
looking that user up — and a wi-admin administrator has no platform user row, deliberately.

These two routes need no identity on geo-tracker's side and expose no agent.

## `GET /system/geo-tracker`

| | |
|---|---|
| **Permission** | `system.health.read` — an Admin on call needs to know whether tracking is up |
| **Parameters** | None |

### Response (200)

```jsonc
{
  "success": true,
  "data": {
    "service": "geo-tracker",
    "configured": true,
    "health":    { "…liveness…": "…" },
    "readiness": { "…readiness…": "…" },
    "note": "Service-level operations reads only — no live position, no trail, no session content. Per-agent reads still require a platform user identity, which an administrator deliberately does not have (ADR-009 D-2)."
  }
}
```

**This route can never fail.** The client cannot throw — making geo-tracker a readiness
dependency of wi-admin would recreate a coupled-failure amplifier. `configured: false` and an
unhealthy report are the two ways it says "no".

---

## `GET /system/geo-tracker/metrics`

| | |
|---|---|
| **Permission** | **`system.metrics.read`** — session and websocket counts are the same business/reconnaissance class that gave the platform's `/metrics` its own permission |
| **Parameters** | None |

---

## What is **not** here

| Missing | Where it is |
|---|---|
| Live agent positions or GPS trails | geo-tracker, behind Tracking Allow. **No door exists from this service** |
| wi-admin's own logs | Not built. `/system/logs` is reserved for it |
| Any write | [`/dev-tools`](dev-tools.md) |
