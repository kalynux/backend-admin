# ADR-014 — System operations

**Phase 14.** Status: implemented. Supersedes nothing; amends ADR-005's `/system` prefix reservation
and ADR-009 §D-2 (by reaffirming it).

> **Numbering note.** `docs/` stops at ADR-012, but four source files already reference
> `ADR-013-NOTIFICATIONS.md` (`src/api/index.ts:280`, `src/config/env.ts:195`,
> `src/modules/notifications/routes/notification.routes.ts:13`, plus the Phase 13 banner in
> `audit.catalog.ts`). Phase 13 shipped its code and still owes its document. That debt is
> recorded here and **not** absorbed — this is 014.

---

## Context

Three services run in this workspace and two of them could already answer "is this thing working":

- **geo-tracker** has a `health` module — `/healthz`, `/readyz` with Redis / Postgres / jovi-mall
  checkers — plus `/metrics` exporting 16 Prometheus instruments from a private registry.
- **wi-admin** has `/health/live`, `/health/ready`, and `/api/v1/system/{health,workers,outbox,config}`
  with the dangerous verbs quarantined behind `/api/v1/dev-tools/*`.

**jovi-mall — the service that owns every order, every shipment, and every piece of infrastructure
— had `GET /api/health` returning a hardcoded `{status:'ok'}`.** It read nothing. Mongo could be
down and it still answered 200. `mongoose.connection.readyState` was never read anywhere in the
repo. There was no readiness probe, no metrics, and the only operational read that existed
(`GET /api/internal/admin/dev-tools/workers`) reported schedule strings that were **wrong for eight
of its ten entries** and a `running` flag that could not see a scheduled run.

This phase closes that gap and surfaces it here. It also gives an operator two capabilities that
did not exist: take the platform read-only for a migration, and clear a poisoned cache key without
a redeploy.

Three defects in jovi-mall's worker registry were fixed on the way (D-8), and one finding was
surfaced that nobody was looking for: **both mobile-money gateways are placeholders that complete
no payment** (D-9).

---

## D-1 · `GET /api/health` is frozen

**Decision: exact path, exact body (`{status, timestamp}`), unconditional 200. Readiness went on a
new path.**

Two services depend on it, and the first turns a jovi-mall wobble into its own outage:

`geo-tracker/internal/modules/health/checker/node_checker.go` hits it via `NODE_API_HEALTH_PATH` and
is registered as a **readiness** checker on geo-tracker's `/readyz`. Its client
(`internal/platform/nodeclient/client.go`) treats **any** status ≥ 300 as an error and never parses
the body — only the status code is load-bearing. So moving readiness onto that path yields:

```
jovi-mall Redis wobbles → /api/health 503s → geo-tracker /readyz 503s
  → orchestrator pulls geo-tracker out of rotation → every live WebSocket tracking session dies
```

…for a fault entirely inside a different, perfectly healthy service. A coupled-failure amplifier
from a one-line change that would look like a tidy-up in review.

Second consumer: `admin/src/infra/platform/platform.client.ts` → `pingPlatform()`, which surfaces on
this service's `/health/ready` and `/api/v1/system/health`.

`npm run test:system` asserts the path and body keys, so a future edit fails the suite rather than
the fleet. `/api/health/live` and `/api/health/ready` sit beside it.

### Corollary: Redis is not a readiness dependency

Two reasons, and the second is decisive. (1) Every Redis consumer in jovi-mall is feature-scoped and
already degrades; with Redis down the catalogue, orders, payments and shipments all still serve, so
failing readiness would pull an instance for a partial capability loss. (2) **Redis connects lazily
and never at boot**, so a required-Redis probe would *provision* a connection the process never made
— on DB 0, which nothing in that codebase uses — on every probe interval. A probe that changes the
topology it measures is a probe that lies.

Generalised into the rule that runs through the whole read surface: **a probe observes; it does not
provision.** Redis reports `idle` (never needed here), `up`, or `down`, and contributes `degraded`
rather than a 503.

Also: **geo-tracker is deliberately not a readiness dependency of jovi-mall.** The reverse already
holds, and making it mutual creates a deadlock in which a cold start of both never converges.

---

## D-2 · Integration status: probe vs. configure

**Decision: two columns, never conflated, and a per-provider policy in a catalog rather than a loop
over base URLs.**

The rule, written into `integration-catalog.ts` and into `api-doc/admin/system.md`:

> A diagnostics read may never cause a side effect a customer would see, cost money, or consume a
> quota that a real request needs.

The naive health check for most of these providers is an authenticated API call, and for two of
them it is literally sending a message to a person. An operations page that quietly texts a customer
every time somebody opens it is not an operations page.

Four reachability modes — `probed`, `on_demand`, `passive`, `never` — and the mode travels with
every verdict, because "WhatsApp: unknown" reads as "WhatsApp is broken" when it means "we chose not
to ask".

**`passive` is the interesting one.** Providers that cannot be probed are called constantly in the
course of ordinary work, and every one of those calls already knows whether it succeeded. So instead
of asking, we remember: `recordIntegrationCall()` feeds both an in-memory last-outcome map and the
Prometheus counters. An operator gets "Stripe: ok, 40 seconds ago" at zero cost and with no side
effect — better than a probe could have told them.

Where a probe is refused, the *useful* fact is reported instead: Stripe's key prefix
(`sk_live_` vs `sk_test_`), and for Google Calendar two free Mongo counts (connected vendors, and
vendors whose token last failed to refresh).

Six "is this configured" predicates already existed in jovi-mall (`getGeocodingProviderType`,
`getStorageProviderType`, `isFcmConfigured`, `trackingIntegrationEnabled`, `internalAdminApiEnabled`,
`internalApiEnabled`) and were on no route at all. This is their first surface.

---

## D-3 · Metrics posture: one registry, two renderings, and jovi-mall's is gated

**Decision: `prom-client` on a private registry; a Prometheus text endpoint AND a JSON projection of
the same registry.**

Private registry, never prom-client's global `register` — mirroring geo-tracker's
`internal/platform/metrics/metrics.go`, for the two reasons its header gives: one place to look, and
a test can hold an isolated registry. `test:system` asserts nothing leaked to the global one.

**jovi-mall's `/metrics` is token-gated in production while geo-tracker's is open, and that
asymmetry is deliberate.** geo-tracker is not internet-facing. jovi-mall is — it serves
`/api/public/*` with no auth and is the origin the storefront calls. An open `/metrics` there hands
over, in aggregate: request volumes per route group (order rate, payment rate — business
intelligence), the complete internal route map, every integration and worker name with its cadence,
error rates with their timing, and the outbox backlog. Individually minor; together a free
reconnaissance feed, and the duration histograms are a timing oracle.

Three gates: `METRICS_ENABLED` (default true, parity with geo-tracker), `METRICS_SCRAPE_TOKEN`
(**required in production** — a production deploy without it serves nothing rather than serving
openly), and an optional IP allowlist. Every rejection returns **404**, identical in all four cases,
so the response is never an oracle. Deliberately not `INTERNAL_ADMIN_SERVICE_TOKEN`: a scrape config
lives in a monitoring namespace read by more people than a full-privilege credential should be.

**Cardinality is bounded by a closed allowlist, not by normalisation.** Collapsing ids out of a path
bounds *most* of the label space, and "most" is not a bound — a scanner hitting `/api/.env` mints a
time series per request, and prom-client enforces no per-metric cap. So the allowlist **is** the
cap, and `test:system` proves it by fuzzing a thousand adversarial paths rather than asserting the
happy path. `event_type` is bounded differently but as firmly: by **subscription**, since the set of
handled event types is finite and fixed at boot and cannot be grown by a caller.

The JSON projection is **explicit**, not prom-client's raw `getMetricsAsJSON()`. That shape is a
dependency's internal detail; pinning it keeps adding or renaming an instrument a one-repo change
instead of a two-repo dashboard break.

---

## D-4 · The maintenance exemption list, and the webhook trade

**Decision: three modes (`off` / `readonly` / `down`), state in Mongo, five always-exempt prefixes,
and gateway webhooks exempt by default with a per-window override.**

State lives in **Mongo**, not Redis. Redis converges instantly, but jovi-mall connects to it lazily
and its persistence is not guaranteed there — a Redis restart would **silently drop maintenance
mode**, reopening the platform for writes mid-migration with nobody told. That is the worst
available failure direction. Mongo is already a hard dependency, so it adds no new failure mode.

**Every unknown fails OPEN** — an unrecognised mode, a corrupt document, an elapsed expiry all read
as `off`. This is the opposite of the usual instinct and it is deliberate: the failure mode of
failing *closed* here is a platform that is down and whose own operator door may be part of what is
down. Likewise, if the cache refresh read fails, the last known state is kept — defaulting to `off`
reopens writes during a database wobble mid-migration, and defaulting to `down` takes the site
offline on a transient error.

### The exemption list

Each entry is here because blocking it converts a window into an outage, and two of them into
*somebody else's* outage:

1. **`/api/internal/admin/*`** — the whole prefix. The operator's exit, plus the `/system/*` reads
   they need to decide when to take it. Blocking it is a self-inflicted lockout.
2. **`/api/internal/agents/*`** — geo-tracker's authorization door, and the one a naive
   implementation gets wrong. A **read-only verdict**; blocking it means geo-tracker cannot answer
   "may this viewer track this agent", so every live subscription fails authorization and every
   watcher is dropped.
3. **`/api/tracking/*`** — same family, read-only, same reason.
4. **`/api/health*`** — a probe must always answer, or the orchestrator restarts the fleet and the
   window becomes an outage nobody can exit. **Corollary: `/api/health/ready` returns 200 during
   maintenance**, reporting the mode in its body. Draining traffic is a load-balancer action.
5. **`/metrics`** — telemetry matters most during the incident.

`/api/admin/*` is **not** exempt: it is guarded by `requireRole(['admin'])` on a platform `users`
row, and an admin with a users row is still a user. Prefix matching is on segment boundaries, so
naming a route `/api/healthcheck-bypass` does not exempt it.

### Webhooks: a trade, written as a trade

`/api/webhooks/*` is exempt by default in **both** modes, with `blockWebhooks: true` per window.

- "Gateways retry" is *true* for Stripe (3 days, exponential backoff) and *assumed* for the regional
  mobile-money providers. Betting money on an assumption about a PSP's retry policy is the bad half.
- A dropped payment event is not "the order stays unpaid" — jovi-mall's payment path grants digital
  entitlements, opens escrow holds, mints shipments and fires four notification stacks. A missed
  success event is a customer who has been charged and has nothing.
- The counter-argument is real: a webhook is a write, and `readonly` exists to stop writes. The
  resolution is that webhook writes are narrow and **idempotent by construction** — keyed off a
  gateway reference and already re-entrant because gateways send duplicates anyway.
- **Residual risk, stated:** if the window exists *because of* a migration on orders or payments, an
  open webhook path writes into the collection being migrated. Hence the override — a per-incident
  decision, which is what it actually is, rather than a permanent bet.

### Workers pause in `down`, not in `readonly`

A read-only window usually means a schema change on one collection, and the sweeps are the
platform's correctness machinery: pausing `tracking-dispatch` leaves geo-tracker broadcasting a
delivered shipment's position, and pausing `unpaid-booking-cancel` holds slots for free. The guard
sits at each worker's **tick site**, not inside `runSweep()`, so a manual
`POST /dev-tools/workers/:key/run` still works mid-window — an operator running a worker during an
incident is a deliberate act and the point of that surface.

---

## D-5 · The cache-flush allowlist

**Decision: named databases only, dry-run by default, SCAN not KEYS, no whole-instance flush, and a
stated blast radius per database.**

Three of the eight flushable databases are load-bearing, and "clearing a cache" does not sound
dangerous — which is exactly why the policy is a table rather than a permission:

- **`WA_IDEMPOTENCY_DB`** — these keys are the only thing stopping a retried send from becoming a
  **second WhatsApp message to a real person**. Clearing them reopens a duplicate-send window for
  each key's remaining TTL (24–72h).
- **`SLOT_LOCK_DB`** — drops live booking holds. **Degraded, not broken:** the actual double-sale
  guard is `createBooking`'s in-transaction overlap re-check, so what is lost is the reservation
  *courtesy* (two customers reach checkout, the second loses at commit), not the single-occupancy
  invariant. Worth writing down, because the intuitive reading is far worse than the truth.
- **`DOWNLOAD_TOKEN_DB`** — invalidates every live download link; a paying customer mid-download
  gets a dead URL.

Those three refuse a whole-database flush and require a prefix. Combined with `confirm` (repeat the
name) and `dryRun: true` by default (mirroring the existing `FILE_CLEANUP_DRY_RUN` precedent), they
are effectively a two-step.

Databases are addressed **by name**: a numeric field invites `0`, and a typo turning `7` into `8`
silently flushes download links instead of booking holds. `db: 0` is refused outright. The prefix is
a literal — metacharacters are escaped and *we* append the `*`, because `prefix: "*"` would otherwise
be a whole-database flush wearing a prefix's clothes. `FLUSHALL` appears nowhere in the path.

`test:system` asserts **every catalogued Redis database has a policy row**, so a database added to
the factory without one fails the suite rather than becoming silently unflushable.

---

## D-6 · `/queues` sits beside `/outbox`; the redundancy is the feature

**Decision: keep `GET /api/v1/system/outbox`, add `GET /api/v1/system/queues`, deprecate neither.**

They are not the same read. `/outbox` reads `tracking_outbox` **directly** out of `jovi_mall`
(ADR-009 D-1: a record, so a second reader costs nothing). `/queues` is **delegated**, and covers a
second queue — the assignment backlog — whose notion of "due" is jovi-mall's own verdict.

The decisive argument: **during a jovi-mall incident — the exact moment an operator wants queue
depth — the delegated read returns 503 and the direct read still answers.** Superseding `/outbox`
would delete the version that works when the platform is down.

The assignment half is the more operationally urgent of the two, and nothing reported it before:
`AssignmentSweepWorker` is the only thing that advances an auto-assignment session and the only
thing that expires a manual offer. If it stops, nothing throws and nothing logs — shipments simply
sit on offer forever while agencies wonder why nobody picks anything up.

---

## D-7 · `setMaintenance` bypasses `dev_tools.enabled`

**Decision: one carve-out, in the gateway, pinned by a test.**

Every other tool on `/api/v1/dev-tools` is gated on the `dev_tools.enabled` feature flag, which is
**off by default** — correct for capabilities that re-run side effects against live data. Applying
it to maintenance mode produces two failures worse than the risk it guards:

1. During an incident, an operator could not put the platform into maintenance without first finding
   and flipping an unrelated feature flag.
2. Worse — anyone turning `dev_tools.enabled` off while a window was open would **lock the exit**,
   recoverable only by a redeploy or a hand-written Mongo update against `system_state`.

This is the same carve-out the feature-flag routes already take, for the reason
`dev-tools.routes.ts` already states: *a switch must not be able to turn off its own switch.* The
tier-1 `destructive` permission and the audit row both still apply; only the flag is dropped.

`cache/flush` stays behind the flag: an operator who cannot flush a cache is inconvenienced, not
stuck. `test:devtools` asserts both halves of that asymmetry at the source, since a route file
cannot express the absence of a gate that lives in a gateway.

---

## D-8 · The worker registry: derive, don't duplicate

**Decision: three named booleans, schedules derived from what each worker actually schedules with,
and the inventory split from the triggerable registry.**

Three defects, one root cause each:

**Schedules were wrong for eight of ten workers** — `plan-expiry` advertised `daily 00:05` against a
real `0 3 * * *`, `earnings-release` `hourly` against a daily `0 1 * * *`. The root cause was not
carelessness: `schedule` was a hand-typed string **duplicating a value that lived elsewhere**, and
duplicated facts drift. Patching the ten strings would have left the mechanism intact. Each worker
now exposes a `schedules` getter reading the same value it schedules with, and `test:system` asserts
the reported expression is identical to the worker's own — so a literal retyped into the registry
fails the suite rather than misleading an operator. `describeSchedule()` **echoes** any pattern it
cannot render, because a renderer that guesses recreates the original bug in a new place.

**`runningWorkers()` was blind** because *three different things were called `running`*: a manual
trigger claim in the registry, "has been started" in the booking sweeps, and "a pass is in flight" in
the dispatcher. The endpoint reported the first, so a scheduled sweep churning for ten minutes showed
`running: false`. Nothing reports a bare `running` any more — `scheduled` / `executing` /
`manualClaim`.

**Two workers were missing.** `AssignmentSweepWorker` by oversight (the list was written from
`server.ts`'s import block and this one starts indirectly), now registered. `InboundCalendarSyncWorker`
deliberately — "run it once" has no single meaning for it — but it now appears in `WORKER_INVENTORY`
with the reason on the wire, because not being able to *see* a worker is a different problem from not
being able to *run* it.

`GET /dev-tools/workers` keeps its exact response shape, because jovi-mall deploys first and
changing it would open a window where wi-admin's callers break. Its `schedule` and `running` became
strictly more truthful at an unchanged shape, which needed no coordination.

wi-admin's `/api/v1/system/workers` was **re-pointed** at the richer `/system/workers` in the same
phase — safe precisely because of that deploy order, and it is the endpoint an operator actually
reads. `DevToolsController.listWorkers` still calls the old path, so it keeps a consumer;
deprecating it is a separate decision and is not made here.

> ⚠ **Newly visible, deliberately not fixed:** the seven cron workers have **no overlap guard at
> all** — `cron.schedule` fires `void this.runSweep()` and a slow sweep can overlap its own next
> tick. `executing` makes the condition observable. Making it impossible changes scheduling on seven
> live sweeps and is its own decision with its own blast radius.

---

## D-9 · Finding: both mobile-money gateways are placeholders

Not a decision so much as something this phase surfaced by looking.

`callNotchPayAPI` and `callMyCoolPayAPI` contain a commented-out `fetch` and end in
`throw new Error('… not implemented')`. **With no API key they return a mock success** — so a
checkout appears to start, the customer is handed a fake USSD code, and no money ever moves. With a
key, every call throws.

Two consequences for this surface:

- They report **`configured: false` even with an API key set**. "Configured" has to mean "this
  payment path works", because that is what an operator reads it as. A green row next to a key, for
  a gateway whose HTTP call is commented out, is precisely the confidently-wrong signal this whole
  phase exists to eliminate.
- They are deliberately **not** wired to `recordIntegrationCall()`. Instrumenting a placeholder
  would record a mock as a successful call and make the operations page vouch for a payment path
  that does not exist — worse than reporting nothing.

The `impact` string on both says `NOT IMPLEMENTED` in as many words. Whether to build them is a
product decision outside this phase; whether to *say so* was not.

---

## What this phase did not build

- **A public status endpoint.** `jovi-mall/api-doc/system-uptime-status.md` specs a three-dot
  frontend widget and stays unserved: the useful version needs infrastructure detail (pool
  saturation, replication lag, cache hit rate, job backlog) that is exactly what an anonymous caller
  should not have, and the non-useful version is three green dots that stay green during an outage.
  A header note now says so in the file, so the next reader does not implement it by accident.
- **A geo-tracker door for wi-admin.** ADR-009 §D-2 stands, reaffirmed. geo-tracker was not touched
  at all this phase.
- **A jovi-mall runtime-config read.** It would need its own whitelist there, reproducing the whole
  `FORBIDDEN_CONFIG_TOKEN` discipline. Named as the natural follow-up.

## Named debts

- **`ADR-013-NOTIFICATIONS.md` is owed** by Phase 13 and referenced from four source files.
- The seven cron workers' missing overlap guard (D-8).
- **`sent` tracking-outbox rows are never pruned**, so every scan over that collection gets slower
  with age.
- **`closeRedisClients()` has zero call sites** — there is no graceful-shutdown path in jovi-mall.
- The manual worker-trigger claim is **process-local**; a real cross-instance lock needs Redis
  (`SET NX` with a TTL and a fencing token).

## Deployment order

**jovi-mall first, wi-admin second, always.** Every new wi-admin route is a passthrough and 404s
until the far side exists; wi-admin's boot assertions check *catalogs*, not reachability, so a
premature deploy fails at request time rather than at boot — the worse failure.

Within wi-admin, **catalogs and routes must land in the same commit**:
`assertAuditCoverageComplete()` refuses a catalogued action that nothing produces, so splitting them
leaves an intermediate commit that will not boot.
