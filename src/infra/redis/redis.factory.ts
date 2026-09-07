import { createClient, RedisClientType } from 'redis';
import { env } from '../../config/env';
import { logger } from '../../core/logging/logger';

/**
 * Redis client factory, one client per logical database.
 *
 * Same shape as `jovi-mall/src/infra/redis/redis.factory.ts` (a Map of clients keyed by
 * DB index, lazy connect, a close-all for shutdown) with that file's contradictory
 * inline commentary about lazy connection removed — it connects on first request, which
 * is what "lazy" means here.
 *
 * Logical databases are reserved up front so two features never collide on an index.
 *
 * ⚠ **This paragraph used to read "jovi-mall reserves 3–10 on its own Redis instance; these
 * are this service's own namespace and are independent of those." Both halves were wrong**
 * (corrected 2026-09-06, DOC-PROGRAM P-13).
 *
 *  1. jovi-mall uses **0, 3, 5, 6, 7, 8 and 10–15**, not 3–10. Its own
 *     `src/infra/redis/redis.factory.ts` carries the authoritative catalogue, states the
 *     budget as **5–15 precisely because THIS service holds 1, 2 and 3**, and records that
 *     4 and 9 are **retired rather than free** — reading a pre-cutover verification code
 *     back as something else is a security incident.
 *  2. "Independent" holds only when each service has its own Redis, which is what the
 *     workspace compose stack provides. **A developer machine runs one**, and both
 *     `.env.example` files ship `REDIS_URL=redis://localhost:6379`. On that deployment
 *     jovi-mall's `EMAIL_VERIFY_DB = 3` collides with `PERMISSION_CACHE_DB` below —
 *     knowingly and harmlessly, since nothing reads the other's keys and both are exact
 *     gets, but a flush of one clears the other.
 *
 * So: **read `jovi-mall/src/infra/redis/redis.factory.ts` before claiming a new index
 * here.** There is no free range above 3 to expand into; that side has taken 5–15.
 */

/** Admin sessions (Phase 2). Revocable server-side, which a stateless JWT cannot be. */
export const ADMIN_SESSION_DB = 1;

/** Rate-limit counters (Phase 2, when the limiter moves off the in-memory store). */
export const ADMIN_RATE_LIMIT_DB = 2;

/**
 * Reserved, and deliberately UNUSED.
 *
 * Phase 1 set this aside for "resolved tier→endpoint verdicts, cached per admin". Phase 3
 * built authorization without it and should keep it that way: the grant table is static
 * code, so a tier's permission set cannot change while the process runs — there is nothing
 * to invalidate — and each check is a `Set.has` on a string. A Redis round trip would make
 * an O(1) in-memory lookup slower AND add the one failure this design otherwise cannot
 * have: a stale verdict surviving a deploy that changed the policy.
 *
 * The index stays reserved so nothing else claims it and a future feature does not have to
 * relitigate the numbering. See `permission.resolver.ts`.
 */
export const PERMISSION_CACHE_DB = 3;

/** Per-attempt socket connect deadline. */
const REDIS_CONNECT_TIMEOUT_MS = 3_000;

/** Give up rather than retry forever — see the reconnectStrategy note below. */
const REDIS_MAX_RECONNECT_ATTEMPTS = 3;

/** Hard ceiling on the readiness probe, whatever the client is doing internally. */
const REDIS_PING_TIMEOUT_MS = 5_000;

const clients = new Map<number, RedisClientType>();

export const getRedisClient = async (db: number = 0): Promise<RedisClientType> => {
    const existing = clients.get(db);
    if (existing) {
        if (!existing.isOpen) await existing.connect();
        return existing;
    }

    const client = createClient({
        url: env().REDIS_URL,
        database: db,
        socket: {
            connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
            /**
             * Bound the reconnect backoff. node-redis retries FOREVER by default with a
             * growing delay, so a `connect()` against a dead server never settles — which
             * made `/health/ready` hang rather than answer 503. A readiness probe that
             * hangs is worse than one that fails: the orchestrator's own probe times out,
             * and the instance flaps instead of being cleanly withdrawn.
             *
             * Returning an Error stops the retry loop and rejects the pending connect.
             */
            reconnectStrategy: (retries: number) => {
                if (retries >= REDIS_MAX_RECONNECT_ATTEMPTS) {
                    return new Error(`Redis unreachable after ${retries} attempts`);
                }
                return Math.min(retries * 200, 2_000);
            },
        },
    }) as RedisClientType;
    const log = logger().child({ redis: db });

    // A client with no 'error' listener makes node-redis throw on the process, taking the
    // service down for a recoverable blip.
    client.on('error', (err: Error) => log.error({ err: err.message }, 'redis error'));
    client.on('connect', () => log.info('redis connected'));
    client.on('reconnecting', () => log.warn('redis reconnecting'));

    try {
        await client.connect();
    } catch (error) {
        // Do NOT cache a client that never connected: it would be handed to every later
        // caller in a permanently broken state, so the service could not recover when
        // Redis came back. Release it and let the next call build a fresh one.
        try {
            client.destroy();
        } catch {
            /* already unusable — nothing to release */
        }
        throw error;
    }

    clients.set(db, client);
    return client;
};

export interface RedisPingResult {
    ok: boolean;
    durationMs: number;
    error?: string;
}

/**
 * Readiness probe. Connects on first call, so this doubles as the point where Redis
 * availability is first established — Phase 1 does not make Redis a boot requirement.
 */
export const pingRedis = async (): Promise<RedisPingResult> => {
    const startedAt = Date.now();

    // Belt and braces alongside the bounded reconnectStrategy: whatever the client does
    // internally, this probe answers within REDIS_PING_TIMEOUT_MS. Readiness must always
    // produce a verdict — "down" is useful, a hung request is not.
    const timeout = new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error(`redis ping exceeded ${REDIS_PING_TIMEOUT_MS}ms`)),
            REDIS_PING_TIMEOUT_MS,
        );
        timer.unref();
    });

    try {
        await Promise.race([
            (async () => {
                const client = await getRedisClient();
                await client.ping();
            })(),
            timeout,
        ]);
        return { ok: true, durationMs: Date.now() - startedAt };
    } catch (error) {
        return {
            ok: false,
            durationMs: Date.now() - startedAt,
            error: error instanceof Error ? error.message : String(error),
        };
    }
};

/** Close every open client. Part of the graceful-shutdown sequence. */
export const closeRedisClients = async (): Promise<void> => {
    const log = logger();
    for (const [db, client] of clients.entries()) {
        if (!client.isOpen) continue;
        try {
            await client.quit();
            log.info({ redis: db }, 'redis client closed');
        } catch (error) {
            log.error(
                { redis: db, err: error instanceof Error ? error.message : String(error) },
                'failed to close redis client',
            );
        }
    }
    clients.clear();
};
