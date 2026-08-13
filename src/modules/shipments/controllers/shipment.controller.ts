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
} from '../validators/shipment.validator';

const shipments = new ShipmentReadRepository();
const offers = new ShipmentOfferReadRepository();
const cashCollections = new CashCollectionReadRepository();
const outbox = new TrackingOutboxReadRepository();
const orderRefs = new ShipmentOrderRefReadRepository();
const agents = new AgentReadRepository();
const agencies = new AgencyReadRepository();
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
     */
    static detail = asyncHandler(async (req: Request, res: Response) => {
        const shipment = await shipments.findDetailById(req.params.shipmentId);
        if (!shipment) throw createAppError(ERROR_CODES.NOT_FOUND, 404, 'Shipment not found');

        const [names, offerRows, cod, outboxHealth] = await Promise.all([
            hydrateNames([shipment]),
            offers.findForShipment(req.params.shipmentId),
            cashCollections.findForShipment(req.params.shipmentId),
            outbox.healthForShipment(req.params.shipmentId),
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

        sendSuccess(
            res,
            toShipmentDetailDto(shipment, names, { offers: offerRows, cod, outbox: outboxHealth }),
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
