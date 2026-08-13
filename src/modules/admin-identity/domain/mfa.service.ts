import { authenticator } from 'otplib';
import { createCipheriv, createDecipheriv, randomBytes, createHash, randomUUID } from 'crypto';
import { env } from '../../../config/env';
import { getRedisClient, ADMIN_SESSION_DB } from '../../../infra/redis/redis.factory';
import { AdminTier } from './admin-identity.types';

/**
 * TOTP two-factor authentication.
 *
 * jovi-mall stores `two_factor_enabled` on both its admin and vendor models and returns
 * it in the profile DTO — and enforces it nowhere. A flag that reports a protection
 * nobody applies is worse than no flag: it tells an operator they are covered.
 *
 * Enrolment is two-step on purpose. `beginEnrolment` issues a secret but leaves it
 * INACTIVE; only `activateEnrolment`, after a correct code proves the authenticator app
 * actually holds it, sets `mfa_enrolled`. A one-step enrolment locks an admin out of
 * their own account whenever the QR was mis-scanned.
 */

/** ±1 step (30s each), so a code is accepted from 30s before to 30s after. Covers clock drift. */
authenticator.options = { window: 1 };

const ISSUER = 'WiMall Admin';

/**
 * The TOTP secret is encrypted at rest with AES-256-GCM.
 *
 * A password hash is one-way, but a TOTP secret must be recoverable to verify a code —
 * so a dump of `admin_accounts` would otherwise hand over a working second factor for
 * every admin. The key derives from ADMIN_JWT_SECRET, which is already required, secret,
 * and fail-closed at boot.
 */
function encryptionKey(): Buffer {
    return createHash('sha256').update(`mfa:${env().ADMIN_JWT_SECRET}`).digest();
}

export function encryptSecret(secret: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
    const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [iv.toString('base64'), tag.toString('base64'), encrypted.toString('base64')].join('.');
}

export function decryptSecret(payload: string): string {
    const [ivB64, tagB64, dataB64] = payload.split('.');
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivB64, 'base64'));
    // GCM's auth tag makes tampering a decrypt failure rather than silent garbage.
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

export interface EnrolmentOffer {
    /** Plaintext, returned ONCE so the admin can type it if the QR will not scan. */
    secret: string;
    /** Encrypted form, for storage. */
    encryptedSecret: string;
    /** `otpauth://` URI the dashboard renders as a QR code. */
    otpauthUri: string;
}

export function beginEnrolment(email: string): EnrolmentOffer {
    const secret = authenticator.generateSecret();
    return {
        secret,
        encryptedSecret: encryptSecret(secret),
        otpauthUri: authenticator.keyuri(email, ISSUER, secret),
    };
}

export function verifyCode(code: string, encryptedSecret: string): boolean {
    try {
        return authenticator.verify({ token: code, secret: decryptSecret(encryptedSecret) });
    } catch {
        // A corrupt or undecryptable secret is a failed verification, never an exception
        // that reaches the client as a 500 and reveals the account has broken MFA state.
        return false;
    }
}

/** Whether this tier is required to hold TOTP. Lower number = higher privilege. */
export function mfaRequiredForTier(tier: AdminTier): boolean {
    return tier <= env().ADMIN_MFA_REQUIRED_TIER;
}

// ─── MFA challenge ───────────────────────────────────────────────────────────
//
// Between a correct password and a correct TOTP code the admin is half-authenticated.
// That state needs somewhere to live, and it must NOT be a session — a session that
// exists before the second factor is a session that skipped it.
//
// So a challenge is its own short-lived Redis record with no token attached. It names
// the admin, expires in minutes, and can be exchanged exactly once.

const CHALLENGE_KEY = (id: string) => `mfa-challenge:${id}`;
const CHALLENGE_TTL_S = 300; // 5 minutes — long enough to open an authenticator app

export interface MfaChallenge {
    adminId: string;
    ip: string | null;
    userAgent: string | null;
}

export async function createChallenge(challenge: MfaChallenge): Promise<string> {
    const id = randomUUID();
    const redis = await getRedisClient(ADMIN_SESSION_DB);
    await redis.set(CHALLENGE_KEY(id), JSON.stringify(challenge), { EX: CHALLENGE_TTL_S });
    return id;
}

/**
 * Read a challenge WITHOUT consuming it — a wrong code must leave the challenge usable,
 * or a typo forces the admin back through the password step. Consumption happens only
 * on success, via `consumeChallenge`.
 */
export async function readChallenge(id: string): Promise<MfaChallenge | null> {
    const redis = await getRedisClient(ADMIN_SESSION_DB);
    const raw = await redis.get(CHALLENGE_KEY(id));
    return raw ? (JSON.parse(raw) as MfaChallenge) : null;
}

export async function consumeChallenge(id: string): Promise<void> {
    const redis = await getRedisClient(ADMIN_SESSION_DB);
    await redis.del(CHALLENGE_KEY(id));
}
