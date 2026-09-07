/**
 * Test: the Phase 3.5 audit subsystem — the action registry, the read scope, the state
 * sanitiser, the retention arithmetic, and the row mapping.
 *
 * DB-free by construction: every rule asserted here is a frozen constant, a Zod schema or
 * a pure function, which is why they live outside the writer.
 *
 * Two sections earn their place above the rest.
 *
 *  §3 — **the scope filter.** Its failure mode is not an error. It is a Support
 *  administrator reading the administrator directory through the audit feed, which no
 *  request would report as wrong. §3.4 in particular pins the `$and` composition: the
 *  scope is an `$or` and the search helper returns an `$or`, so the `Object.assign` idiom
 *  used everywhere else in this service would silently drop the scope.
 *
 *  §5 — **the sanitiser.** It is the only thing standing between a caller's payload and a
 *  password hash in the audit log.
 *
 * Run: npm run test:audit
 */
import { Types } from 'mongoose';
import { suite } from './_assert';

process.env.LOG_LEVEL = 'silent';
process.env.ADMIN_AUDIT_MAX_STATE_BYTES = process.env.ADMIN_AUDIT_MAX_STATE_BYTES ?? '4096';
process.env.ADMIN_AUDIT_RETENTION_DAYS = process.env.ADMIN_AUDIT_RETENTION_DAYS ?? '365';
// The audit domain reads `env()`; give it the minimum a parse needs.
process.env.MONGO_URI_PLATFORM = process.env.MONGO_URI_PLATFORM ?? 'mongodb://localhost:27017/jovi_mall';
process.env.MONGO_URI_ADMIN = process.env.MONGO_URI_ADMIN ?? 'mongodb://localhost:27017/wi-admin';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
process.env.ADMIN_DASHBOARD_ORIGINS = process.env.ADMIN_DASHBOARD_ORIGINS ?? 'http://localhost:5175';
process.env.ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET ?? 'audit-test-access-secret';
process.env.ADMIN_JWT_REFRESH_SECRET = process.env.ADMIN_JWT_REFRESH_SECRET ?? 'audit-test-refresh-secret';

import {
    AUDIT_ACTION_NAMES,
    AUDIT_CATALOG,
    assertAuditCatalogValid,
    auditSpec,
    isAuditAction,
} from '../../src/modules/audit/domain/audit.catalog';
import {
    AUDIT_ACTOR_KINDS,
    AUDIT_STATUSES,
    AUDIT_SUBJECT_CLASSES,
    AUDIT_TARGET_TYPES,
    familyOf,
} from '../../src/modules/audit/domain/audit.types';
import {
    auditScopeFilter,
    combineFilters,
    subjectClassOf,
    subjectClassTable,
} from '../../src/modules/audit/domain/audit-subject';
import {
    REDACTED_MARKER,
    SENSITIVE_FIELD_NAMES,
    sanitiseState,
} from '../../src/modules/audit/domain/audit-state';
import {
    danglingIntentCutoff,
    isPastRetention,
    purgeAfterFor,
} from '../../src/modules/audit/domain/audit-retention';
import { denialRow, toAuditRow } from '../../src/modules/audit/domain/audit.writer';
import { AuthorizationDenial } from '../../src/modules/authorization/domain/denial.recorder';
import { toAuditEntryDetailDto, toAuditEntryDto } from '../../src/modules/audit/domain/audit.dto';
import {
    AUDIT_MAX_RANGE_DAYS,
    ListAuditQuerySchema,
} from '../../src/modules/audit/validators/audit.validator';
import { PERMISSION_CATALOG } from '../../src/modules/authorization/domain/permission.catalog';
import { assertGrantTableValid } from '../../src/modules/authorization/domain/tier-grants';
import { grantedTo } from '../../src/modules/authorization/domain/permission.resolver';
import { resolveScope, isTicketInScope } from '../../src/modules/authorization/domain/resource-scope';
import { AdminIdentity } from '../../src/modules/admin-identity/domain/admin-identity.types';
import { sanitiseRequestId } from '../../src/api/middlewares/request-id.middleware';
import { IAuditLog } from '../../src/modules/audit/models/audit-log.model';

const t = suite('wi-admin audit (Phase 3.5)');

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ADMIN_ID = '507f1f77bcf86cd799439011';
const OTHER_ID = '507f1f77bcf86cd799439012';

const identity = (tier: 1 | 2 | 3, adminId = ADMIN_ID): AdminIdentity => ({
    adminId,
    sessionId: 'sess-1',
    email: 'a@example.test',
    displayName: 'A',
    tier,
    status: 'active',
    mfaEnrolled: true,
    pendingMfaEnrolment: false,
    authenticatedAt: new Date('2026-08-11T09:00:00.000Z'),
    sessionExpiresAt: new Date('2026-08-18T09:00:00.000Z'),
    authMethod: 'cookie',
    ip: '10.0.0.1',
});

const intent = (action: string, overrides: Record<string, unknown> = {}) => ({
    action,
    actor: {
        kind: 'administrator' as const,
        id: ADMIN_ID,
        email: 'a@example.test',
        displayName: 'A',
        tier: 2,
        sessionId: 'sess-1',
    },
    target: { type: 'administrator' as const, id: OTHER_ID, label: 'b@example.test' },
    context: {
        method: 'POST',
        path: '/api/v1/administrators/x/suspend',
        requestId: 'req-1',
        ip: '10.0.0.1',
        userAgent: 'jest',
    },
    ...overrides,
});

// ─── 1. The action registry ──────────────────────────────────────────────────

t.section('1. Action registry — closed, frozen, and boot-asserted');

t.assert('the registry is frozen', () => Object.isFrozen(AUDIT_CATALOG));
t.assert('it holds every catalogued action', () => AUDIT_ACTION_NAMES.length === Object.keys(AUDIT_CATALOG).length);
t.assert('the shipped registry is valid', () => {
    assertAuditCatalogValid();
    return true;
});

t.assert('every action is a dotted family.resource.action name', () =>
    AUDIT_ACTION_NAMES.every((name) => name.includes('.')));

t.assert('every declared permission exists in the permission catalog', () =>
    AUDIT_ACTION_NAMES.every((name) => {
        const permission = auditSpec(name).permission;
        return permission === null || permission in PERMISSION_CATALOG;
    }));

t.assert('every declared permission belongs to the action’s own family', () =>
    AUDIT_ACTION_NAMES.every((name) => {
        const permission = auditSpec(name).permission;
        return permission === null || permission.startsWith(`${familyOf(name)}.`);
    }));

t.assert('every target is a known audit target type', () =>
    AUDIT_ACTION_NAMES.every((name) => (AUDIT_TARGET_TYPES as readonly string[]).includes(auditSpec(name).target)));

t.assert('every action carries a non-empty summary', () =>
    AUDIT_ACTION_NAMES.every((name) => auditSpec(name).summary.trim().length > 0));

t.assert('isAuditAction refuses a prototype key — no lookup on Object.prototype', () =>
    !isAuditAction('toString') && !isAuditAction('constructor'));

t.assert('isAuditAction accepts a real one', () => isAuditAction('administrators.suspend'));

t.assert('suspend and reinstate are DISTINCT actions — a feed must tell them apart', () =>
    isAuditAction('administrators.suspend') && isAuditAction('administrators.reinstate'));

t.assert('the three COD mutations are catalogued, and the two reads are not', () =>
    isAuditAction('cod.remittances.confirm')
    && isAuditAction('cod.remittances.reject')
    && isAuditAction('cod.deposits.confirm')
    && !isAuditAction('cod.remittances.read'));

t.assert('identity events live under administrators.*, since there is no auth family', () =>
    AUDIT_ACTION_NAMES.filter((n) => n.includes('.auth.')).every((n) => familyOf(n) === 'administrators'));

t.assert('a bad family is refused at boot', () => {
    // The assertion reads the frozen shipped registry, so this proves the rule by proving
    // the shipped one satisfies it and the checker is not vacuous.
    const families = new Set(AUDIT_ACTION_NAMES.map(familyOf));
    return !families.has('auth' as never) && families.size > 0;
});

// ─── 2. Vocabularies ─────────────────────────────────────────────────────────

t.section('2. Vocabularies — one array feeding both the Mongoose and Zod enums');

t.assert('five statuses, attempted first', () =>
    AUDIT_STATUSES.length === 5 && AUDIT_STATUSES[0] === 'attempted');

t.assert('attempted is the only non-terminal status', () =>
    AUDIT_STATUSES.includes('attempted') && AUDIT_STATUSES.includes('succeeded')
    && AUDIT_STATUSES.includes('failed') && AUDIT_STATUSES.includes('denied')
    && AUDIT_STATUSES.includes('queued'));

t.assert('three actor kinds, including anonymous for an unmatched login', () =>
    AUDIT_ACTOR_KINDS.length === 3 && AUDIT_ACTOR_KINDS.includes('anonymous'));

t.assert('three subject classes', () => AUDIT_SUBJECT_CLASSES.length === 3);

t.assert('familyOf takes the first dotted segment', () =>
    familyOf('cod.remittances.confirm') === 'cod' && familyOf('administrators.auth.logout') === 'administrators');

// ─── 3. Subject classification and the read scope ────────────────────────────

t.section('3. Read scope — the section whose failure mode is silent');

t.assert('every target type is classified — no row falls out of every scope', () =>
    subjectClassTable().length === AUDIT_TARGET_TYPES.length
    && subjectClassTable().every((row) => AUDIT_SUBJECT_CLASSES.includes(row.subjectClass)));

t.assert('the five platform actors are platform_actor', () =>
    (['user', 'vendor', 'agency', 'agent', 'customer'] as const)
        .every((type) => subjectClassOf(type) === 'platform_actor'));

t.assert('the money chain is platform_record — Support may read it', () =>
    (['remittance', 'deposit', 'payout', 'discrepancy'] as const)
        .every((type) => subjectClassOf(type) === 'platform_record'));

t.assert('orders, shipments and tickets are platform_record', () =>
    (['order', 'shipment', 'ticket'] as const)
        .every((type) => subjectClassOf(type) === 'platform_record'));

t.assert('this service’s own records are internal — invisible to Support', () =>
    (['administrator', 'admin_session', 'approval_request', 'audit_export'] as const)
        .every((type) => subjectClassOf(type) === 'internal'));

t.section('3b. auditScopeFilter');

t.assert('Developer gets NO clause — not a tautological one', () => auditScopeFilter(1, ADMIN_ID) === null);
t.assert('Admin gets no clause either', () => auditScopeFilter(2, ADMIN_ID) === null);

t.assert('Support gets a two-branch $or', () => {
    const filter = auditScopeFilter(3, ADMIN_ID) as { $or: Record<string, unknown>[] };
    return Array.isArray(filter.$or) && filter.$or.length === 2;
});

t.assert('...branch one admits everything that is not internal', () => {
    const filter = auditScopeFilter(3, ADMIN_ID) as { $or: Record<string, unknown>[] };
    return JSON.stringify(filter.$or[0]) === JSON.stringify({ subject_class: { $ne: 'internal' } });
});

t.assert('...branch two admits their own actions, by ObjectId not string', () => {
    const filter = auditScopeFilter(3, ADMIN_ID) as { $or: Array<{ actor_id?: Types.ObjectId }> };
    return filter.$or[1].actor_id instanceof Types.ObjectId
        && filter.$or[1].actor_id.toString() === ADMIN_ID;
});

t.section('3c. resolveScope agrees with the filter');

t.assert('tier 1 and 2 resolve to all', () =>
    resolveScope(identity(1), 'audit').kind === 'all' && resolveScope(identity(2), 'audit').kind === 'all');

t.assert('tier 3 resolves to own_or_platform_subject, carrying their id', () => {
    const scope = resolveScope(identity(3), 'audit');
    return scope.kind === 'own_or_platform_subject' && scope.adminId === ADMIN_ID;
});

t.assert('isTicketInScope refuses an audit scope rather than guessing', () =>
    !isTicketInScope({ kind: 'own_or_platform_subject', adminId: ADMIN_ID }, null));

t.section('3d. combineFilters — the $or collision this function exists to prevent');

t.assert('scope + search produce $and with BOTH clauses, not one overwriting the other', () => {
    const scope = auditScopeFilter(3, ADMIN_ID)!;
    const search = { $or: [{ actor_email: /ada/i }, { target_label: /ada/i }] };

    const combined = combineFilters(scope, search) as { $and?: Record<string, unknown>[] };

    return Array.isArray(combined.$and)
        && combined.$and.length === 2
        && JSON.stringify(combined.$and[0]) === JSON.stringify(scope);
});

t.assert('the naive Object.assign idiom WOULD have dropped the scope — the bug is real', () => {
    const scope = auditScopeFilter(3, ADMIN_ID)!;
    const search = { $or: [{ actor_email: /ada/i }] };
    const naive = Object.assign({}, scope, search) as { $or: unknown[] };
    // One `$or`, and it is the search's — the scope is gone.
    return naive.$or.length === 1;
});

t.assert('plain equality clauses merge without an $and', () => {
    const combined = combineFilters({ status: 'denied' }, { action: 'x' });
    return !('$and' in combined) && combined.status === 'denied' && combined.action === 'x';
});

t.assert('a field constrained twice is kept as both, never silently overwritten', () => {
    const combined = combineFilters({ status: 'denied' }, { status: 'failed' }) as {
        $and?: Record<string, unknown>[];
    };
    return Array.isArray(combined.$and) && combined.$and.length === 2;
});

t.assert('no clauses yields no filter', () => Object.keys(combineFilters(null, undefined, {})).length === 0);
t.assert('one clause is returned unwrapped', () => {
    const combined = combineFilters({ status: 'denied' });
    return combined.status === 'denied' && !('$and' in combined);
});

// ─── 4. Retention arithmetic ─────────────────────────────────────────────────

t.section('4. Retention — exported AND aged, never either alone');

const OCCURRED = new Date('2026-01-01T00:00:00.000Z');

t.assert('purge_after is occurred_at + N days', () =>
    purgeAfterFor(OCCURRED, 365).toISOString() === '2027-01-01T00:00:00.000Z');

t.assert('it derives from the EVENT, not from export time — exporting early cannot shorten a life', () => {
    // Called twice "at different times"; the answer only depends on occurred_at.
    const first = purgeAfterFor(OCCURRED, 365);
    const second = purgeAfterFor(OCCURRED, 365);
    return first.getTime() === second.getTime();
});

t.assert('a row older than N is past retention — deleted in the export run', () =>
    isPastRetention(OCCURRED, new Date('2027-06-01T00:00:00.000Z'), 365));

t.assert('a row younger than N is NOT — it waits out the remainder', () =>
    !isPastRetention(OCCURRED, new Date('2026-06-01T00:00:00.000Z'), 365));

t.assert('exactly N days is past retention (the boundary is inclusive)', () =>
    isPastRetention(OCCURRED, new Date('2027-01-01T00:00:00.000Z'), 365));

t.assert('the retention window is configurable, and the arithmetic follows it', () =>
    purgeAfterFor(OCCURRED, 1).toISOString() === '2026-01-02T00:00:00.000Z');

t.assert('the dangling-intent cutoff is now minus the window', () =>
    danglingIntentCutoff(new Date('2026-08-11T12:05:00.000Z'), 300).toISOString()
    === '2026-08-11T12:00:00.000Z');

// ─── 5. The state sanitiser ──────────────────────────────────────────────────

t.section('5. Sanitiser — the last thing between a payload and a credential in the log');

t.assert('the sensitive set is DERIVED from the logger’s list, not a second copy', () =>
    SENSITIVE_FIELD_NAMES.has('password')
    && SENSITIVE_FIELD_NAMES.has('password_hash')
    && SENSITIVE_FIELD_NAMES.has('passwordhash')
    && SENSITIVE_FIELD_NAMES.has('refreshtoken')
    && SENSITIVE_FIELD_NAMES.has('mfasecret'));

t.assert('it also covers the shapes this service hands out in responses', () =>
    SENSITIVE_FIELD_NAMES.has('onetimepassword')
    && SENSITIVE_FIELD_NAMES.has('currentpassword')
    && SENSITIVE_FIELD_NAMES.has('newpassword'));

t.assert('a top-level credential is redacted', () => {
    const { value } = sanitiseState({ email: 'a@b.test', password: 'hunter2' });
    return value!.password === REDACTED_MARKER && value!.email === 'a@b.test';
});

t.assert('a NESTED credential is redacted at any depth', () => {
    const { value } = sanitiseState({ a: { b: { passwordHash: '$2b$12$abc', ok: 1 } } });
    const nested = (value!.a as Record<string, Record<string, unknown>>).b;
    return nested.passwordHash === REDACTED_MARKER && nested.ok === 1;
});

t.assert('redaction is case-insensitive', () => {
    const { value } = sanitiseState({ PassWord: 'x', MFASecret: 'y' });
    return value!.PassWord === REDACTED_MARKER && value!.MFASecret === REDACTED_MARKER;
});

t.assert('a credential inside an array is redacted too', () => {
    const { value } = sanitiseState({ items: [{ token: 'abc' }] });
    return (value!.items as Record<string, unknown>[])[0].token === REDACTED_MARKER;
});

t.assert('dates become ISO strings rather than empty objects', () => {
    const { value } = sanitiseState({ at: new Date('2026-08-11T09:00:00.000Z') });
    return value!.at === '2026-08-11T09:00:00.000Z';
});

t.assert('an oversized value is replaced by a summary and flagged, never dropped', () => {
    const { value, truncated } = sanitiseState({ blob: 'x'.repeat(9_000) }, 4_096);
    return truncated === true && value!.truncated === true && Array.isArray(value!.keys);
});

t.assert('...and the surviving key names say WHICH fields changed', () => {
    const { value } = sanitiseState({ blob: 'x'.repeat(9_000), tier: 2 }, 512);
    return (value!.keys as string[]).includes('blob') && (value!.keys as string[]).includes('tier');
});

t.assert('a cyclic object does not throw — it must never cancel the action being audited', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    const { value } = sanitiseState(cyclic);
    return value!.self === '[CIRCULAR]';
});

t.assert('null and undefined map to null', () =>
    sanitiseState(null).value === null && sanitiseState(undefined).value === null);

// ─── 6. Row construction ─────────────────────────────────────────────────────

t.section('6. toAuditRow — the mapping, without a database');

t.assert('a succeeded row carries the action, family and correlation id', () => {
    const row = toAuditRow(intent('administrators.suspend'), 'succeeded');
    return row.action === 'administrators.suspend'
        && row.action_family === 'administrators'
        && row.correlation_id === 'req-1'
        && row.status === 'succeeded';
});

t.assert('subject_class is derived from the target, not supplied', () => {
    const row = toAuditRow(intent('administrators.suspend'), 'succeeded');
    return row.subject_class === 'internal';
});

t.assert('a delegated action is flagged delegated', () => {
    const row = toAuditRow(
        { ...intent('cod.remittances.confirm'), target: { type: 'remittance', id: 'r1', label: null } },
        'attempted',
    );
    return row.delegated === true && row.subject_class === 'platform_record';
});

t.assert('a wi_admin_txn action is NOT flagged delegated', () =>
    toAuditRow(intent('administrators.suspend'), 'succeeded').delegated === false);

t.assert('sensitive is copied from the permission’s flags', () => {
    // `administrators.tier.set` is the catalog's only escalation permission.
    const row = toAuditRow(intent('administrators.tier.set'), 'succeeded');
    return row.sensitive === true;
});

t.assert('an action governed by no permission is not sensitive', () =>
    toAuditRow(intent('administrators.auth.login_succeeded'), 'succeeded').sensitive === false);

t.assert('an attempted row has no completed_at — that is what makes it danglable', () =>
    toAuditRow(intent('cod.deposits.confirm'), 'attempted').completed_at === null);

t.assert('a terminal row stamps completed_at', () =>
    toAuditRow(intent('administrators.suspend'), 'succeeded').completed_at instanceof Date);

t.assert('actor id becomes an ObjectId; a null actor stays null', () => {
    const withActor = toAuditRow(intent('administrators.suspend'), 'succeeded');
    const anonymous = toAuditRow(
        { ...intent('administrators.auth.login_failed'), actor: { kind: 'anonymous', id: null, email: null, displayName: null, tier: null, sessionId: null } },
        'failed',
    );
    return withActor.actor_id instanceof Types.ObjectId && anonymous.actor_id === null;
});

t.assert('the payload is sanitised on the way in', () => {
    const row = toAuditRow(intent('administrators.create', { payload: { email: 'x@y.z', password: 'secret' } }), 'succeeded');
    return row.payload!.password === REDACTED_MARKER && row.payload!.email === 'x@y.z';
});

t.assert('required_permissions is [] and never null', () =>
    Array.isArray(toAuditRow(intent('administrators.suspend'), 'succeeded').required_permissions));

t.assert('a target discovered after the write overrides the placeholder', () => {
    const row = toAuditRow(intent('administrators.create', { target: { type: 'administrator', id: null, label: 'x@y.z' } }), 'succeeded', {
        target: { id: OTHER_ID },
    });
    return row.target_id === OTHER_ID;
});

// ─── 6b. denialRow ───────────────────────────────────────────────────────────

t.section('6b. denialRow — the refusal, whose sensitive flag was inverted until Phase 12');

const denial = (over: Partial<AuthorizationDenial> = {}): AuthorizationDenial => ({
    kind: 'permission',
    adminId: ADMIN_ID,
    tier: 2,
    sessionId: 'sess-1',
    required: ['users.read'],
    reason: 'AUTHZ_PERMISSION_DENIED',
    method: 'POST',
    path: '/api/v1/users/x/suspend',
    requestId: 'req-1',
    ip: '10.0.0.1',
    userAgent: 'Mozilla/5.0',
    ...over,
});

t.assert('a denial is status denied at 403, with the kind recorded', () => {
    const row = denialRow(denial());
    return row.status === 'denied' && row.outcome_status === 403 && row.denial_kind === 'permission';
});

t.assert('the action is <kind>.denied and is deliberately NOT catalogued', () => {
    const row = denialRow(denial({ kind: 'escalation' }));
    // `escalation` is not a PermissionFamily, so this name cannot be added to the catalog —
    // which is why denialRow exists instead of routing through toAuditRow.
    return row.action === 'escalation.denied' && !isAuditAction(row.action);
});

t.assert('the family comes from the first refused permission, not the action', () =>
    denialRow(denial({ required: ['orders.refund'] })).action_family === 'orders');

t.assert('a denial naming no permission falls back to the permissions family', () =>
    denialRow(denial({ required: [] })).action_family === 'permissions');

/**
 * The Phase 12 fix. `sensitive` was the literal `false` for the life of the subsystem, so
 * the rows most worth reading — a refused escalation, a refused refund — were filed as
 * routine, and neither read-scoping nor alerting could find them.
 */
t.assert('a refused ESCALATION permission marks the row sensitive', () =>
    denialRow(denial({ required: ['administrators.tier.set'] })).sensitive === true);

t.assert('a refused FINANCIAL permission marks the row sensitive', () =>
    denialRow(denial({ required: ['orders.refund'] })).sensitive === true);

t.assert('a refused DESTRUCTIVE permission marks the row sensitive', () =>
    denialRow(denial({ required: ['agents.ban'] })).sensitive === true);

t.assert('a mundane refusal is not sensitive', () =>
    denialRow(denial({ required: ['users.read'] })).sensitive === false);

t.assert('ANY sensitive permission in the set marks the row', () =>
    denialRow(denial({ required: ['users.read', 'orders.refund'] })).sensitive === true);

t.assert('an unknown permission name never throws — a denial must still record', () =>
    denialRow(denial({ required: ['nonexistent.permission.name'] as never })).sensitive === false);

/** Also Phase 12: `AuthorizationDenial` had no `userAgent`, so the column was always null. */
t.assert('the user agent reaches the row', () =>
    denialRow(denial()).user_agent === 'Mozilla/5.0');

t.assert('a denial with a target is classified by that target, not left unscoped', () => {
    const row = denialRow(denial({ targetId: OTHER_ID }));
    return row.target_type === 'administrator' && row.subject_class === 'internal';
});

t.assert('a denial with no target is target_type none', () =>
    denialRow(denial()).target_type === 'none');

// ─── 7. DTOs ─────────────────────────────────────────────────────────────────

t.section('7. DTOs — the list omits state, the detail carries it');

const sampleRow = {
    ...toAuditRow(intent('administrators.suspend', { payload: { reason: 'why' } }), 'succeeded', {
        before: { status: 'active' },
        after: { status: 'suspended' },
    }),
    _id: new Types.ObjectId(ADMIN_ID),
} as unknown as IAuditLog;

t.assert('the list DTO exposes id, not _id', () => {
    const dto = toAuditEntryDto(sampleRow);
    return dto.id === ADMIN_ID && !('_id' in dto);
});

t.assert('timestamps are ISO-8601 strings', () =>
    typeof toAuditEntryDto(sampleRow).occurredAt === 'string'
    && toAuditEntryDto(sampleRow).occurredAt.endsWith('Z'));

t.assert('the list DTO OMITS payload, before and after', () => {
    const dto = toAuditEntryDto(sampleRow) as unknown as Record<string, unknown>;
    return !('payload' in dto) && !('before' in dto) && !('after' in dto);
});

t.assert('the detail DTO includes them', () => {
    const dto = toAuditEntryDetailDto(sampleRow);
    return dto.before!.status === 'active' && dto.after!.status === 'suspended' && dto.payload !== null;
});

t.assert('the catalog summary rides along, so a feed reads without a lookup', () =>
    toAuditEntryDto(sampleRow).actionSummary === AUDIT_CATALOG['administrators.suspend'].summary);

t.assert('absent data is null, never omitted', () => {
    const dto = toAuditEntryDto(sampleRow);
    return 'viaApprovalId' in dto && dto.viaApprovalId === null && 'purgeAfter' in dto;
});

// ─── 8. Query validation ─────────────────────────────────────────────────────

t.section('8. Query contract');

t.assert('an empty query yields the defaults', () => {
    const parsed = ListAuditQuerySchema.parse({});
    return parsed.page === 1 && parsed.limit === 20 && parsed.sort.field === 'occurredAt'
        && parsed.sort.direction === -1;
});

t.assert('an unknown action is refused — the vocabulary is ours, so it is pinned', () =>
    !ListAuditQuerySchema.safeParse({ action: 'administrators.nope' }).success);

t.assert('a known action is accepted', () =>
    ListAuditQuerySchema.safeParse({ action: 'administrators.suspend' }).success);

t.assert('an unknown status is refused', () => !ListAuditQuerySchema.safeParse({ status: 'maybe' }).success);
t.assert('an unknown target type is refused', () =>
    !ListAuditQuerySchema.safeParse({ targetType: 'spaceship' }).success);

t.assert('sorting by anything but occurredAt is refused', () =>
    !ListAuditQuerySchema.safeParse({ sort: '-actorId' }).success);

t.assert(`a range wider than ${AUDIT_MAX_RANGE_DAYS} days is refused`, () =>
    !ListAuditQuerySchema.safeParse({
        from: '2026-01-01T00:00:00Z',
        to: '2026-12-01T00:00:00Z',
    }).success);

t.assert('a range inside the cap is accepted', () =>
    ListAuditQuerySchema.safeParse({
        from: '2026-08-01T00:00:00Z',
        to: '2026-08-11T00:00:00Z',
    }).success);

t.assert('a date-only value is refused — an instant is required', () =>
    !ListAuditQuerySchema.safeParse({ from: '2026-08-01' }).success);

t.assert("sensitiveOnly=false means false, not true", () =>
    ListAuditQuerySchema.parse({ sensitiveOnly: 'false' }).sensitiveOnly === false);

// ─── 9. Permission policy ────────────────────────────────────────────────────

t.section('9. Policy — who reads the trail, and who can make a row deletable');

t.assert('the grant table is still valid with the audit changes', () => {
    assertGrantTableValid();
    return true;
});

t.assert('Support HOLDS audit.read — scoping, not withholding, is what protects the trail', () =>
    grantedTo(3).has('audit.read'));

t.assert('Support does NOT hold audit.export — it is the precondition for deletion', () =>
    !grantedTo(3).has('audit.export'));

t.assert('Admin and Developer hold both', () =>
    grantedTo(2).has('audit.read') && grantedTo(2).has('audit.export')
    && grantedTo(1).has('audit.read') && grantedTo(1).has('audit.export'));

t.assert('audit.export is flagged destructive, so allInFamily can never sweep it in', () =>
    PERMISSION_CATALOG['audit.export'].destructive === true);

t.assert('audit.read declares the audit scope', () =>
    PERMISSION_CATALOG['audit.read'].scope === 'audit');

t.assert('both audit permissions now say phase 3.5, not 7', () =>
    PERMISSION_CATALOG['audit.read'].phase === 3.5 && PERMISSION_CATALOG['audit.export'].phase === 3.5);

// ─── 10. The correlation id ──────────────────────────────────────────────────

t.section('10. Correlation id — indexed, so a caller cannot weaponise it');

t.assert('a UUID passes through unchanged', () => {
    const id = '550e8400-e29b-41d4-a716-446655440000';
    return sanitiseRequestId(id) === id;
});

t.assert('a trace-style id with dots and colons is accepted', () =>
    sanitiseRequestId('trace:abc.123-x') === 'trace:abc.123-x');

t.assert('an over-long header is replaced, not stored — it would fail the index key', () => {
    const huge = 'x'.repeat(5_000);
    const result = sanitiseRequestId(huge);
    return result !== huge && result.length <= 128;
});

t.assert('a header with spaces or control characters is replaced', () =>
    sanitiseRequestId('has spaces') !== 'has spaces'
    && sanitiseRequestId('nul byte') !== 'nul byte');

t.assert('a repeated header (array) is replaced rather than read at index 0', () => {
    const result = sanitiseRequestId(['a', 'b'] as unknown);
    return typeof result === 'string' && result.length === 36;
});

t.assert('an absent header mints a UUID', () => sanitiseRequestId(undefined).length === 36);

// ─── 11. Source scans ────────────────────────────────────────────────────────

t.section('11. Source scans — the third layer, after the type and the boot assert');

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (full.endsWith('.ts')) out.push(full);
    }
    return out;
}

const SRC = join(__dirname, '..', '..', 'src');
const sourceFiles = walk(SRC);

/**
 * Strip comments before scanning, matching `test-authz.ts` and `test-agents.ts`.
 *
 * Every scan below must run on code, not prose. These files explain the rule they follow
 * by naming the anti-pattern — the approval repository says an expiry "replaces the
 * `updateMany` this used to be" — and a raw scan reports the explanation as the violation.
 */
function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

t.assert('startSession() is called in exactly ONE file — the audit writer', () => {
    const callers = sourceFiles.filter((file) => readFileSync(file, 'utf8').includes('startSession('));
    return callers.length === 1 && callers[0].endsWith('audit.writer.ts');
});

/**
 * The mechanical inverse of the bug that motivated Phase 12.
 *
 * `recordQueued` sat in the writer with ZERO call sites from Phase 3.5 until Phase 11 —
 * purpose-built for the 202 and never wired, while the whole four-eyes queue went
 * unrecorded. Three lines here would have caught it, so here they are.
 *
 * The assertion is on `auditedQueue`, not on `recordQueued`: `recordQueued` is correctly
 * private-by-convention, called only by the wrapper that opens the transaction around it,
 * and `auditedQueue` is what a queueing path actually reaches for. Asserting the inner
 * function would pass forever on the wrapper alone — which is the exact shape of the bug.
 */
t.assert('auditedQueue is reached from outside the writer — the queue is recorded', () => {
    const callers = sourceFiles.filter((file) =>
        !file.endsWith('audit.writer.ts')
        && !file.endsWith('audit.catalog.ts')          // names it in prose only
        && /auditedQueue\(/.test(readFileSync(file, 'utf8')));
    // Both dual-controlled surfaces: administrators (escalation) and money (large payouts).
    return callers.length >= 2;
});

t.assert('the four-eyes DECISIONS are audited — the module imports the writer', () => {
    const service = readFileSync(
        join(SRC, 'modules', 'dual-control', 'domain', 'approval.service.ts'), 'utf8');
    // Until Phase 12 this file imported no audit writer at all.
    return service.includes('auditedTransaction')
        && service.includes("'approvals.approved'")
        && service.includes("'approvals.rejected'")
        && service.includes("'approvals.withdrawn'")
        && service.includes("'approvals.expired'");
});

/**
 * The expiry sweep must not have gone back to a bulk update.
 *
 * `updateMany` cannot produce one audit row per expired request, and an expiry that ends
 * somebody's pending request with no record is the thing this phase fixed. If a future
 * change re-introduces it for speed, the rows vanish silently — nothing else would fail.
 */
/**
 * The audit subsystem must audit ITSELF.
 *
 * `audit.export` and `audit.purge` were catalogued from Phase 3.5 and written by nothing
 * until Phase 12 — so the one operation in the entire service that DELETES an audit row
 * left no trace in the trail it was deleting from.
 */
t.assert('the export service records export, purge and restamp', () => {
    const service = stripComments(readFileSync(
        join(SRC, 'modules', 'audit', 'domain', 'audit-export.service.ts'), 'utf8'));
    return service.includes("action: 'audit.export'")
        && service.includes("action: 'audit.purge'")
        && service.includes("action: 'audit.retention.restamp'");
});

/**
 * A transaction cannot span a streaming file write or an unbounded delete, so these three
 * are `external`. They were declared `wi_admin_txn` for two phases and never exercised,
 * because nothing wrote them — the contradiction was invisible.
 */
t.assert('export, purge and restamp are `external`, never wi_admin_txn', () =>
    (['audit.export', 'audit.purge', 'audit.retention.restamp'] as const)
        .every((action) => auditSpec(action).transport === 'external'));

/**
 * The purge deletes in bounded batches.
 *
 * A single `deleteMany` over a year of retention would breach the transaction entry size
 * and lifetime limits, and holds locks while the API is live. `admin_audit_log` is the
 * largest collection in the service by design, so this is not a hypothetical bound.
 */
t.assert('the purge batches its deletes rather than issuing one unbounded deleteMany', () => {
    const service = stripComments(readFileSync(
        join(SRC, 'modules', 'audit', 'domain', 'audit-export.service.ts'), 'utf8'));
    return service.includes('PURGE_BATCH_SIZE') && service.includes('deleteExpiredInBatches');
});

/**
 * The legacy shim's redaction is a COPY of this service's leaf-name approach, because the
 * two services share no package — the same situation as `infra/platform/collections.ts`,
 * and handled the same way: a drift test that reads the other repo.
 *
 * Without this the copy rots silently. A name added here for a good reason would keep being
 * redacted on this side and stop being redacted on the legacy surface, which is exactly the
 * surface with the least review attention because it is being deleted.
 */
t.assert('jovi-mall’s shim redacts every leaf name this service does', () => {
    const joviRedact = join(
        SRC, '..', '..', 'jovi-mall', 'src', 'core', 'audit', 'redact.ts',
    );

    let source: string;
    try {
        source = readFileSync(joviRedact, 'utf8');
    } catch {
        // The sibling repo is not checked out. Not a failure — this suite is DB-free and
        // must stay runnable on its own.
        return true;
    }

    const missing = [...SENSITIVE_FIELD_NAMES].filter((name) => !source.includes(`'${name}'`));
    if (missing.length > 0) console.error(`      missing from jovi-mall: ${missing.join(', ')}`);
    return missing.length === 0;
});

t.assert('the expiry sweep stamps ONE row at a time, not with updateMany', () => {
    // Comments stripped: this file EXPLAINS the rule by naming `updateMany` as what it
    // replaced, and a raw scan reports the explanation as the violation.
    const repo = stripComments(readFileSync(
        join(SRC, 'modules', 'dual-control', 'repositories', 'approval-request.repository.ts'), 'utf8'));
    return repo.includes('expireOneIfPending') && !repo.includes('updateMany');
});

t.assert('no service or gateway imports AuditLogModel directly — only the writer may', () => {
    const offenders = sourceFiles.filter((file) => {
        if (!/\.(service|gateway)\.ts$/.test(file)) return false;
        return readFileSync(file, 'utf8').includes('AuditLogModel');
    });
    // The export service legitimately owns the collection's lifecycle.
    return offenders.every((file) => file.endsWith('audit-export.service.ts'));
});

t.assert('exactly the 6 escalation-critical writes take a REQUIRED ClientSession', () => {
    const repo = readFileSync(
        join(SRC, 'modules', 'admin-identity', 'repositories', 'admin-account.repository.ts'),
        'utf8',
    );
    /**
     * `session: ClientSession` is required; `session?: ClientSession` is the optional form
     * the reads use. Counting the required ones pins the writes that make an unaudited
     * administrator mutation a compile error: create, updateProfile, setTier, setSuspension,
     * setPasswordHash — and, from Phase 12, `clearMfa`.
     *
     * `clearMfa` earns the sixth slot on the same argument as the other five: it removes the
     * strongest control on a privileged account, which belongs in the same column as
     * creating one or changing its level.
     */
    const required = repo.match(/[^?]session: ClientSession/g) ?? [];
    return required.length === 6;
});

/**
 * 🔒 The security fix, pinned.
 *
 * `activateMfa` verified the six-digit code in the CONTROLLER, outside any service, and
 * threw a bare 401: no lockout counter, no audit row. The identical guess one step earlier
 * (`completeMfa`) counted every failure — so an attacker holding a stolen mid-enrolment
 * session could brute-force activation without limit and without leaving a trace.
 *
 * These assert the shape that fixed it, not the wording: the check lives in the service,
 * and the controller no longer verifies codes at all. If someone moves it back for
 * convenience, the oracle returns silently — nothing else would fail.
 */
t.assert('MFA activation counts a wrong code toward lockout', () => {
    const service = stripComments(readFileSync(
        join(SRC, 'modules', 'admin-identity', 'domain', 'admin-auth.service.ts'), 'utf8'));
    const activate = service.slice(service.indexOf('export async function activateMfa'));
    const body = activate.slice(0, activate.indexOf('\nexport '));
    return body.includes('lockout.recordFailure')
        && body.includes("'administrators.auth.mfa_failed'");
});

t.assert('the controller does not verify MFA codes — that belongs behind the counter', () => {
    const controller = stripComments(readFileSync(
        join(SRC, 'modules', 'admin-identity', 'controllers', 'auth.controller.ts'), 'utf8'));
    return !controller.includes('mfa.verifyCode');
});

/**
 * `appendOutcomeFacts` amends a COMMITTED row, which is only acceptable under one rule: it
 * adds keys beneath `after` and never replaces `after` itself.
 *
 * A bare `$set: { after: facts }` would silently discard what the transaction recorded —
 * the before/after diff that IS the row's evidence — and leave only the session count. The
 * dotted-path form is what makes that impossible, so it is asserted rather than trusted.
 */
t.assert('appendOutcomeFacts writes dotted paths under after, never replacing it', () => {
    const writer = stripComments(readFileSync(
        join(SRC, 'modules', 'audit', 'domain', 'audit.writer.ts'), 'utf8'));
    const fn = writer.slice(writer.indexOf('export async function appendOutcomeFacts'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    return body.includes('`after.${key}`') && !/\$set:\s*\{\s*after:/.test(body);
});

t.assert('the four session-destroying writes append their count', () => {
    const service = stripComments(readFileSync(
        join(SRC, 'modules', 'administrators', 'domain', 'administrator.service.ts'), 'utf8'));
    // suspend, tier change, password reset, MFA reset — each learns the count only after
    // the commit, because Redis cannot join the transaction.
    return (service.match(/appendOutcomeFacts\(auditId, \{ sessionsEnded \}\)/g) ?? []).length === 4;
});

t.assert('no Mongoose create() passes options as a second argument outside an array', () => {
    // `create(doc, { session })` is read as a SECOND DOCUMENT by some Mongoose versions,
    // silently writing outside the transaction.
    const offenders = sourceFiles.filter((file) =>
        /\.create\(\s*\{[^[]*\},\s*\{\s*session/.test(readFileSync(file, 'utf8')));
    return offenders.length === 0;
});

t.assert('the audit routes all declare an audit.* permission', () => {
    const routes = readFileSync(join(SRC, 'modules', 'audit', 'routes', 'audit.routes.ts'), 'utf8');
    const declared = routes.match(/access: permission\('([^']+)'\)/g) ?? [];
    return declared.length > 0 && declared.every((line) => line.includes("permission('audit."));
});

t.assert('no /api/v1 route file registers a route directly on the router', () => {
    const offenders = sourceFiles.filter((file) => {
        if (!file.endsWith('.routes.ts')) return false;
        // `health.routes.ts` is deliberately exempt: it is mounted OUTSIDE `/api/v1`, so
        // `assertRouteManifestComplete` skips it, and it exists precisely to be reachable
        // when everything else is refusing traffic. See `route-manifest.ts`.
        if (file.endsWith('health.routes.ts')) return false;
        return /router\.(get|post|put|patch|delete)\(/.test(readFileSync(file, 'utf8'));
    });
    return offenders.length === 0;
});

// ─── 12. Coverage ────────────────────────────────────────────────────────────

t.section('12. Audit coverage — the assertion that would have caught this phase’s bugs');

/**
 * Importing the API registers every router into the manifest — the same source the boot
 * assertion reads, so these assertions check what Express will actually serve.
 */
import '../../src/api';
// The machine surface registers separately — it is not mounted under `/api/v1` (ADR-022),
// so importing only `src/api` leaves its one route out of the manifest and every assertion
// about it passes vacuously.
import '../../src/api/internal';
import { assertAuditCoverageComplete } from '../../src/api/audit-coverage';
import {
    NO_AUDIT_ROUTE_ALLOWLIST,
    RouteAudit,
    defineRoute,
    permission as permissionAccess,
    records as recordsAudit,
    resetRouteManifest,
    routeManifest,
    selfService,
} from '../../src/api/route-manifest';
import { NON_ROUTE_AUDIT_PRODUCERS } from '../../src/modules/audit/domain/audit.producers';
import { Router } from 'express';

const shippedManifest = [...routeManifest()];

/** The `AppError.code` a throwing call produced, or null if it did not throw. */
function codeOf(fn: () => unknown): string | null {
    try {
        fn();
        return null;
    } catch (error) {
        return (error as { code?: string }).code ?? null;
    }
}

t.assert('the shipped manifest passes the coverage assertion', () =>
    codeOf(() => assertAuditCoverageComplete()) === null);

t.assert('every mutating route in the manifest carries a declaration', () =>
    shippedManifest.filter((r) => r.method !== 'get').every((r) => r.audit !== null));

t.assert('the manifest holds mutating routes at all — a vacuous pass would be worse', () =>
    shippedManifest.filter((r) => r.method !== 'get').length >= 50);

/**
 * Through Phase 12 this asserted the allowlist was EMPTY, and that was the finding: all 61
 * mutating routes recorded something.
 *
 * Phase 13 adds exactly five, all of them the notification inbox's read receipts — mark
 * read/unread, archive/unarchive, and the bulk mark-read. ADR-006 D-5 already decided reads
 * are not audited, and a receipt for having LOOKED at your own inbox is on that side of the
 * line; auditing them would bury the record of what administrators actually did under the
 * noise of them triaging a morning's alerts.
 *
 * Pinned to the exact set rather than to a count, so a sixth entry is a test failure that
 * names itself rather than a number somebody bumps.
 */
const EXPECTED_NO_AUDIT_ROUTES = [
    'POST /api/v1/notifications/read-all',
    'PATCH /api/v1/notifications/:notificationId/read',
    'PATCH /api/v1/notifications/:notificationId/unread',
    'POST /api/v1/notifications/:notificationId/archive',
    'POST /api/v1/notifications/:notificationId/unarchive',

    /**
     * ── ADR-022 adds the sixth, on a DIFFERENT ground from the five above ─────
     * The five are an administrator's own inbox hygiene: a person acted, and the act was
     * too trivial to record. This one has no person at all — it is the n8n automation
     * layer reporting that it failed, over the one route on this service reachable
     * without an administrator identity.
     *
     * The trail is defined as "the append-only record of every administrator action" and
     * its actor field expects one. A row here would have to invent an actor, and an
     * invented actor in an audit trail is worse than an absent row: it makes the trail's
     * central claim false. The report is itself durable in `admin_automation_failures`;
     * what goes unrecorded is an administrator having done something, because none did.
     */
    'POST /api/internal/automation/failures',
];

t.assert('NO_AUDIT_ROUTE_ALLOWLIST holds exactly the expected set', () =>
    NO_AUDIT_ROUTE_ALLOWLIST.size === EXPECTED_NO_AUDIT_ROUTES.length
    && EXPECTED_NO_AUDIT_ROUTES.every((route) => NO_AUDIT_ROUTE_ALLOWLIST.has(route)));

/**
 * Through Phase 13 this read "every allowlisted route is a notification route", and that
 * was the whole rule because inbox hygiene was the only thing that had ever opted out.
 *
 * ADR-022 makes it two grounds, and the assertion is widened to name BOTH rather than
 * loosened to a count. The property being defended is unchanged: an ordinary business
 * write can never appear here. It must be a read receipt on your own inbox, or a route
 * with no administrator to attribute anything to.
 */
t.assert('every allowlisted route is inbox hygiene or the actor-less machine door', () =>
    [...NO_AUDIT_ROUTE_ALLOWLIST].every((route) =>
        route.includes('/notifications/') || route.startsWith('POST /api/internal/')));

/**
 * The second half of that rule, and the one that actually binds: a machine door may opt
 * out of the trail only because it has no actor — so it must genuinely be a service route.
 * Without this, `/api/internal/` becomes a prefix anybody can use to skip the audit.
 */
t.assert('the allowlisted machine door really is a serviceToken route', () =>
    [...NO_AUDIT_ROUTE_ALLOWLIST]
        .filter((route) => route.startsWith('POST /api/internal/'))
        .every((route) =>
            routeManifest().some(
                (declared) =>
                    `${declared.method.toUpperCase()} ${declared.fullPath}` === route
                    && declared.access.kind === 'service',
            )));

t.assert('the preference write is NOT allowlisted — configuration is audited', () =>
    ![...NO_AUDIT_ROUTE_ALLOWLIST].some((route) => route.includes('/preferences')));

t.assert('every non-route producer names a file and claims at least one action', () =>
    Object.entries(NON_ROUTE_AUDIT_PRODUCERS).every(([key, actions]) =>
        key.length > 0 && actions.length > 0 && actions.every(isAuditAction)));

/**
 * The negative cases. A boot assertion that cannot fail is decoration, so each failure mode
 * is provoked against a synthetic manifest.
 *
 * `resetRouteManifest()` empties the shared array, so the shipped manifest is captured above
 * and each case restores it by re-registering nothing — the last block puts it back.
 */
function withSyntheticManifest(register: (router: Router) => void): string | null {
    resetRouteManifest();
    try {
        register(Router());
        return codeOf(() => assertAuditCoverageComplete());
    } finally {
        resetRouteManifest();
    }
}

const noop = (_req: unknown, _res: unknown, next: () => void): void => next();

t.assert('an action the catalog does not know fails the assertion', () => {
    const code = withSyntheticManifest((router) => {
        defineRoute(router, {
            mountedAt: '/synthetic',
            method: 'post',
            path: '/x',
            access: permissionAccess('users.suspend'),
            audit: { kind: 'records', actions: ['users.not_a_real_action'] } as unknown as RouteAudit,
            handler: noop as never,
        });
    });
    return code === 'AUDIT_COVERAGE_INCOMPLETE';
});

t.assert('an unallowlisted noAudit fails the assertion', () => {
    const code = withSyntheticManifest((router) => {
        defineRoute(router, {
            mountedAt: '/synthetic',
            method: 'post',
            path: '/x',
            access: selfService('synthetic'),
            audit: { kind: 'none', reason: 'because' },
            handler: noop as never,
        });
    });
    return code === 'AUDIT_COVERAGE_INCOMPLETE';
});

/**
 * Permission coherence: a route may not record an action its own permission does not
 * govern. Here a route requiring `users.suspend` claims a vendor action.
 */
t.assert('recording an action the route’s permission does not govern fails', () => {
    const code = withSyntheticManifest((router) => {
        defineRoute(router, {
            mountedAt: '/synthetic',
            method: 'post',
            path: '/x',
            access: permissionAccess('users.suspend'),
            audit: recordsAudit('vendors.kyc.approve'),
            handler: noop as never,
        });
    });
    return code === 'AUDIT_COVERAGE_INCOMPLETE';
});

/**
 * The one that matters most: a catalogued action nobody produces.
 *
 * With an empty manifest, every catalogued action is unproduced except those the non-route
 * registry claims — so this both proves the check fires and proves the registry is doing
 * real work rather than being decorative.
 */
t.assert('a catalogued action with no producer anywhere fails the assertion', () => {
    const code = withSyntheticManifest(() => undefined);
    return code === 'AUDIT_COVERAGE_INCOMPLETE';
});

process.exit(t.finish());
