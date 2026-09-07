import { FileDetail, toFileDetail } from '../../../infra/storage/file-detail';
import { FileUsage, StoredFileReadModel } from '../repositories/file-library.read.repository';

/**
 * A media-library row — the wire shape of `GET /api/v1/files/library` (BR-015).
 *
 * ── It is a `FileDetail`, plus three things a picker cannot work without ────────────────
 * The dashboard already holds the `FileDetail` type and every other file route on this
 * service answers with it, so the library extends rather than replaces it: a component that
 * renders a resolved file renders a library row unchanged, and the three additions are
 * additive fields it can ignore.
 *
 *   `createdAt`  the only sort key an operator actually reaches for
 *   `owner`      the ask names it explicitly — *"the owner (name and role)"*
 *   `usage`      *"whether the file is used or linked to an entity"*
 *
 * ── ⚠ `url` is built HERE, not by jovi-mall (decision L-3) ──────────────────────────────
 * Every other `FileDetail` on this service arrives over the wire from `POST /files/resolve`.
 * This one is constructed locally by `toFileDetail` from the row's storage key, which is
 * the first thing on this service to hold storage configuration and is what reverses
 * ADR-009 D-6. See `infra/storage/public-url.ts` for the containment and
 * `docs/ADR-021-ADMIN-MEDIA-LIBRARY.md` for the amendment.
 *
 * The practical consequence for a client: `url` is `null` for three distinct reasons here
 * rather than two — a private tree, a `STORAGE_PROVIDER` this service cannot reproduce, and
 * an unconfigured one. `meta.publicUrlsConfigured` separates the last two from the first,
 * so a page of `null`s is distinguishable from "not set up here".
 */
export interface LibraryFile extends FileDetail {
    /** ISO-8601. The upload instant, and the default sort. */
    createdAt: string;
    owner: LibraryFileOwner;
    usage: LibraryFileUsage;
}

/**
 * Who uploaded it.
 *
 * ⚠ **`type` is deliberately a plain `string`**, not the six-value union. The dashboard
 * asked for it to stay open — *"we will render an unrecognised value rather than reject
 * it"* — and it is right to: the value is jovi-mall's `FileOwnerType`, which lives in a
 * repository this one does not import, and a union here would turn a value added there into
 * a compile error on a screen that only needs to print it. `null` for a legacy row that
 * carries no owner at all.
 */
export interface LibraryFileOwner {
    type: string | null;
    /**
     * The owner's id in ITS OWN space — a `vendors._id`, a `delivery_agents._id`, and for
     * `admin` a **`wi_admin.admin_accounts._id`**. Not a `users._id` in any case.
     */
    id: string | null;
    /**
     * The resolved display name, or `null`.
     *
     * **`null`, never `''` and never the id substituted silently** (ADR-005). Four things
     * produce it and a client cannot tell them apart, deliberately, because it renders all
     * four the same way: `ownerType: 'system'` (which has no name by construction), a role
     * record that has been deleted, an owner mid-onboarding with no business name yet, and
     * an `admin` whose account was removed from this service.
     */
    name: string | null;
}

/** What refers to this file, and how much of it fitted. */
export interface LibraryFileUsage {
    /**
     * Live references only, and the **true** total — never `references.length`.
     *
     * `0` is what the Media menu shows as "not attached". ⚠ It does not have to agree with
     * the `usage=used|unused` filter: that filter reads `orphanedAt`, which is `null` both
     * for a referenced file and for one never attached to anything. This number is the
     * precise answer; see `buildLibraryFilter`.
     */
    referenceCount: number;
    /** At most `meta.referenceSampleCap` of them. The cap is in `meta` for that reason. */
    references: LibraryFileReference[];
}

export interface LibraryFileReference {
    /** One of jovi-mall's twelve `FileReferenceEntityType` values. Open, like `owner.type`. */
    entityType: string;
    entityId: string;
    /** Which slot on the entity holds it — `media`, `attachments`, `digitalAsset`, … */
    field: string;
    /**
     * A human handle for the entity, or `null`.
     *
     * ⚠ **It is `null` on every row today, and that is the built answer rather than a
     * placeholder.** The dashboard said so explicitly and asked for exactly this: *"`null`
     * is fine and expected — we render the id. Do not add a lookup per entity type if it is
     * expensive; the count and the type already carry most of the value."*
     *
     * Filling it would mean a read of a different collection per `entityType` present on the
     * page — twelve possible ones, each with its own projection and its own permission
     * question, to produce a caption. The field exists so the shape does not have to change
     * on the day one of those is worth paying for.
     */
    label: string | null;
}

/**
 * A raw `files` row → a library row. **Every field named; never a spread of the row.**
 *
 * The projection is the first lock and this is the second, for the reason every mapper on
 * this service is written this way: a spread publishes whatever the upstream collection
 * gains next. `files` gained `orphanedAt` most recently, and `purgeAt` after it.
 *
 * `orphanedAt` in particular is **read and not published** — it decides the `usage` filter
 * and it is an internal housekeeping timestamp that says when a sweep may reclaim the file.
 * The count beside it is the fact an operator can act on.
 *
 * Exported and pure so `test:files` can assert the projection directly: build a row
 * carrying every field jovi-mall's `File` entity has, serialise the result, and assert what
 * must be absent. A projection asserted by source scan proves the code SAYS the right thing
 * rather than that it DOES it.
 *
 * ⚠ The one spread below is `...detail`, and it is not the exception it looks like: that
 * value is a `FileDetail` built field by field by `toFileDetail` two lines above, from a
 * type declared in this repository. Nothing from the database reaches it un-named.
 */
export function toLibraryFile(
    row: StoredFileReadModel,
    ownerName: string | null,
    usage: FileUsage | undefined,
): LibraryFile {
    const detail = toFileDetail({
        id: row._id.toString(),
        key: row.key,
        mimeType: row.mimeType,
        size: row.size,
        originalName: row.originalName ?? null,
        quotaBlockedAt: row.quotaBlockedAt ?? null,
    });

    return {
        ...detail,
        createdAt: row.createdAt.toISOString(),
        owner: {
            type: row.ownerType ?? null,
            id: row.ownerId ? row.ownerId.toString() : null,
            name: ownerName,
        },
        usage: {
            referenceCount: usage?.referenceCount ?? 0,
            references: (usage?.references ?? []).map((reference) => ({
                entityType: reference.entityType,
                entityId: reference.entityId.toString(),
                field: reference.field,
                label: null,
            })),
        },
    };
}
