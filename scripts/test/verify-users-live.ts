/**
 * Verify: user management, end to end, against REAL infrastructure and a REAL jovi-mall.
 *
 * `test:users` proves the rules are internally consistent — the schemas, the filter, the
 * catalog wiring. It structurally cannot prove the three things that only exist when both
 * processes are running and a database is underneath:
 *
 *   Gate A  a suspension ISSUED HERE takes effect THERE — the account is refused by
 *           jovi-mall's auth path on the very next request, not at its next login
 *   Gate B  every delegated write leaves an audit row carrying a real before → after diff
 *   Gate C  the activity feed reads those rows back for that user, and only for that user
 *
 * Gate A is the one the phase exists for. `users.status` used to be written by nothing and
 * read by nothing, so an endpoint that flipped it looked identical — 200, column changed,
 * suspended person still working. The assertion below is the difference.
 *
 * ── What it needs ─────────────────────────────────────────────────────────────
 *   Mongo (wi-admin as a replica set, for the audit transactions) + Redis
 *   jovi-mall RUNNING, with INTERNAL_ADMIN_SERVICE_TOKEN set
 *   this service's JOVI_MALL_BASE_URL + JOVI_MALL_SERVICE_TOKEN set to match
 *
 * It SKIPS loudly rather than silently when jovi-mall is unreachable — a suite that passes
 * by not running is worse than one that fails.
 *
 * It creates its own throwaway platform user and its own administrators, and deletes both
 * at the end, pass or fail. It never touches a pre-existing row.
 *
 * Run: npm run verify:users
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
import { AdminTier } from '../../src/modules/admin-identity/domain/admin-identity.types';
import { hash } from '../../src/modules/admin-identity/domain/password.service';
import { AuditLogModel } from '../../src/modules/audit/models/audit-log.model';
import { pingPlatform } from '../../src/infra/platform/platform.client';
import { COLLECTIONS } from '../../src/infra/platform/collections';

const t = suite('wi-admin user management — live');

const PASSWORD = 'verify-users-suite-password-7712';
/** The jovi-mall fixture user's password. Separate from the ADMIN password above: they authenticate against different services. */
const PLATFORM_PASSWORD = 'verify-users-platform-password-4419';
const EMAIL_ADMIN = 'verify-users-admin@example.test';
const EMAIL_SUPPORT = 'verify-users-support@example.test';

/** Everything this suite creates in `jovi_mall`, tagged so cleanup cannot miss one. */
const FIXTURE_TAG = 'verify-users-fixture';

interface Res { status: number; body: any; cookies: Record<string, string> }

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
): Promise<Res> {
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

async function cleanupPlatform(): Promise<void> {
    await platformDb().collection(COLLECTIONS.USER).deleteMany({ [FIXTURE_TAG]: true });
}

async function cleanupAdmin(): Promise<void> {
    const admins = await AdminAccountModel().find(
        { email: { $in: [EMAIL_ADMIN, EMAIL_SUPPORT] } }, { _id: 1 },
    );
    const ids = admins.map((a) => a._id);
    if (ids.length > 0) {
        await AdminSessionModel().deleteMany({ admin_id: { $in: ids } });
        await AdminAccountModel().deleteMany({ _id: { $in: ids } });
        await AuditLogModel().deleteMany({ actor_id: { $in: ids } });
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

        const reachable = await pingPlatform();
        if (!reachable.configured || !reachable.ok) {
            console.error(
                '\n  ⚠  SKIPPED — jovi-mall is not reachable.\n'
                + '     Every write here is delegated, so there is nothing to verify without it.\n'
                + `     JOVI_MALL_BASE_URL=${env().JOVI_MALL_BASE_URL ?? '(unset)'}\n`,
            );
            t.assert('SKIPPED — jovi-mall unreachable', () => false);
            return t.finish();
        }

        const accounts = new AdminAccountRepository();
        const passwordHash = await hash(PASSWORD);

        // `create` takes a REQUIRED ClientSession as of Phase 3.5 — the type is what makes
        // an unaudited administrator mutation fail to compile. These are fixtures.
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

        await make(EMAIL_ADMIN, 'Verify Users Admin', 2);
        await make(EMAIL_SUPPORT, 'Verify Users Support', 3);

        const app = createApp();
        server = await new Promise<Server>((resolve) => {
            const s = app.listen(0, '127.0.0.1', () => resolve(s));
        });
        const address = server.address();
        port = typeof address === 'object' && address ? address.port : 0;

        const admin = await signIn(EMAIL_ADMIN);
        const support = await signIn(EMAIL_SUPPORT);

        const db = platformDb();
        const stamp = Date.now();
        const emailA = `verify-users-${stamp}@example.test`;
        const emailB = `verify-users-${stamp}-b@example.test`;
        const userId = new ObjectId();

        // ⚠ A REAL bcrypt hash, not the sentinel string this used to carry.
        //
        // The sentinel read `THIS-MUST-NEVER-LEAVE-THE-DATABASE`, which made the leak
        // assertions vivid and made the suspension assertion below IMPOSSIBLE to pass:
        // `bcrypt.compare` against a non-hash is always false, so a login attempt could
        // never get past jovi-mall's credential check to reach the status gate. That did
        // not show up while the credential check was commented out — which is exactly the
        // state this suite was written in, as its own comment below recorded.
        //
        // A bcrypt hash is just as checkable a needle as the sentinel was, and it is the
        // real credential rather than a stand-in for one.
        const platformPasswordHash = await hash(PLATFORM_PASSWORD);

        await db.collection(COLLECTIONS.USER).insertOne({
            _id: userId,
            login_email: emailA,
            login_phone: `+23767${String(stamp).slice(-7)}`,
            password_hash: platformPasswordHash,
            roles: ['customer'],
            status: 'active',
            created_at: new Date(),
            updated_at: new Date(),
            [FIXTURE_TAG]: true,
        } as never);
        const id = userId.toString();

        // ── 1. The list ───────────────────────────────────────────────────────
        t.section('1. List, search, filter, sort');

        const byEmail = await get(admin, `/api/v1/users?search=verify-users-${stamp}`);
        t.assert('a search by email finds the user', () =>
            byEmail.status === 200 && byEmail.body.data.some((u: any) => u.id === id));

        const byId = await get(admin, `/api/v1/users?search=${id}`);
        t.assert('a pasted user id finds them too — the branch a directory needs', () =>
            byId.status === 200 && byId.body.data.some((u: any) => u.id === id));

        const filtered = await get(admin, `/api/v1/users?search=verify-users-${stamp}&role=vendor`);
        t.assert('a role filter that does not match excludes them', () =>
            filtered.body.data.every((u: any) => u.id !== id));

        const paged = await get(admin, '/api/v1/users?limit=2&page=1');
        t.assert('the page carries a real total and a computed page count', () =>
            paged.body.data.length <= 2
            && typeof paged.body.meta.total === 'number'
            && paged.body.meta.pages === Math.ceil(paged.body.meta.total / 2));

        t.assert('the credential never appears in a list response', () =>
            !JSON.stringify(byEmail.body).includes(platformPasswordHash));

        const badSort = await get(admin, '/api/v1/users?sort=password_hash');
        t.assert('an unsortable field is refused, never silently ignored', () =>
            badSort.status === 400 && badSort.body?.error?.code === 'VALIDATION_ERROR');

        const badRange = await get(admin,
            '/api/v1/users?from=2026-08-11T00:00:00.000Z&to=2026-08-01T00:00:00.000Z');
        t.assert('an inverted date range is refused', () => badRange.status === 400);

        // ── 2. Gate A — a suspension takes effect in jovi-mall ────────────────
        t.section('2. Gate A — the suspension is enforced, not merely recorded');

        const platformBase = env().JOVI_MALL_BASE_URL as string;

        const suspended = await write(admin, 'POST', `/api/v1/users/${id}/suspend`,
            { reason: 'verification run' });
        t.assert('suspending through admin succeeds', () => suspended.status === 200);
        t.assert('...and reports the reason back', () =>
            suspended.body?.data?.status === 'suspended'
            && suspended.body?.data?.suspendedReason === 'verification run');

        const stored = await db.collection(COLLECTIONS.USER).findOne({ _id: userId });
        t.assert('the column moved in jovi_mall', () => stored?.status === 'suspended');
        t.assert('...stamped with the ADMINISTRATOR, marked as an admin id, with a name snapshot', () =>
            stored?.suspended_by_user_id?.toString() === admin.adminId
            && stored?.suspended_by_source === 'admin'
            && stored?.suspended_by_name === 'Verify Users Admin');

        /**
         * THE assertion this phase exists for.
         *
         * A login attempt against the suspended account must be refused by jovi-mall with
         * `AUTH_ACCOUNT_SUSPENDED`. Before this phase the column was read by nothing, so
         * this request would have failed on the password instead — or, given the then
         * commented-out password check, succeeded outright.
         *
         * ⚠ IT MUST USE THE CORRECT PASSWORD, and that is not a detail. jovi-mall checks
         * credentials FIRST and status second (`auth.service.ts` — compare at :331, the
         * suspension throw at :344). That ordering is deliberate and correct: answering
         * `AUTH_ACCOUNT_SUSPENDED` to someone who has not proved they own the account
         * tells an enumerator that the address exists AND that it is suspended.
         *
         * So a wrong password can only ever produce 401, and this assertion sent
         * `password: 'anything'`. It passed review because the credential check was
         * commented out when it was written; restoring that check in Phase 5 Part E made
         * it fail — correctly. The suite was wrong, not the service.
         */
        const loginAttempt = await fetch(`${platformBase}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ identifier: emailA, password: PLATFORM_PASSWORD, role: 'customer' }),
        });
        const loginBody = await loginAttempt.json().catch(() => ({}));
        t.assert('jovi-mall REFUSES a login to the suspended account', () =>
            loginAttempt.status === 403);
        t.assert('...with the dedicated code, so the person can be told why', () =>
            (loginBody as any)?.error?.code === 'AUTH_ACCOUNT_SUSPENDED');

        // The other half of that ordering, pinned so nobody "fixes" the service to check
        // status first and turns this endpoint into an account-enumeration oracle.
        const wrongPassword = await fetch(`${platformBase}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ identifier: emailA, password: 'not-the-password', role: 'customer' }),
        });
        const wrongBody = await wrongPassword.json().catch(() => ({}));
        t.assert('a WRONG password on the same suspended account is 401, never 403', () =>
            wrongPassword.status === 401);
        t.assert('...and says only INVALID_CREDENTIALS — suspension is not disclosed to a stranger', () =>
            (wrongBody as any)?.error?.code === 'AUTH_INVALID_CREDENTIALS');

        const reSuspend = await write(admin, 'POST', `/api/v1/users/${id}/suspend`, { reason: 'again' });
        t.assert('a second suspension is refused — the compare-and-set missed', () =>
            reSuspend.status === 409);
        t.assert('...carrying jovi-mall\'s own code rather than a remapped one', () =>
            reSuspend.body?.error?.details?.platformCode === 'USER_STATUS_CONFLICT');

        // ── 3. Gate B — every write leaves a diffable audit row ───────────────
        t.section('3. Gate B — the audit row, with a real before → after');

        /**
         * TWO rows exist by now, and asking for "the latest" would get the wrong one — the
         * refused second attempt is newer than the successful first. That is not a nuisance
         * to sort around: **a refused delegated write is audited too**, which is the property
         * `auditedAttempt` exists for and the one a dangling `attempted` row would betray.
         * So both are fetched by outcome and both are asserted.
         */
        const suspendRow = await AuditLogModel()
            .findOne({ action: 'users.suspend', target_id: id, status: 'succeeded' });
        const refusedRow = await AuditLogModel()
            .findOne({ action: 'users.suspend', target_id: id, status: 'failed' });

        t.assert('the suspension is in the trail', () => suspendRow !== null);
        t.assert('...resolved to `succeeded`, not left dangling at `attempted`', () =>
            suspendRow?.status === 'succeeded' && suspendRow?.completed_at !== null);
        t.assert('...marked delegated, and classified as a platform actor', () =>
            suspendRow?.delegated === true && suspendRow?.subject_class === 'platform_actor');
        t.assert('...naming the acting administrator and their level at the time', () =>
            suspendRow?.actor_id?.toString() === admin.adminId && suspendRow?.actor_tier === 2);
        t.assert('...with the reason in the payload', () =>
            (suspendRow?.payload as any)?.reason === 'verification run');
        t.assert('...and a BEFORE → AFTER that shows the account actually moved', () =>
            (suspendRow?.before as any)?.status === 'active'
            && (suspendRow?.after as any)?.status === 'suspended');
        t.assert('...labelled with the identifier, so the row reads without a join', () =>
            suspendRow?.target_label === emailA);
        t.assert('...and carries the request\'s correlation id', () =>
            typeof suspendRow?.correlation_id === 'string' && suspendRow.correlation_id.length > 0);

        // The refused attempt. An action that jovi-mall rejected must leave a resolved row,
        // not a dangling `attempted` one — that distinction is the whole intent→outcome design.
        t.assert('the REFUSED second attempt is audited too, and resolved', () =>
            refusedRow !== null && refusedRow.completed_at !== null);
        t.assert('...recording jovi-mall\'s verdict rather than a local guess', () =>
            refusedRow?.outcome_status === 409 && refusedRow?.platform_code === 'USER_STATUS_CONFLICT');
        t.assert('...and it changed nothing, so it carries no after-state', () =>
            (refusedRow?.after ?? null) === null);

        // ── 4. The contact edit ───────────────────────────────────────────────
        t.section('4. Editing the login identifiers');

        const edited = await write(admin, 'PATCH', `/api/v1/users/${id}`, { email: emailB });
        t.assert('a valid edit succeeds', () => edited.status === 200 && edited.body?.data?.email === emailB);

        const editRow = await AuditLogModel().findOne({ action: 'users.update', target_id: id });
        t.assert('the PREVIOUS address is in the audit row — the only place it survives', () =>
            (editRow?.before as any)?.email === emailA && (editRow?.after as any)?.email === emailB);

        const malformed = await write(admin, 'PATCH', `/api/v1/users/${id}`, { email: 'not-an-email' });
        t.assert('a malformed address is refused at jovi-mall\'s status, not as a 502', () =>
            malformed.status === 400);

        const clearBoth = await write(admin, 'PATCH', `/api/v1/users/${id}`, { email: null, phone: null });
        t.assert('clearing both identifiers is refused — the account would be unreachable', () =>
            clearBoth.status === 422
            && clearBoth.body?.error?.details?.platformCode === 'USER_CONTACT_REQUIRED');

        const forbiddenField = await write(admin, 'PATCH', `/api/v1/users/${id}`, { roles: ['admin'] });
        t.assert('a body naming another permission\'s field is refused HERE, before the wire', () =>
            forbiddenField.status === 400 && forbiddenField.body?.error?.code === 'VALIDATION_ERROR');

        // ── 5. Gate C — the activity feed ─────────────────────────────────────
        t.section('5. Gate C — the activity feed reads the trail back');

        const activity = await get(admin, `/api/v1/users/${id}/activity`);
        t.assert('the feed reads', () => activity.status === 200);
        t.assert('...holding the suspension and the edit', () => {
            const actions = activity.body.data.map((row: any) => row.action);
            return actions.includes('users.suspend') && actions.includes('users.update');
        });
        t.assert('...every row about THIS user and nobody else', () =>
            activity.body.data.every((row: any) => row.target.id === id && row.target.type === 'user'));
        t.assert('...newest first', () => {
            const times = activity.body.data.map((row: any) => Date.parse(row.occurredAt));
            return times.every((time: number, i: number) => i === 0 || times[i - 1] >= time);
        });
        t.assert('...naming who acted, with a catalog summary so it reads unaided', () =>
            activity.body.data.every((row: any) =>
                row.actor.displayName === 'Verify Users Admin' && typeof row.actionSummary === 'string'));
        t.assert('...and NOT the payload/before/after, which belong to the detail view', () =>
            activity.body.data.every((row: any) => !('before' in row) && !('payload' in row)));

        const filteredFeed = await get(admin, `/api/v1/users/${id}/activity?action=users.update`);
        t.assert('the action filter narrows it', () =>
            filteredFeed.body.data.length > 0
            && filteredFeed.body.data.every((row: any) => row.action === 'users.update'));

        const foreignAction = await get(admin, `/api/v1/users/${id}/activity?action=cod.remittances.confirm`);
        t.assert('...and refuses an action from another family', () => foreignAction.status === 400);

        const unknownFeed = await get(admin, `/api/v1/users/${new ObjectId().toString()}/activity`);
        t.assert('an unknown user 404s rather than answering an empty page', () =>
            unknownFeed.status === 404);

        // ── 6. Restore ────────────────────────────────────────────────────────
        t.section('6. Restore');

        const restored = await write(admin, 'POST', `/api/v1/users/${id}/restore`);
        t.assert('restoring succeeds and clears the whole stamp', () =>
            restored.status === 200
            && restored.body?.data?.status === 'active'
            && restored.body?.data?.suspendedReason === null
            && restored.body?.data?.suspendedBy === null);

        const afterRestore = await db.collection(COLLECTIONS.USER).findOne({ _id: userId });
        t.assert('...in jovi_mall too', () =>
            afterRestore?.status === 'active' && afterRestore?.suspended_reason === null);

        const reinstateCount = await AuditLogModel()
            .countDocuments({ action: 'users.reinstate', target_id: id });
        t.assert('the reinstatement is its OWN audit action, written exactly once — and it is '
            + 'the suspension\'s only surviving record', () => reinstateCount === 1);

        const doubleRestore = await write(admin, 'POST', `/api/v1/users/${id}/restore`);
        t.assert('restoring an active account is a 409', () => doubleRestore.status === 409);

        // ── 7. Authorization ──────────────────────────────────────────────────
        t.section('7. Authorization — Support reads, and only reads');

        const supportList = await get(support, '/api/v1/users');
        t.assert('a Support administrator may look users up', () => supportList.status === 200);

        const supportDetail = await get(support, `/api/v1/users/${id}`);
        t.assert('...and open one', () => supportDetail.status === 200);

        const supportActivity = await get(support, `/api/v1/users/${id}/activity`);
        t.assert('...and read its history — a `user` row is a platform actor', () =>
            supportActivity.status === 200 && supportActivity.body.data.length > 0);

        const supportSuspend = await write(support, 'POST', `/api/v1/users/${id}/suspend`,
            { reason: 'should not be allowed' });
        t.assert('...but may NOT suspend', () =>
            supportSuspend.status === 403
            && supportSuspend.body?.error?.code === 'AUTHZ_PERMISSION_DENIED');

        const supportEdit = await write(support, 'PATCH', `/api/v1/users/${id}`, { email: emailA });
        t.assert('...nor edit a login identifier', () => supportEdit.status === 403);

        t.assert('...and the refusal names what was required, never what they hold', () =>
            Array.isArray(supportSuspend.body?.error?.details?.required)
            && supportSuspend.body?.error?.details?.actual === undefined);

        const stillActive = await db.collection(COLLECTIONS.USER).findOne({ _id: userId });
        t.assert('...and the refused write changed nothing', () => stillActive?.status === 'active');

        const anonymous = await call('GET', `/api/v1/users/${id}`);
        t.assert('an unauthenticated caller gets 401', () => anonymous.status === 401);

        return t.finish();
    } finally {
        await cleanupPlatform().catch(() => undefined);
        await cleanupAdmin().catch(() => undefined);
        if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
        await closeAll().catch(() => undefined);
        await closeRedisClients().catch(() => undefined);
    }
}

main()
    .then((code) => process.exit(code))
    .catch((error) => {
        console.error('\n❌ verify:users failed to run\n', error);
        process.exit(1);
    });
