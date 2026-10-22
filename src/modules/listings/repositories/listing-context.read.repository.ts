import { Document, Filter, ObjectId } from 'mongodb';
import { COLLECTIONS } from '../../../infra/platform/collections';
import { PlatformReadRepository } from '../../../infra/platform/platform.repository';
import { FileDetail, toFileDetail } from '../../../infra/storage/file-detail';

/**
 * What a listing screen needs from OTHER collections: who the provider is, what the photos
 * look like, and how much the listing has been used. Each is a narrow repository of its own,
 * bound to its own collection with its own projection, rather than a widened projection of a
 * shared one.
 */

// ─── The provider ────────────────────────────────────────────────────────────

/**
 * The provider, as a reviewer needs to recognise them — and nothing they could be reached by.
 *
 * ⚠ **Not `VendorReadRepository`.** That one projects the vendor's `email` and `phone`, which
 * is right for the vendor directory and wrong here: a reviewer approving a listing whose whole
 * point is that its contacts are hidden must not be handed the provider's own number on the
 * same screen. So this is a second projection of `vendors`, deliberately narrower, and
 * `test:listings` scans it for contact-field names.
 *
 * `kind` has no schema default upstream (§ C-1): an absent value means `seller`, so it is
 * read through `vendorKindOf` in the DTO, never compared raw.
 */
export interface ListingVendorReadModel extends Document {
    _id: ObjectId;
    display_name?: string;
    status?: string;
    kind?: string;
    kyc_details?: { legit_verified?: boolean; status?: string };
}

export const LISTING_VENDOR_PROJECTION = {
    _id: 1,
    display_name: 1,
    status: 1,
    kind: 1,
    'kyc_details.legit_verified': 1,
    'kyc_details.status': 1,
} as const;

export class ListingVendorReadRepository extends PlatformReadRepository<ListingVendorReadModel> {
    constructor() {
        super(COLLECTIONS.VENDOR, LISTING_VENDOR_PROJECTION);
    }

    /** One query per page, never one per row. */
    async findByIds(ids: ObjectId[]): Promise<Map<string, ListingVendorReadModel>> {
        if (ids.length === 0) return new Map();
        const rows = await this.findBy({ _id: { $in: ids } } as Filter<ListingVendorReadModel>, { limit: ids.length });
        return new Map(rows.map((row) => [row._id.toString(), row]));
    }
}

// ─── The photos ──────────────────────────────────────────────────────────────

/**
 * A `files` row, narrowed to what `toFileDetail` consumes — the media library's builder, so a
 * photo resolves here exactly as it does on every other screen.
 *
 * ⚠ `quotaBlockedAt` MUST be projected: an omitted column reads as "not blocked" and would
 * republish a URL jovi-mall has stopped handing out. Same rule `product-media.read.repository`
 * states for product media.
 */
interface ListingFileReadModel extends Document {
    _id: ObjectId;
    key: string;
    mimeType: string;
    size: number;
    originalName?: string | null;
    quotaBlockedAt?: Date | null;
}

export const LISTING_FILE_PROJECTION = {
    _id: 1,
    key: 1,
    mimeType: 1,
    size: 1,
    originalName: 1,
    quotaBlockedAt: 1,
} as const;

export class ListingFileReadRepository extends PlatformReadRepository<ListingFileReadModel> {
    constructor() {
        super(COLLECTIONS.FILE, LISTING_FILE_PROJECTION);
    }

    /** `deletedAt: null` mirrors jovi-mall's `findManyByIds`: a swept file resolves to nothing. */
    async findDetailsByIds(ids: ObjectId[]): Promise<Map<string, FileDetail>> {
        if (ids.length === 0) return new Map();
        const rows = await this.findBy(
            { _id: { $in: ids }, deletedAt: null } as Filter<ListingFileReadModel>,
            { limit: ids.length },
        );
        return new Map(
            rows.map((row) => [
                row._id.toString(),
                toFileDetail({
                    id: row._id.toString(),
                    key: row.key,
                    mimeType: row.mimeType,
                    size: row.size,
                    originalName: row.originalName,
                    quotaBlockedAt: row.quotaBlockedAt ?? null,
                }),
            ]),
        );
    }
}

// ─── How much it has been used ───────────────────────────────────────────────

/**
 * Lead and reveal counts for one listing. Counts only — the rows themselves (and the
 * customers behind them) are the lead-report screens', which are a later step.
 *
 * Filtered on `vendor_id` as well as `listing_id`. The listing id alone is correct but has no
 * index whose prefix it is (both collections lead with `customer_id` or `vendor_id`), so the
 * vendor id is what lets `listing_lead_vendor_recent` / `listing_reveal_vendor_recent` serve
 * the count rather than a collection scan.
 */
class ListingLeadCountRepository extends PlatformReadRepository<Document> {
    constructor() {
        super(COLLECTIONS.LISTING_LEAD, { _id: 1 });
    }

    async countFor(vendorId: ObjectId, listingId: ObjectId): Promise<number> {
        return this.countBy({ vendor_id: vendorId, listing_id: listingId });
    }
}

class ListingRevealCountRepository extends PlatformReadRepository<Document> {
    constructor() {
        super(COLLECTIONS.LISTING_REVEAL, { _id: 1 });
    }

    async countFor(vendorId: ObjectId, listingId: ObjectId): Promise<number> {
        return this.countBy({ vendor_id: vendorId, listing_id: listingId });
    }
}

export class ListingUsageReadRepository {
    private readonly leads = new ListingLeadCountRepository();
    private readonly reveals = new ListingRevealCountRepository();

    async countsFor(vendorId: ObjectId, listingId: ObjectId): Promise<{ leads: number; reveals: number }> {
        const [leads, reveals] = await Promise.all([
            this.leads.countFor(vendorId, listingId),
            this.reveals.countFor(vendorId, listingId),
        ]);
        return { leads, reveals };
    }
}
