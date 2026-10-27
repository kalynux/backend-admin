import { Request, Response } from 'express';
import { ObjectId } from 'mongodb';
import { asyncHandler } from '../../../core/http/async-handler';
import { createAppError } from '../../../core/errors/app-error';
import { ERROR_CODES } from '../../../core/errors/error-codes';
import { toPageMeta } from '../../../core/http/list-query';
import { sendPaginated, sendSuccess } from '../../../core/http/responses';
import { actorContextOf } from '../../audit/domain/audit-context';
import { requireAdminIdentity } from '../../admin-identity/domain/admin-identity.types';
import { toAuditEntryDto } from '../../audit/domain/audit.dto';
import { AuditRepository } from '../../audit/repositories/audit.repository';
import { ListAuditQuery } from '../../audit/validators/audit.validator';
import { hasPermission } from '../../authorization/domain/permission.resolver';
import { AdminAccountRepository } from '../../admin-identity/repositories/admin-account.repository';
import { CustomerRefReadRepository, VendorRefReadRepository } from '../../orders/repositories/order-context.read.repository';
import { StoreReadRepository } from '../../vendors/repositories/store.read.repository';
import { VendorProductReadRepository } from '../../vendors/repositories/vendor-product.read.repository';
import { PaymentTransactionReadRepository } from '../../money/repositories/payment-transaction.read.repository';
import { EarningsAllocationReadRepository } from '../../money/repositories/earnings.read.repository';
import { RefundRequestReadRepository } from '../../refunds/repositories/refund-request.read.repository';
import * as gateway from '../gateways/booking.gateway';
import {
    BookingReadModel,
    BookingReadRepository,
    BookingSearchResolution,
} from '../repositories/booking.read.repository';
import {
    BookingDetailDto,
    BookingNames,
    StatusActorNames,
    statusActorKey,
    toBookingDetailDto,
    toBookingListItemDto,
} from '../read-models/booking.dto';
import {
    CancelBookingBody,
    CancelSessionBody,
    CompleteBookingBody,
    ListBookingActivityQuery,
    MarkCashPaidBody,
    OptionalNoteBody,
    SearchBookingsQuery,
    ServiceAvailabilityQuery,
} from '../validators/booking.validator';

const bookings = new BookingReadRepository();
const customers = new CustomerRefReadRepository();
const vendors = new VendorRefReadRepository();
const stores = new StoreReadRepository();
const products = new VendorProductReadRepository();
const payments = new PaymentTransactionReadRepository();
const allocations = new EarningsAllocationReadRepository();
const refunds = new RefundRequestReadRepository();
const admins = new AdminAccountRepository();
const audit = new AuditRepository();

/** The meeting link and instructions — tiers 1 + 2 only (decision 2, 2026-10-27). */
export const ACCESS_TEXT_PERMISSION = 'bookings.access.read' as const;

async function loadOr404(bookingId: string): Promise<BookingReadModel> {
    const booking = await bookings.findById(bookingId);
    if (!booking) throw createAppError(ERROR_CODES.NOT_FOUND, 404, 'Booking not found');
    return booking;
}

/** The audit `before` — the fields these writes can change, and how to recognise the row. */
function toAuditState(booking: BookingReadModel): Record<string, unknown> {
    return {
        bookingNumber: booking.bookingNumber ?? null,
        status: booking.status,
        paymentStatus: booking.paymentStatus,
        startAt: booking.startAt,
        price: booking.priceSnapshot,
        currency: booking.currency,
        proposalStatus: booking.rescheduleProposal?.status ?? null,
    };
}

/** Customer, shop and service names for a set of bookings, in three batched reads. */
async function hydrateNames(page: BookingReadModel[]): Promise<BookingNames> {
    const unique = (ids: ObjectId[]) => [...new Set(ids.map(String))].map((id) => new ObjectId(id));
    const [customer, vendor, service] = await Promise.all([
        customers.findContactsByUserIds(unique(page.map((b) => b.userId))),
        stores.findNamesByVendorIds(unique(page.map((b) => b.vendorId))),
        products.findTitlesByIds(unique(page.map((b) => b.productId))),
    ]);
    return { customer, vendor, service };
}

/**
 * Who wrote each status-history row. `customer` ids are USER ids and `vendor` ids are vendor ids,
 * both already resolved by `hydrateNames` for this booking; `admin` ids are wi-admin accounts,
 * resolved in THIS service's own database (jovi-mall cannot answer it — the order timeline's rule).
 */
async function hydrateStatusActors(booking: BookingReadModel, names: BookingNames): Promise<StatusActorNames> {
    const history = booking.statusHistory ?? [];
    const adminIds = [...new Set(history.filter((h) => h.actorRole === 'admin' && h.actorId).map((h) => h.actorId!))];
    const adminNames = adminIds.length > 0 ? await admins.findDisplayNamesByIds(adminIds) : new Map<string, string>();

    const resolved: StatusActorNames = new Map();
    for (const [id, name] of adminNames) resolved.set(statusActorKey('admin', id), name);
    for (const [id, c] of names.customer) resolved.set(statusActorKey('customer', id), c.name);
    for (const [id, name] of names.vendor) resolved.set(statusActorKey('vendor', id), name);
    return resolved;
}

/**
 * The booking detail through the PROJECTED path — the single function behind the GET and every
 * write's response, so a write can never answer with more than the read shows (the order rule).
 * Returns null rather than throwing: after a write has committed, a 404 would tell the client the
 * opposite of what happened.
 */
async function readBookingDetail(req: Request, bookingId: string): Promise<BookingDetailDto | null> {
    const booking = await bookings.findDetailById(bookingId);
    if (!booking) return null;

    const [seats, bookingPayments, bookingRefunds, bookingAllocations] = await Promise.all([
        bookings.findSessionSeats(booking.productId, booking.startAt, booking._id),
        payments.forBooking(bookingId),
        refunds.forBooking(bookingId),
        allocations.findForSource('booking', booking._id),
    ]);
    const names = await hydrateNames([booking, ...seats]);
    const actorNames = await hydrateStatusActors(booking, names);
    const seesAccess = hasPermission(requireAdminIdentity(req).tier, ACCESS_TEXT_PERMISSION);

    return toBookingDetailDto(booking, {
        names,
        actorNames,
        allocations: bookingAllocations,
        payments: bookingPayments,
        refunds: bookingRefunds,
        seats,
        seesAccess,
    });
}

/** Answer a write with the fresh detail and jovi-mall's own result beside it. */
async function respondAfterWrite(req: Request, res: Response, bookingId: string, result: unknown, message: string) {
    const booking = await readBookingDetail(req, bookingId);
    sendSuccess(res, { booking, result }, { message });
}

export class BookingController {
    /**
     * GET /api/v1/bookings — search and filter the platform's bookings.
     *
     * A free-text term can name a customer or a shop, neither of which lives on the booking, so it
     * is resolved against both first (capped, reported in `meta.searchMatchesTruncated`), and the
     * booking page is served from its own index — the order directory's rule.
     */
    static search = asyncHandler(async (req: Request, res: Response) => {
        const query = req.query as unknown as SearchBookingsQuery;

        let resolution: BookingSearchResolution = { userIds: [], vendorIds: [], truncated: false };
        if (query.search) {
            const [customerMatch, vendorMatch, storeMatch] = await Promise.all([
                customers.findUserIdsMatching(query.search),
                vendors.findIdsMatching(query.search),
                stores.findVendorIdsByName(query.search),
            ]);
            resolution = {
                userIds: customerMatch.ids,
                vendorIds: [...vendorMatch.ids, ...storeMatch.ids],
                truncated: customerMatch.truncated || vendorMatch.truncated || storeMatch.truncated,
            };
        }

        const page = await bookings.search(query, resolution);
        const names = await hydrateNames(page.items);

        sendPaginated(
            res,
            page.items.map((booking) => toBookingListItemDto(booking, names)),
            {
                ...toPageMeta(page.total, page.page, page.limit),
                ...(resolution.truncated ? { searchMatchesTruncated: true } : {}),
            },
        );
    });

    /** GET /api/v1/bookings/queues — how many bookings sit in each "needs attention" list. */
    static queues = asyncHandler(async (_req: Request, res: Response) => {
        sendSuccess(res, await bookings.countQueues());
    });

    /** GET /api/v1/bookings/:bookingId */
    static detail = asyncHandler(async (req: Request, res: Response) => {
        const dto = await readBookingDetail(req, req.params.bookingId);
        if (!dto) throw createAppError(ERROR_CODES.NOT_FOUND, 404, 'Booking not found');
        sendSuccess(res, dto);
    });

    /** GET /api/v1/bookings/:bookingId/activity — what ADMINISTRATORS did to this booking. */
    static activity = asyncHandler(async (req: Request, res: Response) => {
        const identity = requireAdminIdentity(req);
        const query = req.query as unknown as ListBookingActivityQuery;
        await loadOr404(req.params.bookingId);

        const page = await audit.search(
            {
                page: query.page,
                limit: query.limit,
                sort: query.sort,
                action: query.action,
                status: query.status,
                from: query.from,
                to: query.to,
                // Fixed by the path — a caller cannot widen it.
                targetType: 'booking',
                targetId: req.params.bookingId,
            } as ListAuditQuery,
            identity,
        );
        sendPaginated(res, page.items.map(toAuditEntryDto), page.meta);
    });

    /**
     * GET /api/v1/bookings/:bookingId/access — can the CUSTOMER see the link and instructions yet,
     * and why not (`not_confirmed`, `not_paid`, `too_early`, `ended`). Delegated: it is the
     * verdict jovi-mall's customer read applies (ADR-008 D-1). The text itself rides on the
     * detail, for `bookings.access.read` only.
     */
    static access = asyncHandler(async (req: Request, res: Response) => {
        await loadOr404(req.params.bookingId);
        sendSuccess(res, await gateway.accessState(req.params.bookingId, actorContextOf(req)));
    });

    /** GET /api/v1/bookings/services/:productId/availability?from&to — the times a customer would be offered. */
    static availability = asyncHandler(async (req: Request, res: Response) => {
        const query = req.query as unknown as ServiceAvailabilityQuery;
        sendSuccess(res, await gateway.availability(req.params.productId, query.from, query.to, actorContextOf(req)));
    });

    /** POST /api/v1/bookings/:bookingId/cancel — `{ reason, fault }`. */
    static cancel = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as CancelBookingBody;
        const booking = await loadOr404(req.params.bookingId);
        const result = await gateway.cancel(req.params.bookingId, body, toAuditState(booking), actorContextOf(req));
        await respondAfterWrite(req, res, req.params.bookingId, result, 'Booking cancelled — the customer’s refund follows the ordinary cancellation refund');
    });

    /**
     * POST /api/v1/bookings/:bookingId/session/cancel — every live seat of this booking's class.
     * The class is read off THIS booking (same service, same start), so the audit row points at a
     * booking that exists rather than at a service id.
     */
    static cancelSession = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as CancelSessionBody;
        const booking = await loadOr404(req.params.bookingId);
        const result = await gateway.cancelSession(
            req.params.bookingId,
            { productId: booking.productId.toString(), startAt: booking.startAt, reason: body.reason, fault: body.fault },
            toAuditState(booking),
            actorContextOf(req),
        );
        await respondAfterWrite(
            req,
            res,
            req.params.bookingId,
            result,
            result.failed.length === 0
                ? `Cancelled ${result.cancelled.length} booking(s) in this class`
                : `Cancelled ${result.cancelled.length} booking(s); ${result.failed.length} could not be cancelled`,
        );
    });

    /** POST /api/v1/bookings/:bookingId/complete — `{ reason }`. */
    static complete = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as CompleteBookingBody;
        const booking = await loadOr404(req.params.bookingId);
        const result = await gateway.complete(req.params.bookingId, body.reason, toAuditState(booking), actorContextOf(req));
        await respondAfterWrite(req, res, req.params.bookingId, result, 'Booking completed — the vendor is paid when the hold ends');
    });

    /** POST /api/v1/bookings/:bookingId/payment/cash — `{ reason }`. */
    static markCashPaid = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as MarkCashPaidBody;
        const booking = await loadOr404(req.params.bookingId);
        const result = await gateway.markCashPaid(req.params.bookingId, body.reason, toAuditState(booking), actorContextOf(req));
        await respondAfterWrite(req, res, req.params.bookingId, result, 'Cash payment recorded');
    });

    /** POST /api/v1/bookings/:bookingId/payment/recheck */
    static recheckPayment = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as OptionalNoteBody;
        const booking = await loadOr404(req.params.bookingId);
        const result = await gateway.recheckPayment(req.params.bookingId, body.reason, toAuditState(booking), actorContextOf(req));
        const message = result.outcome === 'settled'
            ? `The provider answered — the payment is now ${result.paymentStatusAfter}`
            : result.outcome === 'released'
                ? 'The last attempt had failed — the booking is free to be paid again'
                : 'The provider still has this payment in flight — nothing changed';
        await respondAfterWrite(req, res, req.params.bookingId, result, message);
    });

    /** POST /api/v1/bookings/:bookingId/proposal/withdraw */
    static withdrawProposal = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as OptionalNoteBody;
        const booking = await loadOr404(req.params.bookingId);
        const result = await gateway.withdrawProposal(req.params.bookingId, body.reason, toAuditState(booking), actorContextOf(req));
        await respondAfterWrite(req, res, req.params.bookingId, result, 'Proposal withdrawn — the original time stands');
    });

    /** POST /api/v1/bookings/:bookingId/reminder */
    static resendReminder = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as OptionalNoteBody;
        const booking = await loadOr404(req.params.bookingId);
        const result = await gateway.resendReminder(req.params.bookingId, body.reason, toAuditState(booking), actorContextOf(req));
        await respondAfterWrite(
            req,
            res,
            req.params.bookingId,
            result,
            result.sent ? 'Reminder sent to the customer' : 'Nothing sent — this booking has no customer profile to notify',
        );
    });
}
