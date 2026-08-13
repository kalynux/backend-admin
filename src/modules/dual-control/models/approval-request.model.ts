import { Schema, Document, Types, Model } from 'mongoose';
import { adminConnection } from '../../../infra/mongo/connections';
import { AdminTier } from '../../admin-identity/domain/admin-identity.types';

/**
 * `admin_approval_requests` — actions waiting for a second administrator, in the PRIVATE
 * `wi-admin` database.
 *
 * Registered on `adminConnection()`, never the global `mongoose.model(...)`. This service
 * holds two connections; a globally-registered model binds to a default connection that
 * is never opened, nothing throws, and every query hangs.
 *
 * ── What a row is ─────────────────────────────────────────────────────────────
 * A recorded INTENT, not a completed action. It holds everything needed to perform the
 * action later — who asked, what they asked for, and against whom — so the approver's
 * request is the one that performs the write. That is what four eyes means: the second
 * person commits it, not merely nods at it.
 *
 * ── Why rows are never deleted ────────────────────────────────────────────────
 * Rejected and expired requests are stamped, not removed. A request that was refused is
 * as interesting as one that was granted — more so, if someone kept making it — and the
 * audit subsystem joins against these rows. That is also why there is no TTL index: a
 * TTL would quietly erase the record of an attempt.
 */

export const APPROVAL_COLLECTION = 'admin_approval_requests';

export type ApprovalStatus =
    /** Waiting for a second administrator. */
    | 'pending'
    /** Approved AND performed — the two are one step, so there is no 'approved' limbo. */
    | 'approved'
    | 'rejected'
    /** Passed `expires_at` without a decision. Stamped lazily, on read. */
    | 'expired'
    /** Withdrawn by the administrator who requested it. */
    | 'withdrawn';

export const APPROVAL_STATUSES: readonly ApprovalStatus[] = [
    'pending', 'approved', 'rejected', 'expired', 'withdrawn',
] as const;

export interface IApprovalRequest extends Document {
    _id: Types.ObjectId;

    /**
     * Idempotency key: a hash of action + target + the canonical payload.
     *
     * Repeating the identical request returns the existing pending row rather than
     * queueing a second one — otherwise a double-clicked dashboard button produces two
     * approvals for one intent, and approving both performs the action twice.
     */
    request_key: string;

    /** The permission naming the action, e.g. `administrators.tier.set`. */
    action: string;
    /** One line describing what an approver would be committing. */
    description: string;

    requested_by: Types.ObjectId;
    /** The requester's level AT REQUEST TIME. They may be demoted before it is decided. */
    requested_by_tier: AdminTier;

    target_type: string;
    target_id: string;

    /** The validated, canonical intent. Replayed by the handler at approval time. */
    payload: Record<string, unknown>;

    status: ApprovalStatus;

    approver_id: Types.ObjectId | null;
    decided_at: Date | null;
    decision_note: string | null;
    /** Set when performing the approved action failed, so a stuck row explains itself. */
    failure_reason: string | null;

    expires_at: Date;

    created_at: Date;
    updated_at: Date;
}

const ApprovalRequestSchema = new Schema<IApprovalRequest>(
    {
        // No `index: true` here — the partial unique index below covers this field, and
        // declaring both makes Mongoose build two.
        request_key: { type: String, required: true },

        action: { type: String, required: true, index: true },
        description: { type: String, required: true },

        requested_by: { type: Schema.Types.ObjectId, required: true, ref: 'AdminAccount', index: true },
        requested_by_tier: { type: Number, required: true },

        target_type: { type: String, required: true },
        target_id: { type: String, required: true, index: true },

        payload: { type: Schema.Types.Mixed, required: true, default: {} },

        status: { type: String, required: true, enum: APPROVAL_STATUSES, default: 'pending', index: true },

        approver_id: { type: Schema.Types.ObjectId, default: null, ref: 'AdminAccount' },
        decided_at: { type: Date, default: null },
        decision_note: { type: String, default: null },
        failure_reason: { type: String, default: null },

        expires_at: { type: Date, required: true },
    },
    {
        timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
        collection: APPROVAL_COLLECTION,
    },
);

/**
 * One PENDING request per intent, enforced by the database rather than by a read-then-write.
 *
 * Partial: only pending rows participate, so the same action may legitimately be
 * requested again after an earlier one was rejected or expired. A plain unique index
 * would make a rejected request permanently unrepeatable.
 */
ApprovalRequestSchema.index(
    { request_key: 1 },
    { unique: true, partialFilterExpression: { status: 'pending' } },
);

/** Backs the pending queue, newest first. */
ApprovalRequestSchema.index({ status: 1, created_at: -1 });

/**
 * Backs the expiry sweep — `{ status: 'pending', expires_at: { $lte: now } }`.
 *
 * The index above does NOT serve it: `created_at` is the wrong second key, so the sweep
 * scanned every pending row. That was survivable while it was one `updateMany`; Phase 12
 * turned it into a bounded find that runs on three read paths, which makes the scan the
 * hot part rather than an occasional one.
 *
 * Ascending on `expires_at` so the bound (`.sort({ expires_at: 1 }).limit(n)`) reads the
 * longest-overdue first and drains a backlog in deadline order.
 */
ApprovalRequestSchema.index({ status: 1, expires_at: 1 });

let cached: Model<IApprovalRequest> | null = null;

/**
 * Lazy accessor rather than a module-level `model()` call: registration requires the
 * connection to exist, and importing this file must not depend on `connectAll()` having
 * already run.
 */
export function ApprovalRequestModel(): Model<IApprovalRequest> {
    if (!cached) {
        cached = adminConnection().model<IApprovalRequest>('ApprovalRequest', ApprovalRequestSchema);
    }
    return cached;
}

/** Test-only: drop the memoized model so a fresh connection can re-register it. */
export function resetApprovalRequestModel(): void {
    cached = null;
}
