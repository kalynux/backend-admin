import { Document, Model, Schema, Types } from 'mongoose';
import { adminConnection } from '../../../infra/mongo/connections';
import {
    AUDIT_ACTOR_KINDS,
    AUDIT_STATUSES,
    AUDIT_SUBJECT_CLASSES,
    AUDIT_TARGET_TYPES,
    AuditActorKind,
    AuditStatus,
    AuditSubjectClass,
    AuditTargetType,
} from '../domain/audit.types';

/**
 * `admin_audit_log` — the append-only record of every administrator action.
 *
 * ── Durability is the point, so the write concern is explicit ─────────────────
 * `w: 'majority', j: true`. Fail-closed means *durably recorded*, not "accepted by a
 * primary that might roll back" — a row acknowledged by one node and then lost in an
 * election would leave an action that happened and is not in the trail, which is the one
 * outcome this subsystem exists to prevent. A few milliseconds per admin action is not a
 * cost worth optimising at this volume.
 *
 * ── The one TTL index in this service, and why it is allowed ─────────────────
 * `approval-request.model.ts` refuses a TTL outright: "a TTL would quietly erase the
 * record of an attempt." That rule holds here with more force, and this collection has
 * one anyway — under a condition that makes it a different thing.
 *
 * A row can only enter the TTL index by carrying an `export_id`, and an `export_id`
 * points at a completed `admin_audit_exports` manifest holding the file's sha256 and row
 * count. So no row is ever deleted that is not already in a durable file whose integrity
 * can be checked. **Every vanished row is traceable to a file.** That is the whole
 * argument; if the partial filter is ever removed, the argument collapses and the
 * approval model's rule applies again.
 *
 * ── Fields declared WITHOUT a default, deliberately ──────────────────────────
 * `export_id`, `exported_at` and `purge_after` have no `default`, unlike every other
 * optional field in this codebase. That is load-bearing: the TTL's partial filter tests
 * for the field's presence, and Mongoose's usual `default: null` would put the key on
 * every document — making the filter match everything and silently converting a
 * conditional purge into an unconditional one.
 */

const AUDIT_LOG_COLLECTION = 'admin_audit_log';

export interface IAuditLog extends Document {
    _id: Types.ObjectId;

    // ── When and who ─────────────────────────────────────────────────────────
    /**
     * When the INTENT was recorded — the feed's sort key.
     *
     * Deliberately not `created_at`: an intent→outcome row is updated when its outcome
     * arrives, and a sort key that moves under a paging client shows rows twice.
     */
    occurred_at: Date;
    completed_at: Date | null;
    /** Sanitised `req.requestId`; the same value that reached jovi-mall as `X-Request-Id`. */
    correlation_id: string;

    actor_kind: AuditActorKind;
    actor_id: Types.ObjectId | null;
    /** Snapshots — a row must read without a join, and display names change. */
    actor_email: string | null;
    actor_display_name: string | null;
    /** The level held AT THE TIME, not the level now. */
    actor_tier: number | null;
    session_id: string | null;
    ip: string | null;
    user_agent: string | null;
    method: string;
    path: string;

    // ── What ─────────────────────────────────────────────────────────────────
    action: string;
    /** Denormalised first segment, so a family filter is an equality match not a regex. */
    action_family: string;
    status: AuditStatus;
    /** Copied from the permission spec's flags at write time; read-scoping and alerting key off it. */
    sensitive: boolean;
    payload: Record<string, unknown> | null;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    state_truncated: boolean;

    // ── To what ──────────────────────────────────────────────────────────────
    target_type: AuditTargetType;
    /** String, not ObjectId: some targets are session UUIDs. */
    target_id: string | null;
    target_label: string | null;
    subject_class: AuditSubjectClass;
    /**
     * The record the action is really about when the target is a wrapper around it.
     * An approval's target is the approval; this is the administrator it concerns —
     * without it, "what was done to this account" misses every four-eyes action.
     */
    related_target_type: AuditTargetType | null;
    related_target_id: string | null;

    // ── Outcome ──────────────────────────────────────────────────────────────
    outcome_code: string | null;
    outcome_status: number | null;
    outcome_message: string | null;
    denial_kind: string | null;
    required_permissions: string[];
    via_approval_id: Types.ObjectId | null;
    /** The write landed in jovi-mall — selects the "grep the other service" runbook. */
    delegated: boolean;
    /** jovi-mall's own error code, passed through rather than translated. */
    platform_code: string | null;

    // ── Retention (no defaults — see the header) ──────────────────────────────
    export_id?: Types.ObjectId;
    exported_at?: Date;
    purge_after?: Date;

    created_at: Date;
    updated_at: Date;
}

const AuditLogSchema = new Schema<IAuditLog>(
    {
        occurred_at: { type: Date, required: true, default: () => new Date() },
        completed_at: { type: Date, default: null },
        correlation_id: { type: String, required: true },

        actor_kind: { type: String, required: true, enum: AUDIT_ACTOR_KINDS },
        actor_id: { type: Schema.Types.ObjectId, default: null, ref: 'AdminAccount' },
        actor_email: { type: String, default: null },
        actor_display_name: { type: String, default: null },
        actor_tier: { type: Number, default: null },
        session_id: { type: String, default: null },
        ip: { type: String, default: null },
        user_agent: { type: String, default: null },
        method: { type: String, required: true },
        path: { type: String, required: true },

        action: { type: String, required: true },
        action_family: { type: String, required: true },
        status: { type: String, required: true, enum: AUDIT_STATUSES },
        sensitive: { type: Boolean, required: true, default: false },
        payload: { type: Schema.Types.Mixed, default: null },
        before: { type: Schema.Types.Mixed, default: null },
        after: { type: Schema.Types.Mixed, default: null },
        state_truncated: { type: Boolean, required: true, default: false },

        target_type: { type: String, required: true, enum: AUDIT_TARGET_TYPES },
        target_id: { type: String, default: null },
        target_label: { type: String, default: null },
        subject_class: { type: String, required: true, enum: AUDIT_SUBJECT_CLASSES },
        related_target_type: { type: String, default: null, enum: [...AUDIT_TARGET_TYPES, null] },
        related_target_id: { type: String, default: null },

        outcome_code: { type: String, default: null },
        outcome_status: { type: Number, default: null },
        outcome_message: { type: String, default: null },
        denial_kind: { type: String, default: null },
        // `[]`, never null — ADR-005 D-16.
        required_permissions: { type: [String], required: true, default: [] },
        via_approval_id: { type: Schema.Types.ObjectId, default: null, ref: 'ApprovalRequest' },
        delegated: { type: Boolean, required: true, default: false },
        platform_code: { type: String, default: null },

        // NO `default` on these three. See the header — a default would populate the key
        // on every row and make the TTL's partial filter match everything.
        export_id: { type: Schema.Types.ObjectId, ref: 'AuditExport' },
        exported_at: { type: Date },
        purge_after: { type: Date },
    },
    {
        timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
        collection: AUDIT_LOG_COLLECTION,
        writeConcern: { w: 'majority', j: true },
    },
);

// ─────────────────────────────────────────────────────────────────────────────
// Indexes
//
// Equality field first, `occurred_at` second, `_id` last. The ordering is not
// cosmetic: each branch of the tier-3 scope `$or` then emits already-sorted output, so
// Mongo can merge them instead of buffering and sorting; and `toMongoSort` appends `_id`
// as a stability tiebreaker unconditionally, so an index without it forces a re-sort on
// every page.
// ─────────────────────────────────────────────────────────────────────────────

AuditLogSchema.index({ occurred_at: -1, _id: -1 });                                  // the default feed
AuditLogSchema.index({ actor_id: 1, occurred_at: -1, _id: -1 });                     // "what did they do"
AuditLogSchema.index({ target_type: 1, target_id: 1, occurred_at: -1, _id: -1 });    // "what was done to this"
AuditLogSchema.index({ subject_class: 1, occurred_at: -1 });                         // tier-3 scope
AuditLogSchema.index({ action: 1, occurred_at: -1, _id: -1 });                       // "every suspension, ever"
AuditLogSchema.index({ status: 1, occurred_at: 1 });                                 // dangling-intent sweep
AuditLogSchema.index({ correlation_id: 1, occurred_at: 1 });                         // intent↔outcome, cross-service
AuditLogSchema.index({ export_id: 1, _id: 1 });                                      // purge batching, --restamp

/**
 * THE PURGE. `expireAfterSeconds: 0` means "delete when `purge_after` passes".
 *
 * The `partialFilterExpression` is what makes the rule "exported AND aged" rather than
 * merely "aged" — and it makes that a property of the INDEX, not of the writer. A row
 * that somehow acquired a `purge_after` without an `export_id` is not in this index and
 * cannot be deleted by it.
 *
 * `$type: 'objectId'` rather than `$exists: true` on purpose: if `export_id` ever
 * regained a `default: null`, `$exists` would match every document and the filter would
 * become vacuous — a silent conversion of a conditional purge into an unconditional one.
 * A type test cannot fail that way.
 */
AuditLogSchema.index(
    { purge_after: 1 },
    { expireAfterSeconds: 0, partialFilterExpression: { export_id: { $type: 'objectId' } } },
);

let cached: Model<IAuditLog> | null = null;

export function AuditLogModel(): Model<IAuditLog> {
    if (!cached) {
        cached = adminConnection().model<IAuditLog>('AuditLog', AuditLogSchema);
    }
    return cached;
}

export function resetAuditLogModel(): void {
    cached = null;
}

export { AUDIT_LOG_COLLECTION };
