import { Request, Response } from 'express';
import { requestContext } from '../../audit/domain/audit-context';
import { asyncHandler } from '../../../core/http/async-handler';
import { toPageMeta } from '../../../core/http/list-query';
import { sendPaginated, sendSuccess } from '../../../core/http/responses';
import { requireAdminIdentity } from '../../admin-identity/domain/admin-identity.types';
import * as approvals from '../domain/approval.service';
import { ApprovalStatus } from '../models/approval-request.model';
import { DecisionBody, ListApprovalsQuery } from '../validators/approval.validator';

/**
 * `/api/v1/approvals` — the four-eyes queue.
 *
 * Thin: every rule about who may approve what lives in `approval.service.ts`, because the
 * same rules must hold whether the decision arrives through this controller or through
 * anything added later.
 */

export class ApprovalController {
    /** GET /api/v1/approvals */
    static list = asyncHandler(async (req: Request, res: Response) => {
        const query = req.query as unknown as ListApprovalsQuery;

        const { items, total } = await approvals.listApprovals({
            status: query.status as ApprovalStatus,
            action: query.action,
            targetId: query.targetId,
            page: query.page,
            limit: query.limit,
        });

        sendPaginated(res, items, toPageMeta(total, query.page, query.limit));
    });

    /** GET /api/v1/approvals/:approvalId */
    static get = asyncHandler(async (req: Request, res: Response) => {
        sendSuccess(res, await approvals.getApproval(req.params.approvalId));
    });

    /**
     * POST /api/v1/approvals/:approvalId/approve
     *
     * Approving PERFORMS the action — see the registry's header. A 200 here means the
     * promotion happened, not that it was scheduled.
     */
    static approve = asyncHandler(async (req: Request, res: Response) => {
        const identity = requireAdminIdentity(req);
        const body = req.body as DecisionBody;

        const approval = await approvals.approve(
            req.params.approvalId,
            identity,
            body.note ?? null,
            requestContext(req),
        );

        sendSuccess(res, approval, { message: 'Approved and performed' });
    });

    /** POST /api/v1/approvals/:approvalId/reject */
    static reject = asyncHandler(async (req: Request, res: Response) => {
        const identity = requireAdminIdentity(req);
        const body = req.body as DecisionBody;

        sendSuccess(
            res,
            await approvals.reject(req.params.approvalId, identity, body.note ?? null, requestContext(req)),
            { message: 'Rejected' },
        );
    });

    /** DELETE /api/v1/approvals/:approvalId — the requester takes their own request back. */
    static withdraw = asyncHandler(async (req: Request, res: Response) => {
        const identity = requireAdminIdentity(req);
        sendSuccess(
            res,
            await approvals.withdraw(req.params.approvalId, identity, requestContext(req)),
            { message: 'Withdrawn' },
        );
    });
}
