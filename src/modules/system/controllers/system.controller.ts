import { Request, Response } from 'express';
import { asyncHandler } from '../../../core/http/async-handler';
import { sendSuccess } from '../../../core/http/responses';
import { env } from '../../../config/env';
import { pingConnection } from '../../../infra/mongo/connections';
import { pingRedis } from '../../../infra/redis/redis.factory';
import { pingPlatform } from '../../../infra/platform/platform.client';
import { actorContextOf } from '../../audit/domain/audit-context';
import { AuditRepository } from '../../audit/repositories/audit.repository';
import { danglingIntentCutoff } from '../../audit/domain/audit-retention';
import { OutboxReadRepository } from '../repositories/outbox.read.repository';
import { exposedConfig } from '../domain/exposed-config';
// Every read on this controller now goes through `system.gateway` — the dev-tools gateway is the
// WRITE half, and every function there is behind `assertDevToolsEnabled()`. Keeping the import
// out is the point: a read that borrowed from it would inherit a feature-flag check.
import * as system from '../gateways/system.gateway';
import {
    isGeoTrackerOpsConfigured,
    probeGeoHealth,
    probeGeoReadiness,
    readGeoMetrics,
} from '../../../infra/geo/geo-tracker.client';
import {
    CacheKeysQuerySchema,
    DatabaseInspectQuerySchema,
    IntegrationQuerySchema,
    LogQuerySchema,
    PlatformErrorQuerySchema,
} from '../../dev-tools/validators/dev-tools.validator';
import { createAppError } from '../../../core/errors/app-error';
import { ERROR_CODES } from '../../../core/errors/error-codes';
import { requireAdminIdentity } from '../../admin-identity/domain/admin-identity.types';
import {
    isQueryNarrowEnough,
    isVisibleToTier,
    projectErrorRecord,
    PlatformErrorRecord,
} from '../domain/error-exposure';

/**
 * `/api/v1/system` — what an operator needs to answer "is this thing working".
 *
 * ── How it differs from `/health` ─────────────────────────────────────────────
 * `/health` is infrastructure: unversioned, unauthenticated, mounted before the rate
 * limiter, and shaped for an orchestrator's liveness/readiness probes. It must stay that
 * way. This is the human surface — authenticated, permissioned, and richer, including
 * things a probe has no business reporting (the dangling-intent count, the outbox depth,
 * the resolved database names).
 *
 * Reads only. Nothing here changes anything, so nothing here is audited — with the one
 * exception the audit module already makes for a disclosure, and none of these disclose
 * anything a tier-1 administrator could not read from the config file.
 */

const audit = new AuditRepository();
const outbox = new OutboxReadRepository();

export class SystemController {
    /**
     * GET /api/v1/system/health
     *
     * Every dependency, plus the two facts that are only meaningful to a person: whether
     * the admin store is a replica set (the audit subsystem refuses to boot otherwise —
     * ADR-006 D-7), and how many audit intents are dangling.
     *
     * A **dangling intent** is an `attempted` row whose outcome never landed, which means a
     * delegated call crashed mid-flight. `findDanglingIntents` and its index have existed
     * since Phase 3.5 with NOTHING reading them; ADR-006 named the ops surface as where
     * that belongs, and this is it.
     */
    static health = asyncHandler(async (_req: Request, res: Response) => {
        const [admin, platform, redis, platformApi, dangling] = await Promise.all([
            pingConnection('admin'),
            pingConnection('platform'),
            pingRedis(),
            pingPlatform(),
            audit.findDanglingIntents(danglingIntentCutoff(new Date()), 100),
        ]);

        sendSuccess(res, {
            dependencies: { admin, platform, redis, joviMall: platformApi },
            audit: {
                danglingIntents: dangling.length,
                // The cap is stated so `100` is never mistaken for "exactly a hundred".
                danglingIntentsCappedAt: 100,
                oldestDanglingAt: dangling[0]?.occurred_at?.toISOString() ?? null,
                retentionDays: env().ADMIN_AUDIT_RETENTION_DAYS,
            },
        });
    });

    /**
     * GET /api/v1/system/workers — delegated.
     *
     * Worker state is in-memory cron in jovi-mall's process, not a collection. A verdict,
     * not a record (ADR-009 D-1), so it is asked for rather than read.
     *
     * ── Re-pointed at Phase 14, from `/dev-tools/workers` to `/system/workers` ─
     * The old path is a compatibility shape frozen for the two callers that already depend on
     * it — four fields, and a single `running` flag that conflated three different conditions.
     * This one returns all TWELVE workers (the old registry was missing two), three distinct
     * booleans, structured schedules, the `enabled` master switch and `pausedByMaintenance`.
     *
     * Safe to re-point now because jovi-mall deploys first, always: by the time this ships, the
     * richer endpoint exists. `DevToolsController.listWorkers` still calls the old path, so
     * `/dev-tools/workers` keeps a consumer and its own deprecation stays a separate decision.
     */
    static workers = asyncHandler(async (req: Request, res: Response) => {
        sendSuccess(res, await system.getWorkers(actorContextOf(req)));
    });

    /**
     * GET /api/v1/system/outbox — read DIRECTLY from `jovi_mall`.
     *
     * The opposite call from `/workers`, by the same rule: `tracking_outbox` is a
     * collection of records, already `access: 'read'` in `platform-collections.ts`, and a
     * second reader of a record costs nothing.
     */
    static outbox = asyncHandler(async (_req: Request, res: Response) => {
        sendSuccess(res, await outbox.summary());
    });

    /**
     * GET /api/v1/system/config — the whitelisted runtime configuration.
     *
     * Built by naming keys, checked again at boot by `assertExposedConfigSafe()`. No
     * `MONGO_URI_*`, no secrets, no spread of `env()`. See `exposed-config.ts`.
     *
     * Note this is THIS service's configuration. jovi-mall's runtime config would need its own
     * whitelist on its own side, reproducing the whole `FORBIDDEN_CONFIG_TOKEN` discipline
     * there; it is a natural follow-up and deliberately not part of Phase 14.
     */
    static config = asyncHandler(async (_req: Request, res: Response) => {
        sendSuccess(res, { config: exposedConfig() });
    });

    // ═══ Phase 14 — the platform's own operational reads ══════════════════════
    //
    // All delegated, all GETs, none audited. Each is a verdict about jovi-mall's PROCESS —
    // in-memory worker state, live connection topology, a private metrics registry — which is
    // ADR-009 D-1's rule for when to ask rather than read.

    /** GET /api/v1/system/dependencies — jovi-mall's Mongo and Redis, as its process sees them. */
    static dependencies = asyncHandler(async (req: Request, res: Response) => {
        sendSuccess(res, await system.getDependencies(actorContextOf(req)));
    });

    /**
     * GET /api/v1/system/integrations — configured vs reachable, never conflated.
     *
     * `?probe=smtp,telegram` opts into the two checks that are safe but not free. Everything
     * else reports either a free health path or what real traffic last learned; several
     * providers cannot be probed at all, because a health check against Stripe is an
     * authenticated call on a live merchant account and against WhatsApp it is a message to a
     * real person. jovi-mall returns the rule and the per-provider reasoning on the wire.
     */
    static integrations = asyncHandler(async (req: Request, res: Response) => {
        const { probe } = IntegrationQuerySchema.parse(req.query);
        const requested = probe ? probe.split(',').map((s) => s.trim()).filter(Boolean) : [];
        sendSuccess(res, await system.getIntegrations(actorContextOf(req), requested));
    });

    /**
     * GET /api/v1/system/queues — the tracking outbox AND the assignment backlog.
     *
     * Sits BESIDE `/outbox` rather than replacing it, and that redundancy is deliberate: this
     * one is delegated and returns 503 during a jovi-mall incident, which is exactly when an
     * operator wants queue depth; `/outbox` reads the collection directly and still answers.
     * See ADR-014 D-6.
     */
    static queues = asyncHandler(async (req: Request, res: Response) => {
        sendSuccess(res, await system.getQueues(actorContextOf(req)));
    });

    /**
     * GET /api/v1/system/cache — Redis key counts per database, plus instance-wide memory.
     *
     * The response is two-scoped because Redis does not report hits and misses per logical
     * database; presenting an instance figure as a per-database one would send an operator
     * hunting a caching bug that does not exist.
     */
    static cache = asyncHandler(async (req: Request, res: Response) => {
        sendSuccess(res, await system.getCache(actorContextOf(req)));
    });

    /**
     * GET /api/v1/system/metrics — the JSON projection of jovi-mall's Prometheus registry.
     *
     * Its own permission rather than `system.health.read`: this carries per-route request
     * volumes — order rate, payment rate — which is business information, not health.
     */
    static metrics = asyncHandler(async (req: Request, res: Response) => {
        sendSuccess(res, await system.getMetrics(actorContextOf(req)));
    });

    /**
     * GET /api/v1/system/maintenance — the window, if there is one.
     *
     * Reports `storedMode` and `effectiveMode` separately; they differ exactly when a window has
     * passed its expiry, because a read path on jovi-mall's side must never write.
     */
    static maintenance = asyncHandler(async (req: Request, res: Response) => {
        sendSuccess(res, await system.getMaintenance(actorContextOf(req)));
    });

    // ═══ Phase 15 — /system/platform/* and /system/geo-tracker ════════════════
    //
    // `/system/platform/*` is for reads where THIS service has, or will plausibly have, its own
    // answer to the same question. `/config` already means wi-admin's config, so the platform's
    // gets a segment rather than a suffix — and `/system/logs` stays reserved for wi-admin's own
    // logs, which is the obvious next phase (it has pino and no sinks).
    //
    // The seven Phase-14 reads deliberately stay where they are: wi-admin has no competing
    // answer to any of them, and moving them would break a dashboard for no benefit. The
    // inconsistency is stated rather than left to look accidental.

    /** GET /api/v1/system/platform/config — jovi-mall's whitelisted runtime configuration. */
    static platformConfig = asyncHandler(async (req: Request, res: Response) => {
        sendSuccess(res, await system.getPlatformConfig(actorContextOf(req)));
    });

    /**
     * GET /api/v1/system/platform/logs.
     *
     * Behind `developer_tools.logs.read`, NOT `system.health.read` — a log line is free text and
     * can carry personal data, and `system.*` reaches tier 2 through `allInFamily('system')`.
     * Not audited: a log search is diagnostics and high-volume by nature, and auditing it would
     * flood the trail with rows saying nothing about what anybody *did* — the same argument
     * `NO_AUDIT_ROUTE_ALLOWLIST` makes about read receipts.
     */
    static platformLogs = asyncHandler(async (req: Request, res: Response) => {
        const query = LogQuerySchema.parse(req.query);
        sendSuccess(res, await system.getPlatformLogs(actorContextOf(req), query));
    });

    /**
     * GET /api/v1/system/errors — the error journal, GRADED BY TIER (Phase 16).
     *
     * One route, three answers. That is the house pattern — `audit.read` is a single
     * permission and `auditScopeFilter` decides what each row shows — and it is the right
     * shape here because the three views answer the same question at three depths, not
     * three different questions.
     *
     * The route is reachable by any of the three rungs, and `projectErrorRecord` decides
     * what comes back:
     *
     *   developer_tools.logs.read   tier 1   everything, including the stack
     *   system.errors.read          tier 2   the operational diagnosis, no stack
     *   support.errors.lookup       tier 3   what the caller saw, plus the reference
     *
     * Tier 3 is additionally narrowed twice — by ROW (only vendor/agency/agent/customer and
     * anonymous traffic) and by QUERY (a reference, or a code with a window). Neither is
     * redundant: the projection makes a row safe to read, and the narrowing stops the
     * surface being a scrollable feed of every failure on the platform.
     */
    static errors = asyncHandler(async (req: Request, res: Response) => {
        const admin = requireAdminIdentity(req);
        const query = PlatformErrorQuerySchema.parse(req.query);

        if (!isQueryNarrowEnough(admin.tier, query)) {
            throw createAppError(ERROR_CODES.SYSTEM_ERROR_QUERY_TOO_BROAD, 400);
        }

        const report = await system.getPlatformErrors(actorContextOf(req), query);
        const records = report.entries as PlatformErrorRecord[];

        sendSuccess(res, {
            ...report,
            entries: records
                .filter((record) => isVisibleToTier(record, admin.tier))
                .map((record) => projectErrorRecord(record, admin.tier)),
            // Naming the rung is not decoration: without it a Support agent reading a thin
            // row cannot tell "there is nothing more to know" from "I am not being shown
            // it", and would escalate a resolved incident.
            view: admin.tier === 1 ? 'developer' : admin.tier === 2 ? 'admin' : 'support',
        });
    });

    /** GET /api/v1/system/platform/cache/keys — key names, types and TTLs. Never values. */
    static platformCacheKeys = asyncHandler(async (req: Request, res: Response) => {
        const query = CacheKeysQuerySchema.parse(req.query);
        sendSuccess(res, await system.getPlatformCacheKeys(actorContextOf(req), query));
    });

    /** GET /api/v1/system/platform/database — collection stats and index drift. */
    static platformDatabase = asyncHandler(async (req: Request, res: Response) => {
        const query = DatabaseInspectQuerySchema.parse(req.query);
        sendSuccess(res, await system.getPlatformDatabase(actorContextOf(req), query));
    });

    /**
     * GET /api/v1/system/geo-tracker — liveness and readiness of the third service.
     *
     * **A separate route rather than a block inside `/dependencies`**, for two reasons.
     * `/dependencies` is a pure passthrough of jovi-mall's shape, and merging a locally-fetched
     * block would invent a shape only wi-admin knows — the argument ADR-014 D-3 makes against
     * forwarding prom-client's raw JSON. And it would mix two failure domains: jovi-mall being
     * down would 503 the whole read and take the geo-tracker answer with it, when "is geo-tracker
     * still up" is exactly what you want to know during a jovi-mall incident.
     *
     * ⚠ This must never become a readiness dependency of this service — see
     * `infra/geo/geo-tracker.client.ts`. The client cannot throw, which is what makes that
     * structural rather than a rule to remember.
     */
    static geoTracker = asyncHandler(async (_req: Request, res: Response) => {
        const [health, readiness] = await Promise.all([probeGeoHealth(), probeGeoReadiness()]);
        sendSuccess(res, {
            service: 'geo-tracker',
            configured: isGeoTrackerOpsConfigured(),
            health,
            readiness,
            note:
                'Service-level operations reads only — no live position, no trail, no session '
                + 'content. Per-agent reads still require a platform user identity, which an '
                + 'administrator deliberately does not have (ADR-009 D-2).',
        });
    });

    /**
     * GET /api/v1/system/geo-tracker/metrics.
     *
     * `system.metrics.read`, not `system.health.read`: geo-tracker's registry carries session and
     * websocket counts, which is the same reconnaissance/business class that gave jovi-mall's
     * `/metrics` its own permission. Same decision, same reason.
     */
    static geoTrackerMetrics = asyncHandler(async (_req: Request, res: Response) => {
        sendSuccess(res, await readGeoMetrics());
    });
}
