# `/administrators` — administrator management

Base path: `/api/v1/administrators`

The surface that decides who may use this service: creating administrators, changing levels,
suspension, session control, and the two credential-reset break-glass paths.

**There is deliberately no `DELETE`.** Suspension is the model. A deleted administrator leaves
audit rows and session history pointing at nothing, and "who did this" stops being answerable —
the one question an administrator audit trail exists to answer.

| Method | Path | Permission | Audited |
|---|---|---|---|
| `GET` | `/administrators/me` | *self* | — |
| `PATCH` | `/administrators/me` | *self* | ✅ |
| `GET` | `/administrators/me/activity` | *self* | — |
| `GET` | `/administrators` | `administrators.read` | — |
| `POST` | `/administrators` | `administrators.create` | ✅ |
| `GET` | `/administrators/:adminId` | `administrators.read` | — |
| `PATCH` | `/administrators/:adminId` | `administrators.update` | ✅ |
| `GET` | `/administrators/:adminId/activity` | `audit.read` | — |
| `GET` | `/administrators/:adminId/history` | `audit.read` | — |
| `POST` | `/administrators/:adminId/suspend` | `administrators.suspend` | ✅ |
| `POST` | `/administrators/:adminId/reinstate` | `administrators.suspend` | ✅ |
| `PUT` | `/administrators/:adminId/tier` | `administrators.tier.set` | ✅ (may) |
| `GET` | `/administrators/:adminId/sessions` | `administrators.sessions.read` | — |
| `DELETE` | `/administrators/:adminId/sessions` | `administrators.sessions.revoke` | ✅ |
| `DELETE` | `/administrators/:adminId/sessions/:sessionId` | `administrators.sessions.revoke` | ✅ |
| `POST` | `/administrators/:adminId/password-reset` | `administrators.password.reset` | ✅ |
| `POST` | `/administrators/:adminId/mfa-reset` | `administrators.mfa.reset` | ✅ |

Every write on this surface additionally runs the **escalation rules** — see below. Two of
them are **dual-controlled** and can answer `202`.

---

## The escalation rules

The permission says "may you manage administrators". These say "may you manage *this* one".
They run on every write, after the permission check, and they are not overridable.

| Refusal | Status | Code |
|---|---|---|
| Acting on your own account | 403 | `AUTHZ_SELF_ACTION_FORBIDDEN` |
| Target is at or above your own level | 403 | `AUTHZ_TARGET_TIER_PROTECTED` |
| Assigning a level at or above your own | 403 | `AUTHZ_TIER_ESCALATION_FORBIDDEN` |

Messages name the **rule**, not your standing: "You cannot perform this action on an
administrator at or above your own level", never "you are tier 2 and the target is tier 1".

**Remember lower number = more privilege.** A tier-2 Admin may act on tier 3, never on tier 2
or tier 1.

---

## Dual control on this surface

| Endpoint | Queued when | Answers |
|---|---|---|
| `PUT /:adminId/tier` | The requested tier is **1 (Developer)** | `202` with an approval |
| `POST /:adminId/suspend` | The **target** is a Developer | `202` with an approval |
| `POST /:adminId/reinstate` | The **target** is a Developer | `202` with an approval |

A `202` is **not** a refusal. The action was accepted and is waiting for a second
administrator; render "waiting for approval", not an error. See
[authorization.md](authorization.md).

---

## The `Administrator` object

Returned by every read and by most writes. **Never contains `passwordHash` or `mfaSecret`** —
the DTO is built by naming fields, not by deleting them from a spread.

| Field | Type | Notes |
|---|---|---|
| `id` | string | 24-hex |
| `email` | string | Lower-cased |
| `displayName` | string | |
| `tier` | `1` \| `2` \| `3` | |
| `tierLabel` | string | `"Developer"` \| `"Admin"` \| `"Support"` |
| `status` | `"active"` \| `"suspended"` | |
| `jobTitle` | string \| null | |
| `department` | string \| null | |
| `timezone` | string | IANA zone |
| `preferredLanguage` | string | |
| `mfaEnrolled` | boolean | |
| `lastLoginAt` | ISO-8601 \| null | |
| `createdBy` | string \| null | Administrator id. `null` for the bootstrap administrator |
| `suspendedAt` | ISO-8601 \| null | |
| `suspendedBy` | string \| null | |
| `suspendedReason` | string \| null | |
| `tierChangedAt` | ISO-8601 \| null | |
| `tierChangedBy` | string \| null | |
| `createdAt` | ISO-8601 | |

> **Reinstating clears `suspendedAt`, `suspendedBy` and `suspendedReason`.** A suspension that
> was later lifted leaves no trace on the record — the only place it survives is
> `GET /:adminId/history`.

---

## `GET /administrators/me`

The caller's own record. No permission — every administrator may read their own.

Declared **before** `/:adminId` so `me` is never parsed as an id.

### Response (200)

`data` is a single `Administrator` object.

---

## `PATCH /administrators/me`

Edit your own profile. No permission: editing your own display name is not an administrative
act over an account, and requiring `administrators.update` would stop a Support administrator
maintaining their own profile.

### Request body

At least one field is required.

| Field | Type | Rules |
|---|---|---|
| `displayName` | string | 2–120 characters, trimmed |
| `jobTitle` | string \| null | ≤ 120. **Clearable** — send `""` or `null` to empty it |
| `department` | string \| null | ≤ 120. **Clearable** |
| `timezone` | string | 1–64 characters |
| `preferredLanguage` | string | 2–10 characters |

`tier` and `status` are **not accepted here**, on purpose. Levels change through one endpoint
with one permission and dual control at the top; suspension has its own endpoint because it has
its own consequences and its own required reason. A `tier` field quietly accepted by a profile
PATCH would route the most dangerous write in the service through the least examined path.

```json
{ "displayName": "Ada N.", "jobTitle": null, "timezone": "Africa/Douala" }
```

### Response (200)

The updated `Administrator`.

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Empty body ("No fields to update"), or a field out of bounds |

### Audit

`administrators.profile.update_self`

---

## `GET /administrators/me/activity`

What the caller has done — their own audit entries. No permission, because an audit trail
people cannot see their own entry in is one they have no way to challenge.

Query parameters, response shape, pagination and sorting are **identical to `GET /audit`** —
see [audit.md](audit.md#get-audit).

---

## `GET /administrators`

The administrator directory.

| | |
|---|---|
| **Permission** | `administrators.read` (Developer, Admin) |
| **Pagination** | `page`, `limit` |
| **Sorting** | **None offered.** Fixed compound order: by level, then newest first within a level — the directory an administrator actually reads. A single sort key cannot express that |

### Query parameters

| Parameter | Type | Notes |
|---|---|---|
| `tier` | `1` \| `2` \| `3` | Exact level |
| `status` | `"active"` \| `"suspended"` | |
| `search` | string | 1–120 characters. Matches email and display name |
| `page` | integer | Default 1 |
| `limit` | integer | Default 20, max 100 |

### Response (200)

```jsonc
{
  "success": true,
  "data": [ { "id": "…", "email": "…", "tier": 1, "tierLabel": "Developer", "…": "…" } ],
  "meta": { "total": 14, "page": 1, "limit": 20, "pages": 1 }
}
```

---

## `POST /administrators`

Create an administrator.

| | |
|---|---|
| **Permission** | `administrators.create` (Developer, Admin) |
| **Status** | `201` |

### Request body

| Field | Type | Rules |
|---|---|---|
| `email` | string | Required. Trimmed, lower-cased, valid address, unique |
| `displayName` | string | Required. 2–120 characters |
| `tier` | `1` \| `2` \| `3` | Required. **Must be strictly below your own level** |
| `jobTitle` | string | Optional, ≤ 120 |
| `department` | string | Optional, ≤ 120 |

```json
{
  "email": "sam@wimall.cm",
  "displayName": "Samuel Etoo",
  "tier": 3,
  "jobTitle": "Support Agent",
  "department": "Customer Care"
}
```

### Response (201)

```jsonc
{
  "success": true,
  "data": {
    "administrator": { "id": "…", "email": "sam@wimall.cm", "tier": 3, "…": "…" },
    "oneTimePassword": "kR7$mQ2pXv9!nB4wTz3Ld6Hy"
  },
  "message": "Administrator created. The password below is shown once and is stored nowhere else."
}
```

> **`oneTimePassword` is shown once and stored nowhere else.** There is no email delivery in
> this service, so the creating administrator is the delivery channel. Display it, let it be
> copied, and do not persist it client-side.

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | |
| 403 | `AUTHZ_TIER_ESCALATION_FORBIDDEN` | `tier` is at or above your own |
| **409** | **`AUTHZ_APPROVAL_REQUIRED`** | **Creating an administrator directly at Developer level.** There is no approval path from here — create the account at a lower level and then request a promotion, which the four-eyes queue reviews. One reviewed step instead of two |
| 409 | `ADMIN_ACCOUNT_ALREADY_EXISTS` | Email collision |

### Audit

`administrators.create`

---

## `GET /administrators/:adminId`

One administrator.

| | |
|---|---|
| **Permission** | `administrators.read` |
| **Path parameter** | `adminId` — 24-hex |
| **Response** | A single `Administrator` |
| **Errors** | `400 VALIDATION_ERROR` (malformed id), `404 ADMIN_ACCOUNT_NOT_FOUND` |

---

## `PATCH /administrators/:adminId`

Edit another administrator's profile.

| | |
|---|---|
| **Permission** | `administrators.update` |
| **Request body** | Identical to `PATCH /administrators/me` |
| **Response** | The updated `Administrator` |

### Errors

Everything `PATCH /me` returns, plus:

| Status | Code |
|---|---|
| 403 | `AUTHZ_SELF_ACTION_FORBIDDEN`, `AUTHZ_TARGET_TIER_PROTECTED` |
| 404 | `ADMIN_ACCOUNT_NOT_FOUND` |

### Audit

`administrators.update`

---

## The two audit feeds

Both read the same audit collection through the same read scope. They differ only in **which
side of the row they key on** — which is exactly why every audit row records an actor *and* a
target.

### `GET /administrators/:adminId/activity` — what this administrator **did**

The actor half. Answers oversight: "what has this person been doing".

### `GET /administrators/:adminId/history` — what was done **to** this account

The target half. Answers account review: created by whom, promoted when, suspended why —
including changes that went through four eyes. **This is the only place a lifted suspension
survives.**

Both:

| | |
|---|---|
| **Permission** | `audit.read` |
| **Query / response / pagination / sorting** | Identical to `GET /audit` — see [audit.md](audit.md#get-audit) |

---

## `POST /administrators/:adminId/suspend`

Suspend an administrator, ending every one of their sessions immediately.

| | |
|---|---|
| **Permission** | `administrators.suspend` |
| **Dual control** | **Yes, when the target is a Developer** |

### Request body

| Field | Type | Rules |
|---|---|---|
| `reason` | string | **Required.** 3–500 characters, trimmed. An unexplained suspension of a colleague is not permitted |

```json
{ "reason": "Offboarding — left the company 2026-08-12" }
```

### Response — applied (200)

The updated `Administrator`, now `status: "suspended"` with `suspendedAt`, `suspendedBy` and
`suspendedReason` set.

### Response — queued (202)

```jsonc
{
  "success": true,
  "data": {
    "id": "66a0f31c8b2d4e5f60718293",
    "action": "administrators.suspend",
    "description": "Suspend Developer 665f1c2a9b3e4a91c7d2e5f0",
    "status": "pending",
    "requestedBy": "6650aabbccddeeff00112233",
    "requestedByTier": 1,
    "requestedByTierLabel": "Developer",
    "targetType": "administrator",
    "targetId": "665f1c2a9b3e4a91c7d2e5f0",
    "payload": { "adminId": "665f1c2a9b3e4a91c7d2e5f0", "targetTier": 1, "suspend": true,
                 "reason": "Offboarding — left the company 2026-08-12" },
    "approverId": null,
    "decidedAt": null,
    "decisionNote": null,
    "failureReason": null,
    "expiresAt": "2026-08-14T09:14:02.331Z",
    "createdAt": "2026-08-13T09:14:02.331Z"
  },
  "message": "Submitted for a second administrator’s approval"
}
```

Repeating an **identical** request returns the same pending approval with
`message: "An identical request is already awaiting approval"` — a double-clicked button does
not queue two approvals.

### Errors

| Status | Code |
|---|---|
| 400 | `VALIDATION_ERROR` — missing or too-short reason |
| 403 | `AUTHZ_SELF_ACTION_FORBIDDEN`, `AUTHZ_TARGET_TIER_PROTECTED` |
| 404 | `ADMIN_ACCOUNT_NOT_FOUND` |

### Audit

`administrators.suspend`

---

## `POST /administrators/:adminId/reinstate`

Lift a suspension.

| | |
|---|---|
| **Permission** | `administrators.suspend` (the same one) |
| **Dual control** | **Yes, when the target is a Developer** — restoring a suspended Developer grants Developer access to an account that currently has none, which is as consequential as promoting one |
| **Request body** | None |
| **Response** | `200` with the `Administrator`, or `202` with an approval |

### Errors

Same set as `suspend`, minus the validation error.

### Audit

`administrators.reinstate`

---

## `PUT /administrators/:adminId/tier`

Change an administrator's level.

| | |
|---|---|
| **Permission** | `administrators.tier.set` — **Developer only**, the sole `escalation`-flagged permission with an endpoint |
| **Dual control** | **Yes, when the requested tier is 1 (Developer)** |

### Request body

| Field | Type | Rules |
|---|---|---|
| `tier` | `1` \| `2` \| `3` | Required. Must be strictly below your own level |

```json
{ "tier": 2 }
```

### Response

| Situation | Status | `data` |
|---|---|---|
| Applied | `200` | The updated `Administrator` |
| Promotion to Developer | `202` | The approval request |
| **Target already holds that tier** | `200` | The administrator, **unchanged, and nothing is recorded** — idempotent by design, so a retry is not a failure |

Changing a level ends the target's sessions with reason `tier_changed`.

### Errors

| Status | Code |
|---|---|
| 400 | `VALIDATION_ERROR` — "Administrator level must be 1 (Developer), 2 (Admin) or 3 (Support)" |
| 403 | `AUTHZ_SELF_ACTION_FORBIDDEN`, `AUTHZ_TARGET_TIER_PROTECTED`, `AUTHZ_TIER_ESCALATION_FORBIDDEN` |
| 404 | `ADMIN_ACCOUNT_NOT_FOUND` |

### Audit

`administrators.tier.set` — **may** record. A no-op tier set records nothing; a queued
promotion records the same action at `status: "queued"`.

---

## `GET /administrators/:adminId/sessions`

Another administrator's sessions.

| | |
|---|---|
| **Permission** | `administrators.sessions.read` |
| **Pagination** | **None** |

### Query parameters

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `includeEnded` | boolean flag | `false` | `false` → live sessions only (from Redis). `true` → the durable **history**: who signed in from where, when it ended, and which of eleven reasons ended it |

Accepts `true`, `false`, `1`, `0`. `false` means false.

### Response (200) — live only

```jsonc
{
  "success": true,
  "data": [
    {
      "sessionId": "0f9c8b7a-…",
      "startedAt": "2026-08-13T07:02:44.019Z",
      "absoluteExpiresAt": "2026-08-20T07:02:44.019Z",
      "ip": "102.244.18.7",
      "userAgent": "Mozilla/5.0 …",
      "mfaUsed": true,
      "current": false,
      "endedAt": null,
      "endReason": null,
      "lastSeenAt": "2026-08-13T09:11:20.004Z",
      "tierAtLogin": 2
    }
  ]
}
```

`current` is always `false` here — every one of these belongs to someone else.

### Response (200) — `?includeEnded=true`

Same shape, including finished sessions with `endedAt` and `endReason` populated.

| `endReason` | Meaning |
|---|---|
| `logout` | They signed out |
| `logout_all` | They signed out everywhere |
| `revoked_by_admin` | An administrator ended it |
| `account_suspended` | Their account was suspended |
| `tier_changed` | Their level changed — not a revocation; what the session represented is no longer true |
| `password_reset` | Their password was reset |
| `mfa_reset` | Their two-factor enrolment was cleared |
| `refresh_reuse_detected` | A superseded refresh token was presented |
| `idle_expired` | The idle timeout elapsed |
| `absolute_expired` | The absolute cap elapsed |

### Errors

| Status | Code |
|---|---|
| 403 | `AUTHZ_SELF_ACTION_FORBIDDEN`, `AUTHZ_TARGET_TIER_PROTECTED` |
| 404 | `ADMIN_ACCOUNT_NOT_FOUND` |

---

## `DELETE /administrators/:adminId/sessions`

Sign an administrator out of **every** device.

| | |
|---|---|
| **Permission** | `administrators.sessions.revoke` |
| **Request body** | None |

### Response (200)

```json
{ "success": true, "data": { "revoked": 3 }, "message": "Ended 3 session(s)" }
```

### Audit

`administrators.sessions.revoke`

---

## `DELETE /administrators/:adminId/sessions/:sessionId`

End **one** device, so a compromised session can be cut off without signing the administrator
out everywhere.

| | |
|---|---|
| **Permission** | `administrators.sessions.revoke` |
| **Path parameters** | `adminId` (24-hex), `sessionId` (8–128 characters — a session id is a UUID, not an ObjectId) |

### Response (200)

```json
{ "success": true, "data": { "revoked": 1 }, "message": "Session ended" }
```

### Errors

| Status | Code |
|---|---|
| 403 | `AUTHZ_SELF_ACTION_FORBIDDEN`, `AUTHZ_TARGET_TIER_PROTECTED` |
| 404 | `ADMIN_ACCOUNT_NOT_FOUND`, `ADMIN_SESSION_NOT_FOUND` |

### Audit

`administrators.sessions.revoke_one`

---

## `POST /administrators/:adminId/password-reset`

Issue a new one-time password and end every session.

| | |
|---|---|
| **Permission** | `administrators.password.reset` |
| **Request body** | None — the password is generated, never supplied |

### Response (200)

```jsonc
{
  "success": true,
  "data": {
    "administrator": { "…": "…" },
    "oneTimePassword": "vQ8#nT2xLp6!wZ4mBy7K",
    "sessionsEnded": 2
  },
  "message": "Password reset and every session ended. The password below is shown once."
}
```

Every existing session dies (`end_reason: "password_reset"`) — a reset that leaves the old
sessions alive does not recover an account, it adds a second way in.

### Errors

| Status | Code |
|---|---|
| 403 | `AUTHZ_SELF_ACTION_FORBIDDEN` (use `POST /auth/password` for your own), `AUTHZ_TARGET_TIER_PROTECTED` |
| 404 | `ADMIN_ACCOUNT_NOT_FOUND` |

### Audit

`administrators.password.reset`

---

## `POST /administrators/:adminId/mfa-reset`

Clear a lost authenticator so the administrator can enrol a new one.

Separate from the password reset beside it because the two remove **different controls**, and
handing over both from one call would hand over the account. This is why the permission is
`escalation`-flagged and **Developer only**.

Before this existed, `mfaEnrolled` was a one-way door: re-enrolment 409s, nothing cleared the
flag, and MFA is mandatory for the senior level — so a wiped phone made the account permanently
unusable.

| | |
|---|---|
| **Permission** | `administrators.mfa.reset` — **Developer only** |
| **Request body** | None |

### Response (200)

```jsonc
{
  "success": true,
  "data": {
    "administrator": { "…": "…", "mfaEnrolled": false },
    "sessionsEnded": 1
  },
  "message": "Two-factor enrolment cleared and every session ended. They must sign in with their password and enrol a new authenticator."
}
```

Sessions end with reason `mfa_reset`. The administrator signs in with their existing password
and is routed straight back into enrolment.

### Errors

| Status | Code |
|---|---|
| 403 | `AUTHZ_PERMISSION_DENIED` (not a Developer), `AUTHZ_SELF_ACTION_FORBIDDEN`, `AUTHZ_TARGET_TIER_PROTECTED` |
| 404 | `ADMIN_ACCOUNT_NOT_FOUND` |

### Audit

`administrators.mfa.reset`
