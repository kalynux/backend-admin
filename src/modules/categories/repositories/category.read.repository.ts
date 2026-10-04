import { Document, Filter, ObjectId } from 'mongodb';
import { containsInsensitive, toMongoSort } from '../../../core/data/mongo-list';
import { ListQueryBase } from '../../../core/http/list-query';
import { COLLECTIONS } from '../../../infra/platform/collections';
import { Paginated, PlatformReadRepository } from '../../../infra/platform/platform.repository';
import { CATEGORY_SORT } from '../validators/category.validator';

/**
 * The shared product-category list, read directly (ADR-004 D-2: direct read, delegated write).
 *
 * jovi-mall owns the collection, the duplicate check and every write — a merge rewrites
 * products and records aliases inside one of its transactions, which no second writer could
 * reproduce. What this side needs is only to SEE the list and how much each entry is used.
 *
 * ⚠ **`deletedAt: null` is pinned in `buildCategoryFilter`.** A merged-away or deleted
 * category is soft-deleted, and the raw driver applies nothing automatically.
 */
export interface CategoryReadModel extends Document {
    _id: ObjectId;
    name: string;
    slug: string;
    match_key: string;
    alias_keys?: string[];
    created_source?: string;
    created_by_vendor_id?: ObjectId | null;
    createdAt: Date;
    updatedAt: Date;
}

const CATEGORY_PROJECTION = {
    _id: 1,
    name: 1,
    slug: 1,
    match_key: 1,
    alias_keys: 1,
    created_source: 1,
    created_by_vendor_id: 1,
    createdAt: 1,
    updatedAt: 1,
};

export interface CategorySearchQuery extends ListQueryBase {
    search?: string;
    createdSource?: string;
}

export function buildCategoryFilter(query: Pick<CategorySearchQuery, 'search' | 'createdSource'>): Filter<CategoryReadModel> {
    const clauses: Record<string, unknown>[] = [{ deletedAt: null }];
    if (query.createdSource) clauses.push({ created_source: query.createdSource });
    const search = query.search?.trim();
    if (search) {
        const pattern = containsInsensitive(search);
        clauses.push({ $or: [{ name: pattern }, { slug: pattern }] });
    }
    return { $and: clauses } as Filter<CategoryReadModel>;
}

export class CategoryReadRepository extends PlatformReadRepository<CategoryReadModel> {
    constructor() {
        super(COLLECTIONS.PRODUCT_CATEGORY, CATEGORY_PROJECTION);
    }

    async search(query: CategorySearchQuery): Promise<Paginated<CategoryReadModel>> {
        return this.findPage(buildCategoryFilter(query), {
            page: query.page,
            limit: query.limit,
            sort: toMongoSort(query.sort, CATEGORY_SORT),
        });
    }

    async findById(id: string): Promise<CategoryReadModel | null> {
        if (!ObjectId.isValid(id)) return null;
        return this.findOneBy({ _id: new ObjectId(id), deletedAt: null } as Filter<CategoryReadModel>);
    }

    /** Batch name lookup for product DTOs — ids in, `{ id, name, slug }` out, live rows only. */
    async findRefsByIds(ids: ObjectId[]): Promise<Map<string, { id: string; name: string; slug: string }>> {
        if (ids.length === 0) return new Map();
        const rows = await this.findBy({ _id: { $in: ids }, deletedAt: null } as Filter<CategoryReadModel>);
        return new Map(rows.map((r) => [r._id.toString(), { id: r._id.toString(), name: r.name, slug: r.slug }]));
    }
}

/**
 * How many products hold each category — one aggregation per page, never a count per row.
 *
 * Over `products`, not `product_categories`, so it lives in its own repository bound to
 * that collection. Two numbers, because they answer two different questions: `live` is
 * what a merge will move and what blocks a delete (jovi-mall refuses `CATEGORY_IN_USE`
 * while it is above zero); `active` is what shoppers see on the storefront.
 */
export class CategoryUsageReadRepository extends PlatformReadRepository<Document> {
    constructor() {
        super(COLLECTIONS.PRODUCT, { _id: 1 });
    }

    async countsFor(categoryIds: ObjectId[]): Promise<Map<string, { live: number; active: number }>> {
        if (categoryIds.length === 0) return new Map();
        const rows = await this.aggregateBy<{ _id: ObjectId; live: number; active: number }>([
            { $match: { categoryIds: { $in: categoryIds }, deletedAt: null } },
            { $unwind: '$categoryIds' },
            { $match: { categoryIds: { $in: categoryIds } } },
            {
                $group: {
                    _id: '$categoryIds',
                    live: { $sum: 1 },
                    active: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } },
                },
            },
        ]);
        return new Map(rows.map((r) => [r._id.toString(), { live: r.live, active: r.active }]));
    }
}
