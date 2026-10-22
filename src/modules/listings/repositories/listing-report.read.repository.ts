import { Document, Filter, ObjectId } from 'mongodb';
import { toMongoSort } from '../../../core/data/mongo-list';
import { COLLECTIONS } from '../../../infra/platform/collections';
import { Paginated, PlatformReadRepository } from '../../../infra/platform/platform.repository';
import { LISTING_LEAD_SORT, ListListingLeadsQuery } from '../validators/listing-reports.validator';

/**
 * What the lead-report screens read (L-25, L-29, L-31): a listing's leads, the reveals on each,
 * the blocks, the opt-ins, and WHO the customer behind a lead really is.
 *
 * Read directly, written never (ADR-004 D-2). Every one of these rows is written by jovi-mall
 * inside the reveal transaction, the refund or the block; a second writer would move a row and
 * skip the ledger entry, the auto-resume or the neutral refusal that make it mean something.
 *
 * ── Administrators see what the provider cannot (L-31) ───────────────────────
 * The provider sees a lead masked — first name, last initial, two digits of the number (L-13).
 * A drain (L-29) is spotted by an administrator looking at the REAL numbers, so the customer
 * projection below carries the full login phone and e-mail. That is the customer's identity,
 * not the provider's contacts:
 *
 * ⛔ **No PROVIDER contact value is read here, and none could be.** The provider's WhatsApp,
 * phone, email, links, pin and video live in `listing_contacts`, which only
 * `listing-contact.read.repository.ts` reads (`test:listings` § 6). A reveal row carries the
 * FIELD NAME and a sha256 `value_fingerprint` — and the fingerprint is not projected either:
 * it answers no administrator's question, and a hash of a phone number is still a lookup key.
 *
 * Several small repositories in one file, matching `listing-context.read.repository.ts`: each
 * is bound to its own collection with its own whitelist projection.
 */

const asIds = (values: readonly ObjectId[]): ObjectId[] => {
    const seen = new Map<string, ObjectId>();
    for (const value of values) seen.set(value.toString(), value);
    return [...seen.values()];
};

// ─── Leads ───────────────────────────────────────────────────────────────────

export interface ListingLeadReadModel extends Document {
    _id: ObjectId;
    customer_id: ObjectId;
    listing_id: ObjectId;
    vendor_id: ObjectId;
    window_start: Date;
    window_end: Date;
    engaged_while_live?: boolean;
    fields_revealed?: string[];
    channel?: string;
    created_at: Date;
}

export const LISTING_LEAD_PROJECTION = {
    _id: 1,
    customer_id: 1,
    listing_id: 1,
    vendor_id: 1,
    window_start: 1,
    window_end: 1,
    engaged_while_live: 1,
    fields_revealed: 1,
    channel: 1,
    created_at: 1,
} as const;

/** One provider's share of a customer's other leads — the drain-detection rollup (L-29). */
export interface LeadsByProviderRow extends Document {
    _id: ObjectId;
    leads: number;
    firstAt: Date;
    lastAt: Date;
}

export class ListingLeadReadRepository extends PlatformReadRepository<ListingLeadReadModel> {
    constructor() {
        super(COLLECTIONS.LISTING_LEAD, LISTING_LEAD_PROJECTION);
    }

    async findById(leadId: string): Promise<ListingLeadReadModel | null> {
        if (!ObjectId.isValid(leadId)) return null;
        return this.findOneBy({ _id: new ObjectId(leadId) } as Filter<ListingLeadReadModel>);
    }

    /**
     * One listing's leads. Filtered on `vendor_id` as well as `listing_id`: the listing id
     * alone has no index whose prefix it is, and `listing_lead_vendor_recent`
     * `{ vendor_id: 1, created_at: -1 }` serves the default newest-first page.
     */
    async pageForListing(
        vendorId: ObjectId,
        listingId: ObjectId,
        query: ListListingLeadsQuery,
    ): Promise<Paginated<ListingLeadReadModel>> {
        return this.findPage({ vendor_id: vendorId, listing_id: listingId } as Filter<ListingLeadReadModel>, {
            page: query.page,
            limit: query.limit,
            sort: toMongoSort(query.sort, LISTING_LEAD_SORT),
        });
    }

    /** The customer's OTHER leads, newest first — `listing_lead_current` leads with `customer_id`. */
    async othersOfCustomer(customerId: ObjectId, exceptLeadId: ObjectId, limit: number): Promise<{
        total: number;
        items: ListingLeadReadModel[];
        byProvider: LeadsByProviderRow[];
    }> {
        const filter = { customer_id: customerId, _id: { $ne: exceptLeadId } } as Filter<ListingLeadReadModel>;
        const [total, items, byProvider] = await Promise.all([
            this.countBy(filter),
            this.findBy(filter, { sort: { created_at: -1, _id: -1 }, limit }),
            this.aggregateBy<LeadsByProviderRow>([
                { $match: filter },
                {
                    $group: {
                        _id: '$vendor_id',
                        leads: { $sum: 1 },
                        firstAt: { $min: '$created_at' },
                        lastAt: { $max: '$created_at' },
                    },
                },
                { $sort: { lastAt: -1, _id: -1 } },
                { $limit: limit },
            ]),
        ]);
        return { total, items, byProvider };
    }
}

// ─── Reveals — the money records ─────────────────────────────────────────────

export interface ListingRevealReadModel extends Document {
    _id: ObjectId;
    lead_id: ObjectId;
    listing_id: ObjectId;
    vendor_id: ObjectId;
    customer_id: ObjectId;
    field: string;
    cost: number;
    charged_into_debt?: boolean;
    ledger_ref?: string | null;
    refund?: {
        at?: Date;
        by_user_id?: ObjectId | null;
        by_source?: 'platform' | 'admin';
        by_name?: string | null;
        ticket_id?: ObjectId | null;
        ledger_ref?: string;
        note?: string | null;
    } | null;
    at: Date;
}

/** ⚠ `value_fingerprint` is deliberately absent — see the file header. */
export const LISTING_REVEAL_PROJECTION = {
    _id: 1,
    lead_id: 1,
    listing_id: 1,
    vendor_id: 1,
    customer_id: 1,
    field: 1,
    cost: 1,
    charged_into_debt: 1,
    ledger_ref: 1,
    'refund.at': 1,
    'refund.by_user_id': 1,
    'refund.by_source': 1,
    'refund.by_name': 1,
    'refund.ticket_id': 1,
    'refund.ledger_ref': 1,
    'refund.note': 1,
    at: 1,
} as const;

export class ListingRevealReadRepository extends PlatformReadRepository<ListingRevealReadModel> {
    constructor() {
        super(COLLECTIONS.LISTING_REVEAL, LISTING_REVEAL_PROJECTION);
    }

    async findById(revealId: string): Promise<ListingRevealReadModel | null> {
        if (!ObjectId.isValid(revealId)) return null;
        return this.findOneBy({ _id: new ObjectId(revealId) } as Filter<ListingRevealReadModel>);
    }

    /** Every reveal of a page of leads, in reveal order — `listing_reveal_one_per_field` leads with `lead_id`. */
    async findByLeadIds(leadIds: ObjectId[]): Promise<Map<string, ListingRevealReadModel[]>> {
        const byLead = new Map<string, ListingRevealReadModel[]>();
        if (leadIds.length === 0) return byLead;
        const rows = await this.findBy(
            { lead_id: { $in: asIds(leadIds) } } as Filter<ListingRevealReadModel>,
            { sort: { at: 1, _id: 1 } },
        );
        for (const row of rows) {
            const key = row.lead_id.toString();
            if (!byLead.has(key)) byLead.set(key, []);
            byLead.get(key)!.push(row);
        }
        return byLead;
    }

    /**
     * The reveals a provider NAMED in a report, kept to the ones actually on that lead. The
     * provider typed these ids; jovi-mall refuses a report naming reveals off the lead
     * (`LISTING_REPORT_INVALID`), and this filter is the second lock — a stray id resolves to
     * nothing rather than to somebody else's money record.
     */
    async findNamedOnLead(leadId: ObjectId, revealIds: readonly string[]): Promise<ListingRevealReadModel[]> {
        const ids = revealIds.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id));
        if (ids.length === 0) return [];
        return this.findBy(
            { _id: { $in: asIds(ids) }, lead_id: leadId } as Filter<ListingRevealReadModel>,
            { sort: { at: 1, _id: 1 }, limit: ids.length },
        );
    }
}

// ─── Blocks (L-29) ───────────────────────────────────────────────────────────

export interface ListingRevealBlockReadModel extends Document {
    _id: ObjectId;
    customer_id: ObjectId;
    listing_id: ObjectId;
    vendor_id: ObjectId;
    reason: string;
    ticket_id?: ObjectId | null;
    blocked_at: Date;
    blocked_by_user_id?: ObjectId | null;
    blocked_by_source?: 'platform' | 'admin';
    blocked_by_name?: string | null;
    lifted_at?: Date | null;
}

export const LISTING_REVEAL_BLOCK_PROJECTION = {
    _id: 1,
    customer_id: 1,
    listing_id: 1,
    vendor_id: 1,
    reason: 1,
    ticket_id: 1,
    blocked_at: 1,
    blocked_by_user_id: 1,
    blocked_by_source: 1,
    blocked_by_name: 1,
    lifted_at: 1,
} as const;

export class ListingRevealBlockReadRepository extends PlatformReadRepository<ListingRevealBlockReadModel> {
    constructor() {
        super(COLLECTIONS.LISTING_REVEAL_BLOCK, LISTING_REVEAL_BLOCK_PROJECTION);
    }

    /**
     * The ACTIVE block per customer on one listing, keyed by customer id. `lifted_at: null` is
     * in the filter so `listing_reveal_block_one_active` — partial on exactly that — serves it.
     */
    async activeOn(listingId: ObjectId, customerIds: ObjectId[]): Promise<Map<string, ListingRevealBlockReadModel>> {
        if (customerIds.length === 0) return new Map();
        const ids = asIds(customerIds);
        const rows = await this.findBy(
            { customer_id: { $in: ids }, listing_id: listingId, lifted_at: null } as Filter<ListingRevealBlockReadModel>,
            { limit: ids.length },
        );
        return new Map(rows.map((row) => [row.customer_id.toString(), row]));
    }
}

// ─── Opt-ins (L-14) ──────────────────────────────────────────────────────────

export interface ProviderConsentReadModel extends Document {
    _id: ObjectId;
    customer_id: ObjectId;
    vendor_id: ObjectId;
    asked_at?: Date | null;
    granted_at?: Date | null;
    revoked_at?: Date | null;
    source?: string;
}

export const PROVIDER_CONSENT_PROJECTION = {
    _id: 1,
    customer_id: 1,
    vendor_id: 1,
    asked_at: 1,
    granted_at: 1,
    revoked_at: 1,
    source: 1,
} as const;

export class ProviderConsentReadRepository extends PlatformReadRepository<ProviderConsentReadModel> {
    constructor() {
        super(COLLECTIONS.PROVIDER_CONTACT_CONSENT, PROVIDER_CONSENT_PROJECTION);
    }

    /** Each customer's opt-in toward ONE provider — `provider_consent_one_per_pair`. */
    async towardProvider(vendorId: ObjectId, customerIds: ObjectId[]): Promise<Map<string, ProviderConsentReadModel>> {
        if (customerIds.length === 0) return new Map();
        const ids = asIds(customerIds);
        const rows = await this.findBy(
            { customer_id: { $in: ids }, vendor_id: vendorId } as Filter<ProviderConsentReadModel>,
            { limit: ids.length },
        );
        return new Map(rows.map((row) => [row.customer_id.toString(), row]));
    }
}

// ─── Who the customer is ─────────────────────────────────────────────────────

/**
 * The customer PROFILE behind a lead. `listing_leads.customer_id` is a `customers._id`
 * (`ref: MODELS.CUSTOMER`, § C-2) — not a `users._id` — so the account is reached through
 * `user_id`.
 *
 * Name, status and creation instant only. `customers` also carries `saved_addresses` (with
 * geocoded coordinates of a home) and `saved_payment_methods`; none of it answers "who is
 * this", and none of it is projected.
 */
export interface LeadCustomerReadModel extends Document {
    _id: ObjectId;
    user_id?: ObjectId;
    name?: string | null;
    status?: string;
    created_at?: Date;
}

export const LEAD_CUSTOMER_PROJECTION = {
    _id: 1,
    user_id: 1,
    name: 1,
    status: 1,
    created_at: 1,
} as const;

export class LeadCustomerReadRepository extends PlatformReadRepository<LeadCustomerReadModel> {
    constructor() {
        super(COLLECTIONS.CUSTOMER, LEAD_CUSTOMER_PROJECTION);
    }

    async findByIds(ids: ObjectId[]): Promise<Map<string, LeadCustomerReadModel>> {
        if (ids.length === 0) return new Map();
        const unique = asIds(ids);
        const rows = await this.findBy({ _id: { $in: unique } } as Filter<LeadCustomerReadModel>, { limit: unique.length });
        return new Map(rows.map((row) => [row._id.toString(), row]));
    }
}

/**
 * The ACCOUNT behind a customer profile — the full login phone and e-mail (L-31: what the
 * provider cannot see), the roles held, and when the account was made. The same three fields
 * of `users` the support screen's actor resolver reads, plus the account's own dates.
 *
 * Never `password_hash`: a whitelist, like every projection of `users` on this service.
 */
export interface LeadAccountReadModel extends Document {
    _id: ObjectId;
    login_phone?: string | null;
    login_email?: string | null;
    roles?: string[];
    status?: string;
    closed_at?: Date | null;
    created_at?: Date;
}

export const LEAD_ACCOUNT_PROJECTION = {
    _id: 1,
    login_phone: 1,
    login_email: 1,
    roles: 1,
    status: 1,
    closed_at: 1,
    created_at: 1,
} as const;

export class LeadAccountReadRepository extends PlatformReadRepository<LeadAccountReadModel> {
    constructor() {
        super(COLLECTIONS.USER, LEAD_ACCOUNT_PROJECTION);
    }

    async findByIds(ids: ObjectId[]): Promise<Map<string, LeadAccountReadModel>> {
        if (ids.length === 0) return new Map();
        const unique = asIds(ids);
        const rows = await this.findBy({ _id: { $in: unique } } as Filter<LeadAccountReadModel>, { limit: unique.length });
        return new Map(rows.map((row) => [row._id.toString(), row]));
    }
}

// ─── Listing names, for a customer's other leads ─────────────────────────────

/** Just enough of a listing to name it in a list — public names, never content. */
export interface LeadListingRefReadModel extends Document {
    _id: ObjectId;
    vendor_id: ObjectId;
    slug?: string;
    status?: string;
    published?: { title?: string; company_name?: string } | null;
    pending?: { title?: string; company_name?: string } | null;
}

export const LEAD_LISTING_REF_PROJECTION = {
    _id: 1,
    vendor_id: 1,
    slug: 1,
    status: 1,
    'published.title': 1,
    'published.company_name': 1,
    'pending.title': 1,
    'pending.company_name': 1,
} as const;

export class LeadListingRefReadRepository extends PlatformReadRepository<LeadListingRefReadModel> {
    constructor() {
        super(COLLECTIONS.LISTING, LEAD_LISTING_REF_PROJECTION);
    }

    async findByIds(ids: ObjectId[]): Promise<Map<string, LeadListingRefReadModel>> {
        if (ids.length === 0) return new Map();
        const unique = asIds(ids);
        const rows = await this.findBy({ _id: { $in: unique } } as Filter<LeadListingRefReadModel>, { limit: unique.length });
        return new Map(rows.map((row) => [row._id.toString(), row]));
    }
}
