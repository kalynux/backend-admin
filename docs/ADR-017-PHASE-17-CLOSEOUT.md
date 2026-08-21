# ADR-017 — Phase 17 close-out

**Date:** 2026-08-18, extended 2026-08-20 (Phase 5 Parts A–E)
**Status:** **ACCEPTED — complete.** Every decision D-1 … D-12 is recorded here, plus the four
corrections the work produced and the two cross-cutting notes (C-6, C-10). Phase 17 is closed
and jovi-mall's admin surface is cut over.
**Scope:** wi-admin
**Record for:** [`PHASE-17-LEGACY-PORT-PLAN.md`](./PHASE-17-LEGACY-PORT-PLAN.md) and
[`PHASE-17-STATUS.md`](./PHASE-17-STATUS.md), which carry the working detail

---

## Why this file exists — and why it stopped being half-empty

Phase 17's plan and status page are working documents — they track what is ported, what is left,
and what is deliberately unbuilt. What they are not is the place a *decision* is recorded, and
one of their rows has been asking for one in writing since the phase opened: `customers.read` ·
`customers.suspend`, **"the only pair with no written rationale anywhere"**.

That is D-1. The remaining close-out decisions (Part E's forced deletions, the `phase` union
widening, what `LEGACY_ENDPOINT_COUNT = 0` obliges) landed here as they were taken.

D-9 and D-10 landed with Phase 5 Part B; D-11, C-6 and O-2 with Part C. **D-2 … D-8 and D-12
were taken during Parts A–C and written up at Part D** — the backfill this header used to
flag as a visible gap. They are below, in order, each with what actually happened rather than
what was planned.

---

## D-1 · `customers.read` and `customers.suspend` are deleted from the catalog

**Decision: remove both permissions.** Not "unbuilt with a rationale" — removed.

### What was verified before deciding

- Both are catalogued at `phase: 6` under a header that already concedes the point:
  `// ═══ CUSTOMERS ═══ no admin surface today` — `permission.catalog.ts:641-649`. **Neither has
  an endpoint.**
- **Both are granted.** Tier 2 Admin holds them via `allInFamily('customers')`
  (`tier-grants.ts:152`), and Tier 3 Support is granted `customers.read` **by name**
  (`tier-grants.ts:68`). `docs/api/permissions.md:265-266` publishes both with the grant matrix.
- **The `users` module already covers customers, role-agnostically.** `USER_ROLES` is
  `['vendor','agency','agent','customer']` (`users/validators/user.validator.ts:26`), so
  `GET /users?role=customer` *is* the customer directory; `GET /users/:userId` composes a
  `customer` role-profile (`role-profile.read.repository.ts:55`);
  `POST /users/:userId/{suspend,restore}` is the suspension, audited as `users.suspend` /
  `users.reinstate`. Order history is `orders.read` filtered by `customerId`.
- The catalogued summary — *"Search customers and view their detail and order history"* — is
  therefore served in full, by two permissions every tier that would hold `customers.read`
  already has.

### Why deletion rather than the unbuilt list

The other four entries on that list (`users.sessions.revoke`, `users.roles.manage`,
`notifications.manage`, `developer_tools.webhooks.redeliver`) are **grants nobody holds** —
absent from `tier-grants.ts` entirely. These two are **live grants backing no route**. That
difference is the whole argument: a granted permission with no endpoint appears in an
administrator's effective permission list and in the dashboard's permission screen, promising a
customers surface that does not exist. Leaving it catalogued with a rationale documents the
promise instead of withdrawing it.

### What the change touches

**Done at Phase 5 Part D, step D.1.** What actually changed:

| File | Edit |
|---|---|
| `src/modules/authorization/domain/permission.catalog.ts` | both entries and the `CUSTOMERS` block header deleted, replaced by a tombstone naming why these two were removed rather than documented |
| `src/modules/authorization/domain/permission.types.ts` | **`'customers'` deleted from `PermissionFamily` AND from `PERMISSION_FAMILIES`** — the row this table originally missed |
| `src/modules/authorization/domain/tier-grants.ts` | `'customers.read'` deleted from `SUPPORT`; `allInFamily('customers')` deleted from the tier-2 union |
| `docs/api/permissions.md` | the `customers` section replaced by a note saying where the capability lives instead |
| `PHASE-17-STATUS.md` · `PHASE-17-LEGACY-PORT-PLAN.md` | the unbuilt-list rows point here, and both counts corrected to 4 |

⚠ **The family had to go with the names, and this table did not say so.** `test-authz.ts`
asserts *"every family in `PERMISSION_FAMILIES` has at least one permission"*, so deleting the
two names while keeping `customers` in the union turns the suite red. That is the right
behaviour and worth keeping: **building a real customers surface later means re-declaring the
family**, which is a deliberate edit rather than a silent reuse of a name that outlived its
permissions.

**The catalog-size and tier-grant assertions this section told the implementer to check do not
exist.** No suite pins the catalog size or any tier's grant count as a literal — the counts are
published in `docs/api/permissions.md` and were updated there (113 → **111**, tier 1 113 → 111,
tier 2 96 → 94, tier 3 28 → 27, all evaluated rather than reasoned). What `test:authz` *does*
pin is the mechanism: every family non-empty, every permission granted to some tier, tier 1
holding everything. All three still pass, and § 9 gained three assertions pinning this deletion
specifically.

### Consequence

No capability is lost. An administrator searching for a customer uses `users.read` with
`?role=customer`; suspending one uses `users.suspend`, which is the same account lock with the
same audit action and the same compare-and-set. What is lost is a second name for it.

---

## D-2 · Phase 5 Part E performs the FULL jovi-mall cutover

**Decision: cut over in this phase, not a later one.** All remaining public `/api/admin/*`
mounts are deleted, with the `requireRole(['admin'])` guard sites behind them, the three
`adminActionLogMiddleware` mounts and jovi-mall's `api-doc/admin/*`. This is wi-admin's
"Phase 8", pulled forward — ADR-002 § 3 and `IMPLEMENTATION-BLUEPRINT.md` J10 both forecast it
as a phase of its own.

**Why now.** The alternative is running two authorization models over the same operations for
an unbounded period: wi-admin's tiered, granular, audited one, and jovi-mall's
`requireRole(['admin'])` on a platform `users` row that carries no tier and no permission set.
Every wi-admin decision — the tier matrix, the escalation rules, the dual-control queue, the
audit — is bypassed by a token that satisfies the second. Keeping both is not a smaller risk
than cutting over; it is the same risk indefinitely.

The precondition was the port, and the port is done: **111 catalogued permissions, 107 routed,
4 unbuilt with a written reason each.**

**What survives is not a small list** — see D-6 and D-7, and Part E.4 of the Phase 5 plan. The
`/api/internal/admin/*` surface is untouched: wi-admin reaches it with
`INTERNAL_SERVICE_TOKEN` and `requireAdminCaller`, and that is the door that stays open.

---

## D-3 · Step 5.0 is discharged by ORDERING, not by reverting the classification

`platform-collections.ts` declared `articles` and `article_authors` `owned` / `direct` before
wi-admin had a content module — which is what removes the write guard rail — while jovi-mall
still served `POST`/`PATCH`/`DELETE` on them. Phase 17 C-2 flagged this as the one actively
inconsistent item on its status page: *"the moment Part B writes its first article there are
two writers on one collection."*

**Decision: keep the classification and close the window by deploy order, not by reverting to
`delegated` and back.** Reverting would have been two further changes to the same table for a
window that ordering removes entirely.

---

## D-4 · Deploy order within the content port is **jovi-mall FIRST**

The direct consequence of D-3, and the direction is not obvious, so it is written out.

- **jovi-mall first** → a window with **no blog editor at all**. The public reader keeps
  serving, the marketing site is unaffected, and nobody can publish for the length of one
  deploy.
- **wi-admin first** → a window with **two writers on one collection**, one behind
  `requireRole(['admin'])` on a platform user session and the other behind the tier matrix.

The second is the exact state D-3's guard rail exists to prevent. Losing an editor for a deploy
window costs a delayed article; two writers on one collection costs a slug collision that
resolves to the wrong URL and an audit trail with a hole in it. **Order accordingly.**

---

## D-5 · The `phase` field is NOT restamped and the union is NOT widened

Phase 5's inherited plan called for widening the `phase` union at `permission.types.ts`, which
stops at 16.

**Decision: do neither.** The union stops at 16 because nothing is stamped 17 and nothing
should be. The field's own docstring says it names *"the phase that builds the surface behind
this permission — documentation only"*, written **in advance** so a later phase consumes a
decided policy rather than arguing one.

The precedent is unambiguous: all eleven `support.*` permissions were **built at Phase 17** and
are still stamped `phase: 5`, because 5 is the roadmap phase that was *forecast* to build the
legacy surface. `content.*`, `files.*` and `messaging.telegram.send` are stamped 5 for the same
reason.

Widening the union without restamping adds an unreachable value. Restamping to match reality
would mean restamping `support.*` too — rewriting a forecast into a history the field was never
meant to hold. Recorded as X-3 in the Phase 17 register.

---

## D-6 · The `admin` role VALUE survives in jovi-mall; only user-session access to it is retired

"Retire the admin role" cannot mean deleting the string, and the difference matters because
around twenty sites read it.

`requireAdminCaller` **synthesises** `req.auth.role = 'admin'` for every wi-admin call, and the
upload policy, file ownership stamping, `FileAttachService`, `FileReferenceService`,
`actorSourceOf`, the rate-limit caller class and `AuditLogger.log` all branch on it. `'admin'`
also stays in `UserRole` on the Mongoose user model, because that enum describes **what a
legacy row may hold** — `AUTHENTICATABLE_ROLES` is what may be signed in *as*, and the two are
deliberately different.

**What is retired is the ability of a platform user session to carry the role and reach a route
with it.** Two things, and only two: the public mounts are deleted, and `rotateRefreshToken`
gains the role filter the other four auth paths already had.

---

## D-7 · `admin_action_log` and `AuditLogger` SURVIVE; only the three middleware mounts go

**Decision: delete the three `adminActionLogMiddleware` mounts and nothing else.** The model,
the recorder, the context, the redactor, `AuditLogger`, the index migration and
`test:admin-action-log` all stay.

Deleting the collection would break a live path. `AuditLogger.log` routes any entry whose
`actor.role === 'admin'` into it, and `AdminAgencyService.deactivate` / `reactivate` hardcode
`actor: { userId, role: 'admin' }` — reached over `/api/internal/admin/agencies`, which is
exactly the surface that survives cutover.

**Corollary, and it is the argument for D-8:** after cutover every new row in that collection
is a **duplicate** of a wi-admin audit row for the same operation, written with a real
administrator identity and the same correlation id. Recorded as a follow-up (Phase 5 O-6)
rather than fixed here — it is a change to `AuditLogger`'s branching, not to the cutover.

---

## D-8 · wi-admin's `legacy-audit` module is deleted OUTRIGHT

**Decision: delete, do not preserve.** Six files, its mount, `legacy-endpoint-map.ts`, the
`audit.legacy_feed` feature flag and the `AUDIT_LEGACY_FEED_DISABLED` error code.

Two things forced it and one justified it:

- **Forced, mechanically.** `test-authz.ts` carried the tripwire
  `LEGACY_ENDPOINT_COUNT > 0 || !existsSync(src/modules/legacy-audit)`. Part C took the count to
  0 and the suite went red — deliberately, at exactly one assertion — and stayed red until the
  module was gone. "Delete this later" is the instruction nobody ever receives; this is what it
  looks like when it is enforced instead.
- **Forced, transitively.** The flag's `consumer` field named a file that no longer exists, and
  `feature-flag.catalog.ts`'s own header refuses to carry a flag nothing reads: *"dead config
  that reads as live policy — somebody turns it off, expecting something to change."* The error
  code was the same shape of promise: catalogued, published in `errors.md`, raisable by nothing.
- **Justified, by D-7's corollary.** The feed read `admin_action_log`. After cutover its rows
  duplicate wi-admin's own audit rows, so preserving the read would mean reporting the same
  events twice in two vocabularies — one of them without a catalogued action or a subject class.

**The historical rows stay in Mongo.** Nothing is destroyed; they are reachable through the
developer tools if they are ever wanted.

Eight assertions across seven suites had the deleted map as their subject. They were **restated,
not dropped** — as one strictly stronger unconditional check in `test-authz.ts` § 9: the map
file is gone, the module directory is gone, and no file under `src/` references either. That is
`PHASE-17-STATUS.md` § 7's rule applied in its harder direction: an assertion that goes
*vacuously green* for the success is as dead as one that goes red for it, and far harder to
notice — a red suite announces itself, seven suites quietly passing a check whose subject no
longer exists announce nothing.

---

## D-12 · Two families, one `content` mount

`articles` and `article_authors` are two `:id` namespaces — `/content/articles` and
`/content/authors` — under **one** route group at `/api/v1/content`.

This mirrors jovi-mall's two-router split without a second mount. Two mounts would have made
`content` the only family in this service occupying two route groups, and the README's group
count is a published number a reader navigates by. The paths key on the stable string `key`
(`getting-paid-on-whatsapp`), not an ObjectId, so the shared `objectId` validator is wrong for
them and a ported `ArticleKeySchema` is used instead.

---

## D-9 · The permanent delete requires the file id repeated in the body

**Decision: `DELETE /api/v1/files/:fileId/permanent` takes `{ "confirmFileId": "<the same id>" }`
and answers `400 FILE_DELETE_NOT_CONFIRMED` on a mismatch.**

The precedent is `POST /dev-tools/outbox/prune`, which makes the operator repeat the retention
**age**. The principle it encodes is not "confirm dangerous things" — it is *make the operator
restate the value that decides the blast radius*, because that is the value a slip corrupts. On
the prune it is the age; here the file id is the whole of what the operation acts on, so the id
is what gets restated.

### Why a body field rather than a query flag

A `?confirm=true` trains reflexive confirmation-typing: the operator learns one token that means
"yes" everywhere, and stops reading. `dev-tools.validator.ts` already argues this at
`DatabaseInspectQuerySchema`, which deliberately has **no** confirmation — requiring one in order
to *look* is what devalues the ones that matter. Repeating a value the operator must have read
off the screen cannot be typed from muscle memory.

### Where the comparison lives, and why not in Zod

In the controller. `validate` runs `params` and `body` as two independent schemas, so no
`superRefine` on either can see the other — the same split `dateRangeFields()` / `dateRangeRule()`
makes for the same reason. Shape in the validator, cross-field rule in the handler.

`files.delete` is already `destructive: true`, so it is excluded from `allInFamily()` and is tier
1 only. The confirmation is the second lock, not the first.

---

## D-10 · The orphan listing withholds the storage key

**Decision: `GET /api/v1/files/orphans` returns `id`, `originalName`, `mimeType`, `size`,
`ownerType` and `createdAt`. It does not return `key`** — nor `url`, `provider`, `checksum`,
`ownerId`, `orphanedAt`, `deletedAt` or `purgeAt`, all of which jovi-mall's internal route does
return.

Two requirements pull in opposite directions and both are real:

- **The operator must be able to judge a file before destroying it.** A listing of bare ids is
  safe and useless — nobody can decide anything from it, so the delete becomes a coin toss. What
  makes the judgement possible is the **filename**, plus the type, the size and whose it was.
- **The storage key is an internal locator.** It is the path inside the bucket and it names the
  owner's tree. It adds nothing to the judgement above and everything to a leak.

So the six fields are chosen as exactly the ones that inform the decision, and the rest are
absent rather than nulled.

### Where the projection lives

`toOrphanFile` in `modules/files/gateways/file.gateway.ts` — the one place jovi-mall's raw row
enters this service. In the gateway rather than the controller so a route added later cannot
reach the key by forgetting to project, the same argument that puts the audit wrapper there.
Every field is named explicitly; a spread would publish whatever jovi-mall's `File` gains next.

It is exported and pure so `test:files` § 2 can assert the leak **directly** — build it from a
row carrying every field jovi-mall's `File` entity has, serialise the result, assert none of them
survives. A projection asserted by source scan proves the code *says* the right thing rather than
that it *does* it; `test:public-catalog` in jovi-mall proves its DTOs the same way.

### jovi-mall was not changed to match

Its internal route still answers the whole `File`. The two shapes are deliberately different: the
raw row is what the owning service holds, and the projection is what an administrator is shown.
Narrowing it there would make wi-admin's contract a constraint on jovi-mall's own surface for no
gain, and the route has exactly one caller.

---

## Correction · `files.orphans.read` is tiers 1 and 2, not tier 1 alone

Four comments in this repository described the orphan listing as **"tier-1-only"**. The grant
table has always disagreed: `allInFamily('files')` is in the Admin block, no flag keeps a read
out of a family sweep, and `files.orphans.read` carries none. Evaluated: tiers **1 and 2**.

**The documentation was corrected, not the grant**, for three reasons:

1. The claim was a *forecast* written when the permission was catalogued at Phase 17, before it
   was routed anywhere — the same class of drift the `phase` field's own docstring warns about,
   and the same one Phase 5 C-2 found in the `†` counts.
2. The mechanism is already right. `destructive: true` on `files.delete` is what makes the
   **delete** tier-1-only, structurally rather than by a list somebody typed. An Admin who can
   see an orphan and report it, while only a Developer can destroy it, is the ordinary shape of
   every other destructive name here.
3. Narrowing the read would need a by-name grant that nothing asked for, and it would leave
   `allInFamily('files')` in place doing something different from what it says.

Pinned by `test:files` § 5, which asserts both the outcome and the mechanism — the outcome alone
is reachable by accident and would drift the first time a `files.*` name is added.

Note the boot assertion is the real enforcement of the *delete* half: `assertGrantTableValid()`
refuses to start if a destructive permission reaches tier 2 at all. Verified by mutation — the
grant cannot be added even to try it.

---

## D-11 · `broadcast` becomes `messaging`, and `broadcast.send` becomes `messaging.telegram.send`

**Decision: rename the family and the permission as part of the port, not afterwards.**
Landed with Phase 5 Part C.

### The old name described a capability that has never existed

`broadcast.send` was catalogued at Phase 3 and summarised *"Send a broadcast message to
platform users"*. Read against jovi-mall's source before deciding, the endpoint behind it
(`POST /api/webhooks/telegram/send`) is:

| The name implied | What is there |
|---|---|
| An audience | One recipient — `userId` **or** `chatId` |
| Segmentation, scheduling | Neither exists in any form |
| A delivery record | None. `TelegramBotService.sendMessage` returns a **boolean** |
| "platform users" | Only accounts that linked Telegram through the bot's `/connect` |

A permission name is the sentence an operator reads when deciding whether a tier should hold
it. This one overstated its blast radius by roughly the size of the platform, which gets the
tier discussion had about the wrong capability — a *broadcast* is obviously not Support's,
and so is a single message, but for different reasons and with a different answer if a
second channel is ever added.

### Why the channel is in the permission name

`messaging.telegram.send`, not `messaging.send`. A second channel would be a second
capability with its own connection model and its own failure modes — WhatsApp connections
are a different subsystem in jovi-mall — not a parameter to this one. Naming the channel now
means adding one later is an additive catalog entry rather than a silent widening of a
permission somebody already holds.

### What it touched

Four source files plus documentation, and the union and the array must stay in step:
`permission.types.ts` (the `PermissionFamily` union **and** `PERMISSION_FAMILIES`),
`permission.catalog.ts` (the entry, its family, and the summary), `tier-grants.ts`
(`allInFamily('broadcast')` → `allInFamily('messaging')`), and the audit catalog's new
action, which reuses the permission name by house rule. Catalog size is unchanged at **113**;
no tier's grant count moves.

Pinned by `test:messaging` § 3, which asserts `broadcast` is gone from all four and that
`familyOf('messaging.telegram.send')` resolves to `messaging` — the audit feed's family
filter rides on that split.

---

## C-6 · What moving the send off `/api/webhooks/*` actually changed

**Recorded because the change is invisible in a diff, and because the plan predicted it
backwards in both halves.** Both statements below were verified against jovi-mall's source.

### Maintenance: the send became MORE available, not less

The plan said the port would make the send maintenance-blocked. The opposite is true.

`/api/internal/admin` is the **first entry** in jovi-mall's `ALWAYS_EXEMPT`
(`modules/system/domain/maintenance-mode.ts`) — reachable in every mode, unconditionally,
because blocking it locks an operator out of the door they turn maintenance *off* with.

`/api/webhooks` was exempt too, but **conditionally**: `isExempt` consults
`state.blockWebhooks`, which an operator sets per window when the window exists because of a
migration the webhook writes would land in.

So the operator **loses a per-window off switch they had**, and this service has no
maintenance mode of its own to compensate. Accepted rather than worked around: carving one
path out of `ALWAYS_EXEMPT` would be a second, weaker rule over the same prefix, and the
prefix-wide exemption is what makes the lockout argument hold.

### Rate limiting: jovi-mall's limiter never applied, and never will

The plan said the port would make the send rate-limited on the jovi-mall side. It is exempt
there.

wi-admin presents `INTERNAL_ADMIN_SERVICE_TOKEN`, so jovi-mall's `resolveCallerClass`
returns `internal_service`, which is `'exempt'` in both `GLOBAL_POLICY` and
`IDENTITY_POLICY`. Its identity layer never runs at all — it is mounted at the tail of
`requireAuth`, and this path carries no session.

What is new and intended is **this service's own identity-scoped limiter** on
`POST /api/v1/messaging/telegram`. The honest one-line summary, and the one that belongs in
the commit message:

> The operator is now rate-limited by wi-admin, and the send is no longer blockable by a
> jovi-mall maintenance window.

---

## O-2 · The audit row records the recipient **and** the full message body

**Decision by the owner, 2026-08-20: both.** The plan graded this SHAPING and flagged it for
the owner, because an operator can paste anything into the body and the row is immutable.

Every other payload on this service records the **fields that changed** on a record that
still exists — the row is a pointer and the record is the evidence. There is no record here:
jovi-mall's `sendMessage` returns a boolean and keeps nothing anywhere. So this row *is* the
evidence, and a row saying only "an administrator messaged this customer" cannot answer the
one question a complaint about a send ever asks.

What bounds the risk is the machinery every payload already goes through — `redact()`
replaces credential-shaped fields at any depth, and the size cap replaces an oversized value
with a summary. Nothing was relaxed for this.

⚠ **One dependency is load-bearing and silent:** `message` must not become a redacted field
name. Adding `'*.message'` to `REDACTED_PATHS` would reverse this decision with no error
anywhere. `test:messaging` § 2 asserts the body through the **real** `sanitiseState`, not a
shape check, and that mutation turns it red.

### `target_type: 'user'`, in both addressing forms

`user` when the operator named a `userId` — that is the target id — and `user` with a `null`
id and a `telegram:<chat>` label when they named a raw chat. A Telegram chat id addresses a
*person*; only the searchable column differs between the two forms.

`none` was the alternative and is worse for the reason it was already rejected at
`files.delete`: it moves the only handle anybody has on the recipient into the payload and
leaves the column an operator searches empty.

The classification consequence is deliberate. `user` is `platform_actor`, so **Support can
read these rows** while holding no permission to send (tiers 1-2 only). Same trade-off as the
file delete: seeing that an administrator messaged a customer whose ticket you are working is
the point of the class.

---

## Correction · this service's wire schema is deliberately narrower than jovi-mall's

`POST /api/v1/messaging/telegram` requires **exactly one** of `userId` / `chatId`.
jovi-mall's `SendNotificationSchema` requires **at least** one.

That is not drift, and jovi-mall was not changed to match. Its
`TelegramNotificationService.send` prefers `params.chatId` when it is present and never
resolves the `userId`, so a body naming both is accepted there, the message goes to the chat,
the response says `sent: true`, and the id that was supposed to identify the recipient is
never read — no error, no log line, nothing in the response that differs from a correct send.

The refusal belongs on this side because this is the side an operator is talking to, and it
should arrive **before** the hop — the same shape and the same reason as the file validators'
24-hour orphan floor, which jovi-mall also enforces independently. jovi-mall stays permissive
because it is the second lock, not the first, and narrowing it would change the behaviour of a
shape this service has already narrowed.

Pinned by `test:messaging` § 1.

---

## `LEGACY_ENDPOINT_COUNT = 0` — the deliberate red, and how it was cleared

With the telegram row gone the legacy map was **empty**, which armed the cutover tripwire at
`test-authz.ts:821`: with the count at 0 it demanded `src/modules/legacy-audit/` be gone.

**`test:authz` was red on purpose after Part C**, at exactly one assertion out of 147 — and it
was not papered over. **Part D cleared it by doing what it asked**: the module, the map, the
flag and the error code are deleted (D-8), and the assertion is now unconditional, because the
`COUNT > 0 ||` escape hatch is precisely what a resurrected map could re-arm.

`test:authz` is green again at **147/147**, the same number it was before — eight assertions
retired, eight added, which is a coincidence of arithmetic rather than a design, and is noted
so nobody reads an unchanged count as an unchanged suite.

---

## What this ADR does not cover

Two things were decided elsewhere and are recorded there, so a reader looking for them here is
not looking in the wrong place by mistake:

- **Whether `AuditLogger` should stop writing duplicate `admin_action_log` rows** after cutover
  (D-7's corollary). Open as Phase 5 **O-6** — recorded, not done.
- **The Phase 4 exit criterion that is still unmet**: two live-suite CI jobs are authored and
  have never run, in any of the three repositories. Phase 5 added a third (`verify:content`) and
  inherits the same unproven pipeline. Not this phase's job, and not fixed by it.
