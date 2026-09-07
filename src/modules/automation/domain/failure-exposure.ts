import { AdminTier } from '../../admin-identity/domain/admin-identity.types';
import { AutomationFailureRecord } from './automation.types';

/**
 * What each rung of the ladder sees of a failure report.
 *
 * The shape is `system/domain/error-exposure.ts` applied to a narrower subject, and it is
 * the same shape for the same reason: three views answering ONE question at three depths,
 * so one route with a projection beats three routes a dashboard has to choose between
 * based on the caller's own level.
 *
 *   tier 1  Developer  everything, stack included — they are the person who fixes the node
 *   tier 2  Admin      which workflow, which node, what it said — enough to decide whether
 *                      this is an incident, without a stack trace they cannot act on
 *   tier 3  Support    that a channel is degraded and when — enough to tell a customer
 *                      "the bot is having trouble right now, we know"
 *
 * ── Why Support gets anything at all ──────────────────────────────────────────
 * The same argument that put `agents.tracking.read` on the Support grant. "The bot did not
 * reply to me" is a ticket, and an agent who cannot see that the automation layer was
 * degraded for twenty minutes escalates it to somebody who knows less about the ticket
 * than they do. What they must NOT get is the machine detail, which is not a secret so
 * much as a false lead: a stack trace in a support conversation produces a customer being
 * told something wrong with great confidence.
 *
 * ── What is withheld from EVERY tier ──────────────────────────────────────────
 * `externalIdHash` never leaves this function. It exists so an operator can count distinct
 * customers, which the summary does server-side; handing the digest out lets a caller
 * correlate a customer across reports, and nothing on this surface needs that.
 */

export interface ProjectedFailure {
    id: string;
    kind: AutomationFailureRecord['kind'];
    occurredAt: string;
    channel: AutomationFailureRecord['channel'];
    workflowName?: string | null;
    workflowId?: string;
    executionId?: string | null;
    nodeName?: string | null;
    errorMessage?: string | null;
    errorStack?: string | null;
    receivedAt?: string;
    requestId?: string | null;
}

export function projectFailureRecord(record: AutomationFailureRecord, tier: AdminTier): ProjectedFailure {
    // The floor: true of every rung, and deliberately free of any machine detail. A
    // channel and a timestamp say "the bot was unwell here, then" and nothing more.
    const base: ProjectedFailure = {
        id: record.id,
        kind: record.kind,
        occurredAt: record.occurredAt,
        channel: record.channel,
    };

    if (tier === 3) return base;

    const operational: ProjectedFailure = {
        ...base,
        workflowId: record.workflowId,
        workflowName: record.workflowName,
        executionId: record.executionId,
        nodeName: record.nodeName,
        errorMessage: record.errorMessage,
        receivedAt: record.receivedAt,
    };

    if (tier === 2) return operational;

    // Tier 1. The stack is the whole difference, and it is the reason this rung reuses
    // `developer_tools.logs.read` rather than holding a `system.*` name: a stack trace is
    // raw internal state, which is the boundary that family exists to mark.
    return {
        ...operational,
        errorStack: record.errorStack,
        requestId: record.requestId,
    };
}

/**
 * The rung, named in the response.
 *
 * Not decoration. Without it a Support agent reading a two-field row cannot tell "there is
 * nothing more to know" from "I am not being shown it", and escalates an incident that is
 * already understood — the same reasoning `SystemController.errors` states for its own
 * `view` field.
 */
export function viewForTier(tier: AdminTier): 'developer' | 'admin' | 'support' {
    return tier === 1 ? 'developer' : tier === 2 ? 'admin' : 'support';
}
