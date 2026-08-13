import { Request, Response } from 'express';
import { asyncHandler } from '../../../core/http/async-handler';
import { sendSuccess } from '../../../core/http/responses';
import { actorContextOf } from '../../audit/domain/audit-context';
import { FeatureFlagName } from '../domain/feature-flag.catalog';
import { listFlags, setFlag } from '../domain/feature-flag.service';
import * as gateway from '../gateways/dev-tools.gateway';
import {
    FlushCacheBody,
    PruneOutboxBody,
    ReplayOutboxBody,
    SetFeatureFlagBody,
    SetMaintenanceBody,
} from '../validators/dev-tools.validator';

/**
 * `/api/v1/dev-tools` — the operational surface, tier 1 only.
 *
 * Thin, like every controller here: the flag check lives in the gateway so a tool added
 * later cannot skip it, and the audit row is written at the transport boundary rather than
 * by each handler remembering.
 */
export class DevToolsController {
    /** GET /api/v1/dev-tools/feature-flags */
    static listFlags = asyncHandler(async (_req: Request, res: Response) => {
        sendSuccess(res, { flags: await listFlags() });
    });

    /** PUT /api/v1/dev-tools/feature-flags/:flag */
    static setFlag = asyncHandler(async (req: Request, res: Response) => {
        const context = actorContextOf(req);
        const body = req.body as SetFeatureFlagBody;

        const flag = await setFlag(
            req.params.flag as FeatureFlagName,
            body.enabled,
            body.reason,
            context.actor,
            context,
        );

        sendSuccess(res, flag, {
            // Said on the wire, not just in a docstring. An administrator turning something
            // off during an incident must know the other instances have not caught up yet.
            message: `"${flag.name}" is now ${flag.enabled ? 'on' : 'off'} on this instance. `
                + 'Other instances converge within the flag cache TTL.',
        });
    });

    /** GET /api/v1/dev-tools/workers */
    static listWorkers = asyncHandler(async (req: Request, res: Response) => {
        sendSuccess(res, await gateway.listWorkers(actorContextOf(req)));
    });

    /** POST /api/v1/dev-tools/workers/:workerKey/run */
    static runWorker = asyncHandler(async (req: Request, res: Response) => {
        const result = await gateway.runWorker(req.params.workerKey, actorContextOf(req));

        sendSuccess(res, result, {
            message: `Ran "${result.worker}" in ${result.durationMs}ms`,
        });
    });

    /** POST /api/v1/dev-tools/outbox/replay */
    static replayOutbox = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as ReplayOutboxBody;
        const result = await gateway.replayOutbox(body, actorContextOf(req));

        sendSuccess(res, result, {
            message: `${result.replayed} outbox row(s) queued for redelivery`,
        });
    });

    /**
     * POST /api/v1/dev-tools/outbox/prune
     *
     * The message leads with the dry run, exactly as `flushCache`'s does: an operator who cannot
     * tell at a glance whether anything was deleted will assume the worse of the two, and act on
     * that assumption.
     */
    static pruneOutbox = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as PruneOutboxBody;
        const result = await gateway.pruneOutbox(body, actorContextOf(req));

        const summary = result.dryRun
            ? `DRY RUN — ${result.matched} delivered row(s) older than ${result.olderThanDays} days matched; nothing was deleted`
            : `${result.deleted} delivered row(s) older than ${result.olderThanDays} days deleted`;

        sendSuccess(res, result, {
            message: result.truncated
                ? `${summary}. The limit was reached — run it again to continue.`
                : summary,
        });
    });

    /** POST /api/v1/dev-tools/catalogue/vectorise */
    static vectoriseCatalogue = asyncHandler(async (req: Request, res: Response) => {
        sendSuccess(res, await gateway.vectoriseCatalogue(actorContextOf(req)), {
            message: 'Catalogue search vectors rebuilt',
        });
    });

    /**
     * PUT /api/v1/dev-tools/maintenance
     *
     * The message states the convergence window jovi-mall reported, for the same reason
     * `setFlag` above does: an administrator opening a window during an incident must know the
     * other instances have not caught up yet.
     */
    static setMaintenance = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as SetMaintenanceBody;
        const result = await gateway.setMaintenance(body, actorContextOf(req));

        sendSuccess(res, result, {
            message: result.changed
                ? `Platform maintenance is now "${result.mode}" (was "${result.previousMode}"). `
                  + `Other jovi-mall instances converge within ${result.convergenceSeconds}s.`
                : `Platform maintenance was already "${result.mode}".`,
        });
    });

    /**
     * POST /api/v1/dev-tools/cache/flush
     *
     * The message leads with the dry-run state, because that is the thing an operator most
     * needs to notice — `dryRun` defaults to TRUE, so a first call reports what *would* go and
     * deletes nothing, and somebody expecting a flush needs to see that it did not happen.
     * Truncation is surfaced too: a partial scan that read as "done" would be the worst
     * possible outcome here.
     */
    static flushCache = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as FlushCacheBody;
        const result = await gateway.flushCache(body, actorContextOf(req));

        const summary = result.dryRun
            ? `DRY RUN — ${result.matched} key(s) matched in ${result.constant}; nothing was deleted`
            : `${result.deleted} key(s) deleted from ${result.constant}`;

        sendSuccess(res, result, {
            message: result.truncated
                ? `${summary}. Stopped at a bound — re-run to continue from cursor ${result.cursor}.`
                : summary,
        });
    });
}
