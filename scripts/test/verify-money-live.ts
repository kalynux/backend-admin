/**
 * Verify: the money surface against REAL infrastructure.
 *
 * `test:money` proves the rules are internally consistent. This proves six things that are
 * properties of what Mongo and Express actually do, and that no DB-free assertion can reach:
 *
 *   1. **the plaintext never leaves.** The fixtures carry a real MSISDN and a real bank
 *      account number in `payout_method_snapshot`. Every payout response is searched for
 *      every substring of both, byte by byte. `test:money` asserts the mapper drops them;
 *      this asserts the PROJECTION never read them — the lock that actually holds.
 *   1b. **…except once, on the record.** The disclosure endpoint answers a tier-2
 *      administrator with the digits, refuses Support outright, and leaves a `succeeded`
 *      row that is `sensitive`, a `platform_record`, not `delegated`, names WHICH KINDS were
 *      revealed and carries not one digit itself. The two halves are the same assertion read
 *      from both ends: the queue cannot leak what it never read, and the one path that reads
 *      it cannot read it unrecorded.
 *   2. **the queries use an index.** `explain()` on the payout queue, the platform ledger
 *      and the allocation list. A `COLLSCAN` on a jovi-mall collection is a FAILURE and is
 *      reported as the index jovi-mall should add — never added from here.
 *   3. **the four-eyes threshold branches for real.** 1,999,999 goes straight to delegation;
 *      2,000,000 answers 202, writes an `admin_approval_requests` row whose payload carries
 *      the amount read off the ROW, and commits a `queued` audit row in the same transaction.
 *      Self-approval is refused. A second administrator's approval RUNS THE HANDLER and the
 *      resulting audit row carries `via_approval_id`.
 *   4. **the service boots.** `createApp()` runs all four boot assertions, including
 *      `assertDualControlHandlersRegistered()` — which `money.routes.ts` satisfies only
 *      because it imports the dual-control module for side effect.
 *   5. **route order resolves.** Express matches literals and params at execution time;
 *      `/money/earnings/allocations` must not be swallowed by anything.
 *
 * ── What it needs ─────────────────────────────────────────────────────────────
 *   Mongo + Redis. **jovi-mall does NOT have to be running.** Every read here is direct,
 *   and the delegated writes are asserted up to and including the delegation ATTEMPT — the
 *   audit row, the approval record and `via_approval_id` are all committed on this side
 *   before jovi-mall is called, and are committed whether or not it answers.
 *
 * ── What it deliberately leaves to the manual checklist ───────────────────────
 *   That jovi-mall's row ends up `paid` with `resolved_by_source: 'admin'`. That is step 5
 *   of the phase plan's manual end-to-end, it needs both services up and a real payout, and
 *   reproducing it here would mean seeding jovi-mall's earnings accounts well enough for its
 *   own transaction to balance — a fixture set that would test the fixture more than the code.
 *
 *   And the FAIL-CLOSED half of the disclosure: with the audit store unreachable, the
 *   endpoint must error and disclose nothing. `auditedAttempt` awaits the intent insert and
 *   does not catch, so the property follows from the writer rather than from this endpoint —
 *   but it is the one property whose failure is silent and total, so the plan's manual step
 *   10 exercises it by hand at least once. Simulating it here would mean breaking the admin
 *   connection mid-suite and leaving every later assertion untrustworthy.
 *
 * It creates its own fixtures in `jovi_mall` and deletes everything it made at the end,
 * pass or fail.
 *
 * Run: npm run verify:money
 */
import 'dotenv/config';

process.env.ADMIN_AUTH_RATE_LIMIT_MAX = '500';

import type { Server } from 'http';
import { ObjectId } from 'mongodb';
import { suite } from './_assert';
import { env } from '../../src/config/env';
import { createApp } from '../../src/app';
import { connectAll, closeAll, platformConnection, adminConnection } from '../../src/infra/mongo/connections';
import { closeRedisClients, getRedisClient, ADMIN_SESSION_DB } from '../../src/infra/redis/redis.factory';
import { AdminAccountModel } from '../../src/modules/admin-identity/models/admin-account.model';
import { AdminSessionModel } from '../../src/modules/admin-identity/models/admin-session.model';
import { AdminAccountRepository } from '../../src/modules/admin-identity/repositories/admin-account.repository';
import { AuditLogModel } from '../../src/modules/audit/models/audit-log.model';
import { ApprovalRequestModel } from '../../src/modules/dual-control/models/approval-request.model';
import { hash } from '../../src/modules/admin-identity/domain/password.service';
import { AdminTier } from '../../src/modules/admin-identity/domain/admin-identity.types';
import { COLLECTIONS } from '../../src/infra/platform/collections';
import { routeManifest } from '../../src/api/route-manifest';

const t = suite('money — live');

const PASSWORD = 'verify-money-suite-password-7712';
const EMAIL_ADMIN = 'verify-money-admin@example.test';
const EMAIL_SECOND = 'verify-money-second@example.test';
const EMAIL_SUPPORT = 'verify-money-support@example.test';
const FIXTURE_TAG = 'verify-money-fixture';

const STORE_NAME = 'Verify Money Emporium';

/** The two values that must never appear in a response. Real shapes, not placeholders. */
const PLAINTEXT_MSISDN = '237670123456';
const PLAINTEXT_ACCOUNT = '10005000123456789';

interface Res { status: number; body: any }
let port = 0;

function parseCookies(headers: Headers): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of headers.getSetCookie?.() ?? []) {
        const [pair] = line.split(';');
        const idx = pair.indexOf('=');
        if (idx > 0) out[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
    }
    return out;
}

async function call(
    method: string,
    path: string,
    options: { body?: unknown; cookies?: Record<string, string>; csrf?: string } = {},
): Promise<Res & { cookies: Record<string, string> }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (options.cookies && Object.keys(options.cookies).length > 0) {
        headers.Cookie = Object.entries(options.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    }
    if (options.csrf) headers['X-CSRF-Token'] = options.csrf;

    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
    const text = await response.text();
    let body: any;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: response.status, body, cookies: parseCookies(response.headers) };
}

interface Session { adminId: string; cookies: Record<string, string>; csrf: string }

async function signIn(email: string): Promise<Session> {
    const res = await call('POST', '/api/v1/auth/login', { body: { email, password: PASSWORD } });
    if (res.status !== 200 || res.body?.data?.mfaEnrolmentRequired) {
        throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
    }
    const me = await call('GET', '/api/v1/auth/me', { cookies: res.cookies });
    return { adminId: me.body?.data?.admin?.id, cookies: res.cookies, csrf: res.cookies.admin_csrf_token ?? '' };
}

const get = (s: Session, path: string) => call('GET', path, { cookies: s.cookies });
const post = (s: Session, path: string, body?: unknown) =>
    call('POST', path, { cookies: s.cookies, csrf: s.csrf, body: body ?? {} });

function platformDb() {
    const db = platformConnection().db;
    if (!db) throw new Error('platform connection has no db');
    return db;
}

// Every id this suite mints, so cleanup cannot miss one.
const vendorId = new ObjectId();
const vendorUserId = new ObjectId();
const storeId = new ObjectId();
const agencyId = new ObjectId();
const smallPayoutId = new ObjectId();
const largePayoutId = new ObjectId();
const paidPayoutId = new ObjectId();
/** A payout predating `payout_method_snapshot` — the 422 the disclosure answers with. */
const legacyPayoutId = new ObjectId();
const platformAllocationId = new ObjectId();
const vendorAllocationId = new ObjectId();
const stuckAllocationId = new ObjectId();
const orderId = new ObjectId();
const paymentId = new ObjectId();

/** The destination every fixture payout carries — plaintext, on purpose. */
const LEAKY_SNAPSHOT = {
    method: 'mobile_money',
    mobile_money: {
        provider: 'MTN',
        phone_number: PLAINTEXT_MSISDN,
        account_name: 'Verify Money Beneficiary',
    },
    bank: {
        bank_name: 'Afriland First Bank',
        account_number: PLAINTEXT_ACCOUNT,
        account_name: 'Verify Money Beneficiary',
        country: 'CM',
    },
    card: null,
};

const PLATFORM_COLLECTIONS_USED = [
    COLLECTIONS.USER,
    COLLECTIONS.VENDOR,
    COLLECTIONS.STORE,
    COLLECTIONS.DELIVERY_AGENCY,
    COLLECTIONS.PAYOUT_REQUEST,
    COLLECTIONS.EARNINGS_LEDGER,
    COLLECTIONS.EARNINGS_ALLOCATION,
    COLLECTIONS.PAYMENT_TRANSACTION,
    COLLECTIONS.REFUND_TRANSACTION,
];

async function cleanupPlatform(): Promise<void> {
    const db = platformDb();
    for (const collection of PLATFORM_COLLECTIONS_USED) {
        await db.collection(collection).deleteMany({ [FIXTURE_TAG]: true } as never);
    }
}

async function cleanupAdmin(): Promise<void> {
    const emails = [EMAIL_ADMIN, EMAIL_SECOND, EMAIL_SUPPORT];
    const admins = await AdminAccountModel().find({ email: { $in: emails } }, { _id: 1 });
    const ids = admins.map((a) => a._id);
    if (ids.length > 0) {
        await AuditLogModel().deleteMany({ actor_id: { $in: ids } });
        await ApprovalRequestModel().deleteMany({ requested_by: { $in: ids } });
        await AdminSessionModel().deleteMany({ admin_id: { $in: ids } });
        await AdminAccountModel().deleteMany({ _id: { $in: ids } });
    }
    const redis = await getRedisClient(ADMIN_SESSION_DB);
    for (const id of ids) {
        const sids = await redis.sMembers(`admin-sessions:${id.toString()}`);
        for (const sid of sids) await redis.del(`session:${sid}`);
        await redis.del(`admin-sessions:${id.toString()}`);
    }
}

async function seedPlatform(): Promise<void> {
    const db = platformDb();
    const now = new Date();
    const older = new Date(now.getTime() - 3_600_000);
    const tag = { [FIXTURE_TAG]: true };

    await db.collection(COLLECTIONS.USER).insertOne({
        _id: vendorUserId, login_email: 'verify-money-user@example.test',
        login_phone: '+237600000094', password_hash: 'x', roles: ['vendor'], status: 'active',
        created_at: now, updated_at: now, ...tag,
    } as never);

    await db.collection(COLLECTIONS.VENDOR).insertOne({
        _id: vendorId, user_id: vendorUserId, display_name: 'Verify Money Contact',
        status: 'active', created_at: now, updated_at: now, ...tag,
    } as never);

    // The BUSINESS name — what the owner is called on every other screen.
    await db.collection(COLLECTIONS.STORE).insertOne({
        _id: storeId, vendor_id: vendorId, name: STORE_NAME, slug: 'verify-money-emporium',
        is_open: true, created_at: now, updated_at: now, ...tag,
    } as never);

    await db.collection(COLLECTIONS.DELIVERY_AGENCY).insertOne({
        _id: agencyId, user_id: vendorUserId, display_name: 'Verify Money Logistics',
        status: 'active', created_at: now, updated_at: now, ...tag,
    } as never);

    /**
     * Three payouts, and the amounts are the point.
     *
     * `1_999_999` and `2_000_000` sit either side of `AUTO_PAYOUT_THRESHOLD`, so the pair
     * proves the branch rather than one side of it. Both are `pending` and therefore need
     * DIFFERENT owners: `payout_requests` carries a partial unique index on
     * `(owner_type, owner_id)` where `status: 'pending'`.
     */
    await db.collection(COLLECTIONS.PAYOUT_REQUEST).insertMany([
        {
            _id: smallPayoutId, owner_type: 'vendor', owner_id: vendorId,
            amount: 1_999_999, currency: 'XAF', status: 'pending', origin: 'manual',
            payout_method_snapshot: LEAKY_SNAPSHOT, ticket_id: null,
            requested_by_user_id: vendorUserId, resolved_at: null, resolved_by: null,
            resolved_by_source: 'platform', resolved_by_name: null,
            paid_reference: null, rejection_reason: null, created_at: now, updated_at: now, ...tag,
        },
        {
            _id: largePayoutId, owner_type: 'agency', owner_id: agencyId,
            amount: 2_000_000, currency: 'XAF', status: 'pending', origin: 'auto_threshold',
            payout_method_snapshot: LEAKY_SNAPSHOT, ticket_id: null,
            requested_by_user_id: vendorUserId, resolved_at: null, resolved_by: null,
            resolved_by_source: 'platform', resolved_by_name: null,
            paid_reference: null, rejection_reason: null, created_at: now, updated_at: now, ...tag,
        },
        // Already settled, so it can share the vendor without tripping the partial index.
        {
            _id: paidPayoutId, owner_type: 'vendor', owner_id: vendorId,
            amount: 45_000, currency: 'XAF', status: 'paid', origin: 'manual',
            payout_method_snapshot: LEAKY_SNAPSHOT, ticket_id: null,
            requested_by_user_id: vendorUserId, resolved_at: older, resolved_by: new ObjectId(),
            resolved_by_source: 'admin', resolved_by_name: 'Some Administrator',
            paid_reference: 'BNK-VERIFY-1', rejection_reason: null,
            created_at: older, updated_at: older, ...tag,
        },
        /**
         * A payout with NO `payout_method_snapshot` at all — what rows predating the
         * snapshot actually look like. It is the only way to reach the disclosure's 422, and
         * the distinction it proves is real: "no such payout" and "nothing on file" are
         * different answers and a dashboard has to be able to tell them apart.
         *
         * `rejected`, so it can share the vendor with the two above without tripping the
         * partial unique index on `(owner_type, owner_id)` where `status: 'pending'`.
         */
        {
            _id: legacyPayoutId, owner_type: 'vendor', owner_id: vendorId,
            amount: 7_500, currency: 'XAF', status: 'rejected', origin: 'manual',
            ticket_id: null,
            requested_by_user_id: vendorUserId, resolved_at: older, resolved_by: null,
            resolved_by_source: 'platform', resolved_by_name: null,
            paid_reference: null, rejection_reason: 'No payout method on file',
            created_at: older, updated_at: older, ...tag,
        },
    ] as never);

    /**
     * The platform ledger. `owner_id: null` is not a missing value — it is what the
     * marketplace's own commission account looks like in this schema, and the filter passes
     * `null` explicitly rather than omitting the term.
     */
    await db.collection(COLLECTIONS.EARNINGS_LEDGER).insertMany([
        {
            _id: new ObjectId(), account_id: new ObjectId(), owner_type: 'platform', owner_id: null,
            entry_type: 'hold', amount: 12_500, pending_after: 12_500, available_after: 0,
            source_type: 'order', source_id: orderId, allocation_id: platformAllocationId,
            reason_code: 'order_split', created_at: older, ...tag,
        },
        {
            _id: new ObjectId(), account_id: new ObjectId(), owner_type: 'platform', owner_id: null,
            entry_type: 'release', amount: 12_500, pending_after: 0, available_after: 12_500,
            source_type: 'order', source_id: orderId, allocation_id: platformAllocationId,
            reason_code: 'hold_release', created_at: now, ...tag,
        },
        // A vendor row, so "the platform feed shows only the platform" is falsifiable.
        {
            _id: new ObjectId(), account_id: new ObjectId(), owner_type: 'vendor', owner_id: vendorId,
            entry_type: 'hold', amount: 87_500, pending_after: 87_500, available_after: 0,
            source_type: 'order', source_id: orderId, allocation_id: vendorAllocationId,
            reason_code: 'order_split', created_at: older, ...tag,
        },
    ] as never);

    /**
     * Three allocations off one order — the split, as a whole. The third is the one this
     * endpoint exists for: COD money the platform has allocated and has NOT physically
     * received, which is what a stuck remittance looks like from the earnings side.
     */
    await db.collection(COLLECTIONS.EARNINGS_ALLOCATION).insertMany([
        {
            _id: platformAllocationId, source_type: 'order', source_id: orderId,
            beneficiary_type: 'platform', beneficiary_id: null,
            gross_snapshot: 100_000, commission_percent_snapshot: 12.5, amount: 12_500,
            currency: 'XAF', status: 'released', completed_at: older, hold_release_at: older,
            released_at: now, reversed_at: null,
            requires_cash_settlement: false, cash_settled_at: null,
            created_at: older, updated_at: now, ...tag,
        },
        {
            _id: vendorAllocationId, source_type: 'order', source_id: orderId,
            beneficiary_type: 'vendor', beneficiary_id: vendorId,
            gross_snapshot: 100_000, commission_percent_snapshot: 12.5, amount: 87_500,
            currency: 'XAF', status: 'held', completed_at: older, hold_release_at: now,
            released_at: null, reversed_at: null,
            requires_cash_settlement: false, cash_settled_at: null,
            created_at: older, updated_at: older, ...tag,
        },
        {
            _id: stuckAllocationId, source_type: 'cod_collection', source_id: new ObjectId(),
            beneficiary_type: 'agency', beneficiary_id: agencyId,
            gross_snapshot: 40_000, commission_percent_snapshot: 0, amount: 4_000,
            currency: 'XAF', status: 'held', completed_at: older, hold_release_at: older,
            released_at: null, reversed_at: null,
            requires_cash_settlement: true, cash_settled_at: null,
            created_at: older, updated_at: older, ...tag,
        },
    ] as never);

    await db.collection(COLLECTIONS.PAYMENT_TRANSACTION).insertOne({
        _id: paymentId, cartId: new ObjectId(), orderIds: [orderId], purpose: 'primary',
        userId: vendorUserId, gateway: 'NOTCHPAY', method: 'MOBILE',
        gatewayRef: 'NP-VERIFY-0001', status: 'SUCCEEDED',
        amountSnapshot: 100_000, currencySnapshot: 'XAF',
        // The three banned fields, present in the DATA so the projection is what excludes them.
        idempotencyKey: `verify-money-${paymentId.toString()}`,
        gatewayPayloadHash: 'sha256:verify-money-hash',
        rawGatewayPayloads: [{ payer: PLAINTEXT_MSISDN, secret: 'do-not-disclose' }],
        totalRefunded: 5_000, hasPartialRefund: true,
        createdAt: older, updatedAt: now, ...tag,
    } as never);

    await db.collection(COLLECTIONS.REFUND_TRANSACTION).insertOne({
        _id: new ObjectId(), paymentTransactionId: paymentId, orderId,
        vendorId, userId: vendorUserId, refundAmount: 5_000, currency: 'XAF',
        reason: 'One item out of stock', status: 'completed', gateway: 'NOTCHPAY',
        gatewayRefundRef: 'NP-REFUND-0001', initiatedBy: new ObjectId(), initiatedByRole: 'admin',
        createdAt: now, completedAt: now, ...tag,
    } as never);
}

/**
 * The winning plan's stage name, walking past every `$cursor` / `FETCH` wrapper.
 *
 * Only the leaf matters: `IXSCAN` means an index served it, `COLLSCAN` means the whole
 * collection was read. A money list that COLLSCANs is a production incident waiting for the
 * collection to grow, and the fix belongs in jovi-mall's schema — never in an `ensureIndex`
 * from this service, which does not own these collections.
 */
function leafStage(plan: any): string {
    let node = plan;
    while (node?.inputStage) node = node.inputStage;
    return String(node?.stage ?? 'UNKNOWN');
}

async function explainStage(collection: string, filter: unknown, sort: unknown): Promise<string> {
    const explained: any = await platformDb()
        .collection(collection)
        .find(filter as never)
        .sort(sort as never)
        .explain('queryPlanner');
    return leafStage(explained?.queryPlanner?.winningPlan);
}

async function main(): Promise<number> {
    let server: Server | null = null;

    try {
        env();
        await connectAll();
        await cleanupAdmin();
        await cleanupPlatform();

        const accounts = new AdminAccountRepository();
        const passwordHash = await hash(PASSWORD);
        const make = async (email: string, displayName: string, tier: AdminTier) => {
            const session = await adminConnection().startSession();
            try {
                await session.withTransaction(async () => {
                    await accounts.create({ email, displayName, passwordHash, tier }, session);
                });
            } finally {
                await session.endSession();
            }
        };
        await make(EMAIL_ADMIN, 'Verify Money Admin', 2);
        await make(EMAIL_SECOND, 'Verify Money Second Admin', 2);
        await make(EMAIL_SUPPORT, 'Verify Money Support', 3);

        await seedPlatform();

        // ── 0. Boot ───────────────────────────────────────────────────────────
        t.section('0. The service starts at all');

        /**
         * `createApp()` runs every boot assertion, and one of them is new at this step:
         * `assertDualControlHandlersRegistered()` refuses to start when a `dualControl` spec
         * has no handler. `money.routes.ts` satisfies it only because it imports
         * `domain/payout-dual-control` for side effect — delete that import and this line
         * throws.
         */
        const app = createApp();
        t.assert('createApp() passes every boot assertion, dual control included', () => Boolean(app));

        server = await new Promise<Server>((resolve) => { const s = app.listen(0, () => resolve(s)); });
        const address = server.address();
        port = typeof address === 'object' && address ? address.port : 0;

        const money = routeManifest().filter((r) => r.fullPath.startsWith('/api/v1/money'));
        t.assert('fourteen /money routes reached Express', () => money.length === 14);

        const admin = await signIn(EMAIL_ADMIN);
        const second = await signIn(EMAIL_SECOND);
        const support = await signIn(EMAIL_SUPPORT);

        // ── 1. Earnings ───────────────────────────────────────────────────────
        t.section('1. The ledger and the allocations — direct reads that RUN');

        const ledger = await get(admin, '/api/v1/money/earnings/platform/ledger?limit=100');
        t.assert('GET /money/earnings/platform/ledger answers 200', () => ledger.status === 200);

        const ledgerRows: any[] = ledger.body?.data ?? [];
        t.assert('...and carries only the platform singleton, never another owner’s rows', () =>
            ledgerRows.length >= 2 && ledgerRows.every((r) => r.owner.type === 'platform' && r.owner.id === null));

        /**
         * `pending_after`/`available_after` are what make a ledger auditable rather than
         * merely readable — a reader can check that the movements add up to the balance the
         * delegated endpoint beside this one reports.
         */
        t.assert('...and every row states the balances it produced', () =>
            ledgerRows.every((r) => typeof r.balancesAfter?.pending === 'number'
                && typeof r.balancesAfter?.available === 'number'));

        /**
         * Narrowed by membership, not by count: this runs against a real `jovi_mall`, whose
         * `earnings_ledgers` already holds platform rows this suite did not create. A
         * `length === 1` assertion would pass on an empty database and fail on a seeded one,
         * which is the wrong way round for a live check.
         */
        const releases = await get(admin, '/api/v1/money/earnings/platform/ledger?entryType=release&limit=100');
        const releaseRows: any[] = releases.body?.data ?? [];
        t.assert('the entryType filter executes and narrows to the release entries', () =>
            releases.status === 200
            && releaseRows.length > 0
            && releaseRows.every((r) => r.entryType === 'release')
            && releaseRows.some((r) => r.allocationId === platformAllocationId.toString()));


        const allocations = await get(admin, `/api/v1/money/earnings/allocations?sourceId=${orderId.toString()}&limit=100`);
        t.assert('the allocation list runs and finds the whole split for one order', () =>
            allocations.status === 200 && (allocations.body?.data ?? []).length === 2);

        /**
         * The platform commission allocation carries `beneficiary_id: null`. That is not a
         * gap to be filled — it is what "the marketplace itself" looks like in this schema —
         * and the DTO says so with `id: null` rather than inventing a display name.
         */
        t.assert('...including the platform row, whose beneficiary id is legitimately null', () => {
            const platform = (allocations.body?.data ?? []).find((a: any) => a.beneficiary.type === 'platform');
            return platform?.beneficiary.id === null && platform?.beneficiary.name === null;
        });

        t.assert('...while a vendor row resolves to its BUSINESS name', () => {
            const vendor = (allocations.body?.data ?? []).find((a: any) => a.beneficiary.type === 'vendor');
            return vendor?.beneficiary.name === STORE_NAME;
        });

        /**
         * The filter this endpoint exists for. `requires_cash_settlement: true` alone would
         * include every COD allocation the platform has already been paid for; the second
         * term is what narrows it to the money that has not arrived.
         */
        const [stuck, notStuck] = await Promise.all([
            get(admin, `/api/v1/money/earnings/allocations?unsettledOnly=true&beneficiaryId=${agencyId.toString()}`),
            get(admin, `/api/v1/money/earnings/allocations?unsettledOnly=true&beneficiaryId=${vendorId.toString()}`),
        ]);
        t.assert('unsettledOnly finds the COD allocation whose cash has not arrived', () =>
            stuck.status === 200
            && (stuck.body?.data ?? []).map((a: any) => a.id).includes(stuckAllocationId.toString()));

        /**
         * The other half, and the one that would be missed by a one-sided check: the vendor
         * allocation is `held` too, and it is NOT stuck — it needs no cash settlement at all.
         * Scoped by beneficiary rather than paged, so the assertion does not depend on how
         * much real data the database happens to hold.
         */
        t.assert('...and excludes a held allocation that never required cash', () =>
            notStuck.status === 200 && (notStuck.body?.data ?? []).length === 0);

        const allocationDetail = await get(
            admin, `/api/v1/money/earnings/allocations/${platformAllocationId.toString()}`,
        );
        t.assert('the allocation detail carries the movements it caused', () =>
            allocationDetail.status === 200
            && (allocationDetail.body?.data?.movements ?? []).length === 2);

        t.assert('...and its siblings on the same sale, so the split can be checked', () => {
            const siblings: any[] = allocationDetail.body?.data?.siblings ?? [];
            const total = siblings.reduce((sum, s) => sum + s.amount, 0);
            return siblings.length === 2 && total === allocationDetail.body.data.snapshots.gross;
        });

        // ── 2. Payouts, and the plaintext that must not appear ────────────────
        t.section('2. The payout queue — byte-level');

        /**
         * Scoped by owner rather than paged over the whole queue: this runs against a real
         * `jovi_mall`, and an assertion that depends on a fixture landing on page one is an
         * assertion that fails as the database grows.
         */
        const payouts = await get(admin, `/api/v1/money/payouts?ownerId=${vendorId.toString()}&limit=100`);
        t.assert('GET /money/payouts answers 200 and finds all three of this vendor’s payouts', () => {
            const ids = (payouts.body?.data ?? []).map((p: any) => p.id);
            return payouts.status === 200
                && ids.length === 3
                && ids.includes(smallPayoutId.toString())
                && ids.includes(paidPayoutId.toString())
                && ids.includes(legacyPayoutId.toString());
        });

        /**
         * The legacy row carries no `payout_method_snapshot` at all, and the DTO says `null`
         * rather than an object full of nulls — "there is no destination on file" and "there
         * is a destination whose details are missing" are different facts.
         */
        t.assert('...and a payout predating the snapshot renders destination: null', () => {
            const row = (payouts.body?.data ?? []).find((p: any) => p.id === legacyPayoutId.toString());
            return row !== undefined && row.destination === null;
        });

        const agencyQueue = await get(
            admin, `/api/v1/money/payouts?ownerId=${agencyId.toString()}&status=pending`,
        );
        t.assert('...and the status filter composes with the owner one', () =>
            agencyQueue.status === 200
            && (agencyQueue.body?.data ?? []).length === 1
            && agencyQueue.body.data[0].id === largePayoutId.toString());

        const payoutDetail = await get(admin, `/api/v1/money/payouts/${paidPayoutId.toString()}`);
        t.assert('the detail reads, and names who resolved it across the database boundary', () =>
            payoutDetail.status === 200
            && payoutDetail.body?.data?.resolvedBy?.source === 'admin'
            && payoutDetail.body?.data?.resolvedBy?.name === 'Some Administrator');

        /**
         * THE assertion this suite exists for.
         *
         * The fixtures carry a real MSISDN and a real bank account number. Every substring
         * long enough to be useful is searched for in the raw JSON of both responses. This
         * is not the mapper being tested — `test:money` does that — it is the PROJECTION:
         * the values were never read out of Mongo at all.
         */
        const rawPayoutJson = JSON.stringify([payouts.body, payoutDetail.body]);
        const leaks = [
            PLAINTEXT_MSISDN,
            PLAINTEXT_MSISDN.slice(-6),
            PLAINTEXT_ACCOUNT,
            PLAINTEXT_ACCOUNT.slice(-6),
            'phone_number',
            'account_number',
        ];
        t.assert('NO payout response contains any part of the destination', () =>
            leaks.every((needle) => !rawPayoutJson.includes(needle)));

        t.assert('...while the labels an operator recognises it by DO come through', () => {
            const row = (payouts.body?.data ?? []).find((p: any) => p.id === paidPayoutId.toString());
            return row?.destination?.method === 'mobile_money'
                && row?.destination?.masked?.mobileMoney?.provider === 'MTN'
                && row?.destination?.masked?.mobileMoney?.phoneNumberMasked === null
                && row?.destination?.full === null
                && row?.destination?.revealed === false;
        });

        // ── 3. The disclosure ─────────────────────────────────────────────────
        t.section('3. The one read that writes a row — and the only one that discloses');

        /**
         * The other half of §2, and the reason §2's tightening is affordable at all.
         *
         * Everything above proves the digits are never read. This proves they CAN be, once,
         * by a tier-2 administrator holding `money.payouts.destination.read` — and that the
         * act of reading them is on the record before the value is fetched.
         */
        const revealed = await get(admin, `/api/v1/money/payouts/${paidPayoutId.toString()}/destination`);

        t.assert('a tier-2 administrator gets the plaintext MSISDN and account number', () =>
            revealed.status === 200
            && revealed.body?.data?.revealed === true
            && revealed.body?.data?.full?.mobileMoney?.phoneNumber === PLAINTEXT_MSISDN
            && revealed.body?.data?.full?.bank?.accountNumber === PLAINTEXT_ACCOUNT);

        /**
         * The masked half renders the tails HERE and only here — this is the one path that
         * read the digits a mask is computed from. On `/money/payouts` the same fields are
         * `null`, which §2 asserts.
         */
        t.assert('...and the masked half renders the tails, which no other endpoint can', () =>
            revealed.body?.data?.masked?.mobileMoney?.phoneNumberMasked
                === '•'.repeat(PLAINTEXT_MSISDN.length - 4) + PLAINTEXT_MSISDN.slice(-4)
            && revealed.body?.data?.masked?.bank?.accountNumberMasked
                === '•'.repeat(PLAINTEXT_ACCOUNT.length - 4) + PLAINTEXT_ACCOUNT.slice(-4));

        /** Never revealed, not even here. A gateway token is a PULL credential. */
        t.assert('...while the card side of `full` stays null, and no token appears', () =>
            revealed.body?.data?.full?.card === null
            && !JSON.stringify(revealed.body).includes('gateway_token'));

        const disclosureRow: any = await AuditLogModel()
            .findOne({ action: 'money.payouts.destination.read', target_id: paidPayoutId.toString() })
            .sort({ occurred_at: -1 })
            .lean();

        /**
         * The step-6 exit gate, stated as one assertion. `sensitive` is DERIVED from the
         * permission's `financial` flag at write time — nothing here set it — which is what
         * puts a disclosure on the alerting axis for free.
         */
        t.assert('the read left a succeeded row: sensitive, platform_record, not delegated', () =>
            Boolean(disclosureRow)
            && disclosureRow.status === 'succeeded'
            && disclosureRow.sensitive === true
            && disclosureRow.subject_class === 'platform_record'
            && disclosureRow.delegated === false);

        t.assert('...whose `after` names WHICH KINDS were revealed', () =>
            JSON.stringify(disclosureRow?.after?.revealedMethods ?? []) === '["mobile_money","bank"]');

        /**
         * THE assertion that makes the audit trail safe to keep. A beneficiary's destination
         * in the audit store would be readable by anyone holding `audit.read` — which is a
         * strictly wider set than the people who may read the destination — so the row that
         * records a disclosure must not itself be one.
         */
        t.assert('...and not one digit of the destination is anywhere on the row', () => {
            const rendered = JSON.stringify(disclosureRow);
            return leaks.every((needle) => !rendered.includes(needle))
                && !rendered.includes(PLAINTEXT_MSISDN.slice(-4));
        });

        /**
         * The payout's own feed is where an auditor goes to ask "who has seen this
         * beneficiary's account number". If the row did not surface here, the endpoint would
         * be recording into a place nobody looks.
         */
        const feed = await get(admin, `/api/v1/money/payouts/${paidPayoutId.toString()}/activity`);
        t.assert('the disclosure appears on the payout’s own activity feed', () =>
            feed.status === 200
            && (feed.body?.data ?? []).some((row: any) =>
                row.action === 'money.payouts.destination.read' && row.sensitive === true));

        /**
         * 422, not 404 — the payout exists and has nothing on file. The attempt is still
         * recorded, at `failed`: somebody asked, and that is the fact worth keeping.
         */
        const absent = await get(admin, `/api/v1/money/payouts/${legacyPayoutId.toString()}/destination`);
        t.assert('a payout with no destination on file answers 422, distinctly from a 404', () =>
            absent.status === 422 && absent.body?.error?.code === 'PAYOUT_DESTINATION_ABSENT');

        const absentRow: any = await AuditLogModel()
            .findOne({ action: 'money.payouts.destination.read', target_id: legacyPayoutId.toString() })
            .lean();
        t.assert('...and the attempt is still on the record, stamped failed', () =>
            Boolean(absentRow)
            && absentRow.status === 'failed'
            && absentRow.outcome_code === 'PAYOUT_DESTINATION_ABSENT');

        /**
         * The 404 comes from the MASKED read, which happens first — so a mistyped id never
         * reaches the trail as an attempted disclosure, because it is not one. This is the
         * ordering in `payout-disclosure.ts`, observed from outside.
         */
        const unknownId = new ObjectId().toString();
        const unknown = await get(admin, `/api/v1/money/payouts/${unknownId}/destination`);
        const unknownRow = await AuditLogModel()
            .findOne({ action: 'money.payouts.destination.read', target_id: unknownId })
            .lean();
        t.assert('an unknown payout is a 404 that writes NO disclosure row at all', () =>
            unknown.status === 404 && unknownRow === null);

        // ── 4. Gateway settlements ────────────────────────────────────────────
        t.section('4. Payments and refunds — and the three fields that stay in Mongo');

        const payment = await get(admin, `/api/v1/money/payments/${paymentId.toString()}`);
        t.assert('the payment detail reads and computes its net amount', () =>
            payment.status === 200
            && payment.body?.data?.amount === 100_000
            && payment.body?.data?.refunds?.netAmount === 95_000);

        t.assert('...and carries the refund that produced it', () =>
            (payment.body?.data?.refundTransactions ?? []).length === 1);

        /**
         * The three are IN the fixture document, so this proves the projection excludes them
         * rather than that the data happened not to have them.
         */
        const rawPaymentJson = JSON.stringify(payment.body);
        t.assert('the raw gateway payload, the payload hash and the idempotency key never leave', () =>
            !rawPaymentJson.includes('rawGatewayPayloads')
            && !rawPaymentJson.includes('gatewayPayloadHash')
            && !rawPaymentJson.includes('idempotencyKey')
            && !rawPaymentJson.includes('do-not-disclose')
            && !rawPaymentJson.includes(PLAINTEXT_MSISDN));

        /**
         * A cart checkout writes ONE payment for N orders and sets `orderIds`, never
         * `orderId` — the majority of orders on the platform. A filter on `orderId` alone
         * would answer "no payment" for them.
         */
        const byOrder = await get(admin, `/api/v1/money/payments?orderId=${orderId.toString()}`);
        t.assert('an order filter finds a CART payment, which sets orderIds and not orderId', () =>
            byOrder.status === 200
            && (byOrder.body?.data ?? []).some((p: any) => p.id === paymentId.toString()));

        const refunds = await get(admin, `/api/v1/money/refunds?orderId=${orderId.toString()}`);
        t.assert('the refund list runs and is scoped by order', () =>
            refunds.status === 200 && (refunds.body?.data ?? []).length === 1);

        // ── 5. Index plans ────────────────────────────────────────────────────
        t.section('5. Every money query uses an index');

        const stages = {
            payouts: await explainStage(
                COLLECTIONS.PAYOUT_REQUEST,
                { $and: [{ status: 'pending' }, { owner_type: 'vendor' }] },
                { created_at: -1, _id: -1 },
            ),
            ledger: await explainStage(
                COLLECTIONS.EARNINGS_LEDGER,
                { $and: [{ owner_type: 'platform' }, { owner_id: null }] },
                { created_at: -1, _id: -1 },
            ),
            allocations: await explainStage(
                COLLECTIONS.EARNINGS_ALLOCATION,
                { $and: [{ beneficiary_type: 'vendor' }, { beneficiary_id: vendorId }] },
                { created_at: -1, _id: -1 },
            ),
            payments: await explainStage(
                COLLECTIONS.PAYMENT_TRANSACTION,
                { $and: [{ gateway: 'NOTCHPAY' }, { status: 'SUCCEEDED' }] },
                { createdAt: -1, _id: -1 },
            ),
        };

        for (const [name, stage] of Object.entries(stages)) {
            t.assert(`the ${name} query is served by an index (${stage})`, () => stage !== 'COLLSCAN');
        }

        // ── 6. Dual control, for real ─────────────────────────────────────────
        t.section('6. The four-eyes threshold branches');

        /**
         * Below the threshold: no approval, straight to delegation. Whether jovi-mall
         * answers is not this suite's business — what matters is that it was CALLED rather
         * than queued, and the audit row proves that with `via_approval_id: null`.
         */
        const small = await post(admin, `/api/v1/money/payouts/${smallPayoutId.toString()}/mark-paid`, {
            reference: 'BNK-SMALL-1',
        });
        t.assert('1,999,999 is NOT queued — it goes straight to delegation', () => small.status !== 202);

        const smallRow = await AuditLogModel()
            .findOne({ action: 'money.payouts.mark_paid', target_id: smallPayoutId.toString() })
            .sort({ occurred_at: -1 })
            .lean();
        t.assert('...and left an audit row carrying no approval id', () =>
            Boolean(smallRow) && (smallRow as any).via_approval_id === null);

        t.assert('...whose payload names the money read off the ROW, not off the body', () =>
            (smallRow as any)?.payload?.amount === 1_999_999
            && (smallRow as any)?.payload?.currency === 'XAF');

        // At the threshold: queued.
        const large = await post(admin, `/api/v1/money/payouts/${largePayoutId.toString()}/mark-paid`, {
            reference: 'BNK-LARGE-1',
        });
        t.assert('2,000,000 answers 202 with an approval id', () =>
            large.status === 202 && typeof large.body?.data?.id === 'string');

        const approvalId = large.body?.data?.id as string;
        const approvalRow = await ApprovalRequestModel().findById(approvalId).lean();

        t.assert('...and the approval it queued is pending against the payout', () =>
            (approvalRow as any)?.status === 'pending'
            && (approvalRow as any)?.target_type === 'payout'
            && (approvalRow as any)?.target_id === largePayoutId.toString());

        /**
         * The payload is what the approver signs for, and the amount in it came from the
         * row. A body that could carry an amount could name 1,999,999 on this payout and
         * skip the second administrator entirely.
         */
        t.assert('...carrying the amount and currency the row holds', () =>
            (approvalRow as any)?.payload?.amount === 2_000_000
            && (approvalRow as any)?.payload?.currency === 'XAF');

        /**
         * The row `recordQueued` has been able to write since Phase 3.5 and never did. It
         * commits in the SAME transaction as the approval, so there is no state in which a
         * payout is waiting for a second administrator and nothing records that anybody
         * asked.
         */
        const queuedRow = await AuditLogModel()
            .findOne({ action: 'money.payouts.mark_paid', status: 'queued' })
            .sort({ occurred_at: -1 })
            .lean();
        t.assert('...and a `queued` audit row committed with it', () =>
            Boolean(queuedRow)
            && String((queuedRow as any).via_approval_id) === approvalId
            && (queuedRow as any).target_type === 'approval_request'
            && (queuedRow as any).related_target_id === largePayoutId.toString());

        const stillPending = await get(admin, `/api/v1/money/payouts/${largePayoutId.toString()}`);
        t.assert('...and the payout is still pending — queueing performs nothing', () =>
            stillPending.body?.data?.status === 'pending');

        // The entire point.
        const selfApprove = await post(admin, `/api/v1/approvals/${approvalId}/approve`, { note: 'me again' });
        t.assert('the requester cannot approve their own request', () => selfApprove.status === 403);

        const supportApprove = await post(support, `/api/v1/approvals/${approvalId}/approve`, {});
        t.assert('...and neither can Support, who does not hold the permission', () =>
            supportApprove.status === 403);

        /**
         * A second administrator approves. The handler RUNS — it re-reads the payout,
         * re-checks the status, amount and currency, and delegates with the approver as the
         * actor.
         *
         * Whether jovi-mall answers is deliberately not asserted (see the header). What is
         * asserted is everything committed on this side: the approval leaves `pending`, and
         * the audit row for the delegation carries `via_approval_id`, which is what ties
         * "X asked" to "Y did it".
         */
        await post(second, `/api/v1/approvals/${approvalId}/approve`, { note: 'agreed' });

        const decided = await ApprovalRequestModel().findById(approvalId).lean();
        t.assert('a second administrator’s approval takes it out of pending', () =>
            (decided as any)?.status === 'approved'
            && String((decided as any)?.approver_id) === second.adminId);

        const performed = await AuditLogModel()
            .findOne({ action: 'money.payouts.mark_paid', target_id: largePayoutId.toString() })
            .sort({ occurred_at: -1 })
            .lean();
        t.assert('...and the handler’s own audit row stamps via_approval_id', () =>
            Boolean(performed) && String((performed as any).via_approval_id) === approvalId);

        t.assert('...with the APPROVER as its actor, not the requester', () =>
            String((performed as any)?.actor_id) === second.adminId);

        // ── 7. The gates ──────────────────────────────────────────────────────
        t.section('7. Who may reach it');

        const [supportPayouts, supportPayments, supportLedger, supportDestination] = await Promise.all([
            get(support, '/api/v1/money/payouts'),
            get(support, '/api/v1/money/payments'),
            get(support, '/api/v1/money/earnings/platform/ledger'),
            get(support, `/api/v1/money/payouts/${paidPayoutId.toString()}/destination`),
        ]);

        /**
         * `money.payments.read` is deliberately unflagged: "did this payment go through" is
         * exactly the question Support is asked. The payout queue and the earnings ledger
         * are not theirs.
         */
        t.assert('Support can read a payment settlement — that is what the permission is for', () =>
            supportPayments.status === 200);

        t.assert('...but not the payout queue, and not the platform ledger', () =>
            supportPayouts.status === 403 && supportLedger.status === 403);

        /**
         * The other half of the step-6 exit gate. `money.payouts.destination.read` is
         * `financial`, so `allInFamily('money')` refuses to expand it into Support's grant
         * and `assertGrantTableValid()` would fail boot if tier 2 did not name it by hand.
         * Nothing in this endpoint checks a tier — the catalog is the whole mechanism.
         */
        t.assert('...nor the destination, which no tier-3 grant can reach', () =>
            supportDestination.status === 403);

        const denials = await AuditLogModel().find({ status: 'denied' }).sort({ occurred_at: -1 }).limit(20).lean();
        t.assert('...and every refusal is on the record', () =>
            denials.some((d: any) => (d.required_permissions ?? []).some((p: string) => p.startsWith('money.'))));

        /**
         * A refused DISCLOSURE is the single most interesting row a security review reads, so
         * it must be findable as one: named permission, and `sensitive` derived from the
         * refused permission's own flag rather than hardcoded false.
         */
        t.assert('...and the refused disclosure is denied, named and marked sensitive', () =>
            denials.some((d: any) =>
                (d.required_permissions ?? []).includes('money.payouts.destination.read')
                && d.status === 'denied'
                && d.sensitive === true));

        // ── 8. Route order ────────────────────────────────────────────────────
        t.section('8. Express resolves the paths as declared');

        const literalUnderEarnings = await get(admin, '/api/v1/money/earnings/allocations?limit=1');
        t.assert('/earnings/allocations resolves to the list, not to a param route', () =>
            literalUnderEarnings.status === 200 && Array.isArray(literalUnderEarnings.body?.data));

        const notAnId = await get(admin, '/api/v1/money/earnings/allocations/not-an-id');
        t.assert('...and its param route validates the id rather than 404ing on shape', () =>
            notAnId.status === 400);

        const activity = await get(admin, `/api/v1/money/payouts/${largePayoutId.toString()}/activity`);
        t.assert('/payouts/:id/activity is not swallowed by /payouts/:id', () =>
            activity.status === 200 && Array.isArray(activity.body?.data));

        t.assert('...and the payout’s own feed shows the attempt that was performed', () =>
            (activity.body?.data ?? []).some((row: any) => row.action === 'money.payouts.mark_paid'));

        const unknownPayout = await get(admin, `/api/v1/money/payouts/${new ObjectId().toString()}/activity`);
        t.assert('an activity feed for an unknown payout is a 404, not an empty page', () =>
            unknownPayout.status === 404);

        /**
         * `/destination` sits beside `/activity` at the same depth, so neither can be
         * swallowed by `/payouts/:payoutId` — but "cannot" is a claim about Express's
         * matching order, and this is the one place it is observed rather than reasoned
         * about. A 200 carrying a `revealed` flag could only have come from the disclosure
         * handler; the detail handler emits `revealed: false` and no `full`.
         */
        const destinationOrder = await get(
            admin, `/api/v1/money/payouts/${paidPayoutId.toString()}/destination`,
        );
        t.assert('/payouts/:id/destination is not swallowed by /payouts/:id either', () =>
            destinationOrder.status === 200
            && destinationOrder.body?.data?.revealed === true
            && destinationOrder.body?.data?.amount === undefined);

        return t.finish();
    } finally {
        try { await cleanupPlatform(); } catch { /* best effort */ }
        try { await cleanupAdmin(); } catch { /* best effort */ }
        if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
        await closeAll();
        await closeRedisClients();
    }
}

void main().then((code) => process.exit(code));
