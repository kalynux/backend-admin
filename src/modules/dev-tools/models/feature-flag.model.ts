import { Document, Model, Schema, Types } from 'mongoose';
import { adminConnection } from '../../../infra/mongo/connections';

/**
 * A feature flag that has been changed from its catalog default.
 *
 * ── Absence means "the default", and the collection starts EMPTY ──────────────
 * There is no seed and no migration. A flag nobody has touched has no row, and
 * `flagEnabled()` answers from `FEATURE_FLAG_CATALOG`. That is what makes adding a flag a
 * one-file change: declare it with a default and it works, in every environment, without
 * anybody remembering to insert anything.
 *
 * It also means a row IS a deviation — the collection reads as "what somebody changed and
 * why", which is the more useful thing to look at during an incident.
 *
 * ── Why this lives in `wi-admin` rather than `jovi_mall` ──────────────────────
 * So a flip and its audit row commit in ONE transaction (`wi_admin_txn`). A flag stored in
 * the platform database could not be, for the reason ADR-006 D-2 gives: two MongoClients,
 * two session pools. See the catalog header for why jovi-mall does not read these.
 */
export interface IFeatureFlag extends Document {
    _id: Types.ObjectId;
    name: string;
    enabled: boolean;
    /** Why it was changed. Required on the write — a flag flipped for no stated reason is a mystery later. */
    reason: string;
    updated_by: Types.ObjectId | null;
    updated_by_email: string | null;
    created_at: Date;
    updated_at: Date;
}

export const FEATURE_FLAG_COLLECTION = 'admin_feature_flags';

const FeatureFlagSchema = new Schema<IFeatureFlag>(
    {
        name: { type: String, required: true },
        enabled: { type: Boolean, required: true },
        reason: { type: String, required: true },
        // Snapshotted like every other actor field on this service: the administrator may
        // be suspended or renamed before anybody reads this row.
        updated_by: { type: Schema.Types.ObjectId, ref: 'AdminAccount', default: null },
        updated_by_email: { type: String, default: null },
    },
    {
        timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
        collection: FEATURE_FLAG_COLLECTION,
    },
);

/** One row per flag. The upsert in `setFlag` relies on this to be atomic. */
FeatureFlagSchema.index({ name: 1 }, { unique: true });

let cached: Model<IFeatureFlag> | null = null;

/**
 * Bound to the ADMIN connection explicitly.
 *
 * `mongoose.model(...)` is always wrong in this service — it registers on a default
 * connection nothing opens, and every query then hangs with no error.
 */
export function FeatureFlagModel(): Model<IFeatureFlag> {
    if (!cached) {
        cached = adminConnection().model<IFeatureFlag>('FeatureFlag', FeatureFlagSchema);
    }
    return cached;
}

/** Test-only: drop the cached model so a suite can rebind it. */
export function resetFeatureFlagModel(): void {
    cached = null;
}
