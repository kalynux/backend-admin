import { Schema, Document, Types, Model } from 'mongoose';
import { adminConnection } from '../../../infra/mongo/connections';
import { ADMIN_STATUSES, ADMIN_TIERS, AdminStatus, AdminTier } from '../domain/admin-identity.types';

/**
 * `admin_accounts` — the administrator record, in the PRIVATE `wi-admin` database.
 *
 * Registered on `adminConnection()`, never the global `mongoose.model(...)`. This
 * service holds two connections, so a globally-registered model binds to a default
 * connection that is never opened: nothing throws, and every query hangs.
 *
 * There is no `users` row in `jovi_mall` behind this. An administrator is not a
 * platform user and holds no other role — jovi-mall's role enums no longer contain
 * `admin` at all. That is why this collection carries credentials directly.
 */

export const ADMIN_COLLECTION = 'admin_accounts';

export interface IAdminAccount extends Document {
    _id: Types.ObjectId;
    email: string;
    display_name: string;
    password_hash: string;
    password_updated_at: Date;

    tier: AdminTier;
    status: AdminStatus;

    job_title: string | null;
    department: string | null;
    timezone: string;
    preferred_language: string;

    /** TOTP is active — set only after a first correct code proves the authenticator works. */
    mfa_enrolled: boolean;
    /**
     * The TOTP shared secret. Present but INACTIVE between enrol and activate.
     * Never leaves the service and never reaches a log — `*.mfaSecret` and `*.secret`
     * are both in the logger's redaction list.
     */
    mfa_secret: string | null;
    mfa_activated_at: Date | null;

    failed_attempts: number;
    locked_until: Date | null;
    last_login_at: Date | null;
    /**
     * Actually populated, unlike jovi-mall's equivalent: its `recordLogin()` has zero
     * callers despite a docstring claiming the auth middleware invokes it, so the field
     * is always null there.
     */
    last_login_ip: string | null;

    // ── Provenance (Phase 3) ─────────────────────────────────────────────────
    // Who created this account, who suspended it, who last changed its level.
    //
    // The audit log (Phase 3.5) is the searchable record of these events; these fields are
    // the CURRENT answer, denormalised onto the row so the administrator directory can
    // show "suspended by X on Y" without joining a log. All optional — the bootstrapped
    // first administrator has no creator, and rows written in Phase 2 have none of them.

    /** Null for the bootstrapped first administrator, and for Phase-2 rows. */
    created_by: Types.ObjectId | null;

    suspended_at: Date | null;
    suspended_by: Types.ObjectId | null;
    /** Required by the service when suspending — an unexplained suspension helps nobody. */
    suspended_reason: string | null;

    tier_changed_at: Date | null;
    tier_changed_by: Types.ObjectId | null;

    created_at: Date;
    updated_at: Date;
}

const AdminAccountSchema = new Schema<IAdminAccount>(
    {
        email: { type: String, required: true, unique: true, trim: true, lowercase: true, index: true },
        display_name: { type: String, required: true, trim: true },
        password_hash: { type: String, required: true },
        password_updated_at: { type: Date, required: true, default: () => new Date() },

        tier: { type: Number, required: true, enum: ADMIN_TIERS },
        status: { type: String, required: true, enum: ADMIN_STATUSES, default: 'active' },

        job_title: { type: String, default: null, trim: true },
        department: { type: String, default: null, trim: true },
        timezone: { type: String, required: true, default: 'Africa/Douala' },
        preferred_language: { type: String, required: true, default: 'en' },

        mfa_enrolled: { type: Boolean, required: true, default: false },
        mfa_secret: { type: String, default: null },
        mfa_activated_at: { type: Date, default: null },

        failed_attempts: { type: Number, required: true, default: 0 },
        locked_until: { type: Date, default: null },
        last_login_at: { type: Date, default: null },
        last_login_ip: { type: String, default: null },

        created_by: { type: Schema.Types.ObjectId, default: null, ref: 'AdminAccount' },

        suspended_at: { type: Date, default: null },
        suspended_by: { type: Schema.Types.ObjectId, default: null, ref: 'AdminAccount' },
        suspended_reason: { type: String, default: null },

        tier_changed_at: { type: Date, default: null },
        tier_changed_by: { type: Schema.Types.ObjectId, default: null, ref: 'AdminAccount' },
    },
    {
        timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
        collection: ADMIN_COLLECTION,
    },
);

/** Backs the administrator directory's default sort and its tier/status filters. */
AdminAccountSchema.index({ tier: 1, status: 1, created_at: -1 });

/**
 * Strip every credential field from anything serialised.
 *
 * Defence in depth, not the primary control — DTOs decide what a response contains.
 * But a model that cannot be serialised into a leak removes a whole class of mistake,
 * and `password_hash` reaching a response body is exactly the sort of thing that slips
 * through a hand-built projection.
 */
AdminAccountSchema.set('toJSON', {
    transform: (_doc, ret) => {
        const plain = ret as unknown as Record<string, unknown>;
        delete plain.password_hash;
        delete plain.mfa_secret;
        return plain;
    },
});

let cached: Model<IAdminAccount> | null = null;

/**
 * Lazy accessor rather than a module-level `model()` call: registration requires the
 * connection to exist, and importing this file must not depend on `connectAll()`
 * having already run.
 */
export function AdminAccountModel(): Model<IAdminAccount> {
    if (!cached) {
        cached = adminConnection().model<IAdminAccount>('AdminAccount', AdminAccountSchema);
    }
    return cached;
}

/** Test-only: drop the memoized model so a fresh connection can re-register it. */
export function resetAdminAccountModel(): void {
    cached = null;
}
