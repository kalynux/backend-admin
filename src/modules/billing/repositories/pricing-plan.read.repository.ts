import { Document, Filter, ObjectId } from 'mongodb';
import { Types } from 'mongoose';
import { containsInsensitive, toMongoSort } from '../../../core/data/mongo-list';
import { ListQueryBase } from '../../../core/http/list-query';
import { COLLECTIONS } from '../../../infra/platform/collections';
import { Paginated, PlatformReadRepository } from '../../../infra/platform/platform.repository';
import { PLAN_SORT } from '../validators/billing.validator';

/**
 * The pricing-plan catalog, read straight out of `jovi_mall`.
 *
 * ── Why this read is direct and every write is not (ADR-009 D-1, applied to money) ──
 * A plan row is a **record**: `find({ role: 'vendor' })` protects no invariant and
 * jovi-mall's own `PricingPlanRepository.list` is a query with no logic in it worth
 * calling over HTTP. Contrast the two derivations this module delegates instead — an
 * owner's *entitlements* and their *balances* — which are numbers the platform itself
 * branches on.
 *
 * Every WRITE is delegated. Creating a plan is nearly a plain insert, and it would still
 * be wrong to do here: `commission_percent` is what every future order's split multiplies
 * by, the code uniqueness is a partial index jovi-mall owns, and assigning a plan (the
 * write this catalog exists to feed) emits `plan.activated`, which resizes an agent's
 * capacity in-process. `PlatformReadRepository` has no write method, so that is not
 * something this file could break by accident.
 */

export interface PricingPlanReadModel extends Document {
    _id: ObjectId;
    role: string;
    code: string;
    name: string;
    price: number;
    currency?: string;
    /** `null` = never expires. Every role's free tier. */
    term_days?: number | null;
    credit_allowance?: number;
    max_active_products?: number | null;
    max_storage_bytes?: number | null;
    commission_percent?: number | null;
    max_unterminated_shipments?: number | null;
    /** Agent plans: the COD pool a KYC-verified agent gets. ⚠ `null` = NO COD, not unlimited. */
    max_cod_pool?: number | null;
    live_tracking_enabled?: boolean;
    is_active?: boolean;
    sort_order?: number;
    /** Soft delete. Set means archived; existing subscribers keep running on it. */
    deletedAt?: Date | null;
    created_at: Date;
    updated_at: Date;
}

/**
 * The whitelist — every field a plan screen may see, named.
 *
 * There is one projection here rather than a list/detail pair, and that is the honest
 * shape for this collection: a plan holds no field a directory row should not see. It is
 * still a whitelist rather than "everything", for the reason the base class states — a
 * column added to `pricing_plans` next year would otherwise arrive on the wire on its own.
 *
 * `deletedAt` is projected on purpose. It is what makes an archived plan legible when
 * `includeArchived` brings one back, and a row that says nothing about why it is not in
 * the default list is worse than one that does.
 */
const PLAN_PROJECTION = {
    _id: 1,
    role: 1,
    code: 1,
    name: 1,
    price: 1,
    currency: 1,
    term_days: 1,
    credit_allowance: 1,
    max_active_products: 1,
    max_storage_bytes: 1,
    commission_percent: 1,
    max_unterminated_shipments: 1,
    max_cod_pool: 1,
    live_tracking_enabled: 1,
    is_active: 1,
    sort_order: 1,
    deletedAt: 1,
    created_at: 1,
    updated_at: 1,
} as const;

export interface PlanSearchQuery extends ListQueryBase {
    role?: string;
    isActive?: boolean;
    /** Whether soft-deleted plans are in scope. Defaulted by the schema, never here. */
    includeArchived: boolean;
    search?: string;
}

export class PricingPlanReadRepository extends PlatformReadRepository<PricingPlanReadModel> {
    constructor() {
        super(COLLECTIONS.PRICING_PLAN, PLAN_PROJECTION);
    }

    async search(query: PlanSearchQuery): Promise<Paginated<PricingPlanReadModel>> {
        return this.findPage(buildPlanFilter(query), {
            page: query.page,
            limit: query.limit,
            sort: toMongoSort(query.sort, PLAN_SORT),
        });
    }

    /**
     * One plan — **archived rows included**.
     *
     * jovi-mall's own `findById` filters `deletedAt: null`, which is right for the paths
     * that are about to act on a plan: you may not assign or edit an archived tier. It is
     * wrong for an administrative detail view, whose whole job is to answer "what did this
     * plan hold" about a row somebody's subscription still points at. The DTO carries
     * `archivedAt`, so nothing reads an archived plan as live.
     */
    async findById(planId: string): Promise<PricingPlanReadModel | null> {
        if (!Types.ObjectId.isValid(planId)) return null;
        return this.findOneBy({ _id: new ObjectId(planId) } as Filter<PricingPlanReadModel>);
    }

    /**
     * Plan names for a page of subscriptions, batched — one query, not one per row.
     *
     * Archived plans are included for the same reason as above: a subscription assigned
     * before its tier was archived still names it, and dropping the row here would render
     * that subscription with a blank plan.
     */
    async findRefsByIds(ids: ObjectId[]): Promise<Map<string, PlanRef>> {
        if (ids.length === 0) return new Map();

        const rows = await this.findBy(
            { _id: { $in: ids } } as Filter<PricingPlanReadModel>,
            { projection: { _id: 1, code: 1, name: 1, role: 1 }, limit: ids.length },
        );

        return new Map(
            rows.map((row) => [
                row._id.toString(),
                { id: row._id.toString(), code: row.code ?? null, name: row.name ?? null, role: row.role ?? null },
            ]),
        );
    }
}

/** How a subscription names the plan it points at, without a join at render time. */
export interface PlanRef {
    id: string;
    code: string | null;
    name: string | null;
    role: string | null;
}

/**
 * Built here rather than in the controller so the archive scope cannot be dropped by a
 * caller, and exported so `test-billing.ts` can assert the branches without a database.
 */
export function buildPlanFilter(query: PlanSearchQuery): Filter<PricingPlanReadModel> {
    const clauses: Record<string, unknown>[] = [];

    // First, and unconditionally unless asked otherwise. An archived plan is still a row
    // in this collection; a default list that showed them would report tiers nobody can
    // buy beside the ones they can.
    if (!query.includeArchived) clauses.push({ deletedAt: null });

    if (query.role) clauses.push({ role: query.role });
    if (query.isActive !== undefined) clauses.push({ is_active: query.isActive });

    const search = query.search?.trim();
    if (search) clauses.push(planSearchClause(search));

    // Reachable: `includeArchived=true` with no other filter is "the whole catalog".
    // `{ $and: [] }` is not an empty filter — Mongo refuses it at query time.
    if (clauses.length === 0) return {} as Filter<PricingPlanReadModel>;
    if (clauses.length === 1) return clauses[0] as Filter<PricingPlanReadModel>;

    /**
     * `$and`, not `Object.assign`. The search clause is an `$or`, and merging two
     * `$or`-shaped filters by assignment silently drops the earlier one — which here
     * would mean a search that quietly includes archived plans.
     */
    return { $and: clauses } as Filter<PricingPlanReadModel>;
}

/**
 * Match the plan code, the display name — or the plan id.
 *
 * The id branch matters for the same reason it does on every other directory here: a
 * subscription row names a plan by id, so pasting one into the only search box is the
 * obvious move, and a catalog that answers "no results" to a valid id looks broken.
 *
 * `containsInsensitive` escapes the term before it reaches `$regex`. An unescaped one is
 * both a correctness bug (`a.b` matching `axb`) and a catastrophic-backtracking pattern
 * supplied by the caller.
 */
function planSearchClause(term: string): Record<string, unknown> {
    const pattern = containsInsensitive(term);
    const branches: Record<string, unknown>[] = [{ code: pattern }, { name: pattern }];

    if (Types.ObjectId.isValid(term) && term.length === 24) {
        branches.push({ _id: new ObjectId(term) });
    }

    return { $or: branches };
}
