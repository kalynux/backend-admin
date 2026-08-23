import { z } from 'zod';
import { csvList, httpOrigin } from '../core/validation/zod.helpers';
import { createAppError } from '../core/errors/app-error';
import { ERROR_CODES } from '../core/errors/error-codes';

/**
 * Environment configuration — validated once, frozen, and FAIL CLOSED.
 *
 * jovi-mall reads configuration as scattered `process.env.X || 'default'` expressions.
 * That is how `process.env.JWT_SECRET || 'secret'` came to exist in six separate files:
 * a deploy that forgot the variable booted normally and signed tokens anyone could forge.
 * Nothing here has an inline fallback for a secret, and a missing required variable stops
 * the process before the HTTP server binds.
 *
 * Two properties worth preserving when adding variables:
 *
 *  1. **Every problem is reported at once.** Zod collects all issues, so an operator fixes
 *     one list instead of restarting five times to discover five missing variables.
 *  2. **Optional means genuinely inert**, never "silently degraded". `JOVI_MALL_BASE_URL`
 *     unset disables the platform client outright and readiness says so — the same
 *     convention jovi-mall uses for an unset `GEO_TRACKER_BASE_URL`.
 */

const NODE_ENVS = ['development', 'test', 'production'] as const;

/**
 * Values that are never an acceptable secret in production, whatever their length.
 * Mirrors the list in `jovi-mall/src/config/secrets.config.ts`.
 */
const PLACEHOLDER_SECRETS = new Set([
    'secret',
    'changeme',
    'password',
    'development_secret_do_not_use_in_prod',
    'must_equal_jovi_mall_internal_admin_service_token',
]);

const MIN_SECRET_LENGTH = 16;

const port = z.coerce.number().int().min(1).max(65535);
const positiveInt = z.coerce.number().int().positive();

/**
 * Express's `trust proxy` accepts a boolean, a hop count, or a subnet string, and each
 * means something different. Preserve that rather than forcing a boolean — behind a proxy
 * the wrong value silently records the proxy's IP as the client's, which corrupts both
 * rate limiting and the Phase 3 audit trail.
 */
const trustProxy = z
    .string()
    .default('false')
    .transform((value) => {
        const normalized = value.trim().toLowerCase();
        if (normalized === 'true') return true;
        if (normalized === 'false') return false;
        if (/^\d+$/.test(normalized)) return Number(normalized);
        return value.trim(); // subnet / named preset, passed through to Express
    });

const EnvSchema = z
    .object({
        NODE_ENV: z.enum(NODE_ENVS).default('development'),
        PORT: port.default(8033),
        LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
        SHUTDOWN_TIMEOUT_MS: positiveInt.default(10_000),
        TRUST_PROXY: trustProxy,

        // ── Databases ─────────────────────────────────────────────────────────
        // Two URIs, not one connection + useDb: wi-admin can move to its own server
        // later as a config change with no code change.
        MONGO_URI_PLATFORM: z.string().min(1, 'MONGO_URI_PLATFORM is required'),
        MONGO_URI_ADMIN: z.string().min(1, 'MONGO_URI_ADMIN is required'),

        // ── Redis ─────────────────────────────────────────────────────────────
        // Now a BOOT dependency, not just a readiness item: admin sessions live here,
        // so a service that cannot reach Redis cannot authenticate anyone.
        REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

        // ── Admin authentication ──────────────────────────────────────────────
        // Deliberately NOT jovi-mall's JWT_SECRET. geo-tracker holds that secret, so
        // signing admin sessions with it would mean a geo-tracker compromise mints
        // admin sessions. The cost, accepted: geo-tracker cannot verify admin tokens,
        // so admin live tracking needs a bridge designed in the tracking phase.
        ADMIN_JWT_SECRET: z.string().min(1, 'ADMIN_JWT_SECRET is required'),
        ADMIN_JWT_REFRESH_SECRET: z.string().min(1, 'ADMIN_JWT_REFRESH_SECRET is required'),

        ADMIN_ACCESS_TOKEN_TTL: positiveInt.default(900),          // 15 min, matching the platform
        ADMIN_SESSION_IDLE_TTL: positiveInt.default(28_800),       // 8 h  — Redis TTL, refreshed on use
        ADMIN_SESSION_ABSOLUTE_TTL: positiveInt.default(604_800),  // 7 d  — hard cap, stored in the record

        // Cross-site cookies need SameSite=None, which requires Secure. The dashboard
        // is a separate origin, so this is environment-dependent: 'lax' works in dev
        // behind a proxy, 'none' is required for a genuinely cross-site production
        // deployment. Bearer tokens remain available either way.
        ADMIN_COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),
        ADMIN_COOKIE_DOMAIN: z.string().min(1).optional(),

        ADMIN_LOCKOUT_MAX_ATTEMPTS: positiveInt.default(5),
        ADMIN_LOCKOUT_DURATION_S: positiveInt.default(900),        // 15 min

        /**
         * Per-IP ceiling on the CREDENTIAL endpoints (login, mfa/verify,
         * change-password) per minute. Bounds one source spraying a password across
         * many accounts, which per-account lockout cannot see. Configurable because a
         * deployment behind a shared corporate NAT legitimately needs a higher value —
         * every admin appears as one IP there.
         */
        ADMIN_AUTH_RATE_LIMIT_MAX: positiveInt.default(10),

        /**
         * Per-IP ceiling on `/auth/refresh` per minute — its OWN bucket.
         *
         * A refresh is not a credential guess. It presents a rotating token the caller
         * already holds, so it belongs in no brute-force budget: sharing one with
         * `/auth/login` meant a handful of tab reloads exhausted the allowance and the
         * refresh answered `429`, which a client reads as a dead session and acts on by
         * signing the operator out of a live one.
         *
         * Still bounded, because refresh-token reuse detection is a real signal and an
         * unbounded endpoint is a free oracle. Higher than the credential ceiling
         * because the legitimate rate is genuinely higher: every open tab refreshes on
         * its own schedule, and one browser can hold many.
         */
        ADMIN_REFRESH_RATE_LIMIT_MAX: positiveInt.default(60),

        /** Tiers at or above this level MUST have TOTP active. 1 = developers only. */
        ADMIN_MFA_REQUIRED_TIER: z.coerce.number().int().min(1).max(3).default(1),

        // ── Authorization (Phase 3) ───────────────────────────────────────────
        /**
         * How long a four-eyes approval request stays open, in seconds. Default 24h.
         *
         * Long enough that a request made at the end of a day is still decidable the next
         * morning, short enough that a stale intent — "promote this person", agreed to a
         * month after it was asked for — cannot be committed against a world that moved
         * on. Expired requests are stamped, never deleted: a request nobody acted on is
         * worth keeping.
         */
        ADMIN_APPROVAL_TTL_S: positiveInt.default(86_400),

        /**
         * The minimum gap between two expiry sweeps, in milliseconds. Default 10s.
         *
         * The sweep is lazy — it runs on the approval READ paths rather than from a worker,
         * so listing the queue used to trigger it on every request. That was free while it
         * was one `updateMany`; since Phase 12 each expiry commits its own audit row, so an
         * unthrottled sweep would open a transaction per overdue request per page view.
         *
         * Per-instance and approximate on purpose. Correctness comes from the compare-and-set
         * in `expireOneIfPending`, not from this: two instances sweeping at once produce
         * skips, never duplicate rows. Raising it only delays the *stamp* — `assertDecidable`
         * refuses an overdue request whether or not the sweep has reached it.
         */
        ADMIN_APPROVAL_SWEEP_MIN_INTERVAL_MS: positiveInt.default(10_000),

        /**
         * How long a feature-flag read is cached in-process, in milliseconds. Default 5s.
         *
         * `flagEnabled()` sits on request paths, so an uncached read would add a Mongo
         * round-trip per gated call. The cost of the cache is convergence delay: `setFlag`
         * clears it on the instance that served the write, and every OTHER instance keeps
         * the old value until this elapses.
         *
         * That makes a flag unsuitable as an emergency stop, which is stated in
         * `feature-flag.service.ts` rather than left to be discovered. Lower it if you need
         * faster convergence; do not set it to 0 expecting a kill switch.
         */
        ADMIN_FEATURE_FLAG_CACHE_MS: positiveInt.default(5_000),

        // ── Audit (Phase 3.5) ─────────────────────────────────────────────────
        /**
         * The minimum age, in days, before an audit row may leave the database.
         *
         * A row is deleted only when BOTH conditions hold: it has been exported to a
         * durable file, and it is at least this old. Neither alone is enough — an
         * unexported row is never deleted however old it is, and a freshly exported row
         * waits out the remainder of this period. See `audit-retention.ts`.
         *
         * Changing this does NOT restamp rows already exported under the old value;
         * `npm run audit:export -- --restamp` does that deliberately.
         */
        ADMIN_AUDIT_RETENTION_DAYS: positiveInt.default(365),

        /** Where export files land. Created on demand; one `.ndjson` + one `.sha256` per export. */
        ADMIN_AUDIT_EXPORT_DIR: z.string().min(1).default('./var/audit-exports'),

        /**
         * Ceiling on each of `payload`/`before`/`after` after redaction. Over it, the
         * value is replaced by a summary and `state_truncated` is set — never silently
         * dropped. Mongo's 16 MB document limit is not the binding constraint; the
         * working set and the export size are.
         */
        ADMIN_AUDIT_MAX_STATE_BYTES: positiveInt.default(4_096),

        /**
         * How long a row may sit at `attempted` before it counts as a dangling intent —
         * an action this service started somewhere it could not transact with, whose
         * outcome never came back. ADR-002 D4-a calls that case "itself a useful signal".
         */
        ADMIN_AUDIT_DANGLING_INTENT_S: positiveInt.default(300),

        /**
         * Row ceiling for the API export path. Above it `POST /audit/exports` refuses and
         * names the CLI, rather than serialising for minutes inside a request — the
         * shape ADR-005 D-10 forbids. The CLI has no cap.
         */
        ADMIN_AUDIT_EXPORT_API_MAX_ROWS: positiveInt.default(50_000),

        // ── NOTIFICATIONS (Phase 13) ──────────────────────────────────────────
        // The projector derives the administrator inbox from committed rows. See
        // `docs/ADR-013-NOTIFICATIONS.md`.

        /**
         * How often the projector sweeps every source.
         *
         * An administrator inbox is not a pager. Thirty seconds is already far tighter than
         * the situations it carries move — a payout request, a KYC review, a discrepancy —
         * and the cost of the interval is ten indexed reads against two databases.
         *
         * `0` disables the timer entirely. That is the supported way to run this service
         * with the inbox dormant (a second replica that should not double-sweep, or a
         * deploy that wants the API without the worker); the read endpoints keep working.
         */
        ADMIN_NOTIFICATIONS_SWEEP_S: z.coerce.number().int().min(0).default(30),

        /** Rows read per source per tick. Bounds the read; correctness comes from the index. */
        ADMIN_NOTIFICATIONS_BATCH: positiveInt.default(200),

        /**
         * Rows DELIVERED per source per tick before the projector truncates and says so.
         *
         * The case this exists for is `tracking_dispatch_failed`: if geo-tracker is
         * unreachable, every outbox row parks as `failed` at once, and without a cap one
         * outage becomes hundreds of identical notifications in every entitled inbox. The
         * cap is not silent — a truncated tick logs at `warn` and the watermark still
         * advances, so the next tick continues rather than repeating.
         */
        ADMIN_NOTIFICATIONS_MAX_PER_TICK: positiveInt.default(25),

        /**
         * Age at which an untouched notification is archived, read or not.
         *
         * Unread is not the same as still-relevant. The thing a three-month-old alert was
         * about has been dealt with or has not, and the screen that owns it is the honest
         * answer either way. `0` disables the sweep.
         */
        ADMIN_NOTIFICATIONS_AUTO_ARCHIVE_DAYS: z.coerce.number().int().min(0).default(90),

        /**
         * How long an archived notification survives before the TTL removes it.
         *
         * Shorter than `ADMIN_AUDIT_RETENTION_DAYS` on purpose, and the difference is the
         * point: a notification is a receipt, not a record. What it was about outlives it in
         * `admin_audit_log` and in the platform row it was derived from.
         */
        ADMIN_NOTIFICATIONS_RETENTION_DAYS: positiveInt.default(30),

        // ── CORS ──────────────────────────────────────────────────────────────
        // Exact origins only. A wildcard with credentials is what jovi-mall does
        // (`origin: true`) and is the defect this replaces.
        ADMIN_DASHBOARD_ORIGINS: csvList.pipe(z.array(httpOrigin).min(1)),

        // ── jovi-mall (optional in Phase 1, required in Phase 4) ──────────────
        JOVI_MALL_BASE_URL: z.string().url().optional(),
        JOVI_MALL_SERVICE_TOKEN: z.string().min(1).optional(),
        JOVI_MALL_TIMEOUT_MS: positiveInt.default(5_000),

        /**
         * ── geo-tracker OPERATIONS reads (Phase 15) ───────────────────────────
         *
         * The `_OPS_` is deliberate and load-bearing as documentation: this is not a general
         * geo-tracker door, it is three unauthenticated service-level paths (`/healthz`,
         * `/readyz`, `/metrics`). See `infra/geo/geo-tracker.client.ts`.
         *
         * No token pairs with it, because those three paths take no credential. Optional, and
         * genuinely inert when unset: the reads answer `configured: false` rather than failing.
         *
         * ⚠ **A DATA door now exists too (Phase 6.I), and it is a SEPARATE variable below.**
         * ADR-009 §D-2 read as "no geo-tracker data door" until ADR-020 amended it. Two base
         * URLs for what is usually one host is not an oversight: it is the lever that lets a
         * deployment take the operations reads and open no data door at all, and it keeps a
         * data call one variable away from ever being made with no credential.
         */
        GEO_TRACKER_OPS_BASE_URL: z.string().url().optional(),
        GEO_TRACKER_OPS_TIMEOUT_MS: positiveInt.default(2_000),

        /**
         * ── geo-tracker DATA reads (Phase 6.I · ADR-020) ──────────────────────
         *
         * The service-caller door: `/internal/*` on geo-tracker, four reads, authenticated by
         * a shared credential rather than by any user identity — which is the whole point,
         * because a wi-admin administrator holds no jovi-mall `users` row and geo-tracker's
         * viewer path therefore cannot resolve them.
         *
         * ⚠ `GEO_TRACKER_ADMIN_TOKEN` has **the same name on geo-tracker's side**, and that is
         * deliberate: it is the fifth secret shared across a service boundary on this platform
         * and the first whose name does not have to be translated. Three of the other four
         * differ, which is why rotation needs a runbook. Nothing compares the two values, so a
         * MISMATCH is still silent — but it surfaces immediately here, as tracking reads
         * answering "geo-tracker refused the credential".
         *
         * Both optional and inert when unset: the tracking reads answer `configured: false`,
         * exactly as the operations ones do. The refinement below refuses a URL with no token,
         * because that combination produces calls geo-tracker rejects at its own guard — which
         * reads as "geo-tracker is broken" rather than "this service is misconfigured", the
         * same trap `JOVI_MALL_SERVICE_TOKEN` is protected from.
         */
        GEO_TRACKER_DATA_BASE_URL: z.string().url().optional(),
        GEO_TRACKER_ADMIN_TOKEN: z.string().min(1).optional(),
        GEO_TRACKER_DATA_TIMEOUT_MS: positiveInt.default(4_000),
    })
    .superRefine((env, ctx) => {
        // A base URL without a token would produce calls jovi-mall rejects at the guard,
        // which reads as "jovi-mall is broken" rather than "this service is misconfigured".
        if (env.JOVI_MALL_BASE_URL && !env.JOVI_MALL_SERVICE_TOKEN) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['JOVI_MALL_SERVICE_TOKEN'],
                message: 'JOVI_MALL_SERVICE_TOKEN is required whenever JOVI_MALL_BASE_URL is set',
            });
        }

        // Same shape, same reason — and it matters more here, because the failure would be a
        // 401 from a service whose whole door is new. An operator debugging that goes looking
        // at geo-tracker's scope configuration rather than at this file.
        if (env.GEO_TRACKER_DATA_BASE_URL && !env.GEO_TRACKER_ADMIN_TOKEN) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['GEO_TRACKER_ADMIN_TOKEN'],
                message: 'GEO_TRACKER_ADMIN_TOKEN is required whenever GEO_TRACKER_DATA_BASE_URL is set',
            });
        }

        // SameSite=None is ignored by browsers unless the cookie is also Secure, which
        // this service only sets in production. Allowing the combination in dev would
        // produce cookies the browser silently drops — a confusing "login succeeds but
        // /me is 401" that looks like a server bug.
        if (env.ADMIN_COOKIE_SAMESITE === 'none' && env.NODE_ENV !== 'production') {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['ADMIN_COOKIE_SAMESITE'],
                message: "SameSite=None requires Secure cookies, which are only set in production. Use 'lax' in development.",
            });
        }

        if (env.NODE_ENV !== 'production') return;

        // Production-only tightening. Kept out of dev so a local checkout runs from
        // .env.example without ceremony.
        for (const name of ['ADMIN_JWT_SECRET', 'ADMIN_JWT_REFRESH_SECRET'] as const) {
            const value = env[name];
            if (value.length < MIN_SECRET_LENGTH || PLACEHOLDER_SECRETS.has(value.toLowerCase())) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: [name],
                    message: `${name} is a placeholder or shorter than ${MIN_SECRET_LENGTH} characters`,
                });
            }
        }

        // Two secrets that are the same secret provide none of the separation they
        // were split for: a stolen access token could be replayed as a refresh token.
        if (env.ADMIN_JWT_SECRET === env.ADMIN_JWT_REFRESH_SECRET) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['ADMIN_JWT_REFRESH_SECRET'],
                message: 'ADMIN_JWT_REFRESH_SECRET must differ from ADMIN_JWT_SECRET',
            });
        }

        if (env.JOVI_MALL_SERVICE_TOKEN) {
            const token = env.JOVI_MALL_SERVICE_TOKEN;
            if (token.length < MIN_SECRET_LENGTH || PLACEHOLDER_SECRETS.has(token.toLowerCase())) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ['JOVI_MALL_SERVICE_TOKEN'],
                    message: `JOVI_MALL_SERVICE_TOKEN is a placeholder or shorter than ${MIN_SECRET_LENGTH} characters`,
                });
            }
        }

        if (env.ADMIN_DASHBOARD_ORIGINS.some((origin) => origin.startsWith('http://'))) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['ADMIN_DASHBOARD_ORIGINS'],
                message: 'Plain-http origins are not allowed in production — this API is credentialed',
            });
        }
    });

export type AdminEnv = z.infer<typeof EnvSchema>;

/**
 * Parse and validate. Exported separately from the singleton so the foundation test can
 * exercise it against synthetic environments without touching `process.env`.
 */
export function parseEnv(source: NodeJS.ProcessEnv): z.SafeParseReturnType<unknown, AdminEnv> {
    return EnvSchema.safeParse(source);
}

/**
 * Formats every issue into one operator-readable block. Deliberately plain text on
 * stderr rather than a logger call: this runs before the logger exists, and a config
 * failure should be readable without a JSON decoder.
 */
export function formatEnvIssues(error: z.ZodError): string {
    const lines = error.issues.map((issue) => `  • ${issue.path.join('.') || '(root)'} — ${issue.message}`);
    return ['Invalid environment configuration:', ...lines].join('\n');
}

let cached: Readonly<AdminEnv> | null = null;

/**
 * The validated environment. Throws on first call if configuration is invalid; `server.ts`
 * calls it before anything else so the process dies at boot rather than mid-request.
 */
export function env(): Readonly<AdminEnv> {
    if (cached) return cached;

    const result = parseEnv(process.env);
    if (!result.success) {
        // Non-operational by construction (500): this is our misconfiguration, not a
        // caller's mistake. Nothing is listening yet, so server.ts catches it, prints the
        // message plainly on stderr and exits non-zero.
        throw createAppError(
            ERROR_CODES.CONFIG_INVALID_ENV,
            500,
            formatEnvIssues(result.error),
            { issueCount: result.error.issues.length },
        );
    }

    cached = Object.freeze(result.data);
    return cached;
}

/** Test-only: drop the memoized value so a new environment can be parsed. */
export function resetEnvCache(): void {
    cached = null;
}
