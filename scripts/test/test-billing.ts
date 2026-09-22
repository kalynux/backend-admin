/**
 * The subscription catalog and who is on it — the rules, with no infrastructure.
 *
 * The first of Phase 11's three money suites. `test-money.ts` will carry the ban-list
 * scans; billing's collections hold no credential, so this one covers the four things
 * that ARE easy to get wrong here:
 *
 *   §2  `expiringBefore` excludes the never-expiring free tier. BSON sorts `null` before
 *       every date, so a bare `$lt` puts every owner who is NOT expiring at the head of
 *       an "expiring soon" queue — a wrong answer that looks like an emergency.
 *   §2  the archive scope is applied unless asked otherwise, and survives `$and`
 *       composition with a search that is itself an `$or`.
 *   §3  `toPlanDto` names every field, and `null` vs absent means "unlimited" vs
 *       "unchanged" on the way back in.
 *   §5  the audit `before` and `after` speak the SAME camelCase, or a diff renders as
 *       every field having changed.
 *
 *   npm run test:billing
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
    AssignSubscriptionSchema,
    BILLING_OWNER_TYPES,
    CreatePlanSchema,
    ListPlanSubscribersQuerySchema,
    ListPlansQuerySchema,
    ListSubscriptionsQuerySchema,
    PLAN_SORT,
    SUBSCRIPTION_SORT,
    SubscriptionOwnerParamSchema,
    UpdatePlanSchema,
} from '../../src/modules/billing/validators/billing.validator';
import { buildPlanFilter } from '../../src/modules/billing/repositories/pricing-plan.read.repository';
import { buildSubscriptionFilter } from '../../src/modules/billing/repositories/subscriber-plan.read.repository';
import { toPlanDto, toSubscriptionDto, ownerKey } from '../../src/modules/billing/read-models/billing.dto';
import { AUDIT_CATALOG, auditSpec, isAuditAction } from '../../src/modules/audit/domain/audit.catalog';
import { subjectClassOf } from '../../src/modules/audit/domain/audit-subject';
import { isPermissionName, permissionSpec } from '../../src/modules/authorization/domain/permission.catalog';
import { TIER_GRANTS } from '../../src/modules/authorization/domain/tier-grants';
import { isSensitive } from '../../src/modules/authorization/domain/permission.types';
// The legacy endpoint map was imported here and is DELETED (Phase 5 Part D).
import { routeManifest } from '../../src/api/route-manifest';
import '../../src/modules/billing/routes/billing.routes';

const t = suite('billing');

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

const PLAN_REPO = [SRC, 'modules', 'billing', 'repositories', 'pricing-plan.read.repository.ts'];
const SUBSCRIPTION_REPO = [SRC, 'modules', 'billing', 'repositories', 'subscriber-plan.read.repository.ts'];
const BILLING_DTO = [SRC, 'modules', 'billing', 'read-models', 'billing.dto.ts'];
const BILLING_GATEWAY = [SRC, 'modules', 'billing', 'gateways', 'billing.gateway.ts'];
const BILLING_CONTROLLER = [SRC, 'modules', 'billing', 'controllers', 'billing.controller.ts'];

const OID = '507f1f77bcf86cd799439011';
const OTHER_OID = '507f1f77bcf86cd799439012';
const base = { page: 1, limit: 20, sort: { field: 'createdAt', direction: -1 as const } };
const planBase = { ...base, includeArchived: false, sort: { field: 'sortOrder', direction: 1 as const } };

// ─────────────────────────────────────────────────────────────────────────────
t.section('1. The query schemas');

t.assert('the catalog defaults to page 1, limit 20, sort_order ascending', () => {
    const parsed = ListPlansQuerySchema.safeParse({});
    return parsed.success
        && parsed.data.page === 1
        && parsed.data.limit === 20
        && parsed.data.sort.field === 'sortOrder'
        && parsed.data.sort.direction === 1;
});

/**
 * `sort_order` is the field the platform put there to say what order the tiers belong in.
 * A catalog listed newest-first shows them in the order somebody happened to create them.
 */
t.assert('...not newest-first, which is the default everywhere else', () =>
    ListPlansQuerySchema.safeParse({}).success
    && (ListPlansQuerySchema.safeParse({}) as { data: { sort: { field: string } } }).data.sort.field !== 'createdAt');

t.assert('every PLAN_SORT key parses in both directions', () =>
    Object.keys(PLAN_SORT).every((key) =>
        ListPlansQuerySchema.safeParse({ sort: key }).success
        && ListPlansQuerySchema.safeParse({ sort: `-${key}` }).success));

t.assert('every SUBSCRIPTION_SORT key parses in both directions', () =>
    Object.keys(SUBSCRIPTION_SORT).every((key) =>
        ListSubscriptionsQuerySchema.safeParse({ sort: key }).success
        && ListSubscriptionsQuerySchema.safeParse({ sort: `-${key}` }).success));

t.assert('an unlisted sort field is refused on both lists', () =>
    !ListPlansQuerySchema.safeParse({ sort: 'commissionPercent' }).success
    && !ListSubscriptionsQuerySchema.safeParse({ sort: 'ownerId' }).success);

t.assert('archived plans are out of scope unless asked for', () => {
    const parsed = ListPlansQuerySchema.safeParse({});
    return parsed.success && parsed.data.includeArchived === false;
});

t.assert('`includeArchived=false` is FALSE, not a truthy string', () => {
    const parsed = ListPlansQuerySchema.safeParse({ includeArchived: 'false' });
    return parsed.success && parsed.data.includeArchived === false;
});

/**
 * This service WRITES against this vocabulary — a plan is filed under a role, and the
 * assign route is mapped to one of exactly three jovi-mall paths by owner type. A fourth
 * value would be a request with nowhere to go.
 */
t.assert('the owner/role vocabulary is pinned to jovi-mall’s three', () =>
    BILLING_OWNER_TYPES.length === 3
    && ListPlansQuerySchema.safeParse({ role: 'agent' }).success
    && !ListPlansQuerySchema.safeParse({ role: 'customer' }).success
    && !SubscriptionOwnerParamSchema.safeParse({ ownerType: 'platform', ownerId: OID }).success);

/**
 * The opposite call, deliberately: this service never writes a status. ADR-005 D-17 — a
 * vocabulary that is not ours is validated for shape, not membership, because a pinned
 * copy goes stale in silence.
 */
t.assert('the subscription STATUS filter is a bounded string, not a pinned enum', () => {
    const source = readCode(SRC, 'modules', 'billing', 'validators', 'billing.validator.ts');
    return !source.includes("'pending_activation'")
        && !source.includes("'cancelled'")
        && ListSubscriptionsQuerySchema.safeParse({ status: 'pending_activation' }).success;
});

t.assert('the date range is bounded to a year on both subscription lists', () =>
    !ListSubscriptionsQuerySchema.safeParse({ from: '2020-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z' }).success
    && !ListPlanSubscribersQuerySchema.safeParse({ from: '2020-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z' }).success);

/**
 * A day is not an instant. "The next seven days" is a different seven days in Douala than
 * in Lisbon, and the client is the only party that knows which.
 */
t.assert('`expiringBefore` is an ISO instant with a zone, never a date', () =>
    ListSubscriptionsQuerySchema.safeParse({ expiringBefore: '2026-09-01T00:00:00.000Z' }).success
    && !ListSubscriptionsQuerySchema.safeParse({ expiringBefore: '2026-09-01' }).success);

/**
 * The plan id is fixed by the path on `/plans/:planId/subscribers`. A `planId` in the
 * query shape would be a second way to name it, and the wrong one would win.
 *
 * The protection is that the shape does not declare it, so Zod strips it — the parse
 * SUCCEEDS and the key is simply not in the result. Asserting a 400 here would be
 * asserting `.strict()`, which these list schemas deliberately are not: a dashboard
 * appending a stale filter to a URL should get a page, not an error.
 */
t.assert('the subscriber list cannot be re-pointed at another plan by query string', () => {
    const parsed = ListPlanSubscribersQuerySchema.safeParse({ planId: OTHER_OID });
    return parsed.success && !('planId' in parsed.data);
});

t.assert('...because the controller takes it from the path, never the query', () => {
    const source = readCode(...BILLING_CONTROLLER);
    const block = source.slice(
        source.indexOf('static listPlanSubscribers'),
        source.indexOf('static listSubscriptions'),
    );
    return block.includes('planId: req.params.planId') && !block.includes('planId: query.');
});

// ─────────────────────────────────────────────────────────────────────────────
t.section('2. The Mongo filters');

t.assert('the catalog always excludes archived plans by default', () => {
    const filter = buildPlanFilter({ ...planBase }) as Record<string, unknown>;
    return filter.deletedAt === null;
});

t.assert('...and stops excluding them only when asked', () => {
    const filter = buildPlanFilter({ ...planBase, includeArchived: true }) as Record<string, unknown>;
    return Object.keys(filter).length === 0;
});

/**
 * The search clause is an `$or`, and the archive scope is a separate key. Merged by
 * assignment they survive; merged with a second `$or` they do not — which is how
 * `audit-subject.ts` documents a Support administrator being handed the whole
 * administrator directory.
 */
t.assert('two or more clauses compose under $and, never by assignment', () => {
    const filter = buildPlanFilter({ ...planBase, role: 'vendor', search: 'growth' }) as Record<string, unknown>;
    return Array.isArray(filter.$and) && (filter.$and as unknown[]).length === 3;
});

t.assert('the archive scope survives that composition', () => {
    const filter = buildPlanFilter({ ...planBase, search: 'growth' }) as Record<string, unknown>;
    const clauses = filter.$and as Record<string, unknown>[];
    return clauses.some((clause) => clause.deletedAt === null);
});

t.assert('`isActive: false` is emitted, not dropped as falsy', () => {
    const filter = buildPlanFilter({ ...planBase, includeArchived: true, isActive: false }) as Record<string, unknown>;
    return filter.is_active === false;
});

t.assert('a search matches the code, the name — and a 24-hex term also the id', () => {
    const byText = buildPlanFilter({ ...planBase, includeArchived: true, search: 'growth' }) as Record<string, unknown>;
    const byId = buildPlanFilter({ ...planBase, includeArchived: true, search: OID }) as Record<string, unknown>;
    const textKeys = (byText.$or as Record<string, unknown>[]).map((b) => Object.keys(b)[0]);
    return textKeys.includes('code')
        && textKeys.includes('name')
        && (byId.$or as Record<string, unknown>[]).some((b) => '_id' in b);
});

t.assert('no subscription filters produce an empty match, never { $and: [] }', () =>
    Object.keys(buildSubscriptionFilter({ ...base })).length === 0);

/**
 * The assertion this suite exists for.
 *
 * BSON's comparison order puts `null` before every date, so a bare
 * `{ expires_at: { $lt: date } }` matches every never-expiring free-tier row in the
 * collection. An "expiring in the next seven days" queue would then be headed by every
 * owner who is not expiring at all.
 */
t.assert('`expiringBefore` refuses the never-expiring free tier', () => {
    const filter = buildSubscriptionFilter({ ...base, expiringBefore: new Date(1) }) as Record<string, unknown>;
    const range = filter.expires_at as Record<string, unknown>;
    return range.$ne === null && range.$lt instanceof Date;
});

t.assert('...and the source carries no bare $lt on expires_at', () => {
    const source = readCode(...SUBSCRIPTION_REPO);
    return !/expires_at:\s*\{\s*\$lt/.test(source);
});

t.assert('the created_at range is half-open — $lt, never $lte', () => {
    const filter = buildSubscriptionFilter({ ...base, from: new Date(0), to: new Date(1) }) as Record<string, unknown>;
    const range = filter.created_at as Record<string, unknown>;
    return '$gte' in range && '$lt' in range && !('$lte' in range);
});

t.assert('a plan-scoped subscriber list is scoped by plan_id and defaults to every status', () => {
    const filter = buildSubscriptionFilter({ ...base, planId: OID }) as Record<string, unknown>;
    return 'plan_id' in filter && !('status' in filter);
});

/**
 * Every id reaching this builder through a route has passed `objectId` at the edge, so
 * this branch is only reachable from a hand-built query — and a filter matching nothing is
 * the honest answer there, rather than a thrown BSONError from a pure function.
 */
t.assert('a malformed id becomes a term matching nothing, not a throw', () => {
    const filter = buildSubscriptionFilter({ ...base, ownerId: 'not-an-id' }) as Record<string, unknown>;
    const clause = filter.owner_id as Record<string, unknown>;
    return Array.isArray(clause.$in) && (clause.$in as unknown[]).length === 0;
});

// ─────────────────────────────────────────────────────────────────────────────
t.section('3. What leaves the database');

const planRow = {
    _id: { toString: () => OID },
    role: 'vendor',
    code: 'growth',
    name: 'Growth',
    price: 15000,
    currency: 'XAF',
    term_days: 30,
    credit_allowance: 500,
    max_active_products: null,
    max_storage_bytes: 1024,
    commission_percent: 7.5,
    max_unterminated_shipments: null,
    live_tracking_enabled: true,
    is_active: true,
    sort_order: 2,
    deletedAt: null,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-02-01T00:00:00.000Z'),
} as unknown as Parameters<typeof toPlanDto>[0];

t.assert('the plan DTO names its fields — no spread of the read model', () => {
    const source = readCode(...BILLING_DTO);
    return !/\.\.\.plan[,\s}]/.test(source) && !/\.\.\.row[,\s}]/.test(source);
});

t.assert('`commission_percent` reaches the wire — the reason plan detail exists', () =>
    toPlanDto(planRow).limits.commissionPercent === 7.5);

/**
 * "Deleted" is what the column is called and not what it means: the row stays, and every
 * owner already on the tier keeps running on it.
 */
t.assert('`deletedAt` is renamed `archivedAt` and is always present, never absent', () => {
    const dto = toPlanDto(planRow);
    const archived = toPlanDto({ ...planRow, deletedAt: new Date('2026-03-01T00:00:00.000Z') } as typeof planRow);
    return 'archivedAt' in dto
        && dto.archivedAt === null
        && archived.archivedAt === '2026-03-01T00:00:00.000Z';
});

t.assert('an inapplicable limit is null, never absent (ADR-005 D-16)', () => {
    const limits = toPlanDto(planRow).limits;
    return limits.maxActiveProducts === null
        && 'maxUnterminatedShipments' in limits
        && limits.maxUnterminatedShipments === null;
});

t.assert('dates leave as ISO strings, never Date objects', () => {
    const dto = toPlanDto(planRow);
    return dto.createdAt === '2026-01-01T00:00:00.000Z' && typeof dto.updatedAt === 'string';
});

/**
 * `maxCodPool` (2026-09-21) — an agent plan's COD pool. Present-and-null on a vendor plan
 * like every other inapplicable limit, carried through on an agent plan, and projected at
 * the source: a whitelist that forgot it would render every agent tier as "no COD".
 */
t.assert('maxCodPool is in the limits block — null on a vendor plan, the number on an agent plan', () => {
    const vendor = toPlanDto(planRow).limits;
    const agent = toPlanDto({ ...planRow, role: 'agent', max_cod_pool: 500_000 } as typeof planRow).limits;
    return 'maxCodPool' in vendor && vendor.maxCodPool === null && agent.maxCodPool === 500_000;
});

t.assert('…projected by the plan read repository, and mapped to max_cod_pool on the way out', () => {
    const repo = readCode(SRC, 'modules', 'billing', 'repositories', 'pricing-plan.read.repository.ts');
    const gateway = readCode(...BILLING_GATEWAY);
    return repo.includes('max_cod_pool: 1') && gateway.includes("set('max_cod_pool', input.maxCodPool)");
});

const subscriptionRow = {
    _id: { toString: () => OID },
    owner_type: 'vendor',
    owner_id: { toString: () => OTHER_OID },
    plan_id: { toString: () => OID },
    plan_code: 'growth',
    status: 'active',
    started_at: new Date('2026-01-01T00:00:00.000Z'),
    expires_at: null,
    assigned_by: null,
    assigned_by_source: 'platform',
    assigned_by_name: null,
    payment_reference: null,
    allowance_granted: true,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
} as unknown as Parameters<typeof toSubscriptionDto>[0];

const planRefs = new Map([[OID, { id: OID, code: 'growth', name: 'Growth', role: 'vendor' }]]);

/**
 * The self-service purchase path and the lazily-created free default both leave
 * `assigned_by` unset. A stamp rendered without checking it reads as "assigned by nobody,
 * source platform", which is a claim rather than an absence — the same rule that keys the
 * agency DTO's `verifiedBy` on the flag beside it.
 */
t.assert('an unassigned subscription reports assignedBy: null, not a hollow stamp', () =>
    toSubscriptionDto(subscriptionRow, planRefs, new Map()).assignedBy === null);

t.assert('an admin-assigned one carries the source and the name snapshot', () => {
    const dto = toSubscriptionDto(
        {
            ...subscriptionRow,
            assigned_by: { toString: () => OID },
            assigned_by_source: 'admin',
            assigned_by_name: 'Ada L.',
        } as typeof subscriptionRow,
        planRefs,
        new Map(),
    );
    return dto.assignedBy?.source === 'admin' && dto.assignedBy?.name === 'Ada L.';
});

/**
 * The code is denormalised onto the subscription row itself, so it answers even when the
 * plan lookup found nothing — which is exactly what a dangling `plan_id` produces. The
 * name being null in that case is how a hand-edited row makes itself visible.
 */
t.assert('a dangling plan_id still names the tier by code, with a null name', () => {
    const dto = toSubscriptionDto(subscriptionRow, new Map(), new Map());
    return dto.plan.code === 'growth' && dto.plan.name === null;
});

t.assert('the never-expiring free tier reports expiresAt: null, not a date', () =>
    toSubscriptionDto(subscriptionRow, planRefs, new Map()).expiresAt === null);

t.assert('the owner name is keyed by TYPE and id — two owner kinds can share an id', () => {
    const names = new Map([[ownerKey('vendor', OTHER_OID), 'Boutique Fatou']]);
    const asVendor = toSubscriptionDto(subscriptionRow, planRefs, names);
    const asAgent = toSubscriptionDto(
        { ...subscriptionRow, owner_type: 'agent' } as typeof subscriptionRow,
        planRefs,
        names,
    );
    return asVendor.owner.name === 'Boutique Fatou' && asAgent.owner.name === null;
});

// ─────────────────────────────────────────────────────────────────────────────
t.section('4. The write bodies');

const validPlan = {
    role: 'vendor',
    code: 'growth',
    name: 'Growth',
    price: 15000,
    termDays: 30,
    creditAllowance: 500,
};

t.assert('a plan can be created with the six required fields', () =>
    CreatePlanSchema.safeParse(validPlan).success);

/**
 * jovi-mall defaults `role` to `'vendor'`, which is right for a caller with one role to be
 * and wrong for an administrator creating tiers for three: an agency plan filed under
 * `vendor` is invisible on the agency catalog and only surfaces as a
 * `BILLING_PLAN_ROLE_MISMATCH` when somebody tries to assign it.
 */
t.assert('the role is REQUIRED here, where jovi-mall defaults it', () =>
    !CreatePlanSchema.safeParse({ ...validPlan, role: undefined }).success);

t.assert('`termDays: null` is accepted — that is the never-expiring free tier', () =>
    CreatePlanSchema.safeParse({ ...validPlan, termDays: null }).success);

/**
 * A mistyped field on this body is a plan quietly priced at the platform default.
 */
t.assert('an unknown key on a plan body is a 400, not a silent drop', () =>
    !CreatePlanSchema.safeParse({ ...validPlan, commision_percent: 5 }).success);

t.assert('a plan code is lower-cased and refuses whitespace', () => {
    const parsed = CreatePlanSchema.safeParse({ ...validPlan, code: 'GROWTH' });
    return parsed.success
        && parsed.data.code === 'growth'
        && !CreatePlanSchema.safeParse({ ...validPlan, code: 'agency free' }).success;
});

t.assert('a commission outside 0–100 is refused', () =>
    !CreatePlanSchema.safeParse({ ...validPlan, commissionPercent: 101 }).success
    && CreatePlanSchema.safeParse({ ...validPlan, commissionPercent: 0 }).success);

/**
 * jovi-mall `delete`s both keys off the update and carries on. Refusing is the better
 * answer for an administrative client: an operator who sent `code` believes they renamed
 * it, and a 200 that discarded the field is how they find out months later.
 */
t.assert('role and code are immutable — sending either is refused, not ignored', () =>
    !UpdatePlanSchema.safeParse({ role: 'agency' }).success
    && !UpdatePlanSchema.safeParse({ code: 'other' }).success);

t.assert('an empty update body is refused', () =>
    !UpdatePlanSchema.safeParse({}).success && UpdatePlanSchema.safeParse({ price: 1 }).success);

/**
 * `null` clears a cap to "unlimited"; omitting the key leaves the stored value alone.
 * Collapsing them would make "remove this cap" unexpressible.
 */
t.assert('a limit can be cleared to null on a PATCH', () =>
    UpdatePlanSchema.safeParse({ maxActiveProducts: null }).success);

t.assert('assigning takes a plan id, and refuses an unknown key', () =>
    AssignSubscriptionSchema.safeParse({ planId: OID }).success
    && AssignSubscriptionSchema.safeParse({ planId: OID, paymentReference: 'NP-1' }).success
    && !AssignSubscriptionSchema.safeParse({ planId: OID, paymentRef: 'NP-1' }).success);

t.assert('...and refuses a malformed plan id at the edge', () =>
    !AssignSubscriptionSchema.safeParse({ planId: 'growth' }).success);

// ─────────────────────────────────────────────────────────────────────────────
t.section('5. The transport split');

t.assert('the read repositories never import the delegation client', () =>
    !readCode(...PLAN_REPO).includes('platform.client')
    && !readCode(...SUBSCRIPTION_REPO).includes('platform.client'));

t.assert('the gateway never imports the repository bases', () =>
    !readCode(...BILLING_GATEWAY).includes('platform.repository'));

t.assert('every delegated write is wrapped in an audit intent', () => {
    const source = readCode(...BILLING_GATEWAY);
    const writes = (source.match(/method:\s*'(POST|PUT|PATCH|DELETE)'/g) ?? []).length;
    const audited = (source.match(/auditedDelegation\(/g) ?? []).length;
    return writes === 4 && audited === writes;
});

/**
 * `before` is read out of `jovi_mall` by this service in camelCase; `after` comes back
 * over HTTP in jovi-mall's snake_case. A row storing `commissionPercent` beside
 * `commission_percent` renders as every field having changed.
 */
t.assert('the audit before/after speak the same camelCase', () => {
    const gateway = readCode(...BILLING_GATEWAY);
    const controller = readCode(...BILLING_CONTROLLER);
    const afterKeys = gateway.slice(gateway.indexOf('function planState'), gateway.indexOf('function subscriptionState'));
    const beforeKeys = controller.slice(controller.indexOf('function toPlanAuditState'));

    return ['role', 'code', 'name', 'price', 'isActive', 'commissionPercent', 'archivedAt'].every(
        (key) => afterKeys.includes(`${key}:`) && beforeKeys.includes(`${key}:`),
    );
});

t.assert('...and the state mappers are two functions, not one that guesses the shape', () => {
    const source = readCode(...BILLING_GATEWAY);
    return source.includes('function planState') && source.includes('function subscriptionState');
});

/**
 * `null` clears a cap, absent leaves it alone. A body built by spreading the parsed
 * request would get the same answer through `JSON.stringify` dropping `undefined`, which
 * is correct by accident and stops being correct the day anything else serialises it.
 */
t.assert('the plan body maps camelCase → snake_case on `!== undefined`', () => {
    const source = readCode(...BILLING_GATEWAY);
    const block = source.slice(source.indexOf('function toPlatformPlanBody'));
    return block.includes('value !== undefined')
        && block.includes("set('commission_percent', input.commissionPercent)")
        && block.includes("set('term_days', input.termDays)");
});

t.assert('the three assign paths are a table, and reproduce no assignment logic', () => {
    const source = readCode(...BILLING_GATEWAY);
    const iterates = /\bfor\s*\(|\bwhile\s*\(|\.forEach\(/.test(source);
    return source.includes('ASSIGN_PATH')
        && source.includes('ASSIGN_ACTION')
        && !iterates;
});

t.assert('every delegated path exists in jovi-mall’s admin billing router', () => {
    const gateway = readCode(...BILLING_GATEWAY);
    const router = read(JOVI, 'modules', 'billing', 'routes', 'admin-billing.routes.ts');

    const paths = [...gateway.matchAll(/[`'](\/billing\/[^`']*)[`']/g)]
        .map((m) => m[1].replace('/billing', ''))
        .map((p) => p.replace(/\$\{planId\}/g, ':id').replace(/\$\{ownerId\}/g, ':id'));

    return paths.length >= 6 && paths.every((p) => {
        const normalised = p.replace(/:id/g, ':param');
        return router
            .replace(/:vendorId|:agencyId|:agentId|:id/g, ':param')
            .includes(`'${normalised}'`);
    });
});

t.assert('jovi-mall mounts the billing router internally', () => {
    const mounts = read(JOVI, 'api', 'routes', 'internal-admin.routes.ts');
    return mounts.includes("router.use('/billing', buildAdminBillingRouter([requireAdminCaller]))");
});

/**
 * Every query in jovi-mall is single-owner, so the partial uniques covered them all. The
 * two cross-owner lists added here page by recency and would otherwise be collection scans
 * plus a blocking in-memory sort — the Phase 9 precedent, where `delivery_agencies` gained
 * its first indexes the day it acquired an admin directory.
 */
t.assert('subscriber_plans gained the indexes these two lists page on', () => {
    const model = read(JOVI, 'modules', 'billing', 'models', 'subscriber-plan.model.ts');
    return model.includes('{ plan_id: 1, created_at: -1 }') && model.includes('{ created_at: -1 }');
});

// ─────────────────────────────────────────────────────────────────────────────
t.section('6. Routes, permissions and the audit catalog');

const billingRoutes = routeManifest().filter((r) => r.fullPath.startsWith('/api/v1/billing'));

// Eight at Phase 11; ten since the two subscription reads landed.
t.assert('ten billing routes are registered', () => billingRoutes.length === 10);

t.assert('every one declares a permission', () =>
    billingRoutes.every((r) => r.access.kind === 'permission'));

t.assert('the six reads all sit behind billing.plans.read alone', () => {
    const reads = billingRoutes.filter((r) => r.method === 'get');
    return reads.length === 6
        && reads.every(
            (r) => r.access.kind === 'permission'
                && r.access.permissions.length === 1
                && r.access.permissions[0] === 'billing.plans.read',
        );
});

/**
 * The owner-scoped read and the assign share a path shape and NOT a permission.
 *
 * Symmetry of shape is the point — assign and read address an owner the same way — but
 * reading who is on a plan is not the same act as changing what they are billed, and
 * `billing.subscriptions.assign` is flagged `financial` precisely so it cannot be swept
 * into a family grant.
 */
t.assert('the owner-scoped read and the assign differ in method and permission', () => {
    const path = '/api/v1/billing/subscriptions/:ownerType/:ownerId';
    const read = billingRoutes.find((r) => r.fullPath === path && r.method === 'get');
    const assign = billingRoutes.find((r) => r.fullPath === path && r.method === 'post');
    return read?.access.kind === 'permission'
        && assign?.access.kind === 'permission'
        && read.access.permissions[0] === 'billing.plans.read'
        && assign.access.permissions[0] === 'billing.subscriptions.assign';
});

/**
 * `current` is read off the row that SAYS `active`, never inferred from dates.
 *
 * `status` is jovi-mall's vocabulary and this service never writes it, so ranking an open
 * list of values is a guess that changes silently when a fifth value appears upstream. And
 * `expiresAt: null` is the never-expiring free tier rather than "unknown", so ordering by
 * it puts the free tier at whichever end the comparison happens to choose.
 */
t.assert('the owner-scoped read determines `current` from the status, not from a date', () => {
    const controller = readCode(SRC, 'modules', 'billing', 'controllers', 'billing.controller.ts');
    const handler = controller.slice(controller.indexOf('static listSubscriptionsForOwner'));
    const body = handler.slice(0, handler.indexOf('static getSubscription'));
    return body.includes("row.status === 'active'")
        && body.includes("row.status === 'pending_activation'")
        && !body.includes('expiresAt');
});

/**
 * The subscriber rows name owners the way a subscription does — an id, a type, a display
 * name — and carry nothing off the vendor/agency/agent documents that those permissions
 * exist to gate. Contrast `/agencies/:id/agents`, whose rows carry KYC and ban state.
 */
t.assert('the subscriber list does NOT reach for agents.read or vendors.read', () => {
    const route = billingRoutes.find((r) => r.fullPath.endsWith('/subscribers'));
    return route?.access.kind === 'permission'
        && !route.access.permissions.includes('agents.read')
        && !route.access.permissions.includes('vendors.read');
});

t.assert('create and edit hold billing.plans.manage; archive holds its own permission', () => {
    const create = billingRoutes.find((r) => r.method === 'post' && r.fullPath.endsWith('/plans'));
    const edit = billingRoutes.find((r) => r.method === 'patch');
    const archive = billingRoutes.find((r) => r.method === 'delete');
    return create?.access.kind === 'permission' && create.access.permissions[0] === 'billing.plans.manage'
        && edit?.access.kind === 'permission' && edit.access.permissions[0] === 'billing.plans.manage'
        && archive?.access.kind === 'permission' && archive.access.permissions[0] === 'billing.plans.delete';
});

t.assert('the three legacy assign routes are ONE route, keyed on :ownerType', () => {
    const assign = billingRoutes.filter(
        (r) => r.method === 'post' && r.fullPath.includes('/subscriptions/'),
    );
    return assign.length === 1
        && assign[0].fullPath === '/api/v1/billing/subscriptions/:ownerType/:ownerId'
        && assign[0].access.kind === 'permission'
        && assign[0].access.permissions[0] === 'billing.subscriptions.assign';
});

t.assert('billing.plans.delete is flagged destructive, so allInFamily cannot sweep it in', () =>
    isPermissionName('billing.plans.delete') && isSensitive(permissionSpec('billing.plans.delete')));

t.assert('billing.subscriptions.assign is flagged financial — it changes what somebody is billed', () =>
    isSensitive(permissionSpec('billing.subscriptions.assign')));

t.assert('Support holds none of the billing family — not even the read', () => {
    const support = TIER_GRANTS[3] ?? [];
    return !support.some((p) => String(p).startsWith('billing.'));
});

t.assert('Admin holds all four billing permissions', () => {
    const admin = TIER_GRANTS[2] ?? [];
    return ['billing.plans.read', 'billing.plans.manage', 'billing.plans.delete', 'billing.subscriptions.assign']
        .every((p) => admin.includes(p as never));
});

t.assert('six billing.* audit actions exist, all delegated', () => {
    const rows = Object.entries(AUDIT_CATALOG).filter(([name]) => name.startsWith('billing.'));
    return rows.length === 6 && rows.every(([, spec]) => spec.transport === 'delegated');
});

/**
 * The decision this whole section validates. `buildQueryFilter` matches on
 * `target_type`/`target_id` and does NOT consult `related_target_*`, so a single
 * `billing.subscriptions.assign` action targeting `plan` would be invisible on
 * `GET /vendors/:id/activity` — the one feed somebody opens to ask what happened to a
 * vendor's billing.
 */
t.assert('assign is THREE actions, one per owner type, each targeting its own subject', () => {
    const byOwner = [
        ['billing.subscriptions.assign_vendor', 'vendor'],
        ['billing.subscriptions.assign_agency', 'agency'],
        ['billing.subscriptions.assign_agent', 'agent'],
    ] as const;

    return byOwner.every(([action, target]) =>
        isAuditAction(action)
        && auditSpec(action).target === target
        && auditSpec(action).permission === 'billing.subscriptions.assign');
});

t.assert('...and the gateway maps every owner type to one of them', () => {
    const source = readCode(...BILLING_GATEWAY);
    return BILLING_OWNER_TYPES.every((owner) => source.includes(`billing.subscriptions.assign_${owner}`));
});

t.assert('the three plan actions target a plan, which is a platform record', () =>
    ['billing.plans.create', 'billing.plans.update', 'billing.plans.delete']
        .every((action) => auditSpec(action as 'billing.plans.create').target === 'plan')
    && subjectClassOf('plan') === 'platform_record');

t.assert('create and update are two actions, so a feed distinguishes them', () =>
    auditSpec('billing.plans.create').summary !== auditSpec('billing.plans.update').summary);

// `no billing row is left in the legacy endpoint map` stood here. Phase 5 Part D deleted the
// map, so the check would now pass by having nothing to read. The surviving fact — the map is
// gone and nothing reconstructs it — is asserted once in `test-authz.ts` § 9, the suite that
// owns the migration surface. What guards THIS domain is the route-manifest section above.

process.exit(t.finish());
