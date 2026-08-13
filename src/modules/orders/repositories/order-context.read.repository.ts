import { Document, Filter, ObjectId } from 'mongodb';
import { Types } from 'mongoose';
import { containsInsensitive, toMongoSort } from '../../../core/data/mongo-list';
import { COLLECTIONS } from '../../../infra/platform/collections';
import { Paginated, PlatformReadRepository } from '../../../infra/platform/platform.repository';
import { ORDER_TIMELINE_SORT, ListOrderTimelineQuery } from '../validators/order.validator';

/**
 * The small reads an order screen needs beside the order itself.
 *
 * Three repositories in one file, matching `vendor-context.read.repository.ts`: each is a
 * handful of lines over a collection this module reads only in service of an order, and
 * three files of twenty lines would be filing rather than structure.
 *
 * ── The search-resolution cap, and why it is reported ─────────────────────────
 * Two of these resolve a free-text term to a set of ids that the order filter then matches
 * with `$in`. That set has to be bounded — a search for "a" against a customer table
 * cannot become a million-element `$in` — but a silent cap is worse than the cost it
 * avoids: an administrator who searches a common surname gets a short list that reads as
 * complete. So each returns `truncated`, and the controller surfaces it in `meta`
 * (ADR-005 D-13: no silent truncation).
 */

/** How many ids one free-text lookup may contribute to the order filter. */
export const SEARCH_MATCH_LIMIT = 200;

export interface IdMatchResult {
    ids: ObjectId[];
    truncated: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Customers — name / phone / email → ids
// ─────────────────────────────────────────────────────────────────────────────

interface CustomerRefReadModel extends Document {
    _id: ObjectId;
    name?: string | null;
    phone?: string | null;
    email?: string | null;
}

export class CustomerRefReadRepository extends PlatformReadRepository<CustomerRefReadModel> {
    constructor() {
        super(COLLECTIONS.CUSTOMER, { _id: 1, name: 1, phone: 1, email: 1 });
    }

    async findIdsMatching(term: string): Promise<IdMatchResult> {
        const pattern = containsInsensitive(term);
        const rows = await this.findBy(
            { $or: [{ name: pattern }, { phone: pattern }, { email: pattern }] } as Filter<CustomerRefReadModel>,
            { projection: { _id: 1 }, limit: SEARCH_MATCH_LIMIT + 1 },
        );
        return {
            ids: rows.slice(0, SEARCH_MATCH_LIMIT).map((row) => row._id),
            truncated: rows.length > SEARCH_MATCH_LIMIT,
        };
    }

    /** Display names for a page of orders, batched. */
    async findNamesByIds(ids: ObjectId[]): Promise<Map<string, string | null>> {
        if (ids.length === 0) return new Map();
        const rows = await this.findBy({ _id: { $in: ids } } as Filter<CustomerRefReadModel>, {
            projection: { _id: 1, name: 1 },
            limit: ids.length,
        });
        return new Map(rows.map((row) => [row._id.toString(), row.name ?? null]));
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Vendors — display name → ids, and names for a page
// ─────────────────────────────────────────────────────────────────────────────

interface VendorRefReadModel extends Document {
    _id: ObjectId;
    display_name?: string | null;
    email?: string | null;
}

export class VendorRefReadRepository extends PlatformReadRepository<VendorRefReadModel> {
    constructor() {
        super(COLLECTIONS.VENDOR, { _id: 1, display_name: 1, email: 1 });
    }

    async findIdsMatching(term: string): Promise<IdMatchResult> {
        const pattern = containsInsensitive(term);
        const rows = await this.findBy(
            { $or: [{ display_name: pattern }, { email: pattern }] } as Filter<VendorRefReadModel>,
            { projection: { _id: 1 }, limit: SEARCH_MATCH_LIMIT + 1 },
        );
        return {
            ids: rows.slice(0, SEARCH_MATCH_LIMIT).map((row) => row._id),
            truncated: rows.length > SEARCH_MATCH_LIMIT,
        };
    }

    async findNamesByIds(ids: ObjectId[]): Promise<Map<string, string | null>> {
        if (ids.length === 0) return new Map();
        const rows = await this.findBy({ _id: { $in: ids } } as Filter<VendorRefReadModel>, {
            projection: { _id: 1, display_name: 1 },
            limit: ids.length,
        });
        return new Map(rows.map((row) => [row._id.toString(), row.display_name ?? null]));
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// The order timeline
// ─────────────────────────────────────────────────────────────────────────────

export interface OrderTimelineReadModel extends Document {
    _id: ObjectId;
    order_id: ObjectId;
    event_type: string;
    description?: string | null;
    metadata?: Record<string, unknown> | null;
    actor_type: string;
    actor_id?: ObjectId | null;
    created_at: Date;
}

/**
 * jovi-mall's append-only order history.
 *
 * ── This is not the wi-admin audit trail, and they are not merged ─────────────
 * This answers "what happened to this order" and its `actor_type` is
 * `vendor | customer | system | admin` — everyone. The audit trail answers "what did
 * ADMINISTRATORS do", lives in a different database reached by a different MongoClient
 * (so there is no `$unionWith`), and carries a different permission. A merged `total`
 * would make `meta.pages` a lie the moment the two interleave. Both are offered, side by
 * side, as `/timeline` and `/activity`.
 *
 * `metadata` is `Mixed` in jovi-mall and is written by every transition path, so the DTO
 * maps named keys out of it and never spreads it onto the wire.
 */
export class OrderTimelineReadRepository extends PlatformReadRepository<OrderTimelineReadModel> {
    constructor() {
        super(COLLECTIONS.ORDER_TIMELINE, {
            _id: 1,
            order_id: 1,
            event_type: 1,
            description: 1,
            metadata: 1,
            actor_type: 1,
            actor_id: 1,
            created_at: 1,
        });
    }

    async listForOrder(
        orderId: string,
        query: ListOrderTimelineQuery,
    ): Promise<Paginated<OrderTimelineReadModel>> {
        if (!Types.ObjectId.isValid(orderId)) {
            return { items: [], total: 0, page: query.page, limit: query.limit, pages: 0 };
        }

        const clauses: Filter<OrderTimelineReadModel>[] = [
            { order_id: new ObjectId(orderId) } as Filter<OrderTimelineReadModel>,
        ];
        if (query.actorType) {
            clauses.push({ actor_type: query.actorType } as Filter<OrderTimelineReadModel>);
        }
        if (query.eventType) {
            clauses.push({ event_type: query.eventType } as Filter<OrderTimelineReadModel>);
        }

        return this.findPage(
            (clauses.length === 1 ? clauses[0] : { $and: clauses }) as Filter<OrderTimelineReadModel>,
            {
                page: query.page,
                limit: query.limit,
                sort: toMongoSort(query.sort, ORDER_TIMELINE_SORT),
            },
        );
    }
}
