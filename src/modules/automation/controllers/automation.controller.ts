import { Request, Response } from 'express';
import { asyncHandler } from '../../../core/http/async-handler';
import { sendSuccess } from '../../../core/http/responses';
import { requireAdminIdentity } from '../../admin-identity/domain/admin-identity.types';
import { isAutomationDoorConfigured } from '../../../api/middlewares/service-token.middleware';
import { AutomationFailureRepository } from '../repositories/automation-failure.repository';
import { projectFailureRecord, viewForTier } from '../domain/failure-exposure';
import {
    FailureQuerySchema,
    FailureReportSchema,
    FailureSummaryQuerySchema,
} from '../validators/automation.validator';

const MS_PER_HOUR = 3_600_000;

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
        const body = FailureReportSchema.parse(req.body);

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
     * Same three permissions, and NOT tier-projected: a count carries no machine detail
     * and no identifier, so there is nothing to withhold. `distinctCustomers` is computed
     * server-side from a hash the projection never emits — the one thing that hash is for.
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
