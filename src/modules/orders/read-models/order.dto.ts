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
    delivery: {
        agencyId: string | null;
        shipmentId: string | null;
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
    metadata: Record<string, unknown> | null;
    occurredAt: string | null;
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
        items: (order.items ?? []).map(toOrderItemDto),
    };
}

function toOrderItemDto(item: NonNullable<OrderReadModel['items']>[number]): OrderItemDto {
    const delivery = item.delivery;
    return {
        id: item._id ? item._id.toString() : null,
        productId: item.product_id ? item.product_id.toString() : null,
        variantId: item.variant_id ? item.variant_id.toString() : null,
        sku: item.sku ?? null,
        title: item.title ?? null,
        variantTitle: item.variant_title ?? null,
        optionsSnapshot: item.options_snapshot ?? null,
        productType: item.product_type ?? null,
        quantity: item.quantity ?? 0,
        price: item.price ?? 0,
        currency: item.currency ?? null,
        delivery: delivery
            ? {
                agencyId: delivery.agency_id ? delivery.agency_id.toString() : null,
                shipmentId: delivery.shipment_id ? delivery.shipment_id.toString() : null,
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
export function toOrderTimelineEntryDto(entry: OrderTimelineReadModel): OrderTimelineEntryDto {
    return {
        id: entry._id.toString(),
        eventType: entry.event_type,
        description: entry.description ?? null,
        actorType: entry.actor_type,
        actorId: entry.actor_id ? entry.actor_id.toString() : null,
        metadata: entry.metadata ?? null,
        occurredAt: toIso(entry.created_at),
    };
}
