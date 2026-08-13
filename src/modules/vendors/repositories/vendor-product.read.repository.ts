import { Document, Filter, ObjectId } from 'mongodb';
import { Types } from 'mongoose';
import { containsInsensitive, toMongoSort } from '../../../core/data/mongo-list';
import { ListQueryBase } from '../../../core/http/list-query';
import { COLLECTIONS } from '../../../infra/platform/collections';
import { Paginated, PlatformReadRepository } from '../../../infra/platform/platform.repository';
import { VENDOR_PRODUCT_SORT } from '../validators/vendor.validator';

/**
 * A vendor's catalogue, as platform oversight sees it.
 *
 * ── The one rule this file exists to make unforgettable ───────────────────────
 * **`deletedAt: null` is pinned in `buildProductFilter`, unconditionally.** jovi-mall's
 * `BaseRepository` applies it automatically to every query the platform makes; this
 * service reads with the raw driver, where nothing does. A soft-deleted product surfacing
 * on an administrative screen is not merely noise — it is a listing an operator might
 * suspend, reinstate, or count.
 *
 * Pinning it in the filter builder rather than at each call site is the difference between
 * a rule and a habit: a method added here later inherits it by construction.
 */

export interface VendorProductReadModel extends Document {
    _id: ObjectId;
    vendorId: ObjectId;
    title?: string;
    slug?: string;
    category?: string;
    type?: string;
    status: string;
    /** Absent on documents written before the field existed — readers coerce to 'advanced'. */
    mode?: string;
    hasVariants?: boolean;
    suspension?: {
        reason?: string;
        previousStatus?: string;
        suspendedAt?: Date;
        suspendedByAgencyId?: ObjectId | null;
        note?: string | null;
    } | null;
    delivery?: { agency_id?: ObjectId | null };
    lastOrderedAt?: Date | null;
    createdAt: Date;
    updatedAt: Date;
}

const PRODUCT_PROJECTION = {
    _id: 1,
    vendorId: 1,
    title: 1,
    slug: 1,
    category: 1,
    type: 1,
    status: 1,
    mode: 1,
    hasVariants: 1,
    'suspension.reason': 1,
    'suspension.previousStatus': 1,
    'suspension.suspendedAt': 1,
    'suspension.suspendedByAgencyId': 1,
    'suspension.note': 1,
    'delivery.agency_id': 1,
    lastOrderedAt: 1,
    createdAt: 1,
    updatedAt: 1,
} as const;

export interface VendorProductSearchQuery extends ListQueryBase {
    search?: string;
    status?: string;
    type?: string;
    mode?: string;
    suspensionReason?: string;
}

/** One bucket of the status breakdown on the detail screen. */
export interface ProductStatusCounts {
    total: number;
    draft: number;
    active: number;
    archived: number;
    pendingReview: number;
    suspended: number;
}

export class VendorProductReadRepository extends PlatformReadRepository<VendorProductReadModel> {
    constructor() {
        super(COLLECTIONS.PRODUCT, PRODUCT_PROJECTION);
    }

    async search(
        vendorId: string,
        query: VendorProductSearchQuery,
    ): Promise<Paginated<VendorProductReadModel>> {
        return this.findPage(buildProductFilter(vendorId, query), {
            page: query.page,
            limit: query.limit,
            sort: toMongoSort(query.sort, VENDOR_PRODUCT_SORT),
        });
    }

    /**
     * The status breakdown, in ONE round trip.
     *
     * A `$group` rather than five `countBy` calls: five counts are five index scans over
     * the same range to answer one question, and they can disagree with each other if a
     * product moves between them.
     */
    async countByStatus(vendorId: string): Promise<ProductStatusCounts> {
        const empty: ProductStatusCounts = {
            total: 0, draft: 0, active: 0, archived: 0, pendingReview: 0, suspended: 0,
        };

        if (!Types.ObjectId.isValid(vendorId)) return empty;

        const rows = await this.aggregateBy<{ _id: string; n: number }>([
            { $match: { vendorId: new ObjectId(vendorId), deletedAt: null } },
            { $group: { _id: '$status', n: { $sum: 1 } } },
        ]);

        // Named mapping, not a dynamic key assignment: an unrecognised status from a
        // future jovi-mall release lands in `total` and nowhere else, rather than adding a
        // key nobody's DTO declares.
        return rows.reduce<ProductStatusCounts>((counts, row) => {
            counts.total += row.n;
            if (row._id === 'draft') counts.draft = row.n;
            else if (row._id === 'active') counts.active = row.n;
            else if (row._id === 'archived') counts.archived = row.n;
            else if (row._id === 'pending_review') counts.pendingReview = row.n;
            else if (row._id === 'suspended') counts.suspended = row.n;
            return counts;
        }, { ...empty });
    }
}

/**
 * The product filter. Exported for `test-vendors.ts`.
 *
 * `vendorId` and `deletedAt: null` are pinned first and cannot be overridden by any input
 * — see the file header for why that matters more here than in a jovi-mall repository.
 */
export function buildProductFilter(
    vendorId: string,
    query: VendorProductSearchQuery,
): Filter<VendorProductReadModel> {
    const clauses: Record<string, unknown>[] = [
        { vendorId: new ObjectId(vendorId) },
        { deletedAt: null },
    ];

    if (query.status) clauses.push({ status: query.status });
    if (query.type) clauses.push({ type: query.type });
    if (query.suspensionReason) clauses.push({ 'suspension.reason': query.suspensionReason });

    if (query.mode) {
        // Documents predating the `mode` field carry no key at all, and jovi-mall's readers
        // coerce a missing one to `'advanced'`. Filtering for `advanced` must therefore
        // match the absent case too, or the filter silently hides every older product.
        clauses.push(
            query.mode === 'advanced'
                ? { $or: [{ mode: 'advanced' }, { mode: { $exists: false } }] }
                : { mode: query.mode },
        );
    }

    const search = query.search?.trim();
    if (search) {
        const pattern = containsInsensitive(search);
        clauses.push({ $or: [{ title: pattern }, { slug: pattern }] });
    }

    // Always `$and`: there are two `$or`-shaped clauses in play (the mode fallback and the
    // search), and merging by assignment would drop one.
    return { $and: clauses } as Filter<VendorProductReadModel>;
}
