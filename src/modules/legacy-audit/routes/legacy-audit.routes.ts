import { Router } from 'express';
import { defineRoute, permission } from '../../../api/route-manifest';
import { LegacyAuditController } from '../controllers/legacy-audit.controller';
import { ListLegacyActionsQuerySchema } from '../validators/legacy-audit.validator';

/**
 * `GET /api/v1/audit/legacy` — the interim feed, mounted under `/audit` beside the real one.
 *
 * ── Under `/audit`, but a separate router ─────────────────────────────────────
 * Same prefix because it answers the same question ("what did administrators do"), separate
 * router because it reads a different database with a different vocabulary and gets deleted
 * at cutover. `api/index.ts` mounts it after the audit router, and the literal `/legacy`
 * cannot collide with `/:auditId` — they are different depths.
 *
 * ── `audit.read`, not a permission of its own ─────────────────────────────────
 * A new permission would be dead policy the day this is deleted, and the question it guards
 * is identical to the one `audit.read` already guards. The tier-3 narrowing that makes
 * `audit.read` safe to hand to Support is reproduced in `legacy-scope.ts` — without that,
 * this endpoint would be a side door onto exactly what the real feed withholds.
 */
const router = Router();
const mountedAt = '/audit';

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/legacy',
    access: permission('audit.read'),
    validate: { query: ListLegacyActionsQuerySchema },
    handler: LegacyAuditController.list,
});

export const legacyAuditRoutes = router;
