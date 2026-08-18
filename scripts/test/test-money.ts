/**
 * Earnings, payouts and gateway settlements — the rules, with no infrastructure.
 *
 * The most valuable of Phase 11's suites, because this is the module where getting it
 * wrong discloses a beneficiary's bank account number or pays somebody twice. Six things
 * it exists to pin:
 *
 *   §2  the filters compose with `$and`, so a term is never dropped by assignment, and
 *       `unsettledOnly` pushes BOTH of its terms.
 *   §3  **the ban list.** Four field names must not appear anywhere in `src/modules/money/`,
 *       two more may appear EXACTLY ONCE and only inside `PAYOUT_DESTINATION_PROJECTION`,
 *       and neither must the whole-subdocument projection forms that would drag them back
 *       in. A projection is a string literal and no compiler checks one.
 *   §4  `toMaskedDestinationDto` emits `full: null, revealed: false` for EVERY input,
 *       including one carrying a plaintext number — the second of the two locks, which has
 *       to hold even if somebody widens the projection that is the first. And its
 *       counterpart `toRevealedDestinationDto`, the one function that discloses, agrees
 *       with jovi-mall's own masker on a fixed vector — run out of its source, not retyped.
 *   §5  every optional field is present-and-null on a minimal source row (ADR-005 D-16).
 *       `JSON.stringify` drops `undefined` silently, so a missing `?? null` ships a
 *       response with a key removed and looks fine in every eyeball test.
 *   §6  `LARGE_PAYOUT.when` on the five inputs that matter, and that the inlined threshold
 *       still equals jovi-mall's `AUTO_PAYOUT_THRESHOLD` — read out of its source, not
 *       retyped here.
 *   §7  the audit and permission catalogs say what the routes assume they say.
 *
 *   npm run test:money
 */
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { ObjectId } from 'mongodb';
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
    ALLOCATION_SORT,
    LEDGER_SORT,
    ListAllocationsQuerySchema,
    ListEarningsAccountsQuerySchema,
    ListPaymentsQuerySchema,
    ListPayoutActivityQuerySchema,
    ListPayoutsQuerySchema,
    ListPlatformLedgerQuerySchema,
    ListRefundsQuerySchema,
    MONEY_MAX_RANGE_DAYS,
    MarkPaidSchema,
    PAYMENT_SORT,
    PAYOUT_AUDIT_ACTIONS,
    PAYOUT_SORT,
    REFUND_SORT,
    RejectPayoutSchema,
} from '../../src/modules/money/validators/money.validator';
import {
    buildAllocationFilter,
    buildLedgerFilter,
} from '../../src/modules/money/repositories/earnings.read.repository';
import { buildPayoutFilter } from '../../src/modules/money/repositories/payout-request.read.repository';
import {
    buildPaymentFilter,
    buildRefundFilter,
} from '../../src/modules/money/repositories/payment-transaction.read.repository';
import {
    formatMaskedCardNumber,
    maskTail,
    revealedMethodsOf,
    toMaskedDestinationDto,
    toRevealedDestinationDto,
} from '../../src/modules/money/read-models/payout-destination.dto';
import {
    MoneyOwnerNames,
    toAllocationDetailDto,
    toAllocationDto,
    toLedgerEntryDto,
    toPaymentDetailDto,
    toPaymentDto,
    toPayoutListItemDto,
    toRefundDto,
} from '../../src/modules/money/read-models/money.dto';
import { auditSpec, isAuditAction } from '../../src/modules/audit/domain/audit.catalog';
import { toAuditRow } from '../../src/modules/audit/domain/audit.writer';
import { subjectClassOf } from '../../src/modules/audit/domain/audit-subject';
import { PERMISSION_CATALOG, permissionSpec } from '../../src/modules/authorization/domain/permission.catalog';
import { isSensitive } from '../../src/modules/authorization/domain/permission.types';
import { TIER_GRANTS } from '../../src/modules/authorization/domain/tier-grants';
import { LEGACY_ENDPOINT_MAP } from '../../src/modules/authorization/domain/legacy-endpoint-map';
import { dualControlHandlerFor } from '../../src/modules/dual-control/domain/dual-control.registry';
import { routeManifest } from '../../src/api/route-manifest';
import '../../src/modules/money/routes/money.routes';

const t = suite('money');

const SRC = join(__dirname, '..', '..', 'src');
const JOVI = join(__dirname, '..', '..', '..', 'jovi-mall', 'src');
const MONEY_DIR = [SRC, 'modules', 'money'];

function read(...segments: string[]): string {
    return readFileSync(join(...segments), 'utf8');
}

function readCode(...segments: string[]): string {
    return read(...segments)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
}

// The files a targeted assertion reads on its own. The MODULE-WIDE scans below do not use
// these — they walk the directory, so a file added later is covered without an edit here.
const PAYOUT_REPO = [...MONEY_DIR, 'repositories', 'payout-request.read.repository.ts'];
const MONEY_DTO = [...MONEY_DIR, 'read-models', 'money.dto.ts'];
const DESTINATION_DTO = [...MONEY_DIR, 'read-models', 'payout-destination.dto.ts'];
const MONEY_GATEWAY = [...MONEY_DIR, 'gateways', 'money.gateway.ts'];
const MONEY_ROUTES = [...MONEY_DIR, 'routes', 'money.routes.ts'];
const MONEY_VALIDATOR = [...MONEY_DIR, 'validators', 'money.validator.ts'];
const DUAL_CONTROL = [...MONEY_DIR, 'domain', 'payout-dual-control.ts'];
const DISCLOSURE = [...MONEY_DIR, 'domain', 'payout-disclosure.ts'];

/**
 * Every `.ts` file under `src/modules/money/`, WALKED rather than listed.
 *
 * This was a hand-maintained array and that was a hole in the guard below: a file added to
 * the module later — `domain/payout-disclosure.ts` is exactly that — would never be scanned,
 * so the ban list would go on passing while the one file that actually reads a beneficiary's
 * account number sat outside it. A scan whose coverage depends on somebody remembering to
 * extend it is not a scan.
 */
function moneySourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) return moneySourceFiles(full);
        return entry.isFile() && full.endsWith('.ts') ? [full] : [];
    });
}

const MONEY_FILES = moneySourceFiles(join(...MONEY_DIR));

/** Every source file in the money module, comments stripped — for the ban-list scans. */
const MONEY_MODULE_SOURCE = MONEY_FILES.map((path) => readCode(path)).join('\n');

const OID = '507f1f77bcf86cd799439011';
const OTHER_OID = '507f1f77bcf86cd799439012';
const base = { page: 1, limit: 20, sort: { field: 'createdAt', direction: -1 as const } };

/**
 * Just enough of a Zod schema to hold several of them in one array.
 *
 * Every list schema here is a differently-shaped `ZodEffects<ZodObject<…>>`, so a
 * `typeof ListPayoutsQuerySchema[]` does not typecheck across them — and widening to `any`
 * would turn a renamed method into a passing assertion. This names the one member the
 * assertions below actually use.
 */
interface Parsable {
    safeParse(value: unknown): { success: boolean };
}

const RANGED_LISTS: Parsable[] = [
    ListPayoutsQuerySchema,
    ListAllocationsQuerySchema,
    ListPlatformLedgerQuerySchema,
    ListPaymentsQuerySchema,
    ListRefundsQuerySchema,
    ListPayoutActivityQuerySchema,
];

function clauses(filter: unknown): Record<string, unknown>[] {
    const asAnd = filter as { $and?: Record<string, unknown>[] };
    if (Array.isArray(asAnd.$and)) return asAnd.$and;
    return [filter as Record<string, unknown>];
}

function hasClause(filter: unknown, predicate: (clause: Record<string, unknown>) => boolean): boolean {
    return clauses(filter).some(predicate);
}

// ─────────────────────────────────────────────────────────────────────────────
t.section('1. The query schemas');

t.assert('the payout queue defaults to newest first', () => {
    const parsed = ListPayoutsQuerySchema.safeParse({});
    return parsed.success && parsed.data.sort.field === 'createdAt' && parsed.data.sort.direction === -1;
});

t.assert('every sort allowlist refuses a field it does not declare', () => {
    const cases: [Parsable, string][] = [
        [ListPayoutsQuerySchema, 'ownerId'],
        [ListAllocationsQuerySchema, 'beneficiaryId'],
        [ListPlatformLedgerQuerySchema, 'reasonCode'],
        [ListPaymentsQuerySchema, 'gatewayRef'],
        [ListRefundsQuerySchema, 'vendorId'],
    ];
    return cases.every(([schema, field]) => !schema.safeParse({ sort: field }).success);
});

/**
 * `payment_transactions` stores camelCase field names — it predates the platform's
 * snake_case convention and was never migrated. The map therefore LOOKS like an identity
 * mapping and is not one: `amount` on the wire is `amountSnapshot` in Mongo, and a sort that
 * translated it to `amount` would silently order by a field no document has.
 */
t.assert('PAYMENT_SORT maps the wire name to the camelCase column, not to itself', () =>
    PAYMENT_SORT.amount === 'amountSnapshot'
    && PAYMENT_SORT.createdAt === 'createdAt'
    && REFUND_SORT.amount === 'refundAmount');

t.assert('...while the snake_case collections keep their own spelling', () =>
    PAYOUT_SORT.createdAt === 'created_at'
    && ALLOCATION_SORT.holdReleaseAt === 'hold_release_at'
    && LEDGER_SORT.createdAt === 'created_at');

t.assert('a range wider than a year is refused on every list that takes one', () => {
    const from = '2026-01-01T00:00:00.000Z';
    const to = '2027-06-01T00:00:00.000Z';
    return RANGED_LISTS.every((schema) => !schema.safeParse({ from, to }).success)
        && MONEY_MAX_RANGE_DAYS === 366;
});

t.assert('...and so is a `to` that is not after `from`', () =>
    !ListPayoutsQuerySchema.safeParse({
        from: '2026-06-01T00:00:00.000Z',
        to: '2026-06-01T00:00:00.000Z',
    }).success);

t.assert('unsettledOnly defaults to false rather than being absent', () => {
    const parsed = ListAllocationsQuerySchema.safeParse({});
    return parsed.success && parsed.data.unsettledOnly === false;
});

/**
 * `z.coerce.boolean()` applies JavaScript truthiness, so `'false'` becomes `true`. On this
 * filter that would turn "everything" into "only the stuck ones" — or the reverse — with a
 * 200 either way.
 */
t.assert('...and the string "false" means false, not truthy', () => {
    const parsed = ListAllocationsQuerySchema.safeParse({ requiresCashSettlement: 'false' });
    return parsed.success && parsed.data.requiresCashSettlement === false;
});

/**
 * THE most important schema assertion in this file.
 *
 * `LARGE_PAYOUT.when` reads the amount out of a payload the controller builds from the ROW.
 * If the body could carry an amount, a caller could name 1,999,999 on a 5,000,000 payout and
 * skip the second administrator. `.strict()` is what makes that a 400 rather than a
 * silently ignored key.
 */
t.assert('mark-paid REFUSES an amount in the body — the threshold is not client-supplied', () =>
    !MarkPaidSchema.safeParse({ amount: 1_999_999 }).success
    && !MarkPaidSchema.safeParse({ reference: 'ok', amount: 1 }).success);

t.assert('...while a bare body and a reference-only body both pass', () =>
    MarkPaidSchema.safeParse({}).success
    && MarkPaidSchema.safeParse({ reference: 'BNK-2026-0001' }).success);

t.assert('rejecting requires a reason and refuses an empty one', () =>
    !RejectPayoutSchema.safeParse({}).success
    && !RejectPayoutSchema.safeParse({ reason: '   ' }).success
    && RejectPayoutSchema.safeParse({ reason: 'Destination unreachable' }).success);

t.assert('the delegated accounts list takes page/limit/ownerType and nothing else', () =>
    ListEarningsAccountsQuerySchema.safeParse({ ownerType: 'agency' }).success
    && !ListEarningsAccountsQuerySchema.safeParse({ sort: '-createdAt' }).success);

/**
 * The activity filter is DERIVED from the audit catalog rather than typed out, so a fourth
 * `money.payouts.*` action widens it automatically. A hand-maintained copy is how the
 * dashboard ends up unable to filter on a row it is already showing.
 */
t.assert('the payout activity filter is derived from the audit catalog', () =>
    PAYOUT_AUDIT_ACTIONS.includes('money.payouts.mark_paid')
    && PAYOUT_AUDIT_ACTIONS.includes('money.payouts.reject')
    && PAYOUT_AUDIT_ACTIONS.includes('money.payouts.destination.read')
    && PAYOUT_AUDIT_ACTIONS.every((action) => action.startsWith('money.payouts.'))
    && !readCode(...MONEY_VALIDATOR).includes("'money.payouts.mark_paid'"));

// ─────────────────────────────────────────────────────────────────────────────
t.section('2. The filters — pure, and composed with $and');

t.assert('an unfiltered payout query is the empty filter, never `{ $and: [] }`', () => {
    const filter = buildPayoutFilter({ ...base });
    return Object.keys(filter).length === 0;
});

t.assert('two payout terms compose with $and rather than by assignment', () => {
    const filter = buildPayoutFilter({ ...base, status: 'pending', ownerType: 'agency' });
    return clauses(filter).length === 2;
});

t.assert('the payout window is half-open [from, to)', () => {
    const from = new Date('2026-06-01T00:00:00.000Z');
    const to = new Date('2026-07-01T00:00:00.000Z');
    const filter = buildPayoutFilter({ ...base, from, to });
    const range = clauses(filter).find((c) => 'created_at' in c)?.created_at as Record<string, Date>;
    return range.$gte === from && range.$lt === to && !('$lte' in range);
});

/**
 * A malformed id becomes a term matching nothing rather than a thrown BSONError. Every id
 * reaching these builders through a route has already passed `objectId` at the edge, so this
 * is only reachable from a hand-built query — and an empty result is the honest answer there.
 */
t.assert('a malformed id becomes a term that matches nothing', () => {
    const filter = buildPayoutFilter({ ...base, ownerId: 'not-an-id' });
    const term = clauses(filter)[0].owner_id as { $in: unknown[] };
    return Array.isArray(term.$in) && term.$in.length === 0;
});

/**
 * The owner terms are not the caller's — the route already decided whose ledger this is —
 * and building them inside the filter is what stops a future caller composing a query that
 * reads every owner's rows at once.
 */
t.assert('the ledger filter always carries both owner terms, even with no filters at all', () => {
    const filter = buildLedgerFilter('platform', null, { ...base });
    const all = clauses(filter);
    return all.length === 2
        && all.some((c) => c.owner_type === 'platform')
        && all.some((c) => 'owner_id' in c && c.owner_id === null);
});

t.assert('...and a real owner id is an ObjectId term, not the null one', () => {
    const filter = buildLedgerFilter('vendor', OID, { ...base });
    const term = clauses(filter).find((c) => 'owner_id' in c)?.owner_id;
    return term !== null && String(term) === OID;
});

/**
 * `requires_cash_settlement: true` alone includes every COD allocation the platform has
 * already been paid for, which is most of them. The second term is what narrows it to the
 * money that has not arrived, and pairing the two is exactly what a client gets subtly
 * wrong while still rendering a plausible page.
 */
t.assert('unsettledOnly pushes BOTH terms — required AND not yet settled', () => {
    const filter = buildAllocationFilter({ ...base, unsettledOnly: true });
    return hasClause(filter, (c) => c.requires_cash_settlement === true)
        && hasClause(filter, (c) => 'cash_settled_at' in c && c.cash_settled_at === null);
});

t.assert('...and it does not cancel a contradicting requiresCashSettlement=false', () => {
    const filter = buildAllocationFilter({ ...base, unsettledOnly: true, requiresCashSettlement: false });
    return hasClause(filter, (c) => c.requires_cash_settlement === false)
        && hasClause(filter, (c) => c.requires_cash_settlement === true);
});

t.assert('an unfiltered allocation query is the empty filter', () =>
    Object.keys(buildAllocationFilter({ ...base, unsettledOnly: false })).length === 0);

/**
 * A cart checkout writes ONE payment for N orders and sets `orderIds`, never `orderId` —
 * which is the majority of orders on the platform. A filter on `orderId` alone answers "no
 * payment" for most of them.
 */
t.assert('an order filter matches BOTH payment linkages', () => {
    const filter = buildPaymentFilter({ ...base, orderId: OID });
    const or = clauses(filter)[0].$or as Record<string, unknown>[];
    return or.length === 2 && 'orderId' in or[0] && 'orderIds' in or[1];
});

t.assert('...and it composes with $and beside another term, so neither is dropped', () => {
    const filter = buildPaymentFilter({ ...base, orderId: OID, status: 'SUCCEEDED' });
    return clauses(filter).length === 2 && hasClause(filter, (c) => '$or' in c);
});

/**
 * `completedAt` is unset on a `pending` and on a `failed` refund, so ranging on it would
 * silently drop exactly the rows somebody opens this list to find.
 */
t.assert('the refund window ranges on createdAt, never on completedAt', () => {
    const filter = buildRefundFilter({
        ...base,
        from: new Date('2026-06-01T00:00:00.000Z'),
        vendorId: OTHER_OID,
    });
    return hasClause(filter, (c) => 'createdAt' in c)
        && !hasClause(filter, (c) => 'completedAt' in c);
});

// ─────────────────────────────────────────────────────────────────────────────
t.section('3. What leaves the database — the ban list');

t.assert('the scan walks the whole module — every file, not a list somebody maintains', () =>
    MONEY_FILES.length >= 10
    && MONEY_FILES.some((f) => f.endsWith('payout-disclosure.ts'))
    && MONEY_FILES.some((f) => f.endsWith('money.controller.ts')));

/**
 * The four names that must appear NOWHERE, and they are not all credentials — which is
 * exactly what makes them easy to project by accident.
 *
 * `gateway_token` is a PULL credential against a card, and nobody sends money *to* one, so
 * it is never disclosed — not even by the unmask. The other three are gateway internals:
 * `rawGatewayPayloads` is unbounded third-party JSON, `gatewayPayloadHash` is
 * webhook-verification material, and `idempotencyKey` lets a caller suppress or collide a
 * legitimate write.
 */
const NEVER_READ = ['gateway_token', 'rawGatewayPayloads', 'gatewayPayloadHash', 'idempotencyKey'];

t.assert('four names appear nowhere in the money module at all', () =>
    NEVER_READ.every((field) => !MONEY_MODULE_SOURCE.includes(field)));

/**
 * The two routing values — where money is actually SENT. With an account name, either is
 * enough to social-engineer a redirect.
 *
 * **Exactly one occurrence each**, both in `PAYOUT_DESTINATION_PROJECTION`, which is the one
 * projection in the service that may name them. This assertion asserted ZERO through step 5,
 * when no code could read them at all; step 6 added the audited disclosure endpoint and this
 * is its relaxed form — still refusing them everywhere else.
 *
 * Matched as the full DOTTED PATH rather than the bare name, deliberately: the disclosure
 * read renames the values to `revealed_bank_account_number` / `revealed_mobile_money_number`
 * on the way out, and `revealed_bank_account_number` CONTAINS the substring
 * `account_number`. A bare-name count would report three and be unreadable; the dotted path
 * is what actually names jovi-mall's field.
 */
const DISCLOSURE_PATHS = [
    'payout_method_snapshot.mobile_money.phone_number',
    'payout_method_snapshot.bank.account_number',
];

function occurrences(haystack: string, needle: string): number {
    return haystack.split(needle).length - 1;
}

t.assert('each routing value is named exactly once in the whole module', () =>
    DISCLOSURE_PATHS.every((path) => occurrences(MONEY_MODULE_SOURCE, path) === 1));

/**
 * …and that one occurrence is inside the disclosure projection. Counting alone would pass if
 * the single mention migrated to a controller or a mapper, which is the move this is really
 * guarding against.
 */
t.assert('...and that occurrence is inside PAYOUT_DESTINATION_PROJECTION', () => {
    const source = readCode(...PAYOUT_REPO);
    const start = source.indexOf('PAYOUT_DESTINATION_PROJECTION');
    const block = source.slice(start, source.indexOf('} as const', start));
    return start > 0 && DISCLOSURE_PATHS.every((path) => occurrences(block, path) === 1);
});

t.assert('...so the rest of the module names neither of them', () => {
    const source = readCode(...PAYOUT_REPO);
    const start = source.indexOf('PAYOUT_DESTINATION_PROJECTION');
    const block = source.slice(start, source.indexOf('} as const', start));
    const everythingElse = MONEY_MODULE_SOURCE.replace(block, '');
    return DISCLOSURE_PATHS.every((path) => !everythingElse.includes(path));
});

/**
 * The whole-subdocument forms. A dotted whitelist is only a whitelist while every path in
 * it is dotted — `payout_method_snapshot: 1` beside the careful ones would return the
 * plaintext MSISDN and the compiler would not care.
 */
t.assert('...and neither does any whole-subdocument projection that would drag them back in', () =>
    !/payout_method_snapshot:\s*1|mobile_money:\s*1|\bbank:\s*1|\bcard:\s*1/.test(MONEY_MODULE_SOURCE));

/**
 * Every projection is an inclusion list. An exclusion protects only what somebody thought
 * of, so a sensitive field added to one of these collections next year would arrive on the
 * wire on its own. Scanned per BLOCK — the module legitimately writes `total: 0` elsewhere.
 */
t.assert('every projection in this module is a whitelist, never an exclusion', () => {
    const source = MONEY_MODULE_SOURCE;
    const blocks = source.match(/_PROJECTION\s*=\s*\{[\s\S]*?\}\s*as const/g) ?? [];
    return blocks.length >= 6 && blocks.every((block) => !/:\s*(0|false)\s*[,}]/.test(block));
});

/**
 * The LIST projection specifically — the one every ordinary payout read goes through.
 *
 * It names every label and not one routing value, which is what makes
 * `toMaskedDestinationDto` unable to leak rather than merely careful not to.
 */
t.assert('the payout LIST projection names the destination LABELS and no routing value', () => {
    const source = readCode(...PAYOUT_REPO);
    const start = source.indexOf('PAYOUT_LIST_PROJECTION');
    const block = source.slice(start, source.indexOf('} as const', start));
    return start > 0
        && block.includes("'payout_method_snapshot.mobile_money.provider': 1")
        && block.includes("'payout_method_snapshot.bank.bank_name': 1")
        && block.includes("'payout_method_snapshot.card.last4': 1")
        && [...DISCLOSURE_PATHS, ...NEVER_READ].every((field) => !block.includes(field));
});

t.assert('the DTOs name their fields — no spread of a read model', () =>
    !/\.\.\.row[,\s}]/.test(readCode(...MONEY_DTO))
    && !/\.\.\.snapshot[,\s}]/.test(readCode(...DESTINATION_DTO)));

/**
 * `cash_collections` holds the customer's plaintext COD delivery OTP, and `select: false`
 * does not protect it from the raw driver. The strongest form of the guarantee is that this
 * module cannot leak a field of a collection it cannot point a repository at.
 */
t.assert('the money module declares NO projection of cash_collections or user_payment_methods', () =>
    !MONEY_MODULE_SOURCE.includes('CASH_COLLECTION')
    && !MONEY_MODULE_SOURCE.includes('USER_PAYMENT_METHOD')
    && !MONEY_MODULE_SOURCE.includes('code_plain'));

// ─────────────────────────────────────────────────────────────────────────────
t.section('4. The destination DTO — the second lock');

/**
 * A snapshot carrying every plaintext value, which the projection means production never
 * produces. The mapper must drop all of it anyway: the projection is the lock that holds in
 * production, and this one is the lock that holds if somebody widens it.
 */
const LEAKY_SNAPSHOT = {
    method: 'mobile_money',
    mobile_money: { provider: 'MTN', account_name: 'Jean Dupont', phone_number: '237670123456' },
    bank: { bank_name: 'Afriland', account_name: 'Jean Dupont', country: 'CM', account_number: '1234567890' },
    card: null,
} as never;

t.assert('toMaskedDestinationDto emits full: null and revealed: false, plaintext or not', () => {
    const dto = toMaskedDestinationDto(LEAKY_SNAPSHOT);
    return dto !== null && dto.full === null && dto.revealed === false;
});

t.assert('...and no field of its output contains any substring of the plaintext', () => {
    const rendered = JSON.stringify(toMaskedDestinationDto(LEAKY_SNAPSHOT));
    return !rendered.includes('237670123456')
        && !rendered.includes('670123456')
        && !rendered.includes('1234567890')
        && !rendered.includes('3456');
});

/**
 * `null`, not `'••••3456'`. This mapper never receives the digits — the projection did not
 * read them — so it cannot render a last-four, and saying `null` is the honest answer.
 * jovi-mall's own admin queue still shows the last four; this service trades that for the
 * stronger property that the list path cannot leak what it never read.
 */
t.assert('the masked values are null, and the LABELS still come through', () => {
    const dto = toMaskedDestinationDto(LEAKY_SNAPSHOT);
    return dto?.masked.mobileMoney?.phoneNumberMasked === null
        && dto?.masked.mobileMoney?.provider === 'MTN'
        && dto?.masked.mobileMoney?.accountName === 'Jean Dupont'
        && dto?.masked.bank?.accountNumberMasked === null
        && dto?.masked.bank?.bankName === 'Afriland';
});

/**
 * A card is the exception that needs no exception made for it: jovi-mall never stores a PAN
 * (that would put the whole database in PCI-DSS scope), so `last4` is the entire number that
 * exists and rendering it is not a disclosure.
 */
t.assert('a card renders its last4 in full, because that IS the whole number stored', () => {
    const dto = toMaskedDestinationDto({
        method: 'card',
        mobile_money: null,
        bank: null,
        card: { brand: 'visa', last4: '4242', card_holder_name: 'J Dupont', expiry_month: 4, expiry_year: 2030, issuing_bank: null, country: 'CM' },
    });
    return dto?.masked.card?.last4 === '4242'
        && dto?.masked.card?.numberMasked === formatMaskedCardNumber('4242')
        && dto?.full === null;
});

/**
 * A legacy payout predating the snapshot carries no destination at all. `null` says so,
 * where an object full of nulls would read as "a destination with no details".
 */
t.assert('no snapshot at all is null, not an empty destination', () =>
    toMaskedDestinationDto(null) === null && toMaskedDestinationDto(undefined) === null);

/**
 * Drift guard against jovi-mall's own formatter, read out of its source. Separate packages,
 * no shared library — so this is a second implementation of a one-line format, and the
 * duplication is named rather than pretended away.
 */
t.assert('formatMaskedCardNumber agrees with jovi-mall on a fixed vector', () => {
    const source = read(JOVI, 'core', 'types', 'payout.types.ts');
    const match = /export function formatMaskedCardNumber\(last4: string\): string \{\s*return `([^`]*)`;/
        .exec(source);
    if (!match) return false;
    return match[1].replace('${last4}', '3456') === formatMaskedCardNumber('3456');
});

// ─────────────────────────────────────────────────────────────────────────────
t.section('5. The disclosure mapper — the one function that reveals');

/**
 * What `PayoutDestinationReadRepository` actually returns: the LABELS nested exactly as the
 * list projection leaves them, and the two routing values RENAMED to top-level fields.
 *
 * The rename is not cosmetic and this fixture is the shape that proves it — `phone_number`
 * and `account_number` are named once each in the whole module, in the projection that
 * produces this, and nowhere in the mapper under test.
 */
const REVEALED_LABELS = {
    method: 'mobile_money',
    mobile_money: { provider: 'MTN', account_name: 'Jean Dupont' },
    bank: { bank_name: 'Afriland', account_name: 'Jean Dupont', country: 'CM' },
    card: null,
};

const REVEALED_ROW = {
    _id: oidLike(OID),
    payout_method_snapshot: REVEALED_LABELS,
    revealed_mobile_money_number: '237670123456',
    revealed_bank_account_number: '1234567890',
} as never;

/** `_id` only has to be an ObjectId-shaped value here; no mapper on this path reads it. */
function oidLike(hex: string): unknown {
    return { toString: () => hex };
}

t.assert('toRevealedDestinationDto puts the routing values in `full`, and says so', () => {
    const dto = toRevealedDestinationDto(REVEALED_ROW);
    return dto?.revealed === true
        && dto.full?.mobileMoney?.phoneNumber === '237670123456'
        && dto.full?.bank?.accountNumber === '1234567890';
});

/**
 * `revealed` is the discriminator and it is never inferred from `full` being non-null —
 * a mapper that forgot to set it would then look like a masked one, which is the wrong
 * direction for a mistake to fail in.
 */
t.assert('...while the masked mapper on the SAME labels still says revealed: false', () => {
    const masked = toMaskedDestinationDto(REVEALED_LABELS as never);
    return masked?.revealed === false
        && masked.full === null
        && masked.masked.mobileMoney?.phoneNumberMasked === null;
});

/**
 * The masked half is delegated to `toMaskedDestinationDto`, so the labels cannot disagree
 * between the two paths — and only the two values this path has are overridden.
 */
t.assert('...and the masked half now renders the tails, because the digits WERE read', () => {
    const dto = toRevealedDestinationDto(REVEALED_ROW);
    return dto?.masked.mobileMoney?.phoneNumberMasked === '••••••••3456'
        && dto.masked.bank?.accountNumberMasked === '••••••7890'
        && dto.masked.mobileMoney?.provider === 'MTN'
        && dto.masked.bank?.bankName === 'Afriland';
});

/**
 * §8 of the phase plan names this one explicitly. `card.gateway_token` is a PULL credential
 * — nobody sends money *to* a token — so a card destination is fully answered by the labels
 * and the disclosure has nothing to add. `revealed: true` with an empty `full` is the honest
 * report: the permission was used, and there was nothing further to give.
 */
t.assert('a CARD payout reveals nothing — full.card is null even on the disclosure', () => {
    const dto = toRevealedDestinationDto({
        _id: oidLike(OID),
        payout_method_snapshot: {
            method: 'card',
            mobile_money: null,
            bank: null,
            card: { brand: 'visa', last4: '4242', card_holder_name: 'J Dupont', expiry_month: 4, expiry_year: 2030, issuing_bank: null, country: 'CM' },
        },
    } as never);
    return dto?.revealed === true
        && dto.full !== null
        && dto.full.card === null
        && dto.full.mobileMoney === null
        && dto.full.bank === null
        && dto.masked.card?.last4 === '4242'
        && revealedMethodsOf(dto).length === 0;
});

/**
 * `full === null` means "not disclosed" and is what every other endpoint emits; here `full`
 * is always an object whose MEMBERS say what there was. A bank-only destination is the case
 * that would break if the two were conflated.
 */
t.assert('a bank-only destination reveals the account and leaves mobileMoney null', () => {
    const dto = toRevealedDestinationDto({
        _id: oidLike(OID),
        payout_method_snapshot: {
            method: 'bank',
            mobile_money: null,
            bank: { bank_name: 'Afriland', account_name: 'Jean Dupont', country: 'CM' },
            card: null,
        },
        revealed_bank_account_number: '10005000123456789',
    } as never);
    return dto?.full?.mobileMoney === null
        && dto.full.bank?.accountNumber === '10005000123456789'
        && dto.masked.mobileMoney === null
        && revealedMethodsOf(dto).join() === 'bank';
});

/**
 * A payout predating the snapshot. `null` here is what the endpoint turns into
 * `PAYOUT_DESTINATION_ABSENT` (422) rather than a 404 — the payout exists and has nothing
 * on file, and a dashboard that could not tell those apart would show "no such payout" for
 * a payout it is displaying.
 */
t.assert('no snapshot at all is null — the 422 path, not an empty destination', () =>
    toRevealedDestinationDto({ _id: oidLike(OID) } as never) === null);

/** The audit row records WHICH KINDS, never the values. This is the whole `after`. */
t.assert('revealedMethodsOf names kinds and can carry no digits at all', () => {
    const kinds = revealedMethodsOf(toRevealedDestinationDto(REVEALED_ROW)!);
    return kinds.join() === 'mobile_money,bank'
        && !JSON.stringify(kinds).includes('3456')
        && !JSON.stringify(kinds).includes('7890');
});

/**
 * **The drift guard, and it RUNS jovi-mall's implementation rather than restating it.**
 *
 * `maskTail` is the fourth copy of a one-line format — jovi-mall holds it privately in
 * `core/types/payout.types.ts`, the two services are separate packages with no shared
 * library, and there is nothing to import. Comparing against a fixed string we typed here
 * would only pin OUR side; extracting their function body and calling it pins BOTH, so the
 * day somebody changes the bullet character or the keep-length on that side, this fails.
 *
 * The four vectors are the plan's: a real MSISDN, exactly the boundary, under it, and empty.
 */
t.assert('maskTail agrees with jovi-mall’s own, run out of its source', () => {
    const source = read(JOVI, 'core', 'types', 'payout.types.ts');
    const match = /function maskTail\(value: string\): string \{([\s\S]*?)\n\}/.exec(source);
    if (!match) return false;

    const theirs = new Function('value', match[1]) as unknown as (value: string) => string;
    return ['237670123456', '1234', '12', ''].every((vector) => theirs(vector) === maskTail(vector));
});

/** …and the two vectors the plan states outright, so a rewrite of the guard cannot lose them. */
t.assert('...on the two vectors the plan names: a full MSISDN, and anything ≤ 4 characters', () =>
    maskTail('237670123456') === '••••••••3456'
    && maskTail('1234') === '••••'
    && maskTail('12') === '••••'
    && maskTail('') === '••••');

// ─────────────────────────────────────────────────────────────────────────────
t.section('6. The audited read — fail-closed, and no value on the record');

/**
 * `auditedAttempt`, never `recordEvent`. The transport declared in the catalog is `external`
 * for exactly this: `recordEvent` is best-effort and SWALLOWS a write failure, which is
 * right for a login that already happened on its own terms and wrong where the audit row IS
 * the control. `auditedAttempt` commits the intent first and does not catch it, so with the
 * audit store down `perform()` never runs and nothing is disclosed.
 */
t.assert('the disclosure commits its intent through auditedAttempt, not best-effort', () => {
    const source = readCode(...DISCLOSURE);
    return source.includes('auditedAttempt(intent')
        && !source.includes('recordEvent')
        && !source.includes('trackPending');
});

/**
 * The ORDER is the design, and it is asserted positionally: the repository read must appear
 * INSIDE the `auditedAttempt` callback. A version that read the destination first and
 * audited afterwards would pass every other assertion in this file and would disclose a
 * bank account number with the audit store down.
 */
t.assert('...and the routing values are read INSIDE it, never before', () => {
    const source = readCode(...DISCLOSURE);
    return source.indexOf('auditedAttempt(intent') < source.indexOf('destinations.findById');
});

/**
 * A beneficiary's destination must not reach the audit store — the one place it would then
 * be readable without the permission that gates it, by anyone holding `audit.read`.
 */
t.assert('the audit payload names the payout and the owner, and no destination', () => {
    const source = readCode(...DISCLOSURE);
    const block = source.slice(source.indexOf('payload:'), source.indexOf('return auditedAttempt'));
    return block.includes('payoutId')
        && block.includes('ownerType')
        && block.includes('ownerId')
        && !block.includes('destination')
        && !block.includes('phone')
        && !block.includes('account');
});

t.assert('...and `after` carries the KINDS, never the mapper output', () => {
    const source = readCode(...DISCLOSURE);
    return source.includes('after: { revealedMethods: revealedMethodsOf(destination) }')
        && !/after:\s*\{[^}]*destination[^}]*\}/.test(source.replace('revealedMethodsOf(destination)', ''));
});

/**
 * 422, not 404 — and the 404 comes from the MASKED read, which happens first. That ordering
 * also means a mistyped id never reaches the audit trail as an attempted disclosure, because
 * it is not one.
 */
t.assert('an absent destination is PAYOUT_DESTINATION_ABSENT, after a 404 that came first', () => {
    const source = readCode(...DISCLOSURE);
    return source.includes('ERROR_CODES.PAYOUT_DESTINATION_ABSENT')
        && source.indexOf('loadPayoutOr404') < source.indexOf('auditedAttempt(intent');
});

/**
 * The status is the call site's — `createAppError` takes it as an argument and there is no
 * registry to read it from — so 422 is pinned where it is written. `PAYOUT_DESTINATION_ABSENT`
 * exists to be distinguishable from a 404, and a 404 status on it would silently undo that.
 */
t.assert('...thrown as a 422, which is the entire reason the code exists', () =>
    readCode(...DISCLOSURE).includes('createAppError(ERROR_CODES.PAYOUT_DESTINATION_ABSENT, 422)'));

/**
 * The catalog decides `sensitive`, not the call site — derived from the permission's
 * `financial` flag at write time, because read-scoping and alerting both filter on the
 * column and Mongo cannot join the permission catalog inside a query.
 *
 * Asserted through `toAuditRow` itself rather than by reading the catalog twice: this is the
 * function that actually builds the row, and it is the phase plan's step-6 exit gate stated
 * as an assertion — `sensitive: true`, `subject_class: 'platform_record'`, and NOT delegated.
 */
t.assert('a disclosure row is sensitive, a platform_record, and not delegated', () => {
    const row = toAuditRow(
        {
            action: 'money.payouts.destination.read',
            actor: { kind: 'administrator', id: OID, email: null, displayName: null, tier: 2, sessionId: null },
            target: { type: 'payout', id: OTHER_OID, label: 'XAF 5000 → vendor x' },
            context: { method: 'GET', path: '/api/v1/money/payouts/x/destination', requestId: 'r', ip: null, userAgent: null },
            payload: { payoutId: OTHER_OID, ownerType: 'vendor', ownerId: OID },
        },
        'succeeded',
        { after: { revealedMethods: ['mobile_money'] } },
    );
    return row.sensitive === true
        && row.subject_class === 'platform_record'
        && row.delegated === false
        && row.action_family === 'money';
});

/** The row a reader opens the trail for: which kinds, and nothing that could be sent to. */
t.assert('...and the row it builds carries the kinds and no digits anywhere', () => {
    const row = toAuditRow(
        {
            action: 'money.payouts.destination.read',
            actor: { kind: 'administrator', id: OID, email: null, displayName: null, tier: 2, sessionId: null },
            target: { type: 'payout', id: OTHER_OID, label: null },
            context: { method: 'GET', path: '/x', requestId: 'r', ip: null, userAgent: null },
            payload: { payoutId: OTHER_OID, ownerType: 'vendor', ownerId: OID },
        },
        'succeeded',
        { after: { revealedMethods: ['mobile_money', 'bank'] } },
    );
    const rendered = JSON.stringify(row);
    return (row.after as Record<string, unknown>).revealedMethods !== undefined
        && !rendered.includes('237670123456')
        && !rendered.includes('3456');
});

// ─────────────────────────────────────────────────────────────────────────────
t.section('7. The wire shapes — required-and-nullable, never absent');

/**
 * ADR-005 D-16, and this section is the only thing that pins it.
 *
 * Every optional field on a money DTO is `null` when its source is missing, never omitted.
 * A key that disappears makes "this payout has not been resolved" and "this client is out
 * of date" indistinguishable — and on this surface the first is a normal state a reader has
 * to be able to see. `JSON.stringify` drops an `undefined` value silently, so a mapper that
 * writes `row.paid_reference` instead of `row.paid_reference ?? null` produces a response
 * that is missing a key and looks fine in every eyeball test.
 *
 * The rows below carry ONLY the fields the read model declares as required, which is what a
 * legacy document written before a column existed actually looks like.
 */

/** Every path in `value` whose leaf is `undefined` — the bug class this section exists for. */
function undefinedPaths(value: unknown, path = ''): string[] {
    if (value === null || typeof value !== 'object') return [];
    if (Array.isArray(value)) return value.flatMap((item, i) => undefinedPaths(item, `${path}[${i}]`));
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
        child === undefined ? [`${path}.${key}`] : undefinedPaths(child, `${path}.${key}`));
}

const oid = (hex: string) => new ObjectId(hex);
const NO_NAMES: MoneyOwnerNames = new Map();

/** A ledger row with `owner_id` absent — the platform singleton, as it is actually stored. */
const MINIMAL_LEDGER = {
    _id: oid(OID), account_id: oid(OTHER_OID), owner_type: 'platform',
    entry_type: 'hold', amount: 100, pending_after: 100, available_after: 0,
    source_type: 'order', source_id: oid(OID), allocation_id: oid(OTHER_OID),
    reason_code: 'order_split', created_at: new Date('2026-06-01T00:00:00.000Z'),
} as never;

/** An allocation predating COD settlement gating: no release stamps, no cash fields. */
const MINIMAL_ALLOCATION = {
    _id: oid(OID), source_type: 'order', source_id: oid(OTHER_OID),
    beneficiary_type: 'platform', gross_snapshot: 1000, commission_percent_snapshot: 10,
    amount: 100, currency: 'XAF', status: 'held',
    created_at: new Date('2026-06-01T00:00:00.000Z'),
    updated_at: new Date('2026-06-01T00:00:00.000Z'),
} as never;

/** A pending payout predating the destination snapshot: nothing resolved, nothing to send to. */
const MINIMAL_PAYOUT = {
    _id: oid(OID), owner_type: 'vendor', owner_id: oid(OTHER_OID),
    amount: 5000, currency: 'XAF', status: 'pending', origin: 'manual',
    created_at: new Date('2026-06-01T00:00:00.000Z'),
    updated_at: new Date('2026-06-01T00:00:00.000Z'),
} as never;

/** A payment with no refunds and no `purpose` — every row written before that field existed. */
const MINIMAL_PAYMENT = {
    _id: oid(OID), userId: oid(OTHER_OID), gateway: 'STRIPE', method: 'CARD',
    gatewayRef: 'ch_1', status: 'SUCCEEDED', amountSnapshot: 5000, currencySnapshot: 'XAF',
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    updatedAt: new Date('2026-06-01T00:00:00.000Z'),
} as never;

/** A refund that has not landed: no `completedAt`, no gateway reference, no reason. */
const MINIMAL_REFUND = {
    _id: oid(OID), paymentTransactionId: oid(OTHER_OID), vendorId: oid(OID),
    userId: oid(OTHER_OID), refundAmount: 500, currency: 'XAF', status: 'pending',
    gateway: 'STRIPE', initiatedBy: oid(OID), initiatedByRole: 'admin',
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
} as never;

t.assert('every money mapper emits no undefined ANYWHERE, on a minimal source row', () => {
    const rendered = [
        toLedgerEntryDto(MINIMAL_LEDGER, NO_NAMES),
        toAllocationDto(MINIMAL_ALLOCATION, NO_NAMES),
        toAllocationDetailDto(MINIMAL_ALLOCATION, NO_NAMES, { movements: [], siblings: [] }),
        toPayoutListItemDto(MINIMAL_PAYOUT, NO_NAMES),
        toPaymentDto(MINIMAL_PAYMENT),
        toPaymentDetailDto(MINIMAL_PAYMENT, []),
        toRefundDto(MINIMAL_REFUND),
    ];
    return rendered.every((dto) => undefinedPaths(dto).length === 0);
});

/**
 * The one plan §8 names explicitly, checked by KEY PRESENCE rather than by value: `in`
 * catches a key that was never assigned, which is the failure `undefinedPaths` above would
 * also catch but which this states as the contract.
 */
t.assert('every PayoutListItemDto field is present-and-null when its source is missing', () => {
    const dto = toPayoutListItemDto(MINIMAL_PAYOUT, NO_NAMES) as unknown as Record<string, unknown>;
    const nullable = [
        'destination', 'ticketId', 'requestedByUserId', 'resolvedAt', 'resolvedBy',
        'paidReference', 'rejectionReason',
    ];
    return nullable.every((key) => key in dto && dto[key] === null);
});

/**
 * A stamp rendered without checking whether there IS an actor reads as "resolved by nobody,
 * source platform" — a claim rather than an absence. Keyed on the id, exactly as the agency
 * DTO keys `verifiedBy`.
 */
t.assert('...and an unresolved payout has resolvedBy: null, not a stamp claiming platform', () =>
    toPayoutListItemDto(MINIMAL_PAYOUT, NO_NAMES).resolvedBy === null);

t.assert('...while a resolved one carries the source and the cross-database name snapshot', () => {
    const stamp = toPayoutListItemDto({
        ...(MINIMAL_PAYOUT as unknown as Record<string, unknown>),
        status: 'paid',
        resolved_by: oid(OID),
        resolved_by_source: 'admin',
        resolved_by_name: 'Some Administrator',
    } as never, NO_NAMES).resolvedBy;
    return stamp?.source === 'admin' && stamp?.name === 'Some Administrator';
});

/**
 * `owner_id: null` is what the marketplace's own commission account looks like in this
 * schema — not a gap to fill. Inventing a display name here would put a label in the data
 * layer that a dashboard is better placed to choose.
 */
t.assert('the platform owner renders as a null id and a null name, never invented', () => {
    const owner = toLedgerEntryDto(MINIMAL_LEDGER, NO_NAMES).owner;
    return owner.type === 'platform' && owner.id === null && owner.name === null;
});

/** The schema's own defaults, applied to a legacy row rather than reported as absent. */
t.assert('a legacy allocation defaults requiresCashSettlement to false, not undefined', () => {
    const release = toAllocationDto(MINIMAL_ALLOCATION, NO_NAMES).release;
    return release.requiresCashSettlement === false && release.cashSettledAt === null;
});

/**
 * `netAmount` is computed here because the Mongoose virtual never reaches the raw driver.
 * With no refunds it must equal the amount — not `NaN`, which is what `amount - undefined`
 * produces and what a missing `?? 0` would ship.
 */
t.assert('a payment with no refunds nets to its full amount, never NaN', () => {
    const refunds = toPaymentDto(MINIMAL_PAYMENT).refunds;
    return refunds.totalRefunded === 0
        && refunds.netAmount === 5000
        && refunds.hasPartialRefund === false;
});

t.assert('...and its cart linkage renders as an empty array, not a missing key', () => {
    const settles = toPaymentDto(MINIMAL_PAYMENT).settles;
    return Array.isArray(settles.orderIds) && settles.orderIds.length === 0
        && settles.purpose === 'primary';
});

t.assert('an unlanded refund reports completedAt: null rather than omitting it', () => {
    const dto = toRefundDto(MINIMAL_REFUND) as unknown as Record<string, unknown>;
    return 'completedAt' in dto && dto.completedAt === null && dto.gatewayRefundRef === null;
});

/**
 * `assertReadOnlyPipeline` guards `$out`/`$merge` on the aggregation paths. This module has
 * none — every read is a `find`/`findPage` — so the hazard does not arise here at all, and
 * that is worth pinning rather than assuming: the day somebody adds a `$lookup` to join
 * owner names into the payout query, they inherit the base class's guard by going through
 * `aggregatePage`, and this assertion is what tells them the module had been aggregation-free.
 */
t.assert('the money module runs no aggregation, so no pipeline can carry $merge', () =>
    !/\baggregate(By|Page|One)?\s*\(/.test(MONEY_MODULE_SOURCE));

// ─────────────────────────────────────────────────────────────────────────────
t.section('8. Dual control on mark-paid');

const MARK_PAID = permissionSpec('money.payouts.mark_paid');

t.assert('money.payouts.mark_paid declares a dual-control spec', () => MARK_PAID.dualControl !== undefined);

t.assert('1,999,999 executes and 2,000,000 is queued', () => {
    const when = MARK_PAID.dualControl!.when;
    return when({ amount: 1_999_999 }) === false && when({ amount: 2_000_000 }) === true;
});

/**
 * `'2000000' >= 2_000_000` is TRUE in JavaScript. The `typeof` guard makes an unparsed body
 * fail closed as "not a number, not a large payout, refuse to guess" rather than tripping
 * the rule for the right reason by accident — and, worse, letting `'1999999'` through the
 * same way.
 */
t.assert('a STRING amount is not a number and does not trip the rule', () => {
    const when = MARK_PAID.dualControl!.when;
    return when({ amount: '2000000' }) === false
        && when({ amount: undefined }) === false
        && when({ amount: null }) === false
        && when({}) === false;
});

/**
 * The threshold is inlined, matching `PROMOTE_TO_DEVELOPER`'s inline `payload.tier === 1` —
 * jovi-mall exports no config to this service. This is the guard that keeps the four-eyes
 * line equal to the platform's OWN definition of "a lot of money" rather than a second,
 * arbitrary one that drifts from it.
 */
t.assert('the inlined threshold still equals jovi-mall AUTO_PAYOUT_THRESHOLD', () => {
    const source = read(JOVI, 'modules', 'earnings', 'config', 'earnings.config.ts');
    const match = /AUTO_PAYOUT_THRESHOLD:\s*intEnv\('EARNINGS_AUTO_PAYOUT_THRESHOLD',\s*([\d_]+)\)/
        .exec(source);
    if (!match) return false;
    const theirs = Number(match[1].replace(/_/g, ''));
    const when = MARK_PAID.dualControl!.when;
    return when({ amount: theirs }) === true && when({ amount: theirs - 1 }) === false;
});

t.assert('the approver needs the same permission — four eyes, not an escalation', () =>
    MARK_PAID.dualControl!.approverPermission === 'money.payouts.mark_paid');

t.assert('the queue description names the money and the beneficiary', () => {
    const description = MARK_PAID.dualControl!.describe({
        payoutId: OID, ownerType: 'agency', ownerId: OTHER_OID, amount: 2_500_000, currency: 'XAF',
    });
    return description.includes(OID)
        && description.includes('XAF')
        && description.includes('agency')
        && description.includes(OTHER_OID);
});

/**
 * The asymmetry is the design: rejecting returns the funds to the owner's available balance
 * and the owner can simply request again, so the mistake it can make is reversible. Marking
 * paid asserts money is gone. A quorum belongs on the irreversible direction only — the same
 * reasoning that leaves a DEMOTION out of `PROMOTE_TO_DEVELOPER`.
 */
t.assert('rejecting a payout is NOT dual-controlled at any amount', () =>
    permissionSpec('money.payouts.reject').dualControl === undefined);

/**
 * `money.routes.ts` imports `payout-dual-control.ts` for side effect, so importing the
 * routes above is enough to register the handler. Without it `createApp()` refuses to start
 * — this is that boot assertion, narrowed to this module's action and run with no database.
 *
 * Narrowed rather than calling `assertDualControlHandlersRegistered()`, which spans the
 * whole catalog: this suite imports the money routes and nothing else, so the administrator
 * handlers are legitimately absent here. `verify-money-live.ts` runs the real `createApp()`,
 * which is where the whole-catalog form belongs.
 */
t.assert('importing the routes registers the handler, so the service can boot', () =>
    dualControlHandlerFor('money.payouts.mark_paid') !== undefined);

t.assert('the handler re-checks status, amount and currency against current state', () => {
    const source = readCode(...DUAL_CONTROL);
    return source.includes('assertPending(row)')
        && source.includes('row.amount !== approval.payload.amount')
        && source.includes('row.currency !== approval.payload.currency');
});

/**
 * The approver performs the write, so the audit row's actor is theirs and `via_approval_id`
 * ties it back to the request — the pair reads as "X asked, Y did it".
 */
t.assert('...and delegates with the APPROVER as actor, threading via_approval_id', () => {
    const source = readCode(...DUAL_CONTROL);
    return source.includes('actor: approver')
        && source.includes('approval._id.toString()');
});

t.assert('the audit `before` and the gateway `after` speak the same camelCase', () => {
    const beforeKeys = readCode(...DUAL_CONTROL)
        .slice(readCode(...DUAL_CONTROL).indexOf('export function toPayoutAuditState'));
    const afterKeys = readCode(...MONEY_GATEWAY)
        .slice(readCode(...MONEY_GATEWAY).indexOf('function payoutState'));
    return ['status', 'amount', 'currency', 'resolvedAt', 'paidReference', 'rejectionReason']
        .every((key) => beforeKeys.includes(`${key}:`) && afterKeys.includes(`${key}:`));
});

/**
 * A beneficiary's destination must not reach the audit store — the one place it would then
 * be readable without the permission that gates it. It cannot change anyway: the snapshot is
 * frozen at request time, which is the whole point of snapshotting it.
 */
t.assert('the audit diff carries no destination', () => {
    const source = readCode(...MONEY_GATEWAY);
    const block = source.slice(source.indexOf('function payoutState'), source.indexOf('export interface PlatformPayoutRequest'));
    return !block.includes('destination') && !block.includes('payout_method');
});

// ─────────────────────────────────────────────────────────────────────────────
t.section('9. The catalogs');

t.assert('both payout writes are delegated actions against a payout', () =>
    (['money.payouts.mark_paid', 'money.payouts.reject'] as const).every((action) =>
        isAuditAction(action)
        && auditSpec(action).target === 'payout'
        && auditSpec(action).transport === 'delegated'
        && auditSpec(action).permission === action)
    && subjectClassOf('payout') === 'platform_record');

/**
 * The one audited READ in the catalog, landing at step 6. `external` rather than
 * `observation` because `observation` is best-effort and swallows a write failure — right
 * for a login that already happened on its own terms, wrong where the audit row IS the
 * control.
 */
t.assert('the destination disclosure is an EXTERNAL audited read against the same target', () =>
    auditSpec('money.payouts.destination.read').transport === 'external'
    && auditSpec('money.payouts.destination.read').target === 'payout');

t.assert('mark_paid is sensitive twice over — financial AND dual-controlled', () =>
    isSensitive(MARK_PAID) && MARK_PAID.financial === true);

/**
 * Adding `dualControl` changed nothing about who holds it: the permission was already
 * `financial`, so `allInFamily('money')` already refused it and tier 2 already names it by
 * hand. Asserted because the reverse — a wildcard quietly acquiring a dual-controlled
 * action — is the failure this flag set exists to prevent.
 */
t.assert('...and tier 2 still holds it by name, while tier 3 does not', () =>
    TIER_GRANTS[2].includes('money.payouts.mark_paid')
    && !TIER_GRANTS[3].includes('money.payouts.mark_paid'));

t.assert('money.payments.read is deliberately unflagged, so Support can answer for a payment', () =>
    !isSensitive(PERMISSION_CATALOG['money.payments.read'])
    && TIER_GRANTS[3].includes('money.payments.read'));

t.assert('money.payouts.destination.read is financial, and refused to tier 3', () =>
    PERMISSION_CATALOG['money.payouts.destination.read'].financial === true
    && !TIER_GRANTS[3].includes('money.payouts.destination.read'));

t.assert('no money row is left in the legacy endpoint map', () =>
    !LEGACY_ENDPOINT_MAP.some(
        (row) => String(row.permission ?? '').startsWith('money.')
            || row.path.includes('/payout-requests')
            || row.path.includes('/earnings'),
    ));

// ─────────────────────────────────────────────────────────────────────────────
t.section('10. The route manifest');

const moneyRoutes = routeManifest().filter((route) => route.fullPath.startsWith('/api/v1/money'));

t.assert('fourteen routes are declared on /money', () => moneyRoutes.length === 14);

t.assert('every one of them declares a permission — none is public or self-service', () =>
    moneyRoutes.every((route) => route.access.kind === 'permission'));

/**
 * The disclosure endpoint sits behind its OWN permission, alone.
 *
 * Not `money.payouts.read` plus something — the whole point of D-3 is that seeing the queue
 * and seeing a beneficiary's account number are different privileges, and a composition
 * including the queue permission would let anyone holding it inherit the disclosure the day
 * somebody widened the set.
 */
t.assert('the destination disclosure stands behind money.payouts.destination.read alone', () => {
    const route = moneyRoutes.find((r) => r.fullPath.endsWith('/destination'));
    return route?.method === 'get'
        && route.access.kind === 'permission'
        && route.access.permissions.join() === 'money.payouts.destination.read';
});

/**
 * These rows ARE audit rows and the repository applies the audit read scope to them, so
 * requiring only `money.payouts.read` would make this a second door onto the trail. It
 * matters more here than on the agent feed: from step 6 this is where every destination
 * disclosure appears.
 */
t.assert('the payout activity feed requires audit.read as well', () => {
    const route = moneyRoutes.find((r) => r.fullPath.endsWith('/activity'));
    return route?.access.kind === 'permission'
        && route.access.mode === 'all'
        && route.access.permissions.includes('audit.read')
        && route.access.permissions.includes('money.payouts.read');
});

t.assert('the two writes are POSTs behind their own permissions', () => {
    const markPaid = moneyRoutes.find((r) => r.fullPath.endsWith('/mark-paid'));
    const reject = moneyRoutes.find((r) => r.fullPath.endsWith('/reject'));
    return markPaid?.method === 'post'
        && reject?.method === 'post'
        && markPaid.access.kind === 'permission'
        && markPaid.access.permissions.join() === 'money.payouts.mark_paid'
        && reject?.access.kind === 'permission'
        && reject.access.permissions.join() === 'money.payouts.reject';
});

/**
 * Route order. `platform`, `accounts` and `allocations` are sibling literals under
 * `/earnings`; the only parameter on that branch sits one level below them. A
 * `/earnings/:ownerType` added later would swallow all three, and Express would not warn.
 */
t.assert('no :param sits beside a literal at the same depth under /earnings', () => {
    const earnings = moneyRoutes
        .map((r) => r.fullPath.replace('/api/v1/money/earnings/', ''))
        .filter((path) => !path.startsWith('/api'));
    // The `.filter()` that used to sit here ignored its own argument — its predicate was
    // `moneyRoutes.some(r => r.fullPath.includes('/earnings/'))`, a constant, so it kept
    // every path or none of them and narrowed nothing. `earnings` is already exactly the
    // routes under /earnings/, which is what the filter was reaching for.
    const secondSegments = earnings.map((path) => path.split('/')[0]);
    return !secondSegments.some((segment) => segment.startsWith(':'));
});

t.assert('the routes file imports the dual-control handler for side effect', () =>
    readCode(...MONEY_ROUTES).includes("import '../domain/payout-dual-control'"));

process.exit(t.finish());
