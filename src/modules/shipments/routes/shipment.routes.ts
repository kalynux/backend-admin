import { Router } from 'express';
import { defineRoute, permission, records } from '../../../api/route-manifest';
import { ShipmentController } from '../controllers/shipment.controller';
import {
    CancelShipmentSchema,
    ListShipmentActivityQuerySchema,
    ReassignShipmentSchema,
    SearchShipmentsQuerySchema,
    ShipmentIdParamSchema,
} from '../validators/shipment.validator';

/**
 * `/api/v1/shipments` — delivery-shipment administration.
 *
 * Entirely net-new. PHASE-0 found **no admin shipment surface anywhere**: no
 * `/api/admin/shipments*` route in jovi-mall, no admin controller importing
 * `ShipmentService`, and no `api-doc/admin/shipments.md`. An administrator investigating a
 * stalled delivery could see the order and the agency and nothing in between. So unlike
 * every other domain in this service, nothing here retires a legacy endpoint — there was
 * none to retire.
 *
 * ── Read directly, write by delegation ────────────────────────────────────────
 * The list, the detail, the offer history and the activity feed are direct reads. The two
 * writes are delegated, and this is the domain where that matters most: a reassignment
 * emits the outbox row that **closes the old agent's live tracking session in
 * geo-tracker**. A second writer would move `agent_id` correctly and leave a person who is
 * no longer delivering being watched.
 *
 * ── What is deliberately not offered ──────────────────────────────────────────
 * **No status transition.** The declared permissions are read, reassign and cancel, and
 * driving a delivery through `picked_up → in_transit → delivered` is the agent's job and
 * the agency desk's. An admin transition would also need a third actor on jovi-mall's
 * `ShipmentStatusActor` carrying neither an `agencyId` nor an `agentId`, which would strip
 * both ownership predicates out of the compare-and-set filter that makes two actors on one
 * shipment safe.
 *
 * **`cancel` reaches only `assigned`.** It maps to jovi-mall's `reject`, which refuses
 * anything past pickup, and that refusal is inherited rather than widened: a picked-up
 * parcel is physically with somebody, and the domain's answer is a reassignment or a
 * return. The dashboard should disable the button outside `assigned` — the 422 carries
 * `details.status`.
 *
 * ── Route order ───────────────────────────────────────────────────────────────
 * Every sub-route sits under a distinct second segment beneath `/:shipmentId`, so Express
 * matches them without ambiguity. A future LITERAL sibling of `/:shipmentId` MUST be
 * declared above it, or it is read as an id.
 */
const router = Router();
const mountedAt = '/shipments';

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/',
    access: permission('shipments.read'),
    validate: { query: SearchShipmentsQuerySchema },
    handler: ShipmentController.search,
});

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/:shipmentId',
    access: permission('shipments.read'),
    validate: { params: ShipmentIdParamSchema },
    handler: ShipmentController.detail,
});

/**
 * Two permissions, `all` mode. These rows name agents, their round and their refusal
 * reasons — a surface gated on `shipments.read` alone would be a second door onto the agent
 * directory. Same rule as `/agencies/:agencyId/agents`.
 */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/:shipmentId/offers',
    access: permission('shipments.read', 'agents.read'),
    validate: { params: ShipmentIdParamSchema },
    handler: ShipmentController.offers,
});

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/:shipmentId/activity',
    access: permission('shipments.read', 'audit.read'),
    validate: { params: ShipmentIdParamSchema, query: ListShipmentActivityQuerySchema },
    handler: ShipmentController.activity,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/:shipmentId/reassign',
    access: permission('shipments.reassign'),
    validate: { params: ShipmentIdParamSchema, body: ReassignShipmentSchema },
    audit: records('shipments.reassign'),
    handler: ShipmentController.reassign,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/:shipmentId/cancel',
    access: permission('shipments.cancel'),
    validate: { params: ShipmentIdParamSchema, body: CancelShipmentSchema },
    audit: records('shipments.cancel'),
    handler: ShipmentController.cancel,
});

export const shipmentRoutes = router;
