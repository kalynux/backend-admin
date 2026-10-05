import { Document, Filter, ObjectId } from 'mongodb';
import { Types } from 'mongoose';
import { toMongoSort } from '../../../core/data/mongo-list';
import { ListQueryBase } from '../../../core/http/list-query';
import { COLLECTIONS } from '../../../infra/platform/collections';
import { Paginated, PlatformReadRepository } from '../../../infra/platform/platform.repository';
import { REFUND_REQUEST_SORT } from '../validators/refund.validator';
import { OPEN_REFUND_STATUSES } from '../domain/refund-vocabulary';

/**
 * The refund queue — a DIRECT read of `refund_requests` (REFUND-FLOW-PLAN § 7, contract § 11.1).
 *
 * ── Read here, written there ──────────────────────────────────────────────────
 * A refund request is a RECORD: reading one protects no invariant. Every transition is a
 * jovi-mall write paired with effects a second writer would miss — the earnings pause, the
 * payout claim with its double-send guard, the clawback on completion, the customer notice —
 * so `PlatformReadRepository` (no write method) is the only base this module has. Writes leave
 * through `../gateways/refund.gateway.ts`.
 *
 * ── What the projection leaves in the database ────────────────────────────────
 *  - `transfer_reference` and `transfer_legs.reference` — OUR merchant reference (`jm_rf_…`),
 *    the idempotency key of money leaving the platform. Same reasoning as the payout queue's
 *    `PAYOUT_LIST_PROJECTION`: anything holding it could in principle be replayed at the
 *    gateway, and what reconciles a transfer against a provider's dashboard is the provider's
 *    own id (`transfer_gateway_ref`), which IS read.
 *  - Everything not named. The whitelist is dotted where a sub-document could grow.
 *
 * The destination phone IS read: the approver has to compare a typed number against the proof
 * picture (R-7). The LIST masks it in the mapper; only the detail shows it in full.
 */

/** An actor stamp as jovi-mall writes it. Admin ids are wi-admin `admin_accounts` ids. */
export interface RefundActorStamp {
    id?: string | null;
    name?: string | null;
    at?: Date | null;
}

export interface RefundRequestReadModel extends Document {
    _id: ObjectId;
    source_kind: string;
    source_id: ObjectId;
    order_number?: string | null;
    vendor_id?: ObjectId | null;
    customer_id?: ObjectId | null;
    reason_kind: string;
    reason?: string | null;
    item_defective?: boolean | null;
    override_policy?: boolean;
    /** `clawback` · `none` — see `REFUND_EARNINGS_IMPACTS`. Absent on rows written before it. */
    earnings_impact?: string | null;
    attribution?: { goods?: number; delivery?: number } | null;
    gross_amount: number;
    fee_rate?: number;
    fee_amount?: number;
    net_amount?: number;
    currency: string;
    payment_channel?: string | null;
    channel?: string | null;
    destination?: { phone?: string | null; name?: string | null; source?: string | null } | null;
    destination_proof_file_id?: ObjectId | null;
    cod_collection_ids?: ObjectId[] | null;
    status: string;
    requested_by?: { id?: string | null; role?: string | null; name?: string | null } | null;
    approved_by?: RefundActorStamp | null;
    rejected_by?: RefundActorStamp | null;
    rejection_reason?: string | null;
    transfer_gateway?: string | null;
    transfer_gateway_ref?: string | null;
    transfer_failure_reason?: string | null;
    /** A note jovi-mall writes beside the transfer (e.g. why it is waiting). */
    transfer_note?: string | null;
    /** `reference` is NOT projected — see the header. */
    transfer_legs?: Array<{
        phone?: string | null;
        /** NET sent through this transfer. */
        amount?: number;
        /** GROSS refunded through it (`amount` + its share of the fee). */
        gross?: number;
        gateway_ref?: string | null;
        status?: string | null;
        failure_reason?: string | null;
    }> | null;
    external_settlement?: {
        method?: string | null;
        reference?: string | null;
        proof_file_id?: ObjectId | null;
        settled_by?: { id?: string | null; name?: string | null } | null;
        settled_at?: Date | null;
        /**
         * The part paid BY HAND — the whole request, or only the unpaid remainder after a
         * multi-transfer refund part of which already arrived. Null on rows written before
         * 2026-10-05: read those as the request's own totals.
         */
        gross_amount?: number | null;
        net_amount?: number | null;
    } | null;
    ticket_id?: ObjectId | null;
    refund_transaction_ids?: ObjectId[] | null;
    completed_at?: Date | null;
    /** When the earnings recovery of a COMPLETED order/booking refund finished. Null until then. */
    earnings_settled_at?: Date | null;
    /** When a COMPLETED billing refund took the plan or the credits back. Null until then. */
    billing_reversed_at?: Date | null;
    created_at: Date;
    updated_at?: Date | null;
}

/**
 * The whitelist. `transfer_reference` and `transfer_legs.reference` are absent ON PURPOSE —
 * `test-refunds.ts` scans for both.
 */
export const REFUND_REQUEST_PROJECTION = {
    _id: 1,
    source_kind: 1,
    source_id: 1,
    order_number: 1,
    vendor_id: 1,
    customer_id: 1,
    reason_kind: 1,
    reason: 1,
    item_defective: 1,
    override_policy: 1,
    earnings_impact: 1,
    'attribution.goods': 1,
    'attribution.delivery': 1,
    gross_amount: 1,
    fee_rate: 1,
    fee_amount: 1,
    net_amount: 1,
    currency: 1,
    payment_channel: 1,
    channel: 1,
    'destination.phone': 1,
    'destination.name': 1,
    'destination.source': 1,
    destination_proof_file_id: 1,
    cod_collection_ids: 1,
    status: 1,
    'requested_by.id': 1,
    'requested_by.role': 1,
    'requested_by.name': 1,
    'approved_by.id': 1,
    'approved_by.name': 1,
    'approved_by.at': 1,
    'rejected_by.id': 1,
    'rejected_by.name': 1,
    'rejected_by.at': 1,
    rejection_reason: 1,
    transfer_gateway: 1,
    transfer_gateway_ref: 1,
    transfer_failure_reason: 1,
    transfer_note: 1,
    'transfer_legs.phone': 1,
    'transfer_legs.amount': 1,
    'transfer_legs.gross': 1,
    'transfer_legs.failure_reason': 1,
    'transfer_legs.gateway_ref': 1,
    'transfer_legs.status': 1,
    'external_settlement.method': 1,
    'external_settlement.reference': 1,
    'external_settlement.proof_file_id': 1,
    'external_settlement.settled_by.id': 1,
    'external_settlement.settled_by.name': 1,
    'external_settlement.settled_at': 1,
    'external_settlement.gross_amount': 1,
    'external_settlement.net_amount': 1,
    ticket_id: 1,
    refund_transaction_ids: 1,
    completed_at: 1,
    earnings_settled_at: 1,
    billing_reversed_at: 1,
    created_at: 1,
    updated_at: 1,
} as const;

export interface RefundRequestSearchQuery extends ListQueryBase {
    status?: string;
    /** The five OPEN statuses — the working queue. Ignored when `status` is given. */
    open?: boolean;
    sourceKind?: string;
    sourceId?: string;
    vendorId?: string;
    customerId?: string;
    requesterRole?: string;
    requesterId?: string;
    channel?: string;
    paymentChannel?: string;
    from?: Date;
    to?: Date;
}

export class RefundRequestReadRepository extends PlatformReadRepository<RefundRequestReadModel> {
    constructor() {
        super(COLLECTIONS.REFUND_REQUEST, REFUND_REQUEST_PROJECTION);
    }

    async search(query: RefundRequestSearchQuery): Promise<Paginated<RefundRequestReadModel>> {
        return this.findPage(buildRefundRequestFilter(query), {
            page: query.page,
            limit: query.limit,
            sort: toMongoSort(query.sort, REFUND_REQUEST_SORT),
        });
    }

    /**
     * One request. Every write path reads through here first: for the 404, for the status
     * pre-flight, for the four-eyes AMOUNT (off the row, never the body) and for the audit
     * `before`.
     */
    async findById(refundId: string): Promise<RefundRequestReadModel | null> {
        if (!Types.ObjectId.isValid(refundId) || refundId.length !== 24) return null;
        return this.findOneBy({ _id: new ObjectId(refundId) } as Filter<RefundRequestReadModel>);
    }

    /**
     * The refund request that still HOLDS an order's or booking's earnings pause — jovi-mall's
     * `findHoldingEarningsPause`, read here so the resume route can refuse before it audits:
     * an OPEN request on the source, else a COMPLETED clawback request whose earnings recovery has
     * not finished yet (`earnings_settled_at` null). Resuming under either would release money
     * the refund is about to claw back.
     */
    async findHoldingEarningsPause(kind: 'order' | 'booking', sourceId: string): Promise<RefundRequestReadModel | null> {
        if (!Types.ObjectId.isValid(sourceId) || sourceId.length !== 24) return null;
        const source = { source_kind: kind, source_id: new ObjectId(sourceId) };
        const open = await this.findOneBy({
            ...source,
            status: { $in: [...OPEN_REFUND_STATUSES] },
        } as Filter<RefundRequestReadModel>);
        if (open) return open;
        return this.findOneBy({
            ...source,
            status: 'completed',
            earnings_impact: 'clawback',
            earnings_settled_at: null,
        } as Filter<RefundRequestReadModel>);
    }

    /**
     * The OPEN refund request of each of these orders (at most one per order — the partial
     * unique index `refund_one_open_per_source`). A delivery-fee refund cannot be settled by hand
     * while its order has one: both come out of the same refundable ceiling.
     */
    async openForOrders(orderIds: string[]): Promise<Map<string, { id: string; status: string }>> {
        const ids = [...new Set(orderIds)].filter((id) => Types.ObjectId.isValid(id) && id.length === 24);
        const found = new Map<string, { id: string; status: string }>();
        if (ids.length === 0) return found;
        const rows = await this.findBy({
            source_kind: 'order',
            source_id: { $in: ids.map((id) => new ObjectId(id)) },
            status: { $in: [...OPEN_REFUND_STATUSES] },
        } as Filter<RefundRequestReadModel>);
        for (const row of rows) found.set(row.source_id.toString(), { id: row._id.toString(), status: row.status });
        return found;
    }

    /**
     * The request a proof picture belongs to — as the destination proof or as the proof of an
     * external payment — or null.
     *
     * This is what bounds `GET /refunds/proofs/:fileId`: a file is served only when a refund
     * request names it, so the route cannot become a reader of any private file whose id
     * somebody holds. Newest first, so a file reused across requests resolves to the latest.
     */
    async findByProofFile(fileId: string): Promise<RefundRequestReadModel | null> {
        if (!Types.ObjectId.isValid(fileId) || fileId.length !== 24) return null;
        const id = new ObjectId(fileId);
        const [row] = await this.findBy(
            {
                $or: [{ destination_proof_file_id: id }, { 'external_settlement.proof_file_id': id }],
            } as Filter<RefundRequestReadModel>,
            { sort: { created_at: -1, _id: -1 }, limit: 1 },
        );
        return row ?? null;
    }
}

/** Pure, and exported so `test-refunds.ts` can assert every branch without a database. */
export function buildRefundRequestFilter(query: RefundRequestSearchQuery): Filter<RefundRequestReadModel> {
    const clauses: Record<string, unknown>[] = [];

    if (query.status) clauses.push({ status: query.status });
    else if (query.open) clauses.push({ status: { $in: [...OPEN_REFUND_STATUSES] } });

    if (query.sourceKind) clauses.push({ source_kind: query.sourceKind });
    if (query.sourceId) clauses.push({ source_id: toObjectIdOrNothing(query.sourceId) });
    if (query.vendorId) clauses.push({ vendor_id: toObjectIdOrNothing(query.vendorId) });
    if (query.customerId) clauses.push({ customer_id: toObjectIdOrNothing(query.customerId) });
    if (query.requesterRole) clauses.push({ 'requested_by.role': query.requesterRole });
    // A string column: jovi-mall stamps the actor id as text (an admin id resolves in wi-admin).
    if (query.requesterId) clauses.push({ 'requested_by.id': query.requesterId });
    if (query.channel) clauses.push({ channel: query.channel });
    if (query.paymentChannel) clauses.push({ payment_channel: query.paymentChannel });

    if (query.from || query.to) {
        const range: Record<string, Date> = {};
        if (query.from) range.$gte = query.from;
        // Half-open `[from, to)`, matching `dateRangeFields`.
        if (query.to) range.$lt = query.to;
        clauses.push({ created_at: range });
    }

    if (clauses.length === 0) return {} as Filter<RefundRequestReadModel>;
    if (clauses.length === 1) return clauses[0] as Filter<RefundRequestReadModel>;
    return { $and: clauses } as Filter<RefundRequestReadModel>;
}

/** A malformed id becomes a term that matches nothing, rather than a thrown BSONError. */
function toObjectIdOrNothing(value: string): ObjectId | { $in: [] } {
    return Types.ObjectId.isValid(value) && value.length === 24 ? new ObjectId(value) : { $in: [] };
}
