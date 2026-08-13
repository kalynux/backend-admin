import { platformRequest } from '../../../infra/platform/platform.client';
import { auditedAttempt } from '../../audit/domain/audit.writer';
import { ActorContext } from '../../audit/domain/audit-context';
import { AuditAction } from '../../audit/domain/audit.catalog';

/**
 * The shipment domain's WRITE half, reached over jovi-mall's internal admin API.
 *
 * ── Why a shipment write can only be delegated ────────────────────────────────
 * This is the domain where a second writer would be most obviously wrong, because the
 * consequences leave the database entirely.
 *
 * A reassignment detaches the current agent under a compare-and-set, opens a handover
 * record, re-offers the shipment to a replacement through the assignment ranking, returns
 * the old agent's capacity, re-opens the COD collection with a fresh delivery code when the
 * shipment was `returned` — and emits a `shipment.agent_released` outbox row that is **what
 * closes the old agent's live tracking session in geo-tracker**. Move the `agent_id` from
 * here and the row is right, the session stays open, and a person who is no longer
 * delivering keeps being watched.
 *
 * A cancellation (jovi-mall's `reject`) puts every order item back at
 * `pending_agency_reassignment`, cancels standing offers, releases capacity and notifies
 * the vendor.
 *
 * ── What is NOT here ──────────────────────────────────────────────────────────
 * No status transition. The declared permissions are read, reassign and cancel; driving
 * the delivery lifecycle is the agent's and the agency's. An admin transition would also
 * need a third member on jovi-mall's `ShipmentStatusActor` carrying neither an `agencyId`
 * nor an `agentId` — which would strip both ownership predicates out of the compare-and-set
 * filter that makes two actors on one shipment safe in the first place.
 */

export type ShipmentSnapshot = Record<string, unknown> | null;

/** Wrap a delegated shipment mutation in an audit intent. See `order.gateway.ts`. */
function auditedDelegation<T>(
    action: AuditAction,
    context: ActorContext,
    target: { id: string; label: string | null },
    payload: Record<string, unknown> | null,
    before: ShipmentSnapshot,
    perform: () => Promise<T>,
): Promise<T> {
    return auditedAttempt(
        {
            action,
            actor: {
                kind: 'administrator',
                id: context.actor.adminId,
                email: context.actor.email,
                displayName: context.actor.displayName,
                tier: context.actor.tier,
                sessionId: context.actor.sessionId,
            },
            target: { type: 'shipment', id: target.id, label: target.label },
            context: {
                method: context.method,
                path: context.path,
                requestId: context.requestId,
                ip: context.ip,
                userAgent: context.userAgent,
            },
            payload,
        },
        async () => {
            const result = await perform();
            return { result, before, after: asState(result) };
        },
    );
}

/**
 * Reduce jovi-mall's answer to the fields worth diffing.
 *
 * `reassignedFrom` and `previousStatus` are the two that matter most, because **nothing
 * else will ever hold them**: the shipment document after a reassignment no longer carries
 * the old agent's id, and the `before`/`after` pair on this row is the only record of who
 * was taken off a delivery and what state it was in when they were.
 */
function asState(result: unknown): Record<string, unknown> | null {
    if (!result || typeof result !== 'object') return null;
    const value = result as Partial<PlatformReassignResult> & Partial<PlatformShipment>;
    const state: Record<string, unknown> = {};

    if (value.status !== undefined) state.status = value.status ?? null;
    if (value.agentId !== undefined) state.agentId = value.agentId ?? null;
    if (value.assignmentState !== undefined) state.assignmentState = value.assignmentState ?? null;
    if (value.reassignedFrom !== undefined) state.reassignedFrom = value.reassignedFrom ?? null;
    if (value.previousStatus !== undefined) state.previousStatus = value.previousStatus ?? null;
    if (value.autoAccepted !== undefined) state.autoAccepted = value.autoAccepted ?? null;
    if (value.offerId !== undefined) state.offerId = value.offerId ?? null;

    return Object.keys(state).length > 0 ? state : null;
}

/** How an administrator recognises a shipment: its tracking number. */
function labelOf(before: ShipmentSnapshot): string | null {
    const value = before?.trackingNumber;
    return typeof value === 'string' ? value : null;
}

export interface PlatformShipment {
    id?: string;
    status?: string;
    agentId?: string | null;
    agencyId?: string | null;
    assignmentState?: string | null;
    trackingNumber?: string | null;
}

export interface PlatformReassignResult extends PlatformShipment {
    /** The agent taken OFF the shipment. Nothing else records this. */
    reassignedFrom?: string;
    previousStatus?: string;
    offerId?: string | null;
    autoAccepted?: boolean;
    pickupLocation?: Record<string, unknown> | null;
}

/**
 * Move a shipment to a different agent.
 *
 * jovi-mall resolves the owning agency from the shipment itself and then runs the ordinary
 * agency-scoped path, so every guard applies unchanged: `REASSIGNABLE_STATUSES`, the
 * post-pickup manual-agent requirement (`SHIPMENT_REASSIGN_REQUIRES_MANUAL_AGENT`, 422),
 * the same-agent refusal, the replacement's eligibility and contract-coverage checks, the
 * settled-order guard, and the `claimForReassignment` compare-and-set whose miss is
 * **409 `SHIPMENT_REASSIGNMENT_CONFLICT`**. Each of those codes reaches the dashboard
 * unchanged, in `details.platformCode`.
 */
export async function reassign(
    shipmentId: string,
    input: { agentId?: string; reason: string; pickupLocation?: Record<string, unknown> },
    before: ShipmentSnapshot,
    context: ActorContext,
): Promise<PlatformReassignResult> {
    return auditedDelegation(
        'shipments.reassign',
        context,
        { id: shipmentId, label: labelOf(before) },
        {
            agentId: input.agentId ?? null,
            reason: input.reason,
            pickupOverridden: Boolean(input.pickupLocation),
        },
        before,
        async () => {
            const result = await platformRequest<PlatformReassignResult>({
                method: 'POST',
                path: `/shipments/${shipmentId}/reassign`,
                body: input,
                actor: context.actor,
                requestId: context.requestId,
            });
            return result.data;
        },
    );
}

/**
 * Cancel a shipment and put its items back for re-routing.
 *
 * Maps to jovi-mall's `ShipmentService.reject`, which refuses anything but `assigned` with
 * **422 `SHIPMENT_REJECTION_NOT_ALLOWED`**. That refusal is inherited rather than widened:
 * a picked-up shipment is physically with an agent, and the domain's answer there is a
 * reassignment or a return. A concurrent transition is **409 `SHIPMENT_STATUS_CONFLICT`**,
 * from the compare-and-set added to that path in the same change.
 */
export async function cancel(
    shipmentId: string,
    input: { reason: string; note: string },
    before: ShipmentSnapshot,
    context: ActorContext,
): Promise<PlatformShipment> {
    return auditedDelegation(
        'shipments.cancel',
        context,
        { id: shipmentId, label: labelOf(before) },
        { reason: input.reason, note: input.note },
        before,
        async () => {
            const result = await platformRequest<PlatformShipment>({
                method: 'POST',
                path: `/shipments/${shipmentId}/cancel`,
                body: input,
                actor: context.actor,
                requestId: context.requestId,
            });
            return result.data;
        },
    );
}
