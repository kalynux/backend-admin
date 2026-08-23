/**
 * The operations surface — `/system` and `/dev-tools`, with no infrastructure.
 *
 * Everything here is a pure function of code: the feature-flag catalog, the exposed-config
 * whitelist and its boot assertion, the validators, and the route declarations. No Mongo,
 * no Redis, no jovi-mall.
 *
 * Two sections carry the weight:
 *
 *   §2  `assertExposedConfigSafe` — the endpoint that serves runtime configuration is one
 *       careless line away from serving a database password. The whitelist is the primary
 *       control and this assertion is the second, so it is tested against the shapes a
 *       secret actually takes rather than against the current list.
 *   §4  the two gates on every tool. The permission is tier 1 only AND the flag is off by
 *       default, and both halves are asserted — a capability that re-runs side effects
 *       against live data should not be reachable because somebody built it.
 *
 *   npm run test:devtools
 */
import { suite } from './_assert';

// Env must be set before importing anything that reads config at module load.
process.env.NODE_ENV = 'test';
process.env.MONGO_URI_PLATFORM = 'mongodb://localhost:27017/jovi_mall_test';
process.env.MONGO_URI_ADMIN = 'mongodb://localhost:27017/wi_admin_test';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.ADMIN_JWT_SECRET = 'test-access-secret-value-32-chars-long';
process.env.ADMIN_JWT_REFRESH_SECRET = 'test-refresh-secret-value-32-chars-long';
process.env.ADMIN_DASHBOARD_ORIGINS = 'http://localhost:5173';

import {
    FEATURE_FLAG_CATALOG,
    FEATURE_FLAG_NAMES,
    assertFeatureFlagCatalogValid,
    featureFlagSpec,
    isFeatureFlagName,
} from '../../src/modules/dev-tools/domain/feature-flag.catalog';
import {
    EXPOSED_CONFIG_KEYS,
    FORBIDDEN_CONFIG_TOKEN,
    assertExposedConfigSafe,
    exposedConfig,
} from '../../src/modules/system/domain/exposed-config';
import {
    CacheKeysQuerySchema,
    FeatureFlagParamSchema,
    FlushCacheSchema,
    LogQuerySchema,
    PruneOutboxSchema,
    ReplayOutboxSchema,
    SetFeatureFlagSchema,
    SetMaintenanceSchema,
    WorkerKeyParamSchema,
} from '../../src/modules/dev-tools/validators/dev-tools.validator';
import { AUDIT_CATALOG, auditSpec, isAuditAction } from '../../src/modules/audit/domain/audit.catalog';
import { subjectClassOf } from '../../src/modules/audit/domain/audit-subject';
import { isPermissionName, permissionSpec } from '../../src/modules/authorization/domain/permission.catalog';
import { hasPermission } from '../../src/modules/authorization/domain/permission.resolver';
import { allInFamily } from '../../src/modules/authorization/domain/tier-grants';
import { routeManifest } from '../../src/api/route-manifest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { GEO_TRACKER_METRIC_ALLOWLIST, GEO_TRACKER_OPS_PATHS } from '../../src/infra/geo/geo-tracker.client';
import { parsePromText } from '../../src/infra/geo/prom-text';
import '../../src/modules/system/routes/system.routes';
import '../../src/modules/dev-tools/routes/dev-tools.routes';

const t = suite('operations surface');

function codeOf(fn: () => unknown): string | null {
    try {
        fn();
        return null;
    } catch (error) {
        return (error as { code?: string }).code ?? null;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
t.section('1. Feature flag catalog');

t.assert('the shipped catalog is valid', () => codeOf(() => assertFeatureFlagCatalogValid()) === null);

t.assert('it is not empty', () => FEATURE_FLAG_NAMES.length > 0);

t.assert('every flag names a consumer — a flag nothing reads is dead config', () =>
    FEATURE_FLAG_NAMES.every((name) => featureFlagSpec(name).consumer.trim().length > 0));

t.assert('every consumer looks like a real path in this service', () =>
    FEATURE_FLAG_NAMES.every((name) => /^[a-z-]+\/.+\.ts$/.test(featureFlagSpec(name).consumer)));

t.assert('every flag has a summary an administrator can act on', () =>
    FEATURE_FLAG_NAMES.every((name) => featureFlagSpec(name).summary.trim().length >= 10));

t.assert('names are dotted family.flag', () =>
    FEATURE_FLAG_NAMES.every((name) => /^[a-z_]+\.[a-z_]+$/.test(name)));

t.assert('isFeatureFlagName accepts a real name and rejects a typo', () =>
    isFeatureFlagName('audit.route_probe') && !isFeatureFlagName('audit.route_prboe'));

t.assert('isFeatureFlagName rejects a prototype key', () => !isFeatureFlagName('toString'));

t.assert('the catalog is frozen — a flag cannot be added at runtime', () => {
    try {
        (FEATURE_FLAG_CATALOG as unknown as Record<string, unknown>).injected = {};
        return false;
    } catch {
        return true;
    }
});

/**
 * The tools' own flag is off; the observability ones are on. Asserted because the DEFAULT is
 * the live value in every environment — the collection starts empty and stays empty until
 * somebody changes something.
 */
t.assert('dev_tools.enabled defaults to OFF', () =>
    featureFlagSpec('dev_tools.enabled').default === false);

/**
 * `audit.legacy_feed` was asserted here too, until Phase 5 Part D deleted it with the module
 * it switched (`GET /api/v1/audit/legacy`). It could not outlive that module: a flag whose
 * `consumer` names a file that no longer exists is the dead config the catalog's own header
 * refuses to carry, and § 1's "every consumer looks like a real path" check is what would have
 * caught it drifting rather than being removed. Its absence is asserted in `test-authz.ts` § 9,
 * beside the deletion it followed from.
 */
t.assert('the audit route probe defaults to ON', () =>
    featureFlagSpec('audit.route_probe').default === true);

// ─────────────────────────────────────────────────────────────────────────────
t.section('2. Exposed config — the whitelist, and the assertion behind it');

t.assert('the shipped whitelist passes the boot assertion', () =>
    codeOf(() => assertExposedConfigSafe()) === null);

t.assert('no MONGO_URI is exposed — they carry credentials', () =>
    !EXPOSED_CONFIG_KEYS.some((key) => key.startsWith('MONGO_URI')));

t.assert('no JWT secret is exposed', () =>
    !EXPOSED_CONFIG_KEYS.some((key) => key.includes('JWT')));

t.assert('nothing exposed contains a credential-shaped segment', () =>
    !EXPOSED_CONFIG_KEYS.some((key) => FORBIDDEN_CONFIG_TOKEN.test(key)));

t.assert('the endpoint returns one entry per whitelisted key, and no more', () => {
    const served = exposedConfig();
    return served.length === EXPOSED_CONFIG_KEYS.length
        && served.every((entry) => EXPOSED_CONFIG_KEYS.includes(entry.key));
});

t.assert('every served value is a flat scalar or null — never an object', () =>
    exposedConfig().every((entry) =>
        entry.value === null
        || ['string', 'number', 'boolean'].includes(typeof entry.value)));

/**
 * The assertion must actually fire, against the REAL predicate rather than a copy of it —
 * a test that restates the rule proves only that it can restate the rule.
 *
 * `MONGO_URI_ADMIN` is the case that matters and the one an end-anchored rule misses: it
 * carries the database password and ends in `_ADMIN`. This list caught exactly that when
 * the check was `_SECRET$`-style, which is why the rule now matches a segment anywhere.
 */
t.assert('the token rule catches every credential shape it claims to', () =>
    ['MONGO_URI_ADMIN', 'MONGO_URI_PLATFORM', 'ADMIN_JWT_SECRET', 'ADMIN_JWT_REFRESH_SECRET',
        'JOVI_MALL_SERVICE_TOKEN', 'STRIPE_API_KEY', 'STRIPE_SECRET_KEY_LIVE',
        'SMTP_PASSWORD', 'SENTRY_DSN', 'GCP_CREDENTIALS', 'REDIS_URL']
        .every((key) => FORBIDDEN_CONFIG_TOKEN.test(key)));

t.assert('...and does not catch the deliberate near-misses on the live list', () =>
    ['ADMIN_DASHBOARD_ORIGINS', 'ADMIN_AUDIT_EXPORT_DIR', 'ADMIN_AUDIT_RETENTION_DAYS',
        'TRUST_PROXY', 'NODE_ENV', 'PORT']
        .every((key) => !FORBIDDEN_CONFIG_TOKEN.test(key)));

// ─────────────────────────────────────────────────────────────────────────────
t.section('3. Validators');

t.assert('the flag name is a pinned enum, so a typo is a 400 not an upsert', () =>
    FeatureFlagParamSchema.safeParse({ flag: 'audit.route_probe' }).success
    && !FeatureFlagParamSchema.safeParse({ flag: 'audit.route_prboe' }).success);

t.assert('a flag change REQUIRES a reason of real length', () =>
    !SetFeatureFlagSchema.safeParse({ enabled: true }).success
    && !SetFeatureFlagSchema.safeParse({ enabled: true, reason: 'test' }).success
    && SetFeatureFlagSchema.safeParse({ enabled: true, reason: 'Incident 4821 mitigation' }).success);

t.assert('`enabled` must be a real boolean, not a truthy string', () =>
    !SetFeatureFlagSchema.safeParse({ enabled: 'true', reason: 'a long enough reason' }).success);

t.assert('the worker key is shape-checked but NOT pinned to a list', () =>
    WorkerKeyParamSchema.safeParse({ workerKey: 'plan-expiry' }).success
    && WorkerKeyParamSchema.safeParse({ workerKey: 'a-worker-added-later' }).success
    && !WorkerKeyParamSchema.safeParse({ workerKey: '../../etc/passwd' }).success
    && !WorkerKeyParamSchema.safeParse({ workerKey: 'Plan_Expiry' }).success);

t.assert('the replay limit is bounded at both ends', () =>
    ReplayOutboxSchema.safeParse({}).success
    && ReplayOutboxSchema.safeParse({ limit: 500 }).success
    && !ReplayOutboxSchema.safeParse({ limit: 0 }).success
    && !ReplayOutboxSchema.safeParse({ limit: 5000 }).success);

// ─────────────────────────────────────────────────────────────────────────────
t.section('4. The two gates — permission AND flag');

const DEV_TOOL_ACTIONS = [
    'developer_tools.feature_flags.set',
    'developer_tools.workers.trigger',
    'developer_tools.outbox.replay',
    'developer_tools.catalogue.vectorise',
    // Phase 15's one new dangerous verb.
    'developer_tools.outbox.prune',
] as const;

t.assert('every developer-tool action is catalogued', () =>
    DEV_TOOL_ACTIONS.every(isAuditAction));

t.assert('every one is governed by a tier-1-only permission', () =>
    DEV_TOOL_ACTIONS.every((action) => {
        const governing = auditSpec(action).permission;
        return governing !== null
            && hasPermission(1, governing)
            && !hasPermission(2, governing)
            && !hasPermission(3, governing);
    }));

t.assert('no developer_tools permission is swept in by allInFamily', () =>
    !allInFamily('developer_tools').some((name) => permissionSpec(name).destructive));

t.assert('the destructive ones are flagged as such', () =>
    (['developer_tools.workers.trigger', 'developer_tools.outbox.replay',
        'developer_tools.catalogue.vectorise', 'developer_tools.feature_flags.set'] as const)
        .every((name) => permissionSpec(name).destructive === true));

/**
 * `webhooks.redeliver` has no audit action, and that is deliberate — every `/webhooks/*`
 * mount in jovi-mall is inbound, so there is no outbound delivery to redeliver. The
 * permission stays, naming its missing prerequisite.
 */
t.assert('webhooks.redeliver is NOT catalogued as an action', () =>
    !isAuditAction('developer_tools.webhooks.redeliver'));

t.assert('...but its permission still exists, so the gap is documented rather than lost', () =>
    permissionSpec('developer_tools.webhooks.redeliver').family === 'developer_tools');

// ─────────────────────────────────────────────────────────────────────────────
t.section('5. Audit targets and route declarations');

t.assert('feature_flag and worker are internal — Support sees neither', () =>
    subjectClassOf('feature_flag') === 'internal' && subjectClassOf('worker') === 'internal');

t.assert('the flag action targets a feature_flag, the worker action a worker', () =>
    auditSpec('developer_tools.feature_flags.set').target === 'feature_flag'
    && auditSpec('developer_tools.workers.trigger').target === 'worker');

/**
 * A replay and a vectorise act on a SET chosen by a filter, not on one record with an id.
 * `none` is the honest target; the filter and the count live in the payload and outcome.
 */
t.assert('the set-wide tools target `none` rather than an arbitrary member', () =>
    auditSpec('developer_tools.outbox.replay').target === 'none'
    && auditSpec('developer_tools.catalogue.vectorise').target === 'none');

t.assert('the flag flip is wi_admin_txn — its row and the change commit together', () =>
    auditSpec('developer_tools.feature_flags.set').transport === 'wi_admin_txn');

t.assert('the three jovi-mall tools are delegated', () =>
    (['developer_tools.workers.trigger', 'developer_tools.outbox.replay',
        'developer_tools.catalogue.vectorise'] as const)
        .every((action) => auditSpec(action).transport === 'delegated'));

const opsRoutes = routeManifest().filter((route) =>
    route.fullPath.startsWith('/api/v1/system') || route.fullPath.startsWith('/api/v1/dev-tools'));

t.assert('both surfaces registered their routes', () => opsRoutes.length >= 9);

t.assert('every /system route is a read', () =>
    opsRoutes.filter((r) => r.fullPath.startsWith('/api/v1/system')).every((r) => r.method === 'get'));

t.assert('every mutating dev-tools route declares an audit action', () =>
    opsRoutes.filter((r) => r.method !== 'get').every((r) => r.audit !== null && r.audit.kind === 'records'));

t.assert('no ops route is public — every one needs a permission', () =>
    opsRoutes.every((route) => route.access.kind === 'permission'));

/**
 * The feature-flag routes must NOT sit behind `dev_tools.enabled`, or turning the tools on
 * would require the tools to be on. Asserted at the source, since the gate lives in the
 * gateway and a route file cannot express its absence.
 */
t.assert('the flag endpoints do not go through the gated gateway', () => {
    const controller = require('fs').readFileSync(
        require('path').join(__dirname, '..', '..', 'src', 'modules', 'dev-tools',
            'controllers', 'dev-tools.controller.ts'),
        'utf8',
    ) as string;
    // `setFlag`/`listFlags` come from the service; only the tools go through `gateway.`.
    return /listFlags,\s*setFlag\s*\}\s*from\s*'\.\.\/domain\/feature-flag\.service'/.test(controller);
});

function devToolsGatewaySource(): string {
    return require('fs').readFileSync(
        require('path').join(__dirname, '..', '..', 'src', 'modules', 'dev-tools',
            'gateways', 'dev-tools.gateway.ts'),
        'utf8',
    ) as string;
}

t.assert('every gated tool in the gateway is behind the enabled check', () => {
    // FIVE gated tools: runWorker, replayOutbox, pruneOutbox, vectoriseCatalogue, flushCache.
    // `listWorkers` is a read. `setMaintenance` is the documented carve-out below.
    //
    // `pruneOutbox` took this from 4 to 5 in Phase 15. The COUNT is asserted rather than the
    // names because the failure it guards against is a tool added *without* the check — and a
    // new ungated function is exactly the shape that omission takes.
    return (devToolsGatewaySource().match(/await assertDevToolsEnabled\(\);/g) ?? []).length === 5;
});

/**
 * Phase 15's tool is behind the flag, which is the asymmetry ADR-014 D-7 sets out: an operator
 * who cannot prune an outbox is inconvenienced, whereas one who cannot exit a maintenance
 * window is stuck.
 */
t.assert('pruneOutbox IS behind the flag — losing a prune only inconveniences', () => {
    const source = devToolsGatewaySource();
    const start = source.indexOf('export async function pruneOutbox');
    if (start === -1) return false;
    const end = source.indexOf('export async function', start + 1);
    return source.slice(start, end === -1 ? undefined : end).includes('await assertDevToolsEnabled();');
});

/**
 * `setMaintenance` must NOT sit behind `dev_tools.enabled`, and this pins it.
 *
 * The same shape of argument as the feature-flag exemption above, one level more serious. With
 * the flag applied, an operator could not put the platform into maintenance during an incident
 * without first flipping an unrelated switch — and if anybody turned `dev_tools.enabled` off
 * while a window was open, **the exit would be locked**, recoverable only by a redeploy or a
 * hand-written Mongo update against jovi-mall's `system_state`.
 *
 * Asserted at the source, because the gate lives in the gateway and a route file cannot express
 * its absence. If somebody "tidies" the carve-out away, this fails rather than the next incident.
 */
t.assert('setMaintenance is NOT behind the flag — a switch must not turn off its own switch', () => {
    const source = devToolsGatewaySource();
    const start = source.indexOf('export async function setMaintenance');
    if (start === -1) return false;
    const end = source.indexOf('export async function', start + 1);
    const body = source.slice(start, end === -1 ? undefined : end);
    return !body.includes('assertDevToolsEnabled');
});

t.assert('flushCache IS behind the flag — losing a cache flush only inconveniences', () => {
    const source = devToolsGatewaySource();
    const start = source.indexOf('export async function flushCache');
    if (start === -1) return false;
    return source.slice(start).includes('await assertDevToolsEnabled();');
});

// ─────────────────────────────────────────────────────────────────────────────
t.section('6. The catalog agrees with itself');

t.assert('every developer_tools action name matches its governing permission', () =>
    Object.keys(AUDIT_CATALOG)
        .filter((name) => name.startsWith('developer_tools.'))
        .every((name) => auditSpec(name as never).permission === name));

// ─────────────────────────────────────────────────────────────────────────────
t.section('7. Phase 14 — system operations');

t.assert('the two new system reads are catalogued and not sensitive', () =>
    (['system.metrics.read', 'system.maintenance.read'] as const).every((name) => {
        const spec = permissionSpec(name);
        return spec.family === 'system' && spec.action === 'read' && spec.destructive === undefined;
    }));

t.assert('metrics is its OWN permission, not folded into system.health.read', () =>
    permissionSpec('system.metrics.read').summary.toLowerCase().includes('request volumes'));

t.assert('the two new tools are destructive writes in the developer_tools family', () =>
    (['developer_tools.maintenance.set', 'developer_tools.cache.flush'] as const).every((name) => {
        const spec = permissionSpec(name);
        return spec.family === 'developer_tools' && spec.action === 'write' && spec.destructive === true;
    }));

/**
 * The grant table needed NO edits for any of the four, and that is true only by derivation —
 * tier 1 is `[...PERMISSION_NAMES]`, and tier 2 takes `allInFamily('system')`, which excludes
 * anything sensitive. Pinned here because "true by accident of derivation" is exactly the kind
 * of property a later edit to `ADMIN` could change without anybody noticing.
 */
t.assert('tier 1 holds all four new permissions', () =>
    (['system.metrics.read', 'system.maintenance.read',
        'developer_tools.maintenance.set', 'developer_tools.cache.flush'] as const)
        .every((name) => hasPermission(1, name)));

t.assert('tier 2 gets the two new system reads via allInFamily, and NEITHER new tool', () =>
    hasPermission(2, 'system.metrics.read')
    && hasPermission(2, 'system.maintenance.read')
    && !hasPermission(2, 'developer_tools.maintenance.set')
    && !hasPermission(2, 'developer_tools.cache.flush'));

t.assert('tier 3 (Support) gets none of the four', () =>
    (['system.metrics.read', 'system.maintenance.read',
        'developer_tools.maintenance.set', 'developer_tools.cache.flush'] as const)
        .every((name) => !hasPermission(3, name)));

t.assert('allInFamily("system") sweeps in the two new reads', () => {
    const family = allInFamily('system') as readonly string[];
    return family.includes('system.metrics.read') && family.includes('system.maintenance.read');
});

t.assert('both new audit actions are catalogued and delegated', () =>
    (['developer_tools.maintenance.set', 'developer_tools.cache.flush'] as const).every((name) =>
        isAuditAction(name) && auditSpec(name).transport === 'delegated'));

/**
 * A real target type for the maintenance window, `none` for the flush — the same split
 * `outbox.replay` already makes. A flush acts on a SET chosen by a filter; a maintenance window
 * is one thing, and it is the most consequential thing on this router.
 */
t.assert('maintenance targets a maintenance_window; the flush targets none', () =>
    auditSpec('developer_tools.maintenance.set').target === 'maintenance_window'
    && auditSpec('developer_tools.cache.flush').target === 'none');

t.assert('maintenance_window classifies as internal — Support does not see it', () =>
    subjectClassOf('maintenance_window') === 'internal');

t.section('7b. Phase 14 — validators mirror jovi-mall, never laxer');

t.assert('a maintenance window REQUIRES a reason; "off" does not', () =>
    !SetMaintenanceSchema.safeParse({ mode: 'down' }).success
    && !SetMaintenanceSchema.safeParse({ mode: 'down', reason: 'short' }).success
    && SetMaintenanceSchema.safeParse({ mode: 'down', reason: 'index migration on orders' }).success
    && SetMaintenanceSchema.safeParse({ mode: 'off' }).success);

t.assert('an unknown maintenance mode is refused', () =>
    !SetMaintenanceSchema.safeParse({ mode: 'sideways', reason: 'a valid reason' }).success);

t.assert('expiry is bounded at 24h — an unbounded window is the one nobody closes', () =>
    SetMaintenanceSchema.safeParse({ mode: 'down', reason: 'a valid reason', expiresInMinutes: 1440 }).success
    && !SetMaintenanceSchema.safeParse({ mode: 'down', reason: 'a valid reason', expiresInMinutes: 1441 }).success);

t.assert('the cache database is a NAME, never an index', () =>
    FlushCacheSchema.safeParse({ db: 'SLOT_LOCK_DB', confirm: 'SLOT_LOCK_DB' }).success
    && !FlushCacheSchema.safeParse({ db: '7', confirm: '7' }).success
    && !FlushCacheSchema.safeParse({ db: 'slot_lock_db', confirm: 'slot_lock_db' }).success);

t.assert('the flush requires a confirm field at all', () =>
    !FlushCacheSchema.safeParse({ db: 'SLOT_LOCK_DB' }).success);

t.assert('the flush limit is bounded', () =>
    !FlushCacheSchema.safeParse({ db: 'SLOT_LOCK_DB', confirm: 'SLOT_LOCK_DB', limit: 10_001 }).success);

t.section('7c. Phase 14 — route declarations');

const phase14Reads = ['/dependencies', '/integrations', '/queues', '/cache', '/metrics', '/maintenance'];

t.assert('all six new system reads are declared as GETs with a permission', () =>
    phase14Reads.every((path) => {
        const route = opsRoutes.find((r) => r.fullPath === `/api/v1/system${path}`);
        return route !== undefined && route.method === 'get' && route.access.kind === 'permission';
    }));

t.assert('/system/outbox SURVIVES — it is the read that still works when jovi-mall is down', () =>
    opsRoutes.some((r) => r.fullPath === '/api/v1/system/outbox'));

t.assert('both new dev-tools routes are mutations that record an audit action', () =>
    [['put', '/api/v1/dev-tools/maintenance'], ['post', '/api/v1/dev-tools/cache/flush']]
        .every(([method, path]) => {
            const route = opsRoutes.find((r) => r.fullPath === path && r.method === method);
            return route !== undefined && route.audit !== null && route.audit.kind === 'records';
        }));

/**
 * jovi-mall's base URL contains `_URL`, which `FORBIDDEN_CONFIG_TOKEN` matches by design — so
 * exposing it would stop the service booting, correctly. This asserts nothing crept in while
 * Phase 14 was adding operational reads.
 */
t.assert('EXPOSED_CONFIG_KEYS is unchanged — no platform URL or new key crept in', () =>
    !EXPOSED_CONFIG_KEYS.some((key) => /JOVI|PLATFORM|GEO_TRACKER/i.test(key)));

// ═════════════════════════════════════════════════════════════════════════════
t.section('8. Phase 15 — developer tools');

const PHASE_15_PERMISSIONS = [
    'developer_tools.logs.read',
    'developer_tools.database.inspect',
    'developer_tools.cache.inspect',
    'developer_tools.outbox.prune',
] as const;

t.assert('all four new permissions are catalogued', () =>
    PHASE_15_PERMISSIONS.every(isPermissionName));

/**
 * Tier-1 confinement comes from an EXISTING boot assertion (`developer_tools` ⇒ tier 1), not
 * from a new rule. Asserted anyway, because that is the property the whole permission argument
 * rests on.
 */
t.assert('all four are tier-1 only', () =>
    PHASE_15_PERMISSIONS.every((name) =>
        hasPermission(1, name) && !hasPermission(2, name) && !hasPermission(3, name)));

/**
 * **The assertion that pins §3 of ADR-015.**
 *
 * If any of these had been named `system.*`, `allInFamily('system')` would hand it to tier 2 —
 * and an unfiltered feed of every platform warning, a full collection map, or a list of cache
 * key names is a broader disclosure than any individual `*.read` an Admin holds. This is the
 * mechanical check that the naming decision was not quietly reversed.
 */
t.assert('allInFamily(\'system\') contains no log, database or cache-inspect permission', () => {
    const systemGrants = allInFamily('system') as readonly string[];
    return !systemGrants.some((name) =>
        name.includes('logs') || name.includes('database') || name.includes('cache.inspect'));
});

/** Regression guards: the two permissions the geo-tracker routes reuse must not have moved. */
t.assert('system.health.read is still tier-2 reachable, so the geo-tracker health route is', () =>
    hasPermission(2, 'system.health.read'));

t.assert('system.metrics.read is unchanged and NOT tier-3', () =>
    hasPermission(2, 'system.metrics.read') && !hasPermission(3, 'system.metrics.read'));

t.assert('only outbox.prune is flagged destructive — the three reads are not', () =>
    permissionSpec('developer_tools.outbox.prune').destructive === true
    && !permissionSpec('developer_tools.logs.read').destructive
    && !permissionSpec('developer_tools.database.inspect').destructive
    && !permissionSpec('developer_tools.cache.inspect').destructive);

// ─── Validators mirror jovi-mall's and are never laxer ───────────────────────

t.assert('PruneOutboxSchema rejects a below-floor age', () =>
    !PruneOutboxSchema.safeParse({ olderThanDays: 1, status: 'sent', confirm: '1' }).success);

t.assert('PruneOutboxSchema rejects status "failed" — that is outbox/replay\'s input', () =>
    !PruneOutboxSchema.safeParse({ olderThanDays: 30, status: 'failed', confirm: '30' }).success);

t.assert('PruneOutboxSchema accepts a well-formed request', () =>
    PruneOutboxSchema.safeParse({ olderThanDays: 30, status: 'sent', confirm: '30' }).success);

t.assert('LogQuerySchema bounds q at 100 chars and limit at 500', () =>
    !LogQuerySchema.safeParse({ q: 'x'.repeat(101) }).success
    && !LogQuerySchema.safeParse({ limit: 501 }).success
    && LogQuerySchema.safeParse({ q: 'payment', limit: 500 }).success);

t.assert('CacheKeysQuerySchema takes a NAME, never an index, and needs no confirm', () =>
    CacheKeysQuerySchema.safeParse({ db: 'SLOT_LOCK_DB' }).success
    && !CacheKeysQuerySchema.safeParse({ db: '7' }).success);

// ─── geo-tracker: the narrow exception, and the rule that keeps it narrow ────

t.assert('the geo-tracker client exposes exactly three paths', () =>
    GEO_TRACKER_OPS_PATHS.length === 3
    && ['/healthz', '/readyz', '/metrics'].every((p) => (GEO_TRACKER_OPS_PATHS as readonly string[]).includes(p)));

/**
 * The structural half of "never a readiness dependency": a client that cannot throw cannot
 * propagate a geo-tracker outage into a wi-admin read, however somebody wires it later.
 * Asserted at the source because the behaviour is a property of the axios config plus a catch
 * that returns, and neither is visible from the exported signatures.
 */
t.assert('the geo-tracker client cannot throw — every status is a result', () => {
    const raw = readFileSync(
        join(__dirname, '..', '..', 'src', 'infra', 'geo', 'geo-tracker.client.ts'), 'utf8');

    // Comments stripped first. Without it this assertion fails on the client's own comment
    // "Caught, never rethrown" — because "rethrown" contains the substring "throw". The same
    // trap the banned-token scans avoid, hit here by a regex rather than a token list.
    const code = raw
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
        .join('\n');

    return code.includes('validateStatus: () => true') && !/\bthrow\b/.test(code);
});

/**
 * ⚠ **The coupled-failure pin, and it lands in the same commit as the client.**
 *
 * ADR-014 D-1: making geo-tracker a readiness dependency means a geo-tracker wobble pulls
 * wi-admin out of rotation. The client cannot throw, which is the structural half; this is the
 * half that stops a tidy-minded reviewer from "improving" the health check by adding it.
 */
t.assert('neither /health nor SystemController.health references EITHER geo-tracker client', () => {
    const health = readFileSync(join(__dirname, '..', '..', 'src', 'api', 'routes', 'health.routes.ts'), 'utf8');
    const controller = readFileSync(
        join(__dirname, '..', '..', 'src', 'modules', 'system', 'controllers', 'system.controller.ts'), 'utf8',
    );
    // Widened at Phase 6.I: `geo-tracker-data.client` does NOT contain the literal
    // `geo-tracker.client`, so the original regex would have let the DATA door into the
    // readiness path — the one place this pin exists to keep it out of.
    if (/geo-tracker(-data)?\.client/.test(health)) return false;

    // The controller DOES import the ops client (for /system/geo-tracker) — what must not
    // happen is the `health` handler itself calling either.
    const start = controller.indexOf('static health =');
    if (start === -1) return false;
    const end = controller.indexOf('static ', start + 10);
    const body = controller.slice(start, end === -1 ? undefined : end);
    return !/probeGeo|readGeoMetrics|isGeoTrackerOpsConfigured|isGeoTrackerDataConfigured|readAgent|readShipment/
        .test(body);
});

/**
 * ── The data door, at Phase 6.I ──────────────────────────────────────────────
 * ADR-009 D-2 said wi-admin had no geo-tracker DATA door; ADR-020 amended it. These pin
 * the two properties that keep the new one from becoming what D-2 feared.
 */

/** Its path set is closed too — four reads, and no listing endpoint on either side. */
t.assert('the geo-tracker data client exposes exactly four reads', () => {
    // Comments stripped first, for the reason the sibling scans learned the hard way: this
    // file's own header names `/internal/*` in backticks while explaining the door, and a
    // scan that cannot tell prose from code fails on its own documentation.
    const code = readFileSync(
        join(__dirname, '..', '..', 'src', 'infra', 'geo', 'geo-tracker-data.client.ts'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
        .join('\n');
    const paths = code.match(/`\/internal\/[^`]+`/g) ?? [];
    return paths.length === 4
        && paths.filter((p) => p.includes('/internal/agents/')).length === 2
        && paths.filter((p) => p.includes('/internal/shipments/')).length === 2
        // The bound that matters most: no agent-scoped trail, ever.
        && !paths.some((p) => p.includes('/internal/agents/') && /trail|checkpoint/.test(p));
});

/**
 * The two doors stay two. Folding them would put a data call one typo away from being made
 * with no credential, and an ops call one typo away from carrying one.
 */
t.assert('the ops client carries no credential and the data client does', () => {
    const geoDir = join(__dirname, '..', '..', 'src', 'infra', 'geo');
    const ops = readFileSync(join(geoDir, 'geo-tracker.client.ts'), 'utf8');
    const data = readFileSync(join(geoDir, 'geo-tracker-data.client.ts'), 'utf8');
    return !/GEO_TRACKER_ADMIN_TOKEN|Authorization/.test(ops)
        && data.includes('GEO_TRACKER_ADMIN_TOKEN')
        && data.includes('GEO_TRACKER_DATA_BASE_URL')
        && !data.includes('GEO_TRACKER_OPS_BASE_URL');
});

// ─── The Prometheus text parser ─────────────────────────────────────────────

const EXPOSITION = [
    '# HELP geotracker_tracking_sessions_active Active tracking sessions',
    '# TYPE geotracker_tracking_sessions_active gauge',
    'geotracker_tracking_sessions_active 42',
    '# TYPE geotracker_webhook_request_duration_seconds histogram',
    'geotracker_webhook_request_duration_seconds_bucket{le="0.1"} 3',
    'geotracker_webhook_request_duration_seconds_bucket{le="+Inf"} 9',
    'geotracker_webhook_request_duration_seconds_sum 1.25',
    'geotracker_webhook_request_duration_seconds_count 9',
    'geotracker_node_api_requests_total{route="/a,/b",status="200"} 7',
    'this line is malformed',
    'geotracker_not_on_the_allowlist 1',
].join('\n');

const parsed = parsePromText(EXPOSITION, GEO_TRACKER_METRIC_ALLOWLIST);

t.assert('a gauge and its HELP/TYPE are parsed', () => {
    const gauge = parsed.metrics.find((m) => m.name === 'geotracker_tracking_sessions_active');
    return gauge?.type === 'gauge' && gauge.samples[0]?.value === 42;
});

t.assert('histogram _bucket/_sum/_count fold into their base instrument', () => {
    const hist = parsed.metrics.find((m) => m.name === 'geotracker_webhook_request_duration_seconds');
    return hist !== undefined && hist.samples.length === 4;
});

t.assert('le="+Inf" parses as Infinity rather than NaN', () => {
    const hist = parsed.metrics.find((m) => m.name === 'geotracker_webhook_request_duration_seconds');
    return hist?.samples.some((s) => s.labels.le === '+Inf' && s.value === 9) === true;
});

/** The case that looks fine until a label legitimately contains a comma. */
t.assert('a label VALUE containing a comma is one label, not two', () => {
    const metric = parsed.metrics.find((m) => m.name === 'geotracker_node_api_requests_total');
    const sample = metric?.samples[0];
    return sample?.labels.route === '/a,/b' && sample.labels.status === '200';
});

t.assert('a malformed line is counted, not thrown', () => parsed.ignored >= 1);

t.assert('a metric outside the allowlist is dropped — the projection is explicit', () =>
    !parsed.metrics.some((m) => m.name === 'geotracker_not_on_the_allowlist'));

t.assert('empty input yields no metrics and does not throw', () =>
    parsePromText('', GEO_TRACKER_METRIC_ALLOWLIST).metrics.length === 0);

// ─── Route declarations ─────────────────────────────────────────────────────

t.assert('all six new reads are declared, and none is a mutation', () => {
    const expected = [
        '/api/v1/system/platform/config',
        '/api/v1/system/platform/logs',
        '/api/v1/system/platform/cache/keys',
        '/api/v1/system/platform/database',
        '/api/v1/system/geo-tracker',
        '/api/v1/system/geo-tracker/metrics',
    ];
    return expected.every((path) =>
        routeManifest().some((r) => r.fullPath === path && r.method === 'get'));
});

t.assert('/system/config and /system/platform/config are both declared and distinct', () => {
    const manifest = routeManifest();
    return manifest.some((r) => r.fullPath === '/api/v1/system/config')
        && manifest.some((r) => r.fullPath === '/api/v1/system/platform/config');
});

t.assert('POST /dev-tools/outbox/prune is declared and audited', () => {
    const route = routeManifest().find(
        (r) => r.fullPath === '/api/v1/dev-tools/outbox/prune' && r.method === 'post');
    return route?.audit?.kind === 'records';
});

t.assert('every /system route is STILL a read after Phase 15', () =>
    routeManifest()
        .filter((r) => r.fullPath.startsWith('/api/v1/system'))
        .every((r) => r.method === 'get'));

// ─── Safe execution boundaries, mirroring jovi-mall's ───────────────────────

t.assert('no wi-admin ops source shells out or evaluates', () => {
    const dirs = [
        join(__dirname, '..', '..', 'src', 'modules', 'dev-tools'),
        join(__dirname, '..', '..', 'src', 'modules', 'system'),
        join(__dirname, '..', '..', 'src', 'infra', 'geo'),
    ];
    const banned = ['child_process', 'execSync', 'execFile', 'spawn(', 'eval(', 'new Function(', '$where'];

    const offenders: string[] = [];
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) { walk(full); continue; }
            if (!entry.name.endsWith('.ts')) continue;
            // Comments stripped first — the bans are DOCUMENTED in these files.
            const code = readFileSync(full, 'utf8')
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .split('\n')
                .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
                .join('\n');
            for (const token of banned) if (code.includes(token)) offenders.push(`${full}: ${token}`);
        }
    };
    dirs.forEach(walk);
    if (offenders.length > 0) console.error(`      ${offenders.join('\n      ')}`);
    return offenders.length === 0;
});

t.assert('the geo-tracker client builds no path from request input', () => {
    const source = readFileSync(
        join(__dirname, '..', '..', 'src', 'infra', 'geo', 'geo-tracker.client.ts'), 'utf8');
    // Every `http.get(...)` call takes the typed `path` parameter, never an interpolation.
    return !/http\.get\(`/.test(source) && /http\.get\(path\)/.test(source);
});

process.exit(t.finish());
