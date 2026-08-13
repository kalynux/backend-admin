import {
    EarningsAllocationReadModel,
    EarningsLedgerReadModel,
} from '../repositories/earnings.read.repository';
import {
    PaymentTransactionReadModel,
    RefundTransactionReadModel,
} from '../repositories/payment-transaction.read.repository';
import { PayoutRequestReadModel } from '../repositories/payout-request.read.repository';
import { PayoutDestinationDto, toMaskedDestinationDto } from './payout-destination.dto';

/**
 * Wire shapes for `/api/v1/money`.
 *
 * Named-field mapping throughout, **never a spread** — and on this mount that is the second
 * of the two locks rather than a style rule. `payout_requests` holds a beneficiary's
 * plaintext account number and `payment_transactions` holds raw gateway JSON; the
 * projections are what stop those reaching the process, and these mappers are what stop
 * them reaching the wire if a projection is ever widened for a new screen.
 *
 * ── Every field is required-and-nullable (ADR-005 D-16) ───────────────────────
 * `null`, never absent. A key that disappears when its value is missing makes "this payout
 * has not been resolved" and "this client is out of date" indistinguishable, and on a money
 * surface the first is a normal state that a reader has to be able to see.
 *
 * ── camelCase on the wire, whatever the database says ─────────────────────────
 * Two of the five collections behind this module are snake_case and two are camelCase
 * (`payment_transactions` and `refund_transactions` predate the platform's convention). The
 * wire does not inherit that split; these functions are the one place both spellings meet.
 */

function toIso(value: Date | null | undefined): string | null {
    if (!value) return null;
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toId(value: { toString(): string } | null | undefined): string | null {
    return value ? value.toString() : null;
}

/**
 * Owner display names for a page, keyed `"<ownerType>:<ownerId>"`.
 *
 * `billing.dto.ts` declares the same two-line helper, and they are deliberately not shared.
 * The vocabularies differ where it counts: a billing owner is always a vendor, agency or
 * agent — all three of which have a directory row to look up — while an earnings owner can
 * be **`platform`**, which is the marketplace's own commission account and has no row
 * anywhere. A shared resolver would need a special case for the caller that does not want
 * it, which is more coupling than two lines of key-building is worth.
 */
export type MoneyOwnerNames = Map<string, string | null>;

/** The key both the resolver and the mapper build, so the two cannot disagree. */
export function ownerKey(ownerType: string, ownerId: string | null): string {
    return `${ownerType}:${ownerId ?? 'null'}`;
}

/**
 * How a money row names the party it is about.
 *
 * `id` is nullable because the platform singleton genuinely has none — `owner_id` is null
 * on those rows, and `beneficiary_id` is null on the commission allocation. That is not a
 * missing value to be filled in; it is what "the platform itself" looks like in this
 * schema, and `name` carries the label for it.
 */
export interface MoneyOwnerRef {
    type: string;
    id: string | null;
    /** The BUSINESS name where there is one — a Store, a Magazin. `null`, never `""`. */
    name: string | null;
}

function toOwnerRef(
    ownerType: string,
    ownerId: string | null,
    names: MoneyOwnerNames,
): MoneyOwnerRef {
    return {
        type: ownerType,
        id: ownerId,
        name: names.get(ownerKey(ownerType, ownerId)) ?? null,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// The earnings ledger
// ─────────────────────────────────────────────────────────────────────────────

export interface LedgerEntryDto {
    id: string;
    accountId: string | null;
    owner: MoneyOwnerRef;
    /** `hold` · `release` · `reversal` · `reserve_hold` · `reserve_release`. */
    entryType: string;
    /**
     * The positive magnitude moved. **Never signed** — direction is `entryType`'s job, and
     * a client that subtracts on the sign alone would get `reserve_hold` backwards (it
     * moves money sideways, pending → reserve, rather than in or out).
     */
    amount: number;
    /** The balances immediately after this entry. What makes the ledger checkable. */
    balancesAfter: { pending: number; available: number };
    source: { type: string; id: string | null };
    allocationId: string | null;
    reasonCode: string;
    createdAt: string | null;
}

export function toLedgerEntryDto(
    row: EarningsLedgerReadModel,
    names: MoneyOwnerNames,
): LedgerEntryDto {
    return {
        id: row._id.toString(),
        accountId: toId(row.account_id),
        owner: toOwnerRef(row.owner_type, toId(row.owner_id), names),
        entryType: row.entry_type,
        amount: row.amount,
        balancesAfter: { pending: row.pending_after, available: row.available_after },
        source: { type: row.source_type, id: toId(row.source_id) },
        allocationId: toId(row.allocation_id),
        reasonCode: row.reason_code,
        createdAt: toIso(row.created_at),
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Allocations
// ─────────────────────────────────────────────────────────────────────────────

export interface AllocationDto {
    id: string;
    source: { type: string; id: string | null };
    beneficiary: MoneyOwnerRef;
    amount: number;
    currency: string;
    status: string;
    /**
     * The split's inputs, frozen at the moment it ran.
     *
     * Grouped rather than flattened beside `amount`, because they are a different KIND of
     * number: `amount` is what somebody is owed, and these two are what it was computed
     * from. Together they make the row checkable — `amount` alone says what a beneficiary
     * got, and with the gross and the rate it says whether that was right.
     */
    snapshots: { gross: number; commissionPercent: number };
    /**
     * Why the money has or has not moved yet. **This block is the reason the endpoint
     * exists** — none of these four fields had an admin surface anywhere before Phase 11.
     */
    release: {
        completedAt: string | null;
        /** `completedAt + HOLD_DAYS`. `null` means the source has not completed at all. */
        holdReleaseAt: string | null;
        releasedAt: string | null;
        reversedAt: string | null;
        /** COD: the money is physical cash, and release waits for it to arrive. */
        requiresCashSettlement: boolean;
        /** `null` with `requiresCashSettlement: true` is exactly "the cash is not here". */
        cashSettledAt: string | null;
    };
    createdAt: string | null;
    updatedAt: string | null;
}

export function toAllocationDto(
    row: EarningsAllocationReadModel,
    names: MoneyOwnerNames,
): AllocationDto {
    return {
        id: row._id.toString(),
        source: { type: row.source_type, id: toId(row.source_id) },
        beneficiary: toOwnerRef(row.beneficiary_type, toId(row.beneficiary_id), names),
        amount: row.amount,
        currency: row.currency,
        status: row.status,
        snapshots: {
            gross: row.gross_snapshot,
            commissionPercent: row.commission_percent_snapshot,
        },
        release: {
            completedAt: toIso(row.completed_at),
            holdReleaseAt: toIso(row.hold_release_at),
            releasedAt: toIso(row.released_at),
            reversedAt: toIso(row.reversed_at),
            // `?? false` is the schema's own default applied to a legacy row written before
            // the field existed, not a guess: COD settlement gating postdates the split.
            requiresCashSettlement: row.requires_cash_settlement ?? false,
            cashSettledAt: toIso(row.cash_settled_at),
        },
        createdAt: toIso(row.created_at),
        updatedAt: toIso(row.updated_at),
    };
}

export interface AllocationDetailDto extends AllocationDto {
    /**
     * The movements this allocation caused — what it DID, as opposed to what it says.
     *
     * A `held` allocation with no ledger rows is a real and alarming state: money was
     * allocated and never entered anybody's balance.
     */
    movements: LedgerEntryDto[];
    /**
     * Every allocation cut from the same sale, this one included.
     *
     * The only place the split is visible as a whole: a prepaid order produces a platform
     * commission row and a vendor net row, a delivery adds the agency and the agent. Whether
     * the parts sum to the gross is a question no other endpoint on this surface can ask.
     */
    siblings: AllocationDto[];
}

export function toAllocationDetailDto(
    row: EarningsAllocationReadModel,
    names: MoneyOwnerNames,
    context: { movements: EarningsLedgerReadModel[]; siblings: EarningsAllocationReadModel[] },
): AllocationDetailDto {
    return {
        ...toAllocationDto(row, names),
        movements: context.movements.map((entry) => toLedgerEntryDto(entry, names)),
        siblings: context.siblings.map((sibling) => toAllocationDto(sibling, names)),
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Payout requests
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Who resolved a payout.
 *
 * `source` says which database `id` resolves in — `'admin'` ids resolve in NEITHER, being
 * `admin_accounts` rows in wi-admin's own database — and `name` is the snapshot taken at
 * write time, which is the only record there will ever be for those. Defaulting `source` to
 * `'platform'` matches the schema: a row written before the admin split carries neither
 * companion field and IS a platform row.
 */
export interface ActorStampDto {
    id: string | null;
    source: string;
    name: string | null;
}

export interface PayoutListItemDto {
    id: string;
    owner: MoneyOwnerRef;
    amount: number;
    currency: string;
    status: string;
    /** `manual` (the owner asked) or `auto_threshold` (the platform opened it for them). */
    origin: string;
    /**
     * Masked, and masked by the PROJECTION rather than by this mapper — the routing values
     * were never read. See `payout-destination.dto.ts`. `null` on legacy rows predating the
     * snapshot, which is a different fact from a destination with no details.
     */
    destination: PayoutDestinationDto | null;
    ticketId: string | null;
    requestedByUserId: string | null;
    resolvedAt: string | null;
    /** `null` while pending — nobody has resolved it, which is not the same as unknown. */
    resolvedBy: ActorStampDto | null;
    paidReference: string | null;
    rejectionReason: string | null;
    createdAt: string | null;
    updatedAt: string | null;
}

export function toPayoutListItemDto(
    row: PayoutRequestReadModel,
    names: MoneyOwnerNames,
): PayoutListItemDto {
    return {
        id: row._id.toString(),
        owner: toOwnerRef(row.owner_type, row.owner_id.toString(), names),
        amount: row.amount,
        currency: row.currency,
        status: row.status,
        origin: row.origin,
        destination: toMaskedDestinationDto(row.payout_method_snapshot),
        ticketId: toId(row.ticket_id),
        requestedByUserId: toId(row.requested_by_user_id),
        resolvedAt: toIso(row.resolved_at),
        // Keyed on the id: a stamp rendered without checking whether there is an actor
        // reads as "resolved by nobody, source platform", which is a claim rather than an
        // absence. Same shape as the agency DTO's `verifiedBy`.
        resolvedBy: row.resolved_by
            ? {
                id: row.resolved_by.toString(),
                source: row.resolved_by_source ?? 'platform',
                name: row.resolved_by_name ?? null,
            }
            : null,
        paidReference: row.paid_reference ?? null,
        rejectionReason: row.rejection_reason ?? null,
        createdAt: toIso(row.created_at),
        updatedAt: toIso(row.updated_at),
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Gateway settlements
// ─────────────────────────────────────────────────────────────────────────────

export interface PaymentDto {
    id: string;
    /**
     * What this payment settles — exactly one of the three is set.
     *
     * `cartId` with `orderIds` is the common case and the one that surprises people: a
     * multi-vendor checkout is ONE payment settling N orders, so a row whose `orderId` is
     * null is not an incomplete record.
     */
    settles: {
        orderId: string | null;
        orderIds: string[];
        bookingId: string | null;
        cartId: string | null;
        /** `primary` or `booking_balance` — a booking can be paid twice. */
        purpose: string;
    };
    /**
     * The payer. **Not one kind of id**: an order or cart payment stores a CUSTOMER id and
     * a booking payment a USER id, and nothing on the row says which. `kind: 'unknown'`
     * rather than a guess — the platform itself resolves it by how the row was created.
     */
    payer: { id: string; kind: 'customer_or_user' };
    gateway: string;
    method: string;
    /** The gateway's own reference — the string quoted in a dispute. */
    gatewayRef: string;
    status: string;
    /** The amount AT PAYMENT TIME, never re-read off the order. */
    amount: number;
    currency: string;
    refunds: {
        totalRefunded: number;
        /** `amount - totalRefunded`. Computed here; the Mongoose virtual never leaves. */
        netAmount: number;
        hasPartialRefund: boolean;
    };
    createdAt: string | null;
    updatedAt: string | null;
}

export function toPaymentDto(row: PaymentTransactionReadModel): PaymentDto {
    const totalRefunded = row.totalRefunded ?? 0;

    return {
        id: row._id.toString(),
        settles: {
            orderId: toId(row.orderId),
            orderIds: (row.orderIds ?? []).map((id) => id.toString()),
            bookingId: toId(row.bookingId),
            cartId: toId(row.cartId),
            purpose: row.purpose ?? 'primary',
        },
        payer: { id: row.userId.toString(), kind: 'customer_or_user' },
        gateway: row.gateway,
        method: row.method,
        gatewayRef: row.gatewayRef,
        status: row.status,
        amount: row.amountSnapshot,
        currency: row.currencySnapshot,
        refunds: {
            totalRefunded,
            netAmount: row.amountSnapshot - totalRefunded,
            hasPartialRefund: row.hasPartialRefund ?? false,
        },
        createdAt: toIso(row.createdAt),
        updatedAt: toIso(row.updatedAt),
    };
}

export interface PaymentDetailDto extends PaymentDto {
    /**
     * The refunds against this payment.
     *
     * `refunds.totalRefunded` says how much came back; these say when, through which
     * gateway and at whose request — and a `pending` or `failed` row here beside a
     * `totalRefunded` that has not moved is what a stuck refund looks like.
     */
    refundTransactions: RefundDto[];
}

export function toPaymentDetailDto(
    row: PaymentTransactionReadModel,
    refunds: RefundTransactionReadModel[],
): PaymentDetailDto {
    return { ...toPaymentDto(row), refundTransactions: refunds.map(toRefundDto) };
}

export interface RefundDto {
    id: string;
    paymentTransactionId: string | null;
    source: { orderId: string | null; bookingId: string | null };
    vendorId: string | null;
    userId: string | null;
    amount: number;
    currency: string;
    reason: string | null;
    status: string;
    gateway: string;
    gatewayRefundRef: string | null;
    /** Who ASKED for it — `vendor` · `admin` · `customer`. Not who approved it. */
    initiatedBy: { id: string | null; role: string };
    createdAt: string | null;
    /**
     * When the money actually went back. `null` on a `pending` or `failed` refund, which is
     * why the list's date range is on `createdAt` — ranging on this one would silently drop
     * exactly the rows somebody opens this list to find.
     */
    completedAt: string | null;
}

export function toRefundDto(row: RefundTransactionReadModel): RefundDto {
    return {
        id: row._id.toString(),
        paymentTransactionId: toId(row.paymentTransactionId),
        source: { orderId: toId(row.orderId), bookingId: toId(row.bookingId) },
        vendorId: toId(row.vendorId),
        userId: toId(row.userId),
        amount: row.refundAmount,
        currency: row.currency,
        reason: row.reason ?? null,
        status: row.status,
        gateway: row.gateway,
        gatewayRefundRef: row.gatewayRefundRef ?? null,
        initiatedBy: { id: toId(row.initiatedBy), role: row.initiatedByRole },
        createdAt: toIso(row.createdAt),
        completedAt: toIso(row.completedAt),
    };
}
