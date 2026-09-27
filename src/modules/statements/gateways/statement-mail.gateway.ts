import { platformRequest } from '../../../infra/platform/platform.client';
import { ActorContext } from '../../audit/domain/audit-context';
import { StatementOwnerType } from '../domain/statement.types';

/**
 * `POST /api/internal/admin/mail/statement` — jovi-mall relays the file this service rendered.
 *
 * ⚠ **There is no recipient in this body, and there must never be one.** jovi-mall resolves
 * the address from the owner profile (registered AND verified) and its schema is `.strict()`,
 * so a `to` field would be refused. That is owner decision O-6 enforced on the side that
 * holds the address. See `jovi-mall/src/modules/mail/admin-statement-mail.routes.ts`.
 */
export interface StatementMailResult {
    sent: boolean;
    /** Masked (`j***@example.com`) — enough for the operator to recognise, not to harvest. */
    recipient: string;
    bytes: number;
}

/** A provider hop with an 8 MB attachment is not a 5-second read. */
const MAIL_RELAY_TIMEOUT_MS = 60_000;

export async function mailStatement(
    input: {
        ownerType: StatementOwnerType;
        ownerId: string;
        from: string;
        to: string;
        fileName: string;
        contentType: string;
        content: Buffer;
    },
    context: ActorContext,
): Promise<StatementMailResult> {
    const result = await platformRequest<StatementMailResult>({
        method: 'POST',
        path: '/mail/statement',
        actor: context.actor,
        requestId: context.requestId,
        body: {
            ownerType: input.ownerType,
            ownerId: input.ownerId,
            from: input.from,
            to: input.to,
            fileName: input.fileName,
            contentType: input.contentType,
            contentBase64: input.content.toString('base64'),
        },
        timeoutMs: MAIL_RELAY_TIMEOUT_MS,
        largeBody: true,
    });
    return result.data;
}
