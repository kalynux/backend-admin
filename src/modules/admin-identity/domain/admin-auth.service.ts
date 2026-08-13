import { createAppError } from '../../../core/errors/app-error';
import { ERROR_CODES } from '../../../core/errors/error-codes';
import { logger } from '../../../core/logging/logger';
import { AdminAccountRepository } from '../repositories/admin-account.repository';
import { IAdminAccount } from '../models/admin-account.model';
import { AdminIdentity, AdminTier } from './admin-identity.types';
import * as passwords from './password.service';
import * as tokens from './token.service';
import * as sessions from './session.service';
import * as lockout from './lockout.service';
import * as mfa from './mfa.service';
import { auditedTransaction, recordEvent } from '../../audit/domain/audit.writer';
import { AuditAction } from '../../audit/domain/audit.catalog';
import { AuditContext } from '../../audit/domain/audit.types';
import { auditActorOf } from '../../audit/domain/audit-context';

/**
 * Authentication orchestration — the login/refresh/logout flow.
 *
 * The ordering inside `login()` is the security-relevant part and is commented at each
 * step. In particular, EVERY failure path costs a bcrypt comparison and returns the
 * same error code, so response time and response body both refuse to say whether an
 * account exists.
 */

const accounts = new AdminAccountRepository();

/**
 * Record an identity event.
 *
 * **Best-effort, and that is a decision rather than an omission.** Every state-changing
 * action in this service is fail-closed — it does not happen if it cannot be audited. This
 * is the deliberate exception, for two reasons: there is nothing to roll back (the login
 * already succeeded or failed on its own terms), and applying the rule here would mean an
 * audit-store outage blocks every login, including the one needed to fix it. The codebase
 * already ruled the same way for the same data — `session.service.ts` writes its durable
 * session row inside a try/catch because "failing to write history must not deny a valid
 * login". A failure here is logged at `fatal`.
 */
function recordIdentityEvent(
    action: AuditAction,
    status: 'succeeded' | 'failed',
    context: AuditContext,
    subject: { id: string | null; email: string | null; tier: number | null; sessionId?: string | null },
    detail?: { payload?: Record<string, unknown>; code?: string },
): void {
    recordEvent(
        {
            action,
            actor: {
                // No account matched, so there is genuinely no actor — recording one would
                // be a lie, and `anonymous` is what makes a spray across many addresses
                // from one IP visible as the pattern it is.
                kind: subject.id ? 'administrator' : 'anonymous',
                id: subject.id,
                email: subject.email,
                displayName: null,
                tier: subject.tier,
                sessionId: subject.sessionId ?? null,
            },
            target: { type: 'administrator', id: subject.id, label: subject.email },
            context: {
                method: context.method,
                path: context.path,
                requestId: context.requestId,
                ip: context.ip,
                userAgent: context.userAgent,
            },
            payload: detail?.payload ?? null,
        },
        status,
        detail?.code ? { code: detail.code } : undefined,
    );
}

export interface IssuedSession {
    accessToken: string;
    refreshToken: string;
    sessionId: string;
    expiresIn: number;
}

export type LoginOutcome =
    | { kind: 'authenticated'; admin: IAdminAccount; session: IssuedSession }
    | { kind: 'mfa_required'; challengeId: string }
    /** Password accepted, but this tier must enrol two-factor before doing anything else. */
    | { kind: 'mfa_enrolment_required'; admin: IAdminAccount; session: IssuedSession };

/** The public shape of an admin. Never carries `password_hash` or `mfa_secret`. */
export interface AdminProfileDto {
    id: string;
    email: string;
    displayName: string;
    tier: AdminTier;
    status: string;
    jobTitle: string | null;
    department: string | null;
    timezone: string;
    preferredLanguage: string;
    mfaEnrolled: boolean;
    mfaRequired: boolean;
    lastLoginAt: string | null;
    createdAt: string;
}

export function toAdminProfile(admin: IAdminAccount): AdminProfileDto {
    return {
        id: admin._id.toString(),
        email: admin.email,
        displayName: admin.display_name,
        tier: admin.tier,
        status: admin.status,
        jobTitle: admin.job_title,
        department: admin.department,
        timezone: admin.timezone,
        preferredLanguage: admin.preferred_language,
        mfaEnrolled: admin.mfa_enrolled,
        mfaRequired: mfa.mfaRequiredForTier(admin.tier),
        lastLoginAt: admin.last_login_at ? admin.last_login_at.toISOString() : null,
        createdAt: admin.created_at.toISOString(),
    };
}

async function issueSession(
    admin: IAdminAccount,
    context: AuditContext,
    mfaUsed: boolean,
    pendingMfaEnrolment = false,
): Promise<IssuedSession> {
    const sessionId = tokens.newSessionId();
    const refreshToken = tokens.signRefreshToken(admin._id.toString(), sessionId);
    const accessToken = tokens.signAccessToken(admin._id.toString(), sessionId, admin.tier);

    await sessions.createSession({
        sessionId,
        adminId: admin._id.toString(),
        tier: admin.tier,
        refreshToken,
        ip: context.ip,
        userAgent: context.userAgent,
        mfaUsed,
        pendingMfaEnrolment,
    });

    await accounts.recordSuccessfulLogin(admin._id.toString(), context.ip);
    await lockout.clearFailures(admin._id.toString());

    // One row per session actually issued, which is the honest definition of "signed in":
    // an MFA challenge that is never answered mints no session and is not a login.
    recordIdentityEvent(
        'administrators.auth.login_succeeded', 'succeeded', context,
        { id: admin._id.toString(), email: admin.email, tier: admin.tier, sessionId },
        { payload: { mfaUsed, scoped: pendingMfaEnrolment } },
    );

    return { accessToken, refreshToken, sessionId, expiresIn: tokens.accessTokenTtl() };
}

export async function login(
    email: string,
    password: string,
    context: AuditContext,
): Promise<LoginOutcome> {
    const log = logger();
    const admin = await accounts.findByEmail(email);

    // 1. Unknown account — still burn a bcrypt comparison, then answer exactly as a
    //    wrong password does. jovi-mall throws before comparing here, which makes its
    //    login endpoint an account-existence oracle by timing.
    if (!admin) {
        await passwords.verifyAgainstDummy(password);
        log.warn({ email, ip: context.ip }, 'admin login failed: no such account');
        // The attempted address goes in the payload. It is not a credential, and a spray
        // across many addresses from one IP is exactly the pattern this row exists to make
        // visible — which an anonymous row with no address could not show.
        recordIdentityEvent(
            'administrators.auth.login_failed', 'failed', context,
            { id: null, email: null, tier: null },
            { payload: { email, reason: 'no_such_account' }, code: ERROR_CODES.ADMIN_AUTH_INVALID_CREDENTIALS },
        );
        throw createAppError(ERROR_CODES.ADMIN_AUTH_INVALID_CREDENTIALS, 401);
    }

    const adminId = admin._id.toString();

    // 2. Lockout BEFORE the password check, so a locked account cannot be probed and so
    //    guesses during a lock do not extend it further.
    const lockState = await lockout.getLockState(adminId);
    if (lockState.locked) {
        log.warn({ adminId, ip: context.ip, retryAfter: lockState.retryAfterSeconds }, 'admin login blocked: locked');
        recordIdentityEvent(
            'administrators.auth.login_failed', 'failed', context,
            { id: adminId, email: admin.email, tier: admin.tier },
            { payload: { reason: 'locked_out' }, code: ERROR_CODES.ADMIN_AUTH_ACCOUNT_LOCKED },
        );
        throw createAppError(ERROR_CODES.ADMIN_AUTH_ACCOUNT_LOCKED, 423, undefined, {
            retryAfterSeconds: lockState.retryAfterSeconds,
        });
    }

    // 3. The password check — and its result is USED. This is the line jovi-mall
    //    commented out, which is why any password authenticates any account there.
    const valid = await passwords.verify(password, admin.password_hash);
    if (!valid) {
        const state = await lockout.recordFailure(adminId);
        await accounts.recordFailedAttempt(
            adminId,
            state.failedAttempts,
            state.locked ? new Date(Date.now() + state.retryAfterSeconds * 1000) : null,
        );
        log.warn({ adminId, ip: context.ip, attempts: state.failedAttempts }, 'admin login failed: bad password');

        recordIdentityEvent(
            'administrators.auth.login_failed', 'failed', context,
            { id: adminId, email: admin.email, tier: admin.tier },
            {
                payload: { reason: 'bad_password', failedAttempts: state.failedAttempts },
                code: ERROR_CODES.ADMIN_AUTH_INVALID_CREDENTIALS,
            },
        );

        // A separate row when this attempt is the one that engaged the lock — the moment
        // an account crosses into lockout is a different event from the failure that
        // caused it, and it is the one worth alerting on.
        if (state.locked) {
            recordIdentityEvent(
                'administrators.auth.lockout_engaged', 'succeeded', context,
                { id: adminId, email: admin.email, tier: admin.tier },
                { payload: { failedAttempts: state.failedAttempts, retryAfterSeconds: state.retryAfterSeconds } },
            );
        }

        throw createAppError(ERROR_CODES.ADMIN_AUTH_INVALID_CREDENTIALS, 401);
    }

    // 4. Suspension is checked AFTER the password, so the endpoint does not reveal which
    //    addresses belong to suspended admins to someone who cannot authenticate.
    if (admin.status === 'suspended') {
        log.warn({ adminId, ip: context.ip }, 'admin login refused: suspended');
        // Worth its own row: a suspended administrator still presenting the correct
        // password means someone is trying, and knows the credential.
        recordIdentityEvent(
            'administrators.auth.login_failed', 'failed', context,
            { id: adminId, email: admin.email, tier: admin.tier },
            { payload: { reason: 'suspended' }, code: ERROR_CODES.ADMIN_AUTH_ACCOUNT_SUSPENDED },
        );
        throw createAppError(ERROR_CODES.ADMIN_AUTH_ACCOUNT_SUSPENDED, 403);
    }

    // 5. A tier that must hold MFA but has not enrolled gets a SCOPED session: enough to
    //    reach the enrolment endpoints, nothing more. Refusing outright would deadlock —
    //    enrolment requires a session, and the first bootstrapped tier-1 admin would
    //    never be able to obtain one. Granting a full session would make the requirement
    //    advisory. The scoped session is the only answer that is neither.
    if (mfa.mfaRequiredForTier(admin.tier) && !admin.mfa_enrolled) {
        const session = await issueSession(admin, context, false, true);
        log.warn(
            { adminId, tier: admin.tier, sessionId: session.sessionId },
            'admin signed in with a scoped session: MFA enrolment required',
        );
        return { kind: 'mfa_enrolment_required', admin, session };
    }

    // 6. Enrolled ⇒ half-authenticated. No session and no token exists yet: a session
    //    minted before the second factor is a session that skipped it.
    if (admin.mfa_enrolled) {
        const challengeId = await mfa.createChallenge({ adminId, ip: context.ip, userAgent: context.userAgent });
        log.info({ adminId }, 'admin login: MFA challenge issued');

        /**
         * The password was correct. That is the fact worth recording.
         *
         * Until Phase 12 this was a log line only, which left a real blind spot: a
         * successful password followed by silence is indistinguishable, in the trail, from
         * a failed password — and it is the opposite situation. A run of challenges issued
         * and never completed means somebody HAS a working password and is stuck on the
         * second factor, which is what a credential-stuffing success looks like from here.
         *
         * `succeeded` because the challenge was issued, not because anybody is in yet;
         * `login_succeeded` still fires only when a session is minted.
         */
        recordIdentityEvent(
            'administrators.auth.mfa_challenged', 'succeeded', context,
            { id: adminId, email: admin.email, tier: admin.tier },
            { payload: { reason: 'password_accepted_second_factor_required' } },
        );

        return { kind: 'mfa_required', challengeId };
    }

    const session = await issueSession(admin, context, false);
    log.info({ adminId, sessionId: session.sessionId, ip: context.ip }, 'admin login succeeded');
    return { kind: 'authenticated', admin, session };
}

export async function completeMfa(
    challengeId: string,
    code: string,
    context: AuditContext,
): Promise<{ admin: IAdminAccount; session: IssuedSession }> {
    const log = logger();

    const challenge = await mfa.readChallenge(challengeId);
    if (!challenge) {
        throw createAppError(ERROR_CODES.ADMIN_AUTH_MFA_INVALID, 401, 'Challenge expired — sign in again');
    }

    const admin = await accounts.findById(challenge.adminId);
    if (!admin || !admin.mfa_secret) {
        await mfa.consumeChallenge(challengeId);
        throw createAppError(ERROR_CODES.ADMIN_AUTH_MFA_INVALID, 401);
    }

    if (!mfa.verifyCode(code, admin.mfa_secret)) {
        // A wrong code counts toward lockout — otherwise the second factor is an
        // unlimited 6-digit guessing game once a password is known.
        const state = await lockout.recordFailure(challenge.adminId);
        log.warn({ adminId: challenge.adminId, attempts: state.failedAttempts }, 'admin MFA failed');

        // Distinct from a failed password: whoever is here already HAS the password. A run
        // of these is a different and more serious signal than a run of login failures.
        recordIdentityEvent(
            'administrators.auth.mfa_failed', 'failed', context,
            { id: challenge.adminId, email: admin.email, tier: admin.tier },
            { payload: { failedAttempts: state.failedAttempts }, code: ERROR_CODES.ADMIN_AUTH_MFA_INVALID },
        );

        // The challenge SURVIVES a wrong code: consuming it on a typo would force the
        // admin back through the password step.
        throw createAppError(ERROR_CODES.ADMIN_AUTH_MFA_INVALID, 401);
    }

    if (admin.status === 'suspended') {
        await mfa.consumeChallenge(challengeId);
        throw createAppError(ERROR_CODES.ADMIN_AUTH_ACCOUNT_SUSPENDED, 403);
    }

    await mfa.consumeChallenge(challengeId);
    const session = await issueSession(admin, context, true);
    log.info({ adminId: admin._id.toString(), sessionId: session.sessionId }, 'admin login succeeded (MFA)');
    return { admin, session };
}

/**
 * Rotate a refresh token.
 *
 * Presenting a SUPERSEDED refresh token destroys the whole session. There are only two
 * ways to hold one — keeping a copy, or stealing it — and both mean the credential is
 * loose. jovi-mall never rotates, so it has no equivalent signal at all.
 */
export async function refresh(
    refreshToken: string,
    context: AuditContext,
): Promise<{ admin: IAdminAccount; session: IssuedSession }> {
    const log = logger();
    const claims = tokens.verifyRefreshToken(refreshToken);

    const lookup = await sessions.getSession(claims.sid, false);
    if (lookup.status === 'missing') {
        throw createAppError(ERROR_CODES.ADMIN_AUTH_SESSION_REVOKED, 401);
    }
    if (lookup.status === 'absolute_expired') {
        throw createAppError(ERROR_CODES.ADMIN_AUTH_SESSION_EXPIRED, 401);
    }

    const admin = await accounts.findById(claims.sub);
    if (!admin) {
        await sessions.destroySession(claims.sid, claims.sub, 'revoked_by_admin');
        throw createAppError(ERROR_CODES.ADMIN_AUTH_SESSION_REVOKED, 401);
    }
    if (admin.status === 'suspended') {
        const ended = await sessions.destroyAllSessions(claims.sub, 'account_suspended');

        // Recorded because this is the moment a suspension actually bites. Until Phase 12
        // it cut every device silently, so the trail showed the decision and never its
        // effect — and `RevokeForAgent`-style confusion ("was it really enforced?") had no
        // answer. Only when something was cut: an already-evicted client retrying would
        // otherwise write a row per poll.
        if (ended > 0) {
            recordIdentityEvent(
                'administrators.auth.session_terminated', 'succeeded', context,
                { id: claims.sub, email: admin.email, tier: admin.tier, sessionId: claims.sid },
                { payload: { reason: 'account_suspended', sessionsEnded: ended, via: 'refresh' } },
            );
        }

        throw createAppError(ERROR_CODES.ADMIN_AUTH_ACCOUNT_SUSPENDED, 403);
    }

    const nextRefresh = tokens.signRefreshToken(claims.sub, claims.sid);
    const rotated = await sessions.rotateRefreshToken(claims.sid, refreshToken, nextRefresh);

    if (!rotated) {
        await sessions.destroySession(claims.sid, claims.sub, 'refresh_reuse_detected');
        log.error({ adminId: claims.sub, sessionId: claims.sid, ip: context.ip }, 'refresh token reuse — session destroyed');

        // 🔑 The highest-value row in the log. There are only two ways to hold a superseded
        // refresh token — keeping a copy, or stealing it — and both mean the credential is
        // loose. Alert on this one. (A successful refresh is deliberately NOT audited: it
        // happens once per session per 15 minutes and would drown the feed.)
        recordIdentityEvent(
            'administrators.auth.refresh_reuse_detected', 'failed', context,
            { id: claims.sub, email: admin.email, tier: admin.tier, sessionId: claims.sid },
            { code: ERROR_CODES.ADMIN_AUTH_REFRESH_REUSED },
        );

        throw createAppError(ERROR_CODES.ADMIN_AUTH_REFRESH_REUSED, 401);
    }

    // Re-read the tier from the account rather than the old token, so a demotion takes
    // effect on the next refresh instead of persisting for the session's lifetime.
    const accessToken = tokens.signAccessToken(claims.sub, claims.sid, admin.tier);

    return {
        admin,
        session: {
            accessToken,
            refreshToken: nextRefresh,
            sessionId: claims.sid,
            expiresIn: tokens.accessTokenTtl(),
        },
    };
}

/**
 * Turn on MFA after enrolment, proving possession of the authenticator first.
 *
 * ── Why this lives here rather than in the controller (Phase 12) ──────────────
 * It used to be inline in `auth.controller.ts`, and the code check sat OUTSIDE any service:
 * a wrong code threw a bare 401, counted toward no lockout and recorded nothing. Meanwhile
 * `completeMfa` — the same six digits against the same secret, one step later in the same
 * flow — counted every failure and recorded `mfa_failed`.
 *
 * That asymmetry was a **security bug, not a logging gap**: an attacker holding a stolen
 * mid-enrolment session could brute-force the activation code without limit and without
 * leaving a trace, while the identical guess at login was rate-limited after a handful.
 * Moving it here is what makes the two paths share the lockout counter, because the
 * counter lives beside them.
 *
 * The activation write itself stays fail-closed in a transaction: turning MFA on is a
 * change to how the account authenticates, and ADR-006 D-1 puts that in the first column.
 */
export async function activateMfa(
    identity: AdminIdentity,
    code: string,
    context: AuditContext,
): Promise<void> {
    const admin = await accounts.findById(identity.adminId);
    if (!admin) throw createAppError(ERROR_CODES.ADMIN_ACCOUNT_NOT_FOUND, 404);
    if (admin.mfa_enrolled) throw createAppError(ERROR_CODES.ADMIN_AUTH_MFA_ALREADY_ENROLLED, 409);
    if (!admin.mfa_secret) throw createAppError(ERROR_CODES.ADMIN_AUTH_MFA_NOT_ENROLLED, 409);

    if (!mfa.verifyCode(code, admin.mfa_secret)) {
        // Exactly what `completeMfa` does with a wrong code, for exactly the same reason.
        const state = await lockout.recordFailure(identity.adminId);
        logger().warn(
            { adminId: identity.adminId, attempts: state.failedAttempts },
            'admin MFA activation code failed',
        );

        recordIdentityEvent(
            'administrators.auth.mfa_failed', 'failed', context,
            { id: identity.adminId, email: admin.email, tier: admin.tier },
            {
                payload: { failedAttempts: state.failedAttempts, phase: 'activation' },
                code: ERROR_CODES.ADMIN_AUTH_MFA_INVALID,
            },
        );

        throw createAppError(ERROR_CODES.ADMIN_AUTH_MFA_INVALID, 401);
    }

    await auditedTransaction(
        {
            action: 'administrators.auth.mfa_activated',
            actor: auditActorOf(identity),
            target: { type: 'administrator', id: identity.adminId, label: identity.email },
            context,
        },
        async (session) => {
            await accounts.activateMfa(identity.adminId, session);
            return { result: true, before: { mfaEnrolled: false }, after: { mfaEnrolled: true } };
        },
    );
}

/**
 * The three self-service session endings.
 *
 * Recorded, not fail-closed: they land in Redis, and an administrator signing themselves
 * out must not be refused because the audit store is unreachable — they would be left
 * signed in, which is the worse outcome of the two.
 */
export async function logout(identity: AdminIdentity, context: AuditContext): Promise<void> {
    await sessions.destroySession(identity.sessionId, identity.adminId, 'logout');
    logger().info({ adminId: identity.adminId, sessionId: identity.sessionId }, 'admin logged out');

    recordIdentityEvent(
        'administrators.auth.logout', 'succeeded', context,
        { id: identity.adminId, email: identity.email, tier: identity.tier, sessionId: identity.sessionId },
    );
}

export async function logoutAll(identity: AdminIdentity, context: AuditContext): Promise<number> {
    const count = await sessions.destroyAllSessions(identity.adminId, 'logout_all');
    logger().info({ adminId: identity.adminId, count }, 'admin logged out of all sessions');

    recordIdentityEvent(
        'administrators.auth.logout_all', 'succeeded', context,
        { id: identity.adminId, email: identity.email, tier: identity.tier, sessionId: identity.sessionId },
        { payload: { sessionsEnded: count } },
    );

    return count;
}

export async function revokeSession(
    identity: AdminIdentity,
    sessionId: string,
    context: AuditContext,
): Promise<void> {
    const lookup = await sessions.getSession(sessionId, false);
    // Scoped to the caller's own sessions: revoking someone else's is an administrative
    // action over another account, which belongs behind tier enforcement, not here.
    if (lookup.status !== 'live' || lookup.record.adminId !== identity.adminId) {
        throw createAppError(ERROR_CODES.ADMIN_SESSION_NOT_FOUND, 404);
    }
    await sessions.destroySession(sessionId, identity.adminId, 'revoked_by_admin');

    recordEvent(
        {
            action: 'administrators.auth.session_revoked',
            actor: {
                kind: 'administrator',
                id: identity.adminId,
                email: identity.email,
                displayName: identity.displayName,
                tier: identity.tier,
                sessionId: identity.sessionId,
            },
            // The target is the SESSION that ended, not the administrator — they are both
            // actor and owner here, and the interesting object is the device.
            target: { type: 'admin_session', id: sessionId, label: null },
            relatedTarget: { type: 'administrator', id: identity.adminId, label: identity.email },
            context: {
                method: context.method,
                path: context.path,
                requestId: context.requestId,
                ip: context.ip,
                userAgent: context.userAgent,
            },
        },
        'succeeded',
    );
}

/**
 * Change your own password.
 *
 * ── Why this did not exist ────────────────────────────────────────────────────
 * It simply was not built. An administrator created through the API is handed a generated
 * password by whoever created them, and until now had **no way to change it** — so the
 * creator knew a working credential for that account indefinitely. `password.service.ts`
 * had the policy check and the hash; nothing called them for a self-service change.
 *
 * Fail-closed, unlike the identity events above: this is a state change to the account
 * row, so it goes through a transaction with its audit row.
 */
export async function changeOwnPassword(
    identity: AdminIdentity,
    currentPassword: string,
    newPassword: string,
    context: AuditContext,
): Promise<{ sessionsEnded: number }> {
    const admin = await accounts.findById(identity.adminId);
    if (!admin) {
        throw createAppError(ERROR_CODES.ADMIN_ACCOUNT_NOT_FOUND, 404);
    }

    // The current password is required so a hijacked session cannot lock the real owner
    // out of their own account.
    if (!(await passwords.verify(currentPassword, admin.password_hash))) {
        recordIdentityEvent(
            'administrators.auth.password_changed', 'failed', context,
            { id: identity.adminId, email: identity.email, tier: identity.tier, sessionId: identity.sessionId },
            { code: ERROR_CODES.ADMIN_AUTH_INVALID_CREDENTIALS },
        );
        throw createAppError(ERROR_CODES.ADMIN_AUTH_INVALID_CREDENTIALS, 401);
    }

    /**
     * Throws 422 ADMIN_AUTH_PASSWORD_WEAK with the specific problems.
     *
     * Caught so the rejection is recorded. The wrong-current-password branch above already
     * writes a `failed` row, and without this the OTHER way to fail this endpoint left no
     * trace — so a run of attempts by somebody holding a session but not the password
     * looked, in the trail, like nothing at all. The row carries no password material: only
     * the code, which says the policy refused it.
     */
    let passwordHash: string;
    try {
        passwordHash = await passwords.hash(newPassword);
    } catch (error) {
        recordIdentityEvent(
            'administrators.auth.password_changed', 'failed', context,
            { id: identity.adminId, email: identity.email, tier: identity.tier, sessionId: identity.sessionId },
            { code: ERROR_CODES.ADMIN_AUTH_PASSWORD_WEAK, payload: { rejected: 'policy' } },
        );
        throw error;
    }

    await auditedTransaction(
        {
            action: 'administrators.auth.password_changed',
            actor: {
                kind: 'administrator',
                id: identity.adminId,
                email: identity.email,
                displayName: identity.displayName,
                tier: identity.tier,
                sessionId: identity.sessionId,
            },
            target: { type: 'administrator', id: identity.adminId, label: identity.email },
            context: {
                method: context.method,
                path: context.path,
                requestId: context.requestId,
                ip: context.ip,
                userAgent: context.userAgent,
            },
        },
        async (session) => {
            const updated = await accounts.setPasswordHash(identity.adminId, passwordHash, session);
            if (!updated) throw createAppError(ERROR_CODES.ADMIN_ACCOUNT_NOT_FOUND, 404);
            // Neither password nor hash — the fact is what an auditor needs.
            return { result: true, after: { passwordRotated: true } };
        },
    );

    // Post-commit, and every OTHER session dies. The caller keeps theirs: signing someone
    // out of the device they are actively using because they changed their password is
    // punishing the correct behaviour.
    const ended = await sessions.destroyOtherSessions(
        identity.adminId,
        identity.sessionId,
        'password_reset',
    );

    return { sessionsEnded: ended };
}

export { accounts as adminAccountRepository };
