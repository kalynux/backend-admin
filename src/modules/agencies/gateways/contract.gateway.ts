import { platformRequest } from '../../../infra/platform/platform.client';
import { auditedAttempt } from '../../audit/domain/audit.writer';
import { ActorContext } from '../../audit/domain/audit-context';
import { AuditAction } from '../../audit/domain/audit.catalog';

/**
 * Administrative intervention on ONE agent↔agency contract, delegated to jovi-mall.
 *
 * ── What is offered, and what stays refused ──────────────────────────────────
 * Suspend, reinstate, terminate. NOT approve, NOT edit-terms, NOT the COD slice — and the
 * refusals are not the same argument as the offers.
 *
 * `agents.md` refuses contract writes on the grounds that "a live contract's terms change
 * by proposal between the two parties, never by edit". That is right, and it is an
 * argument about TERMS. A `terms_proposed_by: null` contract exists precisely because
 * nobody has stated any, so approving it binds an agent to a default that pays zero; and
 * rewriting an agreed fee split changes the number deliveries are being priced against
 * right now. Both stay refused.
 *
 * It is not an argument about freezing a relationship. An agency abusing an agent, or an
 * agent under investigation, is a situation an administrator should be able to stop
 * without transferring anybody — and `agencies.deactivate` already provides exactly that
 * lever one level up. The three verbs here invent no terms; they move a status.
 *
 * The COD slice is refused on a third ground again: `cod.threshold` is this contract's
 * share of a pool bounded across every allocating contract, `0` blocks all COD rather than
 * meaning "no limit", and the arithmetic that bounds it is `AgentCodThresholdService`'s.
 * It has its own endpoint, its own permission and its own `financial` flag.
 *
 * ── Why delegated ────────────────────────────────────────────────────────────
 * Each verb runs jovi-mall's own agency-scoped transition: the authority matrix, the legal
 * `from` states, the status-request row and the membership-event history are the same code
 * an agency desk runs. A second writer here would move `status` and produce none of it.
 */

/** The pre-write state, captured by the caller from its own direct read. */
export type ContractSnapshot = Record<string, unknown> | null;

function auditedDelegation<T>(
    action: AuditAction,
    context: ActorContext,
    target: { id: string; label: string | null },
    payload: Record<string, unknown> | null,
    before: ContractSnapshot,
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
            // The audit target vocabulary has no `contract` member, and the AGENT is the
            // right subject anyway: it is their livelihood these three verbs touch, and it
            // is the record a reviewer will search by. The contract id is in the payload.
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
 * jovi-mall's answer, reduced to the fields these verbs can move.
 *
 * ⚠ Terminate answers `{ contract, pendingRequest, blockers }` rather than a contract, so
 * the status is read through the nested shape as well as the flat one. Getting that wrong
 * is the DATA-EXPOSURE §3 defect verbatim — `asState` reading a field the response does
 * not carry, and every audit row silently recording `null` for the thing that changed.
 */
function asState(result: unknown): Record<string, unknown> | null {
    if (!result || typeof result !== 'object') return null;

    const answer = result as {
        status?: string;
        suspension_reason?: string | null;
        contract?: { status?: string; suspension_reason?: string | null } | null;
        blockers?: unknown;
    };
    const contract = answer.contract ?? answer;

    return {
        status: contract?.status ?? null,
        suspensionReason: contract?.suspension_reason ?? null,
        // Present only on terminate, and the honest record of a verb that did not complete:
        // `null` here means the contract moved, an object means it did not and why.
        terminationBlockers: answer.blockers ?? null,
        completed: answer.contract !== undefined ? answer.contract !== null : true,
    };
}

/**
 * What a contract looked like before the write.
 *
 * Deliberately the same keys `asState` derives its `after` from, so the two halves of a
 * diff line up — a `before` shaped differently from its `after` is a diff nobody can read.
 * Terms and money are absent because nothing here changes them, and a diff listing fields
 * that never move buries the one that did.
 */
export function contractAuditState(contract: {
    status?: string;
    suspension_reason?: string | null;
}): Record<string, unknown> {
    return {
        status: contract.status ?? null,
        suspensionReason: contract.suspension_reason ?? null,
        terminationBlockers: null,
        completed: true,
    };
}

/** Freeze it. Stops new assignments; terms and balances untouched. */
export async function suspend(
    contractId: string,
    agentId: string,
    reason: string,
    before: ContractSnapshot,
    context: ActorContext,
): Promise<unknown> {
    return auditedDelegation(
        'agents.contracts.suspend',
        context,
        { id: agentId, label: null },
        { contractId, reason },
        before,
        async () => {
            const result = await platformRequest<unknown>({
                method: 'POST',
                path: `/agents/contracts/${contractId}/suspend`,
                body: { reason },
                actor: context.actor,
                requestId: context.requestId,
            });
            return result.data;
        },
    );
}

/** Unfreeze it — back to `active` from `paused` or `suspended`. */
export async function reinstate(
    contractId: string,
    agentId: string,
    reason: string,
    before: ContractSnapshot,
    context: ActorContext,
): Promise<unknown> {
    return auditedDelegation(
        'agents.contracts.reinstate',
        context,
        { id: agentId, label: null },
        // The reason is required by this service and stored by neither: jovi-mall has no
        // column for a reinstatement reason. It lives in the audit row, which is where the
        // durable record of an administrator's intervention belongs anyway.
        { contractId, reason },
        before,
        async () => {
            const result = await platformRequest<unknown>({
                method: 'POST',
                path: `/agents/contracts/${contractId}/reinstate`,
                body: {},
                actor: context.actor,
                requestId: context.requestId,
            });
            return result.data;
        },
    );
}

/**
 * Ask to end it.
 *
 * ⚠ **Routinely does not end it, and the response says so.** Deactivation requires the
 * counterparty's agreement AND the outstanding COD and agent payment cleared. jovi-mall
 * answers with `contract: null` and a `pendingRequest` when those are not met, plus the
 * `blockers` that explain which.
 *
 * There is deliberately no override. Ending a relationship while it still owes an agent
 * money is how that money stops being anyone's responsibility, and an administrator is
 * exactly the party who could do it without either side noticing.
 */
export async function terminate(
    contractId: string,
    agentId: string,
    reason: string,
    before: ContractSnapshot,
    context: ActorContext,
): Promise<unknown> {
    return auditedDelegation(
        'agents.contracts.terminate',
        context,
        { id: agentId, label: null },
        { contractId, reason },
        before,
        async () => {
            const result = await platformRequest<unknown>({
                method: 'POST',
                path: `/agents/contracts/${contractId}/deactivate`,
                body: { reason },
                actor: context.actor,
                requestId: context.requestId,
            });
            return result.data;
        },
    );
}
