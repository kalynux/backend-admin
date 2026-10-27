import { Document, Filter, ObjectId } from 'mongodb';
import { Types } from 'mongoose';
import { escapeRegex, toMongoSort } from '../../../core/data/mongo-list';
import { COLLECTIONS } from '../../../infra/platform/collections';
import { Paginated, PlatformReadRepository } from '../../../infra/platform/platform.repository';
import { BOOKING_QUEUES, BOOKING_SORT, BookingQueue, SearchBookingsQuery } from '../validators/booking.validator';

/**
 * Service bookings, read directly (ADR-004 D-2: direct read, delegated write) — the counterpart of
 * `order.read.repository.ts` for bookable services (ADMIN-BOOKINGS-PLAN, 2026-10-27).
 *
 * ── What the projection leaves out, and why ───────────────────────────────────
 * - `location.coordinates` and `location.sourceAddressId`: on a `customer_address` service the
 *   place IS the customer's home. The address lines are what Support needs to answer "where is my
 *   appointment"; the coordinates are not (the order rule — `ORDER_DETAIL_PROJECTION`).
 * - `metadata` except `metadata.notes`: a `Mixed` bag. The customer's note is useful on a ticket;
 *   the rest is display detail jovi-mall keeps for itself.
 * - `externalCalendarEventId` is KEPT: "it isn't on the vendor's calendar" is a real ticket.
 *
 * `access` IS projected — and withheld from callers without `bookings.access.read` by the DTO,
 * never sent to them. The link is a way into the vendor's session (decision 2, 2026-10-27).
 *
 * ⚠ **`deletedAt: null` is pinned in `buildBookingFilter`.** The raw driver applies nothing.
 */

export interface BookingStatusChangeReadModel {
    from: string | null;
    to: string;
    at: Date;
    actorRole: string;
    actorId: string | null;
    reason: string | null;
}

export interface BookingReadModel extends Document {
    _id: ObjectId;
    bookingNumber?: string | null;
    productId: ObjectId;
    userId: ObjectId;
    vendorId: ObjectId;
    startAt: Date;
    endAt: Date;
    status: string;
    paymentStatus: string;
    paymentMethod?: string | null;
    paymentTransactionId?: ObjectId | null;
    paidAt?: Date | null;
    priceSnapshot: number;
    currency: string;
    requiresPayment: boolean;
    cancelledAt?: Date | null;
    cancelledReason?: string | null;
    completedAt?: Date | null;
    externalCalendarEventId?: string | null;
    metadata?: { notes?: string | null } | null;
    settlement?: {
        finalPrice: number;
        pricingMode: string;
        settledAt: Date;
        balanceDue: number;
        balancePaid: number;
        balancePaidAt?: Date | null;
        balancePaymentMethod?: string | null;
        creditDue: number;
    } | null;
    /** jovi-mall's `EarningsPauseSchema` — snake_case inside a camelCase document. */
    earningsPause?: {
        active?: boolean;
        reason?: string | null;
        note?: string | null;
        paused_at?: Date | null;
    } | null;
    location?: {
        kind: string;
        label?: string | null;
        addressLine1?: string | null;
        addressLine2?: string | null;
        city?: string | null;
        state?: string | null;
        country?: string | null;
        formattedAddress?: string | null;
    } | null;
    access?: {
        instructions?: string | null;
        meetingUrl?: string | null;
        revealMinutesBefore?: number | null;
    } | null;
    rescheduleProposal?: {
        status: string;
        proposedBy: string;
        startAt: Date;
        endAt: Date;
        previousStartAt: Date;
        previousEndAt: Date;
        proposedAt: Date;
        expiresAt: Date;
        answeredAt?: Date | null;
    } | null;
    statusHistory?: BookingStatusChangeReadModel[];
    createdAt: Date;
    updatedAt: Date;
}

/** The list: who, what, when, and the two statuses — nothing that needs a detail screen. */
const BOOKING_LIST_PROJECTION = {
    _id: 1,
    bookingNumber: 1,
    productId: 1,
    userId: 1,
    vendorId: 1,
    startAt: 1,
    endAt: 1,
    status: 1,
    paymentStatus: 1,
    paymentMethod: 1,
    priceSnapshot: 1,
    currency: 1,
    requiresPayment: 1,
    'rescheduleProposal.status': 1,
    'rescheduleProposal.expiresAt': 1,
    'location.kind': 1,
    createdAt: 1,
    updatedAt: 1,
} as const;

const BOOKING_DETAIL_PROJECTION = {
    ...BOOKING_LIST_PROJECTION,
    paymentTransactionId: 1,
    paidAt: 1,
    cancelledAt: 1,
    cancelledReason: 1,
    completedAt: 1,
    externalCalendarEventId: 1,
    'metadata.notes': 1,
    settlement: 1,
    earningsPause: 1,
    rescheduleProposal: 1,
    'location.label': 1,
    'location.addressLine1': 1,
    'location.addressLine2': 1,
    'location.city': 1,
    'location.state': 1,
    'location.country': 1,
    'location.formattedAddress': 1,
    access: 1,
    statusHistory: 1,
} as const;

/** How long a payment may sit at `pending` before the `payment_stuck` list shows it. */
export const PAYMENT_STUCK_AFTER_MS = 30 * 60_000;
/** How close to its start an unconfirmed `manual` booking joins `awaiting_confirmation`. */
export const AWAITING_CONFIRMATION_WITHIN_MS = 24 * 3_600_000;

/**
 * The one definition of each "needs attention" list. Pure, and exported for the suite.
 *
 * Every clause leads with a field the booking indexes serve (`status` → `{status, startAt}`,
 * `paymentStatus` → `{paymentStatus}`), so a queue is never a collection scan.
 */
export function bookingQueueClause(queue: BookingQueue, now: Date): Record<string, unknown> {
    switch (queue) {
        case 'payment_stuck':
            return { paymentStatus: 'pending', updatedAt: { $lt: new Date(now.getTime() - PAYMENT_STUCK_AFTER_MS) } };
        case 'awaiting_confirmation':
            return { status: 'pending', startAt: { $lt: new Date(now.getTime() + AWAITING_CONFIRMATION_WITHIN_MS) } };
        case 'unfinished':
            return { status: 'confirmed', endAt: { $lt: now } };
        case 'open_proposal':
            return {
                status: { $in: ['pending', 'confirmed'] },
                'rescheduleProposal.status': 'open',
                'rescheduleProposal.expiresAt': { $gt: now },
            };
        case 'refund_open':
            return { paymentStatus: { $in: ['refund_pending', 'disputed'] } };
        case 'paid_no_show':
            return { status: 'no-show', paymentStatus: 'paid' };
        case 'completed_unpaid':
            return { status: 'completed', requiresPayment: true, paymentStatus: { $nin: ['paid', 'refund_pending', 'refunded'] } };
    }
}

/** A free-text term resolved, BEFORE the booking query, to the people it can name. */
export interface BookingSearchResolution {
    /** Customers' USER ids — `bookings.userId` holds a `users._id`, not a `customers._id`. */
    userIds: ObjectId[];
    vendorIds: ObjectId[];
    truncated: boolean;
}

/**
 * The free-text branch. A booking number is `BKG-2026-000123`, always uppercase, behind a unique
 * index — so an anchored, case-sensitive prefix uses it (the order rule).
 */
function searchClause(term: string, resolved: BookingSearchResolution): Record<string, unknown> {
    const branches: Record<string, unknown>[] = [];
    if (/^[A-Za-z]/.test(term)) {
        branches.push({ bookingNumber: new RegExp('^' + escapeRegex(term.toUpperCase())) });
    }
    if (term.length === 24 && Types.ObjectId.isValid(term)) {
        const id = new ObjectId(term);
        branches.push({ _id: id }, { userId: id }, { vendorId: id }, { productId: id });
    }
    if (resolved.userIds.length > 0) branches.push({ userId: { $in: resolved.userIds } });
    if (resolved.vendorIds.length > 0) branches.push({ vendorId: { $in: resolved.vendorIds } });
    // A term that matched nothing returns nothing, never everything.
    if (branches.length === 0) return { _id: { $in: [] } };
    return { $or: branches };
}

/** Translate a validated query into a Mongo filter. Pure and exported — the suite imports it. */
export function buildBookingFilter(
    query: Omit<SearchBookingsQuery, 'page' | 'limit' | 'sort'>,
    resolved: BookingSearchResolution = { userIds: [], vendorIds: [], truncated: false },
    now: Date = new Date(),
): Filter<BookingReadModel> {
    const clauses: Record<string, unknown>[] = [{ deletedAt: null }];

    if (query.status) clauses.push({ status: query.status });
    if (query.paymentStatus) clauses.push({ paymentStatus: query.paymentStatus });
    if (query.vendorId) clauses.push({ vendorId: new ObjectId(query.vendorId) });
    if (query.userId) clauses.push({ userId: new ObjectId(query.userId) });
    if (query.productId) clauses.push({ productId: new ObjectId(query.productId) });
    if (query.queue) clauses.push(bookingQueueClause(query.queue, now));

    if (query.from || query.to) {
        const range: Record<string, Date> = {};
        if (query.from) range.$gte = query.from;
        if (query.to) range.$lt = query.to; // half-open, matching `dateRangeFields`
        clauses.push({ startAt: range });
    }

    if (query.search) clauses.push(searchClause(query.search, resolved));

    return { $and: clauses } as Filter<BookingReadModel>;
}

export class BookingReadRepository extends PlatformReadRepository<BookingReadModel> {
    constructor() {
        super(COLLECTIONS.BOOKING, BOOKING_LIST_PROJECTION);
    }

    async search(query: SearchBookingsQuery, resolved: BookingSearchResolution): Promise<Paginated<BookingReadModel>> {
        return this.findPage(buildBookingFilter(query, resolved), {
            page: query.page,
            limit: query.limit,
            sort: toMongoSort(query.sort, BOOKING_SORT),
        });
    }

    /** How many bookings sit in each "needs attention" list right now. Seven indexed counts. */
    async countQueues(now: Date = new Date()): Promise<Record<BookingQueue, number>> {
        const counts = await Promise.all(
            BOOKING_QUEUES.map((queue) =>
                this.countBy({ $and: [{ deletedAt: null }, bookingQueueClause(queue, now)] } as Filter<BookingReadModel>),
            ),
        );
        return Object.fromEntries(BOOKING_QUEUES.map((queue, i) => [queue, counts[i]])) as Record<BookingQueue, number>;
    }

    /** The list projection — enough to 404 and to label an audit row. */
    async findById(bookingId: string): Promise<BookingReadModel | null> {
        if (!ObjectId.isValid(bookingId) || bookingId.length !== 24) return null;
        return this.findOneBy({ _id: new ObjectId(bookingId), deletedAt: null } as Filter<BookingReadModel>);
    }

    /** The detail projection — see the header for what it leaves out. */
    async findDetailById(bookingId: string): Promise<BookingReadModel | null> {
        if (!ObjectId.isValid(bookingId) || bookingId.length !== 24) return null;
        const rows = await this.findBy(
            { _id: new ObjectId(bookingId), deletedAt: null } as Filter<BookingReadModel>,
            { projection: BOOKING_DETAIL_PROJECTION, limit: 1 },
        );
        return rows[0] ?? null;
    }

    /**
     * The other seats of a group class: same service, same start, still live. Served by
     * `{productId, startAt, status}`. Bounded — a class is a handful of seats, never a feed.
     */
    async findSessionSeats(productId: ObjectId, startAt: Date, excludeId: ObjectId): Promise<BookingReadModel[]> {
        return this.findBy(
            {
                productId,
                startAt,
                status: { $in: ['pending', 'confirmed'] },
                deletedAt: null,
                _id: { $ne: excludeId },
            } as Filter<BookingReadModel>,
            { sort: { createdAt: 1, _id: 1 }, limit: 100 },
        );
    }
}
