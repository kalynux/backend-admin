import { Document, Model, Schema, Types } from 'mongoose';
import { adminConnection } from '../../../infra/mongo/connections';

/**
 * `admin_audit_exports` — one row per export, and the reason a purge is safe.
 *
 * An audit row may only be deleted if it carries an `export_id`, and an `export_id`
 * points here. So this collection is the answer to "where did that row go": the file
 * path, its sha256, and how many rows it holds. Without it the TTL on `admin_audit_log`
 * would be exactly the "quietly erase the record" mechanism `approval-request.model.ts`
 * refuses — this manifest is what makes it a *transfer* rather than a deletion.
 *
 * It follows from that: **this collection has no TTL and nothing deletes from it.** A
 * manifest outlives the file it describes, because "the rows were exported to a file that
 * has since been archived" is a sentence somebody must be able to say.
 *
 * ── The status is what gates the purge ───────────────────────────────────────
 * Only a `complete` manifest may stamp or purge anything. `running` means the file is not
 * durable yet, and `failed` means it never will be. That check is the crash-safety
 * argument in one field: a partial export cannot delete what it did not finish writing.
 */

const AUDIT_EXPORT_COLLECTION = 'admin_audit_exports';

export const AUDIT_EXPORT_STATUSES = ['running', 'complete', 'failed'] as const;
export type AuditExportStatus = (typeof AUDIT_EXPORT_STATUSES)[number];

export const AUDIT_EXPORT_SOURCES = ['api', 'cli'] as const;
export type AuditExportSource = (typeof AUDIT_EXPORT_SOURCES)[number];

export interface IAuditExport extends Document {
    _id: Types.ObjectId;
    status: AuditExportStatus;
    source: AuditExportSource;

    /** Null for a CLI run with no administrator behind it. */
    requested_by: Types.ObjectId | null;
    requested_by_name: string | null;
    correlation_id: string;

    /** The half-open window `[range_from, range_to)` over `occurred_at`. */
    range_from: Date | null;
    range_to: Date | null;
    /** Any additional filter applied, recorded so the file's contents are reproducible. */
    filter: Record<string, unknown> | null;

    file_name: string | null;
    file_path: string | null;
    byte_size: number | null;
    row_count: number | null;
    sha256: string | null;

    /**
     * The highest `_id` written to the file. Stamping is driven by the range plus this
     * watermark rather than by an in-memory list of ids — a list would not survive a
     * restart, and rows created while the export streamed must not be stamped as
     * exported when they are not in the file.
     */
    max_row_id: Types.ObjectId | null;

    /** The floor in force when this ran, so `--restamp` can tell what changed. */
    retention_days: number;

    started_at: Date;
    completed_at: Date | null;
    /** When rows were marked `export_id`/`purge_after`. Null until step 5 of the sequence. */
    stamped_at: Date | null;
    stamped_count: number | null;
    purged_at: Date | null;
    purged_count: number | null;
    failure_reason: string | null;

    created_at: Date;
    updated_at: Date;
}

const AuditExportSchema = new Schema<IAuditExport>(
    {
        status: { type: String, required: true, enum: AUDIT_EXPORT_STATUSES, default: 'running' },
        source: { type: String, required: true, enum: AUDIT_EXPORT_SOURCES },

        requested_by: { type: Schema.Types.ObjectId, default: null, ref: 'AdminAccount' },
        requested_by_name: { type: String, default: null },
        correlation_id: { type: String, required: true },

        range_from: { type: Date, default: null },
        range_to: { type: Date, default: null },
        filter: { type: Schema.Types.Mixed, default: null },

        file_name: { type: String, default: null },
        file_path: { type: String, default: null },
        byte_size: { type: Number, default: null },
        row_count: { type: Number, default: null },
        sha256: { type: String, default: null },
        max_row_id: { type: Schema.Types.ObjectId, default: null },

        retention_days: { type: Number, required: true },

        started_at: { type: Date, required: true, default: () => new Date() },
        completed_at: { type: Date, default: null },
        stamped_at: { type: Date, default: null },
        stamped_count: { type: Number, default: null },
        purged_at: { type: Date, default: null },
        purged_count: { type: Number, default: null },
        failure_reason: { type: String, default: null },
    },
    {
        timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
        collection: AUDIT_EXPORT_COLLECTION,
        writeConcern: { w: 'majority', j: true },
    },
);

// The exports list, newest first.
AuditExportSchema.index({ started_at: -1, _id: -1 });
// Finds the crash case on start-up: a durable file whose rows were never stamped.
AuditExportSchema.index({ status: 1, stamped_at: 1 });

let cached: Model<IAuditExport> | null = null;

export function AuditExportModel(): Model<IAuditExport> {
    if (!cached) {
        cached = adminConnection().model<IAuditExport>('AuditExport', AuditExportSchema);
    }
    return cached;
}

export function resetAuditExportModel(): void {
    cached = null;
}

export { AUDIT_EXPORT_COLLECTION };
