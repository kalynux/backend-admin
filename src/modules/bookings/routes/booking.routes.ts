import { Router } from 'express';
import { defineRoute, permission, records } from '../../../api/route-manifest';
import { BookingController } from '../controllers/booking.controller';
import {
    BookingIdParamSchema,
    CancelBookingSchema,
    CancelSessionSchema,
    CompleteBookingSchema,
    ListBookingActivityQuerySchema,
    MarkCashPaidSchema,
    OptionalNoteSchema,
    SearchBookingsQuerySchema,
    ServiceAvailabilityQuerySchema,
    ServiceIdParamSchema,
} from '../validators/booking.validator';

/**
 * `/api/v1/bookings` — service-booking administration (ADMIN-BOOKINGS-PLAN, 2026-10-27).
 *
 * Before this, an administrator could see a booking only from the side — a refund about it, a
 * payment filtered by it, its earnings pause — and a ticket pointing at one linked nowhere. This is
 * the order surface's counterpart: the directory, the "needs attention" lists, the detail with
 * everyone involved, the administrators' activity, and the interventions.
 *
 * ── Four permissions, three audiences ─────────────────────────────────────────
 * | Permission | Tiers | What |
 * |---|---|---|
 * | `bookings.read`        | 1 2 3 | the directory, the detail, the verdict reads |
 * | `bookings.remind`      | 1 2 3 | resend the appointment reminder |
 * | `bookings.access.read` | 1 2   | the meeting link and instructions themselves (on the detail) |
 * | `bookings.intervene`   | 1 2   | re-check a stuck payment, withdraw a stale proposal |
 * | `bookings.settle`      | 1 2   | cancel (refund), complete (vendor paid), record cash — `financial` |
 *
 * ── Route order ───────────────────────────────────────────────────────────────
 * `/queues` and `/services/...` are LITERAL siblings of `/:bookingId` and MUST stay declared above
 * it, or Express reads them as a booking id and answers "Not a valid booking id".
 */
const router = Router();
const mountedAt = '/bookings';

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/',
    access: permission('bookings.read'),
    validate: { query: SearchBookingsQuerySchema },
    handler: BookingController.search,
});

/** Literal — declared before `/:bookingId`. */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/queues',
    access: permission('bookings.read'),
    handler: BookingController.queues,
});

/** Literal — declared before `/:bookingId`. A verdict read, delegated (ADR-008 D-1). */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/services/:productId/availability',
    access: permission('bookings.read'),
    validate: { params: ServiceIdParamSchema, query: ServiceAvailabilityQuerySchema },
    handler: BookingController.availability,
});

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/:bookingId',
    access: permission('bookings.read'),
    validate: { params: BookingIdParamSchema },
    handler: BookingController.detail,
});

/**
 * Two permissions, `all` mode: the rows ARE audit rows and the repository applies the audit read
 * scope to them — requiring only `bookings.read` would make this a second door onto the trail.
 */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/:bookingId/activity',
    access: permission('bookings.read', 'audit.read'),
    validate: { params: BookingIdParamSchema, query: ListBookingActivityQuerySchema },
    handler: BookingController.activity,
});

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/:bookingId/access',
    access: permission('bookings.read'),
    validate: { params: BookingIdParamSchema },
    handler: BookingController.access,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/:bookingId/cancel',
    access: permission('bookings.settle'),
    validate: { params: BookingIdParamSchema, body: CancelBookingSchema },
    audit: records('bookings.cancel'),
    handler: BookingController.cancel,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/:bookingId/session/cancel',
    access: permission('bookings.settle'),
    validate: { params: BookingIdParamSchema, body: CancelSessionSchema },
    audit: records('bookings.cancel_session'),
    handler: BookingController.cancelSession,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/:bookingId/complete',
    access: permission('bookings.settle'),
    validate: { params: BookingIdParamSchema, body: CompleteBookingSchema },
    audit: records('bookings.complete'),
    handler: BookingController.complete,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/:bookingId/payment/cash',
    access: permission('bookings.settle'),
    validate: { params: BookingIdParamSchema, body: MarkCashPaidSchema },
    audit: records('bookings.payment.mark_cash'),
    handler: BookingController.markCashPaid,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/:bookingId/payment/recheck',
    access: permission('bookings.intervene'),
    validate: { params: BookingIdParamSchema, body: OptionalNoteSchema },
    audit: records('bookings.payment.recheck'),
    handler: BookingController.recheckPayment,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/:bookingId/proposal/withdraw',
    access: permission('bookings.intervene'),
    validate: { params: BookingIdParamSchema, body: OptionalNoteSchema },
    audit: records('bookings.proposal.withdraw'),
    handler: BookingController.withdrawProposal,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/:bookingId/reminder',
    access: permission('bookings.remind'),
    validate: { params: BookingIdParamSchema, body: OptionalNoteSchema },
    audit: records('bookings.reminder.resend'),
    handler: BookingController.resendReminder,
});

export const bookingRoutes = router;
