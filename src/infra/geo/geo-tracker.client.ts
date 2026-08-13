import axios, { AxiosInstance } from 'axios';
import { env } from '../../config/env';
import { PROM_TEXT_MAX_BYTES, ParsedPromText, parsePromText } from './prom-text';

/**
 * The ONLY door this service has into geo-tracker, and it is three unauthenticated paths wide.
 *
 * ── ADR-009 §D-2 still stands, and this is its named exception ────────────────
 * That decision says wi-admin has no geo-tracker door, because every geo-tracker **data** read
 * requires a real jovi-mall user JWT and resolves per-agent visibility by calling
 * `/api/tracking/visible-agents` *as the viewer* — which does a `findById` on `users`, and an
 * administrator deliberately has no `users` row.
 *
 * `/healthz`, `/readyz` and `/metrics` are different in kind: they need no identity, they are
 * service-level, and they expose **no agent position, no trail and no session content**.
 * `/healthz` returns the literal string `ok`; `/readyz` returns a map of dependency name → status;
 * `/metrics` returns aggregate counters. So D-2 reads, after Phase 15, as *"wi-admin has no
 * geo-tracker **data** door"* — and this is the boundary the next person asking for "just one
 * more geo-tracker endpoint" should be pointed at. See ADR-015 D-5.
 *
 * ── Deliberately NOT `platformRequest`, and not in `infra/platform/` ──────────
 * Different base URL, no auth, different failure semantics. Folding it into the platform client
 * would put a geo-tracker call one typo away from carrying `X-Service-Token` — a credential
 * scoped to a different service with a different blast radius.
 *
 * ── THE HARD RULE: this must never become a readiness dependency ──────────────
 * ADR-014 D-1's coupled-failure amplifier is one `Promise.all` away, and it is the exact mistake
 * that would look like a tidy-up in review. Three layers stop it:
 *
 *   1. it is not called from `/health/ready`, and `SystemController.health`'s `Promise.all` does
 *      not gain a fourth entry;
 *   2. **every function here returns a result object and never throws** — which is stronger than
 *      remembering not to call it, because a non-throwing client cannot propagate a failure into
 *      anything, however it is wired;
 *   3. `test:devtools` scans the source of `health.routes.ts` and `system.controller.ts` and
 *      fails if either mentions this module.
 */

/** The closed set of paths. A path is never built from request input. */
export const GEO_TRACKER_OPS_PATHS = Object.freeze(['/healthz', '/readyz', '/metrics'] as const);
export type GeoTrackerOpsPath = (typeof GEO_TRACKER_OPS_PATHS)[number];

/**
 * The instruments an operator actually reads, as an explicit projection.
 *
 * geo-tracker's registry is its own internal detail; pinning the subset here keeps adding or
 * renaming an instrument there a one-repo change instead of a broken dashboard. The cost is
 * stated in `prom-text.ts`: a new instrument is invisible until this list learns about it.
 */
export const GEO_TRACKER_METRIC_ALLOWLIST: readonly string[] = Object.freeze([
    'geotracker_websocket_connections_active',
    'geotracker_tracking_sessions_active',
    'geotracker_positions_ingested_total',
    'geotracker_webhook_requests_total',
    'geotracker_webhook_request_duration_seconds',
    'geotracker_authz_cache_hits_total',
    'geotracker_authz_cache_misses_total',
    'geotracker_node_api_requests_total',
    'geotracker_redis_errors_total',
    'geotracker_postgres_errors_total',
    'go_goroutines',
    'process_resident_memory_bytes',
]);

export interface GeoProbe {
    configured: boolean;
    reachable: boolean;
    status: number | null;
    latencyMs: number | null;
    error: string | null;
    /** `/readyz` returns a per-dependency map; `/healthz` returns a bare token. */
    body: unknown;
}

export interface GeoMetricsResult extends Omit<GeoProbe, 'body'> {
    metrics: ParsedPromText['metrics'];
    truncated: boolean;
    ignoredLines: number;
    allowlistSize: number;
}

let instance: AxiosInstance | null = null;

function client(): AxiosInstance | null {
    if (!env().GEO_TRACKER_OPS_BASE_URL) return null;
    if (instance) return instance;

    instance = axios.create({
        baseURL: env().GEO_TRACKER_OPS_BASE_URL,
        timeout: env().GEO_TRACKER_OPS_TIMEOUT_MS,
        // Bounded, because a passthrough of an unbounded body is one of the three reasons the
        // metrics response is parsed rather than forwarded.
        maxContentLength: PROM_TEXT_MAX_BYTES,
        maxBodyLength: PROM_TEXT_MAX_BYTES,
        // Every status is a result, never a rejection — see the hard rule above.
        validateStatus: () => true,
        // Prometheus text and geo-tracker's plain `ok` are both text; JSON is parsed by us.
        responseType: 'text',
        transformResponse: [(data: unknown) => data],
    });
    return instance;
}

export function isGeoTrackerOpsConfigured(): boolean {
    return Boolean(env().GEO_TRACKER_OPS_BASE_URL);
}

async function fetchPath(path: GeoTrackerOpsPath): Promise<{ probe: GeoProbe; raw: string }> {
    const unconfigured: GeoProbe = {
        configured: false,
        reachable: false,
        status: null,
        latencyMs: null,
        error: 'GEO_TRACKER_OPS_BASE_URL is not set — geo-tracker operations reads are inert.',
        body: null,
    };

    const http = client();
    if (!http) return { probe: unconfigured, raw: '' };

    const startedAt = Date.now();
    try {
        const response = await http.get(path);
        const raw = typeof response.data === 'string' ? response.data : String(response.data ?? '');
        return {
            probe: {
                configured: true,
                reachable: response.status >= 200 && response.status < 300,
                status: response.status,
                latencyMs: Date.now() - startedAt,
                error: response.status >= 300 ? `HTTP ${response.status}` : null,
                body: null,
            },
            raw,
        };
    } catch (error) {
        // Caught, never rethrown. A geo-tracker outage must not be able to fail a wi-admin read.
        return {
            probe: {
                configured: true,
                reachable: false,
                status: null,
                latencyMs: Date.now() - startedAt,
                error: error instanceof Error ? error.message : String(error),
                body: null,
            },
            raw: '',
        };
    }
}

/** `/healthz` — liveness. Unauthenticated and dependency-free on geo-tracker's side. */
export async function probeGeoHealth(): Promise<GeoProbe> {
    const { probe, raw } = await fetchPath('/healthz');
    return { ...probe, body: raw ? raw.trim().slice(0, 200) : null };
}

/** `/readyz` — per-dependency readiness (Redis, Postgres, and jovi-mall's frozen `/api/health`). */
export async function probeGeoReadiness(): Promise<GeoProbe> {
    const { probe, raw } = await fetchPath('/readyz');
    let body: unknown = raw ? raw.trim().slice(0, 2000) : null;
    try {
        if (raw.trim().startsWith('{')) body = JSON.parse(raw);
    } catch {
        // Keep the text. A body we cannot parse is still evidence.
    }
    return { ...probe, body };
}

export async function readGeoMetrics(): Promise<GeoMetricsResult> {
    const { probe, raw } = await fetchPath('/metrics');
    const parsed = parsePromText(raw, GEO_TRACKER_METRIC_ALLOWLIST);
    return {
        configured: probe.configured,
        reachable: probe.reachable,
        status: probe.status,
        latencyMs: probe.latencyMs,
        error: probe.error,
        metrics: parsed.metrics,
        truncated: parsed.truncated,
        ignoredLines: parsed.ignored,
        allowlistSize: GEO_TRACKER_METRIC_ALLOWLIST.length,
    };
}

/** Test-only. */
export function resetGeoTrackerClient(): void {
    instance = null;
}
