/**
 * What the automation layer can report, and what a stored failure row holds.
 *
 * ── Why there are two kinds and not one ───────────────────────────────────────
 * The incident that produced this module is the reason. On 2026-09-07 jovi-mall was down,
 * a customer messaged the bot, and Meta refused the outgoing reply with an expired token.
 * n8n recorded all three executions as `success`.
 *
 * That is not a bug in n8n. `wi-mall-core` carries fifteen error-swallowing nodes — every
 * HTTP node has `neverError: true`, and the nodes that can fail structurally use
 * `continueErrorOutput` — because the design goal is that a customer always gets an
 * answer. The workflow is built never to fail, so **execution status alone is not a
 * failure signal on this platform**, and a monitor built on it would have shown a clean
 * board through the entire incident.
 *
 * So a report arrives by one of two routes, and both are needed:
 *
 *   `execution_failed`  n8n's own Error Trigger fired — something threw and the run died.
 *                       Rare by construction, and now genuinely meaningful because the two
 *                       send nodes no longer swallow a refused send.
 *
 *   `degraded_turn`     The run SUCCEEDED and the customer still got a worse answer than
 *                       they should have: a fallback branch ran because jovi-mall could not
 *                       be reached or the model did not answer. Nothing in n8n's own data
 *                       model records this, which is exactly why it is reported explicitly.
 */

export const AUTOMATION_FAILURE_KINDS = ['execution_failed', 'degraded_turn'] as const;
export type AutomationFailureKind = (typeof AUTOMATION_FAILURE_KINDS)[number];

/**
 * The channel a degraded turn happened on. `unknown` is honest rather than defensive:
 * an `execution_failed` report from the Error Trigger has no envelope to read a channel
 * from, and guessing one would put a fact in the row that nobody established.
 */
export const AUTOMATION_CHANNELS = ['telegram', 'whatsapp', 'unknown'] as const;
export type AutomationChannel = (typeof AUTOMATION_CHANNELS)[number];

/** The shape the read surface deals in, before tier projection. */
export interface AutomationFailureRecord {
    id: string;
    workflowId: string;
    workflowName: string | null;
    executionId: string | null;
    kind: AutomationFailureKind;
    occurredAt: string;
    receivedAt: string;
    nodeName: string | null;
    errorMessage: string | null;
    errorStack: string | null;
    channel: AutomationChannel;
    externalIdHash: string | null;
    requestId: string | null;
}
