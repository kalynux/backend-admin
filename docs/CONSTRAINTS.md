# wi-admin — implementation constraints

**Verified against source on 2026-09-08** — the suite count (24 `test:*` + 15 `verify:*`, from
`package.json`) and the permission total (**118**, `npm run authz:matrix`). Both figures had moved;
every rule on the page was left as written.

**The things that look like improvements and are not.**

Every entry here is a rule whose *obvious* refactor is the bug. They are collected in one place
because they share a property: **each is invisible to the type system**, and several are invisible to
the 39 suites as well (24 `test:*` offline + 15 `verify:*` live, re-counted 2026-09-08) — so the
only thing standing between the codebase and the regression is somebody having read this.

Read from source 2026-09-06.

---

## 1 · The founding separation

**Administrators hold no `users` row, anywhere.** Everything else on this page is downstream of it.

| ⛔ Do not | Because |
|---|---|
| mint platform users for administrators | it collapses the identity separation the entire admin architecture is built on. This was the **rejected alternative** in ADR-020 |
| authenticate an administrator through jovi-mall | jovi-mall cannot resolve one — `/api/tracking/visible-agents` does a `findById` on `users`, and there is no row |
| build a permission system in jovi-mall | the permissions live here — **118** on 2026-09-08, and the figure moves every phase — and one policy in two places drifts |
| enforce on `X-Actor-Tier` in jovi-mall | the token authenticating that call is **full-privilege**; anyone holding it could set the header. jovi-mall serves the full record, wi-admin grades it |
| read `X-Admin-Actor` in **geo-tracker** for a decision | same reason, other seam. It is recorded, never consulted — which is precisely **why the tracking audit row lives here**, where the human is actually known |

---

## 2 · Route registration and audit coverage

⛔ **Never write a raw `router.get(` in a routes file.** Use `defineRoute`.

> *Authorization that is attached by remembering to attach it is authorization that is eventually
> forgotten.*

Three layers enforce it, and each catches what the one before misses — structural requirement,
`assertRouteManifestComplete()` at boot, and `test:authz`'s source scan. Auditing has the same three
since Phase 12, and **the gap that forced them was real: the whole four-eyes decision path and the
audit purge shipped recording nothing.**

| ⛔ Do not | Because |
|---|---|
| move `validate` before the guards | an unauthorized caller should not be able to probe a schema |
| make CSRF conditional | it already no-ops on safe methods and bearer clients, so attaching it always costs nothing and **removes the entire "forgot CSRF on a new route" failure mode** |
| use `requireAdminAllowingMfaEnrolment` outside the enrolment routes | everything else uses the strict export **so a new route is protected by default rather than by opting in** |
| add a permission without flagging `financial` / `escalation` / `destructive` | an unflagged financial write can be swept into a tier by `allInFamily()`. This is the one mistake with real consequences |
| add an audit action without deciding its `transport` | `transport` is not documentation — the validator and the writer check against it, so the recording mode is decided **once**, not re-chosen per call site |

---

## 3 · The direction of privilege

⚠ **A LOWER tier number means MORE privilege.** Tier 1 Developer (116) → tier 2 Admin (99) → tier 3
Support (30). This reverses ADR-001 D5 and is the single most misread fact in this service.

⛔ **Do not make demotion dual-controlled.** Promotion to Developer, and suspension or reinstatement
of one, take two Developers — so no single account can create a peer, and a compromised Developer can
be contained by another. **Reducing privilege is the safe direction, and needing a quorum to contain
a compromised account would be exactly backwards.**

⚠ Reinstatement *does* ride the dual-control spec, because restoring a suspended Developer grants
Developer access to an account that currently has none — as consequential as promoting one.

⛔ **Do not cache permission verdicts.** `PERMISSION_CACHE_DB = 3` is reserved and deliberately
unused: the grant table is static code, so there is nothing to invalidate, and each check is a
`Set.has`. A Redis round trip would be slower **and** would add the one failure this design otherwise
cannot have — **a stale verdict surviving a deploy that changed the policy.**

---

## 4 · Data

| ⛔ Do not | Because |
|---|---|
| write `jovi_mall` directly | its writes carry invariants — FIFO cash settlement, guarded compare-and-set, the deactivation cascade — each inside a transaction **paired with a post-commit event emission**. A second writer can get the money right and **silently get the notifications wrong**, and that does not show up in testing |
| add a write method to `PlatformReadRepository` | its *absence* is the mechanism. A service holding one cannot write however carelessly it is written, and no review has to catch it |
| add `user_payment_methods` to the access table to "complete" it | it holds gateway instrument ids that jovi-mall marks as secrets, with **no `select: false`** — which would not help anyway, because this service reads with the raw driver. Its absence removes the collection from `PlatformCollection` entirely |
| read `customers` without a dotted projection | the same two secrets are embedded on `customers.saved_payment_methods` |
| label `admin_action_log` `internal-api` | that would assert there is an endpoint to write it through. There is not, **and there must not be — an HTTP ingest into an audit collection is a forgery surface** |
| hand a real `Map` to the driver for `article_authors` | BSON stores a Map as a plain object, so it writes `{}` — **a byline with no title and no bio, in every language** |
| add a field to jovi-mall's `ArticleSchema` alone | its schema and indexes stay there, its writes happen here, and the raw driver applies no defaults. **No test in either repository would see it** |
| consolidate the audit indexes by eye | each of the eight names its query in a trailing comment |
| make the audit TTL unconditional | the `partialFilterExpression` on `export_id` is what makes retention *"exported AND aged"* rather than *"aged"*. Without it, compliance rows leave before they were ever exported |
| skip `ensure:indexes` in production | `autoIndex` is off there, so the TTL index **silently does not exist** and the collection grows without bound while the compliance story says it does not — invisible until storage runs out. It also builds the partial unique index that makes four-eyes idempotent |
| claim a Redis index without checking jovi-mall | both `.env.example` files point at `redis://localhost:6379`, so a developer machine shares one Redis. jovi-mall's factory is the fuller catalogue, including which numbers are **retired rather than free** |
| drop the `_id` sort tiebreaker | skip/limit paging over a non-unique key is unstable: one document appears twice and another never appears at all — reported as *"a record is missing from the list"*, which is unfalsifiable from a bug report |

⛔ **Do not add a second migration without porting jovi-mall's runner.** There is one
migration-shaped script and therefore no declared order; **the moment there are two, order becomes a
fact somebody has to declare, and a status report that cannot express order is misleading.**

---

## 5 · The doors into geo-tracker

⛔ **Neither client may ever throw, and neither may become a readiness dependency of wi-admin.** That
would recreate ADR-014 D-1's coupled-failure amplifier in the opposite direction — and it is **one
`Promise.all` away**, the exact mistake that would look like a tidy-up in review.

> **A data door may fail a *request*. It may never fail the *service*.**

| ⛔ Do not | Because |
|---|---|
| merge the ops and data clients | a data call would be one typo from having no credential, and an ops call one typo from carrying one |
| fold either into `platform.client.ts` | a geo-tracker call would be one typo from carrying `X-Service-Token` — **a credential scoped to a different service with a different blast radius** |
| collapse the two base-URL variables | they are the lever that lets a deployment take the operations reads and **open no data door** |
| widen the ops path set | `/healthz`, `/readyz`, `/metrics` is a **closed literal set**, and it is the boundary to point the next "just one more geo-tracker endpoint" request at |
| merge `agents.tracking.read` and `shipments.tracking.read` | one is **live surveillance of a person**, the other is **a case file about a delivery**. Support holds both deliberately, and the audit row is the other half of that decision |
| catch the failure of the pre-read audit write | it commits **before** the read and its failure is deliberately uncaught, so with the audit store down **nothing is disclosed** |

---

## 6 · Things that have been reported and are not defects

| Looks like | Is |
|---|---|
| `developer_tools.webhooks.redeliver` is a permission with no route | **deliberate.** Every webhook mount in the platform is inbound; nothing records an outbound delivery, so there is no subject to redeliver. The permission names its own missing prerequisite. **Writing the endpoint would be worse than the gap** |
| `PERMISSION_CACHE_DB = 3` is unused | **reserved on purpose** — see § 3 |
| `:articleKey` was renamed to `:articleId` | **cosmetic.** A path-parameter name is not on the wire, and the value is still `ArticleKeySchema` — a slug-style string explicitly **not** an ObjectId. DOC-PROGRAM P-2, closed with no action |
| wi-admin duplicates jovi-mall's `/system` vs `/dev-tools` split | it does, deliberately. One surface is read-only and tier 1–2; the other is destructive and tier 1 |

---

## 7 · Three claims about OTHER services that aged in this repository's comments

**All three were corrected on 2026-09-06** (comment-only edits; `tsc --noEmit` clean, no
non-comment line touched). They are kept here rather than quietly closed **because the pattern is
the lesson**, and it is the pattern [`../../CLAUDE.md`](../../CLAUDE.md) already warns about in its
own defect list:

> **A comment that asserts something about a *different* repository ages without anybody editing the
> file that makes the claim.** Nothing fails, no test turns red, and the reader has no way to tell a
> current statement from a three-phase-old one.

| Where | Had said | Actually | Finding |
|---|---|---|---|
| `src/infra/geo/geo-tracker.client.ts` | *"the ONLY door this service has into geo-tracker"*, and that D-2 reads as *"wi-admin has no geo-tracker **data** door"* | **amended by ADR-020 on 2026-08-22.** The sibling `geo-tracker-data.client.ts` recorded the amendment in its own docstring; this file was not updated alongside it | **P-16** |
| `src/api/routes/health.routes.ts` | *"jovi-mall's entire observability surface is `GET /api/health` → `{ status: 'ok' }` … it cannot drive a load balancer or a deployment gate"* | true when written, **false since Phase 14**. jovi-mall serves `/api/health/live`, `/api/health/ready`, `/metrics` and twelve `/api/internal/admin/system/*` routes — and its unconditional 200 on `/api/health` is now a **frozen cross-service contract**, not an omission | **P-15** |
| `src/infra/redis/redis.factory.ts` | *"jovi-mall reserves 3–10 on its own Redis instance; these are this service's own namespace and are independent of those"* | jovi-mall uses **0, 3, 5–8 and 10–15**, and its own factory states the budget as **5–15 precisely because wi-admin holds 1/2/3**. Both `.env.example` files ship `redis://localhost:6379`, so on a developer machine they are **not** independent | **P-13** |

⚠ **The third was the one with teeth.** A reader trusting *"jovi-mall reserves 3–10"* would have
concluded 11–15 were free here — and would have collided with the rate limiter, the worker lock, the
connection codes, the login codes or the cache.

⛔ **The rule this leaves behind:** when a comment here describes another service, cite the file or
ADR that owns the fact rather than restating it, so the next reader can check the claim against its
source instead of against its age.
