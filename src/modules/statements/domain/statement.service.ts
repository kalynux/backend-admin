import { createAppError } from '../../../core/errors/app-error';
import { ERROR_CODES } from '../../../core/errors/error-codes';
import { ownerBalances } from '../../accounts/gateways/account.gateway';
import { ActorContext, auditActorOf } from '../../audit/domain/audit-context';
import { auditedAttempt } from '../../audit/domain/audit.writer';
import { AuditIntent } from '../../audit/domain/audit.types';
import { mailStatement, StatementMailResult } from '../gateways/statement-mail.gateway';
import { renderPdf } from '../render/pdf.renderer';
import { renderXlsx } from '../render/xlsx.renderer';
import { buildStatement, OwnerBalances } from './statement.builder';
import { toStatementPeriod } from './statement-period';
import { StatementFormat, StatementOwnerType } from './statement.types';

/**
 * Generate an account statement and either hand it back or have jovi-mall mail it.
 *
 * ── Audited, fail-closed, BEFORE anything is read ─────────────────────────────
 * A statement is the most complete disclosure of an account this service can produce, and the
 * owner granted it to every tier including Support (O-5). What bounds that is the record: the
 * intent row commits first and its failure is not caught, so with the audit store down no
 * statement is built — the `money.payouts.destination.read` posture. The payload carries ids,
 * the period, the format and the channel, never a figure from the file.
 *
 * One audit action per owner type (`money.statements.send_vendor|_agency|_agent`), because a
 * catalog action has a single target type and the row must land on that owner's own activity
 * feed — the same split as `billing.subscriptions.assign_*`.
 */

export const STATEMENT_EMAIL_MAX_BYTES = 8 * 1024 * 1024;

export const CONTENT_TYPES: Record<StatementFormat, string> = {
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pdf: 'application/pdf',
};

export interface StatementRequest {
    ownerType: StatementOwnerType;
    ownerId: string;
    from: string;
    to: string;
    format: StatementFormat;
    delivery: 'download' | 'email';
}

export type StatementOutcome =
    | { delivery: 'download'; fileName: string; contentType: string; content: Buffer }
    | ({ delivery: 'email'; fileName: string } & StatementMailResult);

export function statementFileName(req: Pick<StatementRequest, 'ownerType' | 'ownerId' | 'from' | 'to' | 'format'>): string {
    return `statement-${req.ownerType}-${req.ownerId.slice(-6)}-${req.from}-to-${req.to}.${req.format}`;
}

async function balancesOrNull(req: StatementRequest, context: ActorContext): Promise<OwnerBalances | null> {
    // Best effort: a statement for download is still worth having while jovi-mall is down,
    // and the file says the balances were unavailable rather than printing zeros.
    try {
        const b = await ownerBalances(req.ownerType, req.ownerId, context);
        return {
            pending: b.pending ?? null,
            available: b.available ?? null,
            reserve: b.reserve ?? null,
            requested: b.requested ?? null,
        };
    } catch {
        return null;
    }
}

export async function produceStatement(req: StatementRequest, context: ActorContext): Promise<StatementOutcome> {
    // Validate the period before the audit row, so a typo is a 400 and not an audit entry.
    const period = toStatementPeriod(req.from, req.to);
    const fileName = statementFileName(req);

    const intent: AuditIntent = {
        action: `money.statements.send_${req.ownerType}`,
        actor: auditActorOf(context.actor),
        target: { type: req.ownerType, id: req.ownerId, label: `${req.from} to ${req.to}` },
        context,
        payload: {
            ownerType: req.ownerType,
            ownerId: req.ownerId,
            from: req.from,
            to: req.to,
            format: req.format,
            delivery: req.delivery,
        },
    };

    return auditedAttempt<StatementOutcome>(intent, async () => {
        const balances = await balancesOrNull(req, context);
        const doc = await buildStatement({ ownerType: req.ownerType, ownerId: req.ownerId, period, balances });
        const content = req.format === 'xlsx' ? await renderXlsx(doc) : await renderPdf(doc);
        const contentType = CONTENT_TYPES[req.format];
        const rowCounts = Object.fromEntries(doc.sections.map((s) => [s.key, s.rows.length]));

        if (req.delivery === 'download') {
            return {
                result: { delivery: 'download' as const, fileName, contentType, content },
                after: { bytes: content.length, rowCounts },
            };
        }

        if (content.length > STATEMENT_EMAIL_MAX_BYTES) {
            throw createAppError(ERROR_CODES.STATEMENT_TOO_LARGE_TO_EMAIL, 413, undefined, {
                bytes: content.length,
                maxBytes: STATEMENT_EMAIL_MAX_BYTES,
            });
        }
        const mailed = await mailStatement(
            { ownerType: req.ownerType, ownerId: req.ownerId, from: req.from, to: req.to, fileName, contentType, content },
            context,
        );
        return {
            result: { delivery: 'email' as const, fileName, ...mailed },
            after: { bytes: content.length, rowCounts, recipient: mailed.recipient },
        };
    });
}
