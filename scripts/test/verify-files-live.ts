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
 * ── BR-015 added two more, and § 6 is the one this suite now exists for most ──
 *
 *   5. **The URL this service builds IS the one jovi-mall returns** (§ 6). Decision L-3
 *      reversed ADR-009 D-6 and put URL construction here, so `STORAGE_PROVIDER` and
 *      `STORAGE_LOCAL_URL` now live in TWO deployments and **nothing compares them** — the
 *      property every cross-service secret on this platform has. A mismatch fails no boot,
 *      logs nothing, and produces URLs that 404 on a screen full of thumbnails.
 *
 *      ⚠ `test:files` § 8 diffs the two `storage-trees.ts` files offline and is a different
 *      check answering a different question: it proves the two SOURCES agree, and this
 *      proves the two ANSWERS do. **Neither implies the other** — a correct tree map with a
 *      wrong `STORAGE_LOCAL_URL` passes the first and fails this.
 *
 *   6. **The media library actually runs** (§ 7). It is the one read on this mount that is
 *      NOT delegated: a direct read of `jovi_mall.files` joined to `file_references`, with
 *      owner names resolved across five role collections plus this service's own
 *      `admin_accounts`. Mongo validates an aggregation pipeline at EXECUTION time, so no
 *      offline suite can prove the usage `$group` is even legal — only a real one can.
 *
 * ⚠ **`POST /files/upload` is NOT covered here.** It takes a `multipart/form-data` body and
 * `call()` sends JSON; exercising it needs a multipart client and bytes jovi-mall's sniffing
 * pipeline will accept. Everything this service owns about it is asserted offline
 * (`test:files` §§ 4, 6, 9); the round trip is not asserted anywhere, and the first real
 * upload is the first proof the proxy streams correctly. Stated so the gap is known.
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
import { toFileDetail } from '../../src/infra/storage/file-detail';
import { publicUrlsAreConfigured } from '../../src/infra/storage/public-url';

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

/**
 * Two more fixtures, for the L-3 parity check and the media library (BR-015).
 *
 * ⚠ **Their TREES are the whole point, and the two existing fixtures cannot serve.** Both
 * of those live under `vendors/`, which is not in `STORAGE_TREE_VISIBILITY` at all — so
 * both resolve PRIVATE by the fail-closed rule and both sides answer `url: null`. A parity
 * assertion between two nulls passes while proving nothing about URL construction, which is
 * the one thing decision L-3 put in this service.
 *
 * `images/` is a real public tree and the one an administrator's own upload lands in;
 * `shipments/` is a real private one. Between them they exercise both branches of
 * `toFileDetail` against jovi-mall's answer for the same row.
 */
const KEY_PUBLIC = 'images/2026/08/verify-files-public-a1b2c3.png';
const KEY_PRIVATE = 'shipments/2026/08/verify-files-private-d4e5f6.jpg';

const PUBLIC_ID = new ObjectId('6a11000000000000000000f3');
const PRIVATE_ID = new ObjectId('6a11000000000000000000f4');

/** Every fixture this suite plants in `jovi_mall.files`, for one cleanup list. */
const FIXTURE_FILE_IDS = [ORPHAN_ID, KEPT_ID, PUBLIC_ID, PRIVATE_ID];

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
 * jovi-mall's `POST /files/resolve` — the OTHER producer of a `FileDetail` (BR-015 · L-3).
 *
 * ⚠ **This is the whole of the live half of the L-3 containment, and it proves something
 * the offline drift check structurally cannot.** `test:files` § 8 diffs the two source
 * files and proves they AGREE; that says nothing about whether this service's construction
 * actually MATCHES, because agreement on the classification table does not imply agreement
 * on the URL built from it — a wrong `STORAGE_LOCAL_URL`, a provider set to something else,
 * or a divergence in how the key is joined would all pass that diff. Neither check implies
 * the other, and this is the only one that compares OUTPUT.
 */
async function joviResolve(fileIds: string[]): Promise<{ status: number; body: any }> {
    const base = process.env.JOVI_MALL_BASE_URL ?? '';
    const response = await fetch(`${base}/api/internal/admin/files/resolve`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Service-Token': process.env.JOVI_MALL_SERVICE_TOKEN ?? '',
            'X-Actor-Id': '6a11000000000000000000aa',
            'X-Actor-Name': 'verify-files',
            Accept: 'application/json',
        },
        body: JSON.stringify({ fileIds }),
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
function fileDoc(id: ObjectId, key: string, originalName: string, orphanedAt: Date | null = null) {
    return {
        _id: id,
        key,
        provider: 'local',
        mimeType: 'image/png',
        size: 20_480,
        originalName,
        ownerType: 'vendor',
        ownerId: new ObjectId('6a11000000000000000000ff'),
        /**
         * ⚠ **Set by hand, and it must agree with the `file_references` rows planted beside
         * it** (BR-015). jovi-mall's reference layer maintains this field — non-null means
         * "the live reference count is 0" — and this connection applies none of that logic.
         * The media library's `usage=used|unused` filter reads exactly this column, so a
         * fixture whose stamp contradicts its own reference rows would make that filter look
         * broken when it is the data that is wrong.
         */
        orphanedAt,
        deletedAt: null,
        purgeAt: null,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
    };
}

async function cleanupPlatform(): Promise<void> {
    const db = platformDb();
    await db.collection(COLLECTIONS.FILE).deleteMany({ _id: { $in: FIXTURE_FILE_IDS } });
    await db.collection('file_references').deleteMany({ fileId: { $in: FIXTURE_FILE_IDS } });
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

        // The orphan, a control file that is REFERENCED and must never appear, and the two
        // tree fixtures the L-3 parity check and the media library need (BR-015).
        await platformDb().collection(COLLECTIONS.FILE)
            .insertMany([
                fileDoc(ORPHAN_ID, KEY_ORPHAN, 'verify-files-orphan.png'),
                fileDoc(KEPT_ID, KEY_KEPT, 'verify-files-kept.png'),
                fileDoc(PUBLIC_ID, KEY_PUBLIC, 'verify-files-public.png'),
                // No reference rows below, so it is genuinely an orphan and the `usage=unused`
                // filter has something true to find.
                fileDoc(PRIVATE_ID, KEY_PRIVATE, 'verify-files-private.jpg', CREATED_AT),
            ] as never[]);
        /**
         * ⚠ **The field names here were WRONG until BR-015, and the error was invisible.**
         * This row carried `ownerType`/`ownerId` where `IFileReference` declares
         * `entityType`/`entityId`. The orphan query it was written for matches on `fileId`
         * alone, so it kept `KEPT_ID` out of the listing exactly as intended and nothing
         * failed — while the row described no entity at all. The media library's usage join
         * projects `entityType`, `entityId` and `field`, so it is the first reader that
         * would have noticed, by reporting `undefined` in every reference cell.
         *
         * (`ownerType`/`ownerId` DO exist on that model, denormalised from the file's
         * uploader for per-owner aggregates — which is exactly why the mistake reads as
         * plausible. They are not the entity.)
         */
        await platformDb().collection('file_references').insertOne({
            fileId: KEPT_ID,
            entityType: 'product',
            entityId: new ObjectId('6a11000000000000000000fe'),
            field: 'images',
            deletedAt: null,
            createdAt: CREATED_AT,
            updatedAt: CREATED_AT,
        } as never);
        // The public fixture is referenced twice, by two different entities, so the media
        // library has a row whose `referenceCount` is more than one and whose `usage` join
        // has to group rather than merely find.
        await platformDb().collection('file_references').insertMany([
            {
                fileId: PUBLIC_ID,
                entityType: 'ticket',
                entityId: new ObjectId('6a11000000000000000000fc'),
                field: 'attachments',
                deletedAt: null,
                createdAt: CREATED_AT,
                updatedAt: CREATED_AT,
            },
            {
                fileId: PUBLIC_ID,
                entityType: 'product',
                entityId: new ObjectId('6a11000000000000000000fd'),
                field: 'media',
                deletedAt: null,
                createdAt: CREATED_AT,
                updatedAt: CREATED_AT,
            },
        ] as never[]);

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


        // ─────────────────────────────────────────────────────────────────────
        t.section('6. L-3 parity — the URL this service builds IS jovi-mall\'s');

        /**
         * ⚠ **The only check that proves the two deployments actually agree**, and the
         * reason decision L-3 was allowed at all.
         *
         * L-3 reversed ADR-009 D-6 and put URL construction in this service, which means
         * `STORAGE_PROVIDER` and `STORAGE_LOCAL_URL` now exist in TWO deployments. Nothing
         * anywhere compares one side's value against the other's — the property every
         * cross-service secret on this platform has — so a mismatch is **silent**: it fails
         * no boot, logs nothing, and produces URLs that 404 on a screen full of thumbnails,
         * which reads as "the files are gone" rather than as a configuration fault.
         *
         * `test:files` § 8 covers the other half offline by diffing the tree map against
         * jovi-mall's source. **Neither implies the other.** That check proves the two
         * FILES agree; this one proves the two ANSWERS do, which is what a client sees.
         */
        const localDetail = (id: ObjectId, key: string) => toFileDetail({
            id: id.toHexString(),
            key,
            mimeType: 'image/png',
            size: 20_480,
            originalName: 'verify-files.png',
        });

        /**
         * Asserted rather than skipped past. A wi-admin with no reproducible
         * `STORAGE_PROVIDER` answers `url: null` for every file — which is the correct
         * INERT behaviour and a broken media library, and it would make every comparison
         * below fail for a reason that has nothing to do with drift. Failing here names the
         * two variables instead.
         */
        t.assert('this deployment can build URLs at all — STORAGE_PROVIDER is set here', () =>
            publicUrlsAreConfigured());

        const resolved = await joviResolve([PUBLIC_ID.toHexString(), PRIVATE_ID.toHexString()]);

        t.assert('jovi-mall resolved both fixtures', () =>
            resolved.status === 200 && Array.isArray(resolved.body?.data?.files)
            && resolved.body.data.files.length === 2);

        const theirs = new Map<string, { url: string | null; access: string }>(
            (resolved.body?.data?.files ?? []).map(
                (f: { id: string; url: string | null; access: string }) => [f.id, { url: f.url, access: f.access }],
            ),
        );

        const theirPublic = theirs.get(PUBLIC_ID.toHexString());
        const theirPrivate = theirs.get(PRIVATE_ID.toHexString());
        const ourPublic = localDetail(PUBLIC_ID, KEY_PUBLIC);
        const ourPrivate = localDetail(PRIVATE_ID, KEY_PRIVATE);

        /**
         * ⚠ **The premise, asserted before the comparison.** If jovi-mall answered `null` for
         * the public fixture too, every assertion below would pass by comparing two nulls
         * and prove nothing — the same trap § 1 avoids by checking the storage key IS
         * present upstream before checking it is absent here.
         */
        t.assert('jovi-mall really does return a URL for the public tree', () =>
            typeof theirPublic?.url === 'string' && theirPublic.url.length > 0);

        t.assert('the PUBLIC url is byte-identical to jovi-mall\'s', () =>
            ourPublic.url === theirPublic?.url);

        t.assert('...and so is `access`', () =>
            ourPublic.access === theirPublic?.access && ourPublic.access === 'public');

        /**
         * The private branch. Both sides must answer `null` — and this assertion is weaker
         * than it looks on its own, which is why it sits after the one above: two services
         * that both fail to build any URL would also pass it.
         */
        t.assert('the PRIVATE file resolves to url null on BOTH sides', () =>
            ourPrivate.url === null && theirPrivate?.url === null);

        t.assert('...and to `authorized` on both', () =>
            ourPrivate.access === 'authorized' && theirPrivate?.access === 'authorized');

        // ─────────────────────────────────────────────────────────────────────
        t.section('7. The media library over the wire (BR-015)');

        /**
         * The library is the one read on this mount that is NOT delegated (L-1): it reads
         * `jovi_mall.files` and `file_references` directly and resolves owner names across
         * five role collections plus this service's OWN `admin_accounts`. Three things only
         * a live run proves — that the aggregation actually RUNS (Mongo validates a pipeline
         * at execution time, not at compile time), that the usage join groups rather than
         * duplicating rows, and that the tier split holds on the wire rather than only in
         * the grant table.
         *
         * ⚠ Every result is awaited BEFORE its assertion. `t.assert` takes a synchronous
         * `() => boolean` and the harness refuses a Promise outright, because a Promise is
         * truthy and an `async` assertion would pass unconditionally forever.
         */
        const libraryAsAdmin = await get(admin, '/api/v1/files/library?search=verify-files&limit=100');
        const libraryAsSupport = await get(support, '/api/v1/files/library');

        t.assert('an Admin may browse the library', () => libraryAsAdmin.status === 200);

        t.assert('...and Support may NOT — the same line /orphans draws', () =>
            libraryAsSupport.status === 403);

        const libraryRows: any[] = Array.isArray(libraryAsAdmin.body?.data)
            ? libraryAsAdmin.body.data
            : [];

        const publicRow = libraryRows.find((r) => r.id === PUBLIC_ID.toHexString());

        t.assert('the planted public fixture is in the page', () => publicRow !== undefined);

        /**
         * ⚠ The usage join, against real rows. Two references on one file must produce ONE
         * row with a count of two — not two rows, which is what a `$lookup` + `$unwind`
         * would produce and what a naive fix for a missing count would introduce.
         */
        t.assert('usage groups: two references, one row, count 2', () =>
            libraryRows.filter((r) => r.id === PUBLIC_ID.toHexString()).length === 1
            && publicRow?.usage?.referenceCount === 2
            && publicRow?.usage?.references?.length === 2);

        t.assert('a reference names its entity and its field', () => {
            const ticket = publicRow?.usage?.references?.find(
                (r: { entityType: string }) => r.entityType === 'ticket',
            );
            return ticket?.field === 'attachments'
                && ticket?.entityId === '6a11000000000000000000fc'
                && ticket?.label === null;
        });

        /**
         * The owner name, resolved across a collection boundary. The fixture is owned by a
         * `vendors._id` that exists in no `stores` row, so the honest answer is `null` —
         * **never `''` and never the id** (ADR-005). That the type and id still travel is
         * what lets a screen render "vendor · 6a11…ff" rather than an empty cell.
         */
        t.assert('an unresolvable owner reports type and id, and a null name', () =>
            publicRow?.owner?.type === 'vendor'
            && publicRow?.owner?.id === '6a11000000000000000000ff'
            && publicRow?.owner?.name === null);

        t.assert('the row carries the L-3 url and access, matching § 6', () =>
            publicRow?.access === 'public' && publicRow?.url === ourPublic.url);

        /**
         * `meta` declares the reference cap and whether URLs can be built here at all —
         * both asked for by BR-015 so a client is not left inferring them from the rows.
         */
        t.assert('meta declares the reference cap and the URL configuration', () =>
            typeof libraryAsAdmin.body?.meta?.referenceSampleCap === 'number'
            && libraryAsAdmin.body.meta.referenceSampleCap > 0
            && libraryAsAdmin.body.meta.publicUrlsConfigured === true
            && typeof libraryAsAdmin.body.meta.total === 'number');

        /**
         * The `usage` filter against real `orphanedAt` stamps. The private fixture has no
         * reference rows and a non-null stamp; the public one has two and a null stamp.
         */
        const unusedPage = await get(
            admin, '/api/v1/files/library?search=verify-files&usage=unused&limit=100',
        );
        const unusedIds: string[] = (unusedPage.body?.data ?? []).map((r: { id: string }) => r.id);

        t.assert('`usage=unused` finds the orphan fixture and not the referenced one', () =>
            unusedPage.status === 200
            && unusedIds.includes(PRIVATE_ID.toHexString())
            && !unusedIds.includes(PUBLIC_ID.toHexString()));

        /**
         * The entity filter, backed by the `{ entityType, entityId, deletedAt }` index. A
         * pair naming an entity nothing references must answer an EMPTY page rather than the
         * whole library — the `[]`-versus-`null` distinction the offline suite pins on the
         * filter builder, proved here end to end.
         */
        const entityHit = await get(admin, '/api/v1/files/library?entityType=ticket&entityId=6a11000000000000000000fc');
        const entityMiss = await get(admin, '/api/v1/files/library?entityType=ticket&entityId=6a11000000000000000000ab');
        const entityHitIds: string[] = (entityHit.body?.data ?? []).map((r: { id: string }) => r.id);

        t.assert('`entityType`/`entityId` narrows to that entity', () =>
            entityHit.status === 200 && entityHitIds.includes(PUBLIC_ID.toHexString()));

        t.assert('...and an entity nothing references answers an EMPTY page', () =>
            entityMiss.status === 200 && (entityMiss.body?.data ?? []).length === 0);

        /**
         * ⚠ **The upload is deliberately NOT verified here, and that is a gap worth stating
         * rather than hiding.** `POST /api/v1/files/upload` takes a `multipart/form-data`
         * body and this suite's `call()` helper sends JSON; exercising it needs a multipart
         * client and a real byte payload that jovi-mall's sniffing pipeline will accept as
         * an image. What IS covered offline is every part of it this service owns — the
         * content-type gate, the byte ceiling, the audit spec and the declared limits
         * (`test:files` §§ 4, 6, 9). What nothing on this side covers is the round trip, so
         * the first real upload is the first proof that the proxy streams correctly.
         */
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
