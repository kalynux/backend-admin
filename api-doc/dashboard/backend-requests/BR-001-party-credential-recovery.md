# BR-001 · Credential recovery for platform parties

**Verified against source on 2026-09-08** — both proposed routes, their permissions and their audit
actions against the live route manifest; the `†` list below and the `broadcast`/`customers`
permissions it names against `admin/src/modules/authorization/domain/permission.catalog.ts`; the
request body against `users/validators/user.validator.ts` (`SendCredentialSchema`); and the
response shape against `users/gateways/user.gateway.ts` (`CredentialDeliveryResult`).

> ### ✅ BUILT — and this page's *"What exists today: **Nothing**"* is a snapshot of 2026-08-17
>
> **Answered in [`RESPONSE-2026-08-17.md`](RESPONSE-2026-08-17.md). The live contract is
> [`users.md`](../../api/users.md) § *Credential recovery*** — read that, not this.
>
> ```
> POST /api/v1/users/:userId/password-reset-link   users.password.reset      audited
> POST /api/v1/users/:userId/login-link            users.login_link.send     audited
> ```
>
> Three things below are **no longer true**, and each would mislead:
>
> - ⛔ *"there is no endpoint anywhere in the **179**"* — the surface is **237** versioned routes
>   across **24** groups today, and two of them are these. Re-derive rather than re-quote:
>   `npm run authz:matrix` for permissions, and `routeManifest()` for routes.
> - ⛔ **The six-permission `†` list is wrong twice over.** `users.password.reset` was routed by
>   this very request, and `broadcast.send`, `customers.read` and `customers.suspend` are **not in
>   the permission catalog at all** any more. There are exactly **four** catalogued-but-unrouted
>   permissions today: `users.sessions.revoke`, `users.roles.manage`, `notifications.manage`,
>   `developer_tools.webhooks.redeliver`.
> - ⛔ **`USER_CHANNEL_UNVERIFIED` (§2, and the error table) was never created.** jovi-mall's
>   `users` row carries no `email_verified`, so the gate this page proposes protects nothing —
>   the reasoning is in [`RESPONSE-2026-08-17.md`](RESPONSE-2026-08-17.md) § *There is no
>   `emailVerified` on a user*. Do not branch on it.
>
> The rest is kept as the record of the ask, and the seven design questions in it are each
> answered in the response.

**Priority: high. Scope: two services.** This one cannot be done inside wi-admin alone.

## The ask

> We should be able to send a login link to customers, and a reset-password link to vendors,
> agencies and agents, on either their WhatsApp, email or Telegram, so far as they are in the system.
> (This can be found in the *Edit login details* dialog.)

## What exists today

**Nothing.** Not partially — there is no endpoint anywhere in the 179 that transmits anything to a
platform party.

| Capability | Status |
|---|---|
| Send a login link to anybody | **No endpoint** |
| Send a password-reset link to anybody | **No endpoint** |
| Deliver over email / WhatsApp / Telegram | **No endpoint** |
| Force a platform user to sign out | **No endpoint** |
| Any `/customers` surface | **No route group at all** |
| Change a user's email or phone | `PATCH /users/:userId` ✅ — the only thing that exists |

Four contract lines make this explicit rather than accidental:

- [`notifications.md`](../../api/notifications.md): *"Nothing here creates a notification. There
  is no `POST /notifications`. Every row is derived by a background projector from a row some other
  part of the platform already committed. An endpoint that manufactured one would be exactly the hole
  this design was asked not to open."* `/notifications` is the **administrator inbox**, inbound only.
- [`users.md`](../../api/users.md), *what this surface deliberately does not offer*:
  password reset — *"jovi-mall has no administrator-initiated password flow"*; forced sign-out —
  *"jovi-mall issues stateless JWTs with no session store — there is nothing to revoke."*
- [`permissions.md`](../../api/permissions.md): `users.password.reset †`,
  `users.sessions.revoke †`, `users.roles.manage †`, `broadcast.send †`, `customers.read †`,
  `customers.suspend †` — all **catalogued policy with no endpoint built yet**.
- WhatsApp and Telegram appear **twice in the whole contract**, neither of them a send:
  `GET /system/integrations?probe=smtp,telegram` (a health probe — and the page notes *"against
  WhatsApp it is a message to a real person"*, so it is not probed), and `store.supportWhatsapp` /
  `contact.whatsappVerified` as read-only display fields on a vendor.

**The one adjacent thing that does exist** is `POST /administrators/:adminId/password-reset`. It is
worth reading before designing this, and worth *not* copying wholesale: it targets an **administrator**,
generates the password server-side (*"the password is generated, never supplied"*), and **returns it
in the response body** — `{ administrator, oneTimePassword, sessionsEnded }` with the message *"the
password below is shown once."* It sends nothing anywhere. Handing a one-time password back to an
operator to read out over the phone is a different security model from mailing a link to the party,
and the second is what is being asked for.

## What the dashboard does in the meantime

**Nothing.** No button, no disabled affordance, no feature flag. Decided deliberately: a control that
cannot work teaches an operator a workflow that does not exist, and a disabled one reads as *"you lack
a permission"*, which is the wrong diagnosis.

`src/components/users/EditIdentifiersDialog.tsx` continues to edit `email` and `phone` only.

## The proposed contract

Two routes, symmetric, both **delegated** — the credential lives in jovi-mall, so wi-admin issues the
instruction and jovi-mall mints and sends.

### `POST /api/v1/users/:userId/login-link`
### `POST /api/v1/users/:userId/password-reset-link`

The dashboard identifies a vendor, an agency and an agent all by their **`userId`**, and every one of
those directories already exposes it (`Vendor.userId`, `Agency.userId`, `Agent.userId`). Keying both
routes on `/users/:userId` therefore covers all four parties with one surface and one permission,
rather than four near-identical routes that drift. If you prefer per-directory routes, they must
share one service.

**Body** (strict — unknown key is a `400`):

| Field | Type | Rules |
|---|---|---|
| `channel` | string | **Required.** `email` · `whatsapp` · `telegram`. A pinned enum: an unrecognised channel must be a `400`, not a silent fallback to email |
| `reason` | string | **Required**, trimmed, 3–500. This is an administrator acting on someone else's account; the audit row needs a why |

The destination is **not** in the body, on purpose. An operator who could type the address could mail
a working credential for somebody else's account to themselves. The service reads the party's own
`email` / `phone` and refuses if the requested channel has none.

**Response `200`** — deliberately thin. It must **not** contain the link, the token, or the full
destination.

```jsonc
{
  "success": true,
  "data": {
    "channel": "whatsapp",
    "destinationMasked": "+2376••••4417",
    "expiresAt": "2026-08-17T11:42:00.000Z",
    "sentAt": "2026-08-17T11:27:00.000Z"
  },
  "message": "Login link sent by WhatsApp"
}
```

### Questions the design has to answer, not implementation details

1. **Link semantics.** Single-use, and expiring — we suggest 15 minutes for a login link, 60 for a
   reset. A login link is a **bearer credential sitting in a messaging app**; it must be invalidated
   on first use and on any subsequent issue for the same party.
2. **Unverified destinations.** A party may hold an `email` with `emailVerified: false`. Sending a
   credential to an unverified address is an account-takeover path. Our reading: refuse, with a
   distinct code so the dashboard can say *why* rather than showing a generic failure.
3. **Rate limiting.** Per party and per administrator. An unrated endpoint here is an SMS-pumping
   bill and a harassment vector.
4. **Enumeration.** Less critical than on a public endpoint (the caller is already authenticated and
   permissioned) but the response must still not distinguish *"no such user"* from *"no address on
   that channel"* in a way that turns the directory into an oracle for operators whose scope should
   not reach that row. `404` for out-of-scope is the existing rule.
5. **Does it need dual control?** Issuing a login link to a high-value vendor account is close in
   effect to signing in as them. Four-eyes currently guards three actions; this may be a fourth. If
   so it answers `202` with an approval id and the dashboard renders *"waiting for approval"*.
6. **Which permission.** `users.password.reset` is already catalogued and `†`. Routing it here is the
   obvious move; note that doing so changes the tier matrix, and **tier 3 Support must not hold it** —
   Support answers delivery tickets and would otherwise be able to take over any vendor account.
7. **Telegram.** Requires a `chatId`, not a phone number, and the platform stores no such field on
   any party today. Either it is out of scope for v1 or a `telegramChatId` has to be collected during
   onboarding — that is a jovi-mall product change, not a wi-admin one.

### Error codes to add to `errors.md`

| Code | Status | Meaning |
|---|---|---|
| `USER_CHANNEL_UNAVAILABLE` | 409 | The party has no address on the requested channel |
| `USER_CHANNEL_UNVERIFIED` | 409 | They have one, but it is unverified |
| `USER_CREDENTIAL_LINK_THROTTLED` | 429 | Rate limit; include `Retry-After` |
| `PLATFORM_OPERATION_REJECTED` | passthrough | jovi-mall refused; reason in `details.platformCode` |

### Audit

Two actions, catalogued and returned by `GET /audit/actions`: `users.login_link.send` and
`users.password_reset_link.send`. Both `sensitive: true`. The row records the channel and the
**masked** destination, never the token. If the action is queued, `status: "queued"` with
`viaApprovalId`, per the existing convention.

## Acceptance

- [ ] Both routes exist, are delegated, and are audited in the same transaction that sends.
- [ ] `channel` is a pinned enum; an unknown value is a `400`.
- [ ] The destination is read from the party's record and never accepted from the caller.
- [ ] The response carries no token and no unmasked destination.
- [ ] Links are single-use and expire; issuing a new one invalidates the previous.
- [ ] Rate-limited per party and per administrator, with `Retry-After`.
- [ ] A decision is recorded on unverified destinations, on dual control, and on Telegram.
- [ ] The permission is routed, removed from the `†` list in `permissions.md`, and **not granted to
      tier 3**.
- [ ] New codes are in `errors.md`; new actions are in the audit catalog.
- [ ] jovi-mall has grown the administrator-initiated credential flow this depends on.
