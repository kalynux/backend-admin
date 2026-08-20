# ADR-013 — The administrator inbox

**Status:** accepted · **Date:** 2026-08-12 · **Phase:** 13
**Implements:** the *Notifications* row of `PHASE-0:307`; the `admin_notifications` half of
blueprint Phase 7
**Depends on:** [ADR-003](./ADR-003-GRANULAR-PERMISSIONS.md) (the permission catalog this
gates on) · [ADR-004](./ADR-004-DOMAIN-OWNERSHIP.md) (read direct, write through jovi-mall) ·
[ADR-005](./ADR-005-API-CONTRACT.md) (the list contract) · [ADR-006](./ADR-006-AUDIT.md)
(the trail, and D-5 on not auditing reads)

> **Numbered 013.** ADR-012 is owed by the audit phase — ADR-006's Phase 12 addendum cites
> `ADR-012-AUDIT-COMPLETION.md`, and a source-file citation wins the tiebreak (the rule
> ADR-010 set against ADR-009). Nothing cites 013 yet; `api/index.ts` cites it from this
> phase's mount.

**Verified by:** `npm run test:notifications` (88, DB-free) ·
`npm run verify:notifications` (53, needs Mongo + Redis)

---

## Context

`PHASE-0:124` measured it and `PHASE-0:339` listed it as problem 15: jovi-mall's
`modules/notifications/` carries **four** notification stacks — vendor, agency, agent,
customer — with in-app inboxes, unread counts, preferences, deep links, push, email,
Telegram and WhatsApp. `collections.ts` confirms there is no `ADMIN_NOTIFICATION` model. The
administrator was the only role on the platform without one.

The gap was operational rather than cosmetic. `PHASE-0:307` names what the missing inbox was
supposed to carry — **disputes, COD discrepancies, payouts, failed webhooks** — and until
this phase an administrator learned about each of those by opening the screen that lists it
and noticing the number had changed. A dispute raised at 02:00, a cash shortfall blocking an
agency's reserve releases, an action waiting on a second signature: all silent until somebody
looked.

`admin_notifications` was reserved for this in the first ADR (`ADR-001:296`, `ADR-002:255`,
`PHASE-0:375` — *"the missing fifth notification stack"*) and ADR-004's ownership map assigns
it to **wi-admin: own DB, own read, own write**. The permissions were catalogued in Phase 3
and granted in the same change: `permission.catalog.ts:673-681` declares `notifications.read`
and `notifications.manage` at `phase: 7`, `tier-grants.ts:75` gives tier 3 the read and `:140`
gives tier 2 the family.

So the policy was decided years before this phase and the implementation was zero lines.

### The constraint that shaped every decision

The phase was specified with one rule: **do not invent notification events.**

That rule has teeth here because the platform has already paid for its opposite, twice, and
both times the failure was silent:

- **jovi-mall, ADR-005 D-17.** Two hand-maintained copies of the agent notification types
  drifted. Eight `agent_contract.*` situations existed in the TypeScript union and not in the
  Mongoose enum, so every one of those notifications threw a `ValidationError` on write and
  the agent was simply never told. `ADR-008:105` puts the cost at eight silently-undelivered
  notifications.
- **This service, ADR-006's Phase 12 addendum.** `audit.export`, `audit.purge` and the five
  `approvals.*` actions were catalogued from day one and produced by nothing. ADR-006's claim
  that both were audited "was aspirational for the whole of its life".

Neither was found by anything failing. Both were found by reading code. That is the
observation this phase is built around.

---

## Decisions

### D-1 · A notification is derived from a committed row. It is never emitted.

There is **no function anywhere in this service that creates a notification from a
free-form event.** `source.registry.ts` is the complete list of facts the inbox can carry,
and each entry names a collection, a filter meaning *this row is actionable*, and the field
whose movement marks the transition. The projector reads rows; it is handed no other way to
produce anything.

That is what makes the phase's rule structural rather than aspirational. A situation the
platform does not actually record cannot be notified about — not because a convention forbids
it, but because there is no code path that would accept it.

**Ten sources ship**, and they cover all four of `PHASE-0:307`'s named alerts:

| Source | Collection | Actionable when | Watermark | Gated on |
|---|---|---|---|---|
| `cod_discrepancy_opened` | `cod_discrepancies` | `status: open` | `opened_at` | `cod.discrepancies.read` |
| `cod_remittance_declared` | `agency_remittances` | `status: declared` | `declared_at` | `cod.remittances.read` |
| `payout_requested` | `payout_requests` | `status: pending` | `created_at` | `money.payouts.read` |
| `order_disputed` | `orders` | `dispute_hold.active` | `dispute_hold.disputed_at` | `orders.disputes.read` |
| `agency_verification_pending` | `delivery_agencies` | pending, unverified | `updated_at` | `agencies.verify` |
| `vendor_kyc_pending` | `vendors` | KYC pending | `updated_at` | `vendors.kyc.review` |
| `tracking_dispatch_failed` | `tracking_outbox` | `status: failed` | `updated_at` | `system.outbox.read` |
| `approval_requested` | `admin_approval_requests` | `status: pending` | `created_at` | the action's `approverPermission` |
| `approval_decided` | `admin_approval_requests` | approved / rejected | `decided_at` | the requester |
| `audit_export_finished` | `admin_audit_exports` | complete / failed | `updated_at` | the requester |

Every jovi_mall collection there was **already** declared readable in
`platform-collections.ts`. `tracking_outbox`'s entry already said *"read for dispatch HEALTH
only"*, which is precisely this use. Widening that file to feed the inbox would be a
data-access decision (ADR-004) and does not get made here.

### D-2 · No Redis pub/sub. J8 is not a prerequisite after all.

`IMPLEMENTATION-BLUEPRINT.md:106-110` deferred **J8 (Redis pub/sub event transport)** to
"Phase 1.5" and named two things that must not ship before it — the first admin direct write
with platform side effects, and **the admin notification stack (Phase 7)**.

J8 is still unbuilt. `jovi-mall/src/core/events/event-bus.ts` is an in-process
`Map<string, EventHandler[]>` that awaits handlers and swallows their errors; wi-admin's
`src/infra/redis/` holds only `redis.factory.ts`.

**This phase does not build it, and does not need it.** Two facts decided that:

1. jovi-mall's bus is **lossy by construction**. The root `CLAUDE.md` already lists it as a
   verified cross-service defect: an event lost between the commit and the handler is lost
   permanently. A Redis hop would add a second place to lose it, and the inbox would inherit
   a delivery guarantee weaker than the rows it describes.
2. The rows are **already committed and already readable**. A row is a strictly better source
   than a fire-and-forget publish, because re-reading it is free and re-publishing it is
   impossible.

The result is a projector that cannot lose anything. A crashed tick re-derives on the next
one; delivery is made exactly-once by a unique index rather than by careful bookkeeping.

**J8 remains owed** for its other purpose — admin's own direct writes reaching jovi-mall's
in-process subscribers (`BLUEPRINT:96-101`). This phase removes one of the two reasons it was
blocking, not the requirement itself.

### D-3 · A declared type with no producer fails the boot.

`assertNotificationCoverageComplete()` runs in `app.ts` beside `assertAuditCatalogValid` and
`assertAuditCoverageComplete`, and refuses to start when any member of `NOTIFICATION_TYPES`
is produced by no source, produced by more than one, or missing from the catalog.
`assertSourcePermissionsExist()` checks the other side: every `gates` names a catalogued
permission.

This is Phase 12's mechanism applied one subsystem over, for the same reason and against the
same failure. **Exactly one** producer, not at least one: two sources producing one type
means two `source_key`s for one situation, which the unique index cannot collapse, so the
administrator is told twice.

The check is a pure function (`findCoverageProblems`) so the DB-free suite can hand it an
orphaned type and prove the failure is detected. Asserting only that the shipped registry
passes would be a test that stays green if the function returned `[]` — which is the shape of
"declared and never written" all over again.

### D-4 · Visibility is the permission catalog, applied twice.

Each source declares the permission its rows are gated on. Fan-out resolves recipients
through the existing `grantedTo(tier)` / `hasPermission(tier, name)` — no new policy, no new
resolver, no cache.

The list query then filters on the viewer's **current** effective permissions as well. That
second check is not redundant: without it visibility would be frozen at the instant of
delivery, and an administrator demoted from tier 1 to tier 3 would keep reading every
financial alert already in their inbox for as long as the rows lived. Re-checking makes a
demotion apply to the whole inbox on the next request — the same posture
`authenticate.middleware.ts` takes by re-reading the tier from Mongo rather than trusting the
token.

Proven end to end in `verify:notifications` §3: a tier-2 administrator receives a COD
discrepancy, and a tier-3 (Support) administrator — who holds `notifications.read` and not
`cod.discrepancies.read` — has no row written for them at all.

### D-5 · A notification is never load-bearing.

It is a delivery receipt for a fact recorded elsewhere. It never joins the transaction it
describes, and its failure never rolls anything back.

This is the deliberate **inverse** of ADR-006 D-1 ("an action that cannot be audited does not
happen"), and the asymmetry is the point: an audit row is evidence, a notification is a
receipt for something already on file. Making the inbox load-bearing would mean an
administrator cannot suspend an account while the notification collection is unhealthy —
trading a real capability for a convenience.

Three consequences, all intentional: no `writeConcern: majority` on the model; the projector
runs on a timer rather than in the request; and D-6's TTL is defensible where
`approval-request.model.ts` refuses one.

### D-6 · Soft archive, and a TTL with an argument behind it.

`archived_at` + `purge_after`, with a partial TTL index keyed on `archived_at` existing, and
both fields declared **without a default** — a `default: null` puts the key on every document
and makes the partial filter vacuous, silently converting a conditional purge into an
unconditional one. `$type: 'date'` rather than `$exists`, for the same reason
`audit-log.model.ts:204` gives.

`approval-request.model.ts` refuses a TTL outright — *"a TTL would quietly erase the record of
an attempt"* — and that is right there and wrong here. The rows are not alike. An approval
request **is** the record of an attempt and the audit subsystem joins against it. A
notification's subject outlives it on both sides: the jovi_mall row it was derived from is
still there, `admin_audit_log` still holds whatever an administrator did about it, and the
registry can re-derive the row from scratch. Purging an archived receipt destroys no evidence
and answers no question worse.

There is **no hard delete**. Archiving is the only removal path, and `unarchive` clears both
fields — leaving `purge_after` behind would produce a row outside the partial index that
lies about what happens to it next.

### D-7 · A new source starts at `now`. There is no backfill.

The first tick of a source records the clock and delivers nothing.

Without this, adding `vendor_kyc_pending` would fan out one notification per unreviewed
vendor on the platform, to every administrator holding `vendors.kyc.review`, in one tick, on
deploy day — `vendor.read.repository.ts:261` is explicit that the entire pre-existing roster
matches that filter. An inbox that opens with four hundred unread rows is an inbox nobody
reads, and the second one they ignore is the one that mattered.

The backlog is not lost and was never this surface's job: `/vendors?kycStatus=pending` and
the other list screens answer that question and were built for it. There is deliberately no
backfill switch; if one is ever wanted it is a CLI that clears a named watermark, visible and
deliberate, not something a deploy does by itself.

### D-8 · Inbox hygiene is not an administrative action.

Mark read, unread, archive, unarchive and bulk mark-read declare `noAudit(...)` and are the
**first five entries** in `NO_AUDIT_ROUTE_ALLOWLIST`, which was empty through Phase 12.

ADR-006 D-5 already decided that reads are not audited, with one deliberate exception (a
payout destination, where the disclosure *is* the action). A receipt for having looked at
your own inbox is on the far side of that line. Auditing them would also damage the trail it
is meant to protect: an administrator triaging a morning's alerts would generate dozens of
rows saying nothing about what anybody **did**, diluting the record a security review reads.
What they then do about the notification is audited by the endpoint that does it.

The preference write **is** audited, as `notifications.preferences.update_self` with
`permission: null` — the exact shape of the existing `administrators.profile.update_self`,
which `checkPermissionCoherence` passes because a null-governed action on a `selfService`
route returns early. A preference is durable configuration that changes what this service
does in future, not a record of having looked.

### D-9 · Preferences are self-service. `notifications.manage` stays unrouted.

Per-administrator, per-type overrides, mirroring what jovi-mall's four stacks already give
every other role. Applied at **fan-out**, so a muted type produces no row at all rather than
one filtered later — muting cannot then be a filter somebody forgets, and the unread count
cannot disagree with the list.

The document stores only the types an administrator has an opinion about; everything else
resolves to the catalog's `defaultEnabled`. A dense record would need a migration per new
type, and until it ran every existing administrator would hold a document that silently
disagrees with the catalog about a type it has never heard of. `null` in the patch **removes**
an override rather than setting it — without that third state there is no way to stop
overriding a type, only to set it to whatever the default happens to be today, which looks
identical and silently stops tracking the catalog.

`notifications.manage` reads *"configure which events raise an administrator alert"*, which is
service-wide by its wording. Gating self-service preferences behind it would stop a
tier-3 administrator configuring their own, so it is left catalogued and unrouted — the
natural home for a future source-level switch. `assertGrantTableValid` is satisfied either
way.

---

## Defects found while building, and fixed here

Both were found by `verify:notifications` measuring what the code actually does, and neither
would have failed anything.

| # | Defect | Where |
|---|---|---|
| **F-1** | The projector's cursor stored `last_seen_id` as a string and compared it against ObjectId `_id`s. **BSON compares across types by type order before value, and String sorts below ObjectId**, so the tiebreaker branch matched every row rather than the ones after the cursor. Idempotency absorbed the extra rows, so the only symptom was a sweep re-reading a whole millisecond forever — indistinguishable from a healthy one. Fixed by `toComparableId`. | `notification-source.read.repository.ts` |
| **F-2** | `order_disputed` watermarked on `updated_at`, which is **unindexed on `orders`** — `explain()` reported a COLLSCAN over the entire collection, on a sweep running every thirty seconds. It was also semantically wrong: `updated_at` moves on every unrelated edit. Both fixed by moving to `dispute_hold.disputed_at`, which is the real moment *and* the key of the partial `dispute_queue` index (`order.model.ts:473`); the filter is now that index's `partialFilterExpression` exactly. | `source.registry.ts` |

F-2 forced a third fix: a dotted watermark path is a valid Mongo query path but the document
that comes back is **nested**, so `row['dispute_hold.disputed_at']` is `undefined` while the
query that produced it worked. The cursor would never advance and the source would sit on its
first page forever, again with no duplicates and no errors. `valueAt()` resolves the path.

A fourth was found in shared test infrastructure and fixed there: `_assert.ts` accepted a
`() => boolean` and an `async` assertion returns a Promise, which is truthy — so an async
assertion **passes unconditionally, forever, whatever it checks**. This suite was written with
22 of them. The harness now reports a Promise result as a failure naming the cause, which
makes the mistake loud for every suite rather than invisible.

---

## The API

`/api/v1/notifications`. Offset paging, `meta` from `toPageMeta`, filters as top-level
camelCase parameters, one sort allowlist — ADR-005 throughout.

| Method | Path | Access | Audit |
|---|---|---|---|
| GET | `/notifications` | `notifications.read` | — |
| GET | `/notifications/unread-count` | `notifications.read` | — |
| GET | `/notifications/sources` | `notifications.read` | — |
| GET | `/notifications/preferences` | self | — |
| PATCH | `/notifications/preferences` | self | `notifications.preferences.update_self` |
| POST | `/notifications/read-all` | `notifications.read` | none (D-8) |
| PATCH | `/notifications/:id/read` · `/unread` | `notifications.read` | none (D-8) |
| POST | `/notifications/:id/archive` · `/unarchive` | `notifications.read` | none (D-8) |

Notes worth having in one place:

- **There is no POST that creates a notification.** D-1, expressed as an absence.
- **`?status=` is derived, not stored** — `unread` is `read_at: null`, `archived` is
  `archived_at` present. A stored column would be a second source for one fact and a way for
  the two to disagree. `all` still excludes archived: an archived row has left the inbox, and
  `?status=archived` is how you open the drawer.
- **The default sort is `-occurredAt`, not `-createdAt`.** `created_at` is when the projector
  noticed; `occurred_at` is when the thing happened. An inbox ordered by the former would
  reorder itself for reasons that have nothing to do with the platform.
- **`unread-count` exists.** jovi-mall gave a badge endpoint to customers alone; vendor,
  agency and agent all have to read `meta.unreadCount` off a list they do not want, and one
  has a `countUnread` service method with no route in front of it.
- **`read-all` takes the list's filters and a `before` bound**, so the gesture means "mark
  read what I was looking at" rather than "discard whatever arrived while I was reading".
- **404, never 403**, for a row that is not yours or that your tier no longer entitles you to.
  Answering "that exists but is not yours" tells the caller a notification was raised, which
  type it was, and that somebody else received it.
- **`action_path` is this service's own API path**, not a dashboard route. The dashboard is
  user-owned and its contract is Phase 8's `admin/api-doc/`; inventing UI paths would assert a
  contract nobody has agreed to.

---

## Operating it

| Variable | Default | What it does |
|---|---|---|
| `ADMIN_NOTIFICATIONS_SWEEP_S` | `30` | Sweep interval. **`0` disables the projector**, which is the supported way to run a replica that should not double-sweep — the read endpoints keep working. |
| `ADMIN_NOTIFICATIONS_BATCH` | `200` | Rows read per source per tick. |
| `ADMIN_NOTIFICATIONS_MAX_PER_TICK` | `25` | Rows delivered per source per tick before truncating. |
| `ADMIN_NOTIFICATIONS_AUTO_ARCHIVE_DAYS` | `90` | Age at which an untouched row is archived, read or not. |
| `ADMIN_NOTIFICATIONS_RETENTION_DAYS` | `30` | How long an archived row survives the TTL. |

The per-tick cap exists for `tracking_dispatch_failed`: if geo-tracker is unreachable, every
outbox row parks as `failed` at once, and one outage would otherwise become hundreds of
identical notifications in every entitled inbox. **The cap is never silent** — a truncated
tick logs at `warn` with the count, and the watermark still advances, so the next tick
continues rather than repeating.

`npm run ensure:indexes` must run before or with the deploy. The unique
`{ source_key, admin_id }` index is not a nicety: it is the projector's entire exactly-once
guarantee, and without it every sweep is a duplicate generator.

The projector starts **after** the port is bound and stops **first** on drain, before the
databases close — a tick in flight when Mongo goes away throws inside a timer callback, which
is the one place with no handler above it.

---

## Consequences

- **The administrator is no longer the only role without a notification stack.** The four
  `PHASE-0:307` alerts are delivered, and `PHASE-0:339`'s problem 15 is closed.
- **Adding a source is one registry entry**, and forgetting the entry stops the service
  booting rather than producing a type nobody receives.
- **Ten sources, and none of them required a jovi-mall change.** Every collection was already
  readable; no event shape moved; the projector is a read-only consumer of rows that were
  written for other reasons. This is the ADR-004 read/write split paying for itself.
- **`NO_AUDIT_ROUTE_ALLOWLIST` is no longer empty**, and `test-audit.ts` now pins its exact
  contents rather than its size — a sixth entry is a named failure, not a bumped number.
- **The `_assert.ts` change applies to every suite**, retroactively. No other suite used an
  async assertion, so nothing changed colour; the guard is there for the next one.

### Deliberately not built

- **J8 Redis pub/sub** (D-2). Still owed for admin's own direct writes reaching jovi-mall's
  subscribers.

  ⏸ **Re-examined 2026-08-20** (Phase 4 step 22) and left open **deliberately**, with the thing
  it now waits on named. D-2's argument against building a Redis hop as a bandage stands
  unchanged, and the standing instruction has been *decide J8 with data*. That data now has a
  producer and no readings: jovi-mall emits **`eventBusHandlerFailuresTotal`** (Phase 4 step 6,
  `jovi-mall/src/core/events/event-bus.ts`), which counts exactly the loss D-2 describes — a
  subscriber that throws, is logged, and is never retried. It has **never run against real
  traffic**. Closing J8 now, in either direction, would be deciding it with the same absence of
  evidence that deferred it in the first place.

  What to look at when the numbers exist: **the four user-facing notification stacks are the
  exposure**, not the two money splits — those have recovery sweeps in `EarningsReleaseWorker`
  (`recoverMissedCodSplits`, `recoverMissedDeliverySplits`), and the stacks have none, so a
  handler that throws means the customer is simply never told. Revisit in **6.K**.
- **`notifications.manage`** — a service-wide alert-configuration surface (D-9).
- **Email or push delivery.** In-app only. jovi-mall's stacks carry four channels; an
  administrator sits in front of the dashboard, and a second delivery path is a second thing
  to get wrong before anybody has asked for it.
- **Backfill** (D-7).
- **jovi-mall's four user-facing stacks.** Exploration for this phase surfaced real defects
  there — a missing `customer-notification.hbs` so customer email notifications silently never
  deliver, no `POST /api/customer/devices` route so customer push can never target anyone,
  `order.refunded` catalogued in three places and published by nothing, and roughly thirty
  events published to zero subscribers (`cod.discrepancy.opened`, `payment.disputed`, all
  `ticket.*`, `earnings.matured`, `user.password.changed`). Different repo, different phase.
  Worth filing; not worth folding in here.
