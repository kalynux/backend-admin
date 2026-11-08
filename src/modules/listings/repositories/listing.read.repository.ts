import { Document, Filter, ObjectId } from 'mongodb';
import { matchAnyField, toMongoSort } from '../../../core/data/mongo-list';
import { ListQueryBase } from '../../../core/http/list-query';
import { COLLECTIONS } from '../../../infra/platform/collections';
import { Paginated, PlatformReadRepository } from '../../../infra/platform/platform.repository';
import { LISTING_SORT } from '../validators/listing.validator';

/**
 * Informational service listings, read directly (ADR-004 D-2: direct read, delegated write).
 *
 * jovi-mall owns the collection and every write: an approval copies the pending content AND
 * the pending contacts to their published copies in one transaction, re-indexes, and may
 * publish straight into `suspended` when the provider's wallet is short (§ C-8a). A second
 * writer would flip `status` and leave every one of those undone.
 *
 * ── Privacy is decided by WHERE the data is stored ───────────────────────────
 * `listings` holds public fields only; the WhatsApp number, phone, email, links, pin and video
 * live in `listing_contacts`, which this repository does not touch. The projections below are
 * a whitelist even so — every content field named by its dotted path, never `published: 1` —
 * so a contact-shaped field added to the content upstream next year stops here instead of
 * arriving on the review queue. `test:listings` scans every projection in this module for
 * contact-field names.
 *
 * No `deletedAt` pin: a listing is never soft-deleted. `archived` is a status, and an archived
 * listing is exactly what a reviewer looking up a provider's history needs to see.
 */

export interface ListingContentReadModel {
    title?: string;
    company_name?: string;
    category_ids?: ObjectId[];
    country?: string;
    city?: string;
    area?: string;
    description?: string;
    description_rich?: unknown;
    photo_file_ids?: ObjectId[];
    opening_hours?: Array<{ day?: string; open_time?: string; close_time?: string; is_closed?: boolean }> | null;
}

export interface ListingReadModel extends Document {
    _id: ObjectId;
    vendor_id: ObjectId;
    slug: string;
    status: string;
    suspension?: {
        reason?: string;
        previous_status?: string;
        at?: Date;
        note?: string | null;
        by_user_id?: ObjectId | null;
        by_source?: 'platform' | 'admin';
        by_name?: string | null;
    } | null;
    published?: ListingContentReadModel | null;
    pending?: ListingContentReadModel | null;
    review?: {
        state?: string;
        submitted_at?: Date | null;
        decided_at?: Date | null;
        decided_by_user_id?: ObjectId | null;
        decided_by_source?: 'platform' | 'admin';
        decided_by_name?: string | null;
        reasons?: string[];
        preflags?: Array<{ kind?: string; field?: string; excerpt?: string }>;
        index_fee_ref?: string | null;
    } | null;
    last_decision?: {
        decision?: string;
        at?: Date;
        by_user_id?: ObjectId | null;
        by_source?: 'platform' | 'admin';
        by_name?: string | null;
        reasons?: string[];
    } | null;
    available_fields?: string[];
    published_at?: Date | null;
    archived_at?: Date | null;
    vectorisation_status?: string;
    created_at: Date;
    updated_at: Date;
}

/** The content fields, by dotted path, for one copy (`published` or `pending`). */
function contentPaths(copy: 'published' | 'pending'): Record<string, 1> {
    return {
        [`${copy}.title`]: 1,
        [`${copy}.company_name`]: 1,
        [`${copy}.category_ids`]: 1,
        [`${copy}.country`]: 1,
        [`${copy}.city`]: 1,
        [`${copy}.area`]: 1,
        [`${copy}.description`]: 1,
        [`${copy}.description_rich`]: 1,
        [`${copy}.photo_file_ids`]: 1,
        [`${copy}.opening_hours`]: 1,
    };
}

/**
 * The queue row: what a reviewer scans a page of. Title, company and city of both copies (the
 * row shows whichever is under review), the review state and submission instant, the KINDS of
 * pre-flags (to count them — the excerpt is the detail screen's), the suspension reason.
 */
export const LISTING_LIST_PROJECTION = {
    _id: 1,
    vendor_id: 1,
    slug: 1,
    status: 1,
    'published.title': 1,
    'published.company_name': 1,
    'published.city': 1,
    'pending.title': 1,
    'pending.company_name': 1,
    'pending.city': 1,
    'review.state': 1,
    'review.submitted_at': 1,
    'review.preflags.kind': 1,
    'suspension.reason': 1,
    published_at: 1,
    created_at: 1,
    updated_at: 1,
} as const;

/** The detail: both content copies whole (by path), the review, the decision, the suspension. */
export const LISTING_DETAIL_PROJECTION = {
    _id: 1,
    vendor_id: 1,
    slug: 1,
    status: 1,
    ...contentPaths('published'),
    ...contentPaths('pending'),
    'suspension.reason': 1,
    'suspension.previous_status': 1,
    'suspension.at': 1,
    'suspension.note': 1,
    'suspension.by_user_id': 1,
    'suspension.by_source': 1,
    'suspension.by_name': 1,
    'review.state': 1,
    'review.submitted_at': 1,
    'review.decided_at': 1,
    'review.decided_by_user_id': 1,
    'review.decided_by_source': 1,
    'review.decided_by_name': 1,
    'review.reasons': 1,
    'review.preflags': 1,
    'review.index_fee_ref': 1,
    'last_decision.decision': 1,
    'last_decision.at': 1,
    'last_decision.by_user_id': 1,
    'last_decision.by_source': 1,
    'last_decision.by_name': 1,
    'last_decision.reasons': 1,
    available_fields: 1,
    published_at: 1,
    archived_at: 1,
    vectorisation_status: 1,
    created_at: 1,
    updated_at: 1,
} as const;

export interface ListingSearchQuery extends ListQueryBase {
    reviewState?: string;
    status?: string;
    vendorId?: string;
    search?: string;
    /** Half-open `[from, to)` over `review.submitted_at`. */
    from?: Date;
    to?: Date;
}

/** The fields the free-text term is matched against — public names only, both copies. */
export const LISTING_SEARCH_FIELDS = [
    'published.title',
    'published.company_name',
    'pending.title',
    'pending.company_name',
] as const;

/**
 * Pure, and exported for `test:listings`. Every term goes through `matchAnyField`, which
 * escapes it — no `RegExp` is built from a raw string here.
 */
export function buildListingFilter(query: Omit<ListingSearchQuery, 'page' | 'limit' | 'sort'>): Filter<ListingReadModel> {
    const clauses: Record<string, unknown>[] = [];
    if (query.reviewState) clauses.push({ 'review.state': query.reviewState });
    if (query.status) clauses.push({ status: query.status });
    if (query.vendorId) clauses.push({ vendor_id: new ObjectId(query.vendorId) });
    if (query.from || query.to) {
        const range: Record<string, Date> = {};
        if (query.from) range.$gte = query.from;
        if (query.to) range.$lt = query.to;
        clauses.push({ 'review.submitted_at': range });
    }
    const search = query.search?.trim();
    if (search) clauses.push(matchAnyField(LISTING_SEARCH_FIELDS, search));
    return (clauses.length > 0 ? { $and: clauses } : {}) as Filter<ListingReadModel>;
}

export class ListingReadRepository extends PlatformReadRepository<ListingReadModel> {
    constructor() {
        super(COLLECTIONS.LISTING, LISTING_LIST_PROJECTION);
    }

    async search(query: ListingSearchQuery): Promise<Paginated<ListingReadModel>> {
        return this.findPage(buildListingFilter(query), {
            page: query.page,
            limit: query.limit,
            sort: toMongoSort(query.sort, LISTING_SORT),
        });
    }

    /** The detail view — the wider projection, one document. */
    async findDetailById(listingId: string): Promise<ListingReadModel | null> {
        if (!ObjectId.isValid(listingId)) return null;
        const rows = await this.findBy(
            { _id: new ObjectId(listingId) } as Filter<ListingReadModel>,
            { projection: LISTING_DETAIL_PROJECTION, limit: 1 },
        );
        return rows[0] ?? null;
    }

    /**
     * A page of listings' titles in one query, for the reviews screens (2026-11-08). The published
     * title, else the pending one (a listing never published has no review anyway). Reads
     * `listings` only — never `listing_contacts`.
     */
    async findTitlesByIds(ids: ObjectId[]): Promise<Map<string, string | null>> {
        if (ids.length === 0) return new Map();
        const rows = await this.findBy({ _id: { $in: ids } } as Filter<ListingReadModel>, {
            projection: { _id: 1, 'published.title': 1, 'pending.title': 1 },
            limit: ids.length,
        });
        return new Map(rows.map((row) => [row._id.toString(), row.published?.title ?? row.pending?.title ?? null]));
    }
}
