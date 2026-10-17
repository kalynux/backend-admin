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
    LiftAgencyCodRestrictionSchema,
    ReactivateAgencySchema,
    RestrictAgencyCodSchema,
    SearchAgenciesQuerySchema,
    VerifyAgencySchema,
} from '../../src/modules/agencies/validators/agency.validator';
import {
    codRestrictionAuditState,
    toCodRestrictionDto,
} from '../../src/modules/cod/read-models/cod-restriction.dto';
import { buildAgencyFilter } from '../../src/modules/agencies/repositories/agency.read.repository';
import { toAgencyPoliciesDto } from '../../src/modules/agencies/read-models/agency-policies.dto';
import { buildContractFilter } from '../../src/modules/agencies/repositories/contract.read.repository';
import { AUDIT_CATALOG, auditSpec, isAuditAction } from '../../src/modules/audit/domain/audit.catalog';
import { subjectClassOf } from '../../src/modules/audit/domain/audit-subject';
import { isPermissionName, permissionSpec } from '../../src/modules/authorization/domain/permission.catalog';
import { TIER_GRANTS, allInFamily } from '../../src/modules/authorization/domain/tier-grants';
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

// BR-028. The agency's detail page prints its user id, and the user directory names the
// business by nothing else. The vendor directory has matched both since it was written.
t.assert('⭐ a 24-hex term ALSO matches the USER id, as the vendor directory does', () => {
    const filter = buildAgencyFilter({ ...base, search: OID }) as Record<string, unknown>;
    return (filter.$or as Record<string, unknown>[]).some((b) => String(b.user_id) === OID);
});

t.assert('a non-id term, or a PART of an id, adds no id branch of either kind', () =>
    ['jovi', OID.slice(0, 8)].every((term) => {
        const filter = buildAgencyFilter({ ...base, search: term }) as Record<string, unknown>;
        return !(filter.$or as Record<string, unknown>[]).some((b) => '_id' in b || 'user_id' in b);
    }));

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

    // 4 cascade/verdict writes + the COD-limit read, pin and release (2026-10-02), which
    // share one jovi-mall path — seven calls on five paths until 2026-10-10, when the
    // COD-restriction read, restrict and lift added three more calls on a sixth path.
    return paths.length === 10 && new Set(paths).size === 6 && paths.every((p) => router.includes(`'${p}'`));
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

// Nine through Phase 6; ten since the KYC evidence read (2026-09-14).
// Ten until 2026-10-02, when the COD-limit read, pin and release made thirteen.
// Thirteen until 2026-10-10, when the COD-restriction read, restrict and lift made sixteen
// (each pinned by method, path, permission and audit action below, so the count cannot pass
// on a swap).
t.assert('sixteen agency routes are registered', () => agencyRoutes.length === 16);

/**
 * The agency COD cash limit (owner decision 2026-10-02). Read under `agencies.read`, written
 * under `agencies.cod_limit.set` — FINANCIAL, so `allInFamily('agencies')` cannot sweep it
 * in, Support never holds it, and Admin holds it only because it is named in the money block,
 * exactly like its agent twin `agents.cod_threshold.set`. Two audit actions, one permission.
 */
t.assert('the COD-limit read is agencies.read and unaudited; pin and release are agencies.cod_limit.set, audited apart', () => {
    const read = agencyRoutes.find((r) => r.fullPath === '/api/v1/agencies/:agencyId/cod-limit' && r.method === 'get');
    const pin = agencyRoutes.find((r) => r.fullPath === '/api/v1/agencies/:agencyId/cod-limit' && r.method === 'put');
    const release = agencyRoutes.find((r) => r.fullPath === '/api/v1/agencies/:agencyId/cod-limit/release');
    const perms = (r: typeof read) => (r && r.access.kind === 'permission' ? r.access.permissions : []);
    return !!read && !read.audit && perms(read).includes('agencies.read')
        && !!pin && perms(pin).includes('agencies.cod_limit.set') && !!pin.audit
        && !!release && release.method === 'post' && perms(release).includes('agencies.cod_limit.set') && !!release.audit
        && isAuditAction('agencies.cod_limit.set') && isAuditAction('agencies.cod_limit.release')
        && auditSpec('agencies.cod_limit.release').permission === 'agencies.cod_limit.set';
});

t.assert('agencies.cod_limit.set is FINANCIAL — so allInFamily cannot grant it', () =>
    isSensitive(permissionSpec('agencies.cod_limit.set')));

/**
 * The agency COD restriction (owner decision 2026-10-10) — an administrator switching cash
 * on delivery off for one agency, and back on. The limit's three-route shape again: the
 * read is `agencies.read`, both writes are `agencies.cod.restrict`, and the two directions
 * are two audit actions under that one permission, because lifting clears the record in
 * jovi-mall and the `unrestrict` row is then the only trace it existed.
 *
 * Each route is found by METHOD and exact path. The restrict and the read share a path, so
 * a lookup by path alone would pass with either one missing.
 */
const COD_RESTRICTION_PATH = '/api/v1/agencies/:agencyId/cod-restriction';
const codRestrictionRead = agencyRoutes.find((r) => r.fullPath === COD_RESTRICTION_PATH && r.method === 'get');
const codRestrict = agencyRoutes.find((r) => r.fullPath === COD_RESTRICTION_PATH && r.method === 'put');
const codLift = agencyRoutes.find((r) => r.fullPath === `${COD_RESTRICTION_PATH}/lift` && r.method === 'post');

t.assert('the COD-restriction read is a GET under agencies.read alone, and is not audited', () =>
    codRestrictionRead?.access.kind === 'permission'
    && codRestrictionRead.access.permissions.length === 1
    && codRestrictionRead.access.permissions[0] === 'agencies.read'
    && !codRestrictionRead.audit);

t.assert('restricting is a PUT under agencies.cod.restrict alone, recording agencies.cod.restrict', () =>
    codRestrict?.access.kind === 'permission'
    && codRestrict.access.mode === 'all'
    && codRestrict.access.permissions.length === 1
    && codRestrict.access.permissions[0] === 'agencies.cod.restrict'
    && codRestrict.audit?.kind === 'records'
    && codRestrict.audit.actions.length === 1
    && codRestrict.audit.actions[0] === 'agencies.cod.restrict');

t.assert('lifting is a POST …/lift under the SAME permission, recording agencies.cod.unrestrict', () =>
    codLift?.access.kind === 'permission'
    && codLift.access.mode === 'all'
    && codLift.access.permissions.length === 1
    && codLift.access.permissions[0] === 'agencies.cod.restrict'
    && codLift.audit?.kind === 'records'
    && codLift.audit.actions.length === 1
    && codLift.audit.actions[0] === 'agencies.cod.unrestrict');

t.assert('both audit actions exist, are delegated, target an agency and name the one permission', () =>
    (['agencies.cod.restrict', 'agencies.cod.unrestrict'] as const).every((action) => {
        if (!isAuditAction(action)) return false;
        const spec = auditSpec(action);
        return spec.permission === 'agencies.cod.restrict'
            && spec.target === 'agency'
            && spec.transport === 'delegated';
    }));

t.assert('...and read differently in the feed — two opposite acts, two summaries', () =>
    auditSpec('agencies.cod.restrict').summary !== auditSpec('agencies.cod.unrestrict').summary);

/**
 * FINANCIAL, like the limit it sits beside. The flag is the mechanism, not a description:
 * it keeps the name out of `allInFamily('agencies')`, so tier 2 holds it only because it is
 * typed into the money block, and `assertGrantTableValid()` refuses it to Support at boot.
 */
t.assert('agencies.cod.restrict is FINANCIAL, a write, and not dual-controlled', () => {
    const spec = permissionSpec('agencies.cod.restrict');
    return spec.financial === true && spec.action === 'write' && spec.dualControl === undefined;
});

t.assert('...so allInFamily(agencies) does not expand it', () =>
    !allInFamily('agencies').includes('agencies.cod.restrict'));

t.assert('Developer (tier 1) holds agencies.cod.restrict', () =>
    new Set(TIER_GRANTS[1]).has('agencies.cod.restrict'));

t.assert('Admin (tier 2) holds it — named in the money block', () =>
    new Set(TIER_GRANTS[2]).has('agencies.cod.restrict'));

t.assert('Support (tier 3) does NOT hold it', () =>
    !new Set(TIER_GRANTS[3]).has('agencies.cod.restrict'));

/**
 * ⚠ The KYC evidence read is `agencies.read`, the Support-tier lookup, and is not audited.
 *
 * Same call as the vendor and agent screens, for the same reason: Support answers "why was my
 * agency rejected" and cannot do it from a status. The verdict WRITES (`/verify`, `/reject`)
 * keep their own permission, and the DISCLOSURE — looking at the identity card — happens on
 * the audited `files.content.read`, not here.
 *
 * Narrowing this means narrowing all three in the same change.
 */
t.assert('the KYC evidence read is agencies.read and is not audited', () => {
    const route = agencyRoutes.find((r) => r.fullPath === '/api/v1/agencies/:agencyId/verification');
    return !!route
        && route.method === 'get'
        && route.access.kind === 'permission'
        && route.access.permissions.includes('agencies.read')
        && !route.audit;
});

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
        && !support.includes('agencies.reactivate')
        && !support.includes('agencies.cod_limit.set')
        && !support.includes('agencies.cod.restrict');
});

/**
 * Stated over the FAMILY rather than a list of names, so a seventh `agencies.*` write
 * added later is covered without anybody remembering to extend the assertion above.
 */
t.assert('...in fact agencies.read is the ONLY agencies.* permission Support holds', () => {
    const held = (TIER_GRANTS[3] ?? []).filter((name) => permissionSpec(name).family === 'agencies');
    return held.length === 1 && held[0] === 'agencies.read';
});

t.assert('Admin holds all five writes (incl. the COD-limit pin and the COD switch, named in the money block)', () => {
    const admin = TIER_GRANTS[2] ?? [];
    return [
        'agencies.verify', 'agencies.deactivate', 'agencies.reactivate',
        'agencies.cod_limit.set', 'agencies.cod.restrict',
    ].every((p) => admin.includes(p as never));
});

// Four until 2026-10-02; the COD-limit pin and release made six; the COD restriction and
// its lift (2026-10-10) made eight.
t.assert('eight agencies.* audit actions exist, all delegated, all targeting an agency', () => {
    const rows = Object.entries(AUDIT_CATALOG).filter(([name]) => name.startsWith('agencies.'));
    return rows.length === 8
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

// ─────────────────────────────────────────────────────────────────────────────
t.section('7. The COD restriction — the bodies, the gateway and the direct read');

const RESTRICTION_BODIES = [
    ['restrict', RestrictAgencyCodSchema],
    ['lift', LiftAgencyCodRestrictionSchema],
] as const;

/**
 * Required in BOTH directions — the opposite of deactivate/reactivate above, where undoing
 * needs no reason. jovi-mall requires one both ways, and lifting clears the stored
 * restriction, so the lift's reason survives only in this service's audit row.
 */
t.assert('a reason is required to restrict AND to lift', () =>
    RESTRICTION_BODIES.every(([, schema]) => !schema.safeParse({}).success
        && schema.safeParse({ reason: 'Repeated shortfalls on remitted cash' }).success));

t.assert('...trimmed, so padding cannot make a keystroke look like a reason', () =>
    RESTRICTION_BODIES.every(([, schema]) =>
        schema.parse({ reason: '  three refused parcels this week  ' }).reason === 'three refused parcels this week'
        && !schema.safeParse({ reason: '  x  ' }).success
        && !schema.safeParse({ reason: '     ' }).success));

t.assert('...bounded at 3–500 characters', () =>
    RESTRICTION_BODIES.every(([, schema]) =>
        !schema.safeParse({ reason: 'xx' }).success
        && schema.safeParse({ reason: 'xxx' }).success
        && schema.safeParse({ reason: 'x'.repeat(500) }).success
        && !schema.safeParse({ reason: 'x'.repeat(501) }).success));

/**
 * The bound is jovi-mall's, and a limit only one side enforces is one the other side can
 * violate: a 600-character reason accepted here would be refused there as a bare 400, after
 * the audit intent had already been written. Read from jovi-mall's source so a change to
 * either constant fails this suite rather than a request.
 */
t.assert('...the same bound jovi-mall enforces (COD_RESTRICTION_REASON_MIN / _MAX)', () => {
    const types = read(JOVI, 'core', 'types', 'cod-restriction.types.ts');
    return /COD_RESTRICTION_REASON_MIN\s*=\s*3\b/.test(types)
        && /COD_RESTRICTION_REASON_MAX\s*=\s*500\b/.test(types);
});

/**
 * The direction is the ROUTE. jovi-mall's body carries a `restricted` flag; if this one
 * accepted it, `PUT …/cod-restriction { restricted: false }` would be a restrict request
 * saying "lift" and one of the two would silently win.
 */
t.assert('both bodies are strict — a `restricted` key is refused, never ignored', () =>
    RESTRICTION_BODIES.every(([, schema]) =>
        !schema.safeParse({ reason: 'A real reason', restricted: false }).success
        && !schema.safeParse({ reason: 'A real reason', maxAmount: 0 }).success));

/** One exported gateway function, from its declaration to the next `export`. */
function gatewayFunction(name: string): string {
    const source = readCode(...AGENCY_GATEWAY);
    const start = source.indexOf(`export async function ${name}(`);
    if (start === -1) return '';
    const next = source.indexOf('\nexport ', start + 1);
    return source.slice(start, next === -1 ? undefined : next);
}

t.assert('restricting sends PUT /agencies/:id/cod-restriction with `restricted: true` and the reason', () => {
    const body = gatewayFunction('restrictCod');
    return body.includes("method: 'PUT'")
        && body.includes('path: `/agencies/${agencyId}/cod-restriction`')
        && /body:\s*\{\s*restricted:\s*true,\s*reason\s*\}/.test(body)
        && !body.includes('restricted: false')
        && body.includes("'agencies.cod.restrict'");
});

t.assert('lifting sends the SAME endpoint with `restricted: false`, under agencies.cod.unrestrict', () => {
    const body = gatewayFunction('liftCodRestriction');
    return body.includes("method: 'PUT'")
        && body.includes('path: `/agencies/${agencyId}/cod-restriction`')
        && /body:\s*\{\s*restricted:\s*false,\s*reason\s*\}/.test(body)
        && !body.includes('restricted: true')
        && body.includes("'agencies.cod.unrestrict'");
});

t.assert('the reason is in the audit payload as well as forwarded', () =>
    ['restrictCod', 'liftCodRestriction'].every((name) => /\{ reason \},/.test(gatewayFunction(name))));

/**
 * `before` and `after` go through ONE mapper, so the diff is a single key that lines up.
 * A `before` shaped differently from its `after` is a diff nobody can read.
 */
t.assert('before and after are both reduced by codRestrictionAuditState', () =>
    ['restrictCod', 'liftCodRestriction'].every((name) => {
        const body = gatewayFunction(name);
        return body.includes('codRestrictionAuditState(current),')
            && /\},\s*codRestrictionAuditState,\s*\);/.test(body);
    }));

t.assert('the audit state is exactly { codRestricted } — the one thing the write changes', () => {
    const on = codRestrictionAuditState({ subject: 'agency', subjectId: OID, userId: OID, restricted: true, restriction: null });
    const off = codRestrictionAuditState({ subject: 'agency', subjectId: OID, userId: OID, restricted: false, restriction: null });
    return on !== null && off !== null
        && Object.keys(on).join(',') === 'codRestricted'
        && on.codRestricted === true
        && off.codRestricted === false
        && codRestrictionAuditState(null) === null;
});

/** A controller handler, from `static name` to the next `static `. */
function handler(name: string): string {
    const source = readCode(...AGENCY_CONTROLLER);
    const start = source.indexOf(`static ${name} `);
    if (start === -1) return '';
    const next = source.indexOf('static ', start + 1);
    return source.slice(start, next === -1 ? undefined : next);
}

/**
 * The order inside each write handler: 404, then the delegated read that becomes the audit
 * `before`, then the write. Scanned within the handler's own span — every write in this
 * controller calls `loadOr404`, so a file-wide scan would pass with these two missing it.
 */
t.assert('both write handlers 404 first, read the current state through jovi-mall, then write', () =>
    ([['restrictCod', 'gateway.restrictCod('], ['liftCodRestriction', 'gateway.liftCodRestriction(']] as const)
        .every(([name, call]) => {
            const span = handler(name);
            const load = span.indexOf('loadOr404(');
            const current = span.indexOf('gateway.codRestriction(');
            const write = span.indexOf(call);
            return load !== -1 && current !== -1 && write !== -1 && load < current && current < write;
        }));

t.assert('the read handler 404s before it delegates', () => {
    const span = handler('codRestriction');
    const load = span.indexOf('loadOr404(');
    const call = span.indexOf('gateway.codRestriction(');
    return load !== -1 && call !== -1 && load < call;
});

/**
 * The detail carries the restriction so the dashboard can badge an agency without a second
 * call. It is projected field by field like `kyc_details` — never `cod_restriction: 1`,
 * which would ship whatever jovi-mall adds to the sub-document next.
 */
t.assert('the detail projects the restriction field by field, never whole', () => {
    const source = readCode(...AGENCY_REPO);
    const extras = source.slice(source.indexOf('const AGENCY_DETAIL_EXTRAS'), source.indexOf('const MAGAZIN_PROJECTION'));
    return ['reason', 'restricted_at', 'restricted_by_user_id', 'restricted_by_source', 'restricted_by_name']
        .every((field) => extras.includes(`'cod_restriction.${field}': 1`))
        && !/['"]?cod_restriction['"]?\s*:\s*1/.test(source);
});

t.assert('...on the DETAIL only — a directory row does not carry it', () => {
    const source = readCode(...AGENCY_REPO);
    const list = source.slice(source.indexOf('const AGENCY_LIST_PROJECTION'), source.indexOf('const AGENCY_DETAIL_EXTRAS'));
    return !list.includes('cod_restriction');
});

t.assert('the detail DTO maps it through toCodRestrictionDto', () =>
    readCode(...AGENCY_CONTROLLER).includes('codRestriction: toCodRestrictionDto(agency.cod_restriction)'));

/**
 * The mapper, driven. "Not restricted" has three stored spellings — the field absent (every
 * agency written before 2026-10-10), an explicit `null` (a lifted one), and a sub-document
 * with no stamp — and all three must read as `null`, which is jovi-mall's own test
 * (`isCodRestricted`: `restricted_at` is set).
 */
t.assert('absent, null and unstamped all read as not restricted', () =>
    toCodRestrictionDto(undefined) === null
    && toCodRestrictionDto(null) === null
    && toCodRestrictionDto({}) === null
    && toCodRestrictionDto({ reason: 'stale', restricted_at: null }) === null);

t.assert('a stamped restriction maps to the five named fields, in camelCase, with an ISO instant', () => {
    const dto = toCodRestrictionDto({
        reason: 'Repeated shortfalls on remitted cash',
        restricted_at: new Date('2026-10-10T09:30:00.000Z'),
        restricted_by_user_id: OID,
        restricted_by_source: 'admin',
        restricted_by_name: 'Ada Admin',
        // Not in the contract. It must not travel.
        internal_note: 'must not reach the dashboard',
    });
    return dto !== null
        && Object.keys(dto).sort().join(',')
            === 'reason,restrictedAt,restrictedByName,restrictedBySource,restrictedByUserId'
        && dto.reason === 'Repeated shortfalls on remitted cash'
        && dto.restrictedAt === '2026-10-10T09:30:00.000Z'
        && dto.restrictedByUserId === OID
        && dto.restrictedBySource === 'admin'
        && dto.restrictedByName === 'Ada Admin';
});

t.assert('jovi-mall’s rule for "restricted" is still the one this mapper copies', () => {
    const rule = readCode(JOVI, 'modules', 'cod', 'domain', 'cod-restriction.ts');
    const fn = rule.slice(rule.indexOf('export function isCodRestricted'));
    return fn.slice(0, 400).includes('restricted_at') && fn.slice(0, 400).includes('at !== null && at !== undefined');
});

// ─────────────────────────────────────────────────────────────────────────────
t.section('Customer-paid delivery — the two ADR-A11 pricing fields');

t.assert('pricing carries maxFeePerShipment and acceptsCashDeliveryFee', () => {
    const dto = toAgencyPoliciesDto({ pricing: { max_fee_per_shipment: 5_000, accepts_cash_delivery_fee: true } });
    return dto?.pricing?.maxFeePerShipment === 5_000 && dto?.pricing?.acceptsCashDeliveryFee === true;
});
t.assert('an agency that never set them reads "no ceiling" and "no cash fee"', () => {
    const dto = toAgencyPoliciesDto({ pricing: {} });
    return dto?.pricing?.maxFeePerShipment === null && dto?.pricing?.acceptsCashDeliveryFee === false;
});

process.exit(t.finish());
