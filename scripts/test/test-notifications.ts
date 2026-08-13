/**
 * The administrator inbox — the rules, with no infrastructure.
 *
 * Everything here is a pure function of code: the vocabulary, the source registry, the
 * coverage assertion, the query schemas, the Mongo filters, and the route declarations. No
 * Mongo, no Redis, no jovi-mall.
 *
 * Four assertions here are the ones worth having:
 *
 *   §2  the coverage assertion refuses a type nothing produces. This is the whole of
 *       "do not invent notification events" as a mechanism rather than a promise — and it
 *       is the third time this platform has needed exactly this check (jovi-mall's eight
 *       undelivered `agent_contract.*` situations; this service's unproduced `approvals.*`
 *       audit actions, found in Phase 12).
 *   §4  the visibility filter composes under `$and`. It contributes a top-level `$or`, and
 *       a merged second one would silently replace the VISIBILITY clause — the exact bug
 *       `audit-subject.ts` documents, on the one clause where it leaks.
 *   §5  the cursor's `_id` tiebreaker is parsed back to an ObjectId. A string compared
 *       against ObjectId `_id`s matches every row, and the symptom is invisible.
 *   §7  the DTO names its fields, and `required_permission` is not one of them.
 *
 *   npm run test:notifications
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { ObjectId } from 'mongodb';
import { suite, throws } from './_assert';

// Env must be set before importing anything that reads config at module load.
process.env.NODE_ENV = 'test';
process.env.MONGO_URI_PLATFORM = 'mongodb://localhost:27017/jovi_mall_test';
process.env.MONGO_URI_ADMIN = 'mongodb://localhost:27017/wi_admin_test';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.ADMIN_JWT_SECRET = 'test-access-secret-value-32-chars-long';
process.env.ADMIN_JWT_REFRESH_SECRET = 'test-refresh-secret-value-32-chars-long';
process.env.ADMIN_DASHBOARD_ORIGINS = 'http://localhost:5173';

import {
    NOTIFICATION_SEVERITIES,
    NOTIFICATION_STATUS_FILTERS,
    NOTIFICATION_TYPES,
} from '../../src/modules/notifications/domain/notification.types';
import {
    NOTIFICATION_CATALOG,
    NOTIFICATION_CATALOG_ENTRIES,
    isEnabledByDefault,
    notificationSpec,
} from '../../src/modules/notifications/domain/notification.catalog';
import { NOTIFICATION_SOURCES, notificationSource } from '../../src/modules/notifications/domain/source.registry';
import {
    assertNotificationCoverageComplete,
    assertSourcePermissionsExist,
    findCoverageProblems,
} from '../../src/modules/notifications/domain/notification.coverage';
import {
    ListNotificationsQuerySchema,
    MarkAllReadBodySchema,
    NOTIFICATION_SORT,
    UpdatePreferencesBodySchema,
} from '../../src/modules/notifications/validators/notification.validator';
import { buildNotificationFilter } from '../../src/modules/notifications/repositories/notification.repository';
import { toComparableId, withCursor } from '../../src/modules/notifications/repositories/notification-source.read.repository';
import { PERMISSION_CATALOG } from '../../src/modules/authorization/domain/permission.catalog';
import { TIER_GRANTS } from '../../src/modules/authorization/domain/tier-grants';
import { grantedTo } from '../../src/modules/authorization/domain/permission.resolver';
import { AUDIT_CATALOG, auditSpec, isAuditAction } from '../../src/modules/audit/domain/audit.catalog';
import { AUDIT_TARGET_TYPES } from '../../src/modules/audit/domain/audit.types';
import { PLATFORM_COLLECTIONS } from '../../src/infra/platform/platform-collections';
import { NO_AUDIT_ROUTE_ALLOWLIST, routeManifest } from '../../src/api/route-manifest';
// Importing the router registers its routes into the manifest — the same source the boot
// assertion reads, so §6 checks what Express will actually serve.
import '../../src/modules/notifications/routes/notification.routes';

const t = suite('administrator notifications');

const SRC = join(__dirname, '..', '..', 'src');
const MODULE = join(SRC, 'modules', 'notifications');

function read(...segments: string[]): string {
    return readFileSync(join(...segments), 'utf8');
}

/**
 * Read a file with its comments removed.
 *
 * Every source scan below must run on code, not prose. These files explain the rule they
 * follow by naming the anti-pattern — `notification.writer.ts` says "a plain upsert with
 * `$set` would quietly resurrect" — and a scan over the raw text reports the explanation
 * as the violation.
 */
function readCode(...segments: string[]): string {
    return read(...segments)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
}

const ADMIN_ID = '65f0000000000000000000a1';

// ─────────────────────────────────────────────────────────────────────────────
t.section('1. The vocabulary — one array, feeding everything');
// ─────────────────────────────────────────────────────────────────────────────

t.assert('there are notification types at all — a vacuous suite would be worse', () =>
    NOTIFICATION_TYPES.length >= 8);

t.assert('every type has a catalog entry', () =>
    NOTIFICATION_TYPES.every((type) => Boolean(NOTIFICATION_CATALOG[type])));

t.assert('the catalog has no entry for a type that does not exist', () =>
    Object.keys(NOTIFICATION_CATALOG).every((type) =>
        (NOTIFICATION_TYPES as readonly string[]).includes(type)));

t.assert('every catalog severity is a declared severity', () =>
    NOTIFICATION_CATALOG_ENTRIES.every((entry) =>
        (NOTIFICATION_SEVERITIES as readonly string[]).includes(entry.severity)));

t.assert('every type has a non-empty summary — the preferences screen renders it', () =>
    NOTIFICATION_CATALOG_ENTRIES.every((entry) => entry.summary.trim().length > 0));

/**
 * THE regression test for the defect ADR-005 D-17 records. jovi-mall kept two
 * hand-maintained copies of its agent notification types; eight values existed in the union
 * and not in the Mongoose enum, so every one of those notifications threw on write.
 *
 * The model must import the array, never restate it.
 */
t.assert('the model feeds its enum from NOTIFICATION_TYPES, not a second copy', () => {
    const model = readCode(MODULE, 'models', 'admin-notification.model.ts');
    return model.includes('enum: NOTIFICATION_TYPES')
        && model.includes('enum: NOTIFICATION_SEVERITIES');
});

t.assert('the validator feeds its enums from the same arrays', () => {
    const validator = readCode(MODULE, 'validators', 'notification.validator.ts');
    return validator.includes('z.enum(NOTIFICATION_TYPES)')
        && validator.includes('z.enum(NOTIFICATION_SEVERITIES)')
        && validator.includes('z.enum(NOTIFICATION_STATUS_FILTERS)');
});

t.assert('no file restates a notification type as a string literal array', () => {
    const files = ['models/admin-notification.model.ts', 'validators/notification.validator.ts'];
    return files.every((file) => {
        const code = readCode(MODULE, ...file.split('/'));
        // A literal `'cod.discrepancy.opened'` outside the types file means a second copy.
        return !code.includes("'cod.discrepancy.opened'");
    });
});

// ─────────────────────────────────────────────────────────────────────────────
t.section('2. Coverage — a type nobody produces stops the service booting');
// ─────────────────────────────────────────────────────────────────────────────

t.assert('the shipped registry passes the coverage assertion', () =>
    !throws(() => assertNotificationCoverageComplete()));

t.assert('the shipped registry passes the permission assertion', () =>
    !throws(() => assertSourcePermissionsExist()));

t.assert('every declared type has exactly one producer', () => {
    const counts = new Map<string, number>();
    for (const source of NOTIFICATION_SOURCES) {
        for (const type of source.produces) counts.set(type, (counts.get(type) ?? 0) + 1);
    }
    return NOTIFICATION_TYPES.every((type) => counts.get(type) === 1);
});

/**
 * The assertions this phase exists to have. Adding a type to `NOTIFICATION_TYPES` without a
 * source must be a BOOT failure, not a notification nobody ever receives.
 *
 * Driven through the pure core, so these can hand it a registry the service does not ship.
 * Asserting only that the real registry passes would be a test that cannot fail for the
 * reason it exists — it would stay green if the check returned `[]` unconditionally.
 */
t.assert('a declared type produced by NOTHING is caught', () => {
    const problems = findCoverageProblems(
        [...NOTIFICATION_TYPES, 'cod.discrepancy.invented'],
        NOTIFICATION_SOURCES,
    );
    return problems.some((problem) => problem.includes('produced by nothing'));
});

t.assert('a type produced TWICE is caught — one situation, two deliveries', () => {
    const duplicated = [
        ...NOTIFICATION_SOURCES,
        { id: 'a_second_producer', produces: ['cod.discrepancy.opened'] },
    ];
    return findCoverageProblems(NOTIFICATION_TYPES, duplicated)
        .some((problem) => problem.includes('produced by 2 sources'));
});

t.assert('a source producing a type that does not exist is caught', () => {
    const bogus = [...NOTIFICATION_SOURCES, { id: 'bogus', produces: ['not.a.real.type'] }];
    return findCoverageProblems(NOTIFICATION_TYPES, bogus)
        .some((problem) => problem.includes('not in NOTIFICATION_TYPES'));
});

t.assert('a source declaring no type at all is caught', () => {
    const empty = [...NOTIFICATION_SOURCES, { id: 'silent', produces: [] }];
    return findCoverageProblems(NOTIFICATION_TYPES, empty)
        .some((problem) => problem.includes('declares no notification type'));
});

t.assert('a duplicate source id is caught — two sources would share one watermark', () => {
    const clashing = [
        ...NOTIFICATION_SOURCES,
        { id: NOTIFICATION_SOURCES[0].id, produces: NOTIFICATION_SOURCES[0].produces },
    ];
    return findCoverageProblems(NOTIFICATION_TYPES, clashing)
        .some((problem) => problem.includes('duplicate source id'));
});

t.assert('the real registry produces no problems at all', () =>
    findCoverageProblems(NOTIFICATION_TYPES, NOTIFICATION_SOURCES).length === 0);

t.assert('source ids are unique — two sources sharing a watermark would leapfrog', () =>
    new Set(NOTIFICATION_SOURCES.map((source) => source.id)).size === NOTIFICATION_SOURCES.length);

t.assert('every source declares at least one type', () =>
    NOTIFICATION_SOURCES.every((source) => source.produces.length > 0));

t.assert('every source names a watermark field', () =>
    NOTIFICATION_SOURCES.every((source) => source.watermarkField.trim().length > 0));

/**
 * A dotted watermark path is a real case — `order_disputed` uses
 * `dispute_hold.disputed_at`, because that is the key of the partial index its filter
 * matches. Mongo accepts the dotted form in the query and returns a NESTED document, so a
 * projector reading `row[field]` gets `undefined`, never advances its cursor, and re-reads
 * the same batch forever. Idempotency hides it completely: no duplicates, no errors.
 */
t.assert('a source that watermarks on a dotted path projects the nested field', () => {
    const registry = read(MODULE, 'domain', 'source.registry.ts');
    const dotted = NOTIFICATION_SOURCES.filter((source) => source.watermarkField.includes('.'));
    return dotted.every((source) => registry.includes(`'${source.watermarkField}': 1`));
});

t.assert('the projector resolves dotted watermark paths rather than indexing directly', () => {
    const projector = readCode(MODULE, 'domain', 'notification.projector.ts');
    return projector.includes('valueAt(advanceTo, source.watermarkField)')
        && !projector.includes('advanceTo[source.watermarkField]');
});

t.assert('notificationSource() finds every registered id', () =>
    NOTIFICATION_SOURCES.every((source) => notificationSource(source.id) === source));

// ─────────────────────────────────────────────────────────────────────────────
t.section('3. Sources — gated on real permissions, over readable collections');
// ─────────────────────────────────────────────────────────────────────────────

t.assert('every gated source names a catalogued permission', () =>
    NOTIFICATION_SOURCES.every((source) => !source.gates || Boolean(PERMISSION_CATALOG[source.gates])));

t.assert('every gated permission is granted to some tier — else it reaches nobody', () => {
    const granted = new Set(Object.values(TIER_GRANTS).flat());
    return NOTIFICATION_SOURCES.every((source) => !source.gates || granted.has(source.gates));
});

/**
 * A source may only read a collection ADR-004 already decided this service may touch.
 * Widening `platform-collections.ts` is a data-access decision, not a notification one, and
 * it must not arrive smuggled in beside a `title` string.
 */
t.assert('every platform source reads a collection declared in platform-collections', () => {
    const declared = new Set(Object.keys(PLATFORM_COLLECTIONS));
    const adminOwned = ['admin_approval_requests', 'admin_audit_exports'];
    return NOTIFICATION_SOURCES.every((source) =>
        declared.has(source.collection) || adminOwned.includes(source.collection));
});

t.assert('no source reads a collection this service may WRITE to the platform', () =>
    NOTIFICATION_SOURCES.every((source) => {
        const spec = (PLATFORM_COLLECTIONS as Record<string, { writes?: string }>)[source.collection];
        return !spec || spec.writes !== 'direct';
    }));

/** The four `PHASE-0:307` named. This phase is not finished without them. */
t.assert('the four alerts PHASE-0 promised are all produced', () => {
    const produced = new Set(NOTIFICATION_SOURCES.flatMap((source) => [...source.produces]));
    return produced.has('orders.dispute.opened')
        && produced.has('cod.discrepancy.opened')
        && produced.has('money.payout.requested')
        && produced.has('system.tracking_dispatch.failed');
});

t.assert('the payout source does not project payout_method_snapshot', () => {
    const registry = read(MODULE, 'domain', 'source.registry.ts');
    return !registry.includes('payout_method_snapshot: 1');
});

t.assert('every source target type is a declared audit target type', () => {
    const registry = readCode(MODULE, 'domain', 'source.registry.ts');
    const used = [...registry.matchAll(/type:\s*'([a-z_]+)'\s*,\s*id:/g)].map((match) => match[1]);
    return used.length > 0
        && used.every((type) => (AUDIT_TARGET_TYPES as readonly string[]).includes(type));
});

// ─────────────────────────────────────────────────────────────────────────────
t.section('4. The list query and its filter');
// ─────────────────────────────────────────────────────────────────────────────

t.assert('paginates by default — page 1, 20 rows', () => {
    const parsed = ListNotificationsQuerySchema.parse({});
    return parsed.page === 1 && parsed.limit === 20;
});

t.assert('defaults to unread — the question an inbox is opened to ask', () =>
    ListNotificationsQuerySchema.parse({}).status === 'unread');

t.assert('defaults to newest-first by when it HAPPENED, not when we noticed', () =>
    ListNotificationsQuerySchema.parse({}).sort.field === 'occurredAt');

t.assert('refuses a sort field outside NOTIFICATION_SORT', () =>
    !ListNotificationsQuerySchema.safeParse({ sort: 'required_permission' }).success);

t.assert('every sortable wire name maps to a database path', () =>
    Object.entries(NOTIFICATION_SORT).every(([, path]) => typeof path === 'string' && path.length > 0));

t.assert('refuses a limit over the global maximum', () =>
    !ListNotificationsQuerySchema.safeParse({ limit: 101 }).success);

t.assert('refuses a source id no source produces', () =>
    !ListNotificationsQuerySchema.safeParse({ source: 'not_a_source' }).success);

t.assert('accepts every real source id', () =>
    NOTIFICATION_SOURCES.every((source) =>
        ListNotificationsQuerySchema.safeParse({ source: source.id }).success));

/**
 * §4's headline. `visibleTo` contributes a top-level `$or`; merging a second one by
 * assignment would replace it, and the clause it replaces is the one that decides who sees
 * what. Composing under `$and` is what makes that impossible rather than unlikely.
 */
t.assert('the filter composes under $and and never merges two $or clauses', () => {
    const filter = buildNotificationFilter(ADMIN_ID, 1, { status: 'unread', type: 'cod.discrepancy.opened' });
    return Array.isArray(filter.$and) && filter.$and.length >= 2 && !('$or' in filter);
});

t.assert('the visibility clause is always present, whatever the query', () => {
    const cases = [{}, { status: 'all' as const }, { status: 'archived' as const }, { severity: 'info' as const }];
    return cases.every((query) => {
        const filter = buildNotificationFilter(ADMIN_ID, 3, query);
        const clauses = filter.$and as Record<string, unknown>[];
        return clauses.some((clause) => 'admin_id' in clause && '$or' in clause);
    });
});

t.assert('the visibility clause admits only permissions the tier actually holds', () => {
    const filter = buildNotificationFilter(ADMIN_ID, 3, {});
    const clauses = filter.$and as Record<string, { $in?: string[] }[]>[];
    const visibility = clauses.find((clause) => 'admin_id' in clause) as unknown as {
        $or: { required_permission: { $in?: string[] } | null }[];
    };
    const allowed = visibility.$or[1].required_permission?.$in ?? [];
    return allowed.length === grantedTo(3).size
        && allowed.every((name) => grantedTo(3).has(name as never));
});

t.assert('a tier-3 admin cannot see a permission only tier 1 holds', () => {
    const filter = buildNotificationFilter(ADMIN_ID, 3, {});
    const clauses = filter.$and as Record<string, unknown>[];
    const visibility = clauses.find((clause) => 'admin_id' in clause) as unknown as {
        $or: { required_permission: { $in?: string[] } | null }[];
    };
    const allowed = visibility.$or[1].required_permission?.$in ?? [];
    return !allowed.includes('developer_tools.outbox.replay');
});

t.assert('unread excludes archived — an archived row has left the inbox', () => {
    const clauses = buildNotificationFilter(ADMIN_ID, 1, { status: 'unread' }).$and as Record<string, unknown>[];
    return clauses.some((clause) => 'read_at' in clause && 'archived_at' in clause);
});

t.assert('"all" still excludes archived; only ?status=archived opens the drawer', () => {
    const all = buildNotificationFilter(ADMIN_ID, 1, { status: 'all' }).$and as Record<string, unknown>[];
    const archived = buildNotificationFilter(ADMIN_ID, 1, { status: 'archived' }).$and as Record<string, unknown>[];
    return JSON.stringify(all).includes('"$exists":false')
        && JSON.stringify(archived).includes('"$exists":true');
});

t.assert('the date range is half-open [from, to) so ranges tile without overlap', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    const to = new Date('2026-02-01T00:00:00Z');
    const clauses = buildNotificationFilter(ADMIN_ID, 1, { from, to }).$and as Record<string, unknown>[];
    const range = clauses.find((clause) => 'occurred_at' in clause) as { occurred_at: Record<string, Date> };
    return range.occurred_at.$gte === from && range.occurred_at.$lt === to;
});

t.assert('every status filter is handled — none falls through to no clause', () =>
    NOTIFICATION_STATUS_FILTERS.every((status) => {
        const clauses = buildNotificationFilter(ADMIN_ID, 1, { status }).$and as unknown[];
        return clauses.length >= 2;
    }));

// ─────────────────────────────────────────────────────────────────────────────
t.section('5. The projector cursor');
// ─────────────────────────────────────────────────────────────────────────────

t.assert('no cursor means no cursor clause — a first tick reads the filter alone', () => {
    const filter = withCursor({ status: 'open' }, 'opened_at', null);
    return JSON.stringify(filter) === JSON.stringify({ status: 'open' });
});

t.assert('a cursor composes under $and, never merging into the source filter', () => {
    const filter = withCursor(
        { $or: [{ a: 1 }, { b: 2 }] },
        'updated_at',
        { at: new Date('2026-01-01'), id: '65f0000000000000000000a1' },
    ) as { $and?: unknown[] };
    return Array.isArray(filter.$and) && filter.$and.length === 2;
});

t.assert('the cursor is a lexicographic (at, _id) pair, not a bare timestamp', () => {
    const filter = withCursor({}, 'opened_at', {
        at: new Date('2026-01-01'),
        id: '65f0000000000000000000a1',
    }) as { $and: { $or?: unknown[] }[] };
    const cursor = filter.$and[1];
    return Array.isArray(cursor.$or) && cursor.$or.length === 2;
});

/**
 * §5's headline. BSON compares across types by TYPE ORDER before value, and String sorts
 * below ObjectId. A raw string tiebreaker therefore matches every row rather than the ones
 * after the cursor — and the symptom is invisible, because idempotency absorbs the extra
 * rows and the only trace is a sweep that re-reads a millisecond forever.
 */
t.assert('an ObjectId-shaped cursor id is parsed back to an ObjectId', () =>
    toComparableId('65f0000000000000000000a1') instanceof ObjectId);

t.assert('a non-ObjectId cursor id stays a string rather than throwing', () =>
    toComparableId('some-composite-key') === 'some-composite-key');

t.assert('a 24-char non-hex id is not mistaken for an ObjectId', () =>
    typeof toComparableId('zzzzzzzzzzzzzzzzzzzzzzzz') === 'string');

t.assert('the cursor clause carries the parsed id, not the raw string', () => {
    const filter = withCursor({}, 'opened_at', {
        at: new Date('2026-01-01'),
        id: '65f0000000000000000000a1',
    }) as { $and: { $or: { _id?: { $gt: unknown } }[] }[] };
    return filter.$and[1].$or[1]._id?.$gt instanceof ObjectId;
});

// ─────────────────────────────────────────────────────────────────────────────
t.section('6. Routes, permissions and audit declarations');
// ─────────────────────────────────────────────────────────────────────────────

const notificationRoutes = routeManifest().filter((route) => route.fullPath.includes('/notifications'));

t.assert('the router registered its routes into the manifest', () =>
    notificationRoutes.length >= 9);

t.assert('every notification route declares an access kind', () =>
    notificationRoutes.every((route) => Boolean(route.access?.kind)));

t.assert('no notification route is public', () =>
    notificationRoutes.every((route) => route.access.kind !== 'public'));

t.assert('the inbox routes require notifications.read', () =>
    notificationRoutes
        .filter((route) => !route.fullPath.includes('/preferences'))
        .every((route) =>
            route.access.kind === 'permission'
            && route.access.permissions.includes('notifications.read')));

t.assert('the preference routes are selfService — a tier-3 admin configures their own', () =>
    notificationRoutes
        .filter((route) => route.fullPath.includes('/preferences'))
        .every((route) => route.access.kind === 'self'));

/**
 * Express resolves by registration order, so a literal path declared after `/:notificationId`
 * is swallowed as an id — and `idParam` then answers a well-formed request with a validation
 * error naming a parameter the caller never sent.
 */
t.assert('every literal path is declared before the parameterised ones', () => {
    const paths = notificationRoutes.map((route) => route.fullPath);
    const firstParam = paths.findIndex((path) => path.includes(':notificationId'));
    if (firstParam === -1) return false;
    return paths.slice(0, firstParam).every((path) => !path.includes(':'));
});

t.assert('every mutating notification route carries an audit declaration', () =>
    notificationRoutes
        .filter((route) => route.method !== 'get')
        .every((route) => route.audit !== null && route.audit !== undefined));

t.assert('the five inbox-hygiene writes are allowlisted, with a reason', () =>
    notificationRoutes
        .filter((route) => route.method !== 'get' && (route.audit as { kind: string }).kind === 'none')
        .every((route) => {
            const label = `${route.method.toUpperCase()} ${route.fullPath}`;
            const audit = route.audit as { kind: string; reason: string };
            return NO_AUDIT_ROUTE_ALLOWLIST.has(label) && audit.reason.trim().length > 0;
        }));

t.assert('the preference write records a catalogued action', () => {
    const route = notificationRoutes.find(
        (candidate) => candidate.method === 'patch' && candidate.fullPath.includes('/preferences'),
    );
    const audit = route?.audit as { kind: string; actions: string[] } | undefined;
    return audit?.kind === 'records'
        && audit.actions.length === 1
        && isAuditAction(audit.actions[0]);
});

t.assert('notifications.preferences.update_self is catalogued with a null permission', () => {
    const spec = auditSpec('notifications.preferences.update_self');
    return spec.permission === null
        && spec.target === 'administrator'
        && spec.transport === 'wi_admin_txn';
});

t.assert('the audit action sits in the notifications family, matching the catalog rule', () =>
    Object.keys(AUDIT_CATALOG)
        .filter((action) => action.startsWith('notifications.'))
        .every((action) => action.split('.')[0] === 'notifications'));

t.assert('there is no route that creates a notification', () =>
    !notificationRoutes.some((route) =>
        route.method === 'post' && /\/notifications\/?$/.test(route.fullPath)));

t.assert('no route file registers a route directly on the router', () => {
    const routes = readCode(MODULE, 'routes', 'notification.routes.ts');
    return !/router\.(get|post|put|patch|delete)\(/.test(routes);
});

// ─────────────────────────────────────────────────────────────────────────────
t.section('7. Bodies, preferences and the read model');
// ─────────────────────────────────────────────────────────────────────────────

t.assert('mark-all-read accepts the same filters the list does', () =>
    MarkAllReadBodySchema.safeParse({ type: 'money.payout.requested', severity: 'warning' }).success);

t.assert('mark-all-read refuses an unknown field — .strict()', () =>
    !MarkAllReadBodySchema.safeParse({ everything: true }).success);

t.assert('mark-all-read accepts a `before` bound so it cannot swallow the unseen', () =>
    MarkAllReadBodySchema.safeParse({ before: '2026-01-01T00:00:00Z' }).success);

t.assert('a preference override accepts true, false and null', () =>
    UpdatePreferencesBodySchema.safeParse({
        overrides: { 'cod.discrepancy.opened': false, 'money.payout.requested': null },
    }).success);

t.assert('a preference override refuses a type that does not exist', () =>
    !UpdatePreferencesBodySchema.safeParse({ overrides: { 'not.a.type': true } }).success);

t.assert('every type ships enabled by default — nothing is silently off', () =>
    NOTIFICATION_TYPES.every((type) => isEnabledByDefault(type)));

t.assert('notificationSpec is total over the type list', () =>
    NOTIFICATION_TYPES.every((type) => Boolean(notificationSpec(type).summary)));

/**
 * §7's headline. `required_permission` describes the authorization model and
 * `source_row_id` invites a client to construct platform URLs; neither belongs on the wire.
 */
t.assert('the DTO maps named fields and never spreads the document', () => {
    const controller = readCode(MODULE, 'controllers', 'notification.controller.ts');
    return !controller.includes('...notification');
});

t.assert('the DTO does not leak required_permission or source_row_id', () => {
    const controller = readCode(MODULE, 'controllers', 'notification.controller.ts');
    const dto = controller.slice(
        controller.indexOf('function toNotificationDto'),
        controller.indexOf('export class NotificationController'),
    );
    return !dto.includes('required_permission') && !dto.includes('source_row_id');
});

// ─────────────────────────────────────────────────────────────────────────────
t.section('8. The design rules, asserted against the code');
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The idempotency guarantee is the unique index, and nothing else. If this index is ever
 * dropped or made non-unique, the projector becomes a duplicate generator on every tick.
 */
t.assert('the model declares a UNIQUE index on { source_key, admin_id }', () => {
    const model = read(MODULE, 'models', 'admin-notification.model.ts');
    return /index\(\s*\{\s*source_key:\s*1,\s*admin_id:\s*1\s*\}\s*,\s*\{\s*unique:\s*true\s*\}/.test(model);
});

t.assert('the TTL is partial on archived_at, so an unarchived row can never be purged', () => {
    const model = read(MODULE, 'models', 'admin-notification.model.ts');
    return model.includes('expireAfterSeconds: 0')
        && model.includes("partialFilterExpression: { archived_at: { $type: 'date' } }");
});

t.assert('archived_at and purge_after are declared WITHOUT a default', () => {
    const model = readCode(MODULE, 'models', 'admin-notification.model.ts');
    return /archived_at:\s*\{\s*type:\s*Date\s*\}/.test(model)
        && /purge_after:\s*\{\s*type:\s*Date\s*\}/.test(model);
});

t.assert('the writer uses $setOnInsert so re-delivery cannot resurrect a read row', () => {
    const writer = readCode(MODULE, 'domain', 'notification.writer.ts');
    return writer.includes('$setOnInsert') && !writer.includes('$set:');
});

t.assert('the models register on adminConnection, never the global mongoose', () =>
    ['admin-notification.model.ts', 'notification-preference.model.ts', 'notification-watermark.model.ts']
        .every((file) => {
            const code = readCode(MODULE, 'models', file);
            return code.includes('adminConnection().model') && !code.includes('mongoose.model(');
        }));

t.assert('the platform source reader goes through PlatformReadRepository', () => {
    const repository = readCode(MODULE, 'repositories', 'notification-source.read.repository.ts');
    return repository.includes('extends PlatformReadRepository')
        && !repository.includes('platformConnection().db.collection');
});

t.assert('nothing in the module writes to the platform database', () => {
    const files = [
        'domain/source.registry.ts',
        'domain/notification.projector.ts',
        'domain/notification.writer.ts',
        'repositories/notification-source.read.repository.ts',
    ];
    return files.every((file) => {
        const code = readCode(MODULE, ...file.split('/'));
        return !/platformConnection\(\)[\s\S]{0,80}(insertOne|updateOne|updateMany|deleteOne|deleteMany)/.test(code);
    });
});

t.assert('the projector never stamps occurred_at from its own clock', () => {
    const registry = readCode(MODULE, 'domain', 'source.registry.ts');
    // `new Date(0)` is the explicit fallback for a row with no timestamp; `new Date()` would
    // be the projector inventing when something happened.
    return !/occurredAt:\s*new Date\(\)/.test(registry);
});

t.assert('the scheduler unrefs its timer so the process can still exit', () => {
    const scheduler = readCode(MODULE, 'domain', 'notification.scheduler.ts');
    return scheduler.includes('.unref()');
});

t.assert('the scheduler guards against overlapping ticks', () => {
    const scheduler = readCode(MODULE, 'domain', 'notification.scheduler.ts');
    return scheduler.includes('if (running) return');
});

t.assert('drain stops the projector before the databases close', () => {
    const lifecycle = readCode(SRC, 'lifecycle.ts');
    const stopAt = lifecycle.indexOf('stopNotificationProjector()');
    const closeAt = lifecycle.indexOf('closeAll()');
    return stopAt !== -1 && closeAt !== -1 && stopAt < closeAt;
});

t.assert('a truncated tick logs rather than dropping rows silently', () => {
    const projector = readCode(MODULE, 'domain', 'notification.projector.ts');
    return projector.includes('truncated') && projector.includes('logger().warn');
});

t.assert('a new source starts at now — no backfill flood on deploy day', () => {
    const projector = readCode(MODULE, 'domain', 'notification.projector.ts');
    return projector.includes('last_seen_at: now');
});

process.exit(t.finish());
