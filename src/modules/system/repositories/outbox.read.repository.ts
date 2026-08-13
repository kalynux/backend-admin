import { Document } from 'mongodb';
import { COLLECTIONS } from '../../../infra/platform/collections';
import { PlatformReadRepository } from '../../../infra/platform/platform.repository';

/**
 * The tracking outbox, read directly out of `jovi_mall`.
 *
 * ── Why direct rather than delegated ──────────────────────────────────────────
 * ADR-009 D-1: delegate a read whose answer is a VERDICT, read directly a read whose answer
 * is a RECORD. Outbox rows are records — append-only, already `access: 'read'` — so a
 * second reader costs nothing and adds no coupling. `/system/workers` goes the other way in
 * the same controller, because worker state is in-memory cron in the other process and
 * cannot be read at all.
 *
 * ── What this deliberately does not expose ────────────────────────────────────
 * Not the payloads. An outbox row carries shipment verdicts, agent ids and a customer's
 * delivery details, and none of that belongs on an operational health screen — the question
 * here is "is the queue moving", which counts and ages answer completely. The base class
 * requires a projection for exactly this reason; the aggregation below never selects a
 * payload field at all.
 */
interface OutboxRow extends Document {
    status: string;
    attempts: number;
    created_at: Date;
}

export interface OutboxSummary {
    depth: { pending: number; failed: number; sent: number };
    oldestPendingAt: string | null;
    /** The worst retry count still in the queue — a stuck row shows up here first. */
    maxAttempts: number;
    totalUnsent: number;
}

export class OutboxReadRepository extends PlatformReadRepository<OutboxRow> {
    constructor() {
        // Narrow on purpose: three fields, none of them a payload.
        super(COLLECTIONS.TRACKING_OUTBOX, { status: 1, attempts: 1, created_at: 1 });
    }

    /**
     * Depth by status, plus the two facts that distinguish "busy" from "stuck": how old the
     * oldest un-dispatched row is, and the highest retry count still outstanding.
     *
     * One aggregation rather than four counts — the dispatcher drains every 2 seconds, so
     * separate queries would report a state the queue was never actually in.
     */
    async summary(): Promise<OutboxSummary> {
        const rows = await this.collection()
            .aggregate<{ _id: string; count: number; oldest: Date | null; maxAttempts: number }>([
                {
                    $group: {
                        _id: '$status',
                        count: { $sum: 1 },
                        oldest: { $min: '$created_at' },
                        maxAttempts: { $max: '$attempts' },
                    },
                },
            ])
            .toArray();

        const byStatus = new Map(rows.map((row) => [row._id, row]));
        const pending = byStatus.get('pending');
        const failed = byStatus.get('failed');

        return {
            depth: {
                pending: pending?.count ?? 0,
                failed: failed?.count ?? 0,
                sent: byStatus.get('sent')?.count ?? 0,
            },
            oldestPendingAt: pending?.oldest ? pending.oldest.toISOString() : null,
            maxAttempts: Math.max(pending?.maxAttempts ?? 0, failed?.maxAttempts ?? 0),
            totalUnsent: (pending?.count ?? 0) + (failed?.count ?? 0),
        };
    }
}
