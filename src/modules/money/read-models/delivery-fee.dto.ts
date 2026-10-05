import { DeliveryFeeProposalReadModel, DeliveryFeeRefundReadModel } from '../repositories/delivery-fee.read.repository';
import { PaymentTransactionReadModel } from '../repositories/payment-transaction.read.repository';

/**
 * Wire shapes for delivery-fee changes after checkout (jovi-mall ADR-A11 W-E/W-E2): the manual
 * refund queue on `/money/delivery-fee-refunds`, and the read-only `deliveryFee` block on the
 * order detail.
 *
 * `DeliveryFeeRefundDto` is jovi-mall's `AdminDeliveryFeeRefundDto` field for field
 * (`api-doc/admin/delivery-fee-refunds.md`), so a dashboard that has read either side's
 * contract reads this one. Dates are ISO strings, as everywhere in this service.
 */

const toIso = (value: Date | null | undefined): string | null => (value ? new Date(value).toISOString() : null);
const toId = (value: { toString(): string } | null | undefined): string | null => (value ? value.toString() : null);

/** The statuses under which a payment's money is (or was) in the platform's hands. */
const SETTLED_PAYMENT_STATUSES: ReadonlySet<string> = new Set(['SUCCEEDED', 'REFUNDED']);
export const DELIVERY_TOPUP_PURPOSE = 'order_delivery_topup';

// ─────────────────────────────────────────────────────────────────────────────
// Refunds
// ─────────────────────────────────────────────────────────────────────────────

export interface DeliveryFeeRefundDto {
    id: string;
    orderId: string;
    orderNumber: string | null;
    shipmentId: string | null;
    customerId: string;
    vendorId: string;
    amount: number;
    currency: string;
    /** `processing` · `completed` · `manual_required` (owed — a person must send it) · `failed`. */
    status: string;
    /** `fee_decrease` · `rto_leftover` · `sweep`. */
    cause: string;
    /** Why it is manual / failed. **Operator-facing — never show it to the customer.** */
    note: string | null;
    /** The HIGH support ticket a manual row opened. */
    ticketId: string | null;
    /**
     * The refund REQUEST that returns this money (REFUND-FLOW-PLAN § 7), or null on a row that
     * never had one. Open it at `GET /api/v1/refunds/:refundId` — that is where it is approved,
     * settled externally (with its proof) or rejected.
     */
    refundRequestId: string | null;
    /** A request that was REJECTED for this money (history); the row is back on this screen. */
    rejectedRefundRequestId: string | null;
    /**
     * An OPEN refund request of the whole ORDER (`{ id, status }`), or null. While one is open
     * this row cannot be settled by hand — both come out of the same refundable ceiling, and
     * jovi-mall refuses it (`409 DELIVERY_FEE_REFUND_NOT_SETTLEABLE` + `details.refundRequestId`).
     * Read here from `refund_requests`; jovi-mall's own DTO does not carry it.
     */
    orderRefundRequest: { id: string; status: string } | null;
    /**
     * True while it may be settled HERE — `manual_required`, not linked to a refund request, and
     * no refund of the whole order open (`orderRefundRequest`).
     * A row whose money sits in a request is settled in the refund queue: jovi-mall refuses it
     * here with `409 DELIVERY_FEE_REFUND_NOT_SETTLEABLE` + `details.refundRequestId`. The same
     * rule as jovi-mall's `AdminDeliveryFeeRefundDto.settleable`. The one flag the button needs.
     */
    settleable: boolean;
    /** Automatic rows: the `refund_transactions` the gateway refund produced. */
    refundTransactionIds: string[];
    settledAt: string | null;
    /** Set when an ADMINISTRATOR settled a manual row; `null` on every automatic row. */
    settlement: {
        /** `mobile_money` · `cash` · `bank` · `other` (sent by hand) · `covered_by_order_refund` (nothing moved). */
        method: string;
        reference: string | null;
        note: string | null;
        /** `id` is a wi-admin administrator id when `source` is `admin`. */
        settledBy: { id: string; source: string | null; name: string | null };
        settledAt: string | null;
    } | null;
    createdAt: string | null;
    updatedAt: string | null;
}

export function toDeliveryFeeRefundDto(
    row: DeliveryFeeRefundReadModel,
    orderNumber: string | null,
    orderRefundRequest: { id: string; status: string } | null = null,
): DeliveryFeeRefundDto {
    const s = row.settlement ?? null;
    return {
        id: row._id.toString(),
        orderId: row.order_id.toString(),
        orderNumber,
        shipmentId: toId(row.shipment_id),
        customerId: row.customer_id.toString(),
        vendorId: row.vendor_id.toString(),
        amount: row.amount,
        currency: row.currency,
        status: row.status,
        cause: row.cause,
        note: row.note ?? null,
        ticketId: toId(row.ticket_id),
        refundRequestId: toId(row.refund_request_id),
        rejectedRefundRequestId: toId(row.rejected_refund_request_id),
        orderRefundRequest,
        settleable: row.status === 'manual_required' && !row.refund_request_id && orderRefundRequest === null,
        refundTransactionIds: (row.refund_transaction_ids ?? []).map((id) => id.toString()),
        settledAt: toIso(row.settled_at),
        settlement: s
            ? {
                  method: s.method,
                  reference: s.reference ?? null,
                  note: s.note ?? null,
                  settledBy: { id: s.settled_by_user_id, source: s.settled_by_source ?? null, name: s.settled_by_name ?? null },
                  settledAt: toIso(s.settled_at),
              }
            : null,
        createdAt: toIso(row.created_at),
        updatedAt: toIso(row.updated_at),
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Proposals
// ─────────────────────────────────────────────────────────────────────────────

export interface DeliveryFeeProposalDto {
    id: string;
    shipmentId: string;
    agencyId: string;
    /** `agency` · `agent` — who proposed. */
    proposedByRole: string;
    /** `agency` · `change_agency` · `combined_request` (`agency` on rows written before ADR-A11). */
    origin: string;
    /** `vendor` (vendor-paid) · `customer` (an increase the customer pays) · `none` (a customer-paid decrease, applied on creation). */
    approver: string;
    /** `increase` · `decrease` · `null` (older rows). */
    direction: string | null;
    feeBefore: number;
    proposedFee: number;
    currency: string;
    reason: string;
    /** `pending` · `approved` · `rejected` · `withdrawn`. */
    status: string;
    respondedByRole: string | null;
    respondedAt: string | null;
    rejectionNote: string | null;
    withdrawalReason: string | null;
    /** An online increase the customer approved: what they must pay on top, and whether they have. */
    topUp: { amount: number; status: string; paymentId: string | null; paidAt: string | null } | null;
    /** What the approval did to the customer's side of the money; `null` until applied, or vendor-paid. */
    customerEffect: {
        feeBefore: number | null;
        feeAfter: number | null;
        topUpAmount: number | null;
        refundDue: number | null;
    } | null;
    createdAt: string | null;
}

export function toDeliveryFeeProposalDto(row: DeliveryFeeProposalReadModel): DeliveryFeeProposalDto {
    const a = row.application ?? null;
    const customerSide =
        a && (a.customer_fee_before != null || a.customer_fee_after != null || a.customer_topup_amount != null || a.customer_refund_due != null);
    return {
        id: row._id.toString(),
        shipmentId: row.shipment_id.toString(),
        agencyId: row.agency_id.toString(),
        proposedByRole: row.proposed_by_role,
        origin: row.origin ?? 'agency',
        approver: row.approver ?? 'vendor',
        direction: row.direction ?? null,
        feeBefore: row.fee_before,
        proposedFee: row.proposed_fee,
        currency: row.currency,
        reason: row.reason,
        status: row.status,
        respondedByRole: row.responded_by_role ?? null,
        respondedAt: toIso(row.responded_at),
        rejectionNote: row.rejection_note ?? null,
        withdrawalReason: row.withdrawal_reason ?? null,
        topUp: row.topup
            ? {
                  amount: row.topup.amount,
                  status: row.topup.status,
                  paymentId: toId(row.topup.transaction_id),
                  paidAt: toIso(row.topup.paid_at),
              }
            : null,
        customerEffect: customerSide
            ? {
                  feeBefore: a!.customer_fee_before ?? null,
                  feeAfter: a!.customer_fee_after ?? null,
                  topUpAmount: a!.customer_topup_amount ?? null,
                  refundDue: a!.customer_refund_due ?? null,
              }
            : null,
        createdAt: toIso(row.created_at),
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-order payments — the checkout charge vs the delivery top-ups
// ─────────────────────────────────────────────────────────────────────────────

export interface OrderPaymentRefDto {
    id: string;
    status: string;
    gateway: string;
    amount: number;
    currency: string;
    /** True when the payment settled N orders (a cart checkout) — `amount` is the GROUP's charge, not this order's share. */
    sharedWithOtherOrders: boolean;
    shipmentId: string | null;
    proposalId: string | null;
    createdAt: string | null;
}

export interface OrderPaymentsSplit {
    /**
     * The checkout charge — the settled non-top-up payment (else the latest attempt). `null`
     * on a COD order or one never paid.
     */
    checkout: OrderPaymentRefDto | null;
    /** Every `order_delivery_topup` attempt for this order, oldest first. */
    deliveryTopUps: OrderPaymentRefDto[];
    /** Σ of the top-ups that SUCCEEDED (or were later refunded) — delivery money paid after checkout. */
    deliveryTopUpsPaid: number;
}

function toPaymentRef(row: PaymentTransactionReadModel): OrderPaymentRefDto {
    return {
        id: row._id.toString(),
        status: row.status,
        gateway: row.gateway,
        amount: row.amountSnapshot,
        currency: row.currencySnapshot,
        sharedWithOtherOrders: !row.orderId && (row.orderIds?.length ?? 0) > 1,
        shipmentId: toId(row.deliveryTopup?.shipmentId),
        proposalId: toId(row.deliveryTopup?.proposalId),
        createdAt: toIso(row.createdAt),
    };
}

/**
 * ⚠ THE per-order payment rule (ADR-A11 W-G2), pure and exported for `test-money.ts`.
 *
 * Since W-E an order can hold TWO kinds of payment row: its checkout charge (`primary`, or a
 * cart's group charge) and any number of `order_delivery_topup` rows, both linked by `orderId`.
 * A reader that wants "THE payment" must exclude top-ups (a top-up is not how the order was
 * paid, and its gateway reference is not the checkout's); a reader that wants "what the
 * customer paid for this order" must add them. This function returns both halves, separately,
 * so no caller has to pick one by accident. Mirrors jovi-mall's own split
 * (`payment-orchestrator.service.ts` refund legs: primary = the SUCCEEDED non-top-up row).
 */
export function splitOrderPayments(rows: PaymentTransactionReadModel[]): OrderPaymentsSplit {
    const topUps = rows.filter((r) => r.purpose === DELIVERY_TOPUP_PURPOSE);
    const charges = rows.filter((r) => r.purpose !== DELIVERY_TOPUP_PURPOSE && r.purpose !== 'booking_balance');
    const checkout = charges.find((r) => SETTLED_PAYMENT_STATUSES.has(r.status)) ?? charges[charges.length - 1] ?? null;
    return {
        checkout: checkout ? toPaymentRef(checkout) : null,
        deliveryTopUps: topUps.map(toPaymentRef),
        deliveryTopUpsPaid: topUps
            .filter((r) => SETTLED_PAYMENT_STATUSES.has(r.status))
            .reduce((sum, r) => sum + (r.amountSnapshot ?? 0), 0),
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// The order-detail block
// ─────────────────────────────────────────────────────────────────────────────

export interface OrderDeliveryFeeDto {
    payments: OrderPaymentsSplit;
    proposals: DeliveryFeeProposalDto[];
    refunds: DeliveryFeeRefundDto[];
    /**
     * Delivery money still owed back to the customer BY HAND (`manual_required` rows) — the
     * figure behind the settle button. Automatic refunds in flight (`processing`) are not in it.
     */
    owedManually: number;
    /** Delivery money returned: gateway refunds that completed plus manual rows settled by hand. */
    returned: number;
}

const PAID_BY_HAND = new Set(['mobile_money', 'cash', 'bank', 'other']);

export function toOrderDeliveryFeeDto(
    orderNumber: string | null,
    payments: PaymentTransactionReadModel[],
    proposals: DeliveryFeeProposalReadModel[],
    refunds: DeliveryFeeRefundReadModel[],
    /** The order's OPEN refund request, if any — no row is settleable by hand while it is open. */
    orderRefundRequest: { id: string; status: string } | null = null,
): OrderDeliveryFeeDto {
    return {
        payments: splitOrderPayments(payments),
        proposals: proposals.map(toDeliveryFeeProposalDto),
        refunds: refunds.map((r) => toDeliveryFeeRefundDto(r, orderNumber, orderRefundRequest)),
        owedManually: refunds.filter((r) => r.status === 'manual_required').reduce((s, r) => s + r.amount, 0),
        // A `covered_by_order_refund` settlement moved nothing — the order refund that covered it
        // is already in `refund_transactions` — so counting it here would count that money twice.
        returned: refunds
            .filter((r) => r.status === 'completed' && (!r.settlement || PAID_BY_HAND.has(r.settlement.method)))
            .reduce((s, r) => s + r.amount, 0),
    };
}
