import { Document, Filter, ObjectId } from 'mongodb';
import { Types } from 'mongoose';
import { containsInsensitive } from '../../../core/data/mongo-list';
import { COLLECTIONS } from '../../../infra/platform/collections';
import { PlatformReadRepository } from '../../../infra/platform/platform.repository';

/**
 * The vendor's public business identity.
 *
 * ── Why this is a separate collection and therefore a separate repository ─────
 * `Vendor.display_name` is the person; the BUSINESS name, slug and branding live on their
 * Store, one per vendor. Every vendor screen needs both, and they are two documents.
 *
 * This repository is used three ways, and the third is the interesting one:
 *   1. `findForVendor`  — hydrate one detail view.
 *   2. `findForVendors` — hydrate a page of the directory in ONE query rather than N.
 *   3. `findVendorIdsByName` — resolve a search term to vendor ids BEFORE the vendor query
 *      runs, so business-name search works without a `$lookup` that would force the
 *      directory's sort off its index. See `VENDOR_SORT` for the trade that buys.
 */

export interface StoreReadModel extends Document {
    _id: ObjectId;
    vendor_id: ObjectId;
    name: string;
    slug: string;
    logo_file_id?: ObjectId | null;
    banner_file_id?: ObjectId | null;
    description?: string | null;
    support_email?: string | null;
    support_phone?: string | null;
    support_whatsapp?: string | null;
    is_open?: boolean;
    created_at: Date;
    updated_at: Date;
}

const STORE_PROJECTION = {
    _id: 1,
    vendor_id: 1,
    name: 1,
    slug: 1,
    logo_file_id: 1,
    banner_file_id: 1,
    description: 1,
    support_email: 1,
    support_phone: 1,
    support_whatsapp: 1,
    is_open: 1,
    created_at: 1,
    updated_at: 1,
} as const;

/**
 * How many business-name matches a search term may contribute.
 *
 * A cap rather than an unbounded `$in`: a one-character term matches most of the table,
 * and a `$in` of every store id is a filter the planner cannot use well. ADR-005 D-13
 * forbids a SILENT cap, so `VendorController.search` reports when this bites rather than
 * letting a truncated result read as a complete one.
 */
export const STORE_SEARCH_CAP = 500;

export class StoreReadRepository extends PlatformReadRepository<StoreReadModel> {
    constructor() {
        super(COLLECTIONS.STORE, STORE_PROJECTION);
    }

    async findForVendor(vendorId: string): Promise<StoreReadModel | null> {
        if (!Types.ObjectId.isValid(vendorId)) return null;
        return this.findOneBy({ vendor_id: new ObjectId(vendorId) } as Filter<StoreReadModel>);
    }

    /**
     * One query per page, not one per row.
     *
     * `vendor_id` is unique+indexed, so this is an index scan over at most `limit` keys.
     */
    async findForVendors(vendorIds: ObjectId[]): Promise<Map<string, StoreReadModel>> {
        if (vendorIds.length === 0) return new Map();

        const rows = await this.findBy({
            vendor_id: { $in: vendorIds },
        } as Filter<StoreReadModel>);

        return new Map(rows.map((row) => [row.vendor_id.toString(), row]));
    }

    /**
     * Vendor ids whose business name matches, capped.
     *
     * Returns `{ ids, truncated }` rather than a bare array: the caller has to be able to
     * tell the dashboard that a broad term did not see every match.
     */
    async findVendorIdsByName(
        term: string,
        cap = STORE_SEARCH_CAP,
    ): Promise<{ ids: ObjectId[]; truncated: boolean }> {
        const rows = await this.findBy(
            { name: containsInsensitive(term) } as Filter<StoreReadModel>,
            { projection: { _id: 0, vendor_id: 1 }, limit: cap + 1 },
        );

        const truncated = rows.length > cap;
        const ids = rows.slice(0, cap).map((row) => row.vendor_id);
        return { ids, truncated };
    }
}
