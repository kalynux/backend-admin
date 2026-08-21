import { z } from 'zod';
import { objectId } from '../../../core/validation/common.schemas';

/**
 * `POST /api/v1/messaging/telegram` — one message, one recipient.
 *
 * ⚠ **EXACTLY one of `userId` / `chatId`, and the "exactly" is this schema's whole job.**
 * jovi-mall's own schema (`telegram.validator.ts`) asks for AT LEAST one, and its service
 * then prefers `chatId` and never resolves the `userId`. So a body carrying both is
 * accepted there and silently ignores half of what the operator asked for — the message
 * goes to the chat, and the user id that was supposed to name the person is never read.
 * There is no error, no log line and no way to notice from the response.
 *
 * Refused here rather than there for the reason the file validators already use for the
 * 24-hour floor: the refusal should arrive BEFORE the hop, and this side is the one an
 * operator is talking to. jovi-mall stays permissive deliberately — narrowing it would
 * change the behaviour of a shape this side has already narrowed, and it is the second
 * lock, not the first.
 *
 * ── Why `userId` is an ObjectId and `chatId` is not ──────────────────────────
 * `userId` is a jovi-mall `users` id and gets the shared validator, so a typo is a 400 here
 * instead of a "no Telegram connection" 404 from two services away. A Telegram `chat_id` is
 * Telegram's own numeric identifier, not ours — it is passed through as an opaque string
 * and only Telegram can say whether it is real.
 *
 * The 4096 ceiling is Telegram's message limit, restated so an over-long body is refused
 * before it is sent rather than after the API rejects it.
 */
export const SendTelegramMessageSchema = z
    .object({
        userId: objectId.optional(),
        chatId: z.string().trim().min(1).max(64).optional(),
        message: z.string().trim().min(1, 'A message is required').max(4096, 'Telegram messages are limited to 4096 characters'),
    })
    .superRefine((body, ctx) => {
        const named = [body.userId, body.chatId].filter(Boolean).length;

        if (named === 0) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['userId'],
                message: 'Name a recipient: either `userId` or `chatId`',
            });
            return;
        }

        if (named === 2) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['chatId'],
                message: 'Name exactly one recipient — `userId` and `chatId` cannot both be given',
            });
        }
    });

export type SendTelegramMessageBody = z.infer<typeof SendTelegramMessageSchema>;
