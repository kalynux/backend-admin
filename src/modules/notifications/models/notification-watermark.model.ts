import { Schema, Document, Types, Model } from 'mongoose';
import { adminConnection } from '../../../infra/mongo/connections';

/**
 * `admin_notification_watermarks` — how far the projector has read each source.
 *
 * One document per `source.registry.ts` entry, in `wi-admin`. The projector reads rows
 * strictly after `(last_seen_at, last_seen_id)` and advances the pair at the end of a
 * batch.
 *
 * ── The watermark bounds the SCAN. It does not decide correctness ─────────────
 * Worth being precise about, because it is easy to read this as an exactly-once mechanism
 * and design against it wrongly. Delivery is made exactly-once by the unique
 * `{ source_key, admin_id }` index on `admin_notifications`, and by nothing else. If this
 * document were deleted, the projector would re-scan its source from the beginning and
 * produce **no** duplicates — only a slow tick.
 *
 * That is what makes the sweep safe to crash: there is no window in which a row is
 * consumed but not delivered, because consuming it again is free.
 *
 * ── Why a compound cursor and not a timestamp ─────────────────────────────────
 * Two rows can share a millisecond. A `> last_seen_at` cursor would skip the second one
 * forever; a `>= last_seen_at` cursor would re-read the first one on every tick and never
 * advance past a busy instant. The `_id` tiebreaker is the same fix ADR-005 D-13 applies
 * to paging, for the same reason, and `_id` is monotonic enough within a millisecond to
 * order rows a timestamp cannot separate.
 *
 * ── No TTL ────────────────────────────────────────────────────────────────────
 * Ten documents that each update once a tick. There is nothing to expire.
 */

export const NOTIFICATION_WATERMARK_COLLECTION = 'admin_notification_watermarks';

export interface INotificationWatermark extends Document {
    _id: Types.ObjectId;

    /** The `source.registry.ts` entry id. */
    source_id: string;

    /** The source row's own transition timestamp — never this service's clock. */
    last_seen_at: Date | null;
    /** Tiebreaker within `last_seen_at`. String, because a source id need not be an ObjectId. */
    last_seen_id: string | null;

    // ── Observability. The projector is this service's first background loop, and a
    // sweep that fails silently is indistinguishable from a platform with nothing to say.
    last_run_at: Date | null;
    last_error: string | null;
    /** Rows delivered on the last non-empty tick — a cheap "is it moving" signal. */
    last_delivered: number;

    created_at: Date;
    updated_at: Date;
}

const NotificationWatermarkSchema = new Schema<INotificationWatermark>(
    {
        source_id: { type: String, required: true },

        last_seen_at: { type: Date, default: null },
        last_seen_id: { type: String, default: null },

        last_run_at: { type: Date, default: null },
        last_error: { type: String, default: null },
        last_delivered: { type: Number, required: true, default: 0 },
    },
    {
        timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
        collection: NOTIFICATION_WATERMARK_COLLECTION,
    },
);

/** One document per source, enforced by the database — the projector upserts on this key. */
NotificationWatermarkSchema.index({ source_id: 1 }, { unique: true });

let cached: Model<INotificationWatermark> | null = null;

export function NotificationWatermarkModel(): Model<INotificationWatermark> {
    if (!cached) {
        cached = adminConnection().model<INotificationWatermark>(
            'NotificationWatermark',
            NotificationWatermarkSchema,
        );
    }
    return cached;
}

export function resetNotificationWatermarkModel(): void {
    cached = null;
}
