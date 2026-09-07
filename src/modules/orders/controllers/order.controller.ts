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
    OrderTimelineReadModel,
    OrderTimelineReadRepository,
    VendorRefReadRepository,
} from '../repositories/order-context.read.repository';
import { AdminAccountRepository } from '../../admin-identity/repositories/admin-account.repository';
import { AgencyReadRepository } from '../../agencies/repositories/agency.read.repository';
import { ShipmentReadRepository } from '../../shipments/repositories/shipment.read.repository';
import {
    ProductImageRef,
    ProductMediaReadRepository,
} from '../../vendors/repositories/product-media.read.repository';
import { StoreReadRepository } from '../../vendors/repositories/store.read.repository';
import {
    OrderDetailDto,
    OrderItemContext,
    TimelineActorNames,
    timelineActorKey,
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
 * The four reads an order DETAIL needs from other modules, each owned by the module that
 * owns its collection — the direction `shipment.controller.ts` already takes for agency and
 * agent names, and for the same reason: a second projection of somebody else's collection
 * declared next door is a second thing to get right.
 *
 * `admins` is the odd one and is the point of BR-016 § 5: it reads **wi-admin's own
 * database**, because an `admin` timeline row's actor id is an `admin_accounts._id` that
 * resolves to nothing in `jovi_mall`.
 */
const agencies = new AgencyReadRepository();
const shipments = new ShipmentReadRepository();
const stores = new StoreReadRepository();
const productMedia = new ProductMediaReadRepository();
const admins = new AdminAccountRepository();

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

    const [names, itemContext] = await Promise.all([
        hydrateNames([order]),
        hydrateItemContext(order),
    ]);
    return toOrderDetailDto(order, names, itemContext);
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

/** Distinct, valid ObjectIds from a column that may be absent on some rows. */
function toIds(values: (string | null | undefined)[]): ObjectId[] {
    const seen = new Set<string>();
    for (const value of values) {
        if (value && ObjectId.isValid(value) && value.length === 24) seen.add(value);
    }
    return [...seen].map((id) => new ObjectId(id));
}

/**
 * The three per-item decorations, resolved for the WHOLE items array in three reads
 * (BR-016 § 4, BR-017 A).
 *
 * ── Why this is on the detail and not the list ────────────────────────────────
 * `ORDER_LIST_PROJECTION` carries `items._id` and nothing else — a hundred-row page has no
 * items to decorate. The detail is one order, so the cost is three round trips on one screen
 * however many lines it has, which is the whole argument BR-017 was granted on: the client's
 * alternative was one delegated product read per distinct product on the page.
 *
 * The tracking numbers come from `findForOrder`, which reads the ORDER's shipments in one
 * indexed query rather than fetching each `delivery.shipment_id` separately. That method had
 * no caller until now, and its docstring already described the block this builds.
 */
async function hydrateItemContext(order: OrderReadModel): Promise<OrderItemContext> {
    const items = order.items ?? [];

    const agencyIds = toIds(items.map((item) => item.delivery?.agency_id?.toString()));
    const imageRefs: ProductImageRef[] = items.map((item) => ({
        productId: item.product_id ? item.product_id.toString() : null,
        variantId: item.variant_id ? item.variant_id.toString() : null,
    }));

    const [agencyName, orderShipments, image] = await Promise.all([
        agencies.findBusinessNamesByIds(agencyIds),
        // Unconditional: an order with no fulfilled item answers an empty array, and the
        // alternative — skipping the read when no item names a shipment — would still cost a
        // scan of the items array to decide.
        shipments.findForOrder(order._id.toString()),
        productMedia.primaryImages(imageRefs),
    ]);

    return {
        agencyName,
        trackingNumber: new Map(
            orderShipments.map((shipment) => [
                shipment._id.toString(),
                shipment.tracking_number ?? null,
            ]),
        ),
        image,
    };
}

/**
 * Who each timeline actor is (BR-016 § 5) — three batched reads across **two databases**.
 *
 * ── The four types, and where each one resolves ───────────────────────────────
 * | `actorType` | The id is | Resolved in |
 * |---|---|---|
 * | `admin`    | a wi-admin `admin_accounts._id` | **this service's own database, no hop** |
 * | `vendor`   | a `vendors._id`                 | `jovi_mall.stores`, by `vendor_id` |
 * | `customer` | a `customers._id`               | `jovi_mall.customers` |
 * | `system`   | always absent                   | — (`null`) |
 *
 * The first row is the one that could not be done anywhere else and is why this exists:
 * jovi-mall's admin-caller middleware stamps `X-Actor-Id` into `actor_id`, a column declared
 * `ref: MODELS.USER`, where it dereferences to nothing. "Which of us did this" is the
 * question an order timeline is opened for, and the platform database cannot answer it.
 *
 * The `vendor` row resolves to the **Store's** business name, matching jovi-mall's own
 * `_resolveActorNames` on the vendor-facing timeline — so the two surfaces name the same
 * vendor the same way. `vendors.display_name` is a person and is not used here.
 *
 * ⚠ `actor_id` is NOT a user id for any of the three, whatever
 * `order-timeline.model.ts`'s "User ID if applicable" comment claims. Verified against the
 * three writers (`vendor-order.service.ts` passes `vendorId`,
 * `customer-order.controller.ts` passes `customerId`, `admin-order.controller.ts` passes
 * `adminCallerActor(req).id`).
 */
async function hydrateTimelineActors(entries: OrderTimelineReadModel[]): Promise<TimelineActorNames> {
    const idsOf = (actorType: string) =>
        entries
            .filter((entry) => entry.actor_type === actorType && entry.actor_id)
            .map((entry) => entry.actor_id!.toString());

    const adminIds = [...new Set(idsOf('admin'))];
    const vendorIds = toIds(idsOf('vendor'));
    const customerIds = toIds(idsOf('customer'));

    const [adminNames, vendorNames, customerNames] = await Promise.all([
        adminIds.length > 0 ? admins.findDisplayNamesByIds(adminIds) : Promise.resolve(new Map()),
        stores.findNamesByVendorIds(vendorIds),
        customers.findNamesByIds(customerIds),
    ]);

    const resolved: TimelineActorNames = new Map();
    // Keyed on `${actorType}:${id}` rather than the bare id: three id spaces share one map,
    // and a bare key would let a collision print the wrong person's name.
    for (const [id, name] of adminNames) resolved.set(timelineActorKey('admin', id), name);
    for (const [id, name] of vendorNames) resolved.set(timelineActorKey('vendor', id), name);
    for (const [id, name] of customerNames) resolved.set(timelineActorKey('customer', id), name);
    return resolved;
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
     * ── `actorName` beside `actorId` (BR-016 § 5) ─────────────────────────────
     * "Which of us did this" is the question this feed is opened for, and until now it
     * answered with a 24-hex id and a role. `hydrateTimelineActors` resolves the page in
     * three batched reads across two databases — see its header for which type resolves
     * where, and why the `admin` one could not have been done anywhere else.
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
        const actorNames = await hydrateTimelineActors(page.items);

        sendPaginated(
            res,
            page.items.map((entry) => toOrderTimelineEntryDto(entry, actorNames)),
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
