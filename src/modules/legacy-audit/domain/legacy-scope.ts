import { AdminTier } from '../../admin-identity/domain/admin-identity.types';

/**
 * Who may read which legacy admin-action rows.
 *
 * ── Mirrors `auditScopeFilter`, and must keep mirroring it ────────────────────
 * The real trail withholds `subject_class: 'internal'` from Support so the audit feed cannot
 * become a side door onto the administrator directory (ADR-006 D-4). These rows have no
 * `subject_class` — jovi-mall's middleware does not know wi-admin's vocabulary — so the
 * equivalent is expressed on what IS here: the resource type.
 *
 * Without this, `GET /audit/legacy` would be exactly the side door the real feed is careful
 * not to be. A second, unscoped view of administrative activity is worth nothing and costs
 * the property the first one protects.
 *
 * ── Tiers 1 and 2 get no clause at all ────────────────────────────────────────
 * Same as the real filter: returning `{}` for them would still cost an `$and` wrap. `null`
 * means "no narrowing", and the repository composes accordingly.
 */

/**
 * Resource types Support may not see acted upon.
 *
 * `User` and `Admin` are the people-records — the analogue of the real feed's `internal`
 * class. Everything else on the legacy surface (tickets, articles, files, billing) is
 * platform activity that Support has a working reason to read, which is the same call
 * ADR-006 D-4 made when it gave Support sight of the COD/money chain.
 */
const WITHHELD_FROM_SUPPORT = ['User', 'Admin', 'AdminAccount'] as const;

export function legacyScopeFilter(tier: AdminTier): Record<string, unknown> | null {
    if (tier <= 2) return null;

    /**
     * `$or` rather than a bare `$nin`, because most rows have `resource_type: null` — the
     * coarse middleware rows do not name a resource at all. A plain `$nin` would still match
     * null in Mongo, but stating both branches makes the intent explicit and survives
     * somebody later adding a `$ne` they think is equivalent.
     */
    return {
        $or: [
            { resource_type: null },
            { resource_type: { $nin: [...WITHHELD_FROM_SUPPORT] } },
        ],
    };
}
