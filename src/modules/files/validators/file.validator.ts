import { z } from 'zod';
import { idParam, isoDateTime, objectId } from '../../../core/validation/common.schemas';

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
 * `files.orphans.read` below — a different permission and a different question (which
 * files does nothing reference), never a way to enumerate this one.
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

/**
 * `GET /api/v1/files/orphans` — the one listing on this mount.
 *
 * ⚠ **The 24-hour floor is not politeness, and it is enforced on BOTH sides.** jovi-mall's
 * `OrphansQuerySchema` refuses the same thing, and repeating it here means the refusal arrives
 * before the hop rather than after it — the same shape `PruneOutboxSchema` uses for its 7-day
 * retention floor. A file is uploaded and attached seconds later; a window that reached into
 * the last minute would list files that are about to be referenced and feed them to an
 * unrecoverable delete.
 *
 * Absent means seven days ago, which is jovi-mall's default. Not restated as a default here:
 * one default in one place, the rule the dev-tools validators already follow.
 */
export const OrphansQuerySchema = z.object({
    olderThan: isoDateTime
        .refine(
            (value) => value.getTime() <= Date.now() - 24 * 60 * 60 * 1000,
            '`olderThan` must be at least 24 hours in the past',
        )
        .optional(),
});

/**
 * `DELETE /api/v1/files/:fileId/permanent` — the confirmation body (Phase 5 D-9).
 *
 * The `outbox.prune` precedent: make the operator restate the value that decides the blast
 * radius. There it is the retention age; here it is the file id, because the id is the whole
 * of what this operation acts on.
 *
 * ⚠ **The match against the path is NOT here**, and cannot be: `validate` runs `params` and
 * `body` as two independent schemas, so no `superRefine` on either can see the other. The
 * controller compares them and raises `FILE_DELETE_NOT_CONFIRMED`. Shape here, cross-field rule
 * there — the same split `dateRangeFields`/`dateRangeRule` makes for the same reason.
 */
export const HardDeleteFileBodySchema = z.object({
    confirmFileId: objectId,
});

export type ResolveFilesQuery = z.infer<typeof ResolveFilesQuerySchema>;
export type OrphansQuery = z.infer<typeof OrphansQuerySchema>;
export type HardDeleteFileBody = z.infer<typeof HardDeleteFileBodySchema>;
