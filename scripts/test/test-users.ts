/**
 * User management — the rules, with no infrastructure.
 *
 * Everything here is a pure function of code: the query schemas, the Mongo filter the
 * search builds, the catalog wiring that decides who may read a user's history, and the
 * projections that decide what leaves the database. No Mongo, no Redis, no jovi-mall.
 *
 * Three assertions here are the ones worth having:
 *
 *   §2  the search filter composes under `$and`. Two `$or`-shaped clauses merged by
 *       assignment is the exact bug `audit-subject.ts` documents, where a search box
 *       silently widened a reader's scope.
 *   §4  the read projections name their fields. A whitelist is the only thing that stops
 *       `password_hash`, `legal_identity` or `payout_details` arriving on a screen the
 *       day somebody adds a field upstream.
 *   §5  suspension is enforced in jovi-mall on all three auth paths. Without it this
 *       whole phase ships an endpoint that flips a column nobody reads.
 *
 *   npm run test:users
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
    ListUserActivityQuerySchema,
    SearchUsersQuerySchema,
    SuspendUserSchema,
    UpdateUserSchema,
    USER_AUDIT_ACTIONS,
    USER_SORT,
} from '../../src/modules/users/validators/user.validator';
import { buildFilter } from '../../src/modules/users/repositories/user.read.repository';
import { AUDIT_CATALOG, auditSpec, isAuditAction } from '../../src/modules/audit/domain/audit.catalog';
import { subjectClassOf } from '../../src/modules/audit/domain/audit-subject';
import { PERMISSION_CATALOG, permissionSpec } from '../../src/modules/authorization/domain/permission.catalog';
import { TIER_GRANTS } from '../../src/modules/authorization/domain/tier-grants';
import { isSensitive } from '../../src/modules/authorization/domain/permission.types';
import { routeManifest } from '../../src/api/route-manifest';
// Importing the router registers its six routes into the manifest — the same source the
// boot assertion reads, so §6 checks what Express will actually serve.
import '../../src/modules/users/routes/user.routes';

const t = suite('user management');

const SRC = join(__dirname, '..', '..', 'src');
const JOVI = join(__dirname, '..', '..', '..', 'jovi-mall', 'src');

function read(...segments: string[]): string {
    return readFileSync(join(...segments), 'utf8');
}

/**
 * Read a file with its comments removed.
 *
 * Every source scan below must run on code, not prose. These files explain the rule they
 * follow by naming the anti-pattern — `user.read.repository.ts` says "a whitelist rather
 * than `{ password_hash: 0 }`" — and a scan over the raw text reports the explanation as
 * the violation. `test-authz.ts` hit the same thing and answered it the same way.
 */
function readCode(...segments: string[]): string {
    return read(...segments)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
}

/** The parsed shape of a list query, for the filter builder. */
function query(overrides: Record<string, unknown> = {}) {
    return SearchUsersQuerySchema.parse(overrides) as never;
}

// ─────────────────────────────────────────────────────────────────────────────
t.section('1. The list query');

t.assert('paginates by default — page 1, 20 rows', () => {
    const parsed = SearchUsersQuerySchema.parse({});
    return parsed.page === 1 && parsed.limit === 20;
});

t.assert('orders newest-first by default', () => {
    const parsed = SearchUsersQuerySchema.parse({});
    return parsed.sort.field === 'createdAt' && parsed.sort.direction === -1;
});

t.assert('refuses a page size above the platform ceiling', () =>
    !SearchUsersQuerySchema.safeParse({ limit: 101 }).success);

t.assert('refuses a sort field that is not in USER_SORT', () =>
    !SearchUsersQuerySchema.safeParse({ sort: 'password_hash' }).success);

t.assert('every sortable wire name maps to a database path', () =>
    Object.values(USER_SORT).every((path) => typeof path === 'string' && path.length > 0));

t.assert('accepts the four platform roles', () =>
    ['vendor', 'agency', 'agent', 'customer'].every(
        (role) => SearchUsersQuerySchema.safeParse({ role }).success));

t.assert('refuses `admin` as a role filter — no users row can hold it', () =>
    !SearchUsersQuerySchema.safeParse({ role: 'admin' }).success);

t.assert('refuses a status outside active/suspended', () =>
    !SearchUsersQuerySchema.safeParse({ status: 'deleted' }).success);

t.assert('refuses a search term long enough to be a pattern attack', () =>
    !SearchUsersQuerySchema.safeParse({ search: 'x'.repeat(121) }).success);

t.assert('refuses a date range whose end precedes its start', () =>
    !SearchUsersQuerySchema.safeParse({
        from: '2026-08-11T00:00:00.000Z',
        to: '2026-08-01T00:00:00.000Z',
    }).success);

t.assert('refuses a date-ONLY value — an instant needs a zone', () =>
    !SearchUsersQuerySchema.safeParse({ from: '2026-08-11' }).success);

t.assert('refuses a range wider than a year', () =>
    !SearchUsersQuerySchema.safeParse({
        from: '2024-01-01T00:00:00.000Z',
        to: '2026-01-01T00:00:00.000Z',
    }).success);

// ─────────────────────────────────────────────────────────────────────────────
t.section('2. The Mongo filter the search builds');

t.assert('no filters → no constraint at all', () => Object.keys(buildFilter(query())).length === 0);

t.assert('one filter stays flat rather than growing a needless $and', () => {
    const filter = buildFilter(query({ status: 'suspended' })) as Record<string, unknown>;
    return filter.status === 'suspended' && filter.$and === undefined;
});

t.assert('role and status compose', () => {
    const filter = buildFilter(query({ role: 'agent', status: 'active' })) as Record<string, unknown>;
    const clauses = filter.$and as Record<string, unknown>[];
    return clauses.length === 2
        && clauses.some((clause) => clause.roles === 'agent')
        && clauses.some((clause) => clause.status === 'active');
});

/**
 * The load-bearing one. `matchAnyField`-style search returns an `$or`, and the established
 * `Object.assign(filter, ...)` idiom elsewhere in this service would let it overwrite —
 * or be overwritten by — any other `$or`-shaped clause. Under `$and` they coexist.
 */
t.assert('a search NEVER replaces another clause — both survive under $and', () => {
    const filter = buildFilter(query({ status: 'suspended', search: 'ada' })) as Record<string, unknown>;
    const clauses = (filter.$and ?? []) as Record<string, unknown>[];
    return clauses.some((clause) => clause.status === 'suspended')
        && clauses.some((clause) => Array.isArray(clause.$or));
});

t.assert('a plain term searches email and phone, and nothing else', () => {
    const filter = buildFilter(query({ search: 'ada' })) as Record<string, unknown>;
    const branches = filter.$or as Record<string, unknown>[];
    return branches.length === 2
        && branches.some((branch) => 'login_email' in branch)
        && branches.some((branch) => 'login_phone' in branch);
});

t.assert('a 24-hex term ALSO matches the user id — a pasted id must find the person', () => {
    const filter = buildFilter(query({ search: '65f0000000000000000000aa' })) as Record<string, unknown>;
    const branches = filter.$or as Record<string, unknown>[];
    return branches.length === 3 && branches.some((branch) => '_id' in branch);
});

t.assert('regex metacharacters in a term are escaped, not interpreted', () => {
    const filter = buildFilter(query({ search: 'a.b+c' })) as Record<string, unknown>;
    const branches = filter.$or as Record<string, unknown>[];
    const pattern = branches[0].login_email as RegExp;
    return pattern.source.includes('\\.') && pattern.source.includes('\\+');
});

t.assert('the creation range is half-open — $gte / $lt, so consecutive ranges tile', () => {
    const filter = buildFilter(
        query({ from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z' }),
    ) as Record<string, unknown>;
    const range = filter.created_at as Record<string, unknown>;
    return range.$gte instanceof Date && range.$lt instanceof Date;
});

// ─────────────────────────────────────────────────────────────────────────────
t.section('3. The write bodies');

t.assert('an edit must change something', () => !UpdateUserSchema.safeParse({}).success);

t.assert('an absent key means "leave it alone" — not "clear it"', () => {
    const parsed = UpdateUserSchema.parse({ email: 'ada@example.test' });
    return parsed.phone === undefined;
});

t.assert('null clears an identifier', () => UpdateUserSchema.parse({ phone: null }).phone === null);

t.assert('an emptied form input ("") clears it too', () =>
    UpdateUserSchema.parse({ phone: '   ' }).phone === null);

t.assert('the edit body refuses fields that belong to another permission', () =>
    !UpdateUserSchema.safeParse({ email: 'a@b.test', roles: ['admin'] }).success
    && !UpdateUserSchema.safeParse({ email: 'a@b.test', status: 'active' }).success);

t.assert('an email longer than RFC 5321 allows is refused before it reaches the wire', () =>
    !UpdateUserSchema.safeParse({ email: `${'x'.repeat(250)}@example.test` }).success);

t.assert('a suspension requires a reason', () => !SuspendUserSchema.safeParse({}).success);

t.assert('...and a real one, not a keystroke', () =>
    !SuspendUserSchema.safeParse({ reason: 'x' }).success);

t.assert('...trimmed and bounded', () => {
    const parsed = SuspendUserSchema.parse({ reason: '  chargeback fraud  ' });
    return parsed.reason === 'chargeback fraud'
        && !SuspendUserSchema.safeParse({ reason: 'x'.repeat(501) }).success;
});

// ─────────────────────────────────────────────────────────────────────────────
t.section('4. What leaves the database');

const USER_REPO = readCode(SRC, 'modules', 'users', 'repositories', 'user.read.repository.ts');
const ROLE_REPO = readCode(SRC, 'modules', 'users', 'repositories', 'role-profile.read.repository.ts');

t.assert('the user projection is a whitelist, never an exclusion', () =>
    USER_REPO.includes('const USER_PROJECTION') && !USER_REPO.includes('password_hash: 0'));

t.assert('`password_hash` is not named anywhere in the read path', () =>
    !USER_REPO.includes('password_hash'));

/**
 * `delivery_agents` is the richest document on the platform. A projection-free read of it
 * would put an agent's identity documents, payout destination and next-of-kin on a screen
 * that only asked "is this person an agent?".
 */
t.assert('no role projection reaches an agent’s identity, payout or emergency details', () =>
    ['legal_identity', 'payout_details', 'emergency_contact', 'documents', 'national_id']
        .every((field) => !ROLE_REPO.includes(`${field}: 1`)));

t.assert('the agent projection takes `kyc.status` only — never the documents behind it', () =>
    ROLE_REPO.includes("'kyc.status': 1") && !ROLE_REPO.includes('kyc: 1'));

/**
 * ⚠ **NARROWED 2026-08-25 (BR-015). The property is unchanged; the counting was too broad.**
 *
 * This counted `collection: COLLECTIONS.` and `projection: {` across the WHOLE FILE and
 * required both to be exactly 4 — a fair proxy for "every role source names a projection"
 * only while the file contained nothing but the four-row `ROLE_SOURCES` table.
 *
 * It stopped being one when the media library needed batched customer names and
 * `findCustomerNamesByIds` was added here (rather than declaring a SECOND narrow projection
 * of `customers` next to the files module — that collection carries `saved_addresses` and
 * `saved_payment_methods`, so one whitelist per role is the point of this file). That method
 * passes its own `projection: { _id: 1, name: 1 }` to `findBy`, which is *more* explicit than
 * the rule requires — and the count went to 5 and the assertion went red for a change that
 * strengthens the very property it defends.
 *
 * So it now counts **inside the `ROLE_SOURCES` table only**. It still fails the day somebody
 * adds a fifth role without a projection, which is the whole job, and it no longer objects to
 * a per-query projection override elsewhere in the file.
 *
 * A blunter fix — bumping 4 to 5 — was available and is worse: it would have re-pinned a
 * number that means nothing, and the next legitimate method here would break it again.
 */
t.assert('every role source names an explicit projection', () => {
    const start = ROLE_REPO.indexOf('const ROLE_SOURCES');
    if (start === -1) return false;

    // The table literal ends at the `});` that closes `Object.freeze({`.
    const end = ROLE_REPO.indexOf('});', start);
    if (end === -1) return false;

    const table = ROLE_REPO.slice(start, end);
    const sources = table.split('collection: COLLECTIONS.').length - 1;
    const projections = table.split('projection: {').length - 1;

    return sources === 4 && projections === 4;
});

/**
 * The other half, and it is what the file-wide count was really reaching for: no read
 * anywhere in this repository may run without a projection. `PlatformReadRepository` supplies
 * one from its constructor for every query, so the only way to lose it is a `findBy` whose
 * options override it with something wider — and there is no such call.
 */
t.assert('no read here widens the projection back out', () =>
    !ROLE_REPO.includes('projection: {}') && !/projection:\s*undefined/.test(ROLE_REPO));

t.assert('the read repository still holds no delegation client', () =>
    !USER_REPO.includes('platform.client') && !ROLE_REPO.includes('platform.client'));

t.assert('the gateway is the ONLY file in the module that can write', () => {
    const gateway = readCode(SRC, 'modules', 'users', 'gateways', 'user.gateway.ts');
    const controller = readCode(SRC, 'modules', 'users', 'controllers', 'user.controller.ts');
    return gateway.includes('platformRequest') && !controller.includes('platformRequest');
});

// ─────────────────────────────────────────────────────────────────────────────
t.section('5. Suspension is enforced, not merely recorded');

/**
 * The premise of the whole phase. Before it, `users.status` was written by nothing and
 * read by nothing: `requireActiveUser` had zero call sites, `login` never looked, and the
 * refresh rotation never looked. An admin endpoint flipping that column would have been a
 * button that did nothing at all.
 *
 * Asserted by reading jovi-mall's source, because that is where the property lives and
 * this service cannot prove it any other way without both processes running.
 */
const JOVI_AUTH_MIDDLEWARE = readCode(JOVI, 'api', 'middlewares', 'auth.middleware.ts');
const JOVI_AUTH_SERVICE = readCode(JOVI, 'modules', 'auth', 'auth.service.ts');

t.assert('every authenticated request refuses a suspended account', () =>
    JOVI_AUTH_MIDDLEWARE.includes("user.status !== 'active'")
    && JOVI_AUTH_MIDDLEWARE.includes('AUTH_ACCOUNT_SUSPENDED'));

t.assert('login refuses one', () => {
    const login = JOVI_AUTH_SERVICE.slice(JOVI_AUTH_SERVICE.indexOf('async login('));
    return login.slice(0, 2_000).includes('AUTH_ACCOUNT_SUSPENDED');
});

t.assert('a refresh cannot outlive a suspension', () => {
    const rotate = JOVI_AUTH_SERVICE.slice(JOVI_AUTH_SERVICE.indexOf('async rotateRefreshToken('));
    return rotate.slice(0, 2_000).includes('AUTH_ACCOUNT_SUSPENDED');
});

t.assert('the status write is a compare-and-set, so two administrators cannot race it', () => {
    const repo = readCode(JOVI, 'modules', 'users', 'user.repository.ts');
    return repo.includes('applyStatusChangeIfCurrent') && repo.includes('status: fromStatus');
});

t.assert('a cleared identifier is $unset, not set to null — the unique index is sparse', () => {
    const repo = readCode(JOVI, 'modules', 'users', 'user.repository.ts');
    return repo.includes('$unset');
});

t.assert('an account can never be left with no way to sign in', () => {
    const service = readCode(JOVI, 'modules', 'users', 'admin-user.service.ts');
    return service.includes('USER_CONTACT_REQUIRED');
});

// ─────────────────────────────────────────────────────────────────────────────
t.section('6. Routes, permissions and the audit catalog');

const USER_ROUTES = routeManifest().filter((route) => route.fullPath.startsWith('/api/v1/users'));

// Six at the user-management phase; eight since credential recovery landed.
t.assert('eight routes are declared', () => USER_ROUTES.length === 8);

t.assert('every one declares a permission — none is public or self-service', () =>
    USER_ROUTES.every((route) => route.access.kind === 'permission'));

t.assert('the reads need `users.read`', () =>
    USER_ROUTES.filter((route) => route.method === 'get')
        .every((route) => route.access.kind === 'permission'
            && route.access.permissions.includes('users.read')));

t.assert('the activity feed needs the audit permission as well, in `all` mode', () => {
    const activity = USER_ROUTES.find((route) => route.fullPath.endsWith('/activity'));
    return activity?.access.kind === 'permission'
        && activity.access.mode === 'all'
        && activity.access.permissions.includes('users.read')
        && activity.access.permissions.includes('audit.read');
});

t.assert('the contact edit is behind its own permission, not the read', () => {
    const patch = USER_ROUTES.find((route) => route.method === 'patch');
    return patch?.access.kind === 'permission'
        && patch.access.permissions.length === 1
        && patch.access.permissions[0] === 'users.update';
});

t.assert('suspend and restore share one permission and are POST sub-resources', () => {
    const actions = USER_ROUTES.filter(
        (route) => route.method === 'post' && /\/(suspend|restore)$/.test(route.fullPath),
    );
    return actions.length === 2
        && actions.every((route) => route.access.kind === 'permission'
            && route.access.permissions[0] === 'users.suspend');
});

/**
 * The two credential routes do NOT share a permission, and that is the point of the
 * assertion rather than an incidental fact.
 *
 * A reset link grants nothing until the person chooses a password; a sign-in link IS a
 * session. Folding them under one permission would mean a tier granted "help people back
 * into their account" silently also got "sign in as a customer".
 */
t.assert('the two credential sends hold DIFFERENT permissions', () => {
    const reset = USER_ROUTES.find((route) => route.fullPath.endsWith('/password-reset-link'));
    const login = USER_ROUTES.find((route) => route.fullPath.endsWith('/login-link'));
    return reset?.access.kind === 'permission'
        && login?.access.kind === 'permission'
        && reset.access.permissions[0] === 'users.password.reset'
        && login.access.permissions[0] === 'users.login_link.send';
});

/**
 * ⚠ The single most dangerous grant this module could make.
 *
 * Support answers delivery tickets. A support agent who can mail a working reset link to
 * any vendor can take over any shop, and the audit row would look like routine help.
 * `assertGrantTableValid()` does NOT catch this — neither permission carries a `financial`
 * or `destructive` flag — so this assertion is the guard.
 */
t.assert('Support holds NEITHER credential permission', () => {
    const support = new Set(TIER_GRANTS[3]);
    return !support.has('users.password.reset') && !support.has('users.login_link.send');
});

t.assert('...and Admin holds both, since account recovery is their job', () => {
    const admin = new Set(TIER_GRANTS[2]);
    return admin.has('users.password.reset') && admin.has('users.login_link.send');
});

t.assert('no route uses `users.roles.manage` — role editing is deliberately unbuilt', () =>
    USER_ROUTES.every((route) => route.access.kind !== 'permission'
        || !route.access.permissions.includes('users.roles.manage')));

t.assert('Support reads users but writes none of them', () => {
    const support = new Set(TIER_GRANTS[3]);
    return support.has('users.read')
        && !support.has('users.update')
        && !support.has('users.suspend');
});

t.assert('Admin holds both writes; only Developer may re-grant a platform role', () => {
    const admin = new Set(TIER_GRANTS[2]);
    return admin.has('users.update')
        && admin.has('users.suspend')
        && !admin.has('users.roles.manage')
        && new Set(TIER_GRANTS[1]).has('users.roles.manage');
});

t.assert('`users.update` is not flagged sensitive — it is routine support work', () =>
    !isSensitive(permissionSpec('users.update')));

t.assert('...unlike role management, which is', () =>
    isSensitive(permissionSpec('users.roles.manage')));

// Three at the user-management phase; five since the two credential sends were catalogued.
t.assert('five user actions are catalogued, and no read among them', () =>
    USER_AUDIT_ACTIONS.length === 5
    && USER_AUDIT_ACTIONS.every((action) => isAuditAction(action)));

/**
 * The audit row for a credential send records the channel and the reason. It must never
 * record the token, the link or the unmasked destination — the trail is read by more
 * people than performed the action, and a link in it is a live credential in a feed.
 */
t.assert('the credential gateway sends no destination and stores no token', () => {
    const gateway = readCode(SRC, 'modules', 'users', 'gateways', 'user.gateway.ts');
    const body = gateway.slice(gateway.indexOf('sendPasswordResetLink'));
    return body.includes('body: { channel }')
        && !body.includes('destination:')
        && !body.includes('token');
});

t.assert('every one targets a `user` and is delegated', () =>
    USER_AUDIT_ACTIONS.every((action) => {
        const spec = auditSpec(action);
        return spec.target === 'user' && spec.transport === 'delegated';
    }));

t.assert('every one names a permission that exists', () =>
    USER_AUDIT_ACTIONS.every((action) => {
        const permission = auditSpec(action).permission;
        return permission !== null && permission in PERMISSION_CATALOG;
    }));

t.assert('reinstatement is its OWN action — it erases the row’s only other record', () =>
    'users.reinstate' in AUDIT_CATALOG
    && auditSpec('users.reinstate').permission === 'users.suspend');

/**
 * The reason a Support administrator can read a user's history at all: `user` classifies
 * as a platform actor, not as this service's internal machinery. Flip this and the feed
 * silently empties for tier 3.
 */
t.assert('a user row is a platform actor, so Support may read its history', () =>
    subjectClassOf('user') === 'platform_actor');

t.assert('the activity filter is derived from the catalog, so it cannot drift', () => {
    const validator = readCode(SRC, 'modules', 'users', 'validators', 'user.validator.ts');
    return validator.includes('AUDIT_ACTION_NAMES.filter');
});

t.assert('the activity feed refuses an action from another family', () =>
    !ListUserActivityQuerySchema.safeParse({ action: 'cod.remittances.confirm' }).success);

t.assert('...and accepts every user action', () =>
    USER_AUDIT_ACTIONS.every((action) => ListUserActivityQuerySchema.safeParse({ action }).success));

process.exit(t.finish());
