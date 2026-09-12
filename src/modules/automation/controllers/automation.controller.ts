import { Request, Response } from 'express';
import { asyncHandler } from '../../../core/http/async-handler';
import { sendSuccess } from '../../../core/http/responses';
import { createAppError } from '../../../core/errors/app-error';
import { ERROR_CODES } from '../../../core/errors/error-codes';
import { requireAdminIdentity } from '../../admin-identity/domain/admin-identity.types';
import { isAutomationDoorConfigured } from '../../../api/middlewares/service-token.middleware';
import { AutomationFailureRepository } from '../repositories/automation-failure.repository';
import { projectFailureRecord, viewForTier } from '../domain/failure-exposure';
import {
    FailureQuerySchema,
    FailureReportBody,
    FailureReportSchema,
    FailureSummaryQuerySchema,
} from '../validators/automation.validator';

const MS_PER_HOUR = 3_600_000;

/**
 * The reporter's body, or `400 AUTOMATION_REPORT_MALFORMED`.
 *
 * ── Why this is not just `Schema.parse()` ─────────────────────────────────────
 * A bare `parse` throws a `ZodError`, which the global handler renders as a generic
 * `400 VALIDATION_ERROR` — the same answer this service gives a dashboard that mistypes a
 * query string. That collapses the distinction `AUTOMATION_REPORT_MALFORMED` exists to
 * draw, and its registry entry states: the two ways this endpoint refuses have DIFFERENT
 * REMEDIES BY DIFFERENT PEOPLE. `AUTOMATION_REPORT_TOKEN_INVALID` is an operator's env
 * var; this one is the reporter workflow's node parameters. An operator reading a reporter
 * node's response body is the only audience either has, and "validation failed" sends them
 * to look at the wrong thing.
 *
 * ── It can only fire on two fields, and that is by design ─────────────────────
 * `FailureReportSchema` is deliberately permissive — everything but `workflowId` and `kind`
 * is nullish, because an Error Trigger's payload varies by how the run died and a strict
 * schema would turn "n8n gave us less detail than usual" into "the incident was lost". So
 * this is reachable only when the report cannot be filed or deduplicated at all. Keep it
 * that way: widening the schema's requirements widens this refusal, and the reporter must
 * never be able to make this 4xx for a reason it cannot fix.
 *
 * `fields` survives to the caller because a 400 is `validation`, not one of the two masked
 * categories — which is the point: the operator is told which node parameter to fix.
 */
function parseReportBody(body: unknown): FailureReportBody {
    const parsed = FailureReportSchema.safeParse(body);
    if (parsed.success) return parsed.data;

    throw createAppError(ERROR_CODES.AUTOMATION_REPORT_MALFORMED, 400, undefined, {
        fields: parsed.error.errors.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
            code: issue.code,
        })),
    });
}

export class AutomationController {
    /**
     * POST /api/internal/automation/failures — the machine door (ADR-022).
     *
     * ── It answers 200 to a duplicate, and that is not sloppiness ─────────────
     * An n8n retry re-posts a report this service already holds. Answering 409 would make
     * a reporter node that is behaving exactly as designed show up as a failing node —
     * and a monitoring system whose own reporter looks broken is worse than no monitoring
     * system, because it trains people to ignore it. The response says `duplicate: true`
     * so an operator reading the node's output can still tell what happened.
     *
     * ── No audit row ──────────────────────────────────────────────────────────
     * Declared `noAudit` and allowlisted. There is no administrator here, and an audit
     * trail defined as "every administrator action" cannot hold a row with no actor
     * without making its own central claim false. The report IS the durable record.
     */
    static report = asyncHandler(async (req: Request, res: Response) => {
        const body = parseReportBody(req.body);

        const result = await AutomationFailureRepository.record({
            workflowId: body.workflowId,
            workflowName: body.workflowName ?? null,
            executionId: body.executionId ?? null,
            kind: body.kind,
            occurredAt: body.occurredAt ? new Date(body.occurredAt) : new Date(),
            nodeName: body.nodeName ?? null,
            errorMessage: body.errorMessage ?? null,
            errorStack: body.errorStack ?? null,
            channel: body.channel ?? 'unknown',
            externalId: body.externalId ?? null,
            requestId: body.requestId ?? null,
        });

        sendSuccess(res, { recorded: true, id: result.id, duplicate: result.duplicate });
    });

    /**
     * GET /api/v1/automation/failures — the feed, GRADED BY TIER.
     *
     * One route, three answers, mirroring `SystemController.errors`. The route is reachable
     * by any of the three rungs and `projectFailureRecord` decides what comes back; see
     * `failure-exposure.ts` for what each sees and why.
     *
     * Unlike the error journal there is no per-row visibility filter and no query-narrowing
     * for tier 3. Both exist there because the subject is a customer's failed request, and
     * a scrollable feed of those is a different disclosure from any single one. The subject
     * here is a machine: every row is about the platform's own automation, so a Support
     * agent seeing all of them at the depth they are shown discloses nothing about anybody.
     */
    static failures = asyncHandler(async (req: Request, res: Response) => {
        const admin = requireAdminIdentity(req);
        const query = FailureQuerySchema.parse(req.query);

        const records = await AutomationFailureRepository.list({
            workflowId: query.workflowId,
            kind: query.kind,
            channel: query.channel,
            since: new Date(Date.now() - query.windowHours * MS_PER_HOUR),
            limit: query.limit,
        });

        sendSuccess(res, {
            configured: isAutomationDoorConfigured(),
            windowHours: query.windowHours,
            count: records.length,
            entries: records.map((record) => projectFailureRecord(record, admin.tier)),
            view: viewForTier(admin.tier),
        });
    });

    /**
     * GET /api/v1/automation/summary — counts by workflow, kind and channel.
     *
     * Same three permissions, and NOT tier-projected.
     *
     * ── Why, and it is NOT the reason this comment used to give ───────────────
     * It said "a count carries no machine detail and no identifier, so there is nothing to
     * withhold". That is true of `count` and `lastOccurredAt` and FALSE of the object they
     * sit in: every group carries `workflowId` and `workflowName`, which are exactly the
     * two fields `projectFailureRecord` withholds from tier 3. Both routes carry the same
     * `anyPermission` triple, so a Support administrator is refused a workflow name on the
     * feed and handed it here. The dashboard caught the contradiction (BR-020, 2026-09-09).
     *
     * The asymmetry is DELIBERATE, and the real reason is what the tier-3 boundary is for.
     * It is not confidentiality — `failure-exposure.ts` and ADR-022 D-7 both say what
     * Support is denied is machine detail "not a secret so much as a false lead". That
     * hazard is PER-INCIDENT CAUSAL ATTRIBUTION: an agent reading one row and telling a
     * customer their message failed because `sync identity` timed out. A summary cannot
     * produce that sentence — no node, no message, no stack, no per-incident row. Aggregate
     * identity is a weaker disclosure than per-incident identity, and "WhatsApp is degraded
     * right now, we know" is the exact statement D-7 grants Support this surface to make.
     *
     * So: the feed is graded, the summary is whole. If that is ever reversed, reverse it in
     * `automation.md`, in ADR-022 D-7, and in `test:automation` § 2b together — the shape is
     * pinned there precisely so it cannot drift back into being an accident.
     *
     * `distinctCustomers` is computed server-side from a hash the projection never emits —
     * the one thing that hash is for, and the one field here that IS withheld from everyone.
     *
     * ⚠ `configured: false` is the answer that matters most on this route. An empty summary
     * means either "nothing failed" or "no reporter is pointed at this deployment", and an
     * operator reading a clean board needs to know which — the same reason the geo-tracker
     * reads report `configured` rather than an empty body.
     */
    static summary = asyncHandler(async (req: Request, res: Response) => {
        const query = FailureSummaryQuerySchema.parse(req.query);
        const since = new Date(Date.now() - query.windowHours * MS_PER_HOUR);

        sendSuccess(res, {
            configured: isAutomationDoorConfigured(),
            windowHours: query.windowHours,
            since: since.toISOString(),
            groups: await AutomationFailureRepository.summary(since),
        });
    });
}
