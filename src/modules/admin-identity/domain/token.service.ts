import jwt from 'jsonwebtoken';
import { randomUUID, createHash } from 'crypto';
import { env } from '../../../config/env';
import { createAppError } from '../../../core/errors/app-error';
import { ERROR_CODES } from '../../../core/errors/error-codes';
import { AdminTier, isAdminTier } from './admin-identity.types';

/**
 * Admin access + refresh tokens.
 *
 * Shape mirrors jovi-mall's (HS256, a short-lived access token beside a long-lived
 * refresh token) so the mental model carries across services. Three differences, each
 * closing a Phase 0 finding:
 *
 * 1. **`sid`** — the session id. jovi-mall's tokens carry only `{userId, role}`, which
 *    is precisely why it cannot revoke: nothing in the token points at server state.
 *    Every token here names a session that must still exist.
 * 2. **`typ`** — `'access'` or `'refresh'`, checked on verify. Without it a refresh
 *    token is a valid access token whenever the two secrets happen to match, and a
 *    30-day credential is accepted where a 15-minute one was intended.
 * 3. **A separate secret from the platform's.** `ADMIN_JWT_SECRET` is not
 *    `JWT_SECRET`; geo-tracker holds the latter, and sharing it would let a
 *    geo-tracker compromise mint admin sessions.
 *
 * `jwt.verify` is pinned to HS256 via `algorithms`, closing `alg: none` and
 * algorithm-confusion — the same pin geo-tracker applies with `WithValidMethods`.
 */

const ALGORITHM = 'HS256' as const;

export type TokenType = 'access' | 'refresh';

export interface AccessTokenClaims {
    sub: string;      // adminId
    sid: string;      // sessionId
    tier: AdminTier;
    typ: 'access';
    iat: number;
    exp: number;
}

export interface RefreshTokenClaims {
    sub: string;
    sid: string;
    typ: 'refresh';
    /** Per-token nonce. Rotation changes it, which is what makes reuse detectable. */
    jti: string;
    iat: number;
    exp: number;
}

export function newSessionId(): string {
    return randomUUID();
}

/**
 * Access-token lifetime in seconds, reported to the client as `expiresIn` so the
 * dashboard can refresh proactively instead of waiting for a 401.
 */
export function accessTokenTtl(): number {
    return env().ADMIN_ACCESS_TOKEN_TTL;
}

/**
 * Refresh tokens are stored as a SHA-256 digest, never in plaintext.
 *
 * Not bcrypt: the value is already 256+ bits of entropy from `randomUUID`, so it is
 * not brute-forceable and a slow KDF buys nothing while costing ~100ms on the refresh
 * path. The digest exists so a dump of the session store cannot be replayed.
 */
export function fingerprint(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}

export function signAccessToken(adminId: string, sessionId: string, tier: AdminTier): string {
    const config = env();
    return jwt.sign(
        { sub: adminId, sid: sessionId, tier, typ: 'access' satisfies TokenType },
        config.ADMIN_JWT_SECRET,
        { algorithm: ALGORITHM, expiresIn: config.ADMIN_ACCESS_TOKEN_TTL },
    );
}

/**
 * The refresh token's lifetime is the session's ABSOLUTE cap. Idle expiry is enforced
 * by the Redis TTL, so a token that outlives an idle session is rejected server-side —
 * whereas a token expiring before the idle window would log out an active admin.
 */
export function signRefreshToken(adminId: string, sessionId: string): string {
    const config = env();
    return jwt.sign(
        { sub: adminId, sid: sessionId, typ: 'refresh' satisfies TokenType, jti: randomUUID() },
        config.ADMIN_JWT_REFRESH_SECRET,
        { algorithm: ALGORITHM, expiresIn: config.ADMIN_SESSION_ABSOLUTE_TTL },
    );
}

function verifyWith(token: string, secret: string, expected: TokenType): jwt.JwtPayload {
    let decoded: jwt.JwtPayload | string;
    try {
        decoded = jwt.verify(token, secret, { algorithms: [ALGORITHM] });
    } catch (error) {
        if (error instanceof jwt.TokenExpiredError) {
            throw createAppError(ERROR_CODES.ADMIN_AUTH_TOKEN_EXPIRED, 401);
        }
        // Bad signature, tampered payload, wrong algorithm, malformed — all one answer.
        // Distinguishing them tells an attacker which part of the forgery to fix.
        throw createAppError(ERROR_CODES.ADMIN_AUTH_TOKEN_INVALID, 401);
    }

    if (typeof decoded === 'string') {
        throw createAppError(ERROR_CODES.ADMIN_AUTH_TOKEN_INVALID, 401);
    }
    if (decoded.typ !== expected) {
        // A refresh token presented as an access token, or vice versa.
        throw createAppError(ERROR_CODES.ADMIN_AUTH_TOKEN_INVALID, 401);
    }
    if (typeof decoded.sub !== 'string' || typeof decoded.sid !== 'string') {
        throw createAppError(ERROR_CODES.ADMIN_AUTH_TOKEN_INVALID, 401);
    }
    return decoded;
}

export function verifyAccessToken(token: string): AccessTokenClaims {
    const decoded = verifyWith(token, env().ADMIN_JWT_SECRET, 'access');

    // The tier in the token is a hint for logging only — `requireAdmin` re-reads the
    // authoritative value from the account on every request, so a demotion takes effect
    // immediately rather than at token expiry. A malformed claim is still a bad token.
    if (!isAdminTier(decoded.tier)) {
        throw createAppError(ERROR_CODES.ADMIN_AUTH_TOKEN_INVALID, 401);
    }

    return {
        sub: decoded.sub as string,
        sid: decoded.sid as string,
        tier: decoded.tier,
        typ: 'access',
        iat: decoded.iat as number,
        exp: decoded.exp as number,
    };
}

export function verifyRefreshToken(token: string): RefreshTokenClaims {
    const decoded = verifyWith(token, env().ADMIN_JWT_REFRESH_SECRET, 'refresh');

    if (typeof decoded.jti !== 'string') {
        throw createAppError(ERROR_CODES.ADMIN_AUTH_TOKEN_INVALID, 401);
    }

    return {
        sub: decoded.sub as string,
        sid: decoded.sid as string,
        typ: 'refresh',
        jti: decoded.jti,
        iat: decoded.iat as number,
        exp: decoded.exp as number,
    };
}
