import type { Server } from 'http';
import { env } from './config/env';
import { logger } from './core/logging/logger';
import { createApp } from './app';
import { connectAll, closeAll, assertAuditStoreTransactional } from './infra/mongo/connections';
import { closeRedisClients, getRedisClient, ADMIN_SESSION_DB } from './infra/redis/redis.factory';
import { initAuthRateLimiter } from './api/middlewares/auth-rate-limit.middleware';
import { flushPendingAudit } from './modules/audit/domain/audit.writer';
import { resumeUnstampedExports } from './modules/audit/domain/audit-export.service';
import {
    startNotificationProjector,
    stopNotificationProjector,
} from './modules/notifications/domain/notification.scheduler';

/**
 * Service lifecycle: start-up and drain.
 *
 * Kept separate from `server.ts` (which is a three-line entrypoint) so the drain can be
 * invoked and asserted directly by `scripts/test/verify-live.ts`. That is not merely
 * convenient — on Windows a real `SIGTERM` cannot be delivered to a child process at all
 * (Node maps `child.kill('SIGTERM')` onto `TerminateProcess`, an uncatchable hard kill),
 * so a signal-only shutdown path would be untestable on the development platform and
 * would first be exercised in production.
 *
 * BOOT ORDER is load-bearing: validate configuration → open both databases → only then
 * bind the port. The service must never accept a request it cannot serve.
 *
 * jovi-mall has no shutdown handling at all — it calls `app.listen` and stops there, so a
 * deploy severs in-flight requests and leaves Mongo and Redis connections to time out
 * server-side. `drain()` exists to avoid inheriting that.
 */

let httpServer: Server | null = null;
let draining = false;

export async function startServer(): Promise<Server> {
    // Throws with every problem listed at once. Nothing is listening yet.
    const config = env();

    const log = logger();
    log.info({ nodeEnv: config.NODE_ENV, port: config.PORT, logLevel: config.LOG_LEVEL }, 'wi-admin starting');

    // Databases BEFORE the port.
    await connectAll();
    log.info('both database connections established');

    // And before the port, prove the audit store can actually do what the audit
    // subsystem promises. An administrator action and its audit row commit together or
    // not at all; a standalone mongod cannot do that, and a service that starts anyway
    // would be silently unauditable while looking healthy.
    await assertAuditStoreTransactional();

    // Redis BEFORE the port too, as of Phase 2. It was deliberately optional in Phase 1,
    // but admin sessions live there: a service that cannot reach Redis cannot
    // authenticate anyone, so booting into that state would only serve 500s that look
    // like an application fault rather than a missing dependency.
    await getRedisClient(ADMIN_SESSION_DB);
    log.info('redis session store connected');

    // Swap the auth limiter onto the shared Redis store now that it is reachable, so the
    // per-IP credential limit holds across instances instead of per process.
    await initAuthRateLimiter();

    // Finish any export that wrote a durable file and died before marking its rows as
    // exported. Those rows are in a file whose sha256 is on record, so they are safe to
    // stamp; left unstamped they are never eligible for deletion, and the collection
    // grows forever while the retention policy claims otherwise.
    const resumed = await resumeUnstampedExports();
    if (resumed > 0) log.warn({ resumed }, 'resumed audit exports left unstamped by a previous run');

    const app = createApp();
    const server = await new Promise<Server>((resolve) => {
        const instance = app.listen(config.PORT, () => {
            log.info(`wi-admin listening on http://localhost:${config.PORT}`);
            resolve(instance);
        });
    });

    // Node's default keep-alive timeout of 0 leaves sockets open indefinitely, which holds
    // a drain open and leaks sockets across a long-lived deployment. `headersTimeout` must
    // exceed `keepAliveTimeout` or Node races itself and drops valid requests.
    server.keepAliveTimeout = 65_000;
    server.headersTimeout = 66_000;

    // AFTER the port is bound, deliberately. The projector is best-effort background work
    // whose failure must never stop the service from serving; starting it before `listen`
    // would put a cross-database sweep on the critical path of becoming healthy.
    startNotificationProjector();

    httpServer = server;
    return server;
}

/**
 * Close everything, in order: stop accepting connections → release idle keep-alive
 * sockets → let in-flight requests finish → close both databases → close Redis.
 *
 * Deliberately does NOT call `process.exit` — the caller decides. That keeps the sequence
 * assertable from a test that must survive it.
 *
 * `closeIdleConnections()` matters more than it looks: `server.close()` alone waits for
 * every open socket, and a keep-alive socket sitting idle between requests never closes on
 * its own. Without it the drain reliably hits the timeout and force-exits — exactly the
 * abrupt termination this is meant to prevent.
 *
 * @returns true when the drain completed cleanly, false when it was already running or failed.
 */
export async function drain(reason: string): Promise<boolean> {
    // A second SIGTERM, or an impatient operator's Ctrl-C, must not start a parallel
    // sequence that closes connections the first one is still using.
    if (draining) {
        logger().warn({ reason }, 'drain already in progress — ignoring');
        return false;
    }
    draining = true;

    const log = logger();
    log.info({ reason }, 'shutdown initiated');

    try {
        // FIRST, and before the databases close. A tick in flight when Mongo goes away
        // throws inside a timer callback, which is the one place with no handler above it —
        // an unhandled rejection there takes the process down mid-drain and turns a clean
        // shutdown into the abrupt one this function exists to avoid.
        stopNotificationProjector();

        if (httpServer) {
            const server = httpServer;
            await new Promise<void>((resolve) => {
                server.close(() => resolve());
                server.closeIdleConnections();
            });
            httpServer = null;
            log.info('http server closed to new connections');
        }

        // Between the last request and closing Mongo. Best-effort audit writes — denials
        // and identity events — are issued without being awaited by their request, so
        // closing the connection first would cancel them mid-flight and lose exactly the
        // rows a security review reads. Bounded, so a stuck write cannot hold a deploy.
        const flushed = await flushPendingAudit(5_000);
        if (flushed > 0) log.info({ flushed }, 'pending audit writes flushed');

        await closeAll();
        await closeRedisClients();

        log.info({ reason }, 'shutdown complete');
        return true;
    } catch (error) {
        log.error({ err: error instanceof Error ? error.message : String(error) }, 'error during shutdown');
        return false;
    } finally {
        draining = false;
    }
}

/**
 * Reads the timeout without risking a throw: after an early crash configuration may never
 * have validated, and `env()` would throw again here, masking the original failure.
 */
function safeShutdownTimeout(): number {
    try {
        return env().SHUTDOWN_TIMEOUT_MS;
    } catch {
        return 10_000;
    }
}

/** Drain, then exit — with a hard deadline so a stuck dependency cannot hang the process. */
async function drainThenExit(reason: string, exitCode: number): Promise<void> {
    const timeoutMs = safeShutdownTimeout();

    const forceExit = setTimeout(() => {
        logger().error({ timeoutMs }, 'shutdown timed out — forcing exit');
        process.exit(1);
    }, timeoutMs);
    forceExit.unref();

    const clean = await drain(reason);
    clearTimeout(forceExit);
    process.exit(clean ? exitCode : 1);
}

export function registerShutdownHandlers(): void {
    // NOTE: on Windows 'SIGTERM' is never emitted — the OS has no such signal and Node
    // terminates the process outright. These handlers are for the Linux runtime.
    process.on('SIGTERM', () => void drainThenExit('SIGTERM', 0));
    process.on('SIGINT', () => void drainThenExit('SIGINT', 0));

    // An unhandled rejection leaves the process in an unknown state. Draining and exiting
    // non-zero lets the orchestrator replace the instance; continuing risks serving
    // requests from a process whose invariants no longer hold.
    process.on('unhandledRejection', (reason) => {
        logger().fatal({ err: reason instanceof Error ? reason.stack : String(reason) }, 'unhandled rejection');
        void drainThenExit('unhandledRejection', 1);
    });

    process.on('uncaughtException', (error) => {
        logger().fatal({ err: error.stack }, 'uncaught exception');
        void drainThenExit('uncaughtException', 1);
    });
}
