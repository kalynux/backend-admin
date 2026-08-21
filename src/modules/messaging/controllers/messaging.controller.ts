import { Request, Response } from 'express';
import { asyncHandler } from '../../../core/http/async-handler';
import { sendSuccess } from '../../../core/http/responses';
import { actorContextOf } from '../../audit/domain/audit-context';
import * as gateway from '../gateways/messaging.gateway';
import { SendTelegramMessageBody } from '../validators/messaging.validator';

/**
 * `/api/v1/messaging` — reaching one person on one channel.
 *
 * See `gateways/messaging.gateway.ts` for why it is delegated, what the move off
 * jovi-mall's webhook prefix actually changed, and why the audit row keeps the body.
 */
export class MessagingController {
    /**
     * POST /api/v1/messaging/telegram — one message, one recipient.
     *
     * Answers `{ sent: true, chatId }`. **The `chatId` comes back on purpose**: when the
     * operator addressed a `userId`, the connection was resolved two services away and this
     * is the only evidence of where the message actually went. A caller that never learns
     * the resolved chat cannot tell a correct send from one to a stale connection.
     *
     * Nothing is caught here. jovi-mall answers 404 when the recipient has no Telegram
     * connection and 502 when the chat resolved and Telegram refused it, and both should
     * reach the operator as what they are — the first is "there is nobody to send to", which
     * is actionable, and the second is "try again", which is not the same thing. Flattening
     * them into one status is exactly what the legacy handler did (`INTERNAL_SERVER_ERROR`
     * at 400 for both) and why nobody could tell them apart.
     */
    static sendTelegram = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as SendTelegramMessageBody;

        const result = await gateway.sendTelegramMessage(body, actorContextOf(req));

        sendSuccess(res, result);
    });
}
