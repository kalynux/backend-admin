/**
 * Service bookings — wi-admin's half (ADMIN-BOOKINGS-PLAN, 2026-10-27).
 *
 * jovi-mall owns every booking rule and write; this service reads `bookings` directly and
 * delegates the rest. What can break on THIS side, silently:
 *
 *   §1  the read pins `deletedAt: null`, and each "needs attention" list is defined once;
 *   §2  the permission split — Support reads and resends a reminder; it never sees the meeting
 *       link, never intervenes, and never decides where money goes (decision 2, 2026-10-27);
 *   §3  every write is audited against a `booking` target with a catalogued action;
 *   §4  the DTO withholds the link from a caller without `bookings.access.read` — the key is
 *       ABSENT, not null — and says where the vendor's money stands without naming amounts;
 *   §5  the gateway's paths are routes jovi-mall actually serves (no shared package — this
 *       cross-repo scan is the contract copy);
 *   §6  a ticket filed against a booking resolves to it.
 *
 * Run: npm run test:bookings
 */
import { suite } from './_assert';

process.env.NODE_ENV = 'test';
process.env.MONGO_URI_PLATFORM = 'mongodb://localhost:27017/jovi_mall_test';
process.env.MONGO_URI_ADMIN = 'mongodb://localhost:27017/wi_admin_test';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.ADMIN_JWT_SECRET = 'test-access-secret-value-32-chars-long';
process.env.ADMIN_JWT_REFRESH_SECRET = 'test-refresh-secret-value-32-chars-long';
process.env.ADMIN_DASHBOARD_ORIGINS = 'http://localhost:5173';

import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { ObjectId } from 'mongodb';
import {
    buildBookingFilter,
    bookingQueueClause,
    BookingReadModel,
    PAYMENT_STUCK_AFTER_MS,
} from '../../src/modules/bookings/repositories/booking.read.repository';
import { deriveEarnings, toBookingDetailDto, BookingNames } from '../../src/modules/bookings/read-models/booking.dto';
import {
    BOOKING_QUEUES,
    CancelBookingSchema,
    CompleteBookingSchema,
    MarkCashPaidSchema,
    OptionalNoteSchema,
    SearchBookingsQuerySchema,
} from '../../src/modules/bookings/validators/booking.validator';
import { PERMISSION_CATALOG as PERMISSIONS } from '../../src/modules/authorization/domain/permission.catalog';
import { TIER_GRANTS } from '../../src/modules/authorization/domain/tier-grants';
import { AUDIT_CATALOG as AUDIT_ACTIONS } from '../../src/modules/audit/domain/audit.catalog';
import { subjectClassOf } from '../../src/modules/audit/domain/audit-subject';
import { EarningsAllocationReadModel } from '../../src/modules/money/repositories/earnings.read.repository';

const t = suite('bookings');

const SRC = resolve(__dirname, '../../src');
const JOVI = resolve(__dirname, '../../../jovi-mall/src');
const read = (root: string, rel: string): string => readFileSync(join(root, rel), 'utf-8').replace(/\r\n/g, '\n');
const code = (root: string, rel: string): string =>
    read(root, rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const NOW = new Date('2026-10-27T12:00:00Z');
const json = (v: unknown) => JSON.stringify(v);

// ─── §1 ──────────────────────────────────────────────────────────────────────
t.section('§1 the read');

t.assert('the filter pins deletedAt: null with nothing else asked', () =>
    json(buildBookingFilter({}, undefined, NOW)) === json({ $and: [{ deletedAt: null }] }));
t.assert('…and still pins it first alongside every other filter', () => {
    const f = buildBookingFilter({
        status: 'confirmed', paymentStatus: 'paid', queue: 'unfinished', search: 'BKG',
        vendorId: '507f1f77bcf86cd799439011', userId: '507f1f77bcf86cd799439012', productId: '507f1f77bcf86cd799439013',
    }, undefined, NOW) as { $and: unknown[] };
    return json(f.$and[0]) === json({ deletedAt: null }) && f.$and.length === 8;
});
t.assert('the date range is on the APPOINTMENT (startAt), half-open', () => {
    const from = new Date('2026-10-01T00:00:00Z');
    const to = new Date('2026-11-01T00:00:00Z');
    const f = buildBookingFilter({ from, to }, undefined, NOW) as { $and: Array<Record<string, { $gte?: Date; $lt?: Date }>> };
    return f.$and[1].startAt.$gte === from && f.$and[1].startAt.$lt === to;
});
t.assert('a booking number is an anchored, UPPERCASED prefix (the unique index serves it)', () => {
    const f = buildBookingFilter({ search: 'bkg-2026' }, undefined, NOW) as { $and: Array<{ $or?: Array<{ bookingNumber?: RegExp }> }> };
    const re = f.$and[1].$or![0].bookingNumber!;
    return re.source === '^BKG-2026' && re.flags === '' && re.test('BKG-2026-000123') && !re.test('X-BKG-2026');
});
t.assert('a 24-hex term matches the booking, the customer, the shop or the service by id', () => {
    const f = buildBookingFilter({ search: '507f1f77bcf86cd799439011' }, undefined, NOW) as { $and: Array<{ $or?: unknown[] }> };
    return f.$and[1].$or!.length === 4;
});
t.assert('a term that resolved to nobody returns NOTHING, never everything', () => {
    const f = buildBookingFilter({ search: '42' }, undefined, NOW) as { $and: unknown[] };
    return json(f.$and[1]) === json({ _id: { $in: [] } });
});
t.assert('a resolved customer matches on userId (bookings store the USER id, not the customer id)', () => {
    const id = new ObjectId();
    const f = buildBookingFilter({ search: 'Amina' }, { userIds: [id], vendorIds: [], truncated: false }, NOW) as { $and: Array<{ $or?: Array<{ userId?: { $in: ObjectId[] } }> }> };
    return f.$and[1].$or!.some((b) => b.userId?.$in[0] === id);
});
t.assert('every queue has a clause, and the list of queues is the seven in the plan', () =>
    BOOKING_QUEUES.length === 7 && BOOKING_QUEUES.every((q) => Object.keys(bookingQueueClause(q, NOW)).length > 0));
t.assert('payment_stuck = pending for more than 30 minutes', () => {
    const c = bookingQueueClause('payment_stuck', NOW) as { paymentStatus: string; updatedAt: { $lt: Date } };
    return c.paymentStatus === 'pending' && c.updatedAt.$lt.getTime() === NOW.getTime() - PAYMENT_STUCK_AFTER_MS
        && PAYMENT_STUCK_AFTER_MS === 30 * 60_000;
});
t.assert('⛔ paid_no_show = no-show AND paid — the money an administrator must decide (owner, 2026-10-27)', () =>
    json(bookingQueueClause('paid_no_show', NOW)) === json({ status: 'no-show', paymentStatus: 'paid' }));
t.assert('unfinished = still confirmed after its end', () =>
    json(bookingQueueClause('unfinished', NOW)) === json({ status: 'confirmed', endAt: { $lt: NOW } }));
t.assert('open_proposal = a live proposal on a live booking (a lapsed one holds nothing)', () => {
    const c = bookingQueueClause('open_proposal', NOW) as Record<string, unknown>;
    return c['rescheduleProposal.status'] === 'open' && json(c['rescheduleProposal.expiresAt']) === json({ $gt: NOW });
});
t.assert('the list query defaults to newest appointment first and refuses an unknown sort / queue', () =>
    SearchBookingsQuerySchema.safeParse({}).success
    && !SearchBookingsQuerySchema.safeParse({ sort: 'priceSnapshot' }).success
    && !SearchBookingsQuerySchema.safeParse({ queue: 'everything' }).success);
t.assert('the status filter accepts the hyphenated `no-show`', () =>
    SearchBookingsQuerySchema.safeParse({ status: 'no-show' }).success);
t.assert('the write bodies are strict, and cancel requires a fault of vendor | customer', () =>
    !CancelBookingSchema.safeParse({ reason: 'Vendor closed', fault: 'platform' }).success
    && !CancelBookingSchema.safeParse({ reason: 'Vendor closed' }).success
    && CancelBookingSchema.safeParse({ reason: 'Vendor closed', fault: 'vendor' }).success
    && !CompleteBookingSchema.safeParse({ reason: 'Customer attended', amount: 1 }).success
    && !MarkCashPaidSchema.safeParse({}).success
    && OptionalNoteSchema.safeParse({}).success);
t.assert('wi-admin never writes bookings itself (no insert/update on the raw driver)', () =>
    !/insertOne|updateOne|updateMany|deleteOne|findOneAndUpdate/.test(code(SRC, 'modules/bookings/repositories/booking.read.repository.ts')));
t.assert('⛔ the detail projection leaves the coordinates out (a customer_address service is their home)', () => {
    const repo = code(SRC, 'modules/bookings/repositories/booking.read.repository.ts');
    return !repo.includes("'location.coordinates'") && !/\blocation: 1\b/.test(repo) && repo.includes("'location.addressLine1': 1");
});

// ─── §2 ──────────────────────────────────────────────────────────────────────
t.section('§2 permissions');

type Spec = { family: string; action: string; financial?: boolean; destructive?: boolean };
const spec = (name: string) => PERMISSIONS[name as keyof typeof PERMISSIONS] as Spec;
const BOOKING_PERMISSIONS = ['bookings.read', 'bookings.access.read', 'bookings.remind', 'bookings.intervene', 'bookings.settle'];

t.assert('five booking permissions, all in the bookings family', () =>
    BOOKING_PERMISSIONS.every((p) => spec(p)?.family === 'bookings'));
t.assert('⛔ bookings.settle is FINANCIAL — no family sweep can hand it out', () => spec('bookings.settle').financial === true);
t.assert('Support reads bookings and resends a reminder', () =>
    TIER_GRANTS[3].includes('bookings.read') && TIER_GRANTS[3].includes('bookings.remind'));
t.assert('⛔ Support never sees the meeting link (decision 2)', () => !TIER_GRANTS[3].includes('bookings.access.read'));
t.assert('⛔ Support neither intervenes nor settles', () =>
    !TIER_GRANTS[3].includes('bookings.intervene') && !TIER_GRANTS[3].includes('bookings.settle'));
t.assert('Admin and Developer hold all five', () =>
    BOOKING_PERMISSIONS.every((p) => TIER_GRANTS[2].includes(p as never) && TIER_GRANTS[1].includes(p as never)));

// ─── §3 ──────────────────────────────────────────────────────────────────────
t.section('§3 audit');

const ACTIONS: Array<[string, string]> = [
    ['bookings.cancel', 'bookings.settle'],
    ['bookings.cancel_session', 'bookings.settle'],
    ['bookings.complete', 'bookings.settle'],
    ['bookings.payment.mark_cash', 'bookings.settle'],
    ['bookings.payment.recheck', 'bookings.intervene'],
    ['bookings.proposal.withdraw', 'bookings.intervene'],
    ['bookings.reminder.resend', 'bookings.remind'],
];
for (const [action, permission] of ACTIONS) {
    t.assert(`${action}: delegated, target booking, under ${permission}`, () => {
        const a = AUDIT_ACTIONS[action as keyof typeof AUDIT_ACTIONS] as { permission: string; target: string; transport: string } | undefined;
        return !!a && a.permission === permission && a.target === 'booking' && a.transport === 'delegated';
    });
}
t.assert('a booking audit row is a platform_record (Support reads what was done to it)', () =>
    subjectClassOf('booking') === 'platform_record');
const ROUTES = code(SRC, 'modules/bookings/routes/booking.routes.ts');
t.assert('every write route records its audit action', () =>
    ACTIONS.every(([action]) => ROUTES.includes(`records('${action}')`)));
t.assert('every write route requires the permission its audit action is filed under', () =>
    ACTIONS.every(([action, permission]) =>
        new RegExp(`access: permission\\('${permission.replace('.', '\\.')}'\\),[\\s\\S]{0,160}records\\('${action.replace(/\./g, '\\.')}'\\)`).test(ROUTES)));
t.assert('the literal /queues and /services/… routes are declared above /:bookingId', () =>
    ROUTES.indexOf("path: '/queues'") < ROUTES.indexOf("path: '/:bookingId'")
    && ROUTES.indexOf("path: '/services/") < ROUTES.indexOf("path: '/:bookingId'"));
t.assert('the activity feed needs audit.read as well (it IS audit rows)', () =>
    /permission\('bookings\.read', 'audit\.read'\)/.test(ROUTES));

// ─── §4 ──────────────────────────────────────────────────────────────────────
t.section('§4 the detail');

const BOOKING_ID = new ObjectId();
const booking = (over: Partial<BookingReadModel> = {}): BookingReadModel => ({
    _id: BOOKING_ID,
    bookingNumber: 'BKG-2026-000123',
    productId: new ObjectId(),
    userId: new ObjectId(),
    vendorId: new ObjectId(),
    startAt: new Date('2026-10-28T09:00:00Z'),
    endAt: new Date('2026-10-28T10:00:00Z'),
    status: 'confirmed',
    paymentStatus: 'paid',
    priceSnapshot: 10_000,
    currency: 'XAF',
    requiresPayment: true,
    access: { meetingUrl: 'https://meet.example.com/x', instructions: 'Use the side door', revealMinutesBefore: 30 },
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
});
const NAMES: BookingNames = { customer: new Map(), vendor: new Map(), service: new Map() };
const detail = (seesAccess: boolean, b = booking()) => toBookingDetailDto(b, {
    names: NAMES, actorNames: new Map(), allocations: [], payments: [], refunds: [], seats: [], seesAccess,
}, NOW);

t.assert('⛔ without bookings.access.read the link and instructions are ABSENT — not null', () => {
    const access = detail(false).access!;
    return access.visible === false && access.hasMeetingUrl && access.hasInstructions
        && !('meetingUrl' in access) && !('instructions' in access);
});
t.assert('with it, both are present', () => {
    const access = detail(true).access!;
    return access.visible === true && access.meetingUrl === 'https://meet.example.com/x' && access.instructions === 'Use the side door';
});
t.assert('a booking with no link and no instructions has no access block at all', () =>
    detail(true, booking({ access: null })).access === null);
t.assert('the controller decides `seesAccess` from bookings.access.read', () =>
    /ACCESS_TEXT_PERMISSION = 'bookings\.access\.read'/.test(code(SRC, 'modules/bookings/controllers/booking.controller.ts'))
    && code(SRC, 'modules/bookings/controllers/booking.controller.ts').includes('hasPermission(requireAdminIdentity(req).tier, ACCESS_TEXT_PERMISSION)'));
t.assert('an absent status history reads as an empty list ("not recorded")', () =>
    Array.isArray(detail(false).statusHistory) && detail(false).statusHistory.length === 0);

const alloc = (over: Partial<EarningsAllocationReadModel>): EarningsAllocationReadModel => ({
    _id: new ObjectId(), source_type: 'booking', source_id: BOOKING_ID, beneficiary_type: 'vendor',
    gross_snapshot: 10_000, commission_percent_snapshot: 10, amount: 9_000, currency: 'XAF', status: 'held',
    created_at: NOW, updated_at: NOW, ...over,
} as EarningsAllocationReadModel);
const HOLD = new Date('2026-10-31T00:00:00Z');
t.assert('earnings: nothing split → none', () => deriveEarnings(booking(), []).state === 'none');
t.assert('earnings: held with no release date → waiting (a paid no-show sits here)', () =>
    deriveEarnings(booking({ status: 'no-show' }), [alloc({})]).state === 'waiting');
t.assert('earnings: held with a release date → holding, and the date is reported', () => {
    const e = deriveEarnings(booking({ status: 'completed' }), [alloc({ hold_release_at: HOLD })]);
    return e.state === 'holding' && e.holdReleaseAt === HOLD;
});
t.assert('earnings: an active pause wins over the hold', () =>
    deriveEarnings(booking({ earningsPause: { active: true, reason: 'refund_in_progress' } }), [alloc({ hold_release_at: HOLD })]).state === 'paused');
t.assert('earnings: released, and every row reversed → reversed', () =>
    deriveEarnings(booking(), [alloc({ status: 'released' })]).state === 'released'
    && deriveEarnings(booking(), [alloc({ status: 'reversed' })]).state === 'reversed');
t.assert('⛔ earnings carry no amounts (money.earnings.read is not Support\'s)', () =>
    !Object.keys(deriveEarnings(booking(), [alloc({ hold_release_at: HOLD })])).some((k) => /amount/i.test(k)));

// ─── §5 ──────────────────────────────────────────────────────────────────────
t.section('§5 the cross-repo path contract');

const GW = code(SRC, 'modules/bookings/gateways/booking.gateway.ts');
const JOVI_ROUTES = code(JOVI, 'modules/booking/routes/admin-booking.routes.ts');
const JOVI_MOUNT = code(JOVI, 'api/routes/internal-admin.routes.ts');

t.assert('jovi-mall mounts the booking admin router at /bookings, internal only', () =>
    /router\.use\('\/bookings',\s*buildAdminBookingRouter\(\[requireAdminCaller\]\)\)/.test(JOVI_MOUNT));
const PAIRS: Array<[RegExp, string]> = [
    [/post<PlatformBookingAck>\(`\/bookings\/\$\{bookingId\}\/cancel`/, "router.post('/:bookingId/cancel'"],
    [/post<PlatformSessionCancel>\(`\/bookings\/services\/\$\{input\.productId\}\/sessions\/cancel`/, "router.post('/services/:productId/sessions/cancel'"],
    [/post<PlatformBookingAck>\(`\/bookings\/\$\{bookingId\}\/complete`/, "router.post('/:bookingId/complete'"],
    [/post<PlatformBookingAck>\(`\/bookings\/\$\{bookingId\}\/payment\/cash`/, "router.post('/:bookingId/payment/cash'"],
    [/post<PlatformPaymentRecheck>\(`\/bookings\/\$\{bookingId\}\/payment\/recheck`/, "router.post('/:bookingId/payment/recheck'"],
    [/post<PlatformBookingAck>\(`\/bookings\/\$\{bookingId\}\/proposal\/withdraw`/, "router.post('/:bookingId/proposal/withdraw'"],
    [/`\/bookings\/\$\{bookingId\}\/reminder`/, "router.post('/:bookingId/reminder'"],
    [/path: `\/bookings\/\$\{bookingId\}\/access-state`/, "router.get('/:bookingId/access-state'"],
    [/path: `\/bookings\/services\/\$\{productId\}\/availability`/, "router.get('/services/:productId/availability'"],
];
for (const [gatewayPath, joviRoute] of PAIRS) {
    t.assert(`${joviRoute.replace("router.", '').replace("'", ' ')} — called here, served there`, () =>
        gatewayPath.test(GW) && JOVI_ROUTES.includes(joviRoute));
}
t.assert('the fault vocabulary is the same on both sides', () =>
    code(SRC, 'modules/bookings/validators/booking.validator.ts').includes("BOOKING_FAULTS = ['vendor', 'customer']")
    && code(JOVI, 'modules/booking/controllers/admin-booking.controller.ts').includes("z.enum(['vendor', 'customer'])"));
t.assert('every write answers through the projected detail, never jovi-mall\'s echo', () => {
    const controller = code(SRC, 'modules/bookings/controllers/booking.controller.ts');
    return (controller.match(/await respondAfterWrite\(/g) ?? []).length === 7;
});

// ─── §6 ──────────────────────────────────────────────────────────────────────
t.section('§6 tickets');

t.assert('a BOOKING ticket resolves its booking number', () =>
    /case 'BOOKING':\s*return \{ vendorId: null, label: await this\.bookings\.findLabel\(entityId\) \}/.test(
        code(SRC, 'modules/support/repositories/ticket-entity.read.repository.ts')));

process.exit(t.finish());
