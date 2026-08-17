import { z } from 'zod';
import { idParam, objectId } from '../../../core/validation/common.schemas';

/** `GET /api/v1/files/:fileId`. */
export const FileIdParamSchema = idParam('fileId', 'file');

/**
 * `GET /api/v1/files?ids=a,b,c`.
 *
 * ── Why a comma-separated string and not repeated `?ids=` ────────────────────
 * Express parses `?ids=a&ids=b` as an array and `?ids=a` as a string, so every consumer
 * has to normalise. One documented separator removes the branch.
 *
 * ── Why 100 ─────────────────────────────────────────────────────────────────
 * The same ceiling `limit` has everywhere on this service. A caller can therefore always
 * resolve a whole page of rows in one request, and can never ask for more than a page —
 * which is what keeps this a resolver rather than a bulk exporter.
 *
 * ⚠ Ids are REQUIRED. There is deliberately no "all files" form: this endpoint resolves
 * ids the caller already holds and must never become a listing. The listing is
 * `files.orphans.read`, which is tier 1 only.
 */
export const ResolveFilesQuerySchema = z.object({
    ids: z
        .string()
        .transform((value) => value.split(',').map((id) => id.trim()).filter(Boolean))
        .pipe(
            z
                .array(objectId)
                .min(1, 'At least one file id is required')
                .max(100, 'At most 100 file ids may be resolved at once'),
        ),
});

export type ResolveFilesQuery = z.infer<typeof ResolveFilesQuerySchema>;
