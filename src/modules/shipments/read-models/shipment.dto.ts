import { FileDetail } from '../../../infra/storage/file-detail';
import { productImageKey } from '../../vendors/repositories/product-media.read.repository';
import { ShipmentReadModel } from '../repositories/shipment.read.repository';
import {
    CashCollectionReadModel,
    OrderItemSnapshot,
    OrderRef,
    OutboxHealth,
    ShipmentOfferReadModel,
} from '../repositories/shipment-context.read.repository';

/**
 * Wire shapes for `/api/v1/shipments`.
 *
 * Named-field mapping throughout, **never a spread** — the second of the two locks that
 * keep a widened projection off the wire. In this module that is not a style rule: the
 * collections behind it hold a COD delivery code and an agent's GPS position, and a spread
 * is how one of those reaches a browser after somebody adds a field to a projection.
 */

function toIso(value: Date | null | undefined): string | null {
    if (!value) return null;
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export interface PartyRef {
    id: string;
    name: string | null;
}

export interface ShipmentListItemDto {
    id: string;
    trackingNumber: string | null;
    status: string;
    orderId: string;
    orderNumber: string | null;
    agency: PartyRef;
    agent: PartyRef | null;
    assignmentState: string | null;
    /** Frozen by the agency-deactivation cascade. */
    held: boolean;
    itemCount: number;
    deliveryFeeSnapshot: number | null;
    createdAt: string | null;
    updatedAt: string | null;
}

/**
 * The order card on a shipment detail — every field of `OrderRef`, named, plus the vendor's
 * business name (BR-016 § 6).
 *
 * ⚠ **`vendorName` here is the STORE's name, and `GET /orders`'s `vendorName` is NOT.**
 * That one reads `vendors.display_name`, which `vendor.model.ts` documents as the vendor's
 * *personal* name — "the public BUSINESS name … live on the vendor's Store". So the two
 * fields share a name and a shape and answer different questions. This one is the business,
 * which is what the card is asking for and what an operator recognises the shop by; the
 * discrepancy on the order list is reported rather than silently mirrored here, because
 * copying the wrong source to be consistent is how BR-006's `contactName` column happened.
 *
 * `null` where the vendor has no Store row (a vendor mid-onboarding) or none was resolved.
 * `null`, never `''`, and never `display_name` substituted in.
 */
export interface ShipmentOrderRefDto extends OrderRef {
    vendorName: string | null;
}

export interface ShipmentItemDto {
    orderItemId: string | null;
    productId: string | null;
    variantId: string | null;
    quantity: number;
    /**
     * The line's title, price and currency, joined from the ORDER's item snapshot on
     * `orderItemId` (BR-017 B).
     *
     * These are the terms of the SALE and are snapshotted upstream precisely so they cannot
     * drift — which is why they are read from the order line rather than from the product,
     * and why they are `null` when the order line is gone rather than refreshed from the
     * catalogue.
     */
    title: string | null;
    price: number | null;
    currency: string | null;
    /**
     * The primary image, variant-preferred — the same resolution the order detail uses, so
     * the two screens cannot show different pictures of one parcel.
     *
     * Live rather than snapshotted, and `null` is ordinary. Render gated on all three of
     * `access === 'public'`, `url !== null` and `mimeType.startsWith('image/')`.
     */
    image: FileDetail | null;
}

export interface ShipmentDetailDto extends ShipmentListItemDto {
    order: ShipmentOrderRefDto | null;
    assignment: {
        state: string | null;
        currentOfferId: string | null;
        offeredAgentId: string | null;
        updatedAt: string | null;
        offerCount: number;
    };
    statusHistory: {
        status: string | null;
        at: string | null;
        byUserId: string | null;
        byRole: string | null;
    }[];
    /**
     * Where a replacement agent collects — TEXTUAL only.
     *
     * `pickup.location` and `pickup.geo` are absent by projection AND by this mapping. The
     * `source` is very often `previous_agent_location`, which means that point is a
     * delivery agent's last known GPS position; the platform's two-gate privacy split
     * exists to control exactly that value, and it does not leave through here.
     */
    handover: {
        source: string | null;
        label: string | null;
        note: string | null;
        isFallback: boolean;
        address: Record<string, unknown> | null;
        fromAgentId: string | null;
        fromStatus: string | null;
        reassignedAt: string | null;
    } | null;
    deliveryFailures: {
        status: string | null;
        reason: string | null;
        note: string | null;
        fromStatus: string | null;
        reportedByAgentId: string | null;
        reportedAt: string | null;
    }[];
    agentCancellation: {
        reason: string | null;
        note: string | null;
        cancelledByAgentId: string | null;
        fromStatus: string | null;
        cancelledAt: string | null;
    } | null;
    rejection: {
        reason: string | null;
        note: string | null;
        at: string | null;
        /** `source` says which database the id resolves in; `admin` ids resolve in neither. */
        by: { id: string | null; source: string; name: string | null };
    } | null;
    customerConfirmation: {
        confirmedAt: string | null;
        confirmedBy: string | null;
        auto: boolean;
    } | null;
    hold: { previousStatus: string | null; heldAt: string | null } | null;
    /** Cash state. **Never the delivery code** — see the repository's ban list. */
    cod: {
        collectionId: string;
        status: string;
        expectedAmount: number;
        currency: string | null;
        collectedAt: string | null;
        verificationMethod: string | null;
        codeAttempts: number;
        codeLocked: boolean;
        settledAmount: number | null;
        settledAt: string | null;
    } | null;
    offers: ShipmentOfferDto[];
    items: ShipmentItemDto[];
    deliveryProofFileId: string | null;
    /**
     * Outbox HEALTH, not a trackability verdict.
     *
     * Whether this shipment's news actually reached geo-tracker. The verdict itself —
     * "is this shipment trackable" — is jovi-mall's policy and is deliberately not
     * recomputed here.
     */
    tracking: { outbox: OutboxHealth };
}

export interface ShipmentOfferDto {
    id: string;
    agentId: string;
    agentName: string | null;
    status: string;
    origin: string | null;
    round: number | null;
    /** Null for a manual offer; set when the offer came from an auto-assignment session. */
    sessionId: string | null;
    createdBy: { role: string | null; userId: string | null; name: string | null } | null;
    expiresAt: string | null;
    respondedAt: string | null;
    rejectionReason: string | null;
    createdAt: string | null;
}

export interface ShipmentNames {
    agency: Map<string, string | null>;
    agent: Map<string, string | null>;
    order: Map<string, OrderRef>;
}

export function toShipmentListItemDto(
    shipment: ShipmentReadModel,
    names: ShipmentNames,
): ShipmentListItemDto {
    const agencyId = shipment.agency_id.toString();
    const agentId = shipment.agent_id ? shipment.agent_id.toString() : null;
    const orderId = shipment.order_id.toString();

    return {
        id: shipment._id.toString(),
        trackingNumber: shipment.tracking_number ?? null,
        status: shipment.status,
        orderId,
        orderNumber: names.order.get(orderId)?.orderNumber ?? null,
        agency: { id: agencyId, name: names.agency.get(agencyId) ?? null },
        agent: agentId ? { id: agentId, name: names.agent.get(agentId) ?? null } : null,
        assignmentState: shipment.assignment?.state ?? null,
        held: Boolean(shipment.hold),
        itemCount: shipment.items?.length ?? 0,
        deliveryFeeSnapshot: shipment.delivery_fee_snapshot ?? null,
        createdAt: toIso(shipment.created_at),
        updatedAt: toIso(shipment.updated_at),
    };
}

/** Everything the DETAIL resolves beyond the list's three name maps. */
export interface ShipmentDetailContext {
    offers: ShipmentOfferReadModel[];
    cod: CashCollectionReadModel | null;
    outbox: OutboxHealth;
    /** The order's vendor, by BUSINESS name — see `ShipmentOrderRefDto`. */
    vendorName: string | null;
    /** `order_item_id` → the sale's terms for that line. */
    itemSnapshots: Map<string, OrderItemSnapshot>;
    /** `productImageKey(productId, variantId)` → the primary image. */
    images: Map<string, FileDetail>;
}

/**
 * The order card, mapped field by field.
 *
 * A named mapping rather than handing the repository's `OrderRef` straight out: it now
 * carries a field that comes from a different collection, and a pass-through would make the
 * next field added to `OrderRefReadModel`'s projection reach the wire on its own — the very
 * thing this file's header says the mappers exist to prevent.
 */
function toShipmentOrderRefDto(ref: OrderRef, vendorName: string | null): ShipmentOrderRefDto {
    return {
        id: ref.id,
        orderNumber: ref.orderNumber,
        paymentMethod: ref.paymentMethod,
        paymentStatus: ref.paymentStatus,
        fulfillmentStatus: ref.fulfillmentStatus,
        customerId: ref.customerId,
        vendorId: ref.vendorId,
        vendorName,
    };
}

export function toShipmentDetailDto(
    shipment: ShipmentReadModel,
    names: ShipmentNames,
    context: ShipmentDetailContext,
): ShipmentDetailDto {
    const handover = shipment.handover;
    const rejection = shipment.rejection;
    const orderRef = names.order.get(shipment.order_id.toString()) ?? null;

    return {
        ...toShipmentListItemDto(shipment, names),
        order: orderRef ? toShipmentOrderRefDto(orderRef, context.vendorName) : null,
        assignment: {
            state: shipment.assignment?.state ?? null,
            currentOfferId: shipment.assignment?.current_offer_id?.toString() ?? null,
            offeredAgentId: shipment.assignment?.offered_agent_id?.toString() ?? null,
            updatedAt: toIso(shipment.assignment?.updated_at),
            offerCount: context.offers.length,
        },
        statusHistory: (shipment.status_history ?? []).map((entry) => ({
            status: entry.status ?? null,
            at: toIso(entry.changed_at),
            byUserId: entry.changed_by_user_id ? entry.changed_by_user_id.toString() : null,
            byRole: entry.changed_by_role ?? null,
        })),
        handover: handover
            ? {
                source: handover.pickup?.source ?? null,
                label: handover.pickup?.label ?? null,
                note: handover.pickup?.note ?? null,
                isFallback: handover.pickup?.is_fallback ?? false,
                address: handover.pickup?.address ?? null,
                fromAgentId: handover.from_agent_id ? handover.from_agent_id.toString() : null,
                fromStatus: handover.from_status ?? null,
                reassignedAt: toIso(handover.reassigned_at),
            }
            : null,
        deliveryFailures: (shipment.delivery_failures ?? []).map((failure) => ({
            status: failure.status ?? null,
            reason: failure.reason ?? null,
            note: failure.note ?? null,
            fromStatus: failure.from_status ?? null,
            reportedByAgentId: failure.reported_by_agent_id
                ? failure.reported_by_agent_id.toString()
                : null,
            reportedAt: toIso(failure.reported_at),
        })),
        agentCancellation: shipment.agent_cancellation
            ? {
                reason: shipment.agent_cancellation.reason ?? null,
                note: shipment.agent_cancellation.note ?? null,
                cancelledByAgentId: shipment.agent_cancellation.cancelled_by_agent_id
                    ? shipment.agent_cancellation.cancelled_by_agent_id.toString()
                    : null,
                fromStatus: shipment.agent_cancellation.from_status ?? null,
                cancelledAt: toIso(shipment.agent_cancellation.cancelled_at),
            }
            : null,
        rejection: rejection
            ? {
                reason: rejection.reason ?? null,
                note: rejection.note ?? null,
                at: toIso(rejection.rejectedAt),
                by: {
                    id: rejection.rejectedBy ? rejection.rejectedBy.toString() : null,
                    // Defaults to 'platform' exactly as the schema does — a row written
                    // before the admin split carries neither field and IS a platform row.
                    source: rejection.rejectedBySource ?? 'platform',
                    name: rejection.rejectedByName ?? null,
                },
            }
            : null,
        customerConfirmation: shipment.customer_confirmation
            ? {
                confirmedAt: toIso(shipment.customer_confirmation.confirmed_at),
                confirmedBy: shipment.customer_confirmation.confirmed_by
                    ? shipment.customer_confirmation.confirmed_by.toString()
                    : null,
                auto: shipment.customer_confirmation.auto ?? false,
            }
            : null,
        hold: shipment.hold
            ? {
                previousStatus: shipment.hold.previousStatus ?? null,
                heldAt: toIso(shipment.hold.heldAt),
            }
            : null,
        cod: context.cod ? toCodDto(context.cod) : null,
        offers: context.offers.map((offer) => toShipmentOfferDto(offer, names.agent)),
        items: (shipment.items ?? []).map((item) => {
            const orderItemId = item.order_item_id ? item.order_item_id.toString() : null;
            const productId = item.product_id ? item.product_id.toString() : null;
            const variantId = item.variant_id ? item.variant_id.toString() : null;
            const snapshot = orderItemId ? context.itemSnapshots.get(orderItemId) : undefined;

            return {
                orderItemId,
                productId,
                variantId,
                quantity: item.quantity ?? 0,
                title: snapshot?.title ?? null,
                price: snapshot?.price ?? null,
                currency: snapshot?.currency ?? null,
                image: context.images.get(productImageKey(productId, variantId)) ?? null,
            };
        }),
        deliveryProofFileId: shipment.delivery_proof_file_id
            ? shipment.delivery_proof_file_id.toString()
            : null,
        tracking: { outbox: context.outbox },
    };
}

/**
 * The cash block.
 *
 * Every field is named. `code_plain` and `code_hash` are absent from the projection AND
 * have no line here — the delivery code is a bearer credential over the customer's cash,
 * and this mapping is the second of the two locks that keep it out of a response.
 */
function toCodDto(collection: CashCollectionReadModel): ShipmentDetailDto['cod'] {
    return {
        collectionId: collection._id.toString(),
        status: collection.status,
        expectedAmount: collection.expected_amount,
        currency: collection.currency ?? null,
        collectedAt: toIso(collection.collected_at),
        verificationMethod: collection.verification?.method ?? null,
        codeAttempts: collection.code_attempts ?? 0,
        codeLocked: collection.code_locked ?? false,
        settledAmount: collection.settled_amount ?? null,
        settledAt: toIso(collection.settled_at),
    };
}

export function toShipmentOfferDto(
    offer: ShipmentOfferReadModel,
    agentNames: Map<string, string | null>,
): ShipmentOfferDto {
    const agentId = offer.agent_id.toString();
    return {
        id: offer._id.toString(),
        agentId,
        agentName: agentNames.get(agentId) ?? null,
        status: offer.status,
        origin: offer.origin ?? null,
        round: offer.round ?? null,
        sessionId: offer.session_id ? offer.session_id.toString() : null,
        createdBy: offer.created_by
            ? {
                role: offer.created_by.role ?? null,
                userId: offer.created_by.user_id ? offer.created_by.user_id.toString() : null,
                // The snapshot that makes an `admin`-created offer legible: that user id
                // resolves in no jovi-mall collection.
                name: offer.created_by.name ?? null,
            }
            : null,
        expiresAt: toIso(offer.expires_at),
        respondedAt: toIso(offer.responded_at),
        rejectionReason: offer.rejection_reason ?? null,
        createdAt: toIso(offer.created_at),
    };
}
