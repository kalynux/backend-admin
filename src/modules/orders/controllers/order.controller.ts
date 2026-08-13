import { Request, Response } from 'express';
import { actorContextOf } from '../../audit/domain/audit-context';
import { ObjectId } from 'mongodb';
import { asyncHandler } from '../../../core/http/async-handler';
import { createAppError } from '../../../core/errors/app-error';
import { ERROR_CODES } from '../../../core/errors/error-codes';
import { toPageMeta } from '../../../core/http/list-query';
import { sendPaginated, sendSuccess } from '../../../core/http/responses';
import { requireAdminIdentity } from '../../admin-identity/domain/admin-identity.types';
import { toAuditEntryDto } from '../../audit/domain/audit.dto';
import { AuditRepository } from '../../audit/repositories/audit.repository';
import { ListAuditQuery } from '../../audit/validators/audit.validator';
import * as gateway from '../gateways/order.gateway';
import { OrderReadModel, OrderReadRepository, OrderSearchResolution } from '../repositories/order.read.repository';
import {
    CustomerRefReadRepository,
    OrderTimelineReadRepository,
    VendorRefReadRepository,
} from '../repositories/order-context.read.repository';
import {
    toOrderDetailDto,
    toOrderListItemDto,
    toOrderTimelineEntryDto,
} from '../read-models/order.dto';
import {
    CancelOrderBody,
    DispatchOrderBody,
    ListDisputedOrdersQuery,
    ListOrderActivityQuery,
    ListOrderTimelineQuery,
    OrderSearchQuery,
    RefundOrderBody,
    ResolveDisputeBody,
} from '../validators/order.validator';

const orders = new OrderReadRepository();
const timelines = new OrderTimelineReadRepository();
const customers = new CustomerRefReadRepository();
const vendors = new VendorRefReadRepository();
const audit = new AuditRepository();

/**
 * Load the order or 404.
 *
 * Reading before delegating costs one indexed lookup and buys the two things the gateway
 * cannot get from jovi-mall's answer: the previous state for the audit diff, and a 404 that
 * says "no such order" rather than a `PLATFORM_OPERATION_REJECTED` wrapping one.
 */
async function loadOr404(orderId: string): Promise<OrderReadModel> {
    const order = await orders.findById(orderId);
    if (!order) throw createAppError(ERROR_CODES.NOT_FOUND, 404, 'Order not found');
    return order;
}

/** The audit `before` — the fields this surface can change, and how to recognise the row. */
function toAuditState(order: OrderReadModel): Record<string, unknown> {
    return {
        orderNumber: order.order_number,
        paymentStatus: order.payment_status,
        fulfillmentStatus: order.fulfillment_status,
        disputeActive: order.dispute_hold?.active ?? false,
        totalAmount: order.total_amount,
        currency: order.currency,
    };
}

/** Vendor and customer display names for a page of orders, in two batched reads. */
async function hydrateNames(page: OrderReadModel[]) {
    const vendorIds = [...new Set(page.map((o) => o.vendor_id.toString()))].map((id) => new ObjectId(id));
    const customerIds = [...new Set(page.map((o) => o.customer_id.toString()))].map((id) => new ObjectId(id));

    const [vendor, customer] = await Promise.all([
        vendors.findNamesByIds(vendorIds),
        customers.findNamesByIds(customerIds),
    ]);
    return { vendor, customer };
}

export class OrderController {
    /**
     * GET /api/v1/orders — search and filter the platform's orders.
     *
     * ── Resolution first, then one indexed page ───────────────────────────────
     * A free-text term can name a customer or a vendor, neither of which lives on the
     * order. The obvious move is a `$lookup`; it is not taken, for the reason the vendor
     * directory records — a post-`$lookup` `$sort` cannot use an index and cannot carry the
     * `_id` tiebreaker that keeps skip/limit paging stable. So the term is resolved against
     * both collections FIRST (two capped, indexed queries), the order page is served from
     * its own index, and names are hydrated for the page afterwards.
     *
     * Those lookups are capped, and a cap that is hit is REPORTED — `searchMatchesTruncated`
     * in `meta`. A search for a common surname that silently returned the first two hundred
     * customers' orders would look complete and not be.
     */
    static search = asyncHandler(async (req: Request, res: Response) => {
        const query = req.query as unknown as OrderSearchQuery;

        // Only when a term is present: an unqualified list must not pay for two scans.
        let resolution: OrderSearchResolution = { customerIds: [], vendorIds: [], truncated: false };
        if (query.search) {
            const [customerMatch, vendorMatch] = await Promise.all([
                customers.findIdsMatching(query.search),
                vendors.findIdsMatching(query.search),
            ]);
            resolution = {
                customerIds: customerMatch.ids,
                vendorIds: vendorMatch.ids,
                truncated: customerMatch.truncated || vendorMatch.truncated,
            };
        }

        const page = await orders.search(query, resolution);
        const names = await hydrateNames(page.items);

        sendPaginated(
            res,
            page.items.map((order) => toOrderListItemDto(order, names)),
            {
                ...toPageMeta(page.total, page.page, page.limit),
                ...(resolution.truncated ? { searchMatchesTruncated: true } : {}),
            },
        );
    });

    /**
     * GET /api/v1/orders/disputes — the payment-dispute queue.
     *
     * Declared ABOVE `/:orderId` in the router, or `disputes` is read as an order id.
     */
    static disputes = asyncHandler(async (req: Request, res: Response) => {
        const query = req.query as unknown as ListDisputedOrdersQuery;

        const page = await orders.findDisputed(query);
        const names = await hydrateNames(page.items);

        sendPaginated(
            res,
            page.items.map((order) => toOrderListItemDto(order, names)),
            toPageMeta(page.total, page.page, page.limit),
        );
    });

    /** GET /api/v1/orders/:orderId */
    static detail = asyncHandler(async (req: Request, res: Response) => {
        const order = await orders.findDetailById(req.params.orderId);
        if (!order) throw createAppError(ERROR_CODES.NOT_FOUND, 404, 'Order not found');

        const names = await hydrateNames([order]);
        sendSuccess(res, toOrderDetailDto(order, names));
    });

    /**
     * GET /api/v1/orders/:orderId/timeline — jovi-mall's own order history.
     *
     * Deliberately NOT merged with `/activity`. This answers "what happened to this order"
     * and its actors are `vendor | customer | system | admin`; the activity feed answers
     * "what did ADMINISTRATORS do", lives in a different database reached by a different
     * MongoClient, and carries a different permission. They cannot be `$unionWith`-ed, and
     * a merged `total` would make `meta.pages` a lie the moment the two interleave.
     */
    static timeline = asyncHandler(async (req: Request, res: Response) => {
        const query = req.query as unknown as ListOrderTimelineQuery;
        await loadOr404(req.params.orderId);

        const page = await timelines.listForOrder(req.params.orderId, query);
        sendPaginated(
            res,
            page.items.map(toOrderTimelineEntryDto),
            toPageMeta(page.total, page.page, page.limit),
        );
    });

    /** GET /api/v1/orders/:orderId/activity — what administrators did to this order. */
    static activity = asyncHandler(async (req: Request, res: Response) => {
        const identity = requireAdminIdentity(req);
        const query = req.query as unknown as ListOrderActivityQuery;

        await loadOr404(req.params.orderId);

        const page = await audit.search(
            {
                page: query.page,
                limit: query.limit,
                sort: query.sort,
                action: query.action,
                status: query.status,
                from: query.from,
                to: query.to,
                // Fixed by the path — a caller cannot widen it.
                targetType: 'order',
                targetId: req.params.orderId,
            } as ListAuditQuery,
            identity,
        );

        sendPaginated(res, page.items.map(toAuditEntryDto), page.meta);
    });

    /**
     * GET /api/v1/orders/:orderId/refund-eligibility
     *
     * Gated on `orders.refund`, not `orders.read`: the answer is a ceiling on money leaving
     * the platform. Delegated rather than computed here — a copy of the refund arithmetic
     * in this service would be a second definition of what a customer is owed.
     */
    static refundEligibility = asyncHandler(async (req: Request, res: Response) => {
        await loadOr404(req.params.orderId);
        const eligibility = await gateway.refundEligibility(req.params.orderId, actorContextOf(req));
        sendSuccess(res, eligibility);
    });

    /** POST /api/v1/orders/:orderId/dispute/resolve */
    static resolveDispute = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as ResolveDisputeBody;
        const order = await loadOr404(req.params.orderId);

        const updated = await gateway.resolveDispute(
            req.params.orderId,
            body.outcome,
            toAuditState(order),
            actorContextOf(req),
        );

        sendSuccess(res, updated, { message: `Dispute resolved as ${body.outcome}` });
    });

    /** POST /api/v1/orders/:orderId/cancel */
    static cancel = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as CancelOrderBody;
        const order = await loadOr404(req.params.orderId);

        const updated = await gateway.cancel(
            req.params.orderId,
            body.reason,
            toAuditState(order),
            actorContextOf(req),
        );

        sendSuccess(res, updated, { message: 'Order cancelled' });
    });

    /** POST /api/v1/orders/:orderId/dispatch */
    static dispatch = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as DispatchOrderBody;
        const order = await loadOr404(req.params.orderId);

        const result = await gateway.dispatch(
            req.params.orderId,
            body.reason,
            toAuditState(order),
            actorContextOf(req),
        );

        sendSuccess(res, result, {
            message: result.shipmentsAssigned > 0
                ? `Dispatched ${result.shipmentsAssigned} shipment(s) to the delivery agency`
                : 'Nothing to dispatch — no shipment on this order was pending',
        });
    });

    /**
     * POST /api/v1/orders/:orderId/refund
     *
     * `overridePolicy` waives the VENDOR's commercial terms — the return window, the refund
     * percentage — and nothing else. Every money invariant is jovi-mall's and refuses
     * regardless. Without the flag, a refund beyond those terms is a 422 carrying exactly
     * which gates it would cross, so an operator confirms a specific override rather than a
     * general one.
     */
    static refund = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as RefundOrderBody;
        const order = await loadOr404(req.params.orderId);

        const result = await gateway.refund(
            req.params.orderId,
            { amount: body.amount, reason: body.reason, overridePolicy: body.overridePolicy },
            toAuditState(order),
            actorContextOf(req),
        );

        sendSuccess(res, result, {
            message: result.withinVendorPolicy
                ? 'Refund completed'
                : 'Refund completed — the vendor’s return policy was overridden',
        });
    });
}
