import { Document, ObjectId } from 'mongodb';
import { COLLECTIONS } from '../../../infra/platform/collections';
import { PlatformCollection } from '../../../infra/platform/platform-collections';
import { PermissionName } from '../../authorization/domain/permission.catalog';
import {
    TRANSACTION_KINDS,
    TransactionDirection,
    TransactionGroup,
    TransactionKind,
    TransactionLinksDto,
    TransactionOutcome,
    TransactionRecordDto,
    TransactionRole,
    TransactionRowDto,
    TransactionSummaryGroupDto,
} from '../read-models/transaction.dto';

/**
 * The eleven sources behind `GET /money/transactions` (BR-027), and everything about them that
 * is a RULE rather than a query: which collection a kind lives in, what leaves it, how the
 * unified filter translates into that collection's own fields, and how a row maps to the
 * wire. Pure — no database, no request — so `test:transactions` asserts all of it offline.
 *
 * ── Why one spec per kind, and not one pipeline ───────────────────────────────
 * The eleven collections share no shape: `payment_transactions` is camelCase with UPPERCASE
 * statuses, the rest snake_case; a ledger row has no currency; a deposit's direction depends
 * on who received it. Each source therefore states its own field names, status buckets and
 * projection, and `buildSourceFilter` turns ONE unified filter into eleven native ones. A
 * filter on a column a kind does not carry (`provider` on a ledger row) means that kind
 * cannot match, so its source is not queried at all — `null`, never "ignore the term".
 *
 * ── Every filter runs in the database ─────────────────────────────────────────
 * Including the derived ones. `outcome`, `direction`, `role` and `reasonCode` are not stored
 * anywhere; each translates to a predicate on stored fields (`outcome=failed` on a payout is
 * `status ∈ {failed, rejected}`), so no row is ever filtered after it was paged.
 *
 * ── The projections are whitelists, and deliberately NARROWER than the kinds' own ──
 * These are second readers of collections that already have a repository, which this
 * service normally avoids. They are separate because the list needs a dozen fields per kind,
 * not the full record, and a narrow whitelist is the safer one to have on a route every tier
 * can reach. The payout one names the destination's TYPE and provider label and nothing
 * else — no account name, no digits; `test:money` § 3 scans this file with the rest.
 */

// ─────────────────────────────────────────────────────────────────────────────
// The unified filter
// ─────────────────────────────────────────────────────────────────────────────

export interface TransactionFilter {
    kind?: readonly TransactionKind[];
    group?: readonly TransactionGroup[];
    direction?: readonly TransactionDirection[];
    role?: readonly TransactionRole[];
    partyId?: string;
    provider?: readonly string[];
    gateway?: readonly string[];
    method?: readonly string[];
    outcome?: readonly TransactionOutcome[];
    status?: readonly string[];
    amount?: number;
    amountMin?: number;
    amountMax?: number;
    amountGt?: number;
    amountLt?: number;
    reasonCode?: readonly string[];
    reference?: string;
    orderId?: string;
    bookingId?: string;
    /** Half-open `[from, to)` on the row's creation instant. Always resolved — see `resolveWindow`. */
    from: Date;
    to: Date;
}

/** What the caller may be sent. Built from the reads they already hold — see `viewerFor`. */
export interface TransactionViewer {
    kinds: ReadonlySet<TransactionKind>;
    /** Rows owned by the platform's own accounts (`platform`, `platform_ai`). Needs `PLATFORM_AMOUNTS_PERMISSION`. */
    seesPlatformAccounts: boolean;
}

export const TRANSACTION_SORT_FIELDS = ['createdAt', 'amount'] as const;
export type TransactionSortField = (typeof TRANSACTION_SORT_FIELDS)[number];

export interface TransactionSort {
    field: TransactionSortField;
    direction: 1 | -1;
}

/**
 * What a caller must hold to be sent the platform's own amounts — here, on the three
 * `/money/earnings/platform*` routes, and on the order split. One name, so the owner's rule
 * ("Admin and Support see the platform's take as rates, never as amounts") is one grant
 * rather than a tier comparison repeated in three places. Tier 1 alone holds it.
 */
export const PLATFORM_AMOUNTS_PERMISSION: PermissionName = 'money.earnings.platform.read';

/** The owner types that are the marketplace's own accounts, not somebody's earnings. */
export const PLATFORM_OWNER_TYPES = ['platform', 'platform_ai'] as const;

// ─────────────────────────────────────────────────────────────────────────────
// The source spec
// ─────────────────────────────────────────────────────────────────────────────

type OutcomeBuckets = Readonly<Record<Exclude<TransactionOutcome, 'unknown'>, readonly string[]>>;

/** What a mapper needs beyond the row: names and (for the ledger) account currencies. */
export interface TransactionRowContext {
    /** Keyed `partyKey(role, id)`. */
    names: ReadonlyMap<string, string | null>;
    /** `earnings_accounts._id` → currency, for ledger rows. */
    currencies: ReadonlyMap<string, string>;
}

export function partyKey(role: string, id: string | null): string {
    return `${role}:${id ?? 'null'}`;
}

export interface TransactionSource {
    kind: TransactionKind;
    group: TransactionGroup;
    /** ALL required — exactly the reads this kind's own screens require today. */
    permissions: readonly PermissionName[];
    collection: PlatformCollection;
    projection: Document;
    fields: { createdAt: string; amount: string; status: string; currency: string | null };
    outcomes: OutcomeBuckets;
    /** Always applied. Only `delivery_fee_refund` has one — see its source. */
    base?: Document;
    /** Static, or read off one field (a deposit's `recipient`). */
    direction:
        | TransactionDirection
        | { field: string; values: Readonly<Record<string, TransactionDirection>>; otherwise: TransactionDirection };
    /** Static, or the stored owner type. */
    role: { fixed: TransactionRole } | { field: string };
    partyIdField: string;
    gatewayField?: string;
    providerField?: string;
    methodField?: string;
    referenceFields: readonly string[];
    order?: (id: ObjectId) => Document;
    booking?: (id: ObjectId) => Document;
    /**
     * Why the money moved. Either a closed set this service derives — each code with the
     * predicate that selects it (`{}` = every row of the kind) — or the kind's own stored
     * code, passed through.
     */
    reasons: { codes: Readonly<Record<string, Document>> } | { field: string };
    /** The existing full read, for the kinds that have one. */
    recordPath?: (id: string) => string;
    party(row: Document): { role: string; id: string | null };
    toRow(row: Document, context: TransactionRowContext): TransactionRowDto;
    /** Kind-specific facts for the detail read. Absent on kinds with a `recordPath`. */
    toRecord?(row: Document, context: TransactionRowContext): TransactionRecordDto;
}

// ─────────────────────────────────────────────────────────────────────────────
// Small mappers
// ─────────────────────────────────────────────────────────────────────────────

function iso(value: unknown): string | null {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value as string);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function id(value: unknown): string | null {
    return value ? String(value) : null;
}

function text(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function links(partial: Partial<TransactionLinksDto>): TransactionLinksDto {
    return {
        orderIds: partial.orderIds ?? [],
        bookingId: partial.bookingId ?? null,
        shipmentId: partial.shipmentId ?? null,
        paymentTransactionId: partial.paymentTransactionId ?? null,
        refundRequestId: partial.refundRequestId ?? null,
        ticketId: partial.ticketId ?? null,
        allocationId: partial.allocationId ?? null,
        planId: partial.planId ?? null,
        vendorId: partial.vendorId ?? null,
        agencyId: partial.agencyId ?? null,
        agentId: partial.agentId ?? null,
        payoutId: partial.payoutId ?? null,
    };
}

export function outcomeOf(source: Pick<TransactionSource, 'outcomes'>, status: string): TransactionOutcome {
    if (source.outcomes.succeeded.includes(status)) return 'succeeded';
    if (source.outcomes.pending.includes(status)) return 'pending';
    if (source.outcomes.failed.includes(status)) return 'failed';
    if (source.outcomes.reversed.includes(status)) return 'reversed';
    return 'unknown';
}

export function directionOf(source: Pick<TransactionSource, 'direction'>, row: Document): TransactionDirection {
    if (typeof source.direction === 'string') return source.direction;
    return source.direction.values[String(row[source.direction.field])] ?? source.direction.otherwise;
}

/** The fields every source fills the same way; the mapper supplies the rest. */
function baseRow(
    source: TransactionSource,
    row: Document,
    context: TransactionRowContext,
): Pick<TransactionRowDto, 'kind' | 'id' | 'group' | 'direction' | 'party' | 'amount' | 'status' | 'outcome' | 'createdAt'> {
    const party = source.party(row);
    const status = String(row[source.fields.status] ?? '');
    return {
        kind: source.kind,
        id: String(row._id),
        group: source.group,
        direction: directionOf(source, row),
        party: { ...party, name: context.names.get(partyKey(party.role, party.id)) ?? null },
        amount: Number(row[source.fields.amount] ?? 0),
        status,
        outcome: outcomeOf(source, status),
        createdAt: iso(row[source.fields.createdAt]),
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// The eleven sources
// ─────────────────────────────────────────────────────────────────────────────

const PRIMARY_PURPOSE = { $nin: ['booking_balance', 'order_delivery_topup'] };

const PAYMENT_ROW_PROJECTION = {
    _id: 1,
    orderId: 1,
    orderIds: 1,
    bookingId: 1,
    purpose: 1,
    'deliveryTopup.shipmentId': 1,
    userId: 1,
    gateway: 1,
    provider: 1,
    method: 1,
    gatewayRef: 1,
    merchantRef: 1,
    status: 1,
    amountSnapshot: 1,
    currencySnapshot: 1,
    createdAt: 1,
    paidAt: 1,
} as const;

/** A customer paying for an order, a cart, a booking, a booking balance or a delivery top-up. */
const PAYMENT: TransactionSource = {
    kind: 'payment',
    group: 'provider',
    permissions: ['money.payments.read'],
    collection: COLLECTIONS.PAYMENT_TRANSACTION,
    projection: PAYMENT_ROW_PROJECTION,
    fields: { createdAt: 'createdAt', amount: 'amountSnapshot', status: 'status', currency: 'currencySnapshot' },
    outcomes: {
        succeeded: ['SUCCEEDED'],
        pending: ['INITIATED', 'PENDING'],
        failed: ['FAILED', 'CANCELLED'],
        reversed: ['REFUNDED'],
    },
    direction: 'in',
    role: { fixed: 'customer' },
    partyIdField: 'userId',
    gatewayField: 'gateway',
    providerField: 'provider',
    methodField: 'method',
    referenceFields: ['gatewayRef', 'merchantRef'],
    // A cart checkout is ONE payment for N orders and sets `orderIds`, not `orderId`.
    order: (orderId) => ({ $or: [{ orderId }, { orderIds: orderId }] }),
    booking: (bookingId) => ({ bookingId }),
    reasons: {
        codes: {
            order_payment: { purpose: PRIMARY_PURPOSE, bookingId: null },
            booking_payment: { purpose: PRIMARY_PURPOSE, bookingId: { $ne: null } },
            booking_balance: { purpose: 'booking_balance' },
            delivery_topup: { purpose: 'order_delivery_topup' },
        },
    },
    recordPath: (paymentId) => `/money/payments/${paymentId}`,
    party: (row) => ({ role: 'customer', id: id(row.userId) }),
    toRow(row, context) {
        const purpose = row.purpose ?? 'primary';
        const code = purpose === 'booking_balance'
            ? 'booking_balance'
            : purpose === 'order_delivery_topup'
                ? 'delivery_topup'
                : row.bookingId ? 'booking_payment' : 'order_payment';
        const orderIds = row.orderId
            ? [String(row.orderId)]
            : ((row.orderIds ?? []) as unknown[]).map(String);
        return {
            ...baseRow(this, row, context),
            currency: text(row.currencySnapshot),
            gateway: text(row.gateway),
            provider: text(row.provider),
            method: text(row.method),
            reason: { code, text: null },
            reference: text(row.gatewayRef),
            merchantRef: text(row.merchantRef),
            links: links({ orderIds, bookingId: id(row.bookingId), shipmentId: id(row.deliveryTopup?.shipmentId) }),
            completedAt: iso(row.paidAt),
        };
    },
};

const PLAN_PURCHASE_ROW_PROJECTION = {
    _id: 1,
    owner_type: 1,
    owner_id: 1,
    plan_id: 1,
    plan_code: 1,
    price: 1,
    currency: 1,
    status: 1,
    gateway: 1,
    provider: 1,
    gateway_ref: 1,
    merchant_ref: 1,
    subscriber_plan_id: 1,
    created_at: 1,
    paid_at: 1,
} as const;

const BILLING_OUTCOMES: OutcomeBuckets = {
    succeeded: ['paid'],
    pending: ['pending'],
    failed: ['failed'],
    reversed: ['reversed'],
};

/** A vendor, agency or agent buying a plan. Writes no `payment_transactions` row (BR-027 D-1). */
const PLAN_PURCHASE: TransactionSource = {
    kind: 'plan_purchase',
    group: 'provider',
    permissions: ['money.earnings.read', 'billing.plans.read'],
    collection: COLLECTIONS.PLAN_PURCHASE,
    projection: PLAN_PURCHASE_ROW_PROJECTION,
    fields: { createdAt: 'created_at', amount: 'price', status: 'status', currency: 'currency' },
    outcomes: BILLING_OUTCOMES,
    direction: 'in',
    role: { field: 'owner_type' },
    partyIdField: 'owner_id',
    gatewayField: 'gateway',
    providerField: 'provider',
    referenceFields: ['gateway_ref', 'merchant_ref'],
    reasons: { codes: { plan_purchase: {} } },
    party: (row) => ({ role: String(row.owner_type), id: id(row.owner_id) }),
    toRow(row, context) {
        return {
            ...baseRow(this, row, context),
            currency: text(row.currency),
            gateway: text(row.gateway),
            provider: text(row.provider),
            method: null,
            reason: { code: 'plan_purchase', text: text(row.plan_code) },
            reference: text(row.gateway_ref),
            merchantRef: text(row.merchant_ref),
            links: links({ planId: id(row.plan_id) }),
            completedAt: iso(row.paid_at),
        };
    },
    toRecord: (row) => ({
        kind: 'plan_purchase',
        planId: id(row.plan_id),
        planCode: String(row.plan_code ?? ''),
        subscriberPlanId: id(row.subscriber_plan_id),
    }),
};

const CREDIT_TOPUP_ROW_PROJECTION = {
    _id: 1,
    owner_type: 1,
    owner_id: 1,
    pack_code: 1,
    credits: 1,
    price: 1,
    currency: 1,
    status: 1,
    gateway: 1,
    provider: 1,
    gateway_ref: 1,
    merchant_ref: 1,
    created_at: 1,
    paid_at: 1,
} as const;

/** Money for credits. The MONEY is the row; the credits are on the record. */
const CREDIT_TOPUP: TransactionSource = {
    kind: 'credit_topup',
    group: 'provider',
    permissions: ['money.earnings.read', 'billing.plans.read'],
    collection: COLLECTIONS.CREDIT_TOPUP,
    projection: CREDIT_TOPUP_ROW_PROJECTION,
    fields: { createdAt: 'created_at', amount: 'price', status: 'status', currency: 'currency' },
    outcomes: BILLING_OUTCOMES,
    direction: 'in',
    role: { field: 'owner_type' },
    partyIdField: 'owner_id',
    gatewayField: 'gateway',
    providerField: 'provider',
    referenceFields: ['gateway_ref', 'merchant_ref'],
    reasons: { codes: { credit_topup: {} } },
    party: (row) => ({ role: String(row.owner_type), id: id(row.owner_id) }),
    toRow(row, context) {
        return {
            ...baseRow(this, row, context),
            currency: text(row.currency),
            gateway: text(row.gateway),
            provider: text(row.provider),
            method: null,
            reason: { code: 'credit_topup', text: text(row.pack_code) },
            reference: text(row.gateway_ref),
            merchantRef: text(row.merchant_ref),
            links: links({}),
            completedAt: iso(row.paid_at),
        };
    },
    toRecord: (row) => ({
        kind: 'credit_topup',
        packCode: String(row.pack_code ?? ''),
        credits: Number(row.credits ?? 0),
    }),
};

const REFUND_ROW_PROJECTION = {
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
    refundRequestId: 1,
    channel: 1,
    feeAmount: 1,
    netAmount: 1,
    initiatedBy: 1,
    initiatedByRole: 1,
    createdAt: 1,
    completedAt: 1,
} as const;

/**
 * Money returned to a customer. A refund sent by mobile-money transfer (`channel: payout`)
 * is THIS row and no `payout_requests` row (BR-027 D-2).
 */
const REFUND: TransactionSource = {
    kind: 'refund',
    group: 'provider',
    permissions: ['money.payments.read'],
    collection: COLLECTIONS.REFUND_TRANSACTION,
    projection: REFUND_ROW_PROJECTION,
    fields: { createdAt: 'createdAt', amount: 'refundAmount', status: 'status', currency: 'currency' },
    outcomes: { succeeded: ['completed'], pending: ['pending'], failed: ['failed'], reversed: [] },
    direction: 'out',
    role: { fixed: 'customer' },
    partyIdField: 'userId',
    gatewayField: 'gateway',
    methodField: 'channel',
    referenceFields: ['gatewayRefundRef'],
    order: (orderId) => ({ orderId }),
    booking: (bookingId) => ({ bookingId }),
    reasons: { codes: { refund: {} } },
    party: (row) => ({ role: 'customer', id: id(row.userId) }),
    toRow(row, context) {
        return {
            ...baseRow(this, row, context),
            currency: text(row.currency),
            gateway: text(row.gateway),
            provider: null,
            method: text(row.channel),
            reason: { code: 'refund', text: text(row.reason) },
            reference: text(row.gatewayRefundRef),
            merchantRef: null,
            links: links({
                orderIds: row.orderId ? [String(row.orderId)] : [],
                bookingId: id(row.bookingId),
                paymentTransactionId: id(row.paymentTransactionId),
                refundRequestId: id(row.refundRequestId),
                vendorId: id(row.vendorId),
            }),
            completedAt: iso(row.completedAt),
        };
    },
    toRecord: (row, context) => ({
        kind: 'refund',
        channel: text(row.channel),
        feeAmount: typeof row.feeAmount === 'number' ? row.feeAmount : null,
        netAmount: typeof row.netAmount === 'number' ? row.netAmount : null,
        initiatedBy: { id: id(row.initiatedBy), role: String(row.initiatedByRole ?? '') },
        vendor: {
            id: id(row.vendorId),
            name: context.names.get(partyKey('vendor', id(row.vendorId))) ?? null,
        },
    }),
};

const DELIVERY_FEE_REFUND_ROW_PROJECTION = {
    _id: 1,
    order_id: 1,
    shipment_id: 1,
    customer_id: 1,
    vendor_id: 1,
    amount: 1,
    currency: 1,
    status: 1,
    note: 1,
    ticket_id: 1,
    settled_at: 1,
    'settlement.method': 1,
    'settlement.reference': 1,
    'settlement.note': 1,
    created_at: 1,
} as const;

/** The settlement methods that mean a person actually sent money. `covered_by_order_refund` moved none. */
export const HAND_SETTLEMENT_METHODS = ['mobile_money', 'cash', 'bank', 'other'] as const;

/**
 * Delivery money returned to a customer BY HAND — the ninth kind (BR-027 D-3).
 *
 * ⚠ **Not every `delivery_fee_refunds` row, and the `base` filter is what prevents a double
 * count.** A row the gateway or a refund request settled already has a `refund_transactions`
 * row, which is the `refund` kind. Only two states have no other record: still owed and
 * waiting for a person (`manual_required`), and settled by an administrator with money
 * (`completed` with one of the four hand methods).
 */
const DELIVERY_FEE_REFUND: TransactionSource = {
    kind: 'delivery_fee_refund',
    group: 'provider',
    permissions: ['money.payments.read'],
    collection: COLLECTIONS.DELIVERY_FEE_REFUND,
    projection: DELIVERY_FEE_REFUND_ROW_PROJECTION,
    fields: { createdAt: 'created_at', amount: 'amount', status: 'status', currency: 'currency' },
    outcomes: { succeeded: ['completed'], pending: ['manual_required'], failed: [], reversed: [] },
    // Leads with `status` so `{status, created_at}` (the admin queue index) selects first.
    base: {
        status: { $in: ['manual_required', 'completed'] },
        $or: [
            { status: 'manual_required' },
            { 'settlement.method': { $in: [...HAND_SETTLEMENT_METHODS] } },
        ],
    },
    direction: 'out',
    role: { fixed: 'customer' },
    partyIdField: 'customer_id',
    methodField: 'settlement.method',
    referenceFields: ['settlement.reference'],
    order: (orderId) => ({ order_id: orderId }),
    reasons: { codes: { delivery_fee_refund: {} } },
    recordPath: (refundId) => `/money/delivery-fee-refunds/${refundId}`,
    party: (row) => ({ role: 'customer', id: id(row.customer_id) }),
    toRow(row, context) {
        return {
            ...baseRow(this, row, context),
            currency: text(row.currency),
            gateway: null,
            provider: null,
            method: text(row.settlement?.method),
            reason: { code: 'delivery_fee_refund', text: text(row.settlement?.note) ?? text(row.note) },
            reference: text(row.settlement?.reference),
            merchantRef: null,
            links: links({
                orderIds: row.order_id ? [String(row.order_id)] : [],
                shipmentId: id(row.shipment_id),
                ticketId: id(row.ticket_id),
                vendorId: id(row.vendor_id),
            }),
            completedAt: iso(row.settled_at),
        };
    },
};

const PAYOUT_ROW_PROJECTION = {
    _id: 1,
    owner_type: 1,
    owner_id: 1,
    amount: 1,
    currency: 1,
    status: 1,
    origin: 1,
    'payout_method_snapshot.method': 1,
    'payout_method_snapshot.mobile_money.provider': 1,
    ticket_id: 1,
    transfer_gateway: 1,
    transfer_gateway_ref: 1,
    transfer_failure_reason: 1,
    resolved_at: 1,
    paid_reference: 1,
    rejection_reason: 1,
    created_at: 1,
} as const;

/**
 * Earnings paid out to a vendor, an agency or an agent.
 *
 * `failed` here is a transfer that failed with the money STILL HELD — retryable, not closed.
 * It buckets as `failed` because that is what an operator filtering for failures wants to
 * find; `status` keeps the source's own word.
 */
const PAYOUT: TransactionSource = {
    kind: 'payout',
    group: 'provider',
    permissions: ['money.payouts.read'],
    collection: COLLECTIONS.PAYOUT_REQUEST,
    projection: PAYOUT_ROW_PROJECTION,
    fields: { createdAt: 'created_at', amount: 'amount', status: 'status', currency: 'currency' },
    outcomes: { succeeded: ['paid'], pending: ['pending', 'processing'], failed: ['failed', 'rejected'], reversed: [] },
    direction: 'out',
    role: { field: 'owner_type' },
    partyIdField: 'owner_id',
    gatewayField: 'transfer_gateway',
    providerField: 'payout_method_snapshot.mobile_money.provider',
    methodField: 'payout_method_snapshot.method',
    referenceFields: ['transfer_gateway_ref', 'paid_reference'],
    reasons: {
        codes: {
            payout_manual: { origin: { $ne: 'auto_threshold' } },
            payout_auto_threshold: { origin: 'auto_threshold' },
        },
    },
    recordPath: (payoutId) => `/money/payouts/${payoutId}`,
    party: (row) => ({ role: String(row.owner_type), id: id(row.owner_id) }),
    toRow(row, context) {
        return {
            ...baseRow(this, row, context),
            currency: text(row.currency),
            gateway: text(row.transfer_gateway),
            provider: text(row.payout_method_snapshot?.mobile_money?.provider),
            method: text(row.payout_method_snapshot?.method),
            reason: {
                code: row.origin === 'auto_threshold' ? 'payout_auto_threshold' : 'payout_manual',
                text: text(row.rejection_reason) ?? text(row.transfer_failure_reason),
            },
            reference: text(row.transfer_gateway_ref) ?? text(row.paid_reference),
            merchantRef: null,
            links: links({ ticketId: id(row.ticket_id) }),
            completedAt: iso(row.resolved_at),
        };
    },
};

const COD_OUTCOMES: OutcomeBuckets = {
    succeeded: ['confirmed'],
    pending: ['declared'],
    failed: ['rejected'],
    reversed: [],
};

const COD_DEPOSIT_ROW_PROJECTION = {
    _id: 1,
    agent_id: 1,
    agency_id: 1,
    amount: 1,
    currency: 1,
    note: 1,
    recipient: 1,
    status: 1,
    reference: 1,
    resolved_at: 1,
    rejection_reason: 1,
    created_at: 1,
} as const;

/**
 * An agent handing COD cash back. `in` when they paid the platform; `internal` when they
 * paid their agency — that cash has not reached us, and counting it `in` would overstate
 * what the platform holds (BR-027 D-5). It becomes `in` at the agency's remittance.
 */
const COD_DEPOSIT: TransactionSource = {
    kind: 'cod_deposit',
    group: 'cash',
    permissions: ['cod.deposits.read'],
    collection: COLLECTIONS.AGENT_DEPOSIT,
    projection: COD_DEPOSIT_ROW_PROJECTION,
    fields: { createdAt: 'created_at', amount: 'amount', status: 'status', currency: 'currency' },
    outcomes: COD_OUTCOMES,
    direction: { field: 'recipient', values: { platform: 'in' }, otherwise: 'internal' },
    role: { fixed: 'agent' },
    partyIdField: 'agent_id',
    referenceFields: ['reference'],
    reasons: {
        codes: {
            cod_deposit_to_platform: { recipient: 'platform' },
            cod_deposit_to_agency: { recipient: { $ne: 'platform' } },
        },
    },
    recordPath: (depositId) => `/cod/deposits/${depositId}`,
    party: (row) => ({ role: 'agent', id: id(row.agent_id) }),
    toRow(row, context) {
        return {
            ...baseRow(this, row, context),
            currency: text(row.currency),
            gateway: null,
            provider: null,
            method: null,
            reason: {
                code: row.recipient === 'platform' ? 'cod_deposit_to_platform' : 'cod_deposit_to_agency',
                text: text(row.rejection_reason) ?? text(row.note),
            },
            reference: text(row.reference),
            merchantRef: null,
            links: links({ agencyId: id(row.agency_id) }),
            completedAt: iso(row.resolved_at),
        };
    },
};

const COD_REMITTANCE_ROW_PROJECTION = {
    _id: 1,
    agency_id: 1,
    amount: 1,
    currency: 1,
    reference: 1,
    note: 1,
    status: 1,
    resolved_at: 1,
    rejection_reason: 1,
    created_at: 1,
} as const;

/** An agency handing COD cash up to the platform. */
const COD_REMITTANCE: TransactionSource = {
    kind: 'cod_remittance',
    group: 'cash',
    permissions: ['cod.remittances.read'],
    collection: COLLECTIONS.AGENCY_REMITTANCE,
    projection: COD_REMITTANCE_ROW_PROJECTION,
    fields: { createdAt: 'created_at', amount: 'amount', status: 'status', currency: 'currency' },
    outcomes: COD_OUTCOMES,
    direction: 'in',
    role: { fixed: 'agency' },
    partyIdField: 'agency_id',
    referenceFields: ['reference'],
    reasons: { codes: { cod_remittance: {} } },
    recordPath: (remittanceId) => `/cod/remittances/${remittanceId}`,
    party: (row) => ({ role: 'agency', id: id(row.agency_id) }),
    toRow(row, context) {
        return {
            ...baseRow(this, row, context),
            currency: text(row.currency),
            gateway: null,
            provider: null,
            method: null,
            reason: { code: 'cod_remittance', text: text(row.rejection_reason) ?? text(row.note) },
            reference: text(row.reference),
            merchantRef: null,
            links: links({}),
            completedAt: iso(row.resolved_at),
        };
    },
};

const COD_COLLECTION_ROW_PROJECTION = {
    _id: 1,
    order_id: 1,
    shipment_id: 1,
    agency_id: 1,
    agent_id: 1,
    customer_id: 1,
    vendor_id: 1,
    kind: 1,
    expected_amount: 1,
    items_amount: 1,
    delivery_fee_amount: 1,
    currency: 1,
    status: 1,
    collected_at: 1,
    settled_amount: 1,
    settled_at: 1,
    created_at: 1,
} as const;

/**
 * A customer paying cash at the door — the tenth kind (owner decision, BR-030).
 *
 * ── `internal`, and that is what keeps `in` meaning something ─────────────────
 * The cash is in the AGENT's hands, not the platform's. The same money is then the agent's
 * deposit (`internal` to their agency, or `in` to the platform) and the agency's remittance
 * (`in`): up to three rows for one banknote, of which exactly one is `in`. Counting the
 * collection `in` as well would count it twice.
 *
 * ── The amount ────────────────────────────────────────────────────────────────
 * `expected_amount`, which is the only amount the record has. A collection is all or
 * nothing — the agent enters the customer's code and the row turns `collected` — so on a
 * `collected` row it IS what was collected, and on a `pending` one it is what is due.
 *
 * ── What this projection must never name ──────────────────────────────────────
 * The delivery code's plaintext and its hash — submitting that code is the only path by
 * which a COD parcel becomes delivered, so either is a bearer credential over somebody
 * else's money — and the verification block, which holds the agent's GPS fix, IP and device.
 * jovi-mall's `select: false` protects nothing from the raw driver; this whitelist is the
 * guard, and `test:transactions` § 6 pins it by name.
 *
 * Graded on `shipments.read`: the shipment detail is where this record is already shown.
 */
const COD_COLLECTION: TransactionSource = {
    kind: 'cod_collection',
    group: 'cash',
    permissions: ['shipments.read'],
    collection: COLLECTIONS.CASH_COLLECTION,
    projection: COD_COLLECTION_ROW_PROJECTION,
    fields: { createdAt: 'created_at', amount: 'expected_amount', status: 'status', currency: 'currency' },
    outcomes: { succeeded: ['collected'], pending: ['pending'], failed: ['cancelled'], reversed: [] },
    direction: 'internal',
    role: { fixed: 'customer' },
    partyIdField: 'customer_id',
    referenceFields: [],
    order: (orderId) => ({ order_id: orderId }),
    reasons: {
        codes: {
            // `kind` is absent on rows written before a fee could be collected alone; all of those were goods.
            cod_order_payment: { kind: { $ne: 'delivery_fee' } },
            cod_delivery_fee: { kind: 'delivery_fee' },
        },
    },
    party: (row) => ({ role: 'customer', id: id(row.customer_id) }),
    toRow(row, context) {
        return {
            ...baseRow(this, row, context),
            currency: text(row.currency),
            gateway: null,
            provider: null,
            method: null,
            reason: { code: row.kind === 'delivery_fee' ? 'cod_delivery_fee' : 'cod_order_payment', text: null },
            reference: null,
            merchantRef: null,
            links: links({
                orderIds: row.order_id ? [String(row.order_id)] : [],
                shipmentId: id(row.shipment_id),
                vendorId: id(row.vendor_id),
                agencyId: id(row.agency_id),
                agentId: id(row.agent_id),
            }),
            completedAt: iso(row.collected_at),
        };
    },
    toRecord: (row, context) => {
        const total = Number(row.expected_amount ?? 0);
        const deliveryFeeAmount = Math.max(0, Number(row.delivery_fee_amount ?? 0));
        return {
            kind: 'cod_collection',
            collects: row.kind === 'delivery_fee' ? 'delivery_fee' : 'order',
            // `items_amount` is null on rows that predate the split; all of their cash was goods.
            itemsAmount: typeof row.items_amount === 'number' ? row.items_amount : Math.max(0, total - deliveryFeeAmount),
            deliveryFeeAmount,
            settledAmount: Number(row.settled_amount ?? 0),
            settledAt: iso(row.settled_at),
            agent: { id: id(row.agent_id), name: context.names.get(partyKey('agent', id(row.agent_id))) ?? null },
        };
    },
};

const LEDGER_ROW_PROJECTION = {
    _id: 1,
    account_id: 1,
    owner_type: 1,
    owner_id: 1,
    entry_type: 1,
    amount: 1,
    pending_after: 1,
    available_after: 1,
    source_type: 1,
    source_id: 1,
    allocation_id: 1,
    reason_code: 1,
    created_at: 1,
} as const;

/**
 * A movement on an earnings account. `status` is the entry type, and the outcome is always
 * `succeeded`: a ledger row is written in the transaction that moved the balance, so it
 * records something that happened. Its `completedAt` is its `createdAt`.
 */
const LEDGER_ENTRY: TransactionSource = {
    kind: 'ledger_entry',
    group: 'internal',
    permissions: ['money.earnings.read'],
    collection: COLLECTIONS.EARNINGS_LEDGER,
    projection: LEDGER_ROW_PROJECTION,
    fields: { createdAt: 'created_at', amount: 'amount', status: 'entry_type', currency: null },
    outcomes: {
        succeeded: [
            'hold', 'release', 'reversal', 'reserve_hold', 'reserve_release',
            'clawback', 'clawback_recovery', 'clawback_write_off',
        ],
        pending: [],
        failed: [],
        reversed: [],
    },
    direction: 'internal',
    role: { field: 'owner_type' },
    partyIdField: 'owner_id',
    referenceFields: [],
    order: (orderId) => ({ source_type: 'order', source_id: orderId }),
    booking: (bookingId) => ({ source_type: 'booking', source_id: bookingId }),
    reasons: { field: 'reason_code' },
    party: (row) => ({ role: String(row.owner_type), id: id(row.owner_id) }),
    toRow(row, context) {
        const sourceId = id(row.source_id);
        return {
            ...baseRow(this, row, context),
            currency: context.currencies.get(String(row.account_id)) ?? null,
            gateway: null,
            provider: null,
            method: null,
            reason: { code: String(row.reason_code ?? ''), text: null },
            reference: null,
            merchantRef: null,
            links: links({
                orderIds: row.source_type === 'order' && sourceId ? [sourceId] : [],
                bookingId: row.source_type === 'booking' ? sourceId : null,
                shipmentId: row.source_type === 'shipment' ? sourceId : null,
                allocationId: id(row.allocation_id),
            }),
            completedAt: iso(row.created_at),
        };
    },
    toRecord: (row) => ({
        kind: 'ledger_entry',
        accountId: id(row.account_id),
        entryType: String(row.entry_type ?? ''),
        balancesAfter: { pending: Number(row.pending_after ?? 0), available: Number(row.available_after ?? 0) },
        source: { type: String(row.source_type ?? ''), id: id(row.source_id) },
        // Filled by the detail read, which is the one caller that fetches the allocation.
        allocation: null,
    }),
};

const EARNINGS_ADJUSTMENT_ROW_PROJECTION = {
    _id: 1,
    refund_key: 1,
    allocation_id: 1,
    beneficiary_type: 1,
    beneficiary_id: 1,
    amount: 1,
    currency: 1,
    kind: 1,
    'actor.id': 1,
    'actor.name': 1,
    reason: 1,
    created_at: 1,
} as const;

/** `recovery:payout:<payoutRequestId>:<event>` — jovi-mall's key for debt paid down by a returned payout. */
const PAYOUT_RECOVERY_KEY = /^recovery:payout:([a-f\d]{24}):([a-z_]+)$/;

/**
 * Refund debt forgiven, or paid down by a payout that came back — the eleventh kind (owner
 * decision, BR-030). The two debt movements that write NO ledger row.
 *
 * ── Exactly which `earnings_adjustments` rows, and why not "the ones with no allocation" ──
 * That shortcut is wrong, and it was this file's first draft. Read against jovi-mall's
 * writers (`earnings-account.service.ts`, `earnings-clawback.service.ts`):
 *
 *   write_off                           never a ledger row            → THIS kind
 *   clawback_recovery, no allocation    a payout returned; no ledger  → THIS kind
 *   clawback_recovery, with allocation  writes a `clawback_recovery` ledger row → `ledger_entry`
 *   refund_clawback, with allocation    writes a `clawback` ledger row          → `ledger_entry`
 *   refund_clawback, no allocation      money charged to a vendor beyond their shares. It
 *                                       writes a ledger row whenever the vendor has a share
 *                                       on that sale to file it under — which is the normal
 *                                       case — so it is NOT here: listing it would repeat it.
 *
 * So the base filter names the two cases outright. `test:transactions` § 4 reads the writers
 * and fails if either starts writing a ledger row, or a third allocation-less writer appears.
 *
 * A debt is an owner's running balance, not one refund's: neither movement names an order or
 * a refund request, so those links are empty. A recovery names its payout, parsed from the key.
 */
const EARNINGS_ADJUSTMENT: TransactionSource = {
    kind: 'earnings_adjustment',
    group: 'internal',
    permissions: ['money.earnings.read'],
    collection: COLLECTIONS.EARNINGS_ADJUSTMENT,
    projection: EARNINGS_ADJUSTMENT_ROW_PROJECTION,
    // The stored `kind` stands where a status would: an adjustment has no lifecycle.
    fields: { createdAt: 'created_at', amount: 'amount', status: 'kind', currency: 'currency' },
    outcomes: { succeeded: ['write_off', 'clawback_recovery'], pending: [], failed: [], reversed: [] },
    base: {
        kind: { $in: ['write_off', 'clawback_recovery'] },
        $or: [{ kind: 'write_off' }, { allocation_id: null }],
    },
    direction: 'internal',
    role: { field: 'beneficiary_type' },
    partyIdField: 'beneficiary_id',
    referenceFields: [],
    reasons: {
        codes: {
            debt_write_off: { kind: 'write_off' },
            debt_recovered_from_payout: { kind: 'clawback_recovery' },
        },
    },
    party: (row) => ({ role: String(row.beneficiary_type), id: id(row.beneficiary_id) }),
    toRow(row, context) {
        const recovery = PAYOUT_RECOVERY_KEY.exec(String(row.refund_key ?? ''));
        return {
            ...baseRow(this, row, context),
            currency: text(row.currency),
            gateway: null,
            provider: null,
            method: null,
            reason: {
                code: row.kind === 'write_off' ? 'debt_write_off' : 'debt_recovered_from_payout',
                text: text(row.reason),
            },
            reference: null,
            merchantRef: null,
            links: links({ payoutId: recovery ? recovery[1] : null }),
            completedAt: iso(row.created_at),
        };
    },
    toRecord: (row) => {
        const recovery = PAYOUT_RECOVERY_KEY.exec(String(row.refund_key ?? ''));
        return {
            kind: 'earnings_adjustment',
            adjustment: String(row.kind ?? ''),
            actor: row.actor && (row.actor.id || row.actor.name)
                ? { id: text(row.actor.id), name: text(row.actor.name) }
                : null,
            payoutEvent: recovery ? recovery[2] : null,
        };
    },
};

export const TRANSACTION_SOURCES: Readonly<Record<TransactionKind, TransactionSource>> = Object.freeze({
    payment: PAYMENT,
    plan_purchase: PLAN_PURCHASE,
    credit_topup: CREDIT_TOPUP,
    refund: REFUND,
    delivery_fee_refund: DELIVERY_FEE_REFUND,
    payout: PAYOUT,
    cod_deposit: COD_DEPOSIT,
    cod_remittance: COD_REMITTANCE,
    cod_collection: COD_COLLECTION,
    ledger_entry: LEDGER_ENTRY,
    earnings_adjustment: EARNINGS_ADJUSTMENT,
});

// ─────────────────────────────────────────────────────────────────────────────
// Who may be sent what
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Graded by the reads the caller ALREADY holds — the new list grants nothing.
 *
 * A kind is visible when the caller holds every permission its own screens require, so
 * Support gets payments, refunds, payouts and the three COD kinds, and tiers 1–2 get all eleven.
 * `seesPlatformAccounts` is the owner's rule (2026-10-04): rows owned by the platform's own
 * accounts are what the marketplace earned, and only a holder of
 * `PLATFORM_AMOUNTS_PERMISSION` — tier 1 — is sent that figure.
 */
export function viewerFor(holds: (permission: PermissionName) => boolean): TransactionViewer {
    return {
        kinds: new Set(
            TRANSACTION_KINDS.filter((kind) => TRANSACTION_SOURCES[kind].permissions.every(holds)),
        ),
        seesPlatformAccounts: holds(PLATFORM_AMOUNTS_PERMISSION),
    };
}

/** The reads that open the route at all: any one makes at least one kind visible to somebody. */
export const TRANSACTION_DOOR_PERMISSIONS: readonly PermissionName[] = [
    'money.payments.read',
    'money.payouts.read',
    'cod.deposits.read',
    'cod.remittances.read',
    'money.earnings.read',
];

// ─────────────────────────────────────────────────────────────────────────────
// The unified filter → one source's native filter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `MTN`, `mtn` and `Mtn` for any of them. Gateway and provider names are stored UPPERCASE
 * and methods lowercase, while a payout's provider label is whatever its owner typed — so a
 * filter value is matched in the four spellings rather than refused or silently missed. An
 * equality `$in`, never a pattern: nothing here reaches a regex.
 */
export function caseVariants(values: readonly string[]): string[] {
    const variants = new Set<string>();
    for (const value of values) {
        const lower = value.toLowerCase();
        variants.add(value);
        variants.add(lower);
        variants.add(value.toUpperCase());
        variants.add(lower.charAt(0).toUpperCase() + lower.slice(1));
    }
    return [...variants];
}

function toObjectId(value: string): ObjectId | null {
    return /^[a-f\d]{24}$/i.test(value) ? new ObjectId(value) : null;
}

function anyOf(clauses: Document[]): Document {
    return clauses.length === 1 ? clauses[0] : { $or: clauses };
}

function directionClause(source: TransactionSource, wanted: readonly TransactionDirection[]): Document | null | true {
    if (typeof source.direction === 'string') return wanted.includes(source.direction) ? true : null;

    const { field, values, otherwise } = source.direction;
    const named = Object.entries(values);
    const matching = named.filter(([, direction]) => wanted.includes(direction)).map(([value]) => value);

    if (wanted.includes(otherwise)) {
        const excluded = named.filter(([, direction]) => !wanted.includes(direction)).map(([value]) => value);
        return excluded.length === 0 ? true : { [field]: { $nin: excluded } };
    }
    return matching.length === 0 ? null : { [field]: { $in: matching } };
}

function roleClause(source: TransactionSource, wanted: readonly TransactionRole[]): Document | null | true {
    if ('fixed' in source.role) return wanted.includes(source.role.fixed) ? true : null;

    // `platform` means both of the marketplace's accounts; no stored owner type is `customer`.
    const stored = wanted
        .filter((role) => role !== 'customer')
        .flatMap((role) => (role === 'platform' ? [...PLATFORM_OWNER_TYPES] : [role]));
    return stored.length === 0 ? null : { [source.role.field]: { $in: stored } };
}

function outcomeClause(source: TransactionSource, wanted: readonly TransactionOutcome[]): Document | null {
    const statusField = source.fields.status;
    const known = wanted.flatMap((outcome) => (outcome === 'unknown' ? [] : source.outcomes[outcome]));
    const clauses: Document[] = [];

    if (known.length > 0) clauses.push({ [statusField]: { $in: known } });
    if (wanted.includes('unknown')) {
        const everyKnown = Object.values(source.outcomes).flat();
        clauses.push({ [statusField]: { $nin: everyKnown } });
    }
    return clauses.length === 0 ? null : anyOf(clauses);
}

function reasonClause(source: TransactionSource, wanted: readonly string[]): Document | null | true {
    const reasons = source.reasons;
    if ('field' in reasons) return { [reasons.field]: { $in: [...wanted] } };

    const predicates = wanted
        .filter((code) => Object.prototype.hasOwnProperty.call(reasons.codes, code))
        .map((code) => reasons.codes[code]);

    if (predicates.length === 0) return null;
    // `{}` selects every row of the kind, so the term constrains nothing further.
    if (predicates.some((predicate) => Object.keys(predicate).length === 0)) return true;
    return anyOf(predicates);
}

function amountClause(source: TransactionSource, filter: TransactionFilter): Document | null {
    const bounds: Document = {};
    if (filter.amount !== undefined) bounds.$eq = filter.amount;
    if (filter.amountMin !== undefined) bounds.$gte = filter.amountMin;
    if (filter.amountMax !== undefined) bounds.$lte = filter.amountMax;
    if (filter.amountGt !== undefined) bounds.$gt = filter.amountGt;
    if (filter.amountLt !== undefined) bounds.$lt = filter.amountLt;
    return Object.keys(bounds).length === 0 ? null : { [source.fields.amount]: bounds };
}

/**
 * One source's native filter, or `null` when no row of this kind can match — in which case
 * the source is not queried at all.
 *
 * `$and` throughout, for the reason every filter in this service composes with it: several
 * of these clauses are `$or`-shaped, and merging two of those by assignment drops one.
 */
export function buildSourceFilter(
    source: TransactionSource,
    filter: TransactionFilter,
    viewer: TransactionViewer,
): Document | null {
    if (!viewer.kinds.has(source.kind)) return null;
    if (filter.kind && !filter.kind.includes(source.kind)) return null;
    if (filter.group && !filter.group.includes(source.group)) return null;

    const clauses: Document[] = [];
    // `true` = the term is satisfied by every row of this kind; `null` = by none.
    const apply = (clause: Document | null | true): boolean => {
        if (clause === null) return false;
        if (clause !== true) clauses.push(clause);
        return true;
    };

    if (source.base) clauses.push(source.base);
    clauses.push({ [source.fields.createdAt]: { $gte: filter.from, $lt: filter.to } });

    // The owner's rule, enforced here rather than hidden by a screen: below tier 1 a row
    // owned by one of the platform's own accounts is never read. Only the ledger has such
    // rows today; the clause is on every owner-typed kind so a later one inherits it.
    if (!viewer.seesPlatformAccounts && 'field' in source.role) {
        clauses.push({ [source.role.field]: { $nin: [...PLATFORM_OWNER_TYPES] } });
    }

    if (filter.direction && !apply(directionClause(source, filter.direction))) return null;
    if (filter.role && !apply(roleClause(source, filter.role))) return null;
    if (filter.outcome && !apply(outcomeClause(source, filter.outcome))) return null;
    if (filter.reasonCode && !apply(reasonClause(source, filter.reasonCode))) return null;

    if (filter.status) clauses.push({ [source.fields.status]: { $in: [...filter.status] } });

    if (filter.partyId) {
        const partyId = toObjectId(filter.partyId);
        if (!partyId) return null;
        clauses.push({ [source.partyIdField]: partyId });
    }

    for (const [values, field] of [
        [filter.gateway, source.gatewayField],
        [filter.provider, source.providerField],
        [filter.method, source.methodField],
    ] as const) {
        if (!values) continue;
        if (!field) return null;
        clauses.push({ [field]: { $in: caseVariants(values) } });
    }

    if (filter.reference) {
        if (source.referenceFields.length === 0) return null;
        // Exact, against every reference the kind carries: the person pasting one cannot
        // tell the provider's from ours.
        clauses.push(anyOf(source.referenceFields.map((field) => ({ [field]: filter.reference }))));
    }

    for (const [value, build] of [
        [filter.orderId, source.order],
        [filter.bookingId, source.booking],
    ] as const) {
        if (!value) continue;
        const linked = toObjectId(value);
        if (!build || !linked) return null;
        clauses.push(build(linked));
    }

    const amount = amountClause(source, filter);
    if (amount) clauses.push(amount);

    return clauses.length === 1 ? clauses[0] : { $and: clauses };
}

// ─────────────────────────────────────────────────────────────────────────────
// The window
// ─────────────────────────────────────────────────────────────────────────────

/** How far one request may reach. The same cap every money list carries. */
export const TRANSACTION_MAX_RANGE_DAYS = 366;
const DAY_MS = 86_400_000;

/**
 * The list ALWAYS has a window, and says which one it used (`meta.window`).
 *
 * `to` defaults to now, `from` to `to − 366 days`. Without one, an amount sort or a summary
 * is a scan of eleven whole collections that a query string can ask for; with one, every
 * request is bounded for good. A caller who gave both has already been held to the cap by
 * the schema.
 */
export function resolveWindow(from: Date | undefined, to: Date | undefined, now: Date = new Date()): { from: Date; to: Date } {
    if (from && to) return { from, to };
    if (from) {
        const cap = new Date(from.getTime() + TRANSACTION_MAX_RANGE_DAYS * DAY_MS);
        return { from, to: cap.getTime() < now.getTime() ? cap : now };
    }
    const end = to ?? now;
    return { from: new Date(end.getTime() - TRANSACTION_MAX_RANGE_DAYS * DAY_MS), to: end };
}

// ─────────────────────────────────────────────────────────────────────────────
// Paging — a keyset over the merge
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ── Why a cursor, and why this one composes where an offset cannot ────────────
 * `skip(40)` applied to eleven sources independently is not rows 40–60 of the merged order.
 * A KEYSET does compose: "everything after `(sortValue, id)`" is the same question to every
 * source, each answers it from its own collection, and the merge of eleven correct answers is
 * the correct answer. The id is the tiebreak, so two rows sharing a millisecond or an amount
 * are neither repeated nor skipped — and unlike the account feed's instant-only cursor, a
 * page here is exactly `limit` long.
 *
 * ObjectIds are unique across collections, so one `(value, id)` pair orders all eleven.
 */
export interface TransactionCursor {
    /** The sort it was issued under, e.g. `-createdAt`. A cursor is refused under any other. */
    sort: string;
    /** Epoch milliseconds for `createdAt`, the amount for `amount`. */
    value: number;
    id: string;
}

export function sortToken(sort: TransactionSort): string {
    return `${sort.direction === -1 ? '-' : ''}${sort.field}`;
}

export function encodeCursor(cursor: TransactionCursor): string {
    return Buffer.from(JSON.stringify([cursor.sort, cursor.value, cursor.id]), 'utf8').toString('base64url');
}

/** `null` for anything that is not a cursor this service issued. Never throws. */
export function decodeCursor(raw: string): TransactionCursor | null {
    try {
        const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
        if (!Array.isArray(parsed) || parsed.length !== 3) return null;
        const [sort, value, cursorId] = parsed as unknown[];
        if (typeof sort !== 'string' || typeof value !== 'number' || !Number.isFinite(value)) return null;
        if (typeof cursorId !== 'string' || !/^[a-f\d]{24}$/.test(cursorId)) return null;
        return { sort, value, id: cursorId };
    } catch {
        return null;
    }
}

/** The database field one source sorts on. */
export function sortFieldOf(source: TransactionSource, sort: TransactionSort): string {
    return sort.field === 'amount' ? source.fields.amount : source.fields.createdAt;
}

export function mongoSortOf(source: TransactionSource, sort: TransactionSort): Record<string, 1 | -1> {
    return { [sortFieldOf(source, sort)]: sort.direction, _id: sort.direction };
}

/** "Strictly after the cursor, in this sort" — the same clause for every source. */
export function keysetClause(source: TransactionSource, sort: TransactionSort, cursor: TransactionCursor): Document {
    const field = sortFieldOf(source, sort);
    const value = sort.field === 'createdAt' ? new Date(cursor.value) : cursor.value;
    const after = sort.direction === -1 ? '$lt' : '$gt';
    return {
        $or: [
            { [field]: { [after]: value } },
            { [field]: value, _id: { [after]: new ObjectId(cursor.id) } },
        ],
    };
}

export function withKeyset(filter: Document, clause: Document | null): Document {
    return clause ? { $and: [filter, clause] } : filter;
}

/** One row on its way to the page: the source row, its kind, and its two sort keys. */
export interface TransactionCandidate {
    kind: TransactionKind;
    row: Document;
    value: number;
    id: string;
}

export function toCandidate(source: TransactionSource, sort: TransactionSort, row: Document): TransactionCandidate {
    const raw = row[sortFieldOf(source, sort)];
    return {
        kind: source.kind,
        row,
        value: sort.field === 'createdAt' ? new Date(raw as Date).getTime() : Number(raw ?? 0),
        id: String(row._id),
    };
}

/**
 * Merge per-source pages into one. Each source handed in `limit + 1` rows already in order;
 * the page is the first `limit` of the merge, and a cursor is issued only when a row was
 * left over.
 */
export function mergeTransactionPage(
    sources: TransactionCandidate[][],
    sort: TransactionSort,
    limit: number,
): { items: TransactionCandidate[]; nextCursor: string | null } {
    const all = sources.flat().sort((a, b) => {
        if (a.value !== b.value) return (a.value - b.value) * sort.direction;
        // 24 lowercase hex characters: string order is byte order, which is Mongo's.
        return a.id < b.id ? -sort.direction : a.id > b.id ? sort.direction : 0;
    });

    if (all.length <= limit) return { items: all, nextCursor: null };

    const items = all.slice(0, limit);
    const last = items[items.length - 1];
    return { items, nextCursor: encodeCursor({ sort: sortToken(sort), value: last.value, id: last.id }) };
}

// ─────────────────────────────────────────────────────────────────────────────
// The summary — a group-by of the list's own columns, and nothing cleverer
// ─────────────────────────────────────────────────────────────────────────────

export interface TransactionSummaryRaw extends Document {
    _id: { status: string | null; currency: string | null; direction: string | null };
    count: number;
    amount: number;
}

/** `$match` → one `$group`. Grouped on stored fields; the outcome and direction are mapped afterwards. */
export function buildSummaryPipeline(source: TransactionSource, filter: Document): Document[] {
    return [
        { $match: filter },
        {
            $group: {
                _id: {
                    status: `$${source.fields.status}`,
                    currency: source.fields.currency ? `$${source.fields.currency}` : null,
                    direction: typeof source.direction === 'string' ? null : `$${source.direction.field}`,
                },
                count: { $sum: 1 },
                amount: { $sum: `$${source.fields.amount}` },
            },
        },
    ];
}

/**
 * Fold the raw groups into `(kind, direction, outcome, currency)` cells. Several statuses
 * share an outcome, so cells are summed here rather than assumed unique.
 *
 * ⚠ Nothing is netted and nothing is summed across cells — that is the caller's choice and
 * mostly a wrong one: `internal` rows are the same money counted at each stage, and a
 * `reversed` payment's refund is its own `out` row.
 */
export function foldSummary(source: TransactionSource, groups: TransactionSummaryRaw[]): TransactionSummaryGroupDto[] {
    const cells = new Map<string, TransactionSummaryGroupDto>();

    for (const group of groups) {
        const direction = typeof source.direction === 'string'
            ? source.direction
            : directionOf(source, { [source.direction.field]: group._id.direction });
        const outcome = outcomeOf(source, String(group._id.status ?? ''));
        const currency = group._id.currency ?? null;
        const key = `${direction}|${outcome}|${currency ?? ''}`;

        const cell = cells.get(key);
        if (cell) {
            cell.count += group.count;
            cell.amount += group.amount;
        } else {
            cells.set(key, { kind: source.kind, direction, outcome, currency, count: group.count, amount: group.amount });
        }
    }
    return [...cells.values()];
}
