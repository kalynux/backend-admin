import { Router } from 'express';
import { defineRoute, permission, records } from '../../../api/route-manifest';
import { FileController } from '../controllers/file.controller';
import {
    FileIdParamSchema,
    HardDeleteFileBodySchema,
    OrphansQuerySchema,
    ResolveFilesQuerySchema,
} from '../validators/file.validator';

/**
 * `/api/v1/files` — resolving a file id this service already handed out, and the
 * housekeeping pair that came with Phase 5 Part B.
 *
 * ── Why this mount exists ────────────────────────────────────────────────────
 * Every DTO here ships file references as opaque ids, and the contract explains why: this
 * service resolves no file URLs and must not grow a storage layer (ADR-009 D-6). It then
 * told the dashboard to resolve them "against jovi-mall" — which the dashboard cannot do,
 * because it talks to this service and to nothing else. The result was every avatar,
 * logo, banner and delivery proof on the admin surface rendering as a placeholder.
 *
 * This closes it without reversing D-6: the resolution is DELEGATED, so
 * `STORAGE_PROVIDER` stays configured in exactly one deployment. The two Phase 5 routes
 * delegate for a second reason on top of that: jovi-mall owns the `files` collection, the
 * references the orphan query is the complement of, and the storage client the delete
 * calls.
 *
 * ── `files.resolve`, held by every tier ──────────────────────────────────────
 * The caller is already holding the id, which means they already passed the guard on the
 * record that carried it. Gating this behind `agencies.read` would mean a `vendors.read`
 * holder cannot see a vendor's own logo; gating it behind all six read permissions would
 * be a rule nobody could state. What keeps it narrow is the shape rather than the tier:
 * it RESOLVES an explicit id set and cannot ENUMERATE.
 *
 * ── The listing is a DIFFERENT permission, and that is the whole point ───────
 * `GET /orphans` enumerates — by definition, since an orphan is found rather than named —
 * so it is not on `files.resolve` and must never be folded into it. It carries
 * `files.orphans.read` (tiers 1 and 2) and exists so an operator can judge a file before
 * the unrecoverable delete beside it, which is `files.delete` and tier 1 alone. The header
 * here used to say "there is no listing form here and there must not be one"; the sharper
 * version is that a listing on this mount needs its own permission.
 *
 * ── Audit ────────────────────────────────────────────────────────────────────
 * The three reads are not audited (ADR-006 D-5), and the one audited read on this service
 * is the payout destination, where the disclosure is itself the action. `files.delete` is
 * audited and is the only unrecoverable operation on this service's whole surface.
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

/**
 * ⚠ **Declared BEFORE `/:fileId`, and the order is load-bearing.** Express matches in
 * declaration order, so a `/:fileId` above this one swallows `/orphans` — the request
 * reaches `FileController.get`, fails the 24-hex param schema, and answers a 400 about a
 * malformed id for a route that exists. jovi-mall's own file router carries the same
 * comment at the same place (`file-upload.routes.ts`), and `test:files` asserts the order
 * here rather than trusting it, because the failure is a plausible-looking 400 rather than
 * anything that reads as a routing bug.
 *
 * Tiers 1 and 2 — `allInFamily('files')` sweeps it into Admin, and no flag keeps a read
 * out. The tier-1-only half of this pair is the delete below. The row deliberately
 * withholds the storage key (D-10).
 */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/orphans',
    access: permission('files.orphans.read'),
    validate: { query: OrphansQuerySchema },
    handler: FileController.listOrphans,
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

/**
 * The hard delete — no undo, on either side of the hop.
 *
 * `files.delete` is `destructive: true`, which keeps it out of `allInFamily()` and makes it
 * tier-1-only. The body must repeat the path's id (D-9, the `outbox.prune` precedent): make
 * the operator restate the value that decides the blast radius.
 */
defineRoute(router, {
    mountedAt,
    method: 'delete',
    path: '/:fileId/permanent',
    access: permission('files.delete'),
    validate: { params: FileIdParamSchema, body: HardDeleteFileBodySchema },
    audit: records('files.delete'),
    handler: FileController.hardDelete,
});

export { router as fileRoutes };
