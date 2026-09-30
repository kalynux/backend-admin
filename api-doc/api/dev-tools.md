# `/dev-tools` — the operations writes

**Verified against source on 2026-09-08** — all nine routes, their guards and which three carry the `dev_tools.enabled` gate against `dev-tools/routes/dev-tools.routes.ts` and the live route manifest; every request body — the 10-character `reason` floor, the `workerKey` pattern, the `7`–`365` prune window, `status: "sent"` as a literal, the 1–1440 maintenance bound and both `confirm` echoes — against `dev-tools/validators/dev-tools.validator.ts`; the two-flag catalog against `dev-tools/domain/feature-flag.catalog.ts:40-77`; and the response messages against `dev-tools/controllers/dev-tools.controller.ts:45-140`.

Base path: `/api/v1/dev-tools`

**2026-09-30:** the two `/dev-tools/payments` rows and their section were added against source (jovi-mall ADR-A08). The stamp above covers the other nine.

Feature flags, worker triggers, outbox replay and prune, cache flush, maintenance mode, and the payment-routing switch.

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
| `GET` | `/dev-tools/payments` | `developer_tools.payments.read` | ❌ | — |
| `PUT` | `/dev-tools/payments` | `developer_tools.payments.set` | ❌ | ✅ |

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

### The four carve-outs

| Route | Why it is not behind the flag |
|---|---|
| `GET /feature-flags`, `PUT /feature-flags/:flag` | **This is how you turn the flag on.** A switch that turns off its own switch is a trap |
| `PUT /maintenance` | Every other tool re-runs a side effect; this one **refuses traffic**, and it is the only one whose failure mode is losing the ability to undo it. With the flag applied, an operator could not enter maintenance during an incident without first flipping an unrelated switch — and if anybody turned `dev_tools.enabled` off mid-window, **the exit would be locked** |
| `GET /workers` | A read. Knowing which workers exist is not running one |
| `GET /payments`, `PUT /payments` | **The manual failover switch for an aggregator outage** (jovi-mall ADR-A08, owner decision 5). Maintenance's argument applied to money: during an outage nobody should first have to find and flip an unrelated flag, and a flag turned off would lock the platform onto a dead aggregator |

The permission and the audit row still apply to all four. Only the flag is dropped.

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

## `GET /dev-tools/payments`

Which aggregator collects and which pays out, what each one can do, and how each has been doing.
**The one administrator surface that names aggregators**. The public
`/api/payments/options` never does.

| | |
|---|---|
| **Permission** | `developer_tools.payments.read`, Developer only |
| **Flag** | **Not behind `dev_tools.enabled`**. See the carve-outs above |
| **Query** | `window`: `24h` (default) or `7d`. Any other value is a `400` |

### Response (200)

```jsonc
{
  "success": true,
  "data": {
    "platformSupported": true,
    "settings": {
      "collectionAggregator": "NOTCHPAY",
      "payoutAggregator": "NOTCHPAY",
      "stripeEnabled": false,
      "providers": { "MTN": { "enabled": true }, "ORANGE": { "enabled": true }, "MOOV": { "enabled": false }, "CARD": { "enabled": false } },
      "version": 3,
      "updatedAt": "2026-09-30T10:00:00.000Z",
      "updatedBy": { "id": "…", "name": "…" },
      "reason": "…"
    },
    "aggregators": [
      { "name": "NOTCHPAY", "configured": true, "capabilities": { "…": "…" }, "payoutImplemented": true,
        "payoutAvailable": true, "refundAvailable": true, "activeForCollections": true, "activeForPayouts": true }
    ],
    "effectiveProviders": { "…": "jovi-mall's shape, passed through" },
    "errors": [],
    "warnings": [ { "code": "PROVIDER_UNROUTABLE", "message": "…", "provider": "MOOV" } ],
    "stats": {
      "window": "24h",
      "since": "2026-09-29T12:00:00.000Z",
      "stuckPendingAfterMinutes": 30,
      "gateways": [
        {
          "gateway": "NOTCHPAY",
          "total": 412, "succeeded": 371, "failed": 22, "pending": 19, "stuckPending": 4,
          "successRate": 0.944,
          "lastSuccessAt": "2026-09-30T11:58:12.000Z",
          "sources": [
            { "source": "payments", "total": 380, "succeeded": 344, "failed": 20, "pending": 16, "stuckPending": 3,
              "settleP50Seconds": 41, "settleP90Seconds": 118, "lastSuccessAt": "2026-09-30T11:58:12.000Z" },
            { "source": "credit_topups", "…": "…" }
          ]
        }
      ]
    }
  }
}
```

`settings`, `aggregators`, `effectiveProviders` and `warnings` come from jovi-mall
(`jovi-mall/api-doc/payments/routing.md` § Administrator surface) and are passed through. `stats`
is computed here, directly on `payment_transactions`, `plan_purchases` and `credit_topups`.

| Field | Notes |
|---|---|
| **`platformSupported`** | **`false` when jovi-mall predates payment routing.** `settings` is then `null`, `aggregators` and `warnings` are empty, and `stats` is still filled in. **Render this as "deploy jovi-mall first", never as an empty configuration** |
| **`errors`** | **Payments are broken NOW.** The stored settings break a **hard** rule, for example `COLLECTION_AGGREGATOR_NOT_CONFIGURED` after the active aggregator's key was removed. New charges are being refused. **Show it as a red "payments are broken" banner, not as a note.** Computed by jovi-mall when you read. Always present, and `[]` when nothing is broken (also against a jovi-mall older than the split) |
| `warnings` | Soft problems on a stored state that is otherwise valid, for example `PAYOUT_UNAVAILABLE` on settings nobody touched, since payout availability changes at runtime. These are the **standing** problems, not the warnings from the last write. `[]` while `errors` is non-empty: nothing soft matters until the hard problem is fixed |
| `errors[].code`, `warnings[].code` | **An open list.** Show `code` and `message` as given and never switch on a fixed set. jovi-mall adds rules (`NO_MOBILE_PROVIDER_ENABLED` arrived during the build) |
| `successRate` | `succeeded ÷ (succeeded + failed)`, over **decided** rows only. Pending rows are left out, because a burst of charges still waiting on customers' phones is not a failure yet. **`null` when nothing was decided**, which is different from `0` |
| `stuckPending` | Pending **and** created more than 30 minutes ago: a settlement that never arrived. A subset of `pending` |
| `sources[]` | One row per collection. Settle-time percentiles are **per source only**, because they cannot be merged, and because an aggregator failing only on billing is a real, separate fault |
| `settleP50Seconds` / `settleP90Seconds` | From creation to settlement, over succeeded rows that have a settlement stamp. Approximate. `null` when there are none |
| `lastSuccessAt` | The latest settlement **in the window**. `null` means none in the window, **not** "never" |

How statuses are counted: `REFUNDED` and `reversed` count as **succeeded**, because the money
arrived. `CANCELLED` counts as **failed**. `INITIATED` and `PENDING` count as **pending**. Billing
rows that never chose a gateway are left out.

⚠ The `plan_purchases` and `credit_topups` windows are **collection scans**, since those tables
are indexed by owner only. That is fine at today's volume, and not fixed here because indexes
belong to jovi-mall.

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | `window` is not `24h` or `7d` |
| 502 / 503 | `SERVICE_DEPENDENCY_UNAVAILABLE` | jovi-mall is unreachable or failed. **The whole read fails**, and no partial screen is shown: switching on the stats alone would mean deciding on half the picture |

---

## `PUT /dev-tools/payments`

The manual failover switch: the collection aggregator, the payout aggregator, Stripe, and which
providers are offered.

| | |
|---|---|
| **Permission** | `developer_tools.payments.set`, Developer only, `destructive` |
| **Flag** | **Not behind `dev_tools.enabled`**. See the carve-outs above |

It changes only **new** charges and payouts. A charge that is already open, and a payout already
attempted, keep the gateway stored on their row. So a switch strands nothing that is in flight.

### Request body (`.strict()`)

| Field | Type | Rules |
|---|---|---|
| `collectionAggregator` | string | Optional. An uppercase **name**, e.g. `MYCOOLPAY`. Not pinned to a list here, so a new aggregator works the day jovi-mall ships it. jovi-mall refuses unknown ones |
| `payoutAggregator` | string | Optional. Same rules |
| `stripeEnabled` | boolean | Optional. Stripe's own switch, independent of the collection aggregator |
| `providers` | `{ [NAME]: { enabled: boolean } }` | Optional and **partial**, merged per provider |
| `expectedVersion` | integer ≥ 0 | **Required.** The `settings.version` you read. Send `0` when no document exists yet. If it no longer matches, the answer is `409`: reload and decide again |
| `reason` | string, 10–500 | **Required.** Recorded on the settings document and in the audit row |

Any other key is a `400`, including an old client's `gateway`, and a misspelt field that a lax
schema would drop, leaving a `200` that switched nothing.

```json
{ "collectionAggregator": "MYCOOLPAY", "expectedVersion": 3, "reason": "NotchPay refusing pushes since 14:02" }
```

### Response (200)

```jsonc
{
  "success": true,
  "data": {
    "previous": { "collectionAggregator": "NOTCHPAY", "…": "the settings view before" },
    "settings": { "collectionAggregator": "MYCOOLPAY", "version": 4, "…": "the settings view after" },
    "changed": ["collectionAggregator"],
    "warnings": [ { "code": "PAYOUT_UNAVAILABLE", "message": "…", "aggregator": "NOTCHPAY" } ],
    "convergenceSeconds": 5
  },
  "message": "Payment routing updated (collectionAggregator). Collections: MYCOOLPAY, payouts: NOTCHPAY. Other jovi-mall instances converge within 5s. 1 warning(s) — read them before leaving this screen."
}
```

- **`changed: []`** means nothing changed. The message then says so, and does not say "switched".
- **`warnings`** are soft rules. The write **was accepted**. Show every one of them.
- **Show `convergenceSeconds`.** Other instances follow within that window, so traffic in the first
  few seconds may still go to the previous aggregator.

### Errors

| Status | Code | `details.platformCode` | When |
|---|---|---|---|
| 400 | `VALIDATION_ERROR` | — | An unknown key, a lowercase name, a missing `expectedVersion`, or a `reason` under 10 characters |
| 409 | `PLATFORM_OPERATION_REJECTED` | `PAYMENT_SETTINGS_VERSION_CONFLICT` | Somebody else switched first. Reload, look again, then decide |
| 422 | `PLATFORM_OPERATION_REJECTED` | `PAYMENT_SETTINGS_INVALID` | A hard rule was broken. **`details.errors[]`** lists them as `{code, message, provider?, aggregator?}`. Treat the codes as an **open list**. Nothing was written |
| 422 | `PLATFORM_OPERATION_REJECTED` | `NOT_FOUND` (with `platformSupported: false`) | **jovi-mall predates payment routing. Deploy jovi-mall first.** Nothing was switched. It is `422` rather than `503` on purpose: a `503`'s message is replaced at the error boundary with "a dependency is unavailable", which would send an operator to check whether jovi-mall is up when it is only older |
| 502 / 503 | `SERVICE_DEPENDENCY_UNAVAILABLE` | — | jovi-mall is unreachable |

### Audit

`developer_tools.payments.set`, target type `payment_settings`, **fail-closed**: if the intent row
cannot be written, the switch does not happen. The row's `before` / `after` are jovi-mall's own
`previous` / `settings` from the compare-and-set, never a separate read first, which would race a
second operator. `after` also carries `changed`, `warnings` and `convergenceSeconds`. A refused
switch leaves the row at `failed`, with the refusal as the outcome.

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
