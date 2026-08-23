/**
 * Delivery-agency administration — the rules, with no infrastructure.
 *
 * The agency half of the delivery network. `test-agents.ts` carries the shared checks —
 * the legacy count, the contract filters, the transport split on that side — so this
 * suite covers what is specific to agencies, and three things in particular:
 *
 *   §2  the aggregation's STAGE ORDER. This is the one list in the service that must join
 *       before it pages, because `search` matches a field on the joined collection. Get
 *       the order wrong and the search silently matches nothing while the endpoint keeps
 *       answering 200.
 *   §3  `payout_details` is absent from both projections. An agency's is the same
 *       `IPayoutMethod[]` shape whose maskers exist in three places precisely because the
 *       raw form must not leave.
 *   §5  `agencies.verify` is granted to tier 2 and withheld from Support — and
 *       `agencies.deactivate` is flagged `destructive`, which is what stops
 *       `allInFamily()` handing it to anybody.
 *
 *   npm run test:agencies
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
    AGENCY_AUDIT_ACTIONS,
    AGENCY_SORT,
    DeactivateAgencySchema,
    ReactivateAgencySchema,
    SearchAgenciesQuerySchema,
    VerifyAgencySchema,
} from '../../src/modules/agencies/validators/agency.validator';
import { buildAgencyFilter } from '../../src/modules/agencies/repositories/agency.read.repository';
import { buildContractFilter } from '../../src/modules/agencies/repositories/contract.read.repository';
import { AUDIT_CATALOG, auditSpec, isAuditAction } from '../../src/modules/audit/domain/audit.catalog';
import { subjectClassOf } from '../../src/modules/audit/domain/audit-subject';
import { isPermissionName, permissionSpec } from '../../src/modules/authorization/domain/permission.catalog';
import { TIER_GRANTS } from '../../src/modules/authorization/domain/tier-grants';
import { isSensitive } from '../../src/modules/authorization/domain/permission.types';
import { routeManifest } from '../../src/api/route-manifest';
import '../../src/modules/agencies/routes/agency.routes';

const t = suite('delivery agencies');

const SRC = join(__dirname, '..', '..', 'src');
const JOVI = join(__dirname, '..', '..', '..', 'jovi-mall', 'src');

function read(...segments: string[]): string {
    return readFileSync(join(...segments), 'utf8');
}

function readCode(...segments: string[]): string {
    return read(...segments)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
}

const AGENCY_REPO = [SRC, 'modules', 'agencies', 'repositories', 'agency.read.repository.ts'];
const AGENCY_CONTROLLER = [SRC, 'modules', 'agencies', 'controllers', 'agency.controller.ts'];
const AGENCY_GATEWAY = [SRC, 'modules', 'agencies', 'gateways', 'agency.gateway.ts'];

function query(overrides: Record<string, unknown> = {}) {
    return SearchAgenciesQuerySchema.safeParse({ ...overrides });
}

const OID = '507f1f77bcf86cd799439011';
const base = { page: 1, limit: 20, sort: { field: 'createdAt', direction: -1 as const } };

// ─────────────────────────────────────────────────────────────────────────────
t.section('1. The list query');

t.assert('defaults to page 1, limit 20, newest first', () => {
    const parsed = query();
    return parsed.success
        && parsed.data.page === 1
        && parsed.data.limit === 20
        && parsed.data.sort.direction === -1;
});

t.assert('every AGENCY_SORT key parses in both directions', () =>
    Object.keys(AGENCY_SORT).every((key) => query({ sort: key }).success && query({ sort: `-${key}` }).success));

/**
 * The business name is the field an administrator most wants to sort by and the one they
 * cannot have: it lives on the joined Magazin, where no index is reachable after a
 * `$lookup`. Offering it would be a collection-scan-plus-blocking-sort requestable from a
 * query string (ADR-005 D-13).
 */
t.assert('the business name is NOT sortable', () =>
    !('businessName' in AGENCY_SORT) && !('name' in AGENCY_SORT) && !query({ sort: 'businessName' }).success);

t.assert('a status outside jovi-mall’s three is refused', () =>
    query({ status: 'pending_verification' }).success && !query({ status: 'suspended' }).success);

t.assert('`verified=false` is FALSE, not a truthy string', () => {
    const parsed = query({ verified: 'false' });
    return parsed.success && parsed.data.verified === false;
});

t.assert('a country is normalised to upper case and must be ISO-2', () => {
    const parsed = query({ country: 'cm' });
    return parsed.success && parsed.data.country === 'CM' && !query({ country: 'CMR' }).success;
});

t.assert('the date range is bounded to a year', () =>
    !query({ from: '2020-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z' }).success);

t.assert('the activity filter is derived from the audit catalog, not typed out', () => {
    const source = readCode(SRC, 'modules', 'agencies', 'validators', 'agency.validator.ts');
    return source.includes('AUDIT_ACTION_NAMES.filter')
        && AGENCY_AUDIT_ACTIONS.every((a) => a.startsWith('agencies.'))
        && AGENCY_AUDIT_ACTIONS.length
            === Object.keys(AUDIT_CATALOG).filter((a) => a.startsWith('agencies.')).length;
});

/**
 * `ContractStatus` has seven values jovi-mall owns and this service never writes. ADR-005
 * D-17: a vocabulary that is not ours gets validated for shape, not membership. It gained
 * `withdrawn` recently — a pinned copy here would have gone stale in silence.
 */
t.assert('the roster status filter is a bounded string, not a pinned enum', () => {
    const source = readCode(SRC, 'modules', 'agencies', 'validators', 'agency.validator.ts');
    return !source.includes("'withdrawn'") && !source.includes("'deactivated'");
});

// ─────────────────────────────────────────────────────────────────────────────
t.section('2. The Mongo filter and the pipeline it runs in');

t.assert('no filters produce an empty match', () =>
    Object.keys(buildAgencyFilter({ ...base })).length === 0);

t.assert('two or more clauses compose under $and, never by assignment', () => {
    const filter = buildAgencyFilter({ ...base, status: 'active', search: 'jovi' }) as Record<string, unknown>;
    return Array.isArray(filter.$and) && (filter.$and as unknown[]).length === 2;
});

t.assert('the search reaches the BUSINESS name on the joined Magazin', () => {
    const filter = buildAgencyFilter({ ...base, search: 'jovi' }) as Record<string, unknown>;
    const or = filter.$or as Record<string, unknown>[];
    return or.some((branch) => 'magazin.name' in branch);
});

t.assert('...and the contact name, email, phone', () => {
    const filter = buildAgencyFilter({ ...base, search: 'jovi' }) as Record<string, unknown>;
    const keys = (filter.$or as Record<string, unknown>[]).map((b) => Object.keys(b)[0]);
    return ['display_name', 'email', 'phone'].every((k) => keys.includes(k));
});

t.assert('a 24-hex term also matches the id', () => {
    const filter = buildAgencyFilter({ ...base, search: OID }) as Record<string, unknown>;
    return (filter.$or as Record<string, unknown>[]).some((b) => '_id' in b);
});

t.assert('`verified` reads kyc_details, the canonical mirror — not the deprecated one', () => {
    const filter = buildAgencyFilter({ ...base, verified: true }) as Record<string, unknown>;
    return filter['kyc_details.legit_verified'] === true && !('legit_verified' in filter);
});

t.assert('`verified: false` is emitted, not dropped as falsy', () => {
    const filter = buildAgencyFilter({ ...base, verified: false }) as Record<string, unknown>;
    return filter['kyc_details.legit_verified'] === false;
});

t.assert('the date range is half-open — $lt, never $lte', () => {
    const filter = buildAgencyFilter({ ...base, from: new Date(0), to: new Date(1) }) as Record<string, unknown>;
    const range = filter.created_at as Record<string, unknown>;
    return '$gte' in range && '$lt' in range && !('$lte' in range);
});

/**
 * The stage order is the assertion this suite exists for.
 *
 * `search` matches `magazin.name`, so the `$lookup` HAS to run before the `$match`. Put
 * the join in `aggregatePage`'s fast `join` half — which runs after skip/limit — and the
 * business-name branch matches nothing, on an endpoint that keeps returning 200 with a
 * plausible-looking page of results.
 */
t.assert('the list joins the Magazin BEFORE it matches', () => {
    const source = readCode(...AGENCY_REPO);
    const search = source.slice(source.indexOf('async search'), source.indexOf('async findById'));
    const lookupAt = search.indexOf('magazinLookup');
    const matchAt = search.indexOf('$match');
    return lookupAt >= 0 && matchAt >= 0 && lookupAt < matchAt;
});

t.assert('...which means the join is in `match`, not the paged `join` half', () => {
    const source = readCode(...AGENCY_REPO);
    const search = source.slice(source.indexOf('async search'), source.indexOf('async findById'));
    return search.includes('match:') && !search.includes('join:');
});

t.assert('the Magazin join preserves agencies that have none', () => {
    const source = readCode(...AGENCY_REPO);
    return source.includes('preserveNullAndEmptyArrays: true');
});

t.assert('the roster is scoped by agency and defaults to every status', () => {
    const filter = buildContractFilter({ agencyId: OID }, base) as Record<string, unknown>;
    return 'agency_id' in filter && !('status' in filter);
});

// ─────────────────────────────────────────────────────────────────────────────
t.section('3. What leaves the database');

const FORBIDDEN_AGENCY_FIELDS = ['payout_details', 'wa'];

t.assert('payout details never appear in a projection', () => {
    const source = readCode(...AGENCY_REPO);
    return FORBIDDEN_AGENCY_FIELDS.every((f) => !new RegExp(`['"]?${f}['"]?\\s*:\\s*1`).test(source));
});

t.assert('...nor in the controller', () => {
    const source = readCode(...AGENCY_CONTROLLER);
    return !source.includes('payout_details') && !source.includes('payoutDetails');
});

t.assert('both projections are whitelists — the list one is the narrower', () => {
    const source = readCode(...AGENCY_REPO);
    return source.includes('AGENCY_LIST_PROJECTION')
        && source.includes('AGENCY_DETAIL_EXTRAS')
        // The base is given the NARROW one, so the widest accidental leak is a list row.
        && /super\(COLLECTIONS\.DELIVERY_AGENCY,\s*AGENCY_LIST_PROJECTION\)/.test(source);
});

t.assert('the roster’s agent lookup projects only six fields', () => {
    const source = readCode(SRC, 'modules', 'agencies', 'repositories', 'contract.read.repository.ts');
    const block = source.slice(source.indexOf('ROSTER_AGENT_PROJECTION = {'));
    const fields = block.slice(0, block.indexOf('}')).split(',').filter((s) => s.trim().length > 0);
    return fields.length === 6;
});

t.assert('the DTO names its fields — no spread of the read model', () => {
    const source = readCode(...AGENCY_CONTROLLER);
    return !/\.\.\.agency[,\s}]/.test(source);
});

t.assert('both verification mirrors are surfaced, so a disagreement is visible', () => {
    const source = readCode(...AGENCY_CONTROLLER);
    return source.includes('verified:') && source.includes('verifiedLegacyMirror:');
});

t.assert('an absent business name is null, never the empty string (ADR-005 D-16)', () => {
    const source = readCode(...AGENCY_CONTROLLER);
    return source.includes('agency.magazin?.name ?? null') && !source.includes("magazin?.name ?? ''");
});

t.assert('files are opaque ids — this service resolves no URLs', () => {
    const source = readCode(...AGENCY_CONTROLLER) + readCode(...AGENCY_REPO);
    return source.includes('logoFileId') && !/resolveFileDetail|storageProvider|STORAGE_PROVIDER/.test(source);
});

// ─────────────────────────────────────────────────────────────────────────────
t.section('4. The transport split');

t.assert('the read repository never imports the delegation client', () =>
    !readCode(...AGENCY_REPO).includes('platform.client'));

t.assert('the gateway never imports the repository bases', () =>
    !readCode(...AGENCY_GATEWAY).includes('platform.repository'));

/**
 * The gateway REPORTS the cascade's counts and must not reproduce its logic — the cascade
 * is the one thing delegating this write exists to protect. It reads two numbers out of
 * jovi-mall's `meta`; it must not iterate anything, and it must not reach into another
 * module to find out what a product is.
 */
t.assert('the gateway reproduces none of the cascade', () => {
    const source = readCode(...AGENCY_GATEWAY);
    const iterates = /\bfor\s*\(|\bwhile\s*\(|\.forEach\(|\.map\(|\.filter\(/.test(source);
    const reachesIntoADomain = /from '\.\.\/\.\.\/(catalog|orders|vendors)/.test(source);
    return !iterates && !reachesIntoADomain;
});

t.assert('every write is wrapped in an audit intent', () => {
    const source = readCode(...AGENCY_GATEWAY);
    const writes = (source.match(/method:\s*'(POST|PUT|PATCH|DELETE)'/g) ?? []).length;
    const audited = (source.match(/auditedDelegation\(/g) ?? []).length;
    return writes > 0 && audited === writes;
});

t.assert('every delegated path exists in jovi-mall’s admin agency router', () => {
    const gateway = readCode(...AGENCY_GATEWAY);
    const router = read(JOVI, 'modules', 'delivery', 'admin-agency.routes.ts');

    const paths = [...gateway.matchAll(/path:\s*[`'](\/agencies[^`']*)[`']/g)]
        .map((m) => m[1].replace('/agencies', '').replace(/\$\{agencyId\}/g, ':id'))
        .filter((p) => p.length > 0);

    return paths.length === 4 && paths.every((p) => router.includes(`'${p}'`));
});

t.assert('jovi-mall mounts the agency router internally', () => {
    const mounts = read(JOVI, 'api', 'routes', 'internal-admin.routes.ts');
    return mounts.includes("router.use('/agencies', buildAdminAgencyRouter([requireAdminCaller]))");
});

/**
 * ⚠ **This assertion was inverted on 2026-08-21 (Phase 6 Step 4), and it had been RED
 * since Phase 5 without anybody noticing.**
 *
 * As written for Phase 9 it asserted the opposite: that `api/index.ts` mounts
 * `router.use('/admin/delivery-agencies', adminAgencyRoutes)`. That was true and load-bearing
 * at the time — the router's paths had become relative so one factory could serve both
 * mounts, and the public mount had to absorb the segment or every dashboard URL moved.
 *
 * **Phase 5's cutover then deleted every public `/api/admin/*` mount — all eleven of them —
 * and this assertion with them lost its subject.** It went red on 2026-08-20 and was not
 * seen, because `test:agencies` was not among the six suites Phase 5's exit criteria ran.
 *
 * It is inverted rather than deleted: "there is no public admin mount" is now the invariant
 * worth holding, and it is one a well-meaning future change could break by re-adding a mount
 * that would compile, work, and silently reopen the second authorization model Phase 5 closed
 * (`requireRole(['admin'])` still exists — it guards the four non-admin roles).
 */
t.assert('jovi-mall serves NO public admin agency mount — Phase 5 deleted it', () => {
    const index = read(JOVI, 'api', 'index.ts');
    return !index.includes("router.use('/admin/delivery-agencies'")
        && !/router\.use\('\/admin\//.test(index);
});

t.assert('...and the router no longer declares that segment itself', () => {
    const router = read(JOVI, 'modules', 'delivery', 'admin-agency.routes.ts');
    return !router.includes("router.get('/delivery-agencies'");
});

// ─────────────────────────────────────────────────────────────────────────────
t.section('5. Routes, permissions and the audit catalog');

const agencyRoutes = routeManifest().filter((r) => r.fullPath.startsWith('/api/v1/agencies'));

t.assert('nine agency routes are registered', () => agencyRoutes.length === 9);

t.assert('every one declares a permission', () =>
    agencyRoutes.every((r) => r.access.kind === 'permission'));

t.assert('the roster requires agents.read as well — the rows carry agents', () => {
    const route = agencyRoutes.find((r) => r.fullPath.endsWith('/agents'));
    return route?.access.kind === 'permission'
        && route.access.permissions.includes('agents.read')
        && route.access.mode === 'all';
});

t.assert('the activity feed requires audit.read as well', () => {
    const route = agencyRoutes.find((r) => r.fullPath.endsWith('/activity'));
    return route?.access.kind === 'permission' && route.access.permissions.includes('audit.read');
});

t.assert('the contract history does NOT — it is not audit data', () => {
    const route = agencyRoutes.find((r) => r.fullPath.endsWith('/contract-history'));
    return route?.access.kind === 'permission' && !route.access.permissions.includes('audit.read');
});

t.assert('the three writes are POSTs, not the legacy PATCHes', () =>
    ['/verify', '/deactivate', '/reactivate'].every((suffix) => {
        const route = agencyRoutes.find((r) => r.fullPath.endsWith(suffix));
        return route?.method === 'post';
    }));

t.assert('agencies.verify exists and is unflagged, so allInFamily grants it to tier 2', () =>
    isPermissionName('agencies.verify') && !isSensitive(permissionSpec('agencies.verify')));

t.assert('agencies.deactivate is flagged destructive, so allInFamily cannot sweep it in', () =>
    isSensitive(permissionSpec('agencies.deactivate')));

t.assert('Support reads agencies and writes none of them', () => {
    const support = TIER_GRANTS[3] ?? [];
    return support.includes('agencies.read')
        && !support.includes('agencies.verify')
        && !support.includes('agencies.deactivate')
        && !support.includes('agencies.reactivate');
});

t.assert('Admin holds all three writes', () => {
    const admin = TIER_GRANTS[2] ?? [];
    return ['agencies.verify', 'agencies.deactivate', 'agencies.reactivate']
        .every((p) => admin.includes(p as never));
});

t.assert('four agencies.* audit actions exist, all delegated, all targeting an agency', () => {
    const rows = Object.entries(AUDIT_CATALOG).filter(([name]) => name.startsWith('agencies.'));
    return rows.length === 4
        && rows.every(([, spec]) => spec.transport === 'delegated' && spec.target === 'agency');
});

t.assert('deactivate and reactivate are two actions, so the feed reads', () =>
    isAuditAction('agencies.deactivate') && isAuditAction('agencies.reactivate')
    && auditSpec('agencies.deactivate').summary !== auditSpec('agencies.reactivate').summary);

t.assert('an agency classifies as a platform actor, so Support may read the feed', () =>
    subjectClassOf('agency') === 'platform_actor');

// ─────────────────────────────────────────────────────────────────────────────
t.section('6. The write bodies');

t.assert('deactivating requires a reason', () =>
    !DeactivateAgencySchema.safeParse({}).success
    && DeactivateAgencySchema.safeParse({ reason: 'Repeated failed deliveries' }).success);

/**
 * The asymmetry is deliberate: imposing a restriction needs a justification, undoing one
 * does not.
 */
t.assert('reactivating does not', () => ReactivateAgencySchema.safeParse({}).success);

t.assert('verify takes no body, and refuses an unexpected one', () =>
    VerifyAgencySchema.safeParse({}).success && !VerifyAgencySchema.safeParse({ reason: 'x' }).success);

/**
 * The reason lives in the audit payload and nowhere else. Forwarding it to jovi-mall,
 * whose endpoint does not read it, would look like it was recorded there.
 */
t.assert('the deactivation reason is audited, not forwarded', () => {
    const source = readCode(...AGENCY_GATEWAY);
    const block = source.slice(source.indexOf('export async function deactivate'));
    return block.includes('{ reason }') && !/body:\s*\{\s*reason/.test(block);
});

process.exit(t.finish());
