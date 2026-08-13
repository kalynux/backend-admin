import { Request, Response, NextFunction } from 'express';
import { randomBytes, timingSafeEqual } from 'crypto';
import { createAppError } from '../../core/errors/app-error';
import { ERROR_CODES } from '../../core/errors/error-codes';
import { ADMIN_COOKIE } from '../../config/cookie.config';

/**
 * CSRF protection for the COOKIE authentication path.
 *
 * Why it is needed here and not in jovi-mall's design: the admin dashboard is a
 * separate origin from this API, so its cookies must be `SameSite=None` in production.
 * `SameSite=Lax` is itself a CSRF defence — dropping to `None` removes it, and a
 * cookie-authenticated state-changing endpoint becomes forgeable from any page the
 * admin visits while signed in.
 *
 * Double-submit: the token is issued in a readable (non-httpOnly) cookie and must be
 * echoed in the `X-CSRF-Token` header. An attacker's page can cause the cookie to be
 * SENT — that is the whole problem — but the same-origin policy stops it being READ,
 * so it cannot set the matching header.
 *
 * **Bearer requests are exempt, and that is not a hole.** CSRF exists because browsers
 * attach cookies automatically; nothing attaches an `Authorization` header
 * automatically. A forged cross-origin request cannot produce one.
 *
 * Safe methods are exempt: they change nothing, and requiring a token on GET would
 * break links and probes for no gain.
 */

const CSRF_HEADER = 'x-csrf-token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const TOKEN_BYTES = 32;

export function generateCsrfToken(): string {
    return randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * Constant-time comparison. A `===` here leaks how many leading characters matched via
 * timing — small, but free to avoid.
 */
function tokensMatch(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    // timingSafeEqual throws on a length mismatch, so check length first — that
    // comparison leaks only the length, which is fixed and public.
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
}

/**
 * Mount AFTER `requireAdmin`, which sets `req.admin.authMethod`. Only cookie-
 * authenticated, state-changing requests are challenged.
 */
export const requireCsrfToken = (req: Request, _res: Response, next: NextFunction): void => {
    if (SAFE_METHODS.has(req.method)) return next();

    // Bearer clients cannot be CSRF'd — see the header note.
    if (req.admin && req.admin.authMethod !== 'cookie') return next();

    // An unauthenticated request has nothing to forge with; `requireAdmin` will reject
    // it on its own terms if the route needs identity.
    if (!req.admin) return next();

    const cookieToken = req.cookies?.[ADMIN_COOKIE.CSRF];
    const headerToken = req.headers[CSRF_HEADER];

    if (typeof cookieToken !== 'string' || typeof headerToken !== 'string' || !cookieToken || !headerToken) {
        return next(createAppError(ERROR_CODES.ADMIN_AUTH_CSRF_INVALID, 403));
    }

    if (!tokensMatch(cookieToken, headerToken)) {
        return next(createAppError(ERROR_CODES.ADMIN_AUTH_CSRF_INVALID, 403));
    }

    next();
};
