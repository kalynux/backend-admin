# ADR-005 — The core API contract

**Status:** Accepted, 2026-08-11 · **Implemented by:** Phase 5 (Port all 81 endpoints)
**Establishes:** the conventions every endpoint in this service obeys
**Enforced by:** `npm run test:contract` (97 assertions, DB-free) · `defineRoute` · ESLint · the global error handler

---

## Context

Phases 1–4 shipped nineteen endpoints. Phase 5 ports **seventy-six more**, and Phase 6 builds nine
domains that exist nowhere today. That is the moment a convention is either written down once or
decided seventy-six times.

It is not a hypothetical risk — it had already started. At the end of Phase 4:

| Rule | Copies | Consequence |
|---|---:|---|
| The 24-hex ObjectId regex | 4 | four chances for the fifth to differ |
| The `page` / `limit` pair | 4 | same |
| The `pages` formula | 3 | **two disagreed**: an empty list was `pages: 1` from `/users` and `pages: 0` from `/administrators` |
| The search-term regex escape | 2 | the third repository to grow a search box ships without one |

Nobody wrote that `pages` inconsistency deliberately. It is what three copies of a two-line formula
produce, and it is exactly what seventy-six more endpoints multiply.

The governing rule for everything below:

> **A frontend must be able to write one client for this API, not one client per endpoint — and it
> must never have to read English to know what happened.**

Every decision here follows from that, and from one prior commitment: this service's envelope is
**byte-identical to jovi-mall's** (`core/http/responses.ts:6`). The admin dashboard is a different
client, but a second envelope would buy nothing and cost every engineer who moves between the two
services.

---

## D-1 · Versioning

**`/api/v1` is the whole API surface. `/health/*` is deliberately outside it.**

| | |
|---|---|
| Mount | `app.use('/api/v1', apiV1)` — `app.ts:105` |
| Unversioned | `/health/live`, `/health/ready` — an orchestrator's probe is not part of the product's contract, and it is mounted **before** the rate limiter so load cannot fail a readiness check |
| Version in | the path, never a header. A URL that can be pasted into a browser, a log, or a bug report is worth more than header purity |

**What forces a `v2`:** removing a field, renaming one, narrowing a type, changing a status code, or
changing the meaning of an existing value. **What does not:** adding an optional request field,
adding a response field, adding an error code, adding an enum member *that the client already treats
as unknown* (see D-17).

There is no `v2` and there should not be one soon. Before cutover (Phase 8) this service has exactly
one consumer, and a breaking change is a coordinated deploy rather than a version. After cutover, a
`v2` would be mounted **beside** `v1` — a second router, not a rewritten one — because the cost of a
version is running both, and that cost is only worth paying for a change that cannot be made
additively.

---

## D-2 · URL structure

```
/api/v1/<domain>/<collection>[/<id>[/<sub-collection>[/<id>]]][/<action>]
```

Rules, in the order they get broken:

1. **Plural nouns for collections.** `/administrators`, `/agents`, `/remittances`. Never
   `/getAgents`, never a singular collection.
2. **kebab-case in paths, camelCase in query strings and bodies.** `/payout-requests?agencyId=…`.
   The path is a URL and reads as one; the query string is JavaScript and parses as one.
3. **An action that is not a CRUD verb is a POST sub-resource**, named as an imperative:
   `POST /remittances/:id/confirm`, `POST /administrators/:id/suspend`. This is preferred over a
   `PATCH` with a magic body (`{ status: 'confirmed' }`) because the permission, the audit row and
   the four-eyes rule all attach to *the action*, not to a field — `cod.remittances.confirm` is a
   permission, `cod.remittances.write` would not be.
4. **Literal segments are declared before parameterised ones.** `/me` before `/:adminId`; Express
   matches in registration order, and the reverse reads `"me"` as an id
   (`administrator.routes.ts:25`).
5. **One mount per path prefix.** jovi-mall stacks five routers on the bare `/admin` prefix, so a
   single request re-resolves authentication up to five times and two routers claiming one path
   silently make the later one dead code. Every `apiV1.use('/x', …)` here has a distinct `/x`
   (`api/index.ts:17-26`).
6. **The domain mount is decided once**, in `legacy-endpoint-map.ts`, not by whoever ports the
   endpoint:

| Mount | Holds |
|---|---|
| `/auth` `/administrators` `/permissions` `/approvals` | this service's own identity surface |
| `/agents` `/agencies` `/users` | the platform's people |
| `/cod` `/money` `/billing` `/orders` | cash, earnings, payouts, plans, disputes |
| `/support` `/content` `/files` `/broadcast` | tickets, articles + authors, file admin, Telegram |
| `/system` `/dev-tools` | Phase 7 operations |

Note what this reshapes: jovi-mall's `POST /api/webhooks/telegram/send` is an admin capability living
on a webhook path, and `GET /api/files/orphans` is an admin route guarded inline in a shared router.
Both land under their domain here. **Porting is not transcription** — the legacy path is the source,
the table above is the destination.

---

## D-3 · HTTP methods

| Method | Means | Body | Retry-safe |
|---|---|---|:---:|
| `GET` | read | never | ✅ |
| `POST` | create, **or** perform a named action | yes | ❌ |
| `PATCH` | partial update — send only what changes | yes | ❌ |
| `PUT` | replace one single-valued sub-resource outright (`/administrators/:id/tier`) | yes | ✅ |
| `DELETE` | remove or revoke (`DELETE /administrators/:id/sessions`) | rarely | ✅ |

**`PATCH`, not `PUT`, for resources.** A `PUT` on a whole resource means "replace it", which turns
every omitted field into a deletion — a client that reads a record, edits one field and sends it back
will silently drop any field it did not know about. That is the failure mode of every dashboard that
outlives one release of its API.

**`PUT` survives for exactly one shape:** a sub-resource that *is* one value, where replace and
update are the same operation and idempotency is worth having.

**There is no `DELETE` on administrators, and there should be none on anything with an audit trail.**
Suspension is the model. A deleted administrator leaves audit rows and session history pointing at
nothing, and "who did this" stops being answerable — the one question an administrator audit trail
exists to answer (`administrator.routes.ts:20`).

**Retry-safety is enforced, not documented.** `platform.client.ts:161` retries `GET`/`HEAD` on a
transport failure and **never** retries a write: jovi-mall has no idempotency keys and its writes are
transactional with post-commit events, so a retried `confirm` settles a remittance twice and emits
its event twice.

---

## D-4 · Status codes

| Code | When | Code family |
|---:|---|---|
| `200` | read, update, or an action that completed | — |
| `201` | a resource was created (`sendCreated`) | — |
| `202` | **queued for a second administrator** (four-eyes) | — |
| `400` | the request was malformed or failed a schema rule | `VALIDATION_ERROR`, `REQUEST_BODY_INVALID` |
| `401` | not authenticated, or the session is gone | `ADMIN_AUTH_*` |
| `403` | authenticated but not permitted — including CSRF and suspension | `AUTHZ_*`, `ADMIN_AUTH_CSRF_INVALID`, `ADMIN_AUTH_ACCOUNT_SUSPENDED` |
| `404` | no such route, or no such record | `NOT_FOUND` |
| `409` | the state moved under you (duplicate key, resolved approval) | `DATABASE_UNIQUE_CONSTRAINT_VIOLATION`, `AUTHZ_APPROVAL_ALREADY_RESOLVED` |
| `413` | body over the 1 MB ceiling | `REQUEST_BODY_TOO_LARGE` |
| `415` | unsupported `Content-Type` or charset | `REQUEST_MEDIA_TYPE_UNSUPPORTED` |
| `429` | rate limited | `RATE_LIMIT_EXCEEDED` |
| `500` | our fault, unexpected | `INTERNAL_SERVER_ERROR` |
| `502` | jovi-mall answered, with a 5xx | `SERVICE_DEPENDENCY_UNAVAILABLE` |
| `503` | a dependency is unreachable or unconfigured | `SERVICE_DEPENDENCY_UNAVAILABLE` |

**202 is the one worth reading twice.** A dual-controlled action is not refused — it is *accepted and
waiting*. Answering `403` would report a permitted action as a denial and the dashboard would show an
error where it should show "waiting for approval" (`administrator.controller.ts:28-33`). The response
body is the pending approval, so the client can poll or link to it.

**502 vs 503 is a real distinction for the caller.** 503 means we never got an answer — retry later.
502 means jovi-mall answered and failed — retrying reproduces it.

---

## D-5 · Authentication

| | |
|---|---|
| Authority | **this service**, for administrators. jovi-mall has no `admin` role at all |
| Resolution | `admin_access_token` cookie **first**, then `Authorization: Bearer` |
| Access token | HS256, 15 min, `ADMIN_JWT_SECRET` — deliberately not jovi-mall's `JWT_SECRET` |
| Session | server-side in Redis, 8 h idle / 7 d absolute, individually revocable |
| Refresh | `POST /api/v1/auth/refresh`, rotated; replaying a superseded token **destroys the session** |
| CSRF | `X-CSRF-Token` header echoing the readable `admin_csrf_token` cookie, on cookie-authenticated writes only |

**There is no silent refresh, and that is the contract.** jovi-mall rotates the access cookie
mid-request when it finds an expired token, which hides expiry from cookie clients and not from
bearer clients — the root of a documented cross-service defect where geo-tracker's forwarded token
expires and the failure is reported as `shipment_completed`. Here an expired token is a plain `401`
with `ADMIN_AUTH_TOKEN_EXPIRED`, and the client calls `/auth/refresh`. **A client must therefore
handle 401-then-refresh-then-retry.** Explicit beats invisible.

**Every request re-reads the account**, so `tier` and `status` are current rather than whatever was
minted into the token: a demotion or a suspension takes effect on the next request, not at token
expiry (`authenticate.middleware.ts:92-106`).

**Three 401 codes, because the remedies differ:** `ADMIN_AUTH_TOKEN_EXPIRED` → refresh;
`ADMIN_AUTH_SESSION_REVOKED` / `ADMIN_AUTH_SESSION_EXPIRED` → sign in again;
`ADMIN_AUTH_MISSING_TOKEN` → you were never signed in.

> **Fixed while writing this ADR.** `X-CSRF-Token` was missing from the CORS `allowedHeaders`
> allowlist (`app.ts`). The guard requires the header, the dashboard is a separate origin, so every
> cookie-authenticated write would have failed its preflight — while passing every `verify:*` script,
> because those are Node clients and CORS is a browser mechanism. A contract that no test client
> exercises the way the real client will is a contract with a blind spot.

---

## D-6 · Authorization

Four layers, in this order, each doing something the one before it cannot:

| Layer | Question | Where | On failure |
|---|---|---|---|
| Permission | may you do this *kind* of thing? | `authorize.middleware.ts` | `403 AUTHZ_PERMISSION_DENIED` |
| Escalation | may you do it to **this administrator**? | `escalation.rules.ts` | `403 AUTHZ_TARGET_TIER_PROTECTED` / `AUTHZ_SELF_ACTION_FORBIDDEN` / `AUTHZ_TIER_ESCALATION_FORBIDDEN` |
| Scope | which records of this kind are yours to see? | `resource-scope.ts` | filtered, or `404` |
| Dual control | must a second administrator agree? | `dual-control/` | `202` with the approval |

**A route declares who may call it, or the service does not boot.** `defineRoute()` makes `access` a
required field; `assertRouteManifestComplete()` fails startup if anything reached Express without it;
`test:authz` scans every `*.routes.ts` for a raw `router.get(`. Three layers, because "remember the
guard" does not survive seventy-six endpoints.

**A 403 names the permission required and never what the caller holds.** jovi-mall's `requireRole`
returns `{ required, actual }`; echoing the caller's own standing back to them is a gratuitous leak,
and the required name alone makes the denial debuggable — any authenticated administrator can read
the catalog anyway (`authorize.middleware.ts:31-35`).

**A record you may not see is a `404`, not a `403`** — a 403 on a specific id confirms the id exists,
which is an existence oracle over the platform's records.

---

## D-7 · Request validation

**The schema is declared on the route, not parsed in the handler.**

```ts
defineRoute(router, {
    mountedAt: '/agents',
    method: 'patch',
    path: '/:agentId/status',
    access: permission('agents.status.set'),
    validate: { params: idParam('agentId', 'agent'), body: SetAgentStatusSchema },
    handler: AgentController.setStatus,
});
```

jovi-mall validates inline in ~200 handlers, which scatters the contract and makes it invisible at
the route table. Declaring it beside `access` means **what a request must look like and who may send
it are read together**.

The chain `defineRoute` builds is fixed: `before → gate → requireCsrfToken → validate → handler`.
**Validation runs after the guards on purpose** — an unauthorized caller must not be able to probe a
schema.

Four rules:

- **The parsed result replaces `req.body` / `req.query` / `req.params`**, so handlers receive
  coerced, defaulted, stripped values. `req.query.page` arrives as `'2'` and reaches the handler as
  `2`. That is the point of validating at all.
- **Unknown keys are stripped, not rejected.** Zod's default. A client sending a field from a newer
  build must not get a 400 from an older server; the field simply does not exist here.
- **ZodErrors are thrown, never caught locally.** The global handler already renders them into the
  documented `VALIDATION_ERROR` envelope with per-field details; catching one locally creates a
  second format for the same failure.
- **On a delegated route, validate shape — never domain.** Bounds and formats (is this an id, is
  `limit` sane) belong here; domain rules (is this remittance still `declared`) belong to jovi-mall,
  which re-validates everything anyway because the internal API is reachable by anything holding the
  service token. A domain rule copied here drifts, and answers `400` for a state jovi-mall answers
  `409` for (`cod.validator.ts:6-15`).

---

## D-8 · Response format

```json
{ "success": true, "data": { }, "meta": { }, "message": "optional" }
```

- `data` is **always present** on success — object, array, or `null`. Never omitted.
- `meta` appears **only** on lists (D-10), and may carry extra list-level summary fields.
- `message` is optional human copy. **Never branch on it.**

Built only through `sendSuccess` / `sendCreated` / `sendPaginated` / `sendMessage`. Hand-rolling
`res.json({ success: true, … })` is how a shape drifts, and ESLint blocks the error half of it
outright.

**DTO rules — the wire is not the database.**

| Rule | Why |
|---|---|
| **camelCase on the wire**, whatever the storage uses | `jovi_mall` is snake_case, `wi-admin` is snake_case, and the dashboard is TypeScript. The mapping happens once, in the DTO |
| `id`, never `_id`; a **string**, never an ObjectId | `{ "$oid": … }` is a driver artifact, not a contract |
| Dates as **ISO-8601 UTC strings**, never `Date` objects or epoch numbers | D-14 |
| **Named-field mapping, never a spread** | The projection is the first lock; naming each field is the second, and the one that survives somebody widening the projection for a new screen (`user.controller.ts:34-40`) |
| Money passes through as jovi-mall states it | a number in the account currency (default `XAF`), not minor units. This service re-envelopes; it does not re-denominate |

**A delegated payload is re-enveloped, not re-shaped.** jovi-mall's `data` becomes this service's
`data` verbatim (`cod.controller.ts:12-19`). The moment a gateway starts renaming fields, this
service is keeping a second opinion about a domain it does not own.

---

## D-9 · Error format

```json
{
  "success": false,
  "requestId": "req_abc123",
  "error": {
    "code": "AUTHZ_PERMISSION_DENIED",
    "message": "You do not have permission to perform this action",
    "statusCode": 403,
    "details": { "required": ["cod.remittances.confirm"], "mode": "all" }
  }
}
```

> **Branch on `error.code`. Never on `error.message`.**
>
> The code is a stable identifier and part of the contract. The message is human copy, it is
> rewritten freely, and in production an unexpected error's message is *masked*. A frontend that
> parses English is a frontend that breaks on a typo fix — and one that has no behaviour at all for
> the 500 it cannot read.

`details` is **omitted entirely** when there is none — never `null`, never `{}`.

**Every error leaves through `createAppError(code, statusCode, message?, details?)` and `next(error)`.**
Both `throw new Error()` and `res.status().json({ error })` are ESLint errors
(`eslint.config.mjs:22-32`). Only the global handler and the bootstrap may build a response by hand.

**Six branches, in order** (`error-handler.middleware.ts`):

| # | Input | Answer |
|---:|---|---|
| 1 | `AppError` | its own code and status |
| 2 | `ZodError` | `400 VALIDATION_ERROR` + `details.fields[{ path, message, code }]` |
| 3 | a body-parser rejection | `400` / `413` / `415` — see below |
| 4 | Mongoose `CastError` | `404 NOT_FOUND` |
| 5 | duplicate key (11000) | `409 DATABASE_UNIQUE_CONSTRAINT_VIOLATION` + `details.keyValue` |
| 6 | anything else | `500 INTERNAL_SERVER_ERROR`, message masked in production, **stack never sent** |

> **Fixed while writing this ADR.** Branch 3 did not exist — in this service or in jovi-mall. A
> request with malformed JSON, or one over the 1 MB body ceiling, fell through to branch 6 and the
> caller was told `500 — Something went wrong`: our fault, unactionable, and false. The three
> outcomes are the three different things the caller must do about it — fix the JSON, send less, send
> a different `Content-Type`.

**Error-code discipline** (`core/errors/error-codes.ts`):

- domain-prefixed `SCREAMING_SNAKE`, **key identical to value**, `Object.freeze`d
- one family per domain — Phase 5 adds `AGENTS_*`, `BILLING_*`, `MONEY_*`, `ORDERS_*`, `SUPPORT_*`,
  `CONTENT_*`, `FILES_*` as their endpoints land, and **not before**: a code with no thrower is a
  contract nobody honours
- a code is **never renamed or repurposed**. Adding is additive; changing what one means is a
  breaking change under D-1
- every code carries a default message, so throw-sites stay terse
- **jovi-mall's codes are passed through, not translated.** A delegated 4xx becomes
  `PLATFORM_OPERATION_REJECTED` at jovi-mall's original status, with its code in
  `details.platformCode`. The two registries are deliberately separate, and a local equivalent for
  506 foreign codes is a translation layer that drifts (`platform.client.ts:237-247`)

**Authentication is one code for every credential failure** — unknown email, wrong password, and an
unusable account all return `ADMIN_AUTH_INVALID_CREDENTIALS`. Splitting it turns the login form into
an account-existence oracle. The single exception is `ADMIN_AUTH_ACCOUNT_LOCKED`: telling a
locked-out admin to wait is worth confirming the account exists, because otherwise they keep retrying
and keep extending their own lockout.

---

## D-10 · Pagination

**Every list is paginated. There is no unpaginated list endpoint.**

| Param | Type | Default | Bound |
|---|---|---:|---|
| `page` | integer, 1-indexed | `1` | ≥ 1 |
| `limit` | integer | `20` | 1 … **100** |

```json
"meta": { "total": 120, "page": 1, "limit": 20, "pages": 6 }
```

- `pages = ceil(total / limit)`, so **an empty list has `pages: 0`** — matching the platform contract
  in `jovi-mall/api-doc/README.md`. Computed in exactly one place, `toPageMeta`.
- `LIMIT_MAX` is 100 **globally**, not per endpoint. An administrator exporting "everything" is a real
  need and the answer to it is a paged export, never a `?limit=100000` that pins the process while it
  serialises.
- A list may add summary fields to `meta` (`totalOutstanding`, `pendingCount`). It may not move the
  four required ones.

**Offset paging is the decision, knowingly.** Cursor paging is stable under concurrent writes and
offset paging is not; but every consumer here is a dashboard with a page-number pager, `skip` over a
100-row page is cheap at admin-console volumes, and the drift offset paging actually produces is
fixed by the `_id` tiebreaker in D-13. Revisit it for an endpoint that streams an export, not for the
surface as a whole.

---

## D-11 · Filtering

- **Filters are top-level query parameters**, camelCase, all optional: `?status=declared&agencyId=…`.
  No filter DSL, no `?filter[status][eq]=…`. The dashboard's screens are known, and a query language
  is a second API to document and a second parser to attack.
- **Absent means unfiltered.** No parameter is ever a required filter; a value of `''` is not a
  filter either (it is rejected, or absent — see D-16).
- **Several filters are `AND`.** There is no `OR` across parameters; the one `$or` in the system is
  search (D-12), across the fields of a single term.
- **Every filter is validated against something.** Either an enum this service owns (D-17) or a
  format (`objectId`). A filter that accepts any string is a filter that reaches the query planner
  unexamined.
- **The filter is built in the query layer, never the controller** — `buildFilter()` beside the
  repository, the same reasoning as jovi-mall's `findByIdAndAgency` convention: a scope assembled at
  the query layer is one nobody can forget to apply.

---

## D-12 · Search

**One parameter, `search`: a free-text term, trimmed, 1–120 characters, matched case-insensitively
as a substring across a field set the endpoint declares.**

```ts
if (query.search) Object.assign(filter, matchAnyField(['login_email', 'login_phone'], query.search));
```

- **The term is escaped, always, and by a helper — never by hand.** `escapeRegex` is not politeness:
  an administrator searching `a.b` must match a literal dot, and an *unescaped* term is a
  catastrophic-backtracking pattern the caller supplies. A search box without an escape is a
  denial-of-service endpoint that looks like a feature. It had already been hand-rolled twice; it is
  now one implementation, asserted by `test:contract`.
- **The 120-character bound is part of that defence.** An unbounded pattern is an attack on the query
  planner even after escaping.
- **A blank term is no constraint, not an empty `$or`** — Mongo rejects `{ $or: [] }` at query time
  rather than treating it as "no filter".
- Which fields a term searches is the endpoint's decision, declared at its repository. Searching an
  unindexed field on a large collection is a design question, not a convention question.

---

## D-13 · Sorting

```
?sort=-createdAt        descending
?sort=createdAt         ascending
```

- **A list endpoint declares a `SortMap`, or it offers no `sort` at all.** The map is
  `wire name → database path`, `as const`, read by both the schema (as the allowlist) and
  `toMongoSort` (as the translation) — so a field can never be sortable-but-untranslatable.
- **A default sort is required, not optional.** A list with no defined order has undefined paging:
  Mongo may legitimately return the same document on two pages. `sortSchema` refuses at *import time*
  if the default is not in the sortable set, because a typo there would 400 every request to the
  endpoint — including those that sent no `sort`.
- **An undeclared field is a `400` naming what is sortable.** No client string ever reaches a Mongo
  sort document, so nobody can order a million-row collection by an unindexed field from a query
  string.
- **`_id` is appended as a tiebreaker, always.** Skip/limit paging over a non-unique key is unstable:
  two rows sharing a `created_at` may order differently between the query for page 1 and the query
  for page 2, so one appears twice and the other never appears. Rare enough to survive testing,
  common enough to be reported as "a record is missing", and unfalsifiable from a bug report.
- **A compound natural order keeps it and offers no `sort`.** `/administrators` orders by
  `{ tier: 1, created_at: -1 }` — grouped by level, newest first within a level — which a single sort
  key cannot express. `listQuery` models one key plus the tiebreaker and does not grow a
  compound-sort grammar for one endpoint.
- **A delegated list is sorted by jovi-mall.** Declaring a `SortMap` here would assert field paths in
  a collection this service does not read; when those endpoints grow a `sort`, it is forwarded as an
  opaque string.

---

## D-14 · Dates and times

- **Every timestamp on the wire is an ISO-8601 UTC string**: `2026-08-11T09:00:00.000Z`. Out of a
  DTO, `.toISOString()`. Never an epoch number, never a `Date`, never a local rendering.
- **Every stored instant is UTC.** Display timezone is the dashboard's problem, and it has the
  administrator's `timezone` on their profile to solve it with.
- **A date-only value is refused on input.** `2026-08-11` is not an instant — it is a day in some
  timezone, and the server must not guess which. An administrator filtering "yesterday" from Douala
  means a different 24 hours than one filtering from Lisbon. jovi-mall has already paid for that
  guess once: availability rules defaulted to `'UTC'` and every vendor's working day shifted when the
  server moved. **The client resolves the day and sends the instants.**
- **A date range is `from`/`to`, and the interval is half-open: `[from, to)`.** An inclusive end
  forces every client to send `23:59:59.999` and every server to decide whether milliseconds count;
  half-open makes consecutive ranges tile exactly and never double-counts a boundary row. Either side
  may be omitted — `from` alone is "since", `to` alone is "until".
- **A range endpoint declares a `maxDays`.** These become unindexed scans over collections with
  millions of rows, and an unbounded one is a query an administrator points at production by
  accident. Over the cap is a `400`, not a slow answer.
- **Durations and TTLs are integer seconds**, named for it (`ADMIN_ACCESS_TOKEN_TTL`), never
  milliseconds and never `"15m"`.

---

## D-15 · Identifiers

- **Every id on the wire is a 24-character hex string** — a MongoDB ObjectId, serialised with
  `.toString()`. This holds across both databases; administrators and platform records are
  indistinguishable in shape, which is intentional: the client should not have to know which database
  answered.
- **Ids are validated at the edge**, by `objectId` / `idParam`. Leaving it to Mongoose's `CastError`
  produces a `404 NOT_FOUND` for a request that was never well-formed — telling a client the record
  is missing when the truth is that `?agencyId=null` is not an id.
- **A path parameter is named for its resource** — `:agentId`, `:remittanceId` — never a bare `:id`.
  It reads correctly in the manifest, in a denial record, and in an audit row.
- **`wi-admin` ids and `jovi_mall` ids are different identity spaces that look alike.** An
  administrator's `_id` travels to jovi-mall as `X-Actor-Id` and lands in columns declared
  `ref: MODELS.USER` **that will never resolve** — safe only because nothing populates an actor
  field. Anything recording an actor writes the `actorStampFields()` trio (`*_source`, `*_name`), so
  the id is never alone. See ADR-004 D-1.
- **An id is opaque to the client.** No parsing, no sorting by it, no deriving a creation time from
  it.

---

## D-16 · Nullability

**On the way out:** a field that exists on a resource is **always present**, and absent data is
`null`. Never omitted, never `""`, never `0`, never `"N/A"`. An optional key forces every consumer to
distinguish "not sent" from "not set", and they will get it wrong in different places.

**On the way in**, three states, and the distinction is the contract:

| Sent | Means |
|---|---|
| key absent | leave the stored value unchanged |
| `null`, `""`, or whitespace | **clear** the field — stored and returned as `null` |
| a value | must satisfy the field's constraint |

Expressed by `clearable()` (`core/validation/zod.helpers.ts`), and **not** by
`.nullable().optional()`, which is the same trap the platform already documents: a field validated as
`z.string().url().optional()` can be set but never emptied, because `''` fails `.url()` and `null`
fails the type check. An emptied form input naturally submits `''`, and no frontend should have to
special-case that.

**Not everything is clearable, and that is deliberate.** Required fields, and fields whose value is
an assertion someone made (a verified email, a suspension reason), have no "clear" state. A field
that cannot be cleared rejects `''` rather than silently ignoring it.

**Arrays are `[]`, not `null`.** An empty collection is an empty collection.

---

## D-17 · Status values and enumerations

**Values are `snake_case` string constants. Never integers, never booleans standing in for a state.**

`status: "suspended"` survives the arrival of a third state; `active: false` does not, and the
migration from it touches every consumer. The one integer in this service is `tier`, which is ordinal
by design (lower = more privilege) and documented as such.

**Whether to pin an enum depends on who owns the vocabulary** — the sharpest rule in this ADR,
because both answers are correct in the right place:

| The vocabulary is | Do | Because |
|---|---|---|
| **ours** (`admin_status`, `approval_status`) | `z.enum([...])`, derived from the one exported constant array | The type union and the Mongoose enum must come from a single source. jovi-mall kept two copies of its agent notification types, they drifted, and eight `agent_contract.*` situations existed in the union and not in the enum — so every contract notification threw a `ValidationError` and the agent was simply never told |
| **jovi-mall's** (COD statuses, shipment statuses) | a bounded `z.string()` | A copy here means a status added there is silently unfilterable until somebody remembers this file. Let jovi-mall reject it — it will, and with the right code |

**A client treats an unknown value as unknown, not as an error.** That is what makes adding an enum
member additive under D-1: render the raw value, do not crash, do not assume the set is closed.

**A filter offers only values that can occur.** `role` on `/users` excludes `admin`: since the Phase
0.5 patch no `users` row can hold it, and offering it would advertise a search that can only ever
return nothing.

---

## How this is enforced

A convention nobody can enforce drifts within a week. Each rule above has a mechanism:

| Rule | Enforced by | Failure mode |
|---|---|---|
| Every error is a registry code | ESLint `no-restricted-syntax` on `throw new Error()` | lint error |
| Every response is the envelope | ESLint on `res…json({ error })` + `sendSuccess` helpers | lint error |
| Every route declares its access | `defineRoute` + `assertRouteManifestComplete()` | **the service does not boot** |
| No unguarded route file | `test:authz` source scan | test failure |
| One `pages` formula | `toPageMeta` is the only implementation | `test:contract` |
| One id format, one page size, one search escape | `common.schemas.ts`, `list-query.ts`, `mongo-list.ts` | `test:contract` |
| Sort is allowlisted | `sortSchema` throws at import for a bad default | boot failure |
| Error branches and status codes | `test:contract` renders the real handler | test failure |

```bash
npm run test:contract     # 97 assertions, no infrastructure
```

---

## Porting an endpoint — the checklist

1. Find its row in `legacy-endpoint-map.ts`. The permission is decided; the target mount is decided.
2. Write the validator: `idParam` for params, `listQuery(SORT, default, {...})` or `paginationFields`
   for a list, `searchTerm` / `dateRangeFields` / `boolFlag` / `reasonText` as needed. Pin an enum
   only if the vocabulary is ours (D-17).
3. Write the route with `defineRoute` — `access` and `validate` together.
4. Delegate or read direct **per ADR-004**, not per preference. Delegated: re-envelope, do not
   re-shape. Direct: projection + named-field DTO.
5. Send through `sendSuccess` / `sendCreated` / `sendPaginated`; a list's `meta` comes from
   `toPageMeta`.
6. Add error codes to the registry **for failures this endpoint actually raises**, with default
   messages.
7. **Delete the row** from `legacy-endpoint-map.ts` — `test:authz` asserts the remaining count, so a
   row deleted without a route replacing it fails the suite.

---

## What this ADR deliberately does not decide

- **Idempotency keys on writes.** jovi-mall has none, so this service cannot offer them on a
  delegated write without inventing a guarantee it cannot keep. Revisit when a direct-write domain
  needs one (Phase 6).
- **Bulk endpoints.** No `PATCH /agents` taking an array. Partial failure in a bulk write has no good
  answer in this envelope, and nothing on the ported surface needs one.
- **Field selection / sparse responses** (`?fields=`). A dashboard with known screens does not need
  it, and it makes every response shape conditional.
- **Cursor pagination.** See D-10.
- **`Retry-After` on 429.** `express-rate-limit`'s `draft-7` headers already carry the window; a
  body-level field would be a second source.

---

## Consequences

**Three shipped defects were fixed by writing this down**, each of which had passed every existing
test:

1. `pages` disagreed between two endpoints for an empty list — three copies of one formula.
2. Malformed JSON and oversized bodies returned `500 INTERNAL_SERVER_ERROR`, blaming the server for
   the caller's payload. jovi-mall still does.
3. `X-CSRF-Token` was absent from the CORS allowlist, so every cookie-authenticated write would have
   failed its preflight from a browser — invisible to `verify:*`, which are Node clients.

The cost: `/api/v1/users` now returns `pages: 0` rather than `pages: 1` for an empty result, and
accepts a `sort` parameter it did not have. Both are pre-cutover changes to a service whose only
consumer is not yet built against it, which is the cheapest moment this correction will ever be
available.

The benefit is the one this phase was gated on: seventy-six endpoints that answer the same seventeen
questions the same way, and a frontend that can be written once.
