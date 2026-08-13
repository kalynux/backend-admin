import { createHash } from 'crypto';
import { createWriteStream } from 'fs';
import { mkdir, open, rename, stat, unlink } from 'fs/promises';
import path from 'path';
import { FilterQuery, Types } from 'mongoose';
import { env } from '../../../config/env';
import { logger } from '../../../core/logging/logger';
import { createAppError } from '../../../core/errors/app-error';
import { ERROR_CODES } from '../../../core/errors/error-codes';
import { AuditLogModel, IAuditLog } from '../models/audit-log.model';
import { AuditExportModel, IAuditExport } from '../models/audit-export.model';
import { purgeAfterFor } from './audit-retention';
import { auditedAttempt } from './audit.writer';
import { systemActor, systemContext } from './audit-context';
import { AuditActor, AuditContext } from './audit.types';

/**
 * Exporting the audit trail, and the only path that deletes a row.
 *
 * ── The retention rule this implements ────────────────────────────────────────
 * A row leaves the database only when BOTH hold: it has been exported to a durable file,
 * and it is at least `ADMIN_AUDIT_RETENTION_DAYS` old. So:
 *
 *   never exported      → no `purge_after` at all  → nothing can delete it
 *   exported, past N    → `purge_after` in the past → deleted in this run
 *   exported, before N  → `purge_after` in future   → the TTL index takes it at N days
 *
 * ── Why the ordering below is the crash-safety argument ───────────────────────
 * The file is made durable BEFORE any row is stamped, and only a `complete` manifest may
 * stamp or purge. A crash between the rename and the stamping therefore leaves rows in a
 * file AND still unstamped, so the next run exports them again.
 *
 * **Duplicate rows across two export files are harmless. A deleted row that was never
 * durably exported is not.** That asymmetry is why every step leans the way it does.
 *
 * Every step is a `$set` of a computed value or a filtered `deleteMany`, so re-running is
 * a no-op rather than a second effect.
 */

export interface RunExportInput {
    /** Half-open `[from, to)` over `occurred_at`. Both optional for the CLI. */
    from?: Date | null;
    to?: Date | null;
    source: 'api' | 'cli';
    requestedBy?: { id: string; name: string } | null;
    correlationId: string;
    /** Refuse above this many rows. The API passes a cap; the CLI passes none. */
    maxRows?: number;
    /** Delete the rows that are past retention once the file is durable. */
    purge?: boolean;
    /**
     * Who is exporting. REQUIRED — an export moves the compliance record out of the system
     * and is the precondition for deleting it, so a row attributed to nobody would be the
     * one place the trail is least trustworthy.
     *
     * The CLI passes `systemActor('audit export CLI')`; there is genuinely no administrator
     * behind `npm run audit:export`, and inventing one would be a lie.
     */
    actor: AuditActor;
    context: AuditContext;
}

export interface RunExportResult {
    manifest: IAuditExport;
    rowCount: number;
    stampedCount: number;
    purgedCount: number;
}

function rangeFilter(from?: Date | null, to?: Date | null): FilterQuery<IAuditLog> {
    if (!from && !to) return {};
    const range: Record<string, Date> = {};
    if (from) range.$gte = from;
    if (to) range.$lt = to;
    return { occurred_at: range } as FilterQuery<IAuditLog>;
}

function fileStamp(date: Date | null | undefined, fallback: string): string {
    return (date ? date.toISOString() : fallback).replace(/[:.]/g, '-');
}

/**
 * Export a range to NDJSON, then stamp and optionally purge.
 *
 * **NDJSON, not CSV or a JSON array.** `before`/`after`/`payload` are nested, and a
 * compliance export that flattens away the change detail is not an export; a single array
 * cannot be streamed, resumed, or read one row at a time. NDJSON appends, greps, and
 * `jq -c` reads it.
 */
export async function runExport(input: RunExportInput): Promise<RunExportResult> {
    return auditedAttempt<RunExportResult>(
        {
            action: 'audit.export',
            actor: input.actor,
            target: { type: 'audit_export', id: null, label: null },
            context: input.context,
            payload: {
                from: input.from?.toISOString() ?? null,
                to: input.to?.toISOString() ?? null,
                source: input.source,
                purge: input.purge === true,
            },
        },
        async () => {
            const result = await performExport(input);
            return {
                result,
                target: { id: String(result.manifest._id) },
                after: {
                    fileName: result.manifest.file_name,
                    rowCount: result.rowCount,
                    sha256: result.manifest.sha256,
                    byteSize: result.manifest.byte_size,
                    stampedCount: result.stampedCount,
                    purgedCount: result.purgedCount,
                },
            };
        },
    );
}

async function performExport(input: RunExportInput): Promise<RunExportResult> {
    const config = env();
    const log = logger();
    const filter = rangeFilter(input.from, input.to);

    const rowCount = await AuditLogModel().countDocuments(filter);

    if (input.maxRows !== undefined && rowCount > input.maxRows) {
        throw createAppError(
            ERROR_CODES.AUDIT_EXPORT_TOO_LARGE,
            422,
            `That range covers ${rowCount} rows; this endpoint exports at most ${input.maxRows}. `
            + 'Narrow the range, or run `npm run audit:export`, which has no cap.',
            { rowCount, maxRows: input.maxRows },
        );
    }

    await mkdir(config.ADMIN_AUDIT_EXPORT_DIR, { recursive: true });

    // ── 1. Manifest first, as `running` ──────────────────────────────────────
    const [manifest] = await AuditExportModel().create([{
        status: 'running',
        source: input.source,
        requested_by: input.requestedBy ? new Types.ObjectId(input.requestedBy.id) : null,
        requested_by_name: input.requestedBy?.name ?? null,
        correlation_id: input.correlationId,
        range_from: input.from ?? null,
        range_to: input.to ?? null,
        filter: null,
        retention_days: config.ADMIN_AUDIT_RETENTION_DAYS,
    }]);

    const exportId = manifest._id;
    const fileName = `audit-${fileStamp(input.from, 'begin')}-${fileStamp(input.to, 'now')}-${exportId.toString()}.ndjson`;
    const finalPath = path.join(config.ADMIN_AUDIT_EXPORT_DIR, fileName);
    const partPath = `${finalPath}.part`;

    try {
        // ── 2. Stream, hashing as we go ──────────────────────────────────────
        // Stable order (`occurred_at` then `_id`) so a re-export of the same range
        // produces the same file, and so the `_id` watermark below is meaningful.
        const hash = createHash('sha256');
        const stream = createWriteStream(partPath, { flags: 'w' });
        let written = 0;
        let maxRowId: Types.ObjectId | null = null;

        const cursor = AuditLogModel().find(filter).sort({ occurred_at: 1, _id: 1 }).lean().cursor();

        for await (const row of cursor) {
            const line = `${JSON.stringify(row)}\n`;
            hash.update(line);
            if (!stream.write(line)) {
                await new Promise<void>((resolve) => stream.once('drain', resolve));
            }
            written += 1;
            maxRowId = row._id as Types.ObjectId;
        }

        await new Promise<void>((resolve, reject) => {
            stream.end((error?: Error) => (error ? reject(error) : resolve()));
        });

        // ── 3. fsync, then rename. The file is durable only after this ──────
        // Without the fsync, a power loss can leave a renamed file whose contents were
        // never flushed — and we would then be entitled to delete rows it does not hold.
        const handle = await open(partPath, 'r+');
        try {
            await handle.sync();
        } finally {
            await handle.close();
        }

        await rename(partPath, finalPath);

        const digest = hash.digest('hex');
        const { size } = await stat(finalPath);

        // ── 4. Manifest → complete. Nothing may be stamped before this line ──
        manifest.status = 'complete';
        manifest.file_name = fileName;
        manifest.file_path = finalPath;
        manifest.byte_size = size;
        manifest.row_count = written;
        manifest.sha256 = digest;
        manifest.max_row_id = maxRowId;
        manifest.completed_at = new Date();
        await manifest.save();

        log.info({ exportId: exportId.toString(), rows: written, bytes: size }, 'audit export written');

        // ── 5 & 6. Stamp, then purge ────────────────────────────────────────
        // The purge writes its OWN row (nested inside this export's), because deleting is a
        // different act from exporting and only one of the two is irreversible.
        const stampedCount = await stampExported(manifest);
        const purgedCount = input.purge ? await purgeExpired(manifest, input.actor, input.context) : 0;

        return { manifest, rowCount: written, stampedCount, purgedCount };
    } catch (error) {
        manifest.status = 'failed';
        manifest.failure_reason = error instanceof Error ? error.message : String(error);
        await manifest.save().catch(() => undefined);
        // Leave no orphan `.part`; a stale one would be mistaken for a durable file.
        await unlink(partPath).catch(() => undefined);
        throw error;
    }
}

/**
 * Mark every row the file holds as exported, and compute when each may be deleted.
 *
 * Driven by the manifest's own range plus the `_id` watermark, never by an in-memory list:
 * a list would not survive a restart, and rows written while the export streamed must not
 * be marked as exported when they are not in the file.
 *
 * `purge_after` is `occurred_at + N days` — a property of the EVENT. Computing `now + N`
 * would silently extend a row's life by however long the export was delayed.
 */
export async function stampExported(manifest: IAuditExport, retentionDays?: number): Promise<number> {
    if (manifest.status !== 'complete') {
        throw createAppError(
            ERROR_CODES.AUDIT_EXPORT_INCOMPLETE,
            409,
            'Only a completed export may stamp rows — its file is not durable yet',
        );
    }

    const days = retentionDays ?? manifest.retention_days;
    const filter: FilterQuery<IAuditLog> = {
        ...rangeFilter(manifest.range_from, manifest.range_to),
        ...(manifest.max_row_id ? { _id: { $lte: manifest.max_row_id } } : {}),
    };

    // Per row, because `purge_after` derives from that row's own `occurred_at`. Batched
    // by the cursor rather than loaded whole — an export can cover millions of rows.
    let stamped = 0;
    const cursor = AuditLogModel().find(filter).select('_id occurred_at').lean().cursor();

    for await (const row of cursor) {
        await AuditLogModel().updateOne(
            { _id: row._id },
            {
                $set: {
                    export_id: manifest._id,
                    exported_at: new Date(),
                    purge_after: purgeAfterFor(row.occurred_at as Date, days),
                },
            },
        );
        stamped += 1;
    }

    manifest.stamped_at = new Date();
    manifest.stamped_count = stamped;
    await manifest.save();

    return stamped;
}

/**
 * Delete the exported rows that have passed their retention floor.
 *
 * The TTL index would eventually do this on its own — its monitor runs about once a
 * minute — but "deleted immediately after the file is durable" is the stated rule, so the
 * explicit delete is the primary path and the TTL is the backstop for a crash between
 * stamping and deleting.
 *
 * Both conditions are in the filter, not just the date: a row without an `export_id`
 * cannot be deleted here any more than it can by the index.
 */
export async function purgeExpired(
    manifest: IAuditExport,
    actor: AuditActor,
    context: AuditContext,
): Promise<number> {
    if (manifest.status !== 'complete') {
        throw createAppError(ERROR_CODES.AUDIT_EXPORT_INCOMPLETE, 409);
    }

    /**
     * Its own row, separate from the export's.
     *
     * This is the ONLY code path in the service that deletes an audit row, and it had no
     * record of itself at all until Phase 12 — a `logger().warn` and a count on the
     * manifest, both of which live outside the trail. An audit system whose one destructive
     * operation is invisible in its own output is the specific failure this phase existed
     * to fix.
     *
     * Intent-first (`external`/`auditedAttempt`) rather than transactional, and for a
     * deletion that ordering is a feature: the `attempted` row naming the export and the
     * cut-off is written BEFORE anything goes, so a crash mid-purge leaves evidence of what
     * was about to be removed instead of a silent hole.
     */
    return auditedAttempt<number>(
        {
            action: 'audit.purge',
            actor,
            target: { type: 'audit_export', id: String(manifest._id), label: manifest.file_name },
            context,
            payload: { exportId: String(manifest._id), file: manifest.file_name },
        },
        async () => {
            const deleted = await deleteExpiredInBatches(manifest);

            manifest.purged_at = new Date();
            manifest.purged_count = deleted;
            await manifest.save();

            logger().warn(
                { exportId: manifest._id.toString(), deleted, file: manifest.file_name },
                'audit rows purged after export',
            );

            return { result: deleted, after: { deletedCount: deleted, exportId: String(manifest._id) } };
        },
    );
}

/**
 * How many rows one `deleteMany` may take.
 *
 * The unbounded `deleteMany` this replaces was fine on a young trail and would not have
 * stayed fine: `admin_audit_log` is the largest collection in the service by design, and a
 * year's retention on a busy deployment makes a single delete a long-running,
 * un-interruptible operation holding locks while the API is live.
 *
 * Batching also makes a partial purge coherent — each batch is durable on its own, so a
 * crash leaves fewer rows rather than an ambiguous half-state.
 */
const PURGE_BATCH_SIZE = 1_000;

async function deleteExpiredInBatches(manifest: IAuditExport): Promise<number> {
    // Pinned once: rows crossing their retention floor mid-purge belong to the next run,
    // not this one, so the set being deleted cannot grow while the loop walks it.
    const cutoff = new Date();
    let deleted = 0;

    for (;;) {
        const batch = await AuditLogModel()
            .find({ export_id: manifest._id, purge_after: { $lte: cutoff } })
            .select('_id')
            .limit(PURGE_BATCH_SIZE)
            .lean();

        if (batch.length === 0) break;

        const result = await AuditLogModel().deleteMany({ _id: { $in: batch.map((row) => row._id) } });
        deleted += result.deletedCount ?? 0;

        // A short batch means the cursor reached the end; one more round-trip would only
        // confirm zero.
        if (batch.length < PURGE_BATCH_SIZE) break;
    }

    return deleted;
}

/**
 * Recompute `purge_after` for rows already exported, after the retention floor changes.
 *
 * Without this, changing `ADMIN_AUDIT_RETENTION_DAYS` would only affect rows exported
 * afterwards, and already-exported rows would keep dying on the old schedule — which
 * would make "the retention period is configurable" untrue in the only case where anyone
 * would want to change it.
 */
export async function restampRetention(
    retentionDays: number,
    actor: AuditActor = systemActor('audit export CLI'),
    context: AuditContext = systemContext('audit/domain/audit-export.service#restampRetention'),
): Promise<number> {
    /**
     * Audited because this moves the deletion date of the ENTIRE archive at once.
     *
     * It is the highest-leverage single operation the service has over its own evidence —
     * shortening the retention floor makes rows deletable that were not, across every
     * export ever taken — and it was neither catalogued nor recorded before Phase 12.
     */
    return auditedAttempt<number>(
        {
            action: 'audit.retention.restamp',
            actor,
            target: { type: 'audit_export', id: null, label: null },
            context,
            payload: { retentionDays },
        },
        async () => {
            let restamped = 0;
            const cursor = AuditLogModel()
                .find({ export_id: { $type: 'objectId' } })
                .select('_id occurred_at')
                .lean()
                .cursor();

            for await (const row of cursor) {
                await AuditLogModel().updateOne(
                    { _id: row._id },
                    { $set: { purge_after: purgeAfterFor(row.occurred_at as Date, retentionDays) } },
                );
                restamped += 1;
            }

            return { result: restamped, after: { retentionDays, restampedCount: restamped } };
        },
    );
}

/**
 * Finish any export that wrote a durable file but died before stamping its rows.
 *
 * Called at start-up. The rows are in a file whose sha256 is recorded, so they are safe to
 * stamp; leaving them unstamped means they are never eligible for deletion and the
 * collection grows forever with the compliance story saying otherwise.
 */
export async function resumeUnstampedExports(): Promise<number> {
    const pending = await AuditExportModel().find({ status: 'complete', stamped_at: null });

    for (const manifest of pending) {
        try {
            /**
             * Recorded as a restamp, with the export as its target.
             *
             * Stamping is what makes rows eligible for deletion, so a boot-time resume moves
             * the same lever `--restamp` does — quietly, on a schedule nobody triggered. It
             * reuses `audit.retention.restamp` rather than earning its own action: the fact
             * worth recording is that rows became deletable, not which of the two paths did
             * it, and `payload.reason` distinguishes them for anyone who asks.
             */
            await auditedAttempt<number>(
                {
                    action: 'audit.retention.restamp',
                    actor: systemActor('startup export resume'),
                    target: {
                        type: 'audit_export',
                        id: String(manifest._id),
                        label: manifest.file_name,
                    },
                    context: systemContext('audit/domain/audit-export.service#resumeUnstampedExports'),
                    payload: { reason: 'resume_unstamped', exportId: String(manifest._id) },
                },
                async () => {
                    const stamped = await stampExported(manifest);
                    return { result: stamped, after: { stampedCount: stamped } };
                },
            );
            logger().info({ exportId: manifest._id.toString() }, 'resumed stamping for a completed export');
        } catch (error) {
            logger().error(
                { exportId: manifest._id.toString(), err: String(error) },
                'failed to resume stamping for a completed export',
            );
        }
    }

    return pending.length;
}
