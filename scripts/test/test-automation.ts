/**
 * The automation failure audit (ADR-022) — offline.
 *
 * Everything here is a pure function of code: the tier projection, the validators, the
 * route declarations, the permission catalog and the allowlists. No Mongo, no Redis, no
 * n8n.
 *
 * Three sections carry the weight:
 *
 *   §2  the projection. A stack trace must not reach tier 2 and machine detail must not
 *       reach tier 3, and the completeness assertion is written against the FIELDS rather
 *       than a snapshot, so adding a field without deciding its rung fails here.
 *   §3  the door. It is the only route on this service reachable without an administrator,
 *       so §3 asserts it is exactly one route, that it is allowlisted, and that nothing on
 *       `/api/internal` ever declares an administrator gate.
 *   §5  the customer identifier. Hashing it is pointless if the digest is then handed out,
 *       so the projection is asserted never to emit it.
 *
 *   npm run test:automation
 */
import { suite } from './_assert';

process.env.NODE_ENV = 'test';
process.env.MONGO_URI_PLATFORM = 'mongodb://localhost:27017/jovi_mall_test';
process.env.MONGO_URI_ADMIN = 'mongodb://localhost:27017/wi_admin_test';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.ADMIN_JWT_SECRET = 'test-access-secret-value-32-chars-long';
process.env.ADMIN_JWT_REFRESH_SECRET = 'test-refresh-secret-value-32-chars-long';
process.env.ADMIN_DASHBOARD_ORIGINS = 'http://localhost:5173';

import { readFileSync } from 'fs';
import { join } from 'path';
import {
    NO_AUDIT_ROUTE_ALLOWLIST,
    PUBLIC_ROUTE_ALLOWLIST,
    SERVICE_ROUTE_ALLOWLIST,
    routeManifest,
} from '../../src/api/route-manifest';
import {
    AUTOMATION_CHANNELS,
    AUTOMATION_FAILURE_KINDS,
    AutomationFailureRecord,
} from '../../src/modules/automation/domain/automation.types';
import { projectFailureRecord, viewForTier } from '../../src/modules/automation/domain/failure-exposure';
import {
    FailureQuerySchema,
    FailureReportSchema,
    FailureSummaryQuerySchema,
} from '../../src/modules/automation/validators/automation.validator';
import { PERMISSION_NAMES, permissionSpec } from '../../src/modules/authorization/domain/permission.catalog';
import { TIER_GRANTS } from '../../src/modules/authorization/domain/tier-grants';
import { ERROR_CODES } from '../../src/core/errors/error-codes';
import { REDACTED_PATHS } from '../../src/core/logging/logger';

// Importing the routers is what registers them on the manifest.
import '../../src/modules/automation/routes/automation.routes';
import '../../src/modules/automation/routes/automation-internal.routes';

const t = suite('automation failure audit');

const SAMPLE: AutomationFailureRecord = {
    id: '65f0000000000000000000aa',
    workflowId: 'vvbouV2136P5weCs',
    workflowName: 'wi-mall-core',
    executionId: '902',
    kind: 'degraded_turn',
    occurredAt: '2026-09-07T11:12:31.874Z',
    receivedAt: '2026-09-07T11:12:33.000Z',
    nodeName: 'sync identity',
    errorMessage: 'timeout of 20000ms exceeded',
    errorStack: 'AxiosError: timeout of 20000ms exceeded\n    at createTimeoutError',
    channel: 'whatsapp',
    externalIdHash: 'deadbeefdeadbeefdeadbeefdeadbeef',
    requestId: '902',
};

// ─────────────────────────────────────────────────────────────────────────────
t.section('1. The two kinds, and why both exist');

t.assert('there are exactly two failure kinds', () => AUTOMATION_FAILURE_KINDS.length === 2);

/**
 * The whole reason this module is not a thin wrapper over n8n's execution status. During
 * the 2026-09-07 incident every execution reported `success` — fifteen error-swallowing
 * nodes in `wi-mall-core` guarantee it — so a monitor keyed on status alone shows a clean
 * board through an outage. `degraded_turn` is the signal that carries that case.
 */
t.assert('degraded_turn is a kind — a successful execution can still be a failure', () =>
    (AUTOMATION_FAILURE_KINDS as readonly string[]).includes('degraded_turn'));

t.assert('execution_failed is a kind', () =>
    (AUTOMATION_FAILURE_KINDS as readonly string[]).includes('execution_failed'));

t.assert('unknown is an allowed channel — an Error Trigger has no envelope to read one from', () =>
    (AUTOMATION_CHANNELS as readonly string[]).includes('unknown'));

// ─────────────────────────────────────────────────────────────────────────────
t.section('2. The tier projection');

t.assert('tier 1 sees the stack', () => projectFailureRecord(SAMPLE, 1).errorStack === SAMPLE.errorStack);

t.assert('tier 2 does NOT see the stack', () => projectFailureRecord(SAMPLE, 2).errorStack === undefined);
t.assert('tier 3 does NOT see the stack', () => projectFailureRecord(SAMPLE, 3).errorStack === undefined);

t.assert('tier 2 sees the operational detail', () => {
    const view = projectFailureRecord(SAMPLE, 2);
    return view.nodeName === 'sync identity'
        && view.errorMessage === SAMPLE.errorMessage
        && view.workflowId === SAMPLE.workflowId;
});

t.assert('tier 3 sees NO machine detail — no node, no message, no workflow', () => {
    const view = projectFailureRecord(SAMPLE, 3);
    return view.nodeName === undefined
        && view.errorMessage === undefined
        && view.workflowId === undefined
        && view.workflowName === undefined;
});

t.assert('tier 3 still sees channel, kind and time — enough to answer a ticket', () => {
    const view = projectFailureRecord(SAMPLE, 3);
    return view.channel === 'whatsapp'
        && view.kind === 'degraded_turn'
        && view.occurredAt === SAMPLE.occurredAt;
});

/**
 * Written against the KEYS rather than a snapshot: a field added to the record without a
 * decision about which rung sees it fails here, rather than silently reaching tier 3.
 */
t.assert('every record field is either projected or deliberately withheld', () => {
    const recordKeys = Object.keys(SAMPLE);
    const tier1Keys = new Set(Object.keys(projectFailureRecord(SAMPLE, 1)));
    const withheld = new Set(['externalIdHash']);
    return recordKeys.every((key) => tier1Keys.has(key) || withheld.has(key));
});

t.assert('the view name matches the rung', () =>
    viewForTier(1) === 'developer' && viewForTier(2) === 'admin' && viewForTier(3) === 'support');

// ─────────────────────────────────────────────────────────────────────────────
t.section('3. The machine door — the only route with no administrator');

const manifest = routeManifest();
const serviceRoutes = manifest.filter((r) => r.access.kind === 'service');

t.assert('exactly one route on the service declares serviceToken()', () => serviceRoutes.length === 1);

t.assert('it is the failure report, and it is a POST', () =>
    serviceRoutes[0]?.fullPath === '/api/internal/automation/failures'
    && serviceRoutes[0]?.method === 'post');

t.assert('it is in SERVICE_ROUTE_ALLOWLIST', () =>
    SERVICE_ROUTE_ALLOWLIST.has('POST /api/internal/automation/failures'));

t.assert('SERVICE_ROUTE_ALLOWLIST holds exactly one entry', () => SERVICE_ROUTE_ALLOWLIST.size === 1);

/** A credentialed route must never be described as public — the two lists mean different things. */
t.assert('it is NOT in PUBLIC_ROUTE_ALLOWLIST', () =>
    !PUBLIC_ROUTE_ALLOWLIST.has('POST /api/internal/automation/failures'));

t.assert('no /api/internal route declares an administrator gate', () =>
    manifest
        .filter((r) => r.fullPath.startsWith('/api/internal'))
        .every((r) => r.access.kind === 'service'));

t.assert('the report writes no audit row, and is allowlisted for it', () =>
    NO_AUDIT_ROUTE_ALLOWLIST.has('POST /api/internal/automation/failures'));

t.assert('the credential header is redacted from logs', () =>
    (REDACTED_PATHS as readonly string[]).includes('req.headers["x-automation-token"]'));

t.assert('all three door error codes are registered', () =>
    Boolean(ERROR_CODES.AUTOMATION_REPORT_TOKEN_INVALID)
    && Boolean(ERROR_CODES.AUTOMATION_REPORT_MALFORMED)
    && Boolean(ERROR_CODES.AUTOMATION_DOOR_UNCONFIGURED));

// ─────────────────────────────────────────────────────────────────────────────
t.section('4. The read surface, and the three rungs that reach it');

const readRoutes = manifest.filter((r) => r.fullPath.startsWith('/api/v1/automation'));

t.assert('both read routes are declared', () => readRoutes.length === 2);

t.assert('every read route is a GET — this surface changes nothing', () =>
    readRoutes.every((r) => r.method === 'get'));

t.assert('each reads via anyPermission across the three rungs', () =>
    readRoutes.every((r) =>
        r.access.kind === 'permission'
        && r.access.mode === 'any'
        && r.access.permissions.length === 3));

t.assert('the two new permissions are in the catalog', () =>
    (PERMISSION_NAMES as readonly string[]).includes('system.automation.read')
    && (PERMISSION_NAMES as readonly string[]).includes('support.automation.lookup'));

/**
 * The FAMILY is the enforcement mechanism, not the name. `allInFamily()` refuses to expand
 * anything sensitive, so a flag on either of these would silently drop it out of the tier
 * it was written for — and the route would 403 for every caller while looking correct.
 */
t.assert('neither new permission is flagged sensitive, or family expansion would skip it', () => {
    const a = permissionSpec('system.automation.read');
    const b = permissionSpec('support.automation.lookup');
    return !a.financial && !a.destructive && !a.escalation && !a.dualControl
        && !b.financial && !b.destructive && !b.escalation && !b.dualControl;
});

t.assert('tier 3 reaches the surface via support.automation.lookup', () =>
    TIER_GRANTS[3].includes('support.automation.lookup'));

t.assert('tier 2 reaches it via system.automation.read', () =>
    TIER_GRANTS[2].includes('system.automation.read'));

t.assert('tier 2 also inherits the Support name — privilege nests', () =>
    TIER_GRANTS[2].includes('support.automation.lookup'));

t.assert('tier 1 holds all three, including the developer_tools rung', () =>
    TIER_GRANTS[1].includes('developer_tools.logs.read')
    && TIER_GRANTS[1].includes('system.automation.read')
    && TIER_GRANTS[1].includes('support.automation.lookup'));

/** The constraint that forced two new names rather than one. */
t.assert('the developer_tools rung is tier 1 ONLY — which is why two new names exist', () =>
    !TIER_GRANTS[2].includes('developer_tools.logs.read')
    && !TIER_GRANTS[3].includes('developer_tools.logs.read'));

// ─────────────────────────────────────────────────────────────────────────────
t.section('5. The customer identifier');

/**
 * Hashing it in the repository is pointless if the digest is then emitted: a caller holding
 * hashes can correlate a customer across every report. Nothing on this surface needs that,
 * and the summary computes the only question it answers server-side.
 */
t.assert('externalIdHash never reaches ANY tier', () =>
    ([1, 2, 3] as const).every((tier) =>
        !Object.keys(projectFailureRecord(SAMPLE, tier)).includes('externalIdHash')));

t.assert('the raw externalId is never a projected field either', () =>
    ([1, 2, 3] as const).every((tier) =>
        !Object.keys(projectFailureRecord(SAMPLE, tier)).includes('externalId')));

/** Source scan: the digest must be salted, or E.164 is a weekend of hashing away. */
t.assert('the hash is salted with a per-deployment secret', () => {
    const source = readFileSync(
        join(
            __dirname, '..', '..', 'src', 'modules', 'automation',
            'repositories', 'automation-failure.repository.ts',
        ),
        'utf8',
    );
    return /AUTOMATION_REPORT_TOKEN/.test(source) && /createHash\(/.test(source);
});

// ─────────────────────────────────────────────────────────────────────────────
t.section('6. The report body — permissive on detail, strict on identity');

t.assert('a minimal report is accepted', () =>
    FailureReportSchema.safeParse({ workflowId: 'abc', kind: 'execution_failed' }).success);

t.assert('a report with no workflowId is refused', () =>
    !FailureReportSchema.safeParse({ kind: 'execution_failed' }).success);

t.assert('an unknown kind is refused', () =>
    !FailureReportSchema.safeParse({ workflowId: 'abc', kind: 'something_else' }).success);

/**
 * The reporter must never be able to make this 4xx for a reason it cannot fix. An Error
 * Trigger's payload varies by how the run died, so missing detail loses a FIELD — never
 * the whole incident.
 */
t.assert('every detail field is optional — missing detail must not lose the report', () =>
    FailureReportSchema.safeParse({
        workflowId: 'abc',
        kind: 'execution_failed',
        nodeName: null,
        errorMessage: null,
        errorStack: null,
        channel: null,
        externalId: null,
        occurredAt: null,
    }).success);

t.assert('a huge stack is accepted here and truncated on write, not refused', () =>
    FailureReportSchema.safeParse({
        workflowId: 'abc',
        kind: 'execution_failed',
        errorStack: 'x'.repeat(50_000),
    }).success);

// ─────────────────────────────────────────────────────────────────────────────
t.section('7. The read query — a monitor, not an export');

t.assert('limit is capped at 200', () => !FailureQuerySchema.safeParse({ limit: 201 }).success);
t.assert('limit defaults to 50', () => FailureQuerySchema.parse({}).limit === 50);
t.assert('the window defaults to 24 hours', () => FailureQuerySchema.parse({}).windowHours === 24);

t.assert('the window cannot exceed the 30-day TTL', () =>
    !FailureQuerySchema.safeParse({ windowHours: 24 * 31 }).success);

t.assert('the summary window has the same ceiling', () =>
    !FailureSummaryQuerySchema.safeParse({ windowHours: 24 * 31 }).success);

process.exit(t.finish());
