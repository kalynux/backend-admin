import { Request, Response } from 'express';
import { auditActorOf, requestContext } from '../domain/audit-context';
import { createReadStream } from 'fs';
import { access } from 'fs/promises';
import { asyncHandler } from '../../../core/http/async-handler';
import { createAppError } from '../../../core/errors/app-error';
import { ERROR_CODES } from '../../../core/errors/error-codes';
import { toPageMeta } from '../../../core/http/list-query';
import { sendCreated, sendPaginated, sendSuccess } from '../../../core/http/responses';
import { env } from '../../../config/env';
import { requireAdminIdentity } from '../../admin-identity/domain/admin-identity.types';
import { AUDIT_CATALOG, AUDIT_ACTION_NAMES } from '../domain/audit.catalog';
import { toAuditEntryDetailDto, toAuditEntryDto, toAuditExportDto } from '../domain/audit.dto';
import { runExport } from '../domain/audit-export.service';
import { AuditExportModel } from '../models/audit-export.model';
import { AuditRepository } from '../repositories/audit.repository';
import { CreateExportBody, ListAuditQuery, ListExportsQuery } from '../validators/audit.validator';

/**
 * `/api/v1/audit` — the record of every administrator action, readable.
 *
 * Thin: the read scope is applied in the repository, never here. That is deliberate and
 * the same rule the platform read repositories follow — a filter assembled at the query
 * layer is one nobody can forget to apply, and the filter this one adds is the difference
 * between a Support administrator seeing platform activity and seeing the administrator
 * directory.
 */

const audit = new AuditRepository();

export class AuditController {
    /** GET /api/v1/audit */
    static list = asyncHandler(async (req: Request, res: Response) => {
        const identity = requireAdminIdentity(req);
        const query = req.query as unknown as ListAuditQuery;

        const page = await audit.search(query, identity);

        // `retentionDays` and `oldestRetainedAt` ride along in `meta` (ADR-005 D-10 allows
        // extra list-level fields) so a dashboard can explain why the feed stops rather
        // than looking broken at the boundary.
        sendPaginated(res, page.items.map(toAuditEntryDto), {
            ...page.meta,
            retentionDays: env().ADMIN_AUDIT_RETENTION_DAYS,
            oldestRetainedAt: (await audit.oldestRetainedAt())?.toISOString() ?? null,
        });
    });

    /**
     * GET /api/v1/audit/actions
     *
     * The vocabulary, so a dashboard builds its filter from the catalog instead of
     * discovering it by collecting 400s — the same role `/permissions/catalog` plays.
     */
    static actions = asyncHandler(async (_req: Request, res: Response) => {
        sendSuccess(res, {
            actions: AUDIT_ACTION_NAMES.map((name) => ({
                name,
                family: name.split('.')[0],
                target: AUDIT_CATALOG[name].target,
                transport: AUDIT_CATALOG[name].transport,
                permission: AUDIT_CATALOG[name].permission,
                summary: AUDIT_CATALOG[name].summary,
            })),
            total: AUDIT_ACTION_NAMES.length,
        });
    });

    /**
     * GET /api/v1/audit/:auditId
     *
     * Adds `payload`, `before` and `after`, which the list omits.
     *
     * A row outside the caller's scope answers 404, not 403 — a 403 on a specific id
     * would confirm the row exists, which is an existence oracle over exactly the rows the
     * scope hides.
     */
    static get = asyncHandler(async (req: Request, res: Response) => {
        const identity = requireAdminIdentity(req);

        const row = await audit.findById(req.params.auditId, identity);
        if (!row) throw createAppError(ERROR_CODES.AUDIT_ENTRY_NOT_FOUND, 404);

        sendSuccess(res, toAuditEntryDetailDto(row));
    });

    /**
     * POST /api/v1/audit/exports
     *
     * Writes an NDJSON file and marks the rows it covers as exported. It does NOT purge:
     * deletion from the dashboard would be one misclick from irreversible, and the CLI
     * (`npm run audit:export -- --purge`) is where that belongs.
     *
     * Bounded by `ADMIN_AUDIT_EXPORT_API_MAX_ROWS`. Above it the request is refused with
     * the row count and a pointer to the CLI, rather than serialising for minutes inside a
     * request — the shape ADR-005 D-10 forbids.
     */
    static createExport = asyncHandler(async (req: Request, res: Response) => {
        const identity = requireAdminIdentity(req);
        const body = req.body as CreateExportBody;

        const result = await runExport({
            from: body.from,
            to: body.to,
            source: 'api',
            requestedBy: { id: identity.adminId, name: identity.displayName },
            correlationId: req.requestId,
            maxRows: env().ADMIN_AUDIT_EXPORT_API_MAX_ROWS,
            purge: false,
            // Phase 12: the export writes its own audit row. `requestedBy` above is the
            // manifest's provenance; these are the trail's, and they are not the same thing
            // — the manifest can be deleted, the row is the record.
            actor: auditActorOf(identity),
            context: requestContext(req),
        });

        sendCreated(res, toAuditExportDto(result.manifest), {
            message: `Exported ${result.rowCount} row(s). Nothing was deleted — use the CLI with --purge for that.`,
        });
    });

    /** GET /api/v1/audit/exports */
    static listExports = asyncHandler(async (req: Request, res: Response) => {
        const query = req.query as unknown as ListExportsQuery;

        const [rows, total] = await Promise.all([
            AuditExportModel()
                .find()
                .sort({ started_at: query.sort.direction, _id: query.sort.direction })
                .skip((query.page - 1) * query.limit)
                .limit(query.limit),
            AuditExportModel().countDocuments(),
        ]);

        sendPaginated(res, rows.map(toAuditExportDto), toPageMeta(total, query.page, query.limit));
    });

    /** GET /api/v1/audit/exports/:exportId */
    static getExport = asyncHandler(async (req: Request, res: Response) => {
        const row = await AuditExportModel().findById(req.params.exportId);
        if (!row) throw createAppError(ERROR_CODES.AUDIT_EXPORT_NOT_FOUND, 404);

        sendSuccess(res, toAuditExportDto(row));
    });

    /**
     * GET /api/v1/audit/exports/:exportId/download
     *
     * Streams the file. The one endpoint in this service that does not answer with the
     * JSON envelope, because the payload is a file — the same exception `ADR-005 D-8`
     * makes for a body that is not a DTO.
     *
     * Note the deployment caveat: the file lives on the instance that wrote it. With more
     * than one instance behind a load balancer this 404s unless the export directory is
     * shared storage, which is why `ADMIN_AUDIT_EXPORT_DIR` is configurable.
     */
    static downloadExport = asyncHandler(async (req: Request, res: Response) => {
        const row = await AuditExportModel().findById(req.params.exportId);
        if (!row) throw createAppError(ERROR_CODES.AUDIT_EXPORT_NOT_FOUND, 404);

        if (row.status !== 'complete' || !row.file_path) {
            throw createAppError(ERROR_CODES.AUDIT_EXPORT_INCOMPLETE, 409);
        }

        try {
            await access(row.file_path);
        } catch {
            throw createAppError(
                ERROR_CODES.AUDIT_EXPORT_FILE_MISSING,
                410,
                'The export file is no longer on disk. It may have been archived, or written by another instance.',
                { fileName: row.file_name },
            );
        }

        res.setHeader('Content-Type', 'application/x-ndjson');
        res.setHeader('Content-Disposition', `attachment; filename="${row.file_name}"`);
        // So a client can verify what it received against the manifest.
        if (row.sha256) res.setHeader('X-Content-SHA256', row.sha256);

        createReadStream(row.file_path).pipe(res);
    });
}
