/**
 * Verify: the authentication flow against REAL Mongo + Redis.
 *
 * `test:auth` covers the primitives in isolation. This covers what only real
 * infrastructure can show — every property here is one the DB-free suite structurally
 * cannot assert:
 *
 *   • that a REVOKED session stops working on the very next request (the single thing
 *     jovi-mall's stateless JWT cannot do at all);
 *   • that refresh ROTATION detects replay and destroys the session;
 *   • that lockout actually engages after N failures, across processes;
 *   • that suspending an account kills its live sessions;
 *   • that the mandatory-MFA session is genuinely SCOPED, not merely flagged.
 *
 * It creates its own throwaway admins under `verify-auth-*@example.test` and deletes
 * them at the end, pass or fail — the same convention as jovi-mall's `verify:blog`.
 *
 * Run: npm run verify:auth
 */
import 'dotenv/config';

// This suite makes ~25 credential calls (the lockout section alone needs 6), far past
// the 10/min production default. Raised here rather than weakened in the default —
// §11 asserts the limiter still engages, using its own low ceiling.
process.env.ADMIN_AUTH_RATE_LIMIT_MAX = '500';

import type { Server } from 'http';
import { authenticator } from 'otplib';
import { suite } from './_assert';
import { env, resetEnvCache } from '../../src/config/env';
import { createApp } from '../../src/app';
import { resetAuthRateLimiter } from '../../src/api/middlewares/auth-rate-limit.middleware';
import { connectAll, closeAll, adminConnection } from '../../src/infra/mongo/connections';
import type { CreateAdminInput } from '../../src/modules/admin-identity/repositories/admin-account.repository';
import { closeRedisClients, getRedisClient, ADMIN_SESSION_DB } from '../../src/infra/redis/redis.factory';
import { AdminAccountModel } from '../../src/modules/admin-identity/models/admin-account.model';
import { AdminSessionModel } from '../../src/modules/admin-identity/models/admin-session.model';
import { AdminAccountRepository } from '../../src/modules/admin-identity/repositories/admin-account.repository';
import { hash } from '../../src/modules/admin-identity/domain/password.service';


const t = suite('wi-admin auth — live');

const PASSWORD = 'verify-auth-suite-password-9931';
const EMAIL_T3 = 'verify-auth-support@example.test';
const EMAIL_T1 = 'verify-auth-developer@example.test';

interface Res {
    status: number;
    body: any;
    cookies: Record<string, string>;
    raw: Headers;
}

let port = 0;

/** Minimal cookie jar — enough to prove the browser path works end to end. */
function parseCookies(headers: Headers): Record<string, string> {
    const out: Record<string, string> = {};
    const raw = headers.getSetCookie?.() ?? [];
    for (const line of raw) {
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
    let body: any = null;
    try { body = JSON.parse(text); } catch { body = text; }

    return { status: response.status, body, cookies: parseCookies(response.headers), raw: response.headers };
}

const errorCode = (res: Res): string | undefined => res.body?.error?.code;

async function cleanup(): Promise<void> {
    const emails = [EMAIL_T3, EMAIL_T1];
    const admins = await AdminAccountModel().find({ email: { $in: emails } }, { _id: 1 });
    const ids = admins.map((a) => a._id);
    if (ids.length > 0) {
        await AdminSessionModel().deleteMany({ admin_id: { $in: ids } });
        await AdminAccountModel().deleteMany({ _id: { $in: ids } });
    }
    // Drop any Redis state the suite created, so a re-run starts clean.
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
        await cleanup();

        const accounts = new AdminAccountRepository();
        const passwordHash = await hash(PASSWORD);

        /**
         * `create` takes a REQUIRED `ClientSession` as of Phase 3.5 — that is what makes
         * an unaudited administrator mutation a compile error. This harness seeds fixtures
         * rather than exercising the audited path, so it opens its own transaction; the
         * audited path itself is covered by `verify:audit`.
         */
        const seedAccount = async (input: CreateAdminInput) => {
            const session = await adminConnection().startSession();
            try {
                let created!: Awaited<ReturnType<typeof accounts.create>>;
                await session.withTransaction(async () => {
                    created = await accounts.create(input, session);
                });
                return created;
            } finally {
                await session.endSession();
            }
        };

        // A tier-3 admin: no mandatory MFA, so it exercises the ordinary flow.
        const support = await seedAccount({
            email: EMAIL_T3, displayName: 'Verify Support', passwordHash, tier: 3,
        });

        const app = createApp();
        server = await new Promise<Server>((resolve) => {
            const s = app.listen(0, () => resolve(s));
        });
        const address = server.address();
        port = typeof address === 'object' && address ? address.port : 0;

        // ── 1. Login ──────────────────────────────────────────────────────────
        t.section('1. Login');

        const badPassword = await call('POST', '/api/v1/auth/login', {
            body: { email: EMAIL_T3, password: 'definitely-not-the-password' },
        });
        t.assert('a wrong password → 401', () => badPassword.status === 401);
        t.assert('...with ADMIN_AUTH_INVALID_CREDENTIALS', () =>
            errorCode(badPassword) === 'ADMIN_AUTH_INVALID_CREDENTIALS');

        const unknownEmail = await call('POST', '/api/v1/auth/login', {
            body: { email: 'verify-auth-nobody@example.test', password: PASSWORD },
        });
        t.assert('an UNKNOWN email returns the SAME code — no existence oracle', () =>
            errorCode(unknownEmail) === errorCode(badPassword));

        const login = await call('POST', '/api/v1/auth/login', {
            body: { email: EMAIL_T3, password: PASSWORD },
        });
        t.assert('the correct password → 200', () => login.status === 200);
        t.assert('an access token is issued', () => typeof login.body?.data?.accessToken === 'string');
        t.assert('a refresh token is issued', () => typeof login.body?.data?.refreshToken === 'string');
        t.assert('the profile carries NO password hash or MFA secret', () => {
            const serialised = JSON.stringify(login.body.data.admin);
            return !serialised.includes('password') && !serialised.includes('mfa_secret');
        });
        t.assert('all three cookies are set', () =>
            Boolean(login.cookies.admin_access_token && login.cookies.admin_refresh_token && login.cookies.admin_csrf_token));
        t.assert('the access cookie is httpOnly', () =>
            (login.raw.getSetCookie?.() ?? []).some((c) => c.startsWith('admin_access_token') && /HttpOnly/i.test(c)));
        t.assert('the CSRF cookie is readable by JS (double-submit requires it)', () =>
            (login.raw.getSetCookie?.() ?? []).some((c) => c.startsWith('admin_csrf_token') && !/HttpOnly/i.test(c)));

        const accessToken: string = login.body.data.accessToken;

        const csrfToken: string = login.body.data.csrfToken;
        const jar = { ...login.cookies };

        // ── 2. Authenticated access ───────────────────────────────────────────
        t.section('2. Authenticated access');

        const meBearer = await call('GET', '/api/v1/auth/me', { bearer: accessToken });
        t.assert('Bearer authentication works', () => meBearer.status === 200);
        t.assert('/me reports the typed identity', () =>
            meBearer.body?.data?.admin?.email === EMAIL_T3 && meBearer.body?.data?.admin?.tier === 3);
        t.assert('/me reports the session', () => typeof meBearer.body?.data?.session?.sessionId === 'string');

        const meCookie = await call('GET', '/api/v1/auth/me', { cookies: jar });
        t.assert('cookie authentication works too', () => meCookie.status === 200);

        const noAuth = await call('GET', '/api/v1/auth/me');
        t.assert('unauthenticated → 401', () => noAuth.status === 401);
        t.assert('...with ADMIN_AUTH_MISSING_TOKEN', () => errorCode(noAuth) === 'ADMIN_AUTH_MISSING_TOKEN');

        const garbage = await call('GET', '/api/v1/auth/me', { bearer: 'not.a.token' });
        t.assert('a garbage token → ADMIN_AUTH_TOKEN_INVALID', () =>
            errorCode(garbage) === 'ADMIN_AUTH_TOKEN_INVALID');

        // ── 3. CSRF ───────────────────────────────────────────────────────────
        t.section('3. CSRF');

        const noCsrf = await call('POST', '/api/v1/auth/logout-all', { cookies: jar });
        t.assert('a cookie-authenticated POST WITHOUT the token → 403', () => noCsrf.status === 403);
        t.assert('...with ADMIN_AUTH_CSRF_INVALID', () => errorCode(noCsrf) === 'ADMIN_AUTH_CSRF_INVALID');

        const wrongCsrf = await call('POST', '/api/v1/auth/logout-all', { cookies: jar, csrf: 'wrong-value' });
        t.assert('a MISMATCHED token → 403', () => wrongCsrf.status === 403);

        const bearerNoCsrf = await call('GET', '/api/v1/auth/sessions', { bearer: accessToken });
        t.assert('Bearer requests are exempt — nothing sends that header ambiently', () =>
            bearerNoCsrf.status === 200);

        // ── 4. Sessions ───────────────────────────────────────────────────────
        t.section('4. Sessions');

        const second = await call('POST', '/api/v1/auth/login', { body: { email: EMAIL_T3, password: PASSWORD } });
        const secondAccess: string = second.body.data.accessToken;

        const sessionList = await call('GET', '/api/v1/auth/sessions', { bearer: accessToken });
        t.assert('both sessions are listed', () => Array.isArray(sessionList.body?.data) && sessionList.body.data.length >= 2);
        t.assert('exactly one is marked current', () =>
            sessionList.body.data.filter((s: any) => s.current).length === 1);

        // ── 5. Revocation — the property jovi-mall cannot offer ───────────────
        t.section('5. Revocation');

        const logout = await call('POST', '/api/v1/auth/logout', { cookies: jar, csrf: csrfToken });
        t.assert('logout succeeds', () => logout.status === 200);

        const afterLogout = await call('GET', '/api/v1/auth/me', { bearer: accessToken });
        t.assert('the STILL-UNEXPIRED access token is rejected on the very next request', () =>
            afterLogout.status === 401);
        t.assert('...as ADMIN_AUTH_SESSION_REVOKED', () =>
            errorCode(afterLogout) === 'ADMIN_AUTH_SESSION_REVOKED');

        const otherStillAlive = await call('GET', '/api/v1/auth/me', { bearer: secondAccess });
        t.assert('the OTHER session is unaffected by a single logout', () => otherStillAlive.status === 200);

        const logoutAll = await call('POST', '/api/v1/auth/logout-all', {
            bearer: secondAccess, csrf: second.body.data.csrfToken,
        });
        t.assert('logout-all succeeds', () => logoutAll.status === 200);
        const afterLogoutAll = await call('GET', '/api/v1/auth/me', { bearer: secondAccess });
        t.assert('every session is dead afterwards', () => afterLogoutAll.status === 401);

        // ── 6. Refresh rotation & reuse detection ─────────────────────────────
        t.section('6. Refresh rotation');

        const fresh = await call('POST', '/api/v1/auth/login', { body: { email: EMAIL_T3, password: PASSWORD } });
        const originalRefresh: string = fresh.body.data.refreshToken;

        const rotated = await call('POST', '/api/v1/auth/refresh', { body: { refreshToken: originalRefresh } });
        t.assert('refresh returns a new pair', () => rotated.status === 200);
        t.assert('the refresh token ROTATED', () => rotated.body.data.refreshToken !== originalRefresh);

        const rotatedAccess: string = rotated.body.data.accessToken;
        const afterRotate = await call('GET', '/api/v1/auth/me', { bearer: rotatedAccess });
        t.assert('the rotated access token authenticates', () => afterRotate.status === 200);

        const replay = await call('POST', '/api/v1/auth/refresh', { body: { refreshToken: originalRefresh } });
        t.assert('REPLAYING the superseded refresh token → 401', () => replay.status === 401);
        t.assert('...as ADMIN_AUTH_REFRESH_REUSED', () => errorCode(replay) === 'ADMIN_AUTH_REFRESH_REUSED');

        const afterReuse = await call('GET', '/api/v1/auth/me', { bearer: rotatedAccess });
        t.assert('reuse DESTROYS the whole session — the good token dies too', () =>
            afterReuse.status === 401);

        // ── 7. Lockout ────────────────────────────────────────────────────────
        t.section('7. Lockout');

        const maxAttempts = env().ADMIN_LOCKOUT_MAX_ATTEMPTS;
        let lockedResponse: Res | null = null;
        for (let i = 0; i < maxAttempts + 1; i++) {
            const attempt = await call('POST', '/api/v1/auth/login', {
                body: { email: EMAIL_T3, password: 'wrong-every-time' },
            });
            if (errorCode(attempt) === 'ADMIN_AUTH_ACCOUNT_LOCKED') { lockedResponse = attempt; break; }
        }
        t.assert(`the account locks within ${maxAttempts + 1} failures`, () => lockedResponse !== null);
        t.assert('the lock reports how long to wait', () =>
            typeof lockedResponse?.body?.error?.details?.retryAfterSeconds === 'number');

        const correctWhileLocked = await call('POST', '/api/v1/auth/login', {
            body: { email: EMAIL_T3, password: PASSWORD },
        });
        t.assert('even the CORRECT password is refused while locked', () =>
            errorCode(correctWhileLocked) === 'ADMIN_AUTH_ACCOUNT_LOCKED');

        // Clear the lock so the remaining sections can authenticate.
        const { clearFailures } = await import('../../src/modules/admin-identity/domain/lockout.service');
        await clearFailures(support._id.toString());

        // ── 8. Suspension ─────────────────────────────────────────────────────
        t.section('8. Suspension');

        const liveAgain = await call('POST', '/api/v1/auth/login', { body: { email: EMAIL_T3, password: PASSWORD } });
        t.assert('login works again after the lock is cleared', () => liveAgain.status === 200);
        const suspendedToken: string = liveAgain.body.data.accessToken;

        await accounts.setStatus(support._id.toString(), 'suspended');

        const afterSuspend = await call('GET', '/api/v1/auth/me', { bearer: suspendedToken });
        t.assert('suspending an account kills its LIVE session immediately', () => afterSuspend.status === 403);
        t.assert('...as ADMIN_AUTH_ACCOUNT_SUSPENDED', () =>
            errorCode(afterSuspend) === 'ADMIN_AUTH_ACCOUNT_SUSPENDED');

        const suspendedLogin = await call('POST', '/api/v1/auth/login', { body: { email: EMAIL_T3, password: PASSWORD } });
        t.assert('a suspended account cannot log back in', () =>
            errorCode(suspendedLogin) === 'ADMIN_AUTH_ACCOUNT_SUSPENDED');

        await accounts.setStatus(support._id.toString(), 'active');

        // ── 9. Mandatory MFA is genuinely SCOPED ──────────────────────────────
        t.section('9. Mandatory MFA (tier 1)');

        const developer = await seedAccount({
            email: EMAIL_T1, displayName: 'Verify Developer', passwordHash, tier: 1,
        });

        const t1Login = await call('POST', '/api/v1/auth/login', { body: { email: EMAIL_T1, password: PASSWORD } });
        t.assert('a tier-1 admin with no MFA still receives a session', () => t1Login.status === 200);
        t.assert('...flagged mfaEnrolmentRequired', () => t1Login.body?.data?.mfaEnrolmentRequired === true);

        const scopedToken: string = t1Login.body.data.accessToken;

        const scopedMe = await call('GET', '/api/v1/auth/me', { bearer: scopedToken });
        t.assert('the scoped session CAN reach /me', () => scopedMe.status === 200);

        const scopedSessions = await call('GET', '/api/v1/auth/sessions', { bearer: scopedToken });
        t.assert('the scoped session CANNOT reach anything else → 403', () => scopedSessions.status === 403);
        t.assert('...as ADMIN_AUTH_MFA_REQUIRED', () => errorCode(scopedSessions) === 'ADMIN_AUTH_MFA_REQUIRED');

        const enrol = await call('POST', '/api/v1/auth/mfa/enroll', { bearer: scopedToken });
        t.assert('the scoped session CAN enrol MFA', () => enrol.status === 200);
        t.assert('enrolment returns an otpauth URI', () =>
            typeof enrol.body?.data?.otpauthUri === 'string' && enrol.body.data.otpauthUri.startsWith('otpauth://'));

        const secret: string = enrol.body.data.secret;
        const badActivate = await call('POST', '/api/v1/auth/mfa/activate', { bearer: scopedToken, body: { code: '000000' } });
        t.assert('a wrong activation code is refused', () => badActivate.status === 401);

        const activate = await call('POST', '/api/v1/auth/mfa/activate', {
            bearer: scopedToken, body: { code: authenticator.generate(secret) },
        });
        t.assert('a correct code activates MFA', () => activate.status === 200);
        t.assert('...and requires re-authentication', () =>
            activate.body?.data?.reauthenticationRequired === true);

        const scopedAfterActivate = await call('GET', '/api/v1/auth/me', { bearer: scopedToken });
        t.assert('the password-only session is destroyed on activation', () => scopedAfterActivate.status === 401);

        const mfaLogin = await call('POST', '/api/v1/auth/login', { body: { email: EMAIL_T1, password: PASSWORD } });
        t.assert('login now returns an MFA CHALLENGE, not tokens', () =>
            mfaLogin.status === 200 && mfaLogin.body?.data?.mfaRequired === true);
        t.assert('no access token accompanies the challenge', () =>
            mfaLogin.body?.data?.accessToken === undefined);

        const challengeId: string = mfaLogin.body.data.challengeId;
        const wrongCode = await call('POST', '/api/v1/auth/mfa/verify', {
            body: { challengeId, code: '000000' },
        });
        t.assert('a wrong MFA code → 401', () => wrongCode.status === 401);

        const verified = await call('POST', '/api/v1/auth/mfa/verify', {
            body: { challengeId, code: authenticator.generate(secret) },
        });
        t.assert('the challenge SURVIVES a wrong code and completes with a right one', () => verified.status === 200);
        t.assert('completing MFA issues a full session', () =>
            typeof verified.body?.data?.accessToken === 'string');

        const fullAccess = await call('GET', '/api/v1/auth/sessions', { bearer: verified.body.data.accessToken });
        t.assert('the MFA session is NOT scoped — it reaches everything', () => fullAccess.status === 200);

        // ── 10. Durable session history ───────────────────────────────────────
        t.section('10. Durable history');

        const rows = await AdminSessionModel().find({ admin_id: developer._id });
        t.assert('every login wrote a durable session row', () => rows.length >= 2);
        t.assert('ended sessions are STAMPED, not deleted — an audit trail must not erase itself', () =>
            rows.some((r) => r.ended_at !== null && r.end_reason !== null));
        t.assert('the tier is snapshotted at login', () => rows.every((r) => r.tier_at_login === 1));

        // ── 11. Rate limiting is scoped to the credential endpoints ───────────
        t.section('11. Rate limiting');

        // The suite raised the ceiling to 500 so the sections above could run. Here a
        // second app is built with a low ceiling to prove the limiter actually engages —
        // and, just as importantly, that it does NOT cover the authenticated routes a
        // dashboard polls.
        process.env.ADMIN_AUTH_RATE_LIMIT_MAX = '3';
        resetEnvCache();
        resetAuthRateLimiter();

        const strictApp = createApp();
        const strictServer = await new Promise<Server>((resolve) => {
            const s = strictApp.listen(0, () => resolve(s));
        });
        const strictPort = (strictServer.address() as { port: number }).port;

        try {
            let limited = false;
            for (let i = 0; i < 6; i++) {
                const attempt = await fetch(`http://127.0.0.1:${strictPort}/api/v1/auth/login`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email: EMAIL_T3, password: 'wrong' }),
                });
                if (attempt.status === 429) { limited = true; break; }
            }
            t.assert('the credential endpoint is rate limited (429 within 6 attempts)', () => limited);

            const meUnderLimit = await fetch(`http://127.0.0.1:${strictPort}/api/v1/auth/me`, {
                headers: { Authorization: `Bearer ${verified.body.data.accessToken}` },
            });
            t.assert('an AUTHENTICATED route is NOT throttled by the credential limiter', () =>
                meUnderLimit.status === 200);
        } finally {
            await new Promise<void>((resolve) => strictServer.close(() => resolve()));
        }

        return t.finish();
    } finally {
        if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
        await cleanup().catch(() => undefined);
        await closeAll();
        await closeRedisClients();
    }
}

main()
    .then((code) => process.exit(code))
    .catch((error) => {
        console.error('\n❌ verify:auth could not run:', error instanceof Error ? error.stack : error);
        console.error('   This suite needs Mongo and Redis reachable at the URLs in .env\n');
        process.exit(1);
    });
