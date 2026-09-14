import { Request, Response } from 'express';
import { ObjectId } from 'mongodb';
import { Types } from 'mongoose';
import { actorContextOf } from '../../audit/domain/audit-context';
import { asyncHandler } from '../../../core/http/async-handler';
import { createAppError } from '../../../core/errors/app-error';
import { ERROR_CODES } from '../../../core/errors/error-codes';
import { toPageMeta } from '../../../core/http/list-query';
import { sendPaginated, sendSuccess } from '../../../core/http/responses';
import { requireAdminIdentity } from '../../admin-identity/domain/admin-identity.types';
import { toAuditEntryDto } from '../../audit/domain/audit.dto';
import { AuditRepository } from '../../audit/repositories/audit.repository';
import { ListAuditQuery } from '../../audit/validators/audit.validator';
import {
    ContractEventReadRepository,
    distinctAgentIds,
} from '../../agencies/repositories/contract-event.read.repository';
import { ContractReadRepository } from '../../agencies/repositories/contract.read.repository';
import { AgencyReadRepository } from '../../agencies/repositories/agency.read.repository';
import { toAgentContractDto, toContractEventDto } from '../../agencies/read-models/contract.dto';
import { ListContractEventsQuery } from '../../agencies/validators/agency.validator';
import { allocationAgencyIds, toCodAllocationDto } from '../read-models/cod-allocation.dto';
import { readAgentPresence } from '../../../infra/geo/geo-tracker-data.client';
import { discloseAgentPosition, readNonDisclosing } from '../domain/tracking-disclosure';
import * as gateway from '../gateways/agent.gateway';
import { verificationRecord } from '../../verification/gateways/verification.gateway';
import { AgentReadModel, AgentReadRepository } from '../repositories/agent.read.repository';
import {
    BanAgentBody,
    AssignabilityQuery,
    EligibilityQuery,
    ListAgentActivityQuery,
    ListContractsQuery,
    ReviewAgentKycBody,
    SearchAgentsQuery,
    SetAgentStatusBody,
    SetThresholdBody,
    SetTrackingBody,
    TrackingReadQuery,
    TransferAgentBody,
} from '../validators/agent.validator';

/**
 * `/api/v1/agents` — delivery-agent administration.
 *
 * PHASE-0 called the legacy agent surface "the strongest in the codebase" — eleven
 * endpoints, reason-required on every negative action — with one hole: there was no LIST.
 * `GET /api/admin/agents/:agentId` existed and `GET /api/admin/agents` did not, so an
 * administrator could not find an agent they did not already have the id of.
 *
 * ── The four state axes stay four ─────────────────────────────────────────────
 * `status` (may this account work at all), `availability` (does the agent want work now),
 * `working_state` (how loaded are they), `tracking.allowed` (may they be tracked) — plus
 * `kyc.status` and `platform_ban`. The agent model keeps them apart because collapsing any
 * two makes "is he offline, or just full?" unanswerable, and this surface preserves that:
 * six independent filters, six independent fields on the DTO, six separate writes.
 *
 * A dashboard showing "suspended" must therefore render FOUR independent flags —
 * `users.status` (the account, which blocks authentication outright and does not cascade),
 * `status` here, `platform_ban.banned`, and each contract's own status. They mean different
 * things and reinstating one restores nothing about the others.
 *
 * ── What this surface deliberately does NOT offer ─────────────────────────────
 *  - **A live position.** See the tracking block on the DTO below.
 *  - **Editing contract terms.** A live contract's terms change by proposal between the
 *    two parties, never by edit — jovi-mall answers 409 to an edit — and an administrator
 *    imposing a fee split neither party proposed would bind an agent to a number nobody
 *    agreed. `transfer` is the one contract-shaped verb here, and it moves a relationship
 *    rather than rewriting one.
 *  - **Creating an agent.** They sign up; an agent is a platform identity, not an
 *    agency-owned record.
 */

const agents = new AgentReadRepository();
const contracts = new ContractReadRepository();
const contractEvents = new ContractEventReadRepository();
/**
 * Reached for one thing: the business name and status behind an agency id on a COD slice.
 *
 * The agencies module owns `delivery_agencies` and the Magazin join that answers "what is
 * this agency called" — `findRowsByIds` is that join, and reusing it is what keeps this
 * endpoint and `GET /agents/:agentId/contracts` naming the same agency the same way.
 */
const agencies = new AgencyReadRepository();
const audit = new AuditRepository();

interface AgentDto {
    id: string;
    userId: string;
    name: string | null;
    email: string | null;
    phone: string | null;
    /** An opaque id — this service resolves no file URLs (ADR-009 D-6). */
    avatarFileId: string | null;
    status: string;
    statusReason: string | null;
    kycStatus: string | null;
    banned: boolean;
    onboardingComplete: boolean;
    /** The operational block — the answer to "can this agent take another job?" */
    operational: {
        availability: string | null;
        availabilityChangedAt: string | null;
        workingState: string | null;
        /**
         * `capacity.active_shipment_count`, NEVER `working_state.active_shipment_count`.
         * The first is authoritative — it is what the accept path compare-and-sets on —
         * while the second is a recomputed input to the label beside it and can lag.
         */
        activeShipments: number;
        maxActiveShipments: number;
    };
    trackingAllowed: boolean;
    /**
     * The EFFECTIVE score — an administrator's pinned override when one exists, the computed
     * score otherwise. Matches what every gate in jovi-mall acts on (O-7).
     *
     * ⚠ The `trustScore` SORT still orders by the computed `cod.trust_score`, because that is
     * the indexed field. An overridden agent therefore sorts by a score that is not being
     * applied to them. `trustSource` is what lets a column say so.
     */
    trustScore: number | null;
    trustSource: 'override' | 'computed';
    createdAt: string;
    updatedAt: string;
}

function toIso(value: Date | null | undefined): string | null {
    if (!value) return null;
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** Named-field mapping, not a spread — the second lock after the projection. */
function toAgentDto(agent: AgentReadModel): AgentDto {
    return {
        id: agent._id.toString(),
        userId: agent.user_id?.toString() ?? '',
        name: agent.name ?? null,
        email: agent.email ?? null,
        phone: agent.phone ?? null,
        avatarFileId: agent.avatar_file_id?.toString() ?? null,
        status: agent.status,
        statusReason: agent.status_reason ?? null,
        kycStatus: agent.kyc?.status ?? null,
        banned: agent.platform_ban?.banned === true,
        // `0` is the COMPLETED sentinel, not "nothing done".
        onboardingComplete: agent.onboarding_step === 0,
        operational: {
            availability: agent.availability?.state ?? null,
            availabilityChangedAt: toIso(agent.availability?.changed_at),
            workingState: agent.working_state?.state ?? null,
            activeShipments: agent.capacity?.active_shipment_count ?? 0,
            maxActiveShipments: agent.capacity?.max_active_shipments ?? 0,
        },
        trackingAllowed: agent.tracking?.allowed === true,
        trustScore: agent.cod?.trust_override?.score ?? agent.cod?.trust_score ?? null,
        trustSource: agent.cod?.trust_override ? 'override' : 'computed',
        createdAt: toIso(agent.created_at) ?? String(agent.created_at),
        updatedAt: toIso(agent.updated_at) ?? String(agent.updated_at),
    };
}

/**
 * How long a reported tracking state may be before it stops meaning anything.
 *
 * A local constant rather than a read of jovi-mall's `AGENT_CONFIG`: this is a *display*
 * threshold for a mirror this service already treats as untrustworthy, not the dispatch
 * rule. The dispatch rule stays where it is, and is reachable through the delegated
 * `tracking-policy` read for anyone who needs the real answer.
 */
const TRACKING_STATE_STALE_AFTER_MS = 2 * 60 * 1000;

function toAgentDetailDto(agent: AgentReadModel) {
    const kyc = agent.kyc ?? {};
    const ban = agent.platform_ban ?? {};
    const tracking = agent.tracking ?? {};
    const lastKnown = agent.last_known_tracking_state ?? {};
    const reportedAt = lastKnown.last_reported_at ? new Date(lastKnown.last_reported_at) : null;

    return {
        ...toAgentDto(agent),
        emailVerified: agent.email_verified === true,
        phoneVerified: agent.phone_verified === true,
        /**
         * ⚠ **Named-field mapping as of the dashboard-request round.** It shipped as
         * `agent.vehicle_info ?? null` and was DOCUMENTED as `{ type, plate }` while
         * actually serving `{ vehicle_type, plate_number, color, photo_file_id }` — so the
         * contract and the wire disagreed on both the casing and the field names.
         *
         * `photoFileId` stays an opaque id, like every other file reference here (ADR-009
         * D-6). `GET /api/v1/files/:fileId` is what turns it into a picture.
         */
        vehicle: agent.vehicle_info
            ? {
                  /** `bike` · `car` · `van` · `truck`. */
                  type: agent.vehicle_info.vehicle_type ?? null,
                  plateNumber: agent.vehicle_info.plate_number ?? null,
                  /**
                   * A documented vocabulary rather than an enum — a lowercase English
                   * token from `VEHICLE_COLORS`, or whatever the agent typed when it is
                   * not one. Never localised on the wire.
                   */
                  color: agent.vehicle_info.color ?? null,
                  photoFileId: agent.vehicle_info.photo_file_id?.toString() ?? null,
              }
            : null,
        homeBase: {
            label: agent.home_base?.label ?? null,
            serviceRadiusKm: agent.home_base?.service_radius_km ?? null,
            // `home_base.location` is NOT here and is not projected. It is a 2dsphere point
            // on a person's residence; the label answers the operational question.
        },
        kyc: {
            status: kyc.status ?? null,
            reference: kyc.reference ?? null,
            rejectionReason: kyc.rejection_reason ?? null,
            verifiedAt: toIso(kyc.verified_at),
            // Present only while verified — a rejected agent carrying a stale approver
            // would read as approved on any screen rendering the block without checking.
            verifiedBy:
                kyc.status === 'verified'
                    ? {
                          id: kyc.verified_by_user_id?.toString() ?? null,
                          source: kyc.verified_by_source ?? 'platform',
                          name: kyc.verified_by_name ?? null,
                      }
                    : null,
        },
        ban: {
            banned: ban.banned === true,
            reason: ban.reason ?? null,
            bannedAt: toIso(ban.banned_at),
            by:
                ban.banned === true
                    ? {
                          id: ban.banned_by_user_id?.toString() ?? null,
                          source: ban.banned_by_source ?? 'platform',
                          name: ban.banned_by_name ?? null,
                      }
                    : null,
        },
        /**
         * ── The tracking block, and the one field in it to be careful with ────
         *
         * `lastKnown.position` is a **business mirror, stale by construction**. jovi-mall
         * says so in two files: it is written by geo-tracker's best-effort notifier, no
         * assignment rule reads it, and serving it as a live position is a bug.
         *
         * It is here for parity — jovi-mall's own admin detail already returns it, so
         * dropping it would be a silent break somebody re-adds as a missing-field report —
         * and it ships with `isStale` computed on read so the wire says what it is. A
         * dashboard must render it as "last seen", never as a live marker on a map: the
         * marker would stop moving and nobody would be told.
         *
         * The live position lives in geo-tracker, behind Tracking Allow, and this service
         * has **no door to it**. Every geo-tracker read requires a real jovi-mall user JWT
         * and resolves per-agent visibility by looking that user up in `users` — and a
         * wi-admin administrator has no `users` row, deliberately (ADR-004 D-1). Building
         * that door means either minting platform users for administrators or adding a
         * service-caller identity geo-tracker does not have. Both are out of scope and
         * neither is a small decision.
         */
        tracking: {
            allowed: tracking.allowed === true,
            reason: tracking.reason ?? null,
            changedAt: toIso(tracking.changed_at),
            changedBy: {
                id: tracking.changed_by_user_id?.toString() ?? null,
                role: tracking.changed_by_role ?? null,
                source: tracking.changed_by_source ?? 'platform',
                name: tracking.changed_by_name ?? null,
            },
            lastKnown: {
                status: lastKnown.status ?? 'unknown',
                position: lastKnown.last_position ?? null,
                /**
                 * A NAME for the position — "Bonapriso, Douala".
                 *
                 * Resolved server-side, once per position, and stored beside it. Not on
                 * read: reverse-geocoding per render is a bill per operator who opens the
                 * tab, and it hands the same person's coordinates to a geocoding provider
                 * once per viewer rather than once per position.
                 *
                 * `null` when nothing resolved — never `''`, and never a coordinate pair
                 * dressed up as a name. `source` is an OPEN string (it names the provider,
                 * and a future "nearest landmark" resolution would be additive), so render
                 * it raw and do not `switch` on it.
                 *
                 * ⚠ It inherits the position's exposure and then some: `[9.7043, 4.0511]`
                 * needs a tool to read and "Bonapriso, Douala" does not. Anything deciding
                 * whether to reveal the coordinates is deciding the same about this.
                 *
                 * ⚠ There is deliberately no `accuracyMetres`, and it is not an oversight:
                 * **geo-tracker records no accuracy anywhere.** The WebSocket
                 * `location_update` frame does not carry one, so nothing on the platform
                 * has ever known how good a fix is. Shipping a field that is null on every
                 * row in every circumstance would teach a client to expect data that does
                 * not exist.
                 */
                place: lastKnown.last_place?.label
                    ? {
                          label: lastKnown.last_place.label,
                          source: lastKnown.last_place.source ?? null,
                          resolvedAt: toIso(lastKnown.last_place.resolved_at),
                      }
                    : null,
                reportedAt: toIso(lastKnown.last_reported_at),
                source: lastKnown.source ?? null,
                isStale:
                    reportedAt === null
                    || Date.now() - reportedAt.getTime() > TRACKING_STATE_STALE_AFTER_MS,
            },
        },
        /**
         * ⚠ **Named-field mapping as of the dashboard-request round.** This shipped as
         * `agent.device ?? null` — jovi-mall's sub-document assigned whole — so eight
         * `snake_case` keys reached the browser against README's "the translation happens
         * in this service and never leaks". The projection above was already enumerated,
         * so the key set was bounded; the casing was not.
         */
        device: agent.device
            ? {
                  platform: agent.device.platform ?? null,
                  appVersion: agent.device.app_version ?? null,
                  /** `always` · `while_in_use` · `denied` · `unknown`. */
                  locationPermission: agent.device.location_permission ?? null,
                  /**
                   * Tri-state, and `null` is not `false`. An unknown flag is never coerced
                   * to a block — `device_location_disabled` is a real dispatch
                   * ineligibility reason, and inventing one from silence would strand an
                   * agent whose app has simply not reported yet.
                   */
                  locationServicesEnabled: agent.device.location_services_enabled ?? null,
                  backgroundLocationEnabled: agent.device.background_location_enabled ?? null,
                  batteryOptimizationExempt: agent.device.battery_optimization_exempt ?? null,
                  pushEnabled: agent.device.push_enabled ?? null,
                  reportedAt: toIso(agent.device.reported_at),
              }
            : null,
        capacity: {
            max: agent.capacity?.max_active_shipments ?? 0,
            active: agent.capacity?.active_shipment_count ?? 0,
            reconciledAt: toIso(agent.capacity?.reconciled_at),
        },
        /**
         * ⚠ `trustScore` is the EFFECTIVE score — the administrator's pinned override when
         * one exists, the computed score otherwise. Every gate in jovi-mall reads it that
         * way (O-7), and until Phase 6.J this DTO reported `cod.trust_score` alone, so on
         * exactly the agents where a human had overridden the machine, this screen showed
         * the number the platform was NOT using.
         *
         * All three are shipped, never just the effective one: a screen that cannot say
         * "pinned at 80, computed 35, by Awa on 12 Aug" cannot tell an administrator what
         * releasing the override would do. `source` is for display, never for a branch.
         */
        cod: {
            trustScore: agent.cod?.trust_override?.score ?? agent.cod?.trust_score ?? null,
            computedTrustScore: agent.cod?.trust_score ?? null,
            trustSource: agent.cod?.trust_override ? ('override' as const) : ('computed' as const),
            trustOverride: agent.cod?.trust_override
                ? {
                      score: agent.cod.trust_override.score ?? null,
                      reason: agent.cod.trust_override.reason ?? null,
                      setAt: toIso(agent.cod.trust_override.set_at),
                      setByName: agent.cod.trust_override.set_by_name ?? null,
                  }
                : null,
            maxThreshold: agent.cod?.max_threshold ?? null,
        },
        /**
         * ⚠ **Named-field mapping as of the dashboard-request round**, for the same reason
         * as `device` above — thirteen `snake_case` keys were reaching the wire, entirely
         * undocumented, because the sub-document was assigned whole.
         *
         * `null` throughout rather than `0`: an agent who has never been rated has no
         * rating, which is a different fact from a rating of zero and reads very
         * differently on a screen deciding whether to dispatch to them.
         */
        trustSignals: agent.trust_signals
            ? {
                  onTimeRate: agent.trust_signals.on_time_rate ?? null,
                  assignmentResponseRate: agent.trust_signals.assignment_response_rate ?? null,
                  completedShipments: agent.trust_signals.completed_shipments ?? null,
                  customerRatingAvg: agent.trust_signals.customer_rating_avg ?? null,
                  customerRatingCount: agent.trust_signals.customer_rating_count ?? null,
                  agencyRatingAvg: agent.trust_signals.agency_rating_avg ?? null,
                  agencyRatingCount: agent.trust_signals.agency_rating_count ?? null,
                  vendorRatingAvg: agent.trust_signals.vendor_rating_avg ?? null,
                  vendorRatingCount: agent.trust_signals.vendor_rating_count ?? null,
                  codCleanReturnCount: agent.trust_signals.cod_clean_return_count ?? null,
                  codDiscrepancyCount: agent.trust_signals.cod_discrepancy_count ?? null,
                  codVolumeReturned: agent.trust_signals.cod_volume_returned ?? null,
                  /**
                   * ⚠ **The SHADOW score, not the live one.** `trustScore` above is
                   * `cod.trust_score` — the number that actually sets this agent's COD
                   * cash limit. This is jovi-mall's nightly composite of the signals
                   * beside it, computed and stored but acting on nothing (that repo's
                   * Phase 6 D-2).
                   *
                   * It is surfaced *because* it differs: the decision to make the
                   * composite live is taken by comparing the two across the roster, and
                   * a number nobody can see cannot be compared. Do not render it as an
                   * agent's trust score, and do not sort or filter a dispatch view on it.
                   *
                   * `null` until the nightly recompute has visited that agent.
                   */
                  compositeScore: agent.trust_signals.composite_score ?? null,
                  computedAt: toIso(agent.trust_signals.computed_at),
              }
            : null,
        settings: {
            autoAcceptAssignments: agent.settings?.auto_accept_assignments === true,
            navigationApp: agent.preferences?.navigation_app ?? null,
        },
        timezone: agent.timezone ?? null,
        preferredLanguage: agent.preferred_language ?? null,
    };
}

/** The fields a write can change, as the audit row's `before`. */
function toAuditState(agent: AgentReadModel): Record<string, unknown> {
    return {
        name: agent.name ?? null,
        status: agent.status,
        statusReason: agent.status_reason ?? null,
        kycStatus: agent.kyc?.status ?? null,
        banned: agent.platform_ban?.banned === true,
        trackingAllowed: agent.tracking?.allowed === true,
        codMaxThreshold: agent.cod?.max_threshold ?? null,
    };
}

async function loadOr404(agentId: string): Promise<AgentReadModel> {
    const agent = await agents.findById(agentId);
    if (!agent) throw createAppError(ERROR_CODES.NOT_FOUND, 404, 'Delivery agent not found');
    return agent;
}

export class AgentController {
    /**
     * GET /api/v1/agents — the directory that did not exist.
     *
     * Six independent filters, one per state axis, because the questions an administrator
     * asks are conjunctions across them: "who is active but unverified", "who is banned and
     * still marked available", "who has tracking off". A single collapsed `state` filter
     * could express none of those.
     */
    static search = asyncHandler(async (req: Request, res: Response) => {
        const query = req.query as unknown as SearchAgentsQuery;

        const page = await agents.search({
            search: query.search,
            status: query.status,
            kycStatus: query.kycStatus,
            availability: query.availability,
            workingState: query.workingState,
            banned: query.banned,
            trackingAllowed: query.trackingAllowed,
            from: query.from,
            to: query.to,
            page: query.page,
            limit: query.limit,
            sort: query.sort,
        });

        sendPaginated(res, page.items.map(toAgentDto), toPageMeta(page.total, page.page, page.limit));
    });

    /** GET /api/v1/agents/:agentId */
    static get = asyncHandler(async (req: Request, res: Response) => {
        sendSuccess(res, toAgentDetailDto(await loadOr404(req.params.agentId)));
    });

    /**
     * GET /api/v1/agents/:agentId/contracts — every agency this agent works with.
     *
     * Every status by default, terminal rows included. jovi-mall's own admin view keeps
     * this unpaginated for the same reason it matters here: an investigation must not lose
     * rows to a page boundary. This one paginates because ADR-005 D-10 admits no unpaged
     * list, and the default page of 20 exceeds any real agent's agency count.
     */
    static contracts = asyncHandler(async (req: Request, res: Response) => {
        const query = req.query as unknown as ListContractsQuery;
        await loadOr404(req.params.agentId);

        const page = await contracts.listForAgent(req.params.agentId, {
            status: query.status,
            primaryOnly: query.primaryOnly,
            page: query.page,
            limit: query.limit,
            sort: query.sort,
        });

        sendPaginated(res, page.items.map(toAgentContractDto), toPageMeta(page.total, page.page, page.limit));
    });

    /**
     * GET /api/v1/agents/:agentId/contract-history — what everyone did to this agent's
     * relationships. The sibling `/activity` is what administrators did. Two feeds, two
     * databases, two permissions — see the repository header.
     *
     * ── `agent` is decorated here too, and it is not redundant (BR-016 § 1) ───
     * Every row on THIS feed names the agent in the path, so the object is the same on all
     * of them. It is still carried, because the two feeds share one DTO and a client
     * branching on which endpoint it called to know whether `agent` is present is a client
     * that will get it wrong. The cost is one batched read of one id.
     */
    static contractHistory = asyncHandler(async (req: Request, res: Response) => {
        const query = req.query as unknown as ListContractEventsQuery;
        await loadOr404(req.params.agentId);

        const page = await contractEvents.list(
            { agentId: req.params.agentId },
            {
                type: query.type,
                actorRole: query.actorRole,
                from: query.from,
                to: query.to,
                page: query.page,
                limit: query.limit,
                sort: query.sort,
            },
        );

        const agentNames = await agents.findNamesByIds(distinctAgentIds(page.items));

        sendPaginated(
            res,
            page.items.map((event) => toContractEventDto(event, agentNames)),
            toPageMeta(page.total, page.page, page.limit),
        );
    });

    /**
     * GET /api/v1/agents/:agentId/activity — the audit trail, filtered to this agent.
     *
     * Not their platform activity — their shipments, their COD collections, their
     * earnings. Those live in other domains behind other permissions, and assembling them
     * here would let `agents.read` alone reach data those permissions exist to gate.
     */
    static activity = asyncHandler(async (req: Request, res: Response) => {
        const identity = requireAdminIdentity(req);
        const query = req.query as unknown as ListAgentActivityQuery;

        await loadOr404(req.params.agentId);

        const page = await audit.search(
            {
                page: query.page,
                limit: query.limit,
                sort: query.sort,
                action: query.action,
                status: query.status,
                from: query.from,
                to: query.to,
                targetType: 'agent',
                targetId: req.params.agentId,
            } as ListAuditQuery,
            identity,
        );

        sendPaginated(res, page.items.map(toAuditEntryDto), page.meta);
    });

    /**
     * GET /api/v1/agents/:agentId/tracking-policy — jovi-mall's own verdict.
     *
     * Delegated, not recomputed: geo-tracker consumes this exact function, and a second
     * implementation here would be a second tracking policy. It answers `trackingAllowed`
     * plus a `denyReason` — `tracking_disabled`, `agent_not_active`, or
     * `no_approved_agency`, the last because tracking exists to serve a delivery
     * relationship and nobody is entitled to watch an unaffiliated person move around.
     */
    static trackingPolicy = asyncHandler(async (req: Request, res: Response) => {
        await loadOr404(req.params.agentId);
        sendSuccess(res, await gateway.trackingPolicy(req.params.agentId, actorContextOf(req)));
    });

    /**
     * GET /api/v1/agents/:agentId/tracking-presence — geo-tracker's operational answer.
     *
     * Is this agent's phone connected, opted in, and how many deliveries are they running?
     * It carries **no coordinates** — `positionKnown` and `positionAgeSeconds` say whether
     * a fix exists and how fresh, which is the operational question, without saying where.
     *
     * Not audited, deliberately: device flags, session states and timestamps are facts
     * about a delivery rather than about a person's location, and a row per render would
     * dilute the trail that the two disclosures below depend on being sparse.
     *
     * ⚠ **This is the first read in this service that reaches geo-tracker's DATA door**
     * (ADR-020). Note what it does NOT replace: `tracking.lastKnown` on the detail read is
     * jovi-mall's stale business mirror and answers "where were they last seen"; this
     * answers "is the device reporting right now". Two questions, two sources.
     */
    static trackingPresence = asyncHandler(async (req: Request, res: Response) => {
        await loadOr404(req.params.agentId);
        const context = actorContextOf(req);

        sendSuccess(
            res,
            readNonDisclosing(
                await readAgentPresence(req.params.agentId, {
                    actor: context.actor.adminId,
                    // Sent on every call so the two services' logs line up, not only on the
                    // audited ones. geo-tracker requires one only where coordinates flow.
                    reason: 'presence',
                }),
            ),
        );
    });

    /**
     * GET /api/v1/agents/:agentId/live-position?reason=… — the sharp one.
     *
     * A person's current coordinates, read by an administrator they have no relationship
     * with. Three things make that defensible and all three are load-bearing:
     *
     *  - **`reason` is required**, and it is recorded. The purpose axis of ADR-020's scope
     *    model, and the difference between a log and a trail.
     *  - **The audit row commits BEFORE the read**, and a failure of that write is not
     *    caught — so with the audit store down nothing is disclosed. See
     *    `domain/tracking-disclosure.ts`, which argues this at length.
     *  - **Tracking Allow gates it on geo-tracker's side.** An agent who has not granted it
     *    answers `position: null, withheld: 'tracking_allow_off'` — and no timestamp
     *    either, because that the agent is streaming is itself part of what the opt-out
     *    withholds.
     *
     * The response carries `ageSeconds`, never a `stale` verdict. Render it as a
     * timestamped reading, not as a live marker on a map: a marker that stops moving tells
     * nobody it has stopped.
     */
    static livePosition = asyncHandler(async (req: Request, res: Response) => {
        const query = req.query as unknown as TrackingReadQuery;
        const agent = await loadOr404(req.params.agentId);

        sendSuccess(
            res,
            await discloseAgentPosition(
                req.params.agentId,
                typeof agent.name === 'string' ? agent.name : null,
                { reason: query.reason },
                actorContextOf(req),
            ),
        );
    });

    /**
     * GET /api/v1/agents/:agentId/cod-allocation — pool, per-contract slices, headroom.
     *
     * ── Delegated verdict, decorated locally (BR-016 § 2) ─────────────────────
     * The arithmetic stays jovi-mall's: `ALLOCATING_CONTRACT_STATUSES` is the judgement that
     * `paused` and `suspended` contracts still hold headroom while `deactivated` ones do
     * not, and a copy of it here would drift silently and report headroom that does not
     * exist. What is added is a NAME, which jovi-mall cannot produce — the agency's business
     * name lives on the Magazin, and this endpoint's subject there is a number.
     *
     * That is the two rules meeting rather than either bending: the verdict is delegated,
     * the record decorating it is read directly.
     *
     * One batched read for the whole payload, and it is bounded twice over — by the agent's
     * contract count, which is single digits, and by the fact that the slices are already in
     * hand when it runs.
     */
    static codAllocation = asyncHandler(async (req: Request, res: Response) => {
        await loadOr404(req.params.agentId);

        const allocation = await gateway.codAllocation(req.params.agentId, actorContextOf(req));
        const agencyRows = await agencies.findRowsByIds(
            allocationAgencyIds(allocation)
                .filter((id) => Types.ObjectId.isValid(id) && id.length === 24)
                .map((id) => new ObjectId(id)),
        );

        sendSuccess(res, toCodAllocationDto(allocation, agencyRows));
    });

    /**
     * GET /api/v1/agents/:agentId/verification — the evidence the KYC verdict rests on.
     *
     * ── What this closes ─────────────────────────────────────────────────────────
     * `PUT /:agentId/kyc` is the write that decides whether an agent may work at all, and
     * until now the only thing an administrator could see before pressing it was
     * `legal_identity.national_id_number` — a string the agent typed — plus `kyc.reference`,
     * a note an administrator had written **themselves**. Nothing checkable. The verdict was
     * therefore either a rubber stamp or a refusal, and neither was evidence.
     *
     * This returns the identity-card scans, the selfie holding the card, the vehicle
     * photographed with its rider, the geocoded home address and the hand-drawn sketches of
     * it, plus who has already decided and when.
     *
     * ── ⚠ It returns NO VERDICT AND NO SCORE, and that is the design ─────────────
     * There is no `estimatedVerdict`, no `complete`, and no `required` column anywhere in the
     * payload. The dashboard owns the required/optional rules per role, computes the badge
     * from them, and pre-populates a rejection reason. Putting a second copy here would be
     * the same rule in two repositories, and the one that changes when the reviewers change
     * their minds is the dashboard's.
     *
     * ── ⚠ Every document has `url: null` ─────────────────────────────────────────
     * These files are in jovi-mall's private `kyc/` tree, so `access` is `authorized` and the
     * `id` is the handle. Render them through `GET /api/v1/files/:fileId/content`, which is
     * behind `files.content.read` and **audited** — that read is the disclosure, and it is
     * where the row belongs. A broken-image icon here means the client used `url`.
     */
    static verification = asyncHandler(async (req: Request, res: Response) => {
        await loadOr404(req.params.agentId);
        sendSuccess(
            res,
            await verificationRecord('agent', req.params.agentId, actorContextOf(req)),
        );
    });

    /**
     * GET /api/v1/agents/:agentId/eligibility?agencyId=… — could this agency dispatch to
     * this agent right now?
     *
     * `agencyId` is required, not optional. Eligibility is pairwise: the rule set includes
     * holding an approved contract with the dispatching agency, so there is no
     * agency-free answer to give. It reports EVERY failed rule at once — the property a
     * local reimplementation loses first, and the reason this read is delegated.
     */
    static eligibility = asyncHandler(async (req: Request, res: Response) => {
        const query = req.query as unknown as EligibilityQuery;
        await loadOr404(req.params.agentId);
        sendSuccess(
            res,
            await gateway.eligibility(req.params.agentId, query.agencyId, actorContextOf(req)),
        );
    });

    /**
     * GET /api/v1/agents/:agentId/assignability?agencyId=…&shipmentId=… — every gate on
     * giving this agent work from this agency, with the numbers behind each one.
     *
     * ── What this adds over `/eligibility`, and why it is a separate endpoint ────
     *
     * `eligibility` answers the PLATFORM half — banned, KYC, active, available, tracking,
     * device, capacity. This answers that half plus the CONTRACT half — active contract,
     * coverage region, per-shipment value ceiling and COD exposure — which was reachable
     * from no surface at all before Phase 6.J.
     *
     * The gap was not academic. An agency refused with `COD_AGENT_EXPOSURE_EXCEEDED` could
     * see its own COD threshold on three of this service's screens, and could see neither
     * the agent's actual exposure (which counts undelivered COD packages, not just held
     * cash, and spans EVERY agency the agent serves) nor the trust multiplier that had
     * halved that threshold. Support had the wrong number in front of them and no way to
     * know it.
     *
     * A separate endpoint rather than fields added to `eligibility`: that shape is a
     * documented contract three dashboards already parse, its subject is genuinely the
     * platform rule set, and this one takes an argument it does not.
     *
     * ── Not audited, and that is consistent rather than an omission ──────────────
     *
     * A GET that mutates nothing. The two audited reads in this service are audited
     * because they disclose a person's live COORDINATES (ADR-020 D-5); this discloses a
     * cash position to the tier that already holds `agents.read` and can see the COD
     * holders list.
     */
    static assignability = asyncHandler(async (req: Request, res: Response) => {
        const query = req.query as unknown as AssignabilityQuery;
        await loadOr404(req.params.agentId);
        sendSuccess(
            res,
            await gateway.assignability(
                req.params.agentId,
                query.agencyId,
                query.shipmentId,
                actorContextOf(req),
            ),
        );
    });

    /**
     * PUT /api/v1/agents/:agentId/status
     *
     * A `PUT` on one single-valued sub-resource, matching `/administrators/:id/tier`.
     * Splitting it into four imperatives would be worse than one body with a conditional
     * reason: `pending_verification` and `inactive` are not verbs anybody says.
     *
     * Memberships are left intact, deliberately — reinstatement restores them.
     */
    static setStatus = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as SetAgentStatusBody;
        const before = await loadOr404(req.params.agentId);

        const updated = await gateway.setStatus(
            req.params.agentId,
            { status: body.status, reason: body.reason },
            toAuditState(before),
            actorContextOf(req),
        );

        sendSuccess(res, updated, { message: `Agent status set to ${body.status}` });
    });

    /**
     * PUT /api/v1/agents/:agentId/kyc — the write that lets an agent work.
     *
     * Eligibility passes only on `verified`, so this is the gate, not a label. Moving an
     * agent OFF `verified` makes them undispatchable immediately; it does not touch their
     * contracts, and in-flight shipments they already hold are unaffected.
     */
    static reviewKyc = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as ReviewAgentKycBody;
        const before = await loadOr404(req.params.agentId);

        const updated = await gateway.reviewKyc(
            req.params.agentId,
            { status: body.status, reference: body.reference, rejectionReason: body.rejectionReason },
            toAuditState(before),
            actorContextOf(req),
        );

        sendSuccess(res, updated, { message: `Identity documents marked ${body.status}` });
    });

    /**
     * PUT /api/v1/agents/:agentId/tracking
     *
     * The message says exactly what happens, because this endpoint used to promise more
     * than it delivered. Since Phase 9 the decision IS pushed to geo-tracker — the live
     * position is suppressed and every open session moves to `tracking_disabled` — but a
     * watcher is still not revoked: `visible-agents` derives visibility from shipments and
     * never consults this flag, so an agency watching stays subscribed and receives
     * nothing. Both halves are stated rather than the flattering one.
     */
    static setTracking = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as SetTrackingBody;
        const before = await loadOr404(req.params.agentId);

        const updated = await gateway.setTracking(
            req.params.agentId,
            { allowed: body.allowed, reason: body.reason },
            toAuditState(before),
            actorContextOf(req),
        );

        sendSuccess(res, updated, {
            message: body.allowed
                ? 'Tracking enabled — this agent can be dispatched and located again'
                : 'Tracking disabled — this agent will not be dispatched, and their live '
                  + 'position stops being recorded. Anyone already watching keeps their '
                  + 'subscription and simply receives nothing.',
        });
    });

    /** PUT /api/v1/agents/:agentId/cod-threshold — the whole pool every contract slices. */
    static setCodThreshold = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as SetThresholdBody;
        const before = await loadOr404(req.params.agentId);

        const updated = await gateway.setCodThreshold(
            req.params.agentId,
            body.maxThreshold,
            toAuditState(before),
            actorContextOf(req),
        );

        sendSuccess(res, updated, { message: 'COD threshold updated' });
    });

    /**
     * POST /api/v1/agents/:agentId/ban
     *
     * An override consulted by every gate, deliberately NOT a cascade over contracts:
     * flipping each to paused would be lossy, since un-banning could not tell which were
     * already paused. One flag suppresses every contract at once and lifting it restores
     * exactly the prior state.
     *
     * The consequence worth knowing: a contract-level `reactivate` while the ban stands
     * WRITES `active`, and the agent stays unusable because every gate still refuses.
     */
    static ban = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as BanAgentBody;
        const before = await loadOr404(req.params.agentId);

        const updated = await gateway.ban(
            req.params.agentId,
            body.reason,
            toAuditState(before),
            actorContextOf(req),
        );

        sendSuccess(res, updated, { message: 'Agent banned from the platform' });
    });

    /**
     * POST /api/v1/agents/:agentId/unban
     *
     * Its own route and its own audit action although it shares the permission. Lifting a
     * ban CLEARS the reason, the timestamp and the actor stamp off the agent row, so the
     * audit row is the only surviving record that the ban ever happened.
     */
    static unban = asyncHandler(async (req: Request, res: Response) => {
        const before = await loadOr404(req.params.agentId);

        const updated = await gateway.unban(
            req.params.agentId,
            toAuditState(before),
            actorContextOf(req),
        );

        sendSuccess(res, updated, { message: 'Platform ban lifted' });
    });

    /**
     * POST /api/v1/agents/transfer — move an agent between agencies.
     *
     * Admin-only, and the reason is worth restating on the surface that exposes it: an
     * agency must not be able to pull an agent off a rival's roster.
     */
    static transfer = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as TransferAgentBody;
        const before = await loadOr404(body.agentId);

        const result = await gateway.transfer(
            {
                agentId: body.agentId,
                fromAgencyId: body.fromAgencyId,
                toAgencyId: body.toAgencyId,
                reason: body.reason,
            },
            toAuditState(before),
            actorContextOf(req),
        );

        sendSuccess(res, result, { message: 'Agent transferred' });
    });
}
