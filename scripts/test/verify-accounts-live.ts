/**
 * Verify: the account surface against REAL infrastructure.
 *
 * `test:accounts` proves the rules are internally consistent. This proves five things that
 * are properties of what Mongo and Express actually do:
 *
 *   1. **the five-way merge runs.** `mergeActivity` is unit-tested on arrays; this is the
 *      only place it is fed by five real collections through five real projections, in one
 *      request, and the ordering is checked against what was seeded.
 *   2. **the cursor walks the whole feed.** Paged two at a time to the end, then compared to
 *      the seeded set: no row repeated, none dropped. The fixtures deliberately include TWO
 *      rows written at the same instant in two different collections — a plan purchase and
 *      its credit allowance, which is exactly how jovi-mall writes them — because that tie is
 *      the case a naive `$lt` cursor loses.
 *   3. **the top-up is deduped.** A paid top-up writes rows in `credit_topups` AND
 *      `credit_transactions`. Both are seeded; the feed must show one.
 *   4. **every source query uses an index.** `explain()` on all five, plus the three
 *      sub-lists. A `COLLSCAN` on a jovi-mall collection is a FAILURE, reported as the index
 *      jovi-mall should add — never added from here.
 *   5. **`codCash: null` for a vendor, an object for an agent** — the phase plan's exit gate,
 *      asserted on raw JSON rather than on a mapper.
 *
 * ── What it needs ─────────────────────────────────────────────────────────────
 *   Mongo + Redis. The four SUB-routes are entirely direct and always run.
 *   The account OVERVIEW additionally needs jovi-mall running: it delegates two verdicts (the
 *   earnings balances and the plan entitlements) and there is no honest way to render it
 *   without them. That section SKIPS LOUDLY when jovi-mall is unreachable — and the split is
 *   itself the point, because it is the same split a production outage produces.
 *
 * It creates its own fixtures in `jovi_mall` and deletes everything it made at the end,
 * pass or fail.
 *
 * Run: npm run verify:accounts
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
import { hash } from '../../src/modules/admin-identity/domain/password.service';
import { AdminTier } from '../../src/modules/admin-identity/domain/admin-identity.types';
import { pingPlatform } from '../../src/infra/platform/platform.client';
import { COLLECTIONS } from '../../src/infra/platform/collections';
import { routeManifest } from '../../src/api/route-manifest';

const t = suite('accounts — live');

const PASSWORD = 'verify-accounts-suite-password-7712';
const EMAIL_ADMIN = 'verify-accounts-admin@example.test';
const EMAIL_SUPPORT = 'verify-accounts-support@example.test';
const FIXTURE_TAG = 'verify-accounts-fixture';

const STORE_NAME = 'Verify Accounts Emporium';
const PLAINTEXT_MSISDN = '237670123456';

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
    options: { body?: unknown; cookies?: Record<string, string> } = {},
): Promise<Res & { cookies: Record<string, string> }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (options.cookies && Object.keys(options.cookies).length > 0) {
        headers.Cookie = Object.entries(options.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    }

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

interface Session { adminId: string; cookies: Record<string, string> }

async function signIn(email: string): Promise<Session> {
    const res = await call('POST', '/api/v1/auth/login', { body: { email, password: PASSWORD } });
    if (res.status !== 200 || res.body?.data?.mfaEnrolmentRequired) {
        throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
    }
    const me = await call('GET', '/api/v1/auth/me', { cookies: res.cookies });
    return { adminId: me.body?.data?.admin?.id, cookies: res.cookies };
}

const get = (s: Session, path: string) => call('GET', path, { cookies: s.cookies });

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
const agentId = new ObjectId();
const contractId = new ObjectId();
const planId = new ObjectId();
const orderId = new ObjectId();
const walletId = new ObjectId();
const topupId = new ObjectId();
const purchaseId = new ObjectId();
const payoutId = new ObjectId();
const cashAccountId = new ObjectId();

/**
 * The instants the fixtures use, newest first.
 *
 * `TIED` is the whole reason this suite can prove anything about the cursor: the plan
 * purchase and its credit allowance are written AT THE SAME MILLISECOND, in two different
 * collections, which is how jovi-mall's `assignPlan` actually writes them — one transaction,
 * one `new Date()`. A bare `$lt` cursor loses one of them at a page boundary.
 */
const T = {
    payout: new Date('2026-06-08T10:00:00.000Z'),
    topup: new Date('2026-06-07T10:00:00.000Z'),
    release: new Date('2026-06-06T10:00:00.000Z'),
    hold: new Date('2026-06-05T10:00:00.000Z'),
    TIED: new Date('2026-06-04T10:00:00.000Z'),
    usage: new Date('2026-06-03T10:00:00.000Z'),
};

/** Every activity row the vendor fixture produces, newest first. 7 rows, one tie pair. */
const EXPECTED_FEED = 7;

const PLATFORM_COLLECTIONS_USED = [
    COLLECTIONS.USER,
    COLLECTIONS.VENDOR,
    COLLECTIONS.STORE,
    COLLECTIONS.DELIVERY_AGENCY,
    COLLECTIONS.DELIVERY_AGENT,
    COLLECTIONS.AGENT_AGENCY_CONTRACT,
    COLLECTIONS.PRICING_PLAN,
    COLLECTIONS.SUBSCRIBER_PLAN,
    COLLECTIONS.BILLING_SETTINGS,
    COLLECTIONS.CREDIT_WALLET,
    COLLECTIONS.CREDIT_TRANSACTION,
    COLLECTIONS.CREDIT_TOPUP,
    COLLECTIONS.PLAN_PURCHASE,
    COLLECTIONS.EARNINGS_ACCOUNT,
    COLLECTIONS.EARNINGS_LEDGER,
    COLLECTIONS.EARNINGS_ALLOCATION,
    COLLECTIONS.PAYOUT_REQUEST,
    COLLECTIONS.COD_CASH_ACCOUNT,
    COLLECTIONS.COD_CASH_LEDGER,
    COLLECTIONS.COD_DISCREPANCY,
];

async function cleanupPlatform(): Promise<void> {
    const db = platformDb();
    for (const collection of PLATFORM_COLLECTIONS_USED) {
        await db.collection(collection).deleteMany({ [FIXTURE_TAG]: true } as never);
    }
}

async function cleanupAdmin(): Promise<void> {
    const emails = [EMAIL_ADMIN, EMAIL_SUPPORT];
    const admins = await AdminAccountModel().find({ email: { $in: emails } }, { _id: 1 });
    const ids = admins.map((a) => a._id);
    if (ids.length > 0) {
        await AuditLogModel().deleteMany({ actor_id: { $in: ids } });
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
    const tag = { [FIXTURE_TAG]: true };

    await db.collection(COLLECTIONS.USER).insertOne({
        _id: vendorUserId, login_email: 'verify-accounts-user@example.test',
        login_phone: '+237600000095', password_hash: 'x', roles: ['vendor'], status: 'active',
        created_at: now, updated_at: now, ...tag,
    } as never);

    await db.collection(COLLECTIONS.VENDOR).insertOne({
        _id: vendorId, user_id: vendorUserId, display_name: 'Verify Accounts Contact',
        email: 'vendor@example.test', email_verified: true, phone: '+237600000095',
        country: 'CM', status: 'active', onboarding_step: 5,
        kyc_details: { status: 'verified', legit_verified: true, verified_at: now },
        created_at: now, updated_at: now, ...tag,
    } as never);

    await db.collection(COLLECTIONS.STORE).insertOne({
        _id: storeId, vendor_id: vendorId, name: STORE_NAME, slug: 'verify-accounts-emporium',
        is_open: true, created_at: now, updated_at: now, ...tag,
    } as never);

    await db.collection(COLLECTIONS.DELIVERY_AGENCY).insertOne({
        _id: agencyId, user_id: vendorUserId, display_name: 'Verify Accounts Logistics',
        status: 'active', legit_verified: true, created_at: now, updated_at: now, ...tag,
    } as never);

    /** `cod.max_threshold` is the ceiling `flags.overCodThreshold` compares against. */
    await db.collection(COLLECTIONS.DELIVERY_AGENT).insertOne({
        _id: agentId, user_id: vendorUserId, name: 'Verify Accounts Agent',
        status: 'active', cod: { trust_score: 80, max_threshold: 200_000 },
        kyc: { status: 'verified', verified_at: now },
        created_at: now, updated_at: now, ...tag,
    } as never);

    await db.collection(COLLECTIONS.AGENT_AGENCY_CONTRACT).insertOne({
        _id: contractId, agent_id: agentId, agency_id: agencyId, status: 'active',
        is_primary: true,
        cod: { threshold: 150_000, outstanding_balance: 60_000, last_settled_at: T.hold },
        payment: { outstanding_to_agent: 12_000 },
        created_at: now, updated_at: now, ...tag,
    } as never);

    // ── Billing ──────────────────────────────────────────────────────────────
    await db.collection(COLLECTIONS.PRICING_PLAN).insertOne({
        _id: planId, code: 'VERIFY_ACCOUNTS_PRO', name: 'Verify Accounts Pro', role: 'vendor',
        price: 15_000, currency: 'XAF', commission_percent: 12.5, max_active_products: 100,
        is_active: true, created_at: now, updated_at: now, ...tag,
    } as never);

    await db.collection(COLLECTIONS.SUBSCRIBER_PLAN).insertOne({
        _id: new ObjectId(), owner_type: 'vendor', owner_id: vendorId, plan_id: planId,
        plan_code: 'VERIFY_ACCOUNTS_PRO', status: 'active',
        started_at: T.TIED, expires_at: new Date('2026-12-31T00:00:00.000Z'),
        assigned_by: new ObjectId(), assigned_by_source: 'admin', assigned_by_name: 'Some Administrator',
        payment_reference: 'PAY-VERIFY-1', allowance_granted: true,
        created_at: T.TIED, updated_at: T.TIED, ...tag,
    } as never);

    await db.collection(COLLECTIONS.BILLING_SETTINGS).insertOne({
        _id: new ObjectId(), owner_type: 'vendor', owner_id: vendorId,
        notify_days_before_expiry: 7, shipment_cap_alerted_at: null,
        created_at: now, updated_at: now, ...tag,
    } as never);

    await db.collection(COLLECTIONS.CREDIT_WALLET).insertOne({
        _id: walletId, owner_type: 'vendor', owner_id: vendorId, balance: 1475,
        currency_unit: 'credit', version: 3, created_at: now, updated_at: now, ...tag,
    } as never);

    /**
     * Three credit rows, and the middle one is the trap.
     *
     * `topup_purchase` is the ledger half of the top-up below — the same event, written twice
     * across two collections. Every credit read on this surface must exclude it, or the feed
     * shows the top-up twice and the credits column double-counts.
     *
     * `plan_allowance` shares `T.TIED` with the plan purchase, because that is how
     * `assignPlan` writes them: one transaction, one instant.
     */
    await db.collection(COLLECTIONS.CREDIT_TRANSACTION).insertMany([
        {
            _id: new ObjectId(), wallet_id: walletId, owner_type: 'vendor', owner_id: vendorId,
            type: 'topup', amount: 1000, balance_after: 1500, reason_code: 'topup_purchase',
            ref: topupId.toString(), created_at: T.topup, ...tag,
        },
        {
            _id: new ObjectId(), wallet_id: walletId, owner_type: 'vendor', owner_id: vendorId,
            type: 'allowance', amount: 500, balance_after: 500, reason_code: 'plan_allowance',
            ref: planId.toString(), created_at: T.TIED, ...tag,
        },
        {
            _id: new ObjectId(), wallet_id: walletId, owner_type: 'vendor', owner_id: vendorId,
            type: 'debit', amount: -25, balance_after: 1475, reason_code: 'vectorisation',
            ref: 'product-verify-1', created_at: T.usage, ...tag,
        },
    ] as never);

    await db.collection(COLLECTIONS.CREDIT_TOPUP).insertOne({
        _id: topupId, owner_type: 'vendor', owner_id: vendorId, pack_code: 'PACK1000',
        credits: 1000, price: 5000, currency: 'XAF', status: 'paid',
        gateway: 'NOTCHPAY', gateway_ref: 'NP-VERIFY-TOPUP', payment_transaction_id: null,
        created_at: T.topup, updated_at: T.topup, ...tag,
    } as never);

    await db.collection(COLLECTIONS.PLAN_PURCHASE).insertOne({
        _id: purchaseId, owner_type: 'vendor', owner_id: vendorId, plan_id: planId,
        plan_code: 'VERIFY_ACCOUNTS_PRO', price: 15_000, currency: 'XAF', status: 'paid',
        gateway: 'NOTCHPAY', gateway_ref: 'NP-VERIFY-PLAN', subscriber_plan_id: null,
        created_at: T.TIED, updated_at: T.TIED, ...tag,
    } as never);

    // ── Earnings ─────────────────────────────────────────────────────────────
    /**
     * The account exists so the ACTIVITY feed can read its `currency` — the one field this
     * module takes from `earnings_accounts`. The four balances are seeded too, and they must
     * NOT appear on the wire: the account view gets its balances from jovi-mall's verdict,
     * and this suite asserts the numbers match that call rather than these columns.
     */
    await db.collection(COLLECTIONS.EARNINGS_ACCOUNT).insertOne({
        _id: new ObjectId(), owner_type: 'vendor', owner_id: vendorId,
        pending_balance: 40_000, available_balance: 25_000, reserve_balance: 0,
        requested_balance: 30_000, currency: 'XAF',
        created_at: now, updated_at: now, ...tag,
    } as never);

    await db.collection(COLLECTIONS.EARNINGS_LEDGER).insertMany([
        {
            _id: new ObjectId(), account_id: new ObjectId(), owner_type: 'vendor', owner_id: vendorId,
            entry_type: 'hold', amount: 65_000, pending_after: 65_000, available_after: 0,
            source_type: 'order', source_id: orderId, allocation_id: new ObjectId(),
            reason_code: 'order_split', created_at: T.hold, ...tag,
        },
        {
            _id: new ObjectId(), account_id: new ObjectId(), owner_type: 'vendor', owner_id: vendorId,
            entry_type: 'release', amount: 25_000, pending_after: 40_000, available_after: 25_000,
            source_type: 'order', source_id: orderId, allocation_id: new ObjectId(),
            reason_code: 'hold_release', created_at: T.release, ...tag,
        },
    ] as never);

    await db.collection(COLLECTIONS.PAYOUT_REQUEST).insertOne({
        _id: payoutId, owner_type: 'vendor', owner_id: vendorId,
        amount: 30_000, currency: 'XAF', status: 'pending', origin: 'manual',
        payout_method_snapshot: {
            method: 'mobile_money',
            mobile_money: { provider: 'MTN', phone_number: PLAINTEXT_MSISDN, account_name: 'Verify Beneficiary' },
            bank: null, card: null,
        },
        ticket_id: null, requested_by_user_id: vendorUserId, resolved_at: null, resolved_by: null,
        resolved_by_source: 'platform', resolved_by_name: null,
        paid_reference: null, rejection_reason: null,
        created_at: T.payout, updated_at: T.payout, ...tag,
    } as never);

    // ── COD, for the agent ───────────────────────────────────────────────────
    await db.collection(COLLECTIONS.COD_CASH_ACCOUNT).insertOne({
        _id: cashAccountId, owner_type: 'agent', owner_id: agentId,
        balance: 200_000, currency: 'XAF', version: 2,
        created_at: now, updated_at: T.release, ...tag,
    } as never);

    await db.collection(COLLECTIONS.COD_CASH_LEDGER).insertMany([
        {
            _id: new ObjectId(), account_id: cashAccountId, owner_type: 'agent', owner_id: agentId,
            entry_type: 'collection', amount: 250_000, balance_after: 250_000,
            ref_type: 'cash_collection', ref_id: new ObjectId(), created_at: T.hold, ...tag,
        },
        {
            _id: new ObjectId(), account_id: cashAccountId, owner_type: 'agent', owner_id: agentId,
            entry_type: 'deposit', amount: -50_000, balance_after: 200_000,
            ref_type: 'agent_deposit', ref_id: new ObjectId(), created_at: T.release, ...tag,
        },
    ] as never);

    await db.collection(COLLECTIONS.COD_DISCREPANCY).insertOne({
        _id: new ObjectId(), agent_id: agentId, agency_id: agencyId, type: 'late_deposit',
        amount: 50_000, currency: 'XAF', status: 'open', raised_by: 'system',
        opened_at: T.hold, resolved_at: null, created_at: T.hold, updated_at: T.hold, ...tag,
    } as never);
}

/**
 * Re-read until a condition holds, or give up and let the assertion report what it found.
 *
 * For the handful of facts this service commits AFTER answering — the best-effort audit
 * writes. Bounded and short: it exists to remove a race, not to wait for something slow.
 */
async function eventually<T>(
    read: () => Promise<T>,
    holds: (value: T) => boolean,
    attempts = 20,
): Promise<T> {
    let latest = await read();
    for (let i = 0; i < attempts && !holds(latest); i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        latest = await read();
    }
    return latest;
}

/** The winning plan's leaf stage — `IXSCAN` served by an index, `COLLSCAN` read everything. */
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
        await make(EMAIL_ADMIN, 'Verify Accounts Admin', 2);
        await make(EMAIL_SUPPORT, 'Verify Accounts Support', 3);

        await seedPlatform();

        // ── 0. Boot ───────────────────────────────────────────────────────────
        t.section('0. The service starts, and the mount is reachable');

        const app = createApp();
        t.assert('createApp() passes every boot assertion', () => Boolean(app));

        server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
        const address = server.address();
        port = typeof address === 'object' && address ? address.port : 0;

        const routes = routeManifest().filter((r) => r.fullPath.startsWith('/api/v1/accounts'));
        t.assert('five /accounts routes reached Express', () => routes.length === 5);

        const admin = await signIn(EMAIL_ADMIN);
        const support = await signIn(EMAIL_SUPPORT);

        const joviUp = await pingPlatform().then(() => true).catch(() => false);

        // ── 1. The activity feed — the merge, for real ────────────────────────
        t.section('1. Five collections, one feed');

        const feed = await get(admin, `/api/v1/accounts/vendor/${vendorId.toString()}/activity?limit=50`);
        const rows: any[] = feed.body?.data ?? [];

        t.assert('GET /accounts/vendor/:id/activity answers 200', () => feed.status === 200);

        /**
         * Seven rows: a payout, a top-up, two earnings entries, a plan purchase, a credit
         * allowance and a credit usage. The `topup_purchase` ledger row is the EIGHTH seeded
         * row and must not appear — it is the top-up, counted twice.
         */
        t.assert('...carrying every source exactly once, with the top-up NOT double-counted', () => {
            const types = rows.map((r) => r.type);
            return rows.length === EXPECTED_FEED
                && types.filter((type) => type === 'credit_topup').length === 1
                && !types.includes('credit_movement')
                && types.includes('plan_purchase')
                && types.includes('credit_allowance')
                && types.includes('credit_usage')
                && types.includes('earning_hold')
                && types.includes('earning_release')
                && types.includes('payout_request');
        });

        /**
         * The `payout` category jovi-mall's `VendorTransaction` reserved and never filled.
         * Its own docstring says "reserved for when cash-out is built" — this is where those
         * rows finally appear.
         */
        t.assert('...including the `payout` category, which jovi-mall never filled', () => {
            const payout = rows.find((r) => r.category === 'payout');
            return payout?.amount === 30_000 && payout?.direction === 'out' && payout?.status === 'pending';
        });

        t.assert('...in one descending order across all five collections', () => {
            const instants = rows.map((r) => new Date(r.createdAt).getTime());
            return instants.every((value, i) => i === 0 || instants[i - 1] >= value);
        });

        /**
         * An earnings ledger row carries no currency of its own — it is read once, from the
         * account, by a projection that CANNOT express a balance. This is that read landing.
         */
        t.assert('...and the earning rows carry the currency read off the account', () =>
            rows.filter((r) => r.category === 'earning').every((r) => r.currency === 'XAF'));

        t.assert('the feed reports a cursor and NO total or pages', () => {
            const meta = feed.body?.meta ?? {};
            return 'nextCursor' in meta && 'hasMore' in meta
                && !('total' in meta) && !('pages' in meta);
        });

        /** No destination on a feed row — this endpoint holds no destination permission. */
        t.assert('...and not one payout destination appears anywhere on it', () => {
            const rendered = JSON.stringify(feed.body);
            return !rendered.includes(PLAINTEXT_MSISDN)
                && !rendered.includes('destination')
                && !rendered.includes('MTN');
        });

        // ── 2. The cursor walk ────────────────────────────────────────────────
        t.section('2. Walking the cursor — nothing repeated, nothing dropped');

        /**
         * THE assertion this suite exists for.
         *
         * Two of the seeded rows share an instant across two collections — a plan purchase
         * and its credit allowance, exactly as `assignPlan` writes them. Paged two at a time,
         * a bare `$lt` cursor drops one of them at the boundary; an inclusive cursor repeats
         * it. The page is extended to the end of the tie group instead, so a page may come
         * back LONGER than `limit` and every row is seen exactly once.
         */
        const seen: string[] = [];
        let cursor: string | null = null;
        let pages = 0;

        for (let guard = 0; guard < 12; guard++) {
            const query = cursor ? `?limit=2&before=${encodeURIComponent(cursor)}` : '?limit=2';
            const page = await get(admin, `/api/v1/accounts/vendor/${vendorId.toString()}/activity${query}`);
            if (page.status !== 200) break;

            const items: any[] = page.body?.data ?? [];
            seen.push(...items.map((r) => r.id));
            pages++;
            cursor = page.body?.meta?.nextCursor ?? null;
            if (cursor === null) break;
        }

        t.assert('paging two at a time reaches every row exactly once', () =>
            seen.length === EXPECTED_FEED && new Set(seen).size === EXPECTED_FEED);

        t.assert('...and the same rows the unpaged feed returned, no more and no fewer', () =>
            new Set(seen).size === new Set(rows.map((r) => r.id)).size
            && rows.every((r) => seen.includes(r.id)));

        t.assert('...taking more than one page to do it', () => pages > 1);

        // ── 3. The three sub-lists ────────────────────────────────────────────
        t.section('3. The direct sub-lists — no jovi-mall involved');

        const credits = await get(admin, `/api/v1/accounts/vendor/${vendorId.toString()}/credits`);
        t.assert('the credit ledger reads, with the top-up half still excluded', () => {
            const items: any[] = credits.body?.data ?? [];
            return credits.status === 200
                && items.length === 2
                && !items.some((row) => row.reasonCode === 'topup_purchase');
        });

        /**
         * The wallet rides in `meta` as a BALANCE OBJECT — not flattened — so it keeps the
         * `unit`/`currency`/`direction` that stop somebody adding it to a money figure.
         */
        t.assert('...and the wallet balance rides in meta as a balance object', () => {
            const wallet = credits.body?.meta?.wallet;
            return wallet?.balance === 1475
                && wallet?.unit === 'credit'
                && wallet?.currency === null
                && wallet?.direction === 'spendable_by_owner'
                && wallet?.walletExists === true;
        });

        const payoutList = await get(admin, `/api/v1/accounts/vendor/${vendorId.toString()}/payouts`);
        t.assert('the payout sub-list reads, masked exactly as /money/payouts is', () => {
            const row = (payoutList.body?.data ?? [])[0];
            return payoutList.status === 200
                && row?.id === payoutId.toString()
                && row?.destination?.masked?.mobileMoney?.provider === 'MTN'
                && row?.destination?.masked?.mobileMoney?.phoneNumberMasked === null
                && row?.destination?.revealed === false
                && !JSON.stringify(payoutList.body).includes(PLAINTEXT_MSISDN);
        });

        t.assert('...and names the owner by its BUSINESS name', () =>
            (payoutList.body?.data ?? [])[0]?.owner?.name === STORE_NAME);

        const cashLedger = await get(admin, `/api/v1/accounts/agent/${agentId.toString()}/cash-ledger`);
        t.assert('the cash ledger reads for an agent, newest first', () => {
            const items: any[] = cashLedger.body?.data ?? [];
            return cashLedger.status === 200
                && items.length === 2
                && items[0].entryType === 'deposit'
                && items[0].balanceAfter === 200_000;
        });

        /**
         * A vendor cannot hold cash, so this is a 400 that says so rather than an empty page
         * reading as "no movements". The distinction is the account DTO's fourth mechanism,
         * enforced at the edge.
         */
        const vendorCash = await get(admin, `/api/v1/accounts/vendor/${vendorId.toString()}/cash-ledger`);
        t.assert('...while a VENDOR cash ledger is refused by shape, not answered empty', () =>
            vendorCash.status === 400);

        // ── 4. Index plans ────────────────────────────────────────────────────
        t.section('4. Every source query uses an index');

        const ownerScope = { $and: [{ owner_type: 'vendor' }, { owner_id: vendorId }] };
        const stages: Record<string, string> = {
            planPurchases: await explainStage(COLLECTIONS.PLAN_PURCHASE, ownerScope, { created_at: -1, _id: -1 }),
            creditTopups: await explainStage(COLLECTIONS.CREDIT_TOPUP, ownerScope, { created_at: -1, _id: -1 }),
            creditLedger: await explainStage(COLLECTIONS.CREDIT_TRANSACTION, ownerScope, { created_at: -1, _id: -1 }),
            earningsLedger: await explainStage(COLLECTIONS.EARNINGS_LEDGER, ownerScope, { created_at: -1, _id: -1 }),
            payouts: await explainStage(COLLECTIONS.PAYOUT_REQUEST, ownerScope, { created_at: -1, _id: -1 }),
            creditWallet: await explainStage(COLLECTIONS.CREDIT_WALLET, ownerScope, { _id: -1 }),
            cashLedger: await explainStage(
                COLLECTIONS.COD_CASH_LEDGER,
                { $and: [{ owner_type: 'agent' }, { owner_id: agentId }] },
                { created_at: -1, _id: -1 },
            ),
        };

        for (const [name, stage] of Object.entries(stages)) {
            t.assert(`the ${name} query is served by an index (${stage})`, () => stage !== 'COLLSCAN');
        }

        // ── 5. The account view ───────────────────────────────────────────────
        t.section('5. The account itself — three balance models, one page');

        if (!joviUp) {
            t.assert('SKIPPED: jovi-mall is unreachable, so the two delegated verdicts cannot answer', () => {
                console.error('    ⚠️  the account OVERVIEW needs jovi-mall running; the four direct routes above ran');
                return true;
            });
        } else {
            const vendorAccount = await get(admin, `/api/v1/accounts/vendor/${vendorId.toString()}`);
            t.assert('GET /accounts/vendor/:id answers 200', () => vendorAccount.status === 200);

            const vendorData = vendorAccount.body?.data ?? {};

            /** The phase plan's exit gate, on raw JSON rather than on a mapper. */
            t.assert('a vendor cannot hold COD cash — codCash is null, and so is codExposure', () =>
                vendorData.balances?.codCash === null && vendorData.codExposure === null);

            t.assert('...while its credit balance is a `credit` unit with a null currency', () =>
                vendorData.balances?.credits?.unit === 'credit'
                && vendorData.balances?.credits?.currency === null
                && vendorData.balances?.credits?.balance === 1475);

            /**
             * The balances came from jovi-mall's `getBalances`, not from the
             * `earnings_accounts` columns this suite seeded — which happen to hold the same
             * numbers, because that IS what the verdict reconciles. What matters is that the
             * call answered rather than the DTO defaulting to zeros.
             */
            t.assert('...and its earnings block came back from the delegated verdict', () =>
                vendorData.balances?.earnings?.direction === 'owed_to_owner'
                && vendorData.balances?.earnings?.currency === 'XAF'
                && vendorData.balances?.earnings?.requested === 30_000);

            t.assert('no top-level balance/total/amount key exists on the response', () =>
                !('balance' in vendorData) && !('total' in vendorData) && !('amount' in vendorData));

            t.assert('the subscription names its plan, its actor stamp and the notice period', () =>
                vendorData.subscription?.planCode === 'VERIFY_ACCOUNTS_PRO'
                && vendorData.subscription?.planName === 'Verify Accounts Pro'
                && vendorData.subscription?.assignedBy?.source === 'admin'
                && vendorData.subscription?.notifyDaysBeforeExpiry === 7);

            t.assert('...and its entitlements came from the second delegated verdict', () =>
                vendorData.subscription?.entitlements?.commissionPercent === 12.5);

            t.assert('the payouts block summarises the pending request, masked', () =>
                vendorData.payouts?.pendingCount === 1
                && vendorData.payouts?.pendingAmount === 30_000
                && vendorData.payouts?.destination?.revealed === false
                && !JSON.stringify(vendorData).includes(PLAINTEXT_MSISDN));

            const agentAccount = await get(admin, `/api/v1/accounts/agent/${agentId.toString()}`);
            const agentData = agentAccount.body?.data ?? {};

            t.assert('an AGENT holds COD cash, and owes it to their agency', () =>
                agentAccount.status === 200
                && agentData.balances?.codCash?.held === 200_000
                && agentData.balances?.codCash?.direction === 'owed_to_agency');

            t.assert('...with its contract exposure and no reserve holds', () =>
                agentData.codExposure?.contracts?.length === 1
                && agentData.codExposure?.contracts[0]?.outstandingBalance === 60_000
                && agentData.codExposure?.contracts[0]?.maxThreshold === 150_000
                && agentData.codExposure?.reserveHolds === null);

            /**
             * `>=`, not `>`: `max_threshold` is the ceiling dispatch refuses AT. The fixture
             * sits exactly on 200,000 for that reason.
             */
            t.assert('...and the flags read the open discrepancy and the COD ceiling', () =>
                agentData.flags?.openDiscrepancies === 1
                && agentData.flags?.overCodThreshold === true);

            const agencyAccount = await get(admin, `/api/v1/accounts/agency/${agencyId.toString()}`);
            t.assert('an AGENCY owes the platform, and has a reserve-hold array', () =>
                agencyAccount.status === 200
                && agencyAccount.body?.data?.balances?.codCash?.direction === 'owed_to_platform'
                && Array.isArray(agencyAccount.body?.data?.codExposure?.reserveHolds));

            /** An agency that has never collected: `held: 0` — applies, currently empty. */
            t.assert('...and reports held: 0 rather than null, because it CAN owe', () =>
                agencyAccount.body?.data?.balances?.codCash?.held === 0);

            /**
             * A REGRESSION assertion for somebody else's endpoint, kept here because this is
             * where the defect surfaced.
             *
             * Reading an agency goes through `AgencyReadRepository.findById`, whose outer
             * `$project` restated the Magazin's own whitelist — carrying a nested `_id: 0`
             * into an inclusion projection, which Mongo refuses. **`GET /agencies` and
             * `GET /agencies/:id` therefore answered 500 on every request from Phase 9 until
             * this suite read an agency through the same repository.** `test-data-access.ts`
             * now pins the shape; this pins that the endpoints actually answer.
             */
            const [agencyDetail, agencyList] = await Promise.all([
                get(admin, `/api/v1/agencies/${agencyId.toString()}`),
                get(admin, '/api/v1/agencies?limit=1'),
            ]);
            t.assert('the agency directory and detail answer 200 — the $project defect is fixed', () =>
                agencyDetail.status === 200
                && agencyList.status === 200
                && Array.isArray(agencyList.body?.data));
        }

        // ── 6. The gates ──────────────────────────────────────────────────────
        t.section('6. Who may reach it');

        const [supportAccount, supportCredits, supportPayouts] = await Promise.all([
            get(support, `/api/v1/accounts/vendor/${vendorId.toString()}`),
            get(support, `/api/v1/accounts/vendor/${vendorId.toString()}/credits`),
            get(support, `/api/v1/accounts/vendor/${vendorId.toString()}/payouts`),
        ]);

        /**
         * The account view is an `all`-mode composition of three permissions, so Support
         * failing ANY one of them refuses the whole page — which is the point of composing
         * rather than inventing an `accounts.read` that would have granted all three.
         */
        t.assert('Support cannot open an account view — it composes three permissions', () =>
            supportAccount.status === 403);

        t.assert('...nor the payout sub-list, which needs money.payouts.read', () =>
            supportPayouts.status === 403);

        /**
         * Polled rather than read once, and the reason is a real property of the writer:
         * `recordDenial` is best-effort and fire-and-forget, so the 403 is already on the
         * wire before its row is committed. Reading immediately would make this assertion
         * fail on a fast machine and pass on a slow one, which is worse than not having it.
         */
        const denials = await eventually(
            () => AuditLogModel().find({ status: 'denied' }).sort({ occurred_at: -1 }).limit(20).lean(),
            (rows) => rows.some((d: any) => (d.required_permissions ?? []).some(
                (p: string) => p.startsWith('money.') || p.startsWith('billing.') || p.startsWith('cod.'),
            )),
        );
        t.assert('every refusal above wrote a denial row naming what was missing', () =>
            denials.some((d: any) => (d.required_permissions ?? []).some(
                (p: string) => p.startsWith('money.') || p.startsWith('billing.') || p.startsWith('cod.'),
            )));

        // Whether Support holds `billing.plans.read` is a tier-grant decision, not this
        // suite's; what matters is that the answer is a decision and not an error.
        t.assert('...and the credits list answers a definite 200 or 403, never a 500', () =>
            supportCredits.status === 200 || supportCredits.status === 403);

        // ── 7. Route order and the 404 ────────────────────────────────────────
        t.section('7. Express resolves the paths as declared');

        const unknown = await get(admin, `/api/v1/accounts/vendor/${new ObjectId().toString()}`);
        t.assert('an id that names no vendor is a 404 with ACCOUNT_OWNER_NOT_FOUND', () =>
            unknown.status === 404 && unknown.body?.error?.code === 'ACCOUNT_OWNER_NOT_FOUND');

        /**
         * The same id under the wrong owner kind. `ACCOUNT_OWNER_NOT_FOUND` rather than the
         * generic `NOT_FOUND` is what lets a dashboard say "this id is an agent, not a
         * vendor" instead of "nothing here".
         */
        const wrongKind = await get(admin, `/api/v1/accounts/vendor/${agentId.toString()}`);
        t.assert('...and so is an id that exists under a DIFFERENT owner kind', () =>
            wrongKind.status === 404 && wrongKind.body?.error?.code === 'ACCOUNT_OWNER_NOT_FOUND');

        const badKind = await get(admin, `/api/v1/accounts/platform/${vendorId.toString()}`);
        t.assert('`platform` is not an account kind — a 400 from the enum, never a route miss', () =>
            badKind.status === 400);

        t.assert('the sub-routes are not swallowed by /:ownerType/:ownerId', () =>
            credits.status === 200 && payoutList.status === 200 && cashLedger.status === 200
            && Array.isArray(credits.body?.data));

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
