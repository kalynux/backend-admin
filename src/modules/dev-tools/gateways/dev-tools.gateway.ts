import { AppError, createAppError } from '../../../core/errors/app-error';
import { ERROR_CODES } from '../../../core/errors/error-codes';
import { platformRequest } from '../../../infra/platform/platform.client';
import { auditedAttempt } from '../../audit/domain/audit.writer';
import { ActorContext } from '../../audit/domain/audit-context';
import { AuditAction } from '../../audit/domain/audit.catalog';
import { AuditIntent, AuditTarget } from '../../audit/domain/audit.types';
import { flagEnabled } from '../domain/feature-flag.service';

/**
 * The developer tools' WRITE half, reached over jovi-mall's internal admin API.
 *
 * ── Why every one of these is delegated ───────────────────────────────────────
 * The workers, the tracking outbox and the catalogue all live in jovi-mall's process. There
 * is nothing here wi-admin could do directly: triggering a worker means calling a method on
 * an object in another process, and replaying an outbox row means the dispatcher that owns
 * it must pick it up.
 *
 * ── The audit wrapper sits at the transport boundary ──────────────────────────
 * Same shape as `agent.gateway.ts` and every other gateway, for the same reason: this is
 * where the call leaves the service, so a method added later inherits auditing by
 * construction rather than by its author remembering. `delegated` transport, so intent →
 * outcome — a crash mid-flight leaves an `attempted` row naming what was about to run,
 * which for a destructive tool is exactly the row you want.
 */

/**
 * Every tool is behind `dev_tools.enabled`, which is OFF by default.
 *
 * The permission answers "may this person"; the flag answers "is this service accepting
 * these at all right now". Both, because the tools re-run side effects against live data
 * and the safe resting state for that is off — a capability available merely because it was
 * built is how one gets used during an incident by somebody guessing.
 *
 * Checked in the gateway rather than per route so a tool added later cannot forget it.
 */
async function assertDevToolsEnabled(): Promise<void> {
    if (await flagEnabled('dev_tools.enabled')) return;

    throw createAppError(
        ERROR_CODES.DEV_TOOLS_DISABLED,
        409,
        'Developer tools are switched off. Turn on the `dev_tools.enabled` feature flag first.',
    );
}

function auditedTool<T>(
    action: AuditAction,
    context: ActorContext,
    target: AuditTarget,
    payload: Record<string, unknown> | null,
    perform: () => Promise<T>,
): Promise<T> {
    return auditedAttempt(
        {
            action,
            actor: actorOf(context),
            target,
            context,
            payload,
        },
        async () => {
            const result = await perform();
            return { result, after: asState(result) };
        },
    );
}

function actorOf(context: ActorContext): AuditIntent['actor'] {
    return {
        kind: 'administrator',
        id: context.actor.adminId,
        email: context.actor.email,
        displayName: context.actor.displayName,
        tier: context.actor.tier,
        sessionId: context.actor.sessionId,
    };
}

/** Whatever the tool reported, flattened onto the row so the outcome is legible. */
function asState(result: unknown): Record<string, unknown> | null {
    if (!result || typeof result !== 'object') return null;
    return result as Record<string, unknown>;
}

export interface WorkerSummary {
    key: string;
    label: string;
    schedule: string;
    running: boolean;
}

export interface WorkerListResult {
    workers: WorkerSummary[];
    runningIsProcessLocal: boolean;
}

/** A read — no audit row, and no flag: knowing what exists is not running anything. */
export async function listWorkers(context: ActorContext): Promise<WorkerListResult> {
    const result = await platformRequest<WorkerListResult>({
        method: 'GET',
        path: '/dev-tools/workers',
        actor: context.actor,
        requestId: context.requestId,
    });
    return result.data;
}

export interface WorkerRunResult {
    worker: string;
    durationMs: number;
    /**
     * Did the sweep actually run, or did jovi-mall's overlap lock refuse it (F-19)?
     *
     * A refused trigger is a `200` — nothing failed, the work simply belongs to a pass already in
     * flight here or on another instance — so without this an operator reads the success `note`
     * and believes a sweep ran that did not.
     *
     * **Optional, and absence means `true`.** A jovi-mall predating the lock always ran, so
     * `result.ran !== false` is the correct reading and this is safe in either deploy order.
     */
    ran?: boolean;
    processed?: number;
    note?: string;
}

export async function runWorker(workerKey: string, context: ActorContext): Promise<WorkerRunResult> {
    await assertDevToolsEnabled();

    return auditedTool(
        'developer_tools.workers.trigger',
        context,
        { type: 'worker', id: workerKey, label: workerKey },
        { worker: workerKey },
        async () => {
            const result = await platformRequest<WorkerRunResult>({
                method: 'POST',
                path: `/dev-tools/workers/${workerKey}/run`,
                actor: context.actor,
                requestId: context.requestId,
            });
            return result.data;
        },
    );
}

export interface OutboxReplayResult {
    replayed: number;
    requested?: number;
    note?: string;
}

export async function replayOutbox(
    input: { limit?: number; eventIds?: string[] },
    context: ActorContext,
): Promise<OutboxReplayResult> {
    await assertDevToolsEnabled();

    return auditedTool(
        'developer_tools.outbox.replay',
        context,
        // No id: a replay acts on a SET chosen by a filter, not on one record. The filter
        // and the count are in the payload and the outcome, where they can be read.
        { type: 'none', id: null, label: null },
        { limit: input.limit ?? null, eventIds: input.eventIds ?? null },
        async () => {
            const result = await platformRequest<OutboxReplayResult>({
                method: 'POST',
                path: '/dev-tools/outbox/replay',
                body: input,
                actor: context.actor,
                requestId: context.requestId,
            });
            return result.data;
        },
    );
}

export interface OutboxPruneResult {
    status: string;
    olderThanDays: number;
    cutoff: string;
    dryRun: boolean;
    matched: number;
    deleted: number;
    truncated: boolean;
    oldestRemainingSentAt: string | null;
}

/**
 * Phase 15's one new dangerous verb.
 *
 * **Behind `dev_tools.enabled`, like `flushCache` and unlike `setMaintenance`.** The asymmetry is
 * the one ADR-014 D-7 states: an operator who cannot prune an outbox is inconvenienced, not
 * stuck, so there is no case for the carve-out that maintenance mode needs.
 *
 * jovi-mall re-validates every guard on its side and refuses `failed` and `pending` outright; the
 * `dryRun` default and the age floor live there too, so there is **one default in one place**.
 * Flattening its whole response onto the audit row means the matched/deleted counts and the
 * cutoff reach whoever reads the trail afterwards.
 */
export async function pruneOutbox(
    input: { olderThanDays: number; status: string; limit?: number; dryRun?: boolean; confirm: string },
    context: ActorContext,
): Promise<OutboxPruneResult> {
    await assertDevToolsEnabled();

    return auditedTool(
        'developer_tools.outbox.prune',
        context,
        // `none` for the same reason as replay and flush above: a filtered SET, not one record.
        { type: 'none', id: null, label: null },
        {
            olderThanDays: input.olderThanDays,
            status: input.status,
            limit: input.limit ?? null,
            // Recorded explicitly rather than inferred, so the trail distinguishes "they looked"
            // from "they deleted" without the reader having to know the default.
            dryRun: input.dryRun !== false,
        },
        async () => {
            const result = await platformRequest<OutboxPruneResult>({
                method: 'POST',
                path: '/dev-tools/outbox/prune',
                body: input,
                actor: context.actor,
                requestId: context.requestId,
            });
            return result.data;
        },
    );
}

export async function vectoriseCatalogue(context: ActorContext): Promise<Record<string, unknown>> {
    await assertDevToolsEnabled();

    return auditedTool(
        'developer_tools.catalogue.vectorise',
        context,
        { type: 'none', id: null, label: null },
        null,
        async () => {
            const result = await platformRequest<Record<string, unknown>>({
                method: 'POST',
                path: '/dev-tools/catalogue/vectorise',
                actor: context.actor,
                requestId: context.requestId,
            });
            return result.data;
        },
    );
}

// ═══ Phase 14 ═════════════════════════════════════════════════════════════════

export interface SetMaintenanceInput {
    mode: 'off' | 'readonly' | 'down';
    reason?: string;
    expiresInMinutes?: number;
    blockWebhooks?: boolean;
    pauseWorkers?: boolean;
}

export interface SetMaintenanceResult {
    changed: boolean;
    previousMode: string;
    mode: string;
    reason: string | null;
    blockWebhooks: boolean;
    pauseWorkers: boolean;
    startedAt: string | null;
    expiresAt: string | null;
    convergenceSeconds: number;
}

/**
 * Open or close a maintenance window on the platform.
 *
 * ── ⚠ THE ONE TOOL THAT DOES NOT CHECK `dev_tools.enabled` ────────────────────
 * Every other function in this file calls `assertDevToolsEnabled()` first, and that flag is OFF
 * by default. Applying it here would produce two failures that are worse than the risk it
 * guards against:
 *
 *   1. During an incident, an operator could not put the platform into maintenance without
 *      first finding and flipping an unrelated feature flag.
 *   2. Worse — if anyone turned `dev_tools.enabled` off while a window was open, **the exit
 *      would be locked.** The only way back would be a redeploy or a hand-written Mongo update
 *      against jovi-mall's `system_state` collection.
 *
 * This is the same carve-out the feature-flag routes already take, for the identical reason
 * stated at `dev-tools.routes.ts`: *"that would be a switch that turns off its own switch."*
 *
 * Everything else still applies — `developer_tools.maintenance.set` is `destructive` and
 * tier-1-only, and every call writes an audit row with intent and outcome.
 */
export async function setMaintenance(
    input: SetMaintenanceInput,
    context: ActorContext,
): Promise<SetMaintenanceResult> {
    return auditedTool(
        'developer_tools.maintenance.set',
        context,
        // A real target type rather than `none`: this is the single most consequential thing an
        // operator can do to the platform, and the trail should say so by name.
        { type: 'maintenance_window', id: input.mode, label: `maintenance: ${input.mode}` },
        {
            mode: input.mode,
            reason: input.reason ?? null,
            expiresInMinutes: input.expiresInMinutes ?? null,
            blockWebhooks: input.blockWebhooks ?? null,
            pauseWorkers: input.pauseWorkers ?? null,
        },
        async () => {
            const result = await platformRequest<SetMaintenanceResult>({
                method: 'PUT',
                path: '/dev-tools/maintenance',
                body: input,
                actor: context.actor,
                requestId: context.requestId,
            });
            return result.data;
        },
    );
}

// ═══ Payment routing (jovi-mall ADR-A08) ══════════════════════════════════════
//
// Contract: `jovi-mall/api-doc/payments/routing.md` § Administrator surface. Shapes below are
// that document's, camelCase as jovi-mall serves them.

export interface PaymentSettingsView {
    collectionAggregator: string;
    payoutAggregator: string;
    stripeEnabled: boolean;
    /**
     * The refund transfer fee in percent (0–20, default 2; REFUND-FLOW-PLAN R-3). Optional in the
     * type only because a jovi-mall older than the refund flow sends no such key.
     */
    refundFeePercent?: number;
    providers: Record<string, { enabled: boolean }>;
    version: number;
    updatedAt: string | null;
    updatedBy: { id: string; name: string } | null;
    reason: string | null;
}

/**
 * One hard error or soft warning from jovi-mall's `validateSettingsChange`.
 *
 * `code` is an OPEN string, deliberately not a union of today's twelve. jovi-mall owns the rules
 * and adds to them (`NO_MOBILE_PROVIDER_ENABLED` arrived while this was being written); an
 * exhaustive copy here would be a second list that drifts. Show `code` and `message` as given.
 */
export interface PaymentSettingsIssue {
    code: string;
    message: string;
    provider?: string;
    aggregator?: string;
}

export interface PaymentAggregatorFacts {
    name: string;
    configured: boolean;
    capabilities: Record<string, unknown>;
    payoutImplemented: boolean;
    payoutAvailable: boolean;
    refundAvailable: boolean;
    activeForCollections: boolean;
    activeForPayouts: boolean;
}

export interface PaymentRoutingState {
    settings: PaymentSettingsView;
    aggregators: PaymentAggregatorFacts[];
    effectiveProviders: unknown;
    /**
     * The STORED settings now break a hard rule — credentials removed after a switch, say. New
     * charges are being refused right now. A different class from `warnings`, and shown as such.
     *
     * Optional in the type because a jovi-mall between cd9f7a3 and 0b58bb7 sent no such key;
     * the controller defaults it to `[]`.
     */
    errors?: PaymentSettingsIssue[];
    /** Soft problems on an otherwise valid stored state. Empty while `errors` is non-empty. */
    warnings: PaymentSettingsIssue[];
}

export interface SetPaymentSettingsInput {
    collectionAggregator?: string;
    payoutAggregator?: string;
    stripeEnabled?: boolean;
    refundFeePercent?: number;
    providers?: Record<string, { enabled: boolean }>;
    expectedVersion: number;
    reason: string;
}

export interface SetPaymentSettingsResult {
    previous: PaymentSettingsView;
    settings: PaymentSettingsView;
    /** Top-level settings keys whose value differs. Empty means nothing changed. */
    changed: string[];
    warnings: PaymentSettingsIssue[];
    convergenceSeconds: number;
}

/**
 * Is this jovi-mall's catch-all 404 — "no route matches" — rather than a real answer?
 *
 * Matched on the PAIR, never the status alone. `toAppError` forwards jovi-mall's status and puts
 * its code in `details.platformCode`; the catch-all in jovi-mall's `app.ts` raises `NOT_FOUND`.
 * A newer jovi-mall that serves the route and answers some other 404 must not be read as "too
 * old", so a 404 with any other platform code passes through untouched.
 *
 * Exported for `test-devtools.ts`.
 */
export function isPlatformRouteMissing(error: unknown): boolean {
    return error instanceof AppError
        && error.code === ERROR_CODES.PLATFORM_OPERATION_REJECTED
        && error.statusCode === 404
        && error.details?.platformCode === 'NOT_FOUND';
}

/**
 * The refusal a write gets from a jovi-mall that predates payment routing.
 *
 * **422 `PLATFORM_OPERATION_REJECTED`, not 503 `SERVICE_DEPENDENCY_UNAVAILABLE`.** A 503
 * derives to `external_service`, and the error boundary replaces an `external_service` message
 * with the registry default and drops its details *in every environment* (ADR-016). The operator
 * would read "A required dependency is unavailable" — which sends them to check whether jovi-mall
 * is up, when it is up and simply older than this service. 422 derives to `business_rule`, which
 * survives the boundary, so the actual instruction arrives: deploy jovi-mall first.
 *
 * Exported for `test-devtools.ts`.
 */
export function platformTooOldError(): AppError {
    return createAppError(
        ERROR_CODES.PLATFORM_OPERATION_REJECTED,
        422,
        'jovi-mall predates payment routing and has no settings to change. Deploy jovi-mall first — '
            + 'nothing was switched.',
        { platformCode: 'NOT_FOUND', platformSupported: false },
    );
}

/**
 * Read the routing settings and per-aggregator facts. A read: no audit row, no flag.
 *
 * `null` means the platform is too old to have them. The caller renders that as a state rather
 * than an error, because the stats beside it are computed here and still mean something.
 */
export async function getPaymentSettings(context: ActorContext): Promise<PaymentRoutingState | null> {
    try {
        const result = await platformRequest<PaymentRoutingState>({
            method: 'GET',
            path: '/dev-tools/payments',
            actor: context.actor,
            requestId: context.requestId,
        });
        return result.data;
    } catch (error) {
        if (isPlatformRouteMissing(error)) return null;
        throw error;
    }
}

/**
 * Switch payment routing — the collection aggregator, the payout aggregator, Stripe, or which
 * providers are offered.
 *
 * ── ⚠ NOT BEHIND `dev_tools.enabled`, for the `setMaintenance` reason ─────────
 * Owner decision 5 (ADR-A08), and ADR-014 D-7's argument applied to money: this switch exists for
 * an aggregator outage, which is precisely when an operator must not first have to find and flip
 * an unrelated flag — and a flag somebody turned off would lock the platform onto a dead
 * aggregator. The tier-1 `destructive` permission and the fail-closed audit row still apply.
 * `test-devtools.ts` pins the absence at the source.
 *
 * ── The before/after come from jovi-mall's compare-and-set, never from a GET here ──
 * `previous` is what the write actually replaced and `settings` what it wrote. Reading first
 * would race a second operator and record a diff against a state that never existed.
 *
 * ── A 404 is "platform too old", never success ────────────────────────────────
 * The intent row is already committed by then, and the outcome stamp records the refusal.
 */
export async function setPaymentSettings(
    input: SetPaymentSettingsInput,
    context: ActorContext,
): Promise<SetPaymentSettingsResult> {
    return auditedAttempt(
        {
            action: 'developer_tools.payments.set',
            actor: actorOf(context),
            target: { type: 'payment_settings', id: 'payments', label: 'payment routing' },
            context,
            payload: {
                collectionAggregator: input.collectionAggregator ?? null,
                payoutAggregator: input.payoutAggregator ?? null,
                stripeEnabled: input.stripeEnabled ?? null,
                refundFeePercent: input.refundFeePercent ?? null,
                providers: input.providers ?? null,
                expectedVersion: input.expectedVersion,
                reason: input.reason,
            },
        },
        async () => {
            let result: SetPaymentSettingsResult;
            try {
                result = (await platformRequest<SetPaymentSettingsResult>({
                    method: 'PUT',
                    path: '/dev-tools/payments',
                    body: input,
                    actor: context.actor,
                    requestId: context.requestId,
                })).data;
            } catch (error) {
                if (isPlatformRouteMissing(error)) throw platformTooOldError();
                throw error;
            }

            return {
                result,
                before: { ...result.previous },
                after: {
                    ...result.settings,
                    changed: result.changed,
                    warnings: result.warnings,
                    convergenceSeconds: result.convergenceSeconds,
                },
            };
        },
    );
}

export interface FlushCacheInput {
    db: string;
    prefix?: string;
    limit?: number;
    dryRun?: boolean;
    confirm: string;
}

export interface FlushCacheResult {
    db: number;
    constant: string;
    match: string;
    dryRun: boolean;
    matched: number;
    deleted: number;
    truncated: boolean;
    cursor: string;
    sample: string[];
    /** jovi-mall's own statement of what these keys were for. Lands in the audit row. */
    blastRadius: string;
    destructive: boolean;
}

/**
 * Delete cached keys from one named Redis database on the platform.
 *
 * Behind the flag, like every other tool: unlike maintenance mode, an operator who cannot flush
 * a cache is inconvenienced rather than locked out of anything.
 *
 * The interesting property is that the outcome — including jovi-mall's `blastRadius` note, the
 * match and delete counts, and whether the scan was truncated — is flattened onto the audit row
 * by `asState`. So the trail records not just that somebody cleared a cache but *which* keys
 * were at stake and what clearing them meant, which is the part a later investigation needs.
 *
 * jovi-mall re-validates everything this sends: `dryRun` defaults true there, the whole-database
 * flush is refused on the three destructive databases, and the prefix is escaped so it cannot be
 * a pattern. This service's copy of the schema exists to give a good 400 before the network hop,
 * never to be the only check.
 */
export async function flushCache(
    input: FlushCacheInput,
    context: ActorContext,
): Promise<FlushCacheResult> {
    await assertDevToolsEnabled();

    return auditedTool(
        'developer_tools.cache.flush',
        context,
        // A flush acts on a SET chosen by a filter, not one record — same reasoning as
        // `outbox.replay`. The database and prefix are in the payload, where they read properly.
        { type: 'none', id: null, label: null },
        {
            db: input.db,
            prefix: input.prefix ?? null,
            limit: input.limit ?? null,
            dryRun: input.dryRun !== false,
        },
        async () => {
            const result = await platformRequest<FlushCacheResult>({
                method: 'POST',
                path: '/dev-tools/cache/flush',
                body: input,
                actor: context.actor,
                requestId: context.requestId,
            });
            return result.data;
        },
    );
}
