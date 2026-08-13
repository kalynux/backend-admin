import { Document, Filter, ObjectId } from 'mongodb';
import { Types } from 'mongoose';
import { toMongoSort } from '../../../core/data/mongo-list';
import { ListQueryBase } from '../../../core/http/list-query';
import { COLLECTIONS } from '../../../infra/platform/collections';
import { Paginated, PlatformReadRepository } from '../../../infra/platform/platform.repository';
import { HOLDER_SORT, TRUST_EVENT_SORT } from '../validators/cod.validator';

/**
 * The physical-cash side of the chain: who is holding it, every movement of it, and the
 * trust score that bounds how much an agent may hold.
 *
 * ── Reading a balance directly, when step 3 refused to ────────────────────────
 * Billing delegates `getBalances` because an earnings balance is a **derivation** — it is
 * reconciled against the ledger before it is reported, and a second implementation would
 * be a second opinion about how much money exists. `cod_cash_accounts.balance` is not that
 * shape. It is a stored scalar guarded by a compare-and-set, written only inside the
 * transaction that appends the matching `cod_cash_ledgers` row, and reported by jovi-mall
 * without arithmetic of any kind. Reading the column is reading the record.
 *
 * What stays delegated is `GET /cod/overview`, and the contrast is exactly the rule:
 * `codSummaryService.adminOverview()` SUMS across every account and cross-references
 * unsettled collections. That total is a derivation, and the platform's own dashboard
 * branches on it.
 *
 * ── Never written from here ──────────────────────────────────────────────────
 * "Never mutate balances directly — go through `CodCashAccountService`, which writes the
 * balance AND an append-only ledger row in one transaction" is jovi-mall's own instruction
 * on this collection. `PlatformReadRepository` has no write method, so this file cannot
 * disobey it.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Cash accounts — the holders
// ─────────────────────────────────────────────────────────────────────────────

export interface CodCashAccountReadModel extends Document {
    _id: ObjectId;
    owner_type: string;
    owner_id: ObjectId;
    /** Outstanding liability, minor units. Never negative — the schema enforces it. */
    balance: number;
    currency?: string | null;
    /** The compare-and-set counter. Read to make a stale screen visible, never written. */
    version?: number;
    created_at: Date;
    updated_at: Date;
}

const CASH_ACCOUNT_PROJECTION = {
    _id: 1,
    owner_type: 1,
    owner_id: 1,
    balance: 1,
    currency: 1,
    version: 1,
    created_at: 1,
    updated_at: 1,
} as const;

export interface HolderSearchQuery extends ListQueryBase {
    ownerType?: string;
    ownerId?: string;
    /** Whether accounts at zero are in scope. Defaulted by the schema, never here. */
    includeSettled: boolean;
}

export class CodCashAccountReadRepository extends PlatformReadRepository<CodCashAccountReadModel> {
    constructor() {
        super(COLLECTIONS.COD_CASH_ACCOUNT, CASH_ACCOUNT_PROJECTION);
    }

    async search(query: HolderSearchQuery): Promise<Paginated<CodCashAccountReadModel>> {
        return this.findPage(buildHolderFilter(query), {
            page: query.page,
            limit: query.limit,
            sort: toMongoSort(query.sort, HOLDER_SORT),
        });
    }
}

/**
 * Pure, and exported so `test-cod.ts` can assert every branch without a database.
 *
 * The `balance > 0` clause is applied FIRST and unconditionally unless asked otherwise,
 * for the same reason the archive scope leads `buildPlanFilter`: it is what the word
 * "holder" means, and a default list carrying settled accounts would report every agent
 * who has ever collected cash as somebody currently owing it.
 */
export function buildHolderFilter(query: HolderSearchQuery): Filter<CodCashAccountReadModel> {
    const clauses: Record<string, unknown>[] = [];

    if (!query.includeSettled) clauses.push({ balance: { $gt: 0 } });
    if (query.ownerType) clauses.push({ owner_type: query.ownerType });
    if (query.ownerId) clauses.push({ owner_id: toObjectIdOrNothing(query.ownerId) });

    // Reachable: `includeSettled=true` with no owner filter is "every cash account".
    // `{ $and: [] }` is not an empty filter — Mongo refuses it at query time.
    if (clauses.length === 0) return {} as Filter<CodCashAccountReadModel>;
    if (clauses.length === 1) return clauses[0] as Filter<CodCashAccountReadModel>;

    return { $and: clauses } as Filter<CodCashAccountReadModel>;
}

// ─────────────────────────────────────────────────────────────────────────────
// The cash ledger — every movement, append-only
// ─────────────────────────────────────────────────────────────────────────────

export interface CodCashLedgerReadModel extends Document {
    _id: ObjectId;
    account_id: ObjectId;
    owner_type: string;
    owner_id: ObjectId;
    entry_type: string;
    /** Signed: positive raises the liability, negative discharges it. */
    amount: number;
    /** The balance immediately after this movement — the audit snapshot. */
    balance_after: number;
    ref_type: string;
    ref_id: ObjectId;
    created_at: Date;
}

const CASH_LEDGER_PROJECTION = {
    _id: 1,
    account_id: 1,
    owner_type: 1,
    owner_id: 1,
    entry_type: 1,
    amount: 1,
    balance_after: 1,
    ref_type: 1,
    ref_id: 1,
    created_at: 1,
} as const;

export class CodCashLedgerReadRepository extends PlatformReadRepository<CodCashLedgerReadModel> {
    constructor() {
        super(COLLECTIONS.COD_CASH_LEDGER, CASH_LEDGER_PROJECTION);
    }

    /**
     * Every movement one remittance or deposit caused.
     *
     * This is what makes the two record details worth opening, and it is the only place
     * the effect of a confirmation is legible. A remittance row says an amount and a
     * status; the ledger rows say what the agency's liability BECAME (`balance_after`) —
     * and for a `recipient: 'platform'` deposit there are **two** of them, one per leg,
     * which is the two-sided settlement made visible rather than described.
     *
     * `ref_id` is not indexed on this collection (`{owner_type, owner_id, created_at}` is),
     * so this is bounded deliberately: a handful of rows per reference, fetched for a
     * single detail view, never for a page of them.
     */
    async findForRef(refId: string): Promise<CodCashLedgerReadModel[]> {
        if (!Types.ObjectId.isValid(refId)) return [];
        return this.findBy(
            { ref_id: new ObjectId(refId) } as Filter<CodCashLedgerReadModel>,
            { sort: { created_at: 1 }, limit: LEDGER_ROWS_PER_REF },
        );
    }

    /**
     * One holder's whole cash history — `GET /accounts/:ownerType/:ownerId/cash-ledger`.
     *
     * Served end to end by `{owner_type, owner_id, created_at: -1}`, which is the index this
     * collection carries and the reason the account view's cash ledger is a separate endpoint
     * rather than a block on the account DTO.
     *
     * Here rather than in the accounts module because `CASH_LEDGER_PROJECTION` is declared
     * once: a second reader of this collection would be a second whitelist to keep right.
     * The accounts module decides who is asking; this decides what leaves the database.
     */
    async listForOwner(
        ownerType: string,
        ownerId: string,
        query: CashLedgerQuery,
    ): Promise<Paginated<CodCashLedgerReadModel>> {
        return this.findPage(buildCashLedgerFilter(ownerType, ownerId, query), {
            page: query.page,
            limit: query.limit,
            sort: toMongoSort(query.sort, CASH_LEDGER_SORT),
        });
    }
}

export const CASH_LEDGER_SORT = {
    createdAt: 'created_at',
    amount: 'amount',
} as const;

export interface CashLedgerQuery extends ListQueryBase {
    entryType?: string;
}

/**
 * Pure, and exported so `test-accounts.ts` can assert it without a database.
 *
 * **The owner terms are pushed in first and unconditionally.** They are not a filter the
 * caller supplies — the route already decided whose ledger this is — and building them here
 * is what stops a future caller composing a query that reads every holder's cash movements
 * at once.
 */
export function buildCashLedgerFilter(
    ownerType: string,
    ownerId: string,
    query: CashLedgerQuery,
): Filter<CodCashLedgerReadModel> {
    const clauses: Record<string, unknown>[] = [
        { owner_type: ownerType },
        { owner_id: toObjectIdOrNothing(ownerId) },
    ];

    if (query.entryType) clauses.push({ entry_type: query.entryType });

    return { $and: clauses } as Filter<CodCashLedgerReadModel>;
}

/**
 * How many ledger rows one reference may contribute to a detail view.
 *
 * A remittance produces one and a platform deposit produces two; the cap is a bound on a
 * query, not a page size, and a reference that somehow produced more has a data problem
 * worth noticing rather than rendering.
 */
export const LEDGER_ROWS_PER_REF = 10;

// ─────────────────────────────────────────────────────────────────────────────
// Trust events — why an agent's COD ceiling moved
// ─────────────────────────────────────────────────────────────────────────────

export interface CodTrustEventReadModel extends Document {
    _id: ObjectId;
    agent_id: ObjectId;
    agency_id?: ObjectId | null;
    event_type: string;
    /** Signed score movement. Negative is a penalty. */
    delta: number;
    /** The agent's score immediately after — the audit snapshot. */
    score_after: number;
    ref_type?: string | null;
    ref_id?: ObjectId | null;
    note?: string | null;
    created_at: Date;
}

const TRUST_EVENT_PROJECTION = {
    _id: 1,
    agent_id: 1,
    agency_id: 1,
    event_type: 1,
    delta: 1,
    score_after: 1,
    ref_type: 1,
    ref_id: 1,
    note: 1,
    created_at: 1,
} as const;

export interface TrustEventSearchQuery extends ListQueryBase {
    eventType?: string;
    from?: Date;
    to?: Date;
}

export class CodTrustEventReadRepository extends PlatformReadRepository<CodTrustEventReadModel> {
    constructor() {
        super(COLLECTIONS.COD_TRUST_EVENT, TRUST_EVENT_PROJECTION);
    }

    /**
     * One agent's trust history, newest first.
     *
     * The agent id is a REQUIRED parameter rather than a filter field, so there is no way
     * to call this without a scope — the collection has no cross-agent read at all. Served
     * by `{agent_id: 1, created_at: -1}`, the only index it carries.
     */
    async listForAgent(
        agentId: string,
        query: TrustEventSearchQuery,
    ): Promise<Paginated<CodTrustEventReadModel>> {
        if (!Types.ObjectId.isValid(agentId)) {
            return { items: [], total: 0, page: query.page, limit: query.limit, pages: 0 };
        }

        return this.findPage(buildTrustEventFilter(agentId, query), {
            page: query.page,
            limit: query.limit,
            sort: toMongoSort(query.sort, TRUST_EVENT_SORT),
        });
    }

    /**
     * The score movements one discrepancy caused — the penalty, made visible beside the
     * flag that produced it.
     *
     * Often empty, and that is a fact worth showing rather than a gap: a
     * `deposit_not_confirmed` flag is the AGENCY's failure and deliberately carries no
     * agent trust penalty, so a discrepancy detail with no trust events is the system
     * working. `late_deposit` is the one that costs the agent.
     */
    async findForDiscrepancy(discrepancyId: string): Promise<CodTrustEventReadModel[]> {
        if (!Types.ObjectId.isValid(discrepancyId)) return [];
        return this.findBy(
            {
                ref_type: 'cod_discrepancy',
                ref_id: new ObjectId(discrepancyId),
            } as Filter<CodTrustEventReadModel>,
            { sort: { created_at: 1 }, limit: LEDGER_ROWS_PER_REF },
        );
    }
}

/**
 * Pure, and exported for the suite. The agent scope is composed in HERE rather than taken
 * from the query, so a caller cannot widen it — the same discipline the audit feeds use
 * for their fixed `targetType`.
 */
export function buildTrustEventFilter(
    agentId: string,
    query: TrustEventSearchQuery,
): Filter<CodTrustEventReadModel> {
    const clauses: Record<string, unknown>[] = [{ agent_id: toObjectIdOrNothing(agentId) }];

    if (query.eventType) clauses.push({ event_type: query.eventType });

    if (query.from || query.to) {
        const range: Record<string, Date> = {};
        if (query.from) range.$gte = query.from;
        if (query.to) range.$lt = query.to;
        clauses.push({ created_at: range });
    }

    if (clauses.length === 1) return clauses[0] as Filter<CodTrustEventReadModel>;
    return { $and: clauses } as Filter<CodTrustEventReadModel>;
}

function toObjectIdOrNothing(value: string): ObjectId | { $in: [] } {
    return Types.ObjectId.isValid(value) && value.length === 24
        ? new ObjectId(value)
        : { $in: [] };
}
