import { env } from '../../../config/env';
import { getRedisClient, ADMIN_RATE_LIMIT_DB } from '../../../infra/redis/redis.factory';

/**
 * Per-account lockout after repeated failed logins.
 *
 * jovi-mall has none: an attacker may try passwords against one account without limit
 * and without leaving a trace. This bounds guesses per account, complementing the
 * per-IP limiter (which bounds a single source across many accounts).
 *
 * Counters live in Redis, keyed by account, with the window expressed as the key's TTL —
 * so a burst of failures decays on its own and nothing has to sweep. The failure count
 * is ALSO mirrored onto the account document, because an operator investigating an
 * account needs to see it without a Redis session.
 */

const FAILURE_KEY = (adminId: string) => `login-failures:${adminId}`;
const LOCK_KEY = (adminId: string) => `login-lock:${adminId}`;

export interface LockState {
    locked: boolean;
    /** Seconds until the lock lifts. Surfaced so the client can say how long to wait. */
    retryAfterSeconds: number;
    failedAttempts: number;
}

async function redis() {
    return getRedisClient(ADMIN_RATE_LIMIT_DB);
}

export async function getLockState(adminId: string): Promise<LockState> {
    const client = await redis();
    const [lockTtl, failures] = await Promise.all([
        client.ttl(LOCK_KEY(adminId)),
        client.get(FAILURE_KEY(adminId)),
    ]);

    return {
        locked: lockTtl > 0,
        retryAfterSeconds: lockTtl > 0 ? lockTtl : 0,
        failedAttempts: failures ? Number(failures) : 0,
    };
}

/**
 * Record a failure and lock once the threshold is reached.
 *
 * The failure window equals the lock duration: attempts spread thinner than that decay
 * naturally, which is the difference between throttling an attacker and locking out a
 * real admin who mistypes twice a week.
 */
export async function recordFailure(adminId: string): Promise<LockState> {
    const config = env();
    const client = await redis();

    const attempts = await client.incr(FAILURE_KEY(adminId));
    if (attempts === 1) {
        await client.expire(FAILURE_KEY(adminId), config.ADMIN_LOCKOUT_DURATION_S);
    }

    if (attempts >= config.ADMIN_LOCKOUT_MAX_ATTEMPTS) {
        await client.set(LOCK_KEY(adminId), '1', { EX: config.ADMIN_LOCKOUT_DURATION_S });
        return { locked: true, retryAfterSeconds: config.ADMIN_LOCKOUT_DURATION_S, failedAttempts: attempts };
    }

    return { locked: false, retryAfterSeconds: 0, failedAttempts: attempts };
}

/** Clear the counters. Called on a successful authentication, never before it. */
export async function clearFailures(adminId: string): Promise<void> {
    const client = await redis();
    await client.multi().del(FAILURE_KEY(adminId)).del(LOCK_KEY(adminId)).exec();
}
