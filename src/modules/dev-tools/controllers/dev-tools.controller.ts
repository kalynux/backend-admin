import { Request, Response } from 'express';
import { asyncHandler } from '../../../core/http/async-handler';
import { sendSuccess } from '../../../core/http/responses';
import { actorContextOf } from '../../audit/domain/audit-context';
import { FeatureFlagName } from '../domain/feature-flag.catalog';
import { listFlags, setFlag } from '../domain/feature-flag.service';
import { collectPaymentRoutingStats } from '../domain/payment-routing-stats';
import * as gateway from '../gateways/dev-tools.gateway';
import {
    FlushCacheBody,
    PaymentStatsQuery,
    PruneOutboxBody,
    ReplayOutboxBody,
    SetFeatureFlagBody,
    SetMaintenanceBody,
    SetPaymentSettingsBody,
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
     * GET /api/v1/dev-tools/payments
     *
     * jovi-mall's routing state beside this service's own per-aggregator outcomes. The two are
     * fetched in parallel and fail independently in one direction only: a platform too old to
     * have the route answers `platformSupported: false` with the stats intact, because the
     * stats are read here and still mean something. Any OTHER platform failure fails the
     * request — a screen that silently showed stats with no settings would invite a switch
     * decided on half the picture.
     */
    static getPaymentRouting = asyncHandler(async (req: Request, res: Response) => {
        const query = req.query as unknown as PaymentStatsQuery;
        const [state, stats] = await Promise.all([
            gateway.getPaymentSettings(actorContextOf(req)),
            collectPaymentRoutingStats(query.window ?? '24h'),
        ]);

        sendSuccess(res, {
            platformSupported: state !== null,
            settings: state?.settings ?? null,
            aggregators: state?.aggregators ?? [],
            effectiveProviders: state?.effectiveProviders ?? null,
            // Two classes, kept apart end to end: `errors` means payments are broken NOW (the
            // screen's red banner), `warnings` is a note on a working state.
            errors: state?.errors ?? [],
            warnings: state?.warnings ?? [],
            stats,
        }, state === null
            ? { message: 'jovi-mall predates payment routing — deploy it first. The outcomes below are still current.' }
            : undefined);
    });

    /**
     * PUT /api/v1/dev-tools/payments
     *
     * The message states the convergence window, as `setMaintenance`'s does, and leads with a
     * no-op when nothing changed: an operator who re-sends the current state during an incident
     * must not read "switched" and believe traffic moved.
     */
    static setPaymentRouting = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as SetPaymentSettingsBody;
        const result = await gateway.setPaymentSettings(body, actorContextOf(req));

        const summary = result.changed.length === 0
            ? 'Payment routing was already in that state — nothing changed.'
            : `Payment routing updated (${result.changed.join(', ')}). `
              + `Collections: ${result.settings.collectionAggregator}, payouts: ${result.settings.payoutAggregator}. `
              + (result.changed.includes('refundFeePercent') && result.settings.refundFeePercent !== undefined
                  ? `Refund fee: ${result.settings.refundFeePercent}% (new refund requests only). `
                  : '')
              + `Other jovi-mall instances converge within ${result.convergenceSeconds}s.`;

        sendSuccess(res, result, {
            message: result.warnings.length > 0
                ? `${summary} ${result.warnings.length} warning(s) — read them before leaving this screen.`
                : summary,
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
