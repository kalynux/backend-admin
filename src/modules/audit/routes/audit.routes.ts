import { Router } from 'express';
import { defineRoute, permission, records } from '../../../api/route-manifest';
import { AuditController } from '../controllers/audit.controller';
import {
    AuditIdParamSchema,
    CreateExportSchema,
    ExportIdParamSchema,
    ListAuditQuerySchema,
    ListExportsQuerySchema,
} from '../validators/audit.validator';

/**
 * `/api/v1/audit` — the record of every administrator action.
 *
 * ── Route order matters here, and the hazard is the usual one ────────────────
 * `/actions` and `/exports` are declared BEFORE `/:auditId`. Express matches in
 * registration order, so the reverse would read "actions" as an audit id and fail its
 * ObjectId check — the same trap `/me` before `/:adminId` avoids in the administrators
 * router (ADR-005 D-2 rule 4).
 *
 * ── Two permissions, two audiences ───────────────────────────────────────────
 * `audit.read` is held by all three tiers, because reading what happened to the records
 * you support is part of supporting them. What a Support administrator SEES is narrowed
 * per row by `auditScopeFilter` — internal rows (administrators, approvals, exports) stay
 * invisible to them, so the feed cannot become a side door onto the administrator
 * directory that `tier-grants.ts` withholds.
 *
 * `audit.export` is Developer + Admin only and flagged `destructive`, because an export is
 * the precondition for deletion: it is the one operation that can make an audit row
 * eligible to leave the database.
 */
const router = Router();
const mountedAt = '/audit';

// ─── The feed ────────────────────────────────────────────────────────────────

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/',
    access: permission('audit.read'),
    validate: { query: ListAuditQuerySchema },
    handler: AuditController.list,
});

// Literal segments first — see the header.
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/actions',
    access: permission('audit.read'),
    handler: AuditController.actions,
});

// ─── Exports (declared before /:auditId for the same reason) ─────────────────

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/exports',
    access: permission('audit.export'),
    validate: { body: CreateExportSchema },
    audit: records('audit.export'),
    handler: AuditController.createExport,
});

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/exports',
    access: permission('audit.export'),
    validate: { query: ListExportsQuerySchema },
    handler: AuditController.listExports,
});

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/exports/:exportId',
    access: permission('audit.export'),
    validate: { params: ExportIdParamSchema },
    handler: AuditController.getExport,
});

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/exports/:exportId/download',
    access: permission('audit.export'),
    validate: { params: ExportIdParamSchema },
    handler: AuditController.downloadExport,
});

// ─── One entry, last ─────────────────────────────────────────────────────────

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/:auditId',
    access: permission('audit.read'),
    validate: { params: AuditIdParamSchema },
    handler: AuditController.get,
});

export const auditRoutes = router;
