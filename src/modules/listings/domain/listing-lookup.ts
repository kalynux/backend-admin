import { createAppError } from '../../../core/errors/app-error';
import { ERROR_CODES } from '../../../core/errors/error-codes';
import { ListingReadModel, ListingReadRepository } from '../repositories/listing.read.repository';

/**
 * The one 404 read every `/listings/:listingId` route starts with — the detail, each write
 * (for the audit row's label and `before`), and the contacts disclosure (which must 404 BEFORE
 * its audit intent, so a mistyped id never reaches the trail as an attempted disclosure).
 */

const listings = new ListingReadRepository();

export async function loadListingOr404(listingId: string): Promise<ListingReadModel> {
    const row = await listings.findDetailById(listingId);
    if (!row) throw createAppError(ERROR_CODES.NOT_FOUND, 404, 'Listing not found');
    return row;
}

/**
 * The audit target's label — recognisable in a list of audit rows without opening each. The
 * copy under review names it if there is one (a first submission has no published title);
 * public text only, never a contact.
 */
export function labelOfListing(row: ListingReadModel): string {
    const copy = row.pending ?? row.published;
    const title = row.published?.title || copy?.title || null;
    const company = row.published?.company_name || copy?.company_name || null;
    if (title && company) return `${title} — ${company}`;
    return title ?? company ?? row.slug;
}

/** What the listing looked like before a write — the audit row's `before`. Public state only. */
export function snapshotOfListing(row: ListingReadModel): Record<string, unknown> {
    return {
        status: row.status,
        reviewState: row.review?.state ?? null,
        suspensionReason: row.suspension?.reason ?? null,
        title: row.published?.title ?? row.pending?.title ?? null,
        companyName: row.published?.company_name ?? row.pending?.company_name ?? null,
        vendorId: row.vendor_id.toString(),
    };
}
