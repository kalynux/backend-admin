import { Document, Model, Schema, Types } from 'mongoose';
import { adminConnection } from '../../../infra/mongo/connections';
import {
    AUTOMATION_CHANNELS,
    AUTOMATION_FAILURE_KINDS,
    AutomationChannel,
    AutomationFailureKind,
} from '../domain/automation.types';

/**
 * `admin_automation_failures` — what the n8n automation layer reported about itself.
 *
 * ── This is NOT the audit trail, and the distinction is load-bearing ──────────
 * `admin_audit_log` is "the append-only record of every administrator action", written
 * with `w: 'majority', j: true` because a lost row means an action that happened and is
 * not in the trail. Nothing here is an administrator and nothing here is an action: these
 * are observations a machine made about its own failures. Folding them into that
 * collection would put rows with no actor into a trail whose central claim is that every
 * row has one, and would drown a security review in operational noise.
 *
 * The ordinary write concern therefore applies. Losing a failure report costs a line on a
 * monitoring screen, not the integrity of a record.
 *
 * ── THE TTL, and why it is allowed here ───────────────────────────────────────
 * This service is deliberately hostile to TTLs. `approval-request.model.ts` refuses one
 * outright — "a TTL would quietly erase the record of an attempt" — and `admin_audit_log`
 * has one only behind a partial filter that makes every deletion traceable to an exported
 * file. This collection has an unconditional TTL, and the argument is not that the rule is
 * inconvenient, it is that neither reason applies:
 *
 *   - the approval rule protects the record of an ATTEMPT BY A PERSON. There is no person.
 *   - the audit rule guarantees a deleted row survives in a durable export. Nothing
 *     downstream consumes these rows: no export, no compliance obligation, no reconciliation.
 *     They exist to be read on a dashboard within days of the failure they describe.
 *
 * A failure report is telemetry with a natural half-life. If that ever stops being true —
 * if anything starts reconciling against these rows — this TTL has to be revisited in the
 * same change, exactly as `ADR-B02` demands of geo-tracker's `tracking_audit`.
 *
 * ── The customer identifier is HASHED, never stored ───────────────────────────
 * `external_id_hash` is a digest of a Telegram chat id or a WhatsApp phone number. Storing
 * either in the clear would put a customer identifier in a collection with no disclosure
 * controls, reachable by tier 3, purely as a side effect of monitoring a machine. The hash
 * keeps the one property an operator actually needs — telling "one customer hit this ten
 * times" from "ten customers hit it once" — and gives up the one nobody needs, which is
 * knowing who.
 */

const AUTOMATION_FAILURE_COLLECTION = 'admin_automation_failures';

export interface IAutomationFailure extends Document {
    _id: Types.ObjectId;

    /** n8n's workflow id. The allowlist lives in the reporter, not here. */
    workflow_id: string;
    workflow_name: string | null;
    /**
     * n8n's execution id. Nullable because a degraded-turn report can in principle be
     * emitted from a context that has none, and a required field would make the reporter
     * invent one — which would defeat the idempotency key it participates in.
     */
    execution_id: string | null;
    kind: AutomationFailureKind;

    /** When the failure happened, per the reporter — the feed's sort key. */
    occurred_at: Date;
    /** When this service stored it. The gap is the reporting latency. */
    received_at: Date;

    node_name: string | null;
    error_message: string | null;
    /** Tier 1 only. Projected away below that — see `failure-exposure.ts`. */
    error_stack: string | null;

    channel: AutomationChannel;
    external_id_hash: string | null;
    /** n8n's `$execution.id`, the same value that travelled as `X-Request-Id`. */
    request_id: string | null;

    /** The TTL's clock. Set on write from `ADMIN_AUTOMATION_RETENTION_DAYS`. */
    purge_after: Date;

    created_at: Date;
    updated_at: Date;
}

const AutomationFailureSchema = new Schema<IAutomationFailure>(
    {
        workflow_id: { type: String, required: true },
        workflow_name: { type: String, default: null },
        execution_id: { type: String, default: null },
        kind: { type: String, required: true, enum: AUTOMATION_FAILURE_KINDS },

        occurred_at: { type: Date, required: true, default: () => new Date() },
        received_at: { type: Date, required: true, default: () => new Date() },

        node_name: { type: String, default: null },
        error_message: { type: String, default: null },
        error_stack: { type: String, default: null },

        channel: { type: String, required: true, enum: AUTOMATION_CHANNELS, default: 'unknown' },
        external_id_hash: { type: String, default: null },
        request_id: { type: String, default: null },

        purge_after: { type: Date, required: true },
    },
    {
        timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
        collection: AUTOMATION_FAILURE_COLLECTION,
    },
);

// ─────────────────────────────────────────────────────────────────────────────
// Indexes. Equality field first, `occurred_at` second, `_id` last — the ordering
// `audit-log.model.ts` explains: each branch emits already-sorted output, and the sort
// appends `_id` as a stability tiebreaker unconditionally.
// ─────────────────────────────────────────────────────────────────────────────

AutomationFailureSchema.index({ occurred_at: -1, _id: -1 });                  // the default feed
AutomationFailureSchema.index({ workflow_id: 1, occurred_at: -1, _id: -1 });  // "what is this workflow doing"
AutomationFailureSchema.index({ kind: 1, occurred_at: -1, _id: -1 });         // degraded vs failed
AutomationFailureSchema.index({ channel: 1, occurred_at: -1, _id: -1 });      // "is WhatsApp broken again"

/**
 * IDEMPOTENCY, and it is doing more work than a retry guard.
 *
 * Two distinct sources report the same incident by design. When a send node throws inside
 * `wi-mall-core`, the sub-workflow dies and the failure propagates to the adapter's
 * Execute Workflow node (`waitForSubWorkflow: true`), so `wi-mall-tg-adapter` or `wi-mall-wa-adapter`
 * fails too and its own Error Trigger fires. Those are two rows with two different
 * `workflow_id`s, and both are TRUE — the key is scoped per workflow so both survive.
 *
 * What it collapses is the same workflow reporting the same execution twice, which is
 * what an n8n retry produces.
 *
 * `partialFilterExpression` on `execution_id` matters: a null `execution_id` would
 * otherwise collide with every other null under a plain unique index, and the second
 * degraded-turn report of the day would be silently rejected.
 */
AutomationFailureSchema.index(
    { workflow_id: 1, execution_id: 1, kind: 1 },
    { unique: true, partialFilterExpression: { execution_id: { $type: 'string' } } },
);

/** THE PURGE. Unconditional — see the header for why that is permitted here and nowhere else. */
AutomationFailureSchema.index({ purge_after: 1 }, { expireAfterSeconds: 0 });

let cached: Model<IAutomationFailure> | null = null;

export function AutomationFailureModel(): Model<IAutomationFailure> {
    if (!cached) {
        cached = adminConnection().model<IAutomationFailure>('AutomationFailure', AutomationFailureSchema);
    }
    return cached;
}

export function resetAutomationFailureModel(): void {
    cached = null;
}

export { AUTOMATION_FAILURE_COLLECTION };
