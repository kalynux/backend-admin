# wi-admin — architecture

**Verified against source on 2026-09-08** — the 23 modules (`ls src/modules`), the 11 Mongoose
models, the route surface (240 = 237 versioned in 24 groups + 1 internal + 2 health, by executing
`routeManifest()` and `FRONTEND-SYNC/tools/dump-routes.js`), and every boot assertion in
`src/app.ts:48-62,147,158` and `src/lifecycle.ts:51`. **Four things were wrong** — the module list
and the route table both omitted `automation` (ADR-022, 2026-09-07), § 3's total folded the health
probes into the versioned figure, and § 4 listed **four** of the **ten** boot assertions.

Read from source 2026-09-06. Route census:
[`../../DOC-PROGRAM/evidence/admin-routes.txt`](../../DOC-PROGRAM/evidence/admin-routes.txt).
Permission matrix: `npm run authz:matrix`.

---

## 1 · Three layers, two databases, one composition root

```
src/api/       the route manifest · middleware chain · error handler · rate limiter
src/modules/   23 modules — controllers, domain, repositories, routes, validators
src/core/      errors · http (the list query) · data (Mongo query building) · validation · logging
src/infra/     mongo (two connections) · redis · platform (the jovi_mall read side) · geo · storage
src/config/    one Zod schema that SUPPLIES the environment
```

The shape most worth understanding is not the layering — it is that **wi-admin owns almost no
domain logic**. 94.6 % of admin behaviour already exists in jovi-mall, so this service **delegates
over HTTP** and reimplements nothing (ADR-001, ADR-004). Its own code is overwhelmingly *access
control, audit and presentation*.

That produces an asymmetry with two databases:

| | `jovi_mall` (shared) | `wi_admin` (private) |
|---|---|---|
| connection | `MONGO_URI_PLATFORM` | `MONGO_URI_ADMIN` |
| this service may | **read only** | read and write |
| how the rule is enforced | **structurally** — `PlatformReadRepository` has no write method | — |
| may be a standalone `mongod`? | yes | ⛔ **no** — see [DATA.md § 2](./DATA.md#2--the-audit-store) |

---

## 2 · Twenty-three modules

`accounts` · `admin-identity` · `administrators` · `agencies` · `agents` · `audit` ·
`authorization` · **`automation`** · `billing` · `cod` · `content` · `dev-tools` · `dual-control` ·
`files` · `messaging` · `money` · `notifications` · `orders` · `shipments` · `support` · `system` ·
`users` · `vendors`

> ⚠ **`automation` was missing from this list until 2026-09-08**, and from the route table below.
> It landed on 2026-09-07 with [ADR-022](./ADR-022-AUTOMATION-FAILURE-AUDIT.md) — the day after
> this page was read from source — so both omissions have one cause. `ls src/modules | wc -l`.

Four of them are **the service itself** rather than a domain, and they are where the interesting
code lives:

| Module | Owns |
|---|---|
| `admin-identity` | administrators, sessions, MFA, lockout — an identity space **entirely separate** from the platform's |
| `authorization` | the permission catalog (**118** on 2026-09-08 — `npm run authz:matrix`) and the tier grant table |
| `audit` | the 114-action catalog, the writer, exports and retention |
| `dual-control` | four-eyes approval requests |

The remaining eighteen are thin: a controller, a validator, a read repository over `jovi_mall`, and
a delegating client call for writes.

---

## 3 · The route surface — 240 routes, and none of them is registered by hand

**237 versioned** under `/api/v1`, in **24** groups · **1** unversioned service door
(`POST /api/internal/automation/failures`) · **2** health probes (`/health/live`, `/health/ready`),
which mount **before** the rate limiter.

| Group | Routes | Group | Routes |
|---|---|---|---|
| `support` | 19 | `notifications` | 10 |
| `agents` | 18 | `billing` | 10 |
| `system` | 17 | `dev-tools` | 9 |
| `administrators` | 17 | `agencies` | 9 |
| `cod` | 16 | `users` | 8 |
| `money` | 14 | `shipments` | 8 |
| `content` | 14 | `files` | 7 |
| `vendors` | 13 | `audit` | 7 |
| `auth` | 11 | `approvals` | 5 |
| `orders` | 10 | `accounts` | 5 |
| | | `contracts` · `permissions` · **`automation`** · `messaging` | 4 · 3 · **2** · 1 |
| | | `/api/internal/automation/failures` | 1 |
| | | `/health/*` | 2 |

> ⚠ **Corrected 2026-09-08.** The table omitted `/automation` (ADR-022, 2026-09-07) and reached
> "237" by counting the two health probes inside the versioned figure. The versioned surface is
> **237 on its own**; 240 is the whole HTTP surface. Re-derive rather than trust:
> ```bash
> node -r ts-node/register/transpile-only -r dotenv/config \
>     ../FRONTEND-SYNC/tools/dump-routes.js "$(pwd)/src/app.ts" | tail -1   # TOTAL 240
> ```

### `defineRoute` — the mechanism that makes an unguarded route unshippable

⛔ **A route cannot be registered without saying who may call it.** `access` is a *required* field on
`RouteDefinition`; there is no default and no way to pass "none" that is not a deliberate, named,
allowlisted choice.

The reason is stated plainly in the source: *"Authorization that is attached by remembering to
attach it is authorization that is eventually forgotten."*

**Three layers, each catching what the one before it misses:**

1. `defineRoute` — declaring access is *structurally* required;
2. `assertRouteManifestComplete()` **at boot** — a route that reached Express without passing
   through here **fails startup**;
3. `test:authz` — a source scan refusing any raw `router.get(` in a routes file.

**Phase 12 gave auditing the same three layers**: `audit` is required on a mutating method,
`assertAuditCoverageComplete()` checks the declaration *and* refuses a catalogued action nobody
produces, and `test:authz` counts declarations against mutating routes per file. The gap it closed
was real — **the whole four-eyes decision path and the audit purge shipped recording nothing.**

### The middleware chain it builds

```
auditProbe → before → gate → requireCsrfToken → validate → handler
```

⚠ **`validate` sits AFTER the guards on purpose**: an unauthorized caller should not be able to probe
a schema. What a request must look like and who may send it are read together.

⚠ **CSRF is attached unconditionally.** It already no-ops on safe methods and on bearer clients, so
attaching it always costs nothing and **removes the entire "forgot CSRF on a new mutating route"
failure mode.**

---

## 4 · Ten things asserted at boot, before the port binds

`src/app.ts` and `src/lifecycle.ts`. Each turns a class of silent wrongness into a startup error.
They share one argument: **a service running on an inconsistent registry is worse than one that is
down, because it looks like it is working.**

Seven run before any route is mounted (`app.ts:48-62`):

| Assertion | Catches |
|---|---|
| `assertGrantTableValid()` | a tier grant that breaks nesting (3 ⊆ 2 ⊆ 1), or a `financial` / `destructive` permission reaching tier 3 |
| `assertDualControlHandlersRegistered()` | a four-eyes action with no registered handler to commit it |
| `assertAuditCatalogValid()` | an action whose `transport` and recording path disagree |
| `assertFeatureFlagCatalogValid()` | a flag nothing reads |
| `assertExposedConfigSafe()` | a `GET /system/config` allowlist key that names a secret |
| `assertNotificationCoverageComplete()` | a notification type nothing produces — invisible otherwise: it appears in the filter and on the preferences screen and simply never arrives |
| `assertSourcePermissionsExist()` | a notification source naming a permission the catalog does not hold |

Two run **immediately after mounting**, because they inspect what Express actually registered
(`app.ts:147,158`):

| Assertion | Catches |
|---|---|
| `assertRouteManifestComplete(app)` | a route registered without `defineRoute`, or one claiming `public` without being on `PUBLIC_ROUTE_ALLOWLIST` |
| `assertAuditCoverageComplete()` | a mutating route with no audit declaration, **and** a catalogued action nobody produces |

One runs in the lifecycle, before the port binds (`lifecycle.ts:51`):

| Assertion | Catches |
|---|---|
| `assertAuditStoreTransactional()` | a `wi_admin` database that cannot run multi-document transactions |

The last is the load-bearing one and is described in [DATA.md § 2](./DATA.md#2--the-audit-store).

> ⚠ **This section listed four of the ten until 2026-09-08.** The six it omitted are the ones a
> reader most needs: they are what fails the boot when somebody adds a permission, a feature flag,
> a notification type or a four-eyes action and stops one step short. Re-derive with
> `grep -n 'assert' src/app.ts src/lifecycle.ts`.

---

## 5 · Boot and drain

```
validate the environment (Zod, supplying every value)
  → connect BOTH databases
  → assert the audit store is transactional
  → connect Redis (session DB)
  → swap the auth limiter onto the shared Redis store
  → resume unstamped audit exports
  → listen
  → start the notification projector
```

Three of those steps are placed deliberately:

- **`initAuthRateLimiter()` after Redis** — so the per-IP credential limit holds *across instances*
  rather than per process.
- **`resumeUnstampedExports()` before listening** — an export that wrote a durable file and died
  before marking its rows exported leaves those rows **never eligible for deletion**, so the
  collection grows forever while the retention policy claims otherwise.
- **The notification projector starts AFTER the port is bound**, deliberately. It is best-effort
  background work whose failure must never stop the service from serving; starting it earlier would
  put a **cross-database sweep on the critical path of becoming healthy.**

`server.keepAliveTimeout = 65_000` and `headersTimeout = 66_000`. ⚠ **`headersTimeout` must exceed
`keepAliveTimeout`** or Node races itself and drops valid requests; Node's default keep-alive of 0
leaves sockets open indefinitely, which holds a drain open and leaks sockets across a long-lived
deployment.

Drain: stop accepting → release idle keep-alive sockets → **flush pending audit (5 s)** → close both
Mongo connections → close Redis. ⚠ **The audit flush must precede the disconnect** — closing first
would cancel in-flight writes mid-flight and lose exactly the rows somebody reads after an incident.
`drain()` does not call `process.exit`; the caller decides, which keeps the sequence assertable from
`verify:live`.
