/**
 * The support queue — the rules, with no infrastructure.
 *
 * Phase 17 Part A shipped 19 routes and 13 audited writes. Its policy core was covered by
 * `test:authz` and its route/audit wiring by the boot assertions, but the DTO, the scope
 * filter's Mongo shape and the gateway paths were asserted nowhere DB-free (G-3 / T-3).
 * This is that suite. No Mongo, no Redis, no jovi-mall process.
 *
 * Five sections carry their weight; the rest are guard rails:
 *
 *   §1  `resolveScope('tickets')` and `scopeFilter` produce the QUERY, asserted as a query
 *       object rather than through a database. This is the assertion that would have caught
 *       G-1's whole class: the module's security property is that a ticket outside the scope
 *       is **not found**, and that only holds if the scope is in the filter.
 *   §2  the authority table across the tier matrix — including that `assigned_admin_id` is a
 *       **LOCK, not an assignment**, the single most misreadable thing in the module.
 *   §3  the DTO, including `avatarUrl` (reserved and always null, step 4.B.6.1) and the fact
 *       that `availableActions` is DERIVED from the same table the service enforces with. A
 *       second copy is how a dashboard offers a verb the API refuses.
 *   §6  every one of the 13 audited writes targets the jovi-mall path it claims, by source
 *       scan. A gateway pointed at the wrong path is invisible until a live run.
 *   §7  the attachment delete's scoping (step 4.B.1) — keyed on the attachment, so it needs
 *       a lookup before the scope. `test:authz` asserts the handler reaches `loadScoped`;
 *       this asserts the lookup that makes reaching it possible.
 *
 *   npm run test:support
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { suite, throws } from './_assert';

// Env must be set before importing anything that reads config at module load.
process.env.NODE_ENV = 'test';
process.env.MONGO_URI_PLATFORM = 'mongodb://localhost:27017/jovi_mall_test';
process.env.MONGO_URI_ADMIN = 'mongodb://localhost:27017/wi_admin_test';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.ADMIN_JWT_SECRET = 'test-access-secret-value-32-chars-long';
process.env.ADMIN_JWT_REFRESH_SECRET = 'test-refresh-secret-value-32-chars-long';
process.env.ADMIN_DASHBOARD_ORIGINS = 'http://localhost:5173';

import { AdminIdentity, AdminTier } from '../../src/modules/admin-identity/domain/admin-identity.types';
import { resolveScope } from '../../src/modules/authorization/domain/resource-scope';
import {
    assignableTiers,
    mayActOnTicket,
    mayClaim,
    TicketAssignmentState,
} from '../../src/modules/support/domain/assignment-authority';
import { snapshotOf } from '../../src/modules/support/domain/admin-snapshot';
import { scopeFilter, TicketReadModel } from '../../src/modules/support/repositories/ticket.read.repository';
import {
    assignmentStateOf,
    toTicketDetailDto,
    toTicketDto,
} from '../../src/modules/support/read-models/ticket.dto';
import {
    AddFollowerSchema,
    AssignTicketSchema,
    AttachFileSchema,
    ClaimTicketSchema,
    CreateNoteSchema,
    CreateTicketSchema,
    SearchTicketsQuerySchema,
    SNAPSHOT_TIERS,
    TICKET_SORT,
    UpdateTicketSchema,
} from '../../src/modules/support/validators/ticket.validator';
import { AUDIT_CATALOG } from '../../src/modules/audit/domain/audit.catalog';
import { PERMISSION_CATALOG } from '../../src/modules/authorization/domain/permission.catalog';
import { PLATFORM_COLLECTIONS } from '../../src/infra/platform/platform-collections';
import { routeManifest } from '../../src/api/route-manifest';
import '../../src/modules/support/routes/ticket.routes';

const t = suite('support tickets');

const MODULE = join(__dirname, '..', '..', 'src', 'modules', 'support');

/** Every .ts file in a directory, comments stripped, so a doc comment cannot fail a scan. */
function readCode(dir: string): { file: string; code: string }[] {
    const out: { file: string; code: string }[] = [];
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            out.push(...readCode(full));
            continue;
        }
        if (!entry.endsWith('.ts')) continue;
        const raw = readFileSync(full, 'utf8');
        const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
        out.push({ file: full, code });
    }
    return out;
}

const files = readCode(MODULE);
const pick = (name: string) => files.find((f) => f.file.endsWith(name))!;
const gatewayCode = pick('ticket.gateway.ts').code;
const controllerCode = pick('ticket.controller.ts').code;
const repoCode = pick('ticket.read.repository.ts').code;
const validatorCode = pick('ticket.validator.ts').code;

type AuditSpec = { permission: string | null; target: string; transport: string };
const auditCatalog = AUDIT_CATALOG as unknown as Record<string, AuditSpec>;

type PermissionSpec = { financial?: boolean; family: string; scope?: string };
const permissions = PERMISSION_CATALOG as unknown as Record<string, PermissionSpec>;

type CollectionSpec = { access: string; writes: string };
const collections = PLATFORM_COLLECTIONS as unknown as Record<string, CollectionSpec>;

const DEV = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const ADM = 'aaaaaaaaaaaaaaaaaaaaaaa2';
const SUP = 'aaaaaaaaaaaaaaaaaaaaaaa3';
const OTHER = 'aaaaaaaaaaaaaaaaaaaaaaa4';

function identity(tier: AdminTier, adminId: string): AdminIdentity {
    return {
        adminId,
        sessionId: 'session',
        email: `tier${tier}@example.test`,
        displayName: `Tier ${tier}`,
        tier,
        status: 'active',
        mfaEnrolled: true,
        pendingMfaEnrolment: false,
    } as AdminIdentity;
}

/** An assignment state: held by nobody, or by `holderId` at `holderTier`. */
function held(holderId: string | null, holderTier: AdminTier | null, assignedByTier: AdminTier | null = null): TicketAssignmentState {
    return { holderId, holderTier, assignedByTier };
}

// ─────────────────────────────────────────────────────────────────────────────
t.section('1. The scope is a QUERY, not a check');

const scopeOf = (tier: AdminTier, adminId: string) => resolveScope(identity(tier, adminId), 'tickets');

t.assert('a Developer runs the whole board', () => scopeOf(1, DEV).kind === 'all');
t.assert('...so its filter narrows nothing', () => Object.keys(scopeFilter(scopeOf(1, DEV))).length === 0);

t.assert('an Admin is scoped, not unscoped', () => scopeOf(2, ADM).kind === 'assigned');
t.assert('Support is scoped, not unscoped', () => scopeOf(3, SUP).kind === 'assigned');

/**
 * The three-branch `$or` is the whole Admin policy in one clause: their own, the pool, and
 * anything a Support administrator holds. **Not a Developer's** — escalating to a Developer
 * has to mean something, and it means nothing if the escalator can still act afterwards.
 */
t.assert('the Admin filter is a three-branch $or — own, pool, tier 3', () => {
    const filter = scopeFilter(scopeOf(2, ADM)) as { $or?: Record<string, unknown>[] };
    return Array.isArray(filter.$or) && filter.$or.length === 3;
});
t.assert('...its first branch is the caller’s own id', () => {
    const filter = scopeFilter(scopeOf(2, ADM)) as { $or: Record<string, unknown>[] };
    return JSON.stringify(filter.$or[0]) === JSON.stringify({ 'admin_assignment.admin.id': { $in: [ADM] } });
});
t.assert('...the pool branch matches null, which also matches a MISSING path', () => {
    const filter = scopeFilter(scopeOf(2, ADM)) as { $or: Record<string, unknown>[] };
    return filter.$or.some((clause) => JSON.stringify(clause) === JSON.stringify({ 'admin_assignment.admin.id': null }));
});
t.assert('...and the supervision branch names tier 3 ONLY', () => {
    const filter = scopeFilter(scopeOf(2, ADM)) as { $or: Record<string, unknown>[] };
    return filter.$or.some((c) => JSON.stringify(c) === JSON.stringify({ 'admin_assignment.admin.tier': { $in: [3] } }));
});

t.assert('the Support filter is TWO branches — own and the pool, no supervision', () => {
    const filter = scopeFilter(scopeOf(3, SUP)) as { $or?: unknown[] };
    return Array.isArray(filter.$or) && filter.$or.length === 2;
});
t.assert('...and never reaches another administrator’s tier', () =>
    !JSON.stringify(scopeFilter(scopeOf(3, SUP))).includes('admin_assignment.admin.tier'));

/**
 * `none` and the audit-only variant must be UNSATISFIABLE rather than empty. An empty filter
 * is `{}`, which matches every ticket on the platform — the exact inversion this whole
 * mechanism exists to prevent, and one a `Object.keys(...).length === 0` check would pass.
 */
t.assert('an unscoped-by-policy caller gets an unsatisfiable filter, not an empty one', () =>
    JSON.stringify(scopeFilter({ kind: 'none' })) === JSON.stringify({ _id: { $in: [] } }));
t.assert('the audit-shaped scope fails CLOSED for a ticket', () =>
    JSON.stringify(scopeFilter({ kind: 'own_or_platform_subject', adminId: SUP })) === JSON.stringify({ _id: { $in: [] } }));

t.assert('no scope produces the match-everything filter except `all`', () => {
    for (const scope of [scopeOf(2, ADM), scopeOf(3, SUP), { kind: 'none' } as const]) {
        if (Object.keys(scopeFilter(scope)).length === 0) return false;
    }
    return true;
});

t.assert('every read method folds the scope in — no unscoped variant exists to reach for', () =>
    repoCode.includes('scopeFilter(scope)') && !/find\w*\(\s*ticketId[^)]*\)\s*:\s*Promise[^{]*\{\s*return this\.findOneBy/.test(repoCode));

t.assert('the soft-delete clause travels with it on both reads', () =>
    (repoCode.match(/deletedAt: null/g) ?? []).length >= 2);

// ─────────────────────────────────────────────────────────────────────────────
t.section('2. The authority table — and assigned_admin_id is a LOCK');

/**
 * The single most misreadable thing in the module. `assigned_admin_id` does NOT mean "this
 * administrator is responsible for the ticket" — it means "this ticket is locked to them".
 * The consequence is the one below: an UNASSIGNED ticket is actionable by every tier, and
 * assignment is what takes it away from the others, not what gives it to somebody.
 */
t.assert('the unassigned pool is open to every tier — assignment REMOVES reach', () =>
    [1, 2, 3].every((tier) => mayActOnTicket(tier as AdminTier, SUP, held(null, null))));

t.assert('a Developer acts on anything, including a ticket another Developer holds', () =>
    mayActOnTicket(1, DEV, held(OTHER, 1)));

t.assert('an Admin acts on their own', () => mayActOnTicket(2, ADM, held(ADM, 2)));
t.assert('an Admin acts on a Support administrator’s', () => mayActOnTicket(2, ADM, held(SUP, 3)));
t.assert('an Admin may NOT act on a Developer’s', () => !mayActOnTicket(2, ADM, held(DEV, 1)));
t.assert('an Admin may NOT act on a peer Admin’s', () => !mayActOnTicket(2, ADM, held(OTHER, 2)));

t.assert('Support acts on their own', () => mayActOnTicket(3, SUP, held(SUP, 3)));
t.assert('Support may NOT act on a peer’s', () => !mayActOnTicket(3, SUP, held(OTHER, 3)));
t.assert('Support may NOT act on an Admin’s', () => !mayActOnTicket(3, SUP, held(ADM, 2)));

const tiersOf = (a: readonly AdminTier[]) => [...a].sort().join(',');

t.assert('a Developer may hand a ticket to any tier, its own included', () =>
    tiersOf(assignableTiers(1, DEV, held(DEV, 1))) === '1,2,3');
t.assert('an Admin holding their own may hand it up or down, not sideways', () =>
    tiersOf(assignableTiers(2, ADM, held(ADM, 2))) === '1,3');

/**
 * The Tier 2 exception, and why the `assigned_by` stamp exists at all: a Developer has
 * already decided the ticket belongs at Tier 2, and bouncing it straight back is the one
 * move that undoes that decision without anybody deciding anything.
 */
t.assert('...but NOT back to a Developer when a Developer handed it down', () =>
    tiersOf(assignableTiers(2, ADM, held(ADM, 2, 1))) === '3');
t.assert('the exception keys on the ASSIGNER’s tier, not the holder’s', () =>
    tiersOf(assignableTiers(2, ADM, held(ADM, 2, 2))) === '1,3');

t.assert('Support escalates its own to Tier 2 and nowhere else', () =>
    tiersOf(assignableTiers(3, SUP, held(SUP, 3))) === '2');
t.assert('Support may not assign a POOL ticket — claiming is the other verb', () =>
    assignableTiers(3, SUP, held(null, null)).length === 0);
t.assert('a caller who may not act may not assign either', () =>
    assignableTiers(3, SUP, held(ADM, 2)).length === 0);

t.assert('claiming is possible exactly when the ticket is unheld', () =>
    mayClaim(held(null, null)) && !mayClaim(held(SUP, 3)));

t.assert('there is no unassign verb anywhere on the surface', () =>
    !/unassign/i.test(controllerCode) && !/unassign/i.test(gatewayCode));

// ─────────────────────────────────────────────────────────────────────────────
t.section('3. The DTO');

const ISO = '2026-08-20T10:00:00.000Z';

function ticket(assignment: TicketReadModel['admin_assignment'] = null): TicketReadModel {
    return {
        _id: { toString: () => 'ticket-1' },
        subject: 'Parcel never arrived',
        description: 'It has been nine days.',
        type: 'DELIVERY_DELAY',
        status: 'open',
        priority: 'high',
        importance: 'normal',
        priority_locked: true,
        entity_type: 'ORDER',
        entity_id: 'order-1',
        created_by_role: 'customer',
        created_by_user_id: null,
        created_by_admin: null,
        admin_assignment: assignment,
        createdAt: new Date(ISO),
        updatedAt: new Date(ISO),
    } as unknown as TicketReadModel;
}

const snapshot = (id: string, tier: AdminTier) => ({
    id, source: 'admin' as const, name: `Tier ${tier}`, tier,
    job_title: 'Support lead', department: 'Customer Care', avatar_url: null,
});

const assigned = {
    admin: snapshot(SUP, 3),
    assigned_by: snapshot(ADM, 2),
    assigned_at: new Date(ISO),
};

t.assert('assignmentStateOf reads the holder off the row', () =>
    assignmentStateOf(ticket(assigned as never)).holderId === SUP);
t.assert('...and the ASSIGNER’s tier, which the Tier 2 rule needs', () =>
    assignmentStateOf(ticket(assigned as never)).assignedByTier === 2);
t.assert('...and reports the pool as three nulls, never as undefined', () => {
    const state = assignmentStateOf(ticket(null));
    return state.holderId === null && state.holderTier === null && state.assignedByTier === null;
});

t.assert('an unassigned ticket maps `assignment: null` — a real state, not missing data', () =>
    toTicketDto(ticket(null), { adminId: SUP, tier: 3 }).assignment === null);

t.assert('the snapshot maps to camelCase', () => {
    const dto = toTicketDto(ticket(assigned as never), { adminId: SUP, tier: 3 });
    return dto.assignment!.admin.jobTitle === 'Support lead' && dto.assignment!.admin.department === 'Customer Care';
});
t.assert('...carries the tier, because THIS audience is the administrator dashboard', () =>
    toTicketDto(ticket(assigned as never), { adminId: SUP, tier: 3 }).assignment!.admin.tier === 3);
t.assert('...and the assigner, null when the ticket was claimed rather than handed over', () =>
    toTicketDto(ticket({ ...assigned, assigned_by: null } as never), { adminId: SUP, tier: 3 })
        .assignment!.assignedBy === null);

/**
 * Step 4.B.6.1 / G-2. `avatarUrl` is **reserved and always null** — `admin_accounts` stores
 * no avatar and this service has no write-side file surface at all. It stays on the wire so
 * that the day one exists, `snapshotOf` is the only line that changes; sending `''` instead
 * would be worse, because a client cannot tell "no picture" from "a picture that failed".
 */
t.assert('avatarUrl is present on the DTO', () =>
    'avatarUrl' in toTicketDto(ticket(assigned as never), { adminId: SUP, tier: 3 }).assignment!.admin);
t.assert('...and is null, because nothing can ever populate it today', () =>
    toTicketDto(ticket(assigned as never), { adminId: SUP, tier: 3 }).assignment!.admin.avatarUrl === null);
t.assert('snapshotOf produces the stored shape, with avatar_url null', () => {
    const built = snapshotOf({
        _id: { toString: () => SUP },
        display_name: 'Tier Three',
        tier: 3,
        job_title: 'Support agent',
        department: 'Customer Care',
        // A stored avatar would be read here if one existed; nothing does.
        avatar_url: 'https://example.test/should-not-be-read.png',
    } as never);

    return built.avatar_url === null
        && built.source === 'admin'
        && built.name === 'Tier Three'
        && Object.keys(built).sort().join(',') === 'avatar_url,department,id,job_title,name,source,tier';
});
t.assert('no upload surface exists in this service — the reason the field stays null', () =>
    !readCode(join(__dirname, '..', '..', 'src', 'modules', 'files')).some((f) => /multer|upload/i.test(f.code)));

/**
 * `availableActions` is DERIVED from the same two functions the service enforces with. A
 * second copy — a `canAssign` in a mapper — is how a dashboard renders a button the API
 * refuses, and the user finds out by clicking it.
 */
t.assert('availableActions.claim comes from mayClaim', () =>
    toTicketDto(ticket(null), { adminId: SUP, tier: 3 }).availableActions.claim === mayClaim(held(null, null)));
t.assert('availableActions.assignableTiers comes from the authority table', () =>
    tiersOf(toTicketDto(ticket(assigned as never), { adminId: SUP, tier: 3 }).availableActions.assignableTiers)
        === tiersOf(assignableTiers(3, SUP, held(SUP, 3, 2))));
t.assert('the DTO never re-derives the rules — it calls them', () => {
    const dto = pick('ticket.dto.ts').code;
    return dto.includes('mayClaim(state)') && dto.includes('assignableTiers(caller.tier, caller.adminId, state)')
        && !/callerTier === 1/.test(dto);
});

t.assert('the detail adds description and nothing else', () => {
    const list = toTicketDto(ticket(null), { adminId: SUP, tier: 3 });
    const detail = toTicketDetailDto(ticket(null), { adminId: SUP, tier: 3 });
    const extra = Object.keys(detail).filter((key) => !(key in list));
    return extra.length === 1 && extra[0] === 'description';
});
t.assert('a missing description maps to an empty string, never undefined', () =>
    toTicketDetailDto({ ...ticket(null), description: undefined } as TicketReadModel, { adminId: SUP, tier: 3 })
        .description === '');

t.assert('dates leave as ISO strings', () =>
    toTicketDto(ticket(null), { adminId: SUP, tier: 3 }).createdAt === ISO);

/** Named-field mapping throughout, never a spread of the stored document. */
t.assert('the mapper never spreads a read model onto the wire', () =>
    !/\.\.\.\s*ticket\b/.test(pick('ticket.dto.ts').code));

// ─────────────────────────────────────────────────────────────────────────────
t.section('4. The query schema');

const parse = (query: Record<string, unknown>) => SearchTicketsQuerySchema.parse({ ...query });

t.assert('defaults to newest first', () => parse({}).sort.field === 'createdAt' && parse({}).sort.direction === -1);
t.assert('the queue defaults to everything the scope allows', () => parse({}).queue === 'all');
t.assert('limit is capped at 100', () => throws(() => parse({ limit: '500' })));
t.assert('an unknown sort field is refused', () => throws(() => parse({ sort: 'nope' })));

/**
 * `assignedAt` is deliberately unsortable: it lives inside `admin_assignment`, which is null
 * for the entire unassigned pool — including every system ticket — so sorting by it puts the
 * queue in an order nobody can predict.
 */
t.assert('assignedAt is not sortable', () => throws(() => parse({ sort: 'assignedAt' })));
t.assert('TICKET_SORT declares exactly the four indexed keys', () =>
    Object.keys(TICKET_SORT).sort().join(',') === 'createdAt,priority,status,updatedAt');

t.assert('the queue enum is closed', () => throws(() => parse({ queue: 'theirs' })));
/**
 * There is no `assignedTo` parameter, and its absence is the point: whose queue a caller may
 * read is the SCOPE's decision, and a parameter that could contradict it would be the one
 * place the two disagree. A list query strips unknown keys rather than refusing them, so the
 * property to assert is that it cannot reach the repository — not that it 400s.
 */
t.assert('an assignedTo parameter is stripped — it never reaches the query', () =>
    !('assignedTo' in parse({ assignedTo: SUP })));
t.assert('...and the repository reads no such field', () => !repoCode.includes('assignedTo'));

/** Bounded strings rather than pinned enums: the vocabulary is jovi-mall's and it grows. */
t.assert('an unknown status passes the bound — the vocabulary is not ours', () =>
    parse({ status: 'awaiting_customer' }).status === 'awaiting_customer');
t.assert('...but a shapeless one does not', () => throws(() => parse({ status: 'x'.repeat(61) })));

t.assert('a note defaults to PRIVATE — the failure direction must be "not shown"', () =>
    CreateNoteSchema.parse({ content: 'internal' }).isPublic === false);
t.assert('the assign body names the TARGET only — never the assigner, never a tier', () =>
    throws(() => AssignTicketSchema.parse({ administratorId: SUP, tier: 1 })));
t.assert('claiming takes no body', () => throws(() => ClaimTicketSchema.parse({ administratorId: SUP })));
t.assert('an empty update is refused rather than accepted as a no-op', () =>
    throws(() => UpdateTicketSchema.parse({})));
t.assert('follower roles are pinned — admins are not followers', () =>
    throws(() => AddFollowerSchema.parse({ userId: SUP, role: 'admin' })));
t.assert('attachments on create are capped', () =>
    throws(() => CreateTicketSchema.parse({
        subject: 's', description: 'd', type: 'T', importance: 'normal', entityType: 'ORDER',
        attachments: Array.from({ length: 6 }, () => SUP),
    })));
t.assert('a file attach names a file id and nothing else', () =>
    throws(() => AttachFileSchema.parse({ fileId: SUP, ticketId: SUP })));

t.assert('the snapshot tier union covers exactly the real tiers', () =>
    [...SNAPSHOT_TIERS].sort().join(',') === '1,2,3');

// ─────────────────────────────────────────────────────────────────────────────
t.section('5. Routes, permissions and audit wiring');

const routes = routeManifest().filter((route) => route.fullPath.startsWith('/api/v1/support/tickets'));

t.assert('nineteen support routes are registered', () => routes.length === 19);
t.assert('none is public', () => routes.every((route) => !JSON.stringify(route.access).includes('"public"')));
t.assert('every mutation declares an audit action', () =>
    routes.filter((route) => route.method !== 'get').every((route) => route.audit !== null));
t.assert('no READ is audited — a ticket read moves nothing (ADR-006 D-5)', () =>
    routes.filter((route) => route.method === 'get').every((route) => route.audit === null));
t.assert('thirteen writes are audited', () => routes.filter((route) => route.audit !== null).length === 13);

/**
 * Express matches in registration order, so the three literal siblings of `/:ticketId` must
 * be declared first — below it they are silently read as ticket ids, and only for those
 * paths.
 */
t.assert('the literal /reference/* and /attachments/:id precede /:ticketId', () => {
    const detail = routes.findIndex((r) => r.fullPath === '/api/v1/support/tickets/:ticketId' && r.method === 'get');
    return ['/api/v1/support/tickets/reference/orders',
        '/api/v1/support/tickets/reference/products',
        '/api/v1/support/tickets/attachments/:attachmentId',
    ].every((path) => routes.findIndex((r) => r.fullPath === path) < detail);
});

const SUPPORT_ACTIONS = [
    'support.tickets.create', 'support.tickets.update', 'support.tickets.status.set',
    'support.tickets.priority.set', 'support.tickets.assign', 'support.tickets.claim',
    'support.tickets.close', 'support.tickets.reopen', 'support.tickets.followers.add',
    'support.tickets.followers.remove', 'support.tickets.notes.create',
    'support.tickets.attachments.attach', 'support.tickets.attachments.delete',
];

t.assert('the catalog carries all thirteen', () => SUPPORT_ACTIONS.every((a) => auditCatalog[a] !== undefined));
t.assert('every one targets a ticket', () => SUPPORT_ACTIONS.every((a) => auditCatalog[a].target === 'ticket'));
t.assert('every one is DELEGATED — this service writes no ticket', () =>
    SUPPORT_ACTIONS.every((a) => auditCatalog[a].transport === 'delegated'));

/**
 * Assign and claim share an endpoint shape and stay two actions: "gave this ticket to X" and
 * "took this ticket" read differently six months later, and only the first names a person.
 */
t.assert('assign and claim are two actions on one permission', () =>
    auditCatalog['support.tickets.assign'].permission === 'support.tickets.assign'
    && auditCatalog['support.tickets.claim'].permission === 'support.tickets.assign');

t.assert('the writes split four ways rather than into one support.tickets.write', () =>
    ['support.tickets.update', 'support.tickets.assign', 'support.tickets.lifecycle',
        'support.tickets.followers.manage'].every((p) => permissions[p] !== undefined)
    && permissions['support.tickets.write'] === undefined);

t.assert('the ticket permissions declare the `tickets` scope, or the filter is unreachable', () =>
    ['support.tickets.read', 'support.tickets.update'].every((p) => permissions[p]?.scope === 'tickets'));

// ─────────────────────────────────────────────────────────────────────────────
t.section('6. Every gateway write targets the path it claims');

/**
 * A gateway pointed at the wrong jovi-mall path is invisible until a live run: the audit
 * intent commits, the call goes out, and a 404 comes back as a delegation failure that reads
 * like the platform being down. Asserted by source scan, keyed on the exported function.
 */
function gatewayBody(name: string): string | null {
    const at = gatewayCode.indexOf(`export async function ${name}(`);
    if (at === -1) return null;
    const rest = gatewayCode.slice(at);
    const end = rest.indexOf('\n}');
    return end === -1 ? rest : rest.slice(0, end);
}

const GATEWAY_PATHS: [string, string, string][] = [
    ['createTicket', 'POST', "path: '/tickets'"],
    ['updateTicket', 'PATCH', 'path: `/tickets/${ticketId}`'],
    ['setStatus', 'PATCH', 'path: `/tickets/${ticketId}/status`'],
    ['setPriority', 'PATCH', 'path: `/tickets/${ticketId}/priority`'],
    ['assign', 'PATCH', 'path: `/tickets/${ticketId}/assign`'],
    ['close', 'POST', 'path: `/tickets/${ticketId}/close`'],
    ['reopen', 'POST', 'path: `/tickets/${ticketId}/reopen`'],
    ['addFollower', 'POST', 'path: `/tickets/${ticketId}/followers`'],
    ['removeFollower', 'DELETE', 'path: `/tickets/${ticketId}/followers/${userId}`'],
    ['createNote', 'POST', 'path: `/tickets/${ticketId}/notes`'],
    ['attachFile', 'POST', 'path: `/tickets/${ticketId}/attachments`'],
    ['deleteAttachment', 'DELETE', 'path: `/tickets/attachments/${attachmentId}`'],
    ['listNotes', 'GET', 'path: `/tickets/${ticketId}/notes`'],
    ['listAttachments', 'GET', 'path: `/tickets/${ticketId}/attachments`'],
    ['refreshSnapshot', 'PATCH', 'path: `/tickets/${ticketId}/admin-snapshot`'],
];

for (const [name, method, path] of GATEWAY_PATHS) {
    t.assert(`${name} → ${method} ${path.slice(7)}`, () => {
        const body = gatewayBody(name);
        return body !== null && body.includes(`method: '${method}'`) && body.includes(path);
    });
}

/**
 * ⚠ NOT `/assign`. Sending a bare `admin` there means "this administrator now holds it,
 * claimed" — routing the D-10 refresh through it would reassign the ticket on every edit and
 * clear `assigned_by`, the field the Tier 2 rule depends on.
 */
t.assert('the snapshot refresh does NOT ride the assign endpoint', () =>
    !(gatewayBody('refreshSnapshot') ?? '').includes('/assign'));

/**
 * ── The two wire names jovi-mall does NOT share with us (step 21) ─────────────
 *
 * Both were found writing `docs/api/support.md`, and both were invisible because the
 * receiving schema is non-strict: the wrong key is stripped, not refused, so the call
 * succeeded and did something other than what it said.
 *
 *  - a note's `isPublic` is jovi-mall's `visibility: 'public' | 'private'`, which DEFAULTS
 *    to public — so the dropped key filed every staff note where the customer reads it,
 *    the exact inversion of the validator's stated safety default;
 *  - the reference lookup's `search` is jovi-mall's `q`, so the form's type-ahead answered
 *    the unfiltered first page while looking as though it had searched.
 *
 * These assert the TRANSLATION, not the parameter — a test that only checked `isPublic`
 * reaches the gateway is exactly the test that passed while the bug was live.
 */
t.assert('a note’s isPublic is translated to jovi-mall’s visibility enum', () => {
    const body = gatewayBody('createNote') ?? '';
    return body.includes("visibility: body.isPublic ? 'public' : 'private'");
});
t.assert('...and the request body is never forwarded wholesale', () => {
    const body = gatewayBody('createNote') ?? '';
    const sent = body.slice(body.indexOf('platformRequest'));
    // `body,` — the ES shorthand — is how the defect was written, so that is the shape to
    // refuse. `body: body` is not a thing anybody types.
    return !sent.includes('body,') && !sent.includes('isPublic:');
});
t.assert('...and the note cap matches jovi-mall’s 300, so the 400 is ours to explain', () =>
    validatorCode.includes('content: z.string().trim().min(1).max(300)'));
t.assert('the reference lookup sends q, the parameter jovi-mall actually reads', () => {
    const body = gatewayBody('referenceLookup') ?? '';
    return body.includes('{ q: search }') && !/{ search }/.test(body);
});

t.assert('every delegated write leaves through platformRequest', () =>
    GATEWAY_PATHS.every(([name]) => (gatewayBody(name) ?? '').includes('platformRequest')));
t.assert('the audit wrapper lives in the gateway, not the controller', () =>
    gatewayCode.includes('auditedAttempt') && !controllerCode.includes('auditedAttempt'));

/** The note's TEXT never enters an audit payload — it is personal data with another retention rule. */
t.assert('a note’s content is not copied into its audit row — only its length', () => {
    const body = gatewayBody('createNote') ?? '';
    const payload = body.slice(body.indexOf("'support.tickets.notes.create'"), body.indexOf('async ()'));
    // `length: body.content.length` is a number; a `content:` KEY would be the text itself.
    return payload.includes('length: body.content.length') && !/\bcontent:/.test(payload);
});

// ─────────────────────────────────────────────────────────────────────────────
t.section('7. The attachment delete is scoped through a lookup (step 4.B.1)');

function handlerBody(name: string): string | null {
    const at = controllerCode.indexOf(`static ${name} = asyncHandler(`);
    if (at === -1) return null;
    const rest = controllerCode.slice(at);
    const end = rest.indexOf('\n    });');
    return end === -1 ? rest : rest.slice(0, end);
}

const deleteBody = handlerBody('deleteAttachment') ?? '';

t.assert('it resolves the attachment to its ticket first', () => deleteBody.includes('findTicketIdByAttachment('));
t.assert('...then applies the SHARED scope, not a second copy of it', () =>
    deleteBody.indexOf('findTicketIdByAttachment(') < deleteBody.indexOf('loadScoped('));
t.assert('...and the assignment lock after it', () =>
    deleteBody.indexOf('loadScoped(') < deleteBody.indexOf('assertMayAct('));

/**
 * A missing attachment and an out-of-scope one must be INDISTINGUISHABLE. Two 404s differing
 * only in `error.code` are still an existence oracle: a Support administrator holding an
 * attachment id could otherwise learn it exists on a ticket they may not see.
 */
t.assert('a missing attachment answers the same code as an out-of-scope ticket', () =>
    deleteBody.includes('ERROR_CODES.TICKET_NOT_FOUND'));
t.assert('...and the identical message', () =>
    (deleteBody.match(/'Support ticket not found'/g) ?? []).length >= 1
    && controllerCode.includes("createAppError(ERROR_CODES.TICKET_NOT_FOUND, 404, 'Support ticket not found')"));

t.assert('the owner lookup projects two fields — never the attachment row', () =>
    repoCode.includes('ATTACHMENT_OWNER_PROJECTION')
    && /ATTACHMENT_OWNER_PROJECTION = \{\s*_id: 1,\s*ticket_id: 1,\s*\}/.test(repoCode));
t.assert('...so file_name and visible_to_user_ids never leave the database', () =>
    !repoCode.includes('file_name') && !repoCode.includes('visible_to_user_ids'));

// ─────────────────────────────────────────────────────────────────────────────
t.section('8. Data access, and the two silent paths that must not be silent');

for (const name of ['tickets', 'ticket_notes', 'ticket_followers', 'ticket_attachments']) {
    t.assert(`${name} is read-only here`, () => collections[name]?.access === 'read');
    t.assert(`${name} writes go over the internal API`, () => collections[name]?.writes === 'internal-api');
}

/**
 * Step 4.B.7 / G-6. The D-10 snapshot refresh swallows — a ticket write that succeeded must
 * not report failure because a cosmetic name refresh did — but swallowing SILENTLY meant a
 * rename could stay unpropagated with no signal, and the snapshot is the only record of that
 * administrator jovi-mall will ever have.
 */
const refreshBody = controllerCode.slice(controllerCode.indexOf('async function refreshHolder'));
/** Only the `catch`. `holderId` is a local of the function, so scanning the whole body proves nothing. */
const refreshCatch = refreshBody.slice(refreshBody.indexOf('catch (err)'));

t.assert('refreshHolder exists to be asserted about', () =>
    refreshBody.startsWith('async function refreshHolder') && refreshCatch.length > 0);
t.assert('the refresh still swallows — the write it accompanies must not fail', () =>
    !refreshCatch.includes('throw'));
t.assert('...but is no longer silent: the catch logs at warn', () =>
    /requestLogger\([^)]*\)\s*\.warn\(/.test(refreshCatch));
t.assert('...naming the ticket id', () => refreshCatch.includes('ticketId:'));
t.assert('...the HOLDER id, without which the line only says "something failed"', () =>
    refreshCatch.includes('holderId'));
t.assert('...and the error itself', () => /err[:,]/.test(refreshCatch));
t.assert('and no Prometheus counter was smuggled in — wi-admin has no registry (D-14)', () =>
    !files.some((f) => /prom-client|new Counter\(/.test(f.code)));

process.exit(t.finish());
