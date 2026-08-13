# wi-admin — Administration Backend

The **only** backend the admin dashboard talks to. Owns every administration operation on
the WiMall platform.

| | |
|---|---|
| Stack | Express 4 · TypeScript · Mongoose 8 · Redis · Zod · pino |
| Port | `8033` |
| API | `/api/v1` (versioned) · `/health/*` (unversioned) |
| Phase | **4 + 3.5 complete**, plus **user management** — foundation, authentication, authorization, data access, the API contract, the audit subsystem, and the first fully-built platform domain. Porting the remaining legacy endpoints (5) is next |

## Where this service sits

```
vendor / agency / agent / customer apps ──► jovi-mall  (:8022) ──┐
                                                                 ├──► geo-tracker (:8090)
admin dashboard ────────────────────────► wi-admin   (:8033) ──┘

wi-admin ──► jovi_mall database  (shared with jovi-mall)
         └─► wi-admin  database  (private: admin identity, sessions, audit)
```

An admin **never** calls jovi-mall. Vendor/agency/agent/customer apps **never** call
wi-admin. Both backends read the shared platform database; only this one can see `wi-admin`.

Design record: [`docs/`](./docs) — start with `IMPLEMENTATION-BLUEPRINT.md`.

**API contract: [`docs/api/`](./docs/api) — the official reference for frontend development.**
Every one of the 179 versioned endpoints, with its authentication, permission, parameters, body,
response, errors, pagination, filters and sorting. Start at [`docs/api/README.md`](./docs/api/README.md).

## Commands

```bash
npm run dev              # ts-node-dev, hot reload, :8033
npm run build            # tsc → dist/
npm start                # node dist/server.js
npm run lint             # eslint, zero warnings allowed

npm run bootstrap:admin -- --email you@example.com --name "Your Name"
npm run ensure:indexes   # build wi-admin indexes (production: autoIndex is off there)
npm run authz:matrix     # print the level → permission matrix
npm run audit:export -- --from ISO --to ISO [--purge]   # export the audit trail; --purge deletes aged rows

npm run test:foundation  # 66  assertions — NO infrastructure needed
npm run test:contract    # 97  assertions — NO infrastructure needed
npm run test:audit       # 103 assertions — NO infrastructure needed
npm run test:auth        # 49  assertions — NO infrastructure needed
npm run test:authz       # 130 assertions — NO infrastructure needed
npm run test:data-access # 37  assertions — NO infrastructure needed
npm run test:users       # 61  assertions — NO infrastructure needed
npm run test:notifications  # 88 assertions — NO infrastructure needed
npm run verify:notifications # 53 assertions — NEEDS Mongo + Redis
npm run verify:live      # 32  assertions — NEEDS Mongo + Redis
npm run verify:auth      # 64  assertions — NEEDS Mongo + Redis
npm run verify:authz     # 84  assertions — NEEDS Mongo + Redis
npm run verify:platform  # 30  assertions — NEEDS Mongo + Redis + a RUNNING jovi-mall
npm run verify:users     # 52  assertions — NEEDS Mongo + Redis + a RUNNING jovi-mall
npm run verify:audit     # 26  assertions — NEEDS Mongo (a replica set) + Redis
```

Tests follow jovi-mall's convention — plain `ts-node` scripts with hand-rolled asserts, no
runner. `verify:live` exists because the DB-free suite structurally cannot prove that both
Mongo connections land on *different, correct* databases, that readiness reports real
per-dependency state, that CORS actually withholds the header, or that the drain closes
everything.

## Setup

```bash
cp .env.example .env     # defaults target localhost Mongo + Redis
npm install
npm run dev
```

`GET /health/ready` should return `200` with `mongoPlatform`, `mongoAdmin` and `redis` all
`up`. `joviMall` reads `not_configured` until you set `JOVI_MALL_BASE_URL` — which stays optional:
delegated routes answer 503 without it and everything else works, so local work on the direct-read
domains needs no second service running.

Redis is a **hard boot dependency** as of Phase 2: sessions live there, so a service that
cannot reach it cannot authenticate anyone and refuses to start rather than serving 500s
that look like an application fault.

Then create the first administrator — the only way one comes into existence, since
self-registration is gone from both services:

```bash
npm run bootstrap:admin -- --email you@example.com --name "Your Name"
```

It prints a generated password once and refuses to run when **any** administrator already
exists — as of Phase 3 it creates the first one only, always a Developer. Every other
account is created through `POST /api/v1/administrators`, which records who created it and
enforces the level rules the CLI cannot. A tier-1 account **requires TOTP**: its first sign-in returns a
session scoped to `/auth/mfa/enroll` and `/auth/mfa/activate` and nothing else — without
that scope the requirement would deadlock, since enrolling needs a session and the session
needs enrolment.

## Authentication

| | |
|---|---|
| Authority | **this service**, for administrators. jovi-mall has no `admin` role at all |
| Access token | HS256 `{sub, sid, tier, typ}`, `ADMIN_JWT_SECRET`, 15 min |
| Refresh | rotated on every use; replaying a superseded token **destroys the session** |
| Resolution | `admin_access_token` cookie first, then `Authorization: Bearer` |
| Session | 8 h idle (Redis TTL) / 7 d absolute, server-side and individually revocable |
| Logout | revokes server-side — the token dies on the next request |
| MFA | TOTP, mandatory at or above `ADMIN_MFA_REQUIRED_TIER` (default 1) |
| CSRF | double-submit on cookie-authenticated writes; Bearer is exempt |

`ADMIN_JWT_SECRET` is deliberately **not** jovi-mall's `JWT_SECRET`. geo-tracker holds that
one, so signing admin sessions with it would let a geo-tracker compromise mint admin
sessions. The accepted consequence: geo-tracker cannot verify admin tokens, so **admin live
tracking needs a bridge**, designed when the tracking surface is built.

Handlers read `req.admin` (typed `AdminIdentity`) via `requireAdminIdentity(req)` — never
`req.auth`, which is jovi-mall's differently-shaped property.

## Authorization

Authentication settles **who**; this settles **whether they may**. Four layers, each doing
something the one before it cannot ([ADR-003](./docs/ADR-003-GRANULAR-PERMISSIONS.md)):

| Layer | Question | Where |
|---|---|---|
| Permission | May you do this kind of thing at all? | `permission.catalog.ts` + `authorize.middleware.ts` |
| Escalation | May you do it to **this administrator**? | `escalation.rules.ts` |
| Scope | Which records of this kind are yours to see? | `resource-scope.ts` |
| Dual control | Does a second administrator have to agree? | `dual-control/` |

**Levels — lower number is more privilege.** `npm run authz:matrix` prints the resolved sets.

| | Holds |
|---|---|
| **1 Developer** | Everything |
| **2 Admin** | The operational surface including money. **Not** `administrators.tier.set`, `files.delete`, `users.roles.manage`, or any developer tool |
| **3 Support** | Tickets, plus read-only lookups. Nothing financial, nothing destructive, no sight of the administrator directory |

Privilege nests (3 ⊆ 2 ⊆ 1) and the service **refuses to start** if it does not, or if a
permission is granted to nobody, or if an escalation permission reaches below tier 1, or if
anything financial or destructive reaches Support.

**Routes declare who may call them, or the service does not boot.** `defineRoute()` is the
only sanctioned way to register one and `access` is required; `assertRouteManifestComplete()`
fails startup if anything reached Express without it; and `test:authz` scans every
`*.routes.ts` for a raw `router.get(`. Three layers, because "remember the guard" does not
survive the 81 endpoints arriving at Phase 5.

```ts
defineRoute(router, {
    mountedAt: '/administrators',
    method: 'put',
    path: '/:adminId/tier',
    access: permission('administrators.tier.set'),   // or selfService() / publicRoute()
    validate: { params: AdminIdParamSchema, body: SetTierSchema },
    handler: AdministratorController.setTier,
});
```

`PermissionName` is derived from the catalog, so a misspelled permission is a **compile
error**. Permissions exist for endpoints that are not built yet — `phase` says which builds
them, and `legacy-endpoint-map.ts` maps all 81 legacy endpoints to theirs.

**No permission cache.** `PERMISSION_CACHE_DB = 3` stays unused: the grant table is static
code, so there is nothing to invalidate, and `tier` is re-read from Mongo every request
anyway. A cache would be slower and would let a stale verdict survive a policy deploy.

**Four-eyes.** A dual-controlled action answers **202 with a pending approval** rather than
executing, and the *approver's* request performs the write. Live today on the two most
dangerous writes: promoting anyone to Developer, and one Developer suspending another —
which is what makes a compromised Developer account containable at all. Financial endpoints
inherit it at Phase 5 by declaring a threshold predicate.

**Denials go through one function.** `recordAuthorizationDenial()` writes a structured warn
line today; Phase 3.5's audit writer replaces its body and no call site moves.

**A single-Developer installation cannot suspend that Developer** through the API — the
review needs a second one. Deliberate; the database is the break-glass path.

## Data access

Where each domain's data lives, and how this service reaches it. Recorded once, in
[ADR-004](./docs/ADR-004-DOMAIN-OWNERSHIP.md) — the table there covers all 18 domains.

**One rule, and everything follows from it:**

> Admin **reads** `jovi_mall` directly where it needs to. Admin **writes** `jovi_mall` only
> through jovi-mall's internal API. The single exception is the two blog collections, whose
> ownership moved here.

Reads protect no invariant, so a second reader costs nothing. Writes are transactions
paired with post-commit events — a second writer would get the money right and silently
get the notifications wrong.

| | Reached by |
|---|---|
| Administrators · sessions · approvals · audit | this service's own `wi-admin` database |
| Agents · COD · money · billing · tickets · files | **HTTP** to `/api/internal/admin/*` |
| Users · vendors · customers · orders · shipments | **direct read**; writes over HTTP |
| Articles · authors | **owned here** — jovi-mall keeps no writer |

`/api/v1/users` is where that third row is visible in one module: the list, the detail and
the activity feed query the collection, while the three writes leave through a gateway.
Read [ADR-007](./docs/ADR-007-USER-MANAGEMENT.md) before adding a verb to it — the split
is not stylistic, and three obvious-looking verbs are missing on purpose.

**The rule is enforced by the type system, not by discipline.**
`src/infra/platform/platform-collections.ts` declares each collection's access class, and
`PlatformReadRepository` **has no write method to call**. `PlatformOwnedRepository` does,
but its type parameter accepts only collections marked `owned` — pointing one at `users` is
a compile error. That is the only abstraction this layer adds, and it is the whole reason
it exists.

**Collection names are a verbatim copy** of jovi-mall's `core/database/collections.ts` —
pure frozen constants, the one artifact safe to duplicate, because a Mongoose model imported
across the boundary registers on the wrong connection and drags in config that throws.
`test:data-access` re-reads the original and fails if a name drifted; a rename there would
otherwise just return an empty list.

**Direct reads are typed read-models over the raw driver.** No schemas are redeclared and no
models are registered on the platform connection. Every repository names an explicit
projection — a whitelist, so a credential-shaped field added upstream next year does not
arrive here automatically.

**The delegation client** (`infra/platform/platform.client.ts`) carries the acting
administrator in headers, passes jovi-mall's status and error code through rather than
remapping them, and **retries GETs only** — jovi-mall has no idempotency keys, so a retried
`confirm` would settle twice.

## Audit

Every administrator action is recorded in `admin_audit_log`, in the private `wi-admin`
database. Design record: [ADR-006](./docs/ADR-006-AUDIT.md).

**The guarantee: an action that cannot be audited does not happen.** A write to `wi-admin`
commits its audit row in the *same transaction*, so there is no ordering in which one
exists without the other. `verify:audit` proves it by forcing the audit insert to fail
during a tier change and asserting the tier did not move.

| | |
|---|---|
| Local writes | one transaction — `auditedTransaction`. **`wi-admin` must be a replica set**; the service refuses to start otherwise |
| Redis / jovi-mall writes | intent → outcome — `auditedAttempt`. The intent commits first, so an unrecordable action is never performed |
| Identity events | best-effort. A login has nothing to roll back, and failing closed there is a lockout with no way in to fix it |
| Denials | best-effort, through the Phase-3 seam — signature and all four call sites unchanged |
| What a row keeps | the fields that **changed**, credential shapes stripped by name, capped and flagged when truncated |
| Who reads it | `audit.read` — all three tiers, scoped per row: Support sees platform activity and its own actions, never administrators, approvals or exports |
| Retention | a row leaves the DB only if **exported AND** older than `ADMIN_AUDIT_RETENTION_DAYS`. Enforced by a TTL index with a partial filter on `export_id`, so an unexported row is not in the index at all |

Two feeds, from one trail: `GET /administrators/:id/activity` (what they did) and
`/history` (what was done to their account, four-eyes changes included). Every
administrator reads their own at `/administrators/me/activity` without a permission.

```bash
npm run test:audit       # 103 assertions, no infrastructure
npm run verify:audit     #  26 assertions, needs Mongo + Redis
```

## The API contract

Every endpoint answers the same seventeen questions the same way, decided once in
[ADR-005](./docs/ADR-005-API-CONTRACT.md) and enforced by shared primitives rather than by
discipline. Read it before writing a route.

| | |
|---|---|
| Surface | `/api/v1/**` · `/health/*` unversioned, mounted before the rate limiter |
| Success | `{ success: true, data, meta?, message? }` — `sendSuccess` / `sendCreated` / `sendPaginated` |
| Error | `{ success: false, requestId, error: { code, message, statusCode, details? } }` — **branch on `code`, never on `message`** |
| Lists | `?page=1&limit=20` (max 100), `?sort=-createdAt` against a declared allowlist, `meta.pages = ceil(total/limit)` |
| Wire types | camelCase · `id` as a 24-hex string · ISO-8601 UTC instants · absent data is `null`, never omitted |
| Actions | a POST sub-resource (`/remittances/:id/confirm`), because the permission and the audit row attach to the action |
| Queued | a dual-controlled action answers **202** with the pending approval — accepted, not refused |

The primitives are `core/validation/common.schemas.ts` (ids, search terms, ISO instants,
date ranges, boolean flags), `core/http/list-query.ts` (pagination, sort, `toPageMeta`) and
`core/data/mongo-list.ts` (sort translation, regex-safe search). Use them; a hand-rolled
copy is how the contract drifts.

```bash
npm run test:contract    # 97 assertions, no infrastructure
```

## Things to know before editing

**Register models on a connection, never globally.** There are two databases, so
`mongoose.model(...)` is always wrong here — use `platformConnection().model(...)` or
`adminConnection().model(...)`. A globally-registered model binds to a default connection
this service never opens: it throws nothing, and every query hangs.
See `src/infra/mongo/connections.ts`.

**One mount per path prefix.** jovi-mall stacks five routers on bare `/admin`, so
authentication re-resolves up to five times per request and a duplicated path silently
becomes dead code. `src/api/index.ts` documents the rule.

**Errors go through `createAppError()`, responses through `next(error)`.** ESLint enforces
both. The response envelope in `src/core/http/responses.ts` is identical to jovi-mall's and
must not drift.

**Do not hand-roll a pagination pair, an id regex, or a search escape.** Each of those had
grown two-to-four copies by Phase 4, and the copies of the `pages` formula had already
disagreed. `common.schemas.ts`, `list-query.ts` and `mongo-list.ts` are the single
definitions — see [ADR-005](./docs/ADR-005-API-CONTRACT.md).

**Never log a credential.** `src/core/logging/logger.ts` redacts by pattern; a new
credential-shaped field needs an entry in `REDACTED_PATHS`, and `test:foundation` asserts
the list stays complete.

## Corrections carried in from Phase 0

Each of these is a defect catalogued in `docs/PHASE-0-DISCOVERY.md`, fixed here by construction:

| jovi-mall | wi-admin |
|---|---|
| `process.env.X \|\| 'default'` in six places, incl. `JWT_SECRET \|\| 'secret'` | one Zod-validated config, fails closed, reports every problem at once |
| `cors({ origin: true, credentials: true })` — reflects any origin | exact-match allowlist, normalised origins |
| `console.*` logging (leaked a refresh token to stdout) | pino with a redaction list |
| No rate limiting anywhere | global limiter; strict auth limiter in Phase 2 |
| No body size limit | `1mb` |
| No graceful shutdown | bounded drain: server → both DBs → Redis |
| `GET /health` → `{status:'ok'}` | split liveness / readiness with per-dependency detail |
| CSP relaxed to `script-src 'unsafe-inline'` | helmet defaults, unrelaxed |
| `AUTH_ROLE_NOT_FOUND` returned for a 403 | dedicated `AUTHZ_*` family |
| `autoIndex` on in production (silent index failures) | off in production |
| **The password check is commented out** — any password logs in | the verdict is used; `verify:auth` asserts it |
| Login throws before bcrypt on an unknown account (timing oracle) | a comparison always runs; same code, same timing |
| No revocation — logout only clears cookies | server-side sessions; logout kills the token now |
| Refresh never rotates, 30-day lifetime | rotated per use, with reuse detection |
| No lockout, no login throttling | per-account lockout + per-IP credential limiter |
| `two_factor_enabled` stored and enforced nowhere | real TOTP, mandatory above a configurable tier |
| `User.status: 'suspended'` never read or written | suspension kills live sessions on the next request |
| `last_login_ip` never populated (`recordLogin` has no callers) | written on every successful login |

## Scope so far

**Phase 1** — project config, fail-closed environment, dual Mongo connections, Redis
factory, pino logging, error system, response envelope, validation middleware, security
middleware, CORS allowlist, rate limiting, liveness/readiness, graceful drain, testing
foundation, `/api/v1` versioning, jovi-mall reachability ping.

**Phase 2** — `admin_accounts` + `admin_sessions` in `wi-admin`, password hashing, tokens,
revocable sessions, refresh rotation with reuse detection, lockout, TOTP, CSRF, the
credential rate limiter, `requireAdmin`, the typed `AdminIdentity`, the bootstrap CLI, and
`/api/v1/auth` (login · mfa/verify · refresh · logout · logout-all · me · sessions ·
mfa/enroll · mfa/activate).

**Phase 3** — the permission catalog (~95 permissions) and tier grants, `requirePermission`,
`defineRoute` + the boot manifest assertion, escalation rules, four-eyes with
`admin_approval_requests`, the resource-scope primitive, denial recording, and three new
surfaces: `/api/v1/administrators` (create · read · update · suspend · reinstate · tier ·
sessions · password-reset), `/api/v1/permissions` (catalog · me · tiers) and
`/api/v1/approvals` (queue · approve · reject · withdraw). Plus `legacy-endpoint-map.ts`,
which maps all 81 legacy endpoints to their permission for Phase 5.

**Phase 4** — the data-access layer and the ownership map ([ADR-004](./docs/ADR-004-DOMAIN-OWNERSHIP.md)):
the copied collection constants, the access table, the two repository bases, the delegation
client's operation layer, and `requireAdminCaller` + `/api/internal/admin/*` on jovi-mall's
side. Proven on one vertical slice of each transport — `/api/v1/cod` (5 endpoints,
delegated) and `/api/v1/users` (2 endpoints, read direct).

**User management** ([ADR-007](./docs/ADR-007-USER-MANAGEMENT.md)) — the first platform
domain built out end to end, and the one where both transports appear side by side: list ·
search · filter · detail with role profiles · activity (**direct read**), edit identifiers ·
suspend · restore (**delegated**). The enabling change is in jovi-mall, not here —
`users.status` was written by nothing and read by nothing, so it is now enforced at
`login`, at refresh rotation and on **every authenticated request**, which is what makes a
suspension end live sessions rather than label an account.

Three verbs are deliberately **not** built and say so in the permission catalog: forced
sign-out (jovi-mall has no session store to revoke), password reset (no
administrator-initiated flow exists there) and role management (removing a role has no
implementation and no safe semantics — it strands the Store or Magazin it provisioned).

**The delivery network** ([ADR-009](./docs/ADR-009-DELIVERY-NETWORK.md)) — agencies and
delivery agents, 23 endpoints across two prefixes. It refines the read half of the split
rather than repeating it: **delegate a read whose answer is a VERDICT the platform acts on,
read directly a read whose answer is a RECORD**. So the directories, rosters and contract
histories are direct reads, while an agent's eligibility, tracking policy and COD allocation
are delegated — those three are answers the dispatcher itself branches on.

Four things it fixed rather than documented: there was **no agent list anywhere** (detail
only, so an administrator could not find an agent without already having their id);
`pending_verification` had **no exit** except a misnamed `reactivate`, so `agencies.verify`
is new; the admin **Tracking Allow switch reached geo-tracker through no path at all**, so
it is now an outbox event and a two-repo protocol change; and neither collection had an
index behind the screens being built.

The tracking boundary is the part to read before extending it — this service has **no door
into geo-tracker** and does not serve a live position or a GPS trail (ADR-009 D-2).

Not built: the remaining 61 ported endpoints (Phase 5);
customers/orders/shipments (Phase 6); API documentation (Phase 8).

The operations surface reserved as "Phase 7" shipped under later work items and the phase
numbering here no longer matches the ADR numbering. `/system` and `/dev-tools` landed in
Phase 12 (`ADR-012`); Phase 14 (`ADR-014-SYSTEM-OPERATIONS.md`) extended them to the
platform's own diagnostics — dependency health, integration status, queue depth, cache
status, background jobs and operational metrics — plus two capabilities that did not exist
before: **maintenance mode** and a **bounded cache flush**. jovi-mall grew the real
diagnostics; this service delegates and renders them. geo-tracker was not touched
(ADR-009 D-2, reaffirmed).

Three things ship declared but with no consumer until their phase, on purpose — so those
phases wire a decided rule rather than inventing one: the **ticket scope resolver**
(`resolveScope('tickets')`, consumed at Phase 5 with the ticket module), the
**amount-threshold form of dual control** (financial permissions are flagged; the predicate
arrives with the endpoint), and **`PlatformOwnedRepository`** (the blog domain moves here at
Phase 5; until then nothing writes `jovi_mall` at all).

**Upgrading a running instance:** existing sessions keep working, but an administrator
sitting at tier 3 is now denied most routes — that is the phase working. Run
`npm run ensure:indexes` before first boot in production, since the partial unique index on
`admin_approval_requests.request_key` is what makes four-eyes idempotent and `autoIndex` is
off there.
