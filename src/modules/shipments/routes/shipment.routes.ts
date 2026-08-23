import { Router } from 'express';
import { defineRoute, permission, records } from '../../../api/route-manifest';
import { ShipmentController } from '../controllers/shipment.controller';
import {
    CancelShipmentSchema,
    ListShipmentActivityQuerySchema,
    ReassignShipmentSchema,
    SearchShipmentsQuerySchema,
    ShipmentIdParamSchema,
    TrackingEventsQuerySchema,
    TrackingTrailQuerySchema,
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

/**
 * ═══ The geo-tracker DATA door, shipment half (Phase 6.I · ADR-020) ════════════
 *
 * These are shipment-scoped because geo-tracker's scope model is: there is no endpoint on
 * that door that takes an agent id and answers with a trail, so "where has this person been
 * this week" is not a question any permission here can produce. The URL states the bound.
 *
 * `shipments.tracking.read`, in the shipments family — NOT the agents-family permission
 * that governs the live-position read. The two halves of this door are different
 * exposures: live surveillance of a person, versus a case file about a delivery. Keeping
 * them apart lets an operator grant one without the other, which is also how geo-tracker's
 * own scope model separates `agent:position` from `shipment:trail`.
 *
 * Deliberately NOT paired with `shipments.read`, unlike `/:shipmentId/offers` which names
 * `agents.read` beside it — that pattern states a CROSS-FAMILY dependency. Every tier
 * holding one of these holds the other, so naming both here would be noise.
 */

/**
 * ⚠ An audited READ. Every point on this trail is where a person actually was, so the
 * audit row commits BEFORE the read and its failure is not caught — see
 * `agents/domain/tracking-disclosure.ts`. `?reason=` is required.
 *
 * The row records the SHAPE of what was disclosed (points, sessions, `agentIds`,
 * `truncated`) and never the coordinates: putting them there would move a person's
 * movements into the one store readable without the permission gating them.
 */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/:shipmentId/tracking-trail',
    access: permission('shipments.tracking.read'),
    validate: { params: ShipmentIdParamSchema, query: TrackingTrailQuerySchema },
    audit: records('shipments.tracking.trail.read'),
    handler: ShipmentController.trackingTrail,
});

/** No coordinates: state transitions and the connection log. No reason, no audit row. */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/:shipmentId/tracking-events',
    access: permission('shipments.tracking.read'),
    validate: { params: ShipmentIdParamSchema, query: TrackingEventsQuerySchema },
    handler: ShipmentController.trackingEvents,
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
