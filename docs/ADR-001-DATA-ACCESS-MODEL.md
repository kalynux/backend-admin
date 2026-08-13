# ADR-001 — Admin Backend Data Access Model

**Status:** Awaiting decision (this is the detail requested for Phase 0 §9.1)
**Context:** [PHASE-0-DISCOVERY.md](./PHASE-0-DISCOVERY.md)
**Decided already:** bootstrap first-admin · big-bang cutover · Express+TS+Mongo+Redis · fixed tier permissions

---

## 0. Why this decision got harder, and then easier

Two facts discovered after Phase 0 change the analysis. Both are measured, not assumed.

**Fact 1 — the event bus is in-process and in-memory.** `src/core/events/event-bus.ts` is a
`Map<string, EventHandler[]>` with no persistence, no queue, and no cross-process transport. Its own
docstring lists "integration with message queue" as a *future enhancement*.

**Fact 2 — jovi-mall's admin controllers are almost entirely stateless with respect to the session.**
Across all 9 admin controllers there are **16 total** `req.auth` references, and every single one
extracts the same thing: the actor's user id, to stamp on a domain record.

```
admin-profile.controller.ts          2 refs
admin-agent.controller.ts            1 ref   → { userId: req.auth!.user.id, role: req.auth!.role }
admin-billing.controller.ts          1 ref
admin-article.controller.ts          0 refs
admin-cod.controller.ts              6 refs  → confirmedByUserId / recordedByUserId / rejectedByUserId
admin-agency.controller.ts           2 refs
admin-earnings.controller.ts         0 refs
admin-payout-requests.controller.ts  2 refs  → const adminUserId = req.auth!.user.id
admin-order.controller.ts            2 refs
```

Fact 1 makes **Option A** substantially worse than I described in Phase 0.
Fact 2 makes **Option B** substantially cheaper than I described in Phase 0. My Phase 0 wording —
"requires substantial new work inside jovi-mall" — was too pessimistic. The work is *mechanical*, not
new business logic. §3.2 quantifies it.

---

## 1. The shape of the problem

**82 admin endpoints — 32 reads, 50 writes.**

| Router | GET | Write |
|---|---:|---:|
| `admins/routes.ts` | 1 | 2 |
| `agents/admin-agent.routes.ts` | 5 | 6 |
| `billing/admin-billing.routes.ts` | 1 | 6 |
| `cod/admin-cod.routes.ts` | 6 | 7 |
| `delivery/admin-agency.routes.ts` | 2 | 2 |
| `earnings/admin-earnings.routes.ts` | 2 | 0 |
| `earnings/admin-payout-requests.routes.ts` | 2 | 2 |
| `orders/admin-order.routes.ts` | 1 | 1 |
| `tickets/admin-ticket.routes.ts` | 6 | 12 |
| `blog/admin-blog.routes.ts` | 5 | 9 |
| files (inline-guarded) | 1 | 1 |
| telegram (inline-guarded) | 0 | 1 |
| **Total** | **32** | **50** |

**Big-bang means all 82 must be reachable through the admin backend on day one.** That is the
constraint every option below is measured against.

---

## 2. Option A — Shared MongoDB

The admin service connects to jovi-mall's MongoDB directly and reads/writes collections itself.

### 2.1 What it costs to build

Cheapest by a wide margin. No jovi-mall changes at all. You redeclare the ~25 Mongoose schemas the
admin surface touches (of ~90 total) and write handlers.

### 2.2 What it breaks — measured, not hypothetical

**Admin-reachable services emit 18 distinct domain events.** Every one is published on the
in-process bus:

```
cod.remittance.confirmed     cod.remittance.declared    cod.discrepancy.opened
cod.discrepancy.resolved     cod.collection.recorded    earnings.split
earnings.matured             payout.requested           payout.paid
payout.rejected              plan.activated             ticket.created
ticket.assigned              ticket.status_changed      ticket.priority_changed
ticket.note_created          ticket.attachment_uploaded ticket.attachment_deleted
```

And jovi-mall registers **live subscribers at boot** for a direct subset of them:

| Event an admin action emits | Subscribers registered in jovi-mall |
|---|---:|
| `payout.paid` | 2 |
| `payout.rejected` | 2 |
| `payout.requested` | 2 |
| `plan.activated` | 1 |
| `cod.deposit.recorded` | 2 |
| `cod.deposit.declared` | 1 |
| `cod.deposit.rejected` | 1 |
| `cod.collection.recorded` | 1 |

Because the bus is in-memory and in-process, **a write performed from a second process fires
nothing.** Concretely, under Option A:

- Admin marks a payout paid → the row updates, and the **2 subscribers never run**. The vendor or
  agency is never notified that their money was sent.
- Admin records a direct COD deposit → the row updates, and the **2 subscribers never run**. The
  agent's notification stack stays silent, and the agent's app still shows cash owed.
- Admin assigns a pricing plan → `plan.activated` fires nothing, so the agent's
  `max_active_shipments` capacity is never synced (`registerAgentPlanCapacityConsumer` in
  `server.ts`).

None of these produce an error. Nothing is logged. The data looks right in the database and the
platform quietly stops behaving correctly. **This is the failure mode that is hardest to detect and
hardest to reverse.**

Beyond events, Option A also loses the invariant logic itself. `AgencyRemittanceService.confirm()`
does not just flip a status — it lowers the agency's liability, FIFO-settles its collections, and
unlocks the earnings those collections back. Deactivating an agency cascades a suspend across every
vendor product that names it as default. Reimplementing those in a second codebase means they drift
the first time either side changes.

Finally, this is precisely what the platform's own governing rule forbids:

> *ask which service would have to grow a copy of the other's data — that one is wrong.*

### 2.3 Verdict

**Rejected.** Cheapest to start, and the only option that can silently corrupt platform behavior.

---

## 3. Option B — Delegation via an internal API ⭐

The admin backend owns admin identity, tiers, sessions, MFA and the audit log in **its own
database**. Every platform read and write is delegated to jovi-mall over
`/api/internal/admin/*`, authenticated by a shared service token — the pattern geo-tracker already
uses (`agents/middlewares/service-token.middleware.ts`, which fails closed when the secret is unset).

### 3.1 How it works

```
Admin Dashboard
   │ admin session cookie (issued by the admin backend)
   ▼
┌───────────────────────────────────────────────────────────┐
│ Admin Backend                                             │
│   1. authenticate admin        (own DB, own MFA)          │
│   2. resolve tier              (L1 / L2 / L3)             │
│   3. authorize this endpoint   (fixed tier→endpoint map)  │  ← final authority
│   4. audit: intent                                        │
│   5. delegate ────────────────────────────────────────────┼──► jovi-mall
│   6. audit: outcome                                       │    /api/internal/admin/*
│                                                           │    X-Service-Token + X-Actor-User-Id
│  own Mongo: admin_accounts, admin_sessions, admin_audit_log│
└───────────────────────────────────────────────────────────┘
```

Steps 4 and 6 are why the audit log finally works: recording *is* the transport, so no admin
mutation can bypass it.

### 3.2 What it actually costs in jovi-mall — the corrected estimate

Because of Fact 2, the internal API is **not 82 new handlers**. It is a re-mount of the 12 routers
that already exist, behind a different guard.

Today every admin router begins:

```ts
router.use(requireAuth);
router.use(requireRole(['admin']));
```

The change is to swap those two lines for one:

```ts
router.use(requireAdminCaller);   // validates service token, populates req.auth from X-Actor-User-Id
```

`requireAdminCaller` is a single new middleware (~30 lines) that constant-time-compares the service
token and injects `req.auth = { user: { id: <actor header> }, role: 'admin' }`. Every existing
controller keeps working unmodified, because all 16 of their session references only ever read
`req.auth.user.id`.

**Estimated jovi-mall work for the full 82-endpoint surface:**

| Item | Scope |
|---|---|
| `requireAdminCaller` middleware | 1 new file |
| Swap the guard in 12 admin routers | 12 two-line edits |
| Mount them under `/api/internal/admin/*` in `api/index.ts` | 1 edit |
| Remove the 5-router `/admin` stacking (§1.3 of Phase 0) | resolved as a side effect |
| **New business logic required** | **none** |

The 5×-auth performance defect disappears for free: service-token validation is an HMAC compare and
a header read, with **zero Mongo queries**, replacing up to 10.

The genuinely new work is Phase 6 of the plan — users, vendors, customers, orders, shipments — and
that has to be built *somewhere* under every option, because it does not exist today.

### 3.3 The one real constraint this creates

Actor fields on admin-written records are `ObjectId` references to the `users` collection, and they
are **shared** between admin and non-admin actors:

```ts
// agency-remittance.model.ts
declared_by_user_id: { type: Schema.Types.ObjectId, ref: MODELS.USER, required: true },  // the agency
resolved_by_user_id: { type: Schema.Types.ObjectId, ref: MODELS.USER, default: null },   // the admin
```

Same pattern in `agent-deposit.model.ts`, `cod-discrepancy.model.ts`, `payout-request.model.ts`.

**Therefore: the admin's `User` row must stay in jovi-mall.** Moving admin identity out entirely
would leave dangling refs and break `populate()` on financial records.

This settles Phase 0 open question 9.5.2 with evidence:

> **Admin identity is split, not moved.** The `User` row (id, credentials-of-record, status) stays in
> jovi-mall as the identity anchor and FK target. The admin service owns everything *about* being an
> admin — tier, session, MFA, lockout, audit — in its own DB, keyed by that `user_id`.

The `admins` collection and its profile endpoints migrate to the admin service; the `users` row does
not.

### 3.4 Verdict

**Recommended.** Single writer, invariants stay where they live, events fire correctly, audit is
structurally unbypassable, matches the geo-tracker precedent, and the migration cost is mechanical.

---

## 4. Option C — Hybrid (delegate writes, read Mongo directly)

Writes go through B; the 32 read endpoints query jovi-mall's Mongo directly from the admin service.

### 4.1 The appeal

Reads are where list/search/filter/aggregate complexity lives, and where the admin dashboard will
want query shapes jovi-mall's endpoints do not offer (cross-role search, arbitrary sort, CSV export).
Building those as internal endpoints means round-tripping every new filter through two services.

### 4.2 The cost

Reads are safe from the event problem — that failure mode is write-only. The cost is **schema
coupling**: the admin service redeclares read models for ~25 collections, and a field rename in
jovi-mall breaks the admin service with no compile-time link between them. There is no shared
package and, per `CLAUDE.md`, deliberately so.

### 4.3 Where it stops being worth it

Under **big-bang**, C's saving is smaller than it looks. Because of §3.2, the 32 read endpoints cost
roughly *zero* to expose via B — they are already-written controllers being re-mounted. C only pays
off for read shapes that **don't exist yet** in jovi-mall, which is mostly the Phase 6 domains
(users, vendors, customers, orders, shipments).

### 4.4 Verdict

**Not now — but keep it as a named escape hatch.** If a Phase 6/7 dashboard view needs an
aggregation that would be awkward as an internal endpoint (analytics rollups, cross-collection
search, export), add a **read-only, explicitly-listed** Mongo connection for that view and document
it. Deciding it case-by-case with a written justification is safer than adopting it wholesale now.

---

## 5. Recommendation

**Option B**, with C reserved as a documented, per-case escape hatch for read-only analytics.

| | A: Shared DB | **B: Delegate** | C: Hybrid |
|---|---|---|---|
| Build cost (given §3.2) | Low | **Low–Medium** | Medium |
| Domain events fire | ❌ silently not | ✅ | ✅ writes only |
| Business invariants preserved | ❌ duplicated | ✅ single copy | ✅ writes only |
| Audit bypassable | ✅ trivially | ❌ structurally not | ❌ for writes |
| Schema coupling | Total | **None** | Partial |
| Follows platform's own rule | ❌ | ✅ | ⚠️ partly |
| Fixes the 5×-auth defect | ❌ | ✅ free | ✅ free |

The deciding factor is not cost — after the §3.2 correction, A and B are closer than Phase 0
implied. It is that **A's failure mode is silent**. A missed notification or an unsynced capacity
counter produces no error, no log line, and correct-looking data.

---

## 6. Consequences if B is chosen

**In jovi-mall:**
1. New `requireAdminCaller` middleware; `INTERNAL_ADMIN_SERVICE_TOKEN` env var, fail-closed when unset.
2. 12 admin routers re-guarded and re-mounted under `/api/internal/admin/*`.
3. The public `/api/admin/*` surface is **removed** at cutover (big-bang) — the dashboard no longer
   reaches jovi-mall directly.
4. §4.2 escalation patch: `'admin'` removed from both Zod enums and both `AuthService` switch branches.
5. `admins` module retired; the `users` row for each admin stays.

**In the admin backend:**
6. Owns `admin_accounts`, `admin_sessions`, `admin_audit_log`, `admin_notifications` — keyed by jovi-mall `user_id`.
7. Every delegated call is wrapped in an audit write (intent → outcome).
8. Tier→endpoint authorization resolved locally before any delegation; jovi-mall trusts the service
   token, exactly as it trusts geo-tracker.
9. Needs a jovi-mall availability story: it is now on the critical path for **admin** operations.
   Note this does not violate `CLAUDE.md`'s "geo-tracker must stay off the critical path for business
   actions" — that rule is about deliveries, and delegating admin reads/writes to the service that
   owns the data is not the same as making the data owner optional.

---

## 7. Decisions recorded from this round

| # | Decision | Consequence |
|---|---|---|
| **2** | First admin created by a **bootstrap** | A CLI/seed script in the admin service creates the `User` row in jovi-mall (via internal API) + the `admin_accounts` row at tier L1. Idempotent, refuses to run when an L1 admin already exists. Removes the last legitimate use of admin self-registration. |
| **3** | **Big-bang** cutover | All 82 endpoints reachable through the admin backend before launch; public `/api/admin/*` removed at cutover. Made feasible by §3.2. |
| **4** | Stack **confirmed**: Express + TypeScript + MongoDB + Redis | Reuses the response envelope, error-code discipline and Zod conventions; error codes extend the existing registry rather than starting a second one. |
| **5** | **Fixed tier permissions**, no per-admin overrides | Authorization is a static tier→endpoint map in code, not data. Drops `admin_permissions`, `admin_tier_grants`, `admin_permission_overrides` from the Phase 0 design — **3 collections removed**. An admin record carries only `tier: 1 \| 2 \| 3`; changing an admin's tier changes their access wholesale. Simpler, and every endpoint's required tier is greppable in one file. |

Decision 5 simplifies Phase 2 materially: the permission system becomes a declaration on each route
(`minTier: 2`) plus one resolver, instead of a permission catalog with grant/override resolution.

> ⚠️ **Decision 5 is SUPERSEDED IN PART by [ADR-003](./ADR-003-GRANULAR-PERMISSIONS.md)** (Phase 3,
> 2026-08-10).
>
> The *tier→endpoint map* was replaced by a **granular permission catalog in code**: a route declares
> `permission('cod.remittances.confirm')` rather than `minTier: 2`. The Phase 3 brief required
> granular permissions and, decisively, that authorization *"never rely solely on tier checks when a
> resource-specific permission is required"* — which a single scalar per route cannot express.
>
> **What still holds:** policy is code and not data; it is not editable at runtime; there are no
> per-admin overrides; and the three collections this decision dropped stay dropped. What changed is
> the unit — what a route *does*, rather than who may reach it. ADR-003 has the full argument,
> including the two properties that were unobtainable under the map: a family grant can no longer
> sweep in a write that moves money, and the permission is separable from the resource it applies to.

**Still open:** the operational split between Level 2 and Level 3 (Phase 0 §9.5.1). I can propose a
concrete per-endpoint tier assignment across all 82 endpoints for your review — that is the natural
first artifact of Phase 2, and I will not invent the policy without your sign-off.

> **Settled in Phase 3.** The split is `src/modules/authorization/domain/tier-grants.ts`, expressed
> as permission sets rather than per-endpoint tiers. `npm run authz:matrix` prints it. Note also that
> the count above is wrong throughout this document: the real endpoint total is **81**, not 82 — the
> ticket router declares 18 routes, not 19, which this ADR's own row sums (32 + 49) already implied.
