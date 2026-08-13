# ADR-006 — The audit subsystem

**Status:** Accepted, 2026-08-11 · **Implements:** blueprint Phase 3.5, decision **D4**
**Closes:** ADR-002 D4 (audit location and consistency), PHASE-0 open question 3 (retention)
**Verified by:** `npm run test:audit` (103, DB-free) · `npm run verify:audit` (26, needs Mongo + Redis)

---

## Context

Phase 3.5 was specified in three ADRs and sequenced deliberately **before** any delegated
mutation, for a reason the blueprint states plainly:

> "Audit (3.5) precedes any delegated mutation (4) deliberately — retrofitting an audit trail onto
> working endpoints is exactly how the legacy `console.log` stub happened."

Phases 4 and 5 overtook it. Until this landed, the service had **no audit code at all**: no model,
no writer, no route. `/audit` was a comment in `api/index.ts`; `audit.read` and `audit.export` were
catalogued permissions with nothing behind them. The only durable trace of an administrative action
was a set of last-write-wins columns on the account row — and `applyReinstatement` clears
`suspended_by`/`suspended_reason`, so a suspension that was later lifted left **no evidence it ever
happened**.

Phase 3 had left the seam to drop into: `recordAuthorizationDenial()` is one function with four call
sites whose docstring promised that this phase would replace its body and move nothing else. That
promise is kept literally — see D-6.

---

## D-1 · Fail closed on state changes, best-effort on observations

**An action that cannot be audited does not happen.** For a write to `wi-admin`, the audit row and
the state change commit in **one transaction**, so there is no ordering in which one exists without
the other.

The deliberate exception is **identity observations** — login success and failure, lockout, a
rejected MFA code. Two reasons, and the codebase had already ruled this way for the same data
(`session.service.ts`: *"failing to write history must not deny a valid login"*):

1. There is nothing to roll back. The login already succeeded or failed on its own terms.
2. Applied there, the rule makes an audit-store outage a **lockout with no break-glass path** —
   including for the administrator who would fix it.

A failed observation write is logged at `fatal`, not swallowed.

| | Fail closed | Best-effort |
|---|---|---|
| Administrator create / update / suspend / reinstate / tier / password reset | ✅ | |
| MFA enrol / activate, self password change | ✅ | |
| Session revocation (Redis), COD delegation (HTTP) | ✅ *via intent-first* | |
| Login, lockout, MFA failure, refresh reuse, logout | | ✅ |
| Authorization denials | | ✅ — a denial is a **non-action**; nothing happened to refuse |

**Verified, not asserted:** `verify:audit` forces the audit insert to fail during a tier change and
proves **the tier did not change**.

## D-2 · Three transports, because two was wrong

> **Can this write join a `wi-admin` `ClientSession`? Yes → `auditedTransaction`. No → `auditedAttempt`.**

"No" is broader than jovi-mall. Session revocation lands in **Redis**. And `connections.ts` calls
`createConnection()` twice, so `platform` and `admin` are two `MongoClient`s with two session pools
— **even a direct write to `jovi_mall` is outside a `wi-admin` transaction**, on the same mongod.
That matters at Phase 5 for the two owned blog collections.

`auditedAttempt` commits an `attempted` row **first**; if that write fails, the action is never
performed. A crash in between leaves a **dangling intent** — which ADR-002 D4-a calls "itself a
useful signal", resolved by grepping jovi-mall for the row's `correlation_id`.

Three footguns are handled in the writer and worth knowing before editing it:

- `withTransaction` **re-runs its callback** on a transient error, so the callback contains no Redis
  call and no HTTP call. This is why `destroyAllSessions` **moved after the commit** in
  `applySuspension`, `applyTierChange` and `resetAdministratorPassword` — wrapping them unchanged
  would have left a rolled-back suspension that still signed the target out, twice.
- `Model.create(doc, { session })` is read as a **second document** by some Mongoose versions.
  Always the array form.
- A failed transaction records its `failed` row *outside* any transaction, best-effort — fail-closed
  is already satisfied, and losing that row must not mask the original error.

## D-3 · Retention: exported **and** aged, never either alone

A row leaves the database only when both hold. Implemented by one field and one index:

| Row state | `purge_after` | Outcome |
|---|---|---|
| never exported | **absent** | nothing can delete it, ever |
| exported, older than N | in the past | deleted in the export's own run |
| exported, younger than N | in the future | the TTL removes it at N days |

```ts
AuditLogSchema.index(
    { purge_after: 1 },
    { expireAfterSeconds: 0, partialFilterExpression: { export_id: { $type: 'objectId' } } },
);
```

**A bare TTL does not implement this rule.** It expresses "aged", not "exported and aged"; the
partial filter makes *exported* a property of the **index** rather than of the writer. Two details
are load-bearing: `export_id` and `purge_after` are declared with **no default** (the repo's usual
`default: null` would put the key on every row and make `$exists` vacuous), and the filter tests
`$type` rather than `$exists` so it cannot silently become universal.

`purge_after` derives from **`occurred_at`**, not from export time — retention is a property of the
event. Exporting a row early therefore does not shorten its life. `--restamp` recomputes existing
rows when `ADMIN_AUDIT_RETENTION_DAYS` changes; without it, "configurable" would only be true of
future exports.

**Why a TTL is allowed here when `approval-request.model.ts` refuses one outright** ("a TTL would
quietly erase the record of an attempt"): a row can only enter this index by carrying an `export_id`
pointing at a completed manifest with a sha256 and a row count. **Every vanished row is traceable to
a file.** Remove the partial filter and that argument collapses.

## D-4 · Read scope: Support sees the platform, never the machinery

`audit.read` is granted to **all three tiers**; what each sees is narrowed per row.

```js
// tier 3 only; tiers 1 and 2 add no clause at all
{ $or: [ { subject_class: { $ne: 'internal' } }, { actor_id: <self> } ] }
```

`subject_class` is derived from `target_type` by a frozen, exhaustive map. `internal` covers
administrators, sessions, approvals and exports — so the feed cannot become a side door onto the
administrator directory that `tier-grants.ts` withholds from Support.

**Support does see the COD/money chain**, chosen knowingly: they can *see the record of* a money
action without being able to perform one. No financial permission is granted, so the boot assertion
refusing `financial` to tier 3 is untouched.

> ⚠️ **The single most dangerous line in the module.** The scope is an `$or`, and `matchAnyField`
> returns an `$or`. The `Object.assign(filter, matchAnyField(...))` idiom used everywhere else in
> this service would **overwrite the scope with the search clause** and hand Support the whole
> directory the moment they typed in a search box. `combineFilters` composes them under `$and`;
> `test-audit.ts` asserts both that it does and that the naive form would not.

`audit.export` is **Developer + Admin**, flagged `destructive` — not because exporting destroys
anything by itself, but because it is the **precondition for deletion**. The flag stops
`allInFamily()` sweeping it in and makes the boot check refuse it to Support.

## D-5 · Changed fields only, credentials by name

A row records what **moved** — `before: { tier: 3 }`, `after: { tier: 2 }` — never a document.
ADR-005 D-8's named-field rule applied to storage.

`sanitiseState()` strips credential-shaped fields at any depth, deriving its field set from the
logger's `REDACTED_PATHS` rather than maintaining a second list — the drift this codebase documents
repeatedly. A password reset audits `{ passwordRotated: true }`; the one-time password shown to the
caller never enters a row. Values over `ADMIN_AUDIT_MAX_STATE_BYTES` are replaced by a summary with
`state_truncated: true` — never dropped silently. A cyclic object yields `[CIRCULAR]` rather than
throwing, because under D-1 a throw here would cancel the action being audited.

## D-6 · The denial seam, kept as promised

`recordAuthorizationDenial` keeps its signature, its four call sites and its error-swallowing.
What changed is that `createApp()` calls `installAuditDenialSink()` — the audit module installs
itself through the `setDenialSink` seam that already existed.

The direction matters: **audit depends on authorization, never the reverse.** `denial.recorder.ts`
imports no database, so the bootstrap CLI and every DB-free suite still load the permission guard
without registering a model on a connection they never open, and they keep the log sink by simply
never installing one.

## D-7 · A boot gate, because transactions are an assumption

`assertAuditStoreTransactional()` runs in `startServer()` **before the port binds** and refuses to
start unless `wi-admin` reports a replica set or a mongos. Two plausible configurations break the
subsystem silently without it: `MONGO_URI_ADMIN` carries no `replicaSet=` parameter and works by
driver discovery alone (adding `directConnection=true` while debugging pins single-server topology),
and the blueprint still lists `wi-admin` placement as an open question — a standalone `mongod` would
fail every audited write in production, on the first suspension.

---

## What this also fixed

| | |
|---|---|
| 🔴 **An Admin could enumerate a Developer's live sessions** — IPs and user agents — because `listAdministratorSessions` skipped the `assertMayActOn` that every neighbouring operation runs. The revoke route beside it did check | new `read_sessions` escalation action |
| 🔴 **`req.requestId` was caller-controlled and unvalidated.** Indexed and fail-closed, an oversized `X-Request-Id` would have **refused an administrator's action**, and a caller could collide correlation ids to forge a link to someone else's request | `sanitiseRequestId` |
| **No administrator could change their own password.** Whoever created an account kept a working credential for it indefinitely | `POST /api/v1/auth/password` |
| **The durable session history was written and never read** — nine end reasons recorded since Phase 2, invisible to every endpoint | `?includeEnded=true` |
| **No way to revoke ONE session** of another administrator | `DELETE /:adminId/sessions/:sessionId` |
| `platformClientFor()` — zero callers, and mutated `defaults.headers.common` on the shared Axios instance: a correlation-id race on the very value the trail joins on | deleted |
| `audit.*` said `phase: 7` under a "Phase 3.5" banner; `PermissionSpec.phase` could not express 3.5 | widened and corrected |
| `isInScope` was ticket-shaped behind a generic name and would have answered the audit scope wrongly rather than not at all | renamed `isTicketInScope` |

## Consequences

- **The `admin_audit_log` collection becomes the largest in `wi-admin`**, with nine indexes. Justified
  by read patterns (a few hundred writes a day, read by humans asking arbitrary questions under time
  pressure); revisit the write cost once real volume exists.
- **`ensure:indexes` is now load-bearing for retention.** If it is never run in production the TTL
  silently does not exist and the collection grows without bound. It fails *safe* — no index means
  nothing is deleted, never the reverse — but the compliance story would be wrong.
- **The export file lives on the instance that wrote it.** With more than one instance,
  `ADMIN_AUDIT_EXPORT_DIR` must be shared storage or `/download` will 404. Stated in the controller.
- **Five repository methods now take a required `ClientSession`**, so an unaudited administrator
  mutation does not compile. Two test harnesses open their own transaction to seed fixtures.
- **Phase 5's remaining 73 endpoints inherit auditing** from the gateway wrapper rather than each
  author remembering — which is the whole reason 3.5 was sequenced first.

## Still open

- **`audit.export` is not dual-controlled.** It is the only path to deletion, and a second signature
  is defensible; it was left out to keep a routine compliance job frictionless. Revisit if exports
  become frequent enough to be unexamined.
- **The dangling-intent sweep has no worker.** `findDanglingIntents` exists and the index backs it;
  nothing runs it on a schedule. Phase 7 (ops surface) is where that belongs.
- **No alerting.** `administrators.auth.refresh_reuse_detected` is the highest-value row in the log
  and currently only sits in a table.

---

## Addendum — Phase 12 (2026-08-11)

Phase 12 completed this subsystem's coverage and made it enforceable. Full record:
[ADR-012](./ADR-012-AUDIT-COMPLETION.md) — numbered 012 rather than 011 because
`ADR-011-ACCOUNTS-AND-FINANCE.md` is Phase 11's, the same rule ADR-010 applied against
ADR-009. Three things in *this* document turned out to be wrong and are corrected here,
because a reader arrives at this file first.

### 1. `audit.export` and `audit.purge` were catalogued `wi_admin_txn`, and could not be

D-1's "the row and the change commit in one transaction" was applied to these two by
reflex. It does not fit either:

- `runExport` streams a cursor to an NDJSON file, `fsync`s and renames it. That is minutes
  of wall time and a filesystem side effect — neither belongs inside a Mongo transaction,
  and `withTransaction`'s retry would re-run the whole export.
- `purgeExpired` is a single unbounded `deleteMany`. Wrapped, it would breach the 16 MB
  transaction entry limit and `transactionLifetimeLimitSeconds` at any real trail size.

Both are now `external` + `auditedAttempt`, and the purge deletes in bounded batches.
For a *deletion*, intent-first is the better property anyway: a crashed purge leaves a
dangling intent naming what it was about to remove, rather than silence.

The general rule D-2 states is unchanged and still correct. What was wrong was the
assumption that "this service's own database" implies "fits in one transaction". Size and
duration are the second question, and the catalog is where it gets answered once.

### 2. Both were declared and never written

They were listed in the catalog from day one and no code produced them, so the ADR's claim
that "both are audited" was aspirational for the whole of its life. So were the five
`approvals.*` actions — the entire dual-control decision path. `recordQueued()` was written
for the 202 in this phase and had **no call site at all** until Phase 12.

That is what motivated `assertAuditCoverageComplete()`'s reverse check: every catalogued
action must now name a producer at boot, so a declared-but-unwritten action fails startup
instead of looking finished.

### 3. `recordDenial` hardcoded `sensitive: false`

The row it hand-builds bypasses `toAuditRow`, and `sensitive` was a literal. A denial of an
`escalation` or `financial` permission — the single most interesting row a security review
reads — was therefore filed as not sensitive, which is backwards. It is now derived from
the refused permissions' own flags. `recordDenial` still cannot route through `toAuditRow`:
that function resolves `spec.transport` via `auditSpec(action)`, and `permission.denied` is
not catalogable (the family assertion in D-4's neighbourhood requires a real
`PermissionFamily`, and `permission` is not one). The shared body is `denialRow()`.

### Also corrected

`AuthorizationDenial` gained `userAgent` — the field was hardcoded null on every denial row
because the interface had nowhere to carry it. And this document's "four call sites" for
`recordAuthorizationDenial` was three: the middleware's two guards share one.
