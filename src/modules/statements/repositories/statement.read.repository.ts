import { Document, Filter, ObjectId } from 'mongodb';
import { COLLECTIONS } from '../../../infra/platform/collections';
import { PlatformReadRepository } from '../../../infra/platform/platform.repository';

/**
 * The account-statement reads — one small repository per collection, each with its own
 * whitelist, all scoped by OWNER and PERIOD.
 *
 * ── Why these are new rather than the `/money` and `/accounts` repositories ────
 * Those serve paged screens: newest-first, `limit`ed, cursor- or offset-paged. A statement is
 * the opposite read — every row in a closed period, in order, once. Bolting an unbounded
 * range method onto a repository whose whole design is "never return everything" would be the
 * widened surface the two-lock convention exists to prevent. The period is bounded instead
 * (≤ 366 days, `STATEMENT_MAX_DAYS`), and the size cap on the rendered file is the backstop.
 *
 * ── Projections: what is deliberately absent ───────────────────────────────────
 *  - `payment_transactions.rawGatewayPayloads` / `payloadHash` / idempotency keys (ADR-011's
 *    projection ban list). The payment DATE is taken from the allocation instead — see the
 *    statement builder.
 *  - `customers.saved_payment_methods` (gateway instrument ids — see `platform-collections.ts`).
 *  - `order_timelines.metadata` (Mixed; can carry anything).
 *  - `payout_requests.payout_method_snapshot` beyond the method KIND and provider name: the
 *    account number is `money.payouts.destination.read`'s, audited one payout at a time, and a
 *    statement must never become a bulk way round that.
 *
 * Every `period.end` is EXCLUSIVE (`$lt`) — see `statement-period.ts`.
 */

export interface Range {
    start: Date;
    end: Date;
}

const inRange = (r: Range) => ({ $gte: r.start, $lt: r.end });
const oid = (id: string) => new ObjectId(id);
const uniq = (ids: ObjectId[]) => [...new Map(ids.map((id) => [id.toHexString(), id])).values()];

// ─────────────────────────────────────────────────────────────────────────────
// earnings_allocations
// ─────────────────────────────────────────────────────────────────────────────

export interface AllocationRow extends Document {
    _id: ObjectId;
    source_type: 'order' | 'booking' | 'cod_collection' | 'shipment';
    source_id: ObjectId;
    beneficiary_type: 'vendor' | 'agency' | 'platform' | 'agent' | 'platform_ai';
    beneficiary_id: ObjectId | null;
    gross_snapshot: number;
    commission_percent_snapshot: number;
    amount: number;
    currency: string;
    status: 'held' | 'released' | 'reversed';
    completed_at?: Date | null;
    hold_release_at?: Date | null;
    released_at?: Date | null;
    reversed_at?: Date | null;
    requires_cash_settlement?: boolean;
    cash_settled_at?: Date | null;
    created_at: Date;
}

export class StatementAllocationRepository extends PlatformReadRepository<AllocationRow> {
    constructor() {
        super(COLLECTIONS.EARNINGS_ALLOCATION, {
            _id: 1, source_type: 1, source_id: 1, beneficiary_type: 1, beneficiary_id: 1,
            gross_snapshot: 1, commission_percent_snapshot: 1, amount: 1, currency: 1, status: 1,
            completed_at: 1, hold_release_at: 1, released_at: 1, reversed_at: 1,
            requires_cash_settlement: 1, cash_settled_at: 1, created_at: 1,
        });
    }

    /**
     * Money that REACHED the owner's account in the period. `created_at` is the split instant,
     * which is the payment instant for a prepaid order and the collection instant for COD —
     * the "date the money was received" rule (owner decision O-2), with no second field.
     */
    createdFor(type: string, id: string, range: Range): Promise<AllocationRow[]> {
        return this.findBy(
            { beneficiary_type: type, beneficiary_id: oid(id), created_at: inRange(range) } as Filter<AllocationRow>,
            { sort: { created_at: 1, _id: 1 } },
        );
    }

    /** Rows of this owner reversed in the period, whenever they were created. */
    reversedFor(type: string, id: string, range: Range): Promise<AllocationRow[]> {
        return this.findBy(
            { beneficiary_type: type, beneficiary_id: oid(id), reversed_at: inRange(range) } as Filter<AllocationRow>,
            { sort: { reversed_at: 1, _id: 1 } },
        );
    }

    /** Every allocation on these sources — the siblings a breakdown is read from. */
    async forSources(sources: { type: string; id: ObjectId }[]): Promise<AllocationRow[]> {
        if (sources.length === 0) return [];
        const byType = new Map<string, ObjectId[]>();
        for (const s of sources) byType.set(s.type, [...(byType.get(s.type) ?? []), s.id]);
        return this.findBy({
            $or: [...byType].map(([type, ids]) => ({ source_type: type, source_id: { $in: uniq(ids) } })),
        } as Filter<AllocationRow>);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// earnings_adjustments — refund clawbacks and write-offs (REFUND-FLOW-PLAN § 6.1)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One `earnings_adjustments` row. `refund_clawback` is money a refund took back from this owner
 * (from a held share, its reserve slice, available, or — when nothing covered it — debt);
 * `write_off` is debt the platform forgave. `clawback_recovery` (debt paid down by a later
 * inflow) is NOT read: it moves money from one of the owner's pots to another and changes no
 * earning, so counting it would count the clawback twice.
 */
export interface AdjustmentRow extends Document {
    _id: ObjectId;
    refund_key: string;
    /** `null` on a vendor charge beyond its shares (C-1 delivery money) and on a write-off. */
    allocation_id: ObjectId | null;
    source_type: 'order' | 'booking' | 'cod_collection' | 'shipment' | null;
    source_id: ObjectId | null;
    beneficiary_type: string;
    beneficiary_id: ObjectId | null;
    amount: number;
    currency?: string;
    taken_from?: { pending?: number; reserve?: number; available?: number; debt?: number } | null;
    kind: 'refund_clawback' | 'write_off' | 'clawback_recovery';
    created_at: Date;
}

export class StatementAdjustmentRepository extends PlatformReadRepository<AdjustmentRow> {
    constructor() {
        super(COLLECTIONS.EARNINGS_ADJUSTMENT, {
            _id: 1, refund_key: 1, allocation_id: 1, source_type: 1, source_id: 1, beneficiary_type: 1,
            beneficiary_id: 1, amount: 1, currency: 1, 'taken_from.pending': 1, 'taken_from.reserve': 1,
            'taken_from.available': 1, 'taken_from.debt': 1, kind: 1, created_at: 1,
        });
    }

    /** This owner's clawbacks and write-offs recorded in the period. */
    clawbacksFor(type: string, id: string, range: Range): Promise<AdjustmentRow[]> {
        return this.findBy(
            {
                beneficiary_type: type,
                beneficiary_id: oid(id),
                kind: { $in: ['refund_clawback', 'write_off'] },
                created_at: inRange(range),
            } as Filter<AdjustmentRow>,
            { sort: { created_at: 1, _id: 1 } },
        );
    }

    /**
     * Which of these allocations a clawback has EVER touched, whatever the period. A reversed
     * allocation in that set is already told by its adjustment rows (a partial claw last month
     * and the final one this month are two rows) — listing its `reversed_at` too would count it
     * twice. One with no clawback row was reversed before the clawback ledger existed.
     */
    async clawedAllocationIds(allocationIds: ObjectId[]): Promise<Set<string>> {
        if (allocationIds.length === 0) return new Set();
        const rows = await this.findBy({
            allocation_id: { $in: uniq(allocationIds) },
            kind: 'refund_clawback',
        } as Filter<AdjustmentRow>);
        return new Set(rows.filter((r) => r.allocation_id).map((r) => r.allocation_id!.toHexString()));
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// orders · customers · order_timelines · payment_transactions · refund_transactions
// ─────────────────────────────────────────────────────────────────────────────

export interface OrderItemRow {
    _id: ObjectId;
    title?: string;
    sku?: string;
    quantity: number;
    price: number;
    negotiated_unit_price?: number | null;
    floor_price_snapshot?: number | null;
    /** Not yet written by jovi-mall (plan Step 1.2); projected now so it appears when it is. */
    list_price_snapshot?: number | null;
}

export interface OrderRow extends Document {
    _id: ObjectId;
    order_number: string;
    vendor_id: ObjectId;
    customer_id: ObjectId;
    order_type?: string;
    payment_method: string;
    payment_status: string;
    fulfillment_status: string;
    /** Items + customer-paid delivery since ADR-A11 — never a vendor's gross. */
    total_amount: number;
    /** `delivery` = what the customer was charged for delivery (absent → 0, before ADR-A11). */
    price_breakdown?: { base?: number | null; delivery?: number | null } | null;
    /** `null`/absent before ADR-A11 and on digital orders — read as `vendor`. */
    delivery_payer?: 'vendor' | 'customer' | null;
    currency: string;
    items: OrderItemRow[];
    completion?: { confirmed_at?: Date | null } | null;
    /** Not yet written by jovi-mall (plan Step 1.2). */
    customer_snapshot?: { name?: string | null; phone?: string | null } | null;
    created_at: Date;
}

export class StatementOrderRepository extends PlatformReadRepository<OrderRow> {
    constructor() {
        super(COLLECTIONS.ORDER, {
            _id: 1, order_number: 1, vendor_id: 1, customer_id: 1, order_type: 1,
            payment_method: 1, payment_status: 1, fulfillment_status: 1, total_amount: 1, currency: 1,
            'price_breakdown.base': 1, 'price_breakdown.delivery': 1, delivery_payer: 1,
            'items._id': 1, 'items.title': 1, 'items.sku': 1, 'items.quantity': 1, 'items.price': 1,
            'items.negotiated_unit_price': 1, 'items.floor_price_snapshot': 1, 'items.list_price_snapshot': 1,
            'completion.confirmed_at': 1, 'customer_snapshot.name': 1, 'customer_snapshot.phone': 1,
            created_at: 1,
        });
    }

    byIds(ids: ObjectId[]): Promise<OrderRow[]> {
        if (ids.length === 0) return Promise.resolve([]);
        return this.findBy({ _id: { $in: uniq(ids) } } as Filter<OrderRow>);
    }
}

export interface CustomerRow extends Document {
    _id: ObjectId;
    name?: string;
    phone?: string | null;
}

export class StatementCustomerRepository extends PlatformReadRepository<CustomerRow> {
    constructor() {
        // Name and phone ONLY. `saved_payment_methods` carries gateway instrument ids.
        super(COLLECTIONS.CUSTOMER, { _id: 1, name: 1, phone: 1 });
    }

    byIds(ids: ObjectId[]): Promise<CustomerRow[]> {
        if (ids.length === 0) return Promise.resolve([]);
        return this.findBy({ _id: { $in: uniq(ids) } } as Filter<CustomerRow>);
    }
}

export interface TimelineRow extends Document {
    _id: ObjectId;
    order_id: ObjectId;
    event_type: string;
    description: string;
    actor_type: string;
    created_at: Date;
}

export class StatementTimelineRepository extends PlatformReadRepository<TimelineRow> {
    constructor() {
        super(COLLECTIONS.ORDER_TIMELINE, { _id: 1, order_id: 1, event_type: 1, description: 1, actor_type: 1, created_at: 1 });
    }

    forOrders(ids: ObjectId[]): Promise<TimelineRow[]> {
        if (ids.length === 0) return Promise.resolve([]);
        return this.findBy({ order_id: { $in: uniq(ids) } } as Filter<TimelineRow>, { sort: { created_at: 1, _id: 1 } });
    }
}

export interface PaymentRow extends Document {
    _id: ObjectId;
    orderId?: ObjectId | null;
    orderIds?: ObjectId[] | null;
    bookingId?: ObjectId | null;
    purpose?: string;
    gateway: string;
    method: string;
    gatewayRef?: string;
    merchantRef?: string | null;
    status: string;
    amountSnapshot: number;
    currencySnapshot: string;
    /** Not yet written by jovi-mall (plan Step 1.1). */
    paidAt?: Date | null;
    payer?: { name?: string | null; phone?: string | null } | null;
    createdAt: Date;
    updatedAt: Date;
}

export class StatementPaymentRepository extends PlatformReadRepository<PaymentRow> {
    constructor() {
        super(COLLECTIONS.PAYMENT_TRANSACTION, {
            _id: 1, orderId: 1, orderIds: 1, bookingId: 1, purpose: 1, gateway: 1, method: 1,
            gatewayRef: 1, merchantRef: 1, status: 1, amountSnapshot: 1, currencySnapshot: 1,
            paidAt: 1, 'payer.name': 1, 'payer.phone': 1, createdAt: 1, updatedAt: 1,
        });
    }

    forOrders(ids: ObjectId[]): Promise<PaymentRow[]> {
        if (ids.length === 0) return Promise.resolve([]);
        const $in = uniq(ids);
        return this.findBy({ $or: [{ orderId: { $in } }, { orderIds: { $in } }] } as Filter<PaymentRow>, {
            sort: { createdAt: 1 },
        });
    }
}

/**
 * A `refund_transactions` row. Since the refund flow (REFUND-FLOW-PLAN § 11.5) `gateway` and
 * `paymentTransactionId` may be ABSENT (COD and externally-settled refunds), and `refundAmount`
 * stays the GROSS while `feeAmount` / `netAmount` say what the platform kept and what the
 * customer received. Everything here reads them as optional.
 */
export interface RefundRow extends Document {
    _id: ObjectId;
    orderId?: ObjectId | null;
    bookingId?: ObjectId | null;
    refundAmount: number;
    currency: string;
    reason?: string;
    status: string;
    gateway?: string | null;
    channel?: string | null;
    feeAmount?: number | null;
    netAmount?: number | null;
    initiatedByRole?: string;
    createdAt: Date;
    completedAt?: Date | null;
}

export class StatementRefundRepository extends PlatformReadRepository<RefundRow> {
    constructor() {
        super(COLLECTIONS.REFUND_TRANSACTION, {
            _id: 1, orderId: 1, bookingId: 1, refundAmount: 1, currency: 1, reason: 1, status: 1,
            gateway: 1, channel: 1, feeAmount: 1, netAmount: 1, initiatedByRole: 1, createdAt: 1, completedAt: 1,
        });
    }

    forVendor(vendorId: string, range: Range): Promise<RefundRow[]> {
        return this.findBy({ vendorId: oid(vendorId), createdAt: inRange(range) } as Filter<RefundRow>, {
            sort: { createdAt: 1 },
        });
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// shipments · cash_collections · agent_deposits · agency_remittances · reserve holds
// ─────────────────────────────────────────────────────────────────────────────

export interface ShipmentRow extends Document {
    _id: ObjectId;
    order_id: ObjectId;
    agency_id: ObjectId;
    agent_id?: ObjectId | null;
    status: string;
    tracking_number?: string | null;
    /** What the AGENCY is paid for the run. */
    delivery_fee_snapshot?: number | null;
    /** ADR-A11 — see `ShipmentFeeFacts` in `money-breakdown.ts`. */
    delivery_payer?: 'vendor' | 'customer' | null;
    customer_delivery_fee?: number | null;
    status_history?: { status: string; changed_at: Date; changed_by_role?: string }[];
    created_at: Date;
}

export class StatementShipmentRepository extends PlatformReadRepository<ShipmentRow> {
    constructor() {
        super(COLLECTIONS.SHIPMENT, {
            _id: 1, order_id: 1, agency_id: 1, agent_id: 1, status: 1, tracking_number: 1,
            delivery_fee_snapshot: 1, delivery_payer: 1, customer_delivery_fee: 1, 'status_history.status': 1, 'status_history.changed_at': 1,
            'status_history.changed_by_role': 1, created_at: 1,
        });
    }

    byIds(ids: ObjectId[]): Promise<ShipmentRow[]> {
        if (ids.length === 0) return Promise.resolve([]);
        return this.findBy({ _id: { $in: uniq(ids) } } as Filter<ShipmentRow>);
    }

    forOrders(ids: ObjectId[]): Promise<ShipmentRow[]> {
        if (ids.length === 0) return Promise.resolve([]);
        return this.findBy({ order_id: { $in: uniq(ids) } } as Filter<ShipmentRow>, { sort: { created_at: 1 } });
    }
}

export interface CollectionRow extends Document {
    _id: ObjectId;
    order_id: ObjectId;
    shipment_id: ObjectId;
    agency_id: ObjectId;
    agent_id: ObjectId;
    vendor_id: ObjectId;
    /** The cash to collect: `items_amount + delivery_fee_amount` since ADR-A11. */
    expected_amount: number;
    /** The goods part; null on rows before ADR-A11 (all of whose cash was goods). */
    items_amount?: number | null;
    /** Customer-paid delivery handed to the agent with the goods; null before ADR-A11. */
    delivery_fee_amount?: number | null;
    currency: string;
    status: string;
    collected_at?: Date | null;
    verification?: { method?: string } | null;
    settled_amount: number;
    settled_at?: Date | null;
}

export class StatementCashCollectionRepository extends PlatformReadRepository<CollectionRow> {
    constructor() {
        super(COLLECTIONS.CASH_COLLECTION, {
            _id: 1, order_id: 1, shipment_id: 1, agency_id: 1, agent_id: 1, vendor_id: 1,
            expected_amount: 1, items_amount: 1, delivery_fee_amount: 1, currency: 1, status: 1, collected_at: 1,
            'verification.method': 1,
            settled_amount: 1, settled_at: 1,
        });
    }

    byIds(ids: ObjectId[]): Promise<CollectionRow[]> {
        if (ids.length === 0) return Promise.resolve([]);
        return this.findBy({ _id: { $in: uniq(ids) } } as Filter<CollectionRow>);
    }

    forOrders(ids: ObjectId[]): Promise<CollectionRow[]> {
        if (ids.length === 0) return Promise.resolve([]);
        return this.findBy({ order_id: { $in: uniq(ids) } } as Filter<CollectionRow>);
    }

    /** Cash collected by / for this owner in the period. `field` is `agency_id` or `agent_id`. */
    collectedFor(field: 'agency_id' | 'agent_id', id: string, range: Range): Promise<CollectionRow[]> {
        return this.findBy({ [field]: oid(id), collected_at: inRange(range) } as Filter<CollectionRow>, {
            sort: { collected_at: 1, _id: 1 },
        });
    }
}

export interface DepositRow extends Document {
    _id: ObjectId;
    agent_id: ObjectId;
    agency_id: ObjectId;
    amount: number;
    currency: string;
    recipient: string;
    status: string;
    reference?: string | null;
    declared_at?: Date | null;
    recorded_by_source?: string | null;
    recorded_by_name?: string | null;
    resolved_at?: Date | null;
    rejection_reason?: string | null;
    created_at: Date;
}

export class StatementDepositRepository extends PlatformReadRepository<DepositRow> {
    constructor() {
        super(COLLECTIONS.AGENT_DEPOSIT, {
            _id: 1, agent_id: 1, agency_id: 1, amount: 1, currency: 1, recipient: 1, status: 1,
            reference: 1, declared_at: 1, recorded_by_source: 1, recorded_by_name: 1, resolved_at: 1,
            rejection_reason: 1, created_at: 1,
        });
    }

    /** Deposits created in the period (declared by the agent, or recorded by the agency). */
    createdFor(field: 'agency_id' | 'agent_id', id: string, range: Range): Promise<DepositRow[]> {
        return this.findBy({ [field]: oid(id), created_at: inRange(range) } as Filter<DepositRow>, {
            sort: { created_at: 1, _id: 1 },
        });
    }
}

export interface RemittanceRow extends Document {
    _id: ObjectId;
    agency_id: ObjectId;
    amount: number;
    currency: string;
    reference?: string | null;
    status: string;
    declared_at: Date;
    resolved_at?: Date | null;
    resolved_by_source?: string | null;
    resolved_by_name?: string | null;
    rejection_reason?: string | null;
}

export class StatementRemittanceRepository extends PlatformReadRepository<RemittanceRow> {
    constructor() {
        super(COLLECTIONS.AGENCY_REMITTANCE, {
            _id: 1, agency_id: 1, amount: 1, currency: 1, reference: 1, status: 1, declared_at: 1,
            resolved_at: 1, resolved_by_source: 1, resolved_by_name: 1, rejection_reason: 1,
        });
    }

    declaredFor(agencyId: string, range: Range): Promise<RemittanceRow[]> {
        return this.findBy({ agency_id: oid(agencyId), declared_at: inRange(range) } as Filter<RemittanceRow>, {
            sort: { declared_at: 1, _id: 1 },
        });
    }

    /**
     * Confirmed remittances of these agencies — to name which one settled a vendor's COD cash.
     * There is no stored link (the FIFO settlement stamps `settled_at` only), so the builder
     * matches on instant; see `matchRemittance`.
     */
    confirmedFor(agencyIds: ObjectId[]): Promise<RemittanceRow[]> {
        if (agencyIds.length === 0) return Promise.resolve([]);
        return this.findBy({ agency_id: { $in: uniq(agencyIds) }, status: 'confirmed' } as Filter<RemittanceRow>);
    }
}

export interface ReserveHoldRow extends Document {
    _id: ObjectId;
    owner_id: ObjectId;
    amount: number;
    currency: string;
    source_allocation_id: ObjectId;
    status: string;
    held_at: Date;
    release_at: Date;
    released_at?: Date | null;
}

export class StatementReserveHoldRepository extends PlatformReadRepository<ReserveHoldRow> {
    constructor() {
        super(COLLECTIONS.EARNINGS_RESERVE_HOLD, {
            _id: 1, owner_id: 1, amount: 1, currency: 1, source_allocation_id: 1, status: 1,
            held_at: 1, release_at: 1, released_at: 1,
        });
    }

    /** Held OR released in the period — both move money between the agency's balances. */
    touchedFor(agencyId: string, range: Range): Promise<ReserveHoldRow[]> {
        return this.findBy(
            {
                owner_id: oid(agencyId),
                $or: [{ held_at: inRange(range) }, { released_at: inRange(range) }],
            } as Filter<ReserveHoldRow>,
            { sort: { held_at: 1, _id: 1 } },
        );
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// payout_requests · credits · plans · bookings
// ─────────────────────────────────────────────────────────────────────────────

export interface PayoutRow extends Document {
    _id: ObjectId;
    amount: number;
    currency: string;
    status: string;
    origin?: string;
    payout_method_snapshot?: {
        method?: string;
        mobile_money?: { provider?: string } | null;
        bank?: { bank_name?: string } | null;
    } | null;
    paid_reference?: string | null;
    rejection_reason?: string | null;
    transfer_failure_reason?: string | null;
    resolved_at?: Date | null;
    resolved_by_name?: string | null;
    created_at: Date;
}

export class StatementPayoutRepository extends PlatformReadRepository<PayoutRow> {
    constructor() {
        super(COLLECTIONS.PAYOUT_REQUEST, {
            _id: 1, amount: 1, currency: 1, status: 1, origin: 1,
            // The KIND and the provider — never the account number. See the header.
            'payout_method_snapshot.method': 1,
            'payout_method_snapshot.mobile_money.provider': 1,
            'payout_method_snapshot.bank.bank_name': 1,
            paid_reference: 1, rejection_reason: 1, transfer_failure_reason: 1,
            resolved_at: 1, resolved_by_name: 1, created_at: 1,
        });
    }

    /** Requested OR resolved in the period. */
    touchedFor(type: string, id: string, range: Range): Promise<PayoutRow[]> {
        return this.findBy(
            {
                owner_type: type,
                owner_id: oid(id),
                $or: [{ created_at: inRange(range) }, { resolved_at: inRange(range) }],
            } as Filter<PayoutRow>,
            { sort: { created_at: 1, _id: 1 } },
        );
    }
}

export interface CreditTxRow extends Document {
    _id: ObjectId;
    type: string;
    amount: number;
    balance_after: number;
    reason_code: string;
    ref?: string | null;
    created_at: Date;
}

export class StatementCreditTxRepository extends PlatformReadRepository<CreditTxRow> {
    constructor() {
        super(COLLECTIONS.CREDIT_TRANSACTION, { _id: 1, type: 1, amount: 1, balance_after: 1, reason_code: 1, ref: 1, created_at: 1 });
    }

    createdFor(type: string, id: string, range: Range): Promise<CreditTxRow[]> {
        return this.findBy({ owner_type: type, owner_id: oid(id), created_at: inRange(range) } as Filter<CreditTxRow>, {
            sort: { created_at: 1, _id: 1 },
        });
    }
}

export interface CreditTopupRow extends Document {
    _id: ObjectId;
    pack_code: string;
    credits: number;
    price: number;
    currency: string;
    status: string;
    gateway?: string | null;
    gateway_ref?: string | null;
    /** Written by jovi-mall from 2026-09-27; null before. */
    paid_at?: Date | null;
    created_at: Date;
    updated_at: Date;
}

export class StatementCreditTopupRepository extends PlatformReadRepository<CreditTopupRow> {
    constructor() {
        super(COLLECTIONS.CREDIT_TOPUP, {
            _id: 1, pack_code: 1, credits: 1, price: 1, currency: 1, status: 1, gateway: 1,
            gateway_ref: 1, paid_at: 1, created_at: 1, updated_at: 1,
        });
    }

    createdFor(type: string, id: string, range: Range): Promise<CreditTopupRow[]> {
        return this.findBy({ owner_type: type, owner_id: oid(id), created_at: inRange(range) } as Filter<CreditTopupRow>, {
            sort: { created_at: 1, _id: 1 },
        });
    }
}

export interface PlanPurchaseRow extends Document {
    _id: ObjectId;
    plan_code: string;
    price: number;
    currency: string;
    status: string;
    gateway?: string | null;
    gateway_ref?: string | null;
    /** Written by jovi-mall from 2026-09-27; null before. */
    paid_at?: Date | null;
    created_at: Date;
    updated_at: Date;
}

export class StatementPlanPurchaseRepository extends PlatformReadRepository<PlanPurchaseRow> {
    constructor() {
        super(COLLECTIONS.PLAN_PURCHASE, {
            _id: 1, plan_code: 1, price: 1, currency: 1, status: 1, gateway: 1, gateway_ref: 1,
            paid_at: 1, created_at: 1, updated_at: 1,
        });
    }

    createdFor(type: string, id: string, range: Range): Promise<PlanPurchaseRow[]> {
        return this.findBy({ owner_type: type, owner_id: oid(id), created_at: inRange(range) } as Filter<PlanPurchaseRow>, {
            sort: { created_at: 1, _id: 1 },
        });
    }
}

export interface SubscriberPlanRow extends Document {
    _id: ObjectId;
    plan_code: string;
    status: string;
    started_at?: Date | null;
    expires_at?: Date | null;
    assigned_by_source?: string | null;
    assigned_by_name?: string | null;
    payment_reference?: string | null;
    created_at: Date;
}

export class StatementSubscriberPlanRepository extends PlatformReadRepository<SubscriberPlanRow> {
    constructor() {
        super(COLLECTIONS.SUBSCRIBER_PLAN, {
            _id: 1, plan_code: 1, status: 1, started_at: 1, expires_at: 1, assigned_by_source: 1,
            assigned_by_name: 1, payment_reference: 1, created_at: 1,
        });
    }

    /** Subscriptions in force at any point of the period, or created in it. */
    overlapping(type: string, id: string, range: Range): Promise<SubscriberPlanRow[]> {
        return this.findBy(
            {
                owner_type: type,
                owner_id: oid(id),
                $or: [
                    { created_at: inRange(range) },
                    {
                        started_at: { $lt: range.end },
                        $or: [{ expires_at: null }, { expires_at: { $gte: range.start } }],
                    },
                ],
            } as Filter<SubscriberPlanRow>,
            { sort: { created_at: 1, _id: 1 } },
        );
    }
}

export interface BookingRow extends Document {
    _id: ObjectId;
    bookingNumber?: string | null;
    userId?: ObjectId | null;
    startAt?: Date | null;
    status: string;
    /**
     * jovi-mall's booking payment status, shown as written. Since the refund flow (2026-10-05)
     * `refund_pending` means "a refund REQUEST is open on this booking" (`refund_requests`),
     * no longer "a support ticket waits for a manual payout".
     */
    paymentStatus?: string;
    paymentMethod?: string | null;
    paidAt?: Date | null;
    priceSnapshot?: number;
    currency?: string;
    createdAt?: Date;
}

export class StatementBookingRepository extends PlatformReadRepository<BookingRow> {
    constructor() {
        super(COLLECTIONS.BOOKING, {
            _id: 1, bookingNumber: 1, userId: 1, startAt: 1, status: 1, paymentStatus: 1,
            paymentMethod: 1, paidAt: 1, priceSnapshot: 1, currency: 1, createdAt: 1,
        });
    }

    byIds(ids: ObjectId[]): Promise<BookingRow[]> {
        if (ids.length === 0) return Promise.resolve([]);
        return this.findBy({ _id: { $in: uniq(ids) } } as Filter<BookingRow>);
    }
}
