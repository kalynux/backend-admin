import { ErrorCode, ERROR_CODES } from './error-codes';
import { categoryFor, ErrorCategory } from './error-category';

/**
 * Base error class for every application error.
 *
 * Ported verbatim from `jovi-mall/src/core/errors.ts` — same constructor signature and
 * the same `isOperational` semantics, so an engineer moving between the two services
 * does not have to relearn error handling.
 *
 * - `code`           — machine-readable identifier from the ERROR_CODES registry
 * - `statusCode`     — HTTP status
 * - `category`       — the Phase-16 taxonomy value, DERIVED from (code, statusCode)
 * - `isOperational`  — true for expected domain errors; false for programming/infra bugs.
 *                      The global handler uses it to pick log severity.
 * - `details`        — optional supplemental data
 *
 * ── `category` is computed in the constructor, not the factory ────────────────
 * This service has no `AppError` subclasses and `new AppError(...)` appears exactly once,
 * inside `createAppError` — so the two are equivalent here today. It sits in the
 * constructor anyway, to stay identical to jovi-mall (where four subclasses DO call
 * `super()` directly) and so that a subclass added later cannot arrive without a category.
 *
 * ── What decides what ─────────────────────────────────────────────────────────
 * `category` decides what reaches the caller; `isOperational` decides log severity. They
 * are not substitutes: a 503 dependency failure is non-operational AND masked, while a 503
 * maintenance window elsewhere on the platform is operational and NOT masked.
 */
export class AppError extends Error {
    public readonly category: ErrorCategory;

    constructor(
        public readonly message: string,
        public readonly statusCode: number,
        public readonly code: ErrorCode,
        public readonly isOperational = true,
        public readonly details?: Record<string, unknown>,
    ) {
        super(message);
        Object.setPrototypeOf(this, new.target.prototype);
        Error.captureStackTrace(this, this.constructor);
        this.category = categoryFor(code, statusCode);
    }
}

/** Default messages keyed to code, so throw-sites stay terse. */
/**
 * Exported since Phase 16: the global handler substitutes a code's registry copy for the
 * thrown message when the category is not client-safe, and `test:contract` already asserts
 * every code has one — so this is the source the masking reaches for.
 */
export const DEFAULT_MESSAGES: Partial<Record<ErrorCode, string>> = {
    [ERROR_CODES.INTERNAL_SERVER_ERROR]: 'Something went wrong',
    [ERROR_CODES.NOT_FOUND]: 'Resource not found',
    [ERROR_CODES.VALIDATION_ERROR]: 'Validation failed',
    [ERROR_CODES.RATE_LIMIT_EXCEEDED]: 'Too many requests',
    [ERROR_CODES.REQUEST_BODY_INVALID]: 'The request body is not valid JSON',
    [ERROR_CODES.REQUEST_BODY_TOO_LARGE]: 'The request body is too large',
    [ERROR_CODES.REQUEST_MEDIA_TYPE_UNSUPPORTED]: 'Unsupported content type',
    [ERROR_CODES.CONFIG_INVALID_ENV]: 'Environment configuration is invalid',
    [ERROR_CODES.CONFIG_MISSING_SECRET]: 'A required secret is not configured',
    [ERROR_CODES.CONFIG_NOTIFICATION_COVERAGE_INCOMPLETE]:
        'A notification type has no producer, or a source gates on an unknown permission',
    [ERROR_CODES.NOTIFICATION_NOT_FOUND]: 'No such notification in your inbox',
    [ERROR_CODES.SERVICE_DEPENDENCY_UNAVAILABLE]: 'A required dependency is unavailable',
    [ERROR_CODES.PLATFORM_OPERATION_REJECTED]: 'The platform rejected this operation',
    [ERROR_CODES.DATABASE_UNIQUE_CONSTRAINT_VIOLATION]: 'A record with this value already exists',

    [ERROR_CODES.AUDIT_STORE_NOT_TRANSACTIONAL]:
        'The wi-admin database does not support transactions, so administrator actions cannot be audited atomically',
    [ERROR_CODES.AUDIT_CATALOG_INVALID]: 'The audit action registry is inconsistent',
    [ERROR_CODES.AUDIT_COVERAGE_INCOMPLETE]: 'An action would go unrecorded, or a recorded action has no producer',
    // `AUDIT_LEGACY_FEED_DISABLED` rendered here. Gone at Phase 5 Part D — see `error-codes.ts`.
    [ERROR_CODES.SYSTEM_CONFIG_EXPOSURE_UNSAFE]: 'The exposed configuration list names a secret',
    [ERROR_CODES.SYSTEM_FEATURE_FLAG_CATALOG_INVALID]: 'The feature flag registry is inconsistent',
    [ERROR_CODES.DEV_TOOLS_DISABLED]: 'Developer tools are switched off',
    [ERROR_CODES.SYSTEM_ERROR_QUERY_TOO_BROAD]:
        'Narrow the search: supply a request reference, or an error code with a start date',
    [ERROR_CODES.DEV_TOOLS_WORKER_UNKNOWN]: 'No such background worker',
    [ERROR_CODES.DEV_TOOLS_WORKER_BUSY]: 'That worker is already running',
    [ERROR_CODES.AUDIT_ENTRY_NOT_FOUND]: 'Audit entry not found',
    [ERROR_CODES.AUDIT_EXPORT_NOT_FOUND]: 'Audit export not found',
    [ERROR_CODES.AUDIT_EXPORT_TOO_LARGE]: 'That range covers too many rows to export in a request',
    [ERROR_CODES.AUDIT_EXPORT_INCOMPLETE]: 'This export did not finish, so its file is not available',
    [ERROR_CODES.AUDIT_EXPORT_FILE_MISSING]: 'The export file is no longer on disk',
    [ERROR_CODES.AUTHZ_PERMISSION_DENIED]: 'You do not have permission to perform this action',
    [ERROR_CODES.AUTHZ_TIER_INSUFFICIENT]: 'Your administrator level does not permit this action',

    // Escalation refusals name the RULE, not the caller's standing. "You are tier 2 and
    // the target is tier 1" would answer a question the caller should not get to ask by
    // probing; "administrators at or above your own level" states the policy instead.
    [ERROR_CODES.AUTHZ_SELF_ACTION_FORBIDDEN]: 'This action cannot be performed on your own account',
    [ERROR_CODES.AUTHZ_TARGET_TIER_PROTECTED]:
        'You cannot perform this action on an administrator at or above your own level',
    [ERROR_CODES.AUTHZ_TIER_ESCALATION_FORBIDDEN]:
        'You cannot assign an administrator level at or above your own',

    [ERROR_CODES.AUTHZ_APPROVAL_REQUIRED]: 'This action requires a second administrator’s approval',
    [ERROR_CODES.AUTHZ_APPROVAL_NOT_FOUND]: 'Approval request not found',
    [ERROR_CODES.AUTHZ_APPROVAL_SELF_APPROVAL]: 'You cannot approve a request you made yourself',
    [ERROR_CODES.AUTHZ_APPROVAL_EXPIRED]: 'This approval request has expired',
    [ERROR_CODES.AUTHZ_APPROVAL_ALREADY_RESOLVED]: 'This approval request has already been decided',

    // Boot-time only. These never reach a client — the process exits first.
    [ERROR_CODES.AUTHZ_ROUTE_UNDECLARED]: 'A route was registered without declaring who may call it',
    [ERROR_CODES.AUTHZ_GRANT_TABLE_INVALID]: 'The tier permission table is inconsistent',

    // One message for every credential failure, matching the single code. A distinct
    // message would leak exactly what the shared code exists to hide.
    [ERROR_CODES.ADMIN_AUTH_INVALID_CREDENTIALS]: 'Invalid credentials',
    [ERROR_CODES.ADMIN_AUTH_ACCOUNT_LOCKED]: 'Account temporarily locked after too many failed attempts',
    [ERROR_CODES.ADMIN_AUTH_ACCOUNT_SUSPENDED]: 'This administrator account is suspended',
    [ERROR_CODES.ADMIN_AUTH_MISSING_TOKEN]: 'Authentication required',
    [ERROR_CODES.ADMIN_AUTH_TOKEN_INVALID]: 'Invalid authentication token',
    [ERROR_CODES.ADMIN_AUTH_TOKEN_EXPIRED]: 'Authentication token has expired',
    [ERROR_CODES.ADMIN_AUTH_SESSION_REVOKED]: 'This session is no longer valid',
    [ERROR_CODES.ADMIN_AUTH_SESSION_EXPIRED]: 'This session has expired',
    [ERROR_CODES.ADMIN_AUTH_REFRESH_REUSED]: 'This session has been ended for security reasons',
    [ERROR_CODES.ADMIN_AUTH_MFA_REQUIRED]: 'Two-factor authentication is required',
    [ERROR_CODES.ADMIN_AUTH_MFA_INVALID]: 'Invalid two-factor code',
    [ERROR_CODES.ADMIN_AUTH_MFA_ALREADY_ENROLLED]: 'Two-factor authentication is already active',
    [ERROR_CODES.ADMIN_AUTH_MFA_NOT_ENROLLED]: 'Two-factor authentication is not set up',
    [ERROR_CODES.ADMIN_AUTH_CSRF_INVALID]: 'Missing or invalid CSRF token',
    [ERROR_CODES.ADMIN_AUTH_PASSWORD_WEAK]: 'Password does not meet the minimum requirements',
    [ERROR_CODES.ADMIN_ACCOUNT_NOT_FOUND]: 'Administrator not found',
    [ERROR_CODES.ADMIN_SESSION_NOT_FOUND]: 'Session not found',
    [ERROR_CODES.ADMIN_ACCOUNT_ALREADY_EXISTS]: 'An administrator with this email already exists',
    [ERROR_CODES.PAYOUT_DESTINATION_ABSENT]: 'This payout request carries no destination on file',
    [ERROR_CODES.ACCOUNT_OWNER_NOT_FOUND]: 'No vendor, agency or agent with this id',
    [ERROR_CODES.PAYOUT_NOT_PENDING]: 'This payout request has already been resolved',
    [ERROR_CODES.CONTRACT_NOT_FOUND]: 'No agent–agency contract with this id',
    [ERROR_CODES.TICKET_NOT_FOUND]: 'No support ticket with this id',
    [ERROR_CODES.TICKET_ALREADY_ASSIGNED]: 'This ticket is already held by an administrator',
    [ERROR_CODES.FILE_NOT_FOUND]: 'This file no longer exists',
    [ERROR_CODES.FILE_DELETE_NOT_CONFIRMED]:
        'Repeat the file id in the request body to confirm this permanent delete',
    [ERROR_CODES.BLOG_ARTICLE_NOT_FOUND]: 'No article with this id',
    [ERROR_CODES.BLOG_ARTICLE_KEY_TAKEN]: 'An article already uses this id',
    [ERROR_CODES.BLOG_ARTICLE_NOT_PUBLISHABLE]: 'This article is not ready to publish',
    [ERROR_CODES.BLOG_ARTICLE_ALREADY_PUBLISHED]: 'This article is already published',
    [ERROR_CODES.BLOG_ARTICLE_DELETE_NOT_ALLOWED]:
        'This article has been published before, so it cannot be deleted — archive it instead',
    [ERROR_CODES.BLOG_SLUG_TAKEN]: 'Another article already answers to this slug in that language',
    [ERROR_CODES.BLOG_SLUG_RESERVED]: 'That slug is reserved and would collide with a route',
    [ERROR_CODES.BLOG_AUTHOR_NOT_FOUND]: 'No article author with this id',
    [ERROR_CODES.BLOG_AUTHOR_KEY_TAKEN]: 'An article author already uses this id',
    [ERROR_CODES.BLOG_AUTHOR_IN_USE]: 'Articles still credit this byline, so it cannot be removed',
    [ERROR_CODES.USER_CHANNEL_UNAVAILABLE]: 'This person has no address on that channel',
    [ERROR_CODES.USER_CREDENTIAL_LINK_THROTTLED]: 'Too many links have been sent recently — try again shortly',
    [ERROR_CODES.USER_LOGIN_LINK_ROLE_UNSUPPORTED]: 'A sign-in link is only available for customers',
};

/**
 * Primary factory for domain errors. Use this instead of `throw new Error(...)` —
 * ESLint enforces it.
 *
 * @example
 *   throw createAppError(ERROR_CODES.NOT_FOUND, 404);
 *   throw createAppError(ERROR_CODES.AUTHZ_TIER_INSUFFICIENT, 403, undefined, { required: 2 });
 */
export function createAppError(
    code: ErrorCode,
    statusCode: number,
    message?: string,
    details?: Record<string, unknown>,
): AppError {
    const resolved = message ?? DEFAULT_MESSAGES[code] ?? 'An error occurred';
    // 5xx means we did something wrong, not the caller — surface it as non-operational
    // so the handler logs a stack instead of a one-line warning.
    const isOperational = statusCode < 500;
    return new AppError(resolved, statusCode, code, isOperational, details);
}
