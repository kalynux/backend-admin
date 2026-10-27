import { z } from 'zod';
import { listQuery } from '../../../core/http/list-query';
import {
    dateRangeFields,
    dateRangeRule,
    idParam,
    isoDateTime,
    objectId,
    reasonText,
    searchTerm,
} from '../../../core/validation/common.schemas';
import { AUDIT_ACTION_NAMES, AuditAction } from '../../audit/domain/audit.catalog';
import { AUDIT_STATUSES } from '../../audit/domain/audit.types';
import { platformStatus } from '../../orders/validators/order.validator';

/** Request shapes for `/api/v1/bookings` (ADMIN-BOOKINGS-PLAN, 2026-10-27). */

export const BookingIdParamSchema = idParam('bookingId', 'booking');

/**
 * jovi-mall's booking vocabularies, for documentation and DTO typing only — NOT fed to `z.enum`
 * (ADR-005 D-17: the vocabulary is jovi-mall's, so the filter is a bounded token, and an unknown
 * value answers an empty page rather than a 400).
 */
export const BOOKING_STATUSES = ['pending', 'confirmed', 'completed', 'no-show', 'cancelled'] as const;
export const BOOKING_PAYMENT_STATUSES = [
    'unpaid', 'pending', 'paid', 'disputed', 'failed', 'refund_pending', 'refunded',
] as const;

/** `no-show` carries a hyphen, which `platformStatus` refuses — so the booking status gets its own bound. */
const bookingStatusToken = z.string().trim().min(2).max(40).regex(/^[a-z_-]+$/, {
    message: 'Not a valid booking status',
});

/**
 * The "needs attention" lists. THIS vocabulary is ours (D-17), so it is pinned. Each is defined
 * once, in `bookingQueueClause`, and counted by `GET /bookings/queues`.
 */
export const BOOKING_QUEUES = [
    /** Payment `pending` for more than 30 minutes — the provider never answered, or the booking never heard. */
    'payment_stuck',
    /** A `manual` booking still waiting for the vendor less than 24 hours before it starts (or already past). */
    'awaiting_confirmation',
    /** The end time has passed and it is still `confirmed` — never marked completed or no-show. */
    'unfinished',
    /** A proposal of a new time is waiting for an answer. */
    'open_proposal',
    /** A refund is open, or the card payment is disputed. */
    'refund_open',
    /** A PAID no-show: its money is held until an administrator completes or cancels it (owner, 2026-10-27). */
    'paid_no_show',
    /** Completed, payment required, and still not paid — usually cash nobody recorded. */
    'completed_unpaid',
] as const;
export type BookingQueue = (typeof BOOKING_QUEUES)[number];

/**
 * Wire name → `bookings` field. `startAt` only: it is the one sort every booking index can serve
 * (`{startAt}`, `{status, startAt}`, `{vendorId, startAt}`, `{productId, startAt, status}`), and
 * "when is the appointment" is the order an administrator reads bookings in.
 */
export const BOOKING_SORT = { startAt: 'startAt' } as const;

export const BOOKING_ACTIVITY_SORT = { occurredAt: 'occurred_at' } as const;

/** A year and a day, matching the order directory's window. */
export const BOOKING_MAX_RANGE_DAYS = 366;

export const SearchBookingsQuerySchema = listQuery(BOOKING_SORT, '-startAt', {
    /** A booking number (`BKG-…`, prefix), a 24-hex booking id, or a customer / shop name, phone or email. */
    search: searchTerm.optional(),
    status: bookingStatusToken.optional(),
    paymentStatus: platformStatus.optional(),
    queue: z.enum(BOOKING_QUEUES).optional(),
    vendorId: objectId.optional(),
    /** The customer's USER id — the id a booking stores (`bookings.userId`). */
    userId: objectId.optional(),
    /** The service (`bookings.productId`). */
    productId: objectId.optional(),
    /** On the APPOINTMENT time (`startAt`), not on when it was booked. */
    ...dateRangeFields(),
}).superRefine(dateRangeRule({ maxDays: BOOKING_MAX_RANGE_DAYS }));
export type SearchBookingsQuery = z.infer<typeof SearchBookingsQuerySchema>;

export const BOOKING_AUDIT_ACTIONS = AUDIT_ACTION_NAMES.filter(
    (action) => action.startsWith('bookings.') || action.endsWith('_booking'),
) as [AuditAction, ...AuditAction[]];

export const ListBookingActivityQuerySchema = listQuery(BOOKING_ACTIVITY_SORT, '-occurredAt', {
    action: z.enum(BOOKING_AUDIT_ACTIONS).optional(),
    status: z.enum(AUDIT_STATUSES).optional(),
    ...dateRangeFields(),
}).superRefine(dateRangeRule({ maxDays: BOOKING_MAX_RANGE_DAYS }));
export type ListBookingActivityQuery = z.infer<typeof ListBookingActivityQuerySchema>;

/**
 * Whose fault the cancellation is — it decides who bears the payment and transfer fees, nothing
 * else: `vendor` gives the customer 100% back, `customer` takes the fees off. Pinned: it is the
 * argument to jovi-mall's `cancelAsAdmin`, not a stored status.
 */
export const BOOKING_FAULTS = ['vendor', 'customer'] as const;

export const CancelBookingSchema = z.object({
    reason: reasonText('A reason is required to cancel a booking'),
    fault: z.enum(BOOKING_FAULTS),
}).strict();
export type CancelBookingBody = z.infer<typeof CancelBookingSchema>;

/** Every live seat of the class this booking belongs to — same reason and fault for all. */
export const CancelSessionSchema = CancelBookingSchema;
export type CancelSessionBody = CancelBookingBody;

export const CompleteBookingSchema = z.object({
    reason: reasonText('A reason is required to complete a booking for the vendor'),
}).strict();
export type CompleteBookingBody = z.infer<typeof CompleteBookingSchema>;

/** Recording cash is money: the administrator says how they know. */
export const MarkCashPaidSchema = z.object({
    reason: reasonText('Say how the cash payment was confirmed'),
}).strict();
export type MarkCashPaidBody = z.infer<typeof MarkCashPaidSchema>;

/** Re-check, withdraw and resend: a note is welcome, never required. */
export const OptionalNoteSchema = z.object({
    reason: z.string().trim().max(500).optional(),
}).strict();
export type OptionalNoteBody = z.infer<typeof OptionalNoteSchema>;

export const ServiceIdParamSchema = idParam('productId', 'service');

/** What jovi-mall's slot list accepts: an explicit window, at most 31 days. */
export const ServiceAvailabilityQuerySchema = z.object({
    from: isoDateTime,
    to: isoDateTime,
}).superRefine(dateRangeRule({ maxDays: 31 }));
export type ServiceAvailabilityQuery = z.infer<typeof ServiceAvailabilityQuerySchema>;
