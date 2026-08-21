import { ErrorCode, ERROR_CODES } from './error-codes';

/**
 * The nine-value error taxonomy (Phase 16).
 *
 * Mirrors `jovi-mall/src/core/error-category.ts`. There is no shared package between the
 * three services, so **`test:contract` asserts the exact nine sorted names against a
 * hardcoded literal** — that assertion is the contract copy. geo-tracker holds the third
 * copy in `internal/platform/apperror/category.go`.
 *
 * A category drives exposure and telemetry and nothing else. Nothing branches business
 * logic on it, which is what makes deriving it from a table safe: a wrong derivation
 * degrades a diagnostic rather than changing what the service does.
 */
export const ERROR_CATEGORIES = Object.freeze({
    /** Who are you? — no credential, a bad one, an expired one, a disabled account. */
    AUTHENTICATION: 'authentication',
    /** May you? — a known administrator reaching something their level does not grant. */
    AUTHORIZATION: 'authorization',
    /** The request could not be read, or failed a schema rule. */
    VALIDATION: 'validation',
    /** No such thing — including "exists, addressed to someone else". */
    NOT_FOUND: 'not_found',
    /** The state moved underneath the caller: a compare-and-set miss, a duplicate key. */
    CONFLICT: 'conflict',
    /** Well-formed, permitted, and refused by a rule. */
    BUSINESS_RULE: 'business_rule',
    /** Too many requests. */
    RATE_LIMIT: 'rate_limit',
    /** Somebody else's fault: jovi-mall, Mongo, Redis, geo-tracker. */
    EXTERNAL_SERVICE: 'external_service',
    /** Ours. A bug, a broken invariant, a misconfiguration. */
    INTERNAL: 'internal',
} as const);

export type ErrorCategory = (typeof ERROR_CATEGORIES)[keyof typeof ERROR_CATEGORIES];

export const ERROR_CATEGORY_VALUES: readonly ErrorCategory[] = Object.freeze(
    Object.values(ERROR_CATEGORIES),
);

export function isErrorCategory(value: unknown): value is ErrorCategory {
    return typeof value === 'string' && (ERROR_CATEGORY_VALUES as readonly string[]).includes(value);
}

/**
 * The categories whose `message` and `details` may reach a caller unchanged.
 *
 * Used twice: by the global handler on the way out, and by `platform.client.ts` deciding
 * whether jovi-mall's `details` may be forwarded. The second use is why this is exported
 * rather than kept private to `detail-policy.ts`.
 */
export const CLIENT_SAFE_CATEGORIES: ReadonlySet<ErrorCategory> = Object.freeze(
    new Set<ErrorCategory>([
        ERROR_CATEGORIES.AUTHENTICATION,
        ERROR_CATEGORIES.AUTHORIZATION,
        ERROR_CATEGORIES.VALIDATION,
        ERROR_CATEGORIES.NOT_FOUND,
        ERROR_CATEGORIES.CONFLICT,
        ERROR_CATEGORIES.BUSINESS_RULE,
        ERROR_CATEGORIES.RATE_LIMIT,
    ]),
);

// ─────────────────────────────────────────────────────────────────────────────
// Tier 1 — the override table
// ─────────────────────────────────────────────────────────────────────────────

interface CategoryOverride {
    category: ErrorCategory;
    /** Why the status is the wrong answer here. Asserted non-empty by `test:contract`. */
    reason: string;
}

/**
 * Codes whose category the status rule gets wrong.
 *
 * Smaller than jovi-mall's because this service's 61 codes were written after the status
 * conventions were, so most of them already agree with the rule.
 */
export const CATEGORY_OVERRIDES: Partial<Record<ErrorCode, CategoryOverride>> = Object.freeze({
    // ── 403s that end the session rather than deny one resource ──────────────
    // An authorization failure is survivable by asking for something else; these are not.
    // Categorising them as authentication is what makes "sign out and back in" the obvious
    // client handler instead of leaving an administrator on a page they can no longer use.
    [ERROR_CODES.ADMIN_AUTH_ACCOUNT_SUSPENDED]: {
        category: ERROR_CATEGORIES.AUTHENTICATION,
        reason: 'A 403 on the wire, but the account cannot authenticate at all — not a per-resource denial',
    },
    [ERROR_CODES.ADMIN_AUTH_MFA_REQUIRED]: {
        category: ERROR_CATEGORIES.AUTHENTICATION,
        reason: 'A 403, but it names an unfinished credential step — the session is half-authenticated',
    },
    [ERROR_CODES.ADMIN_AUTH_CSRF_INVALID]: {
        category: ERROR_CATEGORIES.AUTHENTICATION,
        reason:
            'A 403, but nothing about the administrator’s grants is wrong — the request could not be '
            + 'attributed to them. The remedy is a fresh token, not a different permission',
    },
    [ERROR_CODES.ADMIN_AUTH_ACCOUNT_LOCKED]: {
        category: ERROR_CATEGORIES.AUTHENTICATION,
        reason: 'A 423 Locked, but it is a credential outcome — the one login failure that admits the account exists',
    },

    // ── 409s and 404s that are decisions, not races ──────────────────────────
    [ERROR_CODES.DEV_TOOLS_DISABLED]: {
        category: ERROR_CATEGORIES.BUSINESS_RULE,
        reason:
            'A 409 chosen because the caller HOLDS the permission and the service is refusing right now. '
            + 'Nothing changed underneath them, so conflict would send them looking for a race that is not there',
    },
    // `AUDIT_LEGACY_FEED_DISABLED` was classified here. Deleted at Phase 5 Part D with the
    // route that raised it and the flag that turned it on — a catalogued code no route can
    // ever answer is a promise to a client that nothing keeps.

    // ── Config faults raised at boot ─────────────────────────────────────────
    // These never reach a client (the process exits first), but they are journaled, and an
    // operator reading `external_service` on a bad env var would look at the wrong system.
    [ERROR_CODES.CONFIG_INVALID_ENV]: {
        category: ERROR_CATEGORIES.INTERNAL,
        reason: 'Boot-time config validation — ours, whatever status it is raised at',
    },
    [ERROR_CODES.CONFIG_MISSING_SECRET]: {
        category: ERROR_CATEGORIES.INTERNAL,
        reason: 'Boot-time config validation — ours, whatever status it is raised at',
    },
});

// ─────────────────────────────────────────────────────────────────────────────
// Tier 2 — the dependency rule
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Codes that always mean "a service we do not own did not cooperate", at any status.
 *
 * `SERVICE_DEPENDENCY_UNAVAILABLE` is raised at both 502 and 503 and `PLATFORM_OPERATION_REJECTED`
 * carries jovi-mall's ORIGINAL 4xx status — so for that second one the status rule would
 * happily call a forwarded 404 `not_found`. Which it is, from the caller's point of view:
 * the record does not exist. That is the right answer and it is why this set contains only
 * the first code. Listed rather than prefix-matched, because this service has no integration
 * prefixes the way jovi-mall does.
 */
const DEPENDENCY_CODES: ReadonlySet<string> = Object.freeze(
    new Set<string>([ERROR_CODES.SERVICE_DEPENDENCY_UNAVAILABLE]),
);

// ─────────────────────────────────────────────────────────────────────────────
// Tier 3 — the status rule
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Exact-status answers. Byte-identical to jovi-mall's table, deliberately — an
 * administrator reading a forwarded platform error and a vendor reading the original must
 * get the same category for the same status, or the taxonomy means two things.
 */
const STATUS_CATEGORY: Readonly<Record<number, ErrorCategory>> = Object.freeze({
    400: ERROR_CATEGORIES.VALIDATION,
    401: ERROR_CATEGORIES.AUTHENTICATION,
    403: ERROR_CATEGORIES.AUTHORIZATION,
    404: ERROR_CATEGORIES.NOT_FOUND,
    409: ERROR_CATEGORIES.CONFLICT,
    410: ERROR_CATEGORIES.NOT_FOUND,
    413: ERROR_CATEGORIES.VALIDATION,
    415: ERROR_CATEGORIES.VALIDATION,
    422: ERROR_CATEGORIES.BUSINESS_RULE,
    423: ERROR_CATEGORIES.BUSINESS_RULE,
    429: ERROR_CATEGORIES.RATE_LIMIT,
    502: ERROR_CATEGORIES.EXTERNAL_SERVICE,
    503: ERROR_CATEGORIES.EXTERNAL_SERVICE,
    504: ERROR_CATEGORIES.EXTERNAL_SERVICE,
});

/**
 * The category of an error, from its code and the status it is raised at.
 *
 * Total over every integer — an unrecognised status is `internal`, because a status we
 * cannot classify is a bug in us.
 */
export function categoryFor(code: string, statusCode: number): ErrorCategory {
    const override = CATEGORY_OVERRIDES[code as ErrorCode];
    if (override) return override.category;

    if (DEPENDENCY_CODES.has(code)) return ERROR_CATEGORIES.EXTERNAL_SERVICE;

    const exact = STATUS_CATEGORY[statusCode];
    if (exact) return exact;

    if (statusCode >= 400 && statusCode < 500) return ERROR_CATEGORIES.BUSINESS_RULE;
    return ERROR_CATEGORIES.INTERNAL;
}

/**
 * The one-line explanation a Support administrator reads instead of the internal message.
 *
 * Per category, not per code. Worded for someone on a call with a vendor or a customer —
 * this is the text that makes tier 3's projection useful rather than merely safe.
 */
export const SUPPORT_HINTS: Readonly<Record<ErrorCategory, string>> = Object.freeze({
    [ERROR_CATEGORIES.AUTHENTICATION]:
        'The caller was not signed in, or their session had ended. Ask them to sign in again.',
    [ERROR_CATEGORIES.AUTHORIZATION]:
        'The caller is signed in but reached something that is not theirs. Check which account and role they are using.',
    [ERROR_CATEGORIES.VALIDATION]:
        'The request was malformed or failed a field rule. Usually a client-side problem — ask what they entered.',
    [ERROR_CATEGORIES.NOT_FOUND]:
        'The record does not exist, or does not belong to that caller. Confirm the reference they used.',
    [ERROR_CATEGORIES.CONFLICT]:
        'Something changed underneath them — often another person acting at the same moment. Ask them to reload and retry.',
    [ERROR_CATEGORIES.BUSINESS_RULE]:
        'The platform refused this on purpose. The message explains which rule; it is not a fault.',
    [ERROR_CATEGORIES.RATE_LIMIT]:
        'Too many requests in a short window. It clears itself — ask them to wait a minute before retrying.',
    [ERROR_CATEGORIES.EXTERNAL_SERVICE]:
        'A service we depend on did not respond. Not the caller’s fault and not fixable by them — escalate with the reference.',
    [ERROR_CATEGORIES.INTERNAL]:
        'A fault on our side. Nothing the caller can do. Escalate with the reference.',
});
