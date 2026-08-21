import { createAppError } from '../../../core/errors/app-error';
import { ERROR_CODES } from '../../../core/errors/error-codes';

/**
 * Every feature flag this service has, and who reads it.
 *
 * ── A closed catalog, like the permission and audit catalogs ──────────────────
 * Same three benefits, for the same reasons: `PUT /dev-tools/feature-flags/:flag` pins a
 * `z.enum` so a typo cannot silently create a flag nothing reads; the dashboard builds its
 * list from `GET /dev-tools/feature-flags` instead of discovering it by collecting 400s;
 * and a flag is a decision recorded in code rather than a row somebody remembers making.
 *
 * ── `consumer` is required, and it is the load-bearing field ──────────────────
 * A flag with no consumer is dead config that reads as live policy — somebody turns it off,
 * nothing changes, and the next person cannot tell whether the flag is broken or the
 * feature is. Naming the file that branches on it makes that checkable, and
 * `assertFeatureFlagCatalogValid()` refuses to start without one.
 *
 * ── ⚠️ These are wi-admin flags. jovi-mall does NOT read them ─────────────────
 * `developer_tools.feature_flags.set` is summarised as "for the whole platform", and that
 * is the one thing this deliberately does not do. jovi-mall reading them would need either
 * a wi-admin database connection there (inverting ADR-004's one-way dependency) or an HTTP
 * call from jovi-mall to wi-admin, which exists in neither direction today. A platform-wide
 * flag is a cross-service config contract with its own cache, invalidation and failure
 * mode — a phase, not a field.
 *
 * So every flag below names a consumer INSIDE this service. Adding one whose consumer is
 * in jovi-mall means building that contract first.
 */

export interface FeatureFlagSpec {
    /** What the flag is when no row exists. The collection starts empty, so this is live. */
    default: boolean;
    /** The single file that branches on it. A flag with no consumer is dead config. */
    consumer: string;
    /** What turning it OFF actually stops. Written for the administrator who will read it. */
    summary: string;
}

export const FEATURE_FLAG_CATALOG = Object.freeze({
    /**
     * The route-level audit probe. On by default — it is a smoke detector and costs one
     * AsyncLocalStorage context per mutating request.
     *
     * Turning it off silences `AUDIT DECLARATION UNMET` without changing what is recorded:
     * the probe only observes. Worth having a switch for because it logs at `fatal`, and a
     * false positive from a route shape nobody anticipated should be silenceable without a
     * deploy.
     */
    'audit.route_probe': {
        default: true,
        consumer: 'api/route-manifest.ts',
        summary: 'Warn when a route succeeds without recording the action it declares',
    },

    // `audit.legacy_feed` was here — the switch that retired `GET /api/v1/audit/legacy` ahead
    // of deleting the module behind it, so a dashboard could stop calling the route without a
    // coordinated release. Both are gone (Phase 5 Part D). It had to go in the same change:
    // its `consumer` named a file that no longer exists, which is exactly the dead config the
    // header above refuses to carry — a switch an operator flips expecting something to
    // change, and nothing does.

    /**
     * Whether the developer tools may actually trigger anything in jovi-mall.
     *
     * **Off by default**, and the only flag here that is. Every tool behind it re-runs a
     * side effect against live data, and the safe state for a capability like that is
     * "explicitly turned on for this incident", not "available because it was built".
     */
    'dev_tools.enabled': {
        default: false,
        consumer: 'modules/dev-tools/gateways/dev-tools.gateway.ts',
        summary: 'Allow the developer tools to run workers, replay outbox rows and rebuild search vectors',
    },
} as const satisfies Record<string, FeatureFlagSpec>);

export type FeatureFlagName = keyof typeof FEATURE_FLAG_CATALOG;

export const FEATURE_FLAG_NAMES = Object.keys(FEATURE_FLAG_CATALOG) as [
    FeatureFlagName,
    ...FeatureFlagName[],
];

export function featureFlagSpec(name: FeatureFlagName): FeatureFlagSpec {
    return FEATURE_FLAG_CATALOG[name];
}

export function isFeatureFlagName(value: unknown): value is FeatureFlagName {
    return typeof value === 'string'
        && Object.prototype.hasOwnProperty.call(FEATURE_FLAG_CATALOG, value);
}

/** Boot assertion, called from `createApp()` beside the other catalogs' checks. */
export function assertFeatureFlagCatalogValid(): void {
    const problems: string[] = [];

    for (const name of FEATURE_FLAG_NAMES) {
        const spec = FEATURE_FLAG_CATALOG[name];

        if (!/^[a-z_]+\.[a-z_]+$/.test(name)) {
            problems.push(`${name} — expected a dotted family.flag name`);
        }
        if (spec.consumer.trim().length === 0) {
            problems.push(`${name} — names no consumer, so nothing reads it`);
        }
        if (spec.summary.trim().length < 10) {
            problems.push(`${name} — needs a summary an administrator can act on`);
        }
    }

    if (problems.length > 0) {
        throw createAppError(
            ERROR_CODES.SYSTEM_FEATURE_FLAG_CATALOG_INVALID,
            500,
            `The feature flag catalog is invalid:\n  ${problems.join('\n  ')}`,
            { problems },
        );
    }
}
