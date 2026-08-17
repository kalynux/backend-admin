import { Document, Filter, ObjectId } from 'mongodb';
import { Types } from 'mongoose';
import { toMongoSort } from '../../../core/data/mongo-list';
import { ListQueryBase } from '../../../core/http/list-query';
import { COLLECTIONS } from '../../../infra/platform/collections';
import { Paginated, PlatformReadRepository } from '../../../infra/platform/platform.repository';
import { SUBSCRIPTION_SORT } from '../validators/billing.validator';

/**
 * An owner's assignment to a plan — `subscriber_plans`, read directly.
 *
 * A record again, and the one that answers two questions the platform could not answer
 * about itself before this phase: **who is on this plan** (asked immediately before
 * editing its commission) and **whose term is about to lapse**. jovi-mall's own reads of
 * this collection are all single-owner — `findByOwnerAndStatus` — because that is the only
 * shape its own paths need; there was no cross-owner query anywhere.
 *
 * ── The indexes this read needed ──────────────────────────────────────────────
 * `subscriber_plans` declared three: the two partial uniques that enforce "at most one
 * active and one pending per owner", and `{status: 1, expires_at: 1}` for the expiry
 * worker. The third serves the expiring-soon queue as it stands. The two lists added here
 * page by recency, so `{plan_id: 1, created_at: -1}` and `{created_at: -1}` were added to
 * `subscriber-plan.model.ts` in the same change — the Phase 9 precedent, where
 * `delivery_agencies` had none at all before its directory existed.
 */

export interface SubscriberPlanReadModel extends Document {
    _id: ObjectId;
    owner_type: string;
    owner_id: ObjectId;
    plan_id: ObjectId;
    /** Denormalised by jovi-mall so an entitlement read needs no populate. */
    plan_code?: string | null;
    status: string;
    started_at?: Date | null;
    /** `null` on the never-expiring free tier — see `buildSubscriptionFilter`. */
    expires_at?: Date | null;
    assigned_by?: ObjectId | null;
    /** Which identity space `assigned_by` belongs to. `admin` ids resolve in neither. */
    assigned_by_source?: string;
    assigned_by_name?: string | null;
    payment_reference?: string | null;
    allowance_granted?: boolean;
    created_at: Date;
    updated_at: Date;
}

/**
 * The whitelist. One projection, because a subscription row holds nothing a list may see
 * and a detail may not — there is no detail endpoint for one, deliberately: the account
 * view (Phase 11 step 7) is where a single owner's subscription is read in context.
 *
 * `payment_reference` is projected and it is worth stating why it is not sensitive: it is
 * a gateway TRANSACTION reference, the string an operator quotes when reconciling a bank
 * statement. It is not a payment credential, and nothing can be charged with it. The
 * fields that are — MSISDNs, account numbers, gateway tokens — live on `payout_requests`
 * and `user_payment_methods`, neither of which this repository can be pointed at.
 */
const SUBSCRIPTION_PROJECTION = {
    _id: 1,
    owner_type: 1,
    owner_id: 1,
    plan_id: 1,
    plan_code: 1,
    status: 1,
    started_at: 1,
    expires_at: 1,
    assigned_by: 1,
    assigned_by_source: 1,
    assigned_by_name: 1,
    payment_reference: 1,
    allowance_granted: 1,
    created_at: 1,
    updated_at: 1,
} as const;

export interface SubscriptionSearchQuery extends ListQueryBase {
    /** Fixed by the path on `/plans/:planId/subscribers`; a caller cannot widen it. */
    planId?: string;
    planCode?: string;
    ownerType?: string;
    ownerId?: string;
    status?: string;
    /** Terms lapsing before this instant. Half-open and never matches the free tier. */
    expiringBefore?: Date;
    from?: Date;
    to?: Date;
}

export class SubscriberPlanReadRepository extends PlatformReadRepository<SubscriberPlanReadModel> {
    constructor() {
        super(COLLECTIONS.SUBSCRIBER_PLAN, SUBSCRIPTION_PROJECTION);
    }

    async search(query: SubscriptionSearchQuery): Promise<Paginated<SubscriberPlanReadModel>> {
        return this.findPage(buildSubscriptionFilter(query), {
            page: query.page,
            limit: query.limit,
            sort: toMongoSort(query.sort, SUBSCRIPTION_SORT),
        });
    }

    /**
     * The owner's plan as it stands, for the audit `before` of an assignment.
     *
     * Deliberately NOT jovi-mall's `getActivePlan`, which lazily creates the role's free
     * tier and grants its credit allowance when an owner has none. That is right for the
     * owner's own first read and wrong for anyone observing them: an administrator about
     * to assign a plan must not mint one — and a credit grant — as a side effect of
     * recording what the owner had before. jovi-mall drew the same line itself with
     * `findActivePlanWithoutCreating`; reading the row directly cannot cross it at all.
     */
    async findActiveForOwner(
        ownerType: string,
        ownerId: string,
    ): Promise<SubscriberPlanReadModel | null> {
        if (!Types.ObjectId.isValid(ownerId)) return null;
        return this.findOneBy({
            owner_type: ownerType,
            owner_id: new ObjectId(ownerId),
            status: 'active',
        } as Filter<SubscriberPlanReadModel>);
    }

    /**
     * EVERY term one owner has ever held, newest first — the owner-scoped read.
     *
     * ── Why this exists beside the cross-owner list ────────────────────────────
     * An owner holds several rows at once: one `active`, optionally one
     * `pending_activation` queued behind it, plus the history. The cross-owner list can be
     * filtered to one owner, but it is SERVER-PAGINATED — so an owner's rows can straddle a
     * page boundary and a client grouping them groups *some* of their terms without being
     * able to tell that it did.
     *
     * Worse, deciding which row is the live one from a page is a heuristic over an open
     * vocabulary: `status` is the platform's to write and this service never does, so a
     * value added upstream next quarter silently changes every client's answer. Here the
     * determination is made once, from the row that actually says `active`, and the
     * partial unique index upstream guarantees there is at most one.
     *
     * Unpaginated on purpose. An owner accumulates one term per renewal — single digits
     * over a platform's lifetime — so paging it would add a cursor to answer a question
     * that fits in one response, and would reintroduce the straddling problem it exists to
     * remove. `sort` is `created_at` descending because `started_at` is `null` on a queued
     * row, and sorting on it would put the thing that has not started yet among the
     * oldest.
     */
    async listAllForOwner(
        ownerType: string,
        ownerId: string,
    ): Promise<SubscriberPlanReadModel[]> {
        if (!Types.ObjectId.isValid(ownerId)) return [];

        return this.findBy(
            {
                owner_type: ownerType,
                owner_id: new ObjectId(ownerId),
            } as Filter<SubscriberPlanReadModel>,
            { sort: { created_at: -1 } },
        );
    }

    /** One subscription by its own id, so a `paymentReference` in a ticket has somewhere to point. */
    async findById(subscriptionId: string): Promise<SubscriberPlanReadModel | null> {
        if (!Types.ObjectId.isValid(subscriptionId)) return null;
        return this.findOneBy({ _id: new ObjectId(subscriptionId) } as Filter<SubscriberPlanReadModel>);
    }
}

/**
 * Pure, and exported so `test-billing.ts` can assert every branch without a database.
 */
export function buildSubscriptionFilter(
    query: SubscriptionSearchQuery,
): Filter<SubscriberPlanReadModel> {
    const clauses: Record<string, unknown>[] = [];

    if (query.planId) clauses.push({ plan_id: toObjectIdOrNothing(query.planId) });
    if (query.planCode) clauses.push({ plan_code: query.planCode });
    if (query.ownerType) clauses.push({ owner_type: query.ownerType });
    if (query.ownerId) clauses.push({ owner_id: toObjectIdOrNothing(query.ownerId) });
    if (query.status) clauses.push({ status: query.status });

    if (query.expiringBefore) {
        /**
         * `$ne: null` is not belt-and-braces — without it this filter is WRONG.
         *
         * BSON's comparison order puts `null` before every date, so
         * `{ expires_at: { $lt: someDate } }` matches every never-expiring free-tier row
         * in the collection. An "expiring in the next seven days" queue would then be
         * headed by every owner who is not expiring at all, which reads as an emergency
         * and is the opposite of one.
         */
        clauses.push({ expires_at: { $ne: null, $lt: query.expiringBefore } });
    }

    if (query.from || query.to) {
        const range: Record<string, Date> = {};
        if (query.from) range.$gte = query.from;
        // Half-open `[from, to)`, matching `dateRangeFields` — consecutive ranges tile
        // exactly and no row is counted twice at a boundary.
        if (query.to) range.$lt = query.to;
        clauses.push({ created_at: range });
    }

    if (clauses.length === 0) return {} as Filter<SubscriberPlanReadModel>;
    if (clauses.length === 1) return clauses[0] as Filter<SubscriberPlanReadModel>;

    // `$and` for the reason every filter in this service composes with it: assignment
    // drops a duplicate key, and two of these clauses can share one.
    return { $and: clauses } as Filter<SubscriberPlanReadModel>;
}

/**
 * A malformed id becomes a term that matches nothing, rather than a thrown BSONError.
 *
 * Every id reaching this builder through a route has already passed `objectId` at the
 * edge, so this is only reachable from a hand-built query — and a filter that matches
 * nothing is the honest answer there. Throwing from a pure function the test suite calls
 * directly would make the branch untestable without try/catch at every call site.
 */
function toObjectIdOrNothing(value: string): ObjectId | { $in: [] } {
    return Types.ObjectId.isValid(value) && value.length === 24
        ? new ObjectId(value)
        : { $in: [] };
}
