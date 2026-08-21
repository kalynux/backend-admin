# Phase 17 — what is done, what is half-done, what is not started

> # ✅ PHASE 17 IS CLOSED — 2026-08-20
>
> Parts B, C, D and E all landed, executed as Parts A, B, C and D of
> [`PHASE-5-LEGACY-CLOSEOUT-PLAN.md`](../../PRODUCTION-READINESS/PHASE-5-LEGACY-CLOSEOUT-PLAN.md).
> **`LEGACY_ENDPOINT_COUNT` is 0, and both the constant and the map it counted are deleted**,
> along with `src/modules/legacy-audit/`, the `audit.legacy_feed` flag and the
> `AUDIT_LEGACY_FEED_DISABLED` error code.
>
> This page is kept as the progress board it was, updated to the closing state. The decisions
> it took live in [`ADR-017-PHASE-17-CLOSEOUT.md`](./ADR-017-PHASE-17-CLOSEOUT.md).

**Measured, not remembered.** Every count here was produced by scanning
`permission.catalog.ts` against the route files — originally on **2026-08-17**, and again on
**2026-08-20** at close-out — and every claim carries a file reference. The plan and the
decision register live in [PHASE-17-LEGACY-PORT-PLAN.md](PHASE-17-LEGACY-PORT-PLAN.md); this
file is the progress board.

---

## 1 · The headline number

| | Count (2026-08-17) | Count (close-out) |
|---|---:|---:|
| Permissions catalogued | 113 | **111** |
| Permissions with a live wi-admin endpoint | 97 | **107** |
| **Permissions with no endpoint** | 16 | **4** |

`LEGACY_ENDPOINT_COUNT` is **0** — down from 37 when Phase 17 began, and 17 when this page was
first written. The constant no longer exists: Part D deleted it with the map.

### How the 4 break down

| Group | Count | Meaning |
|---|---:|---|
| Portable, not started | **0** | Content (14), files (2) and messaging (1) were all ported at Phase 5 |
| Deliberately unbuilt | **4** | Nothing exists anywhere to port; each has a written reason, published in [`api/permissions.md`](./api/permissions.md) |

The other twelve left the list three different ways, and the differences are the interesting
part: **ten were built** (Phase 5 Parts A–C), and **two were deleted** — `customers.read` and
`customers.suspend`, the only pair that was *granted* while backing no route (ADR-017 D-1).

**There is no longer a "half-implemented" group.** The 11 `support.*` permissions were in it
until Phase 17; both halves exist.

---

## 2 · Done

### Part 0 · Groundwork ✅

- Baseline captured; no pre-existing failures in the suites this work touches.
- The two `/api/admin/profile` rows were **stale** — their targets have existed since Phase 2
  (`administrator.routes.ts:37-56`). Deleted with a tombstone; `LEGACY_ENDPOINT_COUNT` 37 → 35.

### Part A · Support / tickets ✅ — 11 permissions, 19 endpoints

**jovi-mall**

| Change | Where |
|---|---|
| Shared administrator snapshot + `publicAdminSnapshot()` (the D-5 disclosure boundary) | `src/core/types/admin-snapshot.types.ts` |
| `admin_assignment` block, `created_by_admin`, two read-scope indexes | `tickets/models/ticket.model.ts` |
| `assigned_admin_id` and the **entire exclusivity mechanism** deleted — 3 private methods, 13 call sites, 2 repository writers, the controller check, `resolveAdmins` | `tickets/` |
| `buildAdminTicketRouter` at `/api/internal/admin/tickets` (19 routes) | `tickets/routes/admin-ticket.routes.ts` |
| The legacy `/api/admin/tickets` mount **deleted** | `api/index.ts` |
| `assignToAdministrator`, `refreshAdminSnapshot`, and their wire schemas | `tickets/services`, `tickets/validators` |
| `npm run test:admin-tickets` — **27 assertions** | `scripts/test/test-admin-tickets.ts` |

**wi-admin** — `src/modules/support/`

| Change | Where |
|---|---|
| The D-3 tier matrix as **one authority table**, read by the service to enforce and the DTO to render | `domain/assignment-authority.ts` |
| The scope as a **Mongo filter**, so a miss is 404 not 403 | `repositories/ticket.read.repository.ts` |
| `resolveScope('tickets')` narrowed: an Admin no longer sees every ticket | `authorization/domain/resource-scope.ts` |
| 13 delegated writes, each wrapped in an audit intent | `gateways/ticket.gateway.ts` |
| 19 routes, all permissioned, all mutations audited | `routes/ticket.routes.ts` |
| 13 new audit actions; 4 ticket sub-collections registered for direct reads | `audit.catalog.ts`, `platform-collections.ts` |

**Verified:** `createApp()` boots with every assertion holding — including
`assertAuditCoverageComplete()`, which proves all 13 new audit actions have producers. Full
wi-admin suite green at **1441 assertions**; jovi-mall `tsc` + `lint` clean and its route table
enumerated from a live load.

---

## 3 · Not started — **nothing**

All four parts landed on 2026-08-20, as Parts A, B, C and D of the Phase 5 plan. Kept below in
their original order with what actually happened, because three of the four turned out to be a
different shape than this page predicted.

### Part B · Content / blog ✅ — 7 permissions, 14 endpoints

Landed as **Phase 5 Part A**. Fourteen routes at `/api/v1/content`, and the only ported family
that **moved ownership**: wi-admin writes `articles` and `article_authors` directly through
`PlatformOwnedRepository` on the raw driver, while jovi-mall keeps the Mongoose schema, the
indexes and the public reader. New `test:content` (146, DB-free) and `verify:content` (46, live).

The inconsistency this section flagged is **resolved, in the direction it warned about**:
`platform-collections.ts` declared `articles` and `article_authors` `owned`/`direct` while
jovi-mall still served writes on them. The port deleted jovi-mall's editor in the same window
(deploy order: jovi-mall first, Phase 5 D-4), so the two-writers state never existed. A write
census — `grep` for `Article(Author)?Model.(create|updateOne|…)` — returns **zero sites in
`src/`**; the only writes left are in `scripts/` (`seed-blog.ts`, and `verify-blog-live.ts`'s
own fixtures).

Two corrections this port produced, both now in ADR-017: ADR-004 D-4's *"no other reader"* was
**false** (`public-article.service.ts` reads both repositories, and the marketing site reads it),
so the models were **duplicated rather than moved**; and the true size was ~1 600–2 000 LOC, not
the 450 D-4 estimated.

### Part C · Files ✅ — 2 permissions, 2 endpoints

Landed as **Phase 5 Part B**, and smaller than even this section said. F-1's premise was stale —
`buildAdminFileRouter` already existed — so it was *extend the factory*, not extract one. Both
jovi-mall handlers moved **door only, not code**: `requireAdminCaller` fabricates
`req.auth.role = 'admin'`, so each handler's own `role !== 'admin'` check is satisfied rather
than contradicted, and both stay as a second lock on an unrecoverable path.

F-2 and F-3 were answered: the delete requires the file id **repeated in the body** (the
`outbox.prune` precedent), and the orphan listing exposes id, original filename, mimeType, size,
ownerType and createdAt — **not** the storage key. New `test:files` (35, DB-free).

⚠ It also corrected a claim four documents made: **`files.orphans.read` is tiers 1 and 2, and
never was tier-1-only.** The grant table had disagreed with the prose since the permission was
catalogued. The documents were corrected, not the grant — `destructive: true` on `files.delete`
is what makes the *delete* tier-1-only, structurally.

### Part D · Messaging ✅ — 1 permission, 1 endpoint

Landed as **Phase 5 Part C**. `POST /api/v1/messaging/telegram`, and the rename went through as
planned (`broadcast` → `messaging`, `broadcast.send` → `messaging.telegram.send`). New
`test:messaging` (38, DB-free).

⚠ **The consequence this section stated is wrong in both halves, and the true one is nearly the
opposite.** Moving it off `/api/webhooks/*` does **not** make it maintenance-blocked:
`/api/internal/admin` is *unconditionally* exempt in every maintenance mode, where
`/api/webhooks` was exempt only while `blockWebhooks` was unset — so the operator **lost a
per-window off switch**. And jovi-mall's rate limiter does not apply either, because wi-admin
authenticates as `internal_service`, which is exempt in both policies. What is genuinely new is
**wi-admin's own identity-scoped limiter**. Recorded in ADR-017 as C-6.

### Part E · Close-out ✅

Landed as **Phase 5 Part D**. `LEGACY_ENDPOINT_COUNT` reaching 0 turned `test-authz.ts`'s
cutover tripwire red on purpose, and clearing it meant deleting `src/modules/legacy-audit/` and
`legacy-endpoint-map.ts` — plus, because they could not survive the module, the
`audit.legacy_feed` feature flag (its `consumer` named a deleted file) and the
`AUDIT_LEGACY_FEED_DISABLED` error code (no route could raise it). The two `customers.*`
permissions and their family went with them, per ADR-017 D-1.

Eight assertions across seven suites had the deleted map as their subject and would have gone
**vacuously green**. They were restated as one strictly stronger unconditional check in
`test-authz.ts` § 9 — *the map does not exist, the module does not exist, and no file under
`src/` references either* — rather than left to pass by having nothing to read. The `†` count
fell to **4**, not the 6 this page forecast and not the 7 the plan forecast.

---

## 4 · Deliberately unbuilt — **4** permissions

Not a backlog; there is nothing built anywhere to port. Published, with these reasons, in
[`api/permissions.md`](./api/permissions.md) § *The four `†` permissions* — so the phase's
"live or unbuilt with a written rationale" criterion is checkable from the contract rather than
from a status page.

| Permission | Why not |
|---|---|
| `users.sessions.revoke` | jovi-mall issues stateless JWTs with no session store. `users.suspend` covers the need. ADR-007 |
| `users.roles.manage` | Removing a role has no implementation and no defined semantics — it strands the Store. ADR-007 |
| `notifications.manage` | ADR-013 D-9 — service-wide wording would block tier 3 configuring their own preferences |
| `developer_tools.webhooks.redeliver` | ADR-012 — every webhook mount is inbound; nothing to redeliver |

**`customers.read` and `customers.suspend` were on this list and are now DELETED**, not
documented — Phase 5 Part D, [ADR-017](./ADR-017-PHASE-17-CLOSEOUT.md) D-1. They were the only
pair here that was *granted* (tier 2 via `allInFamily('customers')`, tier 3 `customers.read` by
name) while backing no route, and a granted permission with no endpoint appears in an
administrator's effective set: a rationale would have documented the promise rather than
withdrawn it. The `customers` **family** went with them, because a family must hold at least one
permission. No capability was lost — the `users` module is role-agnostic (`?role=customer`, the
customer role-profile, suspend/restore) and `orders.read?customerId=` carries the history.

`users.password.reset` **left this list during Phase 17** the third way — it was **built**, once
the login-link work supplied the delivery channel ADR-007 said it was blocked on. It was not
part of this plan.

---

## 5 · Known gaps in what IS shipped

Honest debts in Part A, none of which block it.

| # | Gap | Detail |
|---|---|---|
| ~~G-1~~ | ✅ **CLOSED 2026-08-19 — the attachment delete is tier-scoped** (Phase 4, step 4.B.1) | The lookup exists: `TicketAttachmentReadRepository.findTicketIdByAttachment` projects `{_id, ticket_id}` and nothing else, and the handler feeds that id straight to the same `loadScoped` + `assertMayAct` pair every sibling write uses. A missing attachment and an out-of-scope ticket answer the **identical** `TICKET_NOT_FOUND` 404 — two 404s differing only in their code would still be an existence oracle. `test:authz` now derives the mutating-handler set from `ticket.routes.ts` and asserts each one reaches `loadScoped`, so a route added later is covered without extending a list; a mutation test confirmed the assertion goes red when the call is removed. Verified live: Support → tier-1-held attachment = 404, unknown id = the same 404, pool ticket = past the scope |
| G-2 | 🟡 **ANSWERED 2026-08-20 — reserved by decision, not a debt** (Phase 4, step 4.B.6.1; owner-confirmed). Documentation half completes at step 21 | The plan offered two fixes and the owner took a third: **keep the field, build nothing, document it as reserved and always `null`.** Building an upload surface is a storage decision, a permission, a route and a moderation question — and it would be wi-admin’s **first write-side file surface** (its `files` module is two GETs delegating to jovi-mall; a grep for `multer` finds nothing), so it is a feature rather than a field. Removing it from the wire would not remove it from the stored shape, and `avatar_url` is also a field of jovi-mall’s **`PublicAdminSnapshot`** — the projection a customer, vendor, agency or agent is shown — so wi-admin dropping it would leave jovi-mall still promising it to every non-admin reader: a worse-shaped promise, not a smaller one. What made a permanently-null field a broken promise was that it was **undocumented**. Now stated at `snapshotOf`, on `AdminSnapshotDto.avatarUrl`, and on the four role-facing ticket api-docs in jovi-mall (step 4.B.5). `docs/api/support.md` repeats it when step 4.B.3 writes that page |
| ~~G-3~~ | ✅ **CLOSED 2026-08-20 — `scripts/test/test-support.ts`, 123 assertions** (Phase 4, step 4.B.2) | Eight sections, DB-free: the scope as a **query object** (`resolveScope` × `scopeFilter` per tier — the assertion that would have caught G-1's whole class, including that `none` and the audit-shaped scope are *unsatisfiable* rather than empty, since `{}` matches every ticket on the platform); the authority table across the tier matrix, with `assigned_admin_id` asserted as a **LOCK** — the pool is open to every tier and assignment REMOVES reach; the DTO, including `avatarUrl` reserved-and-null and `availableActions` proven DERIVED from the same two functions the service enforces with; the query schema; routes, permissions and the 13 audited actions; **every gateway path**, one assertion each, plus the ⚠ that the D-10 refresh must not ride `/assign`; the attachment delete's lookup-then-scope order; and the G-6 log signal, scanned inside the `catch` only. Four mutations confirmed it fails when it should — widening the Admin scope to tier 2, dropping `holderId` from the log, and mis-pointing `refreshSnapshot` at `/assign` each turn it red. CI discovers it automatically (`test:*` from `package.json`), so the suite count moved 18 → 19 with no workflow edit |
| ~~G-4~~ | ✅ **CLOSED — `docs/api/support.md` exists** (Phase 4, step 4.B.3) | The page has been written since Phase 4 and this row went on saying otherwise for two phases, which is the same class of drift as the assertions in § 7: a status line that memorised the state at the moment it was typed. Marked closed at Phase 5 Part D, when the page was read to confirm it rather than assumed |
| ~~G-5~~ | ✅ **CLOSED 2026-08-20 — the role-facing api-docs describe the shape they serve** (Phase 4, step 4.B.5) | Three JSON examples rewritten and a new **Administrator snapshot** section in `jovi-mall/api-doc/vendor/tickets.md` and `agency/tickets.md`, stating what the four fields are, that `assigned_admin` is `null` until a wi-admin administrator takes the ticket, that `avatar_url` is reserved and always `null` (step 4.B.6.1), that there is deliberately no `tier` and no `id`, and that `assigned_admin_id` resolves to nothing in that database. Two corrections to the step: only **two** files describe the block — `agent/tickets.md` and `customer/tickets.md` document no payloads and defer to `vendor/tickets.md`, so they gained a callout pointing at it — and **`created_by_admin` carries the identical shape and was documented nowhere at all**, so the new section covers both |
| ~~G-6~~ | ✅ **CLOSED 2026-08-20 — the D-10 refresh has a signal** (Phase 4, step 4.B.7) | Still swallowed — a ticket write that succeeded must not report failure because a cosmetic name refresh did — but no longer silent. The `catch` logs at **`warn`** through `requestLogger`, carrying the ticket id, the **holder id** and the error message. Without the holder id the line answers "something failed"; with it, "this administrator’s rename did not propagate", which is the question. **No counter, deliberately** (D-14): wi-admin has no Prometheus registry — `/system/metrics` delegates to jovi-mall’s and `prom-text.ts` only parses geo-tracker’s — so adding one is an ADR about joining the metrics estate, not a line in a `catch`. The docstring says so, at the `catch`, so the next reader does not "finish" the step by starting unplanned infrastructure |

---

## 6 · Two defects found and fixed while building

Recorded because both were invisible to every existing test.

1. **`refreshSnapshot` was pointed at `/assign`.** Sending a bare `admin` there means "this
   administrator now holds it, claimed" — so the D-10 refresh would have **reassigned the
   ticket on every edit** and cleared `assigned_by`, the field the Tier 2 rule depends on.
   Fixed by giving the refresh its own route and its own schema, so it cannot express a
   reassignment.
2. **An administrator opening a ticket on somebody's behalf rendered as a placeholder.**
   `created_by_user_id` held a wi-admin id, which resolves to nothing in jovi-mall — the same
   defect `assigned_admin` had, on the field the customer reads. Fixed with the same snapshot.

## 7 · Assertions that had memorised the wrong state

All of them failed — or would have passed — *for the success*, and all were restated, not
deleted. **This is the rule the rest of Phase 5 worked to**, and it is cited by name in every
part of that plan.

| Assertion | Was | Now |
|---|---|---|
| `only the two self-profile routes map to no permission` | Pinned the null count at 2 — the drift it existed to catch | Pinned at 0 (and then deleted with the map, below) |
| `the ticket router contributes 18 rows, not 19` | Counted rows that being ported removes | `the eighteen ticket rows are gone from the checklist` |
| `an Admin sees every ticket` | `{kind:'all'}`, which D-3 narrows | `an Admin no longer sees every ticket`, plus 4 new tier assertions |
| `the legacy-audit module is deleted once the legacy surface is` | Conditional on `LEGACY_ENDPOINT_COUNT > 0` — an escape hatch that a resurrected map could re-arm | Unconditional: `src/modules/legacy-audit` does not exist |
| **Eight** map-reading assertions across seven suites (`test-authz`, `test-agents`, `test-billing`, `test-cod`, `test-files`, `test-messaging`, `test-money`) | *"no `<domain>` row is left in the legacy endpoint map"* | The map is **deleted**, so each would now pass by having nothing to read. Restated once, in `test-authz.ts` § 9: the map file is gone, the module is gone, and no file under `src/` references either |

⚠ **The last row is the harder direction of the same rule, and it is worth stating plainly: an
assertion that goes vacuously GREEN for the success is as dead as one that goes red for it, and
it is far harder to notice.** A red suite announces itself. Seven suites quietly passing a check
whose subject no longer exists announce nothing at all.
