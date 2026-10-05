import { Router } from 'express';
import { defineRoute, permission, records } from '../../../api/route-manifest';
import { RefundController } from '../controllers/refund.controller';
/**
 * Imported for SIDE EFFECT, and load-bearing: `refund-actions.ts` registers the `orders.refund`
 * dual-control handler at module scope, and `createApp()` refuses to boot while a dual-controlled
 * action has none. The controller imports it too; this line states the dependency where a
 * refactor would see it (the `money.routes.ts` precedent).
 */
import '../domain/refund-actions';
import {
    ApproveRefundSchema,
    CreateRefundRequestSchema,
    ListRefundActivityQuerySchema,
    ListRefundRequestsQuerySchema,
    ProofFileIdParamSchema,
    RefundEligibilityQuerySchema,
    RefundIdParamSchema,
    RejectRefundSchema,
    ResolveUnknownRefundSchema,
    RetryRefundSchema,
    SettleExternalRefundSchema,
} from '../validators/refund.validator';

/**
 * `/api/v1/refunds` — the refund queue Support and administrators work (REFUND-FLOW-PLAN § 7).
 *
 *   read    `orders.refund.read`        tiers 1, 2, 3   list · detail · proof bytes (audited)
 *   raise   `orders.refund.request`     tiers 1, 2, 3   eligibility · create · proof upload
 *                                                       (financial: opening one HOLDS earnings)
 *   decide  `orders.refund`             tiers 1, 2      approve (four-eyes ≥ 2,000,000) · reject
 *                                                       · retry · resolve-unknown
 *   settle  `orders.refund.settle_external` tiers 1, 2  paid outside the platform, with proof
 *
 * ── Route order ──────────────────────────────────────────────────────────────
 * `/eligibility` and `/proofs/...` are LITERALS and are declared above `/:refundId`, or Express
 * reads them as an id and answers "not a valid refund request id". Any future literal goes above
 * it too. Everything below `/:refundId` differs in depth or verb, so nothing else shadows.
 */
const router = Router();
const mountedAt = '/refunds';

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/',
    access: permission('orders.refund.read'),
    validate: { query: ListRefundRequestsQuerySchema },
    handler: RefundController.list,
});

/** Literal — above `/:refundId`. `orders.refund.request`: it is the form behind raising one. */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/eligibility',
    access: permission('orders.refund.request'),
    validate: { query: RefundEligibilityQuerySchema },
    handler: RefundController.eligibility,
});

/**
 * Upload a proof picture to the PRIVATE `refund-proofs` tree — never `/files/upload`, whose
 * trees are public. Held by whoever may raise a request (a typed number needs its proof) —
 * settling externally needs one too, and every holder of `settle_external` holds this.
 */
defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/proofs',
    access: permission('orders.refund.request'),
    audit: records('orders.refund.proof.upload'),
    handler: RefundController.uploadProof,
});

/** Opening a proof is a disclosure: audited fail-closed on every read. */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/proofs/:fileId',
    access: permission('orders.refund.read'),
    validate: { params: ProofFileIdParamSchema },
    audit: records('orders.refund.proof.read'),
    handler: RefundController.openProof,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/',
    access: permission('orders.refund.request'),
    validate: { body: CreateRefundRequestSchema },
    audit: records('orders.refund.request'),
    handler: RefundController.create,
});

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/:refundId',
    access: permission('orders.refund.read'),
    validate: { params: RefundIdParamSchema },
    handler: RefundController.detail,
});

/** Two permissions, `all` mode: these rows ARE audit rows (the `/payouts/:id/activity` rule). */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/:refundId/activity',
    access: permission('orders.refund.read', 'audit.read'),
    validate: { params: RefundIdParamSchema, query: ListRefundActivityQuerySchema },
    handler: RefundController.activity,
});

/**
 * Approve — **202** with a pending approval at or above 2,000,000 (the amount off the ROW), else
 * 200. A TYPED destination is refused to the administrator who typed it (R-7), at any amount.
 */
defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/:refundId/approve',
    access: permission('orders.refund'),
    validate: { params: RefundIdParamSchema, body: ApproveRefundSchema },
    audit: records('orders.refund.approve'),
    handler: RefundController.approve,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/:refundId/reject',
    access: permission('orders.refund'),
    validate: { params: RefundIdParamSchema, body: RejectRefundSchema },
    audit: records('orders.refund.reject'),
    handler: RefundController.reject,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/:refundId/retry',
    access: permission('orders.refund'),
    validate: { params: RefundIdParamSchema, body: RetryRefundSchema },
    audit: records('orders.refund.retry'),
    handler: RefundController.retry,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/:refundId/settle-external',
    access: permission('orders.refund.settle_external'),
    validate: { params: RefundIdParamSchema, body: SettleExternalRefundSchema },
    audit: records('orders.refund.settle_external'),
    handler: RefundController.settleExternal,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/:refundId/resolve-unknown',
    access: permission('orders.refund'),
    validate: { params: RefundIdParamSchema, body: ResolveUnknownRefundSchema },
    audit: records('orders.refund.resolve_unknown'),
    handler: RefundController.resolveUnknown,
});

export const refundRoutes = router;
