# `/dev-tools` — the operations writes

**Verified against source on 2026-09-08** — all nine routes, their guards and which three carry the `dev_tools.enabled` gate against `dev-tools/routes/dev-tools.routes.ts` and the live route manifest; every request body — the 10-character `reason` floor, the `workerKey` pattern, the `7`–`365` prune window, `status: "sent"` as a literal, the 1–1440 maintenance bound and both `confirm` echoes — against `dev-tools/validators/dev-tools.validator.ts`; the two-flag catalog against `dev-tools/domain/feature-flag.catalog.ts:40-77`; and the response messages against `dev-tools/controllers/dev-tools.controller.ts:45-140`.

Base path: `/api/v1/dev-tools`

Feature flags, worker triggers, outbox replay and prune, cache flush, and maintenance mode.

**Almost everything here is Developer (tier 1) only**, and every write is audited.

Design records: [`../../docs/ADR-014-SYSTEM-OPERATIONS.md`](../../docs/ADR-014-SYSTEM-OPERATIONS.md),
[`../../docs/ADR-015-DEVELOPER-TOOLS.md`](../../docs/ADR-015-DEVELOPER-TOOLS.md).

| Method | Path | Permission | Behind `dev_tools.enabled` | Audited |
|---|---|---|---|---|
| `GET` | `/dev-tools/feature-flags` | `developer_tools.feature_flags.read` | ❌ | — |
| `PUT` | `/dev-tools/feature-flags/:flag` | `developer_tools.feature_flags.set` | ❌ | ✅ |
| `GET` | `/dev-tools/workers` | `system.workers.read` | ❌ | — |
| `POST` | `/dev-tools/workers/:workerKey/run` | `developer_tools.workers.trigger` | ✅ | ✅ |
| `POST` | `/dev-tools/outbox/replay` | `developer_tools.outbox.replay` | ✅ | ✅ |
| `POST` | `/dev-tools/outbox/prune` | `developer_tools.outbox.prune` | ✅ | ✅ |
| `POST` | `/dev-tools/catalogue/vectorise` | `developer_tools.catalogue.vectorise` | ✅ | ✅ |
| `PUT` | `/dev-tools/maintenance` | `developer_tools.maintenance.set` | ❌ | ✅ |
| `POST` | `/dev-tools/cache/flush` | `developer_tools.cache.flush` | ✅ | ✅ |

---

## Two gates, and they answer different questions

| Gate | Question | Default |
|---|---|---|
| **The permission** | May *this person*? | `developer_tools.*` is tier 1 only, enforced by a boot assertion, and can never be swept in by a family grant |
| **The `dev_tools.enabled` flag** | Is the *service* accepting these right now? | **OFF** |

Every tool re-runs a side effect against live data, and the safe resting state for that is off. A
capability available merely because it was built is one that gets used during an incident by
somebody guessing.

When the flag is off:

```jsonc
{
  "success": false,
  "requestId": "…",
  "error": {
    "code": "DEV_TOOLS_DISABLED",
    "message": "Developer tools are switched off",
    "statusCode": 409,
    "category": "business_rule"
  }
}
```

**409, not 403** — you *hold* the permission and the service is refusing right now. A 403 would
send an administrator to look at their own grants, which is the wrong place.

### The three carve-outs

| Route | Why it is not behind the flag |
|---|---|
| `GET /feature-flags`, `PUT /feature-flags/:flag` | **This is how you turn the flag on.** A switch that turns off its own switch is a trap |
| `PUT /maintenance` | Every other tool re-runs a side effect; this one **refuses traffic**, and it is the only one whose failure mode is losing the ability to undo it. With the flag applied, an operator could not enter maintenance during an incident without first flipping an unrelated switch — and if anybody turned `dev_tools.enabled` off mid-window, **the exit would be locked** |
| `GET /workers` | A read. Knowing which workers exist is not running one |

The permission and the audit row still apply to all three. Only the flag is dropped.

---

## `GET /dev-tools/feature-flags`

| | |
|---|---|
| **Permission** | `developer_tools.feature_flags.read` — Developer only |
| **Parameters** | None |
| **Pagination** | None — the catalog is small and closed |

### Response (200)

```jsonc
{
  "success": true,
  "data": {
    "flags": [
      {
        "name": "audit.route_probe",
        "enabled": true,
        "default": true,
        "consumer": "api/route-manifest.ts",
        "summary": "Warn when a route succeeds without recording the action it declares"
      },

      {
        "name": "dev_tools.enabled",
        "enabled": false,
        "default": false,
        "consumer": "modules/dev-tools/gateways/dev-tools.gateway.ts",
        "summary": "Allow the developer tools to run workers, replay outbox rows and rebuild search vectors"
      }
    ]
  }
}
```

**The flag catalog is closed.** A flag with no consumer stops the service from booting.

---

## `PUT /dev-tools/feature-flags/:flag`

| | |
|---|---|
| **Permission** | `developer_tools.feature_flags.set` — Developer only, `destructive` |

### Path parameters

| Parameter | Type | Rules |
|---|---|---|
| `flag` | enum | **Pinned** to the catalog. A typo is a `400` naming the valid values, rather than an upsert that silently creates a flag nothing reads |

### Request body

| Field | Type | Rules |
|---|---|---|
| `enabled` | boolean | Required |
| `reason` | string | **Required, 10–500 characters.** A flag flipped with no stated reason is a mystery to whoever finds it weeks later, and this row is the only place that context can live. Ten characters refuses "test" and "x" without demanding an essay |

```json
{ "enabled": true, "reason": "Enabling dev tools to replay the outbox after the 13/08 outage" }
```

### Response (200)

```jsonc
{
  "success": true,
  "data": { "name": "dev_tools.enabled", "enabled": true, "…": "…" },
  "message": "\"dev_tools.enabled\" is now on on this instance. Other instances converge within the flag cache TTL."
}
```

> **⚠️ The change is not instant across the fleet.** The message says so on the wire, not just
> in a docstring — an administrator turning something off during an incident must know the other
> instances have not caught up yet. **Show the message.**

### Audit

`developer_tools.feature_flags.set`

---

## `GET /dev-tools/workers`

| | |
|---|---|
| **Permission** | **`system.workers.read`**, not a `developer_tools.*` one — the answer is operational information rather than a capability |
| **Parameters** | None |

**This returns a narrower legacy shape** — four fields and a single `running` flag that conflates
three conditions — kept for existing callers. **Prefer
[`GET /system/workers`](system.md#get-systemworkers)**, which returns all twelve workers with
three distinct booleans, structured schedules and the master switch.

---

## `POST /dev-tools/workers/:workerKey/run`

Run a background worker immediately, **against live data**.

| | |
|---|---|
| **Permission** | `developer_tools.workers.trigger` — Developer only, `destructive` |
| **Flag** | Behind `dev_tools.enabled` |
| **Request body** | None |

### Path parameters

| Parameter | Type | Rules |
|---|---|---|
| `workerKey` | string, 1–64 | `^[a-z][a-z0-9-]*$`. **Not pinned to a list** — the registry lives in the platform, and duplicating its keys here would drift the moment a worker is added or renamed |

### Response (200)

```json
{
  "success": true,
  "data": { "worker": "cod-discrepancy-sweep", "durationMs": 4182, "…": "…" },
  "message": "Ran \"cod-discrepancy-sweep\" in 4182ms"
}
```

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Malformed key |
| 404 | `PLATFORM_OPERATION_REJECTED`, `details.platformCode: "DEV_TOOLS_WORKER_UNKNOWN"` | Not in the registry. The platform's answer lists the valid keys |
| 409 | `DEV_TOOLS_DISABLED` | The flag is off |
| **409** | **`PLATFORM_OPERATION_REJECTED`, `details.platformCode: "DEV_TOOLS_WORKER_BUSY"`** | **Already running.** Not queued — two concurrent passes of a sweep is exactly what the mutex prevents |
| 502 / 503 | `SERVICE_DEPENDENCY_UNAVAILABLE` | |

Both worker outcomes are the platform's verdicts, so they arrive as `details.platformCode` on a
forwarded rejection rather than as `error.code`. **Branch on `details.platformCode`.**

### Audit

`developer_tools.workers.trigger`

---

## `POST /dev-tools/outbox/replay`

Re-send outbound events. **Downstream services will see them a second time.**

| | |
|---|---|
| **Permission** | `developer_tools.outbox.replay` — Developer only, `destructive` |
| **Flag** | Behind `dev_tools.enabled` |

### Request body

| Field | Type | Rules |
|---|---|---|
| `limit` | integer | Optional, 1–1000 |
| `eventIds` | string[] | Optional, 1–1000 entries. Specific rows, when an operator knows which |

**Omitting `eventIds` means "the oldest failed rows up to `limit`"** — the common case after an
outage.

```json
{ "limit": 50 }
```

### Response (200)

```json
{ "success": true, "data": { "replayed": 4, "…": "…" }, "message": "4 outbox row(s) queued for redelivery" }
```

Find the rows first with [`GET /system/outbox`](system.md#get-systemoutbox).

### Audit

`developer_tools.outbox.replay`

---

## `POST /dev-tools/outbox/prune`

Permanently delete **delivered** outbound events past a retention age.

| | |
|---|---|
| **Permission** | `developer_tools.outbox.prune` — Developer only, `destructive` |
| **Flag** | Behind `dev_tools.enabled` |

### Request body

| Field | Type | Rules |
|---|---|---|
| `olderThanDays` | integer | **Required.** `7`–`365`. The 7-day floor is the platform's and is repeated here so the refusal arrives before the network hop |
| `status` | **the literal `"sent"`** | Required. **Not an enum with three members** — pruning `failed` destroys the input to `outbox/replay`, and pruning `pending` destroys undelivered events. A field that *could* take another value is one somebody eventually passes another value to |
| `limit` | integer | Optional, 1–50 000 |
| `dryRun` | boolean | Optional. **Defaults to `true` on the platform's side** |
| `confirm` | string | **Required. Must repeat `olderThanDays`** — the age is what decides the blast radius |

```json
{ "olderThanDays": 30, "status": "sent", "confirm": "30", "dryRun": false }
```

### Response (200)

```jsonc
{
  "success": true,
  "data": { "matched": 412088, "deleted": 0, "olderThanDays": 30, "dryRun": true, "truncated": false },
  "message": "DRY RUN — 412088 delivered row(s) older than 30 days matched; nothing was deleted"
}
```

> **The message leads with the dry-run state, and that is deliberate.** An operator who cannot
> tell at a glance whether anything was deleted will assume the worse of the two and act on that
> assumption. **Show the message verbatim.**

When `truncated: true`, the limit was reached — the message says so and the run must be repeated.

### Audit

`developer_tools.outbox.prune` — the counts and cutoff land in the row.

---

## `POST /dev-tools/catalogue/vectorise`

Rebuild search vectors for the **entire** product catalogue.

| | |
|---|---|
| **Permission** | `developer_tools.catalogue.vectorise` — Developer only, `destructive` |
| **Flag** | Behind `dev_tools.enabled` |
| **Request body** | None |
| **Response** | The platform's result, message `"Catalogue search vectors rebuilt"` |

### Audit

`developer_tools.catalogue.vectorise`

---

## `PUT /dev-tools/maintenance`

Put the platform into or out of a maintenance window.

**The single most consequential thing an operator can do to this platform.**

| | |
|---|---|
| **Permission** | `developer_tools.maintenance.set` — Developer only, `destructive` |
| **Flag** | **Not behind `dev_tools.enabled`** — see the carve-outs above |

### Request body

| Field | Type | Rules |
|---|---|---|
| `mode` | `off` \| `readonly` \| `down` | Required |
| `reason` | string, 8–500 | **Required for anything but `off`.** This string is shown to **every refused caller** in the 503 body *and* recorded in the audit row. A window with no stated reason is the one nobody else can confidently end |
| `expiresInMinutes` | integer | Optional, **1–1440 (24 h)**. An unbounded window is the one everybody forgets is open |
| `blockWebhooks` | boolean | Optional |
| `pauseWorkers` | boolean | Optional |

```json
{
  "mode": "readonly",
  "reason": "Migrating the orders collection index — writes paused",
  "expiresInMinutes": 45,
  "pauseWorkers": true
}
```

### Modes

| Mode | Effect |
|---|---|
| `off` | Normal service |
| `readonly` | Writes refused, reads served |
| `down` | **All traffic refused** |

### ⚠️ Exemptions that survive every mode

Two path groups stay reachable in **every** mode, and they are cross-service:

- **`/api/internal/agents/*`**
- **`/api/tracking/*`**

Both are read-only verdicts geo-tracker depends on. Blocking them means geo-tracker cannot answer
*"may this viewer track this agent"*, so every live subscription fails authorization and every
watcher is dropped — **a maintenance window would become a geo-tracker outage.**

### Response (200)

```jsonc
{
  "success": true,
  "data": { "mode": "readonly", "previousMode": "off", "changed": true, "convergenceSeconds": 30, "…": "…" },
  "message": "Platform maintenance is now \"readonly\" (was \"off\"). Other jovi-mall instances converge within 30s."
}
```

When nothing changed: `"Platform maintenance was already \"readonly\"."`

**Show the convergence window.** An administrator opening a window during an incident must know
the other instances have not caught up yet.

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Missing reason for a non-`off` mode, `expiresInMinutes` over 1440 |
| 502 / 503 | `SERVICE_DEPENDENCY_UNAVAILABLE` | |

Read the current state at [`GET /system/maintenance`](system.md#get-systemmaintenance).

### Audit

`developer_tools.maintenance.set`

---

## `POST /dev-tools/cache/flush`

Delete cached keys from a named Redis database on the platform.

| | |
|---|---|
| **Permission** | `developer_tools.cache.flush` — Developer only, `destructive` |
| **Flag** | Behind `dev_tools.enabled` |

The asymmetry with `maintenance` is deliberate: an operator who cannot flush a cache is
inconvenienced; an operator who cannot exit a maintenance window is stuck.

### Request body

| Field | Type | Rules |
|---|---|---|
| `db` | string | **Required.** The database **NAME**, upper-case (e.g. `SLOT_LOCK_DB`) — never its index |
| `prefix` | string, 1–200 | Optional. Without it, the whole database |
| `limit` | integer | Optional, 1–10 000 |
| `dryRun` | boolean | Optional. **Defaults to `true` on the platform's side** |
| `confirm` | string | **Required. Must repeat `db`** |

```json
{ "db": "PRODUCT_CACHE_DB", "prefix": "product:", "confirm": "PRODUCT_CACHE_DB", "dryRun": false }
```

**The platform refuses a whole-database flush on the three databases whose keys are load-bearing
for correctness or for money.** Its blast-radius note comes back in the response and lands in the
audit row.

### Response (200)

```jsonc
{
  "success": true,
  "data": { "constant": "PRODUCT_CACHE_DB", "matched": 8412, "deleted": 0,
            "dryRun": true, "truncated": false, "cursor": null, "…": "…" },
  "message": "DRY RUN — 8412 key(s) matched in PRODUCT_CACHE_DB; nothing was deleted"
}
```

> **`dryRun` defaults to TRUE.** A first call reports what *would* go and deletes nothing.
> Somebody expecting a flush needs to see that it did not happen — which is why the message leads
> with it.

When `truncated: true` the scan stopped at a bound; the message carries the cursor to resume
from. **A partial scan that read as "done" would be the worst possible outcome here.**

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | `db` as an index rather than a name, missing `confirm` |
| 400 / 409 | `PLATFORM_OPERATION_REJECTED` | `confirm` does not match, or a protected database |
| 404 | `PLATFORM_OPERATION_REJECTED` | Unknown database name. The platform lists the valid ones |
| 409 | `DEV_TOOLS_DISABLED` | |
| 502 / 503 | `SERVICE_DEPENDENCY_UNAVAILABLE` | |

### Audit

`developer_tools.cache.flush`

---

## What is deliberately **not** here

### `POST /webhooks/redeliver`

The permission `developer_tools.webhooks.redeliver` exists in the catalog with **no route**.

Every webhook mount in the platform is **inbound**; nothing records an outbound delivery, so
there is no subject to redeliver. The permission stays catalogued, naming its missing
prerequisite. **Writing an endpoint for it would be worse than the gap.**

For outbound events that failed, use
[`POST /dev-tools/outbox/replay`](#post-dev-toolsoutboxreplay).

---

## Where the platform logs live

**Not on this mount.** `GET /system/platform/logs` is under `/system`, and the split is the one
this document opens with: read-only diagnostics and dangerous operations are different mounts
with different permissions, so a route cannot drift from one category into the other by being
added to the wrong file. A log search reads and re-runs nothing.

It is documented in full — the query, the cursor, **the shape of a log entry**, whether
anything is truncated, and the load-bearing `meta.warning` — under
[`GET /system/platform/logs`](system.md).

The short version, for a reader who arrived here looking for it:

| | |
|---|---|
| **Permission** | `developer_tools.logs.read` — **Developer only** |
| **Guaranteed keys** | `at`, `level`, `msg`. Everything else is the writer's context and is rendered raw |
| **`level`** | Filters **at or above** the named level |
| **Truncation** | None. A line is stored as the writer emitted it |
| **`meta.warning`** | Stays on the response. Log lines carry personal data; the scrubber removes credential *shapes* only |
