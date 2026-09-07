import { FileDetail } from '../../../infra/storage/file-detail';
import { productImageKey } from '../../vendors/repositories/product-media.read.repository';
import { OrderReadModel } from '../repositories/order.read.repository';
import { OrderTimelineReadModel } from '../repositories/order-context.read.repository';

/**
 * Wire shapes for `/api/v1/orders`.
 *
 * Named-field mapping throughout, **never a spread** — the second of the two locks that
 * keep a widened projection from reaching the wire on its own. The first is the projection
 * whitelist in the repository; this is what stops a field added there from appearing on an
 * endpoint nobody re-reviewed.
 */

function toIso(value: Date | null | undefined): string | null {
    if (!value) return null;
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export interface OrderListItemDto {
    id: string;
    orderNumber: string;
    type: string;
    /** The `cart_id` — one checkout splits into one order per vendor, all sharing it. */
    checkoutGroupId: string | null;
    vendorId: string;
    vendorName: string | null;
    customerId: string;
    customerName: string | null;
    currency: string;
    totalAmount: number;
    paymentMethod: string;
    paymentStatus: string;
    fulfillmentStatus: string;
    /** Frozen by a payment dispute. */
    disputeHeld: boolean;
    /** The escrow gate — orthogonal to `fulfillmentStatus`, not derivable from it. */
    completedAt: string | null;
    itemCount: number;
    createdAt: string | null;
    updatedAt: string | null;
}

export interface OrderDetailDto extends OrderListItemDto {
    priceBreakdown: {
        base: number | null;
        tax: number | null;
        discount: number | null;
        total: number | null;
    } | null;
    paymentIntentId: string | null;
    /** Present only while meaningful — `null` when this order has never been disputed. */
    dispute: {
        active: boolean;
        disputedAt: string | null;
        resolvedAt: string | null;
        gatewayDisputeId: string | null;
        reason: string | null;
    } | null;
    completion: {
        confirmedAt: string | null;
        confirmedBy: string | null;
        auto: boolean;
    } | null;
    /**
     * The drop-off, TEXTUAL only. `coordinates` and `raw_input` are absent by projection
     * AND by this mapping — the two locks again, on the sharpest PII in the collection.
     */
    deliveryAddress: {
        formattedAddress: string | null;
        components: Record<string, unknown> | null;
    } | null;
    items: OrderItemDto[];
}

export interface OrderItemDto {
    id: string | null;
    productId: string | null;
    variantId: string | null;
    sku: string | null;
    title: string | null;
    variantTitle: string | null;
    optionsSnapshot: string | null;
    productType: string | null;
    quantity: number;
    price: number;
    currency: string | null;
    /**
     * What the thing on this line looks like — the PRIMARY image, never the gallery (BR-017 A).
     *
     * Resolved live against the product's current media rather than snapshotted, because an
     * image is not a term of the sale: the line snapshots title, sku and price precisely so
     * they cannot drift, while the *current* picture is the more useful one for recognising
     * an object in a dispute. It also means every order that already exists has one, with no
     * backfill.
     *
     * **Variant-preferred**, falling back to the product's own media — see
     * `ProductMediaReadRepository`. The line names a specific `variantId`, so that variant's
     * photograph is the truthful answer: a red T-shirt must not show the blue one.
     *
     * `null` is expected and fine — a digital line, a product whose media was swept, a
     * product deleted since the order. Render the title alone.
     *
     * ⚠ Render gated on **three** conditions, not one: `access === 'public'`, `url !== null`
     * AND `mimeType.startsWith('image/')`. This is a full `FileDetail` rather than a bare
     * URL string exactly so a client is not left guessing at the first two.
     */
    image: FileDetail | null;
    delivery: {
        agencyId: string | null;
        /**
         * The agency's business name, from the Magazin (BR-016 § 4). `null` where the
         * item has no agency yet, where the agency row is gone, or where the Magazin has
         * no name — **never `display_name`**, which is the agency's contact PERSON.
         */
        agencyName: string | null;
        shipmentId: string | null;
        /**
         * ⚠ **The handle an operator actually works with** (BR-016 § 4).
         *
         * `shipmentId` is an internal id that cannot be typed into anything: the shipment
         * directory's `search` takes a tracking-number PREFIX, and a customer on the phone
         * quotes a tracking number, never an ObjectId.
         *
         * `null` while the item is unfulfilled — the ordinary state, not an error — and also
         * on a shipment created before tracking numbers were stamped.
         */
        trackingNumber: string | null;
        status: string | null;
        freeDelivery: boolean;
        /** Set when an agency deactivation put this item on hold. */
        hold: { previousStatus: string | null; heldAt: string | null } | null;
        pickup: {
            source: string | null;
            vendorAddressId: string | null;
            agencyAddressId: string | null;
        } | null;
    } | null;
}

export interface OrderTimelineEntryDto {
    id: string;
    eventType: string;
    description: string | null;
    actorType: string;
    actorId: string | null;
    /**
     * Who that id is (BR-016 § 5). `null` for `system`, and `null` where the record is gone.
     *
     * ⚠ **The four actor types resolve in three different places, and one of them is not
     * `jovi_mall` at all.** An `admin` row was written by THIS service — jovi-mall's
     * admin-caller middleware stamps `X-Actor-Id`, a wi-admin `admin_accounts._id`, into a
     * column declared `ref: MODELS.USER` where it dereferences to nothing. wi-admin is the
     * only thing that can name it, and it does so with no hop.
     *
     * A `vendor` row's id is a **vendor id** and resolves to the STORE's business name; a
     * `customer` row's id is a **customer id**. Neither is a `users._id`, whatever
     * `order-timeline.model.ts`'s "User ID if applicable" comment says.
     */
    actorName: string | null;
    metadata: Record<string, unknown> | null;
    occurredAt: string | null;
}

/**
 * The per-item decorations the DETAIL read resolves, all three batched for the whole array.
 *
 * A parameter object rather than three, because they travel together and a caller that
 * resolved two of them has a bug rather than a smaller feature.
 */
export interface OrderItemContext {
    /** `agency_id` → the Magazin's business name. */
    agencyName: Map<string, string | null>;
    /** `shipment_id` → `tracking_number`. */
    trackingNumber: Map<string, string | null>;
    /** `productImageKey(productId, variantId)` → the primary image. */
    image: Map<string, FileDetail>;
}

/** Nothing resolved — what the list path passes, and the shape of an empty order. */
export const EMPTY_ITEM_CONTEXT: OrderItemContext = {
    agencyName: new Map(),
    trackingNumber: new Map(),
    image: new Map(),
};

/**
 * Actor names for a page of timeline rows, keyed by `${actorType}:${actorId}`.
 *
 * Keyed on the PAIR, not on the id alone: the three resolvable types draw from three
 * different id spaces (a wi-admin `admin_accounts._id`, a `vendors._id`, a `customers._id`),
 * and a single-keyed map would let a collision across two of them print the wrong person's
 * name. jovi-mall's own resolver keys on the bare id; this one does not.
 */
export type TimelineActorNames = Map<string, string | null>;

export function timelineActorKey(actorType: string, actorId: string): string {
    return `${actorType}:${actorId}`;
}

export function toOrderListItemDto(
    order: OrderReadModel,
    names: { vendor: Map<string, string | null>; customer: Map<string, string | null> },
): OrderListItemDto {
    return {
        id: order._id.toString(),
        orderNumber: order.order_number,
        type: order.order_type,
        checkoutGroupId: order.cart_id ? order.cart_id.toString() : null,
        vendorId: order.vendor_id.toString(),
        vendorName: names.vendor.get(order.vendor_id.toString()) ?? null,
        customerId: order.customer_id.toString(),
        customerName: names.customer.get(order.customer_id.toString()) ?? null,
        currency: order.currency,
        totalAmount: order.total_amount,
        paymentMethod: order.payment_method,
        paymentStatus: order.payment_status,
        fulfillmentStatus: order.fulfillment_status,
        disputeHeld: order.dispute_hold?.active ?? false,
        completedAt: toIso(order.completion?.confirmed_at),
        itemCount: order.items?.length ?? 0,
        createdAt: toIso(order.created_at),
        updatedAt: toIso(order.updated_at),
    };
}

export function toOrderDetailDto(
    order: OrderReadModel,
    names: { vendor: Map<string, string | null>; customer: Map<string, string | null> },
    itemContext: OrderItemContext = EMPTY_ITEM_CONTEXT,
): OrderDetailDto {
    const hold = order.dispute_hold;
    // Keyed on having ever been disputed, not on `active`: a resolved dispute is exactly
    // what an administrator is looking for when they open this screen. Absent entirely when
    // there never was one, rather than a block of nulls that reads as "unknown".
    const everDisputed = Boolean(hold && (hold.active || hold.disputed_at || hold.gateway_dispute_id));

    return {
        ...toOrderListItemDto(order, names),
        priceBreakdown: order.price_breakdown
            ? {
                base: order.price_breakdown.base ?? null,
                tax: order.price_breakdown.tax ?? null,
                discount: order.price_breakdown.discount ?? null,
                total: order.price_breakdown.total ?? null,
            }
            : null,
        paymentIntentId: order.payment_intent_id ?? null,
        dispute: everDisputed
            ? {
                active: hold?.active ?? false,
                disputedAt: toIso(hold?.disputed_at),
                resolvedAt: toIso(hold?.resolved_at),
                gatewayDisputeId: hold?.gateway_dispute_id ?? null,
                reason: hold?.reason ?? null,
            }
            : null,
        completion: order.completion
            ? {
                confirmedAt: toIso(order.completion.confirmed_at),
                confirmedBy: order.completion.confirmed_by ?? null,
                auto: order.completion.auto ?? false,
            }
            : null,
        deliveryAddress: order.delivery_address
            ? {
                formattedAddress: order.delivery_address.formatted_address ?? null,
                components: order.delivery_address.components ?? null,
            }
            : null,
        items: (order.items ?? []).map((item) => toOrderItemDto(item, itemContext)),
    };
}

function toOrderItemDto(
    item: NonNullable<OrderReadModel['items']>[number],
    context: OrderItemContext,
): OrderItemDto {
    const delivery = item.delivery;
    const productId = item.product_id ? item.product_id.toString() : null;
    const variantId = item.variant_id ? item.variant_id.toString() : null;
    const agencyId = delivery?.agency_id ? delivery.agency_id.toString() : null;
    const shipmentId = delivery?.shipment_id ? delivery.shipment_id.toString() : null;

    return {
        id: item._id ? item._id.toString() : null,
        productId,
        variantId,
        sku: item.sku ?? null,
        title: item.title ?? null,
        variantTitle: item.variant_title ?? null,
        optionsSnapshot: item.options_snapshot ?? null,
        productType: item.product_type ?? null,
        quantity: item.quantity ?? 0,
        price: item.price ?? 0,
        currency: item.currency ?? null,
        image: context.image.get(productImageKey(productId, variantId)) ?? null,
        delivery: delivery
            ? {
                agencyId,
                agencyName: agencyId ? context.agencyName.get(agencyId) ?? null : null,
                shipmentId,
                trackingNumber: shipmentId ? context.trackingNumber.get(shipmentId) ?? null : null,
                status: delivery.status ?? null,
                freeDelivery: delivery.free_delivery ?? false,
                hold: delivery.hold
                    ? {
                        previousStatus: delivery.hold.previousStatus ?? null,
                        heldAt: toIso(delivery.hold.heldAt),
                    }
                    : null,
                pickup: delivery.pickup_location
                    ? {
                        source: delivery.pickup_location.source ?? null,
                        vendorAddressId: delivery.pickup_location.vendor_address_id
                            ? delivery.pickup_location.vendor_address_id.toString()
                            : null,
                        agencyAddressId: delivery.pickup_location.agency_address_id
                            ? delivery.pickup_location.agency_address_id.toString()
                            : null,
                    }
                    : null,
            }
            : null,
    };
}

/**
 * `metadata` is `Mixed` in jovi-mall and written by every transition path, so it is passed
 * through as an opaque object rather than mapped field by field — but it is passed through
 * DELIBERATELY and named here, not spread into the entry. A future field on it that turns
 * out to be sensitive is one edit away from being stripped.
 */
export function toOrderTimelineEntryDto(
    entry: OrderTimelineReadModel,
    actorNames: TimelineActorNames = new Map(),
): OrderTimelineEntryDto {
    const actorId = entry.actor_id ? entry.actor_id.toString() : null;

    return {
        id: entry._id.toString(),
        eventType: entry.event_type,
        description: entry.description ?? null,
        actorType: entry.actor_type,
        actorId,
        actorName: actorId
            ? actorNames.get(timelineActorKey(entry.actor_type, actorId)) ?? null
            : null,
        metadata: entry.metadata ?? null,
        occurredAt: toIso(entry.created_at),
    };
}
