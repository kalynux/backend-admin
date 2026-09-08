# `/messaging` — one Telegram message, to one person

**Verified against source on 2026-09-08** — the route and its guard, the exactly-one-recipient refinement, the 4096 ceiling, the `200` shape and all four error rows, against `admin/src/modules/messaging/{routes,validators,gateways}/`, `admin/src/infra/platform/platform.client.ts:545-590` and jovi-mall's `src/modules/telegram/admin-messaging.routes.ts:83-106`.

One route. It is **not a broadcast**, and the family was renamed at Phase 5 Part C to stop
implying that it is.

| Method | Path | Permission | Tiers | Audited |
|---|---|---|---|---|
| POST | `/api/v1/messaging/telegram` | `messaging.telegram.send` | 1 · 2 | **Yes** |

**Delegated** to jovi-mall.

---

## Why this exists

`POST /api/webhooks/telegram/send` was the **last legacy admin endpoint anywhere**, and the
last of three that lived outside `/api/admin` on public-looking prefixes — the shape a sweep
misses, because the path says *webhook* and the guard says *admin*. Part B took the two file
ones; this was the third. Porting it took `LEGACY_ENDPOINT_COUNT` to **0**.

Its old guard was `requireAuth + requireRole(['admin'])` on a jovi-mall `users` row: a
credential that predates this service's permission catalog entirely and carries no tier, so
the tier matrix could not have been applied to it where it stood.

Delegated for the ordinary reason (ADR-004 D-2, ADR-009 D-6): sending needs
`TELEGRAM_BOT_TOKEN` and the `channel_connections` collection that maps a platform user to
their Telegram chat. Both are jovi-mall's, and a bot token in a second deployment is exactly
the duplication that rule exists to prevent. There is nothing here to own.

---

## What this is *not*

The permission used to be `broadcast.send`, summarised as *"Send a broadcast message to
platform users"*. That was wrong three times over, and the rename (Phase 5 **D-11**) is the
substance of this port rather than a tidy-up:

| The old name implied | What is actually there |
|---|---|
| An audience | One recipient. There is no segmentation, no list, no "all vendors" |
| Scheduling | None. The call sends, or raises |
| A delivery record | None. jovi-mall's `sendMessage` returns a boolean and keeps nothing — **the audit row is the only record a send ever leaves** |
| "platform users" | Only accounts that linked Telegram through the bot's `/connect` flow |

If you need to reach many people, this is not the endpoint and there is no endpoint. Build
it as its own capability with its own permission.

---

## `POST /api/v1/messaging/telegram`

| | |
|---|---|
| **Permission** | `messaging.telegram.send` — tiers 1 and 2, via `allInFamily('messaging')` |
| **Transport** | Delegated |
| **Audited** | **Yes** — `messaging.telegram.send`, targeting the recipient |

### Body

```jsonc
{
  "userId": "6612a4f0c1a2b3d4e5f60718",
  "message": "Your payout of 45 000 XAF was released this morning."
}
```

```jsonc
{
  "chatId": "123456789",
  "message": "Your payout of 45 000 XAF was released this morning."
}
```

| Field | Rules |
|---|---|
| `userId` | A jovi-mall user id, 24-hex. Their Telegram chat is resolved from their connection |
| `chatId` | A raw Telegram chat id, 1–64 characters, passed through opaquely |
| `message` | **Required.** Trimmed, 1–4096 characters — Telegram's own limit |

> ### ⚠️ Exactly **one** of `userId` / `chatId` — never both
>
> A body naming both is `400 VALIDATION_ERROR`, and the issue path is `chatId`.
>
> This is stricter than jovi-mall's own schema on purpose. Its
> `SendNotificationSchema` asks for *at least* one, and `TelegramNotificationService`
> then prefers `chatId` and never resolves the `userId`. So a body carrying both is
> accepted there, the message goes to the chat, the response says `sent: true`, and the
> user id that was supposed to identify the recipient is never read — with no error, no
> log line, and nothing in the response that differs from a correct send. The refusal is
> here so it arrives **before** the hop.

### Response `200`

```jsonc
{
  "success": true,
  "data": { "sent": true, "chatId": "123456789" }
}
```

| Field | Notes |
|---|---|
| `sent` | Always `true` on a 200 — a failed send raises rather than answering `false` |
| `chatId` | string — **the chat jovi-mall actually resolved**, never `null` on a `200`. When you addressed a `userId`, this is the only evidence of *where* the message went; a client that ignores it cannot tell a correct send from one to a stale connection |

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | No recipient, both recipients, a malformed `userId`, or a message that is empty or over 4096 characters |
| 404 | `PLATFORM_OPERATION_REJECTED` | The recipient has no Telegram connection. `details.platformCode` is `MESSAGING_CONNECTION_NOT_FOUND` |
| 502 | `SERVICE_DEPENDENCY_UNAVAILABLE` | The chat resolved and Telegram refused the message. `details.platformCode` is `MESSAGING_DELIVERY_FAILED` |
| 503 | `SERVICE_DEPENDENCY_UNAVAILABLE` | `JOVI_MALL_BASE_URL` is unset |

**The 404 and the 502 are different situations and should be shown differently.** The first
is *there is nobody to send to* — actionable, and retrying will not help. The second is
*try again*. The legacy handler flattened both into `INTERNAL_SERVER_ERROR` at 400, which is
why nobody could tell them apart.

### What the audit row records

**The recipient and the full message body** (Phase 5 **O-2**).

Every other payload on this service records the fields that changed on a record that still
exists, so the row is a pointer and the record is the evidence. There is no record here —
jovi-mall keeps none — so this row *is* the evidence, and a row saying only "an
administrator messaged this customer" cannot answer the one question a complaint about a
send ever asks.

| Column | Value |
|---|---|
| `target_type` | `user`, in **both** addressing forms |
| `target_id` | The `userId`, or `null` when a raw `chatId` was used |
| `target_label` | `telegram:<chatId>` when a raw chat was used, otherwise `null` |
| `payload` | `{ userId, chatId, message }` — both recipient fields always present, explicitly `null` when unused |
| `after` | `{ chatId }` — the chat jovi-mall resolved |
| `before` | `null` by construction. Nothing existed before the send |

`target_type: 'user'` classifies as `platform_actor`, so **Support can read these rows**
while holding no permission to perform a send. That is the same trade-off `files.delete`
carries: seeing that an administrator messaged a customer whose ticket you are working is
the point of the class.

The body is operator-authored free text that nobody validated. What bounds it is the
machinery every payload already goes through — credential-shaped fields are redacted at any
depth, and an oversized value is replaced by a summary. `message` is deliberately **not** a
redacted field name; `test:messaging` § 2 asserts that through the real sanitiser, because
adding it would reverse this decision silently.

---

## ⚠️ Two things the move changed that a diff does not show

Recorded because both were predicted backwards, and both were verified against jovi-mall's
source before being written down here (Phase 5 **C-6**).

### The send is now *more* available during maintenance, not less

`/api/internal/admin` is the **first entry** in jovi-mall's `ALWAYS_EXEMPT` list — reachable
in every maintenance mode, unconditionally, because blocking it would lock an operator out
of the door they turn maintenance *off* with.

The old `/api/webhooks` exemption was **conditional**: an operator could revoke it for a
given window by setting `blockWebhooks`. **That per-window off switch is gone**, and this
service has no maintenance mode of its own to replace it.

### jovi-mall's rate limiter no longer applies at all

This service authenticates as `internal_service`, which is `'exempt'` in both jovi-mall's
`GLOBAL_POLICY` and its `IDENTITY_POLICY`. Its identity-scoped layer never even runs — it is
mounted at the tail of a `requireAuth` this path does not use.

What bounds an operator now is **this service's own identity-scoped limiter** (see
[README.md § Rate limits](README.md#rate-limits)), which is new and is the intended answer.

---

## Tiers

| | 1 Developer | 2 Admin | 3 Support |
|---|:-:|:-:|:-:|
| `messaging.telegram.send` | ● | ● | · |

It reaches Admin through `allInFamily('messaging')` rather than a typed name, which is only
safe because it carries neither `destructive` nor `sensitive`. That is the right call on
**grantability**: the send changes no record and there is nothing to recover.

What makes it consequential is different — a message is *already read* by the time anybody
reconsiders it — and that is answered by the audit payload above rather than by a flag.
Flags govern who may hold a permission; the audit governs what the trail can answer.
