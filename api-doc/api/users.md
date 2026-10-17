# `/users` — platform user management

**Amended 2026-10-13 (BR-029).** `GET /users` gains **`meta.idMatch`**: when `search` was read as an id, it says which kind of id it was (`user`, `customer`, `vendor`, `agency`, `agent`). Additive; absent for every other search. See [`meta.idMatch`](#metaidmatch--what-the-pasted-id-was). Pinned by `npm run test:users` § 4 and § 2b.

**Amended 2026-10-12 (BR-028).** `GET /users?search=` now also finds the account behind a **profile id**: a customer, vendor, agency or agent id resolves to the person who owns it. An id still matches only whole. See [Searching by id](#searching-by-id). Pinned by `npm run test:users` § 2 and § 2b.

**Amended 2026-10-10.** Three routes for the **customer's cash-on-delivery restriction** (owner decision): an administrator holding the new `users.cod.restrict` switches COD off for one customer, and back on. The customer profile on `GET /users/:userId` gains `codRestriction`. See [the section at the end](#the-customers-cod-restriction). Pinned by `npm run test:users` § 7b and § 9.

**Amended 2026-10-04.** Three routes for **role closure** (jovi-mall ADR-A10): an administrator holding the new `users.close` asks a user to close ONE role, and the user confirms or declines it themselves. See [the section at the end](#role-closure). Pinned by `npm run test:users`.

**Amended 2026-09-22.** A ninth route, `POST /users/:userId/bot-memory/reset`, was added under the new permission `users.bot_memory.reset`. It is the one write on this surface that **all three levels** hold. See [the section at the end](#the-customer-bots-memory). Checked against the route manifest and `tier-grants.ts`, and pinned by `npm run test:users` § 7–8.

**Verified against source on 2026-09-08** — all eight routes and their guards against the live route manifest; every query parameter, bound and sort allowlist against `users/validators/user.validator.ts` and `core/validation/common.schemas.ts`; the read DTO and the `profiles`/`missing` shape against `users/controllers/user.controller.ts:54-116` and `users/repositories/role-profile.read.repository.ts`; the write responses against `users/gateways/user.gateway.ts`; and the `details` exposure on the 429 against `core/errors/detail-policy.ts:156`.

Base path: `/api/v1/users`

The account behind every role. A `users` row is the sign-in identity; a vendor, agency, agent
or customer *profile* hangs off it.

Design record: [`../../docs/ADR-007-USER-MANAGEMENT.md`](../../docs/ADR-007-USER-MANAGEMENT.md).

| Method | Path | Permission | Transport | Audited |
|---|---|---|---|---|
| `GET` | `/users` | `users.read` | direct read | — |
| `GET` | `/users/:userId` | `users.read` | direct read | — |
| `GET` | `/users/:userId/activity` | `users.read` **+** `audit.read` | direct read | — |
| `PATCH` | `/users/:userId` | `users.update` | **delegated** | ✅ |
| `POST` | `/users/:userId/suspend` | `users.suspend` | **delegated** | ✅ |
| `POST` | `/users/:userId/restore` | `users.suspend` | **delegated** | ✅ |
| `POST` | `/users/:userId/password-reset-link` | `users.password.reset` | **delegated** | ✅ |
| `POST` | `/users/:userId/login-link` | `users.login_link.send` | **delegated** | ✅ |
| `POST` | `/users/:userId/bot-memory/reset` | `users.bot_memory.reset` | **delegated** | ✅ |
| `GET` | `/users/:userId/closure-requests` | `users.read` | direct read | — |
| `POST` | `/users/:userId/roles/:role/closure` | `users.close` | **delegated** | ✅ |
| `DELETE` | `/users/:userId/roles/:role/closure` | `users.close` | **delegated** | ✅ |
| `GET` | `/users/:userId/cod-restriction` | `users.read` | **delegated** | — |
| `PUT` | `/users/:userId/cod-restriction` | `users.cod.restrict` | **delegated** | ✅ |
| `POST` | `/users/:userId/cod-restriction/lift` | `users.cod.restrict` | **delegated** | ✅ |

Reads go straight to the platform database; every write is executed by jovi-mall. A suspension
is only meaningful because jovi-mall's auth path refuses a non-active account, and a login
identifier is only safe because that service owns its uniqueness index and its format rule.

`users.read` is a Support-level lookup. **One write is Support-level too:** the bot-memory
reset, which every level holds. Every other write here is **Admin and above**.

## What this surface deliberately does not offer

| Missing | Why |
|---|---|
| **Role changes** (`users.roles.manage` exists with no route). *Closing* one role at the user's own confirmation is built, below; adding or silently removing one is not | Adding a role provisions a role entity (a Store, a Magazin); removing one strands every record that entity owns. There is no code path in jovi-mall that removes a role, and inventing the semantics from the admin side is how a vendor's products end up belonging to nobody |
| **Forced sign-out** (`users.sessions.revoke`) | jovi-mall issues stateless JWTs with no session store — there is nothing to revoke. Suspension covers the need: it blocks the next request on every device |
| **Setting a password directly** | An administrator never learns or chooses a platform party's credential. The two routes below send the person a link and let them choose it themselves. Contrast `POST /administrators/:adminId/password-reset`, which *does* generate a password and shows it once — because an administrator has no email, phone or chat on file to be reached on, and a platform party has three |

> **`users.password.reset` has left the `†` list.** It was catalogued-and-unbuilt because
> jovi-mall had no administrator-initiated flow. It has one now, built **on** the existing
> `PasswordResetService` rather than beside it — see the two routes at the end of this
> document.

---

## `GET /users`

Search and filter across every role.

| | |
|---|---|
| **Permission** | `users.read` |
| **Pagination** | `page`, `limit` |
| **Sorting** | `createdAt`, `updatedAt`, `email`. Default **`-createdAt`** |

Every sortable field is index-backed. A field with no index would be a collection scan a client
could request by query string.

### Query parameters

| Parameter | Type | Notes |
|---|---|---|
| `search` | string, 1–120 | Matches **email**, **phone**, or — when the term is itself a 24-hex id — the **user id, or the id of one of that person's profiles** (customer, vendor, agency, agent). That last branch is what makes a support conversation work: an id copied out of an order, a ticket or an audit row finds the person. **An id matches only whole** — see [Searching by id](#searching-by-id) |
| `role` | `vendor` \| `agency` \| `agent` \| `customer` | **`admin` is deliberately absent** — no `users` row can hold that role, so offering it would advertise a search that can only return nothing |
| `status` | `active` \| `suspended` \| `closed` | `closed` is an account its **owner** closed (jovi-mall ADR-A02). Filterable because a closed account still owns orders and tickets, so "why does this order resolve to a customer with no name" is a real support question |
| `from` / `to` | ISO-8601 instant | Creation range, half-open `[from, to)`. **Maximum span 366 days** |
| `page`, `limit`, `sort` | | |

### Searching by id

A 24-hex term is tried as **five** ids, and any one of them finds the account:

| The term is | Finds |
|---|---|
| a user id (`users._id`) | that account |
| a **customer** id — the `customerId` on an order | the account that owns that customer profile |
| a **vendor** id | the account that owns that vendor |
| an **agency** id | the account that owns that agency |
| an **agent** id | the account that owns that agent |

The row that comes back is the **account**, so its `id` is the user id, not the id that was
typed. The id that was typed is on the detail, as `profiles[].id`, and
[`meta.idMatch`](#metaidmatch--what-the-pasted-id-was) says which kind of id it was.

For a customer this is the only route there is: there is no customer directory, and the id on
an order is a customer id. `GET /users?search=<customerId>` is the link from an order to the
person.

> **An id matches only whole — exactly 24 hexadecimal characters.** A shorter or longer term,
> or one with anything round it (quotes, `ObjectId("…")`, a URL), is not read as an id. It is
> treated as text and matched against the email and the phone, where it will normally match
> nothing. Letter case does not matter.

Matching a **part** of an id was considered and declined (BR-028 § 3). A run of digits is far
more often part of a phone number than the start of an id, so reading `67011234` as both would
return people whose phone does not contain it. Only the start of an id could be matched
cheaply, and the dashboard draws an id as its start **and** its end.

`role` and the other filters still apply to an id match: `?search=<customerId>&role=vendor`
finds the person only if they are also a vendor.

### `meta.idMatch` — what the pasted id was

The row an id search returns is the account, so its `id` is often not the id that was typed.
`meta.idMatch` says what the typed id **was**.

```jsonc
"meta": {
  "total": 1, "page": 1, "limit": 20, "pages": 1,
  "idMatch": { "kinds": ["customer"] }
}
```

| `meta.idMatch` | Means |
|---|---|
| **absent** (no key) | `search` was not read as an id: no `search`, a name, an email, a phone, a part of an id. A service older than 2026-10-13 also sends no key |
| `{ "kinds": [] }` | `search` was a whole id, and it is **nobody's**: no account has it and no profile has it. An order id pasted here is the usual case |
| `{ "kinds": ["user"] }` | It is an account's own id |
| `{ "kinds": ["customer"] }` | It is a customer profile's id. Likewise `vendor`, `agency`, `agent` |
| `{ "kinds": ["user", "customer"] }` | It is both. See below |

- **`kinds` is a list**, in a fixed order: `user`, `customer`, `vendor`, `agency`, `agent`. The
  five kinds of id live in five separate collections, so nothing but probability stops one value
  being a user id and somebody else's profile id. In that case the page has **two** rows, and the
  row whose `id` equals the term is the `user` one.
- **The vocabulary is open.** Treat a kind you do not recognise as unknown rather than as an
  error; a sixth profile kind would be an additive change.
- **It is never `null`.** Present with a list, or not there.

**It describes the id, not the page.** `role`, `status` and the date range do not affect it. So
an empty page has three different explanations, and `idMatch` tells them apart:

| Request | `total` | `kinds` | What happened |
|---|---|---|---|
| `?search=<customerId>&role=vendor` | 0 | `["customer"]` | The id is a customer's. **A filter is hiding the account** |
| `?search=<userId>&role=vendor` | 0 | `["user"]` | The same, for an account's own id |
| `?search=<an order id>&role=vendor` | 0 | `[]` | The id is nobody's. Removing the filter will not help |
| `?search=<customerId>`, **no other filter** | 0 | `["customer"]` | ⚠ The profile exists and **its account does not**. A data fault, not a search result: `users` rows are never deleted by the platform, so this needs a hand-edited database to happen |

This tells a caller that an id is a customer's without returning the row. It is nothing they
could not learn by sending the same search without the filter, and every holder of `users.read`
may send that.

It costs one extra count on `users._id`, and only for a term that is a whole id.

### Example

```
GET /api/v1/users?role=agent&status=active&search=+237670112233&sort=-createdAt&limit=25
GET /api/v1/users?search=66b0000000000000000000c3        ← a customer id copied from an order
```

### Response (200)

```jsonc
{
  "success": true,
  "data": [
    {
      "id": "665f1c2a9b3e4a91c7d2e5f0",
      "email": "amina@example.cm",
      "phone": "+237670112233",
      "roles": ["customer", "agent"],
      "status": "active",
      "suspension": null,
      "closedAt": null,
      "createdAt": "2026-02-14T10:05:31.220Z",
      "updatedAt": "2026-08-01T08:12:44.907Z"
    }
  ],
  "meta": { "total": 8412, "page": 1, "limit": 25, "pages": 337 }
}
```

| Field | Type | Notes |
|---|---|---|
| `email`, `phone` | string \| null | The **login identifiers**. Either may be absent |
| `roles` | string[] | Every role the account holds |
| `status` | `active` \| `suspended` \| `closed` | |
| `closedAt` | ISO-8601 \| null | **Present only while closed**, the same pairing rule as `suspension`. A closed account has had its identifiers removed by its owner: `email`, `phone` and the customer's name are gone and are **not recoverable** — the row survives so orders, tickets and bookings still resolve |
| `suspension` | object \| null | **Present only while suspended.** An active account carrying a stale reason would read as suspended on any screen that renders the block without checking `status` first |
| `suspension.at` | ISO-8601 \| null | |
| `suspension.reason` | string \| null | |
| `suspension.by` | `{ id, source, name }` | Every member is nullable except `source`, which falls back to `"platform"`. `source` distinguishes a platform actor from an administrator |

---

## `GET /users/:userId`

The account plus one entry per role it holds.

| | |
|---|---|
| **Permission** | `users.read` |
| **Path parameter** | `userId` — 24-hex |

### Response (200)

Every list field, plus `profiles`:

```jsonc
{
  "success": true,
  "data": {
    "id": "665f1c2a9b3e4a91c7d2e5f0",
    "email": "amina@example.cm",
    "phone": "+237670112233",
    "roles": ["customer", "agent"],
    "status": "active",
    "suspension": null,
    "closedAt": null,
    "createdAt": "2026-02-14T10:05:31.220Z",
    "updatedAt": "2026-08-01T08:12:44.907Z",
    "profiles": [
      {
        "role": "customer",
        "id": "665f1c2a9b3e4a91c7d2e5f1",
        "name": "Amina B.",
        "status": "active",
        "verified": null,
        "kycStatus": null,
        "createdAt": "2026-02-14T10:05:31.400Z",
        "codRestriction": null
      },
      {
        "role": "agent",
        "id": null, "name": null, "status": null,
        "verified": null, "kycStatus": null, "createdAt": null,
        "missing": true
      }
    ]
  }
}
```

#### The `profiles` array

One entry per role, in `roles` order.

| Field | Type | Notes |
|---|---|---|
| `role` | `vendor` \| `agency` \| `agent` \| `customer` | |
| `name` | string \| null | The display name on that role, when the role carries one |
| `verified` | boolean \| null | Business verification — **vendor and agency only**; `null` where the role has none |
| `kycStatus` | string \| null | Identity verification — **agent only** |
| **`codRestriction`** | object \| null | **(2026-10-10) On the `customer` entry only.** `null`, or `{ reason, restrictedAt, restrictedByUserId, restrictedBySource, restrictedByName }` when an administrator has switched cash on delivery off for this customer ([below](#the-customers-cod-restriction)). ⚠ **The key is absent — not `null` — on a vendor, agency or agent entry, and on a `missing` one.** `null` means "not restricted"; an agency's restriction is on [`GET /agencies/:agencyId`](agencies.md#get-agenciesagencyid), and this read does not look at it. `reason` is the administrator's and is never shown to the customer |
| `missing` | `true` | **Present only on a broken entry.** The role is on the `users` row but its entity does not exist — **this stops the person signing in**, and would otherwise be invisible |

Render `missing: true` prominently. It is a real, recoverable-only-by-hand fault.

### Errors

| Status | Code |
|---|---|
| 400 | `VALIDATION_ERROR` — "Not a valid user id" |
| 404 | `NOT_FOUND` — "User not found" |

---

## `GET /users/:userId/activity`

What **administrators have done to** this account: every suspension, reinstatement and
identifier change, who made it, from where, and whether it succeeded.

**This is not the person's own platform activity.** Their orders, shipments and tickets live in
other domains behind other permissions; assembling them here would let `users.read` alone reach
data those permissions exist to gate.

| | |
|---|---|
| **Permission** | `users.read` **+** `audit.read` (both required) |
| **Pagination** | `page`, `limit` |
| **Sorting** | `occurredAt` only. Default **`-occurredAt`** |

Requiring both is not a cost — every level holding either holds both. It states the dependency
so a future grant change cannot quietly open a side door onto the audit trail.

### Query parameters

A deliberate subset of the audit query: no `targetType`/`targetId` (the path fixes both), no
`actorId` (an account's history is not filtered by who acted), no `search`.

| Parameter | Type | Notes |
|---|---|---|
| `action` | enum | Only `users.*` actions — **derived from the audit catalog**, so it widens automatically when a new one is added |
| `status` | `attempted` \| `succeeded` \| `failed` \| `denied` \| `queued` | |
| `from` / `to` | ISO-8601 instant | Max span 366 days |
| `page`, `limit`, `sort` | | |

### Response (200)

A paginated array of audit entries — identical shape to `GET /audit`. See
[audit.md](audit.md#get-audit).

The audit read scope applies on top of the path filter. `user` rows are `platform_actor`, which
every level may read, so a Support administrator sees this feed deliberately.

### Errors

| Status | Code | When |
|---|---|---|
| 404 | `NOT_FOUND` | No such user — checked **first**, so a feed for a nonexistent user says so rather than answering an empty page that looks like "nothing ever happened" |

---

## `PATCH /users/:userId`

Change the login identifiers. **The only user fields an administrator may edit.**

| | |
|---|---|
| **Permission** | `users.update` |
| **Transport** | Delegated to jovi-mall |
| **Body** | **Strict** — unknown fields are a `400`, not silently ignored |

### Request body

At least one of `email` or `phone` is required.

| Field | Type | Rules |
|---|---|---|
| `email` | string \| null | Trimmed, 3–254 characters. **Clearable** — `""` or `null` removes it |
| `phone` | string \| null | Trimmed, 4–24 characters. **Clearable** |

**Format is not validated here, deliberately.** jovi-mall owns the login identifiers and holds
one definition of what each may be (RFC 5322 for email, strict E.164 for phone). A copy of
those rules here would be a second definition of a rule this service does not own, and the
failure mode of drift is silent — an address accepted at this door that every later edit by its
owner would refuse.

So this schema validates **shape**; jovi-mall validates **format** and returns its own `400`
with `details.platformCode`.

```json
{ "email": "amina.b@example.cm", "phone": null }
```

### Response (200)

```jsonc
{
  "success": true,
  "data": {
    "id": "665f1c2a9b3e4a91c7d2e5f0",
    "email": "amina.b@example.cm",
    "phone": null,
    "roles": ["customer", "agent"],
    "status": "active",
    "suspendedAt": null,
    "suspendedReason": null,
    "suspendedBy": null,
    "createdAt": "2026-02-14T10:05:31.220Z",
    "updatedAt": "2026-08-13T09:31:02.118Z"
  },
  "message": "Login details updated"
}
```

> Note the write response is jovi-mall's own user DTO — flat `suspendedAt` / `suspendedReason` /
> `suspendedBy` fields, rather than the nested `suspension` object the **read** endpoints
> return. They carry the same facts.

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Empty body ("Nothing to update — send `email`, `phone`, or both"), an unknown field, or out-of-bounds length |
| 400 | `PLATFORM_OPERATION_REJECTED` | jovi-mall refused the **format**. `details.platformCode` names its code |
| 404 | `NOT_FOUND` | No such user |
| 409 | `PLATFORM_OPERATION_REJECTED` | The identifier is already in use. `details.platformCode` names the collision |
| 502 / 503 | `SERVICE_DEPENDENCY_UNAVAILABLE` | jovi-mall unreachable |

### Audit

`users.update`, with a `before`/`after` diff over `{ email, phone, status, suspendedReason }`.

---

## `POST /users/:userId/suspend`

Block sign-in on every device.

**Takes effect on the suspended person's next request, not at their next login** — jovi-mall
re-reads the account on every authenticated request and refuses a non-active one, and its
refresh rotation refuses too. A live session cannot outlive this call.

| | |
|---|---|
| **Permission** | `users.suspend` |
| **Transport** | Delegated |

### Request body

| Field | Type | Rules |
|---|---|---|
| `reason` | string | **Required.** 3–500 characters, trimmed |

```json
{ "reason": "Fraudulent chargebacks on orders ORD-2026-8841 and ORD-2026-8902" }
```

### Response (200)

jovi-mall's user DTO, `status: "suspended"`, with the message
`"Account suspended — every device is signed out"`.

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Missing or too-short reason |
| 404 | `NOT_FOUND` | |
| 409 | `PLATFORM_OPERATION_REJECTED` | Already suspended — a compare-and-set, so the loser of two concurrent screens is told the state moved rather than overwriting the winner's reason |
| 502 / 503 | `SERVICE_DEPENDENCY_UNAVAILABLE` | |

### Audit

`users.suspend`

---

## `POST /users/:userId/restore`

Lift a suspension.

| | |
|---|---|
| **Permission** | `users.suspend` (the same one — the permission governs both directions; the *audit actions* differ) |
| **Request body** | None |
| **Response** | jovi-mall's user DTO, `status: "active"`, message `"Account restored"` |

### Errors

Same as suspend, minus the validation error. `409` when the account is not suspended.

> [!IMPORTANT]
> **A `closed` account can be neither suspended nor restored, and that is enforced in
> jovi-mall rather than here.** Both verbs are compare-and-sets — suspend from `active`,
> restore from `suspended` — so a closed row misses both and answers `409`. There is
> deliberately **no un-close**: closure removed the identifiers, so there is nothing to
> restore the account to.

### Audit

`users.reinstate`

---

## Why suspend/restore are POST sub-resources, not `PATCH { status }`

The permission and the audit row attach to the **action**. `users.suspend` governs both
directions, but they are separate audit actions — `users.suspend` and `users.reinstate` — and a
status field on a PATCH body could not carry the required reason on one direction and forbid it
on the other. The same pattern holds across vendors, agencies and agents.

---

# Credential recovery

Two routes that send a platform party a way back into their own account. Added in the
dashboard-request round (BR-001), and the one item there that needed work in **both**
services.

## What they are, and what they are not

**They send. They do not disclose.** The response carries no token, no link and no
unmasked destination, and the destination is never accepted from the caller — it is read
from the party's own record. An operator who could type an address could mail a working
credential for somebody else's account to themselves, and no permission short of
withholding the endpoint would prevent it.

**They are a third entrance, not a second mechanism.** Both credentials come out of the
machinery that already existed in jovi-mall:

| Route | Mints through | Lifetime | Single-use |
|---|---|---|---|
| `password-reset-link` | `PasswordResetService.issueResetLinkFor` — the same 32-byte token the self-service and bot flows use, redeemed at the same `POST /auth/reset-password`, carrying the same `password_changed_at` stamp that **evicts every live session** on redemption | 30 min | ✅ |
| `login-link` | `MessagingLoginService` — the same session record the bot `/login` flow mints, with a magic link **and** an 8-character code for one session; using either kills the other | 10 min | ✅ |

Issuing a new credential of the same kind for the same party **revokes the previous one**,
so an operator who clicks twice leaves one live credential rather than two.

---

## `POST /users/:userId/password-reset-link`

| | |
|---|---|
| **Permission** | `users.password.reset` — **tier 1 and 2 only** |
| **Transport** | **Delegated** |
| **Roles** | **Every role.** A password belongs to the `users` row, and vendors and agencies are exactly the people who have one to forget |

## `POST /users/:userId/login-link`

| | |
|---|---|
| **Permission** | `users.login_link.send` — **tier 1 and 2 only** |
| **Transport** | **Delegated** |
| **Roles** | **Customers only.** `USER_LOGIN_LINK_ROLE_UNSUPPORTED` otherwise |

> **Why two permissions rather than one.** A reset link grants nothing until the person
> chooses a password, and evicts every session when they do — its worst case is a
> locked-out user. A sign-in link **is** a session: whoever opens the message is signed in
> as that customer. Folding them together would mean a tier granted "help people back into
> their account" silently also got "sign in as a customer", with nothing in the trail to
> tell the two acts apart.
>
> **Neither is granted to tier 3.** Support answers delivery tickets; a support agent who
> can mail a working link to any vendor can take over any shop, and the audit row would
> read as routine help.

### Request body (both routes, strict)

| Field | Type | Rules |
|---|---|---|
| `channel` | string | **Required.** `email` · `whatsapp` · `telegram`. A pinned enum — an unrecognised value is a `400`, never a silent fallback to email |
| `reason` | string | **Required**, trimmed, 3–500. This is an administrator acting on somebody else's ability to sign in, without their asking. The audit row needs a why, and the person may later need to be told one |

**There is no destination field.** Sending one is a `400`, not a silently ignored key.

`password-reset-link` answers `kind: "password_reset"` with the message
`"Password-reset link sent by <channel>"`; `login-link` answers `kind: "login"` with
`"Sign-in link sent by <channel>"`.

### Where each channel goes

| `channel` | Resolves to | Absent when |
|---|---|---|
| `email` | the party's `login_email` | they have none on file |
| `whatsapp` | the party's `login_phone` | they have none on file |
| `telegram` | the `chat_id` from their **connected** Telegram account | they have never run `/connect` with the bot. The platform stores no `chatId` on any party, so there is nothing to fall back to |

### Response `200`

```jsonc
{
  "success": true,
  "data": {
    "kind": "password_reset",
    "channel": "whatsapp",
    "destinationMasked": "+2376••••4417",
    "expiresAt": "2026-08-17T11:42:00.000Z",
    "sentAt": "2026-08-17T11:12:00.000Z"
  },
  "message": "Password-reset link sent by whatsapp"
}
```

`destinationMasked` is `+2376••••4417` · `j••••t@example.com` · `@handle` — enough to
confirm it went to the right person, not enough to retype.

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Unknown `channel`, missing `reason`, or an extra key |
| 404 | `NOT_FOUND` | No such user |
| 403 | `AUTHZ_PERMISSION_DENIED` | |
| 409 | `PLATFORM_OPERATION_REJECTED` | `details.platformCode` is `USER_CHANNEL_UNAVAILABLE`, `USER_LOGIN_LINK_ROLE_UNSUPPORTED`, or `AUTH_ACCOUNT_SUSPENDED` (reinstate the account first) |
| 429 | `PLATFORM_OPERATION_REJECTED` | Too many links recently. **`details.retryAfterSeconds` is the only detail that arrives** — see the ⚠ below |
| 502 | `PLATFORM_OPERATION_REJECTED` | `details.platformCode: MESSAGING_DELIVERY_FAILED` — the channel accepted the request and did not deliver. Try another channel |

> ### ⚠️ On the **429**, `details.platformCode` does **not** arrive
>
> jovi-mall raises `USER_CREDENTIAL_LINK_THROTTLED` with `{ retryAfterSeconds, scope }`, where
> `scope` is `party` (this person has been sent too many) or `administrator` (you have sent too
> many) — two different remedies, *wait* versus *ask a colleague*. **Neither `scope` nor
> `platformCode` survives the boundary**: `details` is filtered by **category**, and `rate_limit`
> has a closed allowlist of `retryAfterSeconds` · `limit` · `windowSeconds`
> (`admin/src/core/errors/detail-policy.ts:156`).
>
> What you get is the status, `details.retryAfterSeconds`, and **jovi-mall's message** — which
> is the only place the two scopes are distinguishable. Render the message; do not write a
> branch on a code that will never be there. The same is true of any forwarded **403**, whose
> allowlist is `required` · `requiredAny` · `mode` · `resource` · `action` · `hint`.

**Delivery failure is raised, not swallowed.** The self-service flow logs and continues,
because it must answer identically whether or not the account exists. Here the caller is an
administrator watching a dialog: telling them "sent" when nothing was sent makes them close
the ticket while the party stays locked out.

### Rate limits

Per party **and** per administrator, and neither substitutes for the other: the first is a
harassment and SMS-bill bound (the party did not ask for any of these), the second bounds a
compromised or careless operator account.

⚠ **This said "counted on the attempt, so a caller cannot probe which channels a party has by
burning failures for free", and the second half was false** (BR-021, corrected 2026-09-12).
Both counters were spent *after* the channel was resolved, and a channel the party does not
have is refused before that — so the probe cost nothing and was unbounded. The dashboard
measured it in five requests.

**The two counters are now spent at different points, because they bound different things:**

| Counter | Spent | So a refused channel… |
|---|---|---|
| **per administrator** | on the **attempt**, before the channel is resolved | **does** cost the caller their allowance |
| **per party** | once the channel **resolves** | does **not** cost the party theirs |

What this buys you, concretely: **picking the wrong channel in the dialog is free for the
party.** A `409 USER_CHANNEL_UNAVAILABLE` on `email` does not consume one of that party's three,
so the operator can immediately try `whatsapp` and it will work. Charging the party for a
message they were never sent would lock them out of the channel that does work for an hour, on
the commonest mistake in that dialog — and the dialog has no way to discover which channels
exist except by trying.

The probe is **bounded, not impossible.** Three requests still answer "which channels does this
party have" for one party; what the administrator counter stops is doing it across many. We
consider that the right trade and are stating it rather than implying otherwise: this is contact
metadata, and the caller already holds a permission to send to that contact.

### Audit

| Action | Sensitive | Records |
|---|---|---|
| `users.password_reset_link.send` | ✅ | The channel and the reason. **Never the token, the link, or the full address** |
| `users.login_link.send` | ✅ | as above |

The trail is read by more people than performed the action; a link in it would be a live
credential sitting in a feed.

### Two decisions worth having in writing

**No dual control.** Considered and declined. Four-eyes currently guards three actions, all
of which are irreversible or privilege-granting. A reset link is neither, and making routine
account recovery a two-person job would push operators toward reading passwords over the
phone — which is the workflow this endpoint exists to replace.

**No verified-destination gate**, and this one is a finding rather than a choice: jovi-mall's
`users` row carries no `email_verified`. Verification flags live on the **role** entities, a
user may hold several roles, and `login_email` is the login identifier itself — the address
`POST /auth/forgot-password` already mails a live reset token to, anonymously, with no check.
Gating the administrator path more tightly than the path an attacker can drive would protect
nothing.

---

# The customer bot's memory

## `POST /users/:userId/bot-memory/reset`

Make the customer bot start this person's next conversation fresh.

**What a reset does, and what it does not.** The customer bot on WhatsApp and Telegram keeps a
short memory of each customer's chat. A reset makes it forget that memory, so the customer's next
conversation starts from nothing. Use it when the bot is confused by something it remembers and
the customer complains. **It deletes no order, no message record and no account data.** Only
what the bot remembers of the chat is reset.

| | |
|---|---|
| **Permission** | `users.bot_memory.reset`, held by **all three levels: Developer, Admin and Support** |
| **Transport** | **Delegated.** jovi-mall owns the bot's memory and performs the reset |
| **Body** | Optional and **strict**. Unknown fields are a `400` |
| **Audited** | ✅ `users.bot_memory.reset`, visible to every level in `GET /users/:userId/activity` |

> **Why Support holds it, when it holds no other write on this page.** The complaint arrives as
> a Support ticket, and this is the remedy. It is safe at that level because it touches nothing
> the platform keeps about the person. The worst a wrong press can do is have one customer's
> next message answered without memory of the last chat, which is how every new customer
> starts. Contrast the two credential routes above: either one can hand an account to whoever
> opens the message, so Support holds neither.

> **The dashboard button is the owner's frontend work.** This page is the contract it builds
> on. Show the button when `users.bot_memory.reset` is in `GET /permissions/me`, which today is
> every administrator.

### Request body

| Field | Type | Rules |
|---|---|---|
| `reason` | string | **Optional.** Trimmed, 3–500 characters, recorded on the audit row. **Omit the key** rather than sending `""`, because an empty string is a `400` |

An empty body works: `{}`, or no body at all. Cookie-authenticated calls send the CSRF header, as
on every other write ([README](README.md)).

```json
{ "reason": "Customer says the bot keeps quoting an order they cancelled" }
```

### Response `200`

```jsonc
{
  "success": true,
  "data": {
    "userId": "665f1c2a9b3e4a91c7d2e5f0",
    "memoryEpoch": 4,
    "resetAt": "2026-09-22T10:00:00.000Z"
  },
  "message": "Bot memory reset — the next conversation starts fresh"
}
```

| Field | Type | Notes |
|---|---|---|
| `userId` | string | The account whose bot memory was reset |
| `memoryEpoch` | number | jovi-mall's counter for this person's bot memory. A reset starts a new epoch. **Treat it as opaque:** display it if useful, never compute with it |
| `resetAt` | ISO-8601 | When jovi-mall performed the reset |

Exactly these three fields. wi-admin names them one by one, so nothing else jovi-mall might add
reaches the client. Two presses mean two resets and two audit rows, and neither does any harm.

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Not a valid user id, a `reason` outside 3–500 characters (`""` included), or an unknown key |
| 403 | `AUTHZ_PERMISSION_DENIED` | The caller's level lacks `users.bot_memory.reset`. No level lacks it today |
| 404 | `NOT_FOUND` | No such user. Checked here **first**, before jovi-mall is called |
| 4xx | `PLATFORM_OPERATION_REJECTED` | jovi-mall refused. Its status is kept, and its code is in `details.platformCode`. A `404` with this code means jovi-mall does not know the user or, during a rollout, does not serve the route yet |
| 500 | `INTERNAL_SERVER_ERROR` | The audit trail could not record the attempt. **Nothing was reset:** jovi-mall is not called until the audit row exists |
| 502 | `SERVICE_DEPENDENCY_UNAVAILABLE` | jovi-mall failed while doing it (a 5xx on its side) |
| 503 | `SERVICE_DEPENDENCY_UNAVAILABLE` | jovi-mall is unreachable or not configured. A write is **never retried** automatically, so the reset may not have happened. Pressing again is safe |

### Audit

| Action | Sensitive | Records |
|---|---|---|
| `users.bot_memory.reset` | — | The actor, the target user, the optional `reason` (as `null` when none was given), the outcome, and on success `after: { memoryEpoch, resetAt }`. `before` is `null`: the account itself did not change |

The row is written **before** jovi-mall is called. If it cannot be written, the reset does not
happen.

## Role closure

Design record: jovi-mall [`docs/ADR-A10-ROLE-CLOSURE.md`](../../../jovi-mall/docs/ADR-A10-ROLE-CLOSURE.md).

**An administrator ASKS; only the user can close.** Closing is anonymise-and-retain and
irreversible, so these routes create a *request*. The user gets a notice and answers it signed in
as that role, within **7 days**. Nothing about the role changes until they confirm. **No route
here can confirm**, and `test:users` fails if one appears.

`users.close` is `destructive`, held by **Admin and Developer**, never Support. The list is a
read on `users.read`, so Support can see that a request exists and how it was answered, which
is the conversation they will be having.

### `POST /users/:userId/roles/:role/closure`

`:role` is `customer` · `vendor` · `agency` · `agent`. The body is strict:

```json
{ "reason": "Owner asked by email to close the shop" }
```

The reason is **shown to the user** in the notice. `201` answers with the request (shape below).
jovi-mall refuses up front on anything the user's confirm would refuse, so the administrator
learns it now:

| Status | `details.platformCode` | When |
|---|---|---|
| 422 | `ROLE_CLOSURE_BLOCKED` | Live work or money on the role. jovi-mall's `details.blockers` lists them (`[{ code, count, amount?, currency? }]`; codes in jovi-mall `api-doc/me/role-closure.md`). Passed through, never enumerated here. 🆕 2026-10-05: `earnings_clawback_outstanding` (`amount`, `currency`) — the role OWES the platform money back after a refund recovered more than its balances held (REFUND-FLOW-PLAN C-5); it clears through later earnings or a write-off at `POST /money/earnings/clawbacks/:ownerType/:ownerId/write-off` |
| 409 | `ROLE_CLOSURE_ALREADY_PENDING` | One is already waiting |
| 422 | `ROLE_CLOSURE_ROLE_NOT_HELD` | The user does not hold that role |
| 409 | `ROLE_CLOSED` | That role is already closed |
| 409 | `USER_STATUS_CONFLICT` | The account is suspended or closed |

Holding **other roles is not a refusal**. Closing a vendor role leaves the same person's customer
role working. Closing their **last** role closes the whole account.

### `DELETE /users/:userId/roles/:role/closure`

Withdraws the pending request. Returns `404` with `ROLE_CLOSURE_REQUEST_NOT_FOUND` when there is
none, including when the user answered first.

### `GET /users/:userId/closure-requests`

Every request for the account, newest first, read directly from `jovi_mall.role_closure_requests`:

```json
{
  "id": "6710…", "userId": "…", "role": "vendor", "roleEntityId": "…",
  "status": "confirmed",
  "reason": "Owner asked by email to close the shop",
  "requestedBy": { "id": "…", "name": "Awa N." },
  "requestedAt": "…", "expiresAt": "…",
  "warnings": [{ "code": "prepaid_plan_forfeited", "planCode": "pro", "expiresAt": "…", "amount": null }],
  "resolvedAt": "…",
  "resolvedBy": { "id": "…", "source": "platform", "name": null },
  "declineNote": null,
  "outcome": { "closedAt": "…", "accountClosed": false, "endedRelationships": 3 }
}
```

`status` is `pending` · `confirmed` · `declined` · `cancelled` · `expired`. It is **effective**: a
stored `pending` past `expiresAt` is reported `expired`. `warnings` are what the user forfeits
(paid plan time, credits) and were shown to them before confirming.

### Audit

| Action | When |
|---|---|
| `users.close.request` | The administrator asked. The payload records the role and reason |
| `users.close.cancel` | The administrator withdrew it |

The user's confirm or decline is **not** an administrator action, so it has no row here. It is
on the request itself (`status`, `resolvedAt`, `outcome`).

---

# The customer's COD restriction

**(2026-10-10, owner decision.)** An administrator can switch **cash on delivery off** for one
customer, and back on. It is the lever the Returns policy promises: refusing parcels without a
valid reason "may lead us to restrict cash on delivery on your account". Dashboard brief:
[`../FRONTEND-CHANGELOG-cod-restrictions.md`](../FRONTEND-CHANGELOG-cod-restrictions.md).

**What a restriction does.** The customer can no longer **place** a cash-on-delivery order.
jovi-mall refuses it at checkout (`422 COD_CUSTOMER_RESTRICTED`) and the cart quote reports
`customer_restricted`, so the website and the bot stop offering it.

**What it does not touch.** Orders already placed, parcels already on their way, and the cash
owed on them. Every other payment method. Nothing sets it automatically — it is an
administrator's decision each time — and with nothing recorded, COD behaves as it always did.

⚠ **Customers only.** The restriction lives on the *customer profile*. An account that does not
hold the `customer` role has none, and all three routes answer
`404 PLATFORM_OPERATION_REJECTED` with `details.platformCode: "AUTH_PROFILE_NOT_FOUND"`. Show
the switch only when `roles` includes `customer`.

| | |
|---|---|
| **Read** | `users.read` — every level, Support included |
| **Write** | `users.cod.restrict` — **Developer and Admin. Support does not hold it.** Unflagged, like `users.suspend`, and granted the same way; no dual control |
| **Transport** | Delegated to `/api/internal/admin/users/:userId/cod-restriction` |

## `GET /users/:userId/cod-restriction`

```json
{
  "success": true,
  "data": {
    "subject": "customer",
    "subjectId": "665f1c2a9b3e4a91c7d2e5f1",
    "userId": "665f1c2a9b3e4a91c7d2e5f0",
    "restricted": true,
    "restriction": {
      "reason": "Refused three parcels without a reason",
      "restrictedAt": "2026-10-10T09:30:00.000Z",
      "restrictedByUserId": "66b0…",
      "restrictedBySource": "admin",
      "restrictedByName": "Ada Admin"
    }
  }
}
```

| Field | Meaning |
|---|---|
| `subject` | Always `"customer"` on this mount |
| `subjectId` | The **customer profile's** id — `profiles[].id` of the customer entry, **not** the `:userId` in the path |
| `userId` | The account — the `:userId` in the path |
| `restricted` | `true` while cash on delivery is switched off |
| `restriction` | `null` when not restricted. Otherwise the reason, when, and the acting administrator — `restrictedByUserId` is a **wi-admin administrator id** |

Exactly these fields. Not audited. The same record is on the detail as the customer entry's
[`codRestriction`](#the-profiles-array), read directly, so a badge needs no second call.

## `PUT /users/:userId/cod-restriction`

Switch cash on delivery **off** for the customer.

```json
{ "reason": "Refused three parcels without a reason" }
```

| Field | Type | Notes |
|---|---|---|
| `reason` | string | **Required.** Trimmed, 3–500 characters. Stored on the restriction (jovi-mall) **and** in the audit payload. Never shown to the customer |

`.strict()` — `reason` is the only key. ⚠ There is **no `restricted` field**: the direction is
the route. Answers the same body as the GET.

## `POST /users/:userId/cod-restriction/lift`

Switch cash on delivery back **on**.

```json
{ "reason": "Customer explained; the parcels were damaged" }
```

`reason` is **required here too** (trimmed, 3–500, `.strict()`) — unlike `/restore`, which takes
no body. Lifting **clears** the stored restriction in jovi-mall, so the reason given for lifting
survives only in the audit row. Answers the report with `restricted: false` and
`restriction: null`.

### Errors (both writes; the 404s apply to the read too)

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | A malformed user id, a missing or out-of-range `reason`, or any other key |
| 403 | `AUTHZ_PERMISSION_DENIED` | The caller lacks `users.cod.restrict` — every Support administrator does |
| 404 | `NOT_FOUND` | No such user. Checked here before jovi-mall is called |
| 404 | `PLATFORM_OPERATION_REJECTED` | The account has **no customer profile**. `details.platformCode` is `AUTH_PROFILE_NOT_FOUND`. On a write it is answered by the read that precedes it, so **no audit row is written** — nothing was attempted |
| 409 | `PLATFORM_OPERATION_REJECTED` | The customer is **already in that state** — already restricted on the PUT, not restricted on `/lift`. jovi-mall's write is a compare-and-set. `details.platformCode` is `COD_RESTRICTION_UNCHANGED`. Re-read and show what is there |
| 500 | `INTERNAL_SERVER_ERROR` | The audit trail could not record the attempt. **Nothing changed** — jovi-mall is not called until the audit row exists |
| 502 / 503 | `SERVICE_DEPENDENCY_UNAVAILABLE` | jovi-mall failed or is unreachable. A write is never retried automatically; re-read before pressing again |

A **suspended or closed** account is not refused by either service: jovi-mall checks that the
user and its customer profile exist, and nothing else.

### Audit

| Action | Sensitive | Records |
|---|---|---|
| `users.cod.restrict` | — | The actor, the target user, the `reason`, the outcome, and `before` / `after` as `{ codRestricted }` — `false → true` |
| `users.cod.unrestrict` | — | The same, `true → false`. Its **own** action although it shares the permission: lifting clears the record in jovi-mall, so this row is the only surviving trace of the restriction and of why it was lifted |

Both target the **user** (not the customer profile), so they appear in
`GET /users/:userId/activity` beside every other act on the account. The row is written
**before** jovi-mall is called; if it cannot be written, nothing changes.
