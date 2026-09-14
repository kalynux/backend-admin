/**
 * Verify: billing against REAL infrastructure and a REAL jovi-mall.
 *
 * `test:billing` proves the rules are internally consistent. This proves the transport
 * works — and it is the only place the phase's exit gate can be demonstrated, because that
 * gate is about what happens INSIDE the other service:
 *
 *   Gate  `POST /billing/plans` writes a `pricing_plans` row VIA jovi-mall and produces
 *         exactly one `billing.plans.create` audit row at `succeeded`.
 *
 * Four more things only a live run can show, each of which a DB-free suite structurally
 * cannot:
 *
 *   - an assignment stamps `assigned_by_source: 'admin'` with a name snapshot (F-B). That
 *     column is written by jovi-mall from headers this service sent; nothing here can
 *     assert it without asking the other database what landed.
 *   - the assign row appears on **`GET /vendors/:id/activity`**. This is the check that
 *     validates splitting `assign` into three audit actions — `buildQueryFilter` matches
 *     on `target_type`/`target_id` and does not consult `related_target_*`, so a single
 *     action targeting the plan would 200 with an empty feed rather than fail.
 *   - `before: null` on a first assignment, which is the observable consequence of
 *     `findActiveForOwner` deliberately not lazily creating the free tier the way
 *     jovi-mall's own `getActivePlan` does.
 *   - a second assignment being QUEUED rather than activated, and its `before`/`after`
 *     naming both tiers.
 *
 * ── What it needs ─────────────────────────────────────────────────────────────
 *   Mongo + Redis (this service's usual dependencies)
 *   jovi-mall RUNNING, with INTERNAL_ADMIN_SERVICE_TOKEN set
 *   this service's JOVI_MALL_BASE_URL + JOVI_MALL_SERVICE_TOKEN set to match
 *   the seeded vendor plan catalog (`npm run seed:plans` in jovi-mall) — the free tier
 *   `starter` has to exist, because assigning any plan resolves the owner's current one
 *
 * It SKIPS loudly rather than silently when jovi-mall is unreachable — a suite that passes
 * by not running is worse than one that fails.
 *
 * It creates its own fixtures in `jovi_mall` (a throwaway user, vendor, store and pricing
 * plan) and deletes everything it made at the end, pass or fail.
 *
 * Run: npm run verify:billing
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

const t = suite('billing — live');

const PASSWORD = 'verify-billing-suite-password-7712';
const EMAIL_ADMIN = 'verify-billing-admin@example.test';
const EMAIL_SUPPORT = 'verify-billing-support@example.test';
const FIXTURE_TAG = 'verify-billing-fixture';
const PLAN_CODE = 'verify_billing_tier';

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
const write = (s: Session, method: string, path: string, body?: unknown) =>
    call(method, path, { cookies: s.cookies, csrf: s.csrf, body });

function platformDb() {
    const db = platformConnection().db;
    if (!db) throw new Error('platform connection has no db');
    return db;
}

const vendorId = new ObjectId();
const userId = new ObjectId();
const storeId = new ObjectId();

async function cleanupPlatform(): Promise<void> {
    const db = platformDb();
    for (const collection of [COLLECTIONS.USER, COLLECTIONS.VENDOR, COLLECTIONS.STORE]) {
        await db.collection(collection).deleteMany({ [FIXTURE_TAG]: true } as never);
    }
    await db.collection(COLLECTIONS.PRICING_PLAN).deleteMany({ code: PLAN_CODE } as never);
    for (const collection of [
        COLLECTIONS.SUBSCRIBER_PLAN,
        COLLECTIONS.CREDIT_WALLET,
        COLLECTIONS.CREDIT_TRANSACTION,
        COLLECTIONS.BILLING_SETTINGS,
    ]) {
        await db.collection(collection).deleteMany({ owner_id: vendorId } as never);
    }
}

async function cleanupAdmin(): Promise<void> {
    const admins = await AdminAccountModel().find({ email: { $in: [EMAIL_ADMIN, EMAIL_SUPPORT] } }, { _id: 1 });
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

async function auditRows(action: string) {
    return AuditLogModel().find({ action }).sort({ occurred_at: -1 }).limit(5).lean();
}

async function main(): Promise<number> {
    let server: Server | null = null;

    try {
        env();
        await connectAll();

        const ping = await pingPlatform();
        if (!ping.ok) {
            console.error('\n  ⚠️  jovi-mall unreachable — this suite proves the transport, so it SKIPS loudly.\n');
            return 1;
        }

        await cleanupAdmin();
        await cleanupPlatform();

        const accounts = new AdminAccountRepository();
        const passwordHash = await hash(PASSWORD);
        const make = async (email: string, displayName: string, tier: AdminTier) => {
            const session = await adminConnection().startSession();
            try {
                await session.withTransaction(async () => {
                    // ⚠ `status: 'active'` because ADR-023 made `pending` the default, and a pending
                    // fixture is refused every route this suite exercises. Fixtures, not the
                    // audited path — a real hire is activated by a Developer.
                    await accounts.create({ email, displayName, passwordHash, tier, status: 'active' }, session);
                });
            } finally {
                await session.endSession();
            }
        };
        await make(EMAIL_ADMIN, 'Verify Billing Admin', 2);
        await make(EMAIL_SUPPORT, 'Verify Billing Support', 3);

        const db = platformDb();
        const now = new Date();
        await db.collection(COLLECTIONS.USER).insertOne({
            _id: userId, login_email: 'verify-billing-user@example.test',
            login_phone: '+237600000092', password_hash: 'x', roles: ['vendor'],
            status: 'active', created_at: now, updated_at: now, [FIXTURE_TAG]: true,
        } as never);
        await db.collection(COLLECTIONS.VENDOR).insertOne({
            _id: vendorId, user_id: userId, display_name: 'Verify Billing Contact',
            status: 'active', created_at: now, updated_at: now, [FIXTURE_TAG]: true,
        } as never);
        await db.collection(COLLECTIONS.STORE).insertOne({
            _id: storeId, vendor_id: vendorId, name: 'Verify Billing Boutique',
            slug: 'verify-billing-boutique', created_at: now, updated_at: now, [FIXTURE_TAG]: true,
        } as never);

        const app = createApp();
        server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
        const address = server.address();
        port = typeof address === 'object' && address ? address.port : 0;

        const admin = await signIn(EMAIL_ADMIN);
        const support = await signIn(EMAIL_SUPPORT);

        // ── 1. THE GATE ───────────────────────────────────────────────────────
        t.section('1. The exit gate — a plan created THROUGH jovi-mall, audited once');

        const created = await write(admin, 'POST', '/api/v1/billing/plans', {
            role: 'vendor',
            code: PLAN_CODE,
            name: 'Verify Billing Tier',
            price: 12000,
            termDays: 30,
            creditAllowance: 100,
            commissionPercent: 6.5,
            maxActiveProducts: null,
        });

        t.assert('POST /billing/plans answers 201', () => created.status === 201);

        const planId = String(created.body?.data?._id ?? '');
        const row = await db.collection(COLLECTIONS.PRICING_PLAN).findOne({ code: PLAN_CODE } as never);

        t.assert('...and the row is in jovi_mall`s pricing_plans', () => row !== null);
        t.assert('...written by jovi-mall, with its own schema defaults applied', () =>
            (row as any)?.currency === 'XAF' && (row as any)?.live_tracking_enabled === true);
        t.assert('...carrying the commission this service sent', () =>
            (row as any)?.commission_percent === 6.5);

        const createRows = await auditRows('billing.plans.create');
        t.assert('exactly ONE billing.plans.create row exists', () => createRows.length === 1);
        t.assert('...at succeeded, delegated, targeting the plan', () => {
            const r: any = createRows[0];
            return r?.status === 'succeeded' && r?.delegated === true && r?.target_type === 'plan';
        });
        t.assert('...with the target id filled in AFTER the write', () =>
            (createRows[0] as any)?.target_id === planId && planId.length === 24);
        t.assert('...and a label naming the tier, so the feed reads without a join', () =>
            (createRows[0] as any)?.target_label === `vendor:${PLAN_CODE}`);
        t.assert('...whose payload records what was priced', () =>
            (createRows[0] as any)?.payload?.commissionPercent === 6.5);

        // ── 2. The direct reads ───────────────────────────────────────────────
        t.section('2. The catalog reads it back — direct, no jovi-mall call');

        const list = await get(admin, `/api/v1/billing/plans?search=${PLAN_CODE}`);
        t.assert('the catalog finds it', () =>
            list.status === 200 && (list.body?.data ?? []).some((p: any) => p.id === planId));

        const detail = await get(admin, `/api/v1/billing/plans/${planId}`);
        t.assert('the plan detail reads', () => detail.status === 200);
        t.assert('...and carries commissionPercent — the reason it exists', () =>
            detail.body?.data?.limits?.commissionPercent === 6.5);
        t.assert('...with an inapplicable cap as null, present not absent', () =>
            detail.body?.data?.limits?.maxActiveProducts === null
            && 'maxUnterminatedShipments' in (detail.body?.data?.limits ?? {}));
        t.assert('...and archivedAt null while live', () => detail.body?.data?.archivedAt === null);

        const missing = await get(admin, `/api/v1/billing/plans/${new ObjectId().toString()}`);
        t.assert('an unknown plan is a plain 404', () =>
            missing.status === 404 && missing.body?.error?.code === 'NOT_FOUND');

        // ── 3. The edit ───────────────────────────────────────────────────────
        t.section('3. The edit, and the only history a commission has');

        const patched = await write(admin, 'PATCH', `/api/v1/billing/plans/${planId}`, {
            commissionPercent: 8,
        });
        t.assert('PATCH answers 200', () => patched.status === 200);

        const updateRows = await auditRows('billing.plans.update');
        t.assert('...and writes one billing.plans.update row', () => updateRows.length === 1);
        t.assert('...whose before and after line up in the SAME camelCase', () => {
            const r: any = updateRows[0];
            return r?.before?.commissionPercent === 6.5 && r?.after?.commissionPercent === 8;
        });

        const immutable = await write(admin, 'PATCH', `/api/v1/billing/plans/${planId}`, { code: 'other' });
        t.assert('the code is immutable — a 400, not a silent drop', () => immutable.status === 400);

        // ── 4. The assignment ─────────────────────────────────────────────────
        t.section('4. Assigning it — one route where jovi-mall keeps three');

        const assigned = await write(
            admin,
            'POST',
            `/api/v1/billing/subscriptions/vendor/${vendorId.toString()}`,
            { planId, paymentReference: 'VERIFY-BILLING-REF-1' },
        );
        t.assert('POST /subscriptions/vendor/:id answers 200', () => assigned.status === 200);

        const sub: any = await db.collection(COLLECTIONS.SUBSCRIBER_PLAN)
            .findOne({ owner_id: vendorId, plan_code: PLAN_CODE } as never);
        t.assert('...and the subscriber_plans row exists in jovi_mall', () => sub !== null);

        /** F-B, landed at step 0: without these the id resolves in no collection at all. */
        t.assert('the acting ADMINISTRATOR is stamped on it', () => Boolean(sub?.assigned_by));
        t.assert('...marked as an admin id, so nobody looks for it in `users`', () =>
            sub?.assigned_by_source === 'admin');
        t.assert('...with a name snapshot, because that id resolves nowhere here', () =>
            sub?.assigned_by_name === 'Verify Billing Admin');
        t.assert('...and the payment reference this service renamed on the wire', () =>
            sub?.payment_reference === 'VERIFY-BILLING-REF-1');

        /**
         * The decision three audit actions exist for. `buildQueryFilter` matches on
         * target_type/target_id only, so a single action targeting the PLAN would be
         * invisible on the vendor's own activity feed.
         */
        const assignRows = await auditRows('billing.subscriptions.assign_vendor');
        t.assert('one billing.subscriptions.assign_VENDOR row exists', () => assignRows.length === 1);
        t.assert('...targeting the VENDOR, not the plan', () => {
            const r: any = assignRows[0];
            return r?.target_type === 'vendor' && r?.target_id === vendorId.toString();
        });
        t.assert('...labelled with the BUSINESS name off the Store', () =>
            (assignRows[0] as any)?.target_label === 'Verify Billing Boutique');
        t.assert('...naming the tier in the payload — it lives in the other database', () =>
            (assignRows[0] as any)?.payload?.plan === `vendor:${PLAN_CODE}`);

        /**
         * `before: null` here is the CORRECT answer, and it is the observable consequence
         * of `findActiveForOwner` deliberately not being jovi-mall's `getActivePlan`.
         *
         * This vendor has never had a plan. `getActivePlan` would lazily create the role's
         * free tier and grant its credit allowance — so reading the `before` through it
         * would MINT a subscription and a credit grant as a side effect of recording what
         * was there beforehand, and then report the thing it had just created as the prior
         * state. The honest answer for an owner who had nothing is nothing.
         */
        t.assert('...and reports before: null for a vendor who never had a plan', () =>
            (assignRows[0] as any)?.before === null);

        const activity = await get(admin, `/api/v1/vendors/${vendorId.toString()}/activity`);
        t.assert('THE CHECK: the row appears on GET /vendors/:id/activity', () =>
            activity.status === 200
            && (activity.body?.data ?? []).some((e: any) => e.action === 'billing.subscriptions.assign_vendor'));

        /**
         * The "moved from" half, which only a SECOND assignment can show. Our tier has a
         * 30-day term, so jovi-mall queues this one as `pending_activation` rather than
         * activating it — the branch that exists so a term bought in advance loses no days.
         */
        const seededGrowth: any = await db.collection(COLLECTIONS.PRICING_PLAN)
            .findOne({ role: 'vendor', code: 'growth', deletedAt: null } as never);

        const second = await write(
            admin,
            'POST',
            `/api/v1/billing/subscriptions/vendor/${vendorId.toString()}`,
            { planId: String(seededGrowth?._id) },
        );
        t.assert('a second assignment is queued rather than activated', () =>
            second.status === 200 && second.body?.data?.status === 'pending_activation');

        const assignRowsAfter = await auditRows('billing.subscriptions.assign_vendor');
        t.assert('...and ITS audit row says what the vendor moved FROM', () =>
            (assignRowsAfter[0] as any)?.before?.planCode === PLAN_CODE
            && (assignRowsAfter[0] as any)?.after?.planCode === 'growth');

        const subscribers = await get(admin, `/api/v1/billing/plans/${planId}/subscribers`);
        t.assert('the plan now lists its subscriber', () =>
            subscribers.status === 200 && subscribers.body?.meta?.total === 1);
        t.assert('...named by their BUSINESS identity, not their contact', () =>
            subscribers.body?.data?.[0]?.owner?.name === 'Verify Billing Boutique');
        t.assert('...with the admin actor stamp surfaced on the wire', () =>
            subscribers.body?.data?.[0]?.assignedBy?.source === 'admin');

        // ── 5. The queue ──────────────────────────────────────────────────────
        t.section('5. The expiring-soon queue excludes the never-expiring tier');

        const far = new Date(Date.now() + 400 * 86_400_000).toISOString();
        const queue = await get(admin, `/api/v1/billing/subscriptions?expiringBefore=${encodeURIComponent(far)}&limit=100`);
        t.assert('the queue reads', () => queue.status === 200);
        t.assert('...and contains our 30-day term', () =>
            (queue.body?.data ?? []).some((s: any) => s.plan.code === PLAN_CODE));
        t.assert('...and NOT one free-tier row, whose expiresAt is null', () =>
            (queue.body?.data ?? []).every((s: any) => s.expiresAt !== null));

        // ── 6. The archive ────────────────────────────────────────────────────
        t.section('6. Archiving is a soft delete, and the row is still readable');

        const archived = await write(admin, 'DELETE', `/api/v1/billing/plans/${planId}`);
        t.assert('DELETE answers 200 with a message', () =>
            archived.status === 200 && String(archived.body?.message ?? '').includes('archived'));

        const defaultList = await get(admin, `/api/v1/billing/plans?search=${PLAN_CODE}`);
        t.assert('...and the plan leaves the default catalog', () =>
            (defaultList.body?.data ?? []).length === 0);

        const withArchived = await get(admin, `/api/v1/billing/plans?search=${PLAN_CODE}&includeArchived=true`);
        t.assert('...but comes back with includeArchived=true', () =>
            (withArchived.body?.data ?? []).length === 1);
        t.assert('...carrying archivedAt, so nothing reads it as live', () =>
            typeof withArchived.body?.data?.[0]?.archivedAt === 'string');
        t.assert('...while its subscriber keeps running on it', () => sub?.status === 'active');

        const deleteRows = await auditRows('billing.plans.delete');
        t.assert('the archive row carries the whole before — jovi-mall answered no body', () => {
            const r: any = deleteRows[0];
            return r?.status === 'succeeded' && r?.before?.code === PLAN_CODE && r?.after === null;
        });

        // ── 7. The gates ──────────────────────────────────────────────────────
        t.section('7. Who may reach it');

        const supportRead = await get(support, '/api/v1/billing/plans');
        t.assert('Support is refused the catalog — they hold no billing permission', () =>
            supportRead.status === 403);

        const denials = await AuditLogModel().find({ status: 'denied' }).sort({ occurred_at: -1 }).limit(3).lean();
        t.assert('...and the refusal is on the record', () =>
            denials.some((d: any) => (d.required_permissions ?? []).includes('billing.plans.read')));

        const badOwner = await write(
            admin, 'POST', `/api/v1/billing/subscriptions/vendor/${new ObjectId().toString()}`, { planId },
        );
        t.assert('an unknown owner is ACCOUNT_OWNER_NOT_FOUND, naming the owner type', () =>
            badOwner.status === 404 && badOwner.body?.error?.code === 'ACCOUNT_OWNER_NOT_FOUND');

        const badType = await write(admin, 'POST', '/api/v1/billing/subscriptions/customer/' + vendorId.toString(), { planId });
        t.assert('an owner type outside the three is refused at the edge', () => badType.status === 400);

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
