# ADR-002 — Target Architecture (re-derived from your directive)

**Verified against source on 2026-09-08** — the three-service shape it decides, against the live module list (`src/modules/`, 23) and `src/api/index.ts`. Every route, error code, permission and audit action this page names was re-checked against the live route manifest and the four registries — `permission.catalog.ts`, `audit.catalog.ts`, and both services' `error-codes.ts`. ⚠ **This is a dated design record.** Its *Context* sections describe what PHASE-0 or the phase found **at the time** and are correct as history, not as a description of the service today; where a decision is still the live rule it says so at its own D-item.

**Supersedes** the recommendation in [ADR-001](./ADR-001-DATA-ACCESS-MODEL.md). ADR-001's analysis
remains valid as measurement; its *conclusion* is overridden by the directive below.

**Status:** Understanding confirmed · 6 decisions open

---

## 1. The architecture as I understand it

```
┌────────────────────┐                      ┌──────────────────────┐
│ Vendor / Agency /  │                      │  Admin Dashboard     │
│ Agent / Customer   │                      │                      │
│ frontends          │                      │                      │
└─────┬──────────┬───┘                      └───┬──────────────┬───┘
      │          │                              │              │
      ▼          └──────────┐        ┌──────────┘              ▼
┌───────────┐               ▼        ▼               ┌──────────────┐
│ jovi-mall │        ┌──────────────────┐            │ admin        │
│  :8022    │───────►│   geo-tracker    │◄───────────│  :????       │
└─────┬─────┘        │      :8090       │            └──────┬───┬───┘
      │              └────────┬─────────┘                   │   │
      │                       │                             │   │
      │              ┌────────▼─────────┐                    │   │
      │              │ Postgres + Redis │                    │   │
      │              │  (geo-tracker's) │                    │   │
      │              └──────────────────┘                    │   │
      │                                                      │   │
      ▼                                                      ▼   │
┌──────────────────────────────────────────────────────────────┐ │
│              MongoDB  ·  jovi_mall   (SHARED)                │ │
│      85 models — users, orders, shipments, cod, earnings…    │ │
└──────────────────────────────────────────────────────────────┘ │
                                                                 ▼
                                        ┌────────────────────────────┐
                                        │  MongoDB · wi-admin        │
                                        │  admin credentials+profile │
                                        └────────────────────────────┘
```

**Rules I am designing to:**

| # | Rule |
|---|---|
| R1 | `jovi-mall` serves vendor, agency, agent, customer. **No admin endpoints remain in it.** |
| R2 | `geo-tracker` serves live GPS tracking. Unchanged. |
| R3 | `admin` serves **all** administration operations. |
| R4 | Admin dashboard talks **only** to `admin` and `geo-tracker`. Never to jovi-mall. |
| R5 | Vendor/agency/agent/customer frontends talk **only** to jovi-mall and geo-tracker. Never to admin. |
| R6 | Both `admin` and `jovi-mall` may talk to `geo-tracker`. |
| R7 | Both `admin` and `jovi-mall` read/write the **same** `jovi_mall` MongoDB. |
| R8 | Admin **login credentials and profile** live in a separate `wi-admin` MongoDB. |

All 82 admin endpoints move out of jovi-mall. This is a deletion in jovi-mall, not a deprecation.

---

## 2. The re-calculation

### 2.1 The number that drives everything

> ⚠️ **Two measurement errors, found in Phase 4 by re-tracing every importer. See
> [ADR-004](./ADR-004-DOMAIN-OWNERSHIP.md) corrections 2 and 3. The conclusion below survives both —
> the shared proportion barely moves — but two of the individual rows are wrong.**
>
> **(i) `article.service` is admin-only, not shared.** The named non-admin caller,
> `public-article.controller`, imports a *separate* `blog/services/public-article.service.ts`.
> `ArticleService`'s only importer outside a dead barrel is `admin-article.controller.ts`. Corrected
> split: **16 shared / 4 admin-exclusive**, 6,503 / 746 LOC — which makes the blog module 450 LOC of
> cleanly movable code rather than 355 LOC of shared code.
>
> **(ii) The tickets module is missing from the table entirely** — 18 endpoints, the largest single
> router, 6 services, 2,029 LOC, classified nowhere. `TicketService` is called by three OTHER
> services as a side effect of money movement (a failed refund, a payout request and a payment
> dispute each open a ticket), so it is more shared than anything listed. The real total behind the
> admin surface is ~26 services / ~9,278 LOC, not 20 / 7,249.

The 82 admin endpoints are served by **20 distinct services totalling 7,249 lines**. I traced every
caller of each:

| Service | LOC | Non-admin callers | Verdict |
|---|---:|---|---|
| `agent-contract.service` | 2,160 | agency-roster, agent-self | 🔗 shared |
| `agent-deposit.service` | 594 | agency-roster, agent-self, agency-cod, agent-cod, **worker** | 🔗 shared |
| `dispute.service` | 445 | payments webhook | 🔗 shared |
| `payout-request.service` | 386 | payout-request.controller, **worker** | 🔗 shared |
| `cod-discrepancy.service` | 371 | agency-cod, agent-cod, cod-exposure, **2 workers** | 🔗 shared |
| `article.service` | 355 | ~~public-article.controller~~ **none** | ✅ **admin-only** (corrected, Phase 4) |
| `agent-profile.service` | 347 | agent-self | 🔗 shared |
| `earnings-account.service` | 335 | vendor/agency/agent-earnings, split, refund, payout, **worker**, transactions | 🔗 shared |
| `agent-eligibility.service` | 311 | agency-roster, internal-agent | 🔗 shared |
| `subscriber-plan.service` | 295 | subscriber-billing, vendor-billing, entitlement, plan-purchase, **worker** | 🔗 shared |
| `agent-cod-threshold.service` | 269 | agency-roster, agent-contract | 🔗 shared |
| `agent-tracking-policy.service` | 232 | internal-agent (geo-tracker) | 🔗 shared |
| `cod-summary.service` | 223 | agency-cod | 🔗 shared |
| `agency-remittance.service` | 216 | agency-cod | 🔗 shared |
| `agent-gate.service` | 160 | agent-contract | 🔗 shared |
| `cod-trust.service` | 95 | cod-discrepancy | 🔗 shared |
| `pricing-plan.service` | 64 | public-billing, subscriber-billing, vendor-billing | 🔗 shared |
| `admin-agency.service` | 215 | — none — | ✅ admin-only |
| `article-author.service` | 95 | — none — | ✅ admin-only |
| `admin-profile.service` | 81 | — none — | ✅ admin-only |

```
Shared with non-admin callers:  17 services · 6,858 LOC · 94.6%
Admin-exclusive (can move):      3 services ·   391 LOC ·  5.4%
```

**This is the single most important number in the re-calculation.** "Move the admin operations to the
admin service" sounds like relocating a subsystem. In practice, 94.6% of the logic behind those
82 endpoints is *the same code the agency, agent, vendor and customer paths run*, plus five
background workers. Only ~391 lines are genuinely admin-only.

Concretely: `AgencyRemittanceService` has `declare()` called by the **agency** and `confirm()` /
`reject()` called by the **admin** — one class, one set of invariants (liability reduction, FIFO
settlement, earnings unlock), two callers on opposite sides of the new service boundary.

This does not block your architecture. It means **Decision D1 below is the decision that defines the
project**, and it cannot be deferred.

### 2.2 Data surface

- `jovi_mall` holds **85 models**. The admin surface touches roughly **45** of them
  (cod 7, billing 7, vendors 5, earnings 5, agents 5, tickets 4, orders 3, blog 2, files 3,
  delivery 1, customers 1, users 1, shipments 1, plus the Phase-6 domains).
- `wi-admin` holds new collections only — nothing migrates into it except the `admins` profile data.
- **There is no workspace root** (`backend/` has no `package.json`) and no shared package today.
  Any code sharing is new infrastructure.

### 2.3 What ADR-001's measurements still tell us

Two findings survive the change of direction and now become **implementation requirements** rather
than arguments:

**The event bus is in-process.** `core/events/event-bus.ts` is an in-memory `Map`. Admin-reachable
services publish **18 domain events**, and jovi-mall registers boot-time subscribers for a direct
subset — `payout.paid` (2 subscribers), `payout.rejected` (2), `payout.requested` (2),
`cod.deposit.recorded` (2), `cod.deposit.declared` (1), `cod.deposit.rejected` (1),
`cod.collection.recorded` (1), `plan.activated` (1).

Under R7 (shared DB, separate processes) a write from the admin process fires **none** of them, with
no error and no log line. Left unaddressed: marking a payout paid never notifies the vendor;
recording a COD deposit leaves the agent's app showing cash owed; assigning a plan never syncs the
agent's `max_active_shipments`. **This must be solved in Phase 1** — see D2.

**Actor fields reference the shared `users` collection.** Financial records store the acting admin in
a field that is an `ObjectId` ref to `MODELS.USER`, *and the same field also holds non-admin actors*:

```ts
// agency-remittance.model.ts
declared_by_user_id: { ref: MODELS.USER, required: true },  // ← the agency's user
resolved_by_user_id: { ref: MODELS.USER, default: null },   // ← the admin's user
```

Same pattern in `agent-deposit.model.ts`, `cod-discrepancy.model.ts`, `payout-request.model.ts`.
This directly constrains how R8 is implemented — see D3.

---

## 3. Decisions required

### D1 — How does `admin` execute the 94.6% of logic that is shared? ⭐ defines the project

| | Approach | Consequence |
|---|---|---|
| **D1-a** | **Shared code package.** New `backend/shared/` (npm workspace or file: dependency) holding the 85 Mongoose models + the 17 shared domain services. Both services import it. jovi-mall keeps its non-admin controllers; `admin` writes its own controllers over the same services. | One copy of every invariant — no drift. Both services rebuild/redeploy when shared code changes. Requires creating workspace infrastructure that does not exist today. The services stay independently *deployable*, but become build-time coupled. |
| **D1-b** | **Duplicate in `admin`.** Reimplement the ~6,858 LOC the admin surface needs. | True independence, zero shared infrastructure. Two implementations of FIFO cash settlement, escrow release and cascade suspension that must be kept in lockstep by hand. This is the risk Phase 0 flagged as the highest-severity design hazard. |
| **D1-c** | **Backend-to-backend HTTP for shared operations only.** `admin` holds its own logic for the admin-only 5.4%, and calls a jovi-mall internal API (service token) for the 17 shared services. Admin dashboard still never touches jovi-mall — R4 holds, because the caller is a server, not an admin. | One copy of the logic; events fire naturally in-process; no shared package. But `admin` depends on jovi-mall being up, and you may read this as violating the spirit of R3. |
| **D1-d** | **Hybrid.** Shared package for **models only** (thin, stable, rarely changes); D1-c HTTP for the ~8 invariant-heavy write operations (COD confirm/reject/deposit, discrepancy resolve, payout mark-paid/reject, plan assign); `admin` owns everything else directly against the DB. | Smallest coupling surface; events fire for the operations that emit them; most admin reads and simple writes stay direct-to-DB and fast. More concepts to hold in your head. |

**I need your call here before anything else is designed.** My reading of your directive is that you
want D1-a or D1-b (integration through the database, not HTTP). Between those two I would recommend
**D1-a** — the drift risk in D1-b lands squarely on cash handling and escrow, which are the most
expensive things in the system to get wrong. But if the intent behind R3 is that `admin` must be able
to run with jovi-mall completely offline, D1-b is the only option that delivers that, and I will
build it that way.

### D2 — Cross-process domain events (mandatory, no "do nothing" option)

| | Approach | Consequence |
|---|---|---|
| **D2-a** ⭐ | **Redis pub/sub transport.** Replace the in-memory bus internals so `publish()` also emits to a Redis channel, and subscribers register against Redis. Both services already depend on Redis (`infra/redis/redis.factory.ts`). | ~1 new file per service + one change to `event-bus.ts`. Events fire cross-process. At-most-once delivery — a subscriber down during publish misses the event. |
| **D2-b** | **Mongo change streams.** Watch the collections; derive events from writes. Your dev Mongo is already a replica set (`rs0`), so this is available. | No publisher changes at all, and it catches writes from *any* source. But it re-derives intent from data, which is lossy — `payout.paid` is obvious from a status change, `earnings.matured` is not. |
| **D2-c** | **Durable outbox + poller.** Admin writes an outbox row in the same transaction; jovi-mall drains and republishes locally. | At-least-once with retry — the strongest guarantee. The pattern already exists in the codebase (`tracking-integration` outbox → dispatch worker), so it is proven here. Highest cost, adds latency. |

Recommend **D2-a** for Phase 1, with **D2-c** reserved for the money-moving events if you want
delivery guarantees on those specifically. Note the existing tracking outbox has a known
non-transactional defect (documented in `CLAUDE.md`); a new outbox should not repeat it.

### D3 — How R8 is implemented, given the `users` FK constraint

You specified admin **credentials and profile** in `wi-admin`. The constraint from §2.3 is that
admin actor ids are written into `jovi_mall` financial records as refs to `jovi_mall.users`.

| | Approach | Consequence |
|---|---|---|
| **D3-a** ⭐ | **Anchor row, private credentials.** Each admin keeps a minimal `users` row in `jovi_mall` (id + `roles:['admin']` + status — **no password hash**). Credentials, profile, tier, sessions, MFA and audit live in `wi-admin`, keyed by that `user_id`. | Satisfies R8 literally — credentials and profile are in `wi-admin`. Referential integrity preserved, `populate()` keeps working, **zero data migration**. |
| **D3-b** | **Full separation.** Admin identity exists only in `wi-admin`. Actor fields on 4+ models become polymorphic (`actor_id` + `actor_source`). | Cleanest conceptually. Requires migrating existing rows, changing 4 models and every read that populates them, and jovi-mall can no longer resolve "who confirmed this remittance" without a cross-DB call. |
| **D3-c** | **Opaque ids.** Store the `wi-admin` id in the existing `ObjectId` field without integrity. | No migration, no schema change. `populate()` silently yields `null` on every admin-acted record. Not recommended. |

Recommend **D3-a**. It meets your requirement as written while costing nothing.

### D4 — Where the audit log lives, and its consistency guarantee

Audit is admin-private, so `wi-admin` is the natural home. But the audited write lands in
`jovi_mall` — two databases, no shared transaction.

- **D4-a** — Audit in `wi-admin`, written *around* the platform write (intent → outcome) with a
  correlation id. An admin action is never unrecorded, though a crash can leave an intent with no
  outcome. Recommended; the dangling-intent case is itself a useful signal.
- **D4-b** — Audit in `jovi_mall`, same transaction as the write. Atomic, but puts admin-private data
  in the shared DB, which cuts against R8's intent.

### D5 — Workers

15 background workers run in jovi-mall (`server.ts`). Two are admin-adjacent
(`cod-deposit-deadline`, `earnings-release`). Confirming: **all 15 stay in jovi-mall only** — running
the same worker in both processes would double-execute sweeps against one database. `admin` gets
*visibility* into them (Phase 7), not its own copies. Say if you intended otherwise.

### D6 — Does jovi-mall keep serving anything admin-shaped?

R1 says no admin endpoints remain. Three things need an explicit ruling:

1. `POST /api/internal/agents/*` — service-token API consumed by **geo-tracker**. Not admin; stays.
   *Stands.*
2. `POST /api/webhooks/telegram/send` — currently `requireRole(['admin'])`. Moves to `admin`.
   *Still open — Phase 5 Part C.*
3. `GET /api/files/orphans`, `DELETE /api/files/:id/permanent` — admin-gated inline. Move to `admin`;
   the rest of `/api/files` stays in jovi-mall for the other roles.
   ✅ *Done 2026-08-20, Phase 5 Part B.* Both moved onto `/api/internal/admin/files` behind
   `requireAdminCaller` and are served here at `/api/v1/files/{orphans,:fileId/permanent}`. The
   handlers did not move — only the door — and the rest of `/api/files` stayed exactly as this
   ruling said it should.

---

## 4. What must be implemented (scope, once D1–D4 are answered)

### In `jovi-mall` — subtractive plus two additions

| Work | Detail |
|---|---|
| 🔴 Close the escalation holes | Remove `'admin'` from both Zod enums (`auth.schemas.ts:43,59`) and both `AuthService` switch branches (`:166`, `:294`). Admins can no longer be created here at all. |
| 🔴 Fail closed on secrets | `JWT_SECRET \|\| 'secret'` → refuse to boot when unset. ✅ **Done** in jovi-mall (`assertSigningSecrets()`); geo-tracker carried the identical fallback and was closed on 2026-08-19, Phase 3 step 3.E.2. |
| 🔴 Stop logging refresh tokens | `auth.middleware.ts` `console.log`. |
| Delete the admin surface | 12 routers, 9 admin controllers, ~82 route declarations, 13 `api-doc/admin/` files. Resolves the 5-router `/admin` stacking defect and the 5×-auth cost. |
| Move admin-only services out | `admin-agency.service` (215), `article-author.service` (95), `admin-profile.service` (81). |
| Keep the 17 shared services | They still serve agency/agent/vendor/customer/worker callers. |
| Event transport (D2) | Make the event bus cross-process. |
| Retire the `admins` module | Model + repository + profile endpoints move to `wi-admin`. The `users` anchor row stays (D3-a). |

### In `admin` — greenfield

| Layer | Contents |
|---|---|
| Foundation | Express+TS skeleton, fail-closed config, error-code registry (extending jovi-mall's conventions), response envelope, structured logging with redaction, request-id, health |
| Two DB connections | `jovi_mall` (shared platform data) + `wi-admin` (admin identity) |
| Admin identity (`wi-admin`) | `admin_accounts` (`user_id`, tier 1–3, status, password hash, TOTP secret, lockout), `admin_sessions`, `admin_audit_log`, `admin_notifications` |
| Bootstrap | Idempotent CLI: creates the `jovi_mall.users` anchor row + the L1 `admin_accounts` row; refuses if an L1 admin exists |
| AuthZ | Static tier→endpoint map (your Decision 5). Route declares `minTier`; one resolver. **No permission catalog, no per-admin overrides — 3 collections dropped from the Phase 0 design.** |
| Audit | Every mutation wrapped intent→outcome (D4) |
| The 82 ported endpoints | Executed per D1 |
| The 9 empty domains | Users, vendors (incl. wiring the dead `setLegitVerified` so vendor KYC approval finally exists), customers, orders list/detail/search, shipments, admin management, admin notifications, system info, developer tools |
| `admin/api-doc/` | The frontend's source of truth |

### Revised phase plan

| Phase | Scope | Gate |
|---|---|---|
| **0.5** | jovi-mall security patch (escalation, secrets, token logging) — independently shippable | Escalation verified closed |
| **1** | `admin` foundation + both DB connections + **cross-process event transport (D2)** + health | Boots; an event published from `admin` provably fires a jovi-mall subscriber |
| **2** | Admin identity in `wi-admin`: accounts, tiers, sessions, TOTP, lockout, rate limiting, bootstrap CLI | L3 admin provably denied an L2 endpoint |
| **3** | Audit subsystem (D4) | Every Phase-4+ mutation audited by construction |
| **4** | Shared-logic access layer per D1 | COD confirm from `admin` performs FIFO settlement **and** fires its subscribers |
| **5** | Port all 82 endpoints | Full parity |
| **6** | The 9 empty domains | Real admin coverage |
| **7** | Ops: notifications, system info, worker visibility, outbox inspection, dev tools | — |
| **8** ✅ | `admin/api-doc/` + **cutover**: delete jovi-mall's admin surface | ✅ **DONE 2026-08-20**, pulled forward and executed as **Phase 5 Part E** of `PRODUCTION-READINESS/PHASE-5-LEGACY-CLOSEOUT-PLAN.md` ([ADR-017](./ADR-017-PHASE-17-CLOSEOUT.md) D-2). Zero live `requireRole(['admin'])` sites, zero public `/api/admin/*` mounts |

Big-bang cutover was planned for Phase 8 and **happened at Phase 5 Part E**, once the port reached
0 unrouted legacy endpoints. Until then jovi-mall kept serving its admin endpoints so the platform
stayed operable — the dashboard simply never pointed at them.

Two things about how it actually went, worth keeping:

- **It was subtractive, not a migration.** Every admin router had been a factory taking its guard
  chain as a parameter since Phase 4, mounted once publicly and once internally. The cutover
  deleted the `'public'` instantiation and its default export from seven files, and nine
  `router.use` lines from `api/index.ts`. No route handler changed.
- **The security half was one three-line guard, and it was not in the mounts.**
  `rotateRefreshToken` in jovi-mall copied the role out of the presented token without filtering
  it, so a refresh token minted before the cutover kept producing `role: 'admin'` access tokens
  for 30 days. The mounts were hygiene; that was the hole. A ledgered migration
  (`migrate:retire-admin-role`) removed the rows it protected against in the same change.

---

## 5. Clarifications I need

1. **D1** — the defining decision. Is integration through the shared database only (D1-a / D1-b), or
   is backend-to-backend HTTP acceptable for shared operations (D1-c / D1-d)? If the goal is that
   `admin` keeps working with jovi-mall offline, say so — it rules out D1-c/d.
2. **D2** — Redis pub/sub acceptable as the event transport?
3. **D3** — is the `users` anchor row (D3-a) acceptable as the reading of R8?
4. **D4** — audit in `wi-admin` with correlation ids?
5. **D6** — the three edge cases (geo-tracker internal API stays / telegram send moves / file admin
   routes move).
6. **Tiers** — I still need the operational split between Level 2 and Level 3 before Phase 2. I can
   propose a per-endpoint `minTier` across all 82 for your review.
7. **Port** for the admin service, and whether `wi-admin` is a separate `mongod` or another database
   on the same server.
