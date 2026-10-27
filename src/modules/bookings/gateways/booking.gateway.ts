import { platformRequest } from '../../../infra/platform/platform.client';
import { auditedAttempt } from '../../audit/domain/audit.writer';
import { ActorContext } from '../../audit/domain/audit-context';
import { AuditAction } from '../../audit/domain/audit.catalog';

/**
 * The booking domain's WRITE half, reached over jovi-mall's `/api/internal/admin/bookings`
 * (ADMIN-BOOKINGS-PLAN § 4).
 *
 * ── Why a booking write is delegated when the read is not ─────────────────────
 * None of these is a status column. A cancellation detaches the calendar event (or one seat of a
 * shared class event), opens the refund request and tells the customer; a completion starts the
 * earnings hold; recording cash runs the vendor's own rule and re-colours the calendar; the
 * re-check asks the payment provider and runs the success or failure path. A second writer would
 * reproduce the field and miss every effect — ADR-004 D-2.
 *
 * ── Audited intent → outcome, fail-closed ─────────────────────────────────────
 * The intent row commits BEFORE the request, so with the audit store down nothing is changed.
 * The thin methods below are the whole point: this file should never grow logic.
 */

/** What the booking looked like before the write, from the caller's own 404 read. */
export type BookingSnapshot = Record<string, unknown> | null;

function auditedDelegation<T>(
    action: AuditAction,
    context: ActorContext,
    bookingId: string,
    payload: Record<string, unknown> | null,
    before: BookingSnapshot,
    perform: () => Promise<T>,
): Promise<T> {
    const label = typeof before?.bookingNumber === 'string' ? before.bookingNumber : null;
    return auditedAttempt(
        {
            action,
            actor: {
                kind: 'administrator',
                id: context.actor.adminId,
                email: context.actor.email,
                displayName: context.actor.displayName,
                tier: context.actor.tier,
                sessionId: context.actor.sessionId,
            },
            target: { type: 'booking', id: bookingId, label },
            context: {
                method: context.method,
                path: context.path,
                requestId: context.requestId,
                ip: context.ip,
                userAgent: context.userAgent,
            },
            payload,
        },
        async () => {
            const result = await perform();
            return { result, before, after: asState(result) };
        },
    );
}

/** The fields worth diffing — jovi-mall's thin acknowledgement, or the re-check / session result. */
function asState(result: unknown): Record<string, unknown> | null {
    if (!result || typeof result !== 'object') return null;
    const r = result as Record<string, unknown>;
    const state: Record<string, unknown> = {};
    for (const key of ['status', 'paymentStatus', 'rescheduleProposalStatus', 'outcome', 'paymentStatusAfter', 'sent']) {
        if (key in r) state[key] = r[key];
    }
    if (Array.isArray(r.cancelled)) state.cancelled = r.cancelled;
    if (Array.isArray(r.failed)) state.failed = r.failed;
    return Object.keys(state).length > 0 ? state : null;
}

async function post<T>(path: string, body: Record<string, unknown>, context: ActorContext): Promise<T> {
    const result = await platformRequest<T>({
        method: 'POST',
        path,
        body,
        actor: context.actor,
        requestId: context.requestId,
    });
    return result.data;
}

/** jovi-mall's acknowledgement — never the booking document. */
export interface PlatformBookingAck {
    id: string;
    bookingNumber: string | null;
    status: string;
    paymentStatus: string;
    rescheduleProposalStatus: string | null;
}

export interface PlatformPaymentRecheck {
    outcome: 'settled' | 'still_pending' | 'released';
    paymentStatusBefore: string;
    paymentStatusAfter: string;
    transaction: { id: string; status: string; gateway: string } | null;
}

export interface PlatformSessionCancel {
    productId: string;
    startAt: string;
    cancelled: Array<{ bookingId: string; bookingNumber: string | null }>;
    failed: Array<{ bookingId: string; bookingNumber: string | null; code: string }>;
}

export interface PlatformAccessState {
    state: 'open' | 'locked' | 'closed';
    reason: string | null;
    opensAt: string;
    closesAt: string;
    hasInstructions: boolean;
    hasMeetingUrl: boolean;
    revealMinutesBefore: number | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// The writes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cancel for a party. `fault` decides who bears the payment and transfer fees: `vendor` → the
 * customer gets 100% back. The vendor's cancellation policy is NOT applied. jovi-mall refuses a
 * completed booking (`409 BOOKING_TERMINAL_STATE` — refund it through the refund queue) and a
 * cancelled one (`409 BOOKING_ALREADY_CANCELLED`).
 */
export function cancel(
    bookingId: string,
    input: { reason: string; fault: 'vendor' | 'customer' },
    before: BookingSnapshot,
    context: ActorContext,
): Promise<PlatformBookingAck> {
    return auditedDelegation('bookings.cancel', context, bookingId, input, before, () =>
        post<PlatformBookingAck>(`/bookings/${bookingId}/cancel`, input, context));
}

/**
 * Every live seat of the class this booking belongs to. jovi-mall cancels them one at a time and
 * REPORTS a seat it could not cancel rather than stopping; the audit row records both lists.
 */
export function cancelSession(
    bookingId: string,
    input: { productId: string; startAt: Date; reason: string; fault: 'vendor' | 'customer' },
    before: BookingSnapshot,
    context: ActorContext,
): Promise<PlatformSessionCancel> {
    return auditedDelegation(
        'bookings.cancel_session',
        context,
        bookingId,
        { productId: input.productId, startAt: input.startAt.toISOString(), reason: input.reason, fault: input.fault },
        before,
        () => post<PlatformSessionCancel>(`/bookings/services/${input.productId}/sessions/cancel`, {
            startAt: input.startAt.toISOString(),
            reason: input.reason,
            fault: input.fault,
        }, context),
    );
}

/**
 * Complete for the vendor — the vendor is paid once the ordinary hold ends. jovi-mall refuses an
 * unpaid booking (`409 BOOKING_ADMIN_COMPLETE_UNPAID`), one that has not started
 * (`409 BOOKING_NOT_STARTED`) and any status but `confirmed` / `no-show`.
 */
export function complete(
    bookingId: string,
    reason: string,
    before: BookingSnapshot,
    context: ActorContext,
): Promise<PlatformBookingAck> {
    return auditedDelegation('bookings.complete', context, bookingId, { reason }, before, () =>
        post<PlatformBookingAck>(`/bookings/${bookingId}/complete`, { reason }, context));
}

/** Record a cash payment for the vendor. Every rule is the vendor's own (`markAsPaidByCash`). */
export function markCashPaid(
    bookingId: string,
    reason: string,
    before: BookingSnapshot,
    context: ActorContext,
): Promise<PlatformBookingAck> {
    return auditedDelegation('bookings.payment.mark_cash', context, bookingId, { reason }, before, () =>
        post<PlatformBookingAck>(`/bookings/${bookingId}/payment/cash`, { reason }, context));
}

/** Ask the provider about a payment stuck at `pending`. `409 BOOKING_PAYMENT_STATE_MISMATCH` needs an engineer. */
export function recheckPayment(
    bookingId: string,
    reason: string | undefined,
    before: BookingSnapshot,
    context: ActorContext,
): Promise<PlatformPaymentRecheck> {
    return auditedDelegation('bookings.payment.recheck', context, bookingId, reason ? { reason } : null, before, () =>
        post<PlatformPaymentRecheck>(`/bookings/${bookingId}/payment/recheck`, reason ? { reason } : {}, context));
}

/** Withdraw the open proposal of a new time, whichever side made it. The original time stands. */
export function withdrawProposal(
    bookingId: string,
    reason: string | undefined,
    before: BookingSnapshot,
    context: ActorContext,
): Promise<PlatformBookingAck> {
    return auditedDelegation('bookings.proposal.withdraw', context, bookingId, reason ? { reason } : null, before, () =>
        post<PlatformBookingAck>(`/bookings/${bookingId}/proposal/withdraw`, reason ? { reason } : {}, context));
}

/** Send the customer the appointment reminder again. */
export function resendReminder(
    bookingId: string,
    reason: string | undefined,
    before: BookingSnapshot,
    context: ActorContext,
): Promise<{ sent: boolean; reason: string | null }> {
    return auditedDelegation('bookings.reminder.resend', context, bookingId, reason ? { reason } : null, before, () =>
        post<{ sent: boolean; reason: string | null }>(`/bookings/${bookingId}/reminder`, reason ? { reason } : {}, context));
}

// ─────────────────────────────────────────────────────────────────────────────
// The two VERDICT reads — not audited, not wrapped (ADR-008 D-1)
// ─────────────────────────────────────────────────────────────────────────────

/** Can the customer see the link yet, and why not. jovi-mall never sends the link itself here. */
export async function accessState(bookingId: string, context: ActorContext): Promise<PlatformAccessState | null> {
    const result = await platformRequest<PlatformAccessState | null>({
        method: 'GET',
        path: `/bookings/${bookingId}/access-state`,
        actor: context.actor,
        requestId: context.requestId,
    });
    return result.data;
}

/** The times a customer would be offered, as the storefront computes them. */
export async function availability(
    productId: string,
    from: Date,
    to: Date,
    context: ActorContext,
): Promise<{ productId: string; from: string; to: string; slots: unknown[] }> {
    const result = await platformRequest<{ productId: string; from: string; to: string; slots: unknown[] }>({
        method: 'GET',
        path: `/bookings/services/${productId}/availability`,
        query: { from: from.toISOString(), to: to.toISOString() },
        actor: context.actor,
        requestId: context.requestId,
    });
    return result.data;
}
