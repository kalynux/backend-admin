import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { RequestHandler } from 'express';
import { RedisClientType } from 'redis';
import { createAppError } from '../../core/errors/app-error';
import { ERROR_CODES } from '../../core/errors/error-codes';
import { getRedisClient, ADMIN_RATE_LIMIT_DB } from '../../infra/redis/redis.factory';
import { logger } from '../../core/logging/logger';
import { env } from '../../config/env';

/**
 * Strict per-IP limiter for `/auth/*`.
 *
 * Complements the per-account lockout: lockout bounds guesses against ONE account, this
 * bounds one source spraying a common password across MANY accounts. Neither catches
 * the other's attack.
 *
 * Backed by Redis (`ADMIN_RATE_LIMIT_DB`) rather than the in-memory store Phase 1 used
 * globally. Memory is per-process, so N instances multiply the effective limit by N —
 * tolerable for a blanket 300/min, not for a credential endpoint.
 *
 * jovi-mall has no rate limiting on any route.
 */

const AUTH_WINDOW_MS = 60_000;

function build(useRedis: RedisClientType | null): RequestHandler {
    return rateLimit({
        windowMs: AUTH_WINDOW_MS,
        limit: env().ADMIN_AUTH_RATE_LIMIT_MAX,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        ...(useRedis
            ? {
                store: new RedisStore({
                    prefix: 'auth-rl:',
                    sendCommand: (...args: string[]) => useRedis.sendCommand(args),
                }),
            }
            : {}),
        handler: (req, _res, next) => {
            logger().warn({ ip: req.ip, path: req.path }, 'auth rate limit exceeded');
            next(createAppError(ERROR_CODES.RATE_LIMIT_EXCEEDED, 429, 'Too many authentication attempts'));
        },
    });
}

/**
 * Built during `createApp()`, not at import and NOT lazily inside a request.
 *
 * Not at import, because `build()` reads config and this module is pulled in by the
 * route tree long before `env()` has been validated. Not lazily either: constructing a
 * limiter inside a request handler is what express-rate-limit's
 * ERR_ERL_CREATED_IN_REQUEST_HANDLER warns about — the instance built there can end up
 * with per-request state instead of shared state, silently defeating the limit.
 */
let limiter: RequestHandler | null = null;

/** Install the memory-backed limiter. Called by `createApp()`, after config is valid. */
export function ensureAuthRateLimiter(): void {
    if (!limiter) limiter = build(null);
}

/** Test-only: drop the limiter so a new ceiling or a fresh counter takes effect. */
export function resetAuthRateLimiter(): void {
    limiter = null;
}

/**
 * Called during boot, once Redis is connected. Falls back to the memory limiter if
 * Redis is unreachable — a per-process limit still bounds an attacker, whereas failing
 * to build the limiter at all would leave the credential endpoint wide open.
 */
export async function initAuthRateLimiter(): Promise<void> {
    try {
        const client = (await getRedisClient(ADMIN_RATE_LIMIT_DB)) as RedisClientType;
        limiter = build(client);
        logger().info('auth rate limiter using the shared Redis store');
    } catch (error) {
        logger().error(
            { err: error instanceof Error ? error.message : String(error) },
            'auth rate limiter falling back to the in-memory store',
        );
    }
}

/**
 * Delegates to whichever limiter is current, so routes can be mounted at import time
 * while the Redis-backed store is installed later during boot.
 */
export const authRateLimiter: RequestHandler = (req, res, next) => {
    // `ensureAuthRateLimiter()` runs in createApp(), so this is only a safety net for a
    // caller that mounted the router without building the app.
    ensureAuthRateLimiter();
    return limiter!(req, res, next);
};
