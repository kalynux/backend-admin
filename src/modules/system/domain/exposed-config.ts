import { createAppError } from '../../../core/errors/app-error';
import { ERROR_CODES } from '../../../core/errors/error-codes';
import { env } from '../../../config/env';
import { SENSITIVE_FIELD_NAMES } from '../../audit/domain/audit-state';

/**
 * Which runtime configuration `GET /api/v1/system/config` may reveal.
 *
 * ── Built by NAMING keys, never by spreading `env()` ──────────────────────────
 * The obvious implementation — return everything and delete the secrets — is the wrong way
 * round: it is open by default, and the day somebody adds `STRIPE_SECRET_KEY` to the env
 * schema it appears on this endpoint without anyone touching this file. A whitelist is the
 * same choice the platform read repositories make about projections, for the same reason.
 *
 * ── And then checked again, because a whitelist is only as good as its author ──
 * `assertExposedConfigSafe()` runs at boot and refuses a key that LOOKS credential-shaped
 * even if it is listed here. That is belt-and-braces on purpose: this list is edited by
 * hand, under time pressure, by somebody who wants to see one more value on a dashboard.
 *
 * ── Why `MONGO_URI_*` are absent ──────────────────────────────────────────────
 * They carry username and password in every real deployment. The DATABASE NAMES are the
 * useful part — "is this instance pointed at the right database" is the question an
 * operator actually asks — and `/system/health` already reports those, resolved from the
 * live connection rather than parsed out of a URI.
 */
export const EXPOSED_CONFIG_KEYS = Object.freeze([
    'NODE_ENV',
    'PORT',
    'LOG_LEVEL',
    'TRUST_PROXY',
    'ADMIN_DASHBOARD_ORIGINS',
    'ADMIN_APPROVAL_TTL_S',
    'ADMIN_APPROVAL_SWEEP_MIN_INTERVAL_MS',
    'ADMIN_AUDIT_RETENTION_DAYS',
    'ADMIN_AUDIT_MAX_STATE_BYTES',
    'ADMIN_AUDIT_DANGLING_INTENT_S',
    'ADMIN_AUDIT_EXPORT_API_MAX_ROWS',
    'ADMIN_AUDIT_EXPORT_DIR',
    'SHUTDOWN_TIMEOUT_MS',
] as const);

export type ExposedConfigKey = (typeof EXPOSED_CONFIG_KEYS)[number];

/**
 * Names that may never be exposed, whatever the list above says.
 *
 * Two layers: the leaf names the audit sanitiser already knows about (reused rather than
 * restated, so the two cannot drift), and a token rule for the shapes an env var takes.
 *
 * ── Why the token may appear ANYWHERE, not only at the end ────────────────────
 * The first version of this anchored to the end (`_SECRET$`), which reads naturally and is
 * wrong for the most important case in this service: `MONGO_URI_ADMIN` and
 * `MONGO_URI_PLATFORM` carry the database password and end in `_ADMIN` / `_PLATFORM`. A
 * suffix rule waves both through.
 *
 * So the check is "does any underscore-separated segment name a credential", which catches
 * `MONGO_URI_ADMIN`, `STRIPE_SECRET_KEY_LIVE` and `TOKEN_SIGNING_ALGORITHM` alike. The last
 * is a false positive — it names no secret — and that is the correct trade here: a refused
 * boot is a one-line conversation, and a leaked connection string is not.
 */
export const FORBIDDEN_CONFIG_TOKEN = /(^|_)(URI|URL|SECRET|TOKEN|KEY|PASSWORD|PASS|DSN|CREDENTIALS|CREDENTIAL)(_|$)/;

/**
 * Refuse to start if the whitelist names something credential-shaped.
 *
 * `ADMIN_DASHBOARD_ORIGINS` is the one deliberate near-miss: it ends in neither a forbidden
 * suffix nor a sensitive leaf name, and it is a list of origins — public information that
 * the browser sends back to us on every request anyway.
 */
export function assertExposedConfigSafe(): void {
    const problems: string[] = [];

    for (const key of EXPOSED_CONFIG_KEYS) {
        if (FORBIDDEN_CONFIG_TOKEN.test(key)) {
            problems.push(`${key} — contains a segment reserved for credentials`);
            continue;
        }

        const leaf = key.toLowerCase().split('_').pop() ?? '';
        if (SENSITIVE_FIELD_NAMES.has(leaf) || SENSITIVE_FIELD_NAMES.has(key.toLowerCase())) {
            problems.push(`${key} — matches a redacted field name`);
        }
    }

    if (problems.length > 0) {
        throw createAppError(
            ERROR_CODES.SYSTEM_CONFIG_EXPOSURE_UNSAFE,
            500,
            `EXPOSED_CONFIG_KEYS names values that must not be served:\n  ${problems.join('\n  ')}`,
            { problems },
        );
    }
}

export interface ExposedConfigEntry {
    key: ExposedConfigKey;
    value: string | number | boolean | null;
}

/** The whitelisted configuration, as the endpoint serves it. */
export function exposedConfig(): ExposedConfigEntry[] {
    const config = env() as unknown as Record<string, unknown>;

    return EXPOSED_CONFIG_KEYS.map((key) => {
        const value = config[key];
        return {
            key,
            value:
                typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
                    ? value
                    // An array (`ADMIN_DASHBOARD_ORIGINS`) or anything else is rendered rather
                    // than passed through, so the wire shape stays flat and predictable.
                    : value === undefined || value === null ? null : String(value),
        };
    });
}
