import { platformRequest } from '../../../infra/platform/platform.client';
import { ActorContext } from '../../audit/domain/audit-context';
import { auditedAttempt } from '../../audit/domain/audit.writer';

/**
 * The messaging surface, delegated to jovi-mall. One operation.
 *
 * ── Why delegated, and why it could not be anything else ─────────────────────
 * Sending needs `TELEGRAM_BOT_TOKEN` and the `channel_connections` collection that maps a
 * platform user to their Telegram chat. Both live in jovi-mall, and putting a bot token in
 * a second deployment is the same duplication `STORAGE_PROVIDER` is kept out of this
 * service for (ADR-009 D-6, the file gateway's argument). There is nothing here to own.
 *
 * ── This is not a broadcast, and the family was renamed to stop implying it ──
 * One message, one recipient. `TelegramBotService.sendMessage` returns a boolean and keeps
 * no delivery record, so there is no audience, no segmentation, no scheduling and nothing
 * to report on afterwards. The permission was `broadcast.send` and is now
 * `messaging.telegram.send` (Phase 5 D-11).
 *
 * ── ⚠ What moving this off `/api/webhooks/*` actually changed (Phase 5 C-6) ──
 * The plan predicted this became rate-limited AND maintenance-blocked. Both halves were
 * wrong, and one is inverted. Verified against jovi-mall's source:
 *
 *  - **Maintenance: MORE available, not less.** `/api/internal/admin` is the first entry in
 *    jovi-mall's `ALWAYS_EXEMPT` — reachable in every mode, unconditionally. The old
 *    `/api/webhooks` exemption was conditional on `blockWebhooks` being unset, so an
 *    operator could revoke it per window. **That per-window off switch is gone**, and this
 *    service has no maintenance mode of its own to replace it.
 *  - **jovi-mall's rate limiter does not apply at all.** This service presents
 *    `INTERNAL_ADMIN_SERVICE_TOKEN`, so `resolveCallerClass` returns `internal_service`,
 *    which is `'exempt'` in both `GLOBAL_POLICY` and `IDENTITY_POLICY`; its Layer B never
 *    runs, being mounted at the tail of a `requireAuth` this path does not use. What is new
 *    is **this service's own identity-scoped limiter**, which is the intended answer.
 *
 * ── Audited, with the body (Phase 5 O-2) ─────────────────────────────────────
 * `transport: 'external'`, so intent → outcome rather than a transaction: the send happens
 * in another process and no `wi-admin` ClientSession can join it.
 *
 * A send is the one action on this surface that cannot be undone in any sense — not
 * "unrecoverable" like a file delete, where the record is gone but nothing happened to
 * anybody, but **already read**. The only useful question afterwards is what was said to
 * whom, so the row carries the recipient AND the full body. That is the owner's decision on
 * O-2, taken knowing the body is operator-authored free text: the standard credential
 * redaction and the payload size cap still apply, and `message` is not a redacted field
 * name, so what an operator types is what the trail keeps.
 */

/** jovi-mall's answer: it echoes the chat it resolved, which is the only proof of WHERE. */
export interface TelegramSendResult {
    sent: boolean;
    chatId: string | null;
}

export interface SendTelegramMessageInput {
    userId?: string;
    chatId?: string;
    message: string;
}

/**
 * What the audit row remembers about a send — Phase 5 **O-2**.
 *
 * ⚠ **The full message body is here on purpose, and it is the owner's decision.** Every
 * other payload on this service records the FIELDS THAT CHANGED on a record that still
 * exists, so the row is a pointer and the record is the evidence. There is no record here:
 * jovi-mall's `sendMessage` returns a boolean and keeps nothing, so this row IS the
 * evidence, and a row saying only "an administrator messaged this customer" cannot answer
 * the one question a complaint about a send ever asks.
 *
 * Taken knowing the body is operator-authored free text nobody validated — an operator can
 * paste anything into it. What bounds that is the machinery every payload already goes
 * through: `redact()` replaces credential-shaped fields at any depth, and the size cap
 * replaces an oversized value with a summary. `message` is deliberately NOT a redacted
 * field name; if it becomes one, this decision silently stops taking effect.
 *
 * Exported and pure so `test:messaging` can assert the body survives rather than scanning
 * the source for a line that says it does — the same reason `toOrphanFile` is exported in
 * the file gateway, applied to the opposite risk. There the assertion is that a field is
 * ABSENT; here it is that one is PRESENT.
 *
 * Both recipient fields are always present and explicitly `null` when unused. A row where
 * `chatId` is missing and a row where it was never given must not read the same way.
 */
export function toAuditPayload(input: SendTelegramMessageInput): Record<string, unknown> {
    return {
        userId: input.userId ?? null,
        chatId: input.chatId ?? null,
        message: input.message,
    };
}

/**
 * Send one Telegram message.
 *
 * ⚠ **`after` is the resolved chat, and `before` is `null` by construction.** There is no
 * record being changed — nothing existed before the send and nothing is diffable — so
 * inventing a `before` here would be describing a state that never was. What the outcome
 * usefully adds is the `chatId` jovi-mall resolved, which is the difference between "an
 * administrator sent this" and "an administrator sent this, and it went here".
 *
 * Failures are not translated. jovi-mall answers `404 MESSAGING_CONNECTION_NOT_FOUND` when
 * the recipient has no Telegram connection and `502 MESSAGING_DELIVERY_FAILED` when the
 * chat resolved and Telegram refused it; `platformRequest` carries the first through as-is
 * with its `platformCode` and files the second as a dependency failure, which is exactly
 * what each one is. `auditedAttempt` stamps the outcome either way, so a refused send is on
 * the trail as a refused send rather than absent from it.
 */
export async function sendTelegramMessage(
    input: SendTelegramMessageInput,
    context: ActorContext,
): Promise<TelegramSendResult> {
    return auditedAttempt(
        {
            action: 'messaging.telegram.send',
            actor: {
                kind: 'administrator',
                id: context.actor.adminId,
                email: context.actor.email,
                displayName: context.actor.displayName,
                tier: context.actor.tier,
                sessionId: context.actor.sessionId,
            },
            /**
             * `target: 'user'` even when the operator addressed a raw `chatId`, in which
             * case the id is null and the label carries the chat.
             *
             * A Telegram chat id addresses a PERSON — it is how Telegram names one — so the
             * honest target type is the same in both cases; what differs is whether we can
             * put a platform id in the searchable column. `target: 'none'` would have been
             * the alternative and is worse for the same reason it was rejected for
             * `files.delete`: it puts the only handle anybody has on the recipient into the
             * payload and leaves the column an operator searches empty.
             *
             * The classification consequence is deliberate: `user` is `platform_actor`, so
             * Support can READ this row. They cannot perform the send — the permission is
             * tier 1-2 — and seeing that an administrator messaged a customer they are
             * supporting is the point of the class.
             */
            target: {
                type: 'user',
                id: input.userId ?? null,
                label: input.chatId ? `telegram:${input.chatId}` : null,
            },
            context: {
                method: context.method,
                path: context.path,
                requestId: context.requestId,
                ip: context.ip,
                userAgent: context.userAgent,
            },
            payload: toAuditPayload(input),
        },
        async () => {
            const result = await platformRequest<{ sent: boolean; chatId?: string }>({
                method: 'POST',
                path: '/messaging/telegram',
                body: input,
                actor: context.actor,
                requestId: context.requestId,
            });

            const sent: TelegramSendResult = {
                sent: result.data?.sent === true,
                chatId: result.data?.chatId ?? null,
            };

            return { result: sent, before: null, after: { chatId: sent.chatId } };
        },
    );
}
