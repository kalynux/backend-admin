# Errors

The error contract is shared across all three backend services (wi-admin, jovi-mall,
geo-tracker). One envelope, one nine-value taxonomy, one exposure rule.

Design record: [`../ADR-016-ERROR-SYSTEM.md`](../ADR-016-ERROR-SYSTEM.md).

---

## The envelope

```jsonc
{
  "success": false,
  "requestId": "8f14c2a0-6b3e-4a91-9c7d-2e5f0a1b3c4d",
  "error": {
    "code": "AUTHZ_PERMISSION_DENIED",
    "message": "You do not have permission to perform this action",
    "statusCode": 403,
    "category": "authorization",
    "details": { "required": "vendors.suspend", "mode": "all" }
  }
}
```

| Field | Notes |
|---|---|
| `code` | Machine-readable. **This is what a client branches on.** Stable across releases. |
| `message` | Human-readable. May be reworded at any time — never parse it. |
| `statusCode` | Mirrors the HTTP status line. |
| `category` | One of nine values. Drives generic handling (retry, re-login, show field errors). |
| `details` | **Omitted entirely** when absent — never `null`, never `{}`. |
| `requestId` | Correlation id. Quote it in escalations; it keys the server-side journal. |

---

## The nine categories

The category is **derived** from `(code, statusCode)`, never annotated at the throw site — the
same code is raised at different statuses at different places.

| Category | Meaning | What a client should do |
|---|---|---|
| `authentication` | Who are you? No credential, a bad one, an expired one, a disabled account. | Re-authenticate. Redirect to login. |
| `authorization` | May you? A known administrator reached something their level does not grant. | Hide the affordance. Do not retry. |
| `validation` | The request could not be read, or failed a schema rule. | Show field errors from `details.fields`. |
| `not_found` | No such thing — including "exists, addressed to someone else". | Show an empty/not-found state. |
| `conflict` | The state moved underneath the caller. | Reload and retry. |
| `business_rule` | Well-formed, permitted, and refused by a rule. | Show `message`. It is not a fault. |
| `rate_limit` | Too many requests. | Back off `details.retryAfterSeconds`, then retry. |
| `external_service` | Somebody else's fault: jovi-mall, Mongo, Redis, geo-tracker. | Retry later. Escalate with `requestId`. |
| `internal` | Ours. A bug, a broken invariant, a misconfiguration. | Escalate with `requestId`. |

### Status → category

| Status | Category |
|---|---|
| 400, 413, 415 | `validation` |
| 401 | `authentication` |
| 403 | `authorization` |
| 404, 410 | `not_found` |
| 409 | `conflict` |
| 422, 423 | `business_rule` |
| 429 | `rate_limit` |
| 502, 503, 504 | `external_service` |
| other 4xx | `business_rule` |
| anything else | `internal` |

A handful of codes override this table where the status is the wrong answer — the four
listed under *Overrides* below.

---

## The exposure rule

Filtering happens at the **boundary**, keyed on category — never at the throw site. This is
what makes the guarantee hold without auditing every call site that can raise an error.

### For `internal` and `external_service`

**In every environment, including development:**

- `message` is replaced with the error code's registry default.
- `details` is dropped — with **one exception**: `platformCode` and `platformStatus` survive,
  because without them a dashboard cannot tell "jovi-mall is down" from "wi-admin is down"
  when both present as a 502.

```jsonc
// A delegated write that jovi-mall could not be reached for
{
  "success": false,
  "requestId": "…",
  "error": {
    "code": "SERVICE_DEPENDENCY_UNAVAILABLE",
    "message": "A required dependency is unavailable",
    "statusCode": 503,
    "category": "external_service",
    "details": { "platformStatus": 503 }
  }
}
```

### For every other category

`details` passes through a scrub:

- Keys carrying an internal narrative are **always dropped**, in every category:
  `cause`, `causeMessage`, `stack`, `originalError`, `originalCode`, `originalMessage`,
  `upstream`, `upstreamError`, `upstreamBody`, `response`, `responseBody`, `rawResponse`,
  `raw`, `problems`, `problemCount`, `sql`, `query`, `command`, `dsn`, `connectionString`,
  `env`, `config`, `hostname` — plus every credential-shaped field name the audit redactor
  knows (password, token, secret, and so on). Matching ignores case and punctuation.
- `authorization` failures may carry **only** `required`, `requiredAny`, `mode`, `resource`,
  `action`, `hint`. Notably **not** what the caller holds.
- `rate_limit` failures may carry **only** `retryAfterSeconds`, `limit`, `windowSeconds`.
- Nesting is truncated past **depth 4** (`"[TRUNCATED]"`).
- The serialised result is capped at **8 KB**; over that it becomes
  `{ "truncated": true, "bytes": <n> }`.
- An empty result after scrubbing means `details` is omitted.

Stack traces are never sent, in any environment.

---

## Validation errors

Schema failures always look the same:

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
      "fields": [
        { "path": "email",    "message": "A valid email address is required", "code": "invalid_string" },
        { "path": "body.tier","message": "Expected 1 | 2 | 3",                "code": "invalid_enum_value" },
        { "path": "to",       "message": "`to` must be after `from` — the range is half-open, [from, to)", "code": "custom" }
      ]
    }
  }
}
```

`path` is dot-joined and addresses the offending field within whichever target failed (params,
query, or body). Validation runs **after** authentication and authorization, so an
unauthorized caller cannot probe a schema.

---

## Delegated-operation failures

When wi-admin executes a write on jovi-mall's behalf, two distinct outcomes exist and a client
must tell them apart:

| Code | Status | Meaning |
|---|---|---|
| `PLATFORM_OPERATION_REJECTED` | jovi-mall's **original 4xx** | The call reached the platform and the platform refused it. Your request was wrong, or the state moved. |
| `SERVICE_DEPENDENCY_UNAVAILABLE` | 502 / 503 | No answer was received. Retry later. |

`PLATFORM_OPERATION_REJECTED` carries jovi-mall's own code in `details.platformCode` rather
than being re-mapped — the two services keep separate registries on purpose.

```jsonc
{
  "success": false,
  "requestId": "…",
  "error": {
    "code": "PLATFORM_OPERATION_REJECTED",
    "message": "Shipment status has moved since you loaded it",
    "statusCode": 409,
    "category": "conflict",
    "details": { "platformCode": "SHIPMENT_STATUS_CONFLICT" }
  }
}
```

Because the category of a forwarded rejection is derived from the **forwarded status**, a
forwarded 404 is `not_found`, a forwarded 409 is `conflict`, and so on — which is the right
answer from the caller's point of view.

### What travels in `details`

| Field | When |
|---|---|
| `platformCode` | **Always.** It is a published contract and the dashboard's only handle on *why* a delegated write was refused |
| `platformStatus` | On a forwarded **5xx** only, alongside `operation` — a 4xx already carries the platform's status on the status line |
| jovi-mall's own `details` | **Only when jovi-mall's envelope declares a client-safe category.** An older platform build that sends no `category` forwards nothing — failing closed on a service whose exposure rules cannot be read from here |

Several codes in this registry are **never thrown by wi-admin** and arrive only as
`details.platformCode` on a forwarded rejection — `DEV_TOOLS_WORKER_UNKNOWN` and
`DEV_TOOLS_WORKER_BUSY` are the two. They are catalogued so their default messages exist and so
a client can branch on them; branch on `details.platformCode`, not on `error.code`.

---

## The registry

Every code the service can return. Codes marked **boot-time** never reach a client — the
process exits before it listens; they are listed for completeness and because they appear in
logs.

### Generic

| Code | Status | Category | Meaning |
|---|---|---|---|
| `INTERNAL_SERVER_ERROR` | 500 | `internal` | Unhandled fault. Message is always "Something went wrong". |
| `NOT_FOUND` | 404 | `not_found` | Resource not found. Also returned for a malformed database id that got past the edge. |
| `VALIDATION_ERROR` | 400 | `validation` | Schema failure. Carries `details.fields`. |
| `RATE_LIMIT_EXCEEDED` | 429 | `rate_limit` | Carries `details.retryAfterSeconds`. |

### Malformed request (before any schema)

| Code | Status | Category | Meaning |
|---|---|---|---|
| `REQUEST_BODY_INVALID` | 400 | `validation` | The body is not parseable JSON. |
| `REQUEST_BODY_TOO_LARGE` | 413 | `validation` | Over the 1 MB ceiling, or too many form parameters. |
| `REQUEST_MEDIA_TYPE_UNSUPPORTED` | 415 | `validation` | Unsupported `Content-Type` or charset. Send `application/json; charset=utf-8`. |

### Authentication — `ADMIN_AUTH_*`

| Code | Status | Category | Meaning |
|---|---|---|---|
| `ADMIN_AUTH_INVALID_CREDENTIALS` | 401 | `authentication` | **The only code a failed login returns**, whatever the cause. Splitting it would make the login form an account-existence oracle. |
| `ADMIN_AUTH_ACCOUNT_LOCKED` | 423 | `authentication` | The deliberate exception: too many failed attempts. Telling a locked-out admin to wait is worth confirming the account exists. |
| `ADMIN_AUTH_ACCOUNT_SUSPENDED` | 403 | `authentication` | The account is suspended. All its sessions have just been destroyed. |
| `ADMIN_AUTH_MISSING_TOKEN` | 401 | `authentication` | No cookie and no bearer header. |
| `ADMIN_AUTH_TOKEN_INVALID` | 401 | `authentication` | Signature or shape is wrong. |
| `ADMIN_AUTH_TOKEN_EXPIRED` | 401 | `authentication` | Access token expired. **Call `POST /auth/refresh`.** |
| `ADMIN_AUTH_SESSION_REVOKED` | 401 | `authentication` | Signature verified but the session is gone — logged out, revoked, or idle-expired. |
| `ADMIN_AUTH_SESSION_EXPIRED` | 401 | `authentication` | The session passed its absolute cap. |
| `ADMIN_AUTH_REFRESH_REUSED` | 401 | `authentication` | A superseded refresh token was presented. The whole session is destroyed. |
| `ADMIN_AUTH_MFA_REQUIRED` | 403 | `authentication` | The session still owes MFA enrolment. Route to setup. |
| `ADMIN_AUTH_MFA_INVALID` | 401 | `authentication` | Wrong or reused TOTP code. |
| `ADMIN_AUTH_MFA_ALREADY_ENROLLED` | 409 | `conflict` | Re-enrolling would silently invalidate the live authenticator. |
| `ADMIN_AUTH_MFA_NOT_ENROLLED` | 409 | `conflict` | Two-factor is not set up. |
| `ADMIN_AUTH_CSRF_INVALID` | 403 | `authentication` | Missing or mismatched `X-CSRF-Token`. The remedy is a fresh token, not a different permission. |
| `ADMIN_AUTH_PASSWORD_WEAK` | 422 | `business_rule` | The new password fails policy. `details` names which rules. |

### Authorization — `AUTHZ_*`

| Code | Status | Category | Meaning |
|---|---|---|---|
| `AUTHZ_PERMISSION_DENIED` | 403 | `authorization` | The caller's level does not grant the route's permission. `details.required` names it. |
| `AUTHZ_TIER_INSUFFICIENT` | 403 | `authorization` | A bare level floor. Reserved; the permission guard is the normal path. |
| `AUTHZ_SELF_ACTION_FORBIDDEN` | 403 | `authorization` | Suspending, demoting or resetting **yourself**. Refused whatever you hold. |
| `AUTHZ_TARGET_TIER_PROTECTED` | 403 | `authorization` | The target administrator is at or above your own level. |
| `AUTHZ_TIER_ESCALATION_FORBIDDEN` | 403 | `authorization` | Assigning a level at or above your own. |
| `AUTHZ_APPROVAL_REQUIRED` | 409 | `conflict` | The action cannot be taken directly and has no approval path from here. Raised when creating an administrator **at Developer level**: create at a lower level, then request a promotion, which the queue reviews. **Not** the happy path — a queued action answers `202`. |
| `AUTHZ_APPROVAL_NOT_FOUND` | 404 | `not_found` | No such approval request. |
| `AUTHZ_APPROVAL_SELF_APPROVAL` | 403 | `authorization` | You cannot approve your own request. That is the entire point. |
| `AUTHZ_APPROVAL_EXPIRED` | 409 | `conflict` | The request passed `ADMIN_APPROVAL_TTL_S` (default 24 h). |
| `AUTHZ_APPROVAL_ALREADY_RESOLVED` | 409 | `conflict` | Already approved, rejected or cancelled. |
| `AUTHZ_ROUTE_UNDECLARED` | 500 | `internal` | **Boot-time.** A route registered without declaring who may call it. |
| `AUTHZ_GRANT_TABLE_INVALID` | 500 | `internal` | **Boot-time.** The level→permission table is inconsistent. |

### Administrator accounts

| Code | Status | Category | Meaning |
|---|---|---|---|
| `ADMIN_ACCOUNT_NOT_FOUND` | 404 | `not_found` | No such administrator. |
| `ADMIN_ACCOUNT_ALREADY_EXISTS` | 409 | `conflict` | Email collision. Named rather than hidden — creating an administrator is an authorized act, unlike the login form. |
| `ADMIN_SESSION_NOT_FOUND` | 404 | `not_found` | No such session for this administrator. |

### Audit

| Code | Status | Category | Meaning |
|---|---|---|---|
| `AUDIT_ENTRY_NOT_FOUND` | 404 | `not_found` | No such audit row, or it is outside your read scope. |
| `AUDIT_EXPORT_NOT_FOUND` | 404 | `not_found` | No such export. |
| `AUDIT_EXPORT_TOO_LARGE` | 422 | `business_rule` | The range exceeds `ADMIN_AUDIT_EXPORT_API_MAX_ROWS` (default 50 000). Narrow it, or use the CLI. |
| `AUDIT_EXPORT_INCOMPLETE` | 409 | `conflict` | The export did not finish, so its file is not available. |
| `AUDIT_EXPORT_FILE_MISSING` | 410 | `not_found` | The export record exists; the file is no longer on disk. |

| `AUDIT_STORE_NOT_TRANSACTIONAL` | 500 | `internal` | **Boot-time.** The wi-admin database is not a replica set, so audited writes cannot be atomic. Fails closed. |
| `AUDIT_CATALOG_INVALID` | 500 | `internal` | **Boot-time.** The action registry names an unknown permission/target/family. |
| `AUDIT_COVERAGE_INCOMPLETE` | 500 | `internal` | **Boot-time.** A mutation records nothing, or a catalogued action has no producer. |

### System and developer tools

| Code | Status | Category | Meaning |
|---|---|---|---|
| `DEV_TOOLS_DISABLED` | 409 | `business_rule` | The `dev_tools.enabled` flag is off. 409 not 403: you *hold* the permission; the service is refusing right now. |
| `DEV_TOOLS_WORKER_UNKNOWN` | 404 | `not_found` | No such background worker in jovi-mall's registry. **Arrives as `details.platformCode` on a `PLATFORM_OPERATION_REJECTED`**, not as `error.code`. |
| `DEV_TOOLS_WORKER_BUSY` | 409 | `conflict` | That worker is already running. Not queued — two concurrent passes is what the mutex prevents. **Also arrives as `details.platformCode`.** |
| `SYSTEM_ERROR_QUERY_TOO_BROAD` | 400 | `validation` | A Support-level error-journal query with no reference and no bounded window. Add a `requestId`, or a `code` plus a `since`. |
| `SYSTEM_CONFIG_EXPOSURE_UNSAFE` | 500 | `internal` | **Boot-time.** The exposed-config list names a secret. |
| `SYSTEM_FEATURE_FLAG_CATALOG_INVALID` | 500 | `internal` | **Boot-time.** The feature-flag registry is inconsistent. |

### Money and accounts

| Code | Status | Category | Meaning |
|---|---|---|---|
| `PAYOUT_DESTINATION_ABSENT` | 422 | `business_rule` | The payout exists but carries no destination snapshot. **Distinct from `NOT_FOUND`** — this is a legacy row an operator resolves by asking the beneficiary, not a broken link, which is why it is a 422 rather than a 404. |
| `PAYOUT_NOT_PENDING` | 409 | `conflict` | The payout is no longer `pending`. Raised on the `mark-paid` pre-flight (so a doomed action is never queued for approval) and again when an approval is committed. |
| `ACCOUNT_OWNER_NOT_FOUND` | 404 | `not_found` | `:ownerType/:ownerId` names no vendor, agency or agent. **An owner with no balances is not this** — that reports zeroes. |

### Delivery network

| Code | Status | Category | Meaning |
|---|---|---|---|
| `CONTRACT_NOT_FOUND` | 404 | `not_found` | No agent↔agency contract with this id. Its own code rather than a bare `NOT_FOUND` because `/contracts/:contractId` is addressable and the id is what a support ticket carries — a client showing "not found" needs to say *what* was not found, and the neighbouring 404s on that screen are about agents and agencies. |
| `CONTRACT_INVALID_TRANSITION` | 409 | `conflict` | The contract is not in a status this verb can move it from — reinstating one that is already `active`, suspending one that is `deactivated`. `details` names the transition, the current `from`, and the `allowedFrom` set. **Arrives as `details.platformCode` on a `PLATFORM_OPERATION_REJECTED`.** |
| `CONTRACT_TRANSITION_NOT_PERMITTED` | 403 | `authorization` | The transition exists but not for the party attempting it. Reachable from the admin surface only as a platform-side guard; the three administrative writes are chosen to be ones the agency holds unilaterally. **Arrives as `details.platformCode`.** |

### Tracking data door

The three outcomes of a read against geo-tracker's scoped data door (ADR-020). **Three codes
rather than one**, because the remedies are three different people: an operator's deployment,
geo-tracker's scope configuration, and somebody's pager. A single "tracking unavailable" makes
all three look like an outage.

None of them is a fault in *this* service, and none of them ever fails the service itself —
the geo-tracker clients never throw, so a door failure fails the **request** only.

| Code | Status | Category | Meaning |
|---|---|---|---|
| `TRACKING_DOOR_UNCONFIGURED` | 503 | `external_service` | **This deployment has no data door** — `GEO_TRACKER_DATA_BASE_URL` / `GEO_TRACKER_ADMIN_TOKEN` are unset. The door is **optional by design**, so this is a configuration state and not an incident: say "live tracking is not enabled here", not "something went wrong". Probe it without disclosing anything (and without writing an audit row) via the `configured` flag on the tracking reads. |
| `TRACKING_DOOR_REFUSED` | 502 | `external_service` | geo-tracker answered **and refused** — typically a capability missing from `GEO_TRACKER_ADMIN_SCOPES`, or a rejected `reason`. Its own code survives the hop, since both services share one error envelope: `details.upstreamCode` and `details.upstreamStatus` carry it, so a client can say *why*. The remedy is geo-tracker's scope configuration. |
| `TRACKING_DOOR_UNAVAILABLE` | 503 | `external_service` | geo-tracker could not be **reached** — timeout, connection refused, unparseable answer. The only one of the three that is an incident. Retry. |

> ⚠ **A read that emits coordinates writes its audit row BEFORE the disclosure, and does not
> catch a failure of that write.** So a fourth outcome exists that is none of these: with the
> audit store unreachable, the request fails and **nothing is disclosed**. That is deliberate
> (ADR-020 D-5) and is the same fail-closed posture as `money.payouts.destination.read`.

### Billing

| Code | Status | Category | Meaning |
|---|---|---|---|
| `BILLING_PENDING_PLAN_EXISTS` | 409 | `conflict` | The owner **already has a plan queued** behind their current one. **Reachable on a completely ordinary path**: assigning to an owner whose paid term has not lapsed produces a *queued* row rather than replacing the live one, so a second assignment hits this. Pre-empt it by reading `queued` on `GET /billing/subscriptions/:ownerType/:ownerId`. **Arrives as `details.platformCode`.** |
| `BILLING_PLAN_INACTIVE` | 409 | `conflict` | The plan is defined but not purchasable. **Arrives as `details.platformCode`.** |
| `BILLING_PLAN_ROLE_MISMATCH` | 409 | `conflict` | The plan's role does not match the owner's — a vendor plan assigned to an agency. **Arrives as `details.platformCode`.** |

> Neither of the last two is pre-checked by this service: they are the platform's verdicts to
> make, and a copy would be a second opinion about what a plan may be assigned to.

### Files

| Code | Status | Category | Meaning |
|---|---|---|---|
| `FILE_NOT_FOUND` | 404 | `not_found` | `GET /files/:fileId` resolved nothing. **Reachable on an ordinary path and not a client bug** — files are soft-deleted and swept by file-cleanup, so a record legitimately outlives the picture it references. Render the absence rather than an error banner. The batch form (`GET /files?ids=`) never raises this: unresolvable ids are simply **absent** from its result. |
| `FILE_DELETE_NOT_CONFIRMED` | 400 | `validation` | `DELETE /files/:fileId/permanent` was called without `confirmFileId` matching the id in the path. **Nothing was deleted.** Not a schema failure — the shape was valid and the two ids disagreed — so it is its own code rather than a `VALIDATION_ERROR` with a field list. The confirmation exists because this is the only unrecoverable operation on the service (the `outbox.prune` precedent): make the operator restate the value that decides the blast radius. |
| `FILE_UPLOAD_NOT_MULTIPART` | 415 | `validation` | `POST /files/upload` was sent something that is not `multipart/form-data`. **Not a `VALIDATION_ERROR`, and it could not be**: this service never *parses* a multipart body — it is piped to jovi-mall unread (ADR-021 D-2) — so there is no parsed body for a schema to validate and no field path to report. What can be checked without parsing is the `Content-Type`, and it must be: a JSON body forwarded to jovi-mall's parser comes back as `NO_FILES_UPLOADED`, a refusal in another service's vocabulary about a request the caller never addressed there. `details.fieldName` is the multipart field to use (`files`); `details.received` echoes what you sent. **415 rather than 400** so it is distinguishable from a malformed body, which is a different fix. |
| `FILE_UPLOAD_TOO_LARGE` | 413 | `validation` | `POST /files/upload` exceeded **this service's** ceiling, `ADMIN_UPLOAD_MAX_BYTES` (32 MiB by default, the whole request body). ⚠ **Not jovi-mall's limit** — its per-request ceiling is keyed on a session role and an administrator's figure there is 2 GB, chosen for a surface an administrator can no longer reach. wi-admin declares its own, sized for what an administrator actually uploads, and refuses **before** the hop so a doomed body is never streamed across it. Enforced twice: on `Content-Length` when you send one, and on the bytes as they flow when you do not (a chunked upload declares no length, and a ceiling that only reads a header is one any client can opt out of). `details.maxBytes` carries the limit — render that rather than restating a constant that may drift. |
| `FILE_CONTENT_NOT_SUPPORTED` | 409 | `business_rule` | `GET /files/:fileId/content` cannot be served because **this deployment's storage provider has no way to read file bytes**. jovi-mall implements that on the `local` provider and not on `firebase` or `cloudinary`. ⚠ **A configuration state, not an outage** — it will be true for every file until `STORAGE_PROVIDER` changes, so render "this platform cannot display private files" rather than a retry button. `details.platformCode` is `STORAGE_DOWNLOAD_NOT_SUPPORTED`. **409, not 5xx, deliberately**: at `external_service` the boundary filter would replace the message with a registry default and drop `details`, losing the provider name that says why. |

### Support tickets

| Code | Status | Category | Meaning |
|---|---|---|---|
| `TICKET_NOT_FOUND` | 404 | `not_found` | No ticket with this id — or one that exists outside the caller's scope. **Both answer 404 rather than 403**, deliberately: a scoped caller must not learn that a ticket they may not see exists. |
| `TICKET_ALREADY_ASSIGNED` | 409 | `conflict` | Another administrator claimed the ticket first. **This is the code that makes `availableActions.claim` a best-effort hint rather than a guarantee** — the flag is computed when the queue was read, and a shared queue moves between the read and the click. Expected on a busy queue, not a client bug: refresh the row and show who holds it. |

### Content — the blog editor

Ten codes, all raised in-process (this service owns the `articles` and `article_authors`
collections), so every one arrives as `error.code` — **none of these is a
`details.platformCode`**.

| Code | Status | Category | Meaning |
|---|---|---|---|
| `BLOG_ARTICLE_NOT_FOUND` | 404 | `not_found` | No article with this id. **Also raised when the article exists but has no translation in the requested language**, with `details.locale` naming it — the same code because a missing translation and a missing article are the same absence to a reader following a link. |
| `BLOG_ARTICLE_KEY_TAKEN` | 409 | `conflict` | An article already uses this id. `details.id`. Ids are author-chosen rather than generated, so this is an ordinary editing collision. |
| `BLOG_ARTICLE_NOT_PUBLISHABLE` | 422 | `business_rule` | The article is not ready to publish. **`details.blockers` is the FULL checklist, not the first failure** — an array of human-readable strings, every unmet requirement at once. **Render all of them.** A client that shows one line at a time makes the publish button feel broken over three round-trips, which is exactly what the checklist exists to prevent. |
| `BLOG_ARTICLE_ALREADY_PUBLISHED` | 409 | `conflict` | Publishing an article that is already published. `details.id`. |
| `BLOG_ARTICLE_DELETE_NOT_ALLOWED` | 409 | `conflict` | **The test is `published_at`, not `status`** — an already-*unpublished* article still refuses deletion, because the address was live once and may have inbound links a 404 would waste. Surprising and correct. `details.publishedAt` carries when it went live. The remedy for a published mistake is **archive** (410 + the category hub), not delete. |
| `BLOG_SLUG_TAKEN` | 409 | `conflict` | Another article already answers to this slug **in that language**. `details.locale` + `details.slug`. Slugs are unique per locale, not globally. |
| `BLOG_SLUG_RESERVED` | 400 | `validation` | The slug would collide with a route on the public site. `details.reserved` carries the whole reserved list, so a client can validate before submitting rather than guessing. |
| `BLOG_AUTHOR_NOT_FOUND` | 404 | `not_found` | No author with this id. Raised on the author routes with `details.id`, **and on an article write** with `details.authorId` when the byline it credits does not exist. |
| `BLOG_AUTHOR_KEY_TAKEN` | 409 | `conflict` | An author already uses this id. `details.id`. |
| `BLOG_AUTHOR_IN_USE` | 409 | `conflict` | Articles still credit this byline, so it cannot be removed. **`details.articleCount`** — say the number; "cannot delete" without it leaves the editor with no next step. Reassign those articles first. |

### Credential recovery

Every one of these arrives as `details.platformCode` on a `PLATFORM_OPERATION_REJECTED`,
since the send is delegated to jovi-mall. Branch on `platformCode`, not on `error.code`.

| Code | Status | Category | Meaning |
|---|---|---|---|
| `USER_CHANNEL_UNAVAILABLE` | 409 | `conflict` | The party has no address on the requested channel — no `email`, no `phone`, or (for `telegram`) no connected chat. Telegram exists only once the person has run `/connect` with the bot; the platform stores no `chatId` on any party, so there is nothing to fall back to. |
| `USER_CREDENTIAL_LINK_THROTTLED` | 429 | `rate_limit` | Too many links recently. **`details.scope` is `party` or `administrator`** and the two have different remedies — wait, versus ask a colleague. `details.retryAfterSeconds` carries the wait. |
| `USER_LOGIN_LINK_ROLE_UNSUPPORTED` | 409 | `conflict` | A sign-in link was asked for on an account that is not a customer. Structural rather than configurable: jovi-mall scopes every session that flow mints to `customer` as a literal, because a vendor, agency or agent reaches money and other people's data. Send a **password-reset link** instead. |
| `MESSAGING_DELIVERY_FAILED` | 502 | `external_service` | The channel accepted the request and did not deliver. **Raised rather than swallowed**, unlike the self-service reset path — that one must answer identically whether or not the account exists, while here an administrator is watching a dialog and "sent" when nothing was sent closes the ticket with the party still locked out. Offer another channel. |
| `AUTH_ACCOUNT_SUSPENDED` | 409 | `conflict` | The party's account is suspended, so there is nothing to send them back into. Reinstate first. **Arrives as `details.platformCode`**, and note the status differs from the 403 the same code carries on jovi-mall's own login path. |

> **There is no `USER_CHANNEL_UNVERIFIED`, and that is a decision.** jovi-mall's `users` row
> carries no `email_verified` — verification flags live on the ROLE entities, a user may hold
> several roles, and `login_email` is the login identifier itself: the address
> `POST /auth/forgot-password` already mails a live reset token to, anonymously, with no
> check at all. Gating the administrator path more tightly than the path an attacker can
> drive would protect nothing.

### Notifications

| Code | Status | Category | Meaning |
|---|---|---|---|
| `NOTIFICATION_NOT_FOUND` | 404 | `not_found` | The only code this surface raises. Also covers "exists, addressed to someone else" and "exists, but your level no longer holds the permission it is gated on" — both 404 rather than 403, deliberately. |

### Infrastructure and configuration

| Code | Status | Category | Meaning |
|---|---|---|---|
| `SERVICE_DEPENDENCY_UNAVAILABLE` | 502 / 503 | `external_service` | Mongo, Redis or jovi-mall was unreachable. Always `external_service`, at any status. |
| `PLATFORM_OPERATION_REJECTED` | jovi-mall's own 4xx | derived from that status | The platform refused a delegated operation. See above. |
| `DATABASE_UNIQUE_CONSTRAINT_VIOLATION` | 409 | `conflict` | A unique index rejected the write. `details.keyValue` names the colliding fields. |
| `CONFIG_INVALID_ENV` | 500 | `internal` | **Boot-time.** |
| `CONFIG_MISSING_SECRET` | 500 | `internal` | **Boot-time.** |
| `CONFIG_NOTIFICATION_COVERAGE_INCOMPLETE` | 500 | `internal` | **Boot-time.** A notification type has no producer, or a source gates on an unknown permission. |

---

## Overrides

Four codes are categorised against the status table, because the status alone gives the wrong
client behaviour:

| Code | Status | Category used | Why |
|---|---|---|---|
| `ADMIN_AUTH_ACCOUNT_SUSPENDED` | 403 | `authentication` | Not a per-resource denial — the account cannot authenticate at all. "Sign out" is the right handler, not "try something else". |
| `ADMIN_AUTH_MFA_REQUIRED` | 403 | `authentication` | Names an unfinished credential step; the session is half-authenticated. |
| `ADMIN_AUTH_CSRF_INVALID` | 403 | `authentication` | Nothing about the caller's grants is wrong — the request could not be attributed to them. |
| `ADMIN_AUTH_ACCOUNT_LOCKED` | 423 | `authentication` | A credential outcome, not a business rule. |
| `DEV_TOOLS_DISABLED` | 409 | `business_rule` | Nothing changed underneath the caller, so `conflict` would send them hunting a race that is not there. |

---

## Support hints

For a support-facing UI, these one-liners are the intended per-category explanation:

| Category | Hint |
|---|---|
| `authentication` | The caller was not signed in, or their session had ended. Ask them to sign in again. |
| `authorization` | The caller is signed in but reached something that is not theirs. Check which account and role they are using. |
| `validation` | The request was malformed or failed a field rule. Usually a client-side problem — ask what they entered. |
| `not_found` | The record does not exist, or does not belong to that caller. Confirm the reference they used. |
| `conflict` | Something changed underneath them — often another person acting at the same moment. Ask them to reload and retry. |
| `business_rule` | The platform refused this on purpose. The message explains which rule; it is not a fault. |
| `rate_limit` | Too many requests in a short window. It clears itself — ask them to wait a minute before retrying. |
| `external_service` | A service we depend on did not respond. Not the caller's fault and not fixable by them — escalate with the reference. |
| `internal` | A fault on our side. Nothing the caller can do. Escalate with the reference. |

These are also what `GET /api/v1/system/errors` returns to a Support-level caller in place of
the internal message. See [system.md](system.md).
