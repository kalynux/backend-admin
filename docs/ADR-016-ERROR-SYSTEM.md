# ADR-016 · The error system

**Verified against source on 2026-09-08** — **correcting D-5**, which said ADR-009 D-2 and ADR-015 D-5 *"stand unamended"* — [ADR-020](ADR-020-ADMIN-DATA-DOOR.md) amended both on 2026-08-22. The nine categories, the boundary-filtering rule and the three rungs were checked against `src/core/errors/error-category.ts` and `detail-policy.ts` and are correct. Every route, error code, permission and audit action this page names was re-checked against the live route manifest and the four registries — `permission.catalog.ts`, `audit.catalog.ts`, and both services' `error-codes.ts`. ⚠ **This is a dated design record.** Its *Context* sections describe what PHASE-0 or the phase found **at the time** and are correct as history, not as a description of the service today; where a decision is still the live rule it says so at its own D-item.

**Status:** accepted, implemented
**Scope:** all three services — `jovi-mall`, `wi-admin`, `geo-tracker`
**Enforced by:** `jovi-mall: npm run test:errors` (69) · `npm run test:system` (175) ·
`admin: npm run test:contract` (97) · `geo-tracker: make test` · ESLint · the three global
handlers

---

## The problem

Three backends had three answers to *what happened, and who may know*.

| | jovi-mall | wi-admin | geo-tracker |
|---|---|---|---|
| Error primitive | `AppError` + `createAppError` | same | **none** — 11 sentinels |
| Codes | 541, 1362 call sites, zero ad-hoc literals | 61 | **none** |
| Envelope | `{success,requestId,error{…}}` | identical | **plain text**, except routing's `{"error"}` |
| Rate limiting | **none** | 300/min flat, in-memory | **none** |
| Internal exposure | `details` echoed verbatim in prod | 5xx message+details unmasked | `/readyz` returned raw checker errors, unauthenticated |

Three consequences followed.

1. **The taxonomy was not expressible.** A 502 was an external-service failure in
   `payment-orchestrator.service.ts` and an internal one in `google-calendar.client.ts`,
   which raised `INTERNAL_SERVER_ERROR` *at a 502*. Nothing could tell them apart.
2. **Internal detail reached customers.** Five sites in `payment-orchestrator.service.ts`
   put `{ cause: error.message }` — raw gateway text — in a shopper's browser.
   geo-tracker's unauthenticated `/readyz` published Postgres DSNs and up to 4 KB of
   jovi-mall's response body.
3. **Nobody could look an error up.** A `requestId` was minted, echoed and logged, and
   nothing turned one into an answer.

---

## D-1 · Nine categories, and they are derived

```
authentication · authorization · validation · not_found · conflict
business_rule  · rate_limit    · external_service · internal
```

Assignment is `categoryFor(code, statusCode)` — an override table, then an
integration-prefix rule for 5xx, then a status table that is total over every integer.

**Not hand-annotated**, for two reasons. 541 codes is the small one. The real one is that
category is not a property of a code: the same code is raised at different statuses at
different call sites, and any annotation would be wrong at one of them.

**Category drives exposure and telemetry, never control flow.** That is what makes
derivation safe — a wrong category degrades a diagnostic instead of changing behaviour.

### The 422 row is load-bearing

jovi-mall uses **400 for schema failures and 422 for business rules**, at 136 and 139 call
sites respectively, and `api-doc/errors/README.md` documents the split endpoint by endpoint.
So **422 is `business_rule`, not `validation`**. Filing it as validation would tell a
frontend to highlight a form field for *"this agency does not handle cash on delivery"*.

### How a wrong derivation is caught

- **Override hygiene** — every override names a live code, carries a non-empty reason, and
  must **disagree** with what the rules already derive. A dead override is dead policy, the
  argument `tier-grants.ts` makes about a permission granted to no tier. This assertion
  immediately found two redundant entries and they were deleted.
- **The census** — `test:errors` statically scans **every** `createAppError(ERROR_CODES.X, N)`
  site in jovi-mall's `src/` (**1 517** on 2026-09-06; re-measure with
  `grep -rhoE "createAppError\(" src/ | wc -l`) and asserts no code yields two categories.

> **The census found 25 pre-existing conflicts on its first run.** They are baselined, not
> amnestied: the list cannot grow, and a second assertion fails if an entry is fixed and
> left in. Four straddle the masking boundary and are worth a follow-up —
> `INTERNAL_SERVER_ERROR` (seven statuses, including 401 and 403, in a code the registry
> documents as handler-only), `ORDER_ITEM_NOT_FOUND`, `DIGITAL_ENTITLEMENT_NOT_FOUND`,
> `INTEGRATION_UNSUPPORTED_CALENDAR_PROVIDER`. They are not fixed here because each fix
> changes a status on the wire, which D-1 of ADR-005 makes a breaking change — and the phase
> that introduces the taxonomy should not also rewrite the API.

---

## D-2 · The envelope gains exactly one field

```json
{ "success": false, "requestId": "req_abc",
  "error": { "code": "…", "message": "…", "statusCode": 422,
             "category": "business_rule", "details": { } } }
```

`category` is additive and always present. It is the one thing a frontend can branch on
generically without a 541-entry switch — *retry on `external_service`, highlight the field on
`validation`*. `details` was already conditional, so every existing consumer already
tolerates a varying key set.

**Branch on `error.code`. Never on `error.message`.** Unchanged from ADR-005 D-9, and now
more true: for two categories the message is *replaced*.

---

## D-3 · Filter at the boundary, keyed on category — never at the throw site

The organising claim of the phase.

| Category | code | message | details |
|---|---|---|---|
| the seven client-facing ones | real | real | scrubbed and passed |
| **external_service** | real | **registry default** | **omitted** |
| **internal** | real | **registry default** | **omitted** |

The code survives on a 5xx deliberately: it is stable, the registry is not secret, and it is
what a frontend and a support agent branch on. The *message* and *details* carry prose and
payloads, and those are what get masked.

This closed the `payment-orchestrator.service.ts` and `google-calendar.client.ts` leaks
**without editing either file**. A rule enforced at every call site is a rule enforced at all
but one of them.

> **The `NODE_ENV` gate stopped being what protects us.** `internal` and `external_service`
> are masked in development exactly as in production, and `test:errors` asserts the two
> render identically. A masking rule that only runs in prod is a rule nobody has watched
> work.

`isOperational` is now **derived** (`statusCode < 500`). jovi-mall hardcoded it `true`, so
the masking its own docstring promised had never once happened.

---

## D-4 · The journal reuses the capped `system_logs` sink

No second capped collection. That would double a documented one-way door
(`LOG_MONGO_CAP_BYTES` cannot be changed in place) and reimplement the circuit breaker,
bounded in-flight set, drop counting, ring-buffer fallback and cursor pagination that
`verify:logs` already proves.

Everything lands under **one `httpError` key**, not a dozen sibling fields — because
`log-record.ts` assigns every persisted field *by name*, deliberately, and twelve fields
would mean twelve edits in each of three files with the thirteenth silently dropped on read.

> **Size `LOG_MONGO_CAP_BYTES` before this ships.** Errors are now the highest-value rows in
> that collection, and deriving `isOperational` moves ~55 sites from `warn` to `error`.

---

## D-5 · The tier projection lives in wi-admin, and geo-tracker gets no data door

jovi-mall serves the **full** record on `GET /api/internal/admin/system/errors`; wi-admin
re-serves it graded at `GET /api/v1/system/errors`.

wi-admin is the only service that knows a tier. jovi-mall receives `X-Actor-Tier` and its own
middleware says it "is accepted for logging and is never read for a decision" — correct,
because the token authenticating that call is a **full-privilege credential**. Projecting
there would be theatre.

geo-tracker is out of it **for errors**: nothing in this system reaches an operator through
wi-admin. Its errors reach them through its own logs and the new `geotracker_errors_total`.

> ⚠ **Corrected 2026-09-08.** This paragraph said *"ADR-009 D-2 and ADR-015 D-5 **stand
> unamended**"*, and that stopped being true on 2026-08-22: **[ADR-020](ADR-020-ADMIN-DATA-DOOR.md)
> amended both**, and geo-tracker now has a scoped **data** door — four `/internal/*` reads behind
> `GEO_TRACKER_ADMIN_TOKEN`, audited fail-closed in wi-admin. Both amended decisions already say so
> at their own D-items; this was the one page still asserting the old state.
>
> **The rung model above is unaffected and holds on the new door too**, for exactly the reason
> given here: geo-tracker records `X-Admin-Actor` and never reads it for a decision, because it
> authenticates a *service*, not a person. There is still **no error surface** on that door.

### The three rungs

| Rung | Permission | Sees |
|---|---|---|
| **Developer** (1) | `developer_tools.logs.read` | everything — stack, cause chain, raw record |
| **Admin** (2) | `system.errors.read` | the operational diagnosis: internal message, unmasked `details`, path, actor. **No stack** |
| **Support** (3) | `support.errors.lookup` | what the caller saw, plus the reference, the category and a hint |

Developer and Admin differ by **depth**: a stack names our files and our call graph, which is
a developer's concern, while `MongoServerError: connection timed out` is what an operator
diagnosing an incident actually needs.

Support differs in **kind**. Not a smaller record — a different one. Their `message` is
recomputed from the registry and **never echoed from the log line**, because
`log-query.service.ts` carries a `PII_WARNING` saying log lines are free text and can hold an
email from an SMTP failure or a phone number from a WhatsApp error. Support talks to the
public; they must never be handed free text this platform did not compose.

Support is narrowed twice more: by **row** (only `vendor`/`agency`/`agent`/`customer` and
anonymous traffic — an administrator's or an internal caller's error is an operations
problem, not a support conversation) and by **query** (a `requestId`, or a `code` with a
window → else `400 SYSTEM_ERROR_QUERY_TOO_BROAD`). An open feed is a reconnaissance feed
however little each row says.

### The family choice *is* the enforcement

- `developer_tools.*` ⇒ tier 1 only, by an existing boot assertion.
- `system.*` ⇒ swept into tier 2 by `allInFamily('system')`; tier 3's grants are an explicit
  list, so Support does not inherit it.
- `support.*` ⇒ swept into tier 3, then up to 2 and 1 by strict nesting.

Both new permissions must stay non-sensitive or `allInFamily` refuses to expand them.
`npm run authz:matrix` prints the resolved answer; `assertGrantTableValid()` refuses to boot
if it is wrong, which is the test for this decision.

---

## D-6 · Rate limiting: three layers, tolerant, fail-open

```ts
type CallerClass = 'internal_service'|'admin'|'vendor'|'agency'|'agent'|'customer'|'anonymous';
```

**Layer A** — IP-scoped, before the routers, so it covers `/auth/*` where there is no
identity yet. **Layer B** — identity-scoped, at the *tail of `requireAuth`*: one edit, and
every authenticated route in the service inherits the per-role ceiling. **Layer C** —
per-endpoint, already possible via `defineRoute({ before })` and deliberately unused.

> **Do not classify from an unverified JWT.** Selecting a *more generous* bucket from an
> attacker-chosen claim hands a forger the biggest one. That is the whole reason for the
> two-layer split.

Ceilings (per 60s): agent · admin 1200 · vendor · agency 900 · customer 600 · anonymous 600 ·
Layer A 1200 · internal service **exempt** · **auth endpoints 20**. geo-tracker: 600/min per
IP, and **20 frames/s per WebSocket connection** — there was no inbound cap at all before,
and each `location_update` drives a Redis read, a checkpoint decision and a publish.

Every number except the auth bucket is a **backstop, not a budget**: set so no real user can
reach it. `jovimall_rate_limited_total{caller_class,policy}` exists so the first week of
production replaces these guesses with evidence.

**Exempt paths** are closed lists with a reason per entry — `/api/health*` above all, because
geo-tracker registers it as a *readiness* checker and a 429 there kills every live tracking
session (ADR-014 D-1).

### Fail OPEN, and the naive integration fails closed

`rate-limit-redis`'s `sendCommand` **rejects** when Redis is down, and express-rate-limit
surfaces that as a `500` on every request. Wiring the Redis store in without a decorator does
not add a rate limiter — it adds a single point of failure in front of every route.
`FailOpenStore` admits the request, logs once per window, and increments
`rate_limit_store_errors_total`, so failing open is visible rather than silent.

---

## D-7 · geo-tracker adopts the shared envelope

`internal/platform/apperror` (category + code + status + wrapped cause, `errors.As`-friendly)
and `internal/platform/httpx.WriteError`. **Breaking** for a client parsing the plain-text
body; its own api-doc already said to branch on status.

`errors.As` appeared **nowhere** in the service before this, so an error wrapped once with
`fmt.Errorf("%w")` was unclassifiable at the boundary and became a generic 500.

WS error frames gain `code` (additive, `omitempty`). The split that matters: a bad
coordinate, an implausible jump, an identity mismatch and *Redis being down* all reached an
agent's phone as the single string `"location rejected"` — and two of those tell the client
opposite things.

⚠ **`ErrNotAuthorized` maps to 403 in the registry, but `/locations/{agentID}` must keep
answering 404.** Existence must never leak there. The handler overrides deliberately.

---

## Consequences

**Fixed, each of which had shipped:**

1. jovi-mall's `details` passthrough — gateway text in a shopper's browser.
2. geo-tracker's unauthenticated `/readyz` returning DSNs and 4 KB of upstream body.
3. wi-admin's unmasked 5xx `AppError` message and `details`.
4. Malformed JSON answering `500 Something went wrong` — our fault, for their payload.
5. `isOperational` hardcoded `true`, so no 500 was ever logged as one.
6. **Eight envelope-bypass sites** with unregistered code strings and no `requestId`. The
   ESLint rule that should have caught them only fired when `error` was the object's *first*
   property — which is exactly how they accumulated. The selector now matches any position.
7. An unvalidated inbound `X-Request-Id` — log injection, and poisoning of the very lookup
   D-5 makes load-bearing.
8. `cors({ origin: true, credentials: true })`, unconditional: any site on the internet could
   make credentialed requests in a logged-in user's browser and read the responses.
9. `GET /test-auth` — an inline login page with hardcoded credentials, served in every
   environment. helmet's CSP was relaxed to `'unsafe-inline'` **solely** to serve it, so
   deleting the page recovered the CSP for free.
10. `geotracker_webhook_events_total{outcome="rejected"}`, documented since it was added and
    incremented by nothing.

**Deliberately not done:** a second capped collection · reading `X-Actor-Tier` for a decision
· a geo-tracker data door · wiring up `ValidCode<T>` (it would require renaming codes, which
ADR-005 D-9 forbids) · rate-limiting `/api/health` or `/readyz` · fixing the 25 baselined
status conflicts · restarting a panicking goroutine in `safego` (it has lost its invariants;
the point is not taking the other ten thousand connections with it).

**Costs accepted:** `ALLOWED_ORIGINS` must be populated before deploy or browser clients on
other origins lose access. geo-tracker's limiter is in-memory, so N instances multiply its
ceiling by N — stated rather than hidden, and acceptable for a backstop. A WS client can
reset its frame bucket by reconnecting; the per-IP limiter on the upgrade path bounds that.
