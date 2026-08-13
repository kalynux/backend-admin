import { Document, ObjectId } from 'mongodb';
import { COLLECTIONS } from '../../../infra/platform/collections';
import { PlatformReadRepository } from '../../../infra/platform/platform.repository';
import { ownerScopedFilter } from './credit.read.repository';

/**
 * An owner's self-serve purchase of a paid plan — the fifth source of the activity feed.
 *
 * ── Why this is not `subscriber_plans` ────────────────────────────────────────
 * They answer different questions and the account view uses both. `subscriber_plans` is the
 * TERM — which plan is active, when it started, when it expires, who assigned it — and the
 * billing module already reads it. `plan_purchases` is the PAYMENT: what the owner was
 * charged, through which gateway, and whether the charge succeeded.
 *
 * A purchase that never reached `paid` has no subscriber plan at all, so the subscription
 * block on the account view says nothing about it. On the activity feed it is exactly the
 * row somebody is looking for: "they say they paid — did we take the money?"
 *
 * `subscriber_plan_id` is the link between the two, and it is projected for that reason:
 * `null` on a `paid` purchase means the charge landed and the plan was never applied, which
 * is a real and otherwise-invisible state.
 */

export interface PlanPurchaseReadModel extends Document {
    _id: ObjectId;
    owner_type: string;
    owner_id: ObjectId;
    plan_id: ObjectId;
    /** Snapshotted at purchase time — the code as it was, not as the plan is now. */
    plan_code: string;
    price: number;
    currency: string;
    /** `pending` · `paid` · `failed` · `reversed`. */
    status: string;
    gateway?: string | null;
    gateway_ref?: string | null;
    /** The subscriber plan this purchase produced. `null` until it is applied. */
    subscriber_plan_id?: ObjectId | null;
    created_at: Date;
    updated_at: Date;
}

const PLAN_PURCHASE_PROJECTION = {
    _id: 1,
    owner_type: 1,
    owner_id: 1,
    plan_id: 1,
    plan_code: 1,
    price: 1,
    currency: 1,
    status: 1,
    gateway: 1,
    gateway_ref: 1,
    subscriber_plan_id: 1,
    created_at: 1,
    updated_at: 1,
} as const;

export class PlanPurchaseReadRepository extends PlatformReadRepository<PlanPurchaseReadModel> {
    constructor() {
        super(COLLECTIONS.PLAN_PURCHASE, PLAN_PURCHASE_PROJECTION);
    }

    /**
     * One source of the merged activity feed — `limit + 1` rows strictly older than the
     * cursor, newest first. `{owner_type, owner_id, created_at: -1}` serves it end to end.
     */
    async listBefore(
        ownerType: string,
        ownerId: string,
        before: Date | undefined,
        limit: number,
    ): Promise<PlanPurchaseReadModel[]> {
        return this.findBy(
            ownerScopedFilter<PlanPurchaseReadModel>(ownerType, ownerId, before),
            { sort: { created_at: -1, _id: -1 }, limit },
        );
    }
}
