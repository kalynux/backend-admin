# Phase 17 — what is done, what is half-done, what is not started

**Measured, not remembered.** Every count here was produced by scanning
`permission.catalog.ts` against the route files on **2026-08-17**, and every claim carries a
file reference. The plan and the decision register live in
[PHASE-17-LEGACY-PORT-PLAN.md](PHASE-17-LEGACY-PORT-PLAN.md); this file is the progress
board.

---

## 1 · The headline number

| | Count |
|---|---:|
| Permissions catalogued | **113** |
| Permissions with a live wi-admin endpoint | **97** |
| **Permissions with no endpoint** | **16** |

`LEGACY_ENDPOINT_COUNT` is **17** — down from 37 when Phase 17 began.

### How the 16 break down

| Group | Count | Meaning |
|---|---:|---|
| Portable, not started | **10** | Built in jovi-mall, waiting on Parts B/C/D |
| Deliberately unbuilt | **6** | Nothing exists anywhere to port; each has a written reason |

**There is no longer a "half-implemented" group.** The 11 `support.*` permissions were in it
until this session; both halves now exist.

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

## 3 · Not started — 10 permissions

### Part B · Content / blog — 7 permissions, 14 endpoints

Unblocked (D-7 settled C-2). Nothing written yet.

⚠ **The classification is currently half-true, and this is the one item on this page that is
actively inconsistent.** `platform-collections.ts:278-285` declares `articles` and
`article_authors` as `owned` / `direct` — which is what removes the write guard rail — while
jovi-mall still serves `POST`/`PATCH`/`DELETE` on them at `api/index.ts:376-377`. It is
harmless only because wi-admin has no content module yet. The moment Part B writes its first
article there are two writers on one collection.

### Part C · Files — 2 permissions, 2 endpoints

**Smaller than the plan says.** `src/modules/files/` already exists (controllers, gateways,
routes, validators) serving `files.resolve`, so this is two routes added to a live module.
Open: F-1 (extract a `buildAdminFileRouter` on the jovi-mall side — both routes are guarded
**inline** on the user-facing upload router today), F-2 (confirmation semantics for the
unrecoverable delete), F-3 (what an orphan listing may expose).

### Part D · Messaging — 1 permission, 1 endpoint

`POST /api/webhooks/telegram/send` is **not a broadcast**: one message, one recipient, no
audience model, no fan-out, no delivery record. Only reaches accounts that connected Telegram
via `/connect`. Per D-4 it is ported as-is and the capability renamed
(`broadcast` → `messaging`, `broadcast.send` → `messaging.telegram.send`).

⚠ Moving it off `/api/webhooks/*` makes it **rate-limited and maintenance-blocked** — it is
exempt from both today purely by where it is routed. Intended, but invisible in a diff, so it
must be recorded.

### Part E · Close-out

`LEGACY_ENDPOINT_COUNT` reaching 0 **forces deleting `src/modules/legacy-audit/`**
(`test-authz.ts:697`) and `legacy-endpoint-map.ts` itself. Then `permissions.md` (the `†` count
falls to 6), `README.md` (endpoint and group counts), and `ADR-017-LEGACY-PORT.md`.

---

## 4 · Deliberately unbuilt — 6 permissions

Not a backlog; there is nothing built anywhere to port.

| Permission | Why not |
|---|---|
| `users.sessions.revoke` | jovi-mall issues stateless JWTs with no session store. `users.suspend` covers the need. ADR-007 |
| `users.roles.manage` | Removing a role has no implementation and no defined semantics — it strands the Store. ADR-007 |
| `customers.read` · `customers.suspend` | **Not unbuilt — being deleted.** The `users` module is role-agnostic and already covers customers (`?role=customer`, the customer role-profile, suspend/restore), and `orders.read?customerId=` carries the history. Unlike the four rows above these are *granted* (tier 2 via `allInFamily`, tier 3 by name) while backing no route, so a rationale would document the promise rather than withdraw it. Decided in [ADR-017](./ADR-017-PHASE-17-CLOSEOUT.md) D-1; removed in Part E |
| `notifications.manage` | ADR-013 D-9 — service-wide wording would block tier 3 configuring their own preferences |
| `developer_tools.webhooks.redeliver` | ADR-012 — every webhook mount is inbound; nothing to redeliver |

`users.password.reset` **left this list during Phase 17** — the login-link work supplied the
delivery channel ADR-007 said it was blocked on. It was not part of this plan.

---

## 5 · Known gaps in what IS shipped

Honest debts in Part A, none of which block it.

| # | Gap | Detail |
|---|---|---|
| ~~G-1~~ | ✅ **CLOSED 2026-08-19 — the attachment delete is tier-scoped** (Phase 4, step 4.B.1) | The lookup exists: `TicketAttachmentReadRepository.findTicketIdByAttachment` projects `{_id, ticket_id}` and nothing else, and the handler feeds that id straight to the same `loadScoped` + `assertMayAct` pair every sibling write uses. A missing attachment and an out-of-scope ticket answer the **identical** `TICKET_NOT_FOUND` 404 — two 404s differing only in their code would still be an existence oracle. `test:authz` now derives the mutating-handler set from `ticket.routes.ts` and asserts each one reaches `loadScoped`, so a route added later is covered without extending a list; a mutation test confirmed the assertion goes red when the call is removed. Verified live: Support → tier-1-held attachment = 404, unknown id = the same 404, pool ticket = past the scope |
| G-2 | 🟡 **ANSWERED 2026-08-20 — reserved by decision, not a debt** (Phase 4, step 4.B.6.1; owner-confirmed). Documentation half completes at step 21 | The plan offered two fixes and the owner took a third: **keep the field, build nothing, document it as reserved and always `null`.** Building an upload surface is a storage decision, a permission, a route and a moderation question — and it would be wi-admin’s **first write-side file surface** (its `files` module is two GETs delegating to jovi-mall; a grep for `multer` finds nothing), so it is a feature rather than a field. Removing it from the wire would not remove it from the stored shape, and `avatar_url` is also a field of jovi-mall’s **`PublicAdminSnapshot`** — the projection a customer, vendor, agency or agent is shown — so wi-admin dropping it would leave jovi-mall still promising it to every non-admin reader: a worse-shaped promise, not a smaller one. What made a permanently-null field a broken promise was that it was **undocumented**. Now stated at `snapshotOf`, on `AdminSnapshotDto.avatarUrl`, and on the four role-facing ticket api-docs in jovi-mall (step 4.B.5). `docs/api/support.md` repeats it when step 4.B.3 writes that page |
| ~~G-3~~ | ✅ **CLOSED 2026-08-20 — `scripts/test/test-support.ts`, 123 assertions** (Phase 4, step 4.B.2) | Eight sections, DB-free: the scope as a **query object** (`resolveScope` × `scopeFilter` per tier — the assertion that would have caught G-1's whole class, including that `none` and the audit-shaped scope are *unsatisfiable* rather than empty, since `{}` matches every ticket on the platform); the authority table across the tier matrix, with `assigned_admin_id` asserted as a **LOCK** — the pool is open to every tier and assignment REMOVES reach; the DTO, including `avatarUrl` reserved-and-null and `availableActions` proven DERIVED from the same two functions the service enforces with; the query schema; routes, permissions and the 13 audited actions; **every gateway path**, one assertion each, plus the ⚠ that the D-10 refresh must not ride `/assign`; the attachment delete's lookup-then-scope order; and the G-6 log signal, scanned inside the `catch` only. Four mutations confirmed it fails when it should — widening the Admin scope to tier 2, dropping `holderId` from the log, and mis-pointing `refreshSnapshot` at `/assign` each turn it red. CI discovers it automatically (`test:*` from `package.json`), so the suite count moved 18 → 19 with no workflow edit |
| G-4 | **No `docs/api/support.md`** | The contract is not written down, so by this repo's own rule it is not promised |
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

## 7 · Three assertions that had memorised the wrong state

All three failed *for the success* and were restated, not deleted:

| Assertion | Was | Now |
|---|---|---|
| `only the two self-profile routes map to no permission` | Pinned the null count at 2 — the drift it existed to catch | Pinned at 0 |
| `the ticket router contributes 18 rows, not 19` | Counted rows that being ported removes | `the eighteen ticket rows are gone from the checklist` |
| `an Admin sees every ticket` | `{kind:'all'}`, which D-3 narrows | `an Admin no longer sees every ticket`, plus 4 new tier assertions |
