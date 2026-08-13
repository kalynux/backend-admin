import { platformRequest } from '../../../infra/platform/platform.client';
import { ActorContext } from '../../audit/domain/audit-context';

/**
 * The READ half of the operations surface, over jovi-mall's internal admin API.
 *
 * ── Why this is a separate file from `dev-tools.gateway.ts` ───────────────────
 * That one is the **write** half, and every function in it calls `assertDevToolsEnabled()` and
 * wraps itself in `auditedAttempt()`. Putting reads in the same file invites the next author to
 * follow the pattern and add a flag check — or an audit row — to a GET. Reads are plain
 * `platformRequest`: no flag, no audit, exactly like the existing `listWorkers`.
 *
 * ── Why these are delegated at all ────────────────────────────────────────────
 * ADR-009 D-1 — delegate a verdict, read a record. Every answer here is a verdict about
 * jovi-mall's *process*: which cron tasks exist and whether one is mid-sweep, which Redis
 * connections are open, a private in-memory Prometheus registry, the effective maintenance mode
 * after expiry is applied. None of it is in a collection this service could read, and a
 * reimplementation would be a second opinion about another process's own state.
 *
 * ── The one place we deliberately keep BOTH paths ─────────────────────────────
 * `getQueues()` overlaps `OutboxReadRepository.summary()`, which reads `tracking_outbox`
 * directly out of `jovi_mall`. That redundancy is the feature, not an oversight: during a
 * jovi-mall incident — the exact moment an operator wants queue depth — this delegated call
 * returns 503 and the direct read still answers. Superseding `/system/outbox` would delete the
 * version that works when the platform is down. See ADR-014 D-6.
 */

async function read<T>(path: string, context: ActorContext): Promise<T> {
    const result = await platformRequest<T>({
        method: 'GET',
        path: `/system${path}`,
        actor: context.actor,
        requestId: context.requestId,
    });
    return result.data;
}

export interface DependencyReport {
    mongo: Record<string, unknown>;
    redis: Record<string, unknown>;
    maintenance: Record<string, unknown>;
}

export function getDependencies(context: ActorContext): Promise<DependencyReport> {
    return read<DependencyReport>('/dependencies', context);
}

export interface IntegrationsReport {
    integrations: Array<Record<string, unknown>>;
    googleCalendar: { connectedVendors: number; failingRefresh: number };
    rule: string;
}

/**
 * `probe` names the on-demand checks to run this request (`smtp`, `telegram`).
 *
 * They are opt-in on jovi-mall's side because they are safe but not free — an SMTP verify costs
 * a TCP+TLS handshake and some providers rate-limit auth attempts. Passing nothing is the
 * ordinary case and touches no third party at all.
 */
export function getIntegrations(context: ActorContext, probe: string[] = []): Promise<IntegrationsReport> {
    const query = probe.length > 0 ? `?probe=${encodeURIComponent(probe.join(','))}` : '';
    return read<IntegrationsReport>(`/integrations${query}`, context);
}

export interface QueuesReport {
    trackingOutbox: Record<string, unknown>;
    assignment: Record<string, unknown>;
    note: string;
}

export function getQueues(context: ActorContext): Promise<QueuesReport> {
    return read<QueuesReport>('/queues', context);
}

export interface CacheReport {
    available: boolean;
    reason: string | null;
    instance: Record<string, unknown> | null;
    databases: Array<Record<string, unknown>>;
    note: string;
}

export function getCache(context: ActorContext): Promise<CacheReport> {
    return read<CacheReport>('/cache', context);
}

export interface MetricsReport {
    collectedAt: string;
    registrySize: number;
    metrics: Array<{ name: string; help: string; type: string; values: unknown[] }>;
}

export function getMetrics(context: ActorContext): Promise<MetricsReport> {
    return read<MetricsReport>('/metrics', context);
}

export interface MaintenanceReport {
    storedMode: string;
    /** Differs from `storedMode` exactly when a window has passed its expiry. */
    effectiveMode: string;
    reason: string | null;
    blockWebhooks: boolean;
    pauseWorkers: boolean;
    startedAt: string | null;
    expiresAt: string | null;
    setBy: { id: string | null; name: string | null; source: string } | null;
}

export function getMaintenance(context: ActorContext): Promise<MaintenanceReport> {
    return read<MaintenanceReport>('/maintenance', context);
}

/**
 * The richer worker read, beside the compatibility one in `dev-tools.gateway.ts`.
 *
 * `listWorkers()` there hits `/dev-tools/workers` and returns the frozen four-field shape that
 * two call sites already depend on. This one hits `/system/workers` and returns all twelve
 * workers with three distinct booleans, structured schedules, `enabled` and
 * `pausedByMaintenance`. Both exist on purpose during the cutover; re-pointing the old callers
 * and retiring the compatibility read is a follow-up.
 */
export interface SystemWorkersReport {
    workers: Array<Record<string, unknown>>;
    scopeNote: string;
}

export function getWorkers(context: ActorContext): Promise<SystemWorkersReport> {
    return read<SystemWorkersReport>('/workers', context);
}

// ═══ Phase 15 ═════════════════════════════════════════════════════════════════

async function readWithQuery<T>(
    path: string,
    context: ActorContext,
    query: Record<string, string | number | boolean | undefined>,
): Promise<T> {
    const result = await platformRequest<T>({
        method: 'GET',
        path: `/system${path}`,
        actor: context.actor,
        requestId: context.requestId,
        query,
    });
    return result.data;
}

/**
 * The PLATFORM's runtime configuration.
 *
 * Distinct from `exposedConfig()`, which serves **this service's** own — hence the `service`
 * field on both responses and the `/system/platform/config` path. jovi-mall reproduces the whole
 * `FORBIDDEN_CONFIG_TOKEN` discipline on its side, including a boot assertion; ADR-014 named
 * that as the reason this read was not free.
 */
export interface PlatformConfigReport {
    service: string;
    entries: Array<{ key: string; value: string | number | boolean | null; set: boolean }>;
    wiring: Record<string, unknown>;
    note: string;
}

export function getPlatformConfig(context: ActorContext): Promise<PlatformConfigReport> {
    return read<PlatformConfigReport>('/config', context);
}

export interface PlatformLogsReport {
    sourceUsed: 'ring' | 'persisted';
    sourceReason: string | null;
    entries: Array<Record<string, unknown>>;
    nextBefore: string | null;
    meta: { persistence: Record<string, unknown>; ring: Record<string, unknown>; warning: string };
}

export function getPlatformLogs(
    context: ActorContext,
    query: Record<string, string | number | undefined>,
): Promise<PlatformLogsReport> {
    return readWithQuery<PlatformLogsReport>('/logs', context, query);
}

/**
 * The platform's error journal (Phase 16).
 *
 * `entries` is deliberately `unknown[]` at this seam: jovi-mall returns the FULL record
 * and the projection happens in the controller, keyed on the caller's tier. Typing it here
 * as the developer-grade view would make it too easy for a future call site to
 * `sendSuccess` it straight out and skip the sieve.
 */
export interface PlatformErrorsReport {
    sourceUsed: 'ring' | 'persisted';
    sourceReason: string | null;
    entries: unknown[];
    nextBefore: string | null;
    meta: { persistence: Record<string, unknown>; ring: Record<string, unknown>; warning: string };
}

export function getPlatformErrors(
    context: ActorContext,
    query: Record<string, string | number | undefined>,
): Promise<PlatformErrorsReport> {
    return readWithQuery<PlatformErrorsReport>('/errors', context, query);
}

export interface PlatformCacheKeysReport {
    available: boolean;
    reason: string | null;
    constant: string;
    matched: number;
    truncated: boolean;
    destructive: boolean;
    blastRadius: string;
    keys: Array<{ key: string; type: string | null; ttlMs: number | null; sizeBytes: number | null }>;
    note: string;
}

export function getPlatformCacheKeys(
    context: ActorContext,
    query: Record<string, string | number | boolean | undefined>,
): Promise<PlatformCacheKeysReport> {
    return readWithQuery<PlatformCacheKeysReport>('/cache/keys', context, query);
}

export interface PlatformDatabaseReport {
    database: string | null;
    collections: Array<Record<string, unknown>>;
    summary: Record<string, number>;
    truncated: boolean;
    notReached: string[];
    notes: string[];
}

export function getPlatformDatabase(
    context: ActorContext,
    query: Record<string, string | undefined>,
): Promise<PlatformDatabaseReport> {
    return readWithQuery<PlatformDatabaseReport>('/database', context, query);
}
