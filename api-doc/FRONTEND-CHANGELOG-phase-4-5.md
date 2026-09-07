# Admin dashboard — what Phase 4 and Phase 5 changed

Your slice of Phases **4** (Per-service hardening) and **5** (Legacy close-out) of
[`PRODUCTION-READINESS/10-IMPLEMENTATION-PLAN.md`](../../PRODUCTION-READINESS/10-IMPLEMENTATION-PLAN.md).

- **Written:** 2026-08-21 · **Phase 4:** 2026-08-19 → 08-20 · **Phase 5:** 2026-08-20
- **Design records:** [`ADR-017-PHASE-17-CLOSEOUT.md`](../docs/ADR-017-PHASE-17-CLOSEOUT.md) ·
  [`ADR-018-DASHBOARD-BACKEND-REQUESTS.md`](../docs/ADR-018-DASHBOARD-BACKEND-REQUESTS.md)
- **Previous instalment:** [FRONTEND-CHANGELOG-phase-2-3.md](./FRONTEND-CHANGELOG-phase-2-3.md)
- **Context, not required:** [`jovi-mall/api-doc/FRONTEND-CHANGELOG-phase-4-5.md`](../../jovi-mall/api-doc/FRONTEND-CHANGELOG-phase-4-5.md)

> **This is the biggest instalment for you by a wide margin.** Phase 4 fixed two live defects
> that were silently producing wrong outcomes on screens you already ship, and Phase 5 added
> **seventeen endpoints in three modules** and deleted a route, six permissions' worth of dead
> promises and one whole family.

---

## The change list, ranked

### Phase 4 — fixes to surfaces you already ship

| # | Change | Your work |
|---|---|---|
| 1 | 🔴 **Every note this dashboard ever created was filed PUBLIC** — the customer saw it | **Design** — the switch works now; the historical rows do not change |
| 2 | 🔴 **An approval request past `expires_at` was approvable** | None — it now 409s, which your error map already covers |
| 3 | 🔴 `DiscrepancyDto.resolvedByUserId` → **`resolvedBy: ActorStampDto \| null`** | **Required** — one field rename plus a name to render |
| 4 | The three delegated order **writes** now answer the same `OrderDetailDto` as the read | **Small — and keep your `data`-discarding mitigation** |
| 5 | The ticket reference type-ahead **actually filters now** | None — it was answering the unfiltered first page |
| 6 | `DELETE /support/tickets/attachments/:id` is **tier-scoped** | Small — out-of-scope deletes now 404 |
| 7 | Note content is capped at **300** characters here, not 2 000 | Small — your form's counter |
| 8 | `avatarUrl` is documented as **reserved and permanently null** | Small — render initials, never a loading state |
| 9 | `docs/api/support.md` now exists — 19 routes | None |
| 10 | `accuracyMetres` closed as **out of scope** | None — stop waiting for it |

### Phase 5 — the legacy close-out

| # | Change | Your work |
|---|---|---|
| 11 | **NEW: `/api/v1/content`** — 14 routes. The blog editor lives here now | **Build** — a whole module |
| 12 | **NEW: `GET /api/v1/files/orphans`** and **`DELETE /api/v1/files/:fileId/permanent`** | **Build** — a destructive flow with a confirmation |
| 13 | **NEW: `POST /api/v1/messaging/telegram`**; the family renamed `broadcast` → **`messaging`** | **Build** — and read what it is *not* |
| 14 | **DELETED: `GET /audit/legacy`** and the `AUDIT_LEGACY_FEED_DISABLED` code | **Required** — remove the call |
| 15 | **DELETED: `customers.read` / `customers.suspend`** and the whole `customers` family | **Required** if you gate any UI on them |
| 16 | Counts moved: **225 endpoints across 23 route groups**, **111** permissions | Reference |

---

# Part I · Phase 4

## 1 · 🔴 Every note this dashboard created was filed public

**This is the most consequential thing in either phase, and it is a data-disclosure defect that
ran for the life of the module.**

jovi-mall's note field is `visibility: 'public' | 'private'`, defaulting to **`public`**. This
service sent **`isPublic: boolean`**. jovi-mall's receiving schema is not `.strict()`, so the key
was **stripped in transit** and the default applied — the call answered `201`, no warning, and
**every note ever created here was visible to the ticket's customer, vendor, agency or agent.**

That is the exact inversion of what the schema's own docstring argues for: the default must fail
towards *"the customer does not see it"*.

### What changed

The translation now happens at the gateway — the transport boundary is the only layer that knows
what the other service calls a thing. **The wire name you send stays `isPublic`**, because a
boolean is the right shape for the one choice the surface offers:

```jsonc
POST /api/v1/support/tickets/:ticketId/notes
{ "content": "Chargeback risk — see finance thread.", "isPublic": false }
```

| Field | Rules |
|---|---|
| `content` | **1–300** characters (was 2 000 here — see § 7) |
| `isPublic` | **defaults to `false`** — the safe default, and now actually applied |

### What you should do

- **Make `isPublic` explicit and visible in the composer.** It defaults to private, but a note
  that reaches a customer is not undoable and the operator should be choosing, not inheriting.
- **Say which one it is on every rendered note.** An operator reading their colleague's note has
  no way to tell today.
- **Historical rows were not backfilled.** This platform is pre-production and deliberately writes
  no data migrations, so notes created before 2026-08-20 are still stored `PUBLIC` and are still
  being shown to the ticket's counterparty. If that matters for a specific ticket, it is a manual
  correction, not a deploy.

> ⚠ **Carry this past the fix.** Both sides were individually correct and the *seam* was not, and
> nothing on either side could have caught it: this service's tests asserted its own schema,
> jovi-mall's asserted its own, and the integration is a fire-and-forget HTTP call to a
> non-strict validator. **Every other delegated write here has the same exposure.** The general
> fix is jovi-mall making its internal-admin schemas `.strict()`, which is a two-repo change and
> has not been done.

---

## 2 · 🔴 An approval request past its expiry was still approvable

`assertDecidable` branched on `row.status` alone. A request past `expires_at` that the sweep had
not yet stamped was still `pending`, and **was approved normally** — a live run answered `202`,
not `409`. Enforcement rested entirely on `expireOverdue` having got there first, and that sweep
is throttled and runs only on a read path, so the window was operational rather than theoretical.

**Now:** the clock is compared directly, and the single row a decision is about is expired
**unthrottled** on load — so it is stamped `expired`, appears as expired in the queue, and writes
an `approvals.expired` audit row, rather than being merely refused and left sitting at `pending`.

**On the wire:** `409 AUTHZ_APPROVAL_EXPIRED`, which your error map already handles. Nothing to
build — but if your UI ever showed a stale request as actionable and the click succeeded, that is
why.

---

## 3 · 🔴 `DiscrepancyDto.resolvedByUserId` is now `resolvedBy`

**One breaking wire change, and it is in COD.** `CodDiscrepancyService.resolve` wrote
`resolved_by_user_id` alone, and `cod_discrepancies` carried no actor stamp at all. Resolving a
discrepancy is **admin-only** — no agency or agent path exists — so since the wi-admin split that
column has held a wi-admin id with nothing beside it saying so, rendered next to a remittance on
the same screen that *does* show a name.

```diff
- "resolvedByUserId": "665f0c…"
+ "resolvedBy": { "id": "665f0c…", "source": "wi-admin", "name": "Ada Nkemelu" }
```

It is now the same `ActorStampDto` shape `RemittanceDto.resolvedBy` already used.

**Client migration:** read `resolvedBy?.id` where you read `resolvedByUserId`, and render `name`.

| Field | Note |
|---|---|
| `resolvedBy` | **`null` while still open.** A stamp rendered without checking reads as "resolved by nobody", which is a claim rather than an absence |
| `resolvedBy.source` | Which identity space the id belongs to. **A `wi-admin` id resolves in neither database's user collection** — which is why the name is a snapshot rather than a lookup |

Detail: [`docs/api/cod.md`](./api/cod.md).

**Not changed for symmetry:** `agent-deposit` keeps its additive-optional-fields shape. It already
writes source and name; reshaping a money path to look like its neighbour buys a reader nothing.

---

## 4 · The three delegated order writes now answer the projected DTO — keep your mitigation

`POST /orders/:orderId/cancel`, `POST /orders/:orderId/dispute/resolve` and the `order` half of
`POST /orders/:orderId/dispatch` used to answer with **jovi-mall's entire Mongoose order
document**, forwarded untouched: snake_case, and carrying `delivery_address.coordinates`,
`raw_input` (the text the customer typed before picking a geocoding result), every `items[]` entry
whole, plus `payment_intent_id` and `price_breakdown`.

**The corresponding read deliberately withholds exactly those fields.** The same data was withheld
on one verb and returned on another.

**Now:** all three re-read through the same projection as `GET /orders/:orderId` and answer
`data: OrderDetailDto` — camelCase, coordinates and `raw_input` excluded. `dispatch` keeps its own
`{ shipmentsAssigned, order }` envelope; only the `order` half moved. **`shipmentsAssigned: 0` is
still a no-op, not an error** — the usual cause is the vendor's auto-redirect dispatching a moment
earlier.

> ### ⚠ Do NOT clean up `orders.service.ts`'s `data`-discarding
>
> Your service layer discards `data` entirely on all three of these, and `OrderDetail.test.tsx`
> stubs a cancel response containing real coordinates and asserts they never reach the DOM.
>
> **That should survive this fix, as defence in depth against the next delegated write.** It is
> structural rather than disciplinary, which makes it better than a rule somebody has to remember
> — and § 1 above is exactly what a delegated write looks like when nobody remembers.

One edge case, stated so it is not read as a bug: if the re-read comes back empty, the response is
`data: null` rather than a 404. By that point the mutation has committed in jovi-mall and the
audit row is stamped; answering `404 Order not found` would report the opposite of what happened
and invite a retry. `orders` has no delete path in either service, so the branch is unreachable in
practice.

---

## 5 · The ticket-creation type-ahead actually filters now

`GET /support/tickets/reference/orders` and `/reference/products` take `?search=`. It was
**forwarded to jovi-mall under the wrong name** — jovi-mall reads `q` — so the parameter was
ignored and the lookup answered the **unfiltered first page** while looking as though it had
searched.

Nothing to change on your side. Your existing `?search=` calls now do what they said. Expect the
creation form's pickers to start behaving.

Reminder about the shape: these are type-ahead lookups. **Page size is jovi-mall's, capped at 50,
and its pagination metadata is not forwarded** — `data` is the array alone. Page through the real
`/orders` surface for a directory.

---

## 6 · The attachment delete is tier-scoped now

`DELETE /support/tickets/attachments/:attachmentId` ran **neither** of the two checks every
neighbouring write runs. **Any holder of `support.tickets.attachments.write` could delete any
attachment on any ticket** — including one belonging to a ticket their tier cannot see, and one
held by an administrator whose work they may not act on.

It now runs the same two, in the same order: the tier scope (404 if out of scope) then the
assignment lock (403).

**What you will see:** an attachment on a ticket outside your tier now answers **404
`TICKET_NOT_FOUND`** — with the **identical code and identical message** as an attachment id that
does not exist. That is deliberate: a Support-tier administrator holding an attachment id must not
be able to tell *"no such attachment"* from *"exists, on a ticket you may not see"* by reading
`error.code`. Do not try to distinguish them in your UI; you cannot, by construction.

---

## 7 · Note content is 300 characters, not 2 000

This service's validator accepted **2 000** where jovi-mall caps at **300**, so a 301–2 000
character note passed here and came back as a `PLATFORM_OPERATION_REJECTED` naming a limit no
wi-admin document mentioned. Now 300, and `400 VALIDATION_ERROR` locally.

Update your composer's counter and its maximum. *A boundary that accepts what the next hop refuses
is not validating, it is deferring.*

---

## 8 · `avatarUrl` is reserved and permanently null — build for that

`AdminSnapshotDto.avatarUrl` is wired end to end and is **always `null`**. `admin_accounts` stores
no avatar, and **this service has no write-side file surface at all** — its `files` module is two
GETs delegating to jovi-mall, and there is no `multer` anywhere. An administrator avatar would be
wi-admin's *first* upload surface, which makes it a feature rather than a field.

The owner's decision (D-15, 2026-08-20) was: **keep the field, build nothing, document it as
reserved.**

**So: render the initials fallback from `name` and do not branch on this field.** Specifically:

- do not build a loading state for it;
- do not treat `null` as "picture failed to load" — an empty string was rejected precisely because
  a client cannot tell that from "no picture";
- do not remove it from your types. It is a field of jovi-mall's role-facing `PublicAdminSnapshot`
  too — the block a customer, vendor, agency or agent is shown on a ticket — so it is not going
  away, and the day an avatar exists nothing about this shape changes.

The same block is what `assigned_admin` and `created_by_admin` carry on the **role-facing** ticket
reads, where it changed from `{ user_id, role, name, avatar }` to
`{ name, job_title, department, avatar_url }`. Those docs were stale and are now corrected; if you
render a preview of what a vendor sees, that is the shape.

---

## 9 · `docs/api/support.md` exists now — 19 routes

The newest module was the only one without a contract page, and by this repository's own rule an
undocumented contract is not a promised one. [`docs/api/support.md`](./api/support.md) covers every
route, its permission, its transport, its audit action, its body and its error codes — taken from
the router and the source, not from docstrings.

Three things in it are not obvious from the routes and are worth reading before you build against
them:

- **`assigned_admin_id` is a LOCK, not an assignment.** The single most misreadable thing in the
  module.
- **`avatarUrl` is reserved and always null** (§ 8).
- **The attachment delete is keyed on the attachment** — mirroring jovi-mall's route shape — and is
  scoped by a *second* read (§ 6). Do not read that lookup as redundant.

Two stale claims were corrected while writing it: `permissions.md` still carried **†**
(*"catalogued policy with no endpoint built yet"*) on **all eleven** `support.tickets.*`
permissions and on `support.reference.read`, and `docs/api/README.md` undercounted the API by a
whole module.

---

## 10 · `accuracyMetres` — closed as out of scope

The dashboard asked for GPS accuracy on the tracking record. It is **closed**, with the reason
published rather than left on a register:

> The field would have to originate in the **Flutter agent application**, travel through
> geo-tracker's `location_update` frame and its location domain, reach the **checkpoint trail** —
> because an administrator reads `last_known_tracking_state`, never a live position, and ADR-009
> D-2 keeps it that way — and only then reach wi-admin. **Four parts across two repositories and a
> mobile release. None of them exists.**

It was requested by a dashboard that would have rendered a number nothing produces, and it was
already deliberately not shipped as a permanent `null`, so closing it changes nothing on the wire.
**Stop waiting for it.** ADR-018's open list is down to one item: the live position, which is a
scoped piece of future work (6.I), not a pending field.

---

# Part II · Phase 5 — the legacy close-out

## 11 · NEW — `/api/v1/content`: the blog editor is yours now

**14 routes, and this is a module to build.** Full contract:
[`docs/api/content.md`](./api/content.md).

Ownership **moved** rather than being delegated: this service writes `articles` and
`article_authors` in the platform database directly. jovi-mall's `/api/admin/articles` and
`/api/admin/article-authors` are **deleted**.

| Method | Path | Permission |
|---|---|---|
| GET · POST | `/content/articles` | `content.articles.read` · `content.articles.write` |
| GET | `/content/articles/:articleKey` | `content.articles.read` |
| GET | `/content/articles/:articleKey/preview` | `content.articles.read` |
| PATCH | `/content/articles/:articleKey` | `content.articles.write` |
| POST | `/content/articles/:articleKey/{publish,unpublish,archive}` | **`content.articles.publish`** |
| DELETE | `/content/articles/:articleKey` | `content.articles.delete` |
| GET · POST | `/content/authors` | `content.authors.read` · `content.authors.write` |
| GET · PATCH | `/content/authors/:authorKey` | `content.authors.read` · `content.authors.write` |
| DELETE | `/content/authors/:authorKey` | `content.authors.delete` |

### Five things that will otherwise surprise you

1. **`delete` is a SOFT delete, and it is refused on a published article.**
   `content.articles.delete` throws `BLOG_ARTICLE_DELETE_NOT_ALLOWED` (409) when `published_at`
   is set; otherwise it stamps `deletedAt`. `content.authors.delete` additionally refuses while
   any article credits the byline. The permission is flagged `destructive: true` — which is what
   keeps it out of family grants — but the catalogued summary used to say *"permanently delete"*
   and was wrong. **Do not build an "are you sure, this is permanent" dialog for something that is
   not.**
2. **Publishing is a separate permission from writing, and Support does not have it.** Tier 3 was
   granted `content.articles.read/write` and `content.authors.read/write` **by name** —
   deliberately not `allInFamily('content')`, because that would have swept in
   `content.articles.publish`. A Support administrator **can edit a published article** (a typo fix
   is the point of the grant) and **cannot publish or unpublish one**. Your UI must render the
   publish controls off permission, not off tier.
3. **Slug history is load-bearing and derived on write.** `buildSlugKeys` keeps retired slugs so a
   renamed article keeps resolving; jovi-mall's public read answers `BLOG_ARTICLE_MOVED` carrying
   the current slug. **Never send `slug_keys` or `word_count` from the editor** — both are derived,
   as is the `content_updated_at` fingerprint.
4. **The block union is a nine-type discriminated union and this service is now its authority.**
   The marketing site switches over it exhaustively, so **an unknown type is a compile error there
   rather than a blank space on a live page** — which makes the ordering rule real: **the reader
   ships first.** When a block type is added here, hold the editor grant until the marketing site's
   release is out. There is no shared package; the two repositories mirror a 17-document fixture
   list and both go red when they disagree.
5. **The schema and indexes stay in jovi-mall.** You own the writes to a collection whose shape and
   indexes are declared in another repository — including the unique multikey index on `slug_keys`
   that a duplicate write will violate. That is a real split, stated so it is not a surprise.

Ten `BLOG_*` error codes were added; they render non-generic messages.

---

## 12 · NEW — the orphan file listing and the unrecoverable delete

Two routes on the existing `files` module. Full contract: [`docs/api/files.md`](./api/files.md).

### `GET /api/v1/files/orphans`

Uploads no live record refers to. **Permission `files.orphans.read` — tiers 1 and 2.**

> ⚠ **It is not tier-1-only**, whatever four comments in the source and an earlier ADR line said.
> The grant table has disagreed with them since the permission was catalogued. The **documents**
> were corrected, not the grant: `destructive: true` on `files.delete` is what makes the *delete*
> tier-1-only, structurally, and an Admin who can see an orphan while only a Developer can destroy
> it is the ordinary shape of every other destructive name.

| Query | Rules |
|---|---|
| `olderThan` | ISO-8601 instant. **Must be at least 24 h in the past.** Absent means seven days ago |

**The 24-hour floor is refused, not clamped.** A file is uploaded and attached seconds later; a
window reaching into the last minute would list files about to be referenced and feed them to an
unrecoverable delete. A clamp would answer 200 with rows for a window the caller did not ask for.

**Render `meta.olderThan`, not what you sent** — it is the cutoff jovi-mall actually applied.

**The row deliberately withholds the storage `key`** — and `url`, `provider`, `checksum` and
`ownerId` with it. Six fields: `id`, `originalName`, `mimeType`, `size`, `ownerType`, `createdAt`.
The operator must be able to judge a file before destroying it, and the **filename** is what makes
that judgement possible; the storage key is an internal locator that adds nothing to the judgement
and everything to a leak. `originalName` and `ownerType` are `null` rather than absent when
jovi-mall has none.

### `DELETE /api/v1/files/:fileId/permanent`

**Permission `files.delete` — tier 1 only.** Audited.

```jsonc
{ "confirmFileId": "6612a4f0c1a2b3d4e5f60718" }   // must equal the :fileId in the path, byte for byte
```

`400 FILE_DELETE_NOT_CONFIRMED` on a mismatch or an absence. This is the `outbox.prune` pattern:
**make the operator restate the value that decides the blast radius.** Build the confirmation as a
typed-in id, not a checkbox — a checkbox restates nothing.

---

## 13 · NEW — `POST /api/v1/messaging/telegram`, and the family was renamed

The last legacy admin endpoint anywhere. Full contract: [`docs/api/messaging.md`](./api/messaging.md).

**`broadcast` → `messaging`.** The permission is `messaging.telegram.send` (tiers 1 and 2). If your
UI gates anything on `broadcast.send`, it must move.

> ### ⚠ Read what this is *not* before you design a screen for it
>
> The old name implied four things that do not exist:
>
> | Implied | Reality |
> |---|---|
> | An audience | **One recipient.** No segmentation, no list, no "all vendors" |
> | Scheduling | None. The call sends, or raises |
> | A delivery record | None — **the audit row is the only record a send ever leaves** |
> | "platform users" | Only accounts that linked Telegram through the bot's `/connect` flow |
>
> If you need to reach many people, **this is not the endpoint and there is no endpoint.**
> Do not build a composer that looks like one.

**Body:** exactly one of `userId` or `chatId`, plus `message`.

> This service narrows to *exactly one* deliberately. jovi-mall refines on *at least one* and then
> prefers `chatId`, never resolving the `userId` — so a body naming both is accepted there, the
> message goes to the chat, the response says `sent: true`, and the id that was supposed to
> identify the recipient is never read. jovi-mall was **not** narrowed (it is the second lock);
> this side simply refuses the ambiguous shape.

**Two distinct failures, and they must be shown differently.** jovi-mall discriminates them
**structurally** — it echoes the resolved `chatId` on a delivery failure and cannot echo one it
never resolved — rather than by matching on the wording of a log line. This service passes both
through untranslated, so what you receive is the ordinary delegation envelope with the platform
code in `details`:

| Status | Code | `details.platformCode` | Meaning |
|---|---|---|---|
| 400 | `VALIDATION_ERROR` | — | No recipient, **both** recipients, a malformed `userId`, or a message that is empty or over **4096** characters |
| **404** | `PLATFORM_OPERATION_REJECTED` | `MESSAGING_CONNECTION_NOT_FOUND` | **There is nobody to send to.** Actionable; retrying will not help |
| **502** | `SERVICE_DEPENDENCY_UNAVAILABLE` | `MESSAGING_DELIVERY_FAILED` | The chat resolved and Telegram refused it. **Try again** |
| 503 | `SERVICE_DEPENDENCY_UNAVAILABLE` | — | `JOVI_MALL_BASE_URL` is unset |

⚠ **Branch on `details.platformCode`, not on the status alone** — the 502 and the 503 share a
code, and only the platform code separates "Telegram refused this message" from "the platform is
unreachable". The legacy handler flattened everything into `INTERNAL_SERVER_ERROR` at 400, which
is why nobody could tell them apart.

A refused send is still stamped on the audit trail as a refused send, rather than being absent
from it.

**The audit row carries the recipient AND the full message body** (owner decision). An
un-undoable send's only useful question is *what was said to whom*. Warn the operator in the
composer that the text is recorded.

**Two operational facts, invisible in a diff and worth knowing:** the send is now rate-limited by
**this service's** identity-scoped limiter (it was exempt where it sat before), and it is **no
longer blockable by a jovi-mall maintenance window** — `/api/internal/admin` is unconditionally
exempt, whereas the old `/api/webhooks` exemption could be revoked per window by an operator. This
service has no maintenance mode of its own to compensate.

---

## 14 · 🔴 DELETED — `GET /audit/legacy`

The interim feed of administrative actions still performed on jovi-mall. **Remove the call.** It
answers 404 like any unknown path, and the `AUDIT_LEGACY_FEED_DISABLED` code that used to mean
*"the feed is switched off by its flag"* is deleted too, along with the flag.

Your log screen reads **`GET /audit`**, which is the compliance record and always was. The legacy
feed was never that: every page it returned carried `"legacy": true` and
`"retiresAtCutover": true` precisely so a dashboard could not render it as the audit trail by
omission.

**The history went nowhere.** `admin_action_log` survives in Mongo and is still written — what was
deleted is *this service's read* of it. After cutover every new row in it duplicates a wi-admin
audit row for the same operation, with a real administrator identity and the same correlation id,
so the feed would have reported the same events twice in two vocabularies, one of them worse. The
historical rows are reachable through the developer tools if ever needed.

Detail: [`docs/api/audit.md`](./api/audit.md).

---

## 15 · 🔴 DELETED — `customers.read`, `customers.suspend`, and the `customers` family

Both permissions were **granted** — tier 2 via a family sweep, tier 3 by name — while backing **no
route**. That is worse than an unbuilt permission with a written reason: it is a capability the
tier matrix claims to confer and nothing delivers. The family union went with them, because a
family with no permissions cannot exist and re-declaring it is how a real customers surface would
announce itself.

**No capability is lost.** The `users` module is role-agnostic and already covers customers:

| You wanted | Call |
|---|---|
| The customer directory | `GET /users?role=customer` |
| One customer's profile | `GET /users/:userId` — composes the customer role-profile |
| Suspend / restore | `POST /users/:userId/suspend` · `/restore` |
| Their order history | `GET /orders?customerId=…` |

**If your UI gates a menu item or a route on `customers.read`, it must move to `users.read`** — the
permission no longer exists and the check will simply never pass.

---

## 16 · The numbers, for reference

Every one of these was evaluated from a live `createApp()` boot or from the catalog, not reasoned:

| | Before Phase 5 | After |
|---|---|---|
| Endpoints | 209 | **225** |
| Route groups | 21 | **23** (`content`, `messaging` added) |
| Catalogued permissions | 113 | **111** |
| Tier 1 (Developer) | 113 | **111** |
| Tier 2 (Admin) | 96 | **94** |
| Tier 3 (Support) | 24 | **27** |
| `LEGACY_ENDPOINT_COUNT` | 17 | **0** — the constant and its map are deleted |
| Permissions with no endpoint (`†`) | 16 | **4** |

**The four remaining `†` permissions each have a published reason** in
[`docs/api/permissions.md` § *The four `†` permissions*](./api/permissions.md):
`users.sessions.revoke`, `users.roles.manage`, `notifications.manage`,
`developer_tools.webhooks.redeliver`. That section exists so the phase's exit criterion is
checkable from the contract a reader consults rather than from a status page.

> `users.sessions.revoke` is unbuilt **because there is no session store** — and Phase 4's 90-day
> session cap was deliberately built on a token claim rather than a store, precisely so that
> rationale would not go stale. Do not expect a "sign this administrator out everywhere" button.

---

## 17 · One more thing you inherit: the platform's 90-day session cap

jovi-mall now bounds a sign-in absolutely at **90 days** with a new terminal `401
AUTH_SESSION_CAP_REACHED`. **This service's own administrator sessions are separate** and were not
changed by it — but two things reach you:

- Anything you render **about** a platform user's session lifetime is now bounded.
- If any tooling here presents a jovi-mall user token (scripts, a dev-tools probe), it can now be
  refused for that reason and **must not be retried or refreshed** — both fail identically.

Detail: [`jovi-mall/api-doc/FRONTEND-CHANGELOG-phase-4-5.md` § 2](../../jovi-mall/api-doc/FRONTEND-CHANGELOG-phase-4-5.md).

---

## 18 · What did NOT change

- **The response envelope, the nine-value error taxonomy, pagination, sorting, filtering, CSRF,
  MFA and the rate-limit shape.** All exactly as [`docs/api/README.md`](./api/README.md) describes.
- **`admin_action_log`** — the collection, the recorder and `AuditLogger` all survive. Only the
  three coarse middleware mounts and *this service's read* went.
- **The `'admin'` role value inside jovi-mall.** `requireAdminCaller` still synthesises it and
  about twenty downstream sites still read it. What was retired is a *platform user session*
  carrying it.
- **There is still no geo-tracker data door.** No live position, no trail, no ETA for an
  administrator. `GET /api/v1/system/geo-tracker[/metrics]` is the narrow operations exception and
  it exposes no agent. `last_known_tracking_state` is still served **labelled stale**.
- **The developer → admin → support error ladder** lives only here, and jovi-mall still receives
  `X-Actor-Tier` and never reads it for a decision.
- **The audit store must be a replica set.** `assertAuditStoreTransactional()` refuses to boot
  otherwise — that open question is now formally closed with the answer the code has been
  enforcing. ⚠ `directConnection=true` on `MONGO_URI_ADMIN` pins single-server topology and
  refuses the boot for the same reason.
- **J8 (a durable event bus) stays deliberately open**, waiting on production data from
  jovi-mall's `eventBusHandlerFailuresTotal` — which now exists and has never seen real traffic.

---

## 19 · One honest caveat

Every suite result behind these phases was produced **by hand on a developer machine**. Both
live-suite CI jobs are authored, YAML-validated, and have **never run** — no branch in any of the
three repositories has been pushed, and Phase 5 added a third (`verify:content`) to the same
unproven pipeline.

The results are real: all 22 DB-free suites and all 14 live suites here are green, and the four
live suites that moved each fixed a genuine defect. But **there is no automated gate between a
regression and your dashboard**. Test your own integration.

---

## 20 · Where to look

| Topic | Document |
|---|---|
| The API contract | [`docs/api/README.md`](./api/README.md) |
| **NEW** — the blog editor | [`docs/api/content.md`](./api/content.md) |
| **NEW** — files, orphans, the permanent delete | [`docs/api/files.md`](./api/files.md) |
| **NEW** — the Telegram send | [`docs/api/messaging.md`](./api/messaging.md) |
| **NEW** — support, all 19 routes | [`docs/api/support.md`](./api/support.md) |
| Orders (the projected write responses) | [`docs/api/orders.md`](./api/orders.md) |
| COD (`resolvedBy`) | [`docs/api/cod.md`](./api/cod.md) |
| The audit trail, and the deleted feed | [`docs/api/audit.md`](./api/audit.md) |
| Permissions, tiers, and the four unbuilt | [`docs/api/permissions.md`](./api/permissions.md) |
| Approvals and dual control | [`docs/api/authorization.md`](./api/authorization.md) |
| Phase 5 decisions | [`ADR-017-PHASE-17-CLOSEOUT.md`](../docs/ADR-017-PHASE-17-CLOSEOUT.md) |
| The dashboard-request round | [`ADR-018-DASHBOARD-BACKEND-REQUESTS.md`](../docs/ADR-018-DASHBOARD-BACKEND-REQUESTS.md) |
