import { Router } from 'express';
import { defineRoute, permission, records } from '../../../api/route-manifest';
import { OrderController } from '../controllers/order.controller';
import {
    CancelOrderSchema,
    DispatchOrderSchema,
    ListDisputedOrdersQuerySchema,
    ListOrderActivityQuerySchema,
    ListOrderTimelineQuerySchema,
    OrderIdParamSchema,
    RefundOrderSchema,
    ResolveDisputeSchema,
    SearchOrdersQuerySchema,
} from '../validators/order.validator';

/**
 * `/api/v1/orders` — order administration.
 *
 * PHASE-0 found TWO endpoints in this domain — the dispute queue and a manual dispute
 * resolution — and no way to look up an order at all. An administrator holding an order
 * number could do nothing with it. Eleven routes now cover it: the directory, the detail,
 * both histories, and the four interventions.
 *
 * ── Both halves of ADR-004 meet here ──────────────────────────────────────────
 * The directory, the detail, the timeline and the activity feed are **direct reads** —
 * records, with no invariant to protect. The four writes and the refund CEILING are
 * **delegated**, and the rule that separates them is ADR-008 D-1: *delegate a read whose
 * answer is a verdict the platform acts on; read directly a read whose answer is a record.*
 * "How much may be refunded, and whose policy does that break" is a verdict jovi-mall's own
 * refund pipeline branches on — a copy here would be a second definition of what a customer
 * is owed.
 *
 * ── Read and write hold different permissions ─────────────────────────────────
 * `orders.read` is a Support-tier lookup: answering a ticket about a missing parcel needs
 * it. The interventions are not. `orders.intervene` reaches tier 2 through
 * `allInFamily('orders')`, which Support's grant does not include; `orders.refund` and
 * `orders.disputes.resolve` are flagged `financial`, so `allInFamily` refuses to expand
 * them and a human had to type both into the tier-2 list by name.
 *
 * ── Route order ───────────────────────────────────────────────────────────────
 * **`/disputes` is a LITERAL sibling of `/:orderId` and MUST stay declared above it**, or
 * Express reads it as an order id and every request to the dispute queue 404s with "Order
 * not found". It is the one ordering hazard in this module. Any future literal sibling goes
 * above `/:orderId` too.
 */
const router = Router();
const mountedAt = '/orders';

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/',
    access: permission('orders.read'),
    validate: { query: SearchOrdersQuerySchema },
    handler: OrderController.search,
});

/** Literal — declared before `/:orderId`. See the header. */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/disputes',
    access: permission('orders.disputes.read'),
    validate: { query: ListDisputedOrdersQuerySchema },
    handler: OrderController.disputes,
});

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/:orderId',
    access: permission('orders.read'),
    validate: { params: OrderIdParamSchema },
    handler: OrderController.detail,
});

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/:orderId/timeline',
    access: permission('orders.read'),
    validate: { params: OrderIdParamSchema, query: ListOrderTimelineQuerySchema },
    handler: OrderController.timeline,
});

/**
 * Two permissions, `all` mode. The rows ARE audit rows and the repository applies the audit
 * read scope to them; requiring only `orders.read` would make this a second door onto the
 * trail. Same rule as `/vendors/:vendorId/activity`.
 */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/:orderId/activity',
    access: permission('orders.read', 'audit.read'),
    validate: { params: OrderIdParamSchema, query: ListOrderActivityQuerySchema },
    handler: OrderController.activity,
});

/** `orders.refund`, not `orders.read` — the answer is a ceiling on money, not a record. */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/:orderId/refund-eligibility',
    access: permission('orders.refund'),
    validate: { params: OrderIdParamSchema },
    handler: OrderController.refundEligibility,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/:orderId/dispute/resolve',
    access: permission('orders.disputes.resolve'),
    validate: { params: OrderIdParamSchema, body: ResolveDisputeSchema },
    audit: records('orders.disputes.resolve'),
    handler: OrderController.resolveDispute,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/:orderId/cancel',
    access: permission('orders.intervene'),
    validate: { params: OrderIdParamSchema, body: CancelOrderSchema },
    audit: records('orders.cancel'),
    handler: OrderController.cancel,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/:orderId/dispatch',
    access: permission('orders.intervene'),
    validate: { params: OrderIdParamSchema, body: DispatchOrderSchema },
    audit: records('orders.dispatch'),
    handler: OrderController.dispatch,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/:orderId/refund',
    access: permission('orders.refund'),
    validate: { params: OrderIdParamSchema, body: RefundOrderSchema },
    audit: records('orders.refund'),
    handler: OrderController.refund,
});

export const orderRoutes = router;
