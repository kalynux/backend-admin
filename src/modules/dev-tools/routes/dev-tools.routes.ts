import { Router } from 'express';
import { defineRoute, permission, records } from '../../../api/route-manifest';
import { DevToolsController } from '../controllers/dev-tools.controller';
import {
    FeatureFlagParamSchema,
    FlushCacheSchema,
    PruneOutboxSchema,
    ReplayOutboxSchema,
    SetFeatureFlagSchema,
    SetMaintenanceSchema,
    WorkerKeyParamSchema,
} from '../validators/dev-tools.validator';

/**
 * `/api/v1/dev-tools` — the operations surface reserved since Phase 1 and built in Phase 12.
 *
 * ── Why these permissions were catalogued long before this existed ────────────
 * `developer_tools.*` has been in the permission catalog since Phase 3, flagged
 * `destructive`, confined to tier 1 by a boot assertion, and attached to NO route. That was
 * deliberate policy-first design — but it left the brief's "developer tool execution"
 * category unauditable in practice, because there was nothing to audit and no catalog action
 * to record. Both halves land here.
 *
 * ── Two gates, and they answer different questions ────────────────────────────
 * The permission answers "may this person" — tier 1 only, never swept in by a family grant.
 * The `dev_tools.enabled` feature flag answers "is this service accepting these right now",
 * and is OFF by default. Every tool re-runs a side effect against live data, and the safe
 * resting state for that is off; a capability available merely because it was built is one
 * that gets used during an incident by somebody guessing.
 *
 * The flag is checked in the gateway rather than per route, so a tool added later inherits
 * it. The feature-flag routes themselves are NOT behind it — that would be a switch that
 * turns off its own switch.
 *
 * ── There is no `webhooks/redeliver` ──────────────────────────────────────────
 * Every `/webhooks/*` mount in jovi-mall is inbound; nothing records an outbound delivery,
 * so there is no subject. The permission stays in the catalog naming its missing
 * prerequisite. Writing an endpoint for it would be worse than the gap.
 */
const router = Router();
const mountedAt = '/dev-tools';

// ─── Feature flags — the config surface ──────────────────────────────────────
//
// Deliberately NOT behind `dev_tools.enabled`: this is how you turn that on.

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/feature-flags',
    access: permission('developer_tools.feature_flags.read'),
    handler: DevToolsController.listFlags,
});

defineRoute(router, {
    mountedAt,
    method: 'put',
    path: '/feature-flags/:flag',
    access: permission('developer_tools.feature_flags.set'),
    validate: { params: FeatureFlagParamSchema, body: SetFeatureFlagSchema },
    audit: records('developer_tools.feature_flags.set'),
    handler: DevToolsController.setFlag,
});

// ─── The tools themselves ────────────────────────────────────────────────────

/**
 * A read, and the only route here that needs no flag: knowing which workers exist is not
 * running one. `system.workers.read` rather than a `developer_tools.*` permission, because
 * the answer is operational information rather than a capability.
 */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/workers',
    access: permission('system.workers.read'),
    handler: DevToolsController.listWorkers,
});

/**
 * `/workers/:workerKey/run` — the literal `/workers` above is a different depth, so no
 * shadowing. Keep it that way: a `/workers/:something` sibling added later WOULD collide.
 */
defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/workers/:workerKey/run',
    access: permission('developer_tools.workers.trigger'),
    validate: { params: WorkerKeyParamSchema },
    audit: records('developer_tools.workers.trigger'),
    handler: DevToolsController.runWorker,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/outbox/replay',
    access: permission('developer_tools.outbox.replay'),
    validate: { body: ReplayOutboxSchema },
    audit: records('developer_tools.outbox.replay'),
    handler: DevToolsController.replayOutbox,
});

/**
 * `POST /outbox/prune` — Phase 15, and the phase's ONLY new dangerous verb.
 *
 * Behind `dev_tools.enabled`, like `cache/flush` and unlike `maintenance`: an operator who
 * cannot prune an outbox is inconvenienced, not stuck, so the D-7 carve-out does not apply.
 *
 * jovi-mall refuses `failed` and `pending` outright and enforces the 7-day floor, the age
 * confirmation and the dry-run default on its side — one default in one place. The counts and
 * the cutoff come back in the response and land in this route's audit row.
 */
defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/outbox/prune',
    access: permission('developer_tools.outbox.prune'),
    validate: { body: PruneOutboxSchema },
    audit: records('developer_tools.outbox.prune'),
    handler: DevToolsController.pruneOutbox,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/catalogue/vectorise',
    access: permission('developer_tools.catalogue.vectorise'),
    audit: records('developer_tools.catalogue.vectorise'),
    handler: DevToolsController.vectoriseCatalogue,
});

// ─── Phase 14 ────────────────────────────────────────────────────────────────

/**
 * `PUT /maintenance` — and the one tool on this router that is NOT behind `dev_tools.enabled`.
 *
 * Every other tool here re-runs a side effect; this one refuses traffic, and in `down` refuses
 * all of it. It is also the only one whose failure mode is losing the ability to undo it, which
 * is exactly why the flag is carved out in the gateway: with the flag applied, an operator could
 * not enter maintenance during an incident without first flipping an unrelated switch — and if
 * anybody turned `dev_tools.enabled` off mid-window, the exit would be locked.
 *
 * Same carve-out, same reason, as the feature-flag routes at the top of this file. The tier-1
 * permission and the audit row both still apply; only the flag is dropped. See
 * `gateways/dev-tools.gateway.ts` and ADR-014 D-7.
 */
defineRoute(router, {
    mountedAt,
    method: 'put',
    path: '/maintenance',
    access: permission('developer_tools.maintenance.set'),
    validate: { body: SetMaintenanceSchema },
    audit: records('developer_tools.maintenance.set'),
    handler: DevToolsController.setMaintenance,
});

/**
 * `POST /cache/flush` — behind the flag, unlike maintenance above.
 *
 * The asymmetry is deliberate: an operator who cannot flush a cache is inconvenienced, whereas
 * an operator who cannot exit a maintenance window is stuck. jovi-mall re-validates everything
 * and refuses a whole-database flush on the three databases whose keys are load-bearing for
 * correctness or for money; its blast-radius note comes back in the response and lands in this
 * route's audit row.
 */
defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/cache/flush',
    access: permission('developer_tools.cache.flush'),
    validate: { body: FlushCacheSchema },
    audit: records('developer_tools.cache.flush'),
    handler: DevToolsController.flushCache,
});

export const devToolsRoutes = router;
