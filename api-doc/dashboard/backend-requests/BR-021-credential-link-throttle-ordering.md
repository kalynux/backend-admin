# BR-021 · The credential-link throttle is **not** counted on the attempt, and `users.md` says it is

**Raised 2026-09-09, from Phase 6 live verification against a running `:8033`.** Found while
confirming the forwarded-429 detail scrub, which is the premise a shipped dialog is built on. The
scrub itself is **correct and confirmed** — that half is in
[VERIFICATION-2026-09-09-LIVE](../../../VERIFICATION-2026-09-09-LIVE.md) § 5. This is the other
thing the same experiment turned up.

**Priority: medium.** Nothing in the dashboard is broken by it and no operator is harmed. What is
wrong is a **checkable claim about a rate limit**, stated in wi-admin's own contract page and in
jovi-mall's own docblock, and the claim is the reason the limit is described as safe.

---

## The claim

[`users.md`](../../api/users.md) § Rate limits, on `POST /users/:userId/password-reset-link` and
`POST /users/:userId/login-link`:

> Counted on the **attempt**, so a caller cannot probe which channels a party has by burning
> failures for free.

jovi-mall states the same intent, more explicitly, at
`backend/jovi-mall/src/modules/messaging-login/services/admin-credential-delivery.service.ts:186-192`:

> Incremented on the ATTEMPT rather than on success, so a caller cannot probe which channels a
> party has by burning failures for free — and so a delivery that fails downstream still costs the
> operator their allowance, which is the honest accounting for a message that may well have gone
> out.

## What the code does

The send path in that same file, `sendCredential`:

```
132    const destination = await this.resolveDestination(user, channel);   ← refuses here
134    await this.assertWithinLimits(userId, actorId);                      ← counts here
137    const issued = … issueReset(user) / issueLogin(user)
142    await this.deliver(kind, channel, destination, issued);
```

`resolveDestination` throws `409 USER_CHANNEL_UNAVAILABLE` **before** `assertWithinLimits` is
reached. So a channel the party does not have costs the caller nothing: the counter is never
incremented, and the probe is free and unbounded.

The second half of the docblock's claim — *"a delivery that fails downstream still costs the
operator their allowance"* — **is** true, because `deliver` runs at 142, after the count. Only the
probe half is false, and it is the half that names an attacker.

## Measured on the wire

Against `:8033` with a tier-1 session, on user `6a9b699d…` (a `customer`, `email: null`,
`phone: +237672745831`), `channel: "email"`:

| Attempt | Status | `error.code` | `details` |
|---:|---|---|---|
| 1 | 409 | `PLATFORM_OPERATION_REJECTED` | `{ platformCode: "USER_CHANNEL_UNAVAILABLE", channel: "email" }` |
| 2 | 409 | same | same |
| 3 | 409 | same | same |
| 4 | 409 | same | same |
| 5 | 409 | same | same |

The party limit is **3 per hour** (`PER_PARTY_LIMIT`), so attempt 4 should have been a 429 if the
counter had been touched. It was not. Confirmed directly in Redis: the key
`admin_credential:party:<sha256(userId)>` in DB 14 **did not exist** after five attempts
(`valueBefore: null` when the next step read it).

Reaching the genuine 429 therefore required pre-loading that counter past its limit and then
calling with a channel that *does* resolve. That is also what made the test safe to run — the
throw at 134 precedes `issueReset` (137) and `deliver` (142), so no token was minted and no
message was sent, on a platform where WhatsApp and Telegram both hold live credentials.

## Why this is worth an issue rather than a shrug

**The oracle it describes is real.** An administrator holding `users.password.reset` can enumerate,
for any party in scope and at no cost to their allowance, which of `email` / `whatsapp` / `telegram`
that party has on file — one 409 per channel, repeatable. `details.channel` names the channel back,
and the message (*"This person has no email address on file"*) is explicit. Three requests
per party is a complete answer.

Whether that matters is **your** judgement about your own boundary — an administrator is a trusted
party and this is contact metadata, not a credential. We are not claiming it is severe. We are
claiming that the sentence which would tell a reader it is *impossible* is not true, and a reader
who checks the doc rather than the code will conclude the wrong thing. This one is checkable in
five requests, which is how we found it.

## Asking for one of

| | What you would change |
|---|---|
| **(a) The ordering is the bug** | Move `assertWithinLimits` above `resolveDestination`, so a refused channel costs the allowance the docblock already promises it costs. ⚠ Note the side effect, because it is not free: a party whose contact details are simply missing then consumes their own 3/hour, so a legitimate operator who picks the wrong channel twice is locked out of the right one for an hour. That is arguably worse than the oracle |
| **(b) The claim is the bug** | Keep the ordering and **correct both sentences** — `users.md` § Rate limits and the docblock at `:186-192`. Say that the count begins once a channel resolves, and that a refused channel is free. If the oracle is accepted, say that too: it is contact metadata, and the caller already holds a permission to send to that contact |

**(b) is our guess.** (a) trades a metadata oracle for a self-inflicted lockout on the commonest
operator mistake in that dialog, and the dialog has no way to know which channels exist before
trying — the shape of the refusal is the only discovery mechanism the UI has.

## What the dashboard does meanwhile

Nothing changes. `SendCredentialLinkDialog` renders the server's message on both the 409 and the
429 and branches on neither `platformCode` nor `scope` — see BR-012 and the Phase 2c note in
[VERIFICATION-2026-09-09-LIVE](../../../VERIFICATION-2026-09-09-LIVE.md) § 5. It does not attempt
to discover channels ahead of a send, and it will not start.
