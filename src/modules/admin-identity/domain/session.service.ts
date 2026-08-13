import { RedisClientType } from 'redis';
import { env } from '../../../config/env';
import { getRedisClient, ADMIN_SESSION_DB } from '../../../infra/redis/redis.factory';
import { logger } from '../../../core/logging/logger';
import { AdminTier } from './admin-identity.types';
import { fingerprint } from './token.service';
import { AdminSessionModel, SessionEndReason } from '../models/admin-session.model';

/**
 * Session lifecycle — the mechanism that makes admin tokens revocable.
 *
 * jovi-mall's sessions are pure JWT: nothing server-side records that a session exists,
 * so logout can only clear cookies and a stolen access token stays valid for its full
 * 15 minutes (a refresh token, for 30 days). Nothing can end either.
 *
 * Here every token names a `sid` that must still be present in Redis. Deleting that key
 * kills the token on its next use — which is what makes logout, "sign out everywhere",
 * and instant revocation on suspension possible at all.
 *
 * ── Two clocks, deliberately ──────────────────────────────────────────────────
 *   IDLE     the Redis TTL, refreshed on every authenticated request. Expresses
 *            "you stopped using this".
 *   ABSOLUTE stored inside the record and checked on read. Expresses "this session is
 *            old regardless of activity", so a permanently-open dashboard tab cannot
 *            hold a session forever.
 * A single clock cannot express both: a refreshed TTL alone never ends, and a fixed TTL
 * alone logs out an admin mid-task.
 *
 * ── Storage split ─────────────────────────────────────────────────────────────
 *   Redis  the live session. Hot path, expires itself.
 *   Mongo  the durable history in `wi-admin`. Never read to authenticate; it is what
 *          Phase 3's audit log joins against.
 */

const SESSION_KEY = (sid: string) => `session:${sid}`;
const ADMIN_SESSIONS_KEY = (adminId: string) => `admin-sessions:${adminId}`;

export interface SessionRecord {
    adminId: string;
    tier: AdminTier;
    /** SHA-256 of the CURRENT refresh token. Rotation replaces it; a stale one means reuse. */
    refreshTokenHash: string;
    startedAt: string;
    absoluteExpiresAt: string;
    ip: string | null;
    userAgent: string | null;
    mfaUsed: boolean;
    /**
     * A password-only session for an admin whose tier REQUIRES two-factor but who has
     * not enrolled yet. It can reach the MFA enrolment endpoints and nothing else.
     *
     * Without this the requirement is a deadlock: a bootstrapped tier-1 admin cannot log
     * in without MFA, and cannot enrol MFA without logging in. Refusing the login
     * outright would make the very first account unusable.
     */
    pendingMfaEnrolment: boolean;
}

async function client(): Promise<RedisClientType> {
    return getRedisClient(ADMIN_SESSION_DB);
}

export interface CreateSessionInput {
    sessionId: string;
    adminId: string;
    tier: AdminTier;
    refreshToken: string;
    ip: string | null;
    userAgent: string | null;
    mfaUsed: boolean;
    pendingMfaEnrolment?: boolean;
}

export async function createSession(input: CreateSessionInput): Promise<SessionRecord> {
    const config = env();
    const redis = await client();
    const now = new Date();
    const absoluteExpiresAt = new Date(now.getTime() + config.ADMIN_SESSION_ABSOLUTE_TTL * 1000);

    const record: SessionRecord = {
        adminId: input.adminId,
        tier: input.tier,
        refreshTokenHash: fingerprint(input.refreshToken),
        startedAt: now.toISOString(),
        absoluteExpiresAt: absoluteExpiresAt.toISOString(),
        ip: input.ip,
        userAgent: input.userAgent,
        mfaUsed: input.mfaUsed,
        pendingMfaEnrolment: input.pendingMfaEnrolment ?? false,
    };

    await redis
        .multi()
        .set(SESSION_KEY(input.sessionId), JSON.stringify(record), { EX: config.ADMIN_SESSION_IDLE_TTL })
        .sAdd(ADMIN_SESSIONS_KEY(input.adminId), input.sessionId)
        // The index must not outlive the sessions it points at, or a long-dormant admin
        // accumulates a set of dead ids forever.
        .expire(ADMIN_SESSIONS_KEY(input.adminId), config.ADMIN_SESSION_ABSOLUTE_TTL)
        .exec();

    // Durable record. Best-effort: failing to write history must not deny a valid login.
    try {
        await AdminSessionModel().create({
            session_id: input.sessionId,
            admin_id: input.adminId,
            tier_at_login: input.tier,
            ip: input.ip,
            user_agent: input.userAgent,
            mfa_used: input.mfaUsed,
            started_at: now,
            absolute_expires_at: absoluteExpiresAt,
            last_seen_at: now,
        });
    } catch (error) {
        logger().error(
            { err: error instanceof Error ? error.message : String(error), sessionId: input.sessionId },
            'failed to write durable session record',
        );
    }

    return record;
}

export type SessionLookup =
    | { status: 'live'; record: SessionRecord }
    | { status: 'missing' }
    | { status: 'absolute_expired'; record: SessionRecord };

/**
 * Read a session and refresh its idle window.
 *
 * `touch` is false on the refresh path: presenting a refresh token proves possession of
 * a credential, not that a human is using the dashboard. Extending the idle window on
 * refresh alone would let a background timer keep a session alive indefinitely.
 */
export async function getSession(sessionId: string, touch = true): Promise<SessionLookup> {
    const redis = await client();
    const raw = await redis.get(SESSION_KEY(sessionId));
    if (!raw) return { status: 'missing' };

    const record = JSON.parse(raw) as SessionRecord;

    if (new Date(record.absoluteExpiresAt).getTime() <= Date.now()) {
        await destroySession(sessionId, record.adminId, 'absolute_expired');
        return { status: 'absolute_expired', record };
    }

    if (touch) {
        await redis.expire(SESSION_KEY(sessionId), env().ADMIN_SESSION_IDLE_TTL);
    }

    return { status: 'live', record };
}

/**
 * Swap in a new refresh-token hash. Returns false when the presented token is not the
 * current one — the caller treats that as reuse and destroys the session, because the
 * only ways to hold a superseded refresh token are to have kept a copy or stolen one.
 */
export async function rotateRefreshToken(
    sessionId: string,
    presentedToken: string,
    nextToken: string,
): Promise<boolean> {
    const lookup = await getSession(sessionId, false);
    if (lookup.status !== 'live') return false;

    if (lookup.record.refreshTokenHash !== fingerprint(presentedToken)) {
        return false;
    }

    const redis = await client();
    const updated: SessionRecord = { ...lookup.record, refreshTokenHash: fingerprint(nextToken) };
    // Preserve the remaining idle window rather than resetting it — see `touch` above.
    const remaining = await redis.ttl(SESSION_KEY(sessionId));
    await redis.set(SESSION_KEY(sessionId), JSON.stringify(updated), {
        EX: remaining > 0 ? remaining : env().ADMIN_SESSION_IDLE_TTL,
    });

    return true;
}

export async function destroySession(
    sessionId: string,
    adminId: string,
    reason: SessionEndReason,
): Promise<void> {
    const redis = await client();
    await redis.multi().del(SESSION_KEY(sessionId)).sRem(ADMIN_SESSIONS_KEY(adminId), sessionId).exec();

    try {
        await AdminSessionModel().updateOne(
            { session_id: sessionId, ended_at: null },
            { $set: { ended_at: new Date(), end_reason: reason } },
        );
    } catch (error) {
        logger().error(
            { err: error instanceof Error ? error.message : String(error), sessionId },
            'failed to stamp durable session record',
        );
    }
}

/**
 * End every session an admin holds. Backs "sign out everywhere" and — more importantly
 * — revocation on suspension or tier change, where leaving live sessions running would
 * mean the change does not take effect until each token expires.
 */
export async function destroyAllSessions(adminId: string, reason: SessionEndReason): Promise<number> {
    const redis = await client();
    const sessionIds = await redis.sMembers(ADMIN_SESSIONS_KEY(adminId));

    if (sessionIds.length > 0) {
        const multi = redis.multi();
        for (const sid of sessionIds) multi.del(SESSION_KEY(sid));
        multi.del(ADMIN_SESSIONS_KEY(adminId));
        await multi.exec();
    } else {
        await redis.del(ADMIN_SESSIONS_KEY(adminId));
    }

    try {
        await AdminSessionModel().updateMany(
            { admin_id: adminId, ended_at: null },
            { $set: { ended_at: new Date(), end_reason: reason } },
        );
    } catch (error) {
        logger().error(
            { err: error instanceof Error ? error.message : String(error), adminId },
            'failed to stamp durable session records',
        );
    }

    return sessionIds.length;
}

export interface LiveSessionSummary {
    sessionId: string;
    startedAt: string;
    absoluteExpiresAt: string;
    ip: string | null;
    userAgent: string | null;
    mfaUsed: boolean;
    current: boolean;
}

/** This admin's live sessions, so they can spot and kill one they do not recognise. */
export async function listSessions(adminId: string, currentSessionId: string): Promise<LiveSessionSummary[]> {
    const redis = await client();
    const sessionIds = await redis.sMembers(ADMIN_SESSIONS_KEY(adminId));

    const summaries: LiveSessionSummary[] = [];
    for (const sid of sessionIds) {
        const raw = await redis.get(SESSION_KEY(sid));
        if (!raw) {
            // The TTL expired but the index still names it. Self-heal rather than
            // reporting a session that no longer exists.
            await redis.sRem(ADMIN_SESSIONS_KEY(adminId), sid);
            continue;
        }
        const record = JSON.parse(raw) as SessionRecord;
        summaries.push({
            sessionId: sid,
            startedAt: record.startedAt,
            absoluteExpiresAt: record.absoluteExpiresAt,
            ip: record.ip,
            userAgent: record.userAgent,
            mfaUsed: record.mfaUsed,
            current: sid === currentSessionId,
        });
    }

    return summaries.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/**
 * A session as the durable history remembers it — live or long finished.
 *
 * `LiveSessionSummary` is a strict subset, so a live-only response and a history response
 * share the fields a client already renders and simply carry more.
 */
export interface SessionSummary extends LiveSessionSummary {
    /** Null while the session is still live. */
    endedAt: string | null;
    /** One of the nine `SessionEndReason` values; null while live. */
    endReason: SessionEndReason | null;
    lastSeenAt: string | null;
    /** The level held when this session began — not necessarily the level held now. */
    tierAtLogin: number | null;
}

/**
 * End every session EXCEPT one.
 *
 * For a self-service password change: the caller's own device stays signed in, everything
 * else is cut off. Signing someone out of the device they are actively using because they
 * did the right thing is a good way to teach them not to.
 *
 * @returns how many sessions were ended.
 */
export async function destroyOtherSessions(
    adminId: string,
    keepSessionId: string,
    reason: SessionEndReason,
): Promise<number> {
    const redis = await client();
    const sessionIds = await redis.sMembers(ADMIN_SESSIONS_KEY(adminId));
    const doomed = sessionIds.filter((sid) => sid !== keepSessionId);

    for (const sid of doomed) {
        await destroySession(sid, adminId, reason);
    }

    return doomed.length;
}

/**
 * Widen a live summary to the history shape, so one endpoint has one return type whether
 * or not it was asked for ended sessions. The extra fields are genuinely unknown from
 * Redis — `null` says so rather than inventing them.
 */
export function toSessionSummary(live: LiveSessionSummary): SessionSummary {
    return { ...live, endedAt: null, endReason: null, lastSeenAt: null, tierAtLogin: null };
}

/**
 * The durable session history for one administrator, ended sessions included.
 *
 * ── Why this function did not exist until now ────────────────────────────────
 * `admin_sessions` has been written on every login since Phase 2 and stamped with an end
 * reason on every logout, revocation, suspension, tier change and password reset — and
 * **nothing ever read it**. Every session-listing path went to Redis, so an ended session
 * disappeared from the API entirely and "when did this administrator last sign in, and why
 * did that session end" had no answer outside the database.
 *
 * Redis stays authoritative for what is LIVE: a row here whose Redis key is gone was
 * revoked or expired between the two reads, and reporting it as live would be wrong. So
 * the durable rows supply history and the live set decides `current`-ness.
 */
export async function listSessionHistory(adminId: string, limit = 50): Promise<SessionSummary[]> {
    const rows = await AdminSessionModel()
        .find({ admin_id: adminId })
        .sort({ started_at: -1 })
        .limit(limit);

    const liveIds = new Set((await listSessions(adminId, '')).map((entry) => entry.sessionId));

    return rows.map((row) => ({
        sessionId: row.session_id,
        startedAt: row.started_at.toISOString(),
        absoluteExpiresAt: row.absolute_expires_at.toISOString(),
        ip: row.ip,
        userAgent: row.user_agent,
        mfaUsed: row.mfa_used,
        // Never "the caller's own": this is another administrator's history.
        current: false,
        // A row with no `ended_at` whose Redis key is gone expired without being stamped
        // — report it as ended rather than as live.
        endedAt: row.ended_at?.toISOString() ?? null,
        endReason: row.ended_at ? row.end_reason : (liveIds.has(row.session_id) ? null : 'idle_expired'),
        lastSeenAt: row.last_seen_at?.toISOString() ?? null,
        tierAtLogin: row.tier_at_login,
    }));
}

/** Records dashboard activity on the durable row. Best-effort, off the hot path. */
export async function markSeen(sessionId: string): Promise<void> {
    try {
        await AdminSessionModel().updateOne({ session_id: sessionId }, { $set: { last_seen_at: new Date() } });
    } catch {
        /* history only — never fail a request over it */
    }
}
