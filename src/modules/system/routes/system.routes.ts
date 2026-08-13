import { Router } from 'express';
import { defineRoute, permission, anyPermission } from '../../../api/route-manifest';
import { SystemController } from '../controllers/system.controller';

/**
 * `/api/v1/system` — the operations reads, reserved in `api/index.ts` since Phase 1.
 *
 * Every route is a GET and none is audited, which is the ordinary rule (ADR-006 D-5 records
 * what MOVED, and the request log already holds the rest). The one place this service
 * audits a read is a DISCLOSURE — a beneficiary's account number — and nothing here
 * discloses anything a tier-1 administrator could not read out of the config file.
 *
 * `/system/health` does not replace `/health`. That one is unversioned, unauthenticated and
 * mounted before the rate limiter so an orchestrator can always reach it; this one is for a
 * person, behind a permission,
    anyPermission, and reports things a probe should not.
 */
const router = Router();
const mountedAt = '/system';

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/health',
    access: permission('system.health.read'),
    handler: SystemController.health,
});

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/workers',
    access: permission('system.workers.read'),
    handler: SystemController.workers,
});

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/outbox',
    access: permission('system.outbox.read'),
    handler: SystemController.outbox,
});

// ═══ Phase 14 — the platform's own operational reads ══════════════════════════
//
// All delegated to jovi-mall. Four of the six reuse an existing permission, because they answer
// the question those permissions already describe; only `/metrics` and `/maintenance` needed
// their own.

/** `system.health.read` — its summary is literally "database, cache and downstream service health". */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/dependencies',
    access: permission('system.health.read'),
    handler: SystemController.dependencies,
});

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/integrations',
    access: permission('system.health.read'),
    handler: SystemController.integrations,
});

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/cache',
    access: permission('system.health.read'),
    handler: SystemController.cache,
});

/**
 * `/queues` sits BESIDE `/outbox`, not in front of it.
 *
 * `/outbox` reads `tracking_outbox` **directly** out of `jovi_mall`; this one is **delegated**
 * and additionally covers the assignment backlog, whose notion of "due" is jovi-mall's. The
 * decisive difference is what happens during a jovi-mall incident — the exact moment an operator
 * wants queue depth: this returns 503 and `/outbox` still answers. Superseding it would delete
 * the version that works when the platform is down. ADR-014 D-6.
 */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/queues',
    access: permission('system.outbox.read'),
    handler: SystemController.queues,
});

/**
 * Its own permission, not `system.health.read`.
 *
 * The metrics projection carries per-route request volumes — order rate, payment rate — which is
 * business information rather than health. Somebody who should be able to see whether Redis is
 * up does not automatically need to see how many orders an hour the platform takes.
 */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/metrics',
    access: permission('system.metrics.read'),
    handler: SystemController.metrics,
});

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/maintenance',
    access: permission('system.maintenance.read'),
    handler: SystemController.maintenance,
});

/**
 * `developer_tools.config.read`, not a `system.*` permission.
 *
 * Runtime configuration says how the service is wired — which origins it trusts, how long
 * an approval stays open, where exports are written. That is Developer-tier information,
 * and the catalog already put it in the tier-1-only family. The `system.*` reads above are
 * operational and reach tier 2.
 */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/config',
    access: permission('developer_tools.config.read'),
    handler: SystemController.config,
});

// ═══ Phase 15 — the platform's own developer-tool reads ═══════════════════════
//
// THE RULE, stated once: `/system/platform/*` is for reads where this service has, or will
// plausibly have, its own answer to the same question. `/config` above already means wi-admin's
// config, so the platform's takes a segment — and `/system/logs` stays reserved for this
// service's own logs, which is the obvious next phase (it has pino and no sinks at all).
//
// The seven Phase-14 reads above deliberately do NOT move. wi-admin has no competing answer to
// any of them, and relocating them would break a live dashboard for no benefit. The
// inconsistency is deliberate and is written down rather than left to look accidental.

/** Reuses `developer_tools.config.read` — one tier holds both, so a split is not expressible. */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/platform/config',
    access: permission('developer_tools.config.read'),
    handler: SystemController.platformConfig,
});

/**
 * Its own permission, and NOT `system.health.read`.
 *
 * `tier-grants.ts` gives tier 2 `allInFamily('system')`, so a `system.*` name would reach the
 * Admin tier — and an unfiltered feed of every warning in the platform is a broader disclosure
 * than any individual `*.read` an Admin holds, because it is not scoped by subject and cannot be.
 * The `developer_tools` family is the mechanism: the grant-table boot assertion already refuses
 * that family to any tier but 1.
 *
 * Not audited, deliberately. A log search is diagnostics and high-volume by nature; auditing it
 * would flood the trail with rows saying nothing about what anybody DID, which is the same
 * argument `NO_AUDIT_ROUTE_ALLOWLIST` makes about notification read receipts. The honest
 * counter-argument — a tier-1 operator could trawl for customer data — is bounded by the fact
 * that the same person can read `jovi_mall` directly.
 */
/**
 * The error journal (Phase 16), graded by tier inside the handler.
 *
 * `anyPermission`, not `permission`: all three rungs reach the same route and the
 * projection decides what each one gets. Splitting it into three routes would mean three
 * URLs a dashboard has to choose between based on the administrator's own level, which is
 * exactly the thing a server should be deciding.
 *
 * A separate route from `/platform/logs`, which stays tier 1 — that keeps Phase 15's
 * raw-log-feed boundary exactly where `test:devtools` asserts it is.
 *
 * Not audited: a GET, and diagnostics by nature (ADR-006 D-5).
 */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/errors',
    access: anyPermission(
        'developer_tools.logs.read',
        'system.errors.read',
        'support.errors.lookup',
    ),
    handler: SystemController.errors,
});

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/platform/logs',
    access: permission('developer_tools.logs.read'),
    handler: SystemController.platformLogs,
});

/**
 * `cache.inspect`, not `cache.flush`. **Looking is not clearing**, and one permission for both
 * would mean an operator who may inspect may also delete.
 */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/platform/cache/keys',
    access: permission('developer_tools.cache.inspect'),
    handler: SystemController.platformCacheKeys,
});

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/platform/database',
    access: permission('developer_tools.database.inspect'),
    handler: SystemController.platformDatabase,
});

// ═══ Phase 15 — geo-tracker, the narrow exception to ADR-009 D-2 ══════════════

/**
 * `system.health.read` — literally what that permission's summary describes ("database, cache
 * and downstream service health"). Tier 2 reaches it via `allInFamily('system')`, which is
 * right: an Admin on call needs to know whether tracking is up.
 *
 * ⚠ Never call this from `/health/ready`. ADR-014 D-1's coupled-failure amplifier is one
 * `Promise.all` away, and `test:devtools` scans the source to keep it that way.
 */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/geo-tracker',
    access: permission('system.health.read'),
    handler: SystemController.geoTracker,
});

/**
 * Declared AFTER `/geo-tracker` and at a different depth, so no shadowing — but a
 * `/geo-tracker/:something` sibling added later WOULD collide.
 *
 * `system.metrics.read` for the same reason jovi-mall's `/metrics` has it: session and websocket
 * counts are business/reconnaissance information rather than health.
 */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/geo-tracker/metrics',
    access: permission('system.metrics.read'),
    handler: SystemController.geoTrackerMetrics,
});

export const systemRoutes = router;
