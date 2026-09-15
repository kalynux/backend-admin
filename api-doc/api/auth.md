# `/auth` — administrator authentication

**Amended 2026-09-15 (BR-025 § 1)** — the **three `/auth/me/phone*` routes** were served, audited and reachable but appeared on no contract page at all, so a route map extended from the contract could not see them. They are documented below, together with the `phone` / `phoneVerified` pair the profile object has always carried. ⚠ Two behaviours BR-025 reported are **already stale**: the `422` and the `409` were given named codes on 2026-09-14 and are no longer `VALIDATION_ERROR`. The `status` row was corrected too — it has carried three values since ADR-023.

**Verified against source on 2026-09-08** — all eleven routes, their access kinds and their audit declarations against `admin-identity/routes/auth.routes.ts`; every request schema against `admin-identity/validators/auth.validator.ts`; the eight lifetime/limit defaults against `admin/src/config/env.ts:87-139`; the two rate-limit buckets against `api/middlewares/auth-rate-limit.middleware.ts`; the password policy against `admin-identity/domain/password.service.ts:30-71`; and the `422` detail exposure against `core/errors/detail-policy.ts` + `password.service.ts:75-95` (the detail key is now `failedRules`; pinned by `test:contract` § 11).

Base path: `/api/v1/auth`

Login, two-factor, session rotation, session listing, self-service password change — and the
administrator’s own contact phone number. The first three are the only routes on the service
that can be reached with no identity, and the list is closed — a fourth public route requires
editing a boot-checked allowlist.

| Method | Path | Access | Audited |
|---|---|---|---|
| `POST` | `/auth/login` | **public** | ✅ every outcome |
| `POST` | `/auth/mfa/verify` | **public** | ✅ |
| `POST` | `/auth/refresh` | **public** | only on reuse detection |
| `GET` | `/auth/me` | authenticated *(reachable mid-enrolment)* | — |
| `GET` | `/auth/sessions` | authenticated (self) | — |
| `POST` | `/auth/logout` | authenticated *(reachable mid-enrolment)* | ✅ |
| `POST` | `/auth/logout-all` | authenticated (self) | ✅ |
| `POST` | `/auth/password` | authenticated (self) | ✅ |
| `DELETE` | `/auth/sessions/:sessionId` | authenticated (self) | ✅ |
| `POST` | `/auth/mfa/enroll` | authenticated *(reachable mid-enrolment)* | ✅ |
| `POST` | `/auth/mfa/activate` | authenticated *(reachable mid-enrolment)* | ✅ |
| `PATCH` | `/auth/me/phone` | authenticated (self) **— activated only** | ✅ |
| `POST` | `/auth/me/phone/verify/request` | authenticated (self) **— activated only** | only on failure |
| `POST` | `/auth/me/phone/verify/confirm` | authenticated (self) **— activated only** | ✅ |

No endpoint on this surface requires a permission — every route acts on the caller's own
identity, and requiring a permission would let a level be locked out of its own account.

**Rate limiting — two per-IP buckets, and `/refresh` is deliberately not in the strict one.**
Both are Redis-backed, so the counter is shared across instances, and both use a 60-second window.

| Bucket | Routes | Ceiling | Redis prefix |
|---|---|---|---|
| **credential** | `/auth/login` · `/auth/mfa/verify` · `/auth/password` | **10/min/IP** (`ADMIN_AUTH_RATE_LIMIT_MAX`) | `auth-rl:` |
| **refresh** | `/auth/refresh` **only** | **60/min/IP** (`ADMIN_REFRESH_RATE_LIMIT_MAX`) | `refresh-rl:` |

A refresh presents a rotating token the caller already holds, so it is not a guess and does not
belong in a brute-force budget. Sharing one bucket meant a handful of tab reloads exhausted the
allowance — and a client cannot tell a rate-limited refresh from a dead session, so it signed the
operator out of a live one.

⚠ **Neither auth bucket sends `details.retryAfterSeconds`.** Its `429` carries the message
*"Too many authentication attempts"* and no `details` at all; only the global and per-identity
limiters populate that field. Read the `draft-7` `RateLimit` response headers instead.

The remaining routes use only the ordinary per-identity ceiling.

---

## The login flows

There are three possible outcomes to a correct password, and a client must handle all three.

```
POST /auth/login
   │
   ├─ password wrong / unknown / locked / suspended  →  401 or 423, no session
   │
   ├─ MFA enrolled            →  200 { mfaRequired: true, challengeId }
   │                                   │
   │                                   └─ POST /auth/mfa/verify { challengeId, code }
   │                                          → 200 full session
   │
   ├─ MFA required by level,  →  200 { …session…, mfaEnrolmentRequired: true }
   │  not yet enrolled              scoped session: reaches /auth/me, /auth/logout,
   │                                /auth/mfa/enroll, /auth/mfa/activate — nothing else
   │                                   │
   │                                   ├─ POST /auth/mfa/enroll   → secret + otpauth URI
   │                                   └─ POST /auth/mfa/activate → session ended,
   │                                          sign in again with the code
   │
   └─ ordinary                →  200 full session
```

Branch on the **presence of `mfaRequired`** and `mfaEnrolmentRequired` in `data`, not on the
status code — all three success shapes are `200`.

---

## `POST /auth/login`

Exchange an email and password for a session. **Public.**

| | |
|---|---|
| **Method / Path** | `POST /api/v1/auth/login` |
| **Authentication** | None |
| **Permission** | None |
| **CSRF** | Not required |
| **Rate limit** | Credential limiter — 10/min/IP |

### Request body

| Field | Type | Rules |
|---|---|---|
| `email` | string | Required. Trimmed, lower-cased, must be a valid address |
| `password` | string | Required, non-empty. **No format rule** — strength is enforced where a password is *set*, never where one is *checked*, so this is not an oracle for which candidates are worth trying |

```json
{ "email": "ada@wimall.cm", "password": "correct horse battery staple" }
```

### Response — ordinary success (200)

Also sets the three cookies (`admin_access_token`, `admin_refresh_token`, `admin_csrf_token`).

```jsonc
{
  "success": true,
  "data": {
    "admin": {
      "id": "665f1c2a9b3e4a91c7d2e5f0",
      "email": "ada@wimall.cm",
      "displayName": "Ada Nkemelu",
      "tier": 2,
      "status": "active",
      "jobTitle": "Operations Lead",
      "department": "Operations",
      "timezone": "Africa/Douala",
      "preferredLanguage": "en",
      "mfaEnrolled": false,
      "mfaRequired": false,
      "lastLoginAt": "2026-08-12T17:44:10.882Z",
      "createdAt": "2026-03-02T08:00:00.000Z"
    },
    "accessToken": "eyJhbGciOiJIUzI1NiIs…",
    "refreshToken": "eyJhbGciOiJIUzI1NiIs…",
    "expiresIn": 900,
    "csrfToken": "nJ8Qm3F7pQ2xVb…"
  }
}
```

| Field | Type | Notes |
|---|---|---|
| `admin` | object | The administrator profile — see the table below |
| `accessToken` | string | Also set as an httpOnly cookie. Use as `Authorization: Bearer …` if not using cookies |
| `refreshToken` | string | Also set as an httpOnly cookie |
| `expiresIn` | integer | Access-token lifetime in seconds (default **900**) |
| `csrfToken` | string | Echo in `X-CSRF-Token` on every cookie-authenticated write |

#### The `admin` profile object

Returned identically by `/auth/login`, `/auth/mfa/verify`, `/auth/refresh` and `/auth/me`.

| Field | Type | Notes |
|---|---|---|
| `id` | string | 24-hex |
| `email` | string | |
| `displayName` | string | |
| `tier` | `1` \| `2` \| `3` | 1 Developer, 2 Admin, 3 Support. **Lower = more privilege** |
| `status` | `"pending"` \| `"active"` \| `"suspended"` | ⚠ **Three values, not two.** A suspended administrator cannot reach this response at all; a `pending` one **can log in**, and is then refused with `403 ADMIN_ACTIVATION_REQUIRED` on everything outside the onboarding allowlist |
| `phone` | string \| null | The administrator's contact number. ⚠ **A contact detail, never a login factor** — see [the phone section](#the-administrators-own-phone-number) |
| `phoneVerified` | boolean | Proved by a WhatsApp OTP. ⚠ **Cleared by every write to `phone`**, including a write of the value already held |
| `jobTitle` | string \| null | |
| `department` | string \| null | |
| `timezone` | string \| null | IANA zone |
| `preferredLanguage` | string \| null | |
| `mfaEnrolled` | boolean | |
| `mfaRequired` | boolean | Whether this administrator's **level** mandates MFA |
| `lastLoginAt` | ISO-8601 \| null | |
| `createdAt` | ISO-8601 | |

### Response — MFA challenge (200)

`200`, **not** `401`: the password was correct. This is a step in the flow, not a failure, and
a client must be able to tell them apart. **No cookies are set.**

```jsonc
{
  "success": true,
  "data": { "mfaRequired": true, "challengeId": "7c1e0d2b-9a44-4d31-8f2c-0b6f1a3e9c55" },
  "message": "Enter your two-factor code"
}
```

The challenge lives **5 minutes**. Pass `challengeId` to `POST /auth/mfa/verify`.

### Response — MFA enrolment required (200)

A **real but scoped** session. Cookies are set. It reaches `/auth/me`, `/auth/logout`,
`/auth/mfa/enroll` and `/auth/mfa/activate`; every other route answers
`403 ADMIN_AUTH_MFA_REQUIRED`.

```jsonc
{
  "success": true,
  "data": {
    "admin": { "…": "…" },
    "accessToken": "…",
    "refreshToken": "…",
    "expiresIn": 900,
    "csrfToken": "…",
    "mfaEnrolmentRequired": true
  },
  "message": "Two-factor authentication must be set up before continuing"
}
```

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Malformed email, empty password |
| 401 | `ADMIN_AUTH_INVALID_CREDENTIALS` | **Unknown address, wrong password, or an account that cannot sign in — all one code.** Splitting it would make the form an account-existence oracle |
| 403 | `ADMIN_AUTH_ACCOUNT_SUSPENDED` | The account is suspended |
| 423 | `ADMIN_AUTH_ACCOUNT_LOCKED` | 5 failed attempts (`ADMIN_LOCKOUT_MAX_ATTEMPTS`) locks the account for 15 minutes (`ADMIN_LOCKOUT_DURATION_S`). The deliberate exception to the single-code rule — telling a locked-out admin to wait beats them retrying and extending their own lockout |
| 429 | `RATE_LIMIT_EXCEEDED` | Over 10 attempts/min from this IP |

The account-not-found path spends a real bcrypt comparison so its timing matches a genuine
failure.

### Audit

Records on **every** outcome: `administrators.auth.login_succeeded`,
`administrators.auth.login_failed`, `administrators.auth.lockout_engaged`,
`administrators.auth.mfa_challenged`.

---

## `POST /auth/mfa/verify`

Second factor of an in-progress login. **Public** — its credential is the short-lived challenge.

| | |
|---|---|
| **Method / Path** | `POST /api/v1/auth/mfa/verify` |
| **Authentication** | None (the challenge is the credential) |
| **Rate limit** | Credential limiter — 10/min/IP |

### Request body

| Field | Type | Rules |
|---|---|---|
| `challengeId` | string | Required. UUID, from the login response. Valid for **5 minutes**, single use |
| `code` | string | Required. Exactly **6 digits** — anything else is a client bug, not a wrong code |

```json
{ "challengeId": "7c1e0d2b-9a44-4d31-8f2c-0b6f1a3e9c55", "code": "418302" }
```

### Response (200)

Identical to the ordinary login success — `admin`, `accessToken`, `refreshToken`, `expiresIn`,
`csrfToken` — and sets the three cookies.

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Not a UUID, or not six digits |
| 401 | `ADMIN_AUTH_MFA_INVALID` | Wrong code, expired or already-consumed challenge, or a reused code |
| 429 | `RATE_LIMIT_EXCEEDED` | |

### Audit

`administrators.auth.mfa_failed` on rejection; `administrators.auth.login_succeeded` on success.

---

## `POST /auth/refresh`

Rotate an expired access token. **Public** — the whole point is to be callable once the access
token has expired. Its credential is the refresh token.

| | |
|---|---|
| **Method / Path** | `POST /api/v1/auth/refresh` |
| **Authentication** | The refresh token, from the `admin_refresh_token` cookie **or** the body |
| **Rate limit** | **Its own bucket — 60/min/IP** (`ADMIN_REFRESH_RATE_LIMIT_MAX`), *not* the 10/min credential one |

### Request body

Optional. Cookie clients send nothing.

| Field | Type | Rules |
|---|---|---|
| `refreshToken` | string | Only needed when there is no `admin_refresh_token` cookie |

```json
{ "refreshToken": "eyJhbGciOiJIUzI1NiIs…" }
```

### Response (200)

Identical to the ordinary login success, with a **new** refresh token — refresh tokens rotate on
every use. Sets fresh cookies.

### Errors

| Status | Code | When |
|---|---|---|
| 401 | `ADMIN_AUTH_MISSING_TOKEN` | No cookie and no body token |
| 401 | `ADMIN_AUTH_TOKEN_INVALID` / `ADMIN_AUTH_TOKEN_EXPIRED` | The refresh token itself is bad |
| 401 | `ADMIN_AUTH_REFRESH_REUSED` | **A superseded refresh token was presented — it leaked. The entire session is destroyed.** Sign in again |
| 401 | `ADMIN_AUTH_SESSION_REVOKED` / `ADMIN_AUTH_SESSION_EXPIRED` | The session is gone or past its absolute cap |
| 429 | `RATE_LIMIT_EXCEEDED` | |

**On any failure the three cookies are cleared**, so a browser holding dead cookies gets a clean
redirect to the login screen instead of a loop of failed retries.

### Audit

A successful rotation records **nothing** — an active administrator refreshes every fifteen
minutes and recording each would bury every real action. Reuse detection records
`administrators.auth.refresh_reuse_detected`, the single highest-value row in the log.

---

## `GET /auth/me`

Who am I, and what session is this?

| | |
|---|---|
| **Method / Path** | `GET /api/v1/auth/me` |
| **Authentication** | Required. **Also reachable by a session that still owes MFA enrolment, and by a `pending` account** |
| **Permission** | None |

⚠ **Check `admin.status` here before routing into the dashboard.** A `pending` administrator
signs in perfectly normally and is then refused every route outside their own account with
`403 ADMIN_ACTIVATION_REQUIRED`. Send them to the onboarding screen —
[`GET /employees/me`](employees.md) carries the checklist — rather than to a dashboard that will
answer 403 to everything it tries to load. See
[the account lifecycle](administrators.md#the-account-lifecycle).

### Response (200)

```jsonc
{
  "success": true,
  "data": {
    "admin": { "…the profile object…": "…" },
    "session": {
      "sessionId": "0f9c8b7a-6d5e-4c3b-2a19-8f7e6d5c4b3a",
      "authenticatedAt": "2026-08-13T07:02:44.019Z",
      "expiresAt": "2026-08-20T07:02:44.019Z",
      "authMethod": "cookie"
    }
  }
}
```

| Field | Type | Notes |
|---|---|---|
| `session.sessionId` | UUID | |
| `session.authenticatedAt` | ISO-8601 | When the session began — not when this request arrived |
| `session.expiresAt` | ISO-8601 | The **absolute** cap. Idle expiry is enforced separately and is not shown |
| `session.authMethod` | `"cookie"` \| `"bearer"` | Whether CSRF applies to this client's writes |

### Errors

| Status | Code |
|---|---|
| 401 | `ADMIN_AUTH_MISSING_TOKEN`, `ADMIN_AUTH_TOKEN_EXPIRED`, `ADMIN_AUTH_TOKEN_INVALID`, `ADMIN_AUTH_SESSION_REVOKED`, `ADMIN_AUTH_SESSION_EXPIRED` |
| 403 | `ADMIN_AUTH_ACCOUNT_SUSPENDED` |
| 404 | `ADMIN_ACCOUNT_NOT_FOUND` — the account was deleted while the session was live |

---

## `GET /auth/sessions`

List the caller's own live sessions, newest first.

| | |
|---|---|
| **Method / Path** | `GET /api/v1/auth/sessions` |
| **Authentication** | Required (self) |
| **Pagination** | **None** — a session list is inherently small |

### Response (200)

```jsonc
{
  "success": true,
  "data": [
    {
      "sessionId": "0f9c8b7a-6d5e-4c3b-2a19-8f7e6d5c4b3a",
      "startedAt": "2026-08-13T07:02:44.019Z",
      "absoluteExpiresAt": "2026-08-20T07:02:44.019Z",
      "ip": "102.244.18.7",
      "userAgent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) …",
      "mfaUsed": true,
      "current": true
    },
    {
      "sessionId": "b2c3d4e5-…",
      "startedAt": "2026-08-11T19:20:03.551Z",
      "absoluteExpiresAt": "2026-08-18T19:20:03.551Z",
      "ip": "41.202.219.90",
      "userAgent": "Mozilla/5.0 (Linux; Android 14) …",
      "mfaUsed": false,
      "current": false
    }
  ]
}
```

| Field | Type | Notes |
|---|---|---|
| `current` | boolean | Marks the session making this request |
| `mfaUsed` | boolean | Whether a second factor was presented when this session began |
| `ip`, `userAgent` | string \| null | As recorded at session start |

Sessions whose Redis TTL has expired are pruned from the index during this call rather than
being reported.

---

## `POST /auth/logout`

End **this** session server-side — not merely clear the cookies.

| | |
|---|---|
| **Method / Path** | `POST /api/v1/auth/logout` |
| **Authentication** | Required. **Also reachable mid-enrolment**, so an administrator can back out |
| **CSRF** | Required for cookie clients |
| **Request body** | None |

### Response (200)

```json
{ "success": true, "data": null, "message": "Signed out" }
```

The three cookies are cleared. The session is destroyed in Redis, so the access token stops
working on the very next request rather than at expiry.

### Audit

`administrators.auth.logout`

---

## `POST /auth/logout-all`

End **every** session belonging to the caller, on every device.

| | |
|---|---|
| **Method / Path** | `POST /api/v1/auth/logout-all` |
| **Authentication** | Required (self) |
| **CSRF** | Required for cookie clients |
| **Request body** | None |

### Response (200)

```json
{ "success": true, "data": { "sessionsEnded": 3 }, "message": "Signed out of all sessions" }
```

### Audit

`administrators.auth.logout_all`

---

## `DELETE /auth/sessions/:sessionId`

Revoke one of the caller's **own** sessions — "sign out on that device" from the session list.

Revoking *another administrator's* session is a different act and lives at
`DELETE /administrators/:adminId/sessions/:sessionId`, behind a permission.

| | |
|---|---|
| **Method / Path** | `DELETE /api/v1/auth/sessions/:sessionId` |
| **Authentication** | Required (self) |
| **CSRF** | Required for cookie clients |

### Path parameters

| Parameter | Type | Rules |
|---|---|---|
| `sessionId` | string | Required. **UUID** |

### Response (200)

```json
{ "success": true, "data": null, "message": "Session revoked" }
```

Revoking your **own current** session is legitimate; when you do, the cookies are cleared too.

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Not a UUID |
| 404 | `ADMIN_SESSION_NOT_FOUND` | No such session, or it belongs to another administrator |

### Audit

`administrators.auth.session_revoked`

---

## `POST /auth/password`

Change your own password.

| | |
|---|---|
| **Method / Path** | `POST /api/v1/auth/password` |
| **Authentication** | Required (self) |
| **CSRF** | Required for cookie clients |
| **Rate limit** | **Credential limiter — 10/min/IP.** It accepts a password, so it is a credential endpoint whatever the mount says; an unbounded one would be an oracle for guessing the current password from inside a stolen session |

### Request body

| Field | Type | Rules |
|---|---|---|
| `currentPassword` | string | Required, non-empty. Being *checked*, so no format rule |
| `newPassword` | string | Required, 1–200 characters at the schema, then checked against the policy below. Must differ from `currentPassword` |

```json
{ "currentPassword": "old passphrase here", "newPassword": "a much better passphrase" }
```

### Password policy

Enforced where a password is **set** — never where one is checked:

- at least **12** characters
- at most **200** characters
- not on the common-password list (nine literal entries, `password.service.ts:40`)
- not a single repeated character

> ### The `422` names the rules you broke — under `details.failedRules`
>
> The throw site attaches `details.failedRules`: an array of phrases completing *"your password
> …"*, one per rule that failed — `"must be at least 12 characters"`, `"is too common"`,
> `"cannot be a single repeated character"`. Render them as a list.
>
> ```json
> {
>   "success": false,
>   "requestId": "req_01J...",
>   "error": {
>     "code": "ADMIN_AUTH_PASSWORD_WEAK",
>     "message": "Password does not meet the minimum requirements",
>     "statusCode": 422,
>     "category": "business_rule",
>     "details": { "failedRules": ["must be at least 12 characters", "is too common"] }
>   }
> }
> ```
>
> Only the **failed** rules appear, so the array is never empty on a 422 and never lists all
> four. Still state the policy on the form up front and validate the length client-side — this
> is the server confirming a refusal, not the only place the rules are published.
>
> ⚠️ **The key is `failedRules`, not `problems`, and the difference is not cosmetic.** Until
> 2026-09-08 the throw site used `problems`, which is on the boundary’s always-dropped
> internal-key list (it is the boot assertions’ diagnostic payload) and is dropped in **every**
> category — so the object emptied, `details` was omitted, and a client received the fixed
> message and nothing else. If you built a form against that behaviour, the details now arrive.

### Response (200)

```json
{
  "success": true,
  "data": { "sessionsEnded": 2 },
  "message": "Password changed. 2 other session(s) were signed out."
}
```

Every **other** session is ended; the caller keeps theirs.

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Missing field, or the new password equals the current one |
| 401 | `ADMIN_AUTH_INVALID_CREDENTIALS` | `currentPassword` is wrong |
| 422 | `ADMIN_AUTH_PASSWORD_WEAK` | Policy failure. `details.failedRules` lists the rules that broke — see the box above |
| 429 | `RATE_LIMIT_EXCEEDED` | |

### Audit

`administrators.auth.password_changed` — on failure as well as success.

---

## `POST /auth/mfa/enroll`

Begin TOTP enrolment. Issues a secret but does **not** activate it.

| | |
|---|---|
| **Method / Path** | `POST /api/v1/auth/mfa/enroll` |
| **Authentication** | Required. **Also reachable mid-enrolment** — this is the route a scoped session exists to reach |
| **CSRF** | Required for cookie clients |
| **Request body** | None |

### Response (200)

```jsonc
{
  "success": true,
  "data": {
    "secret": "JBSWY3DPEHPK3PXP",
    "otpauthUri": "otpauth://totp/wi-admin:ada%40wimall.cm?secret=JBSWY3DPEHPK3PXP&issuer=wi-admin"
  },
  "message": "Scan the QR code, then confirm with a code to activate"
}
```

**The plaintext secret is returned exactly once, here**, so the administrator can type it if the
QR will not scan. Render `otpauthUri` as a QR code. Neither value appears in the audit row.

### Errors

| Status | Code | When |
|---|---|---|
| 404 | `ADMIN_ACCOUNT_NOT_FOUND` | |
| 409 | `ADMIN_AUTH_MFA_ALREADY_ENROLLED` | Re-enrolling would silently invalidate the authenticator currently in use. Disabling must be a separate, explicit act |

### Audit

`administrators.auth.mfa_enrolled` — recorded **transactionally**, because it writes the staged
secret to the account row.

---

## `POST /auth/mfa/activate`

Confirm enrolment with a first correct code. A correct code proves the authenticator holds the
secret.

| | |
|---|---|
| **Method / Path** | `POST /api/v1/auth/mfa/activate` |
| **Authentication** | Required. **Also reachable mid-enrolment** |
| **CSRF** | Required for cookie clients |

### Request body

| Field | Type | Rules |
|---|---|---|
| `code` | string | Required. Exactly 6 digits |

```json
{ "code": "418302" }
```

### Response — ordinary session (200)

```json
{ "success": true, "data": null, "message": "Two-factor authentication is now active" }
```

### Response — the session was a scoped enrolment session (200)

```jsonc
{
  "success": true,
  "data": { "reauthenticationRequired": true },
  "message": "Two-factor authentication is active. Sign in again with your code."
}
```

The scoped session is **ended** and the cookies cleared. Upgrading it in place would hand out a
full session that never presented a second factor. Branch on `data.reauthenticationRequired`
and route to the login screen.

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Not six digits |
| 401 | `ADMIN_AUTH_MFA_INVALID` | Wrong code. **Attempts are counted against the lockout** |
| 409 | `ADMIN_AUTH_MFA_NOT_ENROLLED` | No staged secret — call `/auth/mfa/enroll` first |
| 423 | `ADMIN_AUTH_ACCOUNT_LOCKED` | Too many wrong codes |

### Audit

`administrators.auth.mfa_activated`

---

## The administrator's own phone number

**Three routes, all self-service, and none of them touches the login.** Added with ADR-023.

| | |
|---|---|
| **Method / Path** | `PATCH /api/v1/auth/me/phone` · `POST /api/v1/auth/me/phone/verify/request` · `POST /api/v1/auth/me/phone/verify/confirm` |
| **Authentication** | Required (self) — **and an ACTIVATED account**, see below |
| **CSRF** | Required for cookie clients |
| **Rate limit** | The ordinary per-identity ceiling here. ⚠ The *real* limits are jovi-mall's, on the code itself |

⛔ **This is a CONTACT detail, not a second login factor, and please do not "complete" it by
making it one.** Administrators already hold TOTP, which is stronger than a WhatsApp OTP, so
gating the login on `phone_verified` would *weaken* it rather than harden it. Nothing in the
auth path reads either field — verified by scan, and `auth.routes.ts` says so at the routes
themselves. It exists so the platform knows how to reach a human being.

⚠ **A `pending` administrator cannot reach any of the three.** They are not on
`ONBOARDING_ROUTE_ALLOWLIST`, so the gate answers `403 ADMIN_ACTIVATION_REQUIRED` — and that is
correct rather than an oversight: **a verified phone is not part of activation.** The readiness
check requires *a phone number on the employee record* (gap code `phone_missing`, section
`contact`) and never consults `phone_verified`. Render the card only once the account is
`active`.

### Where the two fields live

`phone` and `phoneVerified` are on the **`admin` profile object** documented above — so
`/auth/login`, `/auth/mfa/verify`, `/auth/refresh` and `/auth/me` all carry the current state,
and no separate read is needed after a write.

### `PATCH /auth/me/phone`

| Field | Type | Rules |
|---|---|---|
| `phone` | string | Required, **6–20 characters**. `.strict()` — any other key is a `400` |

```json
{ "phone": "+237677001122" }
```

Response: `{ "phone": "+237677001122", "verified": false }`

⚠ **Saving a number ALWAYS clears `phone_verified` — including saving the value already held.**
There is no "same number, keep the flag" path, and the alternative is worse than it looks: a row
claiming a number is proved while holding a *different* number is worse than an unverified one,
because unverified is at least honest. **Warn before the write**; afterwards there is nothing to
undo but the whole OTP round trip.

Audited: `administrators.profile.phone_set`.

### `POST /auth/me/phone/verify/request`

**No body.** The number is read from the account — a caller cannot name one.

Response: `{ "phoneMasked": "+237•••••1122", "expiresAt": "…", "delivery": "text" | "template" }`

⚠ `delivery` reports which side of WhatsApp's 24-hour window the code went out on. It is
`'template'` for **either** template, so no client can come to depend on which one was used.

Audited: **nothing on success.** A resend is routine (the cooldown permits one a minute) and a
row per code would bury the outcome underneath it. The declaration is `mayRecord`, not a missing
audit — `defineRoute` requires every mutating route to state one, so "records nothing" has to be
written down rather than left off.

### `POST /auth/me/phone/verify/confirm`

| Field | Type | Rules |
|---|---|---|
| `code` | string | Required, **4–12 characters**. `.strict()` |

```json
{ "code": "483920" }
```

Response: `{ "phone": "+237677001122", "verified": true }`

⚠ **The body takes `code` alone. Sending `phone` is a `400`**, and the reason is worth keeping
in front of you: a caller that could name the number would be able to prove control of *one*
number and have *another* marked verified. The number is fixed when the code is minted.

⚠ **`409` when the proved number no longer matches the account.** An administrator can change
their number in the ten minutes between requesting a code and typing it, and jovi-mall — which
holds no administrator record — cannot know that happened. wi-admin re-checks before stamping,
and **nothing is written** on the mismatch. Request a new code against the current number.

Audited: `administrators.profile.phone_verified`.

### Errors

Two of these are **wi-admin's own**; the rest arrive from jovi-mall as `details.platformCode`.

| Status | `error.code` | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Bad length, or an extra key past `.strict()` — including `phone` on the confirm |
| 403 | `ADMIN_ACTIVATION_REQUIRED` | The account is still `pending` |
| 422 | **`ADMIN_PHONE_NOT_SET`** | Verification requested with no number saved. ⚠ **wi-admin's own code, not a delegated `PHONE_VERIFICATION_NO_TARGET`** — the call is refused before it is made. There is no field to point at, so there is no `details.fields`, and it is deliberately not `VALIDATION_ERROR` |
| 409 | **`ADMIN_PHONE_VERIFICATION_MISMATCH`** | The proved number is no longer the account's. ⚠ **A named code — it was `VALIDATION_ERROR` until 2026-09-14** |
| 422 / 429 | `PLATFORM_OPERATION_REJECTED` | The code was wrong, expired, resent too soon, or spent. Branch on `details.platformCode` — the six values are in [errors.md](errors.md#the-six-that-arrive-from-jovi-mall) |
| 502 | `SERVICE_DEPENDENCY_UNAVAILABLE` | Delivery failed. `details.platformCode` is `PHONE_VERIFICATION_DELIVERY_FAILED` |
| 503 | `SERVICE_DEPENDENCY_UNAVAILABLE` | `JOVI_MALL_BASE_URL` is unset on this deployment — there is no OTP service at all |

⚠ **`platformCode` now survives a 429** (2026-09-15, BR-025 § 2) and it is the only thing
separating two **opposite** remedies: `PHONE_VERIFICATION_RESEND_TOO_SOON` means *wait,
`details.retryAfterSeconds`, the code in your hand still works*, and
`PHONE_VERIFICATION_TOO_MANY_ATTEMPTS` means *that code is destroyed, request a new one*.

⚠ **A delegated 5xx keeps its code and LOSES its message.** jovi-mall's sentence for a delivery
failure names the templates it tried; `projectMessage` replaces the message of any `internal` or
`external_service` error with the registry default, on jovi-mall's boundary and again on ours.
So `platformCode` survives the hop and the prose does not. **Do not plan to render that
message** — write your own copy keyed on the code.

### Delivery: fixed 2026-09-15 — build the ordinary path, not a workaround

✅ **The two faults that made `PHONE_VERIFICATION_DELIVERY_FAILED` the ordinary outcome are
fixed.** Build the straightforward flow: request → the code arrives on WhatsApp → confirm.

⛔ **A THIRD, UNRELATED FAULT IS STILL OPEN, SO NO CODE ACTUALLY ARRIVES YET.** A live send on
2026-09-15 returned `(#131037) WhatsApp provided number needs display name approval before
message can be sent.` — the platform's WhatsApp number has **never had a display name submitted**
(`name_status: "NON_EXISTS"`). ⚠ **It blocks free-form messages too**, so the workaround below
does not rescue it either. This is an account action on Meta's side, not a backend change.

**Build the flow anyway, and keep the failure path honest**: render
`PHONE_VERIFICATION_DELIVERY_FAILED` as *"we couldn't send the code — try again"* with a retry,
not as *"your phone is wrong"*. When the display name clears, the flow starts working with no
frontend change.

⚠ **This section said the opposite until 2026-09-15, and if you are working from a copy of this
page taken before then, that copy told you to ship a workaround as the primary path.** Two
separate faults closed within a day of each other:

| What was broken | Fixed |
|---|---|
| **The out-of-window template.** An OTP outside WhatsApp's 24-hour window needs an approved template, and `wi_mall_phone_verification` (AUTHENTICATION) could not even be *created* — code 10 / subcode 2388185 — because Meta gates that category behind business verification and the owning business was `business_verification_status: "rejected"` | The business reached **`verified`**; the template was submitted and **APPROVED in `en` and `fr` within seconds**, with no code change on either side |
| **The 24-hour window was never recorded**, so *every* request took the template path — including one from someone who had just messaged the bot | `POST /api/internal/bot/identity/sync` now stamps the window on every inbound message |

⛔ **One thing did NOT get fixed and never will: `wi_mall_phone_verification_utility` (UTILITY)
stays rejected** — `INCORRECT_CATEGORY`, both languages, and rejected again *synchronously*
under `allow_category_change: true`. That verdict is about OTP **content**, not about the
business, so the verification did not revive it. It is now dead weight behind the working path.
⛔ **Do not reword OTP copy to get past the classifier** — Meta classifies OTP content as
AUTHENTICATION and accepts it nowhere else, so rewording is evading enforcement rather than
satisfying it, and the WABA carrying the platform's other 189 templates is what would be at risk.

⚠ **What the administrator actually receives, so your copy can match it:** Meta writes and
localises the body itself — *"**123456** is your verification code. For your security, do not
share this code."* — with a footer reading *"Expires in 10 minutes."* and a **Copy code** button.
None of that is ours to change, and **the footer's ten minutes is frozen inside the approved
template**: if the platform's `PHONE_VERIFY_TTL_SECONDS` is ever lowered, the message keeps
saying ten. Do not build a countdown from the WhatsApp text; use `expiresAt` from the request
response.

<details>
<summary>The manual workaround, kept for the case where delivery fails anyway</summary>

In-window delivery needs no template, and the window is keyed on the **phone number alone** —
not on an account — so this still works as a fallback an operator can be told:

> **Send any WhatsApp message to the platform's business number from the phone you are
> verifying, then press Verify within the next 23 hours.** The code arrives as ordinary text.

⚠ One side effect to state honestly if you surface this: messaging the bot **creates a customer
account against that phone number** on the platform side. It is harmless to the administrator
record — administrator identity lives in this database and the OTP subject is namespaced
`admin:<id>` precisely so the two cannot collide — but the row does come into existence. That
cost was worth paying when this was the only route; it is not worth putting in the primary flow
now.

⚠ **The window tracked is 23 hours, not Meta's 24**, so free-form sends stop a safe margin
before the real boundary rather than racing it.

</details>

---

## Session lifetimes and defaults

| Setting | Env var | Default |
|---|---|---|
| Access-token TTL | `ADMIN_ACCESS_TOKEN_TTL` | 900 s (15 min) |
| Session idle timeout | `ADMIN_SESSION_IDLE_TTL` | 28 800 s (8 h), refreshed on use |
| Session absolute cap | `ADMIN_SESSION_ABSOLUTE_TTL` | 604 800 s (7 d) |
| Failed attempts before lockout | `ADMIN_LOCKOUT_MAX_ATTEMPTS` | 5 |
| Lockout duration | `ADMIN_LOCKOUT_DURATION_S` | 900 s (15 min) |
| MFA challenge TTL | — | 300 s (5 min), hardcoded (`mfa.service.ts:96`) |
| Level at/above which MFA is mandatory | `ADMIN_MFA_REQUIRED_TIER` | 1 (Developer) |
| Credential-endpoint rate limit | `ADMIN_AUTH_RATE_LIMIT_MAX` | 10/min/IP |
| **Refresh** rate limit (its own bucket) | `ADMIN_REFRESH_RATE_LIMIT_MAX` | **60/min/IP** |

### Things a client must not assume

- **There is no silent refresh.** An expired access token is a `401`, always. Call
  `/auth/refresh` and retry.
- **A valid token is not enough.** The session must still exist server-side, so logout,
  revocation and suspension take effect on the very next request.
- **`tier` and `status` are re-read every request.** A demotion applies immediately, not at
  token expiry.
- **A suspended administrator loses every session** on their first request after the flag flips,
  and gets `403 ADMIN_AUTH_ACCOUNT_SUSPENDED`.
