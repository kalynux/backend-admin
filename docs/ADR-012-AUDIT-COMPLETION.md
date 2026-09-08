# ADR-012 — Audit completion and enforcement

**Verified against source on 2026-09-08** — the two boot assertions it adds, at `src/api/audit-coverage.ts` and `src/app.ts:158`, and the seven `/audit` routes against the live manifest. Every route, error code, permission and audit action this page names was re-checked against the live route manifest and the four registries — `permission.catalog.ts`, `audit.catalog.ts`, and both services' `error-codes.ts`. ⚠ **This is a dated design record.** Its *Context* sections describe what PHASE-0 or the phase found **at the time** and are correct as history, not as a description of the service today; where a decision is still the live rule it says so at its own D-item.

**Status:** accepted · **Implements:** the Phase 12 brief ("implement or integrate a proper
audit system") · **Amends:** [ADR-006](./ADR-006-AUDIT.md), whose Phase 12 addendum records
the corrections · **Follows:** [ADR-003](./ADR-003-GRANULAR-PERMISSIONS.md) (the enforcement
pattern this copies), [ADR-004](./ADR-004-DOMAIN-OWNERSHIP.md) (the read/write split the
shim obeys)

> Numbered **012**, not 011: `ADR-011-ACCOUNTS-AND-FINANCE.md` is Phase 11's.

---

## Context

The brief asks for an audit system covering nine categories of administrative action, each
row identifying actor · action · resource · resource id · timestamp · result · safe metadata
· request context, with no secrets in metadata.

**A working audit subsystem already existed** (ADR-006, Phase 3.5), and its record model
already satisfied every field the brief lists. So the question was not "build one" but "is
the one we have actually doing the job", and the answer had three parts.

### 1. The most sensitive control on the service recorded nothing

`dual-control/domain/approval.service.ts` imported no audit writer. All five catalogued
`approvals.*` actions had **zero producers**, and `recordQueued()` — written for the 202 in
Phase 3.5 — was the only exported writer function with no call site anywhere in the repo.

The action an approval *performs* was audited and carried `via_approval_id`. The **decision**
was not. So the trail said "Y changed this tier" and never "Y approved X's request to" — and
a rejection or a withdrawal, which perform nothing, left no trace at all.

### 2. The audit subsystem did not audit itself

`audit.export` and `audit.purge` were catalogued from Phase 3.5 and written by nothing.
`purgeExpired` is the only code path in the service that **deletes an audit row**, and it
recorded a `logger().warn`. `restampRetention` — which moves the deletion date of the entire
archive — was neither catalogued nor recorded.

### 3. Nothing could have noticed either of these

`RouteDefinition` carried no audit field. There was no assertion relating the catalog to the
code. Authorization on this service is enforced by construction — a required `access` field,
a boot assertion, a source scan — and auditing was enforced by remembering, which is the
exact failure mode `route-manifest.ts`'s own header warns about:

> "Authorization that is attached by remembering to attach it is authorization that is
> eventually forgotten."

Two of the brief's nine categories — **configuration changes** and **developer tool
execution** — had no surface at all. Seven `developer_tools.*` permissions had been in the
catalog since Phase 3, flagged `destructive`, tier-1-only, attached to nothing.

---

## Decision

### D-1 · A mutating route cannot compile without saying what it records

`RouteDefinition` becomes a discriminated union on `method`. `audit` is **required** on
`post|put|patch|delete` and optional on `get`.

```ts
export type RouteDefinition =
    | (RouteDefinitionBase & { method: SafeMethod;     audit?: RouteAudit })
    | (RouteDefinitionBase & { method: MutatingMethod; audit: RouteAudit });
```

Four declaration kinds, each earning its place against a real route:

| Kind | Meaning | Why it exists |
|---|---|---|
| `records(...)` | emits ≥1 of these on every 2xx | the default |
| `mayRecord(...)` | may emit nothing on success | `POST /auth/refresh` records only reuse detection; `PUT /:id/tier` is idempotent when the tier already matches |
| `dynamicAudit(reason)` | not knowable from the route | `POST /approvals/:id/approve` performs whatever was queued |
| `noAudit(reason)` | records nothing, allowlisted | `NO_AUDIT_ROUTE_ALLOWLIST`, mirroring `PUBLIC_ROUTE_ALLOWLIST` |

**`NO_AUDIT_ROUTE_ALLOWLIST` is empty**, and that is the finding rather than an oversight:
all 66 mutating routes map to a catalogued action.

#### Optional on a read, not forbidden — and the exception is real

The obvious rule is "reads are not audited" (ADR-006 D-5 records what MOVED). It holds for
all but one route: `GET /money/payouts/:payoutId/destination` reveals a beneficiary's account
number, and Phase 11 built its audit row as the *control* — the intent commits before the
digits are read. So the axis is not read-versus-write but "did something happen the trail
should hold", and forbidding `audit` on a GET would have made that endpoint undeclarable.

### D-2 · Three layers, matching authorization exactly

1. **The type** — a mutating route without `audit` does not compile.
2. **`assertAuditCoverageComplete()`** at boot, beside the four existing assertions. Five
   checks: every declaration present; every `noAudit` allowlisted; every named action in the
   catalog; **permission coherence** (a route may only claim actions its own permission
   governs); and the reverse check below.
3. **A source scan** in `test-authz.ts` — mutating-method count vs `audit:` count per file.

#### The reverse check is the one that would have caught this phase's bugs

> Every entry in `AUDIT_ACTION_NAMES` must have at least one producer — a route declaration,
> or an entry in `audit.producers.ts` naming a non-route producer.

`approvals.*` and `audit.*` were declared and produced by nothing for two phases. A
declared-but-unwritten action now **fails boot**.

`audit.producers.ts` is a maintained claim, not a check — nothing verifies the named file
really writes the named action. That is stated in its header, because it is the one way a
genuinely unwired action could hide from this assertion.

#### What the declaration proves, and what it does not

A declaration is a promise checked three ways. It does **not** prove a row was written — the
writer call is deep in a service, and a handler could return 200 having recorded nothing. It
closes the *design* gap (nobody decided) and the *coverage* gap (nobody produces); the
runtime probe is the smoke detector for the *implementation* gap, and never a lock: by the
time it can know, the response is sent.

### D-3 · Two transports were wrong, and nothing had exercised them

`audit.export` and `audit.purge` were `wi_admin_txn`. Neither fits in a transaction — an
export streams a cursor to disk for minutes, and a purge is an unbounded `deleteMany` that
would breach the 16 MB entry and 60 s lifetime limits at real volume. Both are now `external`
(intent → outcome), and the purge deletes in bounded batches.

For a **deletion**, intent-first is the better property anyway: the row naming what is about
to be removed commits before anything goes.

### D-4 · Dual control is audited at the decision, not the handler

`approve`/`reject`/`withdraw` wrap the **claim** — `resolveIfPending`, which now takes a
required `ClientSession` — so the decision and its row commit together. The handler stays
outside: it opens its own transaction, and nesting an arbitrary domain write (and, for a
delegated action, an HTTP call) inside a `withTransaction` callback that re-runs on conflict
is the footgun ADR-006 D-2 already records.

`expireOverdue` becomes bounded (50/sweep) and throttled
(`ADMIN_APPROVAL_SWEEP_MIN_INTERVAL_MS`) per-row CAS transactions, because it runs on a
**read** path. A new `{ status: 1, expires_at: 1 }` index backs it; the existing
`{ status, created_at }` did not.

**`approvals.requested` was deleted rather than wired.** Phase 11's `auditedQueue` already
records the *queued action itself* at `status: 'queued'`, re-targeted at the approval — that
row says who asked, for what, naming the act. A second row would say the same thing twice and
make every queued action appear twice in a count.

### D-5 · Build the two missing surfaces, gated twice

`/api/v1/system` (four reads) and `/api/v1/dev-tools` (feature flags + three tools).

**Feature flags live in wi-admin**, so a flip and its audit row commit together. They are a
closed catalog like the permission and audit catalogs, and each names its single consumer —
a flag with no consumer is dead config that reads as live policy.

> **jovi-mall does not read them, and this phase did not make it.** Doing so needs either a
> wi-admin connection there (inverting ADR-004's one-way dependency) or an HTTP call in a
> direction that exists nowhere today. A platform-wide flag is a cross-service config
> contract with its own cache, invalidation and failure mode — a phase, not a field. Despite
> `developer_tools.feature_flags.set` being summarised "for the whole platform".

Every tool is behind **two** gates: a tier-1-only `destructive` permission, and
`dev_tools.enabled`, which is **off by default**. A capability that re-runs side effects
against live data should not be reachable merely because it was built.

`GET /system/config` is built by **naming** keys, never spreading `env()`, and
`assertExposedConfigSafe()` re-checks at boot. Its rule matches a credential token
**anywhere** in the name, not as a suffix — `MONGO_URI_ADMIN` ends in `_ADMIN` and an
end-anchored rule waves it through. That was caught by the test, not by review.

**`developer_tools.webhooks.redeliver` gets no route and no action.** Every `/webhooks/*`
mount in jovi-mall is inbound; there is no outbound delivery record to redeliver, and the
only outbound mechanism is the tracking outbox, which `outbox.replay` covers. The permission
stays, naming its missing prerequisite — an endpoint whose subject does not exist is worse
than an unused permission.

### D-6 · The legacy surface gets a shim, written where the actions happen

Until cutover the dashboard still calls **37** unported admin endpoints on jovi-mall, and
those actions were recorded nowhere.

**Rejected: wi-admin proxying them** (that is the cutover, early and without the rest of it),
and **jovi-mall POSTing rows to a wi-admin ingest** (inverts the dependency direction and
creates a way to author audit rows over HTTP — destroying the property that
`audit.writer.ts` is the only writer).

**Chosen:** jovi-mall writes `admin_action_log` in its own database; wi-admin reads it over
the direct-read path ADR-004 already sanctions and serves it at `GET /api/v1/audit/legacy`.

Three properties are load-bearing:

- **Complete by construction.** One `router.use('/admin', …)` registered *before* the twelve
  `/admin*` mounts covers all of them by prefix — including endpoints added later. It does
  not match `/internal/admin/*`, so wi-admin's delegated calls are not double-counted.
- **The middleware never stores a request body** — only `Object.keys(req.body)`. The legacy
  surface accepts KYC documents, ticket bodies and delivery codes; a redaction list over
  that is a list somebody must keep complete forever against endpoints nobody is porting.
- **The actor is legible, never mapped.** These are `jovi_mall` `users` rows with
  `role: 'admin'` — not wi-admin administrators, who hold no `users` row at all (ADR-004
  D-1). `actor_kind: 'platform_admin_user'` deliberately does not exist in wi-admin's
  vocabulary, and the DTO labels it "Legacy admin session (jovi-mall)".

The existing `console.log` stub — the one `IMPLEMENTATION-BLUEPRINT.md` §5 cites by name as
the cautionary tale — became the adapter, so this was one edit rather than fourteen. Only
`actor.role === 'admin'` persists; the other twelve call sites are self-service profile
writes and would have made this an unbounded platform event stream.

**Its TTL is unconditional**, unlike `admin_audit_log`'s export-gated one. This is not the
compliance record: it is a stop-gap in a database wi-admin does not own, with no export
manifest to point a vanished row at. Which is exactly why it must never be treated as one.

---

## Consequences

- **A catalogued action with no producer fails boot.** The single most valuable line in this
  phase, and the one that makes the Phase 3.5 class of bug structurally impossible.
- **`resolveIfPending` and `clearMfa` join the required-`ClientSession` set**, taking it from
  five methods to six plus the approval repository's two.
- **The expiry sweep opens transactions on a read path**, bounded and throttled. Watch it
  under a busy approvals queue.
- **`workers.trigger` has no cross-instance lock.** In-process mutex only; with more than one
  jovi-mall instance two administrators can run one sweep concurrently. Written into the
  registry header rather than left to be discovered. A Redis lock is the follow-up.
- **`admin_action_log` is unbounded until `migrate:admin-action-log` runs.** jovi-mall has no
  `ensure:indexes` habit, and `autoIndex` failing is silent — the highest-probability
  operational miss here.
- **Feature-flag changes converge across instances within `ADMIN_FEATURE_FLAG_CACHE_MS`.**
  A flag is config, not a circuit breaker; anything needing an instant kill needs a different
  mechanism.

### A security bug fixed in passing

`POST /auth/mfa/activate` verified its six-digit code **in the controller**, outside any
service: a wrong code threw a bare 401, counted toward no lockout and recorded nothing.
`completeMfa` — the same digits against the same secret, one step later in the same flow —
counted every failure and recorded `mfa_failed`.

An attacker holding a stolen mid-enrolment session could brute-force activation without limit
and without leaving a trace. The verification moved into `admin-auth.service.ts#activateMfa`,
which is what makes the two paths share the lockout counter.

`test-audit.ts` pins the shape that fixed it: the check lives in the service, and the
controller no longer verifies codes at all.

## Still open

- **No alerting.** ADR-006 said this of `refresh_reuse_detected`; it is now equally true of
  `administrators.mfa.reset`, `audit.purge` and every `developer_tools.*` row. The trail
  records them and nothing watches it.
- **The dangling-intent sweep still has no worker.** `GET /system/health` now *reports* the
  count — the first consumer `findDanglingIntents` has ever had — but nothing resolves them.
- **`audit.export` is still not dual-controlled**, unchanged from ADR-006.
- **The runtime probe is per-instance and advisory.** It logs `fatal`; nothing aggregates it.
