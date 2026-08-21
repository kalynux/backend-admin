/**
 * Verify: files against REAL infrastructure — and against jovi-mall's real file collection.
 *
 * This closes **item 6 of Phase 5 § 6**, the one entry on that list of "six things only a live
 * run proves" that Phase 5 shipped without. `test:files` (35 assertions, DB-free) already drives
 * the controller against a *stubbed* platform client, so the wiring is genuinely asserted and
 * `tsc` rejects a key leak as a type error. What it cannot reach is the hop: nobody had watched
 * `GET /api/v1/files/orphans` return a real orphan row, or watched the permanent delete actually
 * remove a file.
 *
 * Four things only a real round trip proves, each of which fails silently otherwise:
 *
 *   1. **The projection is applied to jovi-mall's REAL payload** (D-10). `test:files` § 2 builds
 *      a row by hand and asserts `toOrphanFile` drops the key; that proves the function. This
 *      proves the *pipeline* — and it asserts the premise too, by reading jovi-mall's internal
 *      response directly and checking the key IS there before checking it is NOT here. An
 *      assertion that a field is absent is worthless if the field was never present upstream,
 *      and that is exactly how a projection test rots when the payload changes shape.
 *   2. **The delete round trip actually deletes** (D-9). A 200 from this service means nothing on
 *      its own; the row has to be gone from `jovi_mall.files`, which is another service's
 *      database. Conversely a REFUSED delete must leave the row alone — a confirmation guard
 *      that answers 400 *after* the hop would look identical from the client.
 *   3. **The tier split holds on the wire**, not just in the grant table: Support cannot
 *      enumerate, Admin can enumerate but cannot delete, Developer can do both.
 *   4. **The audit row is written for the delete**, with the file as its target — the only
 *      unrecoverable operation on this service's whole surface.
 *
 * ── What it needs ─────────────────────────────────────────────────────────────
 *   Mongo (both connections — it plants a fixture in `jovi_mall.files` directly)
 *   Redis (sessions)
 *   jovi-mall RUNNING, with a matching `INTERNAL_ADMIN_SERVICE_TOKEN` — this whole surface is
 *   delegated, so without it there is nothing to verify
 *
 * It SKIPS loudly rather than silently when jovi-mall is unreachable. A suite that passes by not
 * running is worse than one that fails.
 *
 * ── The tier-1 cost ───────────────────────────────────────────────────────────
 * `files.delete` is `destructive: true`, which makes it tier-1-only — so unlike every other live
 * suite except `verify:authz`, this one CANNOT avoid a Developer fixture, and `ADMIN_MFA_REQUIRED_TIER`
 * defaults to 1. It therefore walks the real TOTP enrolment (Phase 5 P-4). The alternative was
 * overriding the tier from the environment, which would test a configuration nobody deploys.
 *
 * Every fixture is keyed `verify-files-*` and deleted at the end, pass or fail.
 *
 * Run: npm run verify:files
 */
import 'dotenv/config';

process.env.ADMIN_AUTH_RATE_LIMIT_MAX = '500';

import type { Server } from 'http';
import { ObjectId } from 'mongodb';
import { authenticator } from 'otplib';
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
import { COLLECTIONS } from '../../src/infra/platform/collections';

const t = suite('files — live');

const PASSWORD = 'verify-files-suite-password-8823';

const EMAIL_DEV = 'verify-files-dev@example.test';
const EMAIL_ADMIN = 'verify-files-admin@example.test';
const EMAIL_SUPPORT = 'verify-files-support@example.test';

/**
 * The fixture's storage key, and the string this suite is really about.
 *
 * It is deliberately shaped like a real one — `vendors/<id>/<uuid>.png` — because the argument
 * for withholding it (D-10) is that it names the owner's tree inside the bucket. A key of
 * `"x"` would let the assertion pass while proving nothing about the thing being protected.
 */
const KEY_ORPHAN = 'vendors/6a11000000000000000000ff/verify-files-orphan-a1b2c3.png';
const KEY_KEPT = 'vendors/6a11000000000000000000ff/verify-files-kept-d4e5f6.png';

const ORPHAN_ID = new ObjectId('6a11000000000000000000f1');
const KEPT_ID = new ObjectId('6a11000000000000000000f2');

/** 30 days old, so it is comfortably past both the 24-hour floor and the 7-day default. */
const CREATED_AT = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
const OLDER_THAN = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

let port = 0;

interface Res { status: number; body: any; cookies: Record<string, string> }

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
    options: { body?: unknown; cookies?: Record<string, string>; bearer?: string; csrf?: string } = {},
): Promise<Res> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (options.cookies && Object.keys(options.cookies).length > 0) {
        headers.Cookie = Object.entries(options.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    }
    if (options.bearer) headers.Authorization = `Bearer ${options.bearer}`;
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

async function sessionFrom(res: Res): Promise<Session> {
    const me = await call('GET', '/api/v1/auth/me', { cookies: res.cookies });
    const adminId: string | undefined = me.body?.data?.admin?.id;
    if (!adminId) throw new Error(`no administrator id from /auth/me: ${JSON.stringify(me.body)}`);
    return { adminId, cookies: res.cookies, csrf: res.cookies.admin_csrf_token ?? '' };
}

/** Password-only sign-in. Works for tiers below `ADMIN_MFA_REQUIRED_TIER`. */
async function signIn(email: string): Promise<Session> {
    const res = await call('POST', '/api/v1/auth/login', { body: { email, password: PASSWORD } });
    if (res.status !== 200 || res.body?.data?.mfaEnrolmentRequired) {
        throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
    }
    return sessionFrom(res);
}

/**
 * The five-call Developer sign-in — enrol, activate, re-authenticate with a generated code.
 *
 * The real flow rather than a faked one, because the TOTP secret is encrypted at rest and there
 * is no way to plant a usable one from outside the service. `verify:auth` § 9 is what ASSERTS
 * this flow; here it is only the cost of reaching a tier-1 permission, so a failure throws.
 */
async function signInDeveloper(email: string): Promise<Session> {
    const scoped = await call('POST', '/api/v1/auth/login', { body: { email, password: PASSWORD } });
    if (scoped.status !== 200 || !scoped.body?.data?.mfaEnrolmentRequired) {
        throw new Error(`expected a scoped enrolment session for ${email}: ${JSON.stringify(scoped.body)}`);
    }
    const bearer: string = scoped.body.data.accessToken;

    const enrol = await call('POST', '/api/v1/auth/mfa/enroll', { bearer });
    const secret: string = enrol.body?.data?.secret;
    if (!secret) throw new Error(`enrolment gave no secret for ${email}`);

    const activated = await call('POST', '/api/v1/auth/mfa/activate', {
        bearer,
        body: { code: authenticator.generate(secret) },
    });
    if (activated.status !== 200) throw new Error(`activation failed: ${JSON.stringify(activated.body)}`);

    const challenge = await call('POST', '/api/v1/auth/login', { body: { email, password: PASSWORD } });
    const verified = await call('POST', '/api/v1/auth/mfa/verify', {
        body: { challengeId: challenge.body?.data?.challengeId, code: authenticator.generate(secret) },
    });
    if (verified.status !== 200) throw new Error(`TOTP login failed: ${JSON.stringify(verified.body)}`);

    return sessionFrom(verified);
}

const get = (s: Session, path: string) => call('GET', path, { cookies: s.cookies });
const write = (s: Session, method: string, path: string, body?: unknown) =>
    call(method, path, { cookies: s.cookies, csrf: s.csrf, body });

function platformDb() {
    const db = platformConnection().db;
    if (!db) throw new Error('platform connection has no db');
    return db;
}

/**
 * jovi-mall's internal file router, called the way wi-admin calls it — service token plus the
 * actor headers. Used ONCE, to prove the storage key is present upstream before asserting that
 * it is absent downstream.
 */
async function jovi(path: string): Promise<{ status: number; body: any }> {
    const base = process.env.JOVI_MALL_BASE_URL ?? '';
    const response = await fetch(`${base}/api/internal/admin${path}`, {
        headers: {
            'X-Service-Token': process.env.JOVI_MALL_SERVICE_TOKEN ?? '',
            'X-Actor-Id': '6a11000000000000000000aa',
            'X-Actor-Name': 'verify-files',
            Accept: 'application/json',
        },
    });
    const text = await response.text();
    let body: any;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: response.status, body };
}

/**
 * A `files` row, written on the raw driver.
 *
 * The Mongoose schema lives in jovi-mall and applies `timestamps` and the `BaseSchemaFields`
 * defaults; this connection has none of that, so `createdAt`, `updatedAt` and `deletedAt` are
 * set by hand — the same raw-driver discipline `verify:content` § 1 exists to police.
 *
 * `deletedAt: null` and no `file_references` row is what makes it an orphan:
 * `FileRepositoryMongo.findOrphans` takes the complement of the referenced set.
 */
function fileDoc(id: ObjectId, key: string, originalName: string) {
    return {
        _id: id,
        key,
        provider: 'local',
        mimeType: 'image/png',
        size: 20_480,
        originalName,
        ownerType: 'vendor',
        ownerId: new ObjectId('6a11000000000000000000ff'),
        orphanedAt: null,
        deletedAt: null,
        purgeAt: null,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
    };
}

async function cleanupPlatform(): Promise<void> {
    const db = platformDb();
    await db.collection(COLLECTIONS.FILE).deleteMany({ _id: { $in: [ORPHAN_ID, KEPT_ID] } });
    await db.collection('file_references').deleteMany({ fileId: { $in: [ORPHAN_ID, KEPT_ID] } });
}

async function cleanupAdmin(): Promise<void> {
    const admins = await AdminAccountModel().find(
        { email: { $in: [EMAIL_DEV, EMAIL_ADMIN, EMAIL_SUPPORT] } }, { _id: 1 },
    );
    const ids = admins.map((a) => a._id);
    if (ids.length > 0) {
        await AdminSessionModel().deleteMany({ admin_id: { $in: ids } });
        await AuditLogModel().deleteMany({ actor_id: { $in: ids } }).catch(() => undefined);
        await AdminAccountModel().deleteMany({ _id: { $in: ids } });
    }
    const redis = await getRedisClient(ADMIN_SESSION_DB);
    for (const id of ids) {
        const sids = await redis.sMembers(`admin-sessions:${id.toString()}`);
        for (const sid of sids) await redis.del(`session:${sid}`);
        await redis.del(`admin-sessions:${id.toString()}`);
    }
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

        await make(EMAIL_DEV, 'Verify Files Developer', 1);
        await make(EMAIL_ADMIN, 'Verify Files Admin', 2);
        await make(EMAIL_SUPPORT, 'Verify Files Support', 3);

        // The orphan, and a control file that is REFERENCED and must never appear.
        await platformDb().collection(COLLECTIONS.FILE)
            .insertMany([
                fileDoc(ORPHAN_ID, KEY_ORPHAN, 'verify-files-orphan.png'),
                fileDoc(KEPT_ID, KEY_KEPT, 'verify-files-kept.png'),
            ] as never[]);
        await platformDb().collection('file_references').insertOne({
            fileId: KEPT_ID,
            ownerType: 'product',
            ownerId: new ObjectId('6a11000000000000000000fe'),
            field: 'images',
            deletedAt: null,
            createdAt: CREATED_AT,
            updatedAt: CREATED_AT,
        } as never);

        const app = createApp();
        server = await new Promise<Server>((resolve) => {
            const s = app.listen(0, '127.0.0.1', () => resolve(s));
        });
        const address = server.address();
        port = typeof address === 'object' && address ? address.port : 0;

        const developer = await signInDeveloper(EMAIL_DEV);
        const admin = await signIn(EMAIL_ADMIN);
        const support = await signIn(EMAIL_SUPPORT);

        // ── Is the other half of the hop there at all? ────────────────────────
        const reachable = await jovi('/files/orphans').then((r) => r.status === 200).catch(() => false);
        if (!reachable) {
            console.error(
                '\n  ⛔ SKIPPED — jovi-mall is not reachable at '
                + `${process.env.JOVI_MALL_BASE_URL ?? '(JOVI_MALL_BASE_URL unset)'}, or the service `
                + 'token does not match.\n     This whole surface is DELEGATED, so there is nothing '
                + 'to verify without it. Start jovi-mall and re-run.\n',
            );
            return 1;
        }

        // ── 1. The projection, against jovi-mall's real payload ───────────────
        t.section('1. D-10 — the storage key is dropped on the way through');

        /**
         * The premise first. Asserting that `key` is absent from wi-admin's row proves nothing
         * unless jovi-mall actually sends one — otherwise the test passes for the wrong reason
         * the day the upstream payload changes shape, which is exactly how a projection
         * assertion rots into decoration.
         */
        const upstream = await jovi(`/files/orphans?olderThan=${OLDER_THAN.toISOString()}`);
        const upstreamRow = (upstream.body?.data ?? []).find(
            (f: { id?: string; _id?: string }) => (f.id ?? f._id) === ORPHAN_ID.toHexString(),
        );

        t.assert('jovi-mall lists the planted orphan', () => upstreamRow !== undefined);
        t.assert('...and jovi-mall DOES send the storage key — so there is something to drop', () =>
            upstreamRow?.key === KEY_ORPHAN);

        const listed = await get(admin, `/api/v1/files/orphans?olderThan=${OLDER_THAN.toISOString()}`);
        t.assert('wi-admin answers 200 for an Admin', () => listed.status === 200);

        // `sendSuccess(res, { files }, …)` — the rows are under `data.files`, not `data`.
        const rows: Array<Record<string, unknown>> = listed.body?.data?.files ?? [];
        const row = rows.find((f) => f.id === ORPHAN_ID.toHexString());

        t.assert('the orphan reaches the operator through the delegated hop', () => row !== undefined);
        t.assert('THE STORAGE KEY IS ABSENT — not null, absent', () =>
            row !== undefined && !('key' in row));
        t.assert('...and so are provider, checksum, ownerId and the soft-delete stamps', () =>
            row !== undefined
            && !('provider' in row) && !('checksum' in row) && !('ownerId' in row)
            && !('deletedAt' in row) && !('orphanedAt' in row));
        t.assert('the six fields an operator judges on all survived the hop', () =>
            row?.originalName === 'verify-files-orphan.png'
            && row?.mimeType === 'image/png'
            && row?.size === 20_480
            && row?.ownerType === 'vendor'
            && typeof row?.createdAt === 'string');

        /**
         * The control. A file with a live `file_references` row is not an orphan, and if it
         * appeared here the listing would be proposing a file in use for permanent deletion.
         */
        t.assert('a REFERENCED file is not offered for deletion', () =>
            rows.every((f) => f.id !== KEPT_ID.toHexString()));

        t.assert('the cutoff actually used comes back in meta', () =>
            typeof listed.body?.meta?.olderThan === 'string');

        // ── 2. The tier split, on the wire ────────────────────────────────────
        t.section('2. The tier split — enumerate is tiers 1-2, delete is tier 1 alone');

        const supportList = await get(support, '/api/v1/files/orphans');
        t.assert('Support cannot enumerate files', () => supportList.status === 403);
        t.assert('...and is refused on the permission, not on the route', () =>
            supportList.body?.error?.code === 'AUTHZ_PERMISSION_DENIED');
        t.assert('...and the message does not name the tier above them', () =>
            !/tier\s*[12]|developer|admin\b/i.test(String(supportList.body?.error?.message ?? '')));

        const adminDelete = await write(
            admin, 'DELETE', `/api/v1/files/${ORPHAN_ID.toHexString()}/permanent`,
            { confirmFileId: ORPHAN_ID.toHexString() },
        );
        t.assert('an Admin can SEE an orphan but cannot destroy it', () => adminDelete.status === 403);

        const afterAdminRefusal = await platformDb()
            .collection(COLLECTIONS.FILE).findOne({ _id: ORPHAN_ID });
        t.assert('...and the file is still there after the refusal', () =>
            afterAdminRefusal !== null);

        // ── 3. D-9's confirmation, and what a refusal must NOT do ─────────────
        t.section('3. D-9 — the delete requires the id repeated, and a refusal deletes nothing');

        const mismatched = await write(
            developer, 'DELETE', `/api/v1/files/${ORPHAN_ID.toHexString()}/permanent`,
            { confirmFileId: KEPT_ID.toHexString() },
        );
        t.assert('a mismatched confirmation is refused', () => mismatched.status === 400);
        t.assert('...with the code that names the remedy', () =>
            mismatched.body?.error?.code === 'FILE_DELETE_NOT_CONFIRMED');

        const missing = await write(
            developer, 'DELETE', `/api/v1/files/${ORPHAN_ID.toHexString()}/permanent`, {},
        );
        t.assert('a missing confirmation is refused, not treated as consent', () =>
            missing.status === 400);

        /**
         * ⚠ **The assertion this section exists for.** A confirmation guard that answers 400
         * *after* the hop is indistinguishable from one that answers before it, from the
         * client's side — and the difference is whether the file still exists. Neither refusal
         * above may have travelled.
         */
        const afterRefusals = await platformDb()
            .collection(COLLECTIONS.FILE).findOne({ _id: ORPHAN_ID });
        t.assert('NEITHER refusal reached jovi-mall — the file is untouched', () =>
            afterRefusals !== null);

        // ── 4. The round trip ─────────────────────────────────────────────────
        t.section('4. The delete actually deletes, in another service’s database');

        const deleted = await write(
            developer, 'DELETE', `/api/v1/files/${ORPHAN_ID.toHexString()}/permanent`,
            { confirmFileId: ORPHAN_ID.toHexString() },
        );
        t.assert('a Developer with a matching confirmation succeeds', () => deleted.status === 200);

        const gone = await platformDb().collection(COLLECTIONS.FILE).findOne({ _id: ORPHAN_ID });
        const kept = await platformDb().collection(COLLECTIONS.FILE).findOne({ _id: KEPT_ID });

        t.assert('THE ROW IS GONE FROM jovi_mall.files — hard, not soft', () => gone === null);
        t.assert('the referenced control file was NOT collateral', () => kept !== null);

        const afterList = await get(admin, `/api/v1/files/orphans?olderThan=${OLDER_THAN.toISOString()}`);
        t.assert('...and it no longer appears in the listing', () =>
            (afterList.body?.data?.files ?? []).every(
                (f: { id?: string }) => f.id !== ORPHAN_ID.toHexString(),
            ));

        // ── 5. The audit row ──────────────────────────────────────────────────
        t.section('5. The only unrecoverable operation on this service is audited');

        /**
         * ⚠ The field is `actor_id` (an ObjectId) and the verdict is `status`, whose values are
         * `attempted | succeeded | failed | denied | queued` — **not** `actor_admin_id` /
         * `outcome: 'success'`, which is what this section was first written against and which
         * matched nothing while looking like a real query. Worth the note: a `findOne` on a
         * misspelt field is indistinguishable from a missing row.
         */
        const actorId = new ObjectId(developer.adminId);

        const entry = await AuditLogModel()
            .findOne({ action: 'files.delete', actor_id: actorId })
            .lean() as { status?: string; target_id?: string; target_type?: string } | null;

        t.assert('a files.delete audit row exists', () => entry !== null);
        t.assert('...it SUCCEEDED, so intent and outcome both landed', () =>
            entry?.status === 'succeeded');
        t.assert('...and it names the FILE, so an operator can search for the id', () =>
            entry?.target_id === ORPHAN_ID.toHexString() && entry?.target_type === 'file');

        /**
         * The refusals must NOT be audited as successes. The confirmation is compared in the
         * controller, before the gateway is reached, so a mismatch should leave no row at all —
         * and certainly not a `succeeded` one. Three here would mean the guard ran after the
         * audit rather than before it.
         */
        const succeededRows = await AuditLogModel().countDocuments({
            action: 'files.delete',
            actor_id: actorId,
            status: 'succeeded',
        });
        t.assert('exactly ONE succeeded row — the two refusals left none', () => succeededRows === 1);

        return t.finish();
    } finally {
        try { await cleanupPlatform(); } catch { /* best effort */ }
        try { await cleanupAdmin(); } catch { /* best effort */ }
        if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
        await closeRedisClients();
        await closeAll();
    }
}

main()
    .then((code) => process.exit(code))
    .catch((err) => {
        console.error('FATAL', err);
        process.exit(1);
    });
