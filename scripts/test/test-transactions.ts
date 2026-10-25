/**
 * The platform transactions list (BR-027) — the rules, with no infrastructure.
 *
 * Nine collections merged into one filterable, graded, cursor-paged list. What this suite
 * exists to pin, in the order a mistake would cost:
 *
 *   §2  **grading.** A caller is sent a kind only when they hold the reads that kind's own
 *       screens require — computed against the REAL grant table, so a tier gaining a
 *       permission moves this suite. And the platform's own ledger rows are read below
 *       tier 1 by no filter this service can build.
 *   §3  **every filter is a database predicate**, and a filter on a column a kind does not
 *       carry skips that kind rather than being ignored.
 *   §4  **the status buckets cover jovi-mall's vocabularies**, read out of its source. A
 *       status added upstream must not vanish from `outcome=…` filters silently.
 *   §5  **the walk is exact**: paging the merge by cursor yields every row once, in order,
 *       under both sorts and both directions, with ties on the sort key.
 *   §6  the wire shape — required-and-nullable, never absent — and that no source reads a
 *       payout routing value or an account name.
 *
 *   npm run test:transactions
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Document, ObjectId } from 'mongodb';
import { suite } from './_assert';

// Env must be set before importing anything that reads config at module load.
process.env.NODE_ENV = 'test';
process.env.MONGO_URI_PLATFORM = 'mongodb://localhost:27017/jovi_mall_test';
process.env.MONGO_URI_ADMIN = 'mongodb://localhost:27017/wi_admin_test';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.ADMIN_JWT_SECRET = 'test-access-secret-value-32-chars-long';
process.env.ADMIN_JWT_REFRESH_SECRET = 'test-refresh-secret-value-32-chars-long';
process.env.ADMIN_DASHBOARD_ORIGINS = 'http://localhost:5173';

import { routeManifest } from '../../src/api/route-manifest';
import '../../src/modules/money/routes/money.routes';
// For § 6 only: two kinds point at `/cod/*` reads, and a route is in the manifest once its file is loaded.
import '../../src/modules/cod/routes/cod.routes';
import '../../src/modules/shipments/routes/shipment.routes';
import { hasPermission } from '../../src/modules/authorization/domain/permission.resolver';
import {
    HAND_SETTLEMENT_METHODS,
    PLATFORM_AMOUNTS_PERMISSION,
    PLATFORM_OWNER_TYPES,
    TRANSACTION_DOOR_PERMISSIONS,
    TRANSACTION_MAX_RANGE_DAYS,
    TRANSACTION_SOURCES,
    TransactionCandidate,
    TransactionFilter,
    TransactionSort,
    TransactionViewer,
    buildSourceFilter,
    buildSummaryPipeline,
    caseVariants,
    decodeCursor,
    encodeCursor,
    foldSummary,
    keysetClause,
    mergeTransactionPage,
    mongoSortOf,
    outcomeOf,
    resolveWindow,
    sortToken,
    viewerFor,
} from '../../src/modules/money/domain/transaction-sources';
import {
    TRANSACTION_KINDS,
    TRANSACTION_OUTCOMES,
    TransactionKind,
} from '../../src/modules/money/read-models/transaction.dto';
import {
    ListTransactionsQuerySchema,
    TransactionParamSchema,
    TransactionSummaryQuerySchema,
} from '../../src/modules/money/validators/transaction.validator';
import { withPlatformAmounts, withholdPlatformAmounts } from '../../src/modules/money/domain/platform-take';

const t = suite('platform transactions (BR-027)');

const SRC = join(__dirname, '..', '..', 'src');
const JOVI = join(__dirname, '..', '..', '..', 'jovi-mall', 'src');
const read = (...segments: string[]): string => readFileSync(join(...segments), 'utf8');

const OID = '665c0f000000000000000001';
const OTHER_OID = '665c0f000000000000000002';
const oid = (hex: string) => new ObjectId(hex);

const FROM = new Date('2026-01-01T00:00:00.000Z');
const TO = new Date('2026-02-01T00:00:00.000Z');
const WINDOW = { from: FROM, to: TO };

const viewerOfTier = (tier: 1 | 2 | 3): TransactionViewer =>
    viewerFor((permission) => hasPermission(tier, permission));
const DEVELOPER = viewerOfTier(1);
const ADMIN = viewerOfTier(2);
const SUPPORT = viewerOfTier(3);

const filterFor = (kind: TransactionKind, terms: Partial<TransactionFilter> = {}, viewer = DEVELOPER) =>
    buildSourceFilter(TRANSACTION_SOURCES[kind], { ...WINDOW, ...terms }, viewer);

/** Every clause of a filter, flattened out of its top-level `$and`. */
function clauses(filter: Document | null): Document[] {
    if (!filter) return [];
    return Array.isArray(filter.$and) ? (filter.$and as Document[]) : [filter];
}
const json = (value: unknown): string => JSON.stringify(value);

function issuesOf(schema: { safeParse: (v: unknown) => unknown }, input: unknown): string[] {
    const result = schema.safeParse(input) as { success: boolean; error?: { errors: { code: string; path: (string | number)[] }[] } };
    return result.success ? [] : result.error!.errors.map((issue) => `${issue.code}:${issue.path.join('.')}`);
}
function parsed<T>(schema: { parse: (v: unknown) => T }, input: unknown): T {
    return schema.parse(input);
}

// ─────────────────────────────────────────────────────────────────────────────
t.section('1. The query schemas');

t.assert('an unknown parameter is refused on the list — a misspelt filter is never the unfiltered page', () =>
    issuesOf(ListTransactionsQuerySchema, { amountMn: '50000' }).some((issue) => issue.startsWith('unrecognized_keys')));

t.assert('...and on the summary', () =>
    issuesOf(TransactionSummaryQuerySchema, { kindd: 'payment' }).some((issue) => issue.startsWith('unrecognized_keys')));

t.assert('the summary takes no paging parameters — `limit` there is an unknown key', () =>
    issuesOf(TransactionSummaryQuerySchema, { limit: '10' }).some((issue) => issue.startsWith('unrecognized_keys')));

t.assert('an empty query is valid: 20 rows, newest first', () => {
    const query = parsed(ListTransactionsQuerySchema, {});
    return query.limit === 20 && query.sort.field === 'createdAt' && query.sort.direction === -1;
});

t.assert('"is any of" reads a comma list', () =>
    json(parsed(ListTransactionsQuerySchema, { kind: 'payment, refund' }).kind) === json(['payment', 'refund']));

t.assert('...and a repeated key, de-duplicated', () =>
    json(parsed(ListTransactionsQuerySchema, { kind: ['payment', 'refund,payment'] }).kind) === json(['payment', 'refund']));

t.assert('a value outside one of OUR vocabularies is a 400 (kind, group, direction, role, outcome)', () =>
    ['kind', 'group', 'direction', 'role', 'outcome'].every((key) =>
        issuesOf(ListTransactionsQuerySchema, { [key]: 'nonsense' }).length > 0));

t.assert('a jovi-mall vocabulary is validated for shape only — an unknown status is a filter, not a 400', () =>
    issuesOf(ListTransactionsQuerySchema, { status: 'some_future_status', gateway: 'NEWPAY' }).length === 0);

t.assert('the five amount comparisons all parse to numbers', () => {
    const query = parsed(ListTransactionsQuerySchema, {
        amount: '5000', amountMin: '1', amountMax: '9', amountGt: '2', amountLt: '8',
    });
    return query.amount === 5000 && query.amountMin === 1 && query.amountMax === 9 && query.amountGt === 2 && query.amountLt === 8;
});

t.assert('amount bounds that exclude everything are a 400, not an empty page', () =>
    issuesOf(ListTransactionsQuerySchema, { amountMin: '100', amountMax: '50' }).length > 0
    && issuesOf(ListTransactionsQuerySchema, { amountGt: '100', amountLt: '50' }).length > 0);

t.assert('a negative or non-numeric amount is refused', () =>
    issuesOf(ListTransactionsQuerySchema, { amountMin: '-1' }).length > 0
    && issuesOf(ListTransactionsQuerySchema, { amount: 'lots' }).length > 0);

t.assert(`a window wider than ${TRANSACTION_MAX_RANGE_DAYS} days is refused`, () =>
    issuesOf(ListTransactionsQuerySchema, { from: '2024-01-01T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z' }).length > 0
    && issuesOf(ListTransactionsQuerySchema, { from: '2026-01-01T00:00:00.000Z', to: '2026-06-01T00:00:00.000Z' }).length === 0);

t.assert('only createdAt and amount are sortable', () =>
    issuesOf(ListTransactionsQuerySchema, { sort: '-status' }).length > 0
    && parsed(ListTransactionsQuerySchema, { sort: 'amount' }).sort.direction === 1);

t.assert('a cursor this list did not issue is refused', () =>
    issuesOf(ListTransactionsQuerySchema, { cursor: 'not-a-cursor' }).includes('custom:cursor'));

t.assert('a cursor issued under one sort is refused under another', () => {
    const cursor = encodeCursor({ sort: '-createdAt', value: 1, id: OID });
    return issuesOf(ListTransactionsQuerySchema, { cursor, sort: '-amount' }).includes('custom:cursor')
        && issuesOf(ListTransactionsQuerySchema, { cursor }).length === 0;
});

t.assert('the detail path pins `kind` and the id shape', () =>
    issuesOf(TransactionParamSchema, { kind: 'payment', id: OID }).length === 0
    && issuesOf(TransactionParamSchema, { kind: 'cash_collection', id: OID }).length > 0
    && issuesOf(TransactionParamSchema, { kind: 'payment', id: 'abc' }).length > 0);

// ─────────────────────────────────────────────────────────────────────────────
t.section('2. Grading — nobody is sent more than their other screens show');

const SUPPORT_KINDS: TransactionKind[] = ['payment', 'refund', 'delivery_fee_refund', 'payout', 'cod_deposit', 'cod_remittance', 'cod_collection'];

t.assert('there are eleven kinds and every one has a source of the same name', () =>
    TRANSACTION_KINDS.length === 11
    && TRANSACTION_KINDS.every((kind) => TRANSACTION_SOURCES[kind]?.kind === kind)
    && Object.keys(TRANSACTION_SOURCES).length === 11);

t.assert('Support is sent exactly seven kinds — no plan purchase, no credit top-up, no ledger entry, no debt adjustment', () =>
    json([...SUPPORT.kinds].sort()) === json([...SUPPORT_KINDS].sort()));

t.assert('Admin and Developer are sent all eleven', () =>
    ADMIN.kinds.size === 11 && DEVELOPER.kinds.size === 11);

t.assert('only tier 1 is sent the platform\'s own rows', () =>
    DEVELOPER.seesPlatformAccounts && !ADMIN.seesPlatformAccounts && !SUPPORT.seesPlatformAccounts);

/**
 * BR-030 § 3: the owner's rule is ONE grant — the platform-amounts permission — read in three
 * places (this list, the three platform-earnings routes, the order split). A `tier === 1`
 * comparison anywhere in the rules file would be a second copy of the rule that a grant
 * change would not move.
 */
t.assert('...because only tier 1 holds the platform-amounts permission, and the viewer reads the permission, not the tier', () =>
    PLATFORM_AMOUNTS_PERMISSION === 'money.earnings.platform.read'
    && hasPermission(1, PLATFORM_AMOUNTS_PERMISSION)
    && !hasPermission(2, PLATFORM_AMOUNTS_PERMISSION)
    && !hasPermission(3, PLATFORM_AMOUNTS_PERMISSION)
    && viewerFor(() => true).seesPlatformAccounts
    && !viewerFor((permission) => permission !== PLATFORM_AMOUNTS_PERMISSION).seesPlatformAccounts
    && !/tier\s*===/.test(read(SRC, 'modules', 'money', 'domain', 'transaction-sources.ts').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')));

/**
 * The property the whole grading design rests on: a kind's permissions are the ones its own
 * screens require today, so the list cannot be a second door. Pinned against the routes that
 * already serve each kind, read out of the manifest rather than restated.
 */
const manifest = routeManifest();
const permissionsOf = (fullPath: string): string[] => {
    const route = manifest.find((r) => r.method === 'get' && r.fullPath === fullPath);
    return route && route.access.kind === 'permission' ? [...route.access.permissions].sort() : ['<no such route>'];
};

t.assert('payment, refund and delivery-fee refund need what /money/payments, /money/refunds and /money/delivery-fee-refunds need', () =>
    json(TRANSACTION_SOURCES.payment.permissions) === json(permissionsOf('/api/v1/money/payments'))
    && json(TRANSACTION_SOURCES.refund.permissions) === json(permissionsOf('/api/v1/money/refunds'))
    && json(TRANSACTION_SOURCES.delivery_fee_refund.permissions) === json(permissionsOf('/api/v1/money/delivery-fee-refunds')));

t.assert('payout needs what /money/payouts needs', () =>
    json(TRANSACTION_SOURCES.payout.permissions) === json(permissionsOf('/api/v1/money/payouts')));

t.assert('a ledger entry and a debt adjustment need what /money/earnings/allocations needs', () =>
    json(TRANSACTION_SOURCES.ledger_entry.permissions) === json(permissionsOf('/api/v1/money/earnings/allocations'))
    && json(TRANSACTION_SOURCES.earnings_adjustment.permissions) === json(permissionsOf('/api/v1/money/earnings/allocations')));

t.assert('a COD collection needs what the shipment detail needs — the one screen that already shows it', () =>
    json(TRANSACTION_SOURCES.cod_collection.permissions) === json(permissionsOf('/api/v1/shipments/:shipmentId'))
    && ([1, 2, 3] as const).every((tier) => hasPermission(tier, 'shipments.read')));

t.assert('⚠ the three platform-earnings routes stand behind the platform-amounts permission alone (BR-030 § 3a)', () =>
    ['/api/v1/money/earnings/platform', '/api/v1/money/earnings/platform/ledger', '/api/v1/money/earnings/platform/summary']
        .every((path) => json(permissionsOf(path)) === json([PLATFORM_AMOUNTS_PERMISSION])));

/**
 * BR-031: the route table and the new section of `money.md` were updated and the three endpoint
 * sections below them were not, so the row a reader lands on from a link named the old
 * permission. Each section's Permission row must name what the manifest guards it with.
 */
t.assert('money.md: each of the three endpoint sections names the permission the manifest uses', () => {
    const page = read(join(SRC, '..', 'api-doc', 'api', 'money.md'));
    return ['/money/earnings/platform', '/money/earnings/platform/summary', '/money/earnings/platform/ledger'].every((path) => {
        const at = page.indexOf(`\n## \`GET ${path}\``);
        const end = page.indexOf('\n## ', at + 1);
        const section = page.slice(at, end < 0 ? undefined : end);
        const row = /\| \*\*Permission\*\* \| `([a-z_.]+)`/.exec(section);
        return at >= 0 && row !== null && json([row[1]]) === json(permissionsOf(`/api/v1${path}`));
    });
});

t.assert('...and the order split stays open to every tier — it is redacted, not refused (§ 3b)', () =>
    json(permissionsOf('/api/v1/money/orders/:orderId/split')) === json(['money.splits.read'])
    && ([1, 2, 3] as const).every((tier) => hasPermission(tier, 'money.splits.read')));

t.assert('a kind the viewer may not read is never queried, whatever the filter says', () =>
    filterFor('ledger_entry', {}, SUPPORT) === null
    && filterFor('plan_purchase', { kind: ['plan_purchase'] }, SUPPORT) === null
    && filterFor('credit_topup', {}, SUPPORT) === null
    && filterFor('payment', {}, SUPPORT) !== null);

const excludesPlatform = (filter: Document | null): boolean =>
    clauses(filter).some((clause) => json(clause) === json({ owner_type: { $nin: [...PLATFORM_OWNER_TYPES] } }));

t.assert('⚠ below tier 1 every ledger filter excludes the platform accounts — with no filter at all', () =>
    excludesPlatform(filterFor('ledger_entry', {}, ADMIN)));

t.assert('⚠ ...and still when the caller asks for them by role, by party or by kind', () =>
    excludesPlatform(filterFor('ledger_entry', { role: ['platform'] }, ADMIN))
    && excludesPlatform(filterFor('ledger_entry', { kind: ['ledger_entry'], reasonCode: ['order_split'] }, ADMIN))
    && excludesPlatform(filterFor('ledger_entry', { orderId: OID }, ADMIN)));

t.assert('tier 1 gets no such clause', () =>
    !excludesPlatform(filterFor('ledger_entry', {}, DEVELOPER)));

t.assert('the door is the five existing reads — and every tier holds at least one', () =>
    TRANSACTION_DOOR_PERMISSIONS.length === 5
    && ([1, 2, 3] as const).every((tier) => TRANSACTION_DOOR_PERMISSIONS.some((p) => hasPermission(tier, p))));

t.assert('every kind but the COD collection needs a door permission — and that one needs a read every tier holds', () =>
    TRANSACTION_KINDS.filter((kind) => kind !== 'cod_collection').every((kind) =>
        TRANSACTION_SOURCES[kind].permissions.some((p) => TRANSACTION_DOOR_PERMISSIONS.includes(p))));

t.assert('a debt adjustment follows the platform rule like a ledger entry: excluded below tier 1, by its own owner field', () =>
    filterFor('earnings_adjustment', {}, SUPPORT) === null
    && clauses(filterFor('earnings_adjustment', {}, ADMIN)).some((clause) =>
        json(clause) === json({ beneficiary_type: { $nin: [...PLATFORM_OWNER_TYPES] } }))
    && !json(filterFor('earnings_adjustment', {}, DEVELOPER)).includes('$nin'));

// ─────────────────────────────────────────────────────────────────────────────
t.section('3. The unified filter → eleven native filters');

t.assert('every source filter carries the half-open window on its own creation field', () =>
    TRANSACTION_KINDS.every((kind) => {
        const field = TRANSACTION_SOURCES[kind].fields.createdAt;
        return clauses(filterFor(kind)).some((clause) => json(clause) === json({ [field]: { $gte: FROM, $lt: TO } }));
    }));

t.assert('`kind` and `group` skip the sources they exclude', () =>
    filterFor('refund', { kind: ['payment'] }) === null
    && filterFor('payment', { kind: ['payment'] }) !== null
    && filterFor('ledger_entry', { group: ['cash'] }) === null
    && filterFor('cod_deposit', { group: ['cash'] }) !== null
    && filterFor('cod_remittance', { group: ['cash'] }) !== null);

t.assert('direction is static per kind: `in` keeps payments and remittances, drops refunds and payouts', () =>
    filterFor('payment', { direction: ['in'] }) !== null
    && filterFor('cod_remittance', { direction: ['in'] }) !== null
    && filterFor('refund', { direction: ['in'] }) === null
    && filterFor('payout', { direction: ['in'] }) === null
    && filterFor('ledger_entry', { direction: ['internal'] }) !== null);

t.assert('a COD deposit is `in` only when the PLATFORM received it (D-5)', () =>
    clauses(filterFor('cod_deposit', { direction: ['in'] })).some((c) => json(c) === json({ recipient: { $in: ['platform'] } }))
    && clauses(filterFor('cod_deposit', { direction: ['internal'] })).some((c) => json(c) === json({ recipient: { $nin: ['platform'] } }))
    && filterFor('cod_deposit', { direction: ['out'] }) === null);

t.assert('...and asking for both directions adds no recipient clause at all', () =>
    !json(filterFor('cod_deposit', { direction: ['in', 'internal'] })).includes('recipient'));

t.assert('role is fixed where the kind has one party type', () =>
    filterFor('payment', { role: ['customer'] }) !== null
    && filterFor('payment', { role: ['vendor'] }) === null
    && filterFor('cod_deposit', { role: ['agent'] }) !== null
    && filterFor('cod_remittance', { role: ['agency'] }) !== null
    && filterFor('cod_remittance', { role: ['agent'] }) === null);

t.assert('...and the stored owner type elsewhere; `platform` means both platform accounts', () =>
    clauses(filterFor('payout', { role: ['vendor', 'agent'] })).some((c) => json(c) === json({ owner_type: { $in: ['vendor', 'agent'] } }))
    && clauses(filterFor('ledger_entry', { role: ['platform'] })).some((c) => json(c) === json({ owner_type: { $in: ['platform', 'platform_ai'] } }))
    && filterFor('payout', { role: ['customer'] }) === null);

t.assert('partyId matches the kind\'s own party field', () =>
    json(filterFor('payment', { partyId: OID })).includes('"userId"')
    && json(filterFor('payout', { partyId: OID })).includes('"owner_id"')
    && json(filterFor('cod_deposit', { partyId: OID })).includes('"agent_id"')
    && json(filterFor('cod_remittance', { partyId: OID })).includes('"agency_id"')
    && json(filterFor('delivery_fee_refund', { partyId: OID })).includes('"customer_id"'));

t.assert('provider filters the kinds that carry one and SKIPS the rest — never "ignore the term"', () =>
    filterFor('payment', { provider: ['MTN'] }) !== null
    && filterFor('plan_purchase', { provider: ['MTN'] }) !== null
    && filterFor('credit_topup', { provider: ['MTN'] }) !== null
    && filterFor('payout', { provider: ['MTN'] }) !== null
    && filterFor('refund', { provider: ['MTN'] }) === null
    && filterFor('ledger_entry', { provider: ['MTN'] }) === null
    && filterFor('cod_deposit', { provider: ['MTN'] }) === null);

t.assert('gateway reaches payouts by their transfer aggregator', () =>
    json(filterFor('payout', { gateway: ['notchpay'] })).includes('"transfer_gateway"')
    && filterFor('cod_remittance', { gateway: ['notchpay'] }) === null);

t.assert('a lower-cased gateway still matches — the four spellings, by equality', () =>
    json(caseVariants(['notchpay']).sort()) === json(['NOTCHPAY', 'Notchpay', 'notchpay'])
    && caseVariants(['Orange']).includes('ORANGE') && caseVariants(['ORANGE']).includes('Orange')
    && clauses(filterFor('payment', { gateway: ['notchpay'] })).some((c) =>
        Array.isArray((c.gateway as Document | undefined)?.$in) && (c.gateway as Document).$in.includes('NOTCHPAY')));

t.assert('no filter on this list is a pattern — nothing builds a $regex', () =>
    !/\$regex|new RegExp\(|containsInsensitive/.test(
        read(SRC, 'modules', 'money', 'domain', 'transaction-sources.ts').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')));

t.assert('outcome translates to the kind\'s own statuses', () =>
    clauses(filterFor('payout', { outcome: ['failed'] })).some((c) => json(c) === json({ status: { $in: ['failed', 'rejected'] } }))
    && clauses(filterFor('payment', { outcome: ['succeeded', 'reversed'] })).some((c) => json(c) === json({ status: { $in: ['SUCCEEDED', 'REFUNDED'] } }))
    && clauses(filterFor('ledger_entry', { outcome: ['succeeded'] })).some((c) => json(c).includes('"entry_type"')));

t.assert('an outcome a kind cannot have skips it', () =>
    filterFor('ledger_entry', { outcome: ['failed'] }) === null
    && filterFor('refund', { outcome: ['reversed'] }) === null
    && filterFor('delivery_fee_refund', { outcome: ['failed'] }) === null);

t.assert('`unknown` selects exactly the statuses no bucket names', () => {
    const clause = clauses(filterFor('payout', { outcome: ['unknown'] })).find((c) => json(c).includes('$nin'));
    return clause !== undefined
        && json([...(clause.status as Document).$nin].sort()) === json(['failed', 'paid', 'pending', 'processing', 'rejected']);
});

t.assert('status is the source\'s own word on the source\'s own field', () =>
    clauses(filterFor('payout', { status: ['paid'] })).some((c) => json(c) === json({ status: { $in: ['paid'] } }))
    && clauses(filterFor('ledger_entry', { status: ['hold'] })).some((c) => json(c) === json({ entry_type: { $in: ['hold'] } })));

t.assert('reasonCode: a derived code becomes its predicate', () =>
    clauses(filterFor('payment', { reasonCode: ['delivery_topup'] })).some((c) => json(c) === json({ purpose: 'order_delivery_topup' }))
    && clauses(filterFor('payout', { reasonCode: ['payout_auto_threshold'] })).some((c) => json(c) === json({ origin: 'auto_threshold' }))
    && clauses(filterFor('cod_deposit', { reasonCode: ['cod_deposit_to_platform'] })).some((c) => json(c) === json({ recipient: 'platform' })));

t.assert('...a code that IS the whole kind adds nothing, and a code of another kind skips this one', () =>
    json(filterFor('refund', { reasonCode: ['refund'] })) === json(filterFor('refund'))
    && filterFor('payment', { reasonCode: ['refund'] }) === null
    && filterFor('refund', { reasonCode: ['order_payment'] }) === null);

t.assert('...and the ledger\'s own reason codes pass through', () =>
    clauses(filterFor('ledger_entry', { reasonCode: ['hold_release', 'order_split'] })).some((c) =>
        json(c) === json({ reason_code: { $in: ['hold_release', 'order_split'] } })));

t.assert('the amount comparisons land on each kind\'s own amount field', () =>
    clauses(filterFor('payment', { amountGt: 5000 })).some((c) => json(c) === json({ amountSnapshot: { $gt: 5000 } }))
    && clauses(filterFor('plan_purchase', { amountMin: 1, amountMax: 9 })).some((c) => json(c) === json({ price: { $gte: 1, $lte: 9 } }))
    && clauses(filterFor('refund', { amount: 700 })).some((c) => json(c) === json({ refundAmount: { $eq: 700 } }))
    && clauses(filterFor('ledger_entry', { amountLt: 3 })).some((c) => json(c) === json({ amount: { $lt: 3 } })));

t.assert('orderId matches BOTH payment linkages — a cart checkout sets orderIds, not orderId', () => {
    const clause = clauses(filterFor('payment', { orderId: OID })).find((c) => Array.isArray(c.$or));
    return clause !== undefined && json(clause).includes('"orderId"') && json(clause).includes('"orderIds"');
});

t.assert('orderId reaches refunds, delivery-fee refunds and the ledger, and skips kinds with no order', () =>
    filterFor('refund', { orderId: OID }) !== null
    && json(filterFor('delivery_fee_refund', { orderId: OID })).includes('"order_id"')
    && json(filterFor('ledger_entry', { orderId: OID })).includes('"source_type":"order"')
    && filterFor('payout', { orderId: OID }) === null
    && filterFor('plan_purchase', { orderId: OID }) === null
    && filterFor('cod_remittance', { orderId: OID }) === null);

t.assert('bookingId reaches payments, refunds and the ledger only', () =>
    filterFor('payment', { bookingId: OID }) !== null
    && filterFor('refund', { bookingId: OID }) !== null
    && json(filterFor('ledger_entry', { bookingId: OID })).includes('"source_type":"booking"')
    && filterFor('delivery_fee_refund', { bookingId: OID }) === null);

t.assert('reference is exact, against every reference the kind carries', () => {
    const clause = clauses(filterFor('payment', { reference: 'jm_pt_abc' })).find((c) => Array.isArray(c.$or));
    return clause !== undefined
        && json(clause) === json({ $or: [{ gatewayRef: 'jm_pt_abc' }, { merchantRef: 'jm_pt_abc' }] })
        && filterFor('ledger_entry', { reference: 'jm_pt_abc' }) === null;
});

t.assert('two $or-shaped terms survive together — composed with $and, never by assignment', () => {
    const all = clauses(filterFor('payment', { orderId: OID, reference: 'ref-1' }));
    return all.filter((c) => Array.isArray(c.$or)).length === 2;
});

t.assert('⚠ a delivery-fee refund is only ever a hand-settled or still-owed one — never a gateway-settled row (D-3)', () => {
    const base = clauses(filterFor('delivery_fee_refund'))[0];
    return json(base) === json({
        status: { $in: ['manual_required', 'completed'] },
        $or: [{ status: 'manual_required' }, { 'settlement.method': { $in: [...HAND_SETTLEMENT_METHODS] } }],
    }) && !(HAND_SETTLEMENT_METHODS as readonly string[]).includes('covered_by_order_refund');
});

t.assert('the four hand methods are jovi-mall\'s settlement methods minus the one that moves no money', () => {
    const source = read(JOVI, 'modules', 'delivery-fee-proposals', 'domain', 'customer-fee-change.rules.ts');
    const block = /MANUAL_REFUND_SETTLEMENT_METHODS[^=]*=\s*\[([\s\S]*?)\]/.exec(source);
    const payments = /MANUAL_REFUND_PAYMENT_METHODS[^=]*=\s*\[([\s\S]*?)\]/.exec(source);
    const literals = (text: string | undefined): string[] => Array.from((text ?? '').matchAll(/'([a-z_]+)'/g)).map((m) => m[1]);
    const upstream = literals(payments?.[1]).length > 0 ? literals(payments?.[1]) : literals(block?.[1]).filter((m) => m !== 'covered_by_order_refund');
    return upstream.length === 4 && json([...upstream].sort()) === json([...HAND_SETTLEMENT_METHODS].sort());
});

// ─────────────────────────────────────────────────────────────────────────────
t.section('4. The status buckets cover jovi-mall\'s vocabularies — read from its source');

/** The string literals of the first `enum: [...]` after `marker` in a jovi-mall model. */
function upstreamEnum(file: string[], marker: string): string[] {
    const source = read(JOVI, ...file);
    const at = source.indexOf(marker);
    const match = at < 0 ? null : /enum:\s*\[([^\]]*)\]/.exec(source.slice(at));
    return match ? Array.from(match[1].matchAll(/'([A-Za-z_]+)'/g)).map((m) => m[1]) : [];
}
/** The literals of an exported `const NAME = [...]`. */
function upstreamConst(file: string[], name: string): string[] {
    const match = new RegExp(`${name}\\s*=\\s*\\[([^\\]]*)\\]`).exec(read(JOVI, ...file));
    return match ? Array.from(match[1].matchAll(/'([A-Za-z_]+)'/g)).map((m) => m[1]) : [];
}

const UPSTREAM_STATUSES: Record<TransactionKind, string[]> = {
    payment: upstreamEnum(['modules', 'payments', 'models', 'payment-transaction.model.ts'], '\n  status: {'),
    plan_purchase: upstreamEnum(['modules', 'billing', 'models', 'plan-purchase.model.ts'], 'status: { type: String'),
    credit_topup: upstreamEnum(['modules', 'billing', 'models', 'credit-topup.model.ts'], 'status: { type: String'),
    refund: upstreamEnum(['modules', 'payments', 'models', 'refund-transaction.model.ts'], 'status: {'),
    delivery_fee_refund: ['manual_required', 'completed'],
    payout: upstreamConst(['modules', 'earnings', 'models', 'payout-request.model.ts'], 'PAYOUT_REQUEST_STATUSES'),
    cod_deposit: upstreamEnum(['modules', 'cod', 'models', 'agent-deposit.model.ts'], 'status: {'),
    cod_remittance: upstreamEnum(['modules', 'cod', 'models', 'agency-remittance.model.ts'], 'status: {'),
    cod_collection: upstreamEnum(['modules', 'cod', 'models', 'cash-collection.model.ts'], 'status: {'),
    ledger_entry: upstreamEnum(['modules', 'earnings', 'models', 'earnings-ledger.model.ts'], 'entry_type: {'),
    // The base filter reads two of the model's three kinds; the third is always a ledger row (§ 4 below).
    earnings_adjustment: upstreamEnum(['modules', 'earnings', 'models', 'earnings-adjustment.model.ts'], 'kind: {')
        .filter((kind) => kind !== 'refund_clawback'),
};

for (const kind of TRANSACTION_KINDS) {
    const upstream = UPSTREAM_STATUSES[kind];
    const unbucketed = upstream.filter((status) => outcomeOf(TRANSACTION_SOURCES[kind], status) === 'unknown');
    t.assert(
        `${kind}: every upstream status has a bucket (${upstream.length} read; unbucketed: ${unbucketed.join(', ') || 'none'})`,
        () => upstream.length >= 2 && unbucketed.length === 0,
    );
}

t.assert('no status sits in two buckets of one kind', () =>
    TRANSACTION_KINDS.every((kind) => {
        const all = Object.values(TRANSACTION_SOURCES[kind].outcomes).flat();
        return new Set(all).size === all.length;
    }));

t.assert('a status nobody bucketed reads `unknown` — never guessed into another word', () =>
    outcomeOf(TRANSACTION_SOURCES.payment, 'SOME_NEW_STATE') === 'unknown'
    && (TRANSACTION_OUTCOMES as readonly string[]).includes('unknown'));

t.assert('the ledger\'s reason codes and the source types it links are still what the model declares', () => {
    const reasons = upstreamEnum(['modules', 'earnings', 'models', 'earnings-ledger.model.ts'], 'reason_code: {');
    const sources = upstreamEnum(['modules', 'earnings', 'models', 'earnings-ledger.model.ts'], 'source_type: {');
    return reasons.includes('order_split') && reasons.includes('hold_release')
        // `agency_claim` (2026-10-22): a damage claim's credit to the vendor and fee to the platform.
        // The feed links no order for it — its `source` carries the type and the claim id.
        && json([...sources].sort()) === json(['agency_claim', 'booking', 'cod_collection', 'order', 'shipment']);
});

t.assert('the ledger owner types are the four roles plus the two platform accounts', () => {
    const owners = upstreamEnum(['modules', 'earnings', 'models', 'earnings-ledger.model.ts'], 'owner_type: {');
    return json([...owners].sort()) === json(['agency', 'agent', 'platform', 'platform_ai', 'vendor'])
        && PLATFORM_OWNER_TYPES.every((type) => owners.includes(type));
});

t.assert('D-1 still holds: nothing in jovi-mall\'s billing module writes a payment transaction', () => {
    const service = read(JOVI, 'modules', 'billing', 'services', 'credit-topup.service.ts');
    const code = service.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    return !/PaymentTransaction|payment_transaction_id/.test(code);
});

t.assert('D-2 still holds: the refund service creates no payout request', () => {
    const service = read(JOVI, 'modules', 'payments', 'services', 'refund-request.service.ts');
    const code = service.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    return !/PayoutRequest/.test(code);
});

t.assert('D-3 still holds: settling a delivery-fee refund by hand writes no refund transaction', () => {
    const service = read(JOVI, 'modules', 'delivery-fee-proposals', 'services', 'delivery-fee-refund-admin.service.ts');
    const code = service.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    return !/RefundTransaction/.test(code);
});

// ─────────────────────────────────────────────────────────────────────────────
t.section('5. Paging — the cursor walk is exact');

t.assert('a cursor round-trips, and garbage decodes to null rather than throwing', () => {
    const cursor = { sort: '-amount', value: 12500.5, id: OID };
    return json(decodeCursor(encodeCursor(cursor))) === json(cursor)
        && decodeCursor('') === null
        && decodeCursor('%%%') === null
        && decodeCursor(Buffer.from('["-amount","12",1]').toString('base64url')) === null
        && decodeCursor(Buffer.from('{"sort":"x"}').toString('base64url')) === null;
});

t.assert('every source sorts on its own field with the id as the tiebreak, in the same direction', () =>
    json(mongoSortOf(TRANSACTION_SOURCES.payment, { field: 'amount', direction: -1 })) === json({ amountSnapshot: -1, _id: -1 })
    && json(mongoSortOf(TRANSACTION_SOURCES.payout, { field: 'createdAt', direction: 1 })) === json({ created_at: 1, _id: 1 }));

t.assert('the keyset is "strictly after (value, id)" — a Date for createdAt, a number for amount', () => {
    const byDate = keysetClause(TRANSACTION_SOURCES.payment, { field: 'createdAt', direction: -1 }, { sort: '-createdAt', value: 1000, id: OID });
    const byAmount = keysetClause(TRANSACTION_SOURCES.plan_purchase, { field: 'amount', direction: 1 }, { sort: 'amount', value: 500, id: OID });
    const [older, tie] = byDate.$or as Document[];
    return older.createdAt.$lt instanceof Date && older.createdAt.$lt.getTime() === 1000
        && tie.createdAt instanceof Date && tie._id.$lt instanceof ObjectId
        && json(byAmount.$or[0]) === json({ price: { $gt: 500 } })
        && (byAmount.$or[1] as Document).price === 500 && (byAmount.$or[1] as Document)._id.$gt instanceof ObjectId;
});

/**
 * The property test. Three "collections" of rows with deliberate ties — the same instant and
 * the same amount across sources — walked page by page exactly as the controller does:
 * each source answers "the first `limit + 1` rows after the cursor", the merge takes `limit`.
 * The concatenated pages must equal the one global ordering, with nothing twice or missing.
 */
function hexId(n: number): string {
    return n.toString(16).padStart(24, '0');
}
const UNIVERSE: TransactionCandidate[][] = [[], [], []];
const KINDS_USED: TransactionKind[] = ['payment', 'payout', 'ledger_entry'];
for (let i = 0; i < 97; i++) {
    UNIVERSE[i % 3].push({
        kind: KINDS_USED[i % 3],
        row: {},
        // Only 7 distinct instants and 5 distinct amounts across 97 rows: ties everywhere.
        value: 0,
        id: hexId((i * 7919) % 100003),
    });
}
function walk(sort: TransactionSort, limit: number, key: (index: number) => number): { pages: number; ids: string[]; expected: string[] } {
    const sources = UNIVERSE.map((rows) => rows.map((row, i) => ({ ...row, value: key(Number.parseInt(row.id, 16) + i) })));
    const order = (a: TransactionCandidate, b: TransactionCandidate): number =>
        a.value !== b.value
            ? (a.value - b.value) * sort.direction
            : a.id === b.id ? 0 : (a.id < b.id ? -1 : 1) * sort.direction;
    const expected = sources.flat().sort(order).map((row) => row.id);

    const ids: string[] = [];
    let cursor: ReturnType<typeof decodeCursor> = null;
    let pages = 0;
    for (;;) {
        const after = cursor;
        const perSource = sources.map((rows) =>
            rows
                .filter((row) => !after || order(row, { ...row, value: after.value, id: after.id }) > 0)
                .sort(order)
                .slice(0, limit + 1));
        const page = mergeTransactionPage(perSource, sort, limit);
        ids.push(...page.items.map((row) => row.id));
        pages++;
        if (!page.nextCursor || pages > 200) break;
        cursor = decodeCursor(page.nextCursor);
    }
    return { pages, ids, expected };
}

const WALKS: Array<[string, TransactionSort, (n: number) => number]> = [
    ['newest first', { field: 'createdAt', direction: -1 }, (n) => 1_700_000_000_000 + (n % 7) * 1000],
    ['oldest first', { field: 'createdAt', direction: 1 }, (n) => 1_700_000_000_000 + (n % 7) * 1000],
    ['largest first', { field: 'amount', direction: -1 }, (n) => (n % 5) * 2500],
    ['smallest first', { field: 'amount', direction: 1 }, (n) => (n % 5) * 2500],
];
for (const [name, sort, key] of WALKS) {
    for (const limit of [1, 7, 20, 100]) {
        const result = walk(sort, limit, key);
        t.assert(`${name}, ${limit} per page: every row once, in order (${result.pages} pages)`, () =>
            result.ids.length === 97
            && new Set(result.ids).size === 97
            && json(result.ids) === json(result.expected));
    }
}

t.assert('a page is exactly `limit` long while more remain, and the last one carries no cursor', () => {
    const rows: TransactionCandidate[] = [1, 2, 3].map((n) => ({ kind: 'payment', row: {}, value: n, id: hexId(n) }));
    const first = mergeTransactionPage([rows], { field: 'amount', direction: 1 }, 2);
    const all = mergeTransactionPage([rows], { field: 'amount', direction: 1 }, 3);
    return first.items.length === 2 && first.nextCursor !== null && all.items.length === 3 && all.nextCursor === null;
});

t.assert('the cursor names the sort it was issued under', () => {
    const rows: TransactionCandidate[] = [1, 2].map((n) => ({ kind: 'payment', row: {}, value: n, id: hexId(n) }));
    const sort: TransactionSort = { field: 'amount', direction: -1 };
    const page = mergeTransactionPage([rows], sort, 1);
    return decodeCursor(page.nextCursor ?? '')?.sort === sortToken(sort) && sortToken(sort) === '-amount';
});

t.assert('the window is always resolved: defaults to the last 366 days, and a lone `from` is capped', () => {
    const now = new Date('2026-10-12T00:00:00.000Z');
    const none = resolveWindow(undefined, undefined, now);
    const onlyTo = resolveWindow(undefined, TO, now);
    const oldFrom = resolveWindow(new Date('2024-01-01T00:00:00.000Z'), undefined, now);
    const recentFrom = resolveWindow(new Date('2026-10-01T00:00:00.000Z'), undefined, now);
    const day = 86_400_000;
    return none.to.getTime() === now.getTime() && (none.to.getTime() - none.from.getTime()) / day === 366
        && onlyTo.to.getTime() === TO.getTime() && (onlyTo.to.getTime() - onlyTo.from.getTime()) / day === 366
        && (oldFrom.to.getTime() - oldFrom.from.getTime()) / day === 366
        && recentFrom.to.getTime() === now.getTime()
        && json(resolveWindow(FROM, TO, now)) === json({ from: FROM, to: TO });
});

// ─────────────────────────────────────────────────────────────────────────────
t.section('6. The wire shape, and what never leaves the database');

function undefinedPaths(value: unknown, path = ''): string[] {
    if (value === null || typeof value !== 'object') return [];
    if (Array.isArray(value)) return value.flatMap((item, i) => undefinedPaths(item, `${path}[${i}]`));
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
        child === undefined ? [`${path}.${key}`] : undefinedPaths(child, `${path}.${key}`));
}

const CREATED = new Date('2026-06-01T00:00:00.000Z');
/** The least each collection can hold — every optional field absent. */
const MINIMAL: Record<TransactionKind, Document> = {
    payment: { _id: oid(OID), userId: oid(OTHER_OID), gateway: 'NOTCHPAY', method: 'mobile_money', gatewayRef: 'g-1', status: 'SUCCEEDED', amountSnapshot: 5000, currencySnapshot: 'XAF', createdAt: CREATED },
    plan_purchase: { _id: oid(OID), owner_type: 'vendor', owner_id: oid(OTHER_OID), plan_id: oid(OID), plan_code: 'pro', price: 10000, currency: 'XAF', status: 'pending', created_at: CREATED },
    credit_topup: { _id: oid(OID), owner_type: 'agency', owner_id: oid(OTHER_OID), pack_code: 'p100', credits: 100, price: 2000, currency: 'XAF', status: 'paid', created_at: CREATED },
    refund: { _id: oid(OID), vendorId: oid(OID), userId: oid(OTHER_OID), refundAmount: 700, currency: 'XAF', status: 'completed', initiatedBy: oid(OID), initiatedByRole: 'vendor', createdAt: CREATED },
    delivery_fee_refund: { _id: oid(OID), order_id: oid(OTHER_OID), customer_id: oid(OID), vendor_id: oid(OID), amount: 500, currency: 'XAF', status: 'manual_required', created_at: CREATED },
    payout: { _id: oid(OID), owner_type: 'agent', owner_id: oid(OTHER_OID), amount: 30000, currency: 'XAF', status: 'failed', origin: 'manual', created_at: CREATED },
    cod_deposit: { _id: oid(OID), agent_id: oid(OTHER_OID), agency_id: oid(OID), amount: 8000, recipient: 'agency', status: 'declared', created_at: CREATED },
    cod_remittance: { _id: oid(OID), agency_id: oid(OTHER_OID), amount: 90000, status: 'confirmed', created_at: CREATED },
    cod_collection: { _id: oid(OID), order_id: oid(OTHER_OID), shipment_id: oid(OID), agency_id: oid(OID), agent_id: oid(OTHER_OID), customer_id: oid(OID), vendor_id: oid(OID), expected_amount: 15000, currency: 'XAF', status: 'pending', created_at: CREATED },
    earnings_adjustment: { _id: oid(OID), refund_key: 'write_off:665c0f000000000000000009', allocation_id: null, beneficiary_type: 'vendor', beneficiary_id: oid(OTHER_OID), amount: 2500, currency: 'XAF', kind: 'write_off', created_at: CREATED },
    ledger_entry: { _id: oid(OID), account_id: oid(OTHER_OID), owner_type: 'platform', entry_type: 'hold', amount: 100, pending_after: 100, available_after: 0, source_type: 'order', source_id: oid(OID), allocation_id: oid(OTHER_OID), reason_code: 'order_split', created_at: CREATED },
};
const NO_CONTEXT = { names: new Map<string, string | null>(), currencies: new Map<string, string>() };
const ROW_KEYS = ['amount', 'completedAt', 'createdAt', 'currency', 'direction', 'gateway', 'group', 'id', 'kind', 'links', 'merchantRef', 'method', 'outcome', 'party', 'provider', 'reason', 'reference', 'status'];
const LINK_KEYS = ['agencyId', 'agentId', 'allocationId', 'bookingId', 'orderIds', 'paymentTransactionId', 'payoutId', 'planId', 'refundRequestId', 'shipmentId', 'ticketId', 'vendorId'];

for (const kind of TRANSACTION_KINDS) {
    const row = TRANSACTION_SOURCES[kind].toRow(MINIMAL[kind], NO_CONTEXT);
    t.assert(`${kind}: a minimal row maps to all 18 fields and all 12 links, null where empty and never absent`, () =>
        json(Object.keys(row).sort()) === json(ROW_KEYS)
        && json(Object.keys(row.links).sort()) === json(LINK_KEYS)
        && undefinedPaths(row).length === 0
        && row.kind === kind && row.id === OID && row.createdAt === CREATED.toISOString()
        && row.amount > 0 && Array.isArray(row.links.orderIds));
}

const rowOf = (kind: TransactionKind, extra: Document = {}, context = NO_CONTEXT) =>
    TRANSACTION_SOURCES[kind].toRow({ ...MINIMAL[kind], ...extra }, context);

t.assert('direction is the platform\'s side: payments and remittances in, refunds and payouts out, the ledger internal', () =>
    rowOf('payment').direction === 'in' && rowOf('plan_purchase').direction === 'in' && rowOf('credit_topup').direction === 'in'
    && rowOf('cod_remittance').direction === 'in'
    && rowOf('refund').direction === 'out' && rowOf('delivery_fee_refund').direction === 'out' && rowOf('payout').direction === 'out'
    && rowOf('ledger_entry').direction === 'internal');

t.assert('direction never follows the status — a failed payment is still `in`, and says so in `outcome`', () => {
    const failed = rowOf('payment', { status: 'FAILED' });
    return failed.direction === 'in' && failed.outcome === 'failed' && failed.status === 'FAILED';
});

t.assert('a deposit to the agency is internal; the same deposit to the platform is in', () =>
    rowOf('cod_deposit').direction === 'internal' && rowOf('cod_deposit').reason.code === 'cod_deposit_to_agency'
    && rowOf('cod_deposit', { recipient: 'platform' }).direction === 'in'
    && rowOf('cod_deposit', { recipient: 'platform' }).reason.code === 'cod_deposit_to_platform');

t.assert('the row a filter selects is the row the mapper labels — direction and reason agree both ways', () =>
    json(filterFor('cod_deposit', { direction: ['in'] })).includes('platform')
    && rowOf('payment', { bookingId: oid(OID) }).reason.code === 'booking_payment'
    && rowOf('payment', { purpose: 'booking_balance', bookingId: oid(OID) }).reason.code === 'booking_balance'
    && rowOf('payment', { purpose: 'order_delivery_topup', orderId: oid(OID) }).reason.code === 'delivery_topup'
    && rowOf('payment').reason.code === 'order_payment'
    && rowOf('payout', { origin: 'auto_threshold' }).reason.code === 'payout_auto_threshold'
    && rowOf('payout').reason.code === 'payout_manual');

t.assert('a cart payment lists every order it settled; a single-order one lists one', () =>
    json(rowOf('payment', { orderIds: [oid(OID), oid(OTHER_OID)] }).links.orderIds) === json([OID, OTHER_OID])
    && json(rowOf('payment', { orderId: oid(OTHER_OID) }).links.orderIds) === json([OTHER_OID]));

t.assert('a refund carries its gross, its channel as the method, and the payment it reversed', () => {
    const row = rowOf('refund', { channel: 'payout', paymentTransactionId: oid(OTHER_OID), reason: 'damaged', refundRequestId: oid(OID), orderId: oid(OID) });
    return row.amount === 700 && row.method === 'payout' && row.links.paymentTransactionId === OTHER_OID
        && row.reason.text === 'damaged' && row.links.refundRequestId === OID && row.links.vendorId === OID;
});

t.assert('a payout says why it failed, and never carries our transfer reference', () => {
    const row = rowOf('payout', { transfer_failure_reason: 'insufficient float', transfer_gateway: 'NOTCHPAY', transfer_gateway_ref: 'np_1' });
    return row.outcome === 'failed' && row.reason.text === 'insufficient float' && row.gateway === 'NOTCHPAY'
        && row.reference === 'np_1' && row.merchantRef === null;
});

t.assert('a ledger row reads its currency off its account, and null when the account is unknown', () =>
    rowOf('ledger_entry').currency === null
    && rowOf('ledger_entry', {}, { names: new Map(), currencies: new Map([[OTHER_OID, 'XAF']]) }).currency === 'XAF'
    && rowOf('ledger_entry').status === 'hold' && rowOf('ledger_entry').outcome === 'succeeded'
    && rowOf('ledger_entry').links.allocationId === OTHER_OID && json(rowOf('ledger_entry').links.orderIds) === json([OID]));

t.assert('the platform\'s bargain-fee account keeps its own role word', () =>
    rowOf('ledger_entry').party.role === 'platform' && rowOf('ledger_entry').party.id === null
    && rowOf('ledger_entry', { owner_type: 'platform_ai' }).party.role === 'platform_ai');

t.assert('a name is the context\'s or null — never invented', () => {
    const named = rowOf('payout', {}, { names: new Map([[`agent:${OTHER_OID}`, 'Jean Dupont']]), currencies: new Map() });
    return named.party.name === 'Jean Dupont' && rowOf('payout').party.name === null && rowOf('payment').party.name === null;
});

t.assert('the six kinds with no page of their own have a record; the five that have one point at it', () => {
    const withRecord = TRANSACTION_KINDS.filter((kind) => TRANSACTION_SOURCES[kind].toRecord !== undefined).sort();
    const withPath = TRANSACTION_KINDS.filter((kind) => TRANSACTION_SOURCES[kind].recordPath !== undefined).sort();
    return json(withRecord) === json(['cod_collection', 'credit_topup', 'earnings_adjustment', 'ledger_entry', 'plan_purchase', 'refund'])
        && json(withPath) === json(['cod_deposit', 'cod_remittance', 'delivery_fee_refund', 'payment', 'payout'])
        && withRecord.every((kind) => !withPath.includes(kind));
});

t.assert('every recordPath is a GET this service really serves', () =>
    TRANSACTION_KINDS.every((kind) => {
        const path = TRANSACTION_SOURCES[kind].recordPath?.(OID);
        if (!path) return true;
        const pattern = `/api/v1${path}`.replace(OID, ':');
        return manifest.some((route) => route.method === 'get' && route.fullPath.replace(/:\w+$/, ':') === pattern);
    }));

t.assert('the records name their fields and carry no undefined', () =>
    (['refund', 'plan_purchase', 'credit_topup', 'ledger_entry', 'cod_collection', 'earnings_adjustment'] as const).every((kind) => {
        const record = TRANSACTION_SOURCES[kind].toRecord!(MINIMAL[kind], NO_CONTEXT);
        return record.kind === kind && undefinedPaths(record).length === 0;
    }));

t.assert('a top-up\'s credits are on the record and are NOT the row amount', () => {
    const record = TRANSACTION_SOURCES.credit_topup.toRecord!(MINIMAL.credit_topup, NO_CONTEXT);
    return record.kind === 'credit_topup' && record.credits === 100 && rowOf('credit_topup').amount === 2000;
});

const SOURCES_FILE = read(SRC, 'modules', 'money', 'domain', 'transaction-sources.ts');

t.assert('every source projection is an inclusion list', () =>
    TRANSACTION_KINDS.every((kind) =>
        Object.values(TRANSACTION_SOURCES[kind].projection).every((value) => value === 1)));

t.assert('⚠ the payout source reads the destination TYPE and provider label and nothing else of it', () => {
    const paths = Object.keys(TRANSACTION_SOURCES.payout.projection).filter((path) => path.startsWith('payout_method_snapshot'));
    return json(paths.sort()) === json(['payout_method_snapshot.method', 'payout_method_snapshot.mobile_money.provider']);
});

t.assert('⚠ ...and no source names a routing value, an account name, or our transfer reference', () =>
    !/phone_number|account_number|account_name|gateway_token|transfer_reference|card_holder_name/.test(
        TRANSACTION_KINDS.map((kind) => Object.keys(TRANSACTION_SOURCES[kind].projection).join(' ')).join(' ')));

t.assert('no source reads a gateway payload, a payload hash or an idempotency key', () =>
    !/rawGatewayPayloads|gatewayPayloadHash|idempotencyKey/.test(SOURCES_FILE));

t.assert('the currency reader projects one label and cannot express a balance', () => {
    const repo = read(SRC, 'modules', 'money', 'repositories', 'transaction.read.repository.ts');
    const block = /ACCOUNT_CURRENCY_PROJECTION\s*=\s*\{([^}]*)\}/.exec(repo);
    return block !== null && block[1].replace(/\s/g, '') === '_id:1,currency:1'
        && !/_balance/.test(repo.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''));
});

// ─────────────────────────────────────────────────────────────────────────────
t.section('7. The summary — a group-by, never a net');

t.assert('the pipeline is the source filter then ONE group on stored fields', () => {
    const pipeline = buildSummaryPipeline(TRANSACTION_SOURCES.payment, { status: 'SUCCEEDED' });
    return pipeline.length === 2 && json(pipeline[0]) === json({ $match: { status: 'SUCCEEDED' } })
        && json(pipeline[1].$group._id) === json({ status: '$status', currency: '$currencySnapshot', direction: null })
        && json(pipeline[1].$group.amount) === json({ $sum: '$amountSnapshot' });
});

t.assert('a deposit groups by recipient, and a ledger entry by no currency', () =>
    buildSummaryPipeline(TRANSACTION_SOURCES.cod_deposit, {})[1].$group._id.direction === '$recipient'
    && buildSummaryPipeline(TRANSACTION_SOURCES.ledger_entry, {})[1].$group._id.currency === null
    && buildSummaryPipeline(TRANSACTION_SOURCES.ledger_entry, {})[1].$group._id.status === '$entry_type');

t.assert('statuses sharing an outcome fold into one cell; different outcomes and currencies stay apart', () => {
    const cells = foldSummary(TRANSACTION_SOURCES.payout, [
        { _id: { status: 'failed', currency: 'XAF', direction: null }, count: 2, amount: 300 },
        { _id: { status: 'rejected', currency: 'XAF', direction: null }, count: 1, amount: 50 },
        { _id: { status: 'paid', currency: 'XAF', direction: null }, count: 4, amount: 1000 },
        { _id: { status: 'paid', currency: 'EUR', direction: null }, count: 1, amount: 10 },
    ]);
    const failed = cells.find((cell) => cell.outcome === 'failed');
    return cells.length === 3 && failed?.count === 3 && failed.amount === 350
        && cells.every((cell) => cell.kind === 'payout' && cell.direction === 'out')
        && cells.filter((cell) => cell.outcome === 'succeeded').length === 2;
});

t.assert('deposit cells split by who received the cash', () => {
    const cells = foldSummary(TRANSACTION_SOURCES.cod_deposit, [
        { _id: { status: 'confirmed', currency: 'XAF', direction: 'platform' }, count: 1, amount: 100 },
        { _id: { status: 'confirmed', currency: 'XAF', direction: 'agency' }, count: 5, amount: 900 },
    ]);
    return cells.length === 2
        && cells.find((cell) => cell.direction === 'in')?.amount === 100
        && cells.find((cell) => cell.direction === 'internal')?.amount === 900;
});

// ─────────────────────────────────────────────────────────────────────────────
t.section('8. The routes');

const routes = manifest.filter((route) => route.fullPath.startsWith('/api/v1/money/transactions'));

t.assert('three routes, all GET', () =>
    routes.length === 3 && routes.every((route) => route.method === 'get')
    && json(routes.map((route) => route.fullPath).sort()) === json([
        '/api/v1/money/transactions',
        '/api/v1/money/transactions/:kind/:id',
        '/api/v1/money/transactions/summary',
    ]));

t.assert('each opens on ANY of the five existing reads — no permission of its own', () =>
    routes.every((route) =>
        route.access.kind === 'permission' && route.access.mode === 'any'
        && json([...route.access.permissions].sort()) === json([...TRANSACTION_DOOR_PERMISSIONS].sort())));

const CONTROLLER = read(SRC, 'modules', 'money', 'controllers', 'transaction.controller.ts').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

t.assert('the controller filters nothing after the database — no row is dropped from a page it was paged into', () =>
    // `related` de-duplicates by identity; that is the one `.filter` over candidates, and it is not a query term.
    (CONTROLLER.match(/\.items\)?\s*\.filter\(/g) ?? []).length <= 1
    && !/toRows\([^)]*\)\.filter\(/.test(CONTROLLER));

t.assert('every one of the three handlers builds its viewer from the permissions the caller\'s tier holds', () =>
    (CONTROLLER.match(/viewerOf\(admin\)/g) ?? []).length === 3
    && /viewerFor\(\(permission\) => hasPermission\(admin\.tier, permission\)\)/.test(CONTROLLER));

t.assert('the detail read refuses a kind the caller may not read BEFORE it touches the database', () => {
    const detail = CONTROLLER.slice(CONTROLLER.indexOf('static detail'));
    return detail.indexOf('AUTHZ_PERMISSION_DENIED') > 0
        && detail.indexOf('AUTHZ_PERMISSION_DENIED') < detail.indexOf('.findById(');
});

t.assert('...and a platform-owned row below tier 1 is a 404, not a row', () =>
    /isPlatformOwned\(kind, row\) && !viewer\.seesPlatformAccounts/.test(CONTROLLER));

t.assert('every response says what was withheld', () =>
    (CONTROLLER.match(/withheld: withheldFor\(viewer\)/g) ?? []).length === 3);

// ─────────────────────────────────────────────────────────────────────────────
t.section('9. The two kinds the owner added (BR-030 § 1 · § 2)');

const COD_ROW = rowOf('cod_collection');
t.assert('a COD collection is cash, internal, paid by the customer, and links the agent holding it', () =>
    COD_ROW.group === 'cash' && COD_ROW.direction === 'internal'
    && COD_ROW.party.role === 'customer' && COD_ROW.party.id === OID
    && COD_ROW.links.agentId === OTHER_OID && COD_ROW.links.agencyId === OID && COD_ROW.links.vendorId === OID
    && COD_ROW.links.shipmentId === OID && json(COD_ROW.links.orderIds) === json([OTHER_OID]));

t.assert('its amount is the expected amount, and it is `succeeded` once collected, with the collection instant', () => {
    const collected = rowOf('cod_collection', { status: 'collected', collected_at: new Date('2026-06-02T00:00:00.000Z') });
    return COD_ROW.amount === 15000 && COD_ROW.outcome === 'pending' && COD_ROW.completedAt === null
        && collected.outcome === 'succeeded' && collected.completedAt === '2026-06-02T00:00:00.000Z'
        && rowOf('cod_collection', { status: 'cancelled' }).outcome === 'failed';
});

t.assert('a legacy collection with no `kind` is a goods payment; a fee-only one says so', () =>
    COD_ROW.reason.code === 'cod_order_payment'
    && rowOf('cod_collection', { kind: 'delivery_fee' }).reason.code === 'cod_delivery_fee'
    && clauses(filterFor('cod_collection', { reasonCode: ['cod_order_payment'] })).some((c) => json(c) === json({ kind: { $ne: 'delivery_fee' } })));

t.assert('`direction=in` never returns a collection — the same cash becomes `in` only at the remittance', () =>
    filterFor('cod_collection', { direction: ['in'] }) === null
    && filterFor('cod_collection', { direction: ['internal'] }) !== null
    && filterFor('cod_collection', { group: ['cash'], orderId: OID }) !== null);

t.assert('its record splits the amount and names the agent; a pre-split row reads as all goods', () => {
    const record = TRANSACTION_SOURCES.cod_collection.toRecord!(
        { ...MINIMAL.cod_collection, settled_amount: 5000 },
        { names: new Map([[`agent:${OTHER_OID}`, 'Paul Rider']]), currencies: new Map() },
    );
    const split = TRANSACTION_SOURCES.cod_collection.toRecord!(
        { ...MINIMAL.cod_collection, kind: 'delivery_fee', items_amount: 0, delivery_fee_amount: 15000 },
        NO_CONTEXT,
    );
    return record.kind === 'cod_collection' && record.collects === 'order' && record.itemsAmount === 15000
        && record.deliveryFeeAmount === 0 && record.settledAmount === 5000 && record.agent.name === 'Paul Rider'
        && split.kind === 'cod_collection' && split.collects === 'delivery_fee' && split.itemsAmount === 0 && split.deliveryFeeAmount === 15000;
});

t.assert('⚠ the collection source never names the delivery code or the verification block', () => {
    const fields = Object.keys(TRANSACTION_SOURCES.cod_collection.projection);
    return fields.every((field) => !/code|verification|device|location|\bip\b/.test(field))
        && Object.values(TRANSACTION_SOURCES.cod_collection.projection).every((value) => value === 1);
});

const WRITE_OFF = rowOf('earnings_adjustment', { reason: 'Vendor closed; balance unrecoverable', actor: { id: 'adm1', name: 'Ama' } });
const RECOVERY = rowOf('earnings_adjustment', { kind: 'clawback_recovery', refund_key: `recovery:payout:${OTHER_OID}:rejected`, reason: null });

t.assert('a write-off is internal, owned by the debtor, and carries the administrator\'s reason', () =>
    WRITE_OFF.group === 'internal' && WRITE_OFF.direction === 'internal' && WRITE_OFF.outcome === 'succeeded'
    && WRITE_OFF.party.role === 'vendor' && WRITE_OFF.party.id === OTHER_OID
    && WRITE_OFF.reason.code === 'debt_write_off' && WRITE_OFF.reason.text === 'Vendor closed; balance unrecoverable'
    && WRITE_OFF.links.payoutId === null);

t.assert('a payout-driven recovery links the payout, parsed from the key', () =>
    RECOVERY.reason.code === 'debt_recovered_from_payout' && RECOVERY.links.payoutId === OTHER_OID
    && rowOf('earnings_adjustment', { kind: 'clawback_recovery', refund_key: 'recovery:payout:not-an-id' }).links.payoutId === null);

t.assert('the records say who forgave it, or which payout event paid it', () => {
    const writeOff = TRANSACTION_SOURCES.earnings_adjustment.toRecord!({ ...MINIMAL.earnings_adjustment, actor: { id: 'adm1', name: 'Ama' } }, NO_CONTEXT);
    const recovery = TRANSACTION_SOURCES.earnings_adjustment.toRecord!(
        { ...MINIMAL.earnings_adjustment, kind: 'clawback_recovery', refund_key: `recovery:payout:${OTHER_OID}:ticket_failed` }, NO_CONTEXT);
    return writeOff.kind === 'earnings_adjustment' && writeOff.actor?.name === 'Ama' && writeOff.payoutEvent === null
        && recovery.kind === 'earnings_adjustment' && recovery.actor === null && recovery.payoutEvent === 'ticket_failed';
});

t.assert('⚠ the base filter is exactly "a write-off, or a recovery with no allocation" — never a clawback', () =>
    json(clauses(filterFor('earnings_adjustment'))[0]) === json({
        kind: { $in: ['write_off', 'clawback_recovery'] },
        $or: [{ kind: 'write_off' }, { allocation_id: null }],
    }));

/**
 * The "no adjustment appears twice" claim rests on facts about jovi-mall's WRITERS, read out of
 * its source. If one of them changes, the base filter above has to change with it, and these are
 * the assertions that say so.
 */
const strip = (code: string): string => code.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
const ACCOUNT_SERVICE = strip(read(JOVI, 'modules', 'earnings', 'services', 'earnings-account.service.ts'));
const CLAWBACK_SERVICE = strip(read(JOVI, 'modules', 'earnings', 'services', 'earnings-clawback.service.ts'));
/** From a method's signature to the next method declared at the same indent. */
function bodyOf(code: string, signature: string): string {
    const at = code.indexOf(signature);
    if (at < 0) return '';
    const rest = code.slice(at + signature.length);
    const next = rest.search(/\n {2}(async |private |public |static )*[a-zA-Z]+\(/);
    return next < 0 ? code.slice(at) : code.slice(at, at + signature.length + next);
}

t.assert('jovi-mall: a write-off writes NO ledger row (so it is this kind)', () => {
    const body = bodyOf(CLAWBACK_SERVICE, 'async writeOff(') + bodyOf(ACCOUNT_SERVICE, 'async writeOffInSession(');
    return body.length > 200 && body.includes("kind: 'write_off'") && !body.includes('ledgerRepo.create');
});

t.assert('jovi-mall: a payout returned to available records its recovery with no allocation and NO ledger row', () => {
    const body = bodyOf(ACCOUNT_SERVICE, 'async revertPayoutToAvailableInSession(');
    return body.includes("kind: 'clawback_recovery'") && body.includes('allocation_id: null') && !body.includes('ledgerRepo.create');
});

t.assert('jovi-mall: a recovery WITH an allocation writes a ledger row beside it (so it stays `ledger_entry`)', () => {
    const body = bodyOf(ACCOUNT_SERVICE, 'private async recordRecovery(');
    return body.includes('ledgerRepo.create') && body.includes("entry_type: 'clawback_recovery'") && body.includes('allocation_id: allocation._id');
});

t.assert('jovi-mall: exactly three adjustment writers set `allocation_id: null` — write-off, payout recovery, vendor overflow', () =>
    (ACCOUNT_SERVICE.match(/allocation_id: null/g) ?? []).length + (CLAWBACK_SERVICE.match(/allocation_id: null/g) ?? []).length === 3);

t.assert('jovi-mall: the vendor-overflow clawback files a ledger row when it has a share to file it under (so it is NOT this kind)', () =>
    /if \(ledgerHome\)\s*\{[\s\S]*ledgerRepo\.create/.test(bodyOf(ACCOUNT_SERVICE, 'async clawBeyondInSession(')));

// ─────────────────────────────────────────────────────────────────────────────
t.section('10. The platform\'s take on the order split — rates, not amounts (BR-030 § 3b)');

const SPLIT = {
    order: { id: OID, vendorId: OID },
    charged: { items: 20000, delivery: 1000, deliveryInCash: 0, total: 21000 },
    sections: [{
        key: 'payment',
        goods: {
            gross: 20000,
            bargainFee: { percent: 30, amount: 600, lines: [{ orderItemId: 'i1', unitPrice: 12000, floorPrice: 10000, quantity: 1, uplift: 2000, fee: 600 }] },
            commission: { percent: 10, base: 19400, amount: 1940 },
            deliveryFeeCharged: 0, codHandlingFee: 0, vendorNet: 17460,
        },
        delivery: null,
        lines: [
            { role: 'bargain_fee', beneficiary: { type: 'platform_ai', id: null, name: null }, amount: 600, clawedAmount: 0, status: 'held' },
            { role: 'commission', beneficiary: { type: 'platform', id: null, name: null }, amount: 1940, clawedAmount: 100, status: 'held' },
            { role: 'vendor_net', beneficiary: { type: 'vendor', id: OID, name: 'Shop' }, amount: 17460, clawedAmount: 0, status: 'held' },
            { role: 'delivery_agent', beneficiary: { type: 'agent', id: null, name: null }, amount: null, clawedAmount: 0, status: 'projected' },
        ],
    }],
    adjustments: [
        { kind: 'refund_clawback', beneficiary: { type: 'platform', id: null }, amount: 100, goodsAmount: 100, deliveryAmount: 0, takenFrom: { pending: 100, reserve: 0, available: 0, debt: 0 } },
        { kind: 'refund_clawback', beneficiary: { type: 'vendor', id: OID }, amount: 900, goodsAmount: 900, deliveryAmount: 0, takenFrom: { pending: 900, reserve: 0, available: 0, debt: 0 } },
    ],
    totals: { platform: { commission: 1840, bargainFee: 600, total: 2440 }, vendor: 16560, agencies: 0, agents: 0, customerRefunds: 0, reversed: 1000 },
    reconciliation: { charged: 21000, distributed: 19000, difference: 2000, complete: false },
    bargainFeePercent: 30,
};
type Loose = Record<string, unknown>;
const HELD = withholdPlatformAmounts(SPLIT) as unknown as Loose;
const KEPT = withPlatformAmounts(SPLIT) as unknown as Loose;
const heldSection = (HELD.sections as Loose[])[0];
const heldLines = heldSection.lines as Loose[];

t.assert('below the permission: no platform line states an amount, and each says it was withheld', () =>
    heldLines.filter((line) => ['bargain_fee', 'commission'].includes(String(line.role)))
        .every((line) => line.amount === null && line.clawedAmount === null && line.withheld === true));

t.assert('...the goods basis keeps both rates and the base, and loses the two amounts and every bargained item\'s fee', () => {
    const goods = heldSection.goods as Record<string, Loose>;
    const items = goods.bargainFee.lines as Loose[];
    return goods.bargainFee.percent === 30 && goods.commission.percent === 10 && goods.commission.base === 19400
        && goods.bargainFee.amount === null && goods.commission.amount === null
        && items.every((item) => item.fee === null && item.uplift === 2000 && item.unitPrice === 12000)
        && goods.bargainFee.withheld === true && goods.commission.withheld === true;
});

t.assert('...`totals.platform` is null, and an adjustment against a platform account has no amounts', () => {
    const [platformClaw, vendorClaw] = HELD.adjustments as Loose[];
    return (HELD.totals as Loose).platform === null
        && platformClaw.amount === null && platformClaw.takenFrom === null && platformClaw.withheld === true
        && vendorClaw.amount === 900 && vendorClaw.withheld === undefined;
});

t.assert('...everybody else\'s figures are untouched — the vendor, the agent\'s not-yet-known share, the reconciliation', () => {
    const vendor = heldLines.find((line) => line.role === 'vendor_net')!;
    const agent = heldLines.find((line) => line.role === 'delivery_agent')!;
    return vendor.amount === 17460 && vendor.withheld === undefined
        && agent.amount === null && agent.withheld === undefined
        && json(HELD.reconciliation) === json(SPLIT.reconciliation) && HELD.bargainFeePercent === 30
        && (HELD.totals as Loose).vendor === 16560;
});

t.assert('the response says which it is, both ways', () =>
    HELD.platformAmountsWithheld === true && KEPT.platformAmountsWithheld === false
    && json({ ...KEPT, platformAmountsWithheld: undefined }) === json({ ...SPLIT, platformAmountsWithheld: undefined }));

t.assert('the input is never mutated', () =>
    SPLIT.sections[0].lines[1].amount === 1940 && SPLIT.totals.platform.total === 2440
    && SPLIT.sections[0].goods.bargainFee.lines[0].fee === 600);

t.assert('a shape it does not know is passed through rather than thrown on', () => {
    const odd = withholdPlatformAmounts({ sections: 'nope', totals: null, adjustments: undefined, extra: 1 } as Loose) as Loose;
    return odd.extra === 1 && odd.platformAmountsWithheld === true;
});

t.assert('⚠ the split handler withholds unless the caller holds the platform-amounts permission', () => {
    const controller = strip(read(SRC, 'modules', 'money', 'controllers', 'money.controller.ts'));
    const handler = controller.slice(controller.indexOf('static orderSplit'), controller.indexOf('static earningsAccounts'));
    // The whole statement, anchored — `true || hasPermission(…)` or a second assignment must not pass.
    return /const seesPlatformAmounts = hasPermission\(requireAdminIdentity\(req\)\.tier, PLATFORM_AMOUNTS_PERMISSION\);/.test(handler)
        && (handler.match(/seesPlatformAmounts/g) ?? []).length === 2
        && /sendSuccess\(res, seesPlatformAmounts \? withPlatformAmounts\(named\) : withholdPlatformAmounts\(named\)\);/.test(handler)
        && (handler.match(/sendSuccess\(/g) ?? []).length === 1;
});

process.exit(t.finish());
