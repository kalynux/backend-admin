import { Document, Model, Schema, Types } from 'mongoose';
import { adminConnection } from './connections';

/**
 * The migration ledger for THIS service's own database. Plan step 2.C.5.
 *
 * ── Why wi-admin needs one at all ─────────────────────────────────────────────
 * `scripts/ensure-indexes.ts` is this service's only migration-shaped script, and its
 * header already argues the case: `autoIndex` is off in production (ADR-004,
 * `connections.ts`), so nothing builds these indexes unless somebody runs it deliberately.
 * Two of them are correctness controls rather than optimisations — the partial unique on
 * `admin_approval_requests.request_key` is what makes four-eyes idempotent, and the TTL on
 * `admin_audit_log` is the ONLY thing that removes exported rows past the retention floor.
 *
 * The gap was that "was it run on this deployment" had no answer anywhere. A missing TTL
 * fails safe (nothing is deleted, never the reverse) but silently: the compliance story
 * says rows age out, and they do not, and nobody finds out until storage does.
 *
 * ── Same shape as jovi-mall's, deliberately, and separately ───────────────────
 *   source: jovi-mall/src/core/database/schema-migration.model.ts
 *
 * There is no shared package between these services, so the shape is duplicated the same
 * way `infra/platform/collections.ts` duplicates the collection registry — and for the same
 * reason: it is a schema plus one pure function, carrying no behaviour and no dependency
 * graph. What is NOT duplicated is the runner. jovi-mall has fifteen migrations that need
 * a declared order and a spawner; this service has one, so `ensure:indexes` records its own
 * row inline and `migrate:status` reads it back.
 *
 * The name carries this service's `admin_` prefix rather than jovi-mall's bare
 * `schema_migrations`. The two ledgers live in different databases and answer different
 * questions; matching the local convention beats matching a name across a boundary that
 * nothing reads across.
 *
 * ── Forward-only, append-only ─────────────────────────────────────────────────
 * Same as geo-tracker's `migrate.go` and jovi-mall's ledger. A failed attempt is kept — it
 * is the more useful row during an incident — so status is "the newest row", not "the row",
 * and there is no unique key that would force an upsert to destroy the history.
 */

export type MigrationOutcome = 'success' | 'failed';

export interface ISchemaMigration extends Document {
    _id: Types.ObjectId;
    /** The npm binding, e.g. `ensure:indexes`. The stable identity. */
    name: string;
    /** sha256 of the script source at the moment it ran. */
    checksum: string;
    environment: string;
    applied_at: Date;
    /** `user@host`, best-effort. A ledger nobody can attribute is half a ledger. */
    applied_by: string;
    duration_ms: number;
    outcome: MigrationOutcome;
    /** What it did, or why it did not. Free text, for a person reading the history. */
    note: string | null;
}

export const SCHEMA_MIGRATION_COLLECTION = 'admin_schema_migrations';

const SchemaMigrationSchema = new Schema<ISchemaMigration>(
    {
        name: { type: String, required: true },
        checksum: { type: String, required: true },
        environment: { type: String, required: true },
        applied_at: { type: Date, required: true, default: Date.now },
        applied_by: { type: String, required: true },
        duration_ms: { type: Number, required: true },
        outcome: { type: String, enum: ['success', 'failed'], required: true },
        note: { type: String, default: null },
    },
    { versionKey: false, collection: SCHEMA_MIGRATION_COLLECTION },
);

/**
 * The only read: newest-first within one name and environment.
 *
 * NOT added to `ensure-indexes.ts`'s target list, and that is the point — this index has to
 * exist before the script that would build it has finished running. `recordMigration()`
 * calls `createIndexes()` on the model itself, which is a no-op once it exists.
 */
SchemaMigrationSchema.index({ name: 1, environment: 1, applied_at: -1 });

let cached: Model<ISchemaMigration> | null = null;

export function SchemaMigrationModel(): Model<ISchemaMigration> {
    if (!cached) {
        cached = adminConnection().model<ISchemaMigration>('SchemaMigration', SchemaMigrationSchema);
    }
    return cached;
}

/** Test-only: drop the cached model so a suite can rebind it. */
export function resetSchemaMigrationModel(): void {
    cached = null;
}

export type MigrationStatus = 'not_applied' | 'applied' | 'changed' | 'failed';

export interface LedgerRow {
    checksum: string;
    applied_at: Date;
    outcome: MigrationOutcome;
}

/**
 * Resolve a migration's status from its rows and the checksum of the file on disk.
 *
 * Pure, and the same four states jovi-mall's ledger resolves — `changed` is the one the
 * checksum exists for. Reporting an edited script as `applied` is the failure the whole
 * ledger was built to prevent, and `ensure-indexes.ts` is edited every time this service
 * grows a collection.
 */
export function resolveMigrationStatus(rows: LedgerRow[], currentChecksum: string): MigrationStatus {
    if (rows.length === 0) return 'not_applied';

    const newestFirst = [...rows].sort((a, b) => b.applied_at.getTime() - a.applied_at.getTime());
    const successes = newestFirst.filter((row) => row.outcome === 'success');

    if (successes.length === 0) return 'failed';
    if (newestFirst[0].outcome === 'failed' && newestFirst[0].checksum === currentChecksum) {
        return 'failed';
    }
    return successes[0].checksum === currentChecksum ? 'applied' : 'changed';
}
