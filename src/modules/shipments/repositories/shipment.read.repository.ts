import { Document, Filter, ObjectId } from 'mongodb';
import { Types } from 'mongoose';
import { escapeRegex, toMongoSort } from '../../../core/data/mongo-list';
import { COLLECTIONS } from '../../../infra/platform/collections';
import { Paginated, PlatformReadRepository } from '../../../infra/platform/platform.repository';
import { SHIPMENT_SORT, ShipmentSearchQuery } from '../validators/shipment.validator';

/**
 * Reading shipments straight out of `jovi_mall`.
 *
 * ── This module's projections carry the sharpest secrets in the service ───────
 * Read the ban list under `SHIPMENT_LIST_PROJECTION` before adding a field here. Two of
 * the excluded values would be immediately exploitable and one of them is protected by
 * NOTHING ELSE: `cash_collections.code_plain` is marked `select: false` in jovi-mall's
 * Mongoose schema, and this service reads with the **raw MongoDB driver**, which does not
 * honour Mongoose `select`. The projection whitelist is the only thing between a COD
 * delivery code and an HTTP response.
 *
 * ── Soft deletes ──────────────────────────────────────────────────────────────
 * `shipments`, `cash_collections` and `shipment_assignment_offers` carry no `deletedAt` —
 * verified, not assumed. No soft-delete clause is needed.
 */

export interface ShipmentReadModel extends Document {
    _id: ObjectId;
    order_id: ObjectId;
    agency_id: ObjectId;
    agent_id?: ObjectId | null;
    status: string;
    tracking_number?: string | null;
    delivery_fee_snapshot?: number | null;
    delivery_proof_file_id?: ObjectId | null;
    hold?: { previousStatus?: string; heldAt?: Date } | null;
    assignment?: {
        state?: string;
        current_offer_id?: ObjectId | null;
        offered_agent_id?: ObjectId | null;
        updated_at?: Date;
    } | null;
    rejection?: {
        reason?: string;
        note?: string | null;
        rejectedAt?: Date;
        rejectedBy?: ObjectId;
        rejectedBySource?: string;
        rejectedByName?: string | null;
    } | null;
    customer_confirmation?: {
        confirmed_at?: Date | null;
        confirmed_by?: ObjectId | null;
        auto?: boolean;
    } | null;
    agent_cancellation?: {
        reason?: string;
        note?: string | null;
        cancelled_by_agent_id?: ObjectId | null;
        from_status?: string | null;
        cancelled_at?: Date;
    } | null;
    status_history?: {
        status?: string;
        changed_at?: Date;
        changed_by_user_id?: ObjectId | null;
        changed_by_role?: string;
    }[];
    delivery_failures?: {
        status?: string;
        reason?: string | null;
        note?: string | null;
        from_status?: string | null;
        reported_by_agent_id?: ObjectId | null;
        reported_at?: Date;
    }[];
    handover?: {
        from_agent_id?: ObjectId | null;
        from_status?: string | null;
        reassigned_at?: Date | null;
        pickup?: {
            source?: string;
            label?: string | null;
            note?: string | null;
            is_fallback?: boolean;
            address?: Record<string, unknown> | null;
        } | null;
    } | null;
    items?: {
        order_item_id?: ObjectId;
        product_id?: ObjectId;
        variant_id?: ObjectId | null;
        quantity?: number;
    }[];
    created_at: Date;
    updated_at: Date;
}

/**
 * The list whitelist.
 *
 * ── THE BAN LIST — every field that must never be projected, anywhere ─────────
 * `test-shipments.ts` source-scans this whole module for each of these, **including the
 * whole-subdocument forms** (`handover: 1`, `'handover.pickup': 1`, `verification: 1`)
 * that would drag them back in. That scan is the single most valuable test in the phase.
 *
 *  - **`cash_collections.code_plain`** — the customer's plaintext COD delivery OTP. It is
 *    the only API path by which a COD shipment reaches `delivered`, so a leak lets anyone
 *    mark a delivery complete and take the cash. Mongoose's `select: false` does NOT
 *    protect it here; this whitelist does.
 *  - **`cash_collections.code_hash`** — a short numeric OTP's SHA-256 is brute-forceable
 *    offline in milliseconds. Same consequence, one step removed.
 *  - **`cash_collections.verification.location` / `.ip` / `.device_info`** — the agent's
 *    GPS fix, IP and device at handoff. `verification.method` alone is projected: `code`
 *    vs `auto_no_code` is the fact a delivery dispute turns on; the rest is telemetry.
 *  - **`shipments.handover.pickup.location`** — a GeoJSON point whose `source` is very
 *    often `previous_agent_location`, i.e. **a delivery agent's last known GPS position**.
 *    The platform's whole two-gate privacy split exists to control that datum; it must not
 *    leak out of a REST detail gated on `shipments.read`.
 *  - **`shipments.handover.pickup.geo`** — the same value in `GeoAddress` clothing.
 *  - **`shipment_assignment_offers.candidate_pool`** — the entire ranked list of every
 *    agent considered, each with a `trust_score`. The offer ROWS already tell the sequence.
 *
 * The append-only arrays — `status_history`, `delivery_failures`, `handover`,
 * `agent_cancellation`, `rejection` — are DETAIL ONLY. They grow without bound, and a
 * hundred-row page of full delivery histories is a payload nobody renders.
 */
const SHIPMENT_LIST_PROJECTION = {
    _id: 1,
    order_id: 1,
    agency_id: 1,
    agent_id: 1,
    status: 1,
    tracking_number: 1,
    delivery_fee_snapshot: 1,
    hold: 1,
    'assignment.state': 1,
    'assignment.current_offer_id': 1,
    'assignment.offered_agent_id': 1,
    'assignment.updated_at': 1,
    // Length only.
    'items.order_item_id': 1,
    created_at: 1,
    updated_at: 1,
} as const;

/**
 * The detail adds the histories and the handover — the latter DOTTED, so that
 * `pickup.location` and `pickup.geo` stay out. A bare `handover: 1` here would ship an
 * agent's GPS position to every holder of `shipments.read`.
 */
const SHIPMENT_DETAIL_PROJECTION = {
    ...SHIPMENT_LIST_PROJECTION,
    delivery_proof_file_id: 1,
    status_history: 1,
    delivery_failures: 1,
    rejection: 1,
    agent_cancellation: 1,
    customer_confirmation: 1,
    'handover.from_agent_id': 1,
    'handover.from_status': 1,
    'handover.reassigned_at': 1,
    'handover.pickup.source': 1,
    'handover.pickup.label': 1,
    'handover.pickup.note': 1,
    'handover.pickup.is_fallback': 1,
    'handover.pickup.address': 1,
    'items.product_id': 1,
    'items.variant_id': 1,
    'items.quantity': 1,
} as const;

export interface ShipmentSearchResolution {
    orderIds: ObjectId[];
    truncated: boolean;
}

const EMPTY_RESOLUTION: ShipmentSearchResolution = { orderIds: [], truncated: false };

export class ShipmentReadRepository extends PlatformReadRepository<ShipmentReadModel> {
    constructor() {
        super(COLLECTIONS.SHIPMENT, SHIPMENT_LIST_PROJECTION);
    }

    async search(
        query: ShipmentSearchQuery,
        resolved: ShipmentSearchResolution = EMPTY_RESOLUTION,
    ): Promise<Paginated<ShipmentReadModel>> {
        return this.findPage(buildFilter(query, resolved), {
            page: query.page,
            limit: query.limit,
            sort: toMongoSort(query.sort, SHIPMENT_SORT),
        });
    }

    async findById(shipmentId: string): Promise<ShipmentReadModel | null> {
        if (!Types.ObjectId.isValid(shipmentId)) return null;
        return this.findOneBy({ _id: new ObjectId(shipmentId) } as Filter<ShipmentReadModel>);
    }

    async findDetailById(shipmentId: string): Promise<ShipmentReadModel | null> {
        if (!Types.ObjectId.isValid(shipmentId)) return null;
        const [shipment] = await this.findBy(
            { _id: new ObjectId(shipmentId) } as Filter<ShipmentReadModel>,
            { projection: SHIPMENT_DETAIL_PROJECTION, limit: 1 },
        );
        return shipment ?? null;
    }

    /** The shipments on one order — the compact block the order detail carries. */
    async findForOrder(orderId: string): Promise<ShipmentReadModel[]> {
        if (!Types.ObjectId.isValid(orderId)) return [];
        return this.findBy({ order_id: new ObjectId(orderId) } as Filter<ShipmentReadModel>, {
            projection: SHIPMENT_LIST_PROJECTION,
            limit: 100,
        });
    }
}

/**
 * Translate a validated query into a Mongo filter. Pure and exported — the DB-free test
 * imports it directly.
 *
 * Composed under `$and`, never `Object.assign`: `search` is `$or`-shaped, and merging it
 * into an object holding another `$or` silently drops one of them, producing a query that
 * looks right and answers a different question.
 */
export function buildFilter(
    query: ShipmentSearchQuery,
    resolved: ShipmentSearchResolution = EMPTY_RESOLUTION,
): Filter<ShipmentReadModel> {
    const clauses: Filter<ShipmentReadModel>[] = [];

    if (query.status) clauses.push({ status: query.status } as Filter<ShipmentReadModel>);
    if (query.agencyId) clauses.push({ agency_id: new ObjectId(query.agencyId) } as Filter<ShipmentReadModel>);
    if (query.agentId) clauses.push({ agent_id: new ObjectId(query.agentId) } as Filter<ShipmentReadModel>);
    if (query.orderId) clauses.push({ order_id: new ObjectId(query.orderId) } as Filter<ShipmentReadModel>);
    if (query.assignmentState) {
        clauses.push({ 'assignment.state': query.assignmentState } as unknown as Filter<ShipmentReadModel>);
    }
    if (query.unassigned !== undefined) {
        clauses.push({
            agent_id: query.unassigned ? { $eq: null } : { $ne: null },
        } as unknown as Filter<ShipmentReadModel>);
    }
    if (query.held !== undefined) {
        clauses.push({
            hold: query.held ? { $ne: null } : { $eq: null },
        } as unknown as Filter<ShipmentReadModel>);
    }

    if (query.from || query.to) {
        const range: Record<string, Date> = {};
        if (query.from) range.$gte = query.from;
        if (query.to) range.$lt = query.to;   // half-open [from, to)
        clauses.push({ created_at: range } as unknown as Filter<ShipmentReadModel>);
    }

    if (query.search) clauses.push(searchClause(query.search, resolved));

    if (clauses.length === 0) return {};
    if (clauses.length === 1) return clauses[0];
    return { $and: clauses } as Filter<ShipmentReadModel>;
}

/**
 * The free-text branch.
 *
 * ── Anchored and CASE-SENSITIVE, deliberately ─────────────────────────────────
 * Tracking numbers are `ACR-YYMMDD-HHMMSS-XXXXX` — always uppercase — and carry a partial
 * unique index. An anchored `^` regex on the uppercased term uses it; the
 * `containsInsensitive` helper would be a collection scan on a hot collection, requestable
 * by query string. This is why no extra index was added for search.
 */
function searchClause(term: string, resolved: ShipmentSearchResolution): Filter<ShipmentReadModel> {
    const branches: Record<string, unknown>[] = [];

    if (/^[A-Za-z]/.test(term)) {
        branches.push({ tracking_number: new RegExp('^' + escapeRegex(term.toUpperCase())) });
    }

    if (term.length === 24 && Types.ObjectId.isValid(term)) {
        const id = new ObjectId(term);
        branches.push({ _id: id });
        branches.push({ order_id: id });
        branches.push({ agent_id: id });
        branches.push({ agency_id: id });
    }

    if (resolved.orderIds.length > 0) branches.push({ order_id: { $in: resolved.orderIds } });

    // A term that matched nothing returns nothing, not everything.
    if (branches.length === 0) return { _id: { $in: [] } } as unknown as Filter<ShipmentReadModel>;

    return { $or: branches } as Filter<ShipmentReadModel>;
}
