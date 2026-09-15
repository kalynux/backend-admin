import {
    EarningsAllocationReadModel,
    EarningsLedgerReadModel,
} from '../repositories/earnings.read.repository';
import {
    PaymentTransactionReadModel,
    RefundTransactionReadModel,
} from '../repositories/payment-transaction.read.repository';
import { PayoutRequestReadModel } from '../repositories/payout-request.read.repository';
import { PlatformEarningsAccount } from '../gateways/money.gateway';
import { OwnerVerification, UNKNOWN_VERIFICATION } from '../domain/owner-verification';
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

/** Names one owner's verification, for keying `MoneyOwnerVerifications`. */
export type MoneyOwnerVerifications = Map<string, OwnerVerification>;

export interface PayoutListItemDto {
    id: string;
    owner: MoneyOwnerRef;
    amount: number;
    currency: string;
    status: string;
    /** `manual` (the owner asked) or `auto_threshold` (the platform opened it for them). */
    origin: string;
    /**
     * Has a human vetted the owner this money is going to?
     *
     * ⚠ **Read this on every row before releasing funds.** Payout review is the platform's
     * one human checkpoint on money leaving it, and since the activation split of
     * 2026-09-15 `owner` being `active` is no longer evidence that anybody vetted the
     * business — accounts activate themselves on a proved phone. Without this field an
     * active vendor with a plausible destination is indistinguishable from a stranger who
     * registered this morning.
     *
     * ⚠ **Top-level, matching jovi-mall's own admin DTO field for field** — not folded into
     * `owner`, and not flattened to a boolean. `owner` is a REFERENCE (who is being paid);
     * this is a fact about the review of that business, refreshed per request. And the
     * `verdict` is the role's own word: vendor and agency default to `pending`, an agent to
     * `unverified`, reaching `pending` only once documents are submitted. On an agent those
     * two separate "nothing submitted" from "submitted, waiting", which is what tells a
     * reviewer whether to chase somebody. Render the word; branch on the boolean.
     *
     * ⚠ **It is INFORMATION, not enforcement.** The platform does not refuse these payouts —
     * working with an unverified counterparty is a business judgement, not a platform
     * decision. Do not gate the pay action on it.
     *
     * ⚠ **Read fresh, never snapshotted**, unlike `destination` beside it. The snapshot
     * there exists so a later profile edit cannot redirect money already in flight; a frozen
     * verdict would do the opposite kind of harm, sending a reviewer to chase documents that
     * were approved after the request was opened.
     *
     * An owner that resolves in no directory reads as `unverified` — see
     * `UNKNOWN_VERIFICATION`. A missing row must never render as a silent approval.
     */
    verification: OwnerVerification;
    /**
     * Masked, and masked by the PROJECTION rather than by this mapper — the routing values
     * were never read. See `payout-destination.dto.ts`. `null` on legacy rows predating the
     * snapshot, which is a different fact from a destination with no details.
     */
    destination: PayoutDestinationDto | null;
    /**
     * The tier-3 endorsement, or null when nobody has reviewed it.
     *
     * ⚠ **Advisory, never a precondition.** A payout with no endorsement is exactly as
     * payable as one with it. A dashboard must not disable its approve control on a null
     * here — the pre-screen exists to save the approver work, not to gate them.
     *
     * There is no rejected verdict: a triage rejection is terminal and appears as
     * `status: "rejected"` with a `rejectionReason`, like any other.
     */
    triage: {
        verdict: string;
        note: string | null;
        by: { id: string | null; name: string | null };
        at: string | null;
    } | null;
    /** The gateway's own transfer id, when one was issued. Never our merchant reference. */
    transferGatewayRef: string | null;
    /** Why the last transfer attempt failed. The funds are still held when this is set. */
    transferFailureReason: string | null;
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
    verifications: MoneyOwnerVerifications = new Map(),
): PayoutListItemDto {
    return {
        id: row._id.toString(),
        owner: toOwnerRef(row.owner_type, row.owner_id.toString(), names),
        amount: row.amount,
        currency: row.currency,
        status: row.status,
        origin: row.origin,
        destination: toMaskedDestinationDto(row.payout_method_snapshot),
        // Defaulted to unverified rather than left undefined: a caller that forgets to
        // hydrate gets the safe answer and a visible one, not a missing key that renders
        // as an empty badge. The default on the parameter and the fallback here are the
        // same decision written twice on purpose — either alone leaves a hole.
        verification:
            verifications.get(ownerKey(row.owner_type, row.owner_id.toString()))
            ?? UNKNOWN_VERIFICATION,
        triage: row.triage
            ? {
                  verdict: row.triage.verdict,
                  note: row.triage.note ?? null,
                  by: { id: row.triage.by_admin_id ?? null, name: row.triage.by_name ?? null },
                  at: row.triage.at ? new Date(row.triage.at).toISOString() : null,
              }
            : null,
        transferGatewayRef: row.transfer_gateway_ref ?? null,
        transferFailureReason: row.transfer_failure_reason ?? null,
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
    /**
     * OUR reference, echoed back by the gateway on its callback — `jm_pt_<32 hex>`.
     *
     * `null` on every row written before the field existed, and on any row whose provider
     * never returned one. Both references are searchable through `?reference=`, which
     * matches either, because the person holding one cannot tell which kind it is.
     */
    merchantRef: string | null;
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
        merchantRef: row.merchantRef ?? null,
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

// ─────────────────────────────────────────────────────────────────────────────
// The earnings-account directory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One owner's four balances, as the Accounts screen reads them.
 *
 * ── Two changes worth knowing about ─────────────────────────────────────────
 * This endpoint used to be a verbatim pass-through of jovi-mall's payload, typed
 * `unknown` on the gateway and undocumented in `money.md`. It is mapped now, which is
 * what lets `owner` carry a NAME — the directory previously showed ObjectIds, while
 * `listPayouts` four lines away in the same controller has always hydrated them.
 *
 * ⚠ **The four balances must never be summed together.** They are stages of one pipeline:
 * `requested` is a claim already staked against `available`, so a total double-counts.
 * `meta.totals` sums each of them ACROSS owners, per currency, which is a different and
 * legitimate question — see `EarningsAccountTotals`.
 */
export interface EarningsAccountDto {
    owner: MoneyOwnerRef;
    pending: number;
    available: number;
    reserve: number;
    requested: number;
    currency: string;
    updatedAt: string | null;
}

export function toEarningsAccountDto(
    row: PlatformEarningsAccount,
    names: MoneyOwnerNames,
): EarningsAccountDto {
    return {
        owner: toOwnerRef(row.ownerType, row.ownerId, names),
        pending: row.pending,
        available: row.available,
        reserve: row.reserve,
        requested: row.requested,
        currency: row.currency,
        updatedAt: row.updatedAt ?? null,
    };
}
