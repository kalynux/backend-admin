import { Schema, Document, Types, Model } from 'mongoose';
import { adminConnection } from '../../../infra/mongo/connections';
import { AUDIT_TARGET_TYPES } from '../../audit/domain/audit.types';
import {
    NOTIFICATION_SEVERITIES,
    NOTIFICATION_TYPES,
    NotificationSeverity,
    NotificationType,
} from '../domain/notification.types';

/**
 * `admin_notifications` — the administrator inbox, in the PRIVATE `wi-admin` database.
 *
 * Registered on `adminConnection()`, never the global `mongoose.model(...)`. This service
 * holds two connections; a globally-registered model binds to a default connection that is
 * never opened, nothing throws, and every query hangs.
 *
 * ── What a row is ─────────────────────────────────────────────────────────────
 * One row per (situation, recipient) — the fan-out shape jovi-mall's four stacks already
 * use. `admin_id` is therefore always present and `read_at` is a scalar, which keeps the
 * list query, the unread count and the ADR-005 paging contract ordinary. The alternative
 * (one row plus a `read_by[]` array) makes every one of those three a special case to buy
 * a saving that does not matter at administrator headcounts.
 *
 * ── What a row is NOT ─────────────────────────────────────────────────────────
 * It is not the record of anything. It is a delivery receipt for a fact recorded elsewhere
 * — in `admin_audit_log`, or in the `jovi_mall` row named by `source_row_id`. Three things
 * follow, and all three are deliberate:
 *
 *  1. **No `writeConcern: majority`.** `audit-log.model.ts` takes one because it is
 *     evidence. Losing a receipt for an event that is still on file, still visible on its
 *     own screen, and still re-derivable by the next projector tick costs nothing worth
 *     paying a round trip per write for.
 *  2. **A TTL is allowed here** (see the purge index below), where
 *     `approval-request.model.ts` refuses one outright.
 *  3. **The write never joins the transaction it describes.** Notifying is not allowed to
 *     be able to fail an administrative action — the opposite posture to the audit
 *     subsystem's D-1, and for the opposite reason.
 *
 * ── Idempotency ───────────────────────────────────────────────────────────────
 * `source_key` is derived from the source row, not from the clock, and
 * `{ source_key, admin_id }` is unique. That single index is what lets the projector be
 * a plain "scan everything since the watermark and upsert" loop with no exactly-once
 * machinery: re-reading a row it has already delivered changes nothing. It is also why a
 * crashed tick is harmless — the next one re-derives.
 */

export const NOTIFICATION_COLLECTION = 'admin_notifications';

export interface IAdminNotification extends Document {
    _id: Types.ObjectId;

    /** The recipient. Every row has exactly one. */
    admin_id: Types.ObjectId;

    type: NotificationType;
    severity: NotificationSeverity;

    /** One line, already rendered. A dashboard shows this without a lookup. */
    title: string;
    /** Optional second line — the amount, the reason, the counterparty. */
    body: string | null;

    // ── Provenance ───────────────────────────────────────────────────────────
    /** The `source.registry.ts` entry that produced this. */
    source_id: string;
    /** The collection the fact lives in — `cod_discrepancies`, `admin_approval_requests`. */
    source_collection: string;
    /** The row it came from, as a string: some sources key on a composite. */
    source_row_id: string;
    /** `<source_id>:<discriminator>` — the idempotency key. Unique per recipient. */
    source_key: string;

    /**
     * The permission that gates seeing this, or `null` when the row is addressed to one
     * administrator personally (an approval they requested, an export they asked for).
     *
     * Stored rather than re-derived so the list can filter on it directly. It is checked
     * a SECOND time at read (`notification.repository.ts`), because fan-out resolved the
     * audience at write time and a demotion afterwards must still take effect.
     */
    required_permission: string | null;

    // ── What it is about ─────────────────────────────────────────────────────
    // Reuses the audit target vocabulary rather than inventing a parallel one: the two
    // surfaces answer questions about the same objects, and a dashboard that can render an
    // audit row's target can render this one with the same component.
    target_type: string;
    target_id: string | null;
    target_label: string | null;

    /** Where the dashboard should send someone who clicks it. Relative, API-shaped. */
    action_path: string | null;

    /** When the underlying fact happened — NOT when we noticed it. Drives the sort. */
    occurred_at: Date;

    read_at: Date | null;

    // ── Retention (no defaults — see the purge index) ─────────────────────────
    archived_at?: Date;
    purge_after?: Date;

    created_at: Date;
    updated_at: Date;
}

const AdminNotificationSchema = new Schema<IAdminNotification>(
    {
        admin_id: { type: Schema.Types.ObjectId, required: true, ref: 'AdminAccount' },

        type: { type: String, required: true, enum: NOTIFICATION_TYPES },
        severity: { type: String, required: true, enum: NOTIFICATION_SEVERITIES },

        title: { type: String, required: true },
        body: { type: String, default: null },

        source_id: { type: String, required: true },
        source_collection: { type: String, required: true },
        source_row_id: { type: String, required: true },
        source_key: { type: String, required: true },

        // Plain `String`, not an enum of every permission name — the same call
        // `audit-log.model.ts` makes for `action`. The compile-time guard is real and lives
        // where it belongs: the registry types this as `PermissionName`, so a typo is a
        // build error rather than a runtime validation failure on a background sweep.
        required_permission: { type: String, default: null },

        target_type: { type: String, required: true, enum: AUDIT_TARGET_TYPES },
        target_id: { type: String, default: null },
        target_label: { type: String, default: null },

        action_path: { type: String, default: null },

        occurred_at: { type: Date, required: true },
        read_at: { type: Date, default: null },

        // NO `default` on these two, for the reason `audit-log.model.ts:164-168` gives: a
        // `default: null` puts the key on every document and makes the partial filter below
        // match everything — silently converting a conditional purge into an unconditional
        // one.
        archived_at: { type: Date },
        purge_after: { type: Date },
    },
    {
        timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
        collection: NOTIFICATION_COLLECTION,
    },
);

// ─────────────────────────────────────────────────────────────────────────────
// Indexes
//
// Equality field first, time second, `_id` last — the convention `audit-log.model.ts`
// sets and the reason it gives applies unchanged here: `toMongoSort` appends `_id` as a
// stability tiebreaker unconditionally, so an index without it forces a re-sort on every
// page.
//
// `admin_id` leads every one of them. There is no query in this module that reads another
// administrator's inbox, so a compound index that does not start there serves nothing.
// ─────────────────────────────────────────────────────────────────────────────

/** The default feed. */
AdminNotificationSchema.index({ admin_id: 1, occurred_at: -1, _id: -1 });

/** The unread filter and the badge count — both `{ admin_id, read_at: null }`. */
AdminNotificationSchema.index({ admin_id: 1, read_at: 1, occurred_at: -1, _id: -1 });

/** `?type=` and `?severity=` triage. */
AdminNotificationSchema.index({ admin_id: 1, type: 1, occurred_at: -1, _id: -1 });

/**
 * IDEMPOTENCY. The whole of the projector's safety, in one index.
 *
 * Unique on the pair, not on `source_key` alone: one situation fans out to every
 * administrator entitled to see it, so the same key legitimately appears once per
 * recipient. Making it unique on `source_key` would let the first recipient's row block
 * everyone else's.
 */
AdminNotificationSchema.index({ source_key: 1, admin_id: 1 }, { unique: true });

/** The auto-archive sweep — unarchived rows older than the cutoff. */
AdminNotificationSchema.index({ archived_at: 1, occurred_at: 1 });

/**
 * THE PURGE. `expireAfterSeconds: 0` means "delete when `purge_after` passes".
 *
 * `approval-request.model.ts` refuses a TTL outright — "a TTL would quietly erase the
 * record of an attempt" — and that is right for that collection and wrong for this one.
 * The two rows are not alike. An approval request IS the record of an attempt, and the
 * audit subsystem joins against it. A notification is a receipt whose subject outlives it
 * on both sides: the `jovi_mall` row it was derived from is still there, `admin_audit_log`
 * still holds whatever an administrator did about it, and the registry can re-derive the
 * row from scratch. Purging an archived receipt destroys no evidence and answers no
 * question worse.
 *
 * The `partialFilterExpression` makes the rule "ARCHIVED and aged" a property of the
 * INDEX, not of the writer: a row that somehow acquired a `purge_after` without being
 * archived is not in this index and cannot be deleted by it.
 *
 * `$type: 'date'` rather than `$exists: true`, for the reason the audit log gives — if
 * `archived_at` ever regained a `default: null`, `$exists` would match every document and
 * the filter would become vacuous. A type test cannot fail that way.
 */
AdminNotificationSchema.index(
    { purge_after: 1 },
    { expireAfterSeconds: 0, partialFilterExpression: { archived_at: { $type: 'date' } } },
);

let cached: Model<IAdminNotification> | null = null;

export function AdminNotificationModel(): Model<IAdminNotification> {
    if (!cached) {
        cached = adminConnection().model<IAdminNotification>('AdminNotification', AdminNotificationSchema);
    }
    return cached;
}

export function resetAdminNotificationModel(): void {
    cached = null;
}
