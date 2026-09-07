import { z } from 'zod';
import { listQuery } from '../../../core/http/list-query';
import { idParam, isoDateTime, objectId, searchTerm } from '../../../core/validation/common.schemas';

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

// ─────────────────────────────────────────────────────────────────────────────
// The media library — BR-015
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `GET /api/v1/files/library` — the SECOND listing on this mount, and the first read on it
 * that is not delegated.
 *
 * ── ⚠ This schema is NOT jovi-mall's `ListFilesQuerySchema` passed through ───────────────
 * The BR proposed exactly that, and it stopped being possible the moment the read became
 * direct (L-1): nothing on this request reaches jovi-mall, so nothing validates it there.
 * The shape is mirrored **field for field** so a client written against the BR works, with
 * three deliberate divergences, each stated in `docs/api/files.md` rather than left to be
 * discovered:
 *
 *   1. **`limit` is 100, not 50** (L-4). `LIMIT_MAX` is universal on this service and the
 *      request no longer passes through jovi-mall's validator, so its 50 binds nothing.
 *   2. **`sort` replaces `sortBy`/`sortOrder`.** Every list on this service takes one
 *      `sort=-createdAt` token, validated against a `SortMap` allowlist so no client string
 *      ever reaches a Mongo sort document. Two endpoints with two sort dialects is worse
 *      than one endpoint that differs from another service.
 *      ⚠ **And the divergence is SILENT if a client gets it wrong**: `listQuery` is not
 *      `.strict()`, so a stray `sortBy=size` is dropped and the page comes back in the
 *      default order rather than 400-ing. That is a known service-wide property, not a
 *      property of this route — which is exactly why the docs state the form outright.
 *   3. **Dates are strict ISO-8601 instants with a zone**, via `isoDateTime`, where
 *      jovi-mall takes `z.coerce.date()`. A bare `2026-08-01` means a different 24 hours in
 *      Douala than in Lisbon, and a filter whose boundary depends on the server's timezone
 *      is one nobody can reproduce.
 */
export const FILE_LIBRARY_SORT = {
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
    size: 'size',
    originalName: 'originalName',
} as const;

/**
 * The broad media categories, mirrored from jovi-mall's `MEDIA_CATEGORIES`.
 *
 * The matcher each one expands to lives beside the query in
 * `repositories/file-library.read.repository.ts`; this is only the accepted vocabulary.
 */
const MEDIA_CATEGORIES = ['image', 'video', 'audio', 'document', 'archive', 'other'] as const;

/**
 * ⚠ **SIX values, of which only three can ever appear and only two produce a URL.**
 *
 * This is `IFile.provider`'s Mongoose enum — the column's legal domain — so refusing `s3`
 * here would refuse a value the database is schema-permitted to hold. But
 * `storage.config.ts` declares a `StorageProviderType` of **three** (`local`, `firebase`,
 * `cloudinary`): `s3`, `gcs` and `r2` have no provider implementation in jovi-mall at all,
 * so no row can carry one unless it was written by hand. And of the three real ones this
 * service can reproduce a public URL for **two** — see `infra/storage/public-url.ts`.
 *
 * The filter is therefore accepted at its widest and answers honestly: a `?provider=s3`
 * page is empty because nothing is stored that way, not because the parameter was rejected.
 * BR-015's filter table repeats the six as though they were all available; the docs say
 * which is true on the wire.
 */
const STORAGE_PROVIDERS = ['local', 's3', 'gcs', 'r2', 'firebase', 'cloudinary'] as const;

/** `IFile.ownerType` — the six-value `FileOwnerType` union, verbatim. */
const FILE_OWNER_TYPES = ['vendor', 'admin', 'customer', 'agent', 'agency', 'system'] as const;

/**
 * `IFileReference.entityType` — jovi-mall's twelve-value union, verbatim.
 *
 * An allowlist rather than a free string because the value goes into a Mongo filter against
 * an indexed column: an arbitrary one would be a scan of `file_references` answering
 * nothing.
 */
const FILE_REFERENCE_ENTITY_TYPES = [
    'product', 'variant', 'digital_asset', 'ticket', 'vendor', 'store',
    'agency', 'agency_magazin', 'customer', 'agent', 'admin', 'shipment',
] as const;

export const FileLibraryQuerySchema = listQuery(FILE_LIBRARY_SORT, '-createdAt', {
    /** Case-insensitive substring on `originalName`. Escaped at the repository — never here. */
    search: searchTerm.optional(),

    /** An exact match. Wins over `category` when both are sent, as it does in jovi-mall. */
    mimeType: z.string().trim().min(1).max(150).optional(),
    category: z.enum(MEDIA_CATEGORIES).optional(),
    provider: z.enum(STORAGE_PROVIDERS).optional(),

    /**
     * **The one parameter the media picker exists for.** `?ownerType=admin` is what makes
     * "only files uploaded by the administration" true, and it is a filter on data that has
     * always been there rather than a new concept.
     */
    ownerType: z.enum(FILE_OWNER_TYPES).optional(),

    minSize: z.coerce.number().int().min(0).optional(),
    maxSize: z.coerce.number().int().min(0).optional(),

    createdAfter: isoDateTime.optional(),
    createdBefore: isoDateTime.optional(),

    /**
     * "What is not attached to anything" — derived from `orphanedAt`, so the media menu can
     * ask it without becoming the orphan screen.
     *
     * ⚠ `used` and `unused` are not exact complements of `usage.referenceCount`. See
     * `buildLibraryFilter`: a file uploaded and never attached has `orphanedAt: null` and so
     * reports `used` here while carrying a count of `0`. The count is the precise answer.
     */
    usage: z.enum(['used', 'unused']).optional(),

    /** "What files does this ticket use". Both halves or neither — see the rule below. */
    entityType: z.enum(FILE_REFERENCE_ENTITY_TYPES).optional(),
    entityId: objectId.optional(),
})
    .superRefine((value, ctx) => {
        if (value.minSize !== undefined && value.maxSize !== undefined && value.minSize > value.maxSize) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['maxSize'],
                message: '`maxSize` must be greater than or equal to `minSize`',
            });
        }

        if (value.createdAfter && value.createdBefore && value.createdAfter > value.createdBefore) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['createdBefore'],
                message: '`createdBefore` must be on or after `createdAfter`',
            });
        }

        /**
         * ⚠ **Refused rather than ignored, and that is the point of the rule.**
         *
         * `entityType` alone would silently widen to "every file any ticket anywhere uses",
         * which is not a narrower answer than the unfiltered library — it is a DIFFERENT
         * one, arrived at by dropping half of what the caller asked. `entityId` alone would
         * silently match nothing, because the index and the uniqueness constraint are both
         * on the pair. Either way the client gets a 200 describing a question it did not
         * ask, which is the failure mode `listQuery` not being `.strict()` already
         * contributes enough of.
         */
        const hasType = value.entityType !== undefined;
        const hasId = value.entityId !== undefined;
        if (hasType !== hasId) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: [hasType ? 'entityId' : 'entityType'],
                message: '`entityType` and `entityId` must be sent together — one without the other filters nothing',
            });
        }
    });

export type FileLibraryQuery = z.infer<typeof FileLibraryQuerySchema>;
