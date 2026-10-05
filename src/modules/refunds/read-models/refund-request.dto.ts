import { maskPhone } from '../../statements/domain/statement-masking';
import { RefundActorStamp, RefundRequestReadModel } from '../repositories/refund-request.read.repository';

/**
 * The refund request on the wire — the camelCase projection of contract § 11.1, required-and-
 * nullable throughout (ADR-005 D-16: a missing source is `null`, never an absent key).
 *
 * ── Two views of the destination ──────────────────────────────────────────────
 * `view: 'list'` masks the destination phone (`+2376••••4417`, the shape jovi-mall's
 * `maskPhone` and the statements use); `view: 'detail'` shows it in full, because the approver
 * of a TYPED number has to compare it digit for digit with the proof picture (R-7). Transfer-leg
 * phones are masked in both views — the destination already names the number.
 *
 * Never on the wire: our merchant `transfer_reference` (not projected at all — see the
 * repository).
 */

export interface RefundActorDto {
    id: string | null;
    name: string | null;
    at: string | null;
}

export interface RefundRequestDto {
    id: string;
    source: { kind: string; id: string | null; number: string | null };
    vendor: { id: string | null; name: string | null };
    customerId: string | null;
    reasonKind: string;
    reason: string | null;
    itemDefective: boolean | null;
    overridePolicy: boolean;
    /**
     * `clawback` — completing it recovers the earnings it touches (and they are paused while it is
     * open); `none` — delivery money never allocated to anybody: nothing paused, nothing clawed.
     */
    earningsImpact: string;
    attribution: { goods: number; delivery: number };
    /** What the refund is worth — what analytics deduct and earnings recovery claws back. */
    grossAmount: number;
    /** Percent; 0 for a card refund (R-3). */
    feeRate: number;
    /** The 2% the platform keeps (D-2). */
    feeAmount: number;
    /** What the customer receives: `grossAmount − feeAmount`. */
    netAmount: number;
    currency: string;
    paymentChannel: string | null;
    /** `null` until it is decided how the money leaves. */
    channel: string | null;
    destination: { phone: string | null; name: string | null; source: string | null } | null;
    destinationProofFileId: string | null;
    /**
     * R-7 at a glance: the destination was TYPED, so its approver must not be its requester.
     * Derived — the dashboard should not have to reproduce the rule from `destination.source`.
     */
    secondApproverRequired: boolean;
    codCollectionIds: string[];
    status: string;
    requestedBy: { id: string | null; role: string | null; name: string | null };
    approvedBy: RefundActorDto | null;
    rejectedBy: RefundActorDto | null;
    rejectionReason: string | null;
    transfer: {
        gateway: string | null;
        /** The PROVIDER's transfer id — what reconciles against its dashboard. */
        gatewayRef: string | null;
        failureReason: string | null;
        note: string | null;
        /** One per paying number (plan § 3.2). `amount` is NET sent, `gross` what it refunds. */
        legs: Array<{
            phone: string | null;
            amount: number;
            gross: number | null;
            gatewayRef: string | null;
            status: string | null;
            failureReason: string | null;
        }>;
    };
    externalSettlement: {
        method: string | null;
        reference: string | null;
        proofFileId: string | null;
        settledBy: { id: string | null; name: string | null };
        settledAt: string | null;
        /**
         * The part paid BY HAND. Usually the whole request; after a multi-transfer refund part of
         * which already arrived, only the unpaid REMAINDER. A row written before 2026-10-05 has no
         * value of its own and reads as the request's `grossAmount` / `netAmount`.
         */
        grossAmount: number;
        netAmount: number;
    } | null;
    ticketId: string | null;
    refundTransactionIds: string[];
    completedAt: string | null;
    /** When the earnings recovery of a completed order/booking refund finished; null until then. */
    earningsSettledAt: string | null;
    /** When a completed billing refund took the plan or the credits back; null until then. */
    billingReversedAt: string | null;
    createdAt: string | null;
    updatedAt: string | null;
}

export type RefundDtoView = 'list' | 'detail';

function toIso(value: Date | null | undefined): string | null {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toId(value: { toString(): string } | null | undefined): string | null {
    return value ? value.toString() : null;
}

function toActor(stamp: RefundActorStamp | null | undefined): RefundActorDto | null {
    if (!stamp || (!stamp.id && !stamp.name)) return null;
    return { id: stamp.id ?? null, name: stamp.name ?? null, at: toIso(stamp.at) };
}

export function toRefundRequestDto(
    row: RefundRequestReadModel,
    view: RefundDtoView,
    vendorName: string | null = null,
): RefundRequestDto {
    const destination = row.destination ?? null;
    const settlement = row.external_settlement ?? null;
    const netAmount = row.net_amount ?? row.gross_amount - (row.fee_amount ?? 0);

    return {
        id: row._id.toString(),
        source: { kind: row.source_kind, id: toId(row.source_id), number: row.order_number ?? null },
        vendor: { id: toId(row.vendor_id), name: vendorName },
        customerId: toId(row.customer_id),
        reasonKind: row.reason_kind,
        reason: row.reason ?? null,
        itemDefective: row.item_defective ?? null,
        overridePolicy: row.override_policy ?? false,
        // jovi-mall's schema default — a row written before the field existed was a clawback one.
        earningsImpact: row.earnings_impact ?? 'clawback',
        attribution: {
            goods: row.attribution?.goods ?? 0,
            delivery: row.attribution?.delivery ?? 0,
        },
        grossAmount: row.gross_amount,
        feeRate: row.fee_rate ?? 0,
        feeAmount: row.fee_amount ?? 0,
        // `?? gross − fee` is the contract's own identity (§ 11.1), applied to a row written
        // before the field was — never a second computation of the fee.
        netAmount,
        currency: row.currency,
        paymentChannel: row.payment_channel ?? null,
        channel: row.channel ?? null,
        destination: destination
            ? {
                  phone: view === 'detail' ? destination.phone ?? null : maskPhone(destination.phone),
                  name: destination.name ?? null,
                  source: destination.source ?? null,
              }
            : null,
        destinationProofFileId: toId(row.destination_proof_file_id),
        secondApproverRequired: destination?.source === 'typed',
        codCollectionIds: (row.cod_collection_ids ?? []).map((id) => id.toString()),
        status: row.status,
        requestedBy: {
            id: row.requested_by?.id ?? null,
            role: row.requested_by?.role ?? null,
            name: row.requested_by?.name ?? null,
        },
        approvedBy: toActor(row.approved_by),
        rejectedBy: toActor(row.rejected_by),
        rejectionReason: row.rejection_reason ?? null,
        transfer: {
            gateway: row.transfer_gateway ?? null,
            gatewayRef: row.transfer_gateway_ref ?? null,
            failureReason: row.transfer_failure_reason ?? null,
            note: row.transfer_note ?? null,
            legs: (row.transfer_legs ?? []).map((leg) => ({
                phone: maskPhone(leg.phone),
                amount: leg.amount ?? 0,
                gross: leg.gross ?? null,
                gatewayRef: leg.gateway_ref ?? null,
                status: leg.status ?? null,
                failureReason: leg.failure_reason ?? null,
            })),
        },
        externalSettlement: settlement
            ? {
                  method: settlement.method ?? null,
                  reference: settlement.reference ?? null,
                  proofFileId: toId(settlement.proof_file_id),
                  settledBy: { id: settlement.settled_by?.id ?? null, name: settlement.settled_by?.name ?? null },
                  settledAt: toIso(settlement.settled_at),
                  // jovi-mall's own fallback: null on an older row → the request's totals.
                  grossAmount: settlement.gross_amount ?? row.gross_amount,
                  netAmount: settlement.net_amount ?? netAmount,
              }
            : null,
        ticketId: toId(row.ticket_id),
        refundTransactionIds: (row.refund_transaction_ids ?? []).map((id) => id.toString()),
        completedAt: toIso(row.completed_at),
        earningsSettledAt: toIso(row.earnings_settled_at),
        billingReversedAt: toIso(row.billing_reversed_at),
        createdAt: toIso(row.created_at),
        updatedAt: toIso(row.updated_at),
    };
}

/**
 * The audit `before` / `after` of a refund write — status and money only, in the camelCase both
 * halves share. ⛔ Never the destination phone: putting it in the audit store would make it
 * readable to every tier that reads the trail, without the permission that gates the detail.
 */
export function toRefundAuditState(row: RefundRequestReadModel | null): Record<string, unknown> | null {
    if (!row) return null;
    return {
        status: row.status,
        grossAmount: row.gross_amount,
        feeAmount: row.fee_amount ?? null,
        netAmount: row.net_amount ?? null,
        channel: row.channel ?? null,
        destinationSource: row.destination?.source ?? null,
    };
}

/** How an administrator recognises a refund request in a feed. No phone, no id. */
export function labelOfRefund(row: RefundRequestReadModel): string {
    const source = row.order_number ?? `${row.source_kind} ${row.source_id.toString()}`;
    return `${row.currency} ${row.gross_amount} refund · ${source}`;
}
