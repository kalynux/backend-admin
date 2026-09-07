import { platformRequest } from '../../../infra/platform/platform.client';
import { auditedAttempt } from '../../audit/domain/audit.writer';
import { ActorContext } from '../../audit/domain/audit-context';
import { AuditAction } from '../../audit/domain/audit.catalog';

/**
 * The agent domain's DELEGATED half: every write, plus the four reads whose answer is a
 * verdict rather than a record.
 *
 * ── The four delegated reads, and why they are not repository methods ─────────
 * ADR-009 D-1: **delegate a read whose answer is a VERDICT the platform acts on.**
 *
 *  - `eligibility` — the dispatcher branches on it, and it reports EVERY failed rule at
 *    once rather than the first. A reimplementation loses that property before it loses
 *    correctness, and a screen that shows one blocker sends an administrator round the
 *    loop fixing them one at a time.
 *  - `trackingPolicy` — geo-tracker consumes this exact function over the service-token
 *    door. A copy here would be a second tracking policy, and the two would disagree the
 *    first time either moved.
 *  - `codAllocation` — not for the arithmetic, which is trivial, but for
 *    `ALLOCATING_CONTRACT_STATUSES`: the judgement that `paused` and `suspended` contracts
 *    still hold headroom while `deactivated` ones do not. That is a domain decision, and a
 *    copy would drift on it silently, reporting headroom that does not exist.
 *
 *  - `assignability` — the other half of `eligibility`: the CONTRACT gates (coverage
 *    region, per-shipment value ceiling, COD exposure). See its own header, which makes
 *    the sharpest version of this argument — a repository implementation is genuinely
 *    available for it and would still be wrong.
 *
 * Being honest about the third: the argument is drift of a classification list, not the
 * protection of an invariant. It is still the right call, and it is a weaker one than the
 * other three.
 *
 * The write methods are thin by design: this file should never grow logic.
 */

export type AgentSnapshot = Record<string, unknown> | null;

/** jovi-mall's agent DTO, as much of it as this gateway names. */
export interface PlatformAgent {
    id: string;
    name?: string | null;
    status?: string;
    [key: string]: unknown;
}

/**
 * Wrap a delegated agent mutation in an audit intent.
 *
 * In the gateway rather than the controller, matching the COD, user and agency gateways:
 * this is the transport boundary, and wrapping here means a method added later inherits
 * auditing by construction rather than by its author remembering.
 */
function auditedDelegation<T>(
    action: AuditAction,
    context: ActorContext,
    target: { id: string; label: string | null },
    payload: Record<string, unknown> | null,
    before: AgentSnapshot,
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
            target: { type: 'agent', id: target.id, label: target.label },
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
 * Reduce jovi-mall's answer to the fields worth diffing — the six an administrator can
 * change from this surface, so a diff over them is complete by construction.
 */
function asState(result: unknown): Record<string, unknown> | null {
    const agent = result as Record<string, unknown> | null;
    if (!agent || typeof agent !== 'object') return null;

    const kyc = agent.kyc as { status?: string } | undefined;
    const ban = agent.platformBan as { banned?: boolean } | undefined;
    const tracking = agent.tracking as { allowed?: boolean } | undefined;
    const cod = agent.cod as { maxThreshold?: number } | undefined;

    return {
        status: agent.status ?? null,
        statusReason: agent.statusReason ?? null,
        kycStatus: kyc?.status ?? null,
        banned: ban?.banned ?? null,
        trackingAllowed: tracking?.allowed ?? null,
        /**
         * ⚠ **Two shapes, and reading only the first was a real defect.**
         *
         * Five of the six writes here answer with an agent, where the threshold is nested
         * at `cod.maxThreshold`. `PUT /cod-threshold` does not: jovi-mall runs
         * `setAgentThreshold` and then returns `getAllocation`, so the answer is a
         * `CodAllocation` carrying `maxThreshold` at the TOP level.
         *
         * Reading `cod?.maxThreshold` alone therefore recorded `null` on every row of the
         * one write on this surface flagged `financial` — the audit trail could say a
         * threshold had been set and never what it was set to. Reported by the dashboard
         * as DATA-EXPOSURE §3.
         *
         * Both are read rather than branching on the action, so a future endpoint
         * answering either shape is covered without anybody remembering this.
         */
        codMaxThreshold: cod?.maxThreshold ?? (agent.maxThreshold as number | undefined) ?? null,
    };
}

function labelOf(before: AgentSnapshot): string | null {
    if (!before) return null;
    const name = before.name;
    return typeof name === 'string' && name.length > 0 ? name : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Delegated reads — verdicts, not records
// ─────────────────────────────────────────────────────────────────────────────

/** What geo-tracker would be told about this agent: the flag plus jovi-mall's verdict. */
export async function trackingPolicy(
    agentId: string,
    context: ActorContext,
): Promise<unknown> {
    const result = await platformRequest<unknown>({
        method: 'GET',
        path: `/agents/${agentId}/tracking-policy`,
        actor: context.actor,
        requestId: context.requestId,
    });
    return result.data;
}

/** The COD pool, its per-contract slices, and the headroom left. */
export async function codAllocation(
    agentId: string,
    context: ActorContext,
): Promise<unknown> {
    const result = await platformRequest<unknown>({
        method: 'GET',
        path: `/agents/${agentId}/cod-allocation`,
        actor: context.actor,
        requestId: context.requestId,
    });
    return result.data;
}

/**
 * Whether this agency could dispatch to this agent right now — every failed rule, not the
 * first. Pairwise: an agent is eligible to be dispatched BY someone.
 */
export async function eligibility(
    agentId: string,
    agencyId: string,
    context: ActorContext,
): Promise<unknown> {
    const result = await platformRequest<unknown>({
        method: 'GET',
        path: `/agents/${agentId}/eligibility`,
        query: { agencyId },
        actor: context.actor,
        requestId: context.requestId,
    });
    return result.data;
}

/**
 * A FOURTH delegated verdict: every gate on giving this agent work from this agency —
 * the platform rules `eligibility` already reports, PLUS the contract terms it does not.
 *
 * ── Why this is delegated, stated in ADR-009 D-1's terms ─────────────────────
 *
 * It is the strongest case of the four, and for a reason none of the others has. The
 * contract half of the answer is arithmetic over numbers this service can read directly
 * — a COD threshold, a trust score, a cash balance — so a repository implementation is
 * genuinely available here, and it would be WRONG in a way nobody would notice:
 *
 *  - the trust multiplier's thresholds are jovi-mall env config (`COD_TRUST_*`), so a
 *    copy is correct only until an operator changes a variable in another service;
 *  - exposure counts PENDING collections, not just held cash, and this service has no
 *    read model for those at all;
 *  - the effective score is `cod.trust_override ?? cod.trust_score`, and every screen in
 *    this service that had projected only the latter reported the wrong number.
 *
 * A drifted verdict does not fail — it lies, and support repeats the lie to an agency.
 * That is the whole reason this endpoint exists, so building it on a copy would be
 * self-defeating.
 *
 * @param shipmentId optional. With one, every gate runs against that shipment. Without,
 *   the two shipment-scoped gates report `skipped` and the cash gate answers "is this
 *   agent already at their limit for this agency" — the question support asks first,
 *   before it has a shipment id.
 */
export async function assignability(
    agentId: string,
    agencyId: string,
    shipmentId: string | undefined,
    context: ActorContext,
): Promise<unknown> {
    const result = await platformRequest<unknown>({
        method: 'GET',
        path: `/agents/${agentId}/assignability`,
        query: shipmentId ? { agencyId, shipmentId } : { agencyId },
        actor: context.actor,
        requestId: context.requestId,
    });
    return result.data;
}

// ─────────────────────────────────────────────────────────────────────────────
// Writes
// ─────────────────────────────────────────────────────────────────────────────

export async function setStatus(
    agentId: string,
    input: { status: string; reason?: string },
    before: AgentSnapshot,
    context: ActorContext,
): Promise<PlatformAgent> {
    return auditedDelegation(
        'agents.status.set',
        context,
        { id: agentId, label: labelOf(before) },
        { ...input },
        before,
        async () => {
            const result = await platformRequest<PlatformAgent>({
                method: 'PATCH',
                path: `/agents/${agentId}/status`,
                body: input,
                actor: context.actor,
                requestId: context.requestId,
            });
            return result.data;
        },
    );
}

/**
 * Review the identity documents — the write that decides whether an agent may work.
 *
 * One audit action for all four outcomes rather than an approve/reject pair, and that is
 * the opposite call from ban/unban next door. The difference: KYC is a four-value review
 * with a natural `status` field an administrator is *setting*, and `pending` and
 * `unverified` belong to neither half of a pair. Ban is a two-state toggle, and there the
 * pair is what keeps the feed readable.
 */
export async function reviewKyc(
    agentId: string,
    input: { status: string; reference?: string; rejectionReason?: string },
    before: AgentSnapshot,
    context: ActorContext,
): Promise<PlatformAgent> {
    return auditedDelegation(
        'agents.kyc.review',
        context,
        { id: agentId, label: labelOf(before) },
        { ...input },
        before,
        async () => {
            const result = await platformRequest<PlatformAgent>({
                method: 'PUT',
                path: `/agents/${agentId}/kyc`,
                body: input,
                actor: context.actor,
                requestId: context.requestId,
            });
            return result.data;
        },
    );
}

/**
 * Set whether the agent may be tracked.
 *
 * Since Phase 9 this genuinely reaches geo-tracker: jovi-mall emits an
 * `agent.tracking_allow_changed` outbox row, the dispatcher POSTs it, and geo-tracker
 * suppresses the live position and drives every open session to `tracking_disabled`.
 * Before that it changed dispatch eligibility and nothing else, while the agent went on
 * streaming — which is what an administrator pressing the button did NOT expect.
 *
 * What it still does not do: revoke a watcher. `visible-agents` derives visibility from
 * shipments and never consults this flag, so an agency watching stays subscribed and
 * simply receives nothing. The controller's message says so rather than overclaiming.
 */
export async function setTracking(
    agentId: string,
    input: { allowed: boolean; reason?: string },
    before: AgentSnapshot,
    context: ActorContext,
): Promise<PlatformAgent> {
    return auditedDelegation(
        'agents.tracking.set',
        context,
        { id: agentId, label: labelOf(before) },
        { ...input },
        before,
        async () => {
            const result = await platformRequest<PlatformAgent>({
                method: 'PUT',
                path: `/agents/${agentId}/tracking-allow`,
                body: input,
                actor: context.actor,
                requestId: context.requestId,
            });
            return result.data;
        },
    );
}

/**
 * Set the agent's whole COD pool.
 *
 * jovi-mall refuses a value below what the agent's contracts have already allocated —
 * that check needs the contracts, which is why the bound is not validated here. The
 * refusal reaches the dashboard as its own 4xx with `details.platformCode`.
 *
 * ⚠ **This answers a `CodAllocation`, NOT an agent**, and the annotation used to say
 * otherwise. jovi-mall's handler runs `setAgentThreshold` then `getAllocation` and returns
 * the latter — which is the more useful answer (a client gets the fresh headroom rather
 * than an agent it has to re-read), but it is a different shape, and `asState` reading
 * only the agent one is what made every audit row on this write record a `null` threshold.
 */
export async function setCodThreshold(
    agentId: string,
    maxThreshold: number,
    before: AgentSnapshot,
    context: ActorContext,
): Promise<PlatformCodAllocation> {
    return auditedDelegation(
        'agents.cod_threshold.set',
        context,
        { id: agentId, label: labelOf(before) },
        { maxThreshold },
        before,
        async () => {
            const result = await platformRequest<PlatformCodAllocation>({
                method: 'PUT',
                path: `/agents/${agentId}/cod-threshold`,
                body: { maxThreshold },
                actor: context.actor,
                requestId: context.requestId,
            });
            return result.data;
        },
    );
}

/**
 * The agent's COD pool and how much of it their contracts have claimed.
 *
 * `maxThreshold` is at the TOP level here, unlike the `cod.maxThreshold` on an agent — see
 * `asState`, which reads both.
 */
export interface PlatformCodAllocation {
    agentId: string;
    maxThreshold: number;
    allocated: number;
    headroom: number;
    contracts: unknown[];
}

/**
 * Ban and unban are two methods over ONE jovi-mall endpoint.
 *
 * The split is in this API's contract, not in the mechanism, and it is deliberate:
 * `PUT /ban { banned: boolean }` is a boolean standing in for a state (ADR-005 D-17) and
 * collapses two opposite acts under one audit label. Lifting a ban CLEARS the reason, the
 * timestamp and the actor stamp off the agent row, so the audit row is the only surviving
 * record that the ban happened — and it cannot be, if both directions share a name.
 */
export async function ban(
    agentId: string,
    reason: string,
    before: AgentSnapshot,
    context: ActorContext,
): Promise<PlatformAgent> {
    return auditedDelegation(
        'agents.ban',
        context,
        { id: agentId, label: labelOf(before) },
        { reason },
        before,
        async () => {
            const result = await platformRequest<PlatformAgent>({
                method: 'PUT',
                path: `/agents/${agentId}/ban`,
                body: { banned: true, reason },
                actor: context.actor,
                requestId: context.requestId,
            });
            return result.data;
        },
    );
}

export async function unban(
    agentId: string,
    before: AgentSnapshot,
    context: ActorContext,
): Promise<PlatformAgent> {
    return auditedDelegation(
        'agents.unban',
        context,
        { id: agentId, label: labelOf(before) },
        null,
        before,
        async () => {
            const result = await platformRequest<PlatformAgent>({
                method: 'PUT',
                path: `/agents/${agentId}/ban`,
                body: { banned: false },
                actor: context.actor,
                requestId: context.requestId,
            });
            return result.data;
        },
    );
}

/**
 * Move an agent from one agency to another.
 *
 * The only write here whose target is arguably the CONTRACT rather than the agent — and it
 * is filed under the agent anyway, because `AUDIT_TARGET_TYPES` has no contract type and
 * inventing one would need a `SUBJECT_CLASS` entry and a read-scoping decision for a
 * single action. The two agency ids ride in the payload, so the row is still complete.
 */
export async function transfer(
    input: { agentId: string; fromAgencyId: string; toAgencyId: string; reason: string },
    before: AgentSnapshot,
    context: ActorContext,
): Promise<unknown> {
    return auditedDelegation(
        'agents.transfer',
        context,
        { id: input.agentId, label: labelOf(before) },
        { fromAgencyId: input.fromAgencyId, toAgencyId: input.toAgencyId, reason: input.reason },
        before,
        async () => {
            const result = await platformRequest<unknown>({
                method: 'POST',
                path: '/agents/transfer',
                body: input,
                actor: context.actor,
                requestId: context.requestId,
            });
            return result.data;
        },
    );
}
