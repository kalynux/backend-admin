# ADR-015 — Developer tools

**Phase 15.** Status: implemented. Builds on ADR-014; amends ADR-009 §D-2 (narrowly, and in the
open — see D-5).

---

## Context

The brief asked for developer-only APIs — diagnostics, service health, **logs**, queue inspection,
cache inspection, integration diagnostics, background-job information, safe system utilities —
each behind a dedicated permission, never exposing credentials, with dangerous operations
requiring explicit permission, strong validation, audit logging and safe execution boundaries, and
**no arbitrary server command execution**.

Phase 14 had already built most of that list. So this phase is the four things ADR-014 named and
did not build, plus the one bullet with no precedent anywhere:

- **Logs.** jovi-mall had *no logging library at all* — 1268 `console.*` calls, stdout only, no
  levels, no redaction, no store, nothing queryable. wi-admin's `core/logging/logger.ts` header
  records what that costs: a **refresh token** written to stdout on every silent refresh.
- **A jovi-mall runtime-config read**, which ADR-014 called "the natural follow-up".
- **Request tracing.** `req.requestId` existed and was mounted first, but only the error handler
  read it.
- **Cache and database inspection.** There was a flush verb and no read.

Shape of the result: **five new reads, one new write, one new subsystem, four bug fixes, three
named debts.** That ratio is worth stating — a diagnostics phase that grew a lot of dangerous
verbs would have misunderstood itself. The one new dangerous verb is
`POST /dev-tools/outbox/prune`. Everything else observes.

---

## D-1 · The logging subsystem, and why the console bridge is worth its risk

**Decision: pino with derived redaction, a bounded ring buffer, a capped Mongo collection for
warn+, and a boot-installed `console.*` bridge with a kill switch.**

### The bridge

~565 `console.*` call sites live in `src/`, **311 of them `console.error`**. Those are precisely
the lines the phase promises will survive the restart you go looking for them after — so without
a bridge, the sinks would never see the output that matters most. A codemod over 565 sites, in a
repo with a part-applied agent-contract refactor, is an unreviewable diff and a merge-conflict
generator.

It is sold as **capture, levels, correlation and structured stacks — never as a security
control.** The redaction it delivers is the scrubber's, which is heuristic. Three conditions are
enforced in code, not documented as intentions:

1. **Installed explicitly from `server.ts`**, never as an import side effect. A module whose
   import silently rewires `console` is the version of this idea that is too clever.
2. **`LOG_CONSOLE_BRIDGE=false` restores native behaviour** with no code change.
3. **Only the five level-shaped methods.** `console.table`/`dir`/`trace` stay native, and
   `test:system` asserts it so nobody "completes" the set later.

Recursion is stopped twice: the original methods are captured at *module load* of
`sink-guard.ts` (so a sink reporting its own failure cannot report into the thing that is
failing), and a module-level reentrancy flag drops any nested sink call.

**`pino.multistream`, not `transport`.** They are mutually exclusive, so wi-admin's
`transport: {target: 'pino-pretty'}` could not be copied here — attempting it fails at logger
construction. pino-pretty is used as a *stream* in development, and the sinks run on the main
thread where they cannot be stranded in a transport worker at exit.

**Accepted limitation, measured in a real boot:** module-**import**-time logging still bypasses
the bridge. `import { app } from './app'` is hoisted above `initLogging()`, so a handful of
gateway-constructor warnings (`[MyCoolPayGateway] … not configured`) reach the native console.
Fixing it means a side-effecting import before `./app`, which condition 1 exists to forbid. The
trade is deliberate: all *runtime* logging is bridged.

### Redaction is two layers and only one is a boundary

`REDACTED_PATHS` is exact, operates on object keys, and is **derived** from
`core/audit/redact.ts`'s `SENSITIVE_FIELD_NAMES` — so it inherits the cross-service drift test
wi-admin already runs, instead of becoming a third copy that rots.

> ⚠ The derivation filters to `/^[a-z0-9_]+$/`, and that filter is load-bearing rather than tidy.
> That set deliberately carries two bracketed **path fragments** (`headers["x-service-token`)
> which exist only so the cross-service name comparison lines up. They are not valid pino paths,
> and pino **throws at construction** on an invalid path — an unfiltered spread would take the
> process down at boot, in production.

`scrub.ts` is the second layer and its header says what it is: **a net, not a boundary.** It
matches JWTs, `Bearer`/`Basic` values, prefixed provider keys (keeping the `sk_live_`/`sk_test_`
prefix, which ADR-014 D-2 already established is the useful leak-free fact), URI userinfo, named
`key=value` pairs and PEM blocks. It deliberately does **not** match bare long hex: 24 chars is an
ObjectId and 64 is an upload fingerprint, both of which this service logs legitimately, and a
scrubber that mangles ordinary output is one an author works around.

Two properties are pinned by tests because both were violated by the first implementation:
**idempotence** (the field rule grew one `]` per pass) and **the scheme surviving**
(`Authorization: Bearer [REDACTED]`, not `[REDACTED] [REDACTED]`).

The scrub runs in pino's `hooks.logMethod`, not in the bridge — otherwise a hand-written
`logger.info('token ' + tok)` is unscrubbed, and those are exactly the sites a future author
writes *because* the logger now exists.

---

## D-2 · Capped, not TTL — and the trap that forced the raw driver

**Decision: a capped `system_logs` collection, written through the raw driver, with no Mongoose
model.**

Capped rather than TTL, in weight order:

1. A capped collection has a **hard byte ceiling**. A TTL bounds by *age*, so an error storm
   inside the window is unbounded — precisely the incident in which you least want the log
   collection filling the volume that holds `orders`.
2. TTL deletion is a best-effort 60-second background thread. Under load it falls behind, so the
   bound is soft exactly when it matters.
3. TTL deletes are ordinary deletes — oplog, index churn, replication traffic — generated on the
   platform's error path. Capped eviction is an in-place overwrite.
4. **Insertion order is time order**, so the read is a `$natural` reverse scan needing no time
   index at all.

**Cost, stated: a capped collection cannot be resized without dropping it.**
`LOG_MONGO_CAP_BYTES` (256 MB) is a one-way door and must be treated as a migration.

> **Why there is no Mongoose model.** Mongoose's `capped:` option applies only when Mongoose
> itself creates the collection — and `autoIndex` will happily create it **first, uncapped**, as
> a side effect of building an index, the moment the connection opens. Since the collection
> cannot be converted afterwards, that failure would be permanent and silent. The raw driver
> removes the race rather than sequencing around it.

**Exactly one secondary index, `{requestId: 1}`**, and deliberately none on `at`: `_id` is indexed,
natural order is time order, and every further index is write amplification on the hottest write
path in the process.

**Five layers stop the sink becoming the incident** — `writeConcern: {w: 0}`, a throttled
diagnostic to the *captured original* console, a bounded in-flight set that drops rather than
queues, a circuit breaker after 20 consecutive failures, and never writing while
`readyState !== 1`. A logger that throws while logging an error turns a diagnosable failure into
an undiagnosable one.

`LOG_PERSIST_LEVEL` is **clamped at `info`**: `debug` persistence turns the cap over in minutes and
evicts exactly the errors the collection exists to keep. The clamp protects the feature from its
own configuration.

---

## D-3 · `developer_tools.logs.read`, not `system.logs.read`

**Decision: all four new permissions live in the `developer_tools` family.**

A log line is free text and can carry personal data — an email in an SMTP failure, a phone number
in a WhatsApp send error, an address in a geocoding warning, an order id, an amount. The scrubber
removes credential *shapes*, never personal data, and deliberately so: redacting all PII from free
text would destroy the endpoint's reason to exist.

`tier-grants.ts:141` gives tier 2 `allInFamily('system')`. So a `system.*` name would reach the
Admin tier — and **an unfiltered feed of every warning in the platform is a broader disclosure
than any individual `*.read` an Admin holds, because it is not scoped by subject and cannot be.**

The family is the *mechanism*, not a label: `assertGrantTableValid()` already refuses any
`developer_tools.*` permission to any tier but 1, so tier-1 confinement comes from an existing
boot assertion rather than a new rule. The alternative — `system.logs.read` flagged `destructive`
to keep `allInFamily` off it — would be a lie about what `destructive` means (a read destroys
nothing) and would rest on a flag rather than a family check.

| permission | why it is its own |
|---|---|
| `developer_tools.logs.read` | free text, unscopeable by subject |
| `developer_tools.database.inspect` | the whole collection map, index topology and row counts — shape, not health |
| `developer_tools.cache.inspect` | **looking is not clearing**; one permission for both would mean an operator who may inspect may also delete |
| `developer_tools.outbox.prune` | `destructive` — it deletes rows permanently |

`test:devtools` asserts that `allInFamily('system')` contains none of them. That single assertion
is what stops this decision being quietly reversed.

**Not audited.** A log search is diagnostics and high-volume by nature; auditing it would flood
the trail with rows saying nothing about what anybody *did* — the same argument
`NO_AUDIT_ROUTE_ALLOWLIST` makes about read receipts. The honest counter-argument (a tier-1
operator could trawl for customer data) is bounded by the fact that the same person can read
`jovi_mall` directly.

`tier-grants.ts` needed **no edit**: tier 1 is derived from `PERMISSION_NAMES`. Worth writing
down, because a reader will expect to have to touch it.

---

## D-4 · The config read: a whitelist, a boot assertion, and one honest omission

**Decision: `EXPOSED_CONFIG_KEYS` built by naming keys, `FORBIDDEN_CONFIG_TOKEN` byte-identical to
wi-admin's, asserted at boot.**

The obvious implementation — return everything and delete the secrets — is the wrong way round:
it is open by default, and the day somebody adds a `*_API_KEY` to a config module it appears on
the endpoint without anyone touching the whitelist. jovi-mall reads **144 distinct environment
variables, at least 28 of them credentials.**

The regex is byte-identical to wi-admin's on purpose — two regexes for one job is how one of them
ends up weaker. `test:system` drives it against a hand-listed set of jovi-mall's **real** credential
variable names, which stays useful as the whitelist grows in a way that "the current list passes"
does not.

**`SMTP_USER` is the deliberate omission the assertion cannot catch.** It matches no forbidden
token and no sensitive leaf name, yet it is half a credential. Its absence is a human decision,
and that is the honest demonstration that **the whitelist is the control and the regex is only the
backstop**. `SMTP_HOST`/`SMTP_PORT` are out for a second-order reason: they are not sensitive, but
listing them puts an obvious blank next to `SMTP_USER` and invites the next author to complete the
set.

**No URLs at all**, and a derived `wiring` block instead. The token rule refuses every
`*_URL`/`*_URI`, which is correct — but it would leave a real gap ("is the dispatcher pointed at
anything"). That gap is filled by deriving the answer from the six "is this configured" predicates
Phase 14 already surfaced, plus the Stripe key *mode*. Better than exposing base URLs, not merely
safer: it is the answer an operator actually wants and it is structurally incapable of carrying a
password.

**`set: false` is not `value: null`.** There is no central validated config object in this service;
almost every key has a compiled-in default. A bare null would read as "this sweep has no schedule"
when it means "the default applies". `/config` says what is *configured*; `/system/workers` says
what is *in force*.

---

## D-5 · geo-tracker: a service-level ops door, and ADR-009 §D-2 amended in the open

**Decision: wi-admin reads geo-tracker's `/healthz`, `/readyz` and `/metrics`. Nothing else.
geo-tracker source is not modified.**

> ⛔ **AMENDED 2026-08-22 by [ADR-020](ADR-020-ADMIN-DATA-DOOR.md).** *"Nothing else"* held for
> three phases and no longer does: geo-tracker gained a service-caller authorization path and
> wi-admin reads four `/internal/*` endpoints through it, gated by a configured scope model and
> audited fail-closed. **This decision was not used as the precedent** — the paragraph below
> designed it *not to be one*, and a separate decision was taken instead, which is the outcome
> that paragraph was aiming for.
>
> Three things here survive unchanged and now govern **both** doors: the ops path set stays a
> closed literal of three, the two clients are **separate files with separate base-URL
> variables**, and *the hard rule below is the rule for the data door too*. `test:devtools`'s
> scan was widened in that change — its regex matched `geo-tracker\.client`, which does not match
> `geo-tracker-data.client`.

ADR-009 §D-2 says wi-admin has no geo-tracker door, because every geo-tracker **data** read needs
a real jovi-mall user JWT and resolves per-agent visibility by calling `/api/tracking/visible-agents`
*as the viewer* — which does a `findById` on `users`, and an administrator deliberately has no
`users` row.

Those three paths are different in kind: no identity, service-level, and **no agent position, no
trail, no session content**. So D-2 now reads as *"wi-admin has no geo-tracker **data** door"*,
with this as the named exception. Stated as a numbered decision rather than a footnote, because
the next person who wants "just one more geo-tracker endpoint" will cite it, and the citation
should land on a stated boundary.

**A new route, not a block inside `/dependencies`**, for two reasons: `/dependencies` is a pure
passthrough of jovi-mall's shape and merging a locally-fetched block would invent a shape only
wi-admin knows (the argument ADR-014 D-3 makes against forwarding prom-client's raw JSON); and it
would mix two failure domains — jovi-mall being down would 503 the whole read and take the
geo-tracker answer with it, when "is geo-tracker still up" is exactly what you want during a
jovi-mall incident.

**Parse the Prometheus text, do not pass it through.** `/api/v1` is JSON throughout; a passthrough
is an unbounded buffered body; and parsing lets us apply a closed `GEO_TRACKER_METRIC_ALLOWLIST` —
ADR-014 D-3's explicit-projection rule applied a second time. **The trade, stated:** a new
geo-tracker instrument is invisible here until the allowlist learns about it.

### The hard rule: never a readiness dependency

ADR-014 D-1's coupled-failure amplifier is one `Promise.all` away, and it is the mistake that
would look like a tidy-up in review. Three layers:

1. not called from `/health/ready`, and `SystemController.health`'s `Promise.all` gains no fourth
   entry;
2. **the client returns a result object and never throws** — stronger than remembering not to
   call it, because a non-throwing client cannot propagate a failure however it is wired;
3. a source-scan assertion in `test:devtools`, landed in the same commit as the client.

The client lives in `infra/geo/`, deliberately **not** `infra/platform/` and deliberately not
reusing `platformRequest`: folding it in would put a geo-tracker call one typo away from carrying
`X-Service-Token`, a credential scoped to a different service with a different blast radius.

---

## D-6 · Cache inspection drops two of the flush's guards, on purpose

**Decision: `resolveInspectPlan` shares `cache-flush-policy.ts` with `resolveFlushPlan`, keeps the
escaping, and drops `confirm` and the whole-DB refusal.**

Kept: addressed **by name** from the same closed list, prefix escaped with the `*` appended by us,
`prefix: "*"` refused rather than silently escaped, limit clamped.

Dropped, and each omission is a decision:

- **No `confirm`.** Requiring an operator to type `SLOT_LOCK_DB` in order to *look* trains
  reflexive confirmation-typing, which is exactly what hollows out the guard on the path that
  deletes. The ceremony must stay attached to deletion or it stops meaning anything.
- **No whole-DB refusal.** Listing an entire destructive database is fine; clearing one is not.

`test:system` pins both, so they read as decisions rather than oversights.

**`peekRedisClient`, not `getRedisClient`.** ADR-014 D-1's rule is *a probe observes; it does not
provision*, and this is a probe. The flush's exception ("the database may legitimately have been
opened by another instance") does not transfer: a listing served from a connection minted for the
listing is precisely the probe that changes what it measures. With no open client it returns
**200** with `available: false`.

**Values are never returned, and there is deliberately no single-key read.** A
`GET /cache/key?name=…` would be a disclosure oracle for download tokens, WhatsApp idempotency
keys and verification codes — exactly the three databases the policy calls destructive.

---

## D-7 · Index drift is the read that earns the phase

**Decision: compare declared indexes against live ones; report, never repair.**

`autoIndex` is on and **a failed index build fails silently at boot** — several model headers say
so, and so does CLAUDE.md. Until now the only detector was `verify:live-parity`, over a handful of
models, and only when somebody ran it. A missing unique index does not throw; it lets a duplicate
through, months later, in a collection nobody watches.

The canonical shape is deliberately **narrow** (key with order significant, `unique`, `sparse`,
`partialFilterExpression`, `expireAfterSeconds`). `background`, `v`, `2dsphereIndexVersion`,
generated names and default collations differ harmlessly on almost every index, and **a noisy
report is worth less than no report** because it also carries the ones that matter. `_id_` is
never reported: one guaranteed false positive per collection.

Key **order** is part of an index's identity — `{a,b}` and `{b,a}` have different prefix behaviour,
and sorting before comparing would report "no drift" for a genuinely missing index, which is the
worst failure this endpoint can have.

**Nothing writes.** A unique index build fails outright on a collection that already holds
duplicates, and a large build on a primary is an availability event. Reporting is the useful 90%.

Stats come from `$collStats` (`collection.stats()` was removed in driver 6), bounded by a wall
clock that reports `notReached[]` — 182 collections × 2 commands is real work on a primary.

---

## D-8 · "No arbitrary server command execution", enforced rather than honoured

**Decision: a negative source scan and two positive allowlists.**

The brief's last line was previously satisfied only by nobody having written a shell-out.

**Negative half** — a comment-stripped scan over `modules/system/**`, `modules/dev-tools/**` and
`core/logging/**` for `child_process`, `exec*`, `spawn(`, `eval(`, `new Function(`, `$where`,
`$function`, `$accumulator`, `mapReduce`, `sendCommand(`, `FLUSHALL`, `FLUSHDB`.

> **Stripping comments first is not a detail.** `FLUSHALL` and `KEYS` appear in this codebase only
> inside the doc comments that *document the ban on them*. A naive scan fails on precisely the
> files that get it right — and the first run of this suite proved it, plus a second time when a
> `.throw`-matching regex fired on the word "re**throw**n" in a comment.

`.command(` cannot simply be banned — `probeMongoServerDetail` legitimately issues
`db.admin().command({serverStatus: 1})`. The rule that bans a passthrough while permitting a named
call is that **the argument must be an object literal, never a variable**, asserted by comparing
two match counts.

Redis's `KEYS` is banned **precisely** rather than by substring, after the naive token fired on
`EXPOSED_CONFIG_KEYS` and `WORKER_KEYS`. A ban that cries wolf on ordinary identifiers gets
deleted by the next person to hit it, taking the real protection with it.

**Positive half — this is what actually enforces:**

1. `domain/redis-command-policy.ts` holds a closed `REDIS_READ_COMMANDS` list and a
   `runReadCommand` helper; the inspection service contains **no direct client call outside it**.
   This is `route-group.ts`'s "the allowlist *is* the cap" applied to Redis: a cache inspector is
   exactly one convenience away from `sendCommand(req.body.args)`.
2. Collection names come from the **frozen `COLLECTIONS` registry** as a `z.enum`, never from the
   request, and the `$collStats` pipeline is a literal.
3. No file under `modules/system/**` declares a mutating route — making that router header's
   existing sentence enforced rather than aspirational.

---

## D-9 · Four bugs fixed on the way, and why these four

**`probeSmtp()` never worked.** It duck-typed for a `verify()` through an `unknown` cast against a
method **no provider defined**, so `?probe=smtp` returned `status: "error"` on every call — while
`api-doc/admin/system.md` advertised it as the one genuinely safe probe. **The duck-type WAS the
bug**: it turned a missing method into a runtime failure instead of a compile error. `verify()` is
now a required member of `IMailProvider`, so a provider added later cannot repeat it. Verified
live: `status: "ok"`, 1638 ms.

**Worker metrics were declared and never incremented.** All five instruments had zero call sites,
so `worker_last_success_timestamp_seconds` — `metrics.ts` calls it "the single most useful worker
signal" — was permanently empty and the documented staleness alert could not fire. Instrumented at
four sites rather than twelve: every manual trigger, plus `tracking-dispatch`, `assignment-sweep`
(ADR-014 D-6 calls its silent death the most operationally urgent condition in the service) and
`earnings-release` (money). The remaining nine scheduled paths are a named debt, and
`api-doc/admin/system.md` now states the coverage instead of implying all five were populated.

**`mongo_operation_errors_total` and a doc that was worse than the gap.** The api-doc claimed the
counter covered "query errors caught by a schema-level post-hook". No such hook exists anywhere in
`src/`, and `recordMongoError` had zero call sites — so the counter was not under-reporting, it
was **permanently zero** while the doc warned only of partial coverage. The doc is corrected and
the connection-level half is wired. The query-level half needs a global Mongoose plugin registered
before the first `model()` call, across 182 models: a bootstrap-ordering change that does not
belong in a diagnostics phase.

**The invisible thirteenth cron.** `initAggregationScheduler()` called `cron.schedule` and
**discarded the returned task handle** — no inventory entry, no `stop()`, a hardcoded schedule
(the exact duplicated-fact defect ADR-014 D-8 fixed for the other ten), and, the part nobody had
noticed, **no `maintenanceBlocksWorkers()` guard**: a full-table sweep over every active vendor ran
happily inside a `down` window. Now an `ObservableWorker` with a derived schedule and the guard at
its tick site. `GET /dev-tools/workers` is frozen in *field set*, not length.

---

## What this phase did not build

- **A wi-admin log surface.** It has pino and no sinks — a strictly smaller version of this same
  work. `/api/v1/system/logs` is reserved for it, which is half the reason the platform's read
  took a `/platform/` segment.
- **Index repair.** See D-7.
- **The global Mongoose error plugin.** See D-9, including its bootstrap-ordering constraint.
- **A graceful-shutdown path.** Wiring `closeRedisClients()` alone would be *worse* than leaving
  it: it closes Redis while requests are in flight and while the 2-second dispatcher is still
  firing, converting a clean container stop into a burst of connection errors. A proper sequence
  now has a **new participant** — the log sink's in-flight writes — which strengthens the case for
  doing it properly rather than piecemeal. The one piece taken here is the sink's own 1-second
  best-effort flush on `SIGTERM`, explicitly labelled as *not* the graceful shutdown.
- ~~**The cron overlap guard.** ADR-014's decision stands.~~ Superseded: it became audit finding
  F-19 and was fixed in `core/jobs/worker-lock.ts`. See ADR-014 D-8-A.
- **A single-key cache value read.** See D-6.

## Named debts

- Nine of thirteen workers are uninstrumented on their **scheduled** path.
- Module-**import**-time logging bypasses the console bridge (D-1).
- `system_logs` always reports one `extra` index, because it has no Mongoose model to declare
  `{requestId: 1}`. Explained by the row's own `reason` field; not worth a model to silence.
- The manual worker-trigger claim is still process-local (ADR-014).

## Route naming

`/system/platform/*` is for reads where wi-admin has, or will plausibly have, its own answer to
the same question — hence `platform/config`, `platform/logs`, `platform/database`,
`platform/cache/keys`. The seven Phase-14 reads **stay where they are**: wi-admin has no competing
answer to any of them, and moving them would break a dashboard for no benefit. The inconsistency
is deliberate and is written down rather than left to look accidental. Both config responses carry
`service:` so a screenshot is unambiguous.

## Deployment order

**jovi-mall first, wi-admin second, always** — every new wi-admin route is a passthrough and 404s
until the far side exists. Within wi-admin, **catalogs and routes must land in the same commit**:
`assertAuditCoverageComplete()` refuses a catalogued action that nothing produces.

Ship **J1 (the logging core) alone and watch it for a day.** A console bridge that misbehaves
affects every line of output in the process, and `LOG_CONSOLE_BRIDGE=false` is the kill switch.

## Verification

| suite | result |
|---|---|
| `jovi-mall: npm run test:system` | **175** (was 70), DB-free |
| `jovi-mall: npm run verify:logs` | **18**, needs Mongo — proves the collection is genuinely capped, `$collStats` is permitted, and the level floor holds |
| `wi-admin: npm run test:devtools` | **92** (was 63) |
| wi-admin, 16 DB-free suites | all green; `lint` and `tsc` clean in both services |
| both services | booted; every boot assertion passes, including `assertAuditCoverageComplete()` |

Endpoints exercised live against a running jovi-mall: `/config` (67 entries, wiring block),
`/logs` (served from the capped collection, bridged `console.error` arriving with structured
`err`), `/cache/keys` (idle database → `available: false`, nothing provisioned), `/database`
(`system_logs` reported `capped: true`), all four `outbox/prune` refusals plus a dry run, the
thirteenth worker visible on `/system/workers`, and `?probe=smtp` returning `ok`.
