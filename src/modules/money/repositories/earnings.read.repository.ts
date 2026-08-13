import { Document, Filter, ObjectId } from 'mongodb';
import { Types } from 'mongoose';
import { toMongoSort } from '../../../core/data/mongo-list';
import { ListQueryBase } from '../../../core/http/list-query';
import { COLLECTIONS } from '../../../infra/platform/collections';
import { Paginated, PlatformReadRepository } from '../../../infra/platform/platform.repository';
import { ALLOCATION_SORT, LEDGER_SORT } from '../validators/money.validator';

/**
 * The earnings RECORDS: the append-only ledger, the allocations every split is computed
 * from, and the agency rolling-reserve slices.
 *
 * ── Why these three are read and the BALANCES are not ─────────────────────────
 * ADR-009 D-1, at its sharpest. An `earnings_ledgers` row is append-only in the strongest
 * sense the platform has — `updatedAt: false` on the schema, written inside the same
 * transaction as the balance move it describes, and never touched again. An allocation is
 * nearly as strict: one row per `(source, beneficiary)` behind a unique index, and its
 * only mutations are the three status stamps. `find()` over either protects no invariant.
 *
 * A BALANCE is the opposite. `getBalances` reconciles four sub-balances that only
 * jovi-mall's transactions move, and a second implementation of that arithmetic here would
 * be a second opinion about how much money exists. So `/money/earnings/platform` and
 * `/money/earnings/accounts` are delegated (see the gateway) while this file serves the
 * rows underneath them.
 *
 * The pair is the point: the ledger says what MOVED and the balance says what IS, and only
 * one of those is safe to derive twice.
 *
 * ── Three repositories in one file ───────────────────────────────────────────
 * Matching `cod-record.read.repository.ts` and `order-context.read.repository.ts`: each is
 * a projection and a handful of queries over one collection this module reads, and they
 * share a vocabulary — `owner_type`/`owner_id`, `source_type`/`source_id`, `allocation_id`
 * — that only reads the same way when it is written down once.
 *
 * ── On indexes ───────────────────────────────────────────────────────────────
 * Nothing needed adding, unlike `subscriber_plans` at step 3. Every query here selects
 * through an index the platform's own workers already depend on:
 *
 *   ledger        `{owner_type, owner_id, created_at: -1}` — the platform-scoped feed
 *   allocations   `{beneficiary_type, beneficiary_id, created_at: -1}` for a beneficiary's
 *                 rows, `{status, hold_release_at}` for the release queue, and the unique
 *                 `(source_type, source_id, beneficiary_type, beneficiary_id)` for a source
 *   reserve holds `{owner_id, status}`
 *
 * The one shape with no index behind it is an UNFILTERED allocation page, which falls back
 * to an in-memory sort — the same fallback jovi-mall's own admin lists take, and
 * `verify-money-live.ts` reports any `COLLSCAN` rather than letting it pass unnoticed.
 */

// ─────────────────────────────────────────────────────────────────────────────
// The ledger — every money movement on an earnings account
// ─────────────────────────────────────────────────────────────────────────────

export interface EarningsLedgerReadModel extends Document {
    _id: ObjectId;
    account_id: ObjectId;
    owner_type: string;
    /** `null` for the platform singleton — the marketplace's own commission account. */
    owner_id?: ObjectId | null;
    /** `hold` · `release` · `reversal` · `reserve_hold` · `reserve_release`. */
    entry_type: string;
    /** The positive magnitude moved. `entry_type` says which direction. */
    amount: number;
    pending_after: number;
    available_after: number;
    source_type: string;
    source_id: ObjectId;
    allocation_id: ObjectId;
    reason_code: string;
    created_at: Date;
}

/**
 * A whitelist, as everywhere — though this collection holds nothing sensitive.
 *
 * `pending_after` and `available_after` are projected deliberately: they are the balances
 * as they stood immediately after the entry, and they are what makes a ledger auditable
 * rather than merely readable. Without them a reader can see that money moved and cannot
 * check that the movements add up.
 */
const LEDGER_PROJECTION = {
    _id: 1,
    account_id: 1,
    owner_type: 1,
    owner_id: 1,
    entry_type: 1,
    amount: 1,
    pending_after: 1,
    available_after: 1,
    source_type: 1,
    source_id: 1,
    allocation_id: 1,
    reason_code: 1,
    created_at: 1,
} as const;

export interface LedgerSearchQuery extends ListQueryBase {
    entryType?: string;
    reasonCode?: string;
    sourceType?: string;
    from?: Date;
    to?: Date;
    /**
     * Cursor for the account activity feed (`listBefore`). Not reachable from
     * `/money/earnings/platform/ledger`, which is offset-paged — `ListPlatformLedgerQuerySchema`
     * does not declare it and is `.strict()`.
     */
    before?: Date;
}

export class EarningsLedgerReadRepository extends PlatformReadRepository<EarningsLedgerReadModel> {
    constructor() {
        super(COLLECTIONS.EARNINGS_LEDGER, LEDGER_PROJECTION);
    }

    /**
     * One owner's ledger. `ownerId` is `null` for the platform singleton, which is not a
     * missing value — `owner_id` is genuinely null on those rows, and a filter that
     * dropped the term would return every owner's ledger under the platform's heading.
     */
    async listForOwner(
        ownerType: string,
        ownerId: string | null,
        query: LedgerSearchQuery,
    ): Promise<Paginated<EarningsLedgerReadModel>> {
        return this.findPage(buildLedgerFilter(ownerType, ownerId, query), {
            page: query.page,
            limit: query.limit,
            sort: toMongoSort(query.sort, LEDGER_SORT),
        });
    }

    /**
     * The movements one allocation caused — what the allocation DID, as opposed to what it
     * says.
     *
     * Unpaged and bounded rather than a page: an allocation produces a handful of entries
     * over its life (a hold, a release, possibly a reserve pair or a reversal), so paging
     * it would be a control with nothing to page. The cap is a guard against a row that
     * somehow accumulated more, not an expected truncation.
     */
    async findForAllocation(allocationId: string): Promise<EarningsLedgerReadModel[]> {
        if (!Types.ObjectId.isValid(allocationId)) return [];
        return this.findBy(
            { allocation_id: new ObjectId(allocationId) } as Filter<EarningsLedgerReadModel>,
            { sort: { created_at: 1, _id: 1 }, limit: 50 },
        );
    }

    /**
     * One source of the account activity feed — rows strictly older than a cursor, newest
     * first.
     *
     * Here rather than in the accounts module for the reason every projection in this
     * service lives beside its collection: `LEDGER_PROJECTION` is declared once, and a
     * second reader of `earnings_ledgers` would be a second whitelist to keep right. The
     * accounts module supplies the cursor and merges; what leaves the database stays this
     * repository's decision.
     */
    async listBefore(
        ownerType: string,
        ownerId: string,
        before: Date | undefined,
        limit: number,
    ): Promise<EarningsLedgerReadModel[]> {
        return this.findBy(
            buildLedgerFilter(ownerType, ownerId, { before } as LedgerSearchQuery),
            { sort: { created_at: -1, _id: -1 }, limit },
        );
    }
}

/**
 * Pure, and exported so `test-money.ts` can assert every branch without a database.
 *
 * The owner terms are pushed in FIRST and unconditionally. They are not a filter the caller
 * supplies — the route already decided whose ledger this is — and building them here rather
 * than in the controller is what stops a future caller composing a query that reads every
 * owner's rows at once.
 */
export function buildLedgerFilter(
    ownerType: string,
    ownerId: string | null,
    query: LedgerSearchQuery,
): Filter<EarningsLedgerReadModel> {
    const clauses: Record<string, unknown>[] = [
        { owner_type: ownerType },
        { owner_id: ownerId === null ? null : toObjectIdOrNothing(ownerId) },
    ];

    if (query.entryType) clauses.push({ entry_type: query.entryType });
    if (query.reasonCode) clauses.push({ reason_code: query.reasonCode });
    if (query.sourceType) clauses.push({ source_type: query.sourceType });

    const range = dateRange(query.from, query.to);
    if (range) clauses.push({ created_at: range });

    /**
     * The account activity feed's cursor — strictly older than, never inclusive, because an
     * inclusive cursor repeats the boundary row on every page and on a money feed that reads
     * as a duplicate transaction.
     *
     * A separate clause rather than folded into `range` above, and separate on purpose: the
     * two can legitimately coexist (a windowed feed that is also being paged), and `$and`
     * composition means neither silently overwrites the other's `created_at` key.
     */
    if (query.before) clauses.push({ created_at: { $lt: query.before } });

    // `$and` for the reason every filter in this service composes with it: assignment drops
    // a duplicate key, and two clauses here can share one.
    return { $and: clauses } as Filter<EarningsLedgerReadModel>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Allocations — the source of truth for one beneficiary's share of one sale
// ─────────────────────────────────────────────────────────────────────────────

export interface EarningsAllocationReadModel extends Document {
    _id: ObjectId;
    source_type: string;
    source_id: ObjectId;
    beneficiary_type: string;
    /** `null` for the platform commission allocation. */
    beneficiary_id?: ObjectId | null;
    /** The order/booking total at split time. An audit snapshot, never recomputed. */
    gross_snapshot: number;
    /** The commission rate applied at split time. The other half of the same snapshot. */
    commission_percent_snapshot: number;
    amount: number;
    currency: string;
    status: string;
    completed_at?: Date | null;
    hold_release_at?: Date | null;
    released_at?: Date | null;
    reversed_at?: Date | null;
    /** COD: the money is physical cash the platform has not necessarily received yet. */
    requires_cash_settlement?: boolean;
    cash_settled_at?: Date | null;
    created_at: Date;
    updated_at: Date;
}

/**
 * The whitelist, and the reason this endpoint exists at all.
 *
 * `requires_cash_settlement`, `cash_settled_at` and `hold_release_at` had **no admin
 * surface anywhere** before Phase 11. Between them they are the entire answer to "why has
 * this beneficiary not been paid", and they were readable only by opening the collection
 * in a shell.
 *
 * The two `*_snapshot` fields are projected for the same reason `pending_after` is on the
 * ledger: they are what makes the row checkable. `amount` alone says what somebody got;
 * with the gross and the rate it says whether that was right.
 */
const ALLOCATION_PROJECTION = {
    _id: 1,
    source_type: 1,
    source_id: 1,
    beneficiary_type: 1,
    beneficiary_id: 1,
    gross_snapshot: 1,
    commission_percent_snapshot: 1,
    amount: 1,
    currency: 1,
    status: 1,
    completed_at: 1,
    hold_release_at: 1,
    released_at: 1,
    reversed_at: 1,
    requires_cash_settlement: 1,
    cash_settled_at: 1,
    created_at: 1,
    updated_at: 1,
} as const;

export interface AllocationSearchQuery extends ListQueryBase {
    beneficiaryType?: string;
    beneficiaryId?: string;
    status?: string;
    sourceType?: string;
    sourceId?: string;
    requiresCashSettlement?: boolean;
    /** Cash is required AND has not arrived — the state a stuck remittance produces. */
    unsettledOnly: boolean;
    from?: Date;
    to?: Date;
}

export class EarningsAllocationReadRepository extends PlatformReadRepository<EarningsAllocationReadModel> {
    constructor() {
        super(COLLECTIONS.EARNINGS_ALLOCATION, ALLOCATION_PROJECTION);
    }

    async search(query: AllocationSearchQuery): Promise<Paginated<EarningsAllocationReadModel>> {
        return this.findPage(buildAllocationFilter(query), {
            page: query.page,
            limit: query.limit,
            sort: toMongoSort(query.sort, ALLOCATION_SORT),
        });
    }

    async findById(allocationId: string): Promise<EarningsAllocationReadModel | null> {
        if (!Types.ObjectId.isValid(allocationId)) return null;
        return this.findOneBy({ _id: new ObjectId(allocationId) } as Filter<EarningsAllocationReadModel>);
    }

    /**
     * Every allocation cut from one sale — the detail view's siblings.
     *
     * A single order produces a platform commission row, a vendor net row and one row per
     * agency; a COD collection adds the agent. Reading them together is the only way to see
     * that the parts sum to the gross, which is the check nothing else on this surface can
     * make. Bounded, for the same reason as `findForAllocation`.
     */
    async findForSource(sourceType: string, sourceId: ObjectId): Promise<EarningsAllocationReadModel[]> {
        return this.findBy(
            { source_type: sourceType, source_id: sourceId } as Filter<EarningsAllocationReadModel>,
            { sort: { created_at: 1, _id: 1 }, limit: 50 },
        );
    }
}

/** Pure, and exported so `test-money.ts` can assert every branch without a database. */
export function buildAllocationFilter(
    query: AllocationSearchQuery,
): Filter<EarningsAllocationReadModel> {
    const clauses: Record<string, unknown>[] = [];

    if (query.beneficiaryType) clauses.push({ beneficiary_type: query.beneficiaryType });
    if (query.beneficiaryId) clauses.push({ beneficiary_id: toObjectIdOrNothing(query.beneficiaryId) });
    if (query.status) clauses.push({ status: query.status });
    if (query.sourceType) clauses.push({ source_type: query.sourceType });
    if (query.sourceId) clauses.push({ source_id: toObjectIdOrNothing(query.sourceId) });

    if (query.requiresCashSettlement !== undefined) {
        clauses.push({ requires_cash_settlement: query.requiresCashSettlement });
    }

    /**
     * The two-field predicate, composed here rather than by the caller.
     *
     * `requires_cash_settlement: true` alone includes every COD allocation the platform has
     * already been paid for, which is most of them — a list that answers "COD" to the
     * question "what is stuck". Adding `cash_settled_at: null` is what narrows it to the
     * money that has not arrived, and pairing the two is exactly the sort of thing a client
     * gets subtly wrong while still rendering a plausible page.
     *
     * Both terms are pushed even when `requiresCashSettlement` was also supplied: `$and`
     * tolerates the duplicate, and dropping it would let `?requiresCashSettlement=false&
     * unsettledOnly=true` resolve to something other than the empty set it must be.
     */
    if (query.unsettledOnly) {
        clauses.push({ requires_cash_settlement: true });
        clauses.push({ cash_settled_at: null });
    }

    const range = dateRange(query.from, query.to);
    if (range) clauses.push({ created_at: range });

    if (clauses.length === 0) return {} as Filter<EarningsAllocationReadModel>;
    if (clauses.length === 1) return clauses[0] as Filter<EarningsAllocationReadModel>;

    return { $and: clauses } as Filter<EarningsAllocationReadModel>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reserve holds — the agency COD rolling reserve
// ─────────────────────────────────────────────────────────────────────────────

export interface EarningsReserveHoldReadModel extends Document {
    _id: ObjectId;
    account_id: ObjectId;
    owner_type: string;
    owner_id: ObjectId;
    amount: number;
    currency: string;
    source_allocation_id: ObjectId;
    status: string;
    held_at: Date;
    release_at: Date;
    released_at?: Date | null;
    created_at: Date;
    updated_at: Date;
}

const RESERVE_HOLD_PROJECTION = {
    _id: 1,
    account_id: 1,
    owner_type: 1,
    owner_id: 1,
    amount: 1,
    currency: 1,
    source_allocation_id: 1,
    status: 1,
    held_at: 1,
    release_at: 1,
    released_at: 1,
    created_at: 1,
    updated_at: 1,
} as const;

/**
 * Built here, consumed at step 7 — the same shape as `billing-settings.read.repository.ts`,
 * which step 3 built for the account view for the same reason.
 *
 * A reserve hold belongs to an AGENCY and nobody else (`owner_type` is a one-member enum in
 * jovi-mall), and it answers a question the earnings balances cannot: a matured slice that
 * has not released is the platform holding an agency's money because that agency has an
 * open cash discrepancy. That is `codExposure.reserveHolds` on the account DTO, and it has
 * no route of its own here because a reserve slice read outside its agency's context is a
 * number with nothing to compare it against.
 */
export class EarningsReserveHoldReadRepository extends PlatformReadRepository<EarningsReserveHoldReadModel> {
    constructor() {
        super(COLLECTIONS.EARNINGS_RESERVE_HOLD, RESERVE_HOLD_PROJECTION);
    }

    /** One agency's reserve slices, newest maturity first. Served by `{owner_id, status}`. */
    async listForOwner(ownerId: string, limit = 50): Promise<EarningsReserveHoldReadModel[]> {
        if (!Types.ObjectId.isValid(ownerId)) return [];
        return this.findBy(
            { owner_id: new ObjectId(ownerId) } as Filter<EarningsReserveHoldReadModel>,
            { sort: { release_at: -1, _id: -1 }, limit },
        );
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Half-open `[from, to)`, matching `dateRangeFields` — consecutive ranges tile exactly and
 * no row is counted twice at a boundary. `null` when neither side was given, so a caller
 * pushes nothing rather than an empty range object.
 */
function dateRange(from?: Date, to?: Date): Record<string, Date> | null {
    if (!from && !to) return null;
    const range: Record<string, Date> = {};
    if (from) range.$gte = from;
    if (to) range.$lt = to;
    return range;
}

/**
 * A malformed id becomes a term that matches nothing, rather than a thrown BSONError.
 *
 * Every id reaching these builders through a route has already passed `objectId` at the
 * edge, so this is only reachable from a hand-built query — and a filter that matches
 * nothing is the honest answer there.
 */
function toObjectIdOrNothing(value: string): ObjectId | { $in: [] } {
    return Types.ObjectId.isValid(value) && value.length === 24
        ? new ObjectId(value)
        : { $in: [] };
}
