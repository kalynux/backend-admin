import { Request, Response } from 'express';
import { ObjectId } from 'mongodb';
import { actorContextOf } from '../../audit/domain/audit-context';
import { asyncHandler } from '../../../core/http/async-handler';
import { toPageMeta } from '../../../core/http/list-query';
import { sendPaginated, sendSuccess } from '../../../core/http/responses';
import { CategoryReadRepository } from '../../categories/repositories/category.read.repository';
import { revealContacts } from '../domain/listing-contacts-disclosure';
import { labelOfListing, loadListingOr404, snapshotOfListing } from '../domain/listing-lookup';
import * as gateway from '../gateways/listing.gateway';
import { referencedIdsOf, toListingDetailDto, toListingQueueItemDto } from '../read-models/listing.dto';
import {
    ListingFileReadRepository,
    ListingUsageReadRepository,
    ListingVendorReadRepository,
} from '../repositories/listing-context.read.repository';
import { ListingReadModel, ListingReadRepository } from '../repositories/listing.read.repository';
import {
    ListListingsQuery,
    RejectListingBody,
    SuspendListingBody,
    UnsuspendListingBody,
} from '../validators/listing.validator';

const listings = new ListingReadRepository();
const vendors = new ListingVendorReadRepository();
const files = new ListingFileReadRepository();
const usage = new ListingUsageReadRepository();
const categories = new CategoryReadRepository();

/** The detail, with everything it needs from other collections resolved in one query each. */
async function detailOf(row: ListingReadModel) {
    const { categoryIds, fileIds } = referencedIdsOf(row);
    const [vendorMap, categoryMap, fileMap, counts] = await Promise.all([
        vendors.findByIds([row.vendor_id]),
        categories.findRefsByIds(categoryIds),
        files.findDetailsByIds(fileIds),
        usage.countsFor(row.vendor_id, row._id),
    ]);
    return toListingDetailDto(row, {
        vendor: vendorMap.get(row.vendor_id.toString()),
        categories: categoryMap,
        files: fileMap,
        counts,
    });
}

const targetOf = (listingId: string, row: ListingReadModel): gateway.ListingWriteTarget => ({
    listingId,
    label: labelOfListing(row),
    before: snapshotOfListing(row),
});

/**
 * After a write, the listing is read back from the database rather than rebuilt from
 * jovi-mall's answer: § C-3 leaves `AdminListingResult` unshaped, and the detail is what the
 * screen renders anyway.
 */
async function freshDetail(listingId: string) {
    return detailOf(await loadListingOr404(listingId));
}

export class ListingController {
    /** GET /api/v1/listings — the review queue and the listing directory. */
    static list = asyncHandler(async (req: Request, res: Response) => {
        const query = req.query as unknown as ListListingsQuery;
        const page = await listings.search(query);
        const vendorIds = new Map<string, ObjectId>();
        for (const row of page.items) vendorIds.set(row.vendor_id.toString(), row.vendor_id);
        const vendorMap = await vendors.findByIds([...vendorIds.values()]);
        sendPaginated(
            res,
            page.items.map((row) => toListingQueueItemDto(row, vendorMap.get(row.vendor_id.toString()))),
            toPageMeta(page.total, page.page, page.limit),
        );
    });

    /** GET /api/v1/listings/:listingId — both copies side by side, never a contact. */
    static get = asyncHandler(async (req: Request, res: Response) => {
        const row = await loadListingOr404(req.params.listingId);
        sendSuccess(res, await detailOf(row));
    });

    /** GET /api/v1/listings/:listingId/contacts — audited before the read; see the domain file. */
    static contacts = asyncHandler(async (req: Request, res: Response) => {
        sendSuccess(res, await revealContacts(req.params.listingId, actorContextOf(req)));
    });

    /** POST /api/v1/listings/:listingId/approve — 409 LISTING_STATUS_CONFLICT if nothing is under review. */
    static approve = asyncHandler(async (req: Request, res: Response) => {
        const { listingId } = req.params;
        const row = await loadListingOr404(listingId);
        await gateway.approve(targetOf(listingId, row), actorContextOf(req));
        sendSuccess(res, await freshDetail(listingId), { message: 'Listing approved' });
    });

    /** POST /api/v1/listings/:listingId/reject — body `{ reasons }`. */
    static reject = asyncHandler(async (req: Request, res: Response) => {
        const { listingId } = req.params;
        const { reasons } = req.body as RejectListingBody;
        const row = await loadListingOr404(listingId);
        await gateway.reject(targetOf(listingId, row), reasons, actorContextOf(req));
        sendSuccess(res, await freshDetail(listingId), { message: 'Listing rejected' });
    });

    /** POST /api/v1/listings/:listingId/suspend — body `{ note }`. */
    static suspend = asyncHandler(async (req: Request, res: Response) => {
        const { listingId } = req.params;
        const { note } = req.body as SuspendListingBody;
        const row = await loadListingOr404(listingId);
        await gateway.suspend(targetOf(listingId, row), note, actorContextOf(req));
        sendSuccess(res, await freshDetail(listingId), { message: 'Listing suspended' });
    });

    /** POST /api/v1/listings/:listingId/unsuspend — body `{ note? }`. */
    static unsuspend = asyncHandler(async (req: Request, res: Response) => {
        const { listingId } = req.params;
        const { note } = req.body as UnsuspendListingBody;
        const row = await loadListingOr404(listingId);
        await gateway.unsuspend(targetOf(listingId, row), note ?? null, actorContextOf(req));
        sendSuccess(res, await freshDetail(listingId), { message: 'Listing put back' });
    });
}
