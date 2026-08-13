import { Request, Response, NextFunction } from 'express';
import { recordEvent } from '../../modules/audit/domain/audit.writer';
import { requestContext } from '../../modules/audit/domain/audit-context';
import { createAppError } from '../../core/errors/app-error';
import { ERROR_CODES } from '../../core/errors/error-codes';
import { asyncHandler } from '../../core/http/async-handler';
import { ADMIN_COOKIE } from '../../config/cookie.config';
import { verifyAccessToken } from '../../modules/admin-identity/domain/token.service';
import * as sessions from '../../modules/admin-identity/domain/session.service';
import { AdminAccountRepository } from '../../modules/admin-identity/repositories/admin-account.repository';
import { AdminAuthMethod, AdminIdentity } from '../../modules/admin-identity/domain/admin-identity.types';
import { identityRateLimiter } from './rate-limit.middleware';

/**
 * `requireAdmin` — the authentication gate.
 *
 * Resolution order matches jovi-mall (cookie first, then `Authorization: Bearer`), so a
 * browser dashboard needs no token handling while a script can still use a header.
 *
 * Two deliberate departures from jovi-mall's `requireAuth`:
 *
 * 1. **No silent refresh.** jovi-mall rotates the access cookie mid-request when it
 *    finds an expired token. That hides expiry from cookie clients but not from bearer
 *    clients, which is the root of a documented cross-service defect (geo-tracker
 *    forwards a bearer token, cannot refresh, and the failure is reported as
 *    "shipment_completed"). Here an expired token is simply a 401 with a distinct code,
 *    and the dashboard calls `POST /auth/refresh`. Explicit beats invisible.
 *
 * 2. **The session is checked.** A valid signature is necessary, not sufficient: the
 *    `sid` must still exist in Redis. This is what makes logout, revocation and
 *    suspension take effect on the very next request rather than at token expiry.
 *
 * Per request this costs one Redis GET plus one Mongo findById. The account is re-read
 * every time on purpose — status and tier must be current, not whatever was true when
 * the token was minted.
 */

const accounts = new AdminAccountRepository();

interface ResolvedToken {
    token: string;
    method: AdminAuthMethod;
}

function extractToken(req: Request): ResolvedToken | null {
    const cookieToken = req.cookies?.[ADMIN_COOKIE.ACCESS];
    if (cookieToken) return { token: cookieToken, method: 'cookie' };

    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
        const token = header.slice('Bearer '.length).trim();
        if (token) return { token, method: 'bearer' };
    }

    return null;
}

function clientIp(req: Request): string | null {
    // `req.ip` honours the `trust proxy` setting configured in app.ts. Without that,
    // every request behind a proxy reports the proxy's address.
    return req.ip ?? null;
}

/**
 * @param allowPendingMfaEnrolment when true, a password-only session belonging to an
 *        admin who still owes MFA enrolment is accepted. ONLY the enrolment routes pass
 *        this. Everything else uses the strict export below, so a new route is protected
 *        by default rather than by remembering to opt in.
 */
function buildAuthenticator(allowPendingMfaEnrolment: boolean) {
    // `res` is threaded through now: the per-tier rate limiter attached at the tail of
    // `authenticate` is an Express handler and needs one to write its headers.
    return asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
        await authenticate(req, res, next, allowPendingMfaEnrolment);
    });
}

async function authenticate(
    req: Request,
    res: Response,
    next: NextFunction,
    allowPendingMfaEnrolment: boolean,
): Promise<void> {
    const resolved = extractToken(req);
    if (!resolved) {
        return next(createAppError(ERROR_CODES.ADMIN_AUTH_MISSING_TOKEN, 401));
    }

    // Throws ADMIN_AUTH_TOKEN_EXPIRED / ADMIN_AUTH_TOKEN_INVALID, both 401.
    const claims = verifyAccessToken(resolved.token);

    const lookup = await sessions.getSession(claims.sid);
    if (lookup.status === 'missing') {
        // Logged out, revoked, or idle-expired — indistinguishable from here, and the
        // client's remedy is the same in all three cases: sign in again.
        return next(createAppError(ERROR_CODES.ADMIN_AUTH_SESSION_REVOKED, 401));
    }
    if (lookup.status === 'absolute_expired') {
        return next(createAppError(ERROR_CODES.ADMIN_AUTH_SESSION_EXPIRED, 401));
    }

    const admin = await accounts.findById(claims.sub);
    if (!admin) {
        // The account was deleted while a session was live. Clean up rather than
        // leaving a session pointing at nothing.
        await sessions.destroySession(claims.sid, claims.sub, 'revoked_by_admin');
        return next(createAppError(ERROR_CODES.ADMIN_AUTH_SESSION_REVOKED, 401));
    }

    if (admin.status === 'suspended') {
        // Suspension takes effect immediately, across every device. jovi-mall's
        // equivalent `User.status` is never written OR read, so suspending changes
        // nothing there.
        const ended = await sessions.destroyAllSessions(claims.sub, 'account_suspended');

        /**
         * Recorded ONLY when this call actually cut something.
         *
         * This branch runs on every request a suspended administrator makes — a dashboard
         * polling in a background tab hits it several times a minute — and an unconditional
         * row would bury the trail under duplicates of one event. Gating on `ended > 0`
         * makes it one row per suspension: the first request after the flag flips does the
         * eviction, and every later one finds nothing left to end.
         */
        if (ended > 0) {
            recordEvent(
                {
                    action: 'administrators.auth.session_terminated',
                    actor: {
                        kind: 'administrator',
                        id: claims.sub,
                        email: admin.email,
                        displayName: admin.display_name,
                        tier: admin.tier,
                        sessionId: claims.sid,
                    },
                    target: { type: 'administrator', id: claims.sub, label: admin.email },
                    context: requestContext(req),
                    payload: { reason: 'account_suspended', sessionsEnded: ended, via: 'request_gate' },
                },
                'succeeded',
            );
        }

        return next(createAppError(ERROR_CODES.ADMIN_AUTH_ACCOUNT_SUSPENDED, 403));
    }

    const pendingMfaEnrolment = lookup.record.pendingMfaEnrolment === true;

    // A password-only session for a tier that owes MFA reaches the enrolment endpoints
    // and nothing else. Enforced here rather than per route, so a route added later is
    // protected by default instead of by remembering to add a check.
    if (pendingMfaEnrolment && !allowPendingMfaEnrolment) {
        return next(
            createAppError(
                ERROR_CODES.ADMIN_AUTH_MFA_REQUIRED,
                403,
                'Two-factor authentication must be activated before using this service',
            ),
        );
    }

    const identity: AdminIdentity = {
        adminId: admin._id.toString(),
        sessionId: claims.sid,
        email: admin.email,
        displayName: admin.display_name,
        // Authoritative, from the account — NOT the `tier` claim in the token, so a
        // demotion applies on the next request instead of at token expiry.
        tier: admin.tier,
        status: admin.status,
        mfaEnrolled: admin.mfa_enrolled,
        pendingMfaEnrolment,
        authenticatedAt: new Date(lookup.record.startedAt),
        sessionExpiresAt: new Date(lookup.record.absoluteExpiresAt),
        authMethod: resolved.method,
        ip: clientIp(req),
    };

    req.admin = identity;

    // History only, deliberately not awaited: a slow write must not delay the request.
    void sessions.markSeen(claims.sid);

    /**
     * Layer B — the per-tier rate limit (Phase 16).
     *
     * Attached HERE rather than per route, and that is the design: this is the single gate
     * every authenticated route in the service passes through, so one line makes the
     * per-tier ceilings live everywhere and a route added next year inherits them without
     * its author knowing they exist.
     *
     * At the tail, after `req.admin` is set, because this is the earliest point where the
     * caller's tier is known from a verified session rather than from a claim they chose —
     * and the tier selects a MORE generous bucket, so reading it from anywhere less
     * trustworthy would be an upgrade an attacker could ask for.
     */
    return identityRateLimiter(req, res, next);
}

/** The default gate. Use this everywhere except the MFA enrolment routes. */
export const requireAdmin = buildAuthenticator(false);

/**
 * Enrolment-only gate: additionally accepts a scoped, password-only session from an
 * admin who still owes MFA. Mounted on `/auth/mfa/enroll`, `/auth/mfa/activate`,
 * `/auth/me` and `/auth/logout` — the minimum needed to finish setting up or back out.
 */
export const requireAdminAllowingMfaEnrolment = buildAuthenticator(true);
