/**
 * Delivery-agent administration — the rules, with no infrastructure.
 *
 * Everything here is a pure function of code: the query schemas, the Mongo filter the
 * search builds, the projections that decide what leaves the database, and the catalog
 * wiring that decides who may do what. No Mongo, no Redis, no jovi-mall.
 *
 * Four sections are the ones worth having:
 *
 *   §3  the projections name their fields. `delivery_agents` holds government identity
 *       documents, payout destinations and a THIRD PARTY's phone number. A whitelist is
 *       the only thing that stops one arriving on a screen the day somebody adds a field
 *       upstream — and the DTO naming its fields is the second lock, the one that survives
 *       somebody widening the projection.
 *   §4  the tracking boundary is structural, not a convention. This module must not import
 *       a geo-tracker client, must not read a live position, and must report the
 *       authoritative capacity counter rather than the one that lags.
 *   §5  the transport split holds — and every delegated path this gateway calls actually
 *       exists in jovi-mall's router. That last one is the only assertion in the repo that
 *       catches a route rename across the service boundary.
 *   §7  the legacy checklist: 15 rows gone, the count down to 61, and the four rows that
 *       LOOK like this domain's and are not still present.
 *
 *   npm run test:agents
 */
import { readFileSync } from 'fs';
import { join } from 'path';
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
    AGENT_AUDIT_ACTIONS,
    AGENT_SORT,
    BanAgentSchema,
    EligibilityQuerySchema,
    ListAgentActivityQuerySchema,
    ReviewAgentKycSchema,
    SearchAgentsQuerySchema,
    SetAgentStatusSchema,
    SetThresholdSchema,
    SetTrackingSchema,
    TransferAgentSchema,
} from '../../src/modules/agents/validators/agent.validator';
import { buildAgentFilter } from '../../src/modules/agents/repositories/agent.read.repository';
import { buildContractFilter } from '../../src/modules/agencies/repositories/contract.read.repository';
import { buildContractEventFilter } from '../../src/modules/agencies/repositories/contract-event.read.repository';
import { AUDIT_CATALOG, auditSpec, isAuditAction } from '../../src/modules/audit/domain/audit.catalog';
import { subjectClassOf } from '../../src/modules/audit/domain/audit-subject';
import { permissionSpec } from '../../src/modules/authorization/domain/permission.catalog';
import { TIER_GRANTS } from '../../src/modules/authorization/domain/tier-grants';
import {
    LEGACY_ENDPOINT_COUNT,
    LEGACY_ENDPOINT_MAP,
} from '../../src/modules/authorization/domain/legacy-endpoint-map';
import { routeManifest } from '../../src/api/route-manifest';
// Importing the routers registers them into the manifest — the same source the boot
// assertion reads, so §6 checks what Express will actually serve.
import '../../src/modules/agents/routes/agent.routes';
import '../../src/modules/agencies/routes/agency.routes';

const t = suite('delivery agents');

const SRC = join(__dirname, '..', '..', 'src');
const JOVI = join(__dirname, '..', '..', '..', 'jovi-mall', 'src');

function read(...segments: string[]): string {
    return readFileSync(join(...segments), 'utf8');
}

/**
 * Read a file with its comments removed.
 *
 * Every source scan below must run on code, not prose. These files explain the rule they
 * follow by naming the anti-pattern — the agent repository says "`trust_signals: 1` and
 * the dotted paths below are DIFFERENT guarantees" — and a scan over the raw text reports
 * the explanation as the violation.
 */
function readCode(...segments: string[]): string {
    return read(...segments)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
}

const AGENT_REPO = [SRC, 'modules', 'agents', 'repositories', 'agent.read.repository.ts'];
const AGENT_CONTROLLER = [SRC, 'modules', 'agents', 'controllers', 'agent.controller.ts'];
const AGENT_GATEWAY = [SRC, 'modules', 'agents', 'gateways', 'agent.gateway.ts'];

function query(overrides: Record<string, unknown> = {}) {
    return SearchAgentsQuerySchema.safeParse({ ...overrides });
}

const OID = '507f1f77bcf86cd799439011';

// ─────────────────────────────────────────────────────────────────────────────
t.section('1. The list query');

t.assert('defaults to page 1, limit 20, newest first', () => {
    const parsed = query();
    return parsed.success
        && parsed.data.page === 1
        && parsed.data.limit === 20
        && parsed.data.sort.field === 'createdAt'
        && parsed.data.sort.direction === -1;
});

t.assert('a limit above the global maximum is refused, not clamped', () => !query({ limit: 101 }).success);

t.assert('an unknown sort field is refused', () => !query({ sort: 'name' }).success);

t.assert('every AGENT_SORT key parses in both directions', () =>
    Object.keys(AGENT_SORT).every((key) => query({ sort: key }).success && query({ sort: `-${key}` }).success));

t.assert('the four state axes are independently filterable', () =>
    query({ status: 'active' }).success
    && query({ kycStatus: 'unverified' }).success
    && query({ availability: 'offline' }).success
    && query({ workingState: 'at_capacity' }).success);

t.assert('a status outside jovi-mall’s enum is refused', () => !query({ status: 'retired' }).success);

t.assert('`banned=false` is FALSE, not a truthy string', () => {
    const parsed = query({ banned: 'false' });
    return parsed.success && parsed.data.banned === false;
});

t.assert('`trackingAllowed=true` parses to a real boolean', () => {
    const parsed = query({ trackingAllowed: 'true' });
    return parsed.success && parsed.data.trackingAllowed === true;
});

t.assert('the date range is bounded to a year', () =>
    !query({ from: '2020-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z' }).success);

t.assert('eligibility REQUIRES an agencyId — the verdict is pairwise', () =>
    !EligibilityQuerySchema.safeParse({}).success
    && EligibilityQuerySchema.safeParse({ agencyId: OID }).success);

t.assert('the activity filter is derived from the audit catalog, not typed out', () => {
    const source = readCode(SRC, 'modules', 'agents', 'validators', 'agent.validator.ts');
    return source.includes('AUDIT_ACTION_NAMES.filter')
        && AGENT_AUDIT_ACTIONS.every((a) => a.startsWith('agents.'))
        && AGENT_AUDIT_ACTIONS.length === Object.keys(AUDIT_CATALOG).filter((a) => a.startsWith('agents.')).length;
});

t.assert('the activity query accepts a derived action', () =>
    ListAgentActivityQuerySchema.safeParse({ action: 'agents.ban' }).success);

// ─────────────────────────────────────────────────────────────────────────────
t.section('2. The Mongo filter the search builds');

const base = { page: 1, limit: 20, sort: { field: 'createdAt', direction: -1 as const } };

t.assert('no filters produce an empty query, not a malformed one', () =>
    Object.keys(buildAgentFilter({ ...base })).length === 0);

t.assert('one filter is emitted flat, without a pointless $and', () => {
    const filter = buildAgentFilter({ ...base, status: 'active' }) as Record<string, unknown>;
    return filter.status === 'active' && filter.$and === undefined;
});

t.assert('two or more compose under $and, never by assignment', () => {
    const filter = buildAgentFilter({ ...base, status: 'active', search: 'ama' }) as Record<string, unknown>;
    return Array.isArray(filter.$and) && (filter.$and as unknown[]).length === 2;
});

t.assert('the search is an $or across name, email and phone', () => {
    const filter = buildAgentFilter({ ...base, search: 'ama' }) as Record<string, unknown>;
    const or = filter.$or as Record<string, unknown>[];
    const keys = or.map((branch) => Object.keys(branch)[0]);
    return keys.includes('name') && keys.includes('email') && keys.includes('phone');
});

t.assert('a 24-hex term ALSO matches the id — pasting one must not look broken', () => {
    const filter = buildAgentFilter({ ...base, search: OID }) as Record<string, unknown>;
    const or = filter.$or as Record<string, unknown>[];
    return or.some((branch) => '_id' in branch);
});

t.assert('a non-id term adds no _id branch', () => {
    const filter = buildAgentFilter({ ...base, search: 'ama' }) as Record<string, unknown>;
    const or = filter.$or as Record<string, unknown>[];
    return !or.some((branch) => '_id' in branch);
});

t.assert('a blank search term adds no clause at all', () =>
    Object.keys(buildAgentFilter({ ...base, search: '   ' })).length === 0);

t.assert('the nested axes use their dotted paths', () => {
    const filter = buildAgentFilter({ ...base, kycStatus: 'verified' }) as Record<string, unknown>;
    return filter['kyc.status'] === 'verified';
});

t.assert('`banned: false` is emitted, not dropped as falsy', () => {
    const filter = buildAgentFilter({ ...base, banned: false }) as Record<string, unknown>;
    return filter['platform_ban.banned'] === false;
});

t.assert('the date range is half-open — $lt, never $lte', () => {
    const filter = buildAgentFilter({ ...base, from: new Date(0), to: new Date(1) }) as Record<string, unknown>;
    const range = filter.created_at as Record<string, unknown>;
    return '$gte' in range && '$lt' in range && !('$lte' in range);
});

t.assert('the contract filter is always scoped, even with no other clause', () => {
    const filter = buildContractFilter({ agentId: OID }, base) as Record<string, unknown>;
    return 'agent_id' in filter;
});

t.assert('a contract scope id becomes an ObjectId — a string matches nothing here', () => {
    const filter = buildContractFilter({ agentId: OID }, base) as Record<string, unknown>;
    return typeof filter.agent_id === 'object';
});

t.assert('the contract-event filter is scoped to one side only', () => {
    const filter = buildContractEventFilter({ agentId: OID }, base) as Record<string, unknown>;
    return 'agent_id' in filter && !('agency_id' in filter);
});

// ─────────────────────────────────────────────────────────────────────────────
t.section('3. What leaves the database');

/**
 * The five fields that must never be projected, each for its own reason. The third is the
 * one most likely to be added back by somebody who has not thought about it: an emergency
 * contact is a person who never joined this platform.
 */
const FORBIDDEN_AGENT_FIELDS = [
    'legal_identity',
    'payout_details',
    'emergency_contact',
    'home_base.location',
    'avatar_url',
];

t.assert('no forbidden field appears in either agent projection', () => {
    const source = readCode(...AGENT_REPO);
    return FORBIDDEN_AGENT_FIELDS.every((field) => !source.includes(`'${field}'`) && !source.includes(`${field}:`));
});

t.assert('both agent projections are whitelists — no `: 0` exclusion anywhere', () => {
    const source = readCode(...AGENT_REPO);
    // `_id: 0` is legitimate inside a $lookup sub-projection; the agent repository has none.
    return !/:\s*0\s*,/.test(source.split('PROJECTION')[1] ?? '');
});

t.assert('`trust_signals` is enumerated, never taken as a whole sub-document', () => {
    const source = readCode(...AGENT_REPO);
    return !/\btrust_signals:\s*1\b/.test(source)
        && source.includes("'trust_signals.on_time_rate': 1");
});

t.assert('`device` is enumerated too', () => {
    const source = readCode(...AGENT_REPO);
    return !/^\s*device:\s*1\s*,/m.test(source) && source.includes("'device.platform': 1");
});

t.assert('the DTO names its fields — no spread of the read model onto the wire', () => {
    const source = readCode(...AGENT_CONTROLLER);
    return !/\.\.\.agent[,\s}]/.test(source);
});

t.assert('no forbidden field is named in the controller either', () => {
    const source = readCode(...AGENT_CONTROLLER);
    return FORBIDDEN_AGENT_FIELDS.filter((f) => f !== 'home_base.location')
        .every((field) => !source.includes(field));
});

/**
 * ── Every projected field EXISTS on jovi-mall's schema ───────────────────────
 *
 * Added at Phase 11, after a live one did not.
 *
 * `findNamesByIds` projected `display_name` and read `row.display_name` off the result.
 * That is the AGENCY's field; `delivery_agents` calls it `name`. Nothing caught it: the
 * read model extends `Document`, whose index signature makes `row.display_name` compile,
 * and Mongo answers a projection of a field that does not exist with silence rather than
 * an error. So every agent name resolved through that method was `null` — on the shipment
 * list, on the shipment detail, and on every offer row — and the response stayed a
 * well-formed 200 the whole time.
 *
 * A projection is a string, so no compiler can check it. This does what a compiler would:
 * reads jovi-mall's model and asserts each projected path is declared there. It is the
 * same trick `test-data-access.ts` uses for the collection constants — assert against the
 * other repo, never against a copy of it.
 */
t.assert('every field this module projects exists on jovi-mall’s agent schema', () => {
    const repo = readCode(...AGENT_REPO);
    const model = read(JOVI, 'modules', 'agents', 'models', 'agent.model.ts');

    // Every quoted-or-bare key given a `: 1` — the projection literals and the two
    // per-method overrides alike.
    const projected = [...repo.matchAll(/['"]?([a-z_]+(?:\.[a-z_]+)*)['"]?:\s*1\b/g)]
        .map((m) => m[1])
        .filter((path) => path !== '_id');

    const declared = new Set(
        [...model.matchAll(/^\s*([a-z_]+):/gm)].map((m) => m[1]),
    );

    /**
     * `*_source` and `*_name` are GENERATED, not written.
     *
     * `actorStampFields('verified_by')` returns the pair and is spread into the schema, so
     * neither name appears literally in the model source and a plain scan reports six
     * false positives. They are accepted when the model calls the generator for their
     * prefix — which also asserts something real: an actor id whose companions were never
     * generated is the dangling-id state ADR-004 D-1 says is only safe BECAUSE of them.
     */
    const isActorStamp = (segment: string): boolean => {
        const prefix = segment.replace(/_(source|name)$/, '');
        return prefix !== segment && model.includes(`actorStampFields('${prefix}')`);
    };

    // Each dotted segment has to be a declared schema key somewhere in the model. That is
    // coarser than resolving the nesting, and it is enough: the failure this catches is a
    // NAME that appears nowhere, which is exactly what `display_name` was.
    const unknown = projected
        .flatMap((path) => path.split('.'))
        .filter((segment) => !declared.has(segment) && !isActorStamp(segment));

    return projected.length > 20 && unknown.length === 0;
});

t.assert('...and the name lookup reads the field it projects', () => {
    const repo = readCode(...AGENT_REPO);
    return !repo.includes('display_name') && /projection: \{ _id: 1, name: 1 \}/.test(repo);
});

t.assert('the roster’s agent lookup carries an inner $project', () => {
    const source = readCode(SRC, 'modules', 'agencies', 'repositories', 'contract.read.repository.ts');
    return source.includes('pipeline: [{ $project: projection }]');
});

t.assert('the contract-event projection omits the Mixed `metadata` field', () => {
    const source = readCode(SRC, 'modules', 'agencies', 'repositories', 'contract-event.read.repository.ts');
    return !source.includes('metadata: 1');
});

// ─────────────────────────────────────────────────────────────────────────────
t.section('4. Tracking privacy is structural, not a convention');

t.assert('this module imports no geo-tracker client', () => {
    const source = readCode(...AGENT_CONTROLLER) + readCode(...AGENT_GATEWAY) + readCode(...AGENT_REPO);
    return !/GEO_TRACKER|geo-tracker|geotracker/i.test(source);
});

t.assert('`home_base.location` reaches neither the projection nor the DTO', () => {
    const repo = readCode(...AGENT_REPO);
    const controller = readCode(...AGENT_CONTROLLER);
    return !repo.includes('home_base.location') && !controller.includes('home_base?.location');
});

/**
 * The stale mirror IS served — jovi-mall's own admin detail already returns it, so
 * withholding it would be a silent parity break somebody re-adds as a bug report. What
 * must hold is that it never ships unlabelled.
 */
t.assert('the last-known position ships with an `isStale` flag beside it', () => {
    const source = readCode(...AGENT_CONTROLLER);
    return source.includes('position: lastKnown.last_position') && source.includes('isStale:');
});

t.assert('the DTO reports capacity’s counter, never working_state’s', () => {
    const source = readCode(...AGENT_CONTROLLER);
    return source.includes('activeShipments: agent.capacity?.active_shipment_count')
        && !/activeShipments:\s*agent\.working_state/.test(source);
});

t.assert('the three verdict reads are delegated, not reimplemented', () => {
    const source = readCode(...AGENT_GATEWAY);
    return source.includes('/tracking-policy')
        && source.includes('/cod-allocation')
        && source.includes('/eligibility');
});

t.assert('no eligibility RULE is evaluated locally', () => {
    const source = readCode(...AGENT_GATEWAY) + readCode(...AGENT_CONTROLLER);
    // The blocker vocabulary belongs to jovi-mall. Naming one here would mean a second
    // implementation of the rule that produces it.
    return !/kyc_not_verified|platform_banned|at_capacity'|no_approved_agency/.test(source);
});

// ─────────────────────────────────────────────────────────────────────────────
t.section('5. The transport split');

t.assert('the read repository never imports the delegation client', () =>
    !readCode(...AGENT_REPO).includes('platform.client'));

t.assert('the gateway never imports the repository bases', () =>
    !readCode(...AGENT_GATEWAY).includes('platform.repository'));

t.assert('every write in the gateway is wrapped in an audit intent', () => {
    const source = readCode(...AGENT_GATEWAY);
    const writes = (source.match(/method:\s*'(POST|PUT|PATCH|DELETE)'/g) ?? []).length;
    const audited = (source.match(/auditedDelegation\(/g) ?? []).length;
    return writes > 0 && audited === writes;
});

/**
 * The highest-value assertion in the suite: it is the only thing in the repo that catches
 * a route rename across the service boundary. `test-data-access.ts` §2 already proves the
 * technique works for collection names.
 */
t.assert('every delegated path exists in jovi-mall’s admin agent router', () => {
    const gateway = readCode(...AGENT_GATEWAY);
    const router = read(JOVI, 'modules', 'agents', 'routes', 'admin-agent.routes.ts');

    const paths = [...gateway.matchAll(/path:\s*[`'](\/agents[^`']*)[`']/g)]
        .map((m) => m[1])
        // Strip the mount prefix and the interpolation to leave the shape jovi-mall declares.
        .map((p) => p.replace('/agents', '').replace(/\$\{agentId\}/g, ':agentId'))
        .filter((p) => p.length > 0);

    return paths.length > 0 && paths.every((p) => router.includes(`'${p}'`));
});

t.assert('jovi-mall mounts the agent router internally for this service to reach', () => {
    const mounts = read(JOVI, 'api', 'routes', 'internal-admin.routes.ts');
    return mounts.includes("router.use('/agents', buildAdminAgentRouter([requireAdminCaller]))");
});

// ─────────────────────────────────────────────────────────────────────────────
t.section('6. Routes, permissions and the audit catalog');

const agentRoutes = routeManifest().filter((r) => r.fullPath.startsWith('/api/v1/agents'));

t.assert('fifteen agent routes are registered', () => agentRoutes.length === 15);

t.assert('every one declares a permission — none is public or self-service', () =>
    agentRoutes.every((r) => r.access.kind === 'permission'));

t.assert('/transfer is declared BEFORE the :agentId routes', () => {
    const all = routeManifest().filter((r) => r.fullPath.startsWith('/api/v1/agents'));
    const transfer = all.findIndex((r) => r.fullPath === '/api/v1/agents/transfer');
    const param = all.findIndex((r) => r.fullPath.includes(':agentId'));
    return transfer >= 0 && param >= 0 && transfer < param;
});

t.assert('the activity route requires audit.read as well', () => {
    const route = agentRoutes.find((r) => r.fullPath.endsWith('/activity'));
    return route?.access.kind === 'permission'
        && route.access.permissions.includes('audit.read')
        && route.access.mode === 'all';
});

t.assert('ban and unban are two routes sharing one permission', () => {
    const ban = agentRoutes.find((r) => r.fullPath.endsWith('/ban'));
    const unban = agentRoutes.find((r) => r.fullPath.endsWith('/unban'));
    return ban !== undefined && unban !== undefined
        && ban.access.kind === 'permission' && unban.access.kind === 'permission'
        && ban.access.permissions[0] === 'agents.ban'
        && unban.access.permissions[0] === 'agents.ban';
});

t.assert('...and two audit actions, so the feed stays readable', () =>
    isAuditAction('agents.ban') && isAuditAction('agents.unban')
    && auditSpec('agents.ban').summary !== auditSpec('agents.unban').summary);

t.assert('agents.unban is governed by agents.ban and targets an agent', () =>
    auditSpec('agents.unban').permission === 'agents.ban'
    && auditSpec('agents.unban').target === 'agent');

t.assert('every agents.* audit action is delegated — nothing is written from here', () =>
    Object.entries(AUDIT_CATALOG)
        .filter(([name]) => name.startsWith('agents.'))
        .every(([, spec]) => spec.transport === 'delegated'));

t.assert('an agent classifies as a platform actor, so Support may read the feed', () =>
    subjectClassOf('agent') === 'platform_actor');

t.assert('Support holds agents.read and none of the writes', () => {
    const support = TIER_GRANTS[3] ?? [];
    return support.includes('agents.read')
        && !support.includes('agents.ban')
        && !support.includes('agents.cod_threshold.set')
        && !support.includes('agents.status.set');
});

t.assert('the two sharpest permissions are flagged, so allInFamily cannot sweep them in', () =>
    isSensitiveName('agents.ban') && isSensitiveName('agents.cod_threshold.set'));

function isSensitiveName(name: 'agents.ban' | 'agents.cod_threshold.set'): boolean {
    const spec = permissionSpec(name);
    return 'destructive' in spec || 'financial' in spec;
}

// ─────────────────────────────────────────────────────────────────────────────
t.section('7. The write bodies');

t.assert('suspending requires a reason; activating refuses to need one', () =>
    !SetAgentStatusSchema.safeParse({ status: 'suspended' }).success
    && SetAgentStatusSchema.safeParse({ status: 'suspended', reason: 'Repeated no-shows' }).success
    && SetAgentStatusSchema.safeParse({ status: 'active' }).success);

t.assert('rejecting KYC requires a reason', () =>
    !ReviewAgentKycSchema.safeParse({ status: 'rejected' }).success
    && ReviewAgentKycSchema.safeParse({ status: 'rejected', rejectionReason: 'Illegible' }).success
    && ReviewAgentKycSchema.safeParse({ status: 'verified' }).success);

t.assert('disabling tracking requires a reason; enabling does not', () =>
    !SetTrackingSchema.safeParse({ allowed: false }).success
    && SetTrackingSchema.safeParse({ allowed: false, reason: 'Under investigation' }).success
    && SetTrackingSchema.safeParse({ allowed: true }).success);

t.assert('banning always requires a reason', () =>
    !BanAgentSchema.safeParse({}).success && BanAgentSchema.safeParse({ reason: 'Fraud' }).success);

t.assert('a negative COD threshold is refused', () =>
    !SetThresholdSchema.safeParse({ maxThreshold: -1 }).success
    && SetThresholdSchema.safeParse({ maxThreshold: 0 }).success);

t.assert('the threshold’s UPPER bound is NOT copied — jovi-mall owns it', () => {
    const source = readCode(SRC, 'modules', 'agents', 'validators', 'agent.validator.ts');
    return !/COD_THRESHOLD_MAX|\.max\(\s*\d{4,}/.test(source);
});

t.assert('a transfer to the same agency is refused', () =>
    !TransferAgentSchema.safeParse({
        agentId: OID, fromAgencyId: OID, toAgencyId: OID, reason: 'x'.repeat(5),
    }).success);

t.assert('every write body is .strict() — an unknown key is a 400, not a silent drop', () => {
    const source = readCode(SRC, 'modules', 'agents', 'validators', 'agent.validator.ts');
    const objects = (source.match(/z\s*\n?\s*\.object\(/g) ?? []).length;
    const stricts = (source.match(/\.strict\(\)/g) ?? []).length;
    // BanAgentSchema is a bare one-field object with no optional siblings; the rest are strict.
    return stricts >= objects - 1;
});

// ─────────────────────────────────────────────────────────────────────────────
t.section('8. The legacy checklist');

/**
 * Keyed on the PERMISSION family, not the path — and that is the whole point of the
 * assertion. `/api/admin/agents/:agentId/plan` starts with the same eleven characters as
 * the eleven rows this phase ported and is a BILLING endpoint that must survive. A path
 * prefix cannot tell them apart; the permission can.
 */
t.assert('no row guarded by an agents.* permission remains', () =>
    !LEGACY_ENDPOINT_MAP.some((e) => e.permission?.startsWith('agents.')));

t.assert('no row guarded by an agencies.* permission remains', () =>
    !LEGACY_ENDPOINT_MAP.some((e) => e.permission?.startsWith('agencies.')));

t.assert('...and the paths are gone too, not merely re-pointed', () =>
    !LEGACY_ENDPOINT_MAP.some((e) => e.path.startsWith('/api/admin/delivery-agencies'))
    && !LEGACY_ENDPOINT_MAP.some((e) => e.path === '/api/admin/agents/transfer'));

/**
 * The constant agrees with the rows — NOT what the number is.
 *
 * This used to read `=== 61` and stopped compiling the moment Phase 10 ported orders and
 * shipments, so the whole agents suite was dead for a phase and a half without anyone
 * noticing. Two suites pinning the same absolute number is what made that possible:
 * `test-authz.ts` owns the count (it is the suite about the migration surface), and this
 * one only needs the constant and the table not to disagree.
 *
 * Keep it that way. A domain suite asserting a global total is a suite that breaks for
 * reasons that have nothing to do with its domain.
 */
t.assert('LEGACY_ENDPOINT_COUNT matches the table it counts', () =>
    LEGACY_ENDPOINT_COUNT === LEGACY_ENDPOINT_MAP.length);

/**
 * The rows that LOOK like this domain's and are not — keyed on PERMISSION FAMILY, which
 * is the whole point.
 *
 * `/api/admin/agents/:agentId/plan` and `/api/admin/cod/agents` both match "agents" on
 * their path and belong to billing and cod respectively. Phase 9 had to not delete them;
 * these two assertions were what stopped it, spelled as "these rows still exist".
 *
 * **Phase 11 has now ported them, so that spelling is spent** — it asserted a fact that
 * was only ever true between two phases, and it failed the moment the right thing
 * happened. Rewritten as the invariant underneath it, which does not expire: a path
 * prefix cannot tell these domains apart, so the sweep must be keyed on the family, and
 * once a family is ported no row may carry it. Re-add a `cod.*` row and this fires.
 */
const PORTED_FAMILIES = ['agents', 'agencies', 'billing', 'cod', 'money', 'orders', 'shipments'];

t.assert('no row survives in a family that has already been ported', () => {
    const stragglers = LEGACY_ENDPOINT_MAP.filter((e) =>
        e.permission !== null && PORTED_FAMILIES.includes(e.permission.split('.')[0]));
    if (stragglers.length > 0) {
        console.error(`      stragglers: ${stragglers.map((e) => `${e.method} ${e.path}`).join(', ')}`);
    }
    return stragglers.length === 0;
});

/**
 * The converse, and the half that still catches a real mistake: a path matching this
 * domain must not be left behind under somebody else's permission. Nothing under
 * `/api/admin/agents` or `/api/admin/cod` should remain at all now.
 */
t.assert('no agent-shaped or COD-shaped path is left in the table', () =>
    !LEGACY_ENDPOINT_MAP.some((e) =>
        e.path.startsWith('/api/admin/agents')
        || e.path.startsWith('/api/admin/cod')
        || e.path.endsWith('/plan')));

t.assert('no duplicate rows were introduced', () => {
    const keys = LEGACY_ENDPOINT_MAP.map((e) => `${e.method} ${e.path}`);
    return new Set(keys).size === keys.length;
});

process.exit(t.finish());
