# Phase 17 — porting the last 21 permissions

**This is a plan and a decision register, not a decision record.** It says what is settled, what
is still open, what to read, and what "done" means for each part. The ADR that records what was
actually decided (`ADR-017-LEGACY-PORT.md`) is written at the end, from what happened.

Every factual claim carries a file reference and was read out of the source on **2026-08-17**.
Anything not verified is marked **⟨decide⟩** and must not be guessed at implementation time.

---

## 1 · What is being ported, and the numbers

Of the **110** permissions in [permission.catalog.ts](../src/modules/authorization/domain/permission.catalog.ts),
**28** have no route in wi-admin. They split two ways, and only one half is this plan's subject:

| | Count | State |
|---|---:|---|
| **Catalogued, built in jovi-mall, not yet ported** | **21** | ← this plan |
| Catalogued, deliberately unbuilt anywhere | 6 | out of scope — §9 |

> **The catalog moved during Phase 17, from outside this plan.** It now holds **113**
> permissions, not 110: `agents.contracts.manage`, `files.resolve` and `users.login_link.send`
> were added and routed while Part A was in progress, and `users.password.reset` was **built** —
> the login-link work supplied the delivery channel ADR-007 said it was blocked on. So the
> deliberately-unbuilt set is **6**, not 7. The 21 in scope here are unchanged.
>
> One consequence for Part C: **`src/modules/files/` already exists** (controllers, gateways,
> routes, validators) serving `files.resolve`. That part is now two routes added to a live
> module rather than a module to create.

The 21 permissions cover **35 legacy endpoints**, listed row-by-row in
[legacy-endpoint-map.ts](../src/modules/authorization/domain/legacy-endpoint-map.ts):

| Family | Permissions | Legacy rows | jovi-mall source |
|---|---:|---:|---|
| `support.*` | 11 | 18 | `modules/tickets/routes/admin-ticket.routes.ts` |
| `content.*` | 7 | 14 | `modules/blog/routes/admin-blog.routes.ts` |
| `files.*` | 2 | 2 | `api/routes/file-upload.routes.ts` (guarded inline) |
| `broadcast.*` → `messaging.*` | 1 | 1 | `modules/telegram/telegram.routes.ts` |
| **Total** | **21** | **35** | |

`LEGACY_ENDPOINT_COUNT` is now **35** — the two `/api/admin/profile` rows were stale and were
deleted at Phase 17 (§4, X-1).

> **Porting is not transcription.** [agency.routes.ts:110](../src/modules/agencies/routes/agency.routes.ts#L110)
> says so: jovi-mall spells two of its writes `PATCH`, wi-admin serves them as `POST`
> sub-resources because the permission and the audit row attach to the *action*. Every ported
> family so far also gained endpoints with no legacy row. The 35 rows are a **coverage
> checklist**, not a target route table.

---

## 2 · Locked decisions

Settled with the product owner on 2026-08-17.

| # | Decision | Consequence |
|---|---|---|
| **D-1** | **Ticket writes are delegated** over jovi-mall's internal API | jovi-mall gains `buildAdminTicketRouter`; wi-admin gains a gateway. The dashboard still talks only to wi-admin. Reads stay direct |
| **D-2** | **Tier 3 gets article read + write. No publish, no delete** | A `tier-grants.ts` edit only — no flag change, no assertion change |
| **D-3** | **Tier 3 ticket reach = unassigned + their own**, and they may escalate their own to Tier 2 | They cannot touch a peer's or a senior's ticket |
| **D-4** | **Port the one-to-one Telegram send**, and rename the capability honestly | It is not a broadcast — §3.3 |
| **D-5** | The customer-visible admin snapshot is **name · avatar · job title · department** | `id`, `source`, `tier` and `assigned_by` are stored but **internal-only**. `publicAdminSnapshot()` is the boundary |
| **D-6** | **No unassign action.** Any tier may claim from the pool | A ticket leaves an administrator only by being assigned onward, which D-3 already governs. The pool cannot stall |
| **D-7** | **jovi-mall's admin blog routes are deleted** in the same change as Part B | Executes ADR-004 D-4. The public reader is untouched; the legacy dashboard loses blog editing that day |
| **D-8** | The wi-admin assignment is a **new `admin_assignment` block** | Superseded in part by D-9 — the old column is now deleted outright rather than kept beside it |
| **D-9** | **`assigned_admin_id`, the whole exclusivity mechanism, and the legacy `/api/admin/tickets` mount are deleted.** No production data exists, so no migration | wi-admin is the only admin ticket surface. The mount could not have been kept: its only access control was the lock, and it cannot enforce the tier matrix because a legacy `admin` is a platform user with no tier |
| **D-10** | The admin snapshot **refreshes on every write** to the ticket | It is current-state ("who is handling this"), not an audit stamp. wi-admin re-sends the profile on each delegated write, so it costs nothing. A dormant ticket keeps the name from its last write |

### D-3 as a matrix

| | may act on | may assign to |
|---|---|---|
| **Tier 1** Developer | everything | Tier 1, 2, 3 |
| **Tier 2** Admin | unassigned · own · **Tier-3-held** | Tier 1, Tier 3 — **except** a ticket assigned to them *by* a Tier 1, which may go only to Tier 3 |
| **Tier 3** Support | unassigned · **own only** | Tier 2 (escalation of their own) |

---

## 3 · What the source says about those decisions

### 3.1 The administrator is invisible to jovi-mall, and denormalising fixes it

`resolveAdmins()` (`jovi-mall/src/modules/tickets/services/ticket-enrichment.service.ts:343-350`)
queries jovi-mall's own `admins` collection for `name` + `avatar`. A wi-admin administrator id
matches nothing, so `assigned_admin` renders **`null`** on every ticket read for the customer,
vendor, agency and agent.

Snapshotting the administrator onto the ticket is the fix, and jovi-mall already has the shape:
**`actorStampFields()` / `actorStamp()`** (`core/types/actor-source.types.ts`) — id +
`*_source: 'platform' | 'admin'` + `*_name` — already used for `agency_remittances.resolved_by`
and `agent_deposits.recorded_by`. **Reuse it; do not invent a parallel shape.**

Platform-created tickets are not auto-assigned to a *person*. Nearly — system tickets **are**
assigned to the admin **pool** (`assignTicket(id, ActorRole.ADMIN, null, …)`,
`payout-request.service.ts:134`). Role-level, no individual.

### 3.2 Three things the port has to build that do not exist

**(a) `assigned_admin_id` is not the assignment field — it is an auto-set exclusivity LOCK.**
`setActiveAdminIfNotSet()` (`ticket.service.ts:101`) stamps it on an admin's **first action** on
any ticket; `clearActiveAdmin()` clears it on close/resolve; `validateActiveAdminPermission()`
(`:79-88`) throws **403** at every other admin — Developers included. Real assignment lives in
`assigned_to_role` + `assigned_to_user_id`, which is polymorphic and can point at a vendor or a
customer.

So today a Tier 3 merely *touching* a ticket locks a Tier 1 out of it. **The lock is replaced by
the D-3 matrix on the internal router**; the legacy public mount keeps it until cutover.

**(b) `resolveScope('tickets')` is half-right already, and needs a denormalised tier to finish.**

```
current                                     required by D-3
tier 1|2 → { kind: 'all' }                  tier 1 → { kind: 'all' }                    ✔ keep
tier 3   → { assigned, self, +unassigned }  tier 2 → own + Tier-3-held + unassigned     ← NEW
                                            tier 3 → { assigned, self, +unassigned }    ✔ exact
```

Tier 2's rule needs the **assignee's tier**, and wi-admin's administrators live in a *different
database* — a cross-DB join cannot exist in one query. So the assignee's tier must be part of the
snapshot on the ticket, or the scope is not expressible as a filter. And it must be a filter:
`resource-scope.ts:20-29` is explicit that a scope folded into the query is one nobody can
forget, and that a miss must be **404**, not 403.

**(c) The Tier 2 exception needs a field that does not exist.** *"Cannot reassign a ticket
assigned to them by a Tier 1 back to Tier 1"* keys on **who assigned it**; the ticket records
only who it is assigned *to*. Add `assigned_by` (id + source + name + **tier**).

**(d) Why D-1 went the way it did.** jovi-mall is a permanent writer of `tickets` —
`payout-request.service.ts:120,134,325`, `dispute.service.ts:469`,
`booking-refund.service.ts:184` — so the collection can never become `owned` the way the blog
did. And every ticket write publishes on jovi-mall's **in-process** bus: `ticket.created`
(`:181`), `ticket.status_changed` (`:259`), `ticket.assigned` (`:348`), `ticket.priority_changed`
(`:431`). A write from wi-admin's own connection publishes none of them — the ticket changes and
nobody is told. That is ADR-004 D-2's exact failure mode.

### 3.3 The broadcast endpoint is not a broadcast

`POST /api/webhooks/telegram/send` sends **one message to one recipient**:

```
{ userId?: string, chatId?: string, message: string (1..4096) }   // one of userId | chatId
```

`TelegramNotificationService.send()` resolves `userId` → that account's Telegram `chat_id` via
`channel_connections`, or takes a raw `chatId`, then calls the Bot API once. **No audience, no
segments, no fan-out, no scheduling, no delivery record** — `sendMessage` returns a boolean. It
reaches only accounts that connected Telegram via `/connect`; everyone else gets
`'No Telegram account connected'`.

Real use cases for what exists: an operator replying to one person out-of-band on a ticket or a
payout, re-sending a notification that failed, and verifying a user's Telegram link works.
"Message every vendor" is **not** portable from this — it is new work.

`PermissionFamily` is a hand-written union plus a parallel array
([permission.types.ts:33-63](../src/modules/authorization/domain/permission.types.ts#L33-L63)),
and the family has exactly **one** member, so `broadcast` → `messaging` and `broadcast.send` →
`messaging.telegram.send` is a ~5-file change.

### 3.4 Two author concepts, which must not be merged

The editorial **byline** (`article_authors`, what `content.authors.*` manages, what the public
site renders) and the **administrative author** (which admin wrote it — an internal record).
Merging them publishes staff identity.

---

## 4 · Rules that constrain every part

Verified, and each refuses to boot or refuses to pass if broken:

| Rule | Where | If you miss it |
|---|---|---|
| A route is registered **only** through `defineRoute` | [route-manifest.ts:332](../src/api/route-manifest.ts#L332) | `assertRouteManifestComplete()` fails startup; `test:authz` refuses a raw `router.get(` in a routes file |
| `access:` required; `audit:` required on every mutating method | [route-manifest.ts:226](../src/api/route-manifest.ts#L226) | Compile error |
| Every catalogued audit action must have a **producer** | [audit-coverage.ts](../src/api/audit-coverage.ts) | Startup failure. **Audit-catalog entries and the routes that emit them must land in one change** |
| Deleting a legacy row means decrementing `LEGACY_ENDPOINT_COUNT` | `legacy-endpoint-map.ts` | `test-authz.ts:679` and `test-agents.ts:569` both fail |
| A direct read of `jovi_mall` needs a `platform-collections.ts` entry, and goes only through `PlatformReadRepository` | [platform-collections.ts](../src/infra/platform/platform-collections.ts) | Compile error |
| Writes go over the internal API — **blog excepted** | ADR-004 D-2 / D-4 | Silent loss of post-commit events |
| Shared vocabulary: `listQuery`, `objectId`, `reasonText`, `toPageMeta`, `sendPaginated` | `core/validation/common.schemas`, `core/http/list-query` | `test:contract` pins them |
| Tier 3 may hold **no** `financial` or `destructive` permission | [tier-grants.ts:275-280](../src/modules/authorization/domain/tier-grants.ts#L275-L280) | Boot failure — this is what D-2 works around |

**No permission-catalog additions are needed** — all 21 names exist. **Two grant edits are**:
D-2's four `content.*` names into `SUPPORT`, and D-4's family rename.

**No audit-catalog entries exist for any of the four families.** The catalog holds 80 actions and
none is `support.*`, `content.*`, `files.*` or `broadcast.*`.

---

## 5 · Part 0 · Groundwork — **DONE**

1. **Baseline captured, all green**: `test:foundation` 66 · `test:contract` 97 · `test:authz` 138
   · `test:audit` 138 · `test:data-access` 44 = **483 assertions**. No pre-existing failures in
   the suites this work touches.
2. **X-1 resolved.** The two `/api/admin/profile` rows were stale — their targets have existed
   since Phase 2 as `selfService` routes (`administrator.routes.ts:37-56`). Rows deleted with a
   tombstone, `LEGACY_ENDPOINT_COUNT` 37 → **35**, and the header's `null` note corrected: no row
   uses `null` today.
3. Mount names confirmed from the map's own `target` column: `/support`, `/content`, `/files`,
   and `/messaging` per D-4.

---

## 6 · The decision register — what is still open

**BLOCKING** — work cannot start. **SHAPING** — work can start, this changes the design.
**DEFERRABLE** — decide before go-live.

### Support / tickets

| # | Grade | Decision |
|---|---|---|
| T-5 | ✅ **CLOSED** | `assigned_by` added as the second half of `admin_assignment` (D-8), carrying tier |
| T-6 | ✅ **CLOSED** | D-5. Enforced by `publicAdminSnapshot()` in `core/types/admin-snapshot.types.ts` |
| T-7 | ✅ **CLOSED** | D-10 — refresh on write. `TicketRepository.refreshAdminSnapshot` is guarded on the assignee id so a refresh racing a reassignment cannot overwrite the new holder |
| T-8 | **SHAPING** | `tickets` is already directly readable; `ticket_notes`, `ticket_followers`, `ticket_attachments` are **not registered at all**. Register all three as `read`, or delegate those reads? *(Recommend register — they are records, not verdicts; ADR-009 D-1)* |
| T-9 | ✅ **CLOSED** | Moot — no production data, and the column is deleted (D-9). The snapshot's `source` field is kept anyway; it is what would distinguish a legacy admin if one ever appeared |
| T-10 | ✅ **CLOSED** | D-6 — no unassign |
| T-11 | ✅ **CLOSED** | D-6 — any tier may claim from the pool |
| T-12 | DEFERRABLE | Where an administrator's file **upload** happens — `POST /:ticketId/attachments` attaches an already-uploaded `fileId`, and wi-admin has no upload surface |
| T-13 | DEFERRABLE | Whether an assigned admin becomes a follower. Admins never count toward the 5-user limit and **cannot be removed** (`ticket-follower.service.ts:17,131`) — one-way |
| T-14 | DEFERRABLE | Whether the legacy `/api/admin/tickets` mount keeps its exclusivity lock until cutover *(recommend yes — untouched)* |

### Content / blog

| # | Grade | Decision |
|---|---|---|
| C-2 | ✅ **CLOSED** | D-7 — jovi-mall's admin blog routes are deleted in the same change. Part B is unblocked. ⚠ Until then the classification is **half true**: `platform-collections.ts` calls both collections `owned`/`direct` — which is what removes the write guard rail — while `api/index.ts:376-377` still serves `POST`/`PATCH`/`DELETE` on them. Harmless only because wi-admin has no content module yet |
| C-3 | **SHAPING** | Grep-verify **no jovi-mall writer remains** on either collection, `seed:blog` included. The table's own instruction — `owned` is what removes the guard rail |
| C-4 | **SHAPING** | How the block-type Zod union stays honest across repos (no shared package; the marketing site renders it too). Precedent: assert one side against the other's fixtures, as `test:rich-description` does |
| C-6 | **SHAPING** | `buildSlugKeys` / the `content_updated_at` fingerprint / `wordCount` move with the service — missing one silently breaks renamed URLs |
| C-7 | DEFERRABLE | Where jovi-mall's `test:blog` (100) and `verify:blog` (47) end up |
| C-8 | DEFERRABLE | May Tier 3 edit an article **after** publication, or drafts only? D-2 withholds publish, not editing |

### Files

| # | Grade | Decision |
|---|---|---|
| F-1 | **SHAPING** | Extract a `buildAdminFileRouter` factory, or another internal mount — both routes are guarded **inline** on the user-facing upload router (`file-upload.routes.ts:67,108`) |
| F-2 | **SHAPING** | Confirmation semantics for the unrecoverable delete. Precedent: `outbox.prune` makes you repeat the value that decides the blast radius |
| F-3 | DEFERRABLE | What an orphan listing may expose (paths, original filenames, owner ids) |

### Messaging (ex-broadcast)

| # | Grade | Decision |
|---|---|---|
| M-1 | **SHAPING** | Final names: family `messaging`, permission `messaging.telegram.send`, route `POST /api/v1/messaging/telegram` — confirm before the rename lands |
| M-2 | **SHAPING** | Moving off `/api/webhooks/*` makes it **rate-limited and maintenance-blocked**; it is exempt from both today purely by where it is routed. Intended, and it must be written down — the change is invisible in a diff |
| M-3 | DEFERRABLE | What the audit row records — recipient, message body, or both. A send is not undoable |

### Cross-cutting

| # | Grade | Decision |
|---|---|---|
| X-2 | DEFERRABLE | `LEGACY_ENDPOINT_COUNT` reaching 0 **forces deleting `src/modules/legacy-audit/`** (`test-authz.ts:697`), and decides the fate of the `admin_action_log` read |
| X-3 | DEFERRABLE | Restamping `phase:` to 17 also means **widening the `phase` union** at `permission.types.ts:166`, which stops at 16 |

---

## 7 · Execution plan

Parts A–D are independent; E is last. **Do not batch them** — a half-ported family leaves
`LEGACY_ENDPOINT_COUNT` disagreeing with its own table, which fails `test:authz` and
`test:agents` by design. Each part ends at a green run and a committed doc.

### Part A · Support / tickets — 11 permissions, 18 endpoints — **IN PROGRESS**

**The jovi-mall half is DONE** — `npm run test:admin-tickets` is green at **27**, `tsc` and
`lint` clean, and the route table was enumerated from a live load rather than assumed.

- `src/core/types/admin-snapshot.types.ts` — the shared administrator snapshot, its sub-schema,
  and `publicAdminSnapshot()`, the D-5 disclosure boundary. **Part B reuses this on articles.**
- `ticket.model.ts` — the `admin_assignment` block, `created_by_admin`, and the two indexes the
  D-3 scope filter needs, sorted to match every other ticket list. `assigned_admin_id` deleted.
- The exclusivity mechanism deleted in full: 3 private methods, 13 call sites, 2 repository
  writers, the controller check, and `resolveAdmins` in the enrichment service.
- `buildAdminTicketRouter(guards)` mounted at `/api/internal/admin/tickets` (18 routes); the
  legacy `/api/admin/tickets` mount deleted (D-9). The other four role mounts are untouched.
- `TicketService.assignToAdministrator` / `refreshAdminSnapshot`, the `AssignToAdministrator`
  wire schema, and `created_by_admin` on the create path.

**A second instance of the same defect was found and fixed while here:** an administrator
opening a ticket on somebody's behalf wrote a wi-admin id into `created_by_user_id`, so "opened
by" rendered a placeholder to the very customer it was opened for — the same failure
`assigned_admin` had. It uses the same snapshot.

**Still to do (wi-admin):** the `support` module — routes, controller, gateway, read
repositories, the tier-scope query, the assignment authority table, audit actions, docs, tests.

**Read first:** `admin-ticket.routes.ts` · `ticket.model.ts` (esp. `:32-36`) ·
`ticket.controller.ts:26,45,97-98` · `resource-scope.ts` (the whole file — built for this and
never consumed) · `src/modules/agencies/` (the reference shape) · `internal-admin.routes.ts`.

**jovi-mall**

1. `actorStamp` the ticket: `assigned_admin_{id,source,name,tier,department,job_title}` and
   `assigned_by_{id,source,name,tier}`, using `actorStampFields()` / `actorStamp()`.
2. `buildAdminTicketRouter(guards)` per the factory pattern; mount at
   `/internal/admin/tickets`; keep the public mount live until cutover.
3. The exclusivity lock **does not apply** on the internal router — D-3 is the authority.
   `validateActiveAdminPermission` / `setActiveAdminIfNotSet` stay on the legacy path (T-14).
4. Extend `ticket-enrichment.service.ts` to render the snapshot when `*_source === 'admin'`,
   falling back to `resolveAdmins()` for `'platform'` rows.
5. Migration for existing rows (T-9).

**wi-admin** — `src/modules/support/`, mirroring `src/modules/agencies/` file-for-file:
`routes/` · `controllers/` · `validators/` · `gateways/support.gateway.ts` (writes, wrapped in
`auditedAttempt`) · `repositories/` + `read-models/`.

6. New `resolveScope('tickets')` tier-2 variant, folded into the query; register the three
   ticket sub-collections per T-8.
7. **One authority table** for the assignment matrix, read by the service (to enforce) *and* the
   DTO (to render buttons) — the house pattern is `resolveAvailableActions` in jovi-mall's
   `stock-requests`. A second copy is how a dashboard offers a verb the API refuses.
8. Audit actions, one per action rather than per route: `support.tickets.create` · `.update` ·
   `.assign` · `.close` · `.reopen` · `.followers.add` · `.followers.remove` · `.notes.create` ·
   `.attachments.attach` · `.attachments.delete`. Close and reopen are two, per the
   `agencies.deactivate` / `.reactivate` precedent.
9. Delete the 18 rows; `LEGACY_ENDPOINT_COUNT -= 18`.

### Part B · Content / blog — 7 permissions, 14 endpoints

1. **Settle C-2 first** — it decides whether this is a move or a copy.
2. `admin/src/modules/content/` on `PlatformOwnedRepository` (no gateway — nothing to delegate
   to). Port `ArticleService` + `ArticleAuthorService` (450 LOC) and `article-body.validator.ts`,
   carrying `buildSlugKeys`, the `content_updated_at` fingerprint and `wordCount` (C-6).
3. `tier-grants.ts`: add `content.articles.read`, `content.articles.write`,
   `content.authors.read`, `content.authors.write` to `SUPPORT` (D-2). Not publish, not delete.
4. Administrative-author stamp, separate from the byline (§3.4).
5. Audit actions: `content.articles.{create,update,publish,unpublish,archive,delete}` ·
   `content.authors.{create,update,delete}`.
6. `GET /articles/:id/preview` returns the **public** DTO behind the admin guard — port that DTO;
   do not add a flag that makes the public route serve drafts.
7. Delete the 14 rows; `LEGACY_ENDPOINT_COUNT -= 14`.

### Part C · Files — 2 permissions, 2 endpoints

`admin/src/modules/files/` — orphan read, delegated hard delete. Settle F-1 and F-2 first. Audit
action `files.delete` only (the read is not audited — ADR-006 D-5). Delete 2 rows.

### Part D · Messaging — 1 permission, 1 endpoint

Rename per D-4/M-1, mount `POST /api/v1/messaging/telegram`, delegate to
`TelegramNotificationService`, audit action `messaging.telegram.send`. **Correct the permission
summary** — it currently promises fan-out that does not exist. Record M-2. Delete 1 row.

### Part E · Close-out

`LEGACY_ENDPOINT_COUNT` → 0 forces deleting `src/modules/legacy-audit/` and
`legacy-endpoint-map.ts` itself. Then `docs/api/permissions.md` (the `†` count falls **28 → 7**),
`docs/api/README.md` (four new rows; "18 route groups" and "179 versioned endpoints" both move),
and `ADR-017-LEGACY-PORT.md` written from what was actually decided.

**Cutover is not in scope** — deleting jovi-mall's public `/api/admin/*` mounts stays Phase 8,
except the blog routes C-2 forces a call on now.

---

## 8 · Verification

```bash
cd admin
npm run test:authz && npm run test:audit && npm run test:data-access && npm run test:contract
npx tsc --noEmit && npm run lint
```

Per family: a DB-free `scripts/test/test-<family>.ts` and a `verify-<family>-live.ts`, registered
in `package.json`. Four things only a live run proves, each of which fails silently otherwise:

1. **D-3 applied as a query filter**, not a controller check — a Tier 3 asking for a Tier 2's
   ticket must get **404**, never 403 (`resource-scope.ts:20-29`). Assert all three tiers against
   a fixture set of unassigned / own / peer / senior tickets.
2. A customer, vendor, agency and agent reading a ticket **see the denormalised admin block**
   where they previously got `null`.
3. A delegated ticket write **still notifies** — assert the four events fire. That is the whole
   reason D-1 went the way it did.
4. The blog's **unique multikey index on `slug_keys`** still builds. `autoIndex` fails silently,
   which is the entire reason `verify:blog` exists.

---

## 9 · Explicitly out of scope

The other **7** unrouted permissions are not a porting backlog — there is nothing built anywhere
to port:

| Permission | Why not |
|---|---|
| `users.sessions.revoke` | jovi-mall issues stateless JWTs with no session store. ADR-007 |
| `users.password.reset` | No administrator-initiated reset exists. ADR-007 |
| `users.roles.manage` | Removing a role has no implementation and no defined semantics. ADR-007 |
| `customers.read` · `customers.suspend` | **Not unbuilt — being deleted.** The `users` module is role-agnostic and already covers customers; `orders.read?customerId=` carries the history. These two are *granted* while backing no route, unlike the rest of this list. [ADR-017](./ADR-017-PHASE-17-CLOSEOUT.md) D-1; removed in Part E |
| `notifications.manage` | ADR-013 D-9 — service-wide wording would block tier 3 configuring their own preferences |
| `developer_tools.webhooks.redeliver` | ADR-012 — every webhook mount is inbound; nothing to redeliver |
