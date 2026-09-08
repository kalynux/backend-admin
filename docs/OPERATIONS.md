# wi-admin — operations

**Verified against source on 2026-09-08** — the scheduled work (`grep -rn 'setInterval' src/` — one),
the environment surface (`src/config/env.ts` plus a scan of `src/` for call-site reads), the two
geo-tracker clients, and the `/dev-tools` and `/system` mounts against the live route manifest and
`npm run authz:matrix`. **Three sections carried false claims** and each is corrected in place with
the measurement: § 1 listed a dangling-intent sweep that does not exist, § 3 undercounted the
environment by six and denied a call-site read that happens four times, and § 7 called the
dev-tools mount uniformly tier-1 and uniformly audited when it is neither.

Read from source 2026-09-06: `src/lifecycle.ts`, `src/config/env.ts`, `src/infra/geo/`,
`src/modules/notifications/domain/notification.scheduler.ts`, `src/api/routes/health.routes.ts`.

Deployment, rollback and secret rotation are **not** here — they span all three services and live in
[`../../docs/RUNBOOK.md`](../../docs/RUNBOOK.md).

---

## 1 · Background work — exactly one scheduled job

wi-admin has **no worker fleet**. Compared with jovi-mall's **nineteen** (18 triggerable in
`WORKER_REGISTRY` plus the observable `inbound-calendar-sync`, re-counted 2026-09-08), that is the
honest shape of a service that owns almost no domain: there is nothing here to sweep.

**There is one `setInterval` in the whole service** (`grep -rn 'setInterval' src/`), and the other
two things this page used to call "sweeps" are not scheduled at all:

| Job | What | When it runs |
|---|---|---|
| **notification projector** | sweeps for things worth telling an administrator, writes `admin_notifications` | **Scheduled** — `setInterval`, `ADMIN_NOTIFICATIONS_SWEEP_S` (30 s). `0` disables it |
| **approval expiry** | expires four-eyes requests past `ADMIN_APPROVAL_TTL_S` (24 h) | **On a read, not on a clock.** All three approval readers call `expireOverdue()` first; it is throttled to one sweep per `ADMIN_APPROVAL_SWEEP_MIN_INTERVAL_MS` (10 s) and bounded at `EXPIRY_SWEEP_BATCH` = 50 rows per call. ⚠ **Nothing expires while nobody reads the queue** — and that is safe only because `assertDecidable` compares `expires_at` against the clock, so the sweep is bookkeeping and not the enforcement |
| ~~audit dangling-intent sweep~~ | — | ⛔ **No such job exists.** See below |

> ⛔ **Corrected 2026-09-08. This table listed an "audit dangling-intent sweep" that "closes intents
> whose outcome never arrived", on a 300-second cadence. All three claims are false.**
> `ADMIN_AUDIT_DANGLING_INTENT_S` is a **classification cutoff**, not a cadence
> (`audit/domain/audit-retention.ts:52-55`), and its only consumer is
> `GET /api/v1/system/health`, which **counts** rows still at `attempted` older than the cutoff and
> caps the count at 100 (`system/controllers/system.controller.ts:77-85`).
> **`findDanglingIntents` has exactly one caller and it is that read.** Nothing closes a dangling
> intent; ADR-002 D4-a's position is that the row is *"itself a useful signal"*, resolved by
> grepping the other service for its `correlation_id`. A reader who believed this row would wait
> for a reconciliation that never happens.

⚠ **`setInterval` fires on a wall clock, not on completion.** A tick slower than its own period
would stack, so the projector is explicitly built as an interval **that cannot overlap itself and
that stops on drain**. jovi-mall solves the same hazard with a Redis lock because it has eighteen
workers and more than one instance; here it is solved by construction, and that difference is worth
knowing before adding a second job.

⚠ **The projector starts AFTER the port binds**, deliberately. It is best-effort background work
whose failure must never stop the service from serving — starting it earlier would put a
**cross-database sweep on the critical path of becoming healthy.**

Throughput bounds: `ADMIN_NOTIFICATIONS_BATCH` (200) and `ADMIN_NOTIFICATIONS_MAX_PER_TICK` (25).
Lifecycle bounds: `_AUTO_ARCHIVE_DAYS` (90) and `_RETENTION_DAYS` (30).

---

## 2 · External services — three clients, none of which may ever throw

| Client | Talks to | Base URL | Credential | Optional? |
|---|---|---|---|---|
| `platform.client.ts` | jovi-mall `/api/internal/admin/*` | `JOVI_MALL_BASE_URL` | `JOVI_MALL_SERVICE_TOKEN` | yes |
| `geo-tracker.client.ts` | geo-tracker **operations** | `GEO_TRACKER_OPS_BASE_URL` | **none** | yes |
| `geo-tracker-data.client.ts` | geo-tracker **data** | `GEO_TRACKER_DATA_BASE_URL` | `GEO_TRACKER_ADMIN_TOKEN` | yes |

Plus **storage configuration**, which is not a client at all and is the subtler entry — see § 4.

### The two geo-tracker doors, and why they are two files

| | operations door (ADR-015 D-5) | data door (ADR-020) |
|---|---|---|
| paths | `/healthz`, `/readyz`, `/metrics` — a **closed literal set** | `/internal/*` — four scoped reads |
| identity | none | a **service** token + advisory `X-Admin-Actor` |
| exposes | a literal `ok`, a dependency map, aggregate counters | presence, position, trail, events |
| surfaced at | `GET /api/v1/system/geo-tracker[/metrics]` | the tracking reads |

⛔ **Folding them into one client would put a data call one typo away from being made with no
credential, and an ops call one typo away from carrying one.** The two base-URL variables are also
the lever that lets a deployment take the operations reads and **open no data door at all**.

⛔ **Neither is `platformRequest`, and neither lives in `infra/platform/`.** Different base URL,
different auth, different failure semantics — folding a geo-tracker call into the platform client
would put it one typo away from carrying `X-Service-Token`, **a credential scoped to a different
service with a different blast radius.**

### ⛔ THE HARD RULE: neither may ever become a readiness dependency

> **A data door may fail a *request*. It may never fail the *service*.**

ADR-014 D-1's coupled-failure amplifier is **one `Promise.all` away**, and it is the exact mistake
that would look like a tidy-up in review. Three layers stop it, and the third had to be repaired
once: `test:devtools` scans `health.routes.ts` and `SystemController.health` for **both** clients —
and its regex had to be **widened** when the data door landed, because `geo-tracker\.client` does not
match `geo-tracker-data.client` and the new door would have slipped past the one pin that exists to
stop it.

### The door is inert by default, on both sides

No `GEO_TRACKER_ADMIN_TOKEN` → geo-tracker answers `503 SERVICE_DOOR_NOT_CONFIGURED` and wi-admin's
reads answer `configured: false`. That is what made ADR-020 **deployable in either order**. ⚠ Because
it is optional by design, **absent means "this deployment has no data door" and only a *mismatch* is
a fault** — unlike the other shared secrets, where absence is now loud on all three services.

---

## 3 · Configuration — 53 variables, 49 SUPPLIED and 4 read

`src/config/env.ts` is a **Zod schema that supplies every value it knows about**. That is the
opposite of jovi-mall's arrangement, and the difference is deliberate on both sides: jovi-mall reads
300 variables through 27 module configs that own their own defaults, so its `env.ts` validates an
environment it does not supply.

Grouped, and the sixteen groups sum to the schema's **49**: process 5 · databases 2 · Redis 1 ·
auth and session 9 · rate limits 2 · MFA 1 · approvals 2 · feature flags 1 · audit 5 ·
notifications 5 · CORS 1 · jovi-mall client 3 · storage 4 · uploads 1 · geo-tracker 5 ·
**automation 2**.

> ⚠ **Corrected 2026-09-08 (R6), and the correction is not only arithmetic.** This section read
> *"47 variables"* and *"**nothing** in `src/` reads `process.env` at a call site"*. Both were
> re-measured against `src/config/env.ts` and a scan of `src/`:
>
> - The schema holds **49**, not 47. The two the grouping missed are ADR-022's
>   `AUTOMATION_REPORT_TOKEN` and `ADMIN_AUTOMATION_RETENTION_DAYS`, added 2026-09-07 — the day
>   after the measurement.
> - **Four variables are read at a call site after all**, through a local `envInt()` helper at
>   `src/api/middlewares/rate-limit.middleware.ts:42-44`, which does `process.env[name]`:
>   `ADMIN_RATE_LIMIT_DEVELOPER` (2400) · `ADMIN_RATE_LIMIT_ADMIN` (1800) ·
>   `ADMIN_RATE_LIMIT_SUPPORT` (1200) · `ADMIN_RATE_LIMIT_ANON` (3000), all per minute. The
>   indexed form is why a `process.env.NAME` grep does not find them.
>
> So the real surface is **53**, and the schema is the configuration for 49 of them.

### ⚠ Thirteen of the 53 are missing from `.env.example`

The first nine were measured 2026-09-06 by diffing the Zod schema against the template and filed as
DOC-PROGRAM **P-14**; the remaining four are the call-site reads above, which no schema diff can
find. Re-measured 2026-09-08:

```
ADMIN_APPROVAL_SWEEP_MIN_INTERVAL_MS   ADMIN_NOTIFICATIONS_BATCH
ADMIN_AUTH_RATE_LIMIT_MAX              ADMIN_NOTIFICATIONS_MAX_PER_TICK
ADMIN_FEATURE_FLAG_CACHE_MS            ADMIN_NOTIFICATIONS_RETENTION_DAYS
ADMIN_NOTIFICATIONS_AUTO_ARCHIVE_DAYS  ADMIN_NOTIFICATIONS_SWEEP_S
ADMIN_REFRESH_RATE_LIMIT_MAX
                                       ADMIN_RATE_LIMIT_DEVELOPER   ← call-site reads,
                                       ADMIN_RATE_LIMIT_ADMIN         absent from the
                                       ADMIN_RATE_LIMIT_SUPPORT       schema AND from
                                       ADMIN_RATE_LIMIT_ANON          `.env.example`
```

All thirteen have defaults, so the service boots and nothing is broken. What is lost is
**discoverability of real operational levers** — the notification sweep interval, batch size,
retention and auto-archive window, and **all six** rate-limit ceilings.

⚠ **This is the exact class of defect jovi-mall's `test:env` exists to catch, and wi-admin has no
equivalent.** jovi-mall's suite found *84 of 149 variables undocumented* when it was written and
now asserts in **both** directions (read-but-undocumented, and documented-but-unread). wi-admin's 39
suites include no `test:env`. Porting it is the durable fix — and note that a port which only reads
the Zod schema would still miss the four above, which is the argument for scanning `src/` rather
than the schema.

---

## 4 · Storage configuration is shared, and a mismatch is silent

`STORAGE_PROVIDER` · `STORAGE_LOCAL_URL` · `STORAGE_FIREBASE_BUCKET` · `STORAGE_FIREBASE_PUBLIC` —
**the same four names on both sides** (ADR-021 D-3 / BR-015). wi-admin's media library **builds
`FileDetail.url` itself** from them rather than asking jovi-mall.

⚠ **These are configuration, not secrets** — a provider name and a public base URL. Nothing is
confidential, there is nothing to compromise, and they need no rotation window. But they are **read
by two services and a mismatch is equally silent**, and the symptom is the misleading part: a wrong
`STORAGE_LOCAL_URL` here **fails no boot and logs nothing**, and produces URLs that 404 on a screen
full of thumbnails — which reads as *"the files are gone"* rather than as a misconfiguration.

All four names were kept **identical on both sides** so the pair can be diffed directly.
`STORAGE_LOCAL_URL` defaults to `http://localhost:8022/api/files` — jovi-mall's port, which is the
tell that this value describes *that* service's file surface.

---

## 5 · Health, and the split that jovi-mall later copied

Mounted **unversioned** at `/health`, because a probe URL is infrastructure, not part of the
dashboard's API contract — **it must not move when `/api/v1` becomes `/api/v2`.**

| Route | Checks | Why |
|---|---|---|
| `GET /health/live` | **never a dependency** | an orchestrator *kills and restarts* on a failing liveness probe — and restarting this service does not fix somebody else's database. **A dependency outage must not become a restart loop.** |
| `GET /health/ready` | everything needed to serve | **503 takes the instance out of rotation without killing it**, so it rejoins by itself when the dependency returns |

⛔ **Neither probe may ever call geo-tracker or jovi-mall.** See § 2.

---

## 6 · Shutdown

```
stop accepting  →  release idle keep-alive sockets  →  flush pending audit (5 s)
  →  close BOTH Mongo connections  →  close Redis
```

⚠ **The audit flush must precede the disconnect.** Audit writes are issued without being awaited by
their request, so closing the connection first would cancel them mid-flight and **lose exactly the
rows somebody reads after an incident.**

`server.keepAliveTimeout = 65_000`, `headersTimeout = 66_000`. ⚠ **`headersTimeout` must exceed
`keepAliveTimeout`** or Node races itself and drops valid requests. Node's default keep-alive of 0
leaves sockets open indefinitely, which holds a drain open and leaks sockets across a long-lived
deployment.

`SHUTDOWN_TIMEOUT_MS` (10 000) bounds the whole drain. A second `SIGTERM` does not start a parallel
sequence. `drain()` does not call `process.exit` — the caller decides, which is what keeps the
sequence assertable from `verify:live`.

---

## 7 · The dangerous verbs

`/api/v1/dev-tools/*` — **9 routes**, and **8 of the 13** `developer_tools.*` permissions are
flagged `destructive`. `/api/v1/system/*` (**17 routes**) is the read-only half: its **seven**
`system.*` permissions are tier 1 **and 2**, and **none is destructive**.

> ⚠ **Corrected 2026-09-08 — two claims here were too strong, and the mount is not uniform.**
> This paragraph said the dev-tools mount is *"all tier-1 Developer only, all audited"* and that
> there are *"six"* `system.*` permissions. Measured against the live route manifest and
> `npm run authz:matrix`:
>
> - **7 of the 9 are audited.** The two reads are not: `GET /dev-tools/feature-flags` and
>   `GET /dev-tools/workers`.
> - **8 of the 9 are tier-1 only.** `GET /dev-tools/workers` declares **`system.workers.read`**,
>   not a `developer_tools.*` permission — so it is reachable by an **Admin**, on the dev-tools
>   mount. That is deliberate (it is a read of the same worker inventory `GET /system/workers`
>   serves) but it means *"grant an Admin the diagnostics without the verbs"* is achieved by the
>   permission split, **not** by the mount split: the mount alone does not gate the tier.
> - `system.*` holds **seven** permissions, not six: `health.read` · `workers.read` ·
>   `outbox.read` · `metrics.read` · `maintenance.read` · `automation.read` · `errors.read`. The
>   seventh, `system.automation.read`, arrived with [ADR-022](./ADR-022-AUTOMATION-FAILURE-AUDIT.md)
>   on 2026-09-07 — the day after this page was read from source.

Keeping the two mounts apart is what lets a deployment grant an Admin the diagnostics without the
verbs — and it mirrors jovi-mall's own `/system/*` vs `/dev-tools/*` split exactly.
