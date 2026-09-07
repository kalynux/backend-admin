import { Document, Filter, ObjectId } from 'mongodb';
import { Types } from 'mongoose';
import { containsInsensitive, toMongoSort } from '../../../core/data/mongo-list';
import { COLLECTIONS } from '../../../infra/platform/collections';
import { Paginated, PlatformReadRepository } from '../../../infra/platform/platform.repository';
import { FILE_LIBRARY_SORT, FileLibraryQuery } from '../validators/file.validator';

/**
 * The media library — `jovi_mall.files`, read DIRECTLY, joined to `file_references` for
 * usage (BR-015 · decision L-1).
 *
 * ── Why this one read is not delegated, when every other route on the mount is ──────────
 * ADR-009 D-1, generalised at ADR-011 D-1: **delegate a read whose answer is a VERDICT the
 * platform acts on; read directly a read whose answer is a RECORD.** A file row and a
 * reference row are records. There is no verdict anywhere on this surface — nothing here is
 * a decision jovi-mall then acts on, and nothing here can be wrong in a way that moves data.
 *
 * It is also the only way the screen can exist at all. jovi-mall's `GET /api/files` does
 * three things this needs and none of them well:
 *
 *   - it cannot join `file_references`, so it cannot answer "is this used, and by what";
 *   - it cannot resolve an owner NAME, which lives across five different role collections
 *     and — for `ownerType: 'admin'` — in **this service's own database**, which jovi-mall
 *     cannot read at all;
 *   - it is unreachable regardless. `requireAuth` has no `admin` branch (Phase 5 Part B), so
 *     the `// Admins: no owner filter` path in `FileManagementController.listFiles` is live
 *     code no caller can arrive on.
 *
 * Delegating would therefore have meant building a new query in jovi-mall whose only caller
 * is this service, for a read with no invariant to protect — and the admin half of it would
 * still have had to come back here.
 *
 * ⚠ **WRITES stay delegated, and on this pair the reason is concrete.** Creating a `files`
 * row is the tail of an upload that also wrote bytes through `STORAGE_PROVIDER`; a
 * `file_references` row is maintained by the layer that sets and clears `File.orphanedAt`.
 * A second writer here produces a row pointing at no object, or an orphan sweep that
 * reclaims a file something is using. `PlatformReadRepository` has no write method, so that
 * is not something this file could break by accident.
 *
 * ── The field names are camelCase, and that is jovi-mall's doing ────────────────────────
 * Almost every collection on that side is `snake_case`; the catalog's file models are not
 * (`mimeType`, `originalName`, `ownerType`, `orphanedAt`, and `createdAt` from
 * `BaseSchemaFields`). Do not "correct" a filter here to snake_case — it would match
 * nothing and read as an empty library rather than as a wrong query.
 */

// ─────────────────────────────────────────────────────────────────────────────
// files
// ─────────────────────────────────────────────────────────────────────────────

export interface StoredFileReadModel extends Document {
    _id: ObjectId;
    key: string;
    mimeType: string;
    size: number;
    originalName?: string | null;
    ownerType?: string | null;
    ownerId?: ObjectId | null;
    orphanedAt?: Date | null;
    /**
     * Set while the file's owner is over their plan storage cap and this file falls outside
     * it. Written by jovi-mall's plan-quota sweep; read here so `toFileDetail` can report
     * `access: 'quota_blocked'` instead of publishing a URL jovi-mall no longer serves.
     */
    quotaBlockedAt?: Date | null;
    createdAt: Date;
}

/**
 * The list whitelist.
 *
 * ⚠ **`key` IS projected here, and that is a deliberate departure from the orphan row's
 * D-10 rule rather than a lapse.** D-10 withholds the storage key from an orphan listing
 * because the operator's question there is "may I destroy this", which a filename answers
 * and a bucket path does not. The library's question is "show me this picture", and after
 * L-3 the key is what `toFileDetail` builds the URL FROM — withholding it would make the
 * one field the screen exists for unbuildable. `FileDetail.key` is already on the wire on
 * every other file route on this service, so nothing new is disclosed.
 *
 * `checksum` is NOT projected: it is a content fingerprint, it is on no `FileDetail`
 * anywhere on the platform, and a page of them is a hundred content hashes shipped to a
 * screen that renders none. `deletedAt`, `purgeAt` and `updatedAt` are absent for the
 * ordinary reason — a whitelist protects what nobody thought of, and an exclusion list does
 * not.
 *
 * ⚠ **`provider` is absent although the route FILTERS on it**, and that is not an
 * inconsistency. The filter is a `$match` clause and needs no projected column; the row has
 * nowhere to put the value, because `FileDetail` carries no `provider` on any route on this
 * platform — and `buildPublicUrl` keys on the deployment's ACTIVE provider rather than on
 * the row's field, deliberately mirroring jovi-mall (see `public-url.ts`). Publishing it
 * would invite a client to build a URL from it and get a different answer from the one this
 * service just gave it.
 */
const FILE_LIBRARY_PROJECTION = {
    _id: 1,
    key: 1,
    mimeType: 1,
    size: 1,
    originalName: 1,
    ownerType: 1,
    ownerId: 1,
    orphanedAt: 1,
    // ⚠ Required, not optional. `toFileDetail` reads it, and an omitted column reads as
    // "not blocked" — so leaving it out of the whitelist does not fail, it silently
    // republishes public URLs for files jovi-mall has stopped serving. This is the one
    // entry here whose absence is a LEAK rather than a missing field.
    quotaBlockedAt: 1,
    createdAt: 1,
} as const;

/**
 * `category` → a `mimeType` matcher.
 *
 * ── COPIED VERBATIM from jovi-mall ───────────────────────────────────────────
 *   source: jovi-mall/src/modules/catalog/domain/services/media/media-category.ts
 *           (the `MEDIA_CATEGORY_MATCHERS` export)
 *
 * Mirrored rather than approximated because the same taxonomy decides a file's **storage
 * folder** on upload (`resolveTypeFolder` runs the in-process twin of these branches). A
 * looser `other` here would list a PDF the platform filed under `documents/`, so the two
 * halves of one taxonomy would disagree about the same file.
 *
 * ⚠ **`other` is a negation, and it must stay one.** The obvious simplification — "not
 * image, video or audio" — silently reclassifies every PDF, spreadsheet and archive as
 * `other`, which is the one category an operator uses to find files nobody has a name for.
 * The expression below is jovi-mall's, character for character, including its escaping.
 */
const DOCUMENT_MIME_TYPES = [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/rtf',
    'text/plain',
    'text/csv',
    'application/epub+zip',
];

const ARCHIVE_MIME_TYPES = [
    'application/zip',
    'application/x-zip-compressed',
    'application/x-rar-compressed',
    'application/vnd.rar',
    'application/x-7z-compressed',
    'application/x-tar',
    'application/gzip',
];

export const MEDIA_CATEGORY_MATCHERS: Readonly<Record<string, unknown>> = Object.freeze({
    image: { $regex: '^image/', $options: 'i' },
    video: { $regex: '^video/', $options: 'i' },
    audio: { $regex: '^audio/', $options: 'i' },
    document: { $in: DOCUMENT_MIME_TYPES },
    archive: { $in: ARCHIVE_MIME_TYPES },
    other: {
        $not: {
            $regex:
                '^(image|video|audio)/|^application/(pdf|msword|rtf|zip|x-zip-compressed|x-rar-compressed|vnd\\.rar|x-7z-compressed|x-tar|gzip|epub\\+zip|vnd\\.(ms-excel|ms-powerpoint|openxmlformats-officedocument\\.(wordprocessingml\\.document|spreadsheetml\\.sheet|presentationml\\.presentation)))$|^text/(plain|csv)$',
            $options: 'i',
        },
    },
});

export class FileLibraryReadRepository extends PlatformReadRepository<StoredFileReadModel> {
    constructor() {
        super(COLLECTIONS.FILE, FILE_LIBRARY_PROJECTION);
    }

    /**
     * A page of the library.
     *
     * `entityFileIds` is passed in rather than joined, and the reason is paging: a
     * `$lookup` that decides which rows MATCH has to run before skip/limit, so it would
     * touch the whole collection on every request. `file_references` carries a
     * `{ entityType, entityId, deletedAt }` index put there for exactly this question, so
     * the ids are resolved from it first and arrive here as an `$in`. See
     * `FileReferenceReadRepository.findFileIdsForEntity`.
     */
    async search(
        query: FileLibraryQuery,
        entityFileIds: ObjectId[] | null,
    ): Promise<Paginated<StoredFileReadModel>> {
        return this.findPage(buildLibraryFilter(query, entityFileIds), {
            page: query.page,
            limit: query.limit,
            sort: toMongoSort(query.sort, FILE_LIBRARY_SORT),
        });
    }
}

/**
 * The filter, built here rather than in the controller so a caller cannot drop a clause,
 * and exported so `test:files` can assert every branch without a database.
 */
export function buildLibraryFilter(
    query: FileLibraryQuery,
    entityFileIds: ObjectId[] | null,
): Filter<StoredFileReadModel> {
    // Soft-deleted rows are swept by jovi-mall's file-cleanup and must never appear: the
    // picker would offer a file whose bytes are about to be reclaimed.
    const filter: Record<string, unknown> = { deletedAt: null };

    /**
     * `entityFileIds` of `[]` is a real answer — "this ticket references nothing" — and it
     * must produce an empty page rather than being treated as "no filter". `$in: []` is
     * the honest encoding and is what `null` deliberately is not.
     */
    if (entityFileIds !== null) filter._id = { $in: entityFileIds };

    /**
     * ⚠ `containsInsensitive`, never a bare `new RegExp`. `originalName` is uploader-supplied
     * and the search term is operator-supplied: unescaped, `a.b` matches anything and
     * `(a+)+$` is catastrophic backtracking served from a search box. `core/data/mongo-list`
     * is the only sanctioned builder on this service, and no repository here constructs a
     * pattern itself.
     */
    if (query.search) filter.originalName = containsInsensitive(query.search);

    // An explicit `mimeType` wins over `category`, matching jovi-mall's own precedence:
    // the two describe the same column, and the specific answer is the one to honour.
    if (query.mimeType) {
        filter.mimeType = query.mimeType;
    } else if (query.category) {
        filter.mimeType = MEDIA_CATEGORY_MATCHERS[query.category];
    }

    if (query.provider) filter.provider = query.provider;
    if (query.ownerType) filter.ownerType = query.ownerType;

    if (query.minSize !== undefined || query.maxSize !== undefined) {
        filter.size = {
            ...(query.minSize !== undefined ? { $gte: query.minSize } : {}),
            ...(query.maxSize !== undefined ? { $lte: query.maxSize } : {}),
        };
    }

    if (query.createdAfter || query.createdBefore) {
        filter.createdAt = {
            ...(query.createdAfter ? { $gte: query.createdAfter } : {}),
            ...(query.createdBefore ? { $lte: query.createdBefore } : {}),
        };
    }

    /**
     * `usage` is answered from `orphanedAt`, not from a count.
     *
     * That field is maintained by jovi-mall's file-reference layer — set to an instant when
     * the last live reference is removed, cleared to `null` when one is added — so it is a
     * denormalised, indexed answer to a question that would otherwise need an aggregation
     * over the whole of `file_references` before paging.
     *
     * ⚠ **`unused` is `orphanedAt: { $ne: null }`, and `used` is NOT its exact complement.**
     * `used` matches `orphanedAt: null`, which includes a file that has never been attached
     * to anything — the field's own docstring says so: *"Null means the file is currently
     * referenced (or was never attached — fall back to createdAt)."* So a file uploaded a
     * minute ago and not yet used reports `usage: used` here and `referenceCount: 0` in the
     * row beside it. The count is the precise answer and the filter is the indexed one;
     * they are different questions and the count is the one to render.
     */
    if (query.usage === 'used') filter.orphanedAt = null;
    if (query.usage === 'unused') filter.orphanedAt = { $ne: null };

    return filter as Filter<StoredFileReadModel>;
}

// ─────────────────────────────────────────────────────────────────────────────
// file_references — "is this used, and by what"
// ─────────────────────────────────────────────────────────────────────────────

export interface FileReferenceReadModel extends Document {
    _id: ObjectId;
    fileId: ObjectId;
    entityType: string;
    entityId: ObjectId;
    field: string;
}

const FILE_REFERENCE_PROJECTION = {
    _id: 1,
    fileId: 1,
    entityType: 1,
    entityId: 1,
    field: 1,
} as const;

/**
 * How many references travel back per file, and where the number is stated.
 *
 * The dashboard asked for this explicitly and gave the case: *"a stock photo on 400
 * products must not put 400 rows in one file's cell. A `referenceCount` with a truncated
 * `references` array is the right answer; a page that quietly drops the rest is not."*
 *
 * So the count is TRUE and the array is capped, and the cap travels in `meta` — ADR-005
 * D-13 forbids a silent truncation, and a client that cannot see the cap has no way to tell
 * "three references" from "three of many".
 */
export const REFERENCE_SAMPLE_CAP = 5;

/**
 * How many file ids an `entityType`/`entityId` filter may contribute.
 *
 * A cap rather than an unbounded `$in`, the `STORE_SEARCH_CAP` precedent: a product with a
 * long media list turns into an `$in` the planner handles badly. Truncation is reported
 * rather than silent — same rule as the reference sample.
 */
export const ENTITY_FILTER_CAP = 500;

/** One file's usage, as the library row reports it. */
export interface FileUsage {
    /** Live rows only, and the TRUE total — never the length of `references`. */
    referenceCount: number;
    references: FileReferenceReadModel[];
}

export class FileReferenceReadRepository extends PlatformReadRepository<FileReferenceReadModel> {
    constructor() {
        super(COLLECTIONS.FILE_REFERENCE, FILE_REFERENCE_PROJECTION);
    }

    /**
     * Usage for a PAGE of files — one aggregation, never one query per row.
     *
     * ── Why the count and the sample come from one pipeline ───────────────────
     * Two round trips would let them disagree: a reference added between them produces a
     * `referenceCount` of 3 beside a four-row sample, which is the one shape a client
     * cannot render. `$group` computes both from the same scan.
     *
     * `$push` then `$slice` rather than `$firstN`: the latter needs MongoDB 5.2 and this
     * service is deliberately version-agnostic about the platform's deployment (the dev
     * stack has run 3.x within memory). `$push` materialises the group in memory, which is
     * bounded by real data — the rows are five small fields each, so even the 400-product
     * stock photo the dashboard worried about is a few tens of kilobytes.
     *
     * ⚠ **`deletedAt: null` is the whole of "live".** A reference is soft-deleted when it is
     * removed, so counting rows without it reports a file as used by every entity that ever
     * touched it — which would make the `unused` filter and the count contradict each other
     * on the same row.
     */
    async findUsageForFiles(fileIds: ObjectId[]): Promise<Map<string, FileUsage>> {
        if (fileIds.length === 0) return new Map();

        const rows = await this.aggregateBy<{
            _id: ObjectId;
            referenceCount: number;
            references: FileReferenceReadModel[];
        }>([
            { $match: { fileId: { $in: fileIds }, deletedAt: null } },
            {
                $group: {
                    _id: '$fileId',
                    referenceCount: { $sum: 1 },
                    references: {
                        $push: {
                            _id: '$_id',
                            fileId: '$fileId',
                            entityType: '$entityType',
                            entityId: '$entityId',
                            field: '$field',
                        },
                    },
                },
            },
            {
                $project: {
                    _id: 1,
                    referenceCount: 1,
                    references: { $slice: ['$references', REFERENCE_SAMPLE_CAP] },
                },
            },
        ]);

        return new Map(
            rows.map((row) => [
                row._id.toString(),
                { referenceCount: row.referenceCount, references: row.references },
            ]),
        );
    }

    /**
     * The files one entity uses — `?entityType=ticket&entityId=…`.
     *
     * Backed by the `{ entityType, entityId, deletedAt }` index the file-reference model
     * declares for exactly this question. Returns `{ ids, truncated }` rather than a bare
     * array so the caller can tell the dashboard the answer was capped (ADR-005 D-13).
     *
     * An entity nobody has attached anything to yields `[]`, which the library filter turns
     * into an empty page — the correct answer, and distinguishable from "no filter" only
     * because the caller passes `null` in that case.
     */
    async findFileIdsForEntity(
        entityType: string,
        entityId: string,
        cap = ENTITY_FILTER_CAP,
    ): Promise<{ ids: ObjectId[]; truncated: boolean }> {
        if (!Types.ObjectId.isValid(entityId)) return { ids: [], truncated: false };

        const rows = await this.findBy(
            {
                entityType,
                entityId: new ObjectId(entityId),
                deletedAt: null,
            } as Filter<FileReferenceReadModel>,
            { projection: { _id: 0, fileId: 1 }, limit: cap + 1 },
        );

        const truncated = rows.length > cap;
        return { ids: rows.slice(0, cap).map((row) => row.fileId), truncated };
    }
}
