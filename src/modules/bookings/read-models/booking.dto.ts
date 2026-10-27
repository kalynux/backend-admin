import { BookingReadModel, BookingStatusChangeReadModel } from '../repositories/booking.read.repository';
import { PaymentTransactionReadModel } from '../../money/repositories/payment-transaction.read.repository';
import { RefundRequestReadModel } from '../../refunds/repositories/refund-request.read.repository';
import { EarningsAllocationReadModel } from '../../money/repositories/earnings.read.repository';

/**
 * The wire shape of `/api/v1/bookings` (ADMIN-BOOKINGS-PLAN § 2). camelCase, ids as strings, and
 * every person named next to their id — "who is involved" is the question this screen is for.
 */

export interface BookingParty {
    id: string;
    name: string | null;
}

export interface BookingCustomerParty extends BookingParty {
    /** The `customers._id` — what the user directory's customer profile is keyed on. Null when there is none. */
    customerId: string | null;
    phone: string | null;
    email: string | null;
}

export interface BookingNames {
    customer: Map<string, { customerId: string; name: string | null; phone: string | null; email: string | null }>;
    vendor: Map<string, string | null>;
    service: Map<string, string | null>;
}

export interface BookingListItemDto {
    id: string;
    bookingNumber: string | null;
    status: string;
    paymentStatus: string;
    paymentMethod: string | null;
    startAt: Date;
    endAt: Date;
    price: number;
    currency: string;
    requiresPayment: boolean;
    locationKind: string | null;
    /** True while a proposal of a new time waits for an answer. */
    proposalOpen: boolean;
    service: BookingParty;
    vendor: BookingParty;
    customer: BookingCustomerParty;
    createdAt: Date;
}

function customerOf(booking: BookingReadModel, names: BookingNames): BookingCustomerParty {
    const userId = booking.userId.toString();
    const found = names.customer.get(userId);
    return {
        id: userId,
        customerId: found?.customerId ?? null,
        name: found?.name ?? null,
        phone: found?.phone ?? null,
        email: found?.email ?? null,
    };
}

function proposalOpen(booking: BookingReadModel, now: Date): boolean {
    const p = booking.rescheduleProposal;
    return !!p && p.status === 'open' && new Date(p.expiresAt).getTime() > now.getTime();
}

export function toBookingListItemDto(booking: BookingReadModel, names: BookingNames, now: Date = new Date()): BookingListItemDto {
    return {
        id: booking._id.toString(),
        bookingNumber: booking.bookingNumber ?? null,
        status: booking.status,
        paymentStatus: booking.paymentStatus,
        paymentMethod: booking.paymentMethod ?? null,
        startAt: booking.startAt,
        endAt: booking.endAt,
        price: booking.priceSnapshot,
        currency: booking.currency,
        requiresPayment: booking.requiresPayment,
        locationKind: booking.location?.kind ?? null,
        proposalOpen: proposalOpen(booking, now),
        service: { id: booking.productId.toString(), name: names.service.get(booking.productId.toString()) ?? null },
        vendor: { id: booking.vendorId.toString(), name: names.vendor.get(booking.vendorId.toString()) ?? null },
        customer: customerOf(booking, names),
        createdAt: booking.createdAt,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// The detail
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where the vendor's money stands, in one word — the answer to "when is the vendor paid".
 *
 * Read off the VENDOR's allocation rows only (the platform's commission follows the same clock).
 * No amounts: those are `money.earnings.read`'s, which Support does not hold, and this block is
 * on a screen Support opens.
 *
 * - `none`        — nothing was split (unpaid, free, or cash not yet recorded);
 * - `waiting`     — held with no release date: the booking is not completed. On a PAID no-show,
 *                   this is the state an administrator resolves (complete or cancel);
 * - `holding`     — completed, released at `holdReleaseAt` unless paused;
 * - `paused`      — never released while paused (a refund, a ticket, a dispute, an administrator);
 * - `released`    — the vendor has it;
 * - `reversed`    — taken back by a refund.
 */
export type BookingEarningsState = 'none' | 'waiting' | 'holding' | 'paused' | 'released' | 'reversed';

export interface BookingEarningsDto {
    state: BookingEarningsState;
    holdReleaseAt: Date | null;
    releasedAt: Date | null;
    pause: { reason: string | null; note: string | null; pausedAt: Date | null } | null;
}

export function deriveEarnings(booking: BookingReadModel, allocations: EarningsAllocationReadModel[]): BookingEarningsDto {
    const pause = booking.earningsPause?.active
        ? {
            reason: booking.earningsPause.reason ?? null,
            note: booking.earningsPause.note ?? null,
            pausedAt: booking.earningsPause.paused_at ?? null,
        }
        : null;
    const vendorRows = allocations.filter((row) => row.beneficiary_type === 'vendor');
    const rows = vendorRows.length > 0 ? vendorRows : allocations;

    let state: BookingEarningsState;
    if (rows.length === 0) state = 'none';
    else if (rows.every((row) => row.status === 'reversed')) state = 'reversed';
    else if (rows.some((row) => row.status === 'released')) state = 'released';
    else if (pause || rows.some((row) => row.paused_at)) state = 'paused';
    else if (rows.some((row) => row.hold_release_at)) state = 'holding';
    else state = 'waiting';

    const holdReleaseAt = rows.map((row) => row.hold_release_at).find((d) => !!d) ?? null;
    const releasedAt = rows.map((row) => row.released_at).find((d) => !!d) ?? null;
    return { state, holdReleaseAt, releasedAt, pause };
}

export interface BookingPaymentDto {
    id: string;
    purpose: string;
    gateway: string | null;
    method: string | null;
    status: string;
    amount: number;
    currency: string;
    reference: string | null;
    createdAt: Date;
    updatedAt: Date;
}

export function toBookingPaymentDto(row: PaymentTransactionReadModel): BookingPaymentDto {
    return {
        id: row._id.toString(),
        purpose: (row.purpose as string | undefined) ?? 'primary',
        gateway: (row.gateway as string | undefined) ?? null,
        method: (row.method as string | undefined) ?? null,
        status: row.status,
        amount: row.amountSnapshot,
        currency: row.currencySnapshot,
        reference: (row.merchantRef as string | null | undefined) ?? (row.gatewayRef as string | null | undefined) ?? null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}

/** A refund request, summarised. The destination number is NOT here — the refund queue's detail shows it. */
export interface BookingRefundDto {
    id: string;
    status: string;
    reasonKind: string;
    grossAmount: number;
    feeAmount: number | null;
    netAmount: number | null;
    feesPaidBy: string | null;
    currency: string;
    requestedBy: string | null;
    createdAt: Date;
}

export function toBookingRefundDto(row: RefundRequestReadModel): BookingRefundDto {
    return {
        id: row._id.toString(),
        status: row.status,
        reasonKind: row.reason_kind,
        grossAmount: row.gross_amount,
        feeAmount: row.fee_amount ?? null,
        netAmount: row.net_amount ?? null,
        feesPaidBy: row.fees?.paid_by ?? null,
        currency: row.currency,
        requestedBy: row.requested_by?.name ?? row.requested_by?.role ?? null,
        createdAt: row.created_at,
    };
}

export interface BookingStatusChangeDto {
    from: string | null;
    to: string;
    at: Date;
    actorRole: string;
    actorId: string | null;
    /** Who that is — a customer's or shop's name, an administrator's display name, null for `system`. */
    actorName: string | null;
    reason: string | null;
}

/** Keyed on `${role}:${id}` — three id spaces share one map (the order timeline's rule). */
export type StatusActorNames = Map<string, string | null>;
export const statusActorKey = (role: string, id: string): string => `${role}:${id}`;

export function toStatusChangeDto(row: BookingStatusChangeReadModel, names: StatusActorNames): BookingStatusChangeDto {
    return {
        from: row.from ?? null,
        to: row.to,
        at: row.at,
        actorRole: row.actorRole,
        actorId: row.actorId ?? null,
        actorName: row.actorId ? names.get(statusActorKey(row.actorRole, row.actorId)) ?? null : null,
        reason: row.reason ?? null,
    };
}

export interface BookingDetailDto extends BookingListItemDto {
    paidAt: Date | null;
    completedAt: Date | null;
    cancelledAt: Date | null;
    cancelledReason: string | null;
    customerNote: string | null;
    calendarEventId: string | null;
    settlement: BookingReadModel['settlement'] | null;
    location: {
        kind: string;
        label: string | null;
        addressLine1: string | null;
        addressLine2: string | null;
        city: string | null;
        state: string | null;
        country: string | null;
        formattedAddress: string | null;
    } | null;
    /**
     * The link and instructions. `null` when the booking carries none. Their TEXT is present only
     * for a caller holding `bookings.access.read` (`visible: true`); everyone else sees only that
     * they exist. Whether the CUSTOMER can see them yet is `GET /bookings/:id/access`.
     */
    access: {
        visible: boolean;
        hasMeetingUrl: boolean;
        hasInstructions: boolean;
        revealMinutesBefore: number | null;
        meetingUrl?: string | null;
        instructions?: string | null;
    } | null;
    proposal: (NonNullable<BookingReadModel['rescheduleProposal']> & { live: boolean }) | null;
    /** Oldest first. An empty list means "not recorded" (bookings from before 2026-10-27), not "nothing happened". */
    statusHistory: BookingStatusChangeDto[];
    earnings: BookingEarningsDto;
    payments: BookingPaymentDto[];
    refunds: BookingRefundDto[];
    /** The other live seats of the same class — empty for a single-occupancy service. */
    sessionSeats: BookingListItemDto[];
}

export interface BookingDetailContext {
    names: BookingNames;
    actorNames: StatusActorNames;
    allocations: EarningsAllocationReadModel[];
    payments: PaymentTransactionReadModel[];
    refunds: RefundRequestReadModel[];
    seats: BookingReadModel[];
    /** The caller holds `bookings.access.read`. */
    seesAccess: boolean;
}

export function toBookingDetailDto(
    booking: BookingReadModel,
    ctx: BookingDetailContext,
    now: Date = new Date(),
): BookingDetailDto {
    const access = booking.access;
    const hasMeetingUrl = !!access?.meetingUrl;
    const hasInstructions = !!access?.instructions;
    const proposal = booking.rescheduleProposal
        ? { ...booking.rescheduleProposal, live: proposalOpen(booking, now) }
        : null;

    return {
        ...toBookingListItemDto(booking, ctx.names, now),
        paidAt: booking.paidAt ?? null,
        completedAt: booking.completedAt ?? null,
        cancelledAt: booking.cancelledAt ?? null,
        cancelledReason: booking.cancelledReason ?? null,
        customerNote: booking.metadata?.notes ?? null,
        calendarEventId: booking.externalCalendarEventId ?? null,
        settlement: booking.settlement ?? null,
        location: booking.location
            ? {
                kind: booking.location.kind,
                label: booking.location.label ?? null,
                addressLine1: booking.location.addressLine1 ?? null,
                addressLine2: booking.location.addressLine2 ?? null,
                city: booking.location.city ?? null,
                state: booking.location.state ?? null,
                country: booking.location.country ?? null,
                formattedAddress: booking.location.formattedAddress ?? null,
            }
            : null,
        access: hasMeetingUrl || hasInstructions
            ? {
                visible: ctx.seesAccess,
                hasMeetingUrl,
                hasInstructions,
                revealMinutesBefore: access?.revealMinutesBefore ?? null,
                // ⛔ Only for `bookings.access.read`. Absent — not null — otherwise.
                ...(ctx.seesAccess
                    ? { meetingUrl: access?.meetingUrl ?? null, instructions: access?.instructions ?? null }
                    : {}),
            }
            : null,
        proposal,
        statusHistory: (booking.statusHistory ?? []).map((row) => toStatusChangeDto(row, ctx.actorNames)),
        earnings: deriveEarnings(booking, ctx.allocations),
        payments: ctx.payments.map(toBookingPaymentDto),
        refunds: ctx.refunds.map(toBookingRefundDto),
        sessionSeats: ctx.seats.map((seat) => toBookingListItemDto(seat, ctx.names, now)),
    };
}
