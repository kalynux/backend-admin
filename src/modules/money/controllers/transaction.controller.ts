import { Request, Response } from 'express';
import { Document, ObjectId } from 'mongodb';
import { asyncHandler } from '../../../core/http/async-handler';
import { createAppError } from '../../../core/errors/app-error';
import { ERROR_CODES } from '../../../core/errors/error-codes';
import { sendSuccess } from '../../../core/http/responses';
import { AdminIdentity, requireAdminIdentity } from '../../admin-identity/domain/admin-identity.types';
import { AgencyReadRepository } from '../../agencies/repositories/agency.read.repository';
import { AgentReadRepository } from '../../agents/repositories/agent.read.repository';
import { actorContextOf } from '../../audit/domain/audit-context';
import { recordAuthorizationDenial } from '../../authorization/domain/denial.recorder';
import { hasPermission, missingPermissions } from '../../authorization/domain/permission.resolver';
import { OrderReadRepository } from '../../orders/repositories/order.read.repository';
import {
    findCustomerNamesByIds,
    findCustomerNamesByUserIds,
} from '../../users/repositories/role-profile.read.repository';
import { StoreReadRepository } from '../../vendors/repositories/store.read.repository';
import {
    PLATFORM_OWNER_TYPES,
    TRANSACTION_SOURCES,
    TransactionCandidate,
    TransactionCursor,
    TransactionFilter,
    TransactionRowContext,
    TransactionSort,
    TransactionViewer,
    buildSourceFilter,
    decodeCursor,
    foldSummary,
    keysetClause,
    mergeTransactionPage,
    mongoSortOf,
    partyKey,
    resolveWindow,
    sortToken,
    toCandidate,
    viewerFor,
    withKeyset,
} from '../domain/transaction-sources';
import { toAllocationDto } from '../read-models/money.dto';
import {
    TRANSACTION_KINDS,
    TransactionDetailDto,
    TransactionKind,
    TransactionRecordDto,
    TransactionRowDto,
    TransactionSummaryGroupDto,
    TransactionWithheldDto,
} from '../read-models/transaction.dto';
import { EarningsAllocationReadRepository } from '../repositories/earnings.read.repository';
import {
    EarningsAccountCurrencyReadRepository,
    TRANSACTION_REPOSITORIES,
} from '../repositories/transaction.read.repository';
import {
    ListTransactionsQuery,
    TransactionParams,
    TransactionSummaryQuery,
} from '../validators/transaction.validator';

/**
 * `/api/v1/money/transactions` — every money movement on the platform in one list (BR-027).
 *
 * Three reads, all DIRECT (ADR-009 D-1: these are records, and nothing here derives a
 * balance). The rules — which kinds exist, how a filter translates, how the merge pages —
 * are `domain/transaction-sources.ts`; this file wires them to the database and decides
 * what the caller may be sent.
 *
 * ── Nobody sees more here than they do today ──────────────────────────────────
 * The route opens to anybody holding one of the existing money or COD reads, and each KIND
 * is sent only to a caller who holds the reads that kind's own screens require. So Support
 * gets payments, refunds, payouts and the three COD kinds; tiers 1–2 get all eleven. The platform's
 * own ledger rows go to tier 1 alone. `meta.withheld` names what was left out, so a screen
 * can say the list is partial instead of looking complete.
 */

const allocations = new EarningsAllocationReadRepository();
const accountCurrencies = new EarningsAccountCurrencyReadRepository();
const orderNumbers = new OrderReadRepository();
const stores = new StoreReadRepository();
const agencies = new AgencyReadRepository();
const agents = new AgentReadRepository();

/** How many related transactions the detail read returns before it says `truncated`. */
const RELATED_LIMIT = 50;
/** A cart payment can settle many orders; the detail read follows this many of them. */
const RELATED_ORDER_LIMIT = 5;

function viewerOf(admin: AdminIdentity): TransactionViewer {
    return viewerFor((permission) => hasPermission(admin.tier, permission));
}

function withheldFor(viewer: TransactionViewer): TransactionWithheldDto {
    return {
        kinds: TRANSACTION_KINDS.filter((kind) => !viewer.kinds.has(kind)),
        platformAccounts: !viewer.seesPlatformAccounts,
    };
}

/**
 * Ask every source that can match, and merge. `limit + 1` from each, so the merge knows
 * whether anything is left without a count.
 */
async function collect(
    filter: TransactionFilter,
    viewer: TransactionViewer,
    sort: TransactionSort,
    limit: number,
    cursor: TransactionCursor | null,
): Promise<{ items: TransactionCandidate[]; nextCursor: string | null }> {
    const pages = await Promise.all(
        TRANSACTION_KINDS.map(async (kind): Promise<TransactionCandidate[]> => {
            const source = TRANSACTION_SOURCES[kind];
            const native = buildSourceFilter(source, filter, viewer);
            if (!native) return [];

            const rows = await TRANSACTION_REPOSITORIES[kind].page(
                withKeyset(native, cursor ? keysetClause(source, sort, cursor) : null),
                mongoSortOf(source, sort),
                limit + 1,
            );
            return rows.map((row) => toCandidate(source, sort, row));
        }),
    );
    return mergeTransactionPage(pages, sort, limit);
}

function objectIds(values: Iterable<string>): ObjectId[] {
    return [...new Set(values)].filter((value) => /^[a-f\d]{24}$/i.test(value)).map((value) => new ObjectId(value));
}

/**
 * Names and ledger currencies for a set of rows — one batched read per directory present,
 * never one per row.
 *
 * The name is the BUSINESS one where there is one (a Store, a Magazin), as on every other
 * money list. A platform account resolves to `null`, which is the answer rather than a gap.
 *
 * ── The payer of a payment (BR-027 D-7) ───────────────────────────────────────
 * `payment_transactions.userId` is a CUSTOMER id on an order payment and a USER id on a
 * booking payment, and nothing on the row says which. Both are tried, customer id first; an
 * ObjectId exists in one collection, so a hit names the right person and a miss stays
 * `null`. Never a guess.
 */
async function hydrate(
    candidates: TransactionCandidate[],
    extraParties: { role: string; id: string | null }[] = [],
): Promise<TransactionRowContext> {
    const parties = [
        ...candidates.map((candidate) => TRANSACTION_SOURCES[candidate.kind].party(candidate.row)),
        ...extraParties,
    ];
    const idsFor = (role: string): ObjectId[] =>
        objectIds(parties.filter((party) => party.role === role && party.id).map((party) => party.id as string));

    const customerIds = idsFor('customer');
    const [vendorNames, agencyNames, agentNames, customersById, currencies] = await Promise.all([
        stores.findNamesByVendorIds(idsFor('vendor')),
        agencies.findNamesByIds(idsFor('agency')),
        agents.findNamesByIds(idsFor('agent')),
        findCustomerNamesByIds(customerIds),
        accountCurrencies.findCurrencies(
            candidates.filter((candidate) => candidate.kind === 'ledger_entry').map((candidate) => String(candidate.row.account_id)),
        ),
    ]);
    const customersByUserId = await findCustomerNamesByUserIds(
        customerIds.filter((customerId) => !customersById.has(customerId.toString())),
    );

    const names = new Map<string, string | null>();
    const absorb = (role: string, found: Map<string, string | null>): void => {
        found.forEach((name, foundId) => names.set(partyKey(role, foundId), name));
    };
    absorb('vendor', vendorNames);
    absorb('agency', agencyNames);
    absorb('agent', agentNames);
    absorb('customer', customersByUserId);
    absorb('customer', customersById);

    return { names, currencies };
}

function toRows(candidates: TransactionCandidate[], context: TransactionRowContext): TransactionRowDto[] {
    return candidates.map((candidate) => TRANSACTION_SOURCES[candidate.kind].toRow(candidate.row, context));
}

function isPlatformOwned(kind: TransactionKind, row: Document): boolean {
    const role = TRANSACTION_SOURCES[kind].role;
    return 'field' in role && (PLATFORM_OWNER_TYPES as readonly string[]).includes(String(row[role.field]));
}

export class TransactionController {
    /**
     * GET /api/v1/money/transactions — the list.
     *
     * Cursor-paged and carries no `total`: eleven `countDocuments` per page turn is the price
     * of a number the screen does not need to walk the list. `/summary` has the counts for a
     * screen that wants them, asked once rather than per page.
     */
    static list = asyncHandler(async (req: Request, res: Response) => {
        const admin = requireAdminIdentity(req);
        const { limit, cursor, sort, ...terms } = req.query as unknown as ListTransactionsQuery;
        const viewer = viewerOf(admin);
        const window = resolveWindow(terms.from, terms.to);

        const page = await collect({ ...terms, ...window }, viewer, sort, limit, cursor ? decodeCursor(cursor) : null);
        const context = await hydrate(page.items);

        sendSuccess(res, toRows(page.items, context), {
            meta: {
                limit,
                nextCursor: page.nextCursor,
                hasMore: page.nextCursor !== null,
                sort: sortToken(sort),
                window: { from: window.from.toISOString(), to: window.to.toISOString() },
                withheld: withheldFor(viewer),
            },
        });
    });

    /**
     * GET /api/v1/money/transactions/summary — counts and sums of the same filtered set.
     *
     * A group-by of the list's own columns: one cell per `(kind, direction, outcome,
     * currency)`, each with a row count and Σ `amount`. Nothing is netted. The service does
     * not add a pay-in to a pay-out or one currency to another, and it never totals
     * `internal` rows into anything — a hold and its release are the same money twice.
     */
    static summary = asyncHandler(async (req: Request, res: Response) => {
        const admin = requireAdminIdentity(req);
        const terms = req.query as unknown as TransactionSummaryQuery;
        const viewer = viewerOf(admin);
        const window = resolveWindow(terms.from, terms.to);
        const filter: TransactionFilter = { ...terms, ...window };

        const perKind = await Promise.all(
            TRANSACTION_KINDS.map(async (kind): Promise<TransactionSummaryGroupDto[]> => {
                const source = TRANSACTION_SOURCES[kind];
                const native = buildSourceFilter(source, filter, viewer);
                if (!native) return [];
                return foldSummary(source, await TRANSACTION_REPOSITORIES[kind].summarise(native));
            }),
        );
        const groups = perKind.flat();

        sendSuccess(res, {
            count: groups.reduce((total, group) => total + group.count, 0),
            groups,
            window: { from: window.from.toISOString(), to: window.to.toISOString() },
            withheld: withheldFor(viewer),
        });
    });

    /**
     * GET /api/v1/money/transactions/:kind/:id — one row and what it is connected to.
     *
     * `related.transactions` is the same list, filtered to the row's order(s) or booking and
     * graded for the same caller — so a payment opens with its refunds, its delivery
     * top-ups and (for tiers 1–2) the earnings movements it caused, without this handler
     * knowing what any of those are. A kind that already has a full read of its own
     * (`recordPath`) is not re-composed here.
     *
     * A kind the caller may not read is a 403 naming the permission; a platform ledger row
     * below tier 1 is a 404, the denial this service gives for an out-of-scope record.
     */
    static detail = asyncHandler(async (req: Request, res: Response) => {
        const admin = requireAdminIdentity(req);
        const { kind, id: rowId } = req.params as unknown as TransactionParams;
        const viewer = viewerOf(admin);
        const source = TRANSACTION_SOURCES[kind];

        if (!viewer.kinds.has(kind)) {
            const required = missingPermissions(admin.tier, source.permissions);
            const context = actorContextOf(req);
            recordAuthorizationDenial({
                kind: 'permission',
                adminId: admin.adminId,
                tier: admin.tier,
                sessionId: admin.sessionId,
                required,
                reason: ERROR_CODES.AUTHZ_PERMISSION_DENIED,
                targetId: rowId,
                method: context.method,
                path: context.path,
                requestId: context.requestId,
                ip: context.ip,
                userAgent: context.userAgent,
            });
            throw createAppError(ERROR_CODES.AUTHZ_PERMISSION_DENIED, 403, undefined, { required });
        }

        const row = await TRANSACTION_REPOSITORIES[kind].findById(rowId);
        if (!row || (isPlatformOwned(kind, row) && !viewer.seesPlatformAccounts)) {
            throw createAppError(ERROR_CODES.NOT_FOUND, 404, 'Transaction not found');
        }

        const sort: TransactionSort = { field: 'createdAt', direction: 1 };
        const self = toCandidate(source, sort, row);

        // The ledger entry's allocation — the row that says when this money is released.
        const allocation = kind === 'ledger_entry' && row.allocation_id
            ? await allocations.findById(String(row.allocation_id))
            : null;

        const bare = source.toRow(row, { names: new Map(), currencies: new Map() });
        const related = await relatedTo(bare, viewer, sort);

        const context = await hydrate([self, ...related.items], [
            // The secondary parties a record names: a refund’s vendor, a collection’s agent.
            { role: 'vendor', id: bare.links.vendorId },
            { role: 'agency', id: bare.links.agencyId },
            { role: 'agent', id: bare.links.agentId },
            ...(allocation
                ? [{ role: allocation.beneficiary_type, id: allocation.beneficiary_id ? allocation.beneficiary_id.toString() : null }]
                : []),
        ]);

        const orderIds = bare.links.orderIds.slice(0, RELATED_ORDER_LIMIT);
        const numbers = orderIds.length > 0 ? await orderNumbers.findNumbersByIds(orderIds) : new Map<string, string | null>();

        let record: TransactionRecordDto | null = source.toRecord ? source.toRecord(row, context) : null;
        if (record?.kind === 'ledger_entry') {
            record = { ...record, allocation: allocation ? toAllocationDto(allocation, context.names as Map<string, string | null>) : null };
        }

        const detail: TransactionDetailDto = {
            transaction: source.toRow(row, context),
            record,
            recordPath: source.recordPath ? source.recordPath(rowId) : null,
            related: {
                orders: orderIds.map((orderId) => ({ id: orderId, orderNumber: numbers.get(orderId) ?? null })),
                transactions: toRows(related.items, context),
                truncated: related.truncated,
            },
        };
        sendSuccess(res, detail, { meta: { withheld: withheldFor(viewer) } });
    });
}

/**
 * Every other transaction on the same order(s) or booking, oldest first.
 *
 * One list query per linked record, unwindowed in effect (an order's money is a handful of
 * rows whenever they were written) and graded by the same viewer as the list.
 */
async function relatedTo(
    row: TransactionRowDto,
    viewer: TransactionViewer,
    sort: TransactionSort,
): Promise<{ items: TransactionCandidate[]; truncated: boolean }> {
    const everything = { from: new Date(0), to: new Date(Date.now() + 86_400_000) };
    const scopes: TransactionFilter[] = [
        ...row.links.orderIds.slice(0, RELATED_ORDER_LIMIT).map((orderId) => ({ ...everything, orderId })),
        ...(row.links.bookingId ? [{ ...everything, bookingId: row.links.bookingId }] : []),
    ];
    if (scopes.length === 0) return { items: [], truncated: false };

    const pages = await Promise.all(scopes.map((scope) => collect(scope, viewer, sort, RELATED_LIMIT, null)));

    // A cart payment's orders can share a transaction, so the union is de-duplicated.
    const seen = new Set<string>([`${row.kind}:${row.id}`]);
    const merged = pages
        .flatMap((page) => page.items)
        .filter((candidate) => {
            const key = `${candidate.kind}:${candidate.id}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .sort((a, b) => a.value - b.value || (a.id < b.id ? -1 : 1));

    return {
        items: merged.slice(0, RELATED_LIMIT),
        truncated: merged.length > RELATED_LIMIT || pages.some((page) => page.nextCursor !== null),
    };
}
