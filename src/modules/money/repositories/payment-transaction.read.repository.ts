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
    /**
     * Which aggregator carried this money. INFORMATIONAL (jovi-mall ADR-A08): an open string —
     * Campay and Flutterwave are coming — and nothing here may branch on it.
     */
    gateway: string;
    /**
     * What the customer paid WITH — `MTN` · `ORANGE` · `MOOV` · `CARD` (ADR-A08 layer 1). Null on
     * every row written before payment routing; no backfill.
     */
    provider?: string | null;
    method: string;
    /** The gateway's own transaction reference — the string quoted in a dispute. */
    gatewayRef: string;
    /**
     * OUR reference, minted per attempt and echoed back by the gateway on its callback
     * (NotchPay `reference`, My-CoolPay `app_transaction_ref`, Stripe `metadata.merchantRef`).
     *
     * `jm_pt_<32 hex>` on a payment transaction. Null on every row written before the field
     * existed, and on any row whose gateway never echoed one back.
     *
     * Projected, unlike `idempotencyKey` and `gatewayPayloadHash` beside it, and the
     * difference is what each one is FOR. Those two are verification and dedup material — a
     * caller who learns them moves closer to forging or suppressing a settlement. This is a
     * routing label the provider already holds, that appears on the customer's own record,
     * and that Support is asked to trace when a payment and an order disagree.
     */
    merchantRef?: string | null;
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
    provider: 1,
    method: 1,
    gatewayRef: 1,
    merchantRef: 1,
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
    /** A gateway reference or a merchant reference, matched exactly against either. */
    reference?: string;
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

    /**
     * The reference lookup — one term, both references.
     *
     * A person holding a reference does not know which KIND they are holding: a customer
     * reads ours off their receipt, a provider's dispute email quotes theirs, and the two
     * are indistinguishable to the person pasting one into a search box. Asking which is a
     * question only this codebase can answer, so the filter answers it instead.
     *
     * Exact equality, never a regex. Both fields carry an index in jovi-mall
     * (`gatewayRef` plain, `merchantRef` sparse-unique), both values are opaque tokens
     * quoted in full, and a prefix search over a money collection is a scan that a query
     * string can request. `escapeRegex`/`containsInsensitive` are for names; these are not
     * names.
     */
    if (query.reference) {
        clauses.push({ $or: [{ gatewayRef: query.reference }, { merchantRef: query.reference }] });
    }

    const range = dateRange(query.from, query.to);
    if (range) clauses.push({ createdAt: range });

    if (clauses.length === 0) return {} as Filter<PaymentTransactionReadModel>;
    if (clauses.length === 1) return clauses[0] as Filter<PaymentTransactionReadModel>;

    // `$and`, not `Object.assign` — the order clause and the reference clause are both
    // `$or`-shaped, and merging two of those by assignment silently drops the earlier one.
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

// ─────────────────────────────────────────────────────────────────────────────
// Per-aggregator outcomes — the evidence behind a manual payment-routing switch
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What an operator looks at before moving collections to another aggregator (jovi-mall ADR-A08,
 * owner decision 6: failover is manual, and this is what "manual" decides on).
 *
 * ── Three collections, because the platform charges through three ─────────────
 * Orders and bookings settle into `payment_transactions`; plan purchases and credit top-ups
 * write their own rows and create **no** payment transaction. An aggregator failing only on
 * billing would be invisible to a `payment_transactions`-only view, and the reverse.
 *
 * ── The two vocabularies are the database's, not this file's ──────────────────
 * `payment_transactions` is camelCase with UPPERCASE statuses; the two billing collections are
 * snake_case with lowercase ones. Each source therefore carries its own field names and its own
 * status buckets rather than one pipeline pretending they agree.
 *
 * Bucketing, and the reasoning behind the two non-obvious rows:
 *   - `REFUNDED` / `reversed` count as **succeeded**. The money arrived — the aggregator did its
 *     job — and what happened afterwards is a business decision, not a gateway outcome.
 *   - `CANCELLED` counts as **failed**. From the operator's chair a cancelled charge and a failed
 *     one are the same symptom: the customer did not pay through this aggregator.
 *
 * ── Aggregates only ───────────────────────────────────────────────────────────
 * Counts, durations and one timestamp per gateway. No row, no payer, no reference leaves the
 * database, so no projection is at stake; the one each class passes is the base class's
 * required argument and `aggregateBy` never applies it.
 *
 * ── Index cost ────────────────────────────────────────────────────────────────
 * `payment_transactions` carries `{gateway, status, createdAt}` ("gateway analytics"), so its
 * window is index-served. `plan_purchases` and `credit_topups` are indexed by owner only, so
 * their window is a **collection scan**. Acceptable at today's volume and deliberately not
 * fixed here: indexes are jovi-mall's (its migration ledger), and a read one tier-1 operator
 * opens during an incident is not a reason to add one.
 */
export type GatewayStatsSource = 'payments' | 'plan_purchases' | 'credit_topups';

export interface GatewayStatsSourceSpec {
    source: GatewayStatsSource;
    createdField: string;
    paidField: string;
    succeeded: readonly string[];
    failed: readonly string[];
    pending: readonly string[];
}

export const GATEWAY_STATS_SOURCES: Readonly<Record<GatewayStatsSource, GatewayStatsSourceSpec>> = Object.freeze({
    payments: {
        source: 'payments',
        createdField: 'createdAt',
        paidField: 'paidAt',
        succeeded: ['SUCCEEDED', 'REFUNDED'],
        failed: ['FAILED', 'CANCELLED'],
        pending: ['INITIATED', 'PENDING'],
    },
    plan_purchases: {
        source: 'plan_purchases',
        createdField: 'created_at',
        paidField: 'paid_at',
        succeeded: ['paid', 'reversed'],
        failed: ['failed'],
        pending: ['pending'],
    },
    credit_topups: {
        source: 'credit_topups',
        createdField: 'created_at',
        paidField: 'paid_at',
        succeeded: ['paid', 'reversed'],
        failed: ['failed'],
        pending: ['pending'],
    },
});

/** A pending row older than this is reported as stuck — a settlement that never arrived. */
export const STUCK_PENDING_AFTER_MINUTES = 30;

export interface GatewayStatsRow {
    gateway: string;
    source: GatewayStatsSource;
    total: number;
    succeeded: number;
    failed: number;
    pending: number;
    /** Pending AND created more than `STUCK_PENDING_AFTER_MINUTES` ago. A subset of `pending`. */
    stuckPending: number;
    /**
     * Median and 90th-percentile time from creation to settlement, over succeeded rows with a
     * settlement stamp. `null` when there are none. Approximate (`$percentile`, MongoDB 7).
     */
    settleP50Seconds: number | null;
    settleP90Seconds: number | null;
    /** The latest settlement stamp IN THE WINDOW. `null` means none in the window, not "never". */
    lastSuccessAt: Date | null;
}

/**
 * Pure, and exported so the test can assert the pipeline without a database.
 *
 * `$match` → one `$group` per gateway. The pending/stuck split is computed in the group rather
 * than by a second query, so one scan answers every column.
 */
export function buildGatewayStatsPipeline(spec: GatewayStatsSourceSpec, since: Date, now: Date): Document[] {
    const created = `$${spec.createdField}`;
    const paid = `$${spec.paidField}`;
    const stuckBefore = new Date(now.getTime() - STUCK_PENDING_AFTER_MINUTES * 60_000);

    const isIn = (values: readonly string[]): Document => ({ $in: ['$status', [...values]] });
    const countIf = (condition: Document): Document => ({ $sum: { $cond: [condition, 1, 0] } });
    const settled = { $and: [isIn(spec.succeeded), { $eq: [{ $type: paid }, 'date'] }] };

    return [
        // `gateway: {$type: 'string'}` drops billing rows still at `gateway: null` — a checkout
        // abandoned before a gateway was chosen says nothing about any aggregator.
        { $match: { [spec.createdField]: { $gte: since }, gateway: { $type: 'string' } } },
        {
            $group: {
                _id: '$gateway',
                total: { $sum: 1 },
                succeeded: countIf(isIn(spec.succeeded)),
                failed: countIf(isIn(spec.failed)),
                pending: countIf(isIn(spec.pending)),
                stuckPending: countIf({ $and: [isIn(spec.pending), { $lt: [created, stuckBefore] }] }),
                // `$percentile` ignores non-numeric input, so an unsettled row contributes a null
                // and is skipped rather than counted as zero seconds.
                settle: {
                    $percentile: {
                        input: { $cond: [settled, { $subtract: [paid, created] }, null] },
                        p: [0.5, 0.9],
                        method: 'approximate',
                    },
                },
                lastSuccessAt: { $max: { $cond: [settled, paid, null] } },
            },
        },
    ];
}

export interface GatewayStatsGroup extends Document {
    _id: string;
    total: number;
    succeeded: number;
    failed: number;
    pending: number;
    stuckPending: number;
    settle: Array<number | null> | null;
    lastSuccessAt: Date | null;
}

function toSeconds(ms: number | null | undefined): number | null {
    return typeof ms === 'number' && Number.isFinite(ms) ? Math.round(ms / 1000) : null;
}

/** Pure, exported for the test. */
export function toGatewayStatsRow(source: GatewayStatsSource, group: GatewayStatsGroup): GatewayStatsRow {
    return {
        gateway: group._id,
        source,
        total: group.total,
        succeeded: group.succeeded,
        failed: group.failed,
        pending: group.pending,
        stuckPending: group.stuckPending,
        settleP50Seconds: toSeconds(group.settle?.[0]),
        settleP90Seconds: toSeconds(group.settle?.[1]),
        lastSuccessAt: group.lastSuccessAt ?? null,
    };
}

/** The base class's required projection. `aggregateBy` never applies it — see above. */
const GATEWAY_STATS_PROJECTION = { _id: 1, gateway: 1, status: 1 } as const;

abstract class GatewayStatsReadRepository extends PlatformReadRepository<Document> {
    protected abstract readonly spec: GatewayStatsSourceSpec;

    async gatewayStats(since: Date, now: Date = new Date()): Promise<GatewayStatsRow[]> {
        const groups = await this.aggregateBy<GatewayStatsGroup>(
            buildGatewayStatsPipeline(this.spec, since, now),
        );
        return groups.map((group) => toGatewayStatsRow(this.spec.source, group));
    }
}

export class PaymentGatewayStatsReadRepository extends GatewayStatsReadRepository {
    protected readonly spec = GATEWAY_STATS_SOURCES.payments;
    constructor() {
        super(COLLECTIONS.PAYMENT_TRANSACTION, GATEWAY_STATS_PROJECTION);
    }
}

export class PlanPurchaseGatewayStatsReadRepository extends GatewayStatsReadRepository {
    protected readonly spec = GATEWAY_STATS_SOURCES.plan_purchases;
    constructor() {
        super(COLLECTIONS.PLAN_PURCHASE, GATEWAY_STATS_PROJECTION);
    }
}

export class CreditTopupGatewayStatsReadRepository extends GatewayStatsReadRepository {
    protected readonly spec = GATEWAY_STATS_SOURCES.credit_topups;
    constructor() {
        super(COLLECTIONS.CREDIT_TOPUP, GATEWAY_STATS_PROJECTION);
    }
}
