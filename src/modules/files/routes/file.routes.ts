import { Router } from 'express';
import { defineRoute, permission, records } from '../../../api/route-manifest';
import { FileController, FileLibraryController } from '../controllers/file.controller';
import {
    FileIdParamSchema,
    FileLibraryQuerySchema,
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
 * The three metadata reads are not audited (ADR-006 D-5). `GET /:fileId/content` is —
 * opening a private file IS the disclosure, which is the same test that made the payout
 * destination and the two tracking reads exceptions. `files.delete` is audited and is the
 * only unrecoverable operation on this service's whole surface.
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

/**
 * The MEDIA LIBRARY — the second listing on this mount (BR-015).
 *
 * ⚠ **Declared BEFORE `/:fileId`, for the same reason `/orphans` is**, and `test:files`
 * asserts both. A `/:fileId` above this one swallows `/library`: the request reaches
 * `FileController.get`, fails the 24-hex param schema, and answers a 400 about a malformed
 * id for a route that exists and that the caller is permitted to reach.
 *
 * ⚠ **The first read on this mount that is NOT delegated.** Every other route here goes to
 * jovi-mall; this one reads `jovi_mall.files` and `file_references` directly (L-1), because
 * the answer is a RECORD rather than a verdict (ADR-009 D-1) and because the two things the
 * screen exists for — the usage join and the owner NAME — are things jovi-mall's own
 * listing cannot do. The `admin` owner name resolves in *this* service's database, which
 * jovi-mall cannot read at all.
 *
 * Tiers 1 and 2 — `allInFamily('files')` sweeps it into Admin, and no flag keeps a read
 * out. The same line `files.orphans.read` draws: Support does not enumerate files.
 *
 * **Not audited** (L-5). The dashboard asked for a row per listing on the argument that
 * this route enumerates; declined, because ADR-006 D-5's exception test is "the output IS
 * the disclosure" and metadata fails it, and because `/orphans` already enumerates here
 * unaudited. See `permission.catalog.ts` — adding it later is additive.
 */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/library',
    access: permission('files.library.read'),
    validate: { query: FileLibraryQuerySchema },
    handler: FileLibraryController.library,
});

/**
 * The UPLOAD — the first write path for files on this service (BR-015).
 *
 * ⚠ **Declared before `/:fileId` as well.** It cannot actually collide with it — `POST` is
 * a different method from the `GET` above — but the assertion in `test:files` reads the
 * whole declaration order rather than per-method order, and a literal segment sitting below
 * a parameter is a pattern nobody should have to re-derive as safe each time.
 *
 * ⚠ **No `validate.body`, and its absence is deliberate rather than an omission.** The body
 * is `multipart/form-data` and this service never PARSES one (ADR-021 D-2): it is piped to
 * jovi-mall unread. A `body:` schema here would be handed `{}` — Express's default for a
 * request no parser matched — and would either pass meaninglessly or reject every upload.
 * The two things that CAN be checked without parsing, the content type and the byte count,
 * are checked in the controller and in `platformUpload`.
 *
 * Tiers 1 and 2, and **audited** (L-6) — it is a write, and every write on this service is
 * audited. The row is the only place the acting administrator is named: jovi-mall stamps
 * `ownerId` with a `wi_admin.admin_accounts._id` it can never dereference, and audits
 * nothing on its own side because it authenticates a service rather than a person.
 */
defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/upload',
    access: permission('files.upload'),
    audit: records('files.upload'),
    handler: FileLibraryController.upload,
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
 * The BYTES — the one route here that answers no envelope (BR-011).
 *
 * ⚠ **`files.content.read`, deliberately NOT `files.resolve`.** The header above explains
 * why resolve is grantable to every tier: the caller already holds the id, so it discloses
 * nothing they did not have. **That reasoning stops at the metadata.** Resolving gives a
 * name and a size; this gives the *picture* — and for `shipments/` that is a photograph of
 * somebody's front door, while for `digital/` it is a vendor's saleable product. Different
 * acts get different names, which is the same call the platform already made for
 * `money.payouts.destination.read`.
 *
 * **Audited, and the audit is what makes the tier-3 grant defensible.** Support holds this
 * because proof-photo disputes are their tickets and refusing them escalates every one —
 * exactly the `agents.tracking.read` trade. The row commits before the bytes are fetched
 * and its failure is not caught, so an unreachable audit store discloses nothing.
 *
 * **No `reason` required**, unlike the two tracking disclosures: an operator opens many
 * images inside one dispute, and a per-image prompt becomes a box somebody types "dispute"
 * into forever. Adding one later is additive — a schema field and a gateway argument.
 *
 * It answers for **any** file, public trees included, streaming them identically. One code
 * path for the dashboard, and no need for a caller to know which tree a file is in.
 *
 * Declared after `/:fileId` because it cannot collide with it — two segments versus one.
 */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/:fileId/content',
    access: permission('files.content.read'),
    validate: { params: FileIdParamSchema },
    audit: records('files.content.read'),
    handler: FileController.content,
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
