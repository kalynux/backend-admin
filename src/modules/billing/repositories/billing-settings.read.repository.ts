import { Document, Filter, ObjectId } from 'mongodb';
import { Types } from 'mongoose';
import { COLLECTIONS } from '../../../infra/platform/collections';
import { PlatformReadRepository } from '../../../infra/platform/platform.repository';

/**
 * Per-owner billing preferences — `billing_settings`, read directly.
 *
 * ── This collection gets no endpoint of its own, on purpose ───────────────────
 * There are two fields on it and neither is a screen. `notify_days_before_expiry` is the
 * owner's own notice preference, and it earns its place on the **account view** (Phase 11
 * step 7): rendering "expires in N days" against a hardcoded seven would report a warning
 * state the platform itself does not hold, because the plan-expiry worker reads this
 * column. `shipment_cap_alerted_at` answers "have they already been told they are over
 * their soft cap", which is the difference between an agency ignoring an alert and one
 * that was never sent it.
 *
 * ── Why it lives here rather than in the accounts module that consumes it ─────
 * The same rule `hydrateNames` follows in the shipment controller: **the module that owns
 * the collection owns the read.** `billing_settings` is billing's, its projection belongs
 * beside the other two billing projections where a reviewer sees all three at once, and
 * the alternative is a second declaration of it inside `/accounts` that has to be kept in
 * step by hand.
 *
 * Row absence is not an error. jovi-mall creates these lazily on first read or write, so
 * an owner who has never touched the preference has no document — the account view reports
 * the platform default rather than 404ing, exactly as `ACCOUNT_OWNER_NOT_FOUND` documents
 * for a missing balance.
 */

export interface BillingSettingsReadModel extends Document {
    _id: ObjectId;
    owner_type: string;
    owner_id: ObjectId;
    notify_days_before_expiry?: number;
    /** When the owner was last told they are over their soft shipment cap. */
    shipment_cap_alerted_at?: Date | null;
    created_at: Date;
    updated_at: Date;
}

const BILLING_SETTINGS_PROJECTION = {
    _id: 1,
    owner_type: 1,
    owner_id: 1,
    notify_days_before_expiry: 1,
    shipment_cap_alerted_at: 1,
    created_at: 1,
    updated_at: 1,
} as const;

export class BillingSettingsReadRepository extends PlatformReadRepository<BillingSettingsReadModel> {
    constructor() {
        super(COLLECTIONS.BILLING_SETTINGS, BILLING_SETTINGS_PROJECTION);
    }

    /** One owner's preferences, or `null` when they have never had any written. */
    async findForOwner(
        ownerType: string,
        ownerId: string,
    ): Promise<BillingSettingsReadModel | null> {
        if (!Types.ObjectId.isValid(ownerId)) return null;
        return this.findOneBy({
            owner_type: ownerType,
            owner_id: new ObjectId(ownerId),
        } as Filter<BillingSettingsReadModel>);
    }
}
