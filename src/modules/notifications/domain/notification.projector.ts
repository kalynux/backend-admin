import { Document } from 'mongodb';
import { logger } from '../../../core/logging/logger';
import { AdminNotificationModel } from '../models/admin-notification.model';
import { NotificationWatermarkModel } from '../models/notification-watermark.model';
import { SourceCursor } from '../repositories/notification-source.read.repository';
import { NOTIFICATION_SOURCES, NotificationSource } from './source.registry';
import { fanOut } from './notification.writer';

/**
 * THE PROJECTOR — the only thing that creates notifications.
 *
 * One tick walks every entry in `source.registry.ts`, reads the rows that appeared since
 * that source's watermark, and fans each out. It is this service's first in-process
 * periodic worker: `dev-tools` inspects jovi-mall's fifteen but runs none of its own, so
 * `lifecycle.ts` grew a timer for this and has to clear it on drain.
 *
 * ── Why it can crash at any point ─────────────────────────────────────────────
 * There is no state that a half-finished tick can corrupt. Rows are delivered by an upsert
 * on `{ source_key, admin_id }`, and the watermark is advanced only after the batch it
 * describes has been fanned out. Crash before the advance and the next tick re-reads the
 * same rows, re-upserts them, and changes nothing. That property is the entire reason this
 * is a projector over committed rows rather than a subscriber to jovi-mall's in-process
 * event bus, whose events are gone the moment a handler misses them.
 *
 * ── Error isolation ───────────────────────────────────────────────────────────
 * A source that throws is caught, recorded on its own watermark document, and skipped. One
 * malformed row in `tracking_outbox` must not stop COD discrepancies from being delivered,
 * and a projector that dies on the first bad row is a projector that is off.
 */

/** Tunables. Passed in rather than read from `env()` so the tests can drive a tick directly. */
export interface ProjectorOptions {
    /** Rows read per source per tick. Bounds the read, not the correctness. */
    batchSize: number;
    /** Rows DELIVERED per source per tick before truncating. See `runSource`. */
    maxDeliveriesPerSource: number;
    /** Archived after this many days. `0` disables the sweep. */
    autoArchiveDays: number;
    /** Days an archived row survives before the TTL removes it. */
    retentionDays: number;
}

export interface SourceTickResult {
    sourceId: string;
    scanned: number;
    delivered: number;
    muted: number;
    skipped: number;
    truncated: boolean;
    error?: string;
}

export interface TickResult {
    sources: SourceTickResult[];
    archived: number;
}

/**
 * Where a source should resume, creating the watermark if this is its first sight.
 *
 * ── A NEW SOURCE STARTS AT `now`, and that is a decision ──────────────────────
 * The first tick of a new source records the clock and delivers NOTHING. Without it, adding
 * `vendors.kyc.pending` would fan out one notification per unreviewed vendor on the
 * platform — the whole historical backlog, to every administrator holding
 * `vendors.kyc.review`, in one tick, on deploy day. `vendor.read.repository.ts:261` is
 * explicit that the pre-existing roster matches that filter.
 *
 * So the inbox carries what happened after it existed, and nothing before. The backlog is
 * not lost and is not this surface's job: it is what `/vendors?kycStatus=pending` and the
 * other list screens are for, and they were built for exactly that question. An inbox that
 * opens with four hundred unread rows is an inbox nobody reads.
 *
 * There is deliberately no backfill switch. If one is ever wanted, it is a CLI that clears
 * a named watermark — visible, deliberate, and not something a deploy does by itself.
 */
async function resumeCursor(source: NotificationSource): Promise<SourceCursor | null> {
    const existing = await NotificationWatermarkModel()
        .findOne({ source_id: source.id })
        .lean()
        .exec();

    if (existing) {
        return existing.last_seen_at
            ? { at: existing.last_seen_at, id: existing.last_seen_id ?? '' }
            : null;
    }

    const now = new Date();
    await NotificationWatermarkModel().updateOne(
        { source_id: source.id },
        {
            $setOnInsert: {
                source_id: source.id,
                last_seen_at: now,
                last_seen_id: '',
                last_run_at: now,
                last_error: null,
                last_delivered: 0,
            },
        },
        { upsert: true },
    );

    logger().info(
        { sourceId: source.id, startingAt: now.toISOString() },
        'notification source registered; starting from now, no backfill',
    );

    return { at: now, id: '' };
}

/** One source, one tick. Never throws — a failure is recorded and reported. */
export async function runSource(
    source: NotificationSource,
    options: ProjectorOptions,
): Promise<SourceTickResult> {
    const result: SourceTickResult = {
        sourceId: source.id,
        scanned: 0,
        delivered: 0,
        muted: 0,
        skipped: 0,
        truncated: false,
    };

    try {
        const cursor = await resumeCursor(source);
        const rows = await source.fetch(cursor, options.batchSize);
        result.scanned = rows.length;

        if (rows.length === 0) {
            await stampRun(source.id, null, 0, null);
            return result;
        }

        let advanceTo: Document | null = null;

        for (const row of rows) {
            // The watermark advances over EVERY row read, including ones the source
            // declines and ones dropped by the cap. A row that is skipped is a row this
            // source has decided about; leaving the cursor behind it would make the sweep
            // re-read it forever and never reach the rows behind it.
            advanceTo = row;

            if (result.delivered >= options.maxDeliveriesPerSource) {
                result.truncated = true;
                result.skipped += 1;
                continue;
            }

            const draft = source.toDraft(row);
            if (!draft) {
                result.skipped += 1;
                continue;
            }

            const fanned = await fanOut(source, draft, String(row._id));
            result.delivered += fanned.delivered;
            result.muted += fanned.muted;
        }

        const cursorAt = valueAt(advanceTo, source.watermarkField);
        if (advanceTo && cursorAt instanceof Date) {
            await stampRun(
                source.id,
                { at: cursorAt, id: String(advanceTo._id) },
                result.delivered,
                null,
            );
        }

        if (result.truncated) {
            // Never a silent cap. A truncated tick is indistinguishable from a quiet one in
            // the data, so it has to say so — and the next tick picks up where this one
            // stopped, because the watermark advanced over the dropped rows.
            logger().warn(
                {
                    sourceId: source.id,
                    cap: options.maxDeliveriesPerSource,
                    droppedThisTick: result.skipped,
                },
                'notification source hit its per-tick delivery cap; rows past the cap were not delivered',
            );
        }
    } catch (error) {
        result.error = error instanceof Error ? error.message : String(error);
        logger().error({ sourceId: source.id, err: error }, 'notification source failed its tick');
        await stampRun(source.id, null, 0, result.error).catch(() => undefined);
    }

    return result;
}

/**
 * Read a possibly-DOTTED field off a returned document.
 *
 * A watermark field is a Mongo query path, and Mongo accepts dotted paths in filters,
 * sorts and projections — but the document that comes BACK is nested, so
 * `row['dispute_hold.disputed_at']` is `undefined` while the query that produced it worked
 * perfectly. The cursor would then never advance, the sweep would re-read the same batch
 * forever, and idempotency would hide it: no duplicates, no errors, just a source stuck at
 * its first page.
 *
 * `order_disputed` watermarks on exactly such a path, because that is the key of the
 * partial index its filter matches.
 */
function valueAt(row: Document | null, path: string): unknown {
    if (!row) return undefined;
    return path.split('.').reduce<unknown>(
        (value, segment) =>
            (value && typeof value === 'object')
                ? (value as Record<string, unknown>)[segment]
                : undefined,
        row,
    );
}

/** Record the outcome of a tick, advancing the cursor only when there is one to advance to. */
async function stampRun(
    sourceId: string,
    cursor: SourceCursor | null,
    delivered: number,
    error: string | null,
): Promise<void> {
    const update: Record<string, unknown> = {
        last_run_at: new Date(),
        last_error: error,
    };

    if (cursor) {
        update.last_seen_at = cursor.at;
        update.last_seen_id = cursor.id;
        update.last_delivered = delivered;
    }

    await NotificationWatermarkModel().updateOne({ source_id: sourceId }, { $set: update });
}

/**
 * Archive rows nobody has touched in a long time, and set them on the TTL's path.
 *
 * Read or unread — deliberately. An unread notification from three months ago is not
 * waiting to be read; the thing it was about has been resolved or has not, and either way
 * the answer is on the screen that owns it. Keeping it unread forever makes the badge a
 * number that only goes up, which is the state that teaches administrators to ignore it.
 *
 * `purge_after` is stamped here rather than by the TTL, because the TTL's partial filter
 * keys on `archived_at` existing — a row needs both fields to be deletable, and setting
 * them together is what makes "archived AND aged" true of every row the index can see.
 */
export async function autoArchive(options: ProjectorOptions): Promise<number> {
    if (options.autoArchiveDays <= 0) return 0;

    const cutoff = new Date(Date.now() - options.autoArchiveDays * 24 * 60 * 60 * 1000);
    const now = new Date();
    const purgeAfter = new Date(now.getTime() + options.retentionDays * 24 * 60 * 60 * 1000);

    const result = await AdminNotificationModel().updateMany(
        { archived_at: { $exists: false }, occurred_at: { $lt: cutoff } },
        { $set: { archived_at: now, purge_after: purgeAfter } },
    );

    if (result.modifiedCount > 0) {
        logger().info(
            { archived: result.modifiedCount, olderThanDays: options.autoArchiveDays },
            'auto-archived aged notifications',
        );
    }

    return result.modifiedCount;
}

/** One full tick across every source, then the archive sweep. Never throws. */
export async function runOnce(options: ProjectorOptions): Promise<TickResult> {
    const sources: SourceTickResult[] = [];

    // Sequential, not `Promise.all`. Ten sources against two databases on a background
    // timer has no latency requirement worth the connection pressure, and a serial sweep
    // keeps one slow source from delaying the others' writes rather than their reads.
    for (const source of NOTIFICATION_SOURCES) {
        sources.push(await runSource(source, options));
    }

    let archived = 0;
    try {
        archived = await autoArchive(options);
    } catch (error) {
        logger().error({ err: error }, 'notification auto-archive failed');
    }

    const delivered = sources.reduce((sum, source) => sum + source.delivered, 0);
    if (delivered > 0) {
        logger().info({ delivered, archived }, 'notification projector tick delivered rows');
    }

    return { sources, archived };
}
