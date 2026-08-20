/**
 * Verify: the administrator inbox against REAL infrastructure.
 *
 * `test:notifications` proves the rules are internally consistent. This proves the seven
 * things that are properties of what Mongo, the projector and Express actually do — and
 * every one of them is a claim the design rests on:
 *
 *   §2  **a new source starts at `now`.** A discrepancy opened BEFORE the first tick is
 *       never delivered. Without this, shipping the phase would fan out the platform's
 *       entire historical backlog on deploy day, to every entitled administrator, in one
 *       tick.
 *   §3  **fan-out respects the permission.** A tier-2 administrator receives a COD
 *       discrepancy; a tier-3 (Support) administrator, who holds `notifications.read` but
 *       NOT `cod.discrepancies.read`, does not. This is the whole visibility model, end to
 *       end, against the real grant table.
 *   §4  **the sweep is idempotent**, including after the watermark is rewound to the
 *       beginning of time. The unique `{ source_key, admin_id }` index is the only thing
 *       standing between this design and a duplicate per tick, forever.
 *   §5  **read/unread/archive do what they say**, including that archiving removes a row
 *       from the default list without destroying it, and that unarchiving clears the purge
 *       date rather than leaving a row that lies about what happens to it next.
 *   §6  **a muted type is not delivered** — preferences apply at fan-out, so the row is
 *       never written rather than filtered later.
 *   §7  **every projector query uses an index.** `explain()` over each source's real sweep
 *       shape. A `COLLSCAN` on a jovi-mall collection is a FAILURE, reported as the index
 *       jovi-mall should add — never added from here.
 *
 * ── What it needs ─────────────────────────────────────────────────────────────
 *   Mongo (a replica set — the audit store assertion requires one) + Redis. It does NOT
 *   need jovi-mall running: every source in this phase is a direct read, which is exactly
 *   the property that deriving from committed rows buys.
 *
 * It creates its own fixtures in `jovi_mall` and `wi-admin` and deletes everything it made
 * at the end, pass or fail.
 *
 * Run: npm run verify:notifications
 */
import 'dotenv/config';

process.env.ADMIN_AUTH_RATE_LIMIT_MAX = '500';
// The projector is driven by hand here, tick by tick. A timer firing between a seed and an
// assertion would make every count in this file racy.
process.env.ADMIN_NOTIFICATIONS_SWEEP_S = '0';

import type { Server } from 'http';
import { ObjectId } from 'mongodb';
import { suite } from './_assert';
import { env } from '../../src/config/env';
import { createApp } from '../../src/app';
import { connectAll, closeAll, platformConnection, adminConnection } from '../../src/infra/mongo/connections';
import { closeRedisClients } from '../../src/infra/redis/redis.factory';
import { AdminAccountRepository } from '../../src/modules/admin-identity/repositories/admin-account.repository';
import { hash } from '../../src/modules/admin-identity/domain/password.service';
import { AdminTier } from '../../src/modules/admin-identity/domain/admin-identity.types';
import { COLLECTIONS } from '../../src/infra/platform/collections';
import { AdminNotificationModel } from '../../src/modules/notifications/models/admin-notification.model';
import { NotificationPreferenceModel } from '../../src/modules/notifications/models/notification-preference.model';
import { NotificationWatermarkModel } from '../../src/modules/notifications/models/notification-watermark.model';
import { NOTIFICATION_SOURCES } from '../../src/modules/notifications/domain/source.registry';
import { withCursor } from '../../src/modules/notifications/repositories/notification-source.read.repository';
import { NOTIFICATION_TYPES } from '../../src/modules/notifications/domain/notification.types';
import { runOnce } from '../../src/modules/notifications/domain/notification.projector';
import { projectorOptions } from '../../src/modules/notifications/domain/notification.scheduler';

const t = suite('administrator notifications — live');

const PASSWORD = 'verify-notifications-suite-password-7712';
const EMAIL_ADMIN = 'verify-notif-admin@example.test';
const EMAIL_SUPPORT = 'verify-notif-support@example.test';
const FIXTURE_TAG = 'verify-notifications-fixture';

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
    // Every mutation goes through `requireCsrfToken`; without the header the route answers
    // 403 before the handler runs, which looks exactly like a permission failure.
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
    return {
        adminId: me.body?.data?.admin?.id,
        cookies: res.cookies,
        csrf: res.cookies.admin_csrf_token ?? '',
    };
}

const get = (s: Session, path: string) => call('GET', path, { cookies: s.cookies });
const write = (s: Session, method: string, path: string, body?: unknown) =>
    call(method, path, { cookies: s.cookies, csrf: s.csrf, body });

function platformDb() {
    const db = platformConnection().db;
    if (!db) throw new Error('platform connection has no db');
    return db;
}

function adminDb() {
    const db = adminConnection().db;
    if (!db) throw new Error('admin connection has no db');
    return db;
}

// Every id this suite mints, so cleanup cannot miss one.
const agentId = new ObjectId();
const agencyId = new ObjectId();
const staleDiscrepancyId = new ObjectId();
const freshDiscrepancyId = new ObjectId();
const mutedDiscrepancyId = new ObjectId();

/** One projector tick, driven by hand. */
const tick = () => runOnce(projectorOptions());

async function seedDiscrepancy(id: ObjectId, openedAt: Date): Promise<void> {
    await platformDb().collection(COLLECTIONS.COD_DISCREPANCY).insertOne({
        _id: id,
        agent_id: agentId,
        agency_id: agencyId,
        type: 'cash_shortfall',
        amount: 125_000,
        currency: 'XAF',
        status: 'open',
        raised_by: 'system',
        raised_by_user_id: null,
        deposit_id: null,
        note: null,
        resolution_note: null,
        resolved_by_user_id: null,
        opened_at: openedAt,
        resolved_at: null,
        created_at: openedAt,
        updated_at: openedAt,
        [FIXTURE_TAG]: true,
    } as never);
}

async function cleanupPlatform(): Promise<void> {
    await platformDb().collection(COLLECTIONS.COD_DISCREPANCY)
        .deleteMany({ [FIXTURE_TAG]: true } as never);
}

async function cleanupAdmin(): Promise<void> {
    const db = adminConnection().db;
    if (!db) return;
    const emails = [EMAIL_ADMIN, EMAIL_SUPPORT];
    const accounts = await db.collection('admin_accounts')
        .find({ email: { $in: emails } }).project({ _id: 1 }).toArray();
    const ids = accounts.map((account) => account._id);

    await db.collection('admin_accounts').deleteMany({ email: { $in: emails } });
    await db.collection('admin_sessions').deleteMany({ admin_id: { $in: ids } });
    await db.collection('admin_audit_log').deleteMany({ actor_id: { $in: ids } });
    await db.collection('admin_notifications').deleteMany({ admin_id: { $in: ids } });
    await db.collection('admin_notification_preferences').deleteMany({ admin_id: { $in: ids } });
    // The watermarks are global, not per-admin. Removing them puts every source back to
    // "never seen", which is what lets §2's no-backfill assertion mean anything.
    await db.collection('admin_notification_watermarks').deleteMany({});
}

async function countFor(adminId: string): Promise<number> {
    return AdminNotificationModel().countDocuments({
        admin_id: new ObjectId(adminId),
        type: 'cod.discrepancy.opened',
    });
}

async function unreadCount(session: Session): Promise<number> {
    const res = await get(session, '/api/v1/notifications/unread-count');
    return res.body?.data?.unreadCount;
}

async function listIds(session: Session, query = ''): Promise<string[]> {
    const res = await get(session, `/api/v1/notifications${query}`);
    return (res.body?.data ?? []).map((row: any) => row.id);
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
        await make(EMAIL_ADMIN, 'Verify Notifications Admin', 2);
        await make(EMAIL_SUPPORT, 'Verify Notifications Support', 3);

        const app = createApp();
        server = await new Promise<Server>((resolve) => {
            const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
        });
        port = (server.address() as { port: number }).port;

        const admin = await signIn(EMAIL_ADMIN);
        const support = await signIn(EMAIL_SUPPORT);

        // ─────────────────────────────────────────────────────────────────────
        t.section('1. The surface answers before anything has happened');
        // ─────────────────────────────────────────────────────────────────────

        const emptyList = await get(admin, '/api/v1/notifications');
        t.assert('the list is 200 with an empty page', () =>
            emptyList.status === 200 && Array.isArray(emptyList.body.data)
            && emptyList.body.data.length === 0);

        t.assert('an empty list reports pages: 0, not 1', () =>
            emptyList.body.meta.pages === 0 && emptyList.body.meta.total === 0);

        t.assert('meta carries unreadCount beside the four required fields', () =>
            emptyList.body.meta.unreadCount === 0
            && ['total', 'page', 'limit', 'pages'].every((key) => key in emptyList.body.meta));

        const sources = await get(admin, '/api/v1/notifications/sources');
        t.assert('the sources endpoint lists every registered source', () =>
            sources.status === 200 && sources.body.data.sources.length === NOTIFICATION_SOURCES.length);

        const supportEmpty = await get(support, '/api/v1/notifications');
        t.assert('a tier-3 admin may read the inbox at all', () => supportEmpty.status === 200);

        const badSort = await get(admin, '/api/v1/notifications?sort=required_permission');
        t.assert('an undeclared sort field is refused with a 400', () => badSort.status === 400);

        // ─────────────────────────────────────────────────────────────────────
        t.section('2. A new source starts at now — no backfill on deploy day');
        // ─────────────────────────────────────────────────────────────────────

        // Opened an hour ago: the historical backlog, in miniature.
        await seedDiscrepancy(staleDiscrepancyId, new Date(Date.now() - 60 * 60 * 1000));

        const firstTick = await tick();
        t.assert('the first tick delivers nothing at all', () =>
            firstTick.sources.every((source) => source.delivered === 0));

        const watermarks = await NotificationWatermarkModel().countDocuments({});
        t.assert('the first tick created a watermark for every source', () =>
            watermarks === NOTIFICATION_SOURCES.length);

        const afterFirst = await countFor(admin.adminId);
        t.assert('the pre-existing discrepancy was NOT delivered', () => afterFirst === 0);

        // ─────────────────────────────────────────────────────────────────────
        t.section('3. Fan-out, and the permission that gates it');
        // ─────────────────────────────────────────────────────────────────────

        await seedDiscrepancy(freshDiscrepancyId, new Date());
        const secondTick = await tick();
        const codTick = secondTick.sources.find((s) => s.sourceId === 'cod_discrepancy_opened');

        t.assert('the tick delivered the new discrepancy', () => (codTick?.delivered ?? 0) > 0);

        const adminCount = await countFor(admin.adminId);
        t.assert('the tier-2 admin received it — they hold cod.discrepancies.read', () =>
            adminCount === 1);

        /**
         * §3's headline. Support holds `notifications.read` — they can open the inbox — and
         * does NOT hold `cod.discrepancies.read`. The row must never have been WRITTEN for
         * them, not merely hidden from them.
         */
        const supportCount = await countFor(support.adminId);
        t.assert('the tier-3 admin did NOT receive it — they lack cod.discrepancies.read', () =>
            supportCount === 0);

        const adminList = await get(admin, '/api/v1/notifications');
        t.assert('it appears in the admin list, unread', () =>
            adminList.body.data.length === 1
            && adminList.body.data[0].type === 'cod.discrepancy.opened'
            && adminList.body.data[0].isRead === false);

        t.assert('it carries the severity the catalog assigns', () =>
            adminList.body.data[0].severity === 'critical');

        t.assert('it points at a real API path for the object', () =>
            adminList.body.data[0].actionPath === `/cod/discrepancies/${freshDiscrepancyId.toString()}`);

        t.assert('occurredAt is the row’s own timestamp, not the sweep’s clock', () =>
            new Date(adminList.body.data[0].occurredAt).getTime() < Date.now());

        t.assert('the DTO does not leak required_permission or source_row_id', () =>
            !('requiredPermission' in adminList.body.data[0])
            && !('sourceRowId' in adminList.body.data[0]));

        const supportList = await get(support, '/api/v1/notifications');
        t.assert('the support inbox is still empty', () => supportList.body.data.length === 0);

        const adminUnread = await unreadCount(admin);
        t.assert('unread-count agrees with the list', () => adminUnread === 1);

        // ─────────────────────────────────────────────────────────────────────
        t.section('4. Idempotency — the sweep may re-read forever');
        // ─────────────────────────────────────────────────────────────────────

        await tick();
        await tick();
        await tick();

        const afterRepeats = await countFor(admin.adminId);
        t.assert('three more ticks delivered no duplicate', () => afterRepeats === 1);

        /**
         * The stronger version: put the watermark back to the beginning of time, so the
         * sweep re-reads every row it has ever seen — the crash-recovery case. The only
         * thing that makes it safe is the unique index.
         */
        await NotificationWatermarkModel().updateOne(
            { source_id: 'cod_discrepancy_opened' },
            { $set: { last_seen_at: new Date(0), last_seen_id: '' } },
        );
        await tick();

        /**
         * Asserted as "no key appears twice", NOT as an absolute count.
         *
         * A rewound watermark re-reads the source from the beginning of time, so it picks up
         * every open discrepancy the development database happens to hold — this run saw
         * eight — not only the two this suite seeded. An expected total would therefore be a
         * fixture of somebody else's data, green or red by accident.
         *
         * What must be true regardless is that no situation was delivered twice, which is
         * exactly what the unique `{ source_key, admin_id }` index guarantees and the only
         * thing the rewind is testing.
         */
        const deliveredRows = await AdminNotificationModel()
            .find({ admin_id: new ObjectId(admin.adminId) })
            .select({ source_key: 1 })
            .lean()
            .exec();
        const distinctKeys = new Set(deliveredRows.map((row) => row.source_key));

        t.assert(
            `a full re-read duplicates nothing — ${deliveredRows.length} rows, `
            + `${distinctKeys.size} distinct keys`,
            () => deliveredRows.length > 0 && deliveredRows.length === distinctKeys.size,
        );

        const staleDelivered = await AdminNotificationModel().countDocuments({
            admin_id: new ObjectId(admin.adminId),
            source_row_id: staleDiscrepancyId.toString(),
        });
        t.assert('the rewind DID pick up the stale row — it was a real re-read', () =>
            staleDelivered === 1);

        const freshDelivered = await AdminNotificationModel().countDocuments({
            admin_id: new ObjectId(admin.adminId),
            source_row_id: freshDiscrepancyId.toString(),
        });
        t.assert('the already-delivered row is still present exactly once', () =>
            freshDelivered === 1);

        // ─────────────────────────────────────────────────────────────────────
        t.section('5. Read, unread, archive, unarchive');
        // ─────────────────────────────────────────────────────────────────────

        const rows = await get(admin, '/api/v1/notifications');
        const target = rows.body.data.find(
            (row: any) => row.target.id === freshDiscrepancyId.toString(),
        );
        t.assert('the fresh discrepancy is addressable by id', () => Boolean(target?.id));

        const unreadBefore = await unreadCount(admin);
        const marked = await write(admin, 'PATCH', `/api/v1/notifications/${target.id}/read`);
        t.assert('marking read returns the row with readAt set', () =>
            marked.status === 200 && marked.body.data.isRead === true && marked.body.data.readAt !== null);

        const unreadAfter = await unreadCount(admin);
        t.assert('the unread count dropped by exactly one', () => unreadAfter === unreadBefore - 1);

        const unreadIds = await listIds(admin);
        t.assert('the read row is gone from the default (unread) list', () =>
            !unreadIds.includes(target.id));

        const readIds = await listIds(admin, '?status=read');
        t.assert('it is present under ?status=read', () => readIds.includes(target.id));

        const unmarked = await write(admin, 'PATCH', `/api/v1/notifications/${target.id}/unread`);
        t.assert('marking unread is a real undo', () =>
            unmarked.status === 200 && unmarked.body.data.isRead === false);

        const archived = await write(admin, 'POST', `/api/v1/notifications/${target.id}/archive`);
        t.assert('archiving stamps archivedAt', () =>
            archived.status === 200 && archived.body.data.isArchived === true
            && archived.body.data.archivedAt !== null);

        const afterArchiveDefault = await listIds(admin);
        t.assert('an archived row leaves the default list', () =>
            !afterArchiveDefault.includes(target.id));

        const afterArchiveAll = await listIds(admin, '?status=all');
        t.assert('an archived row leaves ?status=all too — "all" means the inbox', () =>
            !afterArchiveAll.includes(target.id));

        const afterArchiveDrawer = await listIds(admin, '?status=archived');
        t.assert('?status=archived opens the drawer', () =>
            afterArchiveDrawer.includes(target.id));

        const archivedRow = await AdminNotificationModel().findById(target.id).lean().exec();
        t.assert('archiving set purge_after — the TTL can see the row', () =>
            archivedRow?.purge_after instanceof Date && archivedRow?.archived_at instanceof Date);

        const restored = await write(admin, 'POST', `/api/v1/notifications/${target.id}/unarchive`);
        const restoredRow = await AdminNotificationModel().findById(target.id).lean().exec();
        t.assert('unarchiving clears BOTH archived_at and purge_after', () =>
            restored.status === 200
            && restoredRow?.archived_at === undefined && restoredRow?.purge_after === undefined);

        const foreign = await write(support, 'PATCH', `/api/v1/notifications/${target.id}/read`);
        t.assert('the support admin gets 404 for a row that is not theirs', () =>
            foreign.status === 404 && foreign.body.error.code === 'NOTIFICATION_NOT_FOUND');

        const missing = await write(
            admin, 'PATCH', `/api/v1/notifications/${new ObjectId().toString()}/read`,
        );
        t.assert('a notification that does not exist is the same 404', () =>
            missing.status === 404 && missing.body.error.code === 'NOTIFICATION_NOT_FOUND');

        const readAll = await write(admin, 'POST', '/api/v1/notifications/read-all', { type: 'cod.discrepancy.opened' });
        t.assert('read-all marks the remaining unread rows', () =>
            readAll.status === 200 && readAll.body.data.marked >= 1);

        const afterReadAll = await unreadCount(admin);
        t.assert('nothing is left unread afterwards', () => afterReadAll === 0);

        // ─────────────────────────────────────────────────────────────────────
        t.section('6. Preferences — muting stops the write, not the read');
        // ─────────────────────────────────────────────────────────────────────

        const prefs = await get(admin, '/api/v1/notifications/preferences');
        t.assert('preferences list every catalogued type', () =>
            prefs.status === 200 && prefs.body.data.preferences.length === NOTIFICATION_TYPES.length);

        t.assert('everything is enabled and unoverridden to begin with', () =>
            prefs.body.data.preferences.every((p: any) => p.enabled === true && p.overridden === false));

        const muted = await write(admin, 'PATCH', '/api/v1/notifications/preferences', { overrides: { 'cod.discrepancy.opened': false } });
        t.assert('muting a type is saved and reported as an override', () =>
            muted.status === 200
            && muted.body.data.preferences.find((p: any) => p.type === 'cod.discrepancy.opened')
                .enabled === false);

        const auditRows = await adminDb().collection('admin_audit_log')
            .countDocuments({ action: 'notifications.preferences.update_self' });
        t.assert('the preference change was audited', () => auditRows >= 1);

        const beforeMuteTick = await countFor(admin.adminId);
        await seedDiscrepancy(mutedDiscrepancyId, new Date());
        await tick();
        const afterMuteTick = await countFor(admin.adminId);

        t.assert('a muted type produces NO ROW — it is not merely hidden', () =>
            afterMuteTick === beforeMuteTick);

        const cleared = await write(admin, 'PATCH', '/api/v1/notifications/preferences', { overrides: { 'cod.discrepancy.opened': null } });
        t.assert('null clears the override and returns to the catalog default', () =>
            cleared.body.data.preferences.find((p: any) => p.type === 'cod.discrepancy.opened')
                .overridden === false);

        const badPref = await write(admin, 'PATCH', '/api/v1/notifications/preferences', { overrides: { 'not.a.type': true } });
        t.assert('a preference for a type that does not exist is refused', () =>
            badPref.status === 400);

        // ─────────────────────────────────────────────────────────────────────
        t.section('7. Every projector query uses an index');
        // ─────────────────────────────────────────────────────────────────────

        // A COLLSCAN here is a real finding about jovi-mall's indexes, not about this code:
        // the projector runs unattended on a timer, and a full scan of `orders` every thirty
        // seconds is a load profile nobody asked for.
        for (const source of NOTIFICATION_SOURCES) {
            if (source.collection.startsWith('admin_')) continue;

            // The REAL sweep query — the source's own actionable filter composed with a
            // cursor, exactly as `withCursor` builds it. Explaining a synthetic
            // `{ updated_at: { $gt } }` instead would report a scan this code never runs.
            const sweep = withCursor(source.filter, source.watermarkField, {
                at: new Date(0),
                id: '',
            });

            const explained: any = await platformDb().collection(source.collection)
                .find(sweep)
                .sort({ [source.watermarkField]: 1, _id: 1 })
                .explain('queryPlanner');
            const plan = JSON.stringify(explained?.queryPlanner?.winningPlan ?? {});

            t.assert(`${source.id}: the sweep is served by an index (${plan.includes('COLLSCAN') ? 'COLLSCAN' : 'IXSCAN'})`, () =>
                !plan.includes('COLLSCAN'));
        }

        return t.finish();
    } finally {
        if (server) await new Promise<void>((resolve) => { server!.close(() => resolve()); });
        await cleanupAdmin().catch(() => undefined);
        await cleanupPlatform().catch(() => undefined);
        await NotificationPreferenceModel().deleteMany({}).catch(() => undefined);
        await closeAll().catch(() => undefined);
        await closeRedisClients().catch(() => undefined);
    }
}

main()
    .then((code) => process.exit(code))
    .catch((error) => {
        process.stderr.write(`\n${error instanceof Error ? error.stack : String(error)}\n\n`);
        process.exit(1);
    });
