# wi-admin — data

**Verified against source on 2026-09-08** — `platform-collections.ts` (49 entries: 47 `read`, 2
`owned`; writes 46 `internal-api`, 2 `direct`, 1 `none` — **confirmed correct**), the eleven
Mongoose models on the private connection, and the three reserved Redis indices. **Two corrections:**
the model list omitted `AutomationFailure` (ADR-022), and § 1's `admin_action_log` paragraph named a
writer — jovi-mall's `/admin/*` middleware — that Phase 5 deleted.

Read from source 2026-09-06: `src/infra/mongo/`, `src/infra/platform/`, `src/infra/redis/`,
`src/modules/audit/models/`, `scripts/ensure-indexes.ts`.

---

## 1 · Two connections, and only one of them can be written

| | `platform` | `admin` |
|---|---|---|
| database | `jovi_mall` — **shared** | `wi_admin` — **private** |
| URI | `MONGO_URI_PLATFORM` | `MONGO_URI_ADMIN` |
| driver | **raw MongoDB driver**, hand-written read interfaces | **Mongoose**, 11 models |
| this service may | **read** (2 collections excepted, see below) | read and write |
| standalone `mongod` acceptable? | yes | ⛔ **no** |

### The rule, and why it is structural rather than a convention

> **Admin READS `jovi_mall` directly where it needs to. Admin WRITES `jovi_mall` only through
> jovi-mall's internal API.**

Reads are pure queries with no invariant to protect, so a second reader costs nothing. **Writes are
where the invariants live** — FIFO cash settlement, guarded compare-and-set on balances, the agency
deactivation cascade — and every one of them runs inside a Mongo transaction **paired with a
post-commit event emission**.

> ⚠ A second process can open its own transaction and **get the money right while silently getting
> the notifications wrong.** That is the failure this rule exists to prevent, and it is not a failure
> that shows up in testing.

Two mechanisms make it structural, and the second is the important one:

1. **`platform-collections.ts` is a typed access table** — 49 entries: **47 `read`**, **2 `owned`**;
   writes route as 46 `internal-api`, 2 `direct`, 1 `none`. A write repository pointed at a `read`
   collection is a **compile error**.
2. **`PlatformReadRepository` has no write method to call.** A service holding one cannot insert,
   update or delete however carelessly it is written, and **no code review has to catch it.**

The projection also lives in the base class rather than at the call site, for the same reason: *a
field that should never leave the database — `password_hash`, `mfa_secret` — leaves it exactly once,
from the one query somebody wrote in a hurry.*

### Why the raw driver and not Mongoose (ADR-004 D-3)

jovi-mall exports **no schemas** — zero `export const *Schema`, only compiled Models — and importing
one registers it on *this* process's default connection and drags in module config that throws at
load time. Redeclaring ~15 schemas here would create a second definition per collection to be kept
in step by hand, for casting nobody needs on a read path.

⚠ **The raw driver applies no defaults**, and that has a live consequence on the two `owned`
collections (`articles`, `article_authors`): their **schema and indexes stay in jovi-mall** for its
public reader, so a field added to jovi-mall's `ArticleSchema` without being added to
`domain/article.document.ts` here produces documents its public DTO renders wrong — **and no test in
either repository would see it.**

⚠ **The Mongoose `Map` trap on `article_authors`:** BSON stores a Map as a plain object, so a real
`Map` handed to the raw driver stores `{}` — *a byline with no title and no bio, in every language.*
Author translations must be written as a **plain object**.

### ⛔ One collection is absent from the table ON PURPOSE

**`user_payment_methods` is deliberately not listed** (Phase 11). It holds `gateway_customer_id` and
`gateway_instrument_id`, which jovi-mall's own model marks as secrets and protects with a DTO —
there is **no `select: false`** on them, and it would not help here anyway, **because this service
reads with the raw driver**.

The same two values are embedded on `customers.saved_payment_methods`, so **any future read of
`customers` must exclude that path by dotted projection.**

Leaving it out is not an oversight to be tidied up: `PlatformCollection` is *derived from these
keys*, so a repository cannot be pointed at the collection at all. An administrator has no
operational need for a customer's stored instrument — refunds go back to the original payment, and
payouts read a destination this service already serves elsewhere, masked. **If a genuine need
appears, adding the row is the easy half; deciding what may be projected out of it needs an ADR.**

### `admin_action_log` is `writes: 'none'`, a real third case

Labelling it `internal-api` would assert there is an endpoint to write it through — **there is not,
and there must not be, because an HTTP ingest into an audit collection is a forgery surface.**

> ⚠ **Who writes it — corrected 2026-09-08.** This paragraph said *"jovi-mall's own `/admin/*`
> middleware, and nothing else, ever"*. That middleware **is gone**: Phase 5 deleted the public
> `/api/admin/*` prefix it matched, and with it the coarse `source: 'request'` row it wrote. What
> survives, and still writes this collection, is **`AuditLogger.log`, which routes any entry whose
> `actor.role === 'admin'` here** — reached today through `/api/internal/admin/agencies`, where
> `AdminAgencyService.deactivate` / `reactivate` hardcode that role
> (`jovi-mall/src/api/index.ts:44-61`, `core/audit/admin-action.model.ts`).
>
> Two consequences worth knowing. **Every row still written duplicates a wi-admin audit row** for
> the same operation, written there against a real administrator identity — whether `AuditLogger`
> should stop is jovi-mall's open follow-up (Phase 5 O-6), not a wi-admin decision. And the rows
> **age out**: `ADMIN_ACTION_LOG_TTL_DAYS = 400`.
>
> ⚠ The same stale sentence is still in **source**, at
> `src/infra/platform/platform-collections.ts:175`. Documentation sessions do not edit source; it
> is recorded for the code session.

---

## 2 · The audit store

**Eleven** Mongoose models on the private connection: `AdminAccount` · `AdminSession` · `AuditLog` ·
`AuditExport` · `FeatureFlag` · `ApprovalRequest` · `AdminNotification` · `NotificationPreference` ·
`NotificationWatermark` · **`AutomationFailure`** · `SchemaMigration`.

> ⚠ **`AutomationFailure` was missing from this list until 2026-09-08** — it landed on 2026-09-07
> with [ADR-022](./ADR-022-AUTOMATION-FAILURE-AUDIT.md), the day after this page was read from
> source. Ten of the eleven live at `src/modules/*/models/`; `SchemaMigration` is the exception, at
> `src/infra/mongo/schema-migration.model.ts`.

### ⛔ The service refuses to start against a standalone `mongod`

`assertAuditStoreTransactional()` runs in `startServer()` **before the port binds**. It reads
`hello: 1` and requires either a `setName` (replica set) or `msg: 'isdbgrid'` (mongos).

The reason: **an audited write is a state change and its audit row committing together.** Without
transactions that becomes two writes that can disagree, and the service would degrade to *"audited,
probably"* — the one guarantee the whole subsystem exists to make — **while looking perfectly
healthy.**

This is not a theoretical guard. Two plausible configurations break it silently:

- `MONGO_URI_ADMIN` carries no `replicaSet=` parameter, so it works today only by driver topology
  discovery. **Adding `directConnection=true` while debugging** pins the driver to a single server
  and every audited write starts failing.
- `IMPLEMENTATION-BLUEPRINT.md` still lists `wi-admin` placement as open. A standalone `mongod` in
  production would break every audited write **on the first suspension**.

Failing at boot turns both into a startup error an operator reads.

### Retention is "exported AND aged", and the partial TTL is what makes it so

`ADMIN_AUDIT_RETENTION_DAYS` = 365. The TTL index is:

```
{ purge_after: 1 }, { expireAfterSeconds: 0,
                      partialFilterExpression: { export_id: { $type: 'objectId' } } }
```

⚠ **The partial filter is the whole rule.** A row leaves only once it has been written to a durable
export file **and** aged past the floor. An unconditional TTL would delete compliance rows that were
never exported.

⚠ **That TTL index is the ONLY thing that removes exported rows**, and Mongoose does not build it in
production because `autoIndex` is off there. `npm run ensure:indexes` must run as a deploy step. **If
it never runs, the index silently does not exist and the collection grows without bound while the
compliance story says it does not** — invisible until storage runs out.

The same script builds `admin_approval_requests`' **partial unique index on `request_key`**, which is
what makes four-eyes idempotent: without it, a double-clicked button queues two approvals for one
intent and **approving both performs the action twice.**

`resumeUnstampedExports()` at boot finishes an export that wrote a durable file and died before
marking its rows exported — those rows are in a file whose sha256 is on record, so they are safe to
stamp, and **left unstamped they are never eligible for deletion.**

### Eight indexes, each answering one question

feed · "what did this administrator do" · "what was done to this record" · tier-3 subject scope ·
"every suspension, ever" · the dangling-intent sweep · intent↔outcome correlation (cross-service) ·
purge batching. ⛔ Do not consolidate them by eye; each names its query in a trailing comment.

### Contrast with jovi-mall's `admin_action_log`

| | wi-admin `admin_audit_log` | jovi-mall `admin_action_log` |
|---|---|---|
| TTL | **partial** — exported AND aged, 365 d | **unconditional**, 400 d |
| is the compliance record? | **yes** | **no** — a stop-gap in a database wi-admin does not own |

400 > 365 deliberately, so nothing there disappears before its counterpart here would have.

---

## 3 · Redis — three reserved indices, one of them deliberately unused

| DB | Constant | Holds |
|---|---|---|
| 1 | `ADMIN_SESSION_DB` | admin sessions — **revocable server-side, which a stateless JWT cannot be** |
| 2 | `ADMIN_RATE_LIMIT_DB` | rate-limit counters |
| 3 | `PERMISSION_CACHE_DB` | **reserved and deliberately UNUSED** |

**DB 3 stays empty on purpose.** Phase 1 set it aside for cached tier→endpoint verdicts; Phase 3
built authorization without it and **should keep it that way**: the grant table is static code, so a
tier's permission set cannot change while the process runs — there is nothing to invalidate — and
each check is a `Set.has` on a string. A Redis round trip would make an O(1) lookup slower **and add
the one failure this design otherwise cannot have: a stale verdict surviving a deploy that changed
the policy.** The index stays reserved so nothing else claims it.

⚠ **These three indices are NOT independent of jovi-mall's, on a developer machine.** Both services'
`.env.example` files point at `redis://localhost:6379` (verified 2026-09-06), so on one Redis they
share a keyspace. jovi-mall's own factory documents this correctly and states the resulting budget:
**it may assign 5–15 only**, because wi-admin holds 1/2/3 — and `EMAIL_VERIFY_DB = 3` on that side
**already collides** with `PERMISSION_CACHE_DB`, knowingly and harmlessly (both are exact-gets;
nothing reads the other's keys).

⛔ **Before claiming a new index here, read `jovi-mall/src/infra/redis/redis.factory.ts`.** Its
`REDIS_DB_CATALOG` is the fuller record, and it names which numbers are **retired rather than free**
(4 and 9 — reading a pre-cutover verification code back as something else is a security incident).

---

## 4 · Migrations — one, and no runner

```bash
npm run ensure:indexes     # build the indexes wi-admin collections declare
npm run migrate:status     # was it run here, and from which version — exits non-zero if not applied
```

`autoIndex` is off in production — correct, because an index build triggered by a deploy is an
unannounced load spike — so production needs `ensure:indexes` run **deliberately, as a migration
step**.

⚠ **There is exactly one migration-shaped script, so there is no runner and no declared order.** That
is a deliberate stopping point: *if a second migration ever lands here, the honest move is to port
jovi-mall's `scripts/migrate.ts` rather than grow `migrate-status.ts` — the moment there are two,
ORDER becomes a fact somebody has to declare, and a status report that cannot express order is
misleading.*

---

## 5 · Idempotency

| Surface | Mechanism |
|---|---|
| four-eyes approvals | **partial unique index on `request_key`** — see § 2 |
| audit intent → outcome | `correlation_id`, swept for dangling intents after `ADMIN_AUDIT_DANGLING_INTENT_S` (300 s) |
| audit exports | the export file's **sha256** on record, plus `export_id` stamping |
| notification projection | per-source **watermarks** (`NotificationWatermark`) |

⚠ `ADMIN_AUDIT_MAX_STATE_BYTES` (4 096) bounds the before/after state captured on a row. It is a
**bound, not a preference**: an unbounded state capture on a large document turns the audit
collection into a copy of the database.
