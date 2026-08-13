import { z } from 'zod';
import { listQuery } from '../../../core/http/list-query';
import {
    boolFlag,
    dateRangeFields,
    dateRangeRule,
    idParam,
    objectId,
    reasonText,
    searchTerm,
} from '../../../core/validation/common.schemas';
import { AUDIT_ACTION_NAMES, AuditAction } from '../../audit/domain/audit.catalog';
import { AUDIT_STATUSES } from '../../audit/domain/audit.types';

/** Request shapes for `/api/v1/orders`. */

export const OrderIdParamSchema = idParam('orderId', 'order');

/**
 * A jovi-mall status token, bounded by FORMAT rather than by membership.
 *
 * ADR-005 D-17: pin a `z.enum` when the vocabulary is OURS, use a bounded string when it is
 * jovi-mall's. `payment_status` and `fulfillment_status` are jovi-mall's — it owns the two
 * state machines and adds to them without asking — so an unknown value here returns an
 * empty page rather than a 400 telling an administrator their own platform's status does
 * not exist.
 *
 * The character class is `[A-Za-z_]`, not `[a-z_]`, and that is not sloppiness: `orders`
 * really does store `'AWAITING_PAYMENT'` in SCREAMING_SNAKE beside `'pending'`,
 * `'partially_paid'` and the rest in snake_case. A lowercase-only bound would make the
 * platform's own value the one thing this filter could not express.
 */
export const platformStatus = z.string().trim().min(2).max(40).regex(/^[A-Za-z_]+$/, {
    message: 'Not a valid status token',
});

/** jovi-mall's `TimelineEventType` is dotted (`payment.updated`), so it needs its own bound. */
const platformEventType = z.string().trim().min(2).max(60).regex(/^[A-Za-z_.]+$/, {
    message: 'Not a valid timeline event type',
});

/**
 * jovi-mall's two status vocabularies, for documentation and DTO typing only.
 *
 * Deliberately NOT fed to `z.enum` — see `platformStatus`. They are here so a reader can
 * see what the platform emits without opening the other repository, and so the DTO can
 * name the type it carries.
 */
export const ORDER_PAYMENT_STATUSES = [
    'pending', 'AWAITING_PAYMENT', 'partially_paid', 'paid', 'disputed', 'failed', 'refunded',
] as const;

export const ORDER_FULFILLMENT_STATUSES = [
    'pending', 'processing', 'partially_shipped', 'shipped', 'partially_delivered',
    'delivered', 'fulfilled', 'cancelled', 'returned',
] as const;

/**
 * What the order list may be ordered by: **wire name → `jovi_mall` field path**.
 *
 * Every entry is backed by an index added in the same change (`order.model.ts` —
 * `{created_at: -1}`, `{payment_status: 1, created_at: -1}`,
 * `{fulfillment_status: 1, created_at: -1}`). Before them, the default order was a full
 * collection scan plus a blocking in-memory sort that a client could request by query
 * string.
 *
 * **`totalAmount` is deliberately absent.** There is no index on it, and adding one to a
 * collection this size to serve a "sort by value" nobody has asked for is the wrong trade.
 * `updated_at` is absent for the same reason.
 */
export const ORDER_SORT = { createdAt: 'created_at' } as const;

/** The dispute queue's own order. `disputed_at` is backed by the partial `dispute_queue` index. */
export const ORDER_DISPUTE_SORT = {
    disputedAt: 'dispute_hold.disputed_at',
    createdAt: 'created_at',
} as const;

/** The timeline is append-only and already scoped to one order — `{order_id, created_at}` backs it. */
export const ORDER_TIMELINE_SORT = { occurredAt: 'created_at' } as const;

export const ORDER_ACTIVITY_SORT = { occurredAt: 'occurred_at' } as const;

/** A year and a day, matching the vendor directory's window. */
export const ORDER_MAX_RANGE_DAYS = 366;

export const SearchOrdersQuerySchema = listQuery(ORDER_SORT, '-createdAt', {
    /** Order number prefix, or a 24-hex id of an order, customer, vendor or checkout group. */
    search: searchTerm.optional(),
    /**
     * Pinned as a `z.enum` where the statuses above are not, and the difference is real:
     * `order_type` is a closed two-value set that jovi-mall's own pre-save hook enforces
     * (a third value, `'service'`, is refused outright with `SERVICE_PRODUCTS_NOT_ALLOWED`).
     * A vocabulary that cannot grow is safe to pin.
     */
    orderType: z.enum(['physical', 'digital']).optional(),
    paymentMethod: z.enum(['online', 'cash_on_delivery']).optional(),
    paymentStatus: platformStatus.optional(),
    fulfillmentStatus: platformStatus.optional(),
    vendorId: objectId.optional(),
    customerId: objectId.optional(),
    /** Frozen by a payment dispute, or already flagged `disputed`. */
    disputed: boolFlag.optional(),
    /** The escrow gate — `completion.confirmed_at` set. Orthogonal to fulfilment. */
    completed: boolFlag.optional(),
    ...dateRangeFields(),
}).superRefine(dateRangeRule({ maxDays: ORDER_MAX_RANGE_DAYS }));

export const ListDisputedOrdersQuerySchema = listQuery(ORDER_DISPUTE_SORT, '-disputedAt', {
    ...dateRangeFields(),
}).superRefine(dateRangeRule({ maxDays: ORDER_MAX_RANGE_DAYS }));

export const ListOrderTimelineQuerySchema = listQuery(ORDER_TIMELINE_SORT, '-occurredAt', {
    /**
     * Pinned: `TimelineActorType` is a four-value union this service also WRITES against —
     * an admin cancellation stamps `'admin'` — so a filter naming a fifth value would be a
     * filter for a row nothing here produces.
     */
    actorType: z.enum(['vendor', 'customer', 'system', 'admin']).optional(),
    eventType: platformEventType.optional(),
});

/**
 * The audit-action filter, DERIVED from the catalog rather than retyped.
 *
 * The same rule `VENDOR_AUDIT_ACTIONS` follows: a hand-written list here would silently
 * stop offering an action the day one is added to the catalog.
 */
export const ORDER_AUDIT_ACTIONS = AUDIT_ACTION_NAMES.filter(
    (action) => action.startsWith('orders.'),
) as [AuditAction, ...AuditAction[]];

export const ListOrderActivityQuerySchema = listQuery(ORDER_ACTIVITY_SORT, '-occurredAt', {
    action: z.enum(ORDER_AUDIT_ACTIONS).optional(),
    status: z.enum(AUDIT_STATUSES).optional(),
    ...dateRangeFields(),
}).superRefine(dateRangeRule({ maxDays: ORDER_MAX_RANGE_DAYS }));

/**
 * `won | lost` IS pinned, and that is consistent with D-17 rather than an exception to it:
 * this is not a stored status, it is the argument to `adminResolveOrder`. The vocabulary is
 * this surface's, the type union and the wire must come from one source, and a third value
 * has nowhere to go.
 */
export const ResolveDisputeSchema = z.object({
    outcome: z.enum(['won', 'lost']),
}).strict();

export const CancelOrderSchema = z.object({
    reason: reasonText('A reason is required to cancel an order'),
}).strict();

export const DispatchOrderSchema = z.object({
    reason: z.string().trim().max(500).optional(),
}).strict();

export const RefundOrderSchema = z.object({
    /**
     * Absent means the full remaining refundable balance — NOT the vendor's policy cap.
     * An administrator asking to "refund this order" means the order.
     */
    amount: z.number().positive().max(1_000_000_000).optional(),
    reason: reasonText('A reason is required to refund an order'),
    /**
     * Acknowledges going beyond the VENDOR's commercial terms — the return window, the
     * refund percentage. It never waives a money invariant: an amount above the remaining
     * balance is refused by jovi-mall whatever this says.
     *
     * `boolFlag`, never `z.coerce.boolean()`: the latter turns the string `"false"` into
     * `true`, which on this particular field would silently override a vendor's policy.
     */
    overridePolicy: boolFlag.optional(),
}).strict();

export type OrderSearchQuery = z.infer<typeof SearchOrdersQuerySchema>;
export type ListDisputedOrdersQuery = z.infer<typeof ListDisputedOrdersQuerySchema>;
export type ListOrderTimelineQuery = z.infer<typeof ListOrderTimelineQuerySchema>;
export type ListOrderActivityQuery = z.infer<typeof ListOrderActivityQuerySchema>;
export type ResolveDisputeBody = z.infer<typeof ResolveDisputeSchema>;
export type CancelOrderBody = z.infer<typeof CancelOrderSchema>;
export type DispatchOrderBody = z.infer<typeof DispatchOrderSchema>;
export type RefundOrderBody = z.infer<typeof RefundOrderSchema>;
