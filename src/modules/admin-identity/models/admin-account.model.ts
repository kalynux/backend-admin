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

    /**
     * The administrator's own picture, as a `jovi_mall.files._id` (ADR-023).
     *
     * An id, never a URL — the rule every file reference on this service follows. It resolves
     * through `GET /api/v1/files/:fileId`, which builds the `FileDetail` locally from the
     * storage-tree table (BR-015 L-3). An avatar is an ordinary `by-type` upload and lands in
     * a PUBLIC tree, unlike everything on the employee record.
     *
     * ⚠ Deliberately on the ACCOUNT rather than on the employee record beside the identity
     * documents, and the line between them is ADR-023 D-3: an avatar is how colleagues
     * recognise you in a dropdown, so it is directory data every administrator may see. A
     * photograph of you holding your identity card is evidence, and it is tier-1-only. Two
     * pictures of the same face, two completely different audiences.
     */
    avatar_file_id: Types.ObjectId | null;

    /**
     * A CONTACT number, verified for reachability — deliberately NOT a login factor.
     *
     * ⚠ Administrators already have TOTP (`mfa_secret`/`mfa_enrolled`), which is stronger than
     * a WhatsApp OTP. Adding this as a second factor would WEAKEN the login, not harden it, so
     * nothing in the auth path reads these two fields. If that ever changes it is a security
     * decision, not a refactor.
     */
    phone: string | null;
    /** Proved via the WhatsApp OTP jovi-mall sends — see `admin-phone.service.ts`. */
    phone_verified: boolean;
    phone_verified_at: Date | null;

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
    /**
     * The status this account held at the moment it was suspended, so reinstatement can put
     * it back rather than guess (ADR-023 D-1).
     *
     * ⚠ It exists because reinstatement used to write `'active'` unconditionally, which was
     * right while `active` and `suspended` were the only states and became a silent privilege
     * escalation the moment `pending` was added: suspend a not-yet-activated administrator,
     * reinstate them, and they are active — past the tier-1 decision that lets somebody in,
     * with an audit trail that says "reinstated" because that is what was asked for.
     *
     * Null on a row suspended before this column existed; the repository defaults such a
     * reinstatement to `'active'`, which is what it would have done anyway.
     */
    suspended_from_status: AdminStatus | null;

    tier_changed_at: Date | null;
    tier_changed_by: Types.ObjectId | null;

    // ── Activation provenance (ADR-023) ───────────────────────────────────────
    // Who let this person in, and when. Denormalised beside the suspension columns above
    // and for the same reason: the directory shows "activated by X on Y" without joining
    // the audit log, which stays the searchable record of the event itself.

    /**
     * Null while `status` is `pending`, and null FOREVER on the bootstrapped first
     * administrator — who is created `active` because there is nobody to activate them.
     *
     * ⚠ So `activated_at === null` does NOT mean "not activated". Read `status` for that.
     * This column answers "who decided", and the one account whose answer is "nobody, by
     * construction" is exactly the account a reviewer most wants that stated plainly.
     */
    activated_at: Date | null;
    activated_by: Types.ObjectId | null;

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
        /**
         * ⚠ **`pending`, not `active` — changed at ADR-023 D-1, and the default is the
         * enforcement.** A new administrator is an unverified person until a Developer has
         * read their employee record, and the cheapest way to guarantee that is for the
         * schema to refuse to produce an active account by omission.
         *
         * The ONE account that must not take this default is the bootstrapped first
         * administrator: there is nobody to activate them, so `scripts/bootstrap-admin.ts`
         * passes `status: 'active'` explicitly. That is the whole of the exception and it is
         * written down in two places — there, and in the ⚠ on `activated_at` above.
         */
        status: { type: String, required: true, enum: ADMIN_STATUSES, default: 'pending' },

        avatar_file_id: { type: Schema.Types.ObjectId, default: null },

        phone: { type: String, default: null, trim: true },
        phone_verified: { type: Boolean, required: true, default: false },
        phone_verified_at: { type: Date, default: null },

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
        suspended_from_status: { type: String, enum: ADMIN_STATUSES, default: null },

        tier_changed_at: { type: Date, default: null },
        tier_changed_by: { type: Schema.Types.ObjectId, default: null, ref: 'AdminAccount' },

        activated_at: { type: Date, default: null },
        activated_by: { type: Schema.Types.ObjectId, default: null, ref: 'AdminAccount' },
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
