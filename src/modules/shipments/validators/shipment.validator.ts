import { z } from 'zod';
import { listQuery } from '../../../core/http/list-query';
import {
    boolFlag,
    dateRangeFields,
    dateRangeRule,
    idParam,
    objectId,
    reasonText,
    searchTerm,
} from '../../../core/validation/common.schemas';
import { AUDIT_ACTION_NAMES, AuditAction } from '../../audit/domain/audit.catalog';
import { AUDIT_STATUSES } from '../../audit/domain/audit.types';
import { platformStatus } from '../../orders/validators/order.validator';

/** Request shapes for `/api/v1/shipments`. */

export const ShipmentIdParamSchema = idParam('shipmentId', 'shipment');

/**
 * jovi-mall's shipment status vocabulary — for documentation and DTO typing ONLY.
 *
 * Deliberately not fed to `z.enum`. ADR-005 D-17 names shipment statuses as the canonical
 * case for a bounded string: the enum is a **cross-service contract**, duplicated in
 * geo-tracker's Go, and jovi-mall extends it without asking (`handing_over` was added for
 * post-pickup reassignment). Pinning it here means the day a tenth status ships, this
 * service starts 400-ing filters for a status the platform is actively writing.
 */
export const SHIPMENT_STATUSES = [
    'pending', 'assigned', 'handing_over', 'picked_up', 'in_transit',
    'agent_delivered', 'delivered', 'failed', 'returned', 'rejected',
    'pending_agency_reassignment',
] as const;

/** The assignment mirror on the shipment — NOT the status. */
export const SHIPMENT_ASSIGNMENT_STATES = ['unassigned', 'offered', 'accepted'] as const;

/**
 * What the shipment list may be ordered by: **wire name → `jovi_mall` field path**.
 *
 * Backed by `{created_at: -1}` and `{status: 1, created_at: -1}`, added to
 * `shipment.model.ts` in the same change. `updated_at` is deliberately absent — every
 * sortable field costs an index on a hot write collection, and nothing has asked for it.
 */
export const SHIPMENT_SORT = { createdAt: 'created_at' } as const;

export const SHIPMENT_ACTIVITY_SORT = { occurredAt: 'occurred_at' } as const;

export const SHIPMENT_MAX_RANGE_DAYS = 366;

export const SearchShipmentsQuerySchema = listQuery(SHIPMENT_SORT, '-createdAt', {
    /** Tracking-number prefix, or a 24-hex id of a shipment, order, agent or agency. */
    search: searchTerm.optional(),
    status: platformStatus.optional(),
    agencyId: objectId.optional(),
    agentId: objectId.optional(),
    orderId: objectId.optional(),
    /**
     * Bounded string like `status`, although this one IS a closed three-value set. The two
     * come off the same document and a reader should not have to remember which of them is
     * safe to pin; consistency is worth more here than the marginal validation.
     */
    assignmentState: platformStatus.optional(),
    /** No agent bound yet — out on offer, or never offered. */
    unassigned: boolFlag.optional(),
    /** Frozen by the agency-deactivation cascade (`hold` set). */
    held: boolFlag.optional(),
    ...dateRangeFields(),
}).superRefine(dateRangeRule({ maxDays: SHIPMENT_MAX_RANGE_DAYS }));

export const SHIPMENT_AUDIT_ACTIONS = AUDIT_ACTION_NAMES.filter(
    (action) => action.startsWith('shipments.'),
) as [AuditAction, ...AuditAction[]];

export const ListShipmentActivityQuerySchema = listQuery(SHIPMENT_ACTIVITY_SORT, '-occurredAt', {
    action: z.enum(SHIPMENT_AUDIT_ACTIONS).optional(),
    status: z.enum(AUDIT_STATUSES).optional(),
    ...dateRangeFields(),
}).superRefine(dateRangeRule({ maxDays: SHIPMENT_MAX_RANGE_DAYS }));

/**
 * Where a replacement agent collects, when the platform overrides the derived point.
 *
 * Passed through to jovi-mall's `HandoverPickupService`, which owns the shape and the
 * rules — this is a shape check, not a domain one. Loose on purpose: a stricter copy here
 * would be a second definition of a handover location.
 */
const ReassignPickupLocationSchema = z.object({
    label: z.string().trim().max(200).optional(),
    note: z.string().trim().max(500).optional(),
    coordinates: z.tuple([z.number(), z.number()]).optional(),
    address: z.record(z.unknown()).optional(),
}).strict();

export const ReassignShipmentSchema = z.object({
    /**
     * Optional. Omitted pre-pickup means auto-assign down a fresh ranking; jovi-mall
     * refuses `SHIPMENT_REASSIGN_REQUIRES_MANUAL_AGENT` past pickup.
     *
     * **Deliberately not pre-checked here.** `POST_PICKUP_REASSIGN_STATUSES` is the
     * assignment service's rule, and a copy of it in this validator is a copy that drifts
     * the day jovi-mall adds a status to it — the exact failure D-17 exists to prevent, one
     * layer up. Validate shape; let the domain answer the domain question.
     */
    agentId: objectId.optional(),
    reason: reasonText('A reason is required to reassign a shipment'),
    pickupLocation: ReassignPickupLocationSchema.optional(),
}).strict();

export const CancelShipmentSchema = z.object({
    /**
     * jovi-mall's `ShipmentRejectionReason`, defaulted to the one an administrator owns.
     *
     * Bounded string rather than a pinned enum for the same reason as `status`: the set is
     * jovi-mall's, and its own validator rejects an unknown member with the right code and
     * the right message. Defaulting it means the common case — "the platform is pulling
     * this shipment" — needs no vocabulary lesson.
     */
    reason: platformStatus.default('platform_intervention'),
    /**
     * REQUIRED here where the agency's equivalent is optional.
     *
     * Same argument as `vendors.kyc.reject`: jovi-mall stores it on the shipment, and it
     * has to, because wi-admin's audit trail lives in a database jovi-mall cannot read —
     * the vendor whose delivery just vanished has to be able to be told why by the service
     * that holds their data.
     */
    note: reasonText('A note is required to cancel a shipment', { min: 3, max: 200 }),
}).strict();

export type ShipmentSearchQuery = z.infer<typeof SearchShipmentsQuerySchema>;
export type ListShipmentActivityQuery = z.infer<typeof ListShipmentActivityQuerySchema>;
export type ReassignShipmentBody = z.infer<typeof ReassignShipmentSchema>;
export type CancelShipmentBody = z.infer<typeof CancelShipmentSchema>;

/**
 * The GPS-trail read (Phase 6.I · ADR-020).
 *
 * `reason` is the purpose axis of geo-tracker's scope model and is required — see the note
 * on `TrackingReadQuerySchema` in `agents/validators/agent.validator.ts`, which this
 * mirrors deliberately rather than sharing: the two live in the modules whose routes carry
 * them, and a shared schema would put the rule in neither.
 *
 * `limit` is bounded here at geo-tracker's own ceiling. It ignores an out-of-range value in
 * favour of its default, so a 400 from this side is the more useful answer: a caller asking
 * for 50,000 points wants to know they will not get them, rather than silently receiving
 * 1,000 and believing it is the whole trail.
 */
export const TrackingTrailQuerySchema = z.object({
    reason: reasonText('Say why this trail is being read — it is recorded in the audit trail', { max: 200 }),
    limit: z.coerce.number().int().positive().max(5000).optional(),
}).strict();

/** Tracking events carry no coordinates: no reason, and `limit` at geo-tracker's ceiling. */
export const TrackingEventsQuerySchema = z.object({
    limit: z.coerce.number().int().positive().max(1000).optional(),
}).strict();

export type TrackingTrailQuery = z.infer<typeof TrackingTrailQuerySchema>;
export type TrackingEventsQuery = z.infer<typeof TrackingEventsQuerySchema>;
