# `/auth` — administrator authentication

**Verified against source on 2026-09-08** — all eleven routes, their access kinds and their audit declarations against `admin-identity/routes/auth.routes.ts`; every request schema against `admin-identity/validators/auth.validator.ts`; the eight lifetime/limit defaults against `admin/src/config/env.ts:87-139`; the two rate-limit buckets against `api/middlewares/auth-rate-limit.middleware.ts`; the password policy against `admin-identity/domain/password.service.ts:30-71`; and the `422` detail exposure against `core/errors/detail-policy.ts:74,132`.

Base path: `/api/v1/auth`

Login, two-factor, session rotation, session listing and self-service password change. These
are the only routes on the service that can be reached with no identity, and the list is
closed — a fourth public route requires editing a boot-checked allowlist.

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
| `status` | `"active"` \| `"suspended"` | A suspended administrator cannot reach this response |
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
| **Authentication** | Required. **Also reachable by a session that still owes MFA enrolment** |
| **Permission** | None |

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

> ### ⚠️ The `422` does **not** tell you which rule broke
>
> The throw site attaches `details.problems` — an array of phrases like *"must be at least 12
> characters"* — and **the boundary drops it**. `problems` is on the always-dropped internal-key
> list (`admin/src/core/errors/detail-policy.ts:74`, where it exists to suppress the boot
> assertions' diagnostic payload), and it is dropped in **every** category. After the scrub the
> object is empty, so `details` is omitted from the envelope entirely.
>
> **What a client actually receives is `422 ADMIN_AUTH_PASSWORD_WEAK` with the fixed message
> "Password does not meet the minimum requirements" and no `details`.** State the four rules on
> the form up front and validate the length client-side; do not build a UI that waits for the
> server to name the failure. Verified 2026-09-08 — reported to the backend as a defect.

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
| 422 | `ADMIN_AUTH_PASSWORD_WEAK` | Policy failure. ⚠ **No `details` arrive** — see the box above |
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
