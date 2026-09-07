import { Document, Filter, ObjectId } from 'mongodb';
import { Types } from 'mongoose';
import { COLLECTIONS } from '../../../infra/platform/collections';
import { PlatformReadRepository } from '../../../infra/platform/platform.repository';

/**
 * Turning a ticket's `about` into somewhere an operator can actually go (BR-016 § 7).
 *
 * A ticket points at a domain object with `(entity_type, entity_id)` and nothing else. The
 * dashboard can route `ORDER` and `SHIPMENT` from that pair alone — the type maps to a path
 * and the id is the parameter — and could not route `PRODUCT` at all, because a product's
 * detail route is `/vendors/:vendorId/products/:productId` and needs **two** ids. There is
 * no vendor-agnostic product read anywhere on this service, which left the entity type most
 * likely to be on a catalogue complaint as the one type with no link.
 *
 * ── Three tiny repositories in one file, matching the module convention ──────
 * `order-context.read.repository.ts` and `shipment-context.read.repository.ts` do the same:
 * each is a handful of lines over a collection this module reads only in service of its own
 * subject. Three files of fifteen lines would be filing rather than structure.
 *
 * ── One read per ticket, dispatched on the type ──────────────────────────────
 * The detail is one ticket, so this resolves ONE entity — never a set, and never one per
 * row of the queue. The list deliberately does not carry it: a hundred-row page would be a
 * hundred lookups across three collections for a column that shows an id.
 *
 * ── What is deliberately NOT resolved ────────────────────────────────────────
 * The eight remaining types answer `{ vendorId: null, label: null }` rather than growing a
 * lookup each. `USER`, `VENDOR`, `AGENT` and `AGENCY` already have a directory the dashboard
 * routes to from the type alone, so a label buys nothing a click does not; `BOOKING` and
 * `DELIVERY` have no admin surface to link to at all; `OTHER` names no entity by definition —
 * jovi-mall's own create validator lets `entityId` be omitted for it.
 *
 * ⚠ `CUSTOMER` was listed in the first group until 2026-08-26 and belongs in the second. There
 * is no `/customers` mount on this service (`customers.read` was deleted at ADR-017 D-1) and
 * the user directory is keyed on `users._id`, while a customer id is a `customers._id` — so
 * the dashboard cannot route it and a customer id pasted into the user search finds nothing.
 * Resolving a LABEL for it would need a lookup this switch does not make, and would still be
 * guessing which of the two id spaces `entity_id` holds: nothing validates it (jovi-mall's
 * `validateEntityReference` shape-checks and stores it unread for every type but the three
 * above).
 */

/** What a ticket's entity resolves to. Both fields are `null` for an unresolvable one. */
export interface TicketEntityRef {
    /**
     * Set for `PRODUCT` only, and it is the whole point of § 7: without it the product
     * route cannot be built. `null` on every other type — those are not products, not
     * "unknown vendors".
     */
    vendorId: string | null;
    /**
     * Something an operator recognises: the order number, the tracking number, the product
     * title. A nice-to-have rather than a blocker — given a routable id the destination
     * screen supplies the name — so it is `null` wherever resolving one would cost a read
     * the type does not otherwise need.
     */
    label: string | null;
}

const UNRESOLVED: TicketEntityRef = { vendorId: null, label: null };

/**
 * `products` stores its fields in **camelCase**, unlike almost everything else this service
 * reads. jovi-mall's catalogue convention, not a slip — see `vendor-product.read.repository.ts`.
 */
interface TicketProductReadModel extends Document {
    _id: ObjectId;
    vendorId?: ObjectId;
    title?: string;
}

class TicketProductRefRepository extends PlatformReadRepository<TicketProductReadModel> {
    constructor() {
        super(COLLECTIONS.PRODUCT, { _id: 1, vendorId: 1, title: 1 });
    }

    /**
     * `deletedAt` is deliberately NOT filtered, and that is the opposite call from
     * `buildProductFilter`'s unconditional `deletedAt: null`.
     *
     * That rule protects a LISTING: a soft-deleted product on an administrative directory is
     * a listing an operator might suspend, reinstate or count. This is a ticket ABOUT a
     * product — very often a complaint that ended with the listing being taken down — and
     * refusing to name it would make the one ticket most worth reading the one with no link.
     */
    async findRef(productId: string): Promise<TicketEntityRef> {
        if (!Types.ObjectId.isValid(productId)) return UNRESOLVED;

        const row = await this.findOneBy({ _id: new ObjectId(productId) } as Filter<TicketProductReadModel>);
        if (!row) return UNRESOLVED;

        return {
            vendorId: row.vendorId ? row.vendorId.toString() : null,
            label: row.title ?? null,
        };
    }
}

interface TicketOrderReadModel extends Document {
    _id: ObjectId;
    order_number?: string;
}

class TicketOrderRefRepository extends PlatformReadRepository<TicketOrderReadModel> {
    constructor() {
        super(COLLECTIONS.ORDER, { _id: 1, order_number: 1 });
    }

    async findLabel(orderId: string): Promise<string | null> {
        if (!Types.ObjectId.isValid(orderId)) return null;
        const row = await this.findOneBy({ _id: new ObjectId(orderId) } as Filter<TicketOrderReadModel>);
        return row?.order_number ?? null;
    }
}

interface TicketShipmentReadModel extends Document {
    _id: ObjectId;
    tracking_number?: string | null;
}

class TicketShipmentRefRepository extends PlatformReadRepository<TicketShipmentReadModel> {
    constructor() {
        super(COLLECTIONS.SHIPMENT, { _id: 1, tracking_number: 1 });
    }

    async findLabel(shipmentId: string): Promise<string | null> {
        if (!Types.ObjectId.isValid(shipmentId)) return null;
        const row = await this.findOneBy({ _id: new ObjectId(shipmentId) } as Filter<TicketShipmentReadModel>);
        return row?.tracking_number ?? null;
    }
}

/**
 * The facade the ticket detail calls. One switch, at most one query.
 *
 * The three cases are named literals rather than a map keyed by the whole vocabulary: the
 * token set is jovi-mall's `EntityType` enum and this service validates it by SHAPE, not
 * membership (ADR-005 D-17), so a type added there must land in the default branch — a
 * `null` label — rather than in a lookup somebody has to remember to write.
 */
export class TicketEntityReadRepository {
    private readonly products = new TicketProductRefRepository();
    private readonly orders = new TicketOrderRefRepository();
    private readonly shipments = new TicketShipmentRefRepository();

    async resolve(entityType: string, entityId: string): Promise<TicketEntityRef> {
        if (!entityId) return UNRESOLVED;

        switch (entityType) {
            case 'PRODUCT':
                return this.products.findRef(entityId);
            case 'ORDER':
                return { vendorId: null, label: await this.orders.findLabel(entityId) };
            case 'SHIPMENT':
                return { vendorId: null, label: await this.shipments.findLabel(entityId) };
            default:
                return UNRESOLVED;
        }
    }
}
