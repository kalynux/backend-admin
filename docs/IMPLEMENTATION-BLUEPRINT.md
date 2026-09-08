# Admin Backend — Implementation Blueprint

**Verified against source on 2026-09-08** — the phase ledger it records, against the live manifest and `package.json` — the surface it plans to reach is built, and wi-admin now runs **24** `test:*` and **15** `verify:*` suites. Every route, error code, permission and audit action this page names was re-checked against the live route manifest and the four registries — `permission.catalog.ts`, `audit.catalog.ts`, and both services' `error-codes.ts`. ⚠ **This is a dated design record.** Its *Context* sections describe what PHASE-0 or the phase found **at the time** and are correct as history, not as a description of the service today; where a decision is still the live rule it says so at its own D-item.

**Status:** Decisions locked. Ready to build on your go-ahead.
**Supersedes** the open questions in [ADR-001](./ADR-001-DATA-ACCESS-MODEL.md) and
[ADR-002](./ADR-002-TARGET-ARCHITECTURE.md). Their measurements stand; this file is the decided state.

---

## 1. Locked decisions

| # | Decision | Choice |
|---|---|---|
| **R1–R8** | Service boundaries | 3 services by audience; shared `jovi_mall` DB; private `wi-admin` DB |
| **D1** | Shared business logic (94.6%) | **HTTP to a jovi-mall internal API.** Admin owns the admin-only 5.4% + all new domains directly against `jovi_mall`; the 17 shared services are reached over `/api/internal/admin/*` with a service token |
| **D2** | Cross-process events | **Redis pub/sub** transport |
| **D3** | Admin identity | **Full separation** — admin identity exists only in `wi-admin`; actor fields become polymorphic |
| **D4** | Audit log | **`wi-admin`**, written intent → outcome with a correlation id |
| **D5** | First admin | Idempotent **bootstrap** CLI |
| **D6** | Cutover | **Big-bang** at Phase 8 |
| **D7** | Stack | Express + TypeScript + MongoDB + Redis |
| **D8** | Permissions | **Granular permissions in code, granted by tier** (L1/L2/L3), no per-admin overrides. *Amended by ADR-003 — was "fixed tiers, no permission catalog"* |
| **D9** | Workers | All 15 stay in jovi-mall; admin gets visibility only |

**On R4:** under D1, the admin *dashboard* never contacts jovi-mall — every browser request goes to
the admin service. The admin *backend* does call jovi-mall's internal API server-to-server, exactly
as geo-tracker already does. That is the reading you selected; recording it here so it is not
relitigated later.

**Operational consequence of D1:** the admin service depends on jovi-mall being reachable for the 17
shared services. Admin-only reads, all new domains, and login/audit keep working when it is down.

---

## 2. Two corrections that change the estimates

### 2.1 Full separation is far cheaper than I quoted — `ref: MODELS.USER` is decorative

When I presented D3, I said full separation requires changing "every populate". I measured it:

```
.populate() call sites in the entire jovi-mall repo:  5 files
… that touch an actor (_by) field:                     0
```

**31 actor fields across 12 models declare `ref: MODELS.USER`, and not one is ever dereferenced.**
The refs are documentation, not behavior. So D3-b's read-path migration cost is **zero**, not the
"every populate" I warned about.

Of those 31 fields, only the ones an admin can write need to change. Traced from the admin
controllers, that is **~10 fields across 6 models**:

| Model | Admin-written field |
|---|---|
| `cod/agency-remittance` | `resolved_by_user_id` |
| `cod/agent-deposit` | `recorded_by_user_id` |
| `cod/cod-discrepancy` | `resolved_by_user_id` |
| `earnings/payout-request` | `resolved_by` |
| `billing/subscriber-plan` | `assigned_by` |
| `agents/agent` | `verified_by_user_id`, `banned_by_user_id`, `changed_by_user_id` |
| `agents/agent-agency-membership` | `suspended_by_user_id`, `deactivated_by_user_id`, `approved_by_user_id` |

The remaining ~21 fields hold only platform actors (vendor/agency/agent/customer) and stay unchanged.

**Actor representation.** Each admin-writable field gains a companion source discriminator and a
denormalized display snapshot:

```ts
resolved_by_user_id : { type: Schema.Types.ObjectId, default: null },        // ref: dropped
resolved_by_source  : { type: String, enum: ['platform','admin'], default: 'platform' },
resolved_by_name    : { type: String, default: null },                       // snapshot at write time
```

The snapshot matters: jovi-mall cannot read `wi-admin`, so without it an agency viewing a remittance
would see "resolved by <unresolvable id>". Denormalizing the name at write time is the standard fix
and avoids any cross-DB join.

**Migration** (one script, jovi-mall): for each of the ~10 fields, set
`*_source = 'admin'` where the referenced `users` row has `'admin'` in `roles`, else `'platform'`;
backfill `*_name` from the existing role entity. Determinable entirely from existing data.

> ⚠️ **Corrected in Phase 4 (ADR-004 correction 1).** The claim that follows from this section —
> that `requireAdminCaller` need only inject `{ user: { id }, role: 'admin' }` because all 16
> `req.auth` reads take `user.id` — is true of the nine `admin-*` controllers and **false** of the
> shared controllers those routers also mount. `ticket.controller.ts` reads `role_entity._id` on 24
> lines and compares `ticket.assigned_admin_id` (declared `ref: MODELS.ADMIN`) against
> `role_entity.id`; `file-management.controller.ts` passes the whole `role_entity` document. The
> shipped middleware synthesises all of it. The `.populate()` measurement below is confirmed correct.

### 2.2 Redis pub/sub is foundation, not a blocker for the port

The 3 admin-only services (`admin-agency`, `article-author`, `admin-profile`) emit **no domain
events**. All 18 event-emitting services are in the shared 17 — which under D1 are invoked *inside
jovi-mall's process* over HTTP. **Their subscribers therefore fire in-process, naturally, with no
transport needed.**

Redis pub/sub is still required, but for a narrower and later purpose:

- events raised by admin's **own direct-DB writes** in the new domains (Phase 6) — e.g. suspending a
  vendor should reach jovi-mall's product-suspension logic;
- the admin notification stack;
- keeping the door open so a future direct write is never silently inert.

It does **not** gate porting the 81 endpoints. The silent failure mode from ADR-002 §2.3 is closed by
D1's HTTP delegation, not by the transport.

**Status: deferred to Phase 1.5.** The approved Phase 1 plan shipped the Redis *factory* (clients,
logical DBs, readiness probe, shutdown) but not the pub/sub bridge. Because delegation makes the 81
endpoints' subscribers fire in-process, nothing before Phase 6 needs it — but it MUST land before the
first admin direct write whose platform side effects matter (suspending a vendor, Phase 6) and before
the admin notification stack (Phase 7).

---

## 3. Target architecture

```
┌──────────────────┐                              ┌──────────────────┐
│ Vendor / Agency  │                              │ Admin Dashboard  │
│ Agent / Customer │                              └───┬──────────┬───┘
└────┬────────┬────┘                                  │          │
     │        └──────────────┐            ┌───────────┘          │
     ▼                       ▼            ▼                      │
┌──────────┐          ┌──────────────┐  ┌────────────────┐       │
│jovi-mall │─────────►│ geo-tracker  │◄─│  admin :8033   │       │
│  :8022   │          │    :8090     │  └──┬──────┬──────┘       │
└────┬─────┘          └──────────────┘     │      │              │
     │  ▲                                  │      │              │
     │  │  /api/internal/admin/*           │      │              │
     │  └──────────────────────────────────┘      │              │
     │     service token · 17 shared services     │              │
     ▼                                            ▼              ▼
┌──────────────────────────────────┐   ┌────────────────────────────┐
│  MongoDB · jovi_mall  (SHARED)   │◄──│  MongoDB · wi-admin        │
│  85 models · platform data       │   │  admin identity · audit    │
└──────────────────────────────────┘   └────────────────────────────┘
        ▲                                    (no cross-DB joins, ever)
        └── admin READS directly for the 9 new domains; writes go over HTTP (ADR-004 D-2)
```

**Admin's three data paths, and the rule for choosing:**

| Path | Used for |
|---|---|
| `wi-admin` direct | Admin identity, sessions, MFA, audit, admin notifications |
| `jovi_mall` direct — **READ ONLY** | Reads for the 9 new domains (users, vendors, customers, orders, shipments, …). Writes go over HTTP. The one exception is the 2 blog collections, whose ownership moves here — ADR-004 D-2 |
| jovi-mall HTTP | The shared services, **and every platform write** — anything whose invariants or events also serve another role |

> **The rule (Phase 4, ADR-004 D-2):** admin READS `jovi_mall` directly where it needs to and WRITES
> it only through jovi-mall. Reads protect no invariant; writes are transactions paired with
> post-commit events, and a second writer gets the money right while silently getting the
> notifications wrong. Enforced by the type system — see `infra/platform/platform-collections.ts`.

---

## 4. What gets built

### 4.1 jovi-mall — changes

| # | Work | Size |
|---|---|---|
| J1 🔴 | Remove `'admin'` from `auth.schemas.ts:43,59` and both `AuthService` branches (`:166`, `:294`) — closes public admin registration + self-elevation | ~10 lines |
| J2 ✅ | Fail closed when `JWT_SECRET` unset (drop the `\|\| 'secret'` fallback) | 1 line + boot guard. **Done** — `getJwtSecret()` + `assertSigningSecrets()`. geo-tracker had the same fallback and it was closed separately on 2026-08-19 (Phase 3 step 3.E.2) |
| J3 🔴 | Remove the refresh-token `console.log` in `auth.middleware.ts` | 1 line |
| J4 ✅ | New `requireAdminCaller` middleware — constant-time service-token compare + **synthetic actor** from headers. Shipped Phase 4; the actor is richer than "a userId" — see ADR-004 D-1 | ~130 lines, 2 files |
| J5 ✅ | **Dual-mount** the admin routers under `/api/internal/admin/*` via a per-router factory — NOT a guard swap, see ADR-004 D-5. **Complete, and then half-undone by design**: the cutover (J10, Phase 5 Part E) deleted every public mount, so each factory now has exactly one instantiation. The factory shape survives and is still the shape to follow — a Router instance cannot be mounted twice because its `router.use` guards re-run, which is why the guards are a parameter, and it is what made the cutover subtractive | ~35-line factory refactor per router |
| J11 ✅ | **Enforce `User.status`** at `login`, at `rotateRefreshToken` and in `requireAuth`. The column was written by nothing and read by nothing, so an admin suspension endpoint would have been inert (ADR-007 D-1) | ~15 lines, 3 files |
| J6 ✅ | Polymorphic actor fields: `actorStampFields()` + `actorStamp()` in `core/types/actor-source.types.ts`. **Closed 2026-08-20** (Phase 4 step 22). The estimate here was "~8 fields"; enumerated from the source it is **twelve**, and every one now declares the pair. The backfill is `npm run backfill:actor-source` in jovi-mall — ledgered, idempotent, `--dry-run`, applied on dev. ⚠ It changes no rendered value: every wi-admin read site already defaulted a missing discriminator to `'platform'`, so what the backfill buys is a database that says what the screen says | §2.1 |
| J7 ✅ | Thread the actor through the shared services. **Closed 2026-08-20** (Phase 4 step 22). The "~14 remain" was written at Phase 4-of-wi-admin and went stale as each later phase threaded its own domain with the endpoint that needed it: a source census found **one** unthreaded actor-stamped write left, `CodDiscrepancyService.resolve`, which took `adminUserId: string` and wrote a bare id on an **admin-only** path. It takes an `ActorRef` now. `agent-deposit` keeps its additive-optional-fields shape — functionally complete, and a refactor for symmetry alone is not worth a money path's diff | ~16 signatures |
| J8 ⏸ | Redis pub/sub event transport in `core/events/event-bus.ts`. **Deliberately still open** — Phase 4 step 22 / [ADR-013](./ADR-013-NOTIFICATIONS.md) D-2 + Phase 4 D-16. The argument against building it as a bandage stands, and the instruction was "decide J8 with data": jovi-mall now emits `eventBusHandlerFailuresTotal` (Phase 4 step 6), which has **never run against real traffic**. Closing it now would be deciding it with the same absence of data that deferred it. Revisit in 6.K, with that metric's production numbers | 1 file + 1 new adapter |
| J9 | Move out the admin-only services — **4, not 3, and 746 LOC not 391**: `article.service` is admin-only too (ADR-004 correction 2). `admin-agency.service` **stays**, its cascade being jovi-mall's (ADR-004 D-4) | deletion |
| J10 ✅ | **DONE 2026-08-20 at the cutover** (Phase 5 Part E). The estimate said *"12 routers, 9 controllers, 81 routes, 13 api-doc files"*; what it actually was: **9 `router.use` mounts** (two blog ones had already gone at Part A), **7 public factory instantiations** plus `modules/admins/routes.ts`, **no controllers at all** (every factory kept its handlers — only the public instantiation went), and **2 api-doc files deleted, 8 repointed**. The api-doc estimate was the one that mattered: those pages document the surviving `/api/internal/admin/*` mount, which serves the identical routes, so deleting 13 of them would have left wi-admin's own door undocumented | deletion |

J1–J3 ship immediately and independently. Everything else lands with the phases below.

### 4.2 admin — greenfield

| Layer | Contents |
|---|---|
| Foundation | Express+TS, fail-closed config, error-code registry (extending jovi-mall's conventions, new `AUTHZ_*` family), response envelope, structured logging with redaction, request-id, health |
| Connections | `jovi_mall` (Mongoose #1) + `wi-admin` (Mongoose #2) + Redis + jovi-mall internal HTTP client + geo-tracker client |
| Identity (`wi-admin`) | `admin_accounts` (tier 1–3, password hash, TOTP secret, status, lockout), `admin_sessions`, `admin_audit_log`, `admin_notifications` |
| Bootstrap | Idempotent CLI creating the first L1 admin in `wi-admin`; refuses when an L1 exists. **No jovi-mall row needed** — full separation |
| AuthZ | **Granular permission catalog in code** (`family.resource.action`), tier→permission sets in code, one resolver. Each route declares `permission('x.y.z')` through `defineRoute`. No per-admin overrides, no policy collections. Plus escalation rules for administrator-on-administrator actions, four-eyes for the two most dangerous writes, and a row-level scope resolver. See **ADR-003** |
| Audit | Every mutation wrapped intent → outcome, correlation id propagated to jovi-mall as a header |
| Ported surface | The 81 endpoints, routed per §3’s rule (each already mapped to its permission in `legacy-endpoint-map.ts`) |
| New surface | Users, vendors (incl. wiring the dead `setLegitVerified` so vendor KYC approval exists at last), customers, orders list/detail/search, shipments, admin management, admin notifications, system info, developer tools |
| Docs | `admin/api-doc/` — the dashboard's source of truth |

---

## 5. Phases

| Phase | Scope | Exit gate |
|---|---|---|
| **0.5** ✅ | J1–J3 security patch in jovi-mall | ✅ Both escalation paths verified closed against a running server; existing admin login unaffected |
| **1** ✅ | admin foundation: config, both DB connections, Redis factory, logging, errors, envelope, validation, security + CORS, rate limiting, health, drain, testing, `/api/v1` | ✅ Boots on 8033; readiness green with both DBs distinct and correct; 55 + 32 assertions pass; fails closed on missing config |
| **1.5** | **J8 Redis event transport** — deferred out of Phase 1, which shipped the Redis *factory* only | An event published from admin provably fires a jovi-mall subscriber |
| **2** ✅ | **Authentication** in `wi-admin`: accounts, sessions (revocable), TOTP, lockout, credential rate limiting, CSRF, bootstrap CLI. The `tier` **field** ships; enforcement does not | ✅ A revoked session is refused on the next request; refresh reuse destroys the session; 211 assertions green |
| **3** ✅ | **Authorization & RBAC** (ADR-003): permission catalog, tier grants, the `requirePermission` guard, `defineRoute` + boot manifest assertion, escalation rules, four-eyes, scope resolver, the `/administrators` `/permissions` `/approvals` surfaces, and the 81-endpoint permission map for Phase 5 | ✅ An L3 admin is provably denied an L2 endpoint; 129 + 84 assertions green |
| **3.5** ✅ | **Audit subsystem** (D4) + correlation-id propagation — [ADR-006](./ADR-006-AUDIT.md). Model, writer, read surface, export/purge, and every existing mutation wired | ✅ An unauditable action provably does not happen: the audit insert is forced to fail and the tier does not change. 103 + 26 assertions green |
| **4** ✅ | **Data access & domain boundaries** (ADR-004): the ownership map for all 18 domains, both transports built (internal API + read-model repositories), and a vertical slice of each — 5 COD endpoints delegated, 2 user endpoints read direct | ✅ COD confirm from admin performs FIFO settlement **and** fires its subscribers; 37 + 28 assertions green |
| **5** ◐ | **The core API contract** ([ADR-005](./ADR-005-API-CONTRACT.md)) — URL/method/status conventions, the shared request vocabulary, the list contract, error-code discipline — then port the remaining 76 endpoints against it | Contract green at 97 assertions ✅; parity with today's admin surface |
| **6** ◐ | The 9 empty domains. **`users` is done** — [ADR-007](./ADR-007-USER-MANAGEMENT.md), 6 endpoints, both transports in one module | Users ✅ at 61 assertions, and a suspension provably ends live sessions rather than labelling an account. 8 domains remain |
| **7** | Ops: admin notifications, system info, worker visibility, outbox inspection, dev tools | — |
| **8** ✅ | `admin/api-doc/` + **big-bang cutover** (J10) | ✅ **DONE 2026-08-20**, pulled forward into Phase 5 Part E. jovi-mall serves no public admin traffic: zero live `requireRole(['admin'])` sites, zero `/api/admin/*` mounts, and `rotateRefreshToken` filters the role so a pre-cutover refresh token cannot mint one |

Audit (3.5) precedes any delegated mutation (4) deliberately — retrofitting an audit trail onto
working endpoints is exactly how the legacy `console.log` stub happened. Phase 3 built the single
call site it drops in behind (`denial.recorder.ts`) so no denial goes unrecorded in the meantime.

> **In the event, 4 and 5 overtook it and 3.5 landed afterwards.** The retrofit cost was real but
> contained, because the seam held: `recordAuthorizationDenial` kept its signature and all four call
> sites, and the COD wiring went into the *gateway* so Phase 5's remaining endpoints still inherit
> auditing by construction. What the ordering would have avoided is the part that did bite — three
> write paths had `destroyAllSessions` inside them, and wrapping those in a transaction unchanged
> would have left a rolled-back suspension that still signed the target out. See ADR-006 D-2.

**Numbering note.** Authorization was briefly numbered 2.5, with audit at 3. It is now **Phase 3**
and audit is **3.5**; phases 4–8 are unchanged.

---

## 6. Still open

1. ~~**Tier policy** — the operational split between L2 and L3.~~ **Settled in Phase 3.** The split is
   `tier-grants.ts`, and it is granular permissions rather than the `minTier` numbers proposed here —
   see [ADR-003](./ADR-003-GRANULAR-PERMISSIONS.md), which amends D8. In short: Support gets tickets
   plus read-only lookups; Admin gets the operational surface including money; Developer gets
   everything. `npm run authz:matrix` prints the resolved answer. All 81 legacy endpoints are mapped
   to their permission in `legacy-endpoint-map.ts` for Phase 5 to consume.

   Two things Phase 3 decided that were not asked here, both recorded in ADR-003: four-eyes is
   **revived** (`PHASE-0:436` promised it, then it vanished from every later document), and the
   endpoint census is **81, not 82** — the ticket router has 18 routes, not 19.

   > ⚠️ **Discovered 2026-08-10, in jovi-mall, NOT fixed here** — you took ownership of it:
   > `auth.service.ts:190-191` computes `isValid` from `bcrypt.compare` and the line that would
   > reject a mismatch is commented out. Any registered email or phone logs in with **any**
   > password, in whatever role that account holds. Committed since 2026-02-11. It outranks the
   > Phase 0.5 escalation: there is no need to self-register as an admin if you can log in as one.
2. **Admin service port** — proposing `8033`. Confirm or override.
3. ~~**`wi-admin` placement** — separate `mongod` instance, or another database on the same server?~~
   ✅ **ANSWERED 2026-08-20** (Phase 4 step 22), by recording what the code has been enforcing
   since Phase 3.5. **wi-admin's database must be a replica set** — a shared `rs0` with jovi-mall
   is what runs today and is correct; a standalone `mongod` is **not an option**, whether separate
   or shared. The audit subsystem is fail-closed and every audited write is transactional, and
   MongoDB offers no transactions outside a replica set or a mongos, so
   `assertAuditStoreTransactional()` ([ADR-006](./ADR-006-AUDIT.md) D-7) **refuses to boot**
   against one. That gate was written *because* this question was open; it has since decided it in
   practice, and 2.B.4 of the production-readiness work forced the same answer operationally.
   ⚠ The separate-instance half is still free and is an **operational** choice, not an
   architectural one — a second `mongod` works provided it is a replica set of its own. What is
   closed is the standalone option, and `directConnection=true` on `MONGO_URI_ADMIN` (a habit
   while debugging) pins single-server topology and will refuse the boot for the same reason.
4. **Do admins keep a platform login at all?** Under full separation an admin authenticates only
   against `wi-admin`. If a person needs to be both an admin and a vendor, they will hold two
   independent accounts. Confirming that is intended.
