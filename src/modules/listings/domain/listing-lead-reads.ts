import { ObjectId } from 'mongodb';
import { createAppError } from '../../../core/errors/app-error';
import { ERROR_CODES } from '../../../core/errors/error-codes';
import { Paginated } from '../../../infra/platform/platform.repository';
import { AdminTier } from '../../admin-identity/domain/admin-identity.types';
import { hasPermission } from '../../authorization/domain/permission.resolver';
import { findRoleProfiles } from '../../users/repositories/role-profile.read.repository';
import {
    LeadBlockDto,
    ListingLeadDetailDto,
    ListingLeadDto,
    ListingLeadTicketContextDto,
    TicketLeadMetadata,
    revealIdsOf,
    toLeadAccountRoleDto,
    toLeadBlockDto,
    toLeadListingSummary,
    toListingLeadDetailDto,
    toListingLeadDto,
    toListingLeadTicketContextDto,
    toOtherLeadsDto,
    withheldTicketContext,
} from '../read-models/listing-lead.dto';
import { ListingVendorReadRepository } from '../repositories/listing-context.read.repository';
import {
    LeadAccountReadModel,
    LeadAccountReadRepository,
    LeadCustomerReadModel,
    LeadCustomerReadRepository,
    LeadListingRefReadModel,
    LeadListingRefReadRepository,
    ListingLeadReadModel,
    ListingLeadReadRepository,
    ListingRevealBlockReadRepository,
    ListingRevealReadModel,
    ListingRevealReadRepository,
    ProviderConsentReadRepository,
} from '../repositories/listing-report.read.repository';
import { ListListingLeadsQuery } from '../validators/listing-reports.validator';

/**
 * Assembling the lead-report reads (L-25, L-29, L-31) — every query batched per page, never
 * one per row: a page of twenty leads costs the same seven reads as one lead.
 *
 * ⛔ Nothing here reads `listing_contacts`. What a customer was SHOWN is the provider's
 * contact, and it stays behind `catalog.listings.contacts.read` and its audit row; what an
 * administrator investigating a report needs is who the CUSTOMER is and what each reveal cost.
 */

const leads = new ListingLeadReadRepository();
const reveals = new ListingRevealReadRepository();
const blocks = new ListingRevealBlockReadRepository();
const consents = new ProviderConsentReadRepository();
const customers = new LeadCustomerReadRepository();
const accounts = new LeadAccountReadRepository();
const listingRefs = new LeadListingRefReadRepository();
const vendors = new ListingVendorReadRepository();

/** How many of the customer's OTHER leads, and providers, the drain view lists. */
export const OTHER_LEADS_LIMIT = 50;

export async function loadLeadOr404(leadId: string): Promise<ListingLeadReadModel> {
    const row = await leads.findById(leadId);
    if (!row) throw createAppError(ERROR_CODES.NOT_FOUND, 404, 'Listing lead not found');
    return row;
}

export async function loadRevealOr404(revealId: string): Promise<ListingRevealReadModel> {
    const row = await reveals.findById(revealId);
    if (!row) throw createAppError(ERROR_CODES.NOT_FOUND, 404, 'Listing reveal not found');
    return row;
}

/** The customer profile a block names — 404 before any audit row, like every other target. */
export async function loadCustomerOr404(customerId: string): Promise<LeadCustomerReadModel> {
    const id = ObjectId.isValid(customerId) ? new ObjectId(customerId) : null;
    const row = id ? (await customers.findByIds([id])).get(id.toString()) : undefined;
    if (!row) throw createAppError(ERROR_CODES.NOT_FOUND, 404, 'Customer not found');
    return row;
}

/** The public name of one listing, for a reveal's audit label. `undefined` when it is gone. */
export async function listingRefOf(listingId: ObjectId): Promise<LeadListingRefReadModel | undefined> {
    return (await listingRefs.findByIds([listingId])).get(listingId.toString());
}

/** One customer's ACTIVE block on one listing — the "before" of a block write and its fresh read. */
export async function activeBlockOf(listingId: ObjectId, customerId: ObjectId): Promise<LeadBlockDto | null> {
    return toLeadBlockDto((await blocks.activeOn(listingId, [customerId])).get(customerId.toString()));
}

/**
 * Lead rows for leads of ONE listing (so one provider): the customer behind each, the
 * reveals, the active block on this listing, the opt-in toward this provider.
 */
async function rowsFor(
    listingId: ObjectId,
    vendorId: ObjectId,
    page: ListingLeadReadModel[],
): Promise<{ rows: ListingLeadDto[]; accounts: Map<string, LeadAccountReadModel> }> {
    if (page.length === 0) return { rows: [], accounts: new Map() };
    const customerIds = page.map((lead) => lead.customer_id);
    const [customerMap, revealMap, blockMap, consentMap] = await Promise.all([
        customers.findByIds(customerIds),
        reveals.findByLeadIds(page.map((lead) => lead._id)),
        blocks.activeOn(listingId, customerIds),
        consents.towardProvider(vendorId, customerIds),
    ]);
    const userIds = [...customerMap.values()]
        .map((customer) => customer.user_id)
        .filter((id): id is ObjectId => id instanceof ObjectId);
    const accountMap = await accounts.findByIds(userIds);
    const now = new Date();
    const rows = page.map((lead) => toListingLeadDto(lead, {
        customers: customerMap,
        accounts: accountMap,
        reveals: revealMap,
        blocks: blockMap,
        consents: consentMap,
        now,
    }));
    return { rows, accounts: accountMap };
}

/** GET /listings/:listingId/leads — the caller has already 404'd the listing. */
export async function leadPageOf(
    listing: { _id: ObjectId; vendor_id: ObjectId },
    query: ListListingLeadsQuery,
): Promise<Paginated<ListingLeadDto>> {
    const page = await leads.pageForListing(listing.vendor_id, listing._id, query);
    const { rows } = await rowsFor(listing._id, listing.vendor_id, page.items);
    return { ...page, items: rows };
}

/** One lead as a row — what a write answers with after it lands. */
export async function leadRowOf(lead: ListingLeadReadModel): Promise<ListingLeadDto> {
    const { rows } = await rowsFor(lead.listing_id, lead.vendor_id, [lead]);
    return rows[0];
}

/**
 * GET /listings/leads/:leadId — the lead in full, plus what L-29 needs to tell a drain from a
 * customer: every role on the customer's account with its creation date, and the customer's
 * OTHER leads (how many, which providers, when).
 */
export async function leadDetailOf(lead: ListingLeadReadModel): Promise<ListingLeadDetailDto> {
    const [{ rows: [row], accounts: accountMap }, others] = await Promise.all([
        rowsFor(lead.listing_id, lead.vendor_id, [lead]),
        leads.othersOfCustomer(lead.customer_id, lead._id, OTHER_LEADS_LIMIT),
    ]);

    const listingIds = [lead.listing_id, ...others.items.map((other) => other.listing_id)];
    const vendorIds = [lead.vendor_id, ...others.items.map((o) => o.vendor_id), ...others.byProvider.map((p) => p._id)];
    const holder = row.customer.userId ? accountMap.get(row.customer.userId) : undefined;

    const [listingMap, vendorMap, roleProfiles] = await Promise.all([
        listingRefs.findByIds(listingIds),
        vendors.findByIds([...new Map(vendorIds.map((id) => [id.toString(), id])).values()]),
        holder ? findRoleProfiles(holder._id, holder.roles ?? []) : Promise.resolve([]),
    ]);

    return toListingLeadDetailDto(row, {
        listing: toLeadListingSummary(lead.listing_id, listingMap.get(lead.listing_id.toString())),
        provider: { id: lead.vendor_id.toString(), displayName: vendorMap.get(lead.vendor_id.toString())?.display_name ?? null },
        accountRoles: roleProfiles.map(toLeadAccountRoleDto),
        otherLeads: toOtherLeadsDto({ ...others, listings: listingMap, vendors: vendorMap }),
    });
}

/**
 * The lead context on a `LISTING_LEAD_REPORT` ticket's support detail (L-31).
 *
 * ⛔ **The permission is CHECKED, not assumed.** The ticket detail is gated on the support
 * permissions; the lead behind it is `catalog.listings.read`'s. Every tier holds both today,
 * and that is exactly why the check is written: the day a tier loses the second, this context
 * goes dark for it instead of leaking around its own gate. Without it, only the ids already on
 * the ticket and what the provider asked for are returned.
 */
export async function ticketLeadContextOf(
    leadId: string,
    metadata: TicketLeadMetadata | null | undefined,
    tier: AdminTier,
): Promise<ListingLeadTicketContextDto> {
    if (!hasPermission(tier, 'catalog.listings.read')) return withheldTicketContext(leadId, metadata);

    const lead = await leads.findById(leadId);
    const [listingMap, named] = await Promise.all([
        lead ? listingRefs.findByIds([lead.listing_id]) : Promise.resolve(new Map()),
        lead ? reveals.findNamedOnLead(lead._id, revealIdsOf(metadata)) : Promise.resolve([]),
    ]);
    return toListingLeadTicketContextDto(
        leadId,
        metadata,
        lead,
        lead ? listingMap.get(lead.listing_id.toString()) : undefined,
        named,
    );
}
