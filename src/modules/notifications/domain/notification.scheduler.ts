import { env } from '../../../config/env';
import { logger } from '../../../core/logging/logger';
import { ProjectorOptions, TickResult, runOnce } from './notification.projector';

/**
 * The projector's timer — this service's first background loop.
 *
 * ── Why a timer and not a worker framework ────────────────────────────────────
 * `dev-tools` inspects and triggers jovi-mall's fifteen workers over HTTP; it runs none of
 * its own, and until now neither did anything else here. Introducing a scheduler
 * abstraction for one job would be building the framework before the second caller exists.
 * What this needs is a `setInterval` that cannot overlap itself and that stops on drain.
 *
 * ── Why overlap has to be prevented explicitly ────────────────────────────────
 * `setInterval` fires on a wall clock, not on completion. A tick that takes longer than the
 * interval — a large backlog on first run, or a slow `jovi_mall` — would otherwise be
 * joined by the next one, and two concurrent sweeps of the same source race on the same
 * watermark document: both read the same cursor, both deliver the same rows (harmlessly,
 * thanks to the unique index) and then both write a cursor, with the loser's value
 * potentially moving it BACKWARDS. The `running` flag is what makes the loop serial.
 *
 * A skipped tick is not an error and is not logged as one: the next one reads from the same
 * watermark and sees everything the skipped one would have.
 */

let timer: NodeJS.Timeout | null = null;
let running = false;

export function projectorOptions(): ProjectorOptions {
    const config = env();
    return {
        batchSize: config.ADMIN_NOTIFICATIONS_BATCH,
        maxDeliveriesPerSource: config.ADMIN_NOTIFICATIONS_MAX_PER_TICK,
        autoArchiveDays: config.ADMIN_NOTIFICATIONS_AUTO_ARCHIVE_DAYS,
        retentionDays: config.ADMIN_NOTIFICATIONS_RETENTION_DAYS,
    };
}

/**
 * Run one tick unless one is already in flight.
 *
 * Exported because `verify-notifications-live.ts` drives ticks directly rather than waiting
 * out an interval, and because a future `/dev-tools` trigger is the natural way to give an
 * administrator a "sweep now" button without a second code path.
 */
export async function tickOnce(): Promise<TickResult | null> {
    if (running) return null;
    running = true;
    try {
        return await runOnce(projectorOptions());
    } finally {
        running = false;
    }
}

/**
 * Start the loop. Idempotent, and a no-op when the interval is `0`.
 *
 * Deliberately does NOT run a tick immediately at boot. Start-up is when both database
 * connections have just opened and the audit resume is running; adding ten cross-database
 * scans to that moment buys nothing, because the first interval is thirty seconds away and
 * nothing in the inbox is time-critical to that degree.
 */
export function startNotificationProjector(): void {
    if (timer) return;

    const seconds = env().ADMIN_NOTIFICATIONS_SWEEP_S;
    if (seconds === 0) {
        logger().info('notification projector disabled (ADMIN_NOTIFICATIONS_SWEEP_S=0)');
        return;
    }

    timer = setInterval(() => {
        void tickOnce().catch((error) => {
            // `runOnce` catches per source, so reaching here means the sweep itself failed
            // — a lost database connection, most likely. Logged, never rethrown: an
            // unhandled rejection from a timer takes the process down, and the inbox is not
            // worth the service.
            logger().error({ err: error }, 'notification projector tick failed');
        });
    }, seconds * 1000);

    // Without this the interval keeps the event loop alive and the process never exits on
    // its own — the same reason `drain()` exists rather than trusting a signal.
    timer.unref();

    logger().info({ everySeconds: seconds }, 'notification projector started');
}

/**
 * Stop the loop.
 *
 * Called from `drain()` BEFORE the connections close. A tick in flight when Mongo goes away
 * throws inside a timer callback, which is the one place this codebase has no handler for.
 */
export function stopNotificationProjector(): void {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
    logger().info('notification projector stopped');
}

/** Test seam — `test-notifications.ts` asserts start/stop is idempotent without a Mongo. */
export function isProjectorRunning(): boolean {
    return timer !== null;
}
