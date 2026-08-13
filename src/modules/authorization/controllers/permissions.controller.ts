import { Request, Response } from 'express';
import { asyncHandler } from '../../../core/http/async-handler';
import { sendSuccess } from '../../../core/http/responses';
import {
    ADMIN_TIERS,
    ADMIN_TIER_LABELS,
    requireAdminIdentity,
} from '../../admin-identity/domain/admin-identity.types';
import { PERMISSION_NAMES, permissionSpec } from '../domain/permission.catalog';
import { PERMISSION_FAMILIES } from '../domain/permission.types';
import { effectivePermissions, grantedTo } from '../domain/permission.resolver';

/**
 * `/api/v1/permissions` — what the policy IS, and what the caller holds of it.
 *
 * ── Why the dashboard needs this ──────────────────────────────────────────────
 * Without it the only way for a UI to discover what it may do is to render everything and
 * find out from the 403s. `GET /permissions/me` lets the navigation be built from the
 * caller's actual set, so a button that would be refused is never drawn.
 *
 * ── Why none of it is secret ──────────────────────────────────────────────────
 * The catalog and the tier matrix describe policy, not data. Knowing that
 * `cod.remittances.confirm` exists and that Admins hold it tells an attacker nothing they
 * could not learn by trying, and it is the difference between a usable dashboard and a
 * guessing game.
 */

interface PermissionView {
    name: string;
    family: string;
    action: string;
    summary: string;
    financial: boolean;
    escalation: boolean;
    destructive: boolean;
    dualControl: boolean;
    scoped: boolean;
    phase: number;
}

function toView(name: (typeof PERMISSION_NAMES)[number]): PermissionView {
    const spec = permissionSpec(name);
    return {
        name,
        family: spec.family,
        action: spec.action,
        summary: spec.summary,
        financial: spec.financial === true,
        escalation: spec.escalation === true,
        destructive: spec.destructive === true,
        // The SPEC is exposed, never the predicate — `when` is a function and the payload
        // it inspects is nobody's business but the requesting endpoint's.
        dualControl: spec.dualControl !== undefined,
        scoped: spec.scope !== undefined,
        phase: spec.phase,
    };
}

export class PermissionsController {
    /**
     * GET /api/v1/permissions/catalog
     *
     * Every permission that exists, grouped by family. Includes permissions whose
     * endpoints are not built yet (`phase` says which builds them) so the dashboard can
     * be written against the finished vocabulary rather than a moving one.
     */
    static catalog = asyncHandler(async (_req: Request, res: Response) => {
        const permissions = PERMISSION_NAMES.map(toView);

        sendSuccess(res, {
            families: PERMISSION_FAMILIES.map((family) => ({
                family,
                permissions: permissions.filter((entry) => entry.family === family).map((entry) => entry.name),
            })),
            permissions,
            total: permissions.length,
        });
    });

    /**
     * GET /api/v1/permissions/me
     *
     * The caller's own effective set. No permission required — an administrator who
     * cannot discover what they may do cannot use the service.
     */
    static me = asyncHandler(async (req: Request, res: Response) => {
        const identity = requireAdminIdentity(req);

        sendSuccess(res, {
            adminId: identity.adminId,
            tier: identity.tier,
            tierLabel: ADMIN_TIER_LABELS[identity.tier],
            permissions: effectivePermissions(identity.tier),
        });
    });

    /**
     * GET /api/v1/permissions/tiers
     *
     * The full level→permission matrix, for the administrator-management screen: what
     * changes when you move someone from Support to Admin.
     */
    static tiers = asyncHandler(async (_req: Request, res: Response) => {
        sendSuccess(res, {
            tiers: ADMIN_TIERS.map((tier) => ({
                tier,
                label: ADMIN_TIER_LABELS[tier],
                permissions: [...grantedTo(tier)].sort(),
                total: grantedTo(tier).size,
            })),
        });
    });
}
