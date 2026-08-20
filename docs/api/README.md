# wi-admin API — the frontend contract

**This directory is the official contract for admin-dashboard development.** Everything the
dashboard may call is here: every path, every guard, every field, every failure. If a
behaviour is not written down here, it is not promised.

`wi-admin` is the **only** service the admin dashboard talks to. It never calls jovi-mall or
geo-tracker directly — where an operation belongs to another service, wi-admin delegates on
the dashboard's behalf and returns the result in its own envelope.

---

## Contents

| Document | Surface |
|---|---|
| **This file** | Base URL, envelope, authentication, CSRF, pagination, sorting, filtering, rate limits |
| [errors.md](errors.md) | The complete error-code registry, the nine categories, and the exposure rule |
| [permissions.md](permissions.md) | All 113 permissions, the three administrator levels, and the grant matrix |
| [health.md](health.md) | `/health/live`, `/health/ready` — unversioned probes |
| [auth.md](auth.md) | `/auth` — login, MFA, refresh, sessions, own password |
| [administrators.md](administrators.md) | `/administrators` — administrator management, levels, suspension, sessions |
| [authorization.md](authorization.md) | `/permissions`, `/approvals` — the policy, and the four-eyes queue |
| [audit.md](audit.md) | `/audit` — the audit trail, exports, and the legacy platform feed |
| [users.md](users.md) | `/users` — platform user directory, suspension, login identifiers |
| [vendors.md](vendors.md) | `/vendors` — vendor directory, KYC, catalogue, suspension, settings |
| [agencies.md](agencies.md) | `/agencies` — delivery agencies, verification, rosters, contracts |
| [agents.md](agents.md) | `/agents` — delivery agents, KYC, tracking, COD threshold, bans, transfer |
| [contracts.md](contracts.md) | `/contracts` — one agent↔agency contract: the full terms, and the three administrative interventions |
| [support.md](support.md) | `/support/tickets` — the support queue: assignment, lifecycle, followers, notes, attachments |
| [orders.md](orders.md) | `/orders` — order directory, timeline, disputes, cancel, dispatch, refund |
| [shipments.md](shipments.md) | `/shipments` — shipment directory, offer trail, reassign, cancel |
| [cod.md](cod.md) | `/cod` — cash-on-delivery overview, holders, remittances, deposits, discrepancies, trust |
| [billing.md](billing.md) | `/billing` — pricing-plan catalog and subscriptions |
| [money.md](money.md) | `/money` — earnings, allocations, payouts, payments, refunds |
| [accounts.md](accounts.md) | `/accounts` — one party's status, balances, activity, payouts, credits, cash ledger |
| [system.md](system.md) | `/system` — health, dependencies, workers, queues, metrics, config, error journal |
| [dev-tools.md](dev-tools.md) | `/dev-tools` — feature flags, worker triggers, outbox replay, maintenance mode |
| [notifications.md](notifications.md) | `/notifications` — the administrator inbox and preferences |
| [files.md](files.md) | `/files` — turning a `*FileId` this service returns into a name, a type and a URL |

**209 versioned endpoints** across 21 route groups, plus 2 unversioned health probes.

---

## Base URL and versioning

```
https://<host>/api/v1
```

Everything the dashboard calls lives under `/api/v1`. The **only** exception is the health
probe pair, mounted unversioned at `/health` — a probe URL is infrastructure and must not
move when `/api/v1` becomes `/api/v2`.

The default listen port is **8033** (`PORT`).

### CORS

The service uses an **exact-match origin allowlist** (`ADMIN_DASHBOARD_ORIGINS`), not a
reflector. An unlisted browser origin receives no `Access-Control-Allow-Origin` header and
the browser blocks the read.

| CORS property | Value |
|---|---|
| Credentials | `true` — cookies are sent cross-origin |
| Methods | `GET, POST, PATCH, PUT, DELETE, OPTIONS` |
| Request headers allowed | `Content-Type`, `Authorization`, `X-Request-Id`, `X-CSRF-Token` |
| Response headers exposed | `X-Request-Id` |
| Preflight cache | 600 s |

A request with **no** `Origin` header (server-to-server, curl, probes) is always allowed —
CORS is a browser mechanism.

---

## Response envelope

Every response — success or failure — uses one of two shapes. There are no exceptions and no
bare payloads.

### Success

```jsonc
{
  "success": true,
  "data": { /* object, array, or null */ },
  "meta": { /* present only on list responses */ },
  "message": "Optional human-readable note"
}
```

- `data` is **always present** on success. It may be `null` (for message-only responses).
- `meta` appears only on paginated/cursor lists, and may carry extra list-level summary fields
  beyond the pagination keys.
- `message` is optional and is for humans; never branch on it.

### Error

```jsonc
{
  "success": false,
  "requestId": "3f2c9b1e-...",
  "error": {
    "code": "AUTHZ_PERMISSION_DENIED",
    "message": "You do not have permission to perform this action",
    "statusCode": 403,
    "category": "authorization",
    "details": { "required": "vendors.suspend" }
  }
}
```

- `code` is the machine-readable identifier — **branch on this**, never on `message`.
- `category` is one of nine values and drives generic client handling. See [errors.md](errors.md).
- `details` is **omitted entirely** when there is none. Never `null`, never `{}`.
- `requestId` is echoed from `X-Request-Id` (or generated). Quote it in every support escalation.
- Stack traces are never sent.

This envelope is byte-identical to jovi-mall's and geo-tracker's, deliberately — one error
shape across the platform.

### Request correlation

Send `X-Request-Id` and it is echoed back on the response and used as the log/audit
correlation key. Omit it and the service generates a UUIDv4. It is exposed to browsers via
`Access-Control-Expose-Headers`.

**An inbound id is accepted only if it already looks like one** — `[A-Za-z0-9._:-]`, 1–128
characters, which covers UUIDs, ULIDs, hex and dotted trace ids. Anything else (including a
repeated header, which arrives as an array) is silently replaced with a fresh id rather than
rejected. The value is an indexed field on every audit row, so an unbounded one would be a
denial of service on administration, and a caller-chosen one could forge a link between someone
else's request and their own.

---

## Authentication

Two transports resolve to the same identity. **Cookie is tried first, then bearer.**

### 1. Cookie session (the dashboard's path)

`POST /api/v1/auth/login` sets three cookies:

| Cookie | httpOnly | Purpose |
|---|---|---|
| `admin_access_token` | ✅ | Short-lived access token (default TTL **900 s**) |
| `admin_refresh_token` | ✅ | Rotating refresh token (lifetime = session absolute cap, default **7 d**) |
| `admin_csrf_token` | ❌ **readable by JS on purpose** | Double-submit CSRF token |

Cookie attributes: `Secure` in production, `SameSite` configurable (`none` is required when
the dashboard is a separate origin, and is only permitted in production), `Path=/`,
configurable `Domain`.

### 2. Bearer token (scripts, integrations)

```
Authorization: Bearer <accessToken>
```

The same tokens are returned in the login response body, so a non-browser client never has to
touch cookies.

### Session semantics

- The access token expiring is a **401 `ADMIN_AUTH_TOKEN_EXPIRED`**. There is **no silent
  refresh** — the client calls `POST /api/v1/auth/refresh` explicitly.
- A valid signature is necessary but not sufficient: the session id must still exist in Redis.
  Logout, revocation, and suspension therefore take effect on the **very next request**.
- Idle timeout default **8 h** (refreshed on use); absolute cap default **7 d**.
- The administrator's `tier` and `status` are re-read from the database on every request, not
  taken from the token — a demotion or suspension applies immediately.
- A suspended administrator's sessions are destroyed the first time they make a request, and
  they receive `403 ADMIN_AUTH_ACCOUNT_SUSPENDED`.

### Mandatory MFA

Administrators at or above `ADMIN_MFA_REQUIRED_TIER` (default: **tier 1, Developer**) must
enrol in TOTP. Logging in without enrolment returns a **scoped session** flagged
`mfaEnrolmentRequired: true`. That session reaches exactly four routes:

```
GET  /api/v1/auth/me
POST /api/v1/auth/logout
POST /api/v1/auth/mfa/enroll
POST /api/v1/auth/mfa/activate
```

Everything else answers `403 ADMIN_AUTH_MFA_REQUIRED`. See [auth.md](auth.md) for the full
enrolment flow.

### The three unauthenticated routes

```
POST /api/v1/auth/login
POST /api/v1/auth/mfa/verify
POST /api/v1/auth/refresh
```

That list is closed and enforced at boot — a route declaring itself public that is not on the
allowlist stops the process from starting.

---

## CSRF

**Required on every state-changing request made with cookie authentication.**

| Condition | CSRF checked? |
|---|---|
| `GET`, `HEAD`, `OPTIONS` | No — safe methods |
| `Authorization: Bearer` | No — nothing attaches that header automatically |
| Cookie-authenticated `POST`/`PUT`/`PATCH`/`DELETE` | **Yes** |
| Unauthenticated | No — the auth gate rejects on its own terms |

Double-submit: read the `admin_csrf_token` cookie and echo it in the `X-CSRF-Token` header.
Mismatch or absence is `403 ADMIN_AUTH_CSRF_INVALID`.

The token is also returned as `csrfToken` in the login / MFA-verify / refresh response bodies,
so a client that cannot read cookies (a native shell around the dashboard, say) can still
supply the header.

```http
PATCH /api/v1/users/665f.../  HTTP/1.1
Content-Type: application/json
X-CSRF-Token: nJ8Qm3F...
Cookie: admin_access_token=...; admin_csrf_token=nJ8Qm3F...
```

---

## Authorization

Every route declares what it needs. There are four declaration kinds:

| Kind | Meaning |
|---|---|
| **public** | No identity. Exactly three routes (see above). |
| **self** | Any authenticated administrator. The route acts on the caller's own identity. |
| **mfa-enrolment** | Authenticated, and additionally reachable by a session that still owes MFA enrolment. |
| **permission** | One or more named permissions, in `all` mode (holds every one) or `any` mode (holds at least one). |

Each endpoint page states its exact declaration. A denial is `403 AUTHZ_PERMISSION_DENIED`
with `details.required` naming the permission — **never** what the caller holds.

Holding the permission is **necessary, never sufficient**. Two further layers run after it:

- **Escalation rules** — administrator-on-administrator actions additionally refuse self-action
  (`AUTHZ_SELF_ACTION_FORBIDDEN`), acting on a peer or superior
  (`AUTHZ_TARGET_TIER_PROTECTED`), and assigning a level at or above your own
  (`AUTHZ_TIER_ESCALATION_FORBIDDEN`).
- **Dual control (four eyes)** — three actions are *queued* rather than executed when a
  condition holds. The endpoint answers **`202 Accepted`** with an approval id, and a second,
  different administrator commits it via `/approvals`. See [authorization.md](authorization.md).

The dashboard should build its navigation from `GET /api/v1/permissions/me` rather than from
the 403s it would otherwise collect.

See [permissions.md](permissions.md) for the complete matrix.

---

## Pagination

Every list is **offset-paged** except one (see *Cursor pagination* below).

### Request

| Parameter | Type | Default | Bounds |
|---|---|---|---|
| `page` | integer | `1` | ≥ 1 |
| `limit` | integer | `20` | 1 – **100** |

`limit=100` is a hard ceiling everywhere, not per endpoint. There is no `?limit=all`.

### Response `meta`

```jsonc
{
  "success": true,
  "data": [ /* … */ ],
  "meta": {
    "total": 143,
    "page": 2,
    "limit": 20,
    "pages": 8
  }
}
```

`pages = ceil(total / limit)`. **An empty list reports `pages: 0`**, not `1` — a pager rendered
from `meta.pages` should show nothing rather than a phantom page one.

Some lists add summary fields to `meta` alongside those four; each endpoint page says which.

### Cursor pagination — the one exception

`GET /api/v1/accounts/:ownerType/:ownerId/activity` merges five independent collections into
one chronological feed. It cannot be offset-paged honestly, so it is cursor-paged:

| Parameter | Type | Notes |
|---|---|---|
| `before` | ISO-8601 instant | Strictly older than. Never inclusive. Omit for the first page. |
| `limit` | integer | Default 20, max 100 |

```jsonc
"meta": { "limit": 20, "nextCursor": "2026-07-14T08:31:02.117Z", "hasMore": true }
```

It reports **no `total` and no `pages`** — deliberately, because a page count over a five-way
merge drifts as you walk it. Pass `nextCursor` back as `?before=` for the next page; `null`
means the end of the feed.

---

## Sorting

```
?sort=createdAt      ascending
?sort=-createdAt     descending  (leading minus)
```

Each endpoint declares an **allowlist** of sortable wire fields, listed on its page. Anything
else is a `400 VALIDATION_ERROR` naming the permitted set:

```jsonc
{
  "success": false,
  "requestId": "…",
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Validation failed",
    "statusCode": 400,
    "category": "validation",
    "details": {
      "fields": [{
        "path": "sort",
        "message": "Cannot sort by \"password\". Sortable fields: createdAt, updatedAt, email (prefix with - for descending)",
        "code": "custom"
      }]
    }
  }
}
```

Every list has a **default sort** (stated per endpoint), so paging is always deterministic.
Only one sort field at a time; there is no multi-key sort.

---

## Filtering

Filters are per endpoint and always documented on that endpoint's page. Three conventions hold
everywhere:

### Free-text search — `?search=`

Trimmed, 1–120 characters. An empty `?search=` is rejected rather than treated as "no filter" —
send no parameter at all. The term is escaped before it reaches the database.

### Booleans — `?flag=true`

Accepted values are `true`, `false`, `1`, `0` (and real JSON booleans in a body). **`false`
means false.** Anything else is a validation error rather than a truthiness coercion.

### Date ranges — `?from=` / `?to=`

Both optional; `from` alone is "since", `to` alone is "until".

- **The interval is half-open: `[from, to)`.** Consecutive ranges tile exactly and no row on a
  boundary is counted twice.
- Values must be **ISO-8601 instants with an explicit zone**:
  `2026-08-11T09:00:00.000Z` or `2026-08-11T10:00:00+01:00`.
- **Date-only values (`2026-08-11`) are refused.** A date is not an instant — the client
  resolves the day in the operator's timezone and sends the instants.
- `to` must be strictly after `from`.
- Several endpoints cap the span (`maxDays`); each page states its cap.

---

## Idempotency and concurrency

There is no idempotency-key mechanism. Two properties matter instead:

- **Delegated writes** (anything that changes platform state) are executed by jovi-mall inside
  its own transaction. A duplicate submit is refused by that service's own state guard and
  surfaces here as `PLATFORM_OPERATION_REJECTED` with `details.platformCode`.
- **Dual-controlled writes** answer `202` and are committed exactly once by the approval, which
  re-checks its precondition at approval time.

---

## Rate limits

Two layers, both `429 RATE_LIMIT_EXCEEDED` with `details.retryAfterSeconds`, and both carrying
`draft-7` standard headers (`RateLimit`, `RateLimit-Policy`).

| Layer | Scope | Window | Default ceiling |
|---|---|---|---|
| **A — global** | Per IP, before the routers | 60 s | 3000 req (`ADMIN_RATE_LIMIT_ANON`) |
| **B — identity** | Per administrator, at the tail of the auth gate | 60 s | tier 1 **2400** / tier 2 **1800** / tier 3 **1200** |
| **Credential** | Per IP, on `/auth/login`, `/auth/mfa/verify`, `/auth/refresh`, `/auth/password` | 60 s | **10** (`ADMIN_AUTH_RATE_LIMIT_MAX`) |

`/health/*` is mounted **before** the limiter and is never throttled.

The identity and global ceilings are runaway-loop backstops, not budgets — if a real operator
reaches one, the number is wrong. The credential ceiling is a security boundary and is strict.

---

## Request body rules

| Rule | Value |
|---|---|
| Content type | `application/json` (also `application/x-www-form-urlencoded`) |
| Maximum size | **1 MB** → `413 REQUEST_BODY_TOO_LARGE` |
| Malformed JSON | `400 REQUEST_BODY_INVALID` |
| Unsupported charset/encoding | `415 REQUEST_MEDIA_TYPE_UNSUPPORTED` |
| Unknown fields | Stripped by default; endpoints marked **strict** reject them with `400` |
| File uploads | **Not supported anywhere.** This service accepts no multipart bodies. |

Path ids are validated at the edge: a malformed id is `400 VALIDATION_ERROR` ("Not a valid
agent id"), not a 404.

Validated values reach the handler **coerced and defaulted** — `?page=2` arrives as the number
`2`, `?from=…` as a resolved instant.

---

## Auditing (what the client should know)

Every mutating endpoint records an immutable audit row before answering, in the same
transaction as the change. Three consequences for a client:

1. A `2xx` on a write means the audit row committed. There is no "succeeded but unrecorded".
2. Five inbox-hygiene routes are deliberately **not** audited (mark read/unread/archive/
   unarchive/read-all) — see [notifications.md](notifications.md).
3. One **read** is audited, because the disclosure is the action:
   `GET /money/payouts/:payoutId/destination`.

Audit rows are queryable at `/api/v1/audit` — see [audit.md](audit.md).

---

## Conventions in these documents

- **Wire fields are `camelCase`.** The underlying platform database is `snake_case`; the
  translation happens in this service and never leaks.
- Timestamps on the wire are **ISO-8601 UTC strings** (`2026-08-13T09:14:02.331Z`), never epoch
  numbers.
- Monetary amounts are in the currency's **minor unit** and always travel with an explicit
  `currency` wherever one applies. XAF, the platform's currency, has no subdivision, so the minor
  unit *is* the franc. Stored ledger and liability amounts are integers; a few request bodies
  (`price` on a plan, `amount` on a refund) accept a decimal — each endpoint page says which.
- `null` means "known to be absent". A field that does not apply to a given owner kind is
  `null`, which is distinct from `0`.
- Ids are 24-character hex strings (MongoDB ObjectIds) unless a page says otherwise; session
  and challenge ids are UUIDs.
- **Direct read** vs **delegated write**: a read served from the platform database directly,
  versus an operation executed by jovi-mall on the dashboard's behalf. It matters only for the
  failure modes — a delegated call can return `502`/`503` or
  `PLATFORM_OPERATION_REJECTED`. Each endpoint says which it is.
