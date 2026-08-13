import { Document, Filter, ObjectId } from 'mongodb';
import { Types } from 'mongoose';
import { toMongoSort } from '../../../core/data/mongo-list';
import { ListQueryBase } from '../../../core/http/list-query';
import { COLLECTIONS } from '../../../infra/platform/collections';
import { Paginated, PlatformReadRepository } from '../../../infra/platform/platform.repository';

/**
 * The agent↔agency relationship itself — `agent_agency_contracts`.
 *
 * ── One repository, two directions ────────────────────────────────────────────
 * `GET /agencies/:id/agents` and `GET /agents/:id/contracts` read the same rows from
 * opposite ends. Same reasoning as the contract-event repository beside it: two copies of
 * one projection is drift waiting to happen, and this projection has the sharper edge of
 * the two — it names money.
 *
 * ── What is joined, and what is not ───────────────────────────────────────────
 * The agency's roster joins the AGENT (a roster is a list of people), and the agent's
 * contract list joins the AGENCY's business name. Both joins run in `aggregatePage`'s
 * `join` half — after skip/limit — so a `$lookup` touches at most one page of documents.
 * Neither list filters or sorts on a joined field, which is what makes that legal here and
 * illegal on the agency directory.
 */

export interface ContractReadModel extends Document {
    _id: ObjectId;
    agent_id: ObjectId;
    agency_id: ObjectId;
    status: string;
    origin?: string;
    is_primary?: boolean;
    cod?: {
        threshold?: number;
        outstanding_balance?: number;
        lifetime_settled?: number;
        last_settled_at?: Date | null;
    };
    payment?: {
        outstanding_to_agent?: number;
        lifetime_paid?: number;
        last_paid_at?: Date | null;
    };
    employment?: Record<string, unknown>;
    remittance_terms?: Record<string, unknown>;
    coverage?: { regions?: string[] };
    fee_split?: Record<string, unknown>;
    shipment_value_ceiling?: number | null;
    terms_proposed_by?: string | null;
    terms_version?: number;
    approved_at?: Date | null;
    suspended_at?: Date | null;
    suspension_reason?: string | null;
    deactivated_at?: Date | null;
    deactivation_reason?: string | null;
    withdrawn_at?: Date | null;
    withdrawal_reason?: string | null;
    created_at: Date;
    updated_at: Date;
    /** Populated by the roster's `$lookup`. */
    agent?: { _id: ObjectId; name?: string; status?: string } | null;
    /** Populated by the agent-side `$lookup`. */
    agency?: { _id: ObjectId; status?: string } | null;
}

/**
 * The whitelist.
 *
 * `cod.outstanding_balance` and `payment.outstanding_to_agent` are here deliberately —
 * they are the two numbers an administrator investigating a delivery-network dispute
 * actually needs, and they are already visible to both parties to the contract. What is
 * absent is anything that would let this surface become a second COD console: there is no
 * ledger, no collection, no deposit. Those live behind `cod.*` permissions in their own
 * domain, and assembling them here would let `agents.read` alone reach data those
 * permissions exist to gate.
 */
const CONTRACT_PROJECTION = {
    _id: 1,
    agent_id: 1,
    agency_id: 1,
    status: 1,
    origin: 1,
    is_primary: 1,
    'cod.threshold': 1,
    'cod.outstanding_balance': 1,
    'cod.last_settled_at': 1,
    'payment.outstanding_to_agent': 1,
    'payment.last_paid_at': 1,
    employment: 1,
    remittance_terms: 1,
    coverage: 1,
    fee_split: 1,
    shipment_value_ceiling: 1,
    terms_proposed_by: 1,
    terms_version: 1,
    approved_at: 1,
    suspended_at: 1,
    suspension_reason: 1,
    deactivated_at: 1,
    deactivation_reason: 1,
    withdrawn_at: 1,
    withdrawal_reason: 1,
    created_at: 1,
    updated_at: 1,
} as const;

/**
 * What the roster may take off the agent.
 *
 * Four fields, and no more. This is a *roster row*, not an agent record — the full agent
 * lives one click away behind its own projection, which is where the sensitive-field
 * argument is made properly. Anything wider here would be a second, unreviewed agent
 * projection reachable through a different route.
 */
const ROSTER_AGENT_PROJECTION = {
    _id: 1,
    name: 1,
    status: 1,
    'kyc.status': 1,
    'availability.state': 1,
    'platform_ban.banned': 1,
} as const;

/** The agency's identity on the agent-side list. The business name is on the Magazin. */
const CONTRACT_AGENCY_PROJECTION = {
    _id: 1,
    status: 1,
    display_name: 1,
    country: 1,
} as const;

/** `-createdAt` is served by `{agency_id, status, created_at:-1}` on the roster side. */
export const CONTRACT_SORT = { createdAt: 'created_at' } as const;

export interface ContractQuery extends ListQueryBase {
    status?: string;
    primaryOnly?: boolean;
}

export class ContractReadRepository extends PlatformReadRepository<ContractReadModel> {
    constructor() {
        super(COLLECTIONS.AGENT_AGENCY_CONTRACT, CONTRACT_PROJECTION);
    }

    /**
     * The agency's roster. Served by `{agency_id, status, created_at:-1}` end to end.
     */
    async listForAgency(agencyId: string, query: ContractQuery): Promise<Paginated<ContractReadModel>> {
        return this.aggregatePage<ContractReadModel>(pageOf(query), {
            match: [{ $match: buildContractFilter({ agencyId }, query) }],
            join: lookupOne(COLLECTIONS.DELIVERY_AGENT, 'agent_id', 'agent', ROSTER_AGENT_PROJECTION),
            project: { agent: ROSTER_AGENT_PROJECTION },
        });
    }

    /**
     * The agent's contracts.
     *
     * `{agent_id, status}` has no `created_at` trailer, so the sort is a blocking one.
     * Accepted, and worth saying rather than fixing: it is bounded by ONE agent's contract
     * count, which is single digits — an agent serves a handful of agencies, not a
     * thousand. An index for a five-row sort costs more than the sort.
     */
    async listForAgent(agentId: string, query: ContractQuery): Promise<Paginated<ContractReadModel>> {
        return this.aggregatePage<ContractReadModel>(pageOf(query), {
            match: [{ $match: buildContractFilter({ agentId }, query) }],
            join: lookupOne(COLLECTIONS.DELIVERY_AGENCY, 'agency_id', 'agency', CONTRACT_AGENCY_PROJECTION),
            project: { agency: CONTRACT_AGENCY_PROJECTION },
        });
    }
}

function pageOf(query: ContractQuery) {
    return { page: query.page, limit: query.limit, sort: toMongoSort(query.sort, CONTRACT_SORT) };
}

/**
 * A projected `$lookup` + `$unwind`, keeping rows whose join misses.
 *
 * `preserveNullAndEmptyArrays` matters here: a contract whose agent row was never created,
 * or whose agency was hard-deleted, is precisely the broken state an administrator opens
 * this screen to find. A plain `$unwind` would hide exactly those rows.
 */
function lookupOne(from: string, localField: string, as: string, projection: Document): Document[] {
    return [
        {
            $lookup: {
                from,
                localField,
                foreignField: '_id',
                // The inner `$project` is not optional: without it whole agent documents —
                // `legal_identity`, `payout_details`, `emergency_contact` — enter the
                // aggregation, and one forgotten stage later they are on the wire.
                pipeline: [{ $project: projection }],
                as,
            },
        },
        { $unwind: { path: `$${as}`, preserveNullAndEmptyArrays: true } },
    ];
}

export type ContractScope = { agentId: string } | { agencyId: string };

/** Exported for the DB-free suites. */
export function buildContractFilter(
    scope: ContractScope,
    query: ContractQuery,
): Filter<ContractReadModel> {
    const clauses: Record<string, unknown>[] = [];

    if ('agentId' in scope) {
        clauses.push({ agent_id: toObjectId(scope.agentId) });
    } else {
        clauses.push({ agency_id: toObjectId(scope.agencyId) });
    }

    // Every status by default, terminal rows included — the same call jovi-mall's own
    // contract lists make. A live-only default makes a relationship's history impossible
    // to fetch, which on an administrative surface is the whole point of the screen.
    if (query.status) clauses.push({ status: query.status });
    if (query.primaryOnly) clauses.push({ is_primary: true });

    if (clauses.length === 1) return clauses[0] as Filter<ContractReadModel>;
    return { $and: clauses } as Filter<ContractReadModel>;
}

function toObjectId(id: string): ObjectId | string {
    return Types.ObjectId.isValid(id) && id.length === 24 ? new ObjectId(id) : id;
}
