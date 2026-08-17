import { CookieOptions } from 'express';
import { env } from './env';

/**
 * Admin auth cookies.
 *
 * Shape ported from `jovi-mall/src/config/cookie.config.ts` — httpOnly, Secure in
 * production, path `/`, a configurable domain, and a `clear` variant whose attributes
 * match the `set` variant exactly (they must, or some browsers refuse to clear).
 *
 * Two deliberate differences:
 *
 * 1. **Distinct names.** `admin_access_token` / `admin_refresh_token`, so that if the
 *    two services are ever served from one parent domain, an admin session and a
 *    vendor session cannot overwrite one another.
 * 2. **SameSite is configurable.** jovi-mall hardcodes `lax`, which only works when the
 *    app and API are same-site. The admin dashboard is a separate origin, so a real
 *    deployment needs `none` (with Secure). `env.ts` refuses `none` outside production,
 *    where cookies would not be Secure and the browser would silently drop them.
 */

export const ADMIN_COOKIE = {
    ACCESS: 'admin_access_token',
    REFRESH: 'admin_refresh_token',
    /** Readable by JS on purpose — the double-submit CSRF pattern requires it. */
    CSRF: 'admin_csrf_token',
} as const;

function base(): CookieOptions {
    const config = env();
    return {
        httpOnly: true,
        secure: config.NODE_ENV === 'production',
        sameSite: config.ADMIN_COOKIE_SAMESITE,
        path: '/',
        domain: config.ADMIN_COOKIE_DOMAIN,
    };
}

/**
 * Access cookie.
 *
 * ⚠ **Its lifetime is deliberately NOT the access token's `exp`.**
 *
 * It used to be, and that broke refresh entirely. Giving the cookie the token's
 * own 15-minute `maxAge` means the browser evicts it at the very moment the JWT
 * becomes invalid — so the expired token is never presented, `extractToken`
 * finds nothing, and `authenticate` answers `ADMIN_AUTH_MISSING_TOKEN` instead
 * of `ADMIN_AUTH_TOKEN_EXPIRED`. Those two codes have different remedies: the
 * first means *never signed in* and sends a client to the login screen, the
 * second means *call `/auth/refresh`*. A dashboard therefore signed its operator
 * out at exactly 15 minutes with a perfectly valid 7-day refresh cookie in the
 * jar, having never once called refresh.
 *
 * The `TOKEN_EXPIRED` branch was reachable only during the few milliseconds of
 * network latency between the JWT expiring and the cookie being evicted, which
 * is why no test caught it — nothing exercises a 15-minute-old session.
 *
 * This is the **same argument `refreshCookieOptions` already makes below**: a
 * cookie that dies before the thing it carries is what logs out a live session.
 * Security is unchanged — the JWT is still cryptographically expired and still
 * rejected by `verifyAccessToken`. The cookie is only the carrier, and a carrier
 * that survives is what lets the server say *why* it refused.
 */
export function accessCookieOptions(): CookieOptions {
    return { ...base(), maxAge: env().ADMIN_SESSION_ABSOLUTE_TTL * 1000 };
}

/**
 * Refresh cookie. Its lifetime is the session's ABSOLUTE cap, not the idle timeout —
 * an idle-expired session is rejected server-side by the Redis TTL, so a cookie that
 * outlives it is harmless, whereas a cookie that dies first would log out an admin
 * who is still within their idle window.
 */
export function refreshCookieOptions(): CookieOptions {
    return { ...base(), maxAge: env().ADMIN_SESSION_ABSOLUTE_TTL * 1000 };
}

/**
 * CSRF cookie — deliberately NOT httpOnly. The double-submit pattern needs the
 * dashboard to read this value and echo it in a header; a request forged from another
 * origin can send the cookie but cannot read it to set the header.
 */
export function csrfCookieOptions(): CookieOptions {
    return { ...base(), httpOnly: false, maxAge: env().ADMIN_SESSION_ABSOLUTE_TTL * 1000 };
}

/** Must mirror the set-options exactly, minus maxAge, or the cookie is not cleared. */
export function clearCookieOptions(): CookieOptions {
    const { httpOnly, secure, sameSite, path, domain } = base();
    return { httpOnly, secure, sameSite, path, domain };
}
