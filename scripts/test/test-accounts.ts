/**
 * The account surface — the rules, with no infrastructure.
 *
 * This module's failure mode is not a leak, it is a MISREADING: three unrelated balance
 * models on one page, two of which are liabilities and one of which is not money at all.
 * Nothing here throws when they get mixed; it renders. So five things are pinned:
 *
 *   §2  **`mergeActivity` is total and order-preserving.** Five pre-sorted sources merge
 *       into one page, an empty source shifts nothing, and the cursor never repeats a row
 *       across pages — nor DROPS one, which is the failure a bare `$lt` cursor produces the
 *       moment two collections share an instant (they do: a plan activation writes its
 *       purchase and its credit allowance in one transaction).
 *   §3  **the account DTO's five mechanisms.** No top-level `balance`/`total`/`amount`;
 *       every balance object carrying `unit` + `currency` + `direction`; `null` meaning
 *       "does not apply to this owner kind" against `0` meaning "applies, currently empty";
 *       and no grand total anywhere.
 *   §4  **the top-up dedup.** A paid top-up writes rows in TWO collections describing one
 *       event, and every credit read excludes the ledger half. Without it the feed
 *       double-counts and the credits column is wrong.
 *   §5  **the projection cannot express a balance.** The one read this module makes against
 *       `earnings_accounts` takes the `currency` label and nothing else — asserted by source
 *       scan, because a projection is a string literal and no compiler checks one.
 *   §6  the permissions each route composes, which is the whole authorization design.
 *
 *   npm run test:accounts
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
    ACCOUNT_OWNER_TYPES,
    AccountOwnerParamsSchema,
    CashLedgerOwnerParamsSchema,
    ListAccountPayoutsQuerySchema,
    ListActivityQuerySchema,
    ListCashLedgerQuerySchema,
    ListCreditsQuerySchema,
} from '../../src/modules/accounts/validators/account.validator';
import {
    ActivityCandidate,
    mergeActivity,
} from '../../src/modules/accounts/repositories/account-activity.read.repository';
import {
    TOPUP_REASON_CODES,
    buildCreditFilter,
} from '../../src/modules/accounts/repositories/credit.read.repository';
import { buildCashLedgerFilter } from '../../src/modules/cod/repositories/cod-cash.read.repository';
import {
    ACTIVITY_CATEGORIES,
    AccountSources,
    toAccountDto,
    toCreditActivity,
    toEarningActivity,
    toPayoutActivity,
    toPlanPurchaseActivity,
    toTopupActivity,
} from '../../src/modules/accounts/read-models/account.dto';
import { routeManifest } from '../../src/api/route-manifest';
import { PERMISSION_CATALOG } from '../../src/modules/authorization/domain/permission.catalog';
import '../../src/modules/accounts/routes/account.routes';

const t = suite('accounts');

const SRC = join(__dirname, '..', '..', 'src');
const JOVI = join(__dirname, '..', '..', '..', 'jovi-mall', 'src');
const ACCOUNTS_DIR = [SRC, 'modules', 'accounts'];

function read(...segments: string[]): string {
    return readFileSync(join(...segments), 'utf8');
}

function readCode(path: string): string {
    return readFileSync(path, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
}

/** Every `.ts` file under the module, walked — a scan whose coverage nobody maintains. */
function moduleFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) return moduleFiles(full);
        return entry.isFile() && full.endsWith('.ts') ? [full] : [];
    });
}

const ACCOUNTS_FILES = moduleFiles(join(...ACCOUNTS_DIR));
const ACCOUNTS_SOURCE = ACCOUNTS_FILES.map(readCode).join('\n');

const OID = '507f1f77bcf86cd799439011';
const OTHER_OID = '507f1f77bcf86cd799439012';
const oid = (hex: string) => new ObjectId(hex);

// ─────────────────────────────────────────────────────────────────────────────
t.section('1. The request shapes');

t.assert('the owner type is OUR enum — three kinds, and `platform` is not one', () =>
    ACCOUNT_OWNER_TYPES.join() === 'vendor,agency,agent'
    && AccountOwnerParamsSchema.safeParse({ ownerType: 'agent', ownerId: OID }).success
    && !AccountOwnerParamsSchema.safeParse({ ownerType: 'platform', ownerId: OID }).success);

/**
 * The marketplace's own account has no directory row, no plan, no wallet and no COD
 * liability — every block would be `null` but one, and that one already lives at
 * `/money/earnings/platform`.
 */
t.assert('...and a malformed owner id is a 400 at the edge, not a query that matches nothing', () =>
    !AccountOwnerParamsSchema.safeParse({ ownerType: 'vendor', ownerId: 'nope' }).success);

/**
 * A vendor never collects cash, so `cod_cash_ledgers` cannot hold a row for one. Refusing at
 * the schema makes that a 400 that says so, where running the query would answer an empty
 * page reading as "no movements" when the truth is "cannot have movements".
 */
t.assert('the cash ledger accepts agent and agency ONLY — a vendor is refused by shape', () =>
    CashLedgerOwnerParamsSchema.safeParse({ ownerType: 'agent', ownerId: OID }).success
    && CashLedgerOwnerParamsSchema.safeParse({ ownerType: 'agency', ownerId: OID }).success
    && !CashLedgerOwnerParamsSchema.safeParse({ ownerType: 'vendor', ownerId: OID }).success);

/**
 * The feed has exactly one meaningful order and the cursor IS that order. A `sort` over five
 * merged sources would have to load every row of all five to be correct — the unbounded read
 * this endpoint's design exists to avoid.
 */
t.assert('the activity feed takes before/limit and refuses a sort', () =>
    ListActivityQuerySchema.safeParse({}).success
    && ListActivityQuerySchema.safeParse({ before: '2026-06-01T00:00:00.000Z', limit: 10 }).success
    && !ListActivityQuerySchema.safeParse({ sort: '-createdAt' }).success
    && !ListActivityQuerySchema.safeParse({ page: 2 }).success);

t.assert('...and a cursor that is not an instant is refused', () =>
    !ListActivityQuerySchema.safeParse({ before: 'yesterday' }).success);

t.assert('the three offset lists default to newest first and refuse an unlisted sort', () => {
    const credits = ListCreditsQuerySchema.safeParse({});
    const cash = ListCashLedgerQuerySchema.safeParse({});
    const payouts = ListAccountPayoutsQuerySchema.safeParse({});
    return credits.success && credits.data.sort.field === 'createdAt' && credits.data.sort.direction === -1
        && cash.success && cash.data.sort.field === 'createdAt'
        && payouts.success && payouts.data.sort.field === 'createdAt'
        && !ListCreditsQuerySchema.safeParse({ sort: 'balanceAfter' }).success
        && !ListAccountPayoutsQuerySchema.safeParse({ sort: 'ownerId' }).success;
});

// ─────────────────────────────────────────────────────────────────────────────
t.section('2. mergeActivity — five sources, one order, no row lost');

let sequence = 0;

/** A candidate at a given instant. `id` descends with each call, so ties stay deterministic. */
function at(iso: string, label = `row-${++sequence}`): ActivityCandidate<string> {
    return { row: label, at: new Date(iso), id: String(1_000_000 - sequence) };
}

t.assert('an empty set of sources is an empty page with no cursor', () => {
    const page = mergeActivity<string>([[], [], [], [], []], 20);
    return page.items.length === 0 && page.nextCursor === null;
});

t.assert('five pre-sorted sources interleave into one descending order', () => {
    const page = mergeActivity<string>([
        [at('2026-06-05T00:00:00.000Z', 'plan')],
        [at('2026-06-04T00:00:00.000Z', 'topup')],
        [at('2026-06-03T00:00:00.000Z', 'credit')],
        [at('2026-06-02T00:00:00.000Z', 'earning')],
        [at('2026-06-01T00:00:00.000Z', 'payout')],
    ], 20);
    return page.items.join() === 'plan,topup,credit,earning,payout' && page.nextCursor === null;
});

/**
 * The `payout` category jovi-mall's `VendorTransaction` declared and never filled — its own
 * docstring calls it "reserved for when cash-out is built". This feed is where those rows
 * finally appear, and a merge that silently dropped the fifth source would look identical to
 * one that had no payouts.
 */
t.assert('...and a source with no rows shifts nothing and removes nothing', () => {
    const page = mergeActivity<string>([
        [at('2026-06-05T00:00:00.000Z', 'plan')],
        [],
        [at('2026-06-03T00:00:00.000Z', 'credit')],
        [],
        [at('2026-06-01T00:00:00.000Z', 'payout')],
    ], 20);
    return page.items.join() === 'plan,credit,payout';
});

t.assert('a full page reports a cursor; a short one reports null', () => {
    const rows = Array.from({ length: 5 }, (_, i) => at(`2026-06-0${i + 1}T00:00:00.000Z`));
    return mergeActivity([rows], 3).nextCursor !== null
        && mergeActivity([rows], 5).nextCursor === null
        && mergeActivity([rows], 50).nextCursor === null;
});

t.assert('...and that cursor is the instant of the LAST row on the page', () => {
    const page = mergeActivity<string>([[
        at('2026-06-05T00:00:00.000Z'),
        at('2026-06-04T00:00:00.000Z'),
        at('2026-06-03T00:00:00.000Z'),
    ]], 2);
    return page.items.length === 2 && page.nextCursor === '2026-06-04T00:00:00.000Z';
});

/**
 * **The assertion this section exists for.**
 *
 * The cursor is strictly-older-than, because an inclusive one repeats the boundary row on
 * every page and on a money feed that reads as a duplicate transaction. But a bare `$lt`
 * DROPS rows that share the boundary instant — and here that is routine, not theoretical:
 * activating a plan writes the purchase and its credit allowance in ONE transaction, so two
 * rows in two collections carry the same `created_at`.
 *
 * So the page is extended to the end of the tie group. It comes back LONGER than `limit`,
 * which is the intended trade: an over-long page is visible, a missing transaction is not.
 */
t.assert('a tie group is never split across pages, even when it overflows the limit', () => {
    const tied = '2026-06-04T00:00:00.000Z';
    const page = mergeActivity<string>([
        [at('2026-06-05T00:00:00.000Z', 'newest')],
        [at(tied, 'tie-a')],
        [at(tied, 'tie-b')],
        [at(tied, 'tie-c')],
        [at('2026-06-01T00:00:00.000Z', 'oldest')],
    ], 2);

    return page.items.length === 4
        && page.items[0] === 'newest'
        && ['tie-a', 'tie-b', 'tie-c'].every((row) => page.items.includes(row))
        && page.nextCursor === tied;
});

/**
 * Walking the feed end to end must yield every row exactly once. This is the property both
 * failure modes break — an inclusive cursor repeats, a naive exclusive one drops — and it is
 * checked by simulating the repository's `$lt` rather than by inspecting the algorithm.
 */
t.assert('walking every page yields each row exactly once, ties included', () => {
    const instants = [
        '2026-06-06T00:00:00.000Z',
        '2026-06-05T00:00:00.000Z', '2026-06-05T00:00:00.000Z', '2026-06-05T00:00:00.000Z',
        '2026-06-04T00:00:00.000Z',
        '2026-06-03T00:00:00.000Z', '2026-06-03T00:00:00.000Z',
        '2026-06-02T00:00:00.000Z',
    ];
    const universe = instants.map((iso, i) => at(iso, `row-${i}`));

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 20; guard++) {
        // Exactly what the repositories do: strictly older than the cursor.
        const remaining = cursor === null
            ? universe
            : universe.filter((c) => c.at.getTime() < new Date(cursor as string).getTime());
        if (remaining.length === 0) break;

        const page: { items: string[]; nextCursor: string | null } = mergeActivity([remaining], 2);
        seen.push(...page.items);
        cursor = page.nextCursor;
        if (cursor === null) break;
    }

    return seen.length === universe.length && new Set(seen).size === universe.length;
});

// ─────────────────────────────────────────────────────────────────────────────
t.section('3. The account DTO — five mechanisms against one misreading');

const BALANCES = { pending: 1000, available: 2000, reserve: 300, requested: 400, currency: 'XAF' };
const ENTITLEMENTS = {
    planCode: 'PRO', maxActiveProducts: 100, maxStorageBytes: 1024,
    commissionPercent: 12.5, maxUnterminatedShipments: 5, liveTrackingEnabled: true,
};

function sourcesFor(ownerType: 'vendor' | 'agency' | 'agent'): AccountSources {
    const owner = {
        _id: oid(OID),
        user_id: oid(OTHER_OID),
        status: 'active',
        email: 'owner@example.test',
        email_verified: true,
        created_at: new Date('2026-01-01T00:00:00.000Z'),
        ...(ownerType === 'agent' ? { cod: { max_threshold: 500_000 }, kyc: { status: 'verified' } } : {}),
    } as never;

    return {
        ownerType,
        ownerId: OID,
        owner,
        ownerName: 'Verify Emporium',
        balances: BALANCES,
        entitlements: ENTITLEMENTS,
        subscription: null,
        planName: null,
        billingSettings: null,
        wallet: null,
        codCash: ownerType === 'vendor'
            ? null
            : ({ balance: 250_000, currency: 'XAF', updated_at: new Date('2026-06-01T00:00:00.000Z') } as never),
        contracts: [],
        reserveHolds: [],
        pendingPayout: null,
        lastPaidPayout: null,
        openDiscrepancies: ownerType === 'vendor' ? null : 2,
        unsettledCollections: 0,
    };
}

/**
 * Mechanism 1. Every number lives inside a named object, so nothing can be summed without
 * first naming what it is — and a client that reaches for `dto.balance` finds nothing.
 */
t.assert('no `balance`, `total` or `amount` key exists at the top level', () => {
    const dto = toAccountDto(sourcesFor('agent')) as unknown as Record<string, unknown>;
    return !('balance' in dto) && !('total' in dto) && !('amount' in dto);
});

/** Mechanisms 2 and 3 — the fields that make two balances non-addable. */
t.assert('every balance object carries unit, currency and direction', () => {
    const balances = toAccountDto(sourcesFor('agency')).balances;
    const each = [balances.earnings, balances.credits, balances.codCash];
    return each.every((block) =>
        block !== null
        && 'unit' in block && 'currency' in block && 'direction' in block);
});

t.assert('...earnings are owed TO the owner, and are money', () => {
    const earnings = toAccountDto(sourcesFor('vendor')).balances.earnings;
    return earnings.unit === 'money'
        && earnings.currency === 'XAF'
        && earnings.direction === 'owed_to_owner'
        && earnings.pending === 1000
        && earnings.available === 2000;
});

/** A credit is not denominated in anything, so its currency is `null` and never `'XAF'`. */
t.assert('...credits are a unit of their own, with a null currency', () => {
    const credits = toAccountDto(sourcesFor('vendor')).balances.credits;
    return credits.unit === 'credit'
        && credits.currency === null
        && credits.direction === 'spendable_by_owner';
});

/**
 * The deviation from the phase plan, and the reason for it. `cod-cash-account.model.ts` says
 * an agent's cash is owed to their AGENCY and an agency's to the PLATFORM — which is exactly
 * why a deposit and a remittance are different verbs. A liability label naming the wrong
 * creditor is the class of error this DTO exists to prevent.
 */
t.assert('...and COD cash names its REAL creditor: an agent owes their agency', () =>
    toAccountDto(sourcesFor('agent')).balances.codCash?.direction === 'owed_to_agency'
    && toAccountDto(sourcesFor('agency')).balances.codCash?.direction === 'owed_to_platform');

/**
 * Mechanism 4, and the phase plan's own exit gate. `null` is "cannot owe"; `0` is "owes
 * nothing". Conflating them turns a vendor into a settled agent.
 */
t.assert('a vendor cannot hold COD cash — null, not zero', () => {
    const vendor = toAccountDto(sourcesFor('vendor'));
    return vendor.balances.codCash === null && vendor.codExposure === null;
});

t.assert('...while an agent that owes nothing still gets an object', () => {
    const settled = sourcesFor('agent');
    settled.codCash = { balance: 0, currency: 'XAF', updated_at: null } as never;
    const dto = toAccountDto(settled);
    return dto.balances.codCash?.held === 0 && dto.codExposure !== null;
});

t.assert('...and a missing wallet reads as zero credits, with walletExists saying which', () => {
    const withWallet = sourcesFor('vendor');
    withWallet.wallet = { balance: 42 } as never;
    return toAccountDto(sourcesFor('vendor')).balances.credits.walletExists === false
        && toAccountDto(sourcesFor('vendor')).balances.credits.balance === 0
        && toAccountDto(withWallet).balances.credits.walletExists === true
        && toAccountDto(withWallet).balances.credits.balance === 42;
});

/**
 * Mechanism 5. Adding a liability to an asset across two units is not a number, and even
 * `pending + available + reserve + requested` is omitted — that arithmetic is jovi-mall's and
 * `getBalances` does not return it, so producing it here would be this service inventing a
 * number the platform never states.
 */
t.assert('no grand total is emitted anywhere in the response', () => {
    const rendered = JSON.stringify(toAccountDto(sourcesFor('agent')));
    return !/"(grandTotal|netWorth|totalBalance|netBalance)"/.test(rendered);
});

/**
 * The subscription block stays an OBJECT with null fields rather than going null itself:
 * `entitlements` lives inside it, and a null subscription would take them with it — making
 * "no plan" and "we could not determine the plan" the same shape.
 */
t.assert('an owner with no active plan still reports entitlements', () => {
    const subscription = toAccountDto(sourcesFor('vendor')).subscription;
    return subscription.status === null
        && subscription.subscriberPlanId === null
        && subscription.entitlements.commissionPercent === 12.5;
});

t.assert('reserve holds are an agency thing — null for an agent, an array for an agency', () =>
    toAccountDto(sourcesFor('agent')).codExposure?.reserveHolds === null
    && Array.isArray(toAccountDto(sourcesFor('agency')).codExposure?.reserveHolds));

/**
 * `max_threshold` is the ceiling dispatch refuses AT, so the comparison is `>=`. A vendor and
 * an agency get `null` — the first has no cash, the second no single ceiling.
 */
t.assert('overCodThreshold compares against the agent ceiling and is null elsewhere', () => {
    const agent = sourcesFor('agent');
    agent.codCash = { balance: 500_000, currency: 'XAF', updated_at: null } as never;
    const under = sourcesFor('agent');
    under.codCash = { balance: 499_999, currency: 'XAF', updated_at: null } as never;

    return toAccountDto(agent).flags.overCodThreshold === true
        && toAccountDto(under).flags.overCodThreshold === false
        && toAccountDto(sourcesFor('vendor')).flags.overCodThreshold === null
        && toAccountDto(sourcesFor('agency')).flags.overCodThreshold === null;
});

t.assert('open discrepancies are null for a vendor and a count for an agent', () =>
    toAccountDto(sourcesFor('vendor')).flags.openDiscrepancies === null
    && toAccountDto(sourcesFor('agent')).flags.openDiscrepancies === 2);

/** Every path in `value` whose leaf is `undefined` — the ADR-005 D-16 bug class. */
function undefinedPaths(value: unknown, path = ''): string[] {
    if (value === null || typeof value !== 'object') return [];
    if (Array.isArray(value)) return value.flatMap((item, i) => undefinedPaths(item, `${path}[${i}]`));
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
        child === undefined ? [`${path}.${key}`] : undefinedPaths(child, `${path}.${key}`));
}

/**
 * A key that disappears makes "this owner has no plan" and "this client is out of date"
 * indistinguishable — and `JSON.stringify` drops an `undefined` silently, so the bug looks
 * fine in every eyeball test.
 */
t.assert('the account DTO emits no undefined ANYWHERE, for any owner kind', () =>
    (['vendor', 'agency', 'agent'] as const).every(
        (kind) => undefinedPaths(toAccountDto(sourcesFor(kind))).length === 0,
    ));

// ─────────────────────────────────────────────────────────────────────────────
t.section('4. The activity mappers, and the dedup that stops double-counting');

/**
 * A paid top-up writes a `credit_topups` row AND a `credit_transactions` row
 * (`topup_purchase`); a reversal writes another. Both describe an event the top-up row
 * already describes, so every credit read excludes them. Without this the feed shows each
 * top-up twice and the credits column double-counts.
 */
t.assert('every credit read excludes the two top-up reason codes, unconditionally', () => {
    const bare = buildCreditFilter('vendor', OID, {});
    const filtered = buildCreditFilter('vendor', OID, { type: 'debit', before: new Date() });
    const dedupIn = (filter: unknown) =>
        ((filter as { $and: Record<string, unknown>[] }).$and ?? []).some((clause) => {
            const term = clause.reason_code as { $nin?: string[] } | undefined;
            return Array.isArray(term?.$nin) && term.$nin.join() === TOPUP_REASON_CODES.join();
        });
    return dedupIn(bare) && dedupIn(filtered);
});

/**
 * The owner terms are not the caller's — the route already decided whose ledger this is —
 * and building them in the filter is what stops a future caller composing a query that reads
 * every owner's credits at once.
 */
t.assert('...and both owner terms are always present, on both owner-scoped filters', () => {
    const credit = (buildCreditFilter('agent', OID, {}) as { $and: Record<string, unknown>[] }).$and;
    const cash = (buildCashLedgerFilter('agency', OID, { page: 1, limit: 20, sort: { field: 'createdAt', direction: -1 } }) as { $and: Record<string, unknown>[] }).$and;
    return credit.some((c) => c.owner_type === 'agent')
        && credit.some((c) => 'owner_id' in c)
        && cash.some((c) => c.owner_type === 'agency')
        && cash.some((c) => 'owner_id' in c);
});

t.assert('a malformed owner id becomes a term matching nothing, never a thrown BSONError', () => {
    const clauses = (buildCreditFilter('vendor', 'not-an-id', {}) as { $and: Record<string, unknown>[] }).$and;
    const term = clauses.find((c) => 'owner_id' in c)?.owner_id as { $in?: unknown[] };
    return Array.isArray(term.$in) && term.$in.length === 0;
});

const TOPUP = {
    _id: oid(OID), pack_code: 'PACK10', credits: 1000, price: 5000, currency: 'XAF',
    status: 'paid', gateway: 'NOTCHPAY', created_at: new Date('2026-06-01T00:00:00.000Z'),
} as never;

/**
 * The one row that is money AND credits. It stays ONE row: the movement described is the
 * payment, and the credits arriving are reported beside it — which is the only way a reader
 * sees the rate they actually got.
 */
t.assert('a top-up is money out with the credits it bought beside it', () => {
    const row = toTopupActivity(TOPUP);
    return row.unit === 'money'
        && row.direction === 'out'
        && row.amount === 5000
        && row.currency === 'XAF'
        && row.credits === 1000
        && row.category === 'credit';
});

t.assert('a credit ledger row is credit-unit, unsigned, with the sign in `direction`', () => {
    const spent = toCreditActivity({
        _id: oid(OID), type: 'debit', amount: -25, balance_after: 75,
        reason_code: 'vectorisation', ref: 'product-1', created_at: new Date(),
    } as never);
    const granted = toCreditActivity({
        _id: oid(OTHER_OID), type: 'allowance', amount: 500, balance_after: 575,
        reason_code: 'plan_allowance', ref: null, created_at: new Date(),
    } as never);

    return spent.unit === 'credit' && spent.direction === 'out' && spent.amount === 25
        && spent.currency === null && spent.credits === 25 && spent.type === 'credit_usage'
        && granted.direction === 'in' && granted.type === 'credit_allowance'
        && granted.source === null;
});

/**
 * `earnings_ledgers` rows carry no currency of their own. `null` when the owner has no
 * earnings account — consistent, because no account means no ledger rows either — and never
 * an assumed `'XAF'`.
 */
t.assert('an earning row takes the account currency, and null when there is none', () => {
    const ledgerRow = {
        _id: oid(OID), entry_type: 'release', amount: 8000,
        source_type: 'order', source_id: oid(OTHER_OID), created_at: new Date(),
    } as never;
    return toEarningActivity(ledgerRow, 'XAF').currency === 'XAF'
        && toEarningActivity(ledgerRow, null).currency === null
        && toEarningActivity(ledgerRow, 'XAF').direction === 'in';
});

t.assert('...and a reversal is the one earning that points OUT', () =>
    toEarningActivity({
        _id: oid(OID), entry_type: 'reversal', amount: 8000,
        source_type: 'order', source_id: oid(OTHER_OID), created_at: new Date(),
    } as never, 'XAF').direction === 'out');

/**
 * A payout is the counterpart of `earning_release`: money leaving the owner's platform
 * balance for their bank. **And it carries no destination, masked or otherwise** — this
 * endpoint's permissions do not include `money.payouts.destination.read`, and a feed row is
 * not the place to reason about where money was sent.
 */
t.assert('a payout row is money out, and names no destination at all', () => {
    const row = toPayoutActivity({
        _id: oid(OID), owner_type: 'vendor', owner_id: oid(OTHER_OID),
        amount: 90_000, currency: 'XAF', status: 'paid', origin: 'manual',
        payout_method_snapshot: { method: 'mobile_money', mobile_money: { provider: 'MTN' } },
        created_at: new Date(), updated_at: new Date(),
    } as never);
    const rendered = JSON.stringify(row);

    return row.category === 'payout'
        && row.direction === 'out'
        && row.amount === 90_000
        && !rendered.includes('destination')
        && !rendered.includes('mobile_money')
        && !rendered.includes('MTN');
});

t.assert('every mapper emits the four required-and-nullable keys, never absent', () => {
    const rows = [
        toPlanPurchaseActivity({
            _id: oid(OID), plan_code: 'PRO', price: 15_000, currency: 'XAF',
            status: 'pending', gateway: null, created_at: new Date(),
        } as never),
        toTopupActivity(TOPUP),
        toCreditActivity({
            _id: oid(OID), type: 'adjustment', amount: 5, balance_after: 5,
            reason_code: 'admin_adjustment', created_at: new Date(),
        } as never),
        toEarningActivity({
            _id: oid(OID), entry_type: 'hold', amount: 10, source_type: 'order',
            source_id: oid(OTHER_OID), created_at: new Date(),
        } as never, null),
    ];
    return rows.every((row) =>
        'currency' in row && 'credits' in row && 'gateway' in row && 'source' in row)
        && rows.every((row) => undefinedPaths(row).length === 0)
        && rows.every((row) => ACTIVITY_CATEGORIES.includes(row.category));
});

/**
 * Drift guard against jovi-mall's own feed, read out of its source. The same movement must
 * read the same on both surfaces — a vendor looking at their transactions and an
 * administrator looking at the same account should not see two different words for one row.
 */
t.assert('the credit reason→type map agrees with jovi-mall, read from its source', () => {
    const source = read(JOVI, 'modules', 'transactions', 'services', 'vendor-transaction.service.ts');
    const block = source.slice(
        source.indexOf('CREDIT_TYPE_BY_REASON'),
        source.indexOf('CREDIT_DESC_BY_REASON'),
    );
    const theirs = [...block.matchAll(/(\w+):\s*'([\w_]+)'/g)].map(([, reason, type]) => [reason, type]);

    return theirs.length >= 4 && theirs.every(([reason, type]) =>
        toCreditActivity({
            _id: oid(OID), type: 'debit', amount: 1, balance_after: 1,
            reason_code: reason, created_at: new Date(),
        } as never).type === type);
});

/**
 * ...and the top-up reason codes are the same two. This is the pair whose omission
 * double-counts, so it is checked against their list rather than trusted to a comment.
 */
t.assert('...and the two deduped reason codes are the ones jovi-mall dedups', () => {
    const source = read(JOVI, 'modules', 'transactions', 'services', 'vendor-transaction.service.ts');
    const match = /TOPUP_REASON_CODES: CreditReasonCode\[\] = \[([^\]]*)\]/.exec(source);
    if (!match) return false;
    const theirs = [...match[1].matchAll(/'([\w_]+)'/g)].map(([, code]) => code);
    return theirs.join() === TOPUP_REASON_CODES.join();
});

// ─────────────────────────────────────────────────────────────────────────────
t.section('5. What this module may read — the projection is the argument');

/**
 * D-7 forbids reading `earnings_accounts` directly, because doing so would show balances
 * without the reconciliation `getBalances` performs — a second opinion about how much money
 * exists. This module reads that collection for exactly ONE field, the `currency` label,
 * because `earnings_ledgers` rows do not carry one.
 *
 * The four balance names below are what make the difference between a label and a verdict,
 * and none of them may appear anywhere in this module. A projection is a string literal and
 * no compiler checks one.
 */
const BALANCE_FIELDS = ['pending_balance', 'available_balance', 'reserve_balance', 'requested_balance'];

t.assert('the accounts module names no `earnings_accounts` balance field, anywhere', () =>
    BALANCE_FIELDS.every((field) => !ACCOUNTS_SOURCE.includes(field)));

t.assert('...and the scan walks the whole module rather than a list somebody maintains', () =>
    ACCOUNTS_FILES.length >= 8
    && ACCOUNTS_FILES.some((f) => f.endsWith('account-activity.read.repository.ts'))
    && ACCOUNTS_FILES.some((f) => f.endsWith('account.dto.ts')));

/**
 * The payout destination's three routing values, and the COD delivery OTP. This module reads
 * `payout_requests` (through the money module's masked projection) and never
 * `cash_collections` at all — the strongest form of that guarantee being that it cannot leak
 * a field of a collection it cannot point a repository at.
 */
t.assert('...nor a routing value, a gateway internal, or the COD delivery OTP', () =>
    ['phone_number', 'account_number', 'gateway_token', 'code_plain', 'code_hash',
        'rawGatewayPayloads', 'CASH_COLLECTION', 'USER_PAYMENT_METHOD']
        .every((field) => !ACCOUNTS_SOURCE.includes(field)));

t.assert('every projection in this module is a whitelist, never an exclusion', () => {
    const blocks = ACCOUNTS_SOURCE.match(/_PROJECTION\s*=\s*\{[\s\S]*?\}\s*as const/g) ?? [];
    return blocks.length >= 4 && blocks.every((block) => !/:\s*(0|false)\s*[,}]/.test(block));
});

t.assert('the DTOs name their fields — no spread of a read model', () =>
    !/\.\.\.row[,\s}]/.test(ACCOUNTS_SOURCE)
    && !/\.\.\.owner[,\s}]/.test(ACCOUNTS_SOURCE));

/**
 * The account view is a READ, and reads are not audited: a read leaves no state to
 * reconstruct, so the permission gate is the whole control. The one exception in the service
 * is the payout-destination disclosure, whose output is the material a fraudulent payout
 * instruction is built from — and it lives in the money module, behind its own permission.
 */
t.assert('this module writes nothing, and audits nothing', () =>
    !ACCOUNTS_SOURCE.includes('auditedAttempt')
    && !ACCOUNTS_SOURCE.includes('auditedTransaction')
    && !ACCOUNTS_SOURCE.includes('recordEvent')
    && !/method:\s*'(POST|PATCH|PUT|DELETE)'/.test(ACCOUNTS_SOURCE));

// ─────────────────────────────────────────────────────────────────────────────
t.section('6. The route manifest — every gate is a composition');

const accountRoutes = routeManifest().filter((route) => route.fullPath.startsWith('/api/v1/accounts'));

t.assert('five routes are declared on /accounts, and all of them are GETs', () =>
    accountRoutes.length === 5 && accountRoutes.every((route) => route.method === 'get'));

t.assert('every one of them declares a permission — none is public or self-service', () =>
    accountRoutes.every((route) => route.access.kind === 'permission' && route.access.mode === 'all'));

/**
 * **The authorization design of the mount, in one assertion.** The account view carries
 * earnings balances, a subscriber plan and a COD liability, so it requires the permission
 * that owns each. Gating it on one `accounts.read` would be a side door onto all three.
 */
t.assert('the account view requires all three families, in `all` mode', () => {
    const route = accountRoutes.find((r) => r.fullPath === '/api/v1/accounts/:ownerType/:ownerId');
    if (route?.access.kind !== 'permission') return false;
    const held = [...route.access.permissions] as string[];
    return route.access.mode === 'all'
        && ['money.earnings.read', 'billing.plans.read', 'cod.overview.read']
            .every((name) => held.includes(name));
});

/**
 * ...and each sub-route narrows to the family whose data it carries, so an administrator who
 * may work the payout queue but not see a COD position gets exactly that, on one account.
 */
t.assert('...while each sub-route narrows to the single family it reads', () => {
    const of = (suffix: string) => {
        const route = accountRoutes.find((r) => r.fullPath.endsWith(suffix));
        return route?.access.kind === 'permission' ? [...route.access.permissions].join() : '';
    };
    return of('/payouts') === 'money.payouts.read'
        && of('/credits') === 'billing.plans.read'
        && of('/cash-ledger') === 'cod.overview.read';
});

/**
 * The activity feed carries plan, credit, earning and payout rows — and deliberately NO cash
 * movements, which is why `cod.overview.read` is absent from it. Those are a liability rather
 * than owner value and live at `/cash-ledger` behind their own gate.
 */
t.assert('the activity feed needs earnings and billing, and NOT the COD permission', () => {
    const route = accountRoutes.find((r) => r.fullPath.endsWith('/activity'));
    if (route?.access.kind !== 'permission') return false;
    return route.access.permissions.includes('money.earnings.read')
        && route.access.permissions.includes('billing.plans.read')
        && !route.access.permissions.includes('cod.overview.read');
});

/**
 * **No `accounts` permission family is added, and that is a decision rather than an
 * omission.** A new family would need `PermissionFamily`, `tier-grants.ts` and the audit
 * family assertion — for permissions that duplicate `money.earnings.read` +
 * `billing.plans.read` + `cod.overview.read` semantically.
 */
t.assert('no `accounts.*` permission exists in the catalog', () =>
    !Object.keys(PERMISSION_CATALOG).some((name) => name.startsWith('accounts.')));

/**
 * Route order. `/:ownerType/:ownerId` is the only two-segment path, and everything else sits
 * one level below it — so no literal can be swallowed by a parameter. A literal first segment
 * added later WOULD be captured by `:ownerType` and rejected by its enum as a 400 rather than
 * routed, which is why the enum matters beyond validation.
 */
t.assert('no literal first segment exists that :ownerType would swallow', () =>
    accountRoutes.every((route) => {
        const tail = route.fullPath.replace('/api/v1/accounts/', '');
        return tail.startsWith(':ownerType/');
    }));

process.exit(t.finish());
