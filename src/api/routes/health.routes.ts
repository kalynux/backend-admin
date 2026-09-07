import { Router, Request, Response } from 'express';
import { asyncHandler } from '../../core/http/async-handler';
import { pingConnection } from '../../infra/mongo/connections';
import { pingRedis } from '../../infra/redis/redis.factory';
import { pingPlatform } from '../../infra/platform/platform.client';

/**
 * Health endpoints, mounted UNVERSIONED at `/health`.
 *
 * ⚠ **This docstring opened by describing jovi-mall's observability as "entirely
 * `GET /api/health` → `{ status: 'ok' }` … it cannot drive a load balancer or a deployment
 * gate". That was true when written and has been false since Phase 14** (corrected
 * 2026-09-06, DOC-PROGRAM P-15). jovi-mall now serves `/api/health/live`,
 * `/api/health/ready`, `/metrics` and twelve `/api/internal/admin/system/*` routes.
 *
 * The correction matters more than a stale sentence usually would, because the *reason*
 * jovi-mall kept an unconditional 200 on `/api/health` is a cross-service constraint rather
 * than an omission: geo-tracker registers that exact path as a **readiness** checker and
 * treats any status >= 300 as an error, so putting readiness semantics on it means a
 * jovi-mall Redis wobble 503s geo-tracker's `/readyz` and kills every live tracking session.
 * Its readiness therefore went on `/api/health/ready`. See ADR-014 D-1.
 *
 * The split below is the same split, arrived at first here, and it matters:
 *
 *   /health/live   Is the process alive? NEVER checks a dependency. An orchestrator kills
 *                  and restarts on a failing liveness probe — and restarting this service
 *                  does not fix someone else's database. A dependency outage must not turn
 *                  into a restart loop.
 *
 *   /health/ready  Should traffic be routed here? Checks everything required to serve a
 *                  request. 503 takes the instance out of rotation without killing it, so
 *                  it rejoins by itself when the dependency returns.
 *
 * Unversioned because a probe URL is infrastructure, not part of the dashboard's API
 * contract — it must not move when `/api/v1` becomes `/api/v2`.
 *
 * This is also the seed of the Phase 7 system-information surface.
 */
const router = Router();

type DependencyStatus = 'up' | 'down' | 'not_configured';

interface DependencyReport {
    status: DependencyStatus;
    durationMs: number;
    /** The database actually reached, so a misconfigured URI is visible rather than merely "up". */
    database?: string | null;
    error?: string;
}

/** Liveness. Deliberately trivial and dependency-free. */
router.get('/live', (_req: Request, res: Response) => {
    res.status(200).json({
        success: true,
        data: {
            status: 'alive',
            service: 'wi-admin',
            uptimeSeconds: Math.round(process.uptime()),
            timestamp: new Date().toISOString(),
        },
    });
});

/** Readiness. Probes every dependency in parallel — a slow check must not serialise the rest. */
router.get(
    '/ready',
    asyncHandler(async (_req: Request, res: Response) => {
        const [platformDb, adminDb, redis, platformApi] = await Promise.all([
            pingConnection('platform'),
            pingConnection('admin'),
            pingRedis(),
            pingPlatform(),
        ]);

        const dependencies: Record<string, DependencyReport> = {
            mongoPlatform: {
                status: platformDb.ok ? 'up' : 'down',
                durationMs: platformDb.durationMs,
                database: platformDb.database,
                ...(platformDb.error ? { error: platformDb.error } : {}),
            },
            mongoAdmin: {
                status: adminDb.ok ? 'up' : 'down',
                durationMs: adminDb.durationMs,
                database: adminDb.database,
                ...(adminDb.error ? { error: adminDb.error } : {}),
            },
            redis: {
                status: redis.ok ? 'up' : 'down',
                durationMs: redis.durationMs,
                ...(redis.error ? { error: redis.error } : {}),
            },
            joviMall: {
                // Unconfigured is a valid steady state in Phase 1, not a failure — the same
                // convention jovi-mall uses for an unset GEO_TRACKER_BASE_URL. Phase 4 makes
                // it required, and this entry becomes required with it.
                status: !platformApi.configured ? 'not_configured' : platformApi.ok ? 'up' : 'down',
                durationMs: platformApi.durationMs,
                ...(platformApi.error ? { error: platformApi.error } : {}),
            },
        };

        // Both databases are required. Redis is required from Phase 2 (sessions); it is
        // already reported here so a degraded instance is visible before it matters.
        const required: DependencyStatus[] = [
            dependencies.mongoPlatform.status,
            dependencies.mongoAdmin.status,
            dependencies.redis.status,
        ];
        const ready = required.every((status) => status === 'up');

        res.status(ready ? 200 : 503).json({
            success: ready,
            data: {
                status: ready ? 'ready' : 'not_ready',
                service: 'wi-admin',
                dependencies,
                timestamp: new Date().toISOString(),
            },
        });
    }),
);

export const healthRoutes = router;
