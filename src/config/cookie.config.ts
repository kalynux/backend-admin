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

/** Short-lived access cookie. Its lifetime matches the access token's own `exp`. */
export function accessCookieOptions(): CookieOptions {
    return { ...base(), maxAge: env().ADMIN_ACCESS_TOKEN_TTL * 1000 };
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
