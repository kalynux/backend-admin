import { Request, Response } from 'express';
import { auditActorOf, requestContext } from '../../audit/domain/audit-context';
import { asyncHandler } from '../../../core/http/async-handler';
import { sendSuccess, sendMessage } from '../../../core/http/responses';
import { createAppError } from '../../../core/errors/app-error';
import { ERROR_CODES } from '../../../core/errors/error-codes';
import {
    ADMIN_COOKIE,
    accessCookieOptions,
    refreshCookieOptions,
    csrfCookieOptions,
    clearCookieOptions,
} from '../../../config/cookie.config';
import { generateCsrfToken } from '../../../api/middlewares/csrf.middleware';
import { requireAdminIdentity } from '../domain/admin-identity.types';
import { auditedTransaction } from '../../audit/domain/audit.writer';
import { ChangePasswordBody } from '../validators/auth.validator';
import * as auth from '../domain/admin-auth.service';
import * as sessions from '../domain/session.service';
import * as mfa from '../domain/mfa.service';
import { AdminAccountRepository } from '../repositories/admin-account.repository';
import { IssuedSession } from '../domain/admin-auth.service';

const accounts = new AdminAccountRepository();

/**
 * Auth HTTP surface.
 *
 * Tokens are returned BOTH as httpOnly cookies and in the response body. The cookies
 * serve a browser dashboard with no client-side token handling; the body serves
 * non-browser callers and any deployment where cross-site cookies are impractical. This
 * mirrors jovi-mall's cookie-or-bearer resolution rather than inventing a third scheme.
 */

/**
 * Set the auth cookie trio. The CSRF token is minted per session and is the only one
 * readable by JavaScript — the double-submit pattern requires the dashboard to echo it.
 */
function setSessionCookies(res: Response, session: IssuedSession): string {
    const csrfToken = generateCsrfToken();
    res.cookie(ADMIN_COOKIE.ACCESS, session.accessToken, accessCookieOptions());
    res.cookie(ADMIN_COOKIE.REFRESH, session.refreshToken, refreshCookieOptions());
    res.cookie(ADMIN_COOKIE.CSRF, csrfToken, csrfCookieOptions());
    return csrfToken;
}

function clearSessionCookies(res: Response): void {
    const options = clearCookieOptions();
    res.clearCookie(ADMIN_COOKIE.ACCESS, options);
    res.clearCookie(ADMIN_COOKIE.REFRESH, options);
    res.clearCookie(ADMIN_COOKIE.CSRF, options);
}

export class AuthController {
    /** POST /api/v1/auth/login */
    static login = asyncHandler(async (req: Request, res: Response) => {
        const { email, password } = req.body;
        const outcome = await auth.login(email, password, requestContext(req));

        if (outcome.kind === 'mfa_required') {
            // 200, not 401: the password was correct. This is a step in the flow, not a
            // failure, and the client must be able to tell the two apart.
            sendSuccess(res, {
                mfaRequired: true,
                challengeId: outcome.challengeId,
            }, { message: 'Enter your two-factor code' });
            return;
        }

        const csrfToken = setSessionCookies(res, outcome.session);

        if (outcome.kind === 'mfa_enrolment_required') {
            // A real session, but scoped: it reaches only /auth/mfa/*, /auth/me and
            // /auth/logout. The flag tells the dashboard to route straight to setup.
            sendSuccess(res, {
                admin: auth.toAdminProfile(outcome.admin),
                accessToken: outcome.session.accessToken,
                refreshToken: outcome.session.refreshToken,
                expiresIn: outcome.session.expiresIn,
                csrfToken,
                mfaEnrolmentRequired: true,
            }, { message: 'Two-factor authentication must be set up before continuing' });
            return;
        }

        sendSuccess(res, {
            admin: auth.toAdminProfile(outcome.admin),
            accessToken: outcome.session.accessToken,
            refreshToken: outcome.session.refreshToken,
            expiresIn: outcome.session.expiresIn,
            csrfToken,
        });
    });

    /** POST /api/v1/auth/mfa/verify */
    static verifyMfa = asyncHandler(async (req: Request, res: Response) => {
        const { challengeId, code } = req.body;
        const { admin, session } = await auth.completeMfa(challengeId, code, requestContext(req));

        const csrfToken = setSessionCookies(res, session);
        sendSuccess(res, {
            admin: auth.toAdminProfile(admin),
            accessToken: session.accessToken,
            refreshToken: session.refreshToken,
            expiresIn: session.expiresIn,
            csrfToken,
        });
    });

    /**
     * POST /api/v1/auth/refresh
     *
     * Reads the refresh token from the cookie, falling back to the body for non-browser
     * clients. Deliberately NOT authenticated by `requireAdmin`: the whole point is to
     * be callable once the access token has expired.
     */
    static refresh = asyncHandler(async (req: Request, res: Response) => {
        const token = req.cookies?.[ADMIN_COOKIE.REFRESH] ?? req.body?.refreshToken;
        if (typeof token !== 'string' || !token) {
            throw createAppError(ERROR_CODES.ADMIN_AUTH_MISSING_TOKEN, 401, 'No refresh token supplied');
        }

        try {
            const { admin, session } = await auth.refresh(token, requestContext(req));
            const csrfToken = setSessionCookies(res, session);
            sendSuccess(res, {
                admin: auth.toAdminProfile(admin),
                accessToken: session.accessToken,
                refreshToken: session.refreshToken,
                expiresIn: session.expiresIn,
                csrfToken,
            });
        } catch (error) {
            // Any refresh failure leaves the browser holding cookies that will never
            // work again. Clearing them turns a confusing loop of failed retries into a
            // clean redirect to the login screen.
            clearSessionCookies(res);
            throw error;
        }
    });

    /** POST /api/v1/auth/logout — revokes THIS session server-side, not just the cookies. */
    static logout = asyncHandler(async (req: Request, res: Response) => {
        const identity = requireAdminIdentity(req);
        await auth.logout(identity, requestContext(req));
        clearSessionCookies(res);
        sendMessage(res, 'Signed out');
    });

    /** POST /api/v1/auth/logout-all */
    static logoutAll = asyncHandler(async (req: Request, res: Response) => {
        const identity = requireAdminIdentity(req);
        const count = await auth.logoutAll(identity, requestContext(req));
        clearSessionCookies(res);
        sendSuccess(res, { sessionsEnded: count }, { message: 'Signed out of all sessions' });
    });

    /** GET /api/v1/auth/me */
    static me = asyncHandler(async (req: Request, res: Response) => {
        const identity = requireAdminIdentity(req);
        const admin = await accounts.findById(identity.adminId);
        if (!admin) throw createAppError(ERROR_CODES.ADMIN_ACCOUNT_NOT_FOUND, 404);

        sendSuccess(res, {
            admin: auth.toAdminProfile(admin),
            session: {
                sessionId: identity.sessionId,
                authenticatedAt: identity.authenticatedAt.toISOString(),
                expiresAt: identity.sessionExpiresAt.toISOString(),
                authMethod: identity.authMethod,
            },
        });
    });

    /** GET /api/v1/auth/sessions */
    static listSessions = asyncHandler(async (req: Request, res: Response) => {
        const identity = requireAdminIdentity(req);
        const live = await sessions.listSessions(identity.adminId, identity.sessionId);
        sendSuccess(res, live);
    });

    /** DELETE /api/v1/auth/sessions/:sessionId */
    static revokeSession = asyncHandler(async (req: Request, res: Response) => {
        const identity = requireAdminIdentity(req);
        await auth.revokeSession(identity, req.params.sessionId, requestContext(req));
        // Revoking your own current session is legitimate — it is "sign out on this
        // device" from the session list — so clear the cookies when that happens.
        if (req.params.sessionId === identity.sessionId) clearSessionCookies(res);
        sendMessage(res, 'Session revoked');
    });

    /**
     * POST /api/v1/auth/mfa/enroll
     *
     * Issues a secret but does NOT activate it. The plaintext secret is returned exactly
     * once, here, so the admin can type it if the QR will not scan.
     */
    static enrolMfa = asyncHandler(async (req: Request, res: Response) => {
        const identity = requireAdminIdentity(req);
        const admin = await accounts.findById(identity.adminId);
        if (!admin) throw createAppError(ERROR_CODES.ADMIN_ACCOUNT_NOT_FOUND, 404);

        if (admin.mfa_enrolled) {
            // Re-enrolling would silently invalidate the authenticator the admin is
            // currently relying on. Disabling first must be an explicit, separate act.
            throw createAppError(ERROR_CODES.ADMIN_AUTH_MFA_ALREADY_ENROLLED, 409);
        }

        const offer = mfa.beginEnrolment(admin.email);

        // Audited transactionally, not best-effort: this WRITES to the account row
        // (`mfa_secret`), so it is a state change rather than an observation. Note what the
        // row does not contain — the secret is redacted by name even if a caller passed it,
        // and nothing here passes it.
        await auditedTransaction(
            {
                action: 'administrators.auth.mfa_enrolled',
                actor: auditActorOf(identity),
                target: { type: 'administrator', id: identity.adminId, label: identity.email },
                context: requestContext(req),
            },
            async (session) => {
                await accounts.stageMfaSecret(identity.adminId, offer.encryptedSecret, session);
                return { result: true, after: { mfaSecretStaged: true } };
            },
        );

        sendSuccess(res, {
            secret: offer.secret,
            otpauthUri: offer.otpauthUri,
        }, { message: 'Scan the QR code, then confirm with a code to activate' });
    });

    /** POST /api/v1/auth/mfa/activate — a correct code proves the authenticator holds the secret. */
    static activateMfa = asyncHandler(async (req: Request, res: Response) => {
        const identity = requireAdminIdentity(req);

        // The guards, the code check, the lockout counter and both audit rows all live in
        // the service. They were inline here until Phase 12, which is how the activation
        // path came to accept unlimited code guesses without counting or recording one —
        // see `activateMfa`'s header.
        await auth.activateMfa(identity, req.body.code, requestContext(req));

        if (identity.pendingMfaEnrolment) {
            // The session that got here was password-only. Upgrading it in place would
            // hand out a full session that never presented a second factor — exactly what
            // the requirement forbids. End it and make them sign in properly, now that
            // they can.
            await auth.logout(identity, requestContext(req));
            clearSessionCookies(res);
            sendSuccess(res, { reauthenticationRequired: true }, {
                message: 'Two-factor authentication is active. Sign in again with your code.',
            });
            return;
        }

        sendMessage(res, 'Two-factor authentication is now active');
    });

    /**
     * POST /api/v1/auth/password — change your OWN password.
     *
     * Until this existed there was no self-service change anywhere in the service: an
     * administrator handed a generated password by whoever created them kept it, and that
     * person kept a working credential for the account indefinitely.
     *
     * The current password is required, so a hijacked session cannot lock the real owner
     * out. Every OTHER session is ended; the caller keeps theirs.
     */
    static changePassword = asyncHandler(async (req: Request, res: Response) => {
        const identity = requireAdminIdentity(req);
        const body = req.body as ChangePasswordBody;

        const result = await auth.changeOwnPassword(
            identity,
            body.currentPassword,
            body.newPassword,
            requestContext(req),
        );

        sendSuccess(res, result, {
            message: result.sessionsEnded > 0
                ? `Password changed. ${result.sessionsEnded} other session(s) were signed out.`
                : 'Password changed.',
        });
    });
}
