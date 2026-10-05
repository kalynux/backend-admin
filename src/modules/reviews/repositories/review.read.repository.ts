import { Document, Filter, ObjectId } from 'mongodb';
import { containsInsensitive, toMongoSort } from '../../../core/data/mongo-list';
import { ListQueryBase } from '../../../core/http/list-query';
import { COLLECTIONS } from '../../../infra/platform/collections';
import { Paginated, PlatformReadRepository } from '../../../infra/platform/platform.repository';
import { REVIEW_SORT } from '../validators/review.validator';

/**
 * Product and delivery reviews, read directly (ADR-004 D-2: direct read, delegated write).
 *
 * jovi-mall owns the collection and every write — an unpublish, a republish or a delete
 * recomputes the rating aggregates and nudges an agent's trust score, which a second writer
 * would leave unfired. What this side needs is only to SEE the reviews.
 *
 * ⚠ **`deletedAt: null` is pinned in `buildReviewFilter`.** A deleted review is soft-deleted
 * there, and the raw driver applies nothing automatically — without the pin a review an
 * administrator deleted would reappear on the very list they deleted it from.
 */
export interface ReviewReadModel extends Document {
    _id: ObjectId;
    subject_type: 'product' | 'delivery';
    subject_id: ObjectId;
    author_user_id: ObjectId;
    author_role: 'customer' | 'vendor' | 'agency';
    rating: number;
    title?: string | null;
    body?: string | null;
    status: string;
    published_at?: Date | null;
    moderation?: {
        action?: string;
        by_user_id?: ObjectId | null;
        by_source?: 'platform' | 'admin';
        at?: Date;
        reason?: string | null;
    } | null;
    order_id?: ObjectId | null;
    shipment_id?: ObjectId | null;
    target_product_id?: ObjectId | null;
    target_agent_id?: ObjectId | null;
    target_agency_id?: ObjectId | null;
    target_vendor_id?: ObjectId | null;
    createdAt: Date;
    updatedAt: Date;
}

/** The whitelist. A review carries nothing credential-shaped, but a new field still waits to be named. */
const REVIEW_PROJECTION = {
    _id: 1,
    subject_type: 1,
    subject_id: 1,
    author_user_id: 1,
    author_role: 1,
    rating: 1,
    title: 1,
    body: 1,
    status: 1,
    published_at: 1,
    moderation: 1,
    order_id: 1,
    shipment_id: 1,
    target_product_id: 1,
    target_agent_id: 1,
    target_agency_id: 1,
    target_vendor_id: 1,
    createdAt: 1,
    updatedAt: 1,
};

export interface ReviewSearchQuery extends ListQueryBase {
    status?: string;
    subjectType?: string;
    authorRole?: string;
    rating?: number;
    hasText?: boolean;
    search?: string;
    productId?: string;
    vendorId?: string;
    agentId?: string;
    agencyId?: string;
}

/** A field that holds non-blank text. `$type: 'string'` alone would admit `''`. */
const nonBlank = (field: string) => ({ [field]: { $type: 'string', $regex: /\S/ } });

export function buildReviewFilter(query: Omit<ReviewSearchQuery, 'page' | 'limit' | 'sort'>): Filter<ReviewReadModel> {
    const clauses: Record<string, unknown>[] = [{ deletedAt: null }];
    if (query.status) clauses.push({ status: query.status });
    if (query.subjectType) clauses.push({ subject_type: query.subjectType });
    if (query.authorRole) clauses.push({ author_role: query.authorRole });
    if (query.rating) clauses.push({ rating: query.rating });
    if (query.productId) clauses.push({ target_product_id: new ObjectId(query.productId) });
    if (query.vendorId) clauses.push({ target_vendor_id: new ObjectId(query.vendorId) });
    if (query.agentId) clauses.push({ target_agent_id: new ObjectId(query.agentId) });
    if (query.agencyId) clauses.push({ target_agency_id: new ObjectId(query.agencyId) });
    if (query.hasText === true) clauses.push({ $or: [nonBlank('title'), nonBlank('body')] });
    if (query.hasText === false) {
        clauses.push({ $nor: [nonBlank('title'), nonBlank('body')] });
    }
    const search = query.search?.trim();
    if (search) {
        const pattern = containsInsensitive(search);
        clauses.push({ $or: [{ title: pattern }, { body: pattern }] });
    }
    return { $and: clauses } as Filter<ReviewReadModel>;
}

export class ReviewReadRepository extends PlatformReadRepository<ReviewReadModel> {
    constructor() {
        super(COLLECTIONS.REVIEW, REVIEW_PROJECTION);
    }

    async search(query: ReviewSearchQuery): Promise<Paginated<ReviewReadModel>> {
        return this.findPage(buildReviewFilter(query), {
            page: query.page,
            limit: query.limit,
            sort: toMongoSort(query.sort, REVIEW_SORT),
        });
    }

    /** A live review, or null — a deleted one 404s, exactly as jovi-mall's own read does. */
    async findById(id: string): Promise<ReviewReadModel | null> {
        if (!ObjectId.isValid(id)) return null;
        return this.findOneBy({ _id: new ObjectId(id), deletedAt: null } as Filter<ReviewReadModel>);
    }
}
