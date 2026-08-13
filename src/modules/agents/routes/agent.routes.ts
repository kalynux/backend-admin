import { Router } from 'express';
import { defineRoute, permission, records } from '../../../api/route-manifest';
import { AgentController } from '../controllers/agent.controller';
import { ListContractEventsQuerySchema } from '../../agencies/validators/agency.validator';
import {
    AgentIdParamSchema,
    BanAgentSchema,
    EligibilityQuerySchema,
    ListAgentActivityQuerySchema,
    ListContractsQuerySchema,
    ReviewAgentKycSchema,
    SearchAgentsQuerySchema,
    SetAgentStatusSchema,
    SetThresholdSchema,
    SetTrackingSchema,
    TransferAgentSchema,
} from '../validators/agent.validator';

/**
 * `/api/v1/agents` — delivery-agent administration.
 *
 * Fifteen routes. Eleven are the legacy surface ported (PHASE-0: "port faithfully"), and
 * four are new: the LIST that never existed, the contract list, the contract history, and
 * the administrative activity feed.
 *
 * ── Route order is load-bearing here ─────────────────────────────────────────
 * `POST /transfer` is declared FIRST, above `/:agentId`. Express matches in declaration
 * order, so with the param route first the literal `transfer` is read as an agent id and
 * the endpoint silently 404s on a lookup for an agent called "transfer". jovi-mall's own
 * router carries the same comment for the same reason. Anything else literal at that level
 * must go above too.
 *
 * ── Read and write hold different permissions ─────────────────────────────────
 * `agents.read` covers all six reads including the three delegated verdicts, and Support
 * holds it — answering a ticket about a stalled delivery needs to see whether the agent
 * is even dispatchable. None of the writes are Support's: five reach tier 2 through
 * `allInFamily('agents')`, and the two sharpest do not — `agents.ban` is flagged
 * `destructive` and `agents.cod_threshold.set` `financial`, so `allInFamily` refuses to
 * expand either and a human had to name them in the tier-2 list. That is the mechanism
 * that keeps a family grant from sweeping in a money write.
 */
const router = Router();
const mountedAt = '/agents';

/** Declared before `/:agentId`. See the header — this is not stylistic. */
defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/transfer',
    access: permission('agents.transfer'),
    validate: { body: TransferAgentSchema },
    audit: records('agents.transfer'),
    handler: AgentController.transfer,
});

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/',
    access: permission('agents.read'),
    validate: { query: SearchAgentsQuerySchema },
    handler: AgentController.search,
});

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/:agentId',
    access: permission('agents.read'),
    validate: { params: AgentIdParamSchema },
    handler: AgentController.get,
});

/**
 * The contract list carries the agency it is with, so it needs `agencies.read` too — the
 * same dependency the agency roster states in the other direction. Both tiers holding
 * either hold both, so it costs nobody access and states the coupling.
 */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/:agentId/contracts',
    access: permission('agents.read', 'agencies.read'),
    validate: { params: AgentIdParamSchema, query: ListContractsQuerySchema },
    handler: AgentController.contracts,
});

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/:agentId/contract-history',
    access: permission('agents.read'),
    validate: { params: AgentIdParamSchema, query: ListContractEventsQuerySchema },
    handler: AgentController.contractHistory,
});

/**
 * `audit.read` as well, for the reason `/users/:id/activity` documents: these rows ARE
 * audit rows and the repository applies the audit read scope to them, so requiring only
 * `agents.read` would make this a second door onto the trail.
 */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/:agentId/activity',
    access: permission('agents.read', 'audit.read'),
    validate: { params: AgentIdParamSchema, query: ListAgentActivityQuerySchema },
    handler: AgentController.activity,
});

/** The three delegated verdict reads. All `agents.read` — they are reads. */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/:agentId/tracking-policy',
    access: permission('agents.read'),
    validate: { params: AgentIdParamSchema },
    handler: AgentController.trackingPolicy,
});

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/:agentId/cod-allocation',
    access: permission('agents.read'),
    validate: { params: AgentIdParamSchema },
    handler: AgentController.codAllocation,
});

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/:agentId/eligibility',
    access: permission('agents.read'),
    validate: { params: AgentIdParamSchema, query: EligibilityQuerySchema },
    handler: AgentController.eligibility,
});

/**
 * Four `PUT`s, one per single-valued sub-resource with a conditional reason — the
 * `/administrators/:id/tier` shape. Splitting `status` into four imperatives would be
 * worse: `pending_verification` is not a verb.
 */
defineRoute(router, {
    mountedAt,
    method: 'put',
    path: '/:agentId/status',
    access: permission('agents.status.set'),
    validate: { params: AgentIdParamSchema, body: SetAgentStatusSchema },
    audit: records('agents.status.set'),
    handler: AgentController.setStatus,
});

defineRoute(router, {
    mountedAt,
    method: 'put',
    path: '/:agentId/kyc',
    access: permission('agents.kyc.review'),
    validate: { params: AgentIdParamSchema, body: ReviewAgentKycSchema },
    audit: records('agents.kyc.review'),
    handler: AgentController.reviewKyc,
});

defineRoute(router, {
    mountedAt,
    method: 'put',
    path: '/:agentId/tracking',
    access: permission('agents.tracking.set'),
    validate: { params: AgentIdParamSchema, body: SetTrackingSchema },
    audit: records('agents.tracking.set'),
    handler: AgentController.setTracking,
});

defineRoute(router, {
    mountedAt,
    method: 'put',
    path: '/:agentId/cod-threshold',
    access: permission('agents.cod_threshold.set'),
    validate: { params: AgentIdParamSchema, body: SetThresholdSchema },
    audit: records('agents.cod_threshold.set'),
    handler: AgentController.setCodThreshold,
});

/**
 * Ban and unban are two POST sub-resources over one jovi-mall endpoint.
 *
 * `PUT /ban { banned: boolean }` — which is what jovi-mall offers — is a boolean standing
 * in for a state (ADR-005 D-17) and puts two opposite acts under one audit label. Lifting
 * a ban CLEARS the reason, the timestamp and the actor stamp off the agent row, so the
 * audit row is the only surviving record it happened; that cannot be true if both
 * directions share a name. Same reasoning as `/users/:id/{suspend,restore}`.
 */
defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/:agentId/ban',
    access: permission('agents.ban'),
    validate: { params: AgentIdParamSchema, body: BanAgentSchema },
    audit: records('agents.ban'),
    handler: AgentController.ban,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/:agentId/unban',
    access: permission('agents.ban'),
    validate: { params: AgentIdParamSchema },
    audit: records('agents.unban'),
    handler: AgentController.unban,
});

export const agentRoutes = router;
