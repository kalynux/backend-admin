import { Document, Filter, ObjectId } from 'mongodb';
import { Types } from 'mongoose';
import { toMongoSort } from '../../../core/data/mongo-list';
import { ListQueryBase } from '../../../core/http/list-query';
import { COLLECTIONS } from '../../../infra/platform/collections';
import { Paginated, PlatformReadRepository } from '../../../infra/platform/platform.repository';
import { PAYMENT_SORT, REFUND_SORT } from '../validators/money.validator';

/**
 * Gateway settlements: what a customer actually paid, and what came back.
 *
 * Both collections had **no admin surface at all**. `payment_transactions` is the amount
 * snapshot every refund is validated against, and `refund_transactions` the record of what
 * was returned — and an administrator asked "did this payment go through" had to open the
 * order and infer it from `payment_status`, which is a derived column rather than the
 * gateway's own answer.
 *
 * Direct reads, both. A settlement row is a record in the strongest sense on this surface:
 * written by the gateway orchestrator, finalised atomically with the source it settles, and
 * never revised. Nothing here protects an invariant a second reader could disturb.
 *
 * ── THREE FIELDS ARE BANNED, and none of them is a payment credential ─────────
 * That is what makes them easy to project by accident.
 *
 *   `rawGatewayPayloads`   the provider's own JSON — payer phone, email, card metadata,
 *                          provider identifiers — with **no schema bounding what a gateway
 *                          put there**. Unbounded third-party content cannot be whitelisted
 *                          field by field, which is exactly the argument ADR-009 D-8 made
 *                          for `agent_membership_events.metadata`.
 *   `gatewayPayloadHash`   webhook-verification material. Disclosing it moves an attacker
 *                          measurably closer to forging a settlement callback — the one
 *                          input that makes this service believe money arrived.
 *   `idempotencyKey`       dedup material. Knowing it lets a caller suppress or collide a
 *                          legitimate write.
 *
 * None of the three is projected below, and `test-money.ts` scans this module's source for
 * all three names. The `netAmount` virtual is not projected either — it is a Mongoose
 * virtual, so the raw driver would never return it, and the DTO computes it from the two
 * fields it does have.
 *
 * ── camelCase, and it is not a mistake ────────────────────────────────────────
 * `payment_transactions` and `refund_transactions` store camelCase field names. They
 * predate the platform's snake_case convention and were never migrated. Every projection,
 * filter and sort path in this file is therefore camelCase while every other repository in
 * the module is snake_case; that asymmetry is the database's, not this file's.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Payments
// ─────────────────────────────────────────────────────────────────────────────

export interface PaymentTransactionReadModel extends Document {
    _id: ObjectId;
    /** Exactly one of these three is set. `cartId` means one payment settled N orders. */
    orderId?: ObjectId | null;
    bookingId?: ObjectId | null;
    cartId?: ObjectId | null;
    orderIds?: ObjectId[] | null;
    /** `primary` or `booking_balance` — a booking can be paid twice. */
    purpose?: string;
    /**
     * The payer — but NOT one kind of id. An order or cart payment stores a CUSTOMER id;
     * a booking payment stores a USER id. Which one a row carries depends on how it was
     * created, and nothing on the row says which.
     */
    userId: ObjectId;
    gateway: string;
    method: string;
    /** The gateway's own transaction reference — the string quoted in a dispute. */
    gatewayRef: string;
    status: string;
    /** The amount AT PAYMENT TIME. Never re-read off the order — that is the whole point. */
    amountSnapshot: number;
    currencySnapshot: string;
    totalRefunded?: number;
    hasPartialRefund?: boolean;
    createdAt: Date;
    updatedAt: Date;
}

const PAYMENT_TRANSACTION_PROJECTION = {
    _id: 1,
    orderId: 1,
    bookingId: 1,
    cartId: 1,
    orderIds: 1,
    purpose: 1,
    userId: 1,
    gateway: 1,
    method: 1,
    gatewayRef: 1,
    status: 1,
    amountSnapshot: 1,
    currencySnapshot: 1,
    totalRefunded: 1,
    hasPartialRefund: 1,
    createdAt: 1,
    updatedAt: 1,
} as const;

export interface PaymentSearchQuery extends ListQueryBase {
    status?: string;
    gateway?: string;
    method?: string;
    purpose?: string;
    orderId?: string;
    bookingId?: string;
    userId?: string;
    from?: Date;
    to?: Date;
}

export class PaymentTransactionReadRepository extends PlatformReadRepository<PaymentTransactionReadModel> {
    constructor() {
        super(COLLECTIONS.PAYMENT_TRANSACTION, PAYMENT_TRANSACTION_PROJECTION);
    }

    async search(query: PaymentSearchQuery): Promise<Paginated<PaymentTransactionReadModel>> {
        return this.findPage(buildPaymentFilter(query), {
            page: query.page,
            limit: query.limit,
            sort: toMongoSort(query.sort, PAYMENT_SORT),
        });
    }

    async findById(transactionId: string): Promise<PaymentTransactionReadModel | null> {
        if (!Types.ObjectId.isValid(transactionId)) return null;
        return this.findOneBy({ _id: new ObjectId(transactionId) } as Filter<PaymentTransactionReadModel>);
    }
}

/**
 * Pure, and exported so `test-money.ts` can assert every branch without a database.
 *
 * `orderId` matches **either linkage**, and that is the branch worth reading twice. A
 * single-order payment sets `orderId`; a cart checkout writes ONE payment for N orders and
 * sets `orderIds` while leaving `orderId` unset — which is the majority of orders on the
 * platform. A filter on `orderId` alone would answer "no payment" for most of them, and
 * `payment_transactions` carries `{orderIds: 1, status: 1}` precisely because the refund
 * path already learned this.
 */
export function buildPaymentFilter(query: PaymentSearchQuery): Filter<PaymentTransactionReadModel> {
    const clauses: Record<string, unknown>[] = [];

    if (query.status) clauses.push({ status: query.status });
    if (query.gateway) clauses.push({ gateway: query.gateway });
    if (query.method) clauses.push({ method: query.method });
    if (query.purpose) clauses.push({ purpose: query.purpose });

    if (query.orderId) {
        const id = toObjectIdOrNothing(query.orderId);
        clauses.push({ $or: [{ orderId: id }, { orderIds: id }] });
    }

    if (query.bookingId) clauses.push({ bookingId: toObjectIdOrNothing(query.bookingId) });
    if (query.userId) clauses.push({ userId: toObjectIdOrNothing(query.userId) });

    const range = dateRange(query.from, query.to);
    if (range) clauses.push({ createdAt: range });

    if (clauses.length === 0) return {} as Filter<PaymentTransactionReadModel>;
    if (clauses.length === 1) return clauses[0] as Filter<PaymentTransactionReadModel>;

    // `$and`, not `Object.assign` — the order clause is an `$or`, and merging two
    // `$or`-shaped filters by assignment silently drops the earlier one.
    return { $and: clauses } as Filter<PaymentTransactionReadModel>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Refunds
// ─────────────────────────────────────────────────────────────────────────────

export interface RefundTransactionReadModel extends Document {
    _id: ObjectId;
    paymentTransactionId: ObjectId;
    orderId?: ObjectId | null;
    bookingId?: ObjectId | null;
    vendorId: ObjectId;
    userId: ObjectId;
    refundAmount: number;
    currency: string;
    reason?: string | null;
    status: string;
    gateway: string;
    gatewayRefundRef?: string | null;
    initiatedBy: ObjectId;
    /** `vendor` · `admin` · `customer` — who asked for it, not who approved it. */
    initiatedByRole: string;
    createdAt: Date;
    /** Stamped when the money actually went back. Analytics group by THIS, not creation. */
    completedAt?: Date | null;
}

const REFUND_TRANSACTION_PROJECTION = {
    _id: 1,
    paymentTransactionId: 1,
    orderId: 1,
    bookingId: 1,
    vendorId: 1,
    userId: 1,
    refundAmount: 1,
    currency: 1,
    reason: 1,
    status: 1,
    gateway: 1,
    gatewayRefundRef: 1,
    initiatedBy: 1,
    initiatedByRole: 1,
    createdAt: 1,
    completedAt: 1,
} as const;

export interface RefundSearchQuery extends ListQueryBase {
    status?: string;
    gateway?: string;
    vendorId?: string;
    orderId?: string;
    bookingId?: string;
    paymentTransactionId?: string;
    from?: Date;
    to?: Date;
}

export class RefundTransactionReadRepository extends PlatformReadRepository<RefundTransactionReadModel> {
    constructor() {
        super(COLLECTIONS.REFUND_TRANSACTION, REFUND_TRANSACTION_PROJECTION);
    }

    async search(query: RefundSearchQuery): Promise<Paginated<RefundTransactionReadModel>> {
        return this.findPage(buildRefundFilter(query), {
            page: query.page,
            limit: query.limit,
            sort: toMongoSort(query.sort, REFUND_SORT),
        });
    }

    /**
     * The refunds against one payment — the detail view's other half.
     *
     * `totalRefunded` on the payment says how much came back; these rows say when, through
     * which gateway and at whose request. Bounded rather than paged: a payment accumulates
     * a handful of partial refunds, not a feed.
     */
    async findForPayment(paymentTransactionId: string): Promise<RefundTransactionReadModel[]> {
        if (!Types.ObjectId.isValid(paymentTransactionId)) return [];
        return this.findBy(
            {
                paymentTransactionId: new ObjectId(paymentTransactionId),
            } as Filter<RefundTransactionReadModel>,
            { sort: { createdAt: 1, _id: 1 }, limit: 50 },
        );
    }
}

/** Pure, and exported so `test-money.ts` can assert every branch without a database. */
export function buildRefundFilter(query: RefundSearchQuery): Filter<RefundTransactionReadModel> {
    const clauses: Record<string, unknown>[] = [];

    if (query.status) clauses.push({ status: query.status });
    if (query.gateway) clauses.push({ gateway: query.gateway });
    if (query.vendorId) clauses.push({ vendorId: toObjectIdOrNothing(query.vendorId) });
    if (query.orderId) clauses.push({ orderId: toObjectIdOrNothing(query.orderId) });
    if (query.bookingId) clauses.push({ bookingId: toObjectIdOrNothing(query.bookingId) });
    if (query.paymentTransactionId) {
        clauses.push({ paymentTransactionId: toObjectIdOrNothing(query.paymentTransactionId) });
    }

    /**
     * Ranged on `createdAt`, not `completedAt` — deliberately, and against the collection's
     * own analytics convention.
     *
     * `completedAt` is unset on a `pending` and on a `failed` refund, so ranging on it
     * would silently drop exactly the rows an administrator is looking for when they open
     * this list: the ones that have not landed. `?sort=-completedAt` is available for the
     * analytics reading; the window is always about when somebody asked.
     */
    const range = dateRange(query.from, query.to);
    if (range) clauses.push({ createdAt: range });

    if (clauses.length === 0) return {} as Filter<RefundTransactionReadModel>;
    if (clauses.length === 1) return clauses[0] as Filter<RefundTransactionReadModel>;

    return { $and: clauses } as Filter<RefundTransactionReadModel>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared
// ─────────────────────────────────────────────────────────────────────────────

/** Half-open `[from, to)`, matching `dateRangeFields`. `null` when neither side was given. */
function dateRange(from?: Date, to?: Date): Record<string, Date> | null {
    if (!from && !to) return null;
    const range: Record<string, Date> = {};
    if (from) range.$gte = from;
    if (to) range.$lt = to;
    return range;
}

/** A malformed id becomes a term that matches nothing, rather than a thrown BSONError. */
function toObjectIdOrNothing(value: string): ObjectId | { $in: [] } {
    return Types.ObjectId.isValid(value) && value.length === 24
        ? new ObjectId(value)
        : { $in: [] };
}
