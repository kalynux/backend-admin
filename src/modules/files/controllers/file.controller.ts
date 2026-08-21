import { Request, Response } from 'express';
import { asyncHandler } from '../../../core/http/async-handler';
import { createAppError } from '../../../core/errors/app-error';
import { ERROR_CODES } from '../../../core/errors/error-codes';
import { sendSuccess } from '../../../core/http/responses';
import { actorContextOf } from '../../audit/domain/audit-context';
import * as gateway from '../gateways/file.gateway';
import { HardDeleteFileBody, OrphansQuery, ResolveFilesQuery } from '../validators/file.validator';

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
