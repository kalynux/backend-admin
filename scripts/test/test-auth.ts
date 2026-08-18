/**
 * Test: the authentication primitives — tokens, passwords, MFA, cookies, error codes.
 *
 * DB-free and Redis-free: everything here is a pure function, a Zod schema or a
 * crypto round-trip. Session lifecycle, lockout and the HTTP flow need real
 * infrastructure and are covered by `npm run verify:live`.
 *
 * The sections that matter most are §1 and §2. §1 proves the token verifier refuses
 * every forgery class — a wrong secret, `alg:none`, a swapped token type — because that
 * verifier is the only thing standing between a crafted string and an admin session.
 * §2 proves the password layer both *runs* a comparison on the miss path and *uses* the
 * result, which are the two independent things jovi-mall gets wrong.
 *
 * Run: npm run test:auth
 */
import jwt from 'jsonwebtoken';
import { suite } from './_assert';

// The token/MFA services read config at call time, so a valid environment must exist
// before they are imported.
process.env.NODE_ENV = 'development';
process.env.MONGO_URI_PLATFORM ||= 'mongodb://localhost:27017/jovi_mall';
process.env.MONGO_URI_ADMIN ||= 'mongodb://localhost:27017/wi-admin';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.ADMIN_DASHBOARD_ORIGINS ||= 'http://localhost:5175';
process.env.ADMIN_JWT_SECRET = 'test-access-secret-not-used-in-any-deployment';
process.env.ADMIN_JWT_REFRESH_SECRET = 'test-refresh-secret-different-from-access';

 
import * as tokens from '../../src/modules/admin-identity/domain/token.service';
import * as passwords from '../../src/modules/admin-identity/domain/password.service';
import * as mfa from '../../src/modules/admin-identity/domain/mfa.service';
import { ERROR_CODES } from '../../src/core/errors/error-codes';
import { AppError } from '../../src/core/errors/app-error';
import { isAdminTier, ADMIN_TIER_LABELS, requireAdminIdentity } from '../../src/modules/admin-identity/domain/admin-identity.types';
import { LoginSchema, MfaVerifySchema } from '../../src/modules/admin-identity/validators/auth.validator';
import { authenticator } from 'otplib';

const t = suite('wi-admin authentication');

const ADMIN_ID = '507f1f77bcf86cd799439011';
const SESSION_ID = tokens.newSessionId();

/** ts-node compiles to CommonJS, which has no top-level await. */
async function main(): Promise<number> {

/** Returns the AppError code a throwing call produced, or null when it did not throw. */
function codeOf(fn: () => unknown): string | null {
    try {
        fn();
        return null;
    } catch (err) {
        return err instanceof AppError ? err.code : 'NOT_AN_APP_ERROR';
    }
}

// ─── 1. Tokens ───────────────────────────────────────────────────────────────

t.section('1. Tokens — the forgery surface');

const access = tokens.signAccessToken(ADMIN_ID, SESSION_ID, 2);
const refresh = tokens.signRefreshToken(ADMIN_ID, SESSION_ID);

t.assert('an access token round-trips', () => {
    const claims = tokens.verifyAccessToken(access);
    return claims.sub === ADMIN_ID && claims.sid === SESSION_ID && claims.tier === 2;
});

t.assert('a refresh token round-trips', () => {
    const claims = tokens.verifyRefreshToken(refresh);
    return claims.sub === ADMIN_ID && claims.sid === SESSION_ID;
});

t.assert('every token carries a session id — the thing that makes revocation possible', () => {
    // jovi-mall's tokens are {userId, role} with no server-side referent, which is
    // exactly why it cannot revoke anything.
    const decoded = jwt.decode(access) as Record<string, unknown>;
    return typeof decoded.sid === 'string' && decoded.sid.length > 0;
});

t.assert('a token signed with the WRONG secret is refused', () => {
    const forged = jwt.sign({ sub: ADMIN_ID, sid: SESSION_ID, tier: 1, typ: 'access' }, 'attacker-secret');
    return codeOf(() => tokens.verifyAccessToken(forged)) === ERROR_CODES.ADMIN_AUTH_TOKEN_INVALID;
});

t.assert("an 'alg: none' token is refused", () => {
    // The classic bypass: no signature, and a verifier that does not pin the algorithm
    // accepts it. Both this service and geo-tracker pin HS256.
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ sub: ADMIN_ID, sid: SESSION_ID, tier: 1, typ: 'access' })).toString('base64url');
    return codeOf(() => tokens.verifyAccessToken(`${header}.${body}.`)) === ERROR_CODES.ADMIN_AUTH_TOKEN_INVALID;
});

t.assert('a REFRESH token is refused where an access token is expected', () =>
    codeOf(() => tokens.verifyAccessToken(refresh)) === ERROR_CODES.ADMIN_AUTH_TOKEN_INVALID);

t.assert('an ACCESS token is refused where a refresh token is expected', () =>
    // Without the `typ` claim these are interchangeable whenever the two secrets match,
    // silently turning a 15-minute credential into a 7-day one.
    codeOf(() => tokens.verifyRefreshToken(access)) === ERROR_CODES.ADMIN_AUTH_TOKEN_INVALID);

t.assert('the two token types use DIFFERENT secrets', () => {
    const wrongSecret = jwt.sign({ sub: ADMIN_ID, sid: SESSION_ID, typ: 'refresh', jti: 'x' }, process.env.ADMIN_JWT_SECRET!);
    return codeOf(() => tokens.verifyRefreshToken(wrongSecret)) === ERROR_CODES.ADMIN_AUTH_TOKEN_INVALID;
});

t.assert('an expired token reports EXPIRED, not INVALID', () => {
    // The client's remedy differs: refresh vs sign in again.
    const expired = jwt.sign(
        { sub: ADMIN_ID, sid: SESSION_ID, tier: 1, typ: 'access' },
        process.env.ADMIN_JWT_SECRET!,
        { expiresIn: -10 },
    );
    return codeOf(() => tokens.verifyAccessToken(expired)) === ERROR_CODES.ADMIN_AUTH_TOKEN_EXPIRED;
});

t.assert('a tampered payload is refused', () => {
    const [h, , s] = access.split('.');
    const swapped = Buffer.from(JSON.stringify({ sub: ADMIN_ID, sid: SESSION_ID, tier: 1, typ: 'access' })).toString('base64url');
    return codeOf(() => tokens.verifyAccessToken(`${h}.${swapped}.${s}`)) === ERROR_CODES.ADMIN_AUTH_TOKEN_INVALID;
});

t.assert('a token whose tier claim is not 1|2|3 is refused', () => {
    const bogus = jwt.sign({ sub: ADMIN_ID, sid: SESSION_ID, tier: 9, typ: 'access' }, process.env.ADMIN_JWT_SECRET!);
    return codeOf(() => tokens.verifyAccessToken(bogus)) === ERROR_CODES.ADMIN_AUTH_TOKEN_INVALID;
});

t.assert('refresh tokens are fingerprinted, never stored in plaintext', () => {
    const fp = tokens.fingerprint(refresh);
    return fp.length === 64 && /^[0-9a-f]+$/.test(fp) && !fp.includes(refresh);
});

t.assert('the fingerprint is stable and distinguishes tokens', () =>
    tokens.fingerprint(refresh) === tokens.fingerprint(refresh)
    && tokens.fingerprint(refresh) !== tokens.fingerprint(tokens.signRefreshToken(ADMIN_ID, SESSION_ID)));

t.assert('two sessions never share an id', () => tokens.newSessionId() !== tokens.newSessionId());

// ─── 2. Passwords ────────────────────────────────────────────────────────────

t.section('2. Passwords — the two defects this replaces');

const PASSWORD = 'a-perfectly-fine-admin-password';
const storedHash = await passwords.hash(PASSWORD);

t.assert('hash() output is bcrypt and is not the input', () =>
    storedHash.startsWith('$2') && !storedHash.includes(PASSWORD));

t.assert('cost factor is 12 (jovi-mall uses 10)', () => storedHash.split('$')[2] === '12');

const correct = await passwords.verify(PASSWORD, storedHash);
const wrong = await passwords.verify('not-the-password', storedHash);

t.assert('the correct password verifies TRUE', () => correct === true);
t.assert('a wrong password verifies FALSE — and callers must branch on it', () => wrong === false);

const dummy = await passwords.verifyAgainstDummy('anything at all');
t.assert('the account-not-found path spends a comparison and returns false', () => dummy === false);

{
    // jovi-mall throws before bcrypt when the account is unknown, so a missing account
    // answers in ~1ms and a wrong password in ~100ms — an existence oracle by timing.
    const startMiss = Date.now();
    await passwords.verifyAgainstDummy('candidate');
    const missMs = Date.now() - startMiss;

    const startHit = Date.now();
    await passwords.verify('candidate', storedHash);
    const hitMs = Date.now() - startHit;

    const ratio = missMs === 0 ? Infinity : hitMs / missMs;
    t.assert(
        `miss ${missMs}ms vs wrong-password ${hitMs}ms — within 3x`,
        () => ratio > 0.33 && ratio < 3,
    );
}

t.assert('a short password is rejected by policy', () => !passwords.checkPasswordPolicy('short').ok);
t.assert('a common password is rejected even at length', () => !passwords.checkPasswordPolicy('password123').ok);
t.assert('a repeated single character is rejected', () => !passwords.checkPasswordPolicy('aaaaaaaaaaaaaaaa').ok);
t.assert('a reasonable password passes', () => passwords.checkPasswordPolicy(PASSWORD).ok);
t.assert('policy failures explain themselves', () => passwords.checkPasswordPolicy('x').problems.length > 0);

t.assert('generated passwords pass the policy and differ each time', () => {
    const a = passwords.generateStrongPassword();
    const b = passwords.generateStrongPassword();
    return a !== b && a.length === 24 && passwords.checkPasswordPolicy(a).ok;
});

// ─── 3. MFA ──────────────────────────────────────────────────────────────────

t.section('3. MFA');

const offer = mfa.beginEnrolment('ops@example.com');

t.assert('enrolment yields a secret, an encrypted form and an otpauth URI', () =>
    offer.secret.length > 0 && offer.encryptedSecret.length > 0 && offer.otpauthUri.startsWith('otpauth://totp/'));

t.assert('the stored secret is ENCRYPTED, not the plaintext', () =>
    !offer.encryptedSecret.includes(offer.secret));

t.assert('encryption round-trips', () => mfa.decryptSecret(offer.encryptedSecret) === offer.secret);

t.assert('a tampered ciphertext fails to decrypt rather than returning garbage', () => {
    // AES-GCM's auth tag is what makes this a failure instead of silent corruption.
    const [iv, tag, data] = offer.encryptedSecret.split('.');
    const flipped = Buffer.from(data, 'base64');
    flipped[0] ^= 0xff;
    try {
        mfa.decryptSecret([iv, tag, flipped.toString('base64')].join('.'));
        return false;
    } catch {
        return true;
    }
});

t.assert('a current TOTP code verifies', () =>
    mfa.verifyCode(authenticator.generate(offer.secret), offer.encryptedSecret));

t.assert('a wrong code does not verify', () => !mfa.verifyCode('000000', offer.encryptedSecret));

t.assert('a malformed encrypted secret returns false instead of throwing', () =>
    mfa.verifyCode('123456', 'not-a-valid-payload') === false);

t.assert('tier 1 requires MFA by default', () => mfa.mfaRequiredForTier(1));
t.assert('tier 3 does not require MFA by default', () => !mfa.mfaRequiredForTier(3));

// ─── 4. Identity types ───────────────────────────────────────────────────────

t.section('4. Identity types');

t.assert('isAdminTier accepts 1, 2 and 3', () => [1, 2, 3].every(isAdminTier));
t.assert('isAdminTier rejects 0, 4 and "2"', () => ![0, 4, '2', null, undefined].some(isAdminTier));
t.assert('every tier has a label', () => [1, 2, 3].every((tier) => Boolean(ADMIN_TIER_LABELS[tier as 1 | 2 | 3])));

t.assert('requireAdminIdentity throws when the guard did not run', () =>
    codeOf(() => requireAdminIdentity({} as never)) === ERROR_CODES.ADMIN_AUTH_MISSING_TOKEN);

t.assert('requireAdminIdentity returns the identity when present', () => {
    const identity = { adminId: ADMIN_ID } as never;
    return requireAdminIdentity({ admin: identity } as never) === identity;
});

// ─── 5. Validators ───────────────────────────────────────────────────────────

t.section('5. Validators');

t.assert('login normalises the email to lowercase', () => {
    const parsed = LoginSchema.safeParse({ email: '  OPS@Example.COM ', password: 'x' });
    return parsed.success && parsed.data.email === 'ops@example.com';
});

t.assert('login rejects a non-email', () => !LoginSchema.safeParse({ email: 'nope', password: 'x' }).success);

t.assert('login accepts ANY non-empty password — strength is enforced on write, not on check', () =>
    // Applying the write policy here would tell an attacker which guesses are worth
    // making, and would lock out admins whose password predates a policy change.
    LoginSchema.safeParse({ email: 'a@b.co', password: 'x' }).success);

t.assert('login rejects an empty password', () => !LoginSchema.safeParse({ email: 'a@b.co', password: '' }).success);

t.assert('MFA verify requires exactly 6 digits', () => {
    const ok = MfaVerifySchema.safeParse({ challengeId: SESSION_ID, code: '123456' }).success;
    const short = MfaVerifySchema.safeParse({ challengeId: SESSION_ID, code: '12345' }).success;
    const alpha = MfaVerifySchema.safeParse({ challengeId: SESSION_ID, code: 'abcdef' }).success;
    return ok && !short && !alpha;
});

// ─── 6. Error registry ───────────────────────────────────────────────────────

t.section('6. Error registry');

t.assert('every key still equals its value', () =>
    Object.entries(ERROR_CODES).every(([key, value]) => key === value));

t.assert('no duplicate values after the Phase 2 additions', () => {
    const values = Object.values(ERROR_CODES);
    return new Set(values).size === values.length;
});

t.assert('all ten planned auth codes are registered', () => {
    const required = [
        'ADMIN_AUTH_INVALID_CREDENTIALS', 'ADMIN_AUTH_ACCOUNT_LOCKED', 'ADMIN_AUTH_ACCOUNT_SUSPENDED',
        'ADMIN_AUTH_SESSION_EXPIRED', 'ADMIN_AUTH_SESSION_REVOKED', 'ADMIN_AUTH_TOKEN_INVALID',
        'ADMIN_AUTH_MFA_REQUIRED', 'ADMIN_AUTH_MFA_INVALID', 'ADMIN_AUTH_REFRESH_REUSED',
        'ADMIN_AUTH_CSRF_INVALID',
    ];
    return required.every((code) => code in ERROR_CODES);
});

t.assert('authentication and authorization use SEPARATE code families', () => {
    // jovi-mall answers a 403 with AUTH_ROLE_NOT_FOUND — a lookup-failure name for a
    // permission decision.
    const authn = Object.keys(ERROR_CODES).filter((k) => k.startsWith('ADMIN_AUTH_'));
    const authz = Object.keys(ERROR_CODES).filter((k) => k.startsWith('AUTHZ_'));
    return authn.length >= 10 && authz.length >= 2;
});

    return t.finish();
}

main()
    .then((code) => process.exit(code))
    .catch((error) => {
        console.error('\n❌ test:auth could not run:', error instanceof Error ? error.stack : error);
        process.exit(1);
    });
