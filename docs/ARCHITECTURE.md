# wi-admin — architecture

Read from source 2026-09-06. Route census:
[`../../DOC-PROGRAM/evidence/admin-routes.txt`](../../DOC-PROGRAM/evidence/admin-routes.txt).
Permission matrix: `npm run authz:matrix`.

---

## 1 · Three layers, two databases, one composition root

```
src/api/       the route manifest · middleware chain · error handler · rate limiter
src/modules/   22 modules — controllers, domain, repositories, routes, validators
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

## 2 · Twenty-two modules

`accounts` · `admin-identity` · `administrators` · `agencies` · `agents` · `audit` ·
`authorization` · `billing` · `cod` · `content` · `dev-tools` · `dual-control` · `files` ·
`messaging` · `money` · `notifications` · `orders` · `shipments` · `support` · `system` · `users` ·
`vendors`

Four of them are **the service itself** rather than a domain, and they are where the interesting
code lives:

| Module | Owns |
|---|---|
| `admin-identity` | administrators, sessions, MFA, lockout — an identity space **entirely separate** from the platform's |
| `authorization` | the 116-permission catalog and the tier grant table |
| `audit` | the 114-action catalog, the writer, exports and retention |
| `dual-control` | four-eyes approval requests |

The remaining eighteen are thin: a controller, a validator, a read repository over `jovi_mall`, and
a delegating client call for writes.

---

## 3 · The route surface — 237 routes, and none of them is registered by hand

Everything under `/api/v1`, except `/health/live` and `/health/ready`, which mount **before** the
rate limiter.

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
| | | `contracts` · `permissions` · `messaging` | 4 · 3 · 1 |
| | | `/health/*` | 2 |

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

## 4 · Four things asserted at boot, before the port binds

`src/app.ts` and `src/lifecycle.ts`. Each turns a class of silent wrongness into a startup error:

| Assertion | Catches |
|---|---|
| `assertAuditCatalogValid()` | an action whose `transport` and recording path disagree |
| `assertRouteManifestComplete(app)` | a route registered without `defineRoute` |
| `assertAuditCoverageComplete()` | a mutating route with no audit declaration, **and** a catalogued action nobody produces |
| `assertAuditStoreTransactional()` | a `wi_admin` database that cannot run multi-document transactions |

The last one is the load-bearing one and is described in
[DATA.md § 2](./DATA.md#2--the-audit-store).

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
