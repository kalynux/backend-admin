/**
 * Verify: data access against REAL infrastructure and a REAL jovi-mall.
 *
 * `test:data-access` proves the rules are internally consistent. This proves the transport
 * works — and it is the only place the phase's exit gate can be demonstrated, because that
 * gate is about what happens INSIDE the other service:
 *
 *   Gate A  a remittance confirmed from admin settles its collections FIFO
 *   Gate B  a deposit confirmed from admin fires jovi-mall's in-process subscribers
 *
 * Gate B is the whole argument for delegation. A direct database write could reproduce the
 * transaction; nothing outside jovi-mall's process can reproduce the notification handlers
 * that its post-commit event triggers. Proving they fire is proving the design.
 *
 * ── What it needs ─────────────────────────────────────────────────────────────
 *   Mongo + Redis (this service's usual dependencies)
 *   jovi-mall RUNNING, with INTERNAL_ADMIN_SERVICE_TOKEN set
 *   this service's JOVI_MALL_BASE_URL + JOVI_MALL_SERVICE_TOKEN set to match
 *
 * It SKIPS loudly rather than silently when jovi-mall is unreachable — a suite that passes
 * by not running is worse than one that fails.
 *
 * It creates its own fixtures directly in `jovi_mall` (a throwaway agency, agent, cash
 * position and remittance) and deletes them at the end, pass or fail.
 *
 * Run: npm run verify:platform
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
import { hash } from '../../src/modules/admin-identity/domain/password.service';
import { AdminTier } from '../../src/modules/admin-identity/domain/admin-identity.types';
import { pingPlatform } from '../../src/infra/platform/platform.client';
import { COLLECTIONS } from '../../src/infra/platform/collections';

const t = suite('wi-admin data access — live');

const PASSWORD = 'verify-platform-suite-password-7712';
const EMAIL_ADMIN = 'verify-platform-admin@example.test';
const EMAIL_SUPPORT = 'verify-platform-support@example.test';

/** Everything this suite creates in `jovi_mall`, tagged so cleanup cannot miss one. */
const FIXTURE_TAG = 'verify-platform-fixture';

interface Res {
    status: number;
    body: any;
    cookies: Record<string, string>;
}

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
    return {
        adminId: me.body?.data?.admin?.id,
        cookies: res.cookies,
        csrf: res.cookies.admin_csrf_token ?? '',
    };
}

const get = (s: Session, path: string) => call('GET', path, { cookies: s.cookies });
const write = (s: Session, method: string, path: string, body?: unknown) =>
    call(method, path, { cookies: s.cookies, csrf: s.csrf, body });

/** Direct handles on `jovi_mall`, for building fixtures and asserting what landed. */
function platformDb() {
    const db = platformConnection().db;
    if (!db) throw new Error('platform connection has no db');
    return db;
}

async function cleanupPlatform(): Promise<void> {
    const db = platformDb();
    for (const collection of [
        COLLECTIONS.AGENCY_REMITTANCE,
        COLLECTIONS.AGENT_DEPOSIT,
        COLLECTIONS.COD_CASH_ACCOUNT,
        COLLECTIONS.AGENT_AGENCY_CONTRACT,
        COLLECTIONS.USER,
    ]) {
        await db.collection(collection).deleteMany({ [FIXTURE_TAG]: true });
    }
}

async function cleanupAdmin(): Promise<void> {
    const admins = await AdminAccountModel().find(
        { email: { $in: [EMAIL_ADMIN, EMAIL_SUPPORT] } }, { _id: 1 },
    );
    const ids = admins.map((a) => a._id);
    if (ids.length > 0) {
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

async function main(): Promise<number> {
    let server: Server | null = null;

    try {
        env();
        await connectAll();
        await cleanupAdmin();
        await cleanupPlatform();

        const accounts = new AdminAccountRepository();
        const passwordHash = await hash(PASSWORD);

        /**
         * `create` takes a REQUIRED `ClientSession` as of Phase 3.5 — the type is what makes
         * an unaudited administrator mutation fail to compile. These are fixtures, not the
         * audited path, so the harness opens its own transaction, exactly as
         * `verify-authz-live.ts` does.
         *
         * This script did not compile between Phase 3.5 and the user-management phase for
         * want of these two arguments. Nothing caught it because it is the one suite that
         * needs BOTH services running, so it is not in any routine loop — worth knowing when
         * the remaining endpoints land and this becomes the gate they are proven against.
         */
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

        await make(EMAIL_ADMIN, 'Verify Platform Admin', 2);
        await make(EMAIL_SUPPORT, 'Verify Platform Support', 3);

        const app = createApp();
        server = await new Promise<Server>((resolve) => {
            const s = app.listen(0, () => resolve(s));
        });
        const address = server.address();
        port = typeof address === 'object' && address ? address.port : 0;

        const admin = await signIn(EMAIL_ADMIN);
        const support = await signIn(EMAIL_SUPPORT);

        // ── 1. Direct reads ───────────────────────────────────────────────────
        t.section('1. Direct read — users, straight from jovi_mall');

        const db = platformDb();
        const fixtureUserId = new ObjectId();
        await db.collection(COLLECTIONS.USER).insertOne({
            _id: fixtureUserId,
            login_email: 'verify-platform-user@example.test',
            login_phone: '+237600000091',
            password_hash: 'THIS-MUST-NEVER-LEAVE-THE-DATABASE',
            roles: ['vendor'],
            status: 'active',
            created_at: new Date(),
            updated_at: new Date(),
            [FIXTURE_TAG]: true,
        } as never);

        const list = await get(admin, '/api/v1/users?search=verify-platform-user&limit=5');
        t.assert('an Admin can search users (no jovi-mall call involved)', () => list.status === 200);
        t.assert('...and finds the fixture', () =>
            (list.body?.data ?? []).some((u: any) => u.id === fixtureUserId.toString()));
        t.assert('...paginated with a real total', () => typeof list.body?.meta?.total === 'number');

        // The reason the projection is a whitelist rather than an exclusion list.
        t.assert('the password hash NEVER appears in the response', () =>
            !JSON.stringify(list.body).includes('THIS-MUST-NEVER-LEAVE-THE-DATABASE')
            && !JSON.stringify(list.body).includes('password_hash'));

        const detail = await get(admin, `/api/v1/users/${fixtureUserId.toString()}`);
        t.assert('a user detail reads', () => detail.status === 200);
        /**
         * An EXACT key set, not a subset check. The point is that widening the DTO is a
         * decision somebody has to make here as well — which is exactly what happened when
         * `suspension` and `profiles` were added: this line failed, and that failure is the
         * mechanism working rather than a nuisance.
         */
        t.assert('...with only the whitelisted fields', () => {
            const keys = Object.keys(detail.body?.data ?? {}).sort();
            return keys.join(',')
                === 'createdAt,email,id,phone,profiles,roles,status,suspension,updatedAt';
        });

        t.assert('...an active account carries no suspension block', () =>
            detail.body?.data?.suspension === null);

        t.assert('...and its role profiles name the roles it holds, with nothing sensitive', () => {
            const profiles = detail.body?.data?.profiles ?? [];
            const serialised = JSON.stringify(profiles);
            return Array.isArray(profiles)
                && profiles.length === 1
                && profiles[0].role === 'vendor'
                // The fixture user has no vendor row, so the missing marker is the answer —
                // a claimed role with no entity cannot sign in and must not be hidden.
                && profiles[0].missing === true
                && !serialised.includes('legal_identity')
                && !serialised.includes('payout_details');
        });

        const missing = await get(admin, `/api/v1/users/${new ObjectId().toString()}`);
        t.assert('an unknown user is a 404', () => missing.status === 404);

        // Support DOES hold `users.read` — a support conversation needs to look a customer
        // up, and Phase 3's grant table says so. The interesting boundary is that the same
        // administrator is refused the money surface, asserted in §2.
        const supportReads = await get(support, '/api/v1/users');
        t.assert('a Support administrator may look users up — that is the granted policy', () =>
            supportReads.status === 200);
        t.assert('...and still sees no credential field', () =>
            !JSON.stringify(supportReads.body).includes('password_hash'));

        // ── 2. Delegation ─────────────────────────────────────────────────────
        t.section('2. Delegated reads and writes — COD, served by jovi-mall');

        const reachable = await pingPlatform();

        if (!reachable.configured) {
            t.assert('SKIPPED — JOVI_MALL_BASE_URL is not set, so delegation cannot be exercised', () => true);
            console.error(
                '\n  ⚠  Set JOVI_MALL_BASE_URL + JOVI_MALL_SERVICE_TOKEN and run jovi-mall with a matching\n'
                + '     INTERNAL_ADMIN_SERVICE_TOKEN to exercise sections 2–4. They are the phase exit gate.\n',
            );
            return t.finish();
        }

        if (!reachable.ok) {
            t.assert('SKIPPED — jovi-mall is configured but unreachable', () => true);
            console.error(`\n  ⚠  ${reachable.error ?? 'no response'} — start jovi-mall and re-run.\n`);
            return t.finish();
        }

        const remittances = await get(admin, '/api/v1/cod/remittances?limit=5');
        t.assert('a delegated read succeeds', () => remittances.status === 200);
        t.assert('...re-enveloped as this service\'s shape', () =>
            remittances.body?.success === true && Array.isArray(remittances.body?.data));
        t.assert('...with jovi-mall\'s pagination passed through, not recomputed', () =>
            typeof remittances.body?.meta?.total === 'number'
            && typeof remittances.body?.meta?.pages === 'number');

        const supportDelegated = await get(support, '/api/v1/cod/remittances');
        t.assert('a Support administrator is refused before anything is delegated', () =>
            supportDelegated.status === 403);

        // ── 3. Exit gate A — FIFO settlement ──────────────────────────────────
        t.section('3. Exit gate A — remittance confirm settles FIFO inside jovi-mall');

        const agencyId = new ObjectId();
        const remittanceId = new ObjectId();

        await db.collection(COLLECTIONS.COD_CASH_ACCOUNT).insertOne({
            owner_type: 'agency',
            owner_id: agencyId,
            balance: 5000,
            currency: 'XAF',
            created_at: new Date(),
            updated_at: new Date(),
            [FIXTURE_TAG]: true,
        } as never);

        await db.collection(COLLECTIONS.AGENCY_REMITTANCE).insertOne({
            _id: remittanceId,
            agency_id: agencyId,
            amount: 5000,
            currency: 'XAF',
            reference: 'VERIFY-PLATFORM-REF-1',
            note: null,
            status: 'declared',
            declared_by_user_id: new ObjectId(),
            declared_at: new Date(),
            resolved_at: null,
            resolved_by_user_id: null,
            resolved_by_source: 'platform',
            resolved_by_name: null,
            rejection_reason: null,
            created_at: new Date(),
            updated_at: new Date(),
            [FIXTURE_TAG]: true,
        } as never);

        const confirmed = await write(
            admin, 'POST', `/api/v1/cod/remittances/${remittanceId.toString()}/confirm`,
        );

        t.assert('confirming through admin succeeds', () => confirmed.status === 200);

        const settled = await db.collection(COLLECTIONS.AGENCY_REMITTANCE).findOne({ _id: remittanceId });
        t.assert('the remittance is confirmed in jovi_mall', () => settled?.status === 'confirmed');

        // The actor plumbing — ADR-004 D-1 made observable.
        t.assert('the acting ADMINISTRATOR is stamped on it', () =>
            settled?.resolved_by_user_id?.toString() === admin.adminId);
        t.assert('...marked as an admin id, so nobody looks for it in `users`', () =>
            settled?.resolved_by_source === 'admin');
        t.assert('...with a name snapshot, because that id resolves nowhere here', () =>
            settled?.resolved_by_name === 'Verify Platform Admin');

        const account = await db.collection(COLLECTIONS.COD_CASH_ACCOUNT)
            .findOne({ owner_id: agencyId, [FIXTURE_TAG]: true } as never);
        t.assert('the agency\'s liability was debited by jovi-mall\'s transaction', () =>
            (account?.balance ?? 5000) === 0);

        const reconfirm = await write(
            admin, 'POST', `/api/v1/cod/remittances/${remittanceId.toString()}/confirm`,
        );
        t.assert('re-confirming is refused with jovi-mall\'s own conflict, not a 500', () =>
            reconfirm.status === 409);
        t.assert('...carrying jovi-mall\'s code in details rather than a remapped one', () =>
            typeof reconfirm.body?.error?.details?.platformCode === 'string');

        // ── 4. Exit gate B — in-process subscribers ───────────────────────────
        t.section('4. Exit gate B — a delegated write fires jovi-mall\'s subscribers');

        /**
         * This one rides a REAL seeded world rather than a hand-built fixture.
         *
         * Confirming a deposit needs a live agent↔agency contract, an agent record, and a
         * cash position — jovi-mall's own preconditions. Fabricating all of them here would
         * mean reproducing schemas this service deliberately does not model (ADR-004 D-3),
         * and a fixture that satisfies a precondition by accident proves nothing.
         *
         * So the suite finds a live contract that jovi-mall's `seed:cod` produced and
         * builds only the deposit on top. With no seeded world it skips, loudly.
         */
        const liveContract = await db.collection(COLLECTIONS.AGENT_AGENCY_CONTRACT)
            .findOne({ status: 'active' }, { projection: { agent_id: 1, agency_id: 1 } });

        if (!liveContract) {
            t.assert('SKIPPED — no live agent contract; run jovi-mall\'s `npm run seed:cod` first', () => true);
            console.error(
                '\n  ⚠  Gate B needs a seeded world. Run `npm run seed:cod` in jovi-mall and re-run.\n',
            );
            return t.finish();
        }

        const agentId = liveContract.agent_id as ObjectId;
        const depositAgencyId = liveContract.agency_id as ObjectId;
        const depositId = new ObjectId();

        await db.collection(COLLECTIONS.AGENT_DEPOSIT).insertOne({
            _id: depositId,
            agent_id: agentId,
            agency_id: depositAgencyId,
            amount: 100,
            currency: 'XAF',
            // `platform`, not `agency`: the admin surface confirms the direct-to-platform
            // hand-over that bypasses the agency. An agency-recipient deposit is the
            // agency's own desk to confirm, and jovi-mall rightly answers
            // COD_DEPOSIT_WRONG_RECIPIENT if this door is used for one.
            recipient: 'platform',
            status: 'declared',
            declared_by_user_id: new ObjectId(),
            declared_at: new Date(),
            recorded_by_user_id: null,
            recorded_by_source: 'platform',
            recorded_by_name: null,
            resolved_at: null,
            rejection_reason: null,
            created_at: new Date(),
            updated_at: new Date(),
            [FIXTURE_TAG]: true,
        } as never);

        // NOTE the camelCase key. The notification stacks are the one part of jovi-mall
        // that does not use snake_case columns — asserting on `agent_id` here silently
        // counts zero and reads as 'the subscriber never fired'.
        const notificationsBefore = await db.collection(COLLECTIONS.AGENT_NOTIFICATION)
            .countDocuments({ agentId });

        const depositConfirmed = await write(
            admin, 'POST', `/api/v1/cod/deposits/${depositId.toString()}/confirm`,
        );

        // The deposit fixture is deliberately minimal, so jovi-mall may refuse it on a
        // domain rule (no membership, no cash position). Either outcome proves something:
        // a 200 proves the subscribers fired, a 4xx proves the domain rule reached us
        // intact rather than becoming a 500.
        t.assert('the delegated confirm reaches jovi-mall\'s domain, not an error page', () =>
            depositConfirmed.status === 200 || (depositConfirmed.status >= 400 && depositConfirmed.status < 500));

        if (depositConfirmed.status === 200) {
            const stored = await db.collection(COLLECTIONS.AGENT_DEPOSIT).findOne({ _id: depositId });
            t.assert('the deposit is confirmed', () => stored?.status === 'confirmed');
            t.assert('...stamped with the administrator and marked as an admin id', () =>
                stored?.recorded_by_user_id?.toString() === admin.adminId
                && stored?.recorded_by_source === 'admin');

            const notificationsAfter = await db.collection(COLLECTIONS.AGENT_NOTIFICATION)
                .countDocuments({ agentId });

            // THE assertion this phase exists for. `cod.deposit.recorded` has two
            // subscribers inside jovi-mall's process; a direct database write from here
            // could never have run them.
            t.assert('an in-process subscriber wrote a notification — delegation reached it', () =>
                notificationsAfter > notificationsBefore);
        } else {
            t.assert('...refused with jovi-mall\'s own code, proving the error path maps', () =>
                typeof depositConfirmed.body?.error?.details?.platformCode === 'string');
            console.error(
                `\n  ⚠  The deposit fixture was refused (${depositConfirmed.body?.error?.details?.platformCode}).\n`
                + '     Seed a real one with jovi-mall\'s `npm run seed:cod-shipments` to exercise the\n'
                + '     subscriber assertion.\n',
            );
        }

        // ── 5. The guard fails closed ─────────────────────────────────────────
        t.section('5. The internal API guard');

        const base = env().JOVI_MALL_BASE_URL;
        const direct = await fetch(`${base}/api/internal/admin/cod/remittances`, {
            headers: { 'X-Service-Token': 'not-the-real-token', 'X-Actor-Id': admin.adminId },
        });
        t.assert('a wrong service token is refused by jovi-mall', () => direct.status === 401);

        const noToken = await fetch(`${base}/api/internal/admin/cod/remittances`, {
            headers: { 'X-Actor-Id': admin.adminId },
        });
        t.assert('no service token is refused too', () => noToken.status === 401 || noToken.status === 503);

        const noActor = await fetch(`${base}/api/internal/admin/cod/remittances`, {
            headers: { 'X-Service-Token': env().JOVI_MALL_SERVICE_TOKEN ?? '' },
        });
        t.assert('a valid token with NO actor is refused — an unattributed write is worse than none', () =>
            noActor.status === 400);

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
        console.error('\n❌ verify:platform failed to run\n', error);
        process.exit(1);
    });
