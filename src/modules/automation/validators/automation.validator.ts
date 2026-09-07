import { z } from 'zod';
import { AUTOMATION_CHANNELS, AUTOMATION_FAILURE_KINDS } from '../domain/automation.types';

/**
 * The body the n8n reporter posts.
 *
 * ── Everything optional except what identifies the report ─────────────────────
 * `workflowId` and `kind` are required because without them a row cannot be filed or
 * deduplicated. Everything else is nullable, and that is deliberate rather than lax: an
 * Error Trigger's payload varies by how the run died, and a strict schema would turn "n8n
 * gave us less detail than usual" into "the report was rejected" — losing the whole
 * incident to protect a field nobody reads.
 *
 * The reporter must never be able to make this 4xx for a reason it cannot fix.
 */
export const FailureReportSchema = z.object({
    workflowId: z.string().min(1).max(64),
    workflowName: z.string().max(200).nullish(),
    executionId: z.string().max(64).nullish(),
    kind: z.enum(AUTOMATION_FAILURE_KINDS),

    /**
     * When it happened, per the reporter. Optional — an absent value means "now", which is
     * within a second of the truth on this path and better than refusing the report.
     */
    occurredAt: z.string().datetime().nullish(),

    nodeName: z.string().max(200).nullish(),
    errorMessage: z.string().max(20_000).nullish(),
    errorStack: z.string().max(100_000).nullish(),

    channel: z.enum(AUTOMATION_CHANNELS).nullish(),
    /** RAW. Hashed in the repository and never stored — see the model header. */
    externalId: z.string().max(200).nullish(),
    requestId: z.string().max(128).nullish(),
});

export type FailureReportBody = z.infer<typeof FailureReportSchema>;

const MAX_WINDOW_HOURS = 24 * 30;

/**
 * The read query.
 *
 * `limit` is capped at 200 and there is no cursor, deliberately. This is a monitoring
 * surface, not an export: the useful question is "what is failing now", and a paging API
 * over telemetry with a 30-day TTL invites somebody to build a report on rows that vanish.
 */
export const FailureQuerySchema = z.object({
    workflowId: z.string().min(1).max(64).optional(),
    kind: z.enum(AUTOMATION_FAILURE_KINDS).optional(),
    channel: z.enum(AUTOMATION_CHANNELS).optional(),
    windowHours: z.coerce.number().int().min(1).max(MAX_WINDOW_HOURS).default(24),
    limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const FailureSummaryQuerySchema = z.object({
    windowHours: z.coerce.number().int().min(1).max(MAX_WINDOW_HOURS).default(24),
});
