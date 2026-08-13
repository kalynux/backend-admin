import { Document, Filter, FindOptions, ObjectId } from 'mongodb';
import { PlatformReadRepository } from '../../../infra/platform/platform.repository';
import { PlatformCollection } from '../../../infra/platform/platform-collections';

/** Where a source's sweep left off. `null` on a source that has never run. */
export interface SourceCursor {
    at: Date;
    id: string;
}

/**
 * A watermarked reader over one `jovi_mall` collection.
 *
 * ── Why this goes through `PlatformReadRepository` ────────────────────────────
 * The projector could reach `platformConnection().db.collection(name)` directly and save a
 * file. It must not. That base class is the mechanism ADR-004 D-2 relies on to make the
 * read-only rule STRUCTURAL rather than remembered: the collection name is typed against
 * `PlatformCollection` so a source cannot be pointed at something nobody decided this
 * service may touch, the projection is a required constructor argument so no source can
 * accidentally drag a credential out of the database, and the class exposes no write
 * method at all — a background loop that runs unattended is the last place to give up any
 * of the three.
 *
 * ── The cursor clause, and why it is `$and` ───────────────────────────────────
 * A source's own filter can already contain a top-level `$or` — the disputed-orders clause
 * is exactly that shape, `{ $or: [dispute_hold.active, payment_status] }`. Merging the
 * cursor into it with a spread or `Object.assign` would silently replace that `$or` with
 * this one, and the result is a query that looks right, returns rows, and answers a
 * different question than the one asked. The orders repository writes the same warning
 * over its own `buildFilter`; composing under `$and` is what makes the mistake impossible
 * rather than unlikely.
 */
export class NotificationSourceReadRepository extends PlatformReadRepository<Document> {
    public constructor(collection: PlatformCollection, projection: Document) {
        super(collection, projection);
    }

    /**
     * Actionable rows strictly after the cursor, oldest first, at most `limit`.
     *
     * Ascending is not a preference: the sweep advances its watermark to the last row it
     * saw, so it has to consume a backlog in the order the backlog happened. Sorting the
     * other way would advance the watermark to the newest row on the first tick and skip
     * everything behind it permanently.
     */
    public async findSince(
        filter: Filter<Document>,
        watermarkField: string,
        cursor: SourceCursor | null,
        limit: number,
    ): Promise<Document[]> {
        const options: FindOptions = { sort: { [watermarkField]: 1, _id: 1 }, limit };
        return this.findBy(withCursor(filter, watermarkField, cursor), options);
    }
}

/**
 * Compose a source filter with its cursor.
 *
 * Exported and pure so the DB-free suite can assert the `$and` composition directly — the
 * failure this guards against produces no error, only wrong rows, so it has to be checked
 * by reading the query rather than by running it.
 */
export function withCursor(
    filter: Filter<Document>,
    watermarkField: string,
    cursor: SourceCursor | null,
): Filter<Document> {
    if (!cursor) return filter;

    // `(at, _id) > (cursor.at, cursor.id)` as a lexicographic pair. The second branch is
    // what keeps a busy millisecond from either stalling the sweep or skipping rows — see
    // `notification-watermark.model.ts`.
    const afterCursor = {
        $or: [
            { [watermarkField]: { $gt: cursor.at } },
            { [watermarkField]: cursor.at, _id: { $gt: toComparableId(cursor.id) } },
        ],
    } as unknown as Filter<Document>;

    return { $and: [filter, afterCursor] };
}

/**
 * Turn a stored cursor id back into something Mongo can compare against a real `_id`.
 *
 * ── Why this is not just `cursor.id` ──────────────────────────────────────────
 * The watermark stores `last_seen_id` as a string, because a source's `_id` need not be an
 * ObjectId. But `$gt` in MongoDB compares ACROSS BSON types by type order before value:
 * String sorts below ObjectId in the canonical ordering. So `_id: { $gt: "65f0…" }` against
 * a collection of ObjectId `_id`s matches **every row**, not the ones after the cursor.
 *
 * The symptom would have been quiet rather than loud. Idempotency absorbs the extra rows —
 * they upsert onto keys that already exist and nobody is notified twice — so the only
 * visible effect is a sweep that re-reads a whole millisecond's worth of rows on every
 * tick forever, which looks exactly like a healthy sweep with a slightly high read count.
 *
 * Parsing it back is what makes the tiebreaker do the job `notification-watermark.model.ts`
 * says it does. A non-ObjectId id falls through to the raw string, where the comparison is
 * string-to-string and correct on its own terms.
 */
export function toComparableId(id: string): ObjectId | string {
    return ObjectId.isValid(id) && new ObjectId(id).toHexString() === id ? new ObjectId(id) : id;
}
