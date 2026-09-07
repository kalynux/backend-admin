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
    /** Matched against the **resolved** agency — see `resolveDeliveryAgencyId`. */
    deliveryAgencyId?: string;
}

/**
 * Which agency actually answers for a listing: its own override, else the vendor's default.
 *
 * ── The single definition of that precedence, in this service ─────────────────
 * It is jovi-mall's `resolveEffectiveAgencyId`, restated here because this service reads
 * the documents directly and holds no domain entity. Three call sites now depend on it —
 * the `deliveryAgency` block on a catalogue row, the `deliveryAgencyId` filter below, and
 * `productCount` on a vendor's agency-connection row (BR-018) — and a second definition
 * would show as the catalogue page and the connections panel disagreeing about the same
 * forty-two products.
 *
 * Expressed over the raw override rather than over a product document so that the
 * `$group` in `countByResolvedAgency` can apply the identical rule to a grouped `_id`
 * without fabricating a product to pass in.
 */
export function resolveDeliveryAgencyId(
    overrideAgencyId: ObjectId | null | undefined,
    vendorDefaultAgencyId: string | null,
): string | null {
    return overrideAgencyId?.toString() ?? vendorDefaultAgencyId;
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
        vendorDefaultAgencyId: string | null = null,
    ): Promise<Paginated<VendorProductReadModel>> {
        return this.findPage(buildProductFilter(vendorId, query, vendorDefaultAgencyId), {
            page: query.page,
            limit: query.limit,
            sort: toMongoSort(query.sort, VENDOR_PRODUCT_SORT),
        });
    }

    /**
     * How many of this vendor's products each agency is responsible for — **one
     * aggregation for the whole page**, not one count per row.
     *
     * ── Why it is shaped this way (BR-018's open question) ────────────────────
     * The request asked whether the number is cheap, and offered to drop the column rather
     * than have a slow endpoint. The naive form genuinely is bad: a `countDocuments` per
     * connection row means a vendor with nine agencies pays nine scans of the same
     * catalogue to answer one question, and the nine can disagree with each other if a
     * product moves while they run. That is the argument `countByStatus` below already
     * makes about five counts, applied to a number that varies with the page.
     *
     * So the whole catalogue is grouped once. The `$match` is served by the `vendorId`
     * prefix of `{ vendorId, slug }`, the `$group` key comes off the fetched document, and
     * the cost is one bounded pass over ONE vendor's listings — the same plan, on the same
     * range, that `countByStatus` already runs on every `GET /vendors/:vendorId`. It costs
     * one query no matter how many connections the page shows.
     *
     * ── What resolution means here ────────────────────────────────────────────
     * `$group` on a missing path yields `_id: null`, which is exactly the set of products
     * carrying no override — and those resolve to the vendor's default. Folding that
     * bucket onto the default through `resolveDeliveryAgencyId` is what keeps this number
     * equal to what the catalogue page shows in `deliveryAgency`. When the vendor has no
     * default either, the bucket resolves to nothing and is counted nowhere: those
     * products have no responsible agency at all, which is a real state (and one that
     * blocks activation), not a row to invent.
     *
     * `deletedAt: null` is pinned for the reason the file header gives — a soft-deleted
     * listing must not be counted on an oversight screen.
     */
    async countByResolvedAgency(
        vendorId: string,
        vendorDefaultAgencyId: string | null,
    ): Promise<Map<string, number>> {
        const counts = new Map<string, number>();
        if (!Types.ObjectId.isValid(vendorId)) return counts;

        const rows = await this.aggregateBy<{ _id: ObjectId | null; n: number }>([
            { $match: { vendorId: new ObjectId(vendorId), deletedAt: null } },
            { $group: { _id: '$delivery.agency_id', n: { $sum: 1 } } },
        ]);

        for (const row of rows) {
            const resolved = resolveDeliveryAgencyId(row._id, vendorDefaultAgencyId);
            if (!resolved) continue;
            // `+=` rather than `set`: the null bucket and an explicit override naming the
            // default agency are two groups that resolve to the same agency.
            counts.set(resolved, (counts.get(resolved) ?? 0) + row.n);
        }

        return counts;
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
 *
 * `vendorDefaultAgencyId` is server-resolved context, not client input: it arrives from
 * the vendor document the controller has already loaded, and only `deliveryAgencyId` uses
 * it. Same shape as `buildFilter`'s pre-resolved store ids on the vendor directory.
 */
export function buildProductFilter(
    vendorId: string,
    query: VendorProductSearchQuery,
    vendorDefaultAgencyId: string | null = null,
): Filter<VendorProductReadModel> {
    const clauses: Record<string, unknown>[] = [
        { vendorId: new ObjectId(vendorId) },
        { deletedAt: null },
    ];

    if (query.status) clauses.push({ status: query.status });
    if (query.type) clauses.push({ type: query.type });
    if (query.suspensionReason) clauses.push({ 'suspension.reason': query.suspensionReason });

    if (query.deliveryAgencyId) {
        /**
         * ⚠ **The filter matches the RESOLVED agency, not the stored override**, or it
         * would disagree with the `deliveryAgency` column beside it on the same row.
         *
         * Most products carry no override at all, so the common case is the fallback: when
         * the requested agency IS the vendor's default, "products this agency answers for"
         * has to include every product with no `delivery.agency_id`. `{ x: null }` matches
         * both an explicit null and an absent key, which is exactly the set wanted.
         *
         * This is what makes `productCount` on `GET /vendors/:vendorId/agencies` clickable:
         * `meta.total` on this filtered page is the same number, computed the same way.
         */
        const requested = new ObjectId(query.deliveryAgencyId);
        clauses.push(
            query.deliveryAgencyId === vendorDefaultAgencyId
                ? { $or: [{ 'delivery.agency_id': requested }, { 'delivery.agency_id': null }] }
                : { 'delivery.agency_id': requested },
        );
    }

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

    // Always `$and`: there are THREE `$or`-shaped clauses in play (the mode fallback, the
    // search, and the resolved-agency filter), and merging by assignment would drop one.
    return { $and: clauses } as Filter<VendorProductReadModel>;
}
