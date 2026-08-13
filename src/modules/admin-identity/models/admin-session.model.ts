import { Schema, Document, Types, Model } from 'mongoose';
import { adminConnection } from '../../../infra/mongo/connections';

/**
 * `admin_sessions` — the DURABLE record of a login, in `wi-admin`.
 *
 * This is not the session store. The live session lives in Redis, where the idle TTL
 * does the expiring and a lookup costs nothing; this collection is the history: who
 * signed in, from where, when it ended and why.
 *
 * It is deliberately **never read on the hot path**. Authentication touches Redis only.
 * Phase 3's audit log joins against these rows, which is why `session_id` is indexed
 * and why an ended session is stamped rather than deleted — an audit trail that erases
 * the session an action happened in is not an audit trail.
 */

export const ADMIN_SESSION_COLLECTION = 'admin_sessions';

/**
 * Why a session ended. `idle_expired` and `absolute_expired` are distinct on purpose:
 * one means the admin walked away, the other that a long-running session hit its cap,
 * and telling them apart matters when tuning the two TTLs.
 */
export type SessionEndReason =
    | 'logout'
    | 'logout_all'
    | 'revoked_by_admin'
    | 'account_suspended'
    /**
     * The administrator's level changed (Phase 3).
     *
     * Distinct from `revoked_by_admin` because it is not a revocation — nobody decided
     * this session should end, it ended because what it represents is no longer true. The
     * live session carries a `tier_at_login` snapshot and a token minted with the old
     * level; the guard reads the account rather than either, so access is already correct,
     * but leaving the session alive means its own record of itself disagrees with reality.
     */
    | 'tier_changed'
    /** The password was reset by another administrator, so existing sessions must go. */
    | 'password_reset'
    /**
     * Two-factor enrolment was cleared by another administrator (Phase 12).
     *
     * Its own reason rather than `password_reset`: a live session minted WITH a second
     * factor would otherwise keep the benefit of a factor that no longer exists, and if the
     * reset is being used to recover a compromised account, the attacker's session would
     * survive the recovery. The distinct label is what makes that visible in the session
     * history afterwards.
     */
    | 'mfa_reset'
    | 'refresh_reuse_detected'
    | 'idle_expired'
    | 'absolute_expired';

export interface IAdminSession extends Document {
    _id: Types.ObjectId;
    /** The `sid` carried in the token and used as the Redis key. */
    session_id: string;
    admin_id: Types.ObjectId;
    /** Snapshotted: an audit row must show the level held AT THE TIME, not the level now. */
    tier_at_login: number;
    ip: string | null;
    user_agent: string | null;
    mfa_used: boolean;
    started_at: Date;
    absolute_expires_at: Date;
    last_seen_at: Date;
    ended_at: Date | null;
    end_reason: SessionEndReason | null;
    created_at: Date;
    updated_at: Date;
}

const AdminSessionSchema = new Schema<IAdminSession>(
    {
        session_id: { type: String, required: true, unique: true, index: true },
        admin_id: { type: Schema.Types.ObjectId, required: true, ref: 'AdminAccount', index: true },
        tier_at_login: { type: Number, required: true },
        ip: { type: String, default: null },
        user_agent: { type: String, default: null },
        mfa_used: { type: Boolean, required: true, default: false },
        started_at: { type: Date, required: true, default: () => new Date() },
        absolute_expires_at: { type: Date, required: true },
        last_seen_at: { type: Date, required: true, default: () => new Date() },
        ended_at: { type: Date, default: null },
        end_reason: { type: String, default: null },
    },
    {
        timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
        collection: ADMIN_SESSION_COLLECTION,
    },
);

// Serves "this admin's live sessions" and "revoke everything for this admin".
AdminSessionSchema.index({ admin_id: 1, ended_at: 1, started_at: -1 });

let cached: Model<IAdminSession> | null = null;

export function AdminSessionModel(): Model<IAdminSession> {
    if (!cached) {
        cached = adminConnection().model<IAdminSession>('AdminSession', AdminSessionSchema);
    }
    return cached;
}

export function resetAdminSessionModel(): void {
    cached = null;
}
