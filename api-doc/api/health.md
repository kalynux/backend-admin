# Health probes

**Verified against source on 2026-09-08** — both routes, the readiness rule (three required dependencies, `joviMall` reported but not required), the dependency report shape and the pre-limiter mount, against `admin/src/api/routes/health.routes.ts` and `admin/src/app.ts:127,130`.

**Mounted unversioned at `/health`** — a probe URL is infrastructure, not part of the
dashboard's API contract, and must not move when `/api/v1` becomes `/api/v2`.

Both routes are mounted **before** the rate limiter and are never throttled: a burst of real
traffic tripping the limiter would fail the readiness check and pull a healthy instance out of
rotation, turning load into an outage.

Neither route requires authentication, a permission, or CSRF. Neither is audited. Neither
paginates.

For the rich, authenticated operations view — dependency detail, worker state, queue depth,
metrics — use [`/api/v1/system/*`](system.md) instead.

---

## `GET /health/live`

Is the process alive? **Never checks a dependency.** An orchestrator kills and restarts on a
failing liveness probe, and restarting this service does not fix someone else's database — a
dependency outage must not become a restart loop.

| | |
|---|---|
| **Method / Path** | `GET /health/live` |
| **Authentication** | None |
| **Permission** | None |
| **Parameters** | None |
| **Request body** | None |
| **Status** | Always `200` |

### Response

```jsonc
{
  "success": true,
  "data": {
    "status": "alive",
    "service": "wi-admin",
    "uptimeSeconds": 84213,
    "timestamp": "2026-08-13T09:14:02.331Z"
  }
}
```

| Field | Type | Notes |
|---|---|---|
| `status` | `"alive"` | Constant |
| `service` | string | Always `"wi-admin"` |
| `uptimeSeconds` | integer | Process uptime, rounded |
| `timestamp` | ISO-8601 | Server time at the probe |

### Errors

None. If the process cannot answer, there is no response — which is the signal.

---

## `GET /health/ready`

Should traffic be routed here? Probes every dependency **in parallel** — a slow check must not
serialise the rest.

| | |
|---|---|
| **Method / Path** | `GET /health/ready` |
| **Authentication** | None |
| **Permission** | None |
| **Parameters** | None |
| **Request body** | None |
| **Status** | `200` when ready, **`503`** when not |

### Readiness rule

Three dependencies are **required**: `mongoPlatform`, `mongoAdmin`, `redis`. All three must
report `up`.

`joviMall` is reported but **not** required — `not_configured` is a valid steady state (local
development with no platform URL set), and the platform being down does not make this instance
unable to serve reads.

### Response — ready

```jsonc
{
  "success": true,
  "data": {
    "status": "ready",
    "service": "wi-admin",
    "dependencies": {
      "mongoPlatform": { "status": "up", "durationMs": 4,  "database": "jovi_mall" },
      "mongoAdmin":    { "status": "up", "durationMs": 3,  "database": "wi_admin" },
      "redis":         { "status": "up", "durationMs": 1 },
      "joviMall":      { "status": "up", "durationMs": 27 }
    },
    "timestamp": "2026-08-13T09:14:02.331Z"
  }
}
```

### Response — not ready (HTTP 503)

Note that `success` is `false` while the body is still the readiness report, **not** the error
envelope. This route predates and deliberately sits outside the `/api/v1` error contract.

```jsonc
{
  "success": false,
  "data": {
    "status": "not_ready",
    "service": "wi-admin",
    "dependencies": {
      "mongoPlatform": { "status": "up",   "durationMs": 5, "database": "jovi_mall" },
      "mongoAdmin":    { "status": "down", "durationMs": 2001, "database": null,
                         "error": "Server selection timed out after 2000 ms" },
      "redis":         { "status": "up",   "durationMs": 1 },
      "joviMall":      { "status": "not_configured", "durationMs": 0 }
    },
    "timestamp": "2026-08-13T09:14:02.331Z"
  }
}
```

### Dependency report shape

| Field | Type | Notes |
|---|---|---|
| `status` | `"up"` \| `"down"` \| `"not_configured"` | `not_configured` only occurs for `joviMall` |
| `durationMs` | integer | How long the probe took |
| `database` | string \| null | **Mongo entries only.** The database actually reached, so a misconfigured URI is visible rather than merely "up" |
| `error` | string | Present only on failure |

### Errors

None as an error envelope. A dependency failure is reported as `503` with the body above.

---

## A cross-service note

jovi-mall's `GET /api/health` is a **frozen contract** for the opposite reason: geo-tracker
registers it as a *readiness* checker and treats any status ≥ 300 as an error, so putting
readiness semantics (or a rate limit) on that path would kill every live geo-tracker tracking
session for a fault in a different, healthy service.

wi-admin's `/health/ready` is deliberately **not** a dependency of any other service, and
wi-admin's own geo-tracker client can never throw — making geo-tracker a readiness dependency
of wi-admin would recreate the same coupled-failure amplifier in the opposite direction.
See [`../../docs/ADR-014-SYSTEM-OPERATIONS.md`](../../docs/ADR-014-SYSTEM-OPERATIONS.md) D-1 and
[`../../docs/ADR-015-DEVELOPER-TOOLS.md`](../../docs/ADR-015-DEVELOPER-TOOLS.md) D-5.
