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
    OrderDetailDto,
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

/**
 * The order detail, read through the PROJECTED path and mapped by the DTO — the single
 * function behind both the GET and the three delegated writes' responses.
 *
 * ── Why the writes answer through this and not through jovi-mall's reply ──────
 * jovi-mall echoes the whole Mongoose order document back from `cancel`,
 * `dispute/resolve` and `dispatch`: snake_case, and carrying `delivery_address.coordinates`
 * and `.raw_input` (a customer's home, and the text they typed before picking a geocoding
 * result), every `items[]` entry whole including `pickup_location.address_snapshot` (a
 * vendor's premises), plus `payment_intent_id` and `price_breakdown`. This service's own
 * read of the same order refuses exactly those fields twice over — once in
 * `ORDER_DETAIL_PROJECTION`, once in `toOrderDetailDto` — and **neither lock sits in the
 * path of a delegated write's response**. So the write handed back the PII the read
 * withholds (DATA-EXPOSURE-REGISTER § 6).
 *
 * Answering through *this* function rather than through a second mapper is the part worth
 * keeping: the write and the read cannot disagree, because there is nothing for them to
 * disagree in. A future field added to the DTO reaches all four surfaces or none.
 *
 * The re-read is the DETAIL projection, not `loadOr404`'s list one. Both exclude the
 * coordinates, but a list-projected document mapped by `toOrderDetailDto` would answer with
 * `items: []`, `priceBreakdown: null` and no address — a *different* shape from the GET,
 * which is the defect this step exists to close rather than a smaller version of it.
 *
 * ── Why this returns null rather than throwing ────────────────────────────────
 * The GET turns a null into its 404; a WRITE must not. By the time a write re-reads, its
 * mutation has committed in jovi-mall and its audit row is stamped — converting a completed
 * cancellation into `404 Order not found` would tell the client the opposite of what
 * happened and invite a retry. `orders` has no delete path in either service, so the null
 * branch is unreachable in practice; it answers `data: null` with the success message if it
 * ever is reached, which is the register's own "thin acknowledgement" fallback.
 */
async function readOrderDetail(orderId: string): Promise<OrderDetailDto | null> {
    const order = await orders.findDetailById(orderId);
    if (!order) return null;

    const names = await hydrateNames([order]);
    return toOrderDetailDto(order, names);
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
        const dto = await readOrderDetail(req.params.orderId);
        if (!dto) throw createAppError(ERROR_CODES.NOT_FOUND, 404, 'Order not found');

        sendSuccess(res, dto);
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

    /**
     * POST /api/v1/orders/:orderId/dispute/resolve
     *
     * Answers with the projected detail DTO, not jovi-mall's echoed document —
     * `readOrderDetail` carries the reasoning.
     */
    static resolveDispute = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as ResolveDisputeBody;
        const order = await loadOr404(req.params.orderId);

        await gateway.resolveDispute(
            req.params.orderId,
            body.outcome,
            toAuditState(order),
            actorContextOf(req),
        );

        const after = await readOrderDetail(req.params.orderId);
        sendSuccess(res, after, { message: `Dispute resolved as ${body.outcome}` });
    });

    /**
     * POST /api/v1/orders/:orderId/cancel
     *
     * Answers with the projected detail DTO, not jovi-mall's echoed document —
     * `readOrderDetail` carries the reasoning.
     */
    static cancel = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as CancelOrderBody;
        const order = await loadOr404(req.params.orderId);

        await gateway.cancel(
            req.params.orderId,
            body.reason,
            toAuditState(order),
            actorContextOf(req),
        );

        const after = await readOrderDetail(req.params.orderId);
        sendSuccess(res, after, { message: 'Order cancelled' });
    });

    /**
     * POST /api/v1/orders/:orderId/dispatch
     *
     * The odd one of the three: its response is `{ shipmentsAssigned, order }` and it keeps
     * that shape. Only the `order` half was the exposure, so only the `order` half is
     * projected. `shipmentsAssigned` stays because the dashboard branches on it, and `0` is
     * a **no-op, not an error** — the usual cause is the vendor's auto-redirect dispatching
     * a moment earlier.
     */
    static dispatch = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as DispatchOrderBody;
        const order = await loadOr404(req.params.orderId);

        const result = await gateway.dispatch(
            req.params.orderId,
            body.reason,
            toAuditState(order),
            actorContextOf(req),
        );

        const after = await readOrderDetail(req.params.orderId);
        sendSuccess(res, { shipmentsAssigned: result.shipmentsAssigned, order: after }, {
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
