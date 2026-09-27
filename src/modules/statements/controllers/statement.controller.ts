import { Request, Response } from 'express';
import { asyncHandler } from '../../../core/http/async-handler';
import { sendSuccess } from '../../../core/http/responses';
import { actorContextOf } from '../../audit/domain/audit-context';
import { produceStatement } from '../domain/statement.service';
import { StatementOwnerType } from '../domain/statement.types';
import { CreateStatementBody } from '../validators/statement.validator';

export class StatementController {
    /**
     * POST /api/v1/accounts/:ownerType/:ownerId/statements
     *
     * `delivery: 'download'` answers the FILE itself, not a JSON envelope — the same exception
     * the audit export's download makes (ADR-005 D-8), because the payload is a file.
     * `delivery: 'email'` answers `{ delivery, fileName, sent, recipient (masked), bytes }`.
     */
    static create = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as CreateStatementBody;
        const outcome = await produceStatement(
            {
                ownerType: req.params.ownerType as StatementOwnerType,
                ownerId: req.params.ownerId,
                ...body,
            },
            actorContextOf(req),
        );

        if (outcome.delivery === 'download') {
            res.setHeader('Content-Type', outcome.contentType);
            res.setHeader('Content-Disposition', `attachment; filename="${outcome.fileName}"`);
            res.setHeader('Content-Length', String(outcome.content.length));
            res.setHeader('Cache-Control', 'no-store');
            res.status(200).end(outcome.content);
            return;
        }
        sendSuccess(res, outcome);
    });
}
