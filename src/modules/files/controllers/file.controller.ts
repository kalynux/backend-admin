import { Request, Response } from 'express';
import { asyncHandler } from '../../../core/http/async-handler';
import { createAppError } from '../../../core/errors/app-error';
import { ERROR_CODES } from '../../../core/errors/error-codes';
import { ObjectId } from 'mongodb';
import { sendCreated, sendPaginated, sendSuccess } from '../../../core/http/responses';
import { toPageMeta } from '../../../core/http/list-query';
import { publicUrlsAreConfigured } from '../../../infra/storage/public-url';
import { actorContextOf } from '../../audit/domain/audit-context';
import * as gateway from '../gateways/file.gateway';
import { adminUploadLimits } from '../domain/upload-limits';
import { ownerNameOf, resolveOwnerNames } from '../domain/owner-name.resolver';
import { toLibraryFile } from '../read-models/file-library.dto';
import {
    ENTITY_FILTER_CAP,
    FileLibraryReadRepository,
    FileReferenceReadRepository,
    REFERENCE_SAMPLE_CAP,
} from '../repositories/file-library.read.repository';
import {
    FileLibraryQuery,
    HardDeleteFileBody,
    OrphansQuery,
    ResolveFilesQuery,
} from '../validators/file.validator';

const library = new FileLibraryReadRepository();
const references = new FileReferenceReadRepository();

/**
 * `/api/v1/files` — turning the ids this service hands out into something renderable, and
 * the two housekeeping routes that came with Phase 5 Part B.
 *
 * See `gateways/file.gateway.ts` for why every one of them is delegated rather than
 * performed here.
 */
export class FileController {
    /**
     * GET /api/v1/files?ids=a,b,c — the batch form, and the one a list screen wants.
     *
     * ⚠ **The response may be shorter than the request.** An id that resolves to nothing
     * is simply absent: files are soft-deleted and swept, so a record can outlive its
     * picture, and that is a state to render rather than an error to raise. Clients key
     * the result by `id` rather than by position.
     *
     * Never paginated, and it does not need to be: the input is capped at 100, which is
     * this service's page ceiling, so one call always covers one page.
     */
    static resolve = asyncHandler(async (req: Request, res: Response) => {
        const { ids } = req.query as unknown as ResolveFilesQuery;

        const files = await gateway.resolveMany(ids, actorContextOf(req));

        sendSuccess(res, { files });
    });

    /**
     * GET /api/v1/files/:fileId — the single form, for a detail screen.
     *
     * Unlike the batch above this DOES 404 on an unresolvable id. The difference is what
     * the caller can do about it: a list renders the rows it got and shows a placeholder
     * for the rest, while a caller that asked for exactly one file and got `{}` back has
     * no way to tell "gone" from "the field was empty" without a second branch.
     */
    static get = asyncHandler(async (req: Request, res: Response) => {
        const [file] = await gateway.resolveMany([req.params.fileId], actorContextOf(req));

        if (!file) {
            throw createAppError(
                ERROR_CODES.FILE_NOT_FOUND,
                404,
                'This file no longer exists — it may have been deleted or swept',
            );
        }

        sendSuccess(res, file);
    });

    /**
     * GET /api/v1/files/:fileId/content — the file's BYTES (BR-011).
     *
     * The one route on this service that does not answer an envelope. It streams whatever
     * jovi-mall streams, with jovi-mall's own content type — this service is a pipe here
     * and is not the authority on what the bytes are.
     *
     * ── Why the metadata is read FIRST ────────────────────────────────────────
     * Two reasons, and the second is the one that matters. It supplies the audit row's
     * `label`, so the trail says *which* file was opened rather than only its id — after
     * a later delete the id points at nothing and the label is the whole record. And it
     * turns a mistyped id into a plain 404 **before** an audit row is written, so a typo
     * does not enter the compliance trail as an attempted disclosure. That is the same
     * load-then-audit ordering `payout-disclosure.ts` uses, for the same reason.
     *
     * The extra hop is one `POST /files/resolve` against a batch endpoint on a rare,
     * human-driven operation. It buys a legible trail.
     *
     * ── ⚠ Headers are set BEFORE the pipe, and errors after it are unreportable ─
     * Once `pipe` starts, the status line is already sent — an error surfacing mid-stream
     * cannot become a 500, because there is no status left to change. The response is
     * destroyed instead, which the client sees as a truncated body: the honest signal, and
     * the reason `Content-Length` is forwarded so a client can tell a short read from a
     * complete one. Everything that CAN fail cleanly (the audit write, the provider
     * capability check, the 404) has already happened by then.
     */
    static content = asyncHandler(async (req: Request, res: Response) => {
        const { fileId } = req.params;
        const context = actorContextOf(req);

        const [file] = await gateway.resolveMany([fileId], context);
        if (!file) {
            throw createAppError(
                ERROR_CODES.FILE_NOT_FOUND,
                404,
                'This file no longer exists — it may have been deleted or swept',
            );
        }

        const content = await gateway.openContent(fileId, file.originalName ?? null, context);

        res.setHeader('Content-Type', content.contentType);
        if (content.contentLength !== null) {
            res.setHeader('Content-Length', String(content.contentLength));
        }
        if (content.contentDisposition !== null) {
            res.setHeader('Content-Disposition', content.contentDisposition);
        }
        // Authorization-scoped bytes: no shared cache may hold them, and no proxy between
        // here and the dashboard may keep a copy keyed on the URL alone.
        res.setHeader('Cache-Control', 'private, no-store');

        content.stream.on('error', () => res.destroy());
        content.stream.pipe(res);
    });

    /**
     * GET /api/v1/files/orphans — files no record refers to.
     *
     * The one listing on this mount, behind `files.orphans.read` and tier 1 only. It exists
     * so an operator can judge a file before the unrecoverable delete below, which is why
     * the row carries the filename and not the storage key (D-10) — see the gateway.
     *
     * `meta` is jovi-mall's own count and the cutoff it actually applied, forwarded rather
     * than recomputed: the default cutoff lives there, so recomputing it here would be a
     * second copy that can disagree with the rows it describes.
     */
    static listOrphans = asyncHandler(async (req: Request, res: Response) => {
        const { olderThan } = req.query as unknown as OrphansQuery;

        const { files, meta } = await gateway.listOrphans({ olderThan }, actorContextOf(req));

        sendSuccess(res, { files }, { meta: meta ?? undefined });
    });

    /**
     * DELETE /api/v1/files/:fileId/permanent — the unrecoverable one.
     *
     * ⚠ **The body must repeat the id in the path** (D-9, the `outbox.prune` precedent):
     * make the operator restate the value that decides the blast radius. A mismatch is a
     * `400 FILE_DELETE_NOT_CONFIRMED` and nothing is deleted.
     *
     * The comparison is here rather than in a schema because `validate` runs `params` and
     * `body` as two independent schemas — neither can see the other, so no `superRefine`
     * could express it. Shape in the validator, cross-field rule here.
     *
     * The listing is re-read first so the audit row can carry what the file WAS. That is one
     * extra hop on a rare operation, and it buys the only description of the record that will
     * exist afterwards; without it the trail holds an id pointing at nothing. It is
     * deliberately not fatal on its own: a file absent from the orphan listing — because the
     * window moved, or because it is no longer an orphan — still deletes, and jovi-mall is
     * the authority on whether it may. The audit payload is simply `null` in that case.
     */
    static hardDelete = asyncHandler(async (req: Request, res: Response) => {
        const { fileId } = req.params;
        const { confirmFileId } = req.body as HardDeleteFileBody;

        if (confirmFileId !== fileId) {
            throw createAppError(
                ERROR_CODES.FILE_DELETE_NOT_CONFIRMED,
                400,
                'Repeat the file id from the path in `confirmFileId` to confirm this permanent delete',
            );
        }

        const context = actorContextOf(req);
        const { files } = await gateway.listOrphans({}, context);
        const before = files.find((file) => file.id === fileId) ?? null;

        await gateway.hardDelete(fileId, before, context);

        sendSuccess(res, { id: fileId, deleted: true });
    });
}

/**
 * The media library and the upload door — BR-015.
 *
 * Declared as a second class rather than folded into `FileController` above for one
 * structural reason: **these two routes do not go through the gateway for their data.** The
 * library reads `jovi_mall` directly (L-1) and `test:files` § 2 asserts that
 * `FileController` never touches the platform client, which is what keeps the D-10
 * projection unbypassable on the delegated routes. Putting a direct-read handler in that
 * class would either break that assertion or force it to be weakened.
 *
 * The upload is delegated like everything else, and its gateway call is in the gateway.
 */
export class FileLibraryController {
    /**
     * GET /api/v1/files/library — every file on the platform, with its owner and its usage.
     *
     * ── The four reads, and the order they run in ─────────────────────────────
     *   1. `file_references` → the file ids one entity uses, ONLY when `entityType`/
     *      `entityId` are sent. Resolved first because it narrows the main query, and it is
     *      an index scan on `{ entityType, entityId, deletedAt }`.
     *   2. `files` → the page itself. Filtered, sorted, skipped and limited.
     *   3. `file_references` again → usage for the page's ids. **After** skip/limit, so it
     *      touches at most `limit` files rather than the whole matched set.
     *   4. the role collections → owner names, one query per owner type PRESENT on the page.
     *
     * Steps 3 and 4 run concurrently: they read different collections and neither depends
     * on the other. Worst case is a page mixing all five owner types, which is six queries
     * for a hundred rows — never one per row.
     *
     * ⚠ **Not audited** (L-5), and the dashboard asked for the opposite. Their argument is
     * good and is recorded rather than dismissed: this route ENUMERATES, and "the caller
     * already holds the id" — the reasoning that makes `files.resolve` safe at every tier —
     * does not survive a listing. It was declined because ADR-006 D-5's exception test is
     * "the output IS the disclosure", which metadata fails, and because `files.orphans.read`
     * already enumerates on this same mount unaudited. Adding the row later is purely
     * additive; see `permission.catalog.ts` at `files.library.read`.
     */
    static library = asyncHandler(async (req: Request, res: Response) => {
        const query = req.query as unknown as FileLibraryQuery;

        /**
         * `null` and `[]` mean different things here and the distinction is load-bearing:
         * `null` is "no entity filter was asked for", `[]` is "this entity references
         * nothing" and must produce an empty page rather than the whole library. The
         * validator guarantees the pair arrives together or not at all.
         */
        let entityFileIds: ObjectId[] | null = null;
        let entityFilterTruncated = false;

        if (query.entityType && query.entityId) {
            const found = await references.findFileIdsForEntity(query.entityType, query.entityId);
            entityFileIds = found.ids;
            entityFilterTruncated = found.truncated;
        }

        const page = await library.search(query, entityFileIds);

        const [usage, ownerNames] = await Promise.all([
            references.findUsageForFiles(page.items.map((row) => row._id)),
            resolveOwnerNames(page.items),
        ]);

        const files = page.items.map((row) =>
            toLibraryFile(row, ownerNameOf(row, ownerNames), usage.get(row._id.toString())),
        );

        sendPaginated(res, files, {
            ...toPageMeta(page.total, page.page, page.limit),

            /**
             * ⚠ **The cap is DECLARED, because a silent truncation is forbidden** (ADR-005
             * D-13) and because the dashboard asked for exactly this: *"a `referenceCount`
             * with a truncated `references` array is the right answer; a page that quietly
             * drops the rest is not."* Without this number a client cannot tell "three
             * references" from "three of many".
             *
             * Sent unconditionally rather than only when something was actually truncated:
             * a client renders `referenceCount > references.length` as "and N more", and it
             * needs the cap to know that shape is possible at all.
             */
            referenceSampleCap: REFERENCE_SAMPLE_CAP,

            /**
             * Whether this deployment can build public URLs AT ALL (L-3).
             *
             * `url: null` has three causes here and only one of them is about the file. This
             * separates the other two — an unset or unreproducible `STORAGE_PROVIDER` on
             * *this* side — from "the file is in a private tree", so a page of nulls is
             * distinguishable from a page of private files. The same `configured: false`
             * shape both geo-tracker doors already use, for the same reason: "not set up
             * here" and "there is nothing to show" are different answers.
             */
            publicUrlsConfigured: publicUrlsAreConfigured(),

            // Only when an entity filter actually ran — the same conditional shape
            // `businessNameMatchesTruncated` uses on the vendor directory.
            ...(entityFilterTruncated
                ? { entityFilterTruncated: true, entityFilterCap: ENTITY_FILTER_CAP }
                : {}),
        });
    });

    /**
     * POST /api/v1/files/upload — put a file on the platform as the administration.
     *
     * ── ⚠ THE BODY IS NEVER PARSED, and both gates here exist because of that ──
     * `app.ts` mounts `express.json` and `express.urlencoded` with their default
     * content-type matchers, so a `multipart/form-data` request matches neither and arrives
     * with `req` unread and still flowing. That is what makes the proxy possible with no
     * multer and no new dependency (L-2, ADR-021 D-2) — and it is also what removes every
     * protection a body parser would have given:
     *
     *   - the 1 MB `express.json` limit **never sees this request**, so without the
     *     `Content-Length` check below and the byte counter in `platformUpload` there would
     *     be no ceiling on it at all;
     *   - nothing validates the content type, so a JSON body would be forwarded happily and
     *     come back as jovi-mall's `NO_FILES_UPLOADED` — a refusal in another service's
     *     vocabulary, about a request the caller never addressed there.
     *
     * Hence two explicit gates, both **before** the hop: a doomed body is never streamed
     * across it.
     *
     * ── `Content-Length` is checked here, and the bytes are counted there ──────
     * A chunked upload declares no length, so a ceiling that only reads the header is one
     * any client can opt out of. This gate is the cheap early refusal; `platformUpload`'s
     * `capBytes` is the one that actually binds. Both report the same code and status.
     *
     * ⚠ **`maxFiles` and the accepted MIME list are NOT enforced here** and cannot be —
     * seeing a part boundary or a per-part content type means parsing. They are published
     * in `meta` and in the docs so a picker can filter its file dialog, and jovi-mall's
     * pipeline is the authority. A file that slips past a client comes back as an ordinary
     * `PLATFORM_OPERATION_REJECTED` carrying jovi-mall's `UPLOAD_POLICY_VIOLATION`, whose
     * `details.violations[]` names the offending file. See `domain/upload-limits.ts`.
     */
    static upload = asyncHandler(async (req: Request, res: Response) => {
        const limits = adminUploadLimits();
        const contentType = req.headers['content-type'] ?? '';

        if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
            throw createAppError(
                ERROR_CODES.FILE_UPLOAD_NOT_MULTIPART,
                415,
                `Send the file as multipart/form-data under the \`${limits.fieldName}\` field`,
                { fieldName: limits.fieldName, received: contentType || null },
            );
        }

        const declared = Number(req.headers['content-length']);
        const contentLength = Number.isFinite(declared) ? declared : null;

        if (contentLength !== null && contentLength > limits.maxBytes) {
            throw createAppError(
                ERROR_CODES.FILE_UPLOAD_TOO_LARGE,
                413,
                'This upload is larger than the administration upload limit',
                { maxBytes: limits.maxBytes, declaredBytes: contentLength },
            );
        }

        const files = await gateway.uploadFiles(
            { body: req, contentType, contentLength },
            actorContextOf(req),
        );

        /**
         * `{ files: [...] }`, not a bare object, and **201**.
         *
         * The BR asks for "the created `FileDetail`" in the singular because a picker
         * uploads one file. The route accepts up to ten, because it is a thin proxy over
         * `uploadMultiple`, which is `multer(...).array('files', 10)` — so the response has
         * to be able to describe ten. An array under `files` is the shape `GET /files?ids=`
         * already answers on this mount, so a client that handles one handles the other.
         *
         * ⚠ **The order matches the multipart parts, and the CONTENT does not necessarily
         * match what was sent**: jovi-mall's pipeline sniffs the real type and converts PNG
         * to WebP, so `mimeType` and the key's extension are what was STORED. Read the
         * response rather than echoing the request.
         */
        sendCreated(res, { files }, {
            meta: {
                count: files.length,
                // Declared, never discovered — the BR asked for these by name. They are
                // repeated here so a client that never read the docs still learns them from
                // its first successful call.
                maxBytes: limits.maxBytes,
                maxFiles: limits.maxFiles,
                fieldName: limits.fieldName,
                acceptedMimeTypes: limits.acceptedMimeTypes,
            },
        });
    });
}
