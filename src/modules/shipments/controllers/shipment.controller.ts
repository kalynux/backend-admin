import { Request, Response } from 'express';
import { actorContextOf } from '../../audit/domain/audit-context';
import { ObjectId } from 'mongodb';
import { asyncHandler } from '../../../core/http/async-handler';
import { createAppError } from '../../../core/errors/app-error';
import { ERROR_CODES } from '../../../core/errors/error-codes';
import { toPageMeta } from '../../../core/http/list-query';
import { sendPaginated, sendSuccess } from '../../../core/http/responses';
import { requireAdminIdentity } from '../../admin-identity/domain/admin-identity.types';
import { toAuditEntryDto } from '../../audit/domain/audit.dto';
import { AuditRepository } from '../../audit/repositories/audit.repository';
import { ListAuditQuery } from '../../audit/validators/audit.validator';
import { AgentReadRepository } from '../../agents/repositories/agent.read.repository';
import { AgencyReadRepository } from '../../agencies/repositories/agency.read.repository';
import { readShipmentEvents } from '../../../infra/geo/geo-tracker-data.client';
/**
 * Both live-tracking helpers come from the AGENTS module, and the direction is deliberate:
 * one permission (`agents.tracking.read`), one credential and one decision govern all four
 * reads on that door, so the policy lives in one file rather than half here. A shipment is
 * a *scope* on an agent's movements, not a separate subject. Same direction
 * `agent.routes.ts` already imports an agencies validator.
 */
import { discloseShipmentTrail, readNonDisclosing } from '../../agents/domain/tracking-disclosure';
import * as gateway from '../gateways/shipment.gateway';
import {
    ShipmentReadModel,
    ShipmentReadRepository,
    ShipmentSearchResolution,
} from '../repositories/shipment.read.repository';
import {
    CashCollectionReadRepository,
    ShipmentOfferReadRepository,
    ShipmentOrderRefReadRepository,
    TrackingOutboxReadRepository,
} from '../repositories/shipment-context.read.repository';
/**
 * Two reads from the VENDORS module, for the same reason the agency and agent name lookups
 * come from theirs: the module that owns the collection owns the read. `stores` answers what
 * a vendor is CALLED (their business name lives there, not on the vendor row), and the media
 * repository answers what a parcel's contents look like — the same resolution the order
 * detail uses, so the two screens cannot show different pictures of one shipment.
 */
import {
    ProductImageRef,
    ProductMediaReadRepository,
} from '../../vendors/repositories/product-media.read.repository';
import { StoreReadRepository } from '../../vendors/repositories/store.read.repository';
import {
    ShipmentNames,
    toShipmentDetailDto,
    toShipmentListItemDto,
    toShipmentOfferDto,
} from '../read-models/shipment.dto';
import {
    CancelShipmentBody,
    ListShipmentActivityQuery,
    ReassignShipmentBody,
    ShipmentSearchQuery,
    TrackingEventsQuery,
    TrackingTrailQuery,
} from '../validators/shipment.validator';

const shipments = new ShipmentReadRepository();
const offers = new ShipmentOfferReadRepository();
const cashCollections = new CashCollectionReadRepository();
const outbox = new TrackingOutboxReadRepository();
const orderRefs = new ShipmentOrderRefReadRepository();
const agents = new AgentReadRepository();
const agencies = new AgencyReadRepository();
const stores = new StoreReadRepository();
const productMedia = new ProductMediaReadRepository();
const audit = new AuditRepository();

async function loadOr404(shipmentId: string): Promise<ShipmentReadModel> {
    const shipment = await shipments.findById(shipmentId);
    if (!shipment) throw createAppError(ERROR_CODES.NOT_FOUND, 404, 'Shipment not found');
    return shipment;
}

/** The audit `before` — the fields this surface can change, and how to recognise the row. */
function toAuditState(shipment: ShipmentReadModel): Record<string, unknown> {
    return {
        trackingNumber: shipment.tracking_number ?? null,
        status: shipment.status,
        agentId: shipment.agent_id ? shipment.agent_id.toString() : null,
        agencyId: shipment.agency_id.toString(),
        assignmentState: shipment.assignment?.state ?? null,
    };
}

/**
 * Agency, agent and order references for a page of shipments — three batched reads.
 *
 * The agency and agent name lookups live on Phase 9's own repositories rather than here.
 * `delivery_agents` holds `legal_identity`, `payout_details` and device telemetry, so a
 * second projection of it declared in this module would be a second thing to get right;
 * the module that owns the collection owns the read.
 */
async function hydrateNames(page: ShipmentReadModel[]): Promise<ShipmentNames> {
    const toIds = (values: (string | null)[]) =>
        [...new Set(values.filter((v): v is string => Boolean(v)))].map((id) => new ObjectId(id));

    const agencyIds = toIds(page.map((s) => s.agency_id.toString()));
    const agentIds = toIds(page.map((s) => (s.agent_id ? s.agent_id.toString() : null)));
    const orderIds = toIds(page.map((s) => s.order_id.toString()));

    const [agency, agent, order] = await Promise.all([
        agencies.findNamesByIds(agencyIds),
        agents.findNamesByIds(agentIds),
        orderRefs.findRefsByIds(orderIds),
    ]);

    return { agency, agent, order };
}

export class ShipmentController {
    /**
     * GET /api/v1/shipments — search and filter every shipment on the platform.
     *
     * This is the first query against this collection with neither an agency nor an agent
     * scope, which is why `shipment.model.ts` gained `{created_at: -1}` and
     * `{status: 1, created_at: -1}` in the same change.
     *
     * `isCod` is deliberately not a filter: it is a property of the ORDER, and offering it
     * would require a `$lookup` before the `$sort`, which loses the index and the `_id`
     * paging tiebreaker. Filter orders instead.
     */
    static search = asyncHandler(async (req: Request, res: Response) => {
        const query = req.query as unknown as ShipmentSearchQuery;

        let resolution: ShipmentSearchResolution = { orderIds: [], truncated: false };
        if (query.search) {
            const match = await orderRefs.findIdsMatching(query.search);
            resolution = { orderIds: match.ids, truncated: match.truncated };
        }

        const page = await shipments.search(query, resolution);
        const names = await hydrateNames(page.items);

        sendPaginated(
            res,
            page.items.map((shipment) => toShipmentListItemDto(shipment, names)),
            {
                ...toPageMeta(page.total, page.page, page.limit),
                ...(resolution.truncated ? { searchMatchesTruncated: true } : {}),
            },
        );
    });

    /**
     * GET /api/v1/shipments/:shipmentId
     *
     * The screen that answers "why is this delivery stuck": the status and its history, the
     * assignment state and who has been asked, the handover, the failure attempts, the cash
     * position, and whether this shipment's news actually reached geo-tracker.
     *
     * ── What the parcel actually CONTAINS (BR-016 § 6, BR-017 B) ──────────────
     * A shipment item is the thinnest row on the platform, and this is the screen an
     * operator opens mid-dispute — `6670…40 × 3` describes nothing. The line's title, price
     * and currency are joined from the ORDER's item snapshot on `orderItemId`, and its
     * picture from the same media resolution the order detail uses, so the two screens
     * cannot disagree about one parcel. The order card gains the vendor's business name for
     * the same reason: it carried a 24-hex `vendorId` and nothing else.
     *
     * The vendor lookup is the one read that cannot join the batch, because the vendor id
     * arrives on the order reference that `hydrateNames` is still resolving. One extra round
     * trip on one detail screen, in the same place the offer-agent names already take one.
     */
    static detail = asyncHandler(async (req: Request, res: Response) => {
        const shipment = await shipments.findDetailById(req.params.shipmentId);
        if (!shipment) throw createAppError(ERROR_CODES.NOT_FOUND, 404, 'Shipment not found');

        const orderId = shipment.order_id.toString();
        const imageRefs: ProductImageRef[] = (shipment.items ?? []).map((item) => ({
            productId: item.product_id ? item.product_id.toString() : null,
            variantId: item.variant_id ? item.variant_id.toString() : null,
        }));

        const [names, offerRows, cod, outboxHealth, itemSnapshots, images] = await Promise.all([
            hydrateNames([shipment]),
            offers.findForShipment(req.params.shipmentId),
            cashCollections.findForShipment(req.params.shipmentId),
            outbox.healthForShipment(req.params.shipmentId),
            orderRefs.findItemSnapshots(orderId),
            productMedia.primaryImages(imageRefs),
        ]);

        // The offers name agents the shipment itself never did — everyone who was asked and
        // said no. Their names are a second batched read on top of the page's.
        const offerAgentIds = [...new Set(offerRows.map((offer) => offer.agent_id.toString()))]
            .filter((id) => !names.agent.has(id))
            .map((id) => new ObjectId(id));
        if (offerAgentIds.length > 0) {
            const extra = await agents.findNamesByIds(offerAgentIds);
            extra.forEach((value, key) => names.agent.set(key, value));
        }

        const vendorId = names.order.get(orderId)?.vendorId ?? null;
        const vendorName = vendorId
            ? (await stores.findNamesByVendorIds([new ObjectId(vendorId)])).get(vendorId) ?? null
            : null;

        sendSuccess(
            res,
            toShipmentDetailDto(shipment, names, {
                offers: offerRows,
                cod,
                outbox: outboxHealth,
                vendorName,
                itemSnapshots,
                images,
            }),
        );
    });

    /**
     * GET /api/v1/shipments/:shipmentId/offers — everyone who was asked, in order.
     *
     * Requires `agents.read` as well: the rows name agents, and a surface gated on
     * `shipments.read` alone would be a second door onto the agent directory. Both tiers
     * that hold either hold both, so it costs nobody access.
     */
    static offers = asyncHandler(async (req: Request, res: Response) => {
        await loadOr404(req.params.shipmentId);

        const rows = await offers.findForShipment(req.params.shipmentId);
        const agentIds = [...new Set(rows.map((offer) => offer.agent_id.toString()))]
            .map((id) => new ObjectId(id));
        const names = await agents.findNamesByIds(agentIds);

        sendSuccess(res, rows.map((offer) => toShipmentOfferDto(offer, names)));
    });

    /**
     * GET /api/v1/shipments/:shipmentId/tracking-trail?reason=… — this delivery's GPS trail.
     *
     * ── The route is shipment-scoped because the SCOPE MODEL is ───────────────
     * geo-tracker has no endpoint that takes an agent id and answers with a trail, and that
     * absence is the strongest bound in ADR-020's design: it turns a surveillance
     * credential into a case-file one. "Where has this person been this week" is not a
     * question any permission in this service can produce. The URL says so.
     *
     * **A reassigned delivery returns MORE THAN ONE session**, one per agent who carried
     * it, with their checkpoints merged into a single trail newest-first. A session that
     * ended `shipment_released` with no `terminalStatus` is an agent who left the delivery
     * rather than finishing it.
     *
     * **`truncated` is not cosmetic.** A partial trail that does not announce itself is
     * indistinguishable from a gap in the record, and the record is what a delivery dispute
     * is argued from. Never render one as complete.
     *
     * Audited, fail-closed, before the read — see `agents/domain/tracking-disclosure.ts`.
     */
    static trackingTrail = asyncHandler(async (req: Request, res: Response) => {
        const query = req.query as unknown as TrackingTrailQuery;
        const shipment = await loadOr404(req.params.shipmentId);

        sendSuccess(
            res,
            await discloseShipmentTrail(
                req.params.shipmentId,
                shipment.tracking_number ?? null,
                { reason: query.reason },
                actorContextOf(req),
                query.limit,
            ),
        );
    });

    /**
     * GET /api/v1/shipments/:shipmentId/tracking-events — the delivery's tracking events.
     *
     * State transitions and the connection log: when tracking went online, degraded, lost
     * the network, reconnected. **No coordinates**, so no reason and no audit row — the
     * same line the whole door is drawn on.
     *
     * Several `connections` rows on one session mean one delivery whose agent's phone
     * dropped and came back, not several deliveries. Unlike the trail, these rows are
     * permanent in geo-tracker and are never pruned, so an old delivery still answers.
     */
    static trackingEvents = asyncHandler(async (req: Request, res: Response) => {
        const query = req.query as unknown as TrackingEventsQuery;
        await loadOr404(req.params.shipmentId);
        const context = actorContextOf(req);

        sendSuccess(
            res,
            readNonDisclosing(
                await readShipmentEvents(
                    req.params.shipmentId,
                    { actor: context.actor.adminId, reason: 'events' },
                    query.limit,
                ),
            ),
        );
    });

    /** GET /api/v1/shipments/:shipmentId/activity — what administrators did to this shipment. */
    static activity = asyncHandler(async (req: Request, res: Response) => {
        const identity = requireAdminIdentity(req);
        const query = req.query as unknown as ListShipmentActivityQuery;

        await loadOr404(req.params.shipmentId);

        const page = await audit.search(
            {
                page: query.page,
                limit: query.limit,
                sort: query.sort,
                action: query.action,
                status: query.status,
                from: query.from,
                to: query.to,
                targetType: 'shipment',
                targetId: req.params.shipmentId,
            } as ListAuditQuery,
            identity,
        );

        sendPaginated(res, page.items.map(toAuditEntryDto), page.meta);
    });

    /** POST /api/v1/shipments/:shipmentId/reassign */
    static reassign = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as ReassignShipmentBody;
        const shipment = await loadOr404(req.params.shipmentId);

        const result = await gateway.reassign(
            req.params.shipmentId,
            { agentId: body.agentId, reason: body.reason, pickupLocation: body.pickupLocation },
            toAuditState(shipment),
            actorContextOf(req),
        );

        sendSuccess(res, result, { message: 'Shipment reassigned' });
    });

    /**
     * POST /api/v1/shipments/:shipmentId/cancel
     *
     * Applies to a shipment at `assigned` — dispatched to an agency, not yet picked up.
     * Past that, jovi-mall answers 422 and the domain's answer is a reassignment or a
     * return; that refusal is inherited deliberately rather than widened here.
     */
    static cancel = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as CancelShipmentBody;
        const shipment = await loadOr404(req.params.shipmentId);

        const result = await gateway.cancel(
            req.params.shipmentId,
            { reason: body.reason, note: body.note },
            toAuditState(shipment),
            actorContextOf(req),
        );

        sendSuccess(res, result, { message: 'Shipment cancelled and returned for re-routing' });
    });
}
