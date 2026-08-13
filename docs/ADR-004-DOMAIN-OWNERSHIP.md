# ADR-004 — Domain ownership and data-access paths

**Status:** Accepted, 2026-08-11 · **Implemented by:** Phase 4 (Data Access and Domain Boundaries)
**Amends:** ADR-002 §2.1 (two measurement errors), blueprint J5 (the re-mount mechanism)
**Amended by:** [ADR-009](./ADR-009-DELIVERY-NETWORK.md) D-1 (the *Agents* row) ·
[ADR-011](./ADR-011-ACCOUNTS-AND-FINANCE.md) D-1 (the *Money*, *Billing / plans* and
*COD / cash* rows) — see the ownership map below, where all four cells are corrected in
place and marked **†**

---

## Context

Phases 1–3 built a service that authenticates an administrator and decides what they may do. It
holds no platform data and has never called jovi-mall: `platform.client.ts` shipped `ping()` and
nothing else, and `platformConnection()` was opened, probed by readiness, and had **zero models
registered on it**.

This ADR decides, per domain, where the data lives and how admin reaches it — so that Phase 5 (port
81 endpoints) and Phase 6 (build 9 new domains) execute a decided model instead of re-arguing it per
endpoint.

The governing constraint is `backend/CLAUDE.md`: *ask which service would have to grow a copy of the
other's data — that one is wrong.* Restated for this service:

> **Admin must never become a second writer of an invariant jovi-mall enforces.**

---

## Four measured corrections to the record

The brief for this phase says to use the architecture *actually* discovered, not the documented one.
Four findings changed a decision.

### 1. The actor descriptor is not `{ user: { id } }`

ADR-001 §3.2 claims all 16 `req.auth` reads behind admin routes take `user.id`, so
`requireAdminCaller` can inject a stub and *"every existing controller keeps working unmodified"*.

That holds for the nine `admin-*` controllers. It is **false for the shared controllers those routers
also mount**:

| Controller | refs | reads |
|---|---:|---|
| `tickets/controllers/ticket.controller.ts` | 24 | `role_entity._id`, and at `:98` compares `ticket.assigned_admin_id` — declared `ref: MODELS.ADMIN` — against `role_entity.id` |
| `api/controllers/file-management.controller.ts` | 17 | passes the whole `role_entity` **document** on 5 paths |
| `tickets/controllers/ticket-attachment.controller.ts` | 9 | `role_entity?._id ?? role_entity?.id` |
| `modules/telegram/telegram.controller.ts` | 4 | `req.auth?.user?.id` |

Under D3 (full separation) an administrator has **neither a `users` row nor an `admins` row** in
`jovi_mall`, so both resolve to nothing. Decision 1 below resolves this.

### 2. `article.service` is admin-only, not shared

ADR-002 lists it as shared with `public-article.controller`. That controller imports a **separate**
`blog/services/public-article.service.ts`. `ArticleService`'s only importer outside a dead barrel is
`admin-article.controller.ts`. So blog is **450 LOC of cleanly movable code**, not 355 LOC of shared
code — which is what makes Decision 4 possible.

Corrected split: **16 shared / 4 admin-exclusive**, not 17/3.

### 3. The tickets module is missing from the 17/3 table entirely

18 endpoints — the largest single router — 6 services, 2,029 LOC, classified by no document. And
`TicketService` is called by **three other services as a side effect of money movement**: a failed
refund, a payout request and a payment dispute each open a ticket. It is more shared than anything
in ADR-002's table, and it is why tickets are delegated rather than read directly.

### 4. Routers cannot be "re-mounted behind a different guard"

J5 describes swapping `requireAuth`+`requireRole` for `requireAdminCaller` as *"12 × two-line
edits"*. Each admin router applies those guards with `router.use(...)` at module scope, so mounting
the same instance a second time re-runs them. Dual-mounting — which is what keeps the public
`/api/admin/*` surface alive until cutover — needs a small **router factory** per router. See
Decision 5.

**Confirmed sound:** no `.populate()` anywhere dereferences an actor (`*_by*`) field — 13 populate
sites, none touch one. That measurement is what makes Decision 1 safe.

---

## Decisions

### D-1 — The administrator is a synthetic actor, carried in headers

`requireAdminCaller` fabricates the full `req.auth` shape from request headers, with **no database
read**:

```ts
req.auth = {
    user:        { id: actorId, _id: new Types.ObjectId(actorId) },
    role:        'admin',
    role_entity: { _id: new Types.ObjectId(actorId), id: actorId, name: actorName },
};
```

`actorId` is the **wi-admin `admin_accounts._id`**. It lands in columns declared `ref: MODELS.USER`
and `ref: MODELS.ADMIN` which will never resolve.

**That dangling reference is a decision, not an oversight.** It is safe because no code dereferences
an actor field, and ticket admin-exclusivity keeps working because `ticket.controller.ts:98` is an
id-to-id string comparison. Two things make it legible rather than mysterious:

- a `*_source: 'platform' | 'admin'` discriminator beside each admin-writable actor field, so a
  reader can tell which identity space an id belongs to;
- a `*_name` snapshot written at the same time, so an agency viewing a remittance sees who resolved
  it without a cross-database join that cannot exist.

**What would break it:** adding `.populate()` on an actor field. A future reader who wants the actor
must read `*_name`, or ask the admin service.

*Rejected —* a shadow `admins` row per administrator, synced from wi-admin. It resolves `role_entity`
honestly, but it is a second source of truth for admin identity, which is what D3 exists to prevent
and what this phase's brief forbids. *Rejected —* refactoring tickets and file-management to take an
explicit actor: ~40 call sites in code four non-admin roles also run, with no test framework in
jovi-mall to catch a regression. Worth doing eventually; not as a side effect of this phase.

### D-2 — Admin's connection to `jovi_mall` is read-only

One rule, and the whole access model follows from it:

> **Admin reads `jovi_mall` directly where it needs to; it writes `jovi_mall` only through
> jovi-mall's internal API. The single exception is the two blog collections, whose ownership moves
> here.**

Reads are pure queries with no invariant to protect, so a second reader costs nothing. Writes are
where the invariants live — FIFO settlement, guarded compare-and-set on cash balances, the
deactivation cascade — and every one of them is wrapped in a Mongo transaction *and paired with a
post-commit event emission*. A second process can open its own transaction and get the money right
while silently getting the notifications wrong. That is the failure this rule prevents.

It is enforced by construction, not by discipline — see "How the rule is enforced" below.

### D-3 — Direct reads are typed read-models over the raw driver

No Mongoose schemas are redeclared and no models are registered on `platformConnection()`.

jovi-mall exports **no schemas** — 0 occurrences of `export const *Schema`; only compiled Models,
and importing one registers it on the importing process's default connection and drags in module
config that throws at load time (`agent.config.ts` throws unless `AGENT_TRUST_WEIGHT_*` sum to 100).

So admin copies `core/database/collections.ts` — 288 lines of frozen constants, zero dependencies,
the single highest-value artifact to share — and queries collections directly with hand-written read-
model interfaces and explicit projections. No second schema definition means no drift, and no
validation two processes must agree on.

### D-4 — Admin-only services: move the simple ones, keep the cascade

| Service | LOC | Disposition |
|---|---:|---|
| `admin-profile.service` | 81 | **Retired.** wi-admin owns administrator identity outright since Phase 2. |
| `article.service` + `article-author.service` | 450 | **Moves to admin.** Two models, no cross-domain writes, no events, no other reader. |
| `admin-agency.service` | 215 | **Stays in jovi-mall**, reached over the internal API. |

`AdminAgencyService.deactivate` is one transaction that cascades across agency status, vendor
products, product overrides and order items. Running that from a second process is precisely the
"second copy of the domain" the governing rule forbids — so the split lands on the real line: **does
it write data another service owns?**

### D-5 — Dual-mount via a router factory, not a guard swap

Each ported router exports a factory taking its guards:

```ts
export function buildAdminCodRouter(guards: RequestHandler[]): Router
```

instantiated twice — once with `[requireAuth, requireRole(['admin'])]` for the existing public mount,
once with `[requireAdminCaller]` under `/api/internal/admin`. Both surfaces run until cutover
(Phase 8), so the dashboard keeps working while endpoints migrate one at a time. The handlers,
their order and their behaviour are untouched.

---

## Ownership map

Four access paths, matching the four the brief names. **Combination** — read direct, write through
jovi-mall — is the common case for domains that have no service yet.

| Domain | Data owner | Read | Write | Why |
|---|---|---|---|---|
| Administrators · sessions · approvals | **wi-admin** | own DB | own DB | Built, Phases 2–3 |
| Permissions | **wi-admin** (code) | in-process | — | ADR-003 — policy is code, not data |
| Audit · admin notifications | **wi-admin** | own DB | own DB | Phase 3.5 / Phase 7 |
| **Agents** † | jovi-mall | **direct read** (records) · HTTP (verdicts) | HTTP | ADR-009 D-1. `AgentDirectoryService` filters out exactly the population an administrator opens the screen to find; tracking policy, eligibility and COD allocation stay delegated |
| **COD / cash** † | jovi-mall | **direct read** (records) · HTTP (verdicts) | HTTP | ADR-011 D-1. FIFO settlement + guarded CAS are *write* invariants; `adminOverview` is a delegated verdict, the remittance/deposit/discrepancy/cash rows are records |
| **Money** (earnings, payouts) † | jovi-mall | **direct read** (records) · HTTP (verdicts) | HTTP | ADR-011 D-1. Escrow release is shared with a worker — a *write* concern; a balance is a delegated verdict, a ledger row is a record |
| **Billing / plans** † | jovi-mall | **direct read** (records) · HTTP (verdicts) | HTTP | ADR-011 D-1. `plan.activated` drives agent capacity in-process on the *write*; plans and subscriptions are records, entitlements a delegated verdict |
| **Support / tickets** | jovi-mall | HTTP | HTTP | Rows created in-process by refund, payout and dispute code |
| **Agencies** | jovi-mall | direct read | HTTP | Deactivation cascades into products + order items in one transaction |
| **Files · broadcast** | jovi-mall | HTTP | HTTP | Storage quota and the Telegram provider live there |
| **Developer tools** | jovi-mall | HTTP | HTTP | D9 — the 15 workers stay put; admin gets visibility only |
| **Users** | jovi-mall | **direct read** | HTTP | No service exists; reads are pure queries |
| **Vendors** | jovi-mall | **direct read** | HTTP | " |
| **Customers** | jovi-mall | **direct read** | HTTP | " |
| **Orders** | jovi-mall | **direct read** | HTTP | Dispute resolve already delegates; refunds move money |
| **Shipments** | jovi-mall | **direct read** | HTTP | Assignment state is geo-tracker-coupled |
| **Content / blog** | **admin** | direct | **direct** | Ownership moves — see D-4 |
| System info | both + geo-tracker | own + probes | — | Composed from health endpoints |

**No domain appears twice.** Every row names exactly one owner, which is the "do not duplicate
sources of truth" requirement discharged.

**† The four amended rows, and the rule that replaced their reason.** Each originally read
`HTTP / HTTP`, justified by escrow release, FIFO settlement, the KYC gate, `plan.activated`.
Every one of those is an argument about a **write**, and applying it to reads made this
service unable to answer questions when jovi-mall was down for no invariant's benefit. The
rule that replaced it, stated at ADR-009 D-1 and generalised at ADR-011 D-1:

> **Delegate a read whose answer is a VERDICT the platform acts on.
> Read directly a read whose answer is a RECORD.**

D-2 above is untouched by this — **writes are still delegated without exception**, blog
excepted as it always was. What changed is only which *reads* pay the HTTP cost, and the
enforcement mechanism is unchanged: a direct read is possible only for a collection declared
in `platform-collections.ts`, and only ever through `PlatformReadRepository`, which has no
write method to call.

---

## How the rule is enforced

Discipline does not survive 81 endpoints arriving at Phase 5, so D-2 is enforced by the type system.

`src/infra/platform/platform-collections.ts` is a frozen table — the same shape as Phase 3's
permission catalog — declaring each collection admin touches, its access class, its owner, and where
its writes go:

```ts
users:           { access: 'read',  owner: 'jovi-mall', writes: 'internal-api' },
articles:        { access: 'owned', owner: 'admin',     writes: 'direct' },
```

Two repository bases consume it:

- **`PlatformReadRepository`** — accepts any collection. Exposes `findOne`, `find`, `count`,
  `aggregate`. **There is no write method to call.**
- **`PlatformOwnedRepository`** — additionally exposes writes, and its type parameter accepts only
  collections whose `access` is `'owned'`. Pointing one at `users` is a **compile error**.

That is the only abstraction this phase adds, and it earns its place: it is not a wrapper for the
sake of layering, it is the mechanism that makes the read-only rule unbreakable. Everything else
stays thin — services call repositories directly; there is no unit of work and no generic query
builder.

---

## The transport

**Guard.** `requireAdminCaller` copies the proven shape of the geo-tracker service-token middleware:
hash-then-`timingSafeEqual`, `X-Service-Token` then `Bearer`, and **fails closed when the secret is
unset**.

**Credential.** `INTERNAL_ADMIN_SERVICE_TOKEN`, deliberately **not** the `INTERNAL_SERVICE_TOKEN`
geo-tracker holds — separate credential, separate blast radius.

**Headers.** `X-Service-Token`, `X-Actor-Id`, `X-Actor-Name`, `X-Actor-Tier` (advisory, for
jovi-mall's logs only), `X-Request-Id` (the same correlation id Phase 3.5's audit rows use).

**Retries on GET only.** jovi-mall has no idempotency keys, so a retried `confirm` would settle
twice. Reads retry; writes do not.

**Availability.** `JOVI_MALL_BASE_URL` stays optional in this phase — a delegated route answers
`503 SERVICE_DEPENDENCY_UNAVAILABLE` when it is unset, which is accurate and keeps local development
possible without running jovi-mall. It becomes required at Phase 5, when most of the surface depends
on it. (`platform.client.ts` said Phase 4; deliberate deviation.)

---

## Consequences

- **Authorization stays single-sided.** jovi-mall trusts the service token and re-checks nothing, so
  `INTERNAL_ADMIN_SERVICE_TOKEN` is a full-privilege credential and the Phase 3 permission catalog is
  **not** defence in depth for it. Already flagged at ADR-003:125-128; restated here because this
  phase is where the token comes into existence.
- **jovi-mall becomes a hard runtime dependency for delegated domains.** Admin-only reads, all
  direct-read domains, and login/authorization keep working when it is down — which is the split
  BLUEPRINT:29-30 predicted.
- **Phase 5 is mechanical.** Each remaining router repeats D-5's factory refactor; each ported
  endpoint's permission is already decided in `legacy-endpoint-map.ts`.
- **Phase 6 has a shape to build into** — read-model repository, writes over the internal API,
  new internal-only write endpoints added to jovi-mall as needed.

## Deferred, and named so it is not forgotten

- **J6's migration.** The `*_source` discriminator is added to the COD actor fields this phase
  touches. Backfilling the other ~7 fields belongs with the endpoints that use them, at Phase 5.
- **J7's signature threading** across the shared services — same reason. Those services are called by
  agency, agent, vendor and customer controllers plus 5 workers, so the change must be additive and
  is best made per-domain rather than in one sweep.
- **`SUPPORT_ADMIN_USER_ID`** names a real jovi-mall user acting as the system actor for
  auto-created tickets (`ticket.service.ts`, `earnings-release.worker.ts`). Under D3 that referent
  breaks. Not in this phase's slice; it blocks the ticket domain at Phase 5.
- **The agency KYC gap** — PHASE-0 found agencies have deactivate/reactivate but no KYC approval at
  all. Ownership is assigned here; the missing capability is Phase 6's.
