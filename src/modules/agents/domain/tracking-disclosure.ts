import { createAppError } from '../../../core/errors/app-error';
import { ERROR_CODES } from '../../../core/errors/error-codes';
import {
    GeoAgentPosition,
    GeoDataResult,
    GeoShipmentTrail,
    isGeoTrackerDataConfigured,
    readAgentPosition,
    readShipmentTrail,
} from '../../../infra/geo/geo-tracker-data.client';
import { ActorContext, auditActorOf } from '../../audit/domain/audit-context';
import { AuditIntent } from '../../audit/domain/audit.types';
import { auditedAttempt } from '../../audit/domain/audit.writer';

/**
 * Disclosing where a person is — the answer to Phase 6.I's **O-6**, written as code.
 *
 * ADR-020 D-2 left "is a live-position read audited?" explicitly *unanswered rather than
 * answered no*, because it is the one read in this corpus where an audit row on a READ is
 * genuinely arguable. It is answered here: **yes, audited — in wi-admin, fail-closed, and
 * not in geo-tracker.** See ADR-020 D-5 for the decision and its alternatives.
 *
 * ── Why a read is audited at all ──────────────────────────────────────────────
 * "Reads are not actions" holds everywhere else here, and for a good reason: a read leaves
 * no state behind to reconstruct, so the permission gate is the entire control and a row
 * per read would be volume with nothing to say. Two reads break that, in the same specific
 * way `money.payouts.destination.read` does — **the output is the disclosure.** A live
 * position and a delivery's minute-by-minute trail are a person's movements, read by an
 * administrator that person has no relationship with. For a disclosure, "who may" is not
 * the interesting question; "who did, and how often" is. An administrator who unmasks
 * forty positions in an afternoon is doing something other than answering tickets, and
 * nothing else in this service would ever see it.
 *
 * That is not an abstract worry here. `agents.tracking.read` is held by **tier 3
 * (Support)** — deliberately, because "where is my delivery right now" is the question a
 * ticket asks — and the audit is the other half of that decision. Widening the audience
 * and adding the record were one decision, not two.
 *
 * ── Why the audit is HERE and not in geo-tracker ──────────────────────────────
 * Three reasons, and the third is the one that settles it:
 *
 *  1. **This is where the actor is known.** geo-tracker authenticates a *service*, not a
 *     person. `X-Admin-Actor` reaches it and is advisory by construction — whoever holds
 *     the credential could set it — so a row written there would attribute a disclosure to
 *     an unverifiable string.
 *  2. **This is where the machinery is.** Retention, scoping, export and the activity
 *     feeds all exist here. geo-tracker would need all four built for one table.
 *  3. **`tracking_audit` must stay written by nothing.** That table (geo-tracker's
 *     `0001_init.sql`) has **no retention policy of any kind**, and its `viewer_id` column
 *     would hold a jovi-mall user id. The workspace CLAUDE.md states the consequence
 *     plainly: anything that starts writing it inherits two obligations in the same change
 *     — give it a retention policy, and reopen `ADR-B02-CLOSED-ACCOUNT-TRAIL`, which
 *     currently rests on geo-tracker storing **no** customer identity. Auditing the
 *     disclosure where the human is already known avoids buying that, for nothing gained.
 *
 * geo-tracker's half is corroboration rather than a trail: a log line per disclosure and
 * `geotracker_service_reads_total{scope,outcome}`. Two records that should agree.
 *
 * ── Why `auditedAttempt`, and why the ordering IS the design ──────────────────
 * `transport: 'external'`, not `'observation'`. `observation` (`recordEvent`) is
 * best-effort and swallows a write failure — right for a login, which already happened on
 * its own terms, and wrong here, where **the audit row IS the control**. `auditedAttempt`
 * commits the intent FIRST and does not catch it, so with the audit store unreachable the
 * disclosure simply never runs. Fail-closed is the only acceptable posture for a read that
 * emits a person's coordinates.
 *
 * A crash between the intent and the answer leaves a row at `attempted` — the dangling
 * intent ADR-002 D4-a calls "itself a useful signal". Read conservatively, that row means
 * the position may have been disclosed.
 *
 * ── What the row does NOT contain ─────────────────────────────────────────────
 * **No coordinates.** It records THAT a location was disclosed, the subject, and the
 * stated reason. Putting the values in would move a person's position into the one store
 * readable without the permission gating it, and the audit trail would become the leak —
 * the exact rule `payout-disclosure.ts` follows for account numbers.
 *
 * ── Why this file lives in the AGENTS module ──────────────────────────────────
 * Both disclosures are about an agent's movements; the shipment is a *scope* on the second
 * one, not its subject. They share one permission and one credential, and splitting them
 * across two modules would put half of a single policy where nobody looking for it would
 * read it. `shipment.controller.ts` imports the trail half, which is the same direction
 * `agent.routes.ts` already imports an agencies validator.
 */

/**
 * The reason an administrator gave, as it reaches geo-tracker and the audit row.
 *
 * Validated by the route schemas (3–200 characters); geo-tracker independently refuses a
 * coordinate read without one. Two checks on one rule is not redundancy here: this service
 * must not be able to make an unattributed disclosure even if a route is added without the
 * schema, and geo-tracker must not depend on a peer's validation for its own policy.
 */
export interface DisclosureRequest {
    reason: string;
}

/**
 * Turn the client's non-throwing result into this service's answer.
 *
 * The client never throws — that is what stops a geo-tracker outage from propagating
 * anywhere it was not expected. Failing the REQUEST is allowed and happens here, at the
 * boundary, which is the distinction ADR-020 D-2 constraint 4 draws: a data door may fail
 * a request, never the service.
 *
 * Three outcomes, three codes, because the remedies are three different people — an
 * operator's deployment, geo-tracker's scope configuration, and somebody's pager. A single
 * "tracking unavailable" makes all three look like an outage.
 */
function unwrap<T>(result: GeoDataResult<T>): T {
    if (result.data !== null && result.ok) return result.data;

    if (!result.configured) {
        throw createAppError(ERROR_CODES.TRACKING_DOOR_UNCONFIGURED, 503);
    }
    if (result.status !== null) {
        // geo-tracker answered and refused. Its code survives the hop — the two services
        // share one error envelope (ADR-016) — so the dashboard can say WHY.
        throw createAppError(ERROR_CODES.TRACKING_DOOR_REFUSED, 502, undefined, {
            upstreamCode: result.code,
            upstreamStatus: result.status,
        });
    }
    throw createAppError(ERROR_CODES.TRACKING_DOOR_UNAVAILABLE, 503);
}

/** Whether the door is wired at all — for a capability probe that must not audit. */
export function trackingDoorConfigured(): boolean {
    return isGeoTrackerDataConfigured();
}

/**
 * Reveal an agent's live position, and record that it was revealed.
 *
 * The order is load-bearing at every step:
 *
 *  1. commit the intent, and stop here if that fails;
 *  2. only now ask geo-tracker;
 *  3. stamp `after` with WHETHER coordinates actually came back — never with the
 *     coordinates. `withheld: 'tracking_allow_off'` is a real and common outcome (the
 *     agent has not granted Tracking Allow), and a row that could not distinguish "we
 *     showed them" from "we showed them nothing" would make the trail useless for the one
 *     question it exists to answer.
 *
 * Note there is no load-then-audit step, unlike the payout disclosure. That one reads the
 * payout masked first so a mistyped id never enters the trail as an attempted disclosure.
 * Here the caller has already loaded the agent (a 404 for an unknown id happens before
 * this runs), so the same property holds one layer up.
 */
export async function discloseAgentPosition(
    agentId: string,
    label: string | null,
    request: DisclosureRequest,
    context: ActorContext,
): Promise<GeoAgentPosition> {
    const intent: AuditIntent = {
        action: 'agents.tracking.position.read',
        actor: auditActorOf(context.actor),
        target: { type: 'agent', id: agentId, label },
        context,
        /**
         * The stated reason, and nothing that is not already in the target. This is the
         * field that turns "an administrator looked" into "an administrator looked, and
         * said why" — the whole difference between a log and a trail.
         */
        payload: { agentId, reason: request.reason },
    };

    return auditedAttempt(intent, async () => {
        const position = unwrap(
            await readAgentPosition(agentId, { actor: context.actor.adminId, reason: request.reason }),
        );

        return {
            result: position,
            after: {
                disclosed: position.position !== null,
                withheld: position.withheld ?? null,
                positionAgeSeconds: position.ageSeconds,
            },
        };
    });
}

/**
 * Reveal one delivery's GPS trail, and record that it was revealed.
 *
 * Shipment-scoped by construction, and that is geo-tracker's rule rather than this
 * service's: there is no route on that door that takes an agent id and answers with a
 * trail, so "where has this person been this week" is not a question any permission here
 * can produce. See `geo-tracker/api-doc/service-data-door.md` § The scope model.
 *
 * `after` records the SHAPE of what was disclosed — how many points, over how many
 * sessions, and whether the answer was truncated. A reassigned delivery legitimately
 * returns two sessions with two different agents, and a row that recorded only the
 * shipment would lose which people's movements were actually read; `agentIds` is
 * therefore part of the record, and it is the one place the trail names them.
 */
export async function discloseShipmentTrail(
    shipmentId: string,
    label: string | null,
    request: DisclosureRequest,
    context: ActorContext,
    limit?: number,
): Promise<GeoShipmentTrail> {
    const intent: AuditIntent = {
        action: 'shipments.tracking.trail.read',
        actor: auditActorOf(context.actor),
        target: { type: 'shipment', id: shipmentId, label },
        context,
        payload: { shipmentId, reason: request.reason, limit: limit ?? null },
    };

    return auditedAttempt(intent, async () => {
        const trail = unwrap(
            await readShipmentTrail(
                shipmentId,
                { actor: context.actor.adminId, reason: request.reason },
                limit,
            ),
        );

        return {
            result: trail,
            after: {
                checkpoints: trail.checkpoints.length,
                sessions: trail.sessions.length,
                agentIds: trail.sessions.map((session) => session.agentId),
                truncated: trail.truncated,
            },
        };
    });
}

/**
 * The two reads that carry no coordinates go through here instead: unwrapped, not audited.
 *
 * Presence and events emit device flags, session states and timestamps — operational
 * facts about a delivery, not a location. Auditing them would be the volume-with-nothing-
 * to-say that "reads are not actions" exists to avoid, and it would dilute the trail that
 * the two disclosures above depend on being sparse and meaningful.
 */
export function readNonDisclosing<T>(result: GeoDataResult<T>): T {
    return unwrap(result);
}
