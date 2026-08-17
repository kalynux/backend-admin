import { Router } from 'express';
import { defineRoute, permission } from '../../../api/route-manifest';
import { FileController } from '../controllers/file.controller';
import { FileIdParamSchema, ResolveFilesQuerySchema } from '../validators/file.validator';

/**
 * `/api/v1/files` — resolving a file id this service already handed out.
 *
 * ── Why this mount exists ────────────────────────────────────────────────────
 * Every DTO here ships file references as opaque ids, and the contract explains why: this
 * service resolves no file URLs and must not grow a storage layer (ADR-009 D-6). It then
 * told the dashboard to resolve them "against jovi-mall" — which the dashboard cannot do,
 * because it talks to this service and to nothing else. The result was every avatar,
 * logo, banner and delivery proof on the admin surface rendering as a placeholder.
 *
 * This closes it without reversing D-6: the resolution is DELEGATED, so
 * `STORAGE_PROVIDER` stays configured in exactly one deployment.
 *
 * ── `files.resolve`, held by every tier ──────────────────────────────────────
 * The caller is already holding the id, which means they already passed the guard on the
 * record that carried it. Gating this behind `agencies.read` would mean a `vendors.read`
 * holder cannot see a vendor's own logo; gating it behind all six read permissions would
 * be a rule nobody could state. What keeps it narrow is the shape rather than the tier:
 * it RESOLVES an explicit id set and cannot ENUMERATE. There is no listing form here and
 * there must not be one — `files.orphans.read` is the listing, it is tier 1 only, and it
 * belongs on its own mount when the files domain is ported (Phase 17 Part C).
 *
 * Neither route is audited: reads are not (ADR-006 D-5), and the one audited read on this
 * service is the payout destination, where the disclosure is itself the action.
 */
const router = Router();
const mountedAt = '/files';

/**
 * The batch form. Declared FIRST so `?ids=` is matched before anything could read a query
 * string as a path segment, and because it is the one a list screen calls.
 */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/',
    access: permission('files.resolve'),
    validate: { query: ResolveFilesQuerySchema },
    handler: FileController.resolve,
});

/** The single form, for a detail screen. 404s on an id that resolves to nothing. */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/:fileId',
    access: permission('files.resolve'),
    validate: { params: FileIdParamSchema },
    handler: FileController.get,
});

export { router as fileRoutes };
