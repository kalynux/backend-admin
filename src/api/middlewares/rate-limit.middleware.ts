import rateLimit from 'express-rate-limit';
import { Request, RequestHandler } from 'express';
import { createAppError } from '../../core/errors/app-error';
import { ERROR_CODES } from '../../core/errors/error-codes';
import { logger } from '../../core/logging/logger';
import { env } from '../../config/env';

/**
 * Rate limiting for wi-admin (Phase 16 retrofit of the Phase 1 blanket limiter).
 *
 * ── What changed and why ──────────────────────────────────────────────────────
 * Phase 1 shipped a flat 300/minute per IP with a comment saying the in-memory
 * store was "acceptable while the service has no authenticated surface". It has one now,
 * and the flat number had become wrong in both directions:
 *
 *  - **Too low for an office.** Ten administrators behind one NAT at 30 requests a minute
 *    each — one dashboard screen with a few panels — already reaches 300. The limiter would
 *    fire on a normal Tuesday, and every one of them is a person who is already
 *    authenticated and already authorized.
 *  - **Not expressible per caller.** The platform-wide policy is per caller TYPE, and a
 *    single number cannot say "an operations dashboard fans out; an unauthenticated
 *    probe should not".
 *
 * ── Two layers, matching jovi-mall ────────────────────────────────────────────
 *   Layer A  this file's `globalRateLimiter` — IP-scoped, before the routers, so it also
 *            covers `/auth/*` where there is no identity yet.
 *   Layer B  `identityRateLimiter` — per administrator, attached at the tail of
 *            `requireAdmin`, so every authenticated route inherits it.
 *
 * `authRateLimiter` (`auth-rate-limit.middleware.ts`) is untouched and stays strict at its
 * configured ceiling: it is the credential-stuffing control, and it is the only number here
 * that is a security boundary rather than a runaway-loop backstop.
 *
 * ── Per-endpoint limits are already possible and deliberately unused ──────────
 * `defineRoute` takes `before: RequestHandler[]`, whose own comment reads "rate limiters, in
 * practice". Tightening one endpoint is a `build()` call in its route file — no new
 * mechanism. Nothing needs it yet, and a table with one row is a second thing to keep in
 * step.
 */

export type AdminCallerClass = 'developer' | 'admin' | 'support' | 'anonymous';

/**
 * Per-minute ceilings by tier.
 *
 * Developer sits highest because tier 1 is also the tier that drives the operations surface
 * — dependency probes, log searches, the error journal — which is the most request-dense
 * work anybody does here. Support sits lowest because ticket work is human-paced.
 *
 * The `anonymous` entry is Layer A's ceiling, and what an unauthenticated caller gets.
 * Raised from Phase 1's 300, it sits above every identity ceiling so that Layer A only ever
 * catches a genuine flood from one address rather than being the thing that limits a
 * signed-in administrator — that is Layer B's job, and it can tell them apart.
 *
 * Every number is a backstop. If any of them is ever reached by a real administrator the
 * number is wrong, and `ADMIN_RATE_LIMIT_*` exists so that can be corrected without a
 * deploy.
 *
 * ⚠ Read through `env()` since 2026-09-09 (DOC-PROGRAM close-out § 6, item 3). These four
 * used to be a local `envInt()` over `process.env[name]`, which put them in neither the Zod
 * schema nor `.env.example` — configurable in principle and undiscoverable in practice, and
 * invisible to a `process.env.NAME` grep because the read was indexed. Deliberately a
 * FUNCTION rather than the frozen const it replaces: `env()` parses on first call and
 * throws on a bad environment, so evaluating it at module scope would move a configuration
 * failure into an import and out of `server.ts`'s boot handler.
 */
export function adminRateLimits(): Readonly<Record<AdminCallerClass, number>> {
    const config = env();
    return {
        developer: config.ADMIN_RATE_LIMIT_DEVELOPER,
        admin: config.ADMIN_RATE_LIMIT_ADMIN,
        support: config.ADMIN_RATE_LIMIT_SUPPORT,
        anonymous: config.ADMIN_RATE_LIMIT_ANON,
    };
}

/**
 * Which bucket this request counts against.
 *
 * Reads `req.admin`, which only exists after `requireAdmin` — so Layer A always resolves
 * `anonymous` and Layer B always resolves a real tier. That is not a limitation to work
 * around: classifying earlier would mean reading an unverified token, and selecting a MORE
 * generous bucket from an attacker-chosen claim is how a rate limiter is talked out of
 * limiting anybody.
 */
export function adminCallerClass(req: Request): AdminCallerClass {
    switch (req.admin?.tier) {
        case 1: return 'developer';
        case 2: return 'admin';
        case 3: return 'support';
        default: return 'anonymous';
    }
}

const WINDOW_MS = 60_000;

function build(scope: 'ip' | 'identity'): RequestHandler {
    return rateLimit({
        windowMs: WINDOW_MS,
        limit: (req) => adminRateLimits()[adminCallerClass(req)],
        keyGenerator: (req) =>
            scope === 'identity' && req.admin
                ? `admin:${req.admin.adminId}`
                : `ip:${req.ip ?? 'unknown'}`,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        handler: (req, _res, next) => {
            logger().warn(
                { ip: req.ip, path: req.path, callerClass: adminCallerClass(req), scope },
                'rate limit exceeded',
            );
            next(createAppError(ERROR_CODES.RATE_LIMIT_EXCEEDED, 429, undefined, {
                retryAfterSeconds: WINDOW_MS / 1000,
            }));
        },
    });
}

/**
 * STORE: in-memory, and that is now a considered choice rather than a deferral.
 *
 * Phase 1's note said this would move to Redis "when a shared counter starts to matter".
 * For these ceilings it does not: N instances multiply a 3000/minute backstop by N, and a
 * backstop that is 2× or 3× too generous still catches the runaway loop it exists for.
 * Where a shared counter genuinely matters is the credential endpoint, and
 * `auth-rate-limit.middleware.ts` is already Redis-backed for exactly that reason — a
 * per-process limit on login would let an attacker get N× the guesses.
 *
 * The asymmetry is the point: strict limits are shared, generous ones need not be.
 */
export const globalRateLimiter: RequestHandler = build('ip');

/** Layer B — attached at the tail of `requireAdmin`. Per administrator, per tier. */
export const identityRateLimiter: RequestHandler = build('identity');
