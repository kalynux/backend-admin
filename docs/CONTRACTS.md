# wi-admin — contracts

**Verified against source on 2026-09-08** — the permission catalog, the tier grants, the audit
catalog and the error registry, each re-derived by **executing** `npm run authz:matrix` and
`AUDIT_CATALOG` rather than by reading: **118** permissions across **20** families, tiers
**118 / 101 / 31**, **114** audit actions across four transports (delegated 69 · external 21 ·
`wi_admin_txn` 17 · observation 7), **88** error codes. § 2's permission figures and § 7's code
count were stale; § 2's *"21 `money`"* flag count was **never right** and is **14**.

Read from source 2026-09-06: `src/api/middlewares/`, `src/api/route-manifest.ts`,
`src/modules/authorization/domain/`, `src/modules/audit/domain/`, `src/core/errors/`,
`src/infra/geo/`, `src/infra/platform/`.

---

## 1 · Authentication — a revocable, server-side session

**Administrators hold no `users` row anywhere.** That is the founding separation of this
architecture (ADR-002/ADR-004), and everything on this page follows from it: an administrator cannot
be authenticated by jovi-mall, cannot be authorized by it, and cannot appear in it as a person.

`requireAdmin` resolves **cookie first, then `Authorization: Bearer`** — a browser dashboard needs no
token handling while a script can still use a header.

**Two deliberate departures from jovi-mall's `requireAuth`:**

1. ⛔ **No silent refresh.** jovi-mall rotates the access cookie mid-request when it finds an expired
   token. That hides expiry from cookie clients **but not from bearer clients**, which is the root of
   a documented cross-service defect. Here an expired token is simply a **401 with a distinct code**,
   and the dashboard calls `POST /auth/refresh`. **Explicit beats invisible.**
2. **The session is checked.** A valid signature is *necessary, not sufficient* — the `sid` must
   still exist in Redis. This is what makes logout, revocation and suspension take effect **on the
   very next request** rather than at token expiry.

The cost is one Redis `GET` plus one Mongo `findById` per request. **The account is re-read every
time on purpose**: status and tier must be current, not whatever was true when the token was minted.

| Lifetime | Value | Where |
|---|---|---|
| access token | 900 s (15 min) | matches the platform |
| session idle | 28 800 s (8 h) | Redis TTL, refreshed on use |
| session absolute | 604 800 s (7 d) | hard cap, stored in the record |

Lockout after 5 attempts for 900 s. MFA is required from `ADMIN_MFA_REQUIRED_TIER` (default 1)
upward.

⚠ **`requireAdminAllowingMfaEnrolment` exists and only the enrolment routes may use it.** Everything
else uses the strict export, **so a new route is protected by default rather than by remembering to
opt in.**

⚠ **A suspended administrator's session eviction is audited only when it actually cuts something**
(`ended > 0`). The branch runs on every request a suspended admin makes — a dashboard polling in a
background tab hits it several times a minute — and an unconditional row would bury the trail under
duplicates of one event.

### CSRF

Double-submit: a readable (non-httpOnly) cookie echoed in `X-CSRF-Token`.

**Why here and not in jovi-mall's design:** the admin dashboard is a *separate origin* from this API,
so its cookies must be `SameSite=None` in production — and `SameSite=Lax` **is itself a CSRF
defence**. Dropping to `None` removes it, and a cookie-authenticated state-changing endpoint becomes
forgeable from any page the administrator visits while signed in.

⚠ **Bearer requests are exempt, and that is not a hole.** CSRF exists because browsers attach
*cookies* automatically; nothing attaches an `Authorization` header automatically. A forged
cross-origin request cannot produce one. Safe methods are exempt because they change nothing.

The comparison is constant-time — a `===` leaks how many leading characters matched via timing.
Small, but free to avoid.

---

## 2 · Authorization — 121 permissions, granted by tier

⚠ Re-measured **2026-09-14**: **121 permissions across 21 families** (ADR-023 added the `employees` family and `administrators.activate`, all tier 1). The 2026-09-08 measurement below read 118 across 20.

`npm run authz:matrix` on **2026-09-14**: **121 permissions across 21 families**.

| Tier | Holds |
|---|---|
| **1 — Developer** | 118 |
| **2 — Admin** | 101 |
| **3 — Support** | 31 |

⚠ **Run it; do not quote it.** These four figures have moved five times during this programme
(110 → 113 → 114 → 116 → 118). Only the family count has held.

⚠ **A LOWER tier number means MORE privilege.** This reverses ADR-001 D5 and is the single most
misread fact in this service.

Flags on the catalog: **17 `destructive`**, **14 `money`** (the flag is `financial: true`; the
matrix prints it as `money`), plus two scoped kinds (`scoped:audit` ×1, `scoped:tickets` ×8).
⚠ **The `money` figure read 21 until 2026-09-08 and was never right** — 21 is neither the flag
count (14) nor the size of the `money` *family* (6), and the two are different things: a
`financial` permission can live in any family, which is exactly why the flag exists.

### The rules the catalog encodes

- **Names describe the OPERATION, never the person.** `cod.remittances.confirm` stays true when the
  org chart changes; `minTier: 2` does not.
- **Entries exist for endpoints that do not exist yet**, deliberately — a policy decided once, here,
  rather than argued per-endpoint by whoever ports the surface.
- ⚠ **Mis-flagging is the one mistake with real consequences**: an unflagged financial write can be
  swept into a tier by `allInFamily()`.
- **The boot assertion refuses to start until tier 1 lists a new permission**, so wiring it is not
  optional.
- `as const satisfies` makes `requirePermission('typo.here')` a **compile** error.

### Four-eyes, and the direction that is not dual-controlled

Promoting anyone to **Developer** takes **two Developers**; so does suspending or reinstating one.
Combined with the no-self-action rule, **no single account can create a peer**, and a compromised
Developer can be contained by another without either acting alone.

⚠ **A demotion is NOT dual-controlled, and that asymmetry is correct.** Reducing privilege is the
safe direction, and needing a quorum to contain a compromised account would be exactly backwards.
Reinstatement *does* ride the dual-control spec, because restoring a suspended Developer grants
Developer access to an account that currently has none — as consequential as promoting one.

⚠ **No permission caching.** `PERMISSION_CACHE_DB = 3` is reserved and deliberately **unused**: the
grant table is static code, so a tier's permission set cannot change while the process runs — there
is nothing to invalidate — and each check is a `Set.has` on a string. A Redis round trip would make
an O(1) lookup slower **and** add the one failure this design otherwise cannot have: **a stale
verdict surviving a deploy that changed the policy.**

---

## 3 · Audit — 114 actions, and the transport is a property of the action

`AUDIT_CATALOG`, measured 2026-09-06: **114 actions** across four transports.

| Transport | Count | Means |
|---|---|---|
| `delegated` | **69** | the write happens in jovi-mall; recorded intent → outcome |
| `external` | 21 | the effect lands outside both services |
| `wi_admin_txn` | 17 | the state change and its audit row commit **in one transaction** |
| `observation` | 7 | a read worth recording |

**A closed registry, not free strings.** A closed union means the query's `action` filter is a pinned
`z.enum` (the vocabulary is ours, ADR-005 D-17) and the dashboard builds its filter from
`GET /audit/actions` instead of discovering it by collecting 400s.

**Where an action is governed by a permission it REUSES that permission's name** — deliberately.
`administrators.suspend` means one thing, and an audit name that merely *resembles* the permission
name is how the two drift. `permission: null` marks actions no permission governs: identity events
every administrator performs on themselves by definition, and system work nobody requested.

⚠ **`transport` is not documentation.** `assertAuditCatalogValid()` and the writer check against it,
so an action declared `wi_admin_txn` **cannot** be recorded through the intent→outcome path, and vice
versa. The mode is decided once, here, not re-chosen at each call site.

---

## 4 · Rate limiting

A global limiter mounted before `/api/v1`, plus a stricter credential limiter
(`ADMIN_AUTH_RATE_LIMIT_MAX`, default 10) and a refresh limiter (`ADMIN_REFRESH_RATE_LIMIT_MAX`,
default 60). Counters live in Redis DB 2, swapped onto the shared store at boot so the per-IP limit
holds **across instances** rather than per process.

`/health/live` and `/health/ready` mount before the limiter.

---

## 5 · Events and notifications

wi-admin has **no domain event bus**. What it has instead is a **projector**
(`notifications/domain/notification.scheduler.ts`) that sweeps for things worth telling an
administrator about and writes `admin_notifications` rows.

⚠ **`setInterval` fires on a wall clock, not on completion**, so a tick slower than its own period
would stack. The scheduler is explicitly built as an interval **that cannot overlap itself and that
stops on drain** — the same hazard jovi-mall solved with a Redis lock, solved here by construction
because there is one projector.

Tunables: `ADMIN_NOTIFICATIONS_SWEEP_S` (30) · `_BATCH` (200) · `_MAX_PER_TICK` (25) ·
`_AUTO_ARCHIVE_DAYS` (90) · `_RETENTION_DAYS` (30). ⚠ **All five are absent from `.env.example`** —
see [OPERATIONS.md § 3](./OPERATIONS.md#3--configuration--53-variables-all-53-in-the-schema).

---

## 6 · Webhooks

wi-admin **receives none, and sends none.** There is no inbound webhook route in the 237, and no
outbound delivery either — verified against the route census on 2026-09-06.

That is worth stating because the catalog contains `developer_tools.webhooks.redeliver`, **a
permission with no route** — and it is deliberate, not an unfinished port. Every webhook mount in the
platform is *inbound*; nothing anywhere records an **outbound** delivery, so there is no subject to
redeliver. The permission stays catalogued, naming its own missing prerequisite, because *writing an
endpoint for it would be worse than the gap.* `docs/api/dev-tools.md` § "What is deliberately not
here" is the record, and `phantom-routes.js` classifies the documented path **BY_DESIGN** for exactly
this reason.

⛔ **Do not "fix" this by building the endpoint.**

---

## 7 · Errors — 88 codes, nine categories, and the tier ladder

**88 codes** in `src/core/errors/error-codes.ts` (re-measured **2026-09-08**; it read 85 on
2026-09-06). ⚠ **This number now has a guard** — `npm run test:error-docs` asserts that every
declared code is documented in `api-doc/api/errors.md` and that the page invents none. The envelope, the nine
categories and the boundary-filtering rule are the **shared** contract described in
[ADR-016](./ADR-016-ERROR-SYSTEM.md) and are identical in all three services:

```json
{ "success": false, "requestId": "…",
  "error": { "code": "…", "message": "…", "statusCode": 422, "category": "business_rule",
             "details": { } } }
```

⚠ **There is no shared package.** Each service's test asserts the nine sorted category names against
a **hardcoded literal**, and those three assertions *are* the contract copy. Changing the list means
changing it in three repositories.

### The one thing that is wi-admin's alone: the developer → admin → support ladder

**jovi-mall serves the full error record; wi-admin grades it.** That split is not an implementation
detail — it is the only place it *can* live. jovi-mall receives `X-Actor-Tier` and **never reads it
for a decision**, because the token authenticating that call is a full-privilege credential and
anyone holding it could set the header. wi-admin knows the administrator's real tier, so wi-admin
does the grading.

⚠ **geo-tracker has no error data door.** Its errors reach operators through logs and
`geotracker_errors_total`, not through a wi-admin surface. (Read that as scoped to the *error
system*: ADR-020 did give geo-tracker a scoped **data** door — see § 9.)

---

## 8 · Validation

Zod, attached by `defineRoute` **after** the guards. `core/http/list-query.ts` decides what a client
may ask for; `core/data/mongo-list.ts` decides what the database is asked. Both halves are used by
the platform read repositories **and** by this service's own repositories, because the hazards they
close are properties of Mongo, not of which database it is.

⚠ **`_id` is appended as a sort tiebreaker, always.** Skip/limit paging over a non-unique sort key is
not stable: two documents sharing a `created_at` may be ordered differently between the query for
page 1 and the query for page 2, so **one appears twice and the other never appears at all**. It is
rare enough to survive testing and common enough to be reported as *"a record is missing from the
list"*, which is unfalsifiable from a bug report. A unique final key removes the whole class.

---

## 9 · Service-to-service

wi-admin is a **client of two services and a server to one dashboard**. It has three outbound
clients and — this is the constraint that matters — **none of them may ever throw.**

| Client | Talks to | Base URL | Token |
|---|---|---|---|
| `platform.client.ts` | jovi-mall `/api/internal/admin/*` | `JOVI_MALL_BASE_URL` | `JOVI_MALL_SERVICE_TOKEN` |
| `geo-tracker.client.ts` | geo-tracker **operations** — `/healthz`, `/readyz`, `/metrics` | `GEO_TRACKER_OPS_BASE_URL` | **none** |
| `geo-tracker-data.client.ts` | geo-tracker **data** — `/internal/*` | `GEO_TRACKER_DATA_BASE_URL` | `GEO_TRACKER_ADMIN_TOKEN` |

### The two geo-tracker doors are separate on purpose

Two clients and **two base-URL variables** is the lever that lets a deployment take the operations
reads and open **no** data door. The operations door (ADR-015 D-5) is unauthenticated, carries no
identity, names no agent, and hits a **closed literal path set**. The data door (ADR-020) is
scoped, audited **in wi-admin**, and inert unless `GEO_TRACKER_ADMIN_TOKEN` is set on both sides.

⛔ **Neither client may ever throw, and neither may become a readiness dependency of wi-admin.** That
would recreate ADR-014 D-1's coupled-failure amplifier in the opposite direction. `test:devtools`
scans `health.routes.ts` and `SystemController.health` for **both** — and its regex had to be widened
when the data door landed, because `geo-tracker\.client` does not match `geo-tracker-data.client`
and the new door would have slipped past the one pin that exists to stop it.

> **A data door may fail a *request*. It may never fail the *service*.**

### The permission split on tracking reads

wi-admin's grading stays in wi-admin (ADR-020 D-2 constraint 3 — **no tier logic in Go**), as **two**
permissions rather than one:

| Permission | Covers | Because it is |
|---|---|---|
| `agents.tracking.read` | presence + live position | **live surveillance of a person** |
| `shipments.tracking.read` | trail + events | **a case file about a delivery** |

Support holds **both**, deliberately — and the audit row is the other half of that decision. It
commits **before** the read and its failure is not caught, so with the audit store down **nothing is
disclosed**.

The full cross-service table — every shared secret, and which of them carry a different variable name
on each side — is [`../../CLAUDE.md`](../../CLAUDE.md) § The cross-service contract, and is not
restated here.
