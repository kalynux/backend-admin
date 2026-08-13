import { AdminTier, ADMIN_TIERS } from '../../admin-identity/domain/admin-identity.types';
import { PermissionName } from './permission.catalog';
import { TIER_GRANTS } from './tier-grants';

/**
 * Resolving a tier to the set of permissions it holds.
 *
 * ── Why there is no cache ─────────────────────────────────────────────────────
 * `redis.factory.ts` reserved `PERMISSION_CACHE_DB = 3` for "resolved verdicts, cached
 * per admin". Nothing uses it, and nothing should.
 *
 * The grant table is static code, so a tier's permission set cannot change while the
 * process runs — there is nothing to invalidate. The three sets below are built once at
 * module load and every check is a `Set.has` on a string. A Redis round trip would make
 * an O(1) in-memory lookup slower AND introduce the one class of bug this design has no
 * other way to acquire: a stale verdict surviving a deploy that changed the policy.
 *
 * The admin's TIER is a different matter, and that is already handled: it is re-read from
 * Mongo on every request (`authenticate.middleware.ts:128-130`), never taken from the
 * token, so a demotion applies on the very next request.
 */

function buildTierSets(): Readonly<Record<AdminTier, ReadonlySet<PermissionName>>> {
    const sets = {} as Record<AdminTier, ReadonlySet<PermissionName>>;
    for (const tier of ADMIN_TIERS) {
        sets[tier] = new Set<PermissionName>(TIER_GRANTS[tier]);
    }
    return Object.freeze(sets);
}

const TIER_PERMISSIONS = buildTierSets();

/** The permission set this level holds. Never mutate it — it is shared by every request. */
export function grantedTo(tier: AdminTier): ReadonlySet<PermissionName> {
    return TIER_PERMISSIONS[tier];
}

export function hasPermission(tier: AdminTier, name: PermissionName): boolean {
    return TIER_PERMISSIONS[tier].has(name);
}

/** True only when the tier holds EVERY name. The default reading of a multi-name guard. */
export function hasAllPermissions(tier: AdminTier, names: readonly PermissionName[]): boolean {
    return names.every((name) => TIER_PERMISSIONS[tier].has(name));
}

export function hasAnyPermission(tier: AdminTier, names: readonly PermissionName[]): boolean {
    return names.some((name) => TIER_PERMISSIONS[tier].has(name));
}

/** Which of `names` the tier is missing — what a 403 needs in order to be debuggable. */
export function missingPermissions(tier: AdminTier, names: readonly PermissionName[]): PermissionName[] {
    return names.filter((name) => !TIER_PERMISSIONS[tier].has(name));
}

/**
 * The caller's effective set, sorted, for `GET /permissions/me`.
 *
 * The dashboard renders its navigation from this: a button the caller cannot use is
 * never drawn, rather than drawn and answered with a 403.
 */
export function effectivePermissions(tier: AdminTier): PermissionName[] {
    return [...TIER_PERMISSIONS[tier]].sort();
}
