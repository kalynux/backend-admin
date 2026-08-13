# ADR-007 — Platform user management

**Status:** Accepted, 2026-08-11 · **Implements:** the user-management brief; the `users` half of blueprint Phase 6
**Depends on:** [ADR-004](./ADR-004-DOMAIN-OWNERSHIP.md) (read direct / write delegated), [ADR-005](./ADR-005-API-CONTRACT.md) (the list contract), [ADR-006](./ADR-006-AUDIT.md) (the trail this surface's activity feed reads)
**Verified by:** `npm run test:users` (61, DB-free) · `npm run verify:users` (52, needs Mongo + Redis + a running jovi-mall) · jovi-mall's `npm run verify:admin-users` (18, needs Mongo + a running jovi-mall)

---

## Context

PHASE-0 §6 found that the platform had **no user administration at all**: no endpoint to list
users, none to look one up, and none to suspend one. Phase 4 shipped two read endpoints as the
vertical slice proving the direct-read transport, and left the write verbs explicitly for later:

> "The write verbs the domain eventually needs — suspend, reinstate, force logout, reset password,
> role management — are NOT here. Each cascades into records jovi-mall owns."

This ADR builds the domain out: list, search, filter, detail, edit, suspend, restore, and the
account's administrative history. It also decides, and records, the three verbs it does **not**
build.

### The finding that shaped the whole phase

`users.status` was **inert**. Measured, not assumed:

| Path | Read `user.status`? |
|---|---|
| `auth.service.ts` · `login` | ❌ never |
| `auth.service.ts` · `rotateRefreshToken` | ❌ never |
| `auth.middleware.ts` · `requireAuth` | ❌ never — it loads the row and ignores the field |
| `auth/guards/index.ts` · `requireActiveUser` | ✅ …with **zero call sites** |
| `UserRepository.updateStatus` | write method, **zero call sites** |

So the column was written by nothing and read by nothing. An admin endpoint that flipped it would
have been a button that did nothing at all — the suspended person would have kept working, and the
audit trail would have recorded a suspension that never took effect. The brief's phrasing
("suspend/restore **where supported**") is what forced the question rather than letting the endpoint
ship as a label.

---

## D-1 · Suspension is made real in jovi-mall, on all three auth paths

The enabling change is not in this service. Suspension is enforced where authentication happens:

| Path | Behaviour |
|---|---|
| `login` | refuses with `AUTH_ACCOUNT_SUSPENDED` (403), **after** the credential comparison |
| `rotateRefreshToken` | refuses — a 30-day refresh cookie must not outlive the suspension |
| `requireAuth` | refuses on **every authenticated request** |

The third is the one that matters. Access tokens are stateless and live 15 minutes; enforcing at
login alone would leave a suspended person working for a quarter of an hour and then silently
refreshing back in. `requireAuth` already loads the user row (`findById`, for `req.auth`), so the
check costs a comparison and no query.

**403, not 401.** The credential is valid and re-authenticating cannot help; a 401 sends a browser
client into a refresh loop against an account that is never coming back.

**Ordered after the password check** so that naming the suspension is not an account-existence
oracle. That ordering is doing nothing today — `auth.service.ts:190-191` computes `isValid` and the
rejecting line is commented out, a live defect the platform owner has taken ownership of — but the
ordering is correct for the day it is fixed and costs nothing now.

### The consequence that replaces a feature

Because a suspension is refused on the *next request* from every device, it already does what a
"force sign-out" endpoint would have done. That is why `users.sessions.revoke` is not built — see
D-5.

---

## D-2 · Read direct, write delegated — in one domain, and the clearest case of it

This is ADR-004 D-2 applied where both halves are visible in one module:

| Operation | Transport | Why |
|---|---|---|
| list · search · filter · detail · role profiles · activity | **direct read** of `jovi_mall` | a query protects no invariant; there is no service in jovi-mall to call |
| edit identifiers · suspend · restore | **delegated** to `/api/internal/admin/users` | see below |

The writes delegate for a reason stronger than "there might be events". A suspension is *only*
meaningful by virtue of D-1's three checks, which live in jovi-mall — flipping the column from here
would produce a suspension nobody enforces. And the login identifiers carry **sparse unique
indexes** plus one definition of what an email and an E.164 number may be
(`core/validation/{email,phone}.ts`, used by every platform write path). A second writer would
reproduce neither.

`PlatformReadRepository` has no write method, so the read half cannot break the rule by accident;
`test:users` asserts that the module's gateway is the only file in it that reaches
`platformRequest`.

**jovi-mall's `/users` router is mounted once, not twice.** Every other admin router is dual-mounted
(public `/api/admin/*` for today's dashboard, internal for wi-admin) because it has a legacy
consumer. This domain has none — it never had an admin surface — so a public mount would create
surface whose only future is Phase 8's deletion list.

---

## D-3 · Format validation stays in jovi-mall; wi-admin validates shape

`UpdateUserSchema` here checks that a field was sent, is trimmed, and is within RFC 5321's length
bounds. It does **not** check that an email is an email.

A copy of jovi-mall's RFC 5322 dot-atom rule and its strict E.164 rule would be a second definition
of a rule this service does not own, and drift would be silent in the worst direction: an address
accepted at the admin door that every later edit by its owner is refused. jovi-mall's 400 comes back
through `platformRequest`'s error mapping at the same status, carrying its own message and
`details.platformCode` — which is exactly what that mapping exists for.

The length bounds are here anyway, for one reason only: an unbounded string should not be forwarded
over the wire at all.

---

## D-4 · Three guards on the write path, each catching what the others cannot

| Guard | Refuses | Code |
|---|---|---|
| Compare-and-set on `status` | a second administrator racing the first | `USER_STATUS_CONFLICT` 409 |
| Identifier-free check | an email or phone another account holds | `AUTH_{EMAIL,PHONE}_TAKEN` 409 |
| At-least-one-identifier | an edit that clears both | `USER_CONTACT_REQUIRED` 422 |

The CAS follows `ShipmentRepository.applyStatusChangeIfCurrent`, and for the same reason: two
actors can hold one document open, and an unguarded write lets the loser's audit row claim a
transition that never happened.

The identifier check is belt-and-braces over the sparse unique index — the index is what guarantees
it under a race, and the check is what makes the ordinary case a legible 409 instead of a
duplicate-key 500 naming an index. Note that a cleared identifier is `$unset`, never `$set: null`:
a null **is** a value to a sparse index, so two accounts explicitly nulled would collide.

The third exists because both identifiers are individually optional while `login` resolves an
account by one of them. Clearing both makes the account permanently unreachable, with no
self-service path back.

---

## D-5 · Three verbs deliberately not built

Each is a catalogued permission with no route, and each carries the reason in its catalog entry so
the next person does not rediscover it.

| Permission | Why not |
|---|---|
| `users.sessions.revoke` | jovi-mall issues **stateless JWTs with no session store**. `rotateRefreshToken` verifies a signature and mints — there is nothing to revoke. Forcing a sign-out means building server-side sessions there first, exactly as this service did for its own administrators in Phase 2. D-1 covers the need in the meantime. |
| `users.password.reset` | jovi-mall has no administrator-initiated password flow. `updatePassword` exists on the repository with no admin caller, and the user-facing path is a self-service email round trip. Issuing a one-time password to a platform user needs a delivery channel and an expiry policy neither service has decided. |
| `users.roles.manage` | Adding a role **provisions a role entity** (a Store, a Magazin) through `AuthService.addRole`. Removing one has no implementation anywhere in jovi-mall and no defined semantics: removing `vendor` strands the Store, its products and their order history. Inventing those semantics from the admin side is how a vendor's catalogue ends up belonging to nobody. |

Shipping any of the three as an endpoint that half-works would be worse than the gap: an
administrator who clicks "sign out everywhere" and is told it succeeded will act as though it did.

---

## D-6 · The activity feed is the audit trail, narrowed — not a platform-activity feed

`GET /users/:userId/activity` returns audit rows whose **target** is this user: every suspension,
reinstatement and identifier change, with actor, request context and outcome.

It deliberately does **not** assemble the person's own platform activity — their orders, shipments
and tickets. Those live in other domains behind `orders.read`, `shipments.read` and
`support.tickets.read`, and joining them in here would let `users.read` alone reach data those
permissions exist to gate.

Two consequences of building it on ADR-006's trail rather than on a new store:

- **The route requires `users.read` AND `audit.read`.** Requiring only the first would make this a
  second door onto the trail that bypasses the permission governing it. Both tiers that hold either
  hold both, so it costs nobody access today; it states the dependency so a future tier change
  cannot open a side door.
- **Support can read it, by design.** `user` classifies as `platform_actor` in
  `audit-subject.ts`, which is the class tier 3 may read. Support already holds `users.read`, and
  seeing what was done to an account they can look up is the point of the role. The repository's own
  per-tier scope still applies on top.

The feed's `action` filter is **derived** from the audit catalog (`AUDIT_ACTION_NAMES.filter`), not
typed out — jovi-mall kept two hand-maintained copies of its agent notification types, they drifted,
and eight situations silently stopped being delivered.

---

## D-7 · Suspension provenance on the row; the durable record in the trail

`users` gains `suspended_at`, `suspended_reason` and a `suspended_by` **actor stamp**
(`_user_id` + `_source` + `_name`, per `core/types/actor-source.types.ts`, because an administrator's
id belongs to the wi-admin database and resolves to nothing in `jovi_mall`).

Reinstatement **clears all of it**. That is the same behaviour ADR-006 criticised in
`applyReinstatement` — and it is correct here for the reason that criticism no longer applies: the
audit trail now exists and is append-only, so `users.reinstate` is a permanent record that the
suspension happened. Leaving a reason on an active account would put a stale explanation on a row
that any screen rendering the block without checking `status` first would show as current.

A contact edit gets **no** stamp, and the asymmetry is the rule: a suspension is a *state* somebody
must be able to explain later, so it carries who and why; an edit is an *event*, and the part that
matters when it is disputed — the previous value — is in the audit row's `before`, which no column
could hold.

---

## D-8 · What the read surface may see

Two locks, and the second is the one that survives a hurried change to the first:

1. **A whitelist projection per repository.** `password_hash` is not excluded — it is never
   selected. An exclusion list protects only what somebody thought of, so a credential-shaped field
   added upstream next year would arrive automatically.
2. **Named-field DTO mapping, never a spread.** A widened projection does not reach the wire until
   someone also names the field.

The role profiles are where this matters most. `delivery_agents` is the richest document on the
platform — `legal_identity`, `payout_details`, `emergency_contact`, live device telemetry — and the
vendor and agency rows carry KYC documents and payout destinations. The detail view asks one
question ("what is this person on the platform?") and its projections answer exactly it: id, display
name, status, `legit_verified` for the two businesses, `kyc.status` for the agent, created date.
Anything more belongs on that role's own screen behind that role's own permission, not smuggled in
as a sub-object where `users.read` alone would reach it.

A claimed role whose entity is **missing** is reported (`missing: true`) rather than omitted: that
state makes `requireAuth` answer `AUTH_ROLE_PROFILE_NOT_FOUND` and the person cannot use the role at
all, so a screen that silently dropped the row would leave an administrator unable to see why.

---

## The surface

| | | Permission |
|---|---|---|
| `GET` | `/api/v1/users` | `users.read` |
| `GET` | `/api/v1/users/:userId` | `users.read` |
| `GET` | `/api/v1/users/:userId/activity` | `users.read` + `audit.read` |
| `PATCH` | `/api/v1/users/:userId` | `users.update` |
| `POST` | `/api/v1/users/:userId/suspend` | `users.suspend` |
| `POST` | `/api/v1/users/:userId/restore` | `users.suspend` |

`?page` `&limit` (≤100) `&sort=-createdAt|updatedAt|email` `&search` `&role` `&status` `&from` `&to`.
`search` matches an email, a phone number, **or a user id** — every other admin screen identifies a
person by id, so pasting one into the only search box is the obvious move and a directory that
answers "no results" to a valid id looks broken rather than strict.

Suspend and restore are POST sub-resources rather than a `PATCH { status }`, per ADR-005 D-4: the
permission and the audit row attach to the action, they are two distinct audit actions, and a status
field could not require a reason on one direction and forbid it on the other.

On jovi-mall's side: `PATCH /api/internal/admin/users/:userId`, `POST …/suspend`, `POST …/restore`.
No read endpoint — wi-admin reads the collection.

---

## Consequences

- **A suspended user is signed out of everything on their next request.** This is new behaviour for
  the platform, not only for the admin surface. Any account already sitting at `status: 'suspended'`
  in the database — written by a script or a seed — **loses access the moment this deploys**. There
  is no migration, because that is the correct meaning of the column; but it is worth checking
  `db.users.countDocuments({ status: 'suspended' })` before rolling out.
- The `{ status, roles, created_at }` compound index is added to the `users` model. `autoIndex` is on
  in jovi-mall, so it builds at boot; on a large collection that first boot is slower.
- `users.update` is granted to tiers 1–2 via `allInFamily('users')` and is deliberately **not**
  flagged sensitive. The flag's mechanical effect is to force a tier to name the permission by hand,
  and the tier that would name it is the tier whose job this is. What contains it instead is that
  the identifiers are the only writable fields, and that every edit lands in the trail with the
  previous value in `before`.
- The read path now touches five collections (`users` plus the four role entities), one round trip
  per role a user actually holds. A customer — which most users are — costs one.

## What this also fixed

`verify:platform` — the Phase 4 exit gate — **had not compiled since Phase 3.5**. That phase made
`AdminAccountRepository.create` take a required `ClientSession` (the type-level guarantee that an
unaudited administrator mutation cannot be written), and this one script was never updated. Nothing
caught it because it is the only suite needing both services running, so it is in no routine loop.
Fixed here, and it now passes at 30 — worth knowing before the remaining endpoints land and it
becomes the gate they are proven against.

---

## Still open

1. **Server-side sessions in jovi-mall.** The precondition for `users.sessions.revoke`, and the fix
   for the wider problem that platform tokens cannot be invalidated at all.
2. **The commented-out password check** (`auth.service.ts:190-191`). Owned by the platform owner and
   still live at the time of writing. Until it is fixed, suspension is the only thing standing
   between an attacker and any account whose email or phone they know — which raises the value of
   this phase and does not substitute for the fix.
3. **Bulk operations.** Suspending a cohort is one request per user today. Deliberate: a bulk write
   with one reason and one audit row would be exactly the shape ADR-005 D-10 refuses.
