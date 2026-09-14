import { Request, Response } from 'express';
import { createAppError } from '../../../core/errors/app-error';
import { ERROR_CODES } from '../../../core/errors/error-codes';
import { asyncHandler } from '../../../core/http/async-handler';
import { sendCreated, sendSuccess } from '../../../core/http/responses';
import { env } from '../../../config/env';
import { actorContextOf, requestContext } from '../../audit/domain/audit-context';
import { requireAdminIdentity } from '../../admin-identity/domain/admin-identity.types';
import * as employees from '../domain/employee.service';
import { uploadStaffDocument } from '../gateways/employee-document.gateway';
import { EmployeeDocumentSlot } from '../domain/employee-document.types';
import {
    SetAvatarSchema,
    UpdateEmployeeRecordInput,
    UpdateEmploymentInput,
} from '../validators/employee.validator';

/**
 * `/api/v1/employees` — the staff employment record.
 *
 * ── ⚠ THE MOUNT IS SPLIT IN TWO, AND THE SPLIT IS THE ACCESS CONTROL ────────
 * `/me/*` is self-service: it derives the subject from the session and takes no id. Every
 * other path takes `:adminId` and is behind `employees.read` or
 * `employees.employment.write`, both tier 1.
 *
 * That is not a stylistic preference. It means the id-taking routes and the writing routes
 * are DISJOINT sets, apart from the employment block: a tier-1 Developer reads a colleague's
 * file and cannot alter what is in it, and an employee writes their own and cannot name
 * anybody else's. A single `/:adminId` mount carrying both would collapse that into one
 * authorization check somebody has to get right on every handler.
 */

/** The multipart field name jovi-mall's staff-document multer instance is bound to. */
const DOCUMENT_FIELD_NAME = 'documents';

export class EmployeeController {
    // ─── The caller's own record ─────────────────────────────────────────────

    static me = asyncHandler(async (req: Request, res: Response) => {
        sendSuccess(res, await employees.getOwnRecord(requireAdminIdentity(req)));
    });

    static updateMe = asyncHandler(async (req: Request, res: Response) => {
        const admin = requireAdminIdentity(req);
        const input = req.body as UpdateEmployeeRecordInput;
        sendSuccess(res, await employees.updateOwnRecord(admin, input, requestContext(req)), {
            message: 'Your employee record has been updated',
        });
    });

    static setAvatar = asyncHandler(async (req: Request, res: Response) => {
        const admin = requireAdminIdentity(req);
        const { fileId } = req.body as { fileId: string | null };
        sendSuccess(res, await employees.setAvatar(admin, fileId, requestContext(req)));
    });

    /**
     * POST /me/documents/:slot — upload into a slot. Multipart, field name `documents`.
     *
     * ── ⚠ The body is NEVER PARSED here ──────────────────────────────────────
     * `express.json` and `express.urlencoded` are content-type gated, so a
     * `multipart/form-data` request matches neither and arrives with `req` unread and still
     * flowing. It is piped straight at jovi-mall. This service holds no multer and no busboy,
     * which is ADR-021 D-2 and the reason the checks below are the only two possible: a
     * content type and a declared length are the sole facts available without parsing.
     *
     * ── The room check runs BEFORE the bytes cross, and `offered` is EXACTLY 1 ──
     * The alternative is uploading a file and then reporting that the slot is full — which has
     * already spent the bandwidth, run the virus scan and written a row jovi-mall must now
     * sweep.
     *
     * ⚠ **`offered: 1` is not an approximation.** This service cannot count multipart parts, so
     * a guess here would be wrong precisely when it matters: three sketches posted into a slot
     * holding eight would pass a check written for one and land eleven files in a ten-file
     * slot, with no way to refuse them that does not orphan bytes.
     *
     * The far side therefore accepts **exactly one file per request** —
     * `getAdminIdentityDocumentUploadConfig().maxFilesPerRequest` is 1 and its multer instance
     * refuses a second part outright — which is what makes this number exact rather than
     * optimistic. ⚠ **If that cap is ever raised, this check stops being sound in the same
     * change.**
     */
    static uploadDocument = asyncHandler(async (req: Request, res: Response) => {
        const admin = requireAdminIdentity(req);
        const slot = (req.params as { slot: EmployeeDocumentSlot }).slot;
        const contentType = req.headers['content-type'] ?? '';

        if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
            throw createAppError(
                ERROR_CODES.FILE_UPLOAD_NOT_MULTIPART,
                415,
                `Send the document as multipart/form-data under the \`${DOCUMENT_FIELD_NAME}\` field`,
                { fieldName: DOCUMENT_FIELD_NAME, received: contentType || null },
            );
        }

        const maxBytes = env().ADMIN_UPLOAD_MAX_BYTES;
        const declared = Number(req.headers['content-length']);
        const contentLength = Number.isFinite(declared) ? declared : null;

        if (contentLength !== null && contentLength > maxBytes) {
            throw createAppError(
                ERROR_CODES.FILE_UPLOAD_TOO_LARGE,
                413,
                'This upload is larger than the administration upload limit',
                { maxBytes, declaredBytes: contentLength },
            );
        }

        await employees.assertSlotHasRoom(admin, slot, 1);

        const context = actorContextOf(req);
        const uploaded = await uploadStaffDocument({ body: req, contentType, contentLength, slot }, context);

        const record = await employees.attachDocuments(
            admin,
            slot,
            uploaded.map((file) => file.id),
            context,
        );

        /**
         * The whole record back, not just the created files.
         *
         * A client that uploads a document immediately wants to know whether that closed the
         * last gap on the activation checklist — and `readiness` is on the record. Answering
         * the files alone would make every upload two round trips for no gain.
         */
        sendCreated(res, record, {
            meta: {
                slot,
                uploaded: uploaded.map((file) => ({
                    id: file.id,
                    mimeType: file.mimeType,
                    size: file.size,
                })),
                /**
                 * ⚠ Repeated on every successful upload so a client learns them without
                 * reading the docs — the same `declared, never discovered` rule the media
                 * upload follows. `fieldName` matters most: a part sent under another name is
                 * not an error at the far end, it is simply not seen.
                 */
                maxBytes,
                fieldName: DOCUMENT_FIELD_NAME,
            },
        });
    });

    static deleteDocument = asyncHandler(async (req: Request, res: Response) => {
        const admin = requireAdminIdentity(req);
        const { slot, fileId } = req.params as { slot: EmployeeDocumentSlot; fileId: string };
        sendSuccess(res, await employees.detachDocument(admin, slot, fileId, actorContextOf(req)), {
            message: 'Document removed',
        });
    });

    // ─── Somebody else's record — tier 1 ─────────────────────────────────────

    /**
     * GET /:adminId — a Developer reading a colleague's file.
     *
     * ⚠ **Not audited**, and the reasoning is in `employee.service.ts`: this returns ids, and
     * every id whose content is sensitive needs a second call to `/files/:fileId/content`,
     * which IS audited per file and fail-closed. The disclosure of the pictures is recorded
     * where it happens.
     */
    static get = asyncHandler(async (req: Request, res: Response) => {
        const { adminId } = req.params as { adminId: string };
        sendSuccess(res, await employees.getRecordForReview(adminId));
    });

    /** PATCH /:adminId/employment — the company's terms, written by a Developer. */
    static updateEmployment = asyncHandler(async (req: Request, res: Response) => {
        const admin = requireAdminIdentity(req);
        const { adminId } = req.params as { adminId: string };
        const input = req.body as UpdateEmploymentInput;

        sendSuccess(
            res,
            await employees.updateEmployment(admin, adminId, input, requestContext(req)),
            { message: 'Employment details updated' },
        );
    });
}

/** Re-exported so the routes file can name the schema beside the handler it validates. */
export { SetAvatarSchema };
