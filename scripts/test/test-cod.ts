/**
 * The cash-on-delivery surface — the rules, with no infrastructure.
 *
 * The module that changed shape at Phase 11: five delegated endpoints became sixteen, of
 * which most are now DIRECT reads. Four things this suite exists to pin:
 *
 *   §3  the `cash_collections` ban list, and — more importantly — that this module
 *       declares NO projection of that collection at all. `code_plain` is the customer's
 *       plaintext delivery OTP and the only API path by which a COD shipment reaches
 *       `delivered`; `select: false` does not protect it from the raw driver, so the one
 *       declaration in the shipments module is reused rather than copied.
 *   §4  the DTO superset rule. `GET /remittances` is delegated while
 *       `GET /remittances/:id` is a direct read, so one resource is served through two
 *       transports — and if they spell a field differently, a dashboard opening a row sees
 *       a different object. Asserted against jovi-mall's own source.
 *   §5  the transport split, now that it runs THROUGH one module rather than around it.
 *   §6  `/holders` carries no contact details. It is gated on `cod.holders.read` alone,
 *       and the legacy pair it replaces returned email, phone and account status.
 *
 *   npm run test:cod
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
    COD_HOLDER_TYPES,
    DISCREPANCY_SORT,
    HOLDER_SORT,
    ListDiscrepanciesQuerySchema,
    ListHoldersQuerySchema,
    ListTrustEventsQuerySchema,
    RecordDepositSchema,
    RejectDepositSchema,
    ResolveDiscrepancySchema,
    TrustAdjustmentSchema,
} from '../../src/modules/cod/validators/cod.validator';
import { buildDiscrepancyFilter } from '../../src/modules/cod/repositories/cod-record.read.repository';
import {
    buildHolderFilter,
    buildTrustEventFilter,
} from '../../src/modules/cod/repositories/cod-cash.read.repository';
import { toDiscrepancyDto, toHolderDto, toTrustEventDto } from '../../src/modules/cod/read-models/cod.dto';
import { AUDIT_CATALOG, auditSpec, isAuditAction } from '../../src/modules/audit/domain/audit.catalog';
import { subjectClassOf } from '../../src/modules/audit/domain/audit-subject';
import { permissionSpec } from '../../src/modules/authorization/domain/permission.catalog';
import { TIER_GRANTS } from '../../src/modules/authorization/domain/tier-grants';
import { isSensitive } from '../../src/modules/authorization/domain/permission.types';
// The legacy endpoint map was imported here and is DELETED (Phase 5 Part D).
import { routeManifest } from '../../src/api/route-manifest';
import '../../src/modules/cod/routes/cod.routes';

const t = suite('cash on delivery');

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

const COD_DIR = [SRC, 'modules', 'cod'];
const COD_GATEWAY = [...COD_DIR, 'gateways', 'cod.gateway.ts'];
const COD_CONTROLLER = [...COD_DIR, 'controllers', 'cod.controller.ts'];
const COD_ROUTES = [...COD_DIR, 'routes', 'cod.routes.ts'];
const RECORD_REPO = [...COD_DIR, 'repositories', 'cod-record.read.repository.ts'];
const CASH_REPO = [...COD_DIR, 'repositories', 'cod-cash.read.repository.ts'];
const COD_DTO = [...COD_DIR, 'read-models', 'cod.dto.ts'];

/** Every source file in the COD module, concatenated — for the ban-list scans. */
const COD_MODULE_SOURCE = [
    COD_GATEWAY, COD_CONTROLLER, COD_ROUTES, RECORD_REPO, CASH_REPO, COD_DTO,
    [...COD_DIR, 'validators', 'cod.validator.ts'],
].map((path) => readCode(...path)).join('\n');

const OID = '507f1f77bcf86cd799439011';
const base = { page: 1, limit: 20, sort: { field: 'createdAt', direction: -1 as const } };
const holderBase = {
    page: 1,
    limit: 20,
    includeSettled: false,
    sort: { field: 'balance', direction: -1 as const },
};

// ─────────────────────────────────────────────────────────────────────────────
t.section('1. The query schemas');

t.assert('the holders list defaults to the largest balance first', () => {
    const parsed = ListHoldersQuerySchema.safeParse({});
    return parsed.success && parsed.data.sort.field === 'balance' && parsed.data.sort.direction === -1;
});

/**
 * `cod_cash_accounts` models a LIABILITY, and the platform is the creditor at the top of
 * the chain — an agent owes their agency, an agency owes the platform, and nobody owes the
 * platform's own account because it does not have one. An empty 200 would let a caller go
 * on misreading the model.
 */
t.assert('`ownerType=platform` is REFUSED — the platform holds no cash account', () =>
    COD_HOLDER_TYPES.length === 2
    && ListHoldersQuerySchema.safeParse({ ownerType: 'agent' }).success
    && ListHoldersQuerySchema.safeParse({ ownerType: 'agency' }).success
    && !ListHoldersQuerySchema.safeParse({ ownerType: 'platform' }).success);

t.assert('settled accounts are out of scope unless asked for', () => {
    const parsed = ListHoldersQuerySchema.safeParse({});
    return parsed.success && parsed.data.includeSettled === false;
});

t.assert('`includeSettled=false` is FALSE, not a truthy string', () => {
    const parsed = ListHoldersQuerySchema.safeParse({ includeSettled: 'false' });
    return parsed.success && parsed.data.includeSettled === false;
});

t.assert('every HOLDER_SORT and DISCREPANCY_SORT key parses in both directions', () =>
    Object.keys(HOLDER_SORT).every((k) =>
        ListHoldersQuerySchema.safeParse({ sort: k }).success
        && ListHoldersQuerySchema.safeParse({ sort: `-${k}` }).success)
    && Object.keys(DISCREPANCY_SORT).every((k) =>
        ListDiscrepanciesQuerySchema.safeParse({ sort: k }).success
        && ListDiscrepanciesQuerySchema.safeParse({ sort: `-${k}` }).success));

t.assert('an unlisted sort field is refused', () =>
    !ListHoldersQuerySchema.safeParse({ sort: 'trustScore' }).success
    && !ListDiscrepanciesQuerySchema.safeParse({ sort: 'amount' }).success);

/**
 * ADR-005 D-17: a vocabulary that is not ours is validated for shape, not membership.
 * `CodDiscrepancyType` has already grown once — `deposit_not_confirmed` arrived with the
 * two-sided deposit flow — and a pinned copy would have gone stale in silence.
 */
t.assert('the discrepancy status and type filters are bounded strings, not pinned enums', () => {
    const source = readCode(...COD_DIR, 'validators', 'cod.validator.ts');
    return !source.includes("'deposit_not_confirmed'")
        && !source.includes("'cash_shortfall'")
        && ListDiscrepanciesQuerySchema.safeParse({ type: 'deposit_not_confirmed' }).success;
});

t.assert('the date range is bounded to a year on both direct lists', () =>
    !ListDiscrepanciesQuerySchema.safeParse({ from: '2020-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z' }).success
    && !ListTrustEventsQuerySchema.safeParse({ from: '2020-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z' }).success);

// ─────────────────────────────────────────────────────────────────────────────
t.section('2. The Mongo filters');

/**
 * "Holder" means somebody currently owing money. A default list carrying settled accounts
 * would report every agent who has ever collected cash as one who is holding it.
 */
t.assert('a holder is an account with a balance — always, unless asked otherwise', () => {
    const filter = buildHolderFilter({ ...holderBase }) as Record<string, unknown>;
    return JSON.stringify(filter.balance) === JSON.stringify({ $gt: 0 });
});

t.assert('...and that scope survives $and composition with an owner filter', () => {
    const filter = buildHolderFilter({ ...holderBase, ownerType: 'agent' }) as Record<string, unknown>;
    const clauses = filter.$and as Record<string, unknown>[];
    return Array.isArray(clauses)
        && clauses.length === 2
        && clauses.some((c) => 'balance' in c);
});

t.assert('`includeSettled=true` with no owner filter is an EMPTY filter, not { $and: [] }', () =>
    Object.keys(buildHolderFilter({ ...holderBase, includeSettled: true })).length === 0);

t.assert('no discrepancy filters produce an empty match', () =>
    Object.keys(buildDiscrepancyFilter({ ...base })).length === 0);

t.assert('two or more discrepancy clauses compose under $and, never by assignment', () => {
    const filter = buildDiscrepancyFilter({ ...base, status: 'open', type: 'late_deposit' }) as Record<string, unknown>;
    return Array.isArray(filter.$and) && (filter.$and as unknown[]).length === 2;
});

t.assert('the discrepancy date range is half-open — $lt, never $lte', () => {
    const filter = buildDiscrepancyFilter({ ...base, from: new Date(0), to: new Date(1) }) as Record<string, unknown>;
    const range = filter.created_at as Record<string, unknown>;
    return '$gte' in range && '$lt' in range && !('$lte' in range);
});

/**
 * The agent scope is composed IN by the builder rather than taken from the query, so a
 * caller cannot widen it — the same discipline the audit feeds use for their fixed
 * `targetType`. There is no cross-agent trust feed at all.
 */
t.assert('the trust feed is agent-scoped, and the scope comes from the path', () => {
    const filter = buildTrustEventFilter(OID, { ...base }) as Record<string, unknown>;
    return 'agent_id' in filter && Object.keys(filter).length === 1;
});

t.assert('...and stays scoped when a filter is added', () => {
    const filter = buildTrustEventFilter(OID, { ...base, eventType: 'late_deposit' }) as Record<string, unknown>;
    const clauses = filter.$and as Record<string, unknown>[];
    return Array.isArray(clauses) && clauses.some((c) => 'agent_id' in c) && clauses.length === 2;
});

t.assert('a malformed id becomes a term matching nothing, not a throw', () => {
    const filter = buildDiscrepancyFilter({ ...base, agentId: 'not-an-id' }) as Record<string, unknown>;
    const clause = filter.agent_id as Record<string, unknown>;
    return Array.isArray(clause.$in) && (clause.$in as unknown[]).length === 0;
});

/**
 * A discrepancy is found by the party it is against, its type or its state — never by free
 * text. So no `$regex` reaches these collections at all, and the escaping hazard
 * `containsInsensitive` exists for does not arise here.
 */
t.assert('no COD filter builds a regex from caller input', () =>
    !/\$regex|containsInsensitive|new RegExp/.test(COD_MODULE_SOURCE));

// ─────────────────────────────────────────────────────────────────────────────
t.section('3. What leaves the database — the delivery code, above all');

/**
 * `code_plain` is the customer's plaintext COD delivery OTP; submitting it is the ONLY API
 * path by which a COD shipment reaches `delivered` and the cash is recorded. `code_hash` is
 * a short numeric OTP's SHA-256, brute-forced offline in milliseconds. jovi-mall marks the
 * first `select: false`, which protects NOTHING here — this service reads with the raw
 * driver, which does not honour Mongoose `select`.
 */
const FORBIDDEN_COLLECTION_FIELDS = ['code_plain', 'code_hash'];

t.assert('the delivery code appears nowhere in the COD module', () =>
    FORBIDDEN_COLLECTION_FIELDS.every((field) => !COD_MODULE_SOURCE.includes(field)));

/**
 * The agent's GPS fix, IP and device at the handoff. `verification.method` alone is what a
 * delivery dispute turns on; the rest is telemetry, and the whole-subdocument form
 * `verification: 1` would drag all of it back in.
 */
t.assert('...and neither does the verification telemetry, in any form', () =>
    !/verification\.location|verification\.ip|verification\.device_info|verification:\s*1/.test(
        COD_MODULE_SOURCE,
    ));

/**
 * The strongest form of the guarantee above: the module cannot leak a field of a
 * collection it cannot point a repository at. §5 of the phase plan says it directly —
 * "reuse, do not re-declare" — because the one correct projection already exists in the
 * shipments module and a second copy is a second thing to keep right.
 */
t.assert('the COD module declares NO projection of cash_collections at all', () =>
    !COD_MODULE_SOURCE.includes('CASH_COLLECTION'));

t.assert('...while the one declaration that does exist still bans both names', () => {
    const source = readCode(SRC, 'modules', 'shipments', 'repositories', 'shipment-context.read.repository.ts');
    const block = source.slice(source.indexOf('class CashCollectionReadRepository'));
    return FORBIDDEN_COLLECTION_FIELDS.every((f) => !block.includes(f))
        && block.includes("'verification.method': 1");
});

t.assert('the DTOs name their fields — no spread of a read model', () =>
    !/\.\.\.row[,\s}]/.test(readCode(...COD_DTO)));

/**
 * Six projections, and every one an inclusion list. An exclusion protects only what
 * somebody thought of, so a sensitive field added to one of these collections next year
 * would arrive on the wire on its own. Scanned per BLOCK rather than per file — the
 * repositories legitimately write `total: 0` in an empty page.
 */
t.assert('every projection in this module is a whitelist, never an exclusion', () => {
    const source = readCode(...RECORD_REPO) + readCode(...CASH_REPO);
    const blocks = [...source.matchAll(/_PROJECTION = \{([\s\S]*?)\} as const/g)].map((m) => m[1]);
    return blocks.length === 6 && blocks.every((block) => !/:\s*(0|false)\s*[,}\n]/.test(block));
});

// ─────────────────────────────────────────────────────────────────────────────
t.section('4. The DTO superset rule — one resource, two transports');

/**
 * `GET /cod/remittances` stayed DELEGATED at Phase 11 while `GET /cod/remittances/:id`
 * became a direct read. If the two spell a field differently, a dashboard that renders a
 * row and then opens it sees two different objects for one remittance.
 *
 * So this reads jovi-mall's own DTO out of its source and asserts every field it emits
 * appears here under the same name. The same trick `test-data-access.ts` uses for the
 * collection constants: assert against the other repo, not against a copy of it.
 */
function joviDtoFields(file: string[], marker: string): string[] {
    const source = read(...file);
    const block = source.slice(source.indexOf(marker));
    const body = block.slice(block.indexOf('{'), block.indexOf('};') + 1);
    return [...body.matchAll(/^\s{6}(\w+):/gm)].map((m) => m[1]);
}

t.assert('the remittance DTO carries every field jovi-mall’s list emits', () => {
    const theirs = joviDtoFields(
        [JOVI, 'modules', 'cod', 'services', 'agency-remittance.service.ts'],
        'private toDto(remittance',
    );
    const ours = readCode(...COD_DTO);
    return theirs.length >= 9 && theirs.every((field) => ours.includes(`${field}:`));
});

t.assert('the deposit DTO carries every field jovi-mall’s list emits', () => {
    const theirs = joviDtoFields(
        [JOVI, 'modules', 'cod', 'services', 'agent-deposit.service.ts'],
        'private toDto(deposit',
    );
    const ours = readCode(...COD_DTO);
    return theirs.length >= 11 && theirs.every((field) => ours.includes(`${field}:`));
});

/**
 * `recordedAt` is jovi-mall's name for `created_at` on a deposit. Both are emitted here —
 * dropping either would break the rule in one direction or the other.
 */
t.assert('...including the deposit’s two names for its creation time', () => {
    const ours = readCode(...COD_DTO);
    return ours.includes('recordedAt:') && ours.includes('createdAt:');
});

/** What the admin side ADDS: the actor stamps and the party names an owner does not need. */
t.assert('the direct DTOs add the actor stamps jovi-mall’s own DTOs omit', () => {
    const ours = readCode(...COD_DTO);
    return ours.includes('resolvedBy:') && ours.includes('recordedBy:');
});

/**
 * Phase 4 step 22 (J7's first domain).
 *
 * A discrepancy is resolved on an **admin-only** path, so its `resolved_by_user_id` is a
 * wi-admin id that resolves in neither database — and it used to leave here as a bare
 * `resolvedByUserId` string, rendered beside a remittance on the same screen that shows a
 * name. One actor-stamp shape across this surface, or the two disagree about what an id
 * means.
 */
const discrepancyRow = {
    _id: { toString: () => OID },
    agent_id: { toString: () => OID },
    agency_id: { toString: () => OID },
    type: 'late_deposit',
    status: 'resolved',
    raised_by: 'system',
    resolved_by_user_id: { toString: () => OID },
    resolved_by_source: 'admin',
    resolved_by_name: 'Eric T.',
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-02-01T00:00:00.000Z'),
} as unknown as Parameters<typeof toDiscrepancyDto>[0];

/** Its own, because `noNames` is declared with §6's fixtures further down. */
const noDiscrepancyNames = { agents: new Map<string, string | null>(), agencies: new Map<string, string | null>() };

t.assert('a resolved discrepancy carries the FULL actor stamp, not a bare id', () => {
    const dto = toDiscrepancyDto(discrepancyRow, noDiscrepancyNames);
    return dto.resolvedBy?.source === 'admin' && dto.resolvedBy?.name === 'Eric T.';
});

t.assert('...and the bare resolvedByUserId is gone from the wire', () =>
    !JSON.stringify(toDiscrepancyDto(discrepancyRow, noDiscrepancyNames)).includes('resolvedByUserId'));

/**
 * The fallback must stay, and must stay `'platform'`. `backfill:actor-source` makes the
 * stored data agree with it, but a row written between the two deploys has neither field.
 */
t.assert('a row with no discriminator reads as platform, exactly as the schema default', () => {
    const legacy = { ...discrepancyRow, resolved_by_source: undefined, resolved_by_name: undefined };
    return toDiscrepancyDto(legacy as typeof discrepancyRow, noDiscrepancyNames).resolvedBy?.source === 'platform';
});

t.assert('an OPEN discrepancy reports null rather than a stamp with no actor', () => {
    const open = { ...discrepancyRow, status: 'open', resolved_by_user_id: null };
    return toDiscrepancyDto(open as unknown as typeof discrepancyRow, noDiscrepancyNames).resolvedBy === null;
});

// ─────────────────────────────────────────────────────────────────────────────
t.section('5. The transport split, now that it runs through one module');

t.assert('the read repositories never import the delegation client', () =>
    !readCode(...RECORD_REPO).includes('platform.client')
    && !readCode(...CASH_REPO).includes('platform.client'));

t.assert('the gateway never imports the repository bases', () =>
    !readCode(...COD_GATEWAY).includes('platform.repository'));

/**
 * The rule this file has always asserted, restated: no arithmetic and no threshold
 * comparison in the gateway. `POST /cod/deposits` carries an amount, so the check is about
 * what happens TO it, not whether the word appears.
 */
t.assert('the gateway does no arithmetic and no comparison on an amount', () => {
    const code = readCode(...COD_GATEWAY);
    return !/[<>]=?\s*\d/.test(code) && !/\bamount\w*\s*[-+*/]|[-+*/]\s*\bamount\w*/i.test(code);
});

t.assert('every delegated WRITE is wrapped in an audit intent', () => {
    const source = readCode(...COD_GATEWAY);
    const writes = (source.match(/method:\s*'(POST|PUT|PATCH|DELETE)'/g) ?? []).length;
    const audited = (source.match(/auditedDelegation\(/g) ?? []).length;
    return writes === 7 && audited === writes;
});

/**
 * The overview is the ONE read left on the gateway, and it is deliberately unaudited: a
 * read leaves no state to reconstruct, so the permission gate is the whole control. (The
 * one audited read in this service is the payout-destination disclosure, whose output is
 * the material a fraudulent payout instruction is built from. A cash total is not that.)
 */
t.assert('the overview is the only delegated READ, and it is not audited', () => {
    const source = readCode(...COD_GATEWAY);
    const reads = (source.match(/method:\s*'GET'/g) ?? []).length;
    const overview = source.slice(source.indexOf('export async function overview'));
    return reads === 3 && !overview.slice(0, overview.indexOf('}')).includes('auditedDelegation');
});

/**
 * New at Phase 11 and the reason every write now reads first: a COD audit row that says an
 * administrator confirmed something, without saying what state it was in, is missing most
 * of the question on a cash chain.
 */
t.assert('every audited write carries a `before` read from the record', () => {
    const source = readCode(...COD_GATEWAY);
    const withBefore = (source.match(/audit\.before|before:\s*audit/g) ?? []).length;
    return source.includes('before: Record<string, unknown> | null') && withBefore >= 5;
});

t.assert('...and the before/after halves speak the same camelCase', () => {
    const gateway = readCode(...COD_GATEWAY);
    const controller = readCode(...COD_CONTROLLER);
    return ['status', 'amount', 'resolvedAt', 'rejectionReason'].every(
        (key) => gateway.includes(`${key}:`) && controller.includes(`${key}:`),
    );
});

t.assert('every delegated path exists in jovi-mall’s admin COD router', () => {
    const gateway = readCode(...COD_GATEWAY);
    const router = read(JOVI, 'modules', 'cod', 'admin-cod.routes.ts');

    const paths = [...gateway.matchAll(/path:\s*[`'](\/cod\/[^`']*)[`']/g)]
        .map((m) => m[1].replace('/cod', ''))
        .map((p) => p.replace(/\$\{\w+\}/g, ':id'));

    // Ten `path:` sites, nine distinct: `/deposits` is named twice — once for the
    // delegated list, once for the create, which jovi-mall also serves at one path under
    // two methods.
    return paths.length === 10
        && new Set(paths).size === 9
        && paths.every((p) => router.includes(`'${p}'`));
});

t.assert('jovi-mall mounts the COD router internally', () => {
    const mounts = read(JOVI, 'api', 'routes', 'internal-admin.routes.ts');
    return mounts.includes("router.use('/cod', buildAdminCodRouter([requireAdminCaller]))");
});

/**
 * The header used to assert the module was purely delegated. Leaving that in place while
 * six collections became direct reads would have been a lie a reader acts on.
 */
t.assert('the router header no longer claims reads are delegated', () => {
    const header = read(...COD_ROUTES).slice(0, 3500);
    // The old sentence may still APPEAR — the new header quotes it in order to refute it,
    // which is more useful to the next reader than deleting it. What must not survive is
    // the claim standing unattributed, so it has to be introduced as Phase 4's.
    const claimIndex = header.indexOf('reads are delegated too');
    const attributionIndex = header.indexOf('Phase 4 asserted here');
    return header.includes('MIXED-TRANSPORT')
        && attributionIndex >= 0
        && attributionIndex < claimIndex;
});

/** F-F: the header said "four out of the thirteen" while declaring five, and "nine" when eight remained. */
t.assert('...and its counts match what it declares', () => {
    const header = read(...COD_ROUTES).slice(0, 3000);
    return header.includes('FIVE') && !header.includes('remaining nine');
});

// ─────────────────────────────────────────────────────────────────────────────
t.section('6. The DTO invariants');

const account = {
    _id: { toString: () => OID },
    owner_type: 'agent',
    owner_id: { toString: () => OID },
    balance: 45000,
    currency: 'XAF',
    version: 3,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-02-01T00:00:00.000Z'),
} as unknown as Parameters<typeof toHolderDto>[0];

const noNames = { agents: new Map<string, string | null>(), agencies: new Map<string, string | null>() };

/**
 * `null` = "does not apply to this owner kind", not "unknown". A trust score bounds how
 * much cash one PERSON may carry; an agency's exposure is bounded by its contracts, which
 * is a different mechanism entirely.
 */
t.assert('an agency holder has NO trust block; an agent does', () => {
    const agent = toHolderDto(account, noNames, new Map());
    const agency = toHolderDto(
        { ...account, owner_type: 'agency' } as typeof account,
        noNames,
        new Map(),
    );
    return agency.trust === null && agent.trust !== null;
});

t.assert('an agent with no COD context reports the schema defaults, not null', () => {
    const dto = toHolderDto(account, noNames, new Map());
    return dto.trust?.score === 100 && dto.trust?.maxThreshold === 0;
});

t.assert('the agent name comes from the COD context, keyed by id', () => {
    const dto = toHolderDto(
        account,
        noNames,
        new Map([[OID, { name: 'Awa N.', trustScore: 82, maxThreshold: 50000 }]]),
    );
    return dto.owner.name === 'Awa N.' && dto.trust?.score === 82;
});

/**
 * Read off the account's own `updated_at` rather than the newest ledger row: the two are
 * written in the same transaction, and joining the ledger for a page of holders would be
 * one query per row for a value already on the document.
 */
t.assert('`lastMovementAt` is the account’s updated_at, as an ISO string', () =>
    toHolderDto(account, noNames, new Map()).lastMovementAt === '2026-02-01T00:00:00.000Z');

t.assert('a trust event reports the score AFTER, and a signed delta', () => {
    const dto = toTrustEventDto({
        _id: { toString: () => OID },
        agent_id: { toString: () => OID },
        agency_id: null,
        event_type: 'late_deposit',
        delta: -15,
        score_after: 85,
        ref_type: 'cod_discrepancy',
        ref_id: { toString: () => OID },
        note: null,
        created_at: new Date('2026-02-01T00:00:00.000Z'),
    } as unknown as Parameters<typeof toTrustEventDto>[0]);
    return dto.delta === -15 && dto.scoreAfter === 85 && dto.agencyId === null;
});

// ─────────────────────────────────────────────────────────────────────────────
t.section('7. Routes, permissions and the audit catalog');

const codRoutes = routeManifest().filter((r) => r.fullPath.startsWith('/api/v1/cod'));

t.assert('sixteen COD routes are registered', () => codRoutes.length === 16);

t.assert('every one declares a permission', () =>
    codRoutes.every((r) => r.access.kind === 'permission'));

t.assert('the legacy /cod/agents and /cod/agencies became ONE /holders route', () => {
    const holders = codRoutes.filter((r) => r.fullPath.endsWith('/holders'));
    return holders.length === 1
        && !codRoutes.some((r) => r.fullPath === '/api/v1/cod/agents')
        && !codRoutes.some((r) => r.fullPath === '/api/v1/cod/agencies');
});

/**
 * The DTO is narrowed to earn a single-permission gate: it carries the cash position, the
 * name and the trust context — never the email, phone and account status the legacy pair
 * returned. Those are directory fields behind their own permissions.
 */
t.assert('/holders is gated on cod.holders.read ALONE', () => {
    const route = codRoutes.find((r) => r.fullPath.endsWith('/holders'));
    return route?.access.kind === 'permission' && route.access.permissions.length === 1;
});

t.assert('...and its DTO carries no contact detail', () => {
    const dto = readCode(...COD_DTO);
    const block = dto.slice(dto.indexOf('interface HolderDto'), dto.indexOf('interface AgentCodContext'));
    return !block.includes('email') && !block.includes('phone') && !block.includes('status');
});

/**
 * The rows are a named agent's conduct record — every penalty they have taken and why. A
 * surface gated on the COD permission alone would be a second door onto it.
 */
t.assert('the trust-event FEED requires agents.read as well', () => {
    const route = codRoutes.find((r) => r.fullPath.endsWith('/trust-events'));
    return route?.access.kind === 'permission'
        && route.access.permissions.includes('agents.read')
        && route.access.mode === 'all';
});

/**
 * ...and the WRITE does not, which is the interesting half. It sends a delta and a note;
 * it reads no conduct history. A permission set answers "what does this reach", not "how
 * serious is it" — and `cod.trust.adjust` is already `financial`.
 */
t.assert('...while the trust ADJUSTMENT does not — it reads nothing', () => {
    const route = codRoutes.find((r) => r.fullPath.endsWith('/trust-adjustment'));
    return route?.access.kind === 'permission'
        && route.access.permissions.length === 1
        && route.access.permissions[0] === 'cod.trust.adjust';
});

t.assert('the overview and the deposit-creating write hold DIFFERENT permissions', () => {
    const overview = codRoutes.find((r) => r.fullPath.endsWith('/overview'));
    const create = codRoutes.find((r) => r.method === 'post' && r.fullPath.endsWith('/deposits'));
    return overview?.access.kind === 'permission'
        && create?.access.kind === 'permission'
        && overview.access.permissions[0] !== create.access.permissions[0];
});

t.assert('every COD write permission is flagged financial', () =>
    ['cod.remittances.confirm', 'cod.remittances.reject', 'cod.deposits.create',
        'cod.deposits.confirm', 'cod.deposits.reject', 'cod.discrepancies.resolve',
        'cod.trust.adjust',
    ].every((p) => isSensitive(permissionSpec(p as 'cod.trust.adjust'))));

/**
 * Support holds NO COD permission at all — not even a read — and that is the standing
 * policy rather than an omission this phase should have fixed.
 *
 * The tier-3 block grants the lookups a support conversation needs: the customer, the
 * order, the shipment, the gateway settlement behind "did my payment go through". The cash
 * chain is a different question. Support can still SEE the record of a COD action through
 * `audit.read` — `auditScopeFilter` admits platform activity including the cash chain —
 * which is a read of history rather than a capability.
 *
 * Sixteen new routes went in at Phase 11 and none of them changed this. If a later phase
 * wants Support to answer "has this agency remitted", the grant is one line and this
 * assertion is where the decision gets recorded.
 */
t.assert('Support holds no COD permission — the cash chain is not ticket work', () => {
    const support = TIER_GRANTS[3] ?? [];
    return !support.some((p) => String(p).startsWith('cod.'));
});

t.assert('...and the boot check would refuse it any of the writes anyway', () =>
    ['cod.deposits.create', 'cod.trust.adjust', 'cod.discrepancies.resolve']
        .every((p) => isSensitive(permissionSpec(p as 'cod.trust.adjust'))));

t.assert('Admin holds every COD permission', () => {
    const admin = TIER_GRANTS[2] ?? [];
    return ['cod.overview.read', 'cod.holders.read', 'cod.remittances.read', 'cod.deposits.read',
        'cod.discrepancies.read', 'cod.deposits.create', 'cod.discrepancies.resolve', 'cod.trust.adjust',
    ].every((p) => admin.includes(p as never));
});

t.assert('seven cod.* audit actions exist, all delegated', () => {
    const rows = Object.entries(AUDIT_CATALOG).filter(([name]) => name.startsWith('cod.'));
    return rows.length === 7 && rows.every(([, spec]) => spec.transport === 'delegated');
});

/**
 * The trust adjustment targets the AGENT rather than a COD record, so the row lands on
 * `GET /agents/:id/activity` — where somebody asking why this person's ceiling changed will
 * actually look. Same reasoning as splitting the plan assignment into three actions.
 */
t.assert('the trust adjustment targets the AGENT, not a cash record', () =>
    isAuditAction('cod.trust.adjust')
    && auditSpec('cod.trust.adjust').target === 'agent'
    && subjectClassOf('agent') === 'platform_actor');

t.assert('a discrepancy is a platform RECORD, so Support cannot read its rows', () =>
    auditSpec('cod.discrepancies.resolve').target === 'discrepancy'
    && subjectClassOf('discrepancy') === 'platform_record');

// `no COD row is left in the legacy endpoint map` stood here. Phase 5 Part D deleted the map,
// so the check would now pass by having nothing to read. The surviving fact is asserted once
// in `test-authz.ts` § 9; this domain is guarded by its route-manifest section.

// ─────────────────────────────────────────────────────────────────────────────
t.section('8. The write bodies');

const validDeposit = { agentId: OID, agencyId: OID, amount: 50000, reference: 'BK-99' };

t.assert('recording a deposit needs both parties, an amount and a reference', () =>
    RecordDepositSchema.safeParse(validDeposit).success
    && !RecordDepositSchema.safeParse({ ...validDeposit, reference: undefined }).success
    && !RecordDepositSchema.safeParse({ ...validDeposit, agencyId: undefined }).success);

/**
 * Minor units. A fractional amount is a client that thinks it is sending major ones, and
 * jovi-mall's schema would refuse it anyway — refusing here says which unit is meant.
 */
t.assert('the amount is a positive integer in minor units', () =>
    !RecordDepositSchema.safeParse({ ...validDeposit, amount: 1500.5 }).success
    && !RecordDepositSchema.safeParse({ ...validDeposit, amount: 0 }).success
    && !RecordDepositSchema.safeParse({ ...validDeposit, amount: -1 }).success);

/**
 * Every field on this body is money or the evidence for it. A mistyped `reference` silently
 * dropped would record cash arriving with nothing tying the claim to a bank statement.
 */
t.assert('an unknown key on the deposit body is a 400, not a silent drop', () =>
    !RecordDepositSchema.safeParse({ ...validDeposit, receipt: 'BK-99' }).success);

t.assert('rejecting a deposit requires a reason', () =>
    !RejectDepositSchema.safeParse({}).success
    && RejectDepositSchema.safeParse({ reason: 'Nothing arrived' }).success);

/**
 * `resolution` IS pinned where the status FILTER is not, and the asymmetry is the rule:
 * this service SENDS this value. Two outcomes exist and they mean very different things to
 * whoever absorbs the shortfall.
 */
t.assert('a discrepancy resolves to exactly two outcomes, both needing a note', () =>
    ResolveDiscrepancySchema.safeParse({ resolution: 'resolved', note: 'Recovered' }).success
    && ResolveDiscrepancySchema.safeParse({ resolution: 'written_off', note: 'Loss taken' }).success
    && !ResolveDiscrepancySchema.safeParse({ resolution: 'closed', note: 'x' }).success
    && !ResolveDiscrepancySchema.safeParse({ resolution: 'resolved' }).success);

t.assert('a trust delta is a bounded integer, and the note is required', () =>
    TrustAdjustmentSchema.safeParse({ delta: -15, note: 'Discrepancy resolved' }).success
    && !TrustAdjustmentSchema.safeParse({ delta: 101, note: 'x' }).success
    && !TrustAdjustmentSchema.safeParse({ delta: -101, note: 'x' }).success
    && !TrustAdjustmentSchema.safeParse({ delta: 1.5, note: 'x' }).success
    && !TrustAdjustmentSchema.safeParse({ delta: 10 }).success);

/**
 * Whether THIS agent may hand over THIS amount is bounded by the contract's outstanding
 * balance, which this service does not read. Guessing it here would answer 400 for a state
 * jovi-mall answers 422 for.
 */
t.assert('no domain rule is re-implemented in the validators', () => {
    const source = readCode(...COD_DIR, 'validators', 'cod.validator.ts');
    return !source.includes('outstanding') && !source.includes('threshold >');
});

process.exit(t.finish());
