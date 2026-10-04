import { Document, Filter, ObjectId } from 'mongodb';
import { toMongoSort } from '../../../core/data/mongo-list';
import { ListQueryBase } from '../../../core/http/list-query';
import { COLLECTIONS } from '../../../infra/platform/collections';
import { Paginated, PlatformReadRepository } from '../../../infra/platform/platform.repository';
import { DELIVERY_FEE_REFUND_SORT } from '../validators/money.validator';

/**
 * Delivery-fee changes after checkout (jovi-mall ADR-A11 W-E/W-E2), read DIRECTLY.
 *
 * Two collections, both records rather than verdicts, so ADR-004 D-1 puts them on the direct
 * side: `delivery_fee_refunds` is the ledger of delivery money owed back to a customer, and
 * `delivery_fee_proposals` the history of a shipment's fee moving. The one WRITE on this
 * surface — settling a manual refund — is delegated (`money.gateway.ts`), because jovi-mall
 * pairs it with a ticket resolution and a customer notice a second writer would miss.
 *
 * ⚠ jovi-mall also serves `GET /api/internal/admin/delivery-fee-refunds[/:id]`. They exist so
 * a client with no database could build the settle button; this service has the database, and
 * a delegated read here would be a second round trip to answer a record.
 *
 * Indexes behind each read (jovi-mall `migrate:delivery-fee-proposal-indexes`):
 *   refunds   `{status, created_at: -1}` (the admin queue) · `{order_id, created_at: -1}`
 *   proposals `{order_id, created_at: -1}`
 */

// ─────────────────────────────────────────────────────────────────────────────
// delivery_fee_refunds
// ─────────────────────────────────────────────────────────────────────────────

export interface DeliveryFeeRefundReadModel extends Document {
    _id: ObjectId;
    order_id: ObjectId;
    shipment_id?: ObjectId | null;
    customer_id: ObjectId;
    vendor_id: ObjectId;
    amount: number;
    currency: string;
    /** `processing` · `completed` · `manual_required` · `failed`. */
    status: string;
    /** `fee_decrease` · `rto_leftover` · `sweep`. */
    cause: string;
    refund_transaction_ids?: ObjectId[];
    /** Operator-facing — why it is manual or failed. Never shown to a customer. */
    note?: string | null;
    ticket_id?: ObjectId | null;
    settled_at?: Date | null;
    settlement?: {
        method: string;
        reference?: string | null;
        note?: string | null;
        /** A wi-admin administrator id (`settled_by_source: 'admin'`) — resolves in THIS service. */
        settled_by_user_id: string;
        settled_by_source?: string;
        settled_by_name?: string | null;
        settled_at: Date;
    } | null;
    created_at: Date;
    updated_at: Date;
}

const DELIVERY_FEE_REFUND_PROJECTION = {
    _id: 1,
    order_id: 1,
    shipment_id: 1,
    customer_id: 1,
    vendor_id: 1,
    amount: 1,
    currency: 1,
    status: 1,
    cause: 1,
    refund_transaction_ids: 1,
    note: 1,
    ticket_id: 1,
    settled_at: 1,
    settlement: 1,
    created_at: 1,
    updated_at: 1,
} as const;

/**
 * Which refunds the admin queue shows — the SAME three words jovi-mall's internal list takes,
 * so a dashboard reading either learns one vocabulary.
 *   manual_required  still owed: a person must send the money (the settle button)
 *   settled          settled by an administrator (`completed` with a `settlement`)
 *   all              both — every row an administrator ever had to handle
 * Automatic rows (the gateway returned the money) are not the queue's; they appear on the
 * order detail, which shows the whole ledger of one order.
 */
export const DELIVERY_FEE_REFUND_QUEUES = ['manual_required', 'settled', 'all'] as const;
export type DeliveryFeeRefundQueue = (typeof DELIVERY_FEE_REFUND_QUEUES)[number];

export interface DeliveryFeeRefundSearchQuery extends ListQueryBase {
    status: DeliveryFeeRefundQueue;
    orderId?: string;
    vendorId?: string;
    customerId?: string;
}

/**
 * Pure, and exported so `test-money.ts` can assert every branch without a database.
 *
 * Every branch leads with an equality or `$in` on `status`, so the `{status, created_at}`
 * queue index selects first — `all` included. Written as `$or` alone, its `settlement` branch
 * carries no indexed field and the planner scans the collection.
 */
export function buildDeliveryFeeRefundFilter(query: Omit<DeliveryFeeRefundSearchQuery, keyof ListQueryBase>): Filter<DeliveryFeeRefundReadModel> {
    const clauses: Record<string, unknown>[] = [];

    if (query.status === 'manual_required') clauses.push({ status: 'manual_required' });
    else if (query.status === 'settled') clauses.push({ status: 'completed', settlement: { $ne: null } });
    else {
        clauses.push({
            status: { $in: ['manual_required', 'completed'] },
            $or: [{ status: 'manual_required' }, { settlement: { $ne: null } }],
        });
    }

    if (query.orderId) clauses.push({ order_id: toObjectIdOrNothing(query.orderId) });
    if (query.vendorId) clauses.push({ vendor_id: toObjectIdOrNothing(query.vendorId) });
    if (query.customerId) clauses.push({ customer_id: toObjectIdOrNothing(query.customerId) });

    if (clauses.length === 1) return clauses[0] as Filter<DeliveryFeeRefundReadModel>;
    return { $and: clauses } as Filter<DeliveryFeeRefundReadModel>;
}

export class DeliveryFeeRefundReadRepository extends PlatformReadRepository<DeliveryFeeRefundReadModel> {
    constructor() {
        super(COLLECTIONS.DELIVERY_FEE_REFUND, DELIVERY_FEE_REFUND_PROJECTION);
    }

    async search(query: DeliveryFeeRefundSearchQuery): Promise<Paginated<DeliveryFeeRefundReadModel>> {
        return this.findPage(buildDeliveryFeeRefundFilter(query), {
            page: query.page,
            limit: query.limit,
            sort: toMongoSort(query.sort, DELIVERY_FEE_REFUND_SORT),
        });
    }

    /** Any row — automatic ones too. Whether it may be settled is `settleable` on the DTO. */
    async findById(refundId: string): Promise<DeliveryFeeRefundReadModel | null> {
        if (!isId(refundId)) return null;
        return this.findOneBy({ _id: new ObjectId(refundId) } as Filter<DeliveryFeeRefundReadModel>);
    }

    /**
     * The whole ledger of one order — automatic and manual. Bounded rather than paged: one
     * order accumulates a handful (at most one in flight at a time, by jovi-mall's partial
     * unique index), not a feed.
     */
    async forOrder(orderId: string): Promise<DeliveryFeeRefundReadModel[]> {
        if (!isId(orderId)) return [];
        return this.findBy({ order_id: new ObjectId(orderId) } as Filter<DeliveryFeeRefundReadModel>, {
            sort: { created_at: -1 },
            limit: 50,
        });
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// delivery_fee_proposals
// ─────────────────────────────────────────────────────────────────────────────

export interface DeliveryFeeProposalReadModel extends Document {
    _id: ObjectId;
    shipment_id: ObjectId;
    order_id: ObjectId;
    agency_id: ObjectId;
    proposed_by_role: string;
    currency: string;
    fee_before: number;
    proposed_fee: number;
    reason: string;
    /** `pending` · `approved` · `rejected` · `withdrawn` — jovi-mall's vocabulary, passed through. */
    status: string;
    /** `vendor` · `customer` · `none` (a customer-paid decrease, applied on creation). */
    approver?: string;
    /** `agency` · `change_agency` · `combined_request` — passed through. */
    origin?: string;
    direction?: string | null;
    customer_approval?: { approved_at: Date; topup_amount: number } | null;
    topup?: { amount: number; transaction_id?: ObjectId | null; status: string; paid_at?: Date | null } | null;
    responded_by_role?: string | null;
    responded_at?: Date | null;
    rejection_note?: string | null;
    withdrawal_reason?: string | null;
    application?: {
        fee_at_apply?: number | null;
        customer_fee_before?: number | null;
        customer_fee_after?: number | null;
        customer_topup_amount?: number | null;
        customer_refund_due?: number | null;
    } | null;
    created_at: Date;
}

/**
 * Inclusion-only, and deliberately narrow. NOT projected: `proposed_by_user_id` /
 * `responded_by_user_id` / `edits` / `status_history` / `last_edited_by` (who-did-what trails
 * the order's own timeline already tells), and `customer_id` (the order names its customer).
 */
const DELIVERY_FEE_PROPOSAL_PROJECTION = {
    _id: 1,
    shipment_id: 1,
    order_id: 1,
    agency_id: 1,
    proposed_by_role: 1,
    currency: 1,
    fee_before: 1,
    proposed_fee: 1,
    reason: 1,
    status: 1,
    approver: 1,
    origin: 1,
    direction: 1,
    'customer_approval.approved_at': 1,
    'customer_approval.topup_amount': 1,
    'topup.amount': 1,
    'topup.transaction_id': 1,
    'topup.status': 1,
    'topup.paid_at': 1,
    responded_by_role: 1,
    responded_at: 1,
    rejection_note: 1,
    withdrawal_reason: 1,
    'application.customer_fee_before': 1,
    'application.customer_fee_after': 1,
    'application.customer_topup_amount': 1,
    'application.customer_refund_due': 1,
    'application.fee_at_apply': 1,
    created_at: 1,
} as const;

export class DeliveryFeeProposalReadRepository extends PlatformReadRepository<DeliveryFeeProposalReadModel> {
    constructor() {
        super(COLLECTIONS.DELIVERY_FEE_PROPOSAL, DELIVERY_FEE_PROPOSAL_PROJECTION);
    }

    /** One order's proposals, newest first — bounded (a per-shipment count cap exists upstream). */
    async forOrder(orderId: string): Promise<DeliveryFeeProposalReadModel[]> {
        if (!isId(orderId)) return [];
        return this.findBy({ order_id: new ObjectId(orderId) } as Filter<DeliveryFeeProposalReadModel>, {
            sort: { created_at: -1 },
            limit: 50,
        });
    }
}

function isId(value: string): boolean {
    return typeof value === 'string' && /^[a-f\d]{24}$/i.test(value);
}

/** A malformed id becomes a term that matches nothing, rather than a thrown BSONError. */
function toObjectIdOrNothing(value: string): ObjectId | { $in: [] } {
    return isId(value) ? new ObjectId(value) : { $in: [] };
}
