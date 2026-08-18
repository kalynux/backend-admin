/**
 * Test: the Phase 1 foundation — configuration, the error registry, the response
 * envelope, the validation helpers and the log redaction list.
 *
 * DB-free by construction: everything asserted here is a Zod schema, a pure function or a
 * frozen constant. That is why they live outside the services.
 *
 * The point of the file is §1 and §5. §1 proves the configuration FAILS CLOSED — the
 * property that stops this service repeating jovi-mall's `JWT_SECRET || 'secret'`, where a
 * forgotten variable produced a server that booted fine and accepted forged tokens. §5
 * proves the log redaction list still covers every credential-shaped field, which is what
 * stops it repeating the refresh token that was written to stdout on every silent refresh.
 *
 * Run: npm run test:foundation
 */
import { z } from 'zod';
import { suite } from './_assert';
import { parseEnv, formatEnvIssues } from '../../src/config/env';
import { ERROR_CODES } from '../../src/core/errors/error-codes';
import { AppError, createAppError } from '../../src/core/errors/app-error';
import { clearable, csvList } from '../../src/core/validation/zod.helpers';
import { REDACTED_PATHS } from '../../src/core/logging/logger';
import { ERROR_CATEGORY_VALUES } from '../../src/core/errors/error-category';

const t = suite('wi-admin foundation');

// ─── Fixtures ────────────────────────────────────────────────────────────────

const VALID_ENV = {
    NODE_ENV: 'development',
    PORT: '8033',
    MONGO_URI_PLATFORM: 'mongodb://localhost:27017/jovi_mall',
    MONGO_URI_ADMIN: 'mongodb://localhost:27017/wi-admin',
    REDIS_URL: 'redis://localhost:6379',
    ADMIN_DASHBOARD_ORIGINS: 'http://localhost:5175',
    // Added in Phase 2 — required, and deliberately NOT jovi-mall's JWT_SECRET.
    ADMIN_JWT_SECRET: 'foundation-test-access-secret',
    ADMIN_JWT_REFRESH_SECRET: 'foundation-test-refresh-secret',
};

const REQUIRED_KEYS = [
    'MONGO_URI_PLATFORM',
    'MONGO_URI_ADMIN',
    'REDIS_URL',
    'ADMIN_DASHBOARD_ORIGINS',
    'ADMIN_JWT_SECRET',
    'ADMIN_JWT_REFRESH_SECRET',
] as const;

const withoutKey = (key: string) => {
    const clone: Record<string, string> = { ...VALID_ENV };
    delete clone[key];
    return clone;
};

const issuePaths = (env: Record<string, string>): string[] => {
    const result = parseEnv(env);
    return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
};

// ─── 1. Environment configuration fails closed ───────────────────────────────

t.section('1. Environment — fails closed');

t.assert('a complete environment parses', () => parseEnv(VALID_ENV).success);

for (const key of REQUIRED_KEYS) {
    t.assert(`missing ${key} is rejected`, () => !parseEnv(withoutKey(key)).success);
}

t.assert('EVERY missing variable is reported at once, not just the first', () => {
    const bare = { NODE_ENV: 'development' };
    const paths = issuePaths(bare);
    // The operator must fix one list, not restart four times to discover four problems.
    return REQUIRED_KEYS.every((key) => paths.includes(key));
});

t.assert('the failure message names each missing variable', () => {
    const result = parseEnv({ NODE_ENV: 'development' });
    if (result.success) return false;
    const message = formatEnvIssues(result.error);
    return REQUIRED_KEYS.every((key) => message.includes(key));
});

t.assert('PORT defaults to 8033', () => {
    const result = parseEnv(withoutKey('PORT'));
    return result.success && result.data.PORT === 8033;
});

t.assert('PORT is coerced to a number, not left a string', () => {
    const result = parseEnv(VALID_ENV);
    return result.success && typeof result.data.PORT === 'number';
});

t.assert('a non-numeric PORT is rejected', () => !parseEnv({ ...VALID_ENV, PORT: 'http' }).success);

t.assert('an out-of-range PORT is rejected', () => !parseEnv({ ...VALID_ENV, PORT: '99999' }).success);

t.assert('an unknown NODE_ENV is rejected', () => !parseEnv({ ...VALID_ENV, NODE_ENV: 'staging' }).success);

t.assert('ADMIN_DASHBOARD_ORIGINS splits on commas and trims', () => {
    const result = parseEnv({ ...VALID_ENV, ADMIN_DASHBOARD_ORIGINS: 'http://a.test , http://b.test' });
    return result.success && result.data.ADMIN_DASHBOARD_ORIGINS.length === 2
        && result.data.ADMIN_DASHBOARD_ORIGINS[1] === 'http://b.test';
});

t.assert('a scheme-less origin is rejected', () =>
    // `new URL('localhost:5175')` PARSES — it reads `localhost:` as the scheme — so
    // z.string().url() accepts this. It could never equal a browser Origin header, so the
    // dashboard would be CORS-blocked by a config file that looks correct.
    !parseEnv({ ...VALID_ENV, ADMIN_DASHBOARD_ORIGINS: 'localhost:5175' }).success);

t.assert('a non-http scheme is rejected', () =>
    !parseEnv({ ...VALID_ENV, ADMIN_DASHBOARD_ORIGINS: 'ftp://admin.example.com' }).success);

t.assert('an origin carrying a path is rejected', () =>
    !parseEnv({ ...VALID_ENV, ADMIN_DASHBOARD_ORIGINS: 'https://admin.example.com/dashboard' }).success);

t.assert('a trailing slash is accepted and normalised away', () => {
    // Accepted because operators write it; normalised because the comparison against the
    // Origin header at request time is byte-exact.
    const result = parseEnv({ ...VALID_ENV, ADMIN_DASHBOARD_ORIGINS: 'https://admin.example.com/' });
    return result.success && result.data.ADMIN_DASHBOARD_ORIGINS[0] === 'https://admin.example.com';
});

t.assert('a port is preserved through normalisation', () => {
    const result = parseEnv({ ...VALID_ENV, ADMIN_DASHBOARD_ORIGINS: 'http://localhost:5175' });
    return result.success && result.data.ADMIN_DASHBOARD_ORIGINS[0] === 'http://localhost:5175';
});

t.assert('an empty origin list is rejected — a wildcard is never the fallback', () =>
    !parseEnv({ ...VALID_ENV, ADMIN_DASHBOARD_ORIGINS: '' }).success);

t.assert('TRUST_PROXY "false" becomes the boolean false', () => {
    const result = parseEnv({ ...VALID_ENV, TRUST_PROXY: 'false' });
    return result.success && result.data.TRUST_PROXY === false;
});

t.assert('TRUST_PROXY "1" becomes the hop count 1, not the boolean true', () => {
    // Express treats these differently; collapsing them to a boolean would silently
    // trust every hop and put the proxy's IP in the audit log.
    const result = parseEnv({ ...VALID_ENV, TRUST_PROXY: '1' });
    return result.success && result.data.TRUST_PROXY === 1;
});

t.assert('TRUST_PROXY passes a subnet through unchanged', () => {
    const result = parseEnv({ ...VALID_ENV, TRUST_PROXY: '10.0.0.0/8' });
    return result.success && result.data.TRUST_PROXY === '10.0.0.0/8';
});

t.assert('a jovi-mall base URL without a service token is rejected', () =>
    !parseEnv({ ...VALID_ENV, JOVI_MALL_BASE_URL: 'http://localhost:8022' }).success);

t.assert('jovi-mall configured with both variables is accepted', () =>
    parseEnv({
        ...VALID_ENV,
        JOVI_MALL_BASE_URL: 'http://localhost:8022',
        JOVI_MALL_SERVICE_TOKEN: 'a-real-looking-service-token',
    }).success);

t.assert('jovi-mall unset entirely is valid — the client is inert, not broken', () => {
    const result = parseEnv(VALID_ENV);
    return result.success && result.data.JOVI_MALL_BASE_URL === undefined;
});

t.section('1b. Environment — production tightening');

const PROD_ENV = {
    ...VALID_ENV,
    NODE_ENV: 'production',
    ADMIN_DASHBOARD_ORIGINS: 'https://admin.example.com',
};

t.assert('a valid production environment parses', () => parseEnv(PROD_ENV).success);

t.assert('a plain-http origin is rejected in production', () =>
    !parseEnv({ ...PROD_ENV, ADMIN_DASHBOARD_ORIGINS: 'http://admin.example.com' }).success);

t.assert('a placeholder service token is rejected in production', () =>
    !parseEnv({
        ...PROD_ENV,
        JOVI_MALL_BASE_URL: 'https://api.example.com',
        JOVI_MALL_SERVICE_TOKEN: 'changeme',
    }).success);

t.assert('a too-short service token is rejected in production', () =>
    !parseEnv({
        ...PROD_ENV,
        JOVI_MALL_BASE_URL: 'https://api.example.com',
        JOVI_MALL_SERVICE_TOKEN: 'short',
    }).success);

t.assert('the same short token is allowed in development', () =>
    parseEnv({
        ...VALID_ENV,
        JOVI_MALL_BASE_URL: 'http://localhost:8022',
        JOVI_MALL_SERVICE_TOKEN: 'short',
    }).success);

t.assert('a placeholder ADMIN_JWT_SECRET is rejected in production', () =>
    !parseEnv({ ...PROD_ENV, ADMIN_JWT_SECRET: 'changeme' }).success);

t.assert('a short ADMIN_JWT_SECRET is rejected in production', () =>
    !parseEnv({ ...PROD_ENV, ADMIN_JWT_SECRET: 'tooshort' }).success);

t.assert('reusing ONE secret for both token types is rejected in production', () =>
    // Otherwise a stolen access token can be replayed as a 7-day refresh token, and the
    // `typ` claim is the only thing left standing between them.
    !parseEnv({
        ...PROD_ENV,
        ADMIN_JWT_SECRET: 'a-long-enough-production-secret',
        ADMIN_JWT_REFRESH_SECRET: 'a-long-enough-production-secret',
    }).success);

t.assert('distinct long secrets are accepted in production', () =>
    parseEnv({
        ...PROD_ENV,
        ADMIN_JWT_SECRET: 'a-long-enough-production-secret-one',
        ADMIN_JWT_REFRESH_SECRET: 'a-long-enough-production-secret-two',
    }).success);

t.section('1c. Environment — cookie SameSite');

t.assert("SameSite=None is REFUSED outside production", () =>
    // None requires Secure, which is only set in production. Allowing it in dev would
    // produce cookies the browser silently drops — a "login works but /me is 401" that
    // reads as a server bug.
    !parseEnv({ ...VALID_ENV, ADMIN_COOKIE_SAMESITE: 'none' }).success);

t.assert('SameSite=None is accepted in production', () =>
    parseEnv({
        ...PROD_ENV,
        ADMIN_COOKIE_SAMESITE: 'none',
        ADMIN_JWT_SECRET: 'a-long-enough-production-secret-one',
        ADMIN_JWT_REFRESH_SECRET: 'a-long-enough-production-secret-two',
    }).success);

t.assert("SameSite=lax is the default", () => {
    const result = parseEnv(VALID_ENV);
    return result.success && result.data.ADMIN_COOKIE_SAMESITE === 'lax';
});

t.assert('an unknown SameSite value is rejected', () =>
    !parseEnv({ ...VALID_ENV, ADMIN_COOKIE_SAMESITE: 'sometimes' }).success);

t.assert('session TTL defaults are 8h idle / 7d absolute', () => {
    const result = parseEnv(VALID_ENV);
    return result.success
        && result.data.ADMIN_SESSION_IDLE_TTL === 28_800
        && result.data.ADMIN_SESSION_ABSOLUTE_TTL === 604_800;
});

// ─── 2. Error-code registry ──────────────────────────────────────────────────

t.section('2. Error codes');

t.assert('every key equals its value', () =>
    Object.entries(ERROR_CODES).every(([key, value]) => key === value));

t.assert('no duplicate values', () => {
    const values = Object.values(ERROR_CODES);
    return new Set(values).size === values.length;
});

t.assert('the registry is frozen', () => Object.isFrozen(ERROR_CODES));

t.assert('an AUTHZ_* family exists — a 403 is not a lookup failure', () => {
    // jovi-mall returns AUTH_ROLE_NOT_FOUND for an authorization denial, a code that
    // describes a missing record. This service separates the two from the start.
    const codes = Object.keys(ERROR_CODES);
    return codes.includes('AUTHZ_PERMISSION_DENIED') && codes.includes('AUTHZ_TIER_INSUFFICIENT');
});

// ─── 3. AppError ─────────────────────────────────────────────────────────────

t.section('3. AppError');

t.assert('createAppError builds an AppError', () =>
    createAppError(ERROR_CODES.NOT_FOUND, 404) instanceof AppError);

t.assert('a default message is supplied per code', () =>
    createAppError(ERROR_CODES.NOT_FOUND, 404).message === 'Resource not found');

t.assert('an explicit message overrides the default', () =>
    createAppError(ERROR_CODES.NOT_FOUND, 404, 'Admin not found').message === 'Admin not found');

t.assert('4xx is operational', () => createAppError(ERROR_CODES.NOT_FOUND, 404).isOperational === true);

t.assert('5xx is NOT operational — it gets a stack in the log', () =>
    createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 500).isOperational === false);

t.assert('details are carried through', () => {
    const err = createAppError(ERROR_CODES.AUTHZ_TIER_INSUFFICIENT, 403, undefined, { required: 2 });
    return err.details?.required === 2;
});

t.assert('instanceof survives the prototype dance', () => {
    const err = createAppError(ERROR_CODES.NOT_FOUND, 404);
    return err instanceof AppError && err instanceof Error;
});

// ─── 3b. The taxonomy — this service's copy of the cross-service contract ────
//
// ⚠ THIS ASSERTION WAS MISSING, and its absence was invisible because ADR-016 says it
// exists. That document describes the nine-value taxonomy as held by "three hardcoded
// assertions in three repositories", each spelling the names out because there is no
// shared package — jovi-mall's `test:errors` §1 and geo-tracker's `TestCategoryContract`
// do exactly that. This service defined ERROR_CATEGORY_VALUES and asserted nothing about
// it, so wi-admin was the one copy that could drift in silence: renaming a category here
// would have gone green in every check this repository runs.
//
// Sorted before comparing, so the ORDER of the definition is free to change and only the
// SET is the contract. Changing this list means changing it in three repositories.
t.section('3b. Error taxonomy — the cross-service contract copy');

t.assert('exactly nine categories, spelled as the other two services spell them', () => {
    const want = [
        'authentication', 'authorization', 'business_rule', 'conflict',
        'external_service', 'internal', 'not_found', 'rate_limit', 'validation',
    ];
    const got = [...ERROR_CATEGORY_VALUES].sort();
    return got.length === want.length && want.every((value, i) => got[i] === value);
});

// ─── 4. Validation helpers ───────────────────────────────────────────────────

t.section('4. Validation helpers');

const clearableField = z.object({ jobTitle: clearable(z.string().min(1).max(100)) });

t.assert('clearable: an absent key is accepted', () => clearableField.safeParse({}).success);

t.assert('clearable: null clears', () => {
    const result = clearableField.safeParse({ jobTitle: null });
    return result.success && result.data.jobTitle === null;
});

t.assert('clearable: an empty string normalises to null', () => {
    const result = clearableField.safeParse({ jobTitle: '' });
    return result.success && result.data.jobTitle === null;
});

t.assert('clearable: a whitespace-only string normalises to null', () => {
    const result = clearableField.safeParse({ jobTitle: '   ' });
    return result.success && result.data.jobTitle === null;
});

t.assert('clearable: a real value still satisfies the wrapped schema', () => {
    const result = clearableField.safeParse({ jobTitle: 'Operations Lead' });
    return result.success && result.data.jobTitle === 'Operations Lead';
});

t.assert('clearable: an over-long value is still rejected', () =>
    !clearableField.safeParse({ jobTitle: 'x'.repeat(101) }).success);

t.assert('csvList drops empty entries from a trailing comma', () => {
    const result = csvList.safeParse('a, b, ,c,');
    return result.success && result.data.length === 3;
});

// ─── 5. Log redaction ────────────────────────────────────────────────────────

t.section('5. Log redaction — the defect this service must not repeat');

const redacted = new Set<string>(REDACTED_PATHS);

t.assert('the Authorization header is redacted', () => redacted.has('req.headers.authorization'));

t.assert('the Cookie header is redacted', () => redacted.has('req.headers.cookie'));

t.assert('Set-Cookie is redacted — session issuance must not leak the session', () =>
    redacted.has('res.headers["set-cookie"]'));

t.assert('the jovi-mall service token header is redacted', () =>
    redacted.has('req.headers["x-service-token"]'));

t.assert('refreshToken is redacted at any depth — the exact jovi-mall defect', () =>
    redacted.has('*.refreshToken'));

t.assert('every credential-shaped field name is covered', () => {
    const mustCover = [
        'password',
        'passwordHash',
        'password_hash',
        'token',
        'accessToken',
        'refreshToken',
        'secret',
        'serviceToken',
        'totpSecret',
        'mfaSecret',
        'apiKey',
    ];
    return mustCover.every((field) => redacted.has(`*.${field}`));
});

t.assert('wildcard paths are depth-independent (leading *., not a fixed prefix)', () =>
    [...redacted].filter((path) => path.startsWith('*.')).length >= 10);

process.exit(t.finish());
