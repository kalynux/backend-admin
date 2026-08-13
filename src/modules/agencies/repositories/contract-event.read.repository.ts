import { Document, Filter, ObjectId } from 'mongodb';
import { Types } from 'mongoose';
import { toMongoSort } from '../../../core/data/mongo-list';
import { ListQueryBase } from '../../../core/http/list-query';
import { COLLECTIONS } from '../../../infra/platform/collections';
import { Paginated, PlatformReadRepository } from '../../../infra/platform/platform.repository';
import { CONTRACT_EVENT_SORT } from '../validators/agency.validator';

/**
 * The agent↔agency contract history — `agent_membership_events`.
 *
 * ── One repository, imported by both modules ──────────────────────────────────
 * The agency feed and the agent feed differ in exactly one thing: which id they filter on.
 * Two copies of a projection over an append-only log is the drift jovi-mall already paid
 * for once in this very collection's neighbourhood — it kept two copies of its agent
 * notification types, they diverged, and eight situations silently stopped being
 * delivered. So the agents module imports this rather than declaring its own.
 *
 * ── What this feed is, and what it is not ─────────────────────────────────────
 * It is jovi-mall's record of what happened to a relationship: who invited, who approved,
 * who paused, who withdrew, what the terms became. Its `actor_role` is
 * `agent | agency | admin | system` — **everyone**, not only administrators.
 *
 * The wi-admin audit trail is the other feed and answers a different question: what
 * ADMINISTRATORS did. They are deliberately not merged. They live in two different
 * databases reached by two different MongoClients, so there is no `$unionWith` between
 * them, and a merged `total` would be the sum of two counts — making `meta.pages` a lie
 * the moment the two interleave. They also carry different permissions: this one is gated
 * by `agents.read`/`agencies.read` alone, the trail additionally by `audit.read`.
 */

export interface ContractEventReadModel extends Document {
    _id: ObjectId;
    membership_id?: ObjectId | null;
    agent_id: ObjectId;
    agency_id: ObjectId;
    type: string;
    from_status?: string | null;
    to_status?: string | null;
    actor_user_id?: ObjectId | null;
    actor_role?: string | null;
    reason?: string | null;
    occurred_at: Date;
    created_at?: Date;
}

/**
 * The whitelist.
 *
 * `metadata` is deliberately absent. It is a `Mixed` field jovi-mall writes freely — the
 * one shape on this document with no schema at all — so projecting it would be a standing
 * invitation for whatever a future transition decides to attach to ride out to the
 * dashboard unreviewed. That is exactly the case a whitelist exists for. Surface a named
 * field from it when a screen needs one.
 */
const CONTRACT_EVENT_PROJECTION = {
    _id: 1,
    membership_id: 1,
    agent_id: 1,
    agency_id: 1,
    type: 1,
    from_status: 1,
    to_status: 1,
    actor_user_id: 1,
    actor_role: 1,
    reason: 1,
    occurred_at: 1,
} as const;

export interface ContractEventQuery extends ListQueryBase {
    type?: string;
    actorRole?: string;
    from?: Date;
    to?: Date;
}

/** Which side of the relationship the feed is scoped to. Exactly one is ever set. */
export type ContractEventScope =
    | { agentId: string }
    | { agencyId: string };

export class ContractEventReadRepository extends PlatformReadRepository<ContractEventReadModel> {
    constructor() {
        super(COLLECTIONS.AGENT_MEMBERSHIP_EVENT, CONTRACT_EVENT_PROJECTION);
    }

    /**
     * Both indexes on this collection lead with the scope id and trail `occurred_at: -1`
     * (`{agent_id, occurred_at:-1}` and `{agency_id, occurred_at:-1}`), so the default
     * order is served from the index whichever side asks.
     */
    async list(
        scope: ContractEventScope,
        query: ContractEventQuery,
    ): Promise<Paginated<ContractEventReadModel>> {
        return this.findPage(buildContractEventFilter(scope, query), {
            page: query.page,
            limit: query.limit,
            sort: toMongoSort(query.sort, CONTRACT_EVENT_SORT),
        });
    }
}

/** Exported so `test-agents.ts` can assert the branches without a database. */
export function buildContractEventFilter(
    scope: ContractEventScope,
    query: ContractEventQuery,
): Filter<ContractEventReadModel> {
    const clauses: Record<string, unknown>[] = [];

    // The scope is fixed by the route's path parameter and composed here, where a caller
    // cannot forget it. An unscoped query over this collection is every relationship on
    // the platform.
    if ('agentId' in scope) {
        clauses.push({ agent_id: toObjectId(scope.agentId) });
    } else {
        clauses.push({ agency_id: toObjectId(scope.agencyId) });
    }

    if (query.type) clauses.push({ type: query.type });
    if (query.actorRole) clauses.push({ actor_role: query.actorRole });

    if (query.from || query.to) {
        const range: Record<string, Date> = {};
        if (query.from) range.$gte = query.from;
        if (query.to) range.$lt = query.to;
        clauses.push({ occurred_at: range });
    }

    if (clauses.length === 1) return clauses[0] as Filter<ContractEventReadModel>;
    return { $and: clauses } as Filter<ContractEventReadModel>;
}

/**
 * These columns hold real ObjectIds, unlike the `tracking_outbox`'s string ids. A string
 * here matches nothing and returns an empty page that looks like "no history".
 */
function toObjectId(id: string): ObjectId | string {
    return Types.ObjectId.isValid(id) && id.length === 24 ? new ObjectId(id) : id;
}
