import { Document, Filter, ObjectId } from 'mongodb';
import { escapeRegex, toMongoSort } from '../../../core/data/mongo-list';
import { COLLECTIONS } from '../../../infra/platform/collections';
import { Paginated, PlatformReadRepository } from '../../../infra/platform/platform.repository';
import {
    ListPartnersQuery,
    ListReferredQuery,
    ListRewardsQuery,
    REFERRAL_PARTNER_SORT,
    REFERRAL_RELATIONSHIP_SORT,
    REFERRAL_REWARD_SORT,
} from '../validators/referral.validator';

/**
 * The referral program, read directly (ADR-004 D-2: direct read, delegated write).
 *
 * ⚠ **`payout_details` is NOT projected.** A partner's own destination is a real phone number, and
 * reading one is the audited `money.payouts.destination.read` act on the payout queue. Nothing here
 * opens a second door onto it.
 */

export interface ReferralSettingsReadModel extends Document {
    enabled: boolean;
    terms: Record<string, { rate_percent: number; duration_months: number }>;
    min_payout_amount: number;
    reward_wait_days: number;
    updated_at?: Date | null;
    updated_by_name?: string | null;
}

export interface ReferralStatusChangeReadModel {
    from: string | null;
    to: string;
    at: Date;
    actor_name: string | null;
    actor_source?: string | null;
    reason: string | null;
}

export interface ReferralPartnerReadModel extends Document {
    _id: ObjectId;
    user_id: ObjectId;
    applied_as_role: string;
    status: string;
    code?: string | null;
    motivation?: string | null;
    terms_accepted_at?: Date | null;
    applied_at: Date;
    approved_at?: Date | null;
    status_reason?: string | null;
    can_reapply?: boolean;
    balance_released?: { at: Date; actor_name?: string | null; reason: string } | null;
    custom_terms?: Record<string, { rate_percent?: number | null; duration_months?: number | null } | null> | null;
    status_history?: ReferralStatusChangeReadModel[];
    created_at: Date;
}

export interface ReferralRelationshipReadModel extends Document {
    _id: ObjectId;
    partner_id: ObjectId;
    referred_user_id: ObjectId;
    category: string;
    code_used: string;
    channel: string;
    registered_at: Date;
    expires_at?: Date | null;
}

export interface ReferralRewardReadModel extends Document {
    _id: ObjectId;
    partner_id: ObjectId;
    relationship_id: ObjectId;
    referred_user_id: ObjectId;
    category: string;
    /** Null on a provider reward (2026-11-08): its source is a plan purchase or a credit top-up. */
    commission_allocation_id: ObjectId | null;
    source_type: string;
    source_id: ObjectId;
    order_id?: ObjectId | null;
    booking_id?: ObjectId | null;
    vendor_id: ObjectId;
    commission_earned: number;
    share: { numerator: number; denominator: number };
    rate_percent: number;
    rate_source: string;
    amount: number;
    clawed_amount: number;
    currency: string;
    status: string;
    earned_at: Date;
    matures_at: Date;
    released_at?: Date | null;
    reversed_at?: Date | null;
    adjustments?: Array<{
        at: Date;
        refund_key?: string | null;
        commission_retained: number;
        amount_before: number;
        amount_after: number;
    }>;
}

export interface ReferralWalletReadModel extends Document {
    owner_id: ObjectId;
    currency: string;
    pending_balance: number;
    available_balance: number;
    requested_balance: number;
    clawback_balance?: number;
}

export class ReferralSettingsReadRepository extends PlatformReadRepository<ReferralSettingsReadModel> {
    constructor() {
        super(COLLECTIONS.REFERRAL_SETTINGS, {
            enabled: 1,
            terms: 1,
            min_payout_amount: 1,
            reward_wait_days: 1,
            updated_at: 1,
            updated_by_name: 1,
        });
    }

    async find(): Promise<ReferralSettingsReadModel | null> {
        return this.findOneBy({ key: 'global' } as Filter<ReferralSettingsReadModel>);
    }
}

export class ReferralPartnerReadRepository extends PlatformReadRepository<ReferralPartnerReadModel> {
    constructor() {
        super(COLLECTIONS.REFERRAL_PARTNER, {
            user_id: 1,
            applied_as_role: 1,
            status: 1,
            code: 1,
            motivation: 1,
            terms_accepted_at: 1,
            applied_at: 1,
            approved_at: 1,
            status_reason: 1,
            can_reapply: 1,
            balance_released: 1,
            custom_terms: 1,
            status_history: 1,
            created_at: 1,
        });
    }

    async findById(id: string): Promise<ReferralPartnerReadModel | null> {
        return this.findOneBy({ _id: new ObjectId(id) } as Filter<ReferralPartnerReadModel>);
    }

    async search(query: ListPartnersQuery, userIds: ObjectId[]): Promise<Paginated<ReferralPartnerReadModel>> {
        return this.findPage(buildPartnerFilter(query, userIds) as Filter<ReferralPartnerReadModel>, {
            page: query.page,
            limit: query.limit,
            sort: toMongoSort(query.sort, REFERRAL_PARTNER_SORT),
        });
    }

    async countsByStatus(): Promise<Record<string, number>> {
        const rows = await this.aggregateBy<{ _id: string; count: number }>([
            { $group: { _id: '$status', count: { $sum: 1 } } },
        ]);
        return Object.fromEntries(rows.map((row) => [row._id, row.count]));
    }

    /** Partner id → code, which is how a partner is named on the money screens. */
    async findCodesByIds(ids: ObjectId[]): Promise<Map<string, string | null>> {
        if (ids.length === 0) return new Map();
        const rows = await this.findBy({ _id: { $in: ids } } as Filter<ReferralPartnerReadModel>, { limit: ids.length });
        return new Map(rows.map((row) => [row._id.toString(), row.code ?? null]));
    }
}

/** Pure and exported, so the suite can pin it. A term that matches nobody returns nobody. */
export function buildPartnerFilter(query: Pick<ListPartnersQuery, 'status' | 'search'>, userIds: ObjectId[]): Record<string, unknown> {
    const filter: Record<string, unknown> = {};
    if (query.status) filter.status = query.status;
    if (query.search) {
        const branches: Record<string, unknown>[] = [
            { code: new RegExp(`^${escapeRegex(query.search.toUpperCase())}`) },
        ];
        if (userIds.length > 0) branches.push({ user_id: { $in: userIds } });
        filter.$or = branches;
    }
    return filter;
}

export class ReferralRelationshipReadRepository extends PlatformReadRepository<ReferralRelationshipReadModel> {
    constructor() {
        super(COLLECTIONS.REFERRAL_RELATIONSHIP, {
            partner_id: 1,
            referred_user_id: 1,
            category: 1,
            code_used: 1,
            channel: 1,
            registered_at: 1,
            expires_at: 1,
        });
    }

    async listForPartner(partnerId: string, query: ListReferredQuery): Promise<Paginated<ReferralRelationshipReadModel>> {
        const filter: Record<string, unknown> = { partner_id: new ObjectId(partnerId) };
        if (query.category) filter.category = query.category;
        return this.findPage(filter as Filter<ReferralRelationshipReadModel>, {
            page: query.page,
            limit: query.limit,
            sort: toMongoSort(query.sort, REFERRAL_RELATIONSHIP_SORT),
        });
    }

    async countForPartner(partnerId: ObjectId, onlyEarning = false): Promise<number> {
        const filter: Record<string, unknown> = { partner_id: partnerId };
        if (onlyEarning) filter.expires_at = { $gt: new Date() };
        return this.countBy(filter as Filter<ReferralRelationshipReadModel>);
    }

    /** Who referred this account, if anybody: the question a ticket about a referred account asks. */
    async findByReferredUser(userId: ObjectId): Promise<ReferralRelationshipReadModel | null> {
        return this.findOneBy({ referred_user_id: userId } as Filter<ReferralRelationshipReadModel>);
    }
}

export class ReferralRewardReadRepository extends PlatformReadRepository<ReferralRewardReadModel> {
    constructor() {
        super(COLLECTIONS.REFERRAL_REWARD, {
            partner_id: 1,
            relationship_id: 1,
            referred_user_id: 1,
            category: 1,
            commission_allocation_id: 1,
            source_type: 1,
            source_id: 1,
            order_id: 1,
            booking_id: 1,
            vendor_id: 1,
            commission_earned: 1,
            share: 1,
            rate_percent: 1,
            rate_source: 1,
            amount: 1,
            clawed_amount: 1,
            currency: 1,
            status: 1,
            earned_at: 1,
            matures_at: 1,
            released_at: 1,
            reversed_at: 1,
            adjustments: 1,
        });
    }

    async search(query: ListRewardsQuery, partnerId?: string): Promise<Paginated<ReferralRewardReadModel>> {
        return this.findPage(buildRewardFilter(query, partnerId) as Filter<ReferralRewardReadModel>, {
            page: query.page,
            limit: query.limit,
            sort: toMongoSort(query.sort, REFERRAL_REWARD_SORT),
        });
    }

    async findById(id: string): Promise<ReferralRewardReadModel | null> {
        return this.findOneBy({ _id: new ObjectId(id) } as Filter<ReferralRewardReadModel>);
    }

    /** Every referred account that generated a reward on one commission (document § 16). */
    async findForCommission(allocationId: ObjectId): Promise<ReferralRewardReadModel[]> {
        return this.findBy({ commission_allocation_id: allocationId } as Filter<ReferralRewardReadModel>, { limit: 50 });
    }

    /**
     * Every reward on one provider payment (2026-11-08). ⚠ Never `findForCommission(null)`: that
     * matches every provider reward on the platform.
     */
    async findForPayment(sourceType: string, sourceId: ObjectId): Promise<ReferralRewardReadModel[]> {
        return this.findBy({ source_type: sourceType, source_id: sourceId } as Filter<ReferralRewardReadModel>, { limit: 50 });
    }

    /**
     * What the program costs. A cost, not a share of anything: it is never subtracted from the
     * commission rows, so vendor statements and order splits are unaffected.
     */
    async totals(from?: Date, to?: Date, partnerId?: ObjectId): Promise<Array<{ currency: string; status: string; amount: number; count: number }>> {
        const match: Record<string, unknown> = {};
        if (partnerId) match.partner_id = partnerId;
        if (from || to) {
            match.earned_at = { ...(from ? { $gte: from } : {}), ...(to ? { $lt: to } : {}) };
        }
        const rows = await this.aggregateBy<{ _id: { currency: string; status: string }; amount: number; count: number }>([
            { $match: match },
            {
                $group: {
                    _id: { currency: '$currency', status: '$status' },
                    amount: { $sum: { $subtract: ['$amount', '$clawed_amount'] } },
                    count: { $sum: 1 },
                },
            },
        ]);
        return rows.map((row) => ({ currency: row._id.currency, status: row._id.status, amount: row.amount, count: row.count }));
    }

    /** Earned per relationship, for one page of referred accounts. */
    async earnedByRelationship(ids: ObjectId[]): Promise<Map<string, number>> {
        if (ids.length === 0) return new Map();
        const rows = await this.aggregateBy<{ _id: ObjectId; total: number }>([
            { $match: { relationship_id: { $in: ids } } },
            { $group: { _id: '$relationship_id', total: { $sum: { $subtract: ['$amount', '$clawed_amount'] } } } },
        ]);
        return new Map(rows.map((row) => [row._id.toString(), row.total]));
    }
}

export function buildRewardFilter(
    query: Pick<ListRewardsQuery, 'status' | 'category' | 'orderId' | 'bookingId' | 'from' | 'to'>,
    partnerId?: string,
): Record<string, unknown> {
    const filter: Record<string, unknown> = {};
    if (partnerId) filter.partner_id = new ObjectId(partnerId);
    if (query.status) filter.status = query.status;
    if (query.category) filter.category = query.category;
    if (query.orderId) filter.order_id = new ObjectId(query.orderId);
    if (query.bookingId) filter.booking_id = new ObjectId(query.bookingId);
    if (query.from || query.to) {
        filter.earned_at = { ...(query.from ? { $gte: query.from } : {}), ...(query.to ? { $lt: query.to } : {}) };
    }
    return filter;
}

export class ReferralWalletReadRepository extends PlatformReadRepository<ReferralWalletReadModel> {
    constructor() {
        super(COLLECTIONS.EARNINGS_ACCOUNT, {
            owner_id: 1,
            currency: 1,
            pending_balance: 1,
            available_balance: 1,
            requested_balance: 1,
            clawback_balance: 1,
        });
    }

    async findByPartners(ids: ObjectId[]): Promise<Map<string, ReferralWalletReadModel>> {
        if (ids.length === 0) return new Map();
        const rows = await this.findBy(
            { owner_type: 'referral_partner', owner_id: { $in: ids } } as Filter<ReferralWalletReadModel>,
            { limit: ids.length },
        );
        return new Map(rows.map((row) => [row.owner_id.toString(), row]));
    }
}

interface NamedRow extends Document {
    user_id?: ObjectId | null;
    name?: string | null;
    display_name?: string | null;
}

class RoleNameReader extends PlatformReadRepository<NamedRow> {
    constructor(collection: typeof COLLECTIONS.CUSTOMER | typeof COLLECTIONS.VENDOR | typeof COLLECTIONS.DELIVERY_AGENCY | typeof COLLECTIONS.DELIVERY_AGENT) {
        super(collection, { user_id: 1, name: 1, display_name: 1 });
    }

    async byUsers(ids: ObjectId[]): Promise<NamedRow[]> {
        return this.findBy({ user_id: { $in: ids } } as Filter<NamedRow>, { limit: ids.length });
    }
}

interface UserRow extends Document {
    _id: ObjectId;
    login_phone?: string | null;
    login_email?: string | null;
}

class UserContactReader extends PlatformReadRepository<UserRow> {
    constructor() {
        super(COLLECTIONS.USER, { login_phone: 1, login_email: 1 });
    }

    async byIds(ids: ObjectId[]): Promise<UserRow[]> {
        return this.findBy({ _id: { $in: ids } } as Filter<UserRow>, { limit: ids.length });
    }

    async idsMatching(term: string): Promise<ObjectId[]> {
        const anchored = new RegExp(`^${escapeRegex(term)}`, 'i');
        const rows = await this.findBy(
            { $or: [{ login_phone: anchored }, { login_email: anchored }] } as Filter<UserRow>,
            { limit: 50, projection: { _id: 1 } },
        );
        return rows.map((row) => row._id);
    }
}

export interface ReferralPerson {
    name: string | null;
    phone: string | null;
    email: string | null;
}

/** Who a user id is, for administrators. The name comes from whichever role profile holds one. */
export class ReferralPeopleReadRepository {
    private readonly readers = [
        new RoleNameReader(COLLECTIONS.CUSTOMER),
        new RoleNameReader(COLLECTIONS.VENDOR),
        new RoleNameReader(COLLECTIONS.DELIVERY_AGENCY),
        new RoleNameReader(COLLECTIONS.DELIVERY_AGENT),
    ];
    private readonly users = new UserContactReader();

    async findByUserIds(ids: ObjectId[]): Promise<Map<string, ReferralPerson>> {
        const unique = [...new Set(ids.map(String))].map((id) => new ObjectId(id));
        if (unique.length === 0) return new Map();
        const [users, ...named] = await Promise.all([
            this.users.byIds(unique),
            ...this.readers.map((reader) => reader.byUsers(unique)),
        ]);
        const names = new Map<string, string>();
        for (const rows of named as NamedRow[][]) {
            for (const row of rows) {
                const name = row.name ?? row.display_name;
                if (row.user_id && name && !names.has(row.user_id.toString())) names.set(row.user_id.toString(), name);
            }
        }
        return new Map(
            (users as UserRow[]).map((user) => [
                user._id.toString(),
                { name: names.get(user._id.toString()) ?? null, phone: user.login_phone ?? null, email: user.login_email ?? null },
            ]),
        );
    }

    async idsMatching(term: string): Promise<ObjectId[]> {
        return this.users.idsMatching(term);
    }
}
