import { Request, Response } from 'express';
import { asyncHandler } from '../../../core/http/async-handler';
import { createAppError } from '../../../core/errors/app-error';
import { ERROR_CODES } from '../../../core/errors/error-codes';
import { sendSuccess } from '../../../core/http/responses';
import { actorContextOf } from '../../audit/domain/audit-context';
import * as gateway from '../gateways/file.gateway';
import { ResolveFilesQuery } from '../validators/file.validator';

/**
 * `/api/v1/files` — turning the ids this service hands out into something renderable.
 *
 * Two routes, one operation. See `gateways/file.gateway.ts` for why the resolution is
 * delegated rather than performed here.
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
}
