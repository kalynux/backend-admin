import { Router } from 'express';
import { defineRoute, dynamicAudit, permission, records, selfService } from '../../../api/route-manifest';
import { ApprovalController } from '../controllers/approval.controller';
import {
    ApprovalIdParamSchema,
    DecisionBodySchema,
    ListApprovalsQuerySchema,
} from '../validators/approval.validator';

/**
 * `/api/v1/approvals` — actions waiting for a second administrator.
 *
 * ── Why approve/reject carry no permission of their own ───────────────────────
 * There is no `approvals.approve` permission, deliberately. The approver must hold the
 * permission the PENDING ACTION names — `approval.service.ts` reads it from the catalog's
 * `dualControl.approverPermission` and checks it per request.
 *
 * A single "may approve things" permission would be strictly worse: it would let someone
 * commit an action they could not have performed themselves, which turns four eyes from
 * a second signature into an escalation path. The access declared here is `selfService`
 * because the real check is dynamic and cannot be a static route declaration.
 */
const router = Router();
const mountedAt = '/approvals';

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/',
    access: permission('approvals.read'),
    validate: { query: ListApprovalsQuerySchema },
    handler: ApprovalController.list,
});

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/:approvalId',
    access: permission('approvals.read'),
    validate: { params: ApprovalIdParamSchema },
    handler: ApprovalController.get,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/:approvalId/approve',
    // Authorized dynamically against the pending action's own permission — see above.
    access: selfService('The approver must hold the permission the pending action names, checked per request'),
    validate: { params: ApprovalIdParamSchema, body: DecisionBodySchema },
    audit: dynamicAudit('performs whatever was queued — the row names the queued action, plus approvals.approved for the decision', ['approvals.approved']),
    handler: ApprovalController.approve,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/:approvalId/reject',
    access: selfService('The rejecter must hold the pending action’s permission, or be its requester'),
    validate: { params: ApprovalIdParamSchema, body: DecisionBodySchema },
    audit: records('approvals.rejected'),
    handler: ApprovalController.reject,
});

defineRoute(router, {
    mountedAt,
    method: 'delete',
    path: '/:approvalId',
    access: selfService('Withdrawing is scoped to the caller’s own requests'),
    validate: { params: ApprovalIdParamSchema },
    audit: records('approvals.withdrawn'),
    handler: ApprovalController.withdraw,
});

export const approvalRoutes = router;
