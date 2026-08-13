import { Document, Filter, ObjectId } from 'mongodb';
import { Types } from 'mongoose';
import { escapeRegex, toMongoSort } from '../../../core/data/mongo-list';
import { COLLECTIONS } from '../../../infra/platform/collections';
import { Paginated, PlatformReadRepository } from '../../../infra/platform/platform.repository';
import {
    ListDisputedOrdersQuery,
    ORDER_DISPUTE_SORT,
    ORDER_SORT,
    OrderSearchQuery,
} from '../validators/order.validator';

/**
 * Reading platform orders straight out of `jovi_mall`.
 *
 * ── Why this domain reads directly (ADR-004 D-2) ──────────────────────────────
 * The rule: **delegate a read whose answer is a verdict the platform acts on; read
 * directly a read whose answer is a record.** An order row is a record. The one order read
 * that IS a verdict — "how much may be refunded, and whose policy does that break" — is
 * delegated, because jovi-mall's refund pipeline branches on the same arithmetic and a copy
 * here would be a second definition of what a customer is owed.
 *
 * Every WRITE goes over the internal API. `PlatformReadRepository` has no write method, so
 * that is not something this file could break by accident.
 *
 * ── Soft deletes ──────────────────────────────────────────────────────────────
 * `orders` carries no `deletedAt`: `OrderRepository` in jovi-mall does not extend
 * `BaseRepository`, so nothing there filters one either. Unlike `buildProductFilter`, no
 * soft-delete clause is needed — verified rather than assumed, because the raw driver would
 * silently include deleted rows if there were any.
 */

export interface OrderReadModel extends Document {
    _id: ObjectId;
    order_number: string;
    order_type: 'physical' | 'digital';
    cart_id: ObjectId;
    vendor_id: ObjectId;
    customer_id: ObjectId;
    currency: string;
    total_amount: number;
    price_breakdown?: { base?: number; tax?: number; discount?: number; total?: number };
    payment_method: 'online' | 'cash_on_delivery';
    payment_status: string;
    payment_intent_id?: string | null;
    fulfillment_status: string;
    dispute_hold?: {
        active?: boolean;
        disputed_at?: Date | null;
        resolved_at?: Date | null;
        gateway_dispute_id?: string | null;
        reason?: string | null;
    } | null;
    completion?: {
        confirmed_at?: Date | null;
        confirmed_by?: string | null;
        auto?: boolean;
    } | null;
    delivery_address?: {
        formatted_address?: string | null;
        components?: Record<string, unknown> | null;
    } | null;
    items?: {
        _id?: ObjectId;
        variant_id?: ObjectId;
        sku?: string;
        variant_title?: string;
        options_snapshot?: string;
        product_id?: ObjectId;
        title?: string;
        product_type?: string;
        quantity?: number;
        price?: number;
        currency?: string;
        delivery?: {
            agency_id?: ObjectId;
            shipment_id?: ObjectId | null;
            status?: string;
            free_delivery?: boolean;
            hold?: { previousStatus?: string; heldAt?: Date } | null;
            pickup_location?: {
                source?: string;
                vendor_address_id?: ObjectId | null;
                agency_address_id?: ObjectId | null;
            } | null;
        } | null;
    }[];
    created_at: Date;
    updated_at: Date;
}

/**
 * The list whitelist. Every field the directory may see, named.
 *
 * A whitelist rather than an exclusion list: an exclusion protects only what somebody
 * thought of, so a sensitive field added to `orders` next year would arrive here
 * automatically. This way it does not.
 *
 * ── What is absent from the LIST, and why ─────────────────────────────────────
 *
 *  - **`items` (whole).** An order carries up to thirty of them, each with a
 *    `delivery.pickup_location.address_snapshot` holding a full `GeoAddress`. A hundred-row
 *    page would be thousands of addresses for a screen that renders none. Only `items._id`
 *    is projected, to count them.
 *  - **`delivery_address` (whole).** It is a `GeoAddress`: a formatted line, a GeoJSON
 *    `coordinates` point, and the raw text the customer typed. A directory of a hundred
 *    orders is a hundred customers' home coordinates sitting in a browser.
 *  - **`payment_intent_id`.** The gateway reference every gateway call and
 *    `findOrderIdByPaymentIntent` look up on. It belongs on the detail, where an
 *    investigator correlates one order with Stripe — not on a hundred-row page.
 *  - **`price_breakdown`.** Detail only. The list carries `total_amount`, which is what a
 *    directory row shows.
 *
 * `total_amount` and `currency` ARE projected on both. Support holds `orders.read` and
 * cannot answer "what was I charged" without them. That is a deliberate departure from
 * `vendor-context.read.repository.ts`, which withholds the same field — there the question
 * is VENDOR REVENUE, which is `money.read`'s to gate; here it is the customer's own figure
 * on their own order.
 */
/**
 * The scalar fields both projections share.
 *
 * Split out rather than spread from the list, because the list and the detail want
 * `dispute_hold` and `completion` at DIFFERENT depths — dotted on the list, whole on the
 * detail. **MongoDB refuses a projection naming both a path and a subpath of it**
 * (`Path collision at dispute_hold`), so `{ ...LIST, dispute_hold: 1 }` is a runtime 500,
 * not a widening. A source scan cannot catch that; `verify:orders` did.
 */
const ORDER_CORE_PROJECTION = {
    _id: 1,
    order_number: 1,
    order_type: 1,
    cart_id: 1,
    vendor_id: 1,
    customer_id: 1,
    currency: 1,
    total_amount: 1,
    payment_method: 1,
    payment_status: 1,
    fulfillment_status: 1,
    created_at: 1,
    updated_at: 1,
} as const;

const ORDER_LIST_PROJECTION = {
    ...ORDER_CORE_PROJECTION,
    'dispute_hold.active': 1,
    'dispute_hold.disputed_at': 1,
    'completion.confirmed_at': 1,
    // Length only. A `find()` projection cannot `$size`, and the items array is the single
    // biggest thing on this document.
    'items._id': 1,
} as const;

/**
 * The detail adds the money breakdown, the dispute and completion blocks, the items, and
 * the TEXTUAL parts of the drop-off address.
 *
 * `delivery_address.coordinates` and `.raw_input` are deliberately NOT projected, as dotted
 * paths rather than a promise. A support administrator answering "where is my parcel" needs
 * the street line; the precise latitude and longitude of a private home is a different
 * thing with a different blast radius, and `raw_input` is debug data — whatever the
 * customer typed before picking a geocoding result.
 *
 * `items.delivery.pickup_location.address_snapshot` is excluded for the same reason, one
 * party over: it embeds the coordinates of a VENDOR's premises. The `source` and the two
 * ids are projected, which is what identifies the pickup; a screen that needs the address
 * reads the vendor surface.
 */
const ORDER_DETAIL_PROJECTION = {
    // From CORE, not from LIST: the list's dotted `dispute_hold.*` and `completion.*` would
    // collide with the whole-subdocument forms below. See ORDER_CORE_PROJECTION.
    ...ORDER_CORE_PROJECTION,
    price_breakdown: 1,
    payment_intent_id: 1,
    dispute_hold: 1,
    completion: 1,
    'items._id': 1,
    'delivery_address.formatted_address': 1,
    'delivery_address.components': 1,
    'items.variant_id': 1,
    'items.sku': 1,
    'items.variant_title': 1,
    'items.options_snapshot': 1,
    'items.product_id': 1,
    'items.title': 1,
    'items.product_type': 1,
    'items.quantity': 1,
    'items.price': 1,
    'items.currency': 1,
    'items.delivery.agency_id': 1,
    'items.delivery.shipment_id': 1,
    'items.delivery.status': 1,
    'items.delivery.free_delivery': 1,
    'items.delivery.hold': 1,
    'items.delivery.pickup_location.source': 1,
    'items.delivery.pickup_location.vendor_address_id': 1,
    'items.delivery.pickup_location.agency_address_id': 1,
} as const;

/**
 * Ids resolved from a free-text search term BEFORE the filter is built.
 *
 * Keeping the lookups out of `buildFilter` is what lets that function stay pure and
 * DB-free, so `test-orders.ts` can assert its clause composition without a database. Same
 * pattern as the vendor directory's `storeMatchIds`.
 */
export interface OrderSearchResolution {
    customerIds: ObjectId[];
    vendorIds: ObjectId[];
    /** True when either lookup hit its cap — the caller MUST report it in `meta`. */
    truncated: boolean;
}

const EMPTY_RESOLUTION: OrderSearchResolution = { customerIds: [], vendorIds: [], truncated: false };

export class OrderReadRepository extends PlatformReadRepository<OrderReadModel> {
    constructor() {
        super(COLLECTIONS.ORDER, ORDER_LIST_PROJECTION);
    }

    async search(
        query: OrderSearchQuery,
        resolved: OrderSearchResolution = EMPTY_RESOLUTION,
    ): Promise<Paginated<OrderReadModel>> {
        return this.findPage(buildFilter(query, resolved), {
            page: query.page,
            limit: query.limit,
            sort: toMongoSort(query.sort, ORDER_SORT),
        });
    }

    /**
     * The dispute queue.
     *
     * A separate method rather than `buildFilter` with `disputed: true`, deliberately: the
     * queue's defining clause must not be reachable through a query parameter, so it cannot
     * be widened by one. Backed by the partial `dispute_queue` index.
     */
    async findDisputed(query: ListDisputedOrdersQuery): Promise<Paginated<OrderReadModel>> {
        const clauses: Filter<OrderReadModel>[] = [disputedClause()];
        const range = dateRangeClause(query.from, query.to);
        if (range) clauses.push(range);

        return this.findPage({ $and: clauses } as Filter<OrderReadModel>, {
            page: query.page,
            limit: query.limit,
            sort: toMongoSort(query.sort, ORDER_DISPUTE_SORT),
        });
    }

    async findById(orderId: string): Promise<OrderReadModel | null> {
        if (!Types.ObjectId.isValid(orderId)) return null;
        return this.findOneBy({ _id: new ObjectId(orderId) } as Filter<OrderReadModel>);
    }

    async findDetailById(orderId: string): Promise<OrderReadModel | null> {
        if (!Types.ObjectId.isValid(orderId)) return null;
        const [order] = await this.findBy(
            { _id: new ObjectId(orderId) } as Filter<OrderReadModel>,
            { projection: ORDER_DETAIL_PROJECTION, limit: 1 },
        );
        return order ?? null;
    }
}

/** Orders frozen by a dispute, or flagged `disputed` without a hold (pre-`dispute_hold` rows). */
function disputedClause(): Filter<OrderReadModel> {
    return {
        $or: [{ 'dispute_hold.active': true }, { payment_status: 'disputed' }],
    } as Filter<OrderReadModel>;
}

function dateRangeClause(from?: Date, to?: Date): Filter<OrderReadModel> | null {
    if (!from && !to) return null;
    const range: Record<string, Date> = {};
    if (from) range.$gte = from;
    // Half-open `[from, to)`, matching `dateRangeFields`.
    if (to) range.$lt = to;
    return { created_at: range } as unknown as Filter<OrderReadModel>;
}

/**
 * Translate a validated query into a Mongo filter. Pure and exported — the DB-free test
 * imports it directly.
 *
 * ── Why `$and` and never `Object.assign` ──────────────────────────────────────
 * This filter can carry TWO `$or`-shaped clauses at once: `disputed` and `search`. Merging
 * them into one object means the second silently replaces the first, and the result is a
 * query that looks right, returns rows, and answers a different question than the one
 * asked. Composing under `$and` is what makes that impossible rather than unlikely.
 */
export function buildFilter(
    query: OrderSearchQuery,
    resolved: OrderSearchResolution = EMPTY_RESOLUTION,
): Filter<OrderReadModel> {
    const clauses: Filter<OrderReadModel>[] = [];

    if (query.orderType) clauses.push({ order_type: query.orderType } as Filter<OrderReadModel>);
    if (query.paymentMethod) clauses.push({ payment_method: query.paymentMethod } as Filter<OrderReadModel>);
    if (query.paymentStatus) clauses.push({ payment_status: query.paymentStatus } as Filter<OrderReadModel>);
    if (query.fulfillmentStatus) {
        clauses.push({ fulfillment_status: query.fulfillmentStatus } as Filter<OrderReadModel>);
    }
    if (query.vendorId) clauses.push({ vendor_id: new ObjectId(query.vendorId) } as Filter<OrderReadModel>);
    if (query.customerId) {
        clauses.push({ customer_id: new ObjectId(query.customerId) } as Filter<OrderReadModel>);
    }

    if (query.completed !== undefined) {
        clauses.push({
            'completion.confirmed_at': query.completed ? { $ne: null } : { $eq: null },
        } as unknown as Filter<OrderReadModel>);
    }

    // `$or`-shaped clause #1.
    if (query.disputed !== undefined) {
        clauses.push(
            query.disputed
                ? disputedClause()
                : ({
                    $and: [
                        { $or: [{ 'dispute_hold.active': { $ne: true } }, { 'dispute_hold.active': { $exists: false } }] },
                        { payment_status: { $ne: 'disputed' } },
                    ],
                } as unknown as Filter<OrderReadModel>),
        );
    }

    const range = dateRangeClause(query.from, query.to);
    if (range) clauses.push(range);

    // `$or`-shaped clause #2.
    if (query.search) clauses.push(searchClause(query.search, resolved));

    if (clauses.length === 0) return {};
    if (clauses.length === 1) return clauses[0];
    return { $and: clauses } as Filter<OrderReadModel>;
}

/**
 * The free-text branch.
 *
 * ── Anchored and CASE-SENSITIVE, deliberately ─────────────────────────────────
 * `order_number` carries a unique index and the format is `ORD-2026-000123` — always
 * uppercase. An anchored, case-sensitive `^` regex uses that index; the
 * `containsInsensitive` helper the rest of this service reaches for would be a full
 * collection scan on the platform's largest collection, requestable by query string. This
 * is the one place the module departs from the shared search helper, and this is why.
 */
function searchClause(term: string, resolved: OrderSearchResolution): Filter<OrderReadModel> {
    const branches: Record<string, unknown>[] = [];

    if (/^[A-Za-z]/.test(term)) {
        branches.push({ order_number: new RegExp('^' + escapeRegex(term.toUpperCase())) });
    }

    if (term.length === 24 && Types.ObjectId.isValid(term)) {
        const id = new ObjectId(term);
        branches.push({ _id: id });
        branches.push({ customer_id: id });   // an id pasted from the customer directory
        branches.push({ vendor_id: id });     // or from the vendor directory
        branches.push({ cart_id: id });       // the checkout group
    }

    if (resolved.customerIds.length > 0) branches.push({ customer_id: { $in: resolved.customerIds } });
    if (resolved.vendorIds.length > 0) branches.push({ vendor_id: { $in: resolved.vendorIds } });

    // A term that matched nothing must return nothing, not everything. An empty `$or` is a
    // Mongo error, so the impossible clause is explicit.
    if (branches.length === 0) return { _id: { $in: [] } } as unknown as Filter<OrderReadModel>;

    return { $or: branches } as Filter<OrderReadModel>;
}
