import { Document, Filter, ObjectId } from 'mongodb';
import { Types } from 'mongoose';
import { COLLECTIONS } from '../../../infra/platform/collections';
import { PlatformReadRepository } from '../../../infra/platform/platform.repository';

/**
 * The reads a shipment detail needs beside the shipment itself — the ones that answer
 * "why is this delivery stuck".
 *
 * Four small repositories in one file, matching `vendor-context.read.repository.ts`: each
 * is a handful of lines over a collection this module reads only in service of a shipment.
 *
 * **Every projection here is a security boundary.** See the ban list in
 * `shipment.read.repository.ts`; the two COD fields below are the ones with no other
 * protection, because Mongoose's `select: false` does not reach the raw driver.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Assignment offers — the audit of record for who was asked
// ─────────────────────────────────────────────────────────────────────────────

export interface ShipmentOfferReadModel extends Document {
    _id: ObjectId;
    shipment_id: ObjectId;
    agent_id: ObjectId;
    status: string;
    origin?: string;
    round?: number;
    session_id?: ObjectId | null;
    created_by?: { role?: string; user_id?: ObjectId | null; name?: string | null };
    expires_at?: Date | null;
    responded_at?: Date | null;
    rejection_reason?: string | null;
    created_at: Date;
}

/**
 * `shipment_assignment_offers` — one row per agent asked, in order.
 *
 * **`candidate_pool` is NOT projected.** It holds the entire ranked list of every agent the
 * auto-assigner considered, each with a `breakdown.trust_score`. A twenty-offer page would
 * fan out hundreds of agents' trust scores to a screen that renders one, and an agent's
 * trust score is not a fact the shipments surface is entitled to broadcast. The offer rows
 * already tell the whole sequence — which is what the offer model's own docstring says they
 * exist for.
 */
export class ShipmentOfferReadRepository extends PlatformReadRepository<ShipmentOfferReadModel> {
    constructor() {
        super(COLLECTIONS.SHIPMENT_ASSIGNMENT_OFFER, {
            _id: 1,
            shipment_id: 1,
            agent_id: 1,
            status: 1,
            origin: 1,
            round: 1,
            session_id: 1,
            'created_by.role': 1,
            'created_by.user_id': 1,
            'created_by.name': 1,
            expires_at: 1,
            responded_at: 1,
            rejection_reason: 1,
            created_at: 1,
        });
    }

    async findForShipment(shipmentId: string, limit = 50): Promise<ShipmentOfferReadModel[]> {
        if (!Types.ObjectId.isValid(shipmentId)) return [];
        return this.findBy({ shipment_id: new ObjectId(shipmentId) } as Filter<ShipmentOfferReadModel>, {
            projection: {
                _id: 1, shipment_id: 1, agent_id: 1, status: 1, origin: 1, round: 1,
                session_id: 1, 'created_by.role': 1, 'created_by.user_id': 1,
                'created_by.name': 1, expires_at: 1, responded_at: 1,
                rejection_reason: 1, created_at: 1,
            },
            sort: { created_at: -1 },
            limit,
        });
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// COD collection — the cash state, never the code
// ─────────────────────────────────────────────────────────────────────────────

export interface CashCollectionReadModel extends Document {
    _id: ObjectId;
    shipment_id: ObjectId;
    order_id: ObjectId;
    agent_id?: ObjectId | null;
    agency_id?: ObjectId | null;
    status: string;
    expected_amount: number;
    currency?: string | null;
    code_attempts?: number;
    code_locked?: boolean;
    code_generated_at?: Date | null;
    collected_at?: Date | null;
    settled_amount?: number | null;
    settled_at?: Date | null;
    verification?: { method?: string | null } | null;
}

/**
 * `cash_collections` — whether the money for a COD shipment has been collected.
 *
 * ── The two fields that are absent, and why it matters more here than anywhere ─
 * **`code_plain`** is the customer's plaintext delivery OTP and **`code_hash`** is its
 * digest. Submitting that code is the ONLY API path by which a COD shipment reaches
 * `delivered` and the cash is recorded, so either value is a bearer credential over
 * somebody else's money.
 *
 * jovi-mall marks `code_plain` `select: false`. **That protects nothing here** — this
 * service reads with the raw MongoDB driver, which does not honour Mongoose `select`. This
 * projection is the only guard, which is why `test-shipments.ts` scans the whole module for
 * both names and for `cash_collection: 1`.
 *
 * `verification.method` is projected alone — `code` vs `auto_no_code` is the fact a
 * delivery dispute turns on. `.location`, `.ip` and `.device_info` are the agent's GPS fix,
 * IP and device, and are telemetry rather than administration.
 */
export class CashCollectionReadRepository extends PlatformReadRepository<CashCollectionReadModel> {
    constructor() {
        super(COLLECTIONS.CASH_COLLECTION, {
            _id: 1,
            shipment_id: 1,
            order_id: 1,
            agent_id: 1,
            agency_id: 1,
            status: 1,
            expected_amount: 1,
            currency: 1,
            code_attempts: 1,
            code_locked: 1,
            code_generated_at: 1,
            collected_at: 1,
            settled_amount: 1,
            settled_at: 1,
            'verification.method': 1,
        });
    }

    async findForShipment(shipmentId: string): Promise<CashCollectionReadModel | null> {
        if (!Types.ObjectId.isValid(shipmentId)) return null;
        return this.findOneBy({ shipment_id: new ObjectId(shipmentId) } as Filter<CashCollectionReadModel>);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tracking outbox — dispatch health, not a trackability verdict
// ─────────────────────────────────────────────────────────────────────────────

export interface TrackingOutboxReadModel extends Document {
    _id: ObjectId;
    event_id?: string;
    type?: string;
    shipment_id?: ObjectId | null;
    status?: string;
    attempts?: number;
    last_error?: string | null;
    occurred_at?: Date | null;
    created_at?: Date;
}

export interface OutboxHealth {
    pending: number;
    failed: number;
    lastEventAt: string | null;
    lastError: string | null;
}

/**
 * `tracking_outbox` — has this shipment's news actually reached geo-tracker?
 *
 * ── Health, deliberately NOT a trackability verdict ───────────────────────────
 * `TRACKABLE_SHIPMENT_STATUSES` and `shipmentTrackability()` are jovi-mall's POLICY, and
 * the platform's governing rule is explicit that visibility rules are never reimplemented
 * outside it. Recomputing "is this shipment trackable" here would be a second definition of
 * who may be watched.
 *
 * What this reports is a RECORD: how many rows for this shipment are still pending or have
 * failed, and when the last one went out. That is what makes the platform's known
 * non-transactional-outbox defect visible on the one screen that would care — a
 * reassignment whose `shipment.agent_released` event was lost leaves a tracking session
 * open on an agent who is no longer delivering, and this is where that shows up.
 *
 * If a later phase wants the verdict itself, it delegates one.
 */
export class TrackingOutboxReadRepository extends PlatformReadRepository<TrackingOutboxReadModel> {
    constructor() {
        super(COLLECTIONS.TRACKING_OUTBOX, {
            _id: 1,
            event_id: 1,
            type: 1,
            shipment_id: 1,
            status: 1,
            attempts: 1,
            last_error: 1,
            occurred_at: 1,
            created_at: 1,
        });
    }

    async healthForShipment(shipmentId: string): Promise<OutboxHealth> {
        const empty: OutboxHealth = { pending: 0, failed: 0, lastEventAt: null, lastError: null };
        if (!Types.ObjectId.isValid(shipmentId)) return empty;

        const rows = await this.findBy(
            { shipment_id: new ObjectId(shipmentId) } as Filter<TrackingOutboxReadModel>,
            { sort: { created_at: -1 }, limit: 100 },
        );
        if (rows.length === 0) return empty;

        const failed = rows.filter((row) => row.status === 'failed');
        return {
            pending: rows.filter((row) => row.status === 'pending').length,
            failed: failed.length,
            lastEventAt: rows[0].created_at ? new Date(rows[0].created_at).toISOString() : null,
            lastError: failed[0]?.last_error ?? null,
        };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Order reference — the order number a shipment belongs to
// ─────────────────────────────────────────────────────────────────────────────

interface OrderRefReadModel extends Document {
    _id: ObjectId;
    order_number?: string;
    payment_method?: string;
    payment_status?: string;
    fulfillment_status?: string;
    customer_id?: ObjectId;
    vendor_id?: ObjectId;
}

export interface OrderRef {
    id: string;
    orderNumber: string | null;
    paymentMethod: string | null;
    paymentStatus: string | null;
    fulfillmentStatus: string | null;
    customerId: string | null;
    vendorId: string | null;
}

export class ShipmentOrderRefReadRepository extends PlatformReadRepository<OrderRefReadModel> {
    constructor() {
        super(COLLECTIONS.ORDER, {
            _id: 1,
            order_number: 1,
            payment_method: 1,
            payment_status: 1,
            fulfillment_status: 1,
            customer_id: 1,
            vendor_id: 1,
        });
    }

    /** Order numbers matching a free-text term, for the shipment search. Capped. */
    async findIdsMatching(term: string, limit = 200): Promise<{ ids: ObjectId[]; truncated: boolean }> {
        // Anchored and case-sensitive, matching the order module's own search: the unique
        // `order_number` index serves it, an unanchored contains-match would not.
        const rows = await this.findBy(
            { order_number: new RegExp('^' + term.toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) } as Filter<OrderRefReadModel>,
            { projection: { _id: 1 }, limit: limit + 1 },
        );
        return { ids: rows.slice(0, limit).map((row) => row._id), truncated: rows.length > limit };
    }

    async findRefsByIds(ids: ObjectId[]): Promise<Map<string, OrderRef>> {
        if (ids.length === 0) return new Map();
        const rows = await this.findBy({ _id: { $in: ids } } as Filter<OrderRefReadModel>, {
            limit: ids.length,
        });
        return new Map(
            rows.map((row) => [
                row._id.toString(),
                {
                    id: row._id.toString(),
                    orderNumber: row.order_number ?? null,
                    paymentMethod: row.payment_method ?? null,
                    paymentStatus: row.payment_status ?? null,
                    fulfillmentStatus: row.fulfillment_status ?? null,
                    customerId: row.customer_id ? row.customer_id.toString() : null,
                    vendorId: row.vendor_id ? row.vendor_id.toString() : null,
                },
            ]),
        );
    }
}
