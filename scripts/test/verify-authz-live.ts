/**
 * Verify: authorization against REAL Mongo + Redis, over HTTP.
 *
 * `test:authz` proves the policy is internally consistent. This proves it is ENFORCED —
 * every property here is one the infrastructure-free suite structurally cannot assert:
 *
 *   • the blueprint's exit gate: a Support administrator is provably denied an
 *     Admin-tier endpoint, and an Admin reaches the same one;
 *   • that escalation refusals hold through the wire, not just in the pure function;
 *   • that suspending or re-levelling an administrator kills their live sessions on the
 *     very NEXT request;
 *   • that four-eyes actually works: a request queues at 202, its author cannot approve
 *     it, a second Developer can, and the action is performed by that approval;
 *   • that the boot assertions refuse a service whose routes or grants are wrong.
 *
 * It creates its own throwaway administrators under `verify-authz-*@example.test` and
 * deletes them at the end, pass or fail — the same convention as `verify:auth`.
 *
 * Run: npm run verify:authz
 */
import 'dotenv/config';

// This suite logs in six times over; the 10/min production default would throttle it.
// `verify:auth` §11 is what asserts the limiter still engages.
process.env.ADMIN_AUTH_RATE_LIMIT_MAX = '500';

import type { Server } from 'http';
import { Router } from 'express';
import { authenticator } from 'otplib';
import { suite } from './_assert';
import { env } from '../../src/config/env';
import { createApp } from '../../src/app';
import { connectAll, closeAll, adminConnection } from '../../src/infra/mongo/connections';
import { closeRedisClients, getRedisClient, ADMIN_SESSION_DB } from '../../src/infra/redis/redis.factory';
import { AdminAccountModel } from '../../src/modules/admin-identity/models/admin-account.model';
import { AdminSessionModel } from '../../src/modules/admin-identity/models/admin-session.model';
import { AdminAccountRepository } from '../../src/modules/admin-identity/repositories/admin-account.repository';
import { hash } from '../../src/modules/admin-identity/domain/password.service';
import { ApprovalRequestModel } from '../../src/modules/dual-control/models/approval-request.model';
import { AdminTier } from '../../src/modules/admin-identity/domain/admin-identity.types';
import { AppError } from '../../src/core/errors/app-error';
import { ERROR_CODES } from '../../src/core/errors/error-codes';
import { assertGrantTableValid } from '../../src/modules/authorization/domain/tier-grants';

const t = suite('wi-admin authorization — live');

const PASSWORD = 'verify-authz-suite-password-4417';

const EMAIL = {
    devA: 'verify-authz-dev-a@example.test',
    devB: 'verify-authz-dev-b@example.test',
    adminA: 'verify-authz-admin-a@example.test',
    adminB: 'verify-authz-admin-b@example.test',
    support: 'verify-authz-support@example.test',
    victim: 'verify-authz-victim@example.test',
};

const ALL_EMAILS = Object.values(EMAIL);

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

    return { status: response.status, body, cookies: parseCookies(response.headers) };
}

const errorCode = (res: Res): string | undefined => res.body?.error?.code;

/** A signed-in administrator, with everything needed to make authenticated calls. */
interface Session {
    adminId: string;
    cookies: Record<string, string>;
    csrf: string;
}

async function sessionFrom(res: Res): Promise<Session> {
    // `/auth/me` answers `{ admin: {...}, session: {...} }` — the id is under `admin`,
    // not at the top of `data`. Six assertions in this suite compare against it, so a
    // silent `undefined` here would read as six unrelated failures.
    const me = await call('GET', '/api/v1/auth/me', { cookies: res.cookies });
    const adminId: string | undefined = me.body?.data?.admin?.id;
    if (!adminId) {
        throw new Error(`could not read the administrator id from /auth/me: ${JSON.stringify(me.body)}`);
    }
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
 * Sign in an administrator whose tier makes TOTP mandatory.
 *
 * Runs the real flow rather than faking it — enrol, activate, re-authenticate with a
 * generated code — because the TOTP secret is encrypted at rest and there is no way to
 * plant a usable one from outside the service. Which is the correct property; it just
 * means Developers cost five calls to sign in.
 *
 * `verify:auth` §9 is what ASSERTS this flow. Here it is only the cost of getting a
 * Developer session, so a failure throws rather than being reported as a finding.
 */
async function signInDeveloper(email: string): Promise<Session> {
    const scoped = await call('POST', '/api/v1/auth/login', { body: { email, password: PASSWORD } });
    if (scoped.status !== 200 || !scoped.body?.data?.mfaEnrolmentRequired) {
        throw new Error(`expected a scoped enrolment session for ${email}: ${JSON.stringify(scoped.body)}`);
    }

    // Bearer, not cookies: the CSRF guard exempts bearer clients, which keeps the
    // enrolment calls free of the token dance.
    const bearer: string = scoped.body.data.accessToken;

    const enrol = await call('POST', '/api/v1/auth/mfa/enroll', { bearer });
    const secret: string = enrol.body?.data?.secret;
    if (!secret) throw new Error(`enrolment gave no secret for ${email}`);

    const activated = await call('POST', '/api/v1/auth/mfa/activate', {
        bearer,
        body: { code: authenticator.generate(secret) },
    });
    if (activated.status !== 200) {
        throw new Error(`activation failed for ${email}: ${JSON.stringify(activated.body)}`);
    }

    const challenge = await call('POST', '/api/v1/auth/login', { body: { email, password: PASSWORD } });
    const verified = await call('POST', '/api/v1/auth/mfa/verify', {
        body: { challengeId: challenge.body?.data?.challengeId, code: authenticator.generate(secret) },
    });
    if (verified.status !== 200) {
        throw new Error(`TOTP login failed for ${email}: ${JSON.stringify(verified.body)}`);
    }

    return sessionFrom(verified);
}

/** GET as this administrator. */
const get = (s: Session, path: string) => call('GET', path, { cookies: s.cookies });

/** A mutating call as this administrator, with the CSRF pair the guard requires. */
const write = (s: Session, method: string, path: string, body?: unknown) =>
    call(method, path, { cookies: s.cookies, csrf: s.csrf, body });

async function cleanup(): Promise<void> {
    const admins = await AdminAccountModel().find({ email: { $in: ALL_EMAILS } }, { _id: 1 });
    const ids = admins.map((a) => a._id);

    await ApprovalRequestModel().deleteMany({
        $or: [
            { requested_by: { $in: ids } },
            { target_id: { $in: ids.map((id) => id.toString()) } },
        ],
    });

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
        await cleanup();

        const accounts = new AdminAccountRepository();
        const passwordHash = await hash(PASSWORD);

        /**
         * `create` takes a REQUIRED `ClientSession` as of Phase 3.5 — the type is what
         * makes an unaudited administrator mutation fail to compile. These are fixtures,
         * not the audited path, so the harness opens its own transaction.
         */
        const make = async (email: string, tier: AdminTier, name: string) => {
            const session = await adminConnection().startSession();
            try {
                let created!: Awaited<ReturnType<typeof accounts.create>>;
                await session.withTransaction(async () => {
                    created = await accounts.create({ email, displayName: name, passwordHash, tier }, session);
                });
                return created;
            } finally {
                await session.endSession();
            }
        };

        const devA = await make(EMAIL.devA, 1, 'Verify Dev A');
        const devB = await make(EMAIL.devB, 1, 'Verify Dev B');
        const adminA = await make(EMAIL.adminA, 2, 'Verify Admin A');
        const adminB = await make(EMAIL.adminB, 2, 'Verify Admin B');
        const support = await make(EMAIL.support, 3, 'Verify Support');
        const victim = await make(EMAIL.victim, 3, 'Verify Victim');

        const app = createApp();
        server = await new Promise<Server>((resolve) => {
            const s = app.listen(0, () => resolve(s));
        });
        const address = server.address();
        port = typeof address === 'object' && address ? address.port : 0;

        const supportSession = await signIn(EMAIL.support);
        const adminSession = await signIn(EMAIL.adminA);

        // Tier 1 owes mandatory TOTP by default, so these run the full enrolment flow.
        const developersNeedMfa = env().ADMIN_MFA_REQUIRED_TIER >= 1;
        const devSession = developersNeedMfa ? await signInDeveloper(EMAIL.devA) : await signIn(EMAIL.devA);
        const devBSession = developersNeedMfa ? await signInDeveloper(EMAIL.devB) : await signIn(EMAIL.devB);

        // ── 1. The exit gate ──────────────────────────────────────────────────
        t.section('1. Blueprint exit gate — a Support administrator is denied an Admin endpoint');

        const supportListsAdmins = await get(supportSession, '/api/v1/administrators');
        t.assert('Support is refused the administrator directory (403)', () => supportListsAdmins.status === 403);
        t.assert('...with AUTHZ_PERMISSION_DENIED', () =>
            errorCode(supportListsAdmins) === ERROR_CODES.AUTHZ_PERMISSION_DENIED);
        t.assert('...naming the required permission', () =>
            supportListsAdmins.body?.error?.details?.required?.includes('administrators.read') === true);
        t.assert('...and NOT the caller’s own tier or holdings', () => {
            const details = JSON.stringify(supportListsAdmins.body?.error?.details ?? {});
            return !details.includes('actual') && !details.includes('"tier"');
        });

        const adminListsAdmins = await get(adminSession, '/api/v1/administrators');
        t.assert('an Admin reaches the same endpoint (200)', () => adminListsAdmins.status === 200);
        t.assert('...and gets a paginated list', () => Array.isArray(adminListsAdmins.body?.data));

        // ── 2. The permissions surface ────────────────────────────────────────
        t.section('2. Permissions surface');

        const supportMe = await get(supportSession, '/api/v1/permissions/me');
        t.assert('Support may read its own permissions', () => supportMe.status === 200);
        t.assert('...reporting tier 3 / Support', () =>
            supportMe.body?.data?.tier === 3 && supportMe.body?.data?.tierLabel === 'Support');
        t.assert('...including its ticket surface', () =>
            supportMe.body?.data?.permissions?.includes('support.tickets.read') === true);
        t.assert('...and excluding the money surface', () =>
            supportMe.body?.data?.permissions?.includes('cod.remittances.confirm') === false);

        const catalog = await get(supportSession, '/api/v1/permissions/catalog');
        t.assert('every administrator may read the catalog', () => catalog.status === 200);
        t.assert('...which lists more permissions than any one tier holds', () =>
            catalog.body?.data?.total > supportMe.body?.data?.permissions?.length);

        const supportTiers = await get(supportSession, '/api/v1/permissions/tiers');
        t.assert('Support is refused the full tier matrix', () => supportTiers.status === 403);

        const adminTiers = await get(adminSession, '/api/v1/permissions/tiers');
        t.assert('an Admin may read the tier matrix', () => adminTiers.status === 200);
        t.assert('...showing tier 1 holding strictly more than tier 2', () => {
            const tiers = adminTiers.body?.data?.tiers ?? [];
            const one = tiers.find((x: any) => x.tier === 1)?.total ?? 0;
            const two = tiers.find((x: any) => x.tier === 2)?.total ?? 0;
            return one > two && two > 0;
        });

        // ── 3. Self-service needs no permission ───────────────────────────────
        t.section('3. Self-service routes');

        const supportOwn = await get(supportSession, '/api/v1/administrators/me');
        t.assert('Support may read its OWN record despite lacking administrators.read', () =>
            supportOwn.status === 200);
        t.assert('...and it is their own record', () => supportOwn.body?.data?.email === EMAIL.support);

        const supportEditsSelf = await write(supportSession, 'PATCH', '/api/v1/administrators/me', {
            jobTitle: 'Support Lead',
        });
        t.assert('Support may edit its own profile', () => supportEditsSelf.status === 200);
        t.assert('...and the change took', () => supportEditsSelf.body?.data?.jobTitle === 'Support Lead');

        const supportClears = await write(supportSession, 'PATCH', '/api/v1/administrators/me', { jobTitle: '' });
        t.assert('clearable() lets an empty string clear the field', () =>
            supportClears.body?.data?.jobTitle === null);

        const supportEditsOther = await write(
            supportSession, 'PATCH', `/api/v1/administrators/${victim._id.toString()}`, { jobTitle: 'nope' },
        );
        t.assert('Support may NOT edit someone else’s profile', () => supportEditsOther.status === 403);

        // ── 4. Creating administrators ────────────────────────────────────────
        t.section('4. Creating administrators');

        const created = await write(adminSession, 'POST', '/api/v1/administrators', {
            email: 'verify-authz-created@example.test',
            displayName: 'Created By Admin',
            tier: 3,
        });
        t.assert('an Admin can create a Support administrator', () => created.status === 201);
        t.assert('...and is shown a one-time password exactly once', () =>
            typeof created.body?.data?.oneTimePassword === 'string'
            && created.body.data.oneTimePassword.length >= 12);
        t.assert('...with the creator recorded', () =>
            created.body?.data?.administrator?.createdBy === adminSession.adminId);
        t.assert('...and no password hash anywhere in the response', () =>
            !JSON.stringify(created.body).includes('password_hash'));

        if (created.status === 201) {
            await AdminAccountModel().deleteMany({ email: 'verify-authz-created@example.test' });
        }

        const createPeer = await write(adminSession, 'POST', '/api/v1/administrators', {
            email: 'verify-authz-peer@example.test',
            displayName: 'Peer Attempt',
            tier: 2,
        });
        t.assert('an Admin may NOT create a peer Admin', () => createPeer.status === 403);
        t.assert('...refused as tier escalation', () =>
            errorCode(createPeer) === ERROR_CODES.AUTHZ_TIER_ESCALATION_FORBIDDEN);

        const createDev = await write(adminSession, 'POST', '/api/v1/administrators', {
            email: 'verify-authz-dev-attempt@example.test',
            displayName: 'Dev Attempt',
            tier: 1,
        });
        t.assert('an Admin may NOT create a Developer', () => createDev.status === 403);

        const duplicate = await write(adminSession, 'POST', '/api/v1/administrators', {
            email: EMAIL.victim,
            displayName: 'Duplicate',
            tier: 3,
        });
        t.assert('a duplicate email is refused', () => duplicate.status === 409);
        t.assert('...with ADMIN_ACCOUNT_ALREADY_EXISTS', () =>
            errorCode(duplicate) === ERROR_CODES.ADMIN_ACCOUNT_ALREADY_EXISTS);

        // ── 5. Self-action and peer protection ────────────────────────────────
        t.section('5. Escalation rules over the wire');

        const suspendSelf = await write(
            adminSession, 'POST', `/api/v1/administrators/${adminSession.adminId}/suspend`,
            { reason: 'testing self-suspension' },
        );
        t.assert('an Admin cannot suspend themselves', () => suspendSelf.status === 403);
        t.assert('...refused as a self-action', () =>
            errorCode(suspendSelf) === ERROR_CODES.AUTHZ_SELF_ACTION_FORBIDDEN);

        const suspendPeer = await write(
            adminSession, 'POST', `/api/v1/administrators/${adminB._id.toString()}/suspend`,
            { reason: 'testing peer suspension' },
        );
        t.assert('an Admin cannot suspend another Admin', () => suspendPeer.status === 403);
        t.assert('...refused as a protected target', () =>
            errorCode(suspendPeer) === ERROR_CODES.AUTHZ_TARGET_TIER_PROTECTED);

        const suspendDev = await write(
            adminSession, 'POST', `/api/v1/administrators/${devA._id.toString()}/suspend`,
            { reason: 'testing upward suspension' },
        );
        t.assert('an Admin cannot suspend a Developer', () => suspendDev.status === 403);

        const setTierAsAdmin = await write(
            adminSession, 'PUT', `/api/v1/administrators/${victim._id.toString()}/tier`, { tier: 2 },
        );
        t.assert('an Admin cannot change anyone’s level at all', () => setTierAsAdmin.status === 403);
        t.assert('...because tier.set is Developer-only', () =>
            errorCode(setTierAsAdmin) === ERROR_CODES.AUTHZ_PERMISSION_DENIED);

        const reasonlessSuspend = await write(
            adminSession, 'POST', `/api/v1/administrators/${victim._id.toString()}/suspend`, {},
        );
        t.assert('suspension without a reason is refused (400)', () => reasonlessSuspend.status === 400);

        // ── 6. Suspension ends live sessions on the NEXT request ──────────────
        t.section('6. Session consequences');

        const victimSession = await signIn(EMAIL.victim);
        const victimBefore = await get(victimSession, '/api/v1/administrators/me');
        t.assert('the target can use their session before suspension', () => victimBefore.status === 200);

        const suspended = await write(
            adminSession, 'POST', `/api/v1/administrators/${victim._id.toString()}/suspend`,
            { reason: 'verified suspension' },
        );
        t.assert('an Admin CAN suspend a Support administrator', () => suspended.status === 200);
        t.assert('...recording who and why', () =>
            suspended.body?.data?.suspendedReason === 'verified suspension'
            && suspended.body?.data?.suspendedBy === adminSession.adminId);

        const victimAfter = await get(victimSession, '/api/v1/administrators/me');
        t.assert('the suspended session is dead on the very next request', () => victimAfter.status === 401);

        const reinstated = await write(
            adminSession, 'POST', `/api/v1/administrators/${victim._id.toString()}/reinstate`,
        );
        t.assert('reinstatement works', () => reinstated.status === 200);
        t.assert('...and clears the suspension record', () =>
            reinstated.body?.data?.suspendedReason === null && reinstated.body?.data?.status === 'active');

        const victimSession2 = await signIn(EMAIL.victim);
        const revoked = await write(
            adminSession, 'DELETE', `/api/v1/administrators/${victim._id.toString()}/sessions`,
        );
        t.assert('an Admin can sign a Support administrator out everywhere', () => revoked.status === 200);
        t.assert('...reporting how many sessions ended', () => revoked.body?.data?.revoked >= 1);

        const afterRevoke = await get(victimSession2, '/api/v1/administrators/me');
        t.assert('the revoked session is dead on the next request', () => afterRevoke.status === 401);

        const victimSession3 = await signIn(EMAIL.victim);
        const reset = await write(
            adminSession, 'POST', `/api/v1/administrators/${victim._id.toString()}/password-reset`,
        );
        t.assert('an Admin can reset a Support administrator’s password', () => reset.status === 200);
        t.assert('...and is shown the new password once', () =>
            typeof reset.body?.data?.oneTimePassword === 'string');

        const afterReset = await get(victimSession3, '/api/v1/administrators/me');
        t.assert('a password reset kills every existing session', () => afterReset.status === 401);

        const sessionRows = await AdminSessionModel().find({ admin_id: victim._id, ended_at: { $ne: null } });
        t.assert('the durable history records why each session ended', () =>
            sessionRows.some((row) => row.end_reason === 'account_suspended')
            && sessionRows.some((row) => row.end_reason === 'revoked_by_admin')
            && sessionRows.some((row) => row.end_reason === 'password_reset'));

        // Restore the password so later sections can still sign this account in.
        await AdminAccountModel().updateOne({ _id: victim._id }, { $set: { password_hash: passwordHash } });

        // ── 7. CSRF still applies to every new mutating route ─────────────────
        t.section('7. CSRF on the new surface');

        const noCsrf = await call('POST', `/api/v1/administrators/${victim._id.toString()}/suspend`, {
            cookies: adminSession.cookies,
            body: { reason: 'no csrf token supplied' },
        });
        t.assert('a cookie-authenticated mutation without a CSRF token is refused', () => noCsrf.status === 403);
        t.assert('...with the CSRF code, not the authorization one', () =>
            errorCode(noCsrf) === ERROR_CODES.ADMIN_AUTH_CSRF_INVALID);

        const badCsrf = await call('POST', `/api/v1/administrators/${victim._id.toString()}/suspend`, {
            cookies: adminSession.cookies,
            csrf: 'not-the-right-token',
            body: { reason: 'wrong csrf token' },
        });
        t.assert('a mismatched CSRF token is refused', () => badCsrf.status === 403);

        // ── 8. Four-eyes ──────────────────────────────────────────────────────
        t.section('8. Dual control');

        {
            const promote = await write(
                devSession, 'PUT', `/api/v1/administrators/${adminA._id.toString()}/tier`, { tier: 1 },
            );
            t.assert('promoting to Developer answers 202, not 403 — it is queued, not refused', () =>
                promote.status === 202);
            t.assert('...returning a pending approval', () => promote.body?.data?.status === 'pending');
            t.assert('...describing what an approver would be signing', () =>
                typeof promote.body?.data?.description === 'string'
                && promote.body.data.description.includes('Developer'));

            const approvalId = promote.body?.data?.id;

            const tierUnchanged = await get(devSession, `/api/v1/administrators/${adminA._id.toString()}`);
            t.assert('the level has NOT changed yet', () => tierUnchanged.body?.data?.tier === 2);

            const repeat = await write(
                devSession, 'PUT', `/api/v1/administrators/${adminA._id.toString()}/tier`, { tier: 1 },
            );
            t.assert('an identical request is idempotent — same approval, not a second one', () =>
                repeat.status === 202 && repeat.body?.data?.id === approvalId);

            const selfApprove = await write(devSession, 'POST', `/api/v1/approvals/${approvalId}/approve`, {});
            t.assert('the requester cannot approve their own request', () => selfApprove.status === 403);
            t.assert('...refused as self-approval', () =>
                errorCode(selfApprove) === ERROR_CODES.AUTHZ_APPROVAL_SELF_APPROVAL);

            const adminApproves = await write(adminSession, 'POST', `/api/v1/approvals/${approvalId}/approve`, {});
            t.assert('an Admin cannot approve a Developer-level action', () => adminApproves.status === 403);

            const queue = await get(devBSession, '/api/v1/approvals');
            t.assert('the pending queue is readable', () => queue.status === 200);
            t.assert('...and contains the request', () =>
                (queue.body?.data ?? []).some((row: any) => row.id === approvalId));

            const approved = await write(devBSession, 'POST', `/api/v1/approvals/${approvalId}/approve`, {
                note: 'verified by the second developer',
            });
            t.assert('a SECOND Developer can approve', () => approved.status === 200);
            t.assert('...and the approval records who decided it', () =>
                approved.body?.data?.approverId === devBSession.adminId
                && approved.body?.data?.status === 'approved');

            const promoted = await get(devSession, `/api/v1/administrators/${adminA._id.toString()}`);
            t.assert('the approval PERFORMED the promotion', () => promoted.body?.data?.tier === 1);
            t.assert('...recording who changed the level — the approver, not the requester', () =>
                promoted.body?.data?.tierChangedBy === devBSession.adminId);

            const adminSessionAfter = await get(adminSession, '/api/v1/administrators/me');
            t.assert('a level change kills the target’s live sessions', () => adminSessionAfter.status === 401);

            const tierChangeRow = await AdminSessionModel().findOne({
                admin_id: adminA._id, end_reason: 'tier_changed',
            });
            t.assert('...stamped as tier_changed, not as a revocation', () => tierChangeRow !== null);

            const reApprove = await write(devBSession, 'POST', `/api/v1/approvals/${approvalId}/approve`, {});
            t.assert('an already-decided approval cannot be approved twice', () => reApprove.status === 409);
            t.assert('...with ALREADY_RESOLVED', () =>
                errorCode(reApprove) === ERROR_CODES.AUTHZ_APPROVAL_ALREADY_RESOLVED);

            // Put it back so cleanup and any re-run start from a known state.
            await AdminAccountModel().updateOne({ _id: adminA._id }, { $set: { tier: 2 } });

            // ── withdrawal, rejection, expiry ──
            const demote = await write(
                devSession, 'PUT', `/api/v1/administrators/${adminB._id.toString()}/tier`, { tier: 1 },
            );
            const secondId = demote.body?.data?.id;

            const otherWithdraw = await write(devBSession, 'DELETE', `/api/v1/approvals/${secondId}`);
            t.assert('only the requester may withdraw a request', () => otherWithdraw.status === 404);

            const withdrawn = await write(devSession, 'DELETE', `/api/v1/approvals/${secondId}`);
            t.assert('the requester may withdraw their own', () =>
                withdrawn.status === 200 && withdrawn.body?.data?.status === 'withdrawn');

            const thirdRequest = await write(
                devSession, 'PUT', `/api/v1/administrators/${adminB._id.toString()}/tier`, { tier: 1 },
            );
            t.assert('a withdrawn request does not block a new one — the unique index is partial', () =>
                thirdRequest.status === 202 && thirdRequest.body?.data?.id !== secondId);

            const rejected = await write(
                devBSession, 'POST', `/api/v1/approvals/${thirdRequest.body?.data?.id}/reject`,
                { note: 'not now' },
            );
            t.assert('a second Developer can reject', () =>
                rejected.status === 200 && rejected.body?.data?.status === 'rejected');

            const stillTwo = await get(devSession, `/api/v1/administrators/${adminB._id.toString()}`);
            t.assert('the rejected promotion did not happen', () => stillTwo.body?.data?.tier === 2);

            // Expiry: age a fresh request past its deadline and confirm it is refused.
            const toExpire = await write(
                devSession, 'PUT', `/api/v1/administrators/${adminB._id.toString()}/tier`, { tier: 1 },
            );
            await ApprovalRequestModel().updateOne(
                { _id: toExpire.body?.data?.id },
                { $set: { expires_at: new Date(Date.now() - 60_000) } },
            );
            const expired = await write(
                devBSession, 'POST', `/api/v1/approvals/${toExpire.body?.data?.id}/approve`, {},
            );
            t.assert('an expired request cannot be approved', () => expired.status === 409);
            t.assert('...with AUTHZ_APPROVAL_EXPIRED', () =>
                errorCode(expired) === ERROR_CODES.AUTHZ_APPROVAL_EXPIRED);

            const expiredRow = await ApprovalRequestModel().findById(toExpire.body?.data?.id);
            t.assert('...and the row is stamped expired, not deleted', () => expiredRow?.status === 'expired');

            // ── a Developer suspending a peer Developer ──
            const suspendPeerDev = await write(
                devSession, 'POST', `/api/v1/administrators/${devB._id.toString()}/suspend`,
                { reason: 'containment drill' },
            );
            t.assert('suspending a peer Developer queues rather than applying', () =>
                suspendPeerDev.status === 202);

            const devBStillActive = await get(devBSession, '/api/v1/administrators/me');
            t.assert('...and the peer is still active until approved', () => devBStillActive.status === 200);

            await ApprovalRequestModel().updateOne(
                { _id: suspendPeerDev.body?.data?.id },
                { $set: { status: 'withdrawn', decided_at: new Date() } },
            );
        }

        // ── 9. Boot assertions ────────────────────────────────────────────────
        t.section('9. Boot assertions refuse a broken service');

        t.assert('the shipped grant table passes its own boot check', () => {
            try {
                assertGrantTableValid();
                return true;
            } catch {
                return false;
            }
        });

        t.assert('a route registered outside defineRoute() fails the manifest check', () => {
            // Deliberately bypass the helper, exactly as a careless future change would.
            const rogue = Router();
            rogue.get('/wide-open', (_req, res) => res.json({ ok: true }));

            const rogueApp = createApp();
            rogueApp.use('/api/v1/rogue', rogue);

            try {
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const { assertRouteManifestComplete } = require('../../src/api/route-manifest');
                assertRouteManifestComplete(rogueApp);
                return false;
            } catch (error) {
                return error instanceof AppError && error.code === ERROR_CODES.AUTHZ_ROUTE_UNDECLARED;
            }
        });

        void devA;
        void support;

        return t.finish();
    } finally {
        await cleanup().catch(() => undefined);
        if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
        await closeAll().catch(() => undefined);
        await closeRedisClients().catch(() => undefined);
    }
}

main()
    .then((code) => process.exit(code))
    .catch((error) => {
        console.error('\n❌ verify:authz failed to run\n', error);
        process.exit(1);
    });
