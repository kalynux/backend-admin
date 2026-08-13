import { Document, Filter, ObjectId } from 'mongodb';
import { Types } from 'mongoose';
import { toMongoSort } from '../../../core/data/mongo-list';
import { ListQueryBase } from '../../../core/http/list-query';
import { COLLECTIONS } from '../../../infra/platform/collections';
import { Paginated, PlatformReadRepository } from '../../../infra/platform/platform.repository';
import { DISCREPANCY_SORT } from '../validators/cod.validator';

/**
 * The COD cash chain's RECORDS: remittances, deposits and discrepancies.
 *
 * ── This file is why the COD module stopped being purely delegated ────────────
 * Phase 4 delegated everything here, on the stated premise that "COD reads are aggregates
 * over cash accounts, collections and ledgers whose derivation jovi-mall owns — a second
 * implementation would be a second opinion about how much money exists."
 *
 * That premise holds for the OVERVIEW and for nothing else. ADR-009 D-1 drew the line
 * where it actually falls: **delegate a read whose answer is a verdict the platform acts
 * on; read directly a read whose answer is a record.** A remittance row is a record. It is
 * append-only in spirit — status moves `declared → confirmed | rejected` exactly once and
 * amounts are immutable — and `find({ status: 'declared' })` cannot leave anything
 * inconsistent. The same is true of a deposit and of a discrepancy.
 *
 * Every WRITE stays delegated, and on this module that is not a formality. Confirming a
 * remittance settles collections FIFO inside one transaction and unlocks the escrow they
 * back; recording a direct deposit clears BOTH legs of the chain at once and emits
 * `cod.deposit.recorded`, whose two in-process subscribers write the agent's and the
 * agency's notifications. `PlatformReadRepository` has no write method, so nothing here
 * could reach that by accident.
 *
 * ── Three repositories in one file ───────────────────────────────────────────
 * Matching `order-context.read.repository.ts`: each is a handful of lines over one
 * collection this module reads, they share a vocabulary and a set of party ids, and three
 * files of forty lines would be filing rather than structure.
 *
 * ── On indexes ───────────────────────────────────────────────────────────────
 * Unlike `subscriber_plans` at step 3, none of these three needed one added. All carry
 * `{status: 1, created_at: -1}` (and remittances/deposits a per-party compound), which is
 * the shape the queues actually run: a COD list is opened filtered — the declared
 * remittances, the open discrepancies. An UNFILTERED page falls back to an in-memory sort,
 * which is exactly what jovi-mall's own admin list does over the same collection today.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Agency remittances — the agency handing cash up to the platform
// ─────────────────────────────────────────────────────────────────────────────

export interface AgencyRemittanceReadModel extends Document {
    _id: ObjectId;
    agency_id: ObjectId;
    amount: number;
    currency?: string | null;
    /** The external bank/transfer/receipt id. The evidence, not a credential. */
    reference?: string | null;
    note?: string | null;
    status: string;
    declared_by_user_id?: ObjectId | null;
    declared_at?: Date | null;
    resolved_at?: Date | null;
    resolved_by_user_id?: ObjectId | null;
    /** `'admin'` means the id is a wi-admin one and resolves in NEITHER database's users. */
    resolved_by_source?: string;
    resolved_by_name?: string | null;
    rejection_reason?: string | null;
    created_at: Date;
    updated_at: Date;
}

/**
 * A whitelist, as everywhere — though this collection holds nothing secret.
 *
 * Worth stating what `reference` is, because it looks like it might be: an external
 * money-movement id (a bank transfer reference, a mobile-money receipt). It is the
 * evidence tying a declaration to real money, it is what an operator quotes when
 * reconciling a statement, and nothing can be charged with it. Contrast
 * `payout_requests.payout_method_snapshot`, which holds where money is *sent* — that one
 * is masked by projection and revealed only through an audited endpoint.
 */
const REMITTANCE_PROJECTION = {
    _id: 1,
    agency_id: 1,
    amount: 1,
    currency: 1,
    reference: 1,
    note: 1,
    status: 1,
    declared_by_user_id: 1,
    declared_at: 1,
    resolved_at: 1,
    resolved_by_user_id: 1,
    resolved_by_source: 1,
    resolved_by_name: 1,
    rejection_reason: 1,
    created_at: 1,
    updated_at: 1,
} as const;

export class AgencyRemittanceReadRepository extends PlatformReadRepository<AgencyRemittanceReadModel> {
    constructor() {
        super(COLLECTIONS.AGENCY_REMITTANCE, REMITTANCE_PROJECTION);
    }

    async findById(remittanceId: string): Promise<AgencyRemittanceReadModel | null> {
        if (!Types.ObjectId.isValid(remittanceId)) return null;
        return this.findOneBy({ _id: new ObjectId(remittanceId) } as Filter<AgencyRemittanceReadModel>);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent deposits — the agent handing cash back, to the agency or the platform
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentDepositReadModel extends Document {
    _id: ObjectId;
    agent_id: ObjectId;
    /** The contract this cash was collected under. Always set, platform deposits included. */
    agency_id: ObjectId;
    amount: number;
    currency?: string | null;
    note?: string | null;
    recipient: string;
    status: string;
    reference?: string | null;
    declared_by_user_id?: ObjectId | null;
    declared_at?: Date | null;
    recorded_by_user_id?: ObjectId | null;
    /**
     * Unlike every other actor stamp this service reads, this one carries BOTH kinds by
     * design: the same three methods are reached by the agency desk and by the platform.
     * The discriminator is therefore the only way to tell an agency user's id from an
     * administrator's.
     */
    recorded_by_source?: string;
    recorded_by_name?: string | null;
    resolved_at?: Date | null;
    rejection_reason?: string | null;
    created_at: Date;
    updated_at: Date;
}

const DEPOSIT_PROJECTION = {
    _id: 1,
    agent_id: 1,
    agency_id: 1,
    amount: 1,
    currency: 1,
    note: 1,
    recipient: 1,
    status: 1,
    reference: 1,
    declared_by_user_id: 1,
    declared_at: 1,
    recorded_by_user_id: 1,
    recorded_by_source: 1,
    recorded_by_name: 1,
    resolved_at: 1,
    rejection_reason: 1,
    created_at: 1,
    updated_at: 1,
} as const;

export class AgentDepositReadRepository extends PlatformReadRepository<AgentDepositReadModel> {
    constructor() {
        super(COLLECTIONS.AGENT_DEPOSIT, DEPOSIT_PROJECTION);
    }

    async findById(depositId: string): Promise<AgentDepositReadModel | null> {
        if (!Types.ObjectId.isValid(depositId)) return null;
        return this.findOneBy({ _id: new ObjectId(depositId) } as Filter<AgentDepositReadModel>);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Discrepancies — a flagged problem in the chain
// ─────────────────────────────────────────────────────────────────────────────

export interface CodDiscrepancyReadModel extends Document {
    _id: ObjectId;
    agent_id: ObjectId;
    agency_id: ObjectId;
    type: string;
    /** Money at stake, in minor units. `null` for a non-monetary flag. */
    amount?: number | null;
    currency?: string | null;
    status: string;
    raised_by: string;
    raised_by_user_id?: ObjectId | null;
    /** The deposit at issue — set for `deposit_not_confirmed` and for agent disputes. */
    deposit_id?: ObjectId | null;
    note?: string | null;
    resolution_note?: string | null;
    resolved_by_user_id?: ObjectId | null;
    opened_at?: Date | null;
    resolved_at?: Date | null;
    created_at: Date;
    updated_at: Date;
}

const DISCREPANCY_PROJECTION = {
    _id: 1,
    agent_id: 1,
    agency_id: 1,
    type: 1,
    amount: 1,
    currency: 1,
    status: 1,
    raised_by: 1,
    raised_by_user_id: 1,
    deposit_id: 1,
    note: 1,
    resolution_note: 1,
    resolved_by_user_id: 1,
    opened_at: 1,
    resolved_at: 1,
    created_at: 1,
    updated_at: 1,
} as const;

export interface DiscrepancySearchQuery extends ListQueryBase {
    status?: string;
    type?: string;
    agencyId?: string;
    agentId?: string;
    from?: Date;
    to?: Date;
}

export class CodDiscrepancyReadRepository extends PlatformReadRepository<CodDiscrepancyReadModel> {
    constructor() {
        super(COLLECTIONS.COD_DISCREPANCY, DISCREPANCY_PROJECTION);
    }

    async search(query: DiscrepancySearchQuery): Promise<Paginated<CodDiscrepancyReadModel>> {
        return this.findPage(buildDiscrepancyFilter(query), {
            page: query.page,
            limit: query.limit,
            sort: toMongoSort(query.sort, DISCREPANCY_SORT),
        });
    }

    async findById(discrepancyId: string): Promise<CodDiscrepancyReadModel | null> {
        if (!Types.ObjectId.isValid(discrepancyId)) return null;
        return this.findOneBy({ _id: new ObjectId(discrepancyId) } as Filter<CodDiscrepancyReadModel>);
    }
}

/**
 * Pure, and exported so `test-cod.ts` can assert every branch without a database.
 *
 * Note there is no `search` term anywhere in this module. A discrepancy is found by the
 * party it is against, its type or its state — never by free text — so no `$regex` reaches
 * these collections at all, and the escaping hazard `containsInsensitive` exists for does
 * not arise.
 */
export function buildDiscrepancyFilter(
    query: DiscrepancySearchQuery,
): Filter<CodDiscrepancyReadModel> {
    const clauses: Record<string, unknown>[] = [];

    if (query.status) clauses.push({ status: query.status });
    if (query.type) clauses.push({ type: query.type });
    if (query.agencyId) clauses.push({ agency_id: toObjectIdOrNothing(query.agencyId) });
    if (query.agentId) clauses.push({ agent_id: toObjectIdOrNothing(query.agentId) });

    if (query.from || query.to) {
        const range: Record<string, Date> = {};
        if (query.from) range.$gte = query.from;
        // Half-open `[from, to)`, matching `dateRangeFields` — consecutive ranges tile
        // exactly and no row is counted twice at a boundary.
        if (query.to) range.$lt = query.to;
        clauses.push({ created_at: range });
    }

    if (clauses.length === 0) return {} as Filter<CodDiscrepancyReadModel>;
    if (clauses.length === 1) return clauses[0] as Filter<CodDiscrepancyReadModel>;

    // `$and` for the reason every filter in this service composes with it: assignment
    // drops a duplicate key, and two of these clauses can share one.
    return { $and: clauses } as Filter<CodDiscrepancyReadModel>;
}

/**
 * A malformed id becomes a term that matches nothing, rather than a thrown BSONError.
 *
 * Every id reaching this builder through a route has already passed `objectId` at the
 * edge, so this is only reachable from a hand-built query — and a filter that matches
 * nothing is the honest answer there.
 */
function toObjectIdOrNothing(value: string): ObjectId | { $in: [] } {
    return Types.ObjectId.isValid(value) && value.length === 24
        ? new ObjectId(value)
        : { $in: [] };
}
