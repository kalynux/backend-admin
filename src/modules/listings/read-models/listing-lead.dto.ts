import { ObjectId } from 'mongodb';
import type { RoleProfile, MissingRoleProfile } from '../../users/repositories/role-profile.read.repository';
import type { ListingVendorReadModel } from '../repositories/listing-context.read.repository';
import type {
    LeadAccountReadModel,
    LeadCustomerReadModel,
    LeadListingRefReadModel,
    LeadsByProviderRow,
    ListingLeadReadModel,
    ListingRevealBlockReadModel,
    ListingRevealReadModel,
    ProviderConsentReadModel,
} from '../repositories/listing-report.read.repository';
import { LISTING_REPORT_WANTS, PROVIDER_CONSENT_STATES } from '../validators/listing-reports.validator';

/**
 * The wire shapes of the lead-report reads (ADR-005: camelCase, 24-hex ids, ISO instants, an
 * absent value is `null` — never an omitted key).
 *
 * ── The customer is shown IN FULL here, and that is the decision (L-31) ───────
 * A provider sees *"Jean-Paul K. · +237 ••• ••• •31"* (L-13). An administrator investigating a
 * report sees the full name, the full login phone, the e-mail and when the account was made —
 * a drain (L-29) is only visible through the real numbers. `catalog.listings.read` gates it.
 *
 * ⛔ **No PROVIDER contact value appears in any shape in this file**, and none could: the read
 * models these map from never touch `listing_contacts`. A reveal says WHICH field was unlocked
 * and what it cost — never what the customer was shown.
 *
 * Named-field mapping, never a spread: the projection is the first lock, this is the second.
 */

export type ProviderConsentState = (typeof PROVIDER_CONSENT_STATES)[number];

function toIso(value: Date | string | null | undefined): string | null {
    if (!value) return null;
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export interface ActorRefDto {
    id: string | null;
    source: string;
    name: string | null;
}

function toActor(id: ObjectId | null | undefined, source: string | undefined, name: string | null | undefined): ActorRefDto {
    return { id: id?.toString() ?? null, source: source ?? 'platform', name: name ?? null };
}

/** The public name of a listing — the live copy's, else the draft's. Never content beyond it. */
function namesOf(listing: LeadListingRefReadModel | undefined): { title: string | null; companyName: string | null } {
    return {
        title: listing?.published?.title || listing?.pending?.title || null,
        companyName: listing?.published?.company_name || listing?.pending?.company_name || null,
    };
}

// ─── The customer ────────────────────────────────────────────────────────────

export interface LeadCustomerDto {
    /** `customers._id` — the id the block route takes (`/reveal-blocks/:customerId`). */
    id: string;
    /** `users._id` — the user directory's key. `null` when the profile is gone. */
    userId: string | null;
    name: string | null;
    /** The FULL login phone. Administrators may see it (L-31); the provider never does (L-13). */
    phone: string | null;
    email: string | null;
    profileStatus: string | null;
    accountStatus: string | null;
    /** When the CUSTOMER role was created — a fresh profile on an old account is its own signal. */
    profileCreatedAt: string | null;
    /** When the account itself was created — the drain signal L-29 names. */
    accountCreatedAt: string | null;
    /** Set on a closed account (ADR-A02): the identity fields above are then anonymised. */
    accountClosedAt: string | null;
}

export function toLeadCustomerDto(
    customerId: ObjectId,
    customer: LeadCustomerReadModel | undefined,
    account: LeadAccountReadModel | undefined,
): LeadCustomerDto {
    return {
        id: customerId.toString(),
        userId: customer?.user_id?.toString() ?? null,
        name: customer?.name || null,
        phone: account?.login_phone || null,
        email: account?.login_email || null,
        profileStatus: customer?.status ?? null,
        accountStatus: account?.status ?? null,
        profileCreatedAt: toIso(customer?.created_at),
        accountCreatedAt: toIso(account?.created_at),
        accountClosedAt: toIso(account?.closed_at),
    };
}

// ─── A reveal ────────────────────────────────────────────────────────────────

export interface LeadRevealDto {
    id: string;
    field: string;
    cost: number;
    /** A grace reveal (L-10), paid through the debt path. */
    chargedIntoDebt: boolean;
    at: string | null;
    refunded: boolean;
    refund: {
        at: string | null;
        by: ActorRefDto;
        ticketId: string | null;
        note: string | null;
    } | null;
}

export function toLeadRevealDto(row: ListingRevealReadModel): LeadRevealDto {
    const refund = row.refund ?? null;
    return {
        id: row._id.toString(),
        field: row.field,
        cost: typeof row.cost === 'number' ? row.cost : 0,
        chargedIntoDebt: row.charged_into_debt === true,
        at: toIso(row.at),
        refunded: refund !== null,
        refund: refund
            ? {
                at: toIso(refund.at),
                by: toActor(refund.by_user_id, refund.by_source, refund.by_name),
                ticketId: refund.ticket_id?.toString() ?? null,
                note: refund.note ?? null,
            }
            : null,
    };
}

// ─── A block ─────────────────────────────────────────────────────────────────

export interface LeadBlockDto {
    id: string;
    reason: string;
    ticketId: string | null;
    blockedAt: string | null;
    blockedBy: ActorRefDto;
}

export function toLeadBlockDto(row: ListingRevealBlockReadModel | undefined): LeadBlockDto | null {
    if (!row) return null;
    return {
        id: row._id.toString(),
        reason: row.reason,
        ticketId: row.ticket_id?.toString() ?? null,
        blockedAt: toIso(row.blocked_at),
        blockedBy: toActor(row.blocked_by_user_id, row.blocked_by_source, row.blocked_by_name),
    };
}

// ─── The opt-in ──────────────────────────────────────────────────────────────

export interface LeadConsentDto {
    state: ProviderConsentState;
    askedAt: string | null;
    grantedAt: string | null;
    revokedAt: string | null;
    source: string | null;
}

/** § C-2: granted = `granted_at` set and `revoked_at` not. No row at all is `not_granted`. */
export function consentStateOf(row: Pick<ProviderConsentReadModel, 'granted_at' | 'revoked_at'> | undefined): ProviderConsentState {
    if (!row) return 'not_granted';
    if (row.revoked_at) return 'revoked';
    return row.granted_at ? 'granted' : 'not_granted';
}

export function toLeadConsentDto(row: ProviderConsentReadModel | undefined): LeadConsentDto {
    return {
        state: consentStateOf(row),
        askedAt: toIso(row?.asked_at),
        grantedAt: toIso(row?.granted_at),
        revokedAt: toIso(row?.revoked_at),
        source: row?.source ?? null,
    };
}

// ─── The lead row ────────────────────────────────────────────────────────────

/** Everything one lead row needs from outside `listing_leads`, resolved once per page. */
export interface LeadRowContext {
    customers: Map<string, LeadCustomerReadModel>;
    /** Keyed by `users._id`. */
    accounts: Map<string, LeadAccountReadModel>;
    /** Keyed by lead id. */
    reveals: Map<string, ListingRevealReadModel[]>;
    /** ACTIVE blocks on this lead's listing, keyed by customer id. */
    blocks: Map<string, ListingRevealBlockReadModel>;
    /** Opt-ins toward this lead's provider, keyed by customer id. */
    consents: Map<string, ProviderConsentReadModel>;
    now: Date;
}

export interface ListingLeadDto {
    id: string;
    listingId: string;
    vendorId: string;
    customer: LeadCustomerDto;
    windowStart: string | null;
    windowEnd: string | null;
    /** The 30-day window is still running — the customer is still being served (L-7). */
    windowOpen: boolean;
    engagedWhileLive: boolean;
    channel: string | null;
    fieldsRevealed: string[];
    reveals: LeadRevealDto[];
    /** Credits this lead cost the provider, and how many of them were refunded. */
    credits: { charged: number; refunded: number };
    /** This customer's active block on THIS listing (L-29), or `null`. */
    activeBlock: LeadBlockDto | null;
    /** This customer's opt-in toward THIS provider (L-14). */
    consent: LeadConsentDto;
    createdAt: string | null;
}

export function toListingLeadDto(lead: ListingLeadReadModel, ctx: LeadRowContext): ListingLeadDto {
    const customerKey = lead.customer_id.toString();
    const customer = ctx.customers.get(customerKey);
    const account = customer?.user_id ? ctx.accounts.get(customer.user_id.toString()) : undefined;
    const reveals = (ctx.reveals.get(lead._id.toString()) ?? []).map(toLeadRevealDto);
    const charged = reveals.reduce((sum, r) => sum + r.cost, 0);
    const refunded = reveals.filter((r) => r.refunded).reduce((sum, r) => sum + r.cost, 0);

    return {
        id: lead._id.toString(),
        listingId: lead.listing_id.toString(),
        vendorId: lead.vendor_id.toString(),
        customer: toLeadCustomerDto(lead.customer_id, customer, account),
        windowStart: toIso(lead.window_start),
        windowEnd: toIso(lead.window_end),
        windowOpen: lead.window_end instanceof Date ? lead.window_end.getTime() > ctx.now.getTime() : false,
        engagedWhileLive: lead.engaged_while_live === true,
        channel: lead.channel ?? null,
        fieldsRevealed: lead.fields_revealed ?? [],
        reveals,
        credits: { charged, refunded },
        activeBlock: toLeadBlockDto(ctx.blocks.get(customerKey)),
        consent: toLeadConsentDto(ctx.consents.get(customerKey)),
        createdAt: toIso(lead.created_at),
    };
}

// ─── The lead in full — the drain-detection view (L-29) ──────────────────────

export interface LeadListingSummaryDto {
    id: string;
    slug: string | null;
    title: string | null;
    companyName: string | null;
    status: string | null;
}

export function toLeadListingSummary(listingId: ObjectId, listing: LeadListingRefReadModel | undefined): LeadListingSummaryDto {
    return {
        id: listingId.toString(),
        slug: listing?.slug ?? null,
        ...namesOf(listing),
        status: listing?.status ?? null,
    };
}

export interface LeadProviderRefDto {
    id: string;
    displayName: string | null;
}

/** One role the customer's account holds, and when it was created — never more of the profile. */
export interface LeadAccountRoleDto {
    role: string;
    profileId: string | null;
    status: string | null;
    createdAt: string | null;
    /** On the account's `roles` but with no profile behind it — sign-in fails for that role. */
    missing: boolean;
}

export function toLeadAccountRoleDto(profile: RoleProfile | MissingRoleProfile): LeadAccountRoleDto {
    return {
        role: profile.role,
        profileId: profile.id,
        status: profile.status,
        createdAt: profile.createdAt,
        missing: 'missing' in profile && profile.missing === true,
    };
}

export interface OtherLeadDto {
    id: string;
    listing: LeadListingSummaryDto;
    provider: LeadProviderRefDto;
    windowStart: string | null;
    windowEnd: string | null;
    fieldsRevealed: string[];
    createdAt: string | null;
}

export interface OtherLeadsDto {
    /** How many leads the customer has OTHER than this one, across every listing. */
    total: number;
    /** How many distinct providers those leads touch (within the rollup's limit). */
    providerCount: number;
    /** Per provider: how many leads, first and last — newest provider first. */
    byProvider: Array<{ provider: LeadProviderRefDto; leads: number; firstAt: string | null; lastAt: string | null }>;
    /** The most recent of them, newest first. `truncated` when `total` is larger. */
    recent: OtherLeadDto[];
    truncated: boolean;
}

export interface OtherLeadsContext {
    total: number;
    items: ListingLeadReadModel[];
    byProvider: LeadsByProviderRow[];
    listings: Map<string, LeadListingRefReadModel>;
    vendors: Map<string, ListingVendorReadModel>;
}

const providerRef = (id: ObjectId, vendors: Map<string, ListingVendorReadModel>): LeadProviderRefDto => ({
    id: id.toString(),
    displayName: vendors.get(id.toString())?.display_name ?? null,
});

export function toOtherLeadsDto(ctx: OtherLeadsContext): OtherLeadsDto {
    return {
        total: ctx.total,
        providerCount: ctx.byProvider.length,
        byProvider: ctx.byProvider.map((row) => ({
            provider: providerRef(row._id, ctx.vendors),
            leads: row.leads,
            firstAt: toIso(row.firstAt),
            lastAt: toIso(row.lastAt),
        })),
        recent: ctx.items.map((lead) => ({
            id: lead._id.toString(),
            listing: toLeadListingSummary(lead.listing_id, ctx.listings.get(lead.listing_id.toString())),
            provider: providerRef(lead.vendor_id, ctx.vendors),
            windowStart: toIso(lead.window_start),
            windowEnd: toIso(lead.window_end),
            fieldsRevealed: lead.fields_revealed ?? [],
            createdAt: toIso(lead.created_at),
        })),
        truncated: ctx.total > ctx.items.length,
    };
}

export interface ListingLeadDetailDto extends ListingLeadDto {
    listing: LeadListingSummaryDto;
    provider: LeadProviderRefDto;
    /** Every role on the customer's account, with when each was created (L-29). */
    accountRoles: LeadAccountRoleDto[];
    otherLeads: OtherLeadsDto;
}

export function toListingLeadDetailDto(
    row: ListingLeadDto,
    extra: {
        listing: LeadListingSummaryDto;
        provider: LeadProviderRefDto;
        accountRoles: LeadAccountRoleDto[];
        otherLeads: OtherLeadsDto;
    },
): ListingLeadDetailDto {
    return {
        ...row,
        listing: extra.listing,
        provider: extra.provider,
        accountRoles: extra.accountRoles,
        otherLeads: extra.otherLeads,
    };
}

// ─── On a report ticket (L-31) ───────────────────────────────────────────────

/**
 * The lead context a `LISTING_LEAD_REPORT` ticket carries on the support detail.
 *
 * A SUMMARY plus the ids the two lead reads take — it does not duplicate them. The customer's
 * full identity and other leads are `GET /api/v1/listings/leads/:leadId` (by `leadId`); the
 * listing's other leads are `GET /api/v1/listings/:listingId/leads`. The vendor's reason is the
 * ticket's own `description`, already on the detail.
 *
 * `readable` is the caller's `catalog.listings.read`. Without it every lead field is withheld
 * (`lead: null`, `namedReveals: []`, ids `null`/`[]`) — what the provider asked for (`wants`)
 * is the ticket's own content and stays.
 */
export interface ListingLeadTicketContextDto {
    leadId: string;
    readable: boolean;
    /** What the provider asked for: `refund`, `check_customer`, or both (§ C-3 report body). */
    wants: string[];
    listingId: string | null;
    /** The reveal ids the provider named, as stored on the ticket. */
    revealIds: string[];
    lead: {
        listing: LeadListingSummaryDto;
        vendorId: string;
        customerId: string;
        windowStart: string | null;
        windowEnd: string | null;
        channel: string | null;
        fieldsRevealed: string[];
        createdAt: string | null;
    } | null;
    /** The named reveals that ARE on this lead, with their refund state — what the refund acts on. */
    namedReveals: LeadRevealDto[];
}

export interface TicketLeadMetadata {
    listingId?: unknown;
    wants?: unknown;
    revealIds?: unknown;
}

const stringList = (value: unknown): string[] =>
    (Array.isArray(value) ? value : []).filter((v): v is string => typeof v === 'string');

/** Only the two § C-3 values — the metadata is jovi-mall's, and an unknown token is dropped, not echoed. */
export function wantsOf(metadata: TicketLeadMetadata | null | undefined): string[] {
    return stringList(metadata?.wants).filter((w) => (LISTING_REPORT_WANTS as readonly string[]).includes(w));
}

export function revealIdsOf(metadata: TicketLeadMetadata | null | undefined): string[] {
    return stringList(metadata?.revealIds).filter((id) => /^[a-f\d]{24}$/i.test(id));
}

export function withheldTicketContext(leadId: string, metadata: TicketLeadMetadata | null | undefined): ListingLeadTicketContextDto {
    return { leadId, readable: false, wants: wantsOf(metadata), listingId: null, revealIds: [], lead: null, namedReveals: [] };
}

export function toListingLeadTicketContextDto(
    leadId: string,
    metadata: TicketLeadMetadata | null | undefined,
    lead: ListingLeadReadModel | null,
    listing: LeadListingRefReadModel | undefined,
    namedReveals: ListingRevealReadModel[],
): ListingLeadTicketContextDto {
    const metaListing = typeof metadata?.listingId === 'string' && /^[a-f\d]{24}$/i.test(metadata.listingId)
        ? metadata.listingId
        : null;
    return {
        leadId,
        readable: true,
        wants: wantsOf(metadata),
        // The lead is the authority; the metadata copy is the fallback for a lead that is gone.
        listingId: lead ? lead.listing_id.toString() : metaListing,
        revealIds: revealIdsOf(metadata),
        lead: lead
            ? {
                listing: toLeadListingSummary(lead.listing_id, listing),
                vendorId: lead.vendor_id.toString(),
                customerId: lead.customer_id.toString(),
                windowStart: toIso(lead.window_start),
                windowEnd: toIso(lead.window_end),
                channel: lead.channel ?? null,
                fieldsRevealed: lead.fields_revealed ?? [],
                createdAt: toIso(lead.created_at),
            }
            : null,
        namedReveals: namedReveals.map(toLeadRevealDto),
    };
}
