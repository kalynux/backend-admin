import axios, { AxiosInstance } from 'axios';
import { env } from '../../config/env';

/**
 * The DATA door into geo-tracker — four reads, one credential, and a closed path set.
 *
 * ── This is the thing ADR-009 §D-2 said did not exist ─────────────────────────
 * That decision recorded "wi-admin has no geo-tracker data door" for three phases, because both
 * exits were structural: every geo-tracker data read resolved per-agent visibility by calling
 * `/api/tracking/visible-agents` **as the viewer**, which does a `findById` on `users`, and an
 * administrator deliberately has no `users` row. `admin/docs/ADR-020` amends it. geo-tracker
 * gained a **service-caller** authorization path — a second path, visibly separate in its source
 * — and this is the client of it. Administrators still get no platform identity.
 *
 * ── The sibling file is NOT this file, and the split is deliberate ────────────
 * `geo-tracker.client.ts` is the OPERATIONS door: `/healthz`, `/readyz`, `/metrics`, no identity,
 * no agent. Folding the two together would put a data call one typo away from being made with no
 * credential, and an ops call one typo away from carrying one. They also have different base-URL
 * variables, which is what lets a deployment take the operations reads and open no data door.
 *
 * ── THE HARD RULE, inherited verbatim: this must never become a readiness dependency ──
 * ADR-015 D-5's "the client can never throw" is not softened by this being a data door. ADR-020
 * D-2 constraint 4 restates it: a data door may fail a REQUEST, it may never fail the SERVICE.
 * So the same three layers hold:
 *
 *   1. it is not called from `/health/ready`, and `SystemController.health` does not touch it;
 *   2. **every function here returns a result object and never throws** — which is stronger than
 *      remembering not to call it, because a non-throwing client cannot propagate a failure into
 *      anything, however it is wired;
 *   3. `test:devtools` scans the source and fails on a `throw`, and on any mention of either geo
 *      client in the health route or the health controller.
 *
 * Turning an unreachable geo-tracker into a 502 is the CONTROLLER's job, not this file's. That
 * boundary is the difference between failing a request and failing the service.
 *
 * ── What it may never grow ────────────────────────────────────────────────────
 * A path built from request input. Every path here is assembled from a fixed template plus one
 * `encodeURIComponent`'d id, and the four templates are the whole surface. geo-tracker refuses
 * anything else anyway — there is no listing endpoint on that door — but the ceiling belongs on
 * both sides.
 */

/** The closed set of scopes geo-tracker grades this credential against. Documentation here. */
export const GEO_TRACKER_DATA_SCOPES = Object.freeze([
    'agent:presence',
    'agent:position',
    'shipment:trail',
    'shipment:events',
] as const);
export type GeoTrackerDataScope = (typeof GEO_TRACKER_DATA_SCOPES)[number];

/**
 * The two reads that put a person's location on the wire.
 *
 * Kept as a list rather than checked inline because three separate rules key off it — geo-tracker
 * demands a `reason`, this service writes an audit row BEFORE calling, and the dashboard must
 * render staleness — and a read added later that belongs here and is not listed would opt itself
 * out of all three.
 */
export const GEO_TRACKER_DISCLOSING_READS = Object.freeze(['position', 'trail'] as const);

export interface GeoDataResult<T> {
    configured: boolean;
    ok: boolean;
    status: number | null;
    latencyMs: number | null;
    /** geo-tracker's error code when it refused — e.g. `SERVICE_SCOPE_FORBIDDEN`. */
    code: string | null;
    error: string | null;
    data: T | null;
}

let instance: AxiosInstance | null = null;

function client(): AxiosInstance | null {
    if (!env().GEO_TRACKER_DATA_BASE_URL || !env().GEO_TRACKER_ADMIN_TOKEN) return null;
    if (instance) return instance;

    instance = axios.create({
        baseURL: env().GEO_TRACKER_DATA_BASE_URL,
        timeout: env().GEO_TRACKER_DATA_TIMEOUT_MS,
        headers: { Authorization: `Bearer ${env().GEO_TRACKER_ADMIN_TOKEN}` },
        // Every status is a result, never a rejection — see the hard rule above.
        validateStatus: () => true,
    });
    return instance;
}

export function isGeoTrackerDataConfigured(): boolean {
    return Boolean(env().GEO_TRACKER_DATA_BASE_URL && env().GEO_TRACKER_ADMIN_TOKEN);
}

/**
 * `actor` is the administrator's id, sent as `X-Admin-Actor`.
 *
 * ⚠ It is **advisory on both sides**. geo-tracker records it and never reads it for a decision,
 * because the credential authenticating this call is full-privilege — anyone holding it could set
 * the header. That is the same standing jovi-mall gives `X-Actor-Tier`, and ADR-020 D-2
 * constraint 3 requires it: the grading of WHICH administrator may ask happens here, in the
 * permission catalog and the tier grants, and nowhere in Go.
 *
 * `reason` is required by geo-tracker on the two disclosing reads and is sent on all four, so the
 * two services' logs line up on every call rather than only on the audited ones.
 */
export interface GeoDataCall {
    actor: string;
    reason: string;
}

/**
 * Ids that may be interpolated into a path.
 *
 * ⚠ `encodeURIComponent` is NOT sufficient on its own here, and this is the trap: it leaves `.`
 * untouched, so an id of `..` survives it intact and `/internal/agents/../../x/presence` resolves
 * to a different path before the request leaves this process. The allowlist is what closes it, and
 * it is stricter than either service needs — both sides address by ObjectId-shaped or UUID-shaped
 * ids, so a value outside this set is a bug rather than an unusual customer.
 */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

function rejectedId<T>(): GeoDataResult<T> {
    return {
        configured: true,
        ok: false,
        status: null,
        latencyMs: null,
        code: 'GEO_TRACKER_ID_REJECTED',
        error: 'The identifier is not in a form this client will place in a URL.',
        data: null,
    };
}

async function read<T>(path: string, call: GeoDataCall): Promise<GeoDataResult<T>> {
    const unconfigured: GeoDataResult<T> = {
        configured: false,
        ok: false,
        status: null,
        latencyMs: null,
        code: null,
        error:
            'GEO_TRACKER_DATA_BASE_URL / GEO_TRACKER_ADMIN_TOKEN are not set — '
            + 'live tracking reads are inert.',
        data: null,
    };

    const http = client();
    if (!http) return unconfigured;

    const startedAt = Date.now();
    try {
        const response = await http.get(path, {
            params: { reason: call.reason },
            headers: { 'X-Admin-Actor': call.actor },
        });
        const ok = response.status >= 200 && response.status < 300;
        const body = response.data as { error?: { code?: string; message?: string } } | undefined;

        return {
            configured: true,
            ok,
            status: response.status,
            latencyMs: Date.now() - startedAt,
            // geo-tracker speaks the shared error envelope (ADR-016), so its code survives the
            // hop and the dashboard can say WHY rather than "tracking unavailable".
            code: ok ? null : body?.error?.code ?? null,
            error: ok ? null : body?.error?.message ?? `HTTP ${response.status}`,
            data: ok ? (response.data as T) : null,
        };
    } catch (error) {
        // Caught, never rethrown. A geo-tracker outage must not be able to fail a wi-admin read.
        return {
            configured: true,
            ok: false,
            status: null,
            latencyMs: Date.now() - startedAt,
            code: null,
            error: error instanceof Error ? error.message : String(error),
            data: null,
        };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// The four reads. Shapes are geo-tracker's; see its `api-doc/service-data-door.md`.
// ─────────────────────────────────────────────────────────────────────────────

export interface GeoAgentPresence {
    agentId: string;
    connected: boolean;
    connectionId?: string;
    device: {
        locationEnabled?: boolean;
        locationPermissionGranted?: boolean;
        trackingEnabled?: boolean;
        lastSeenAt?: string;
    };
    trackingAllow: boolean;
    /** Whether a fix exists and how fresh — NEVER the fix itself. That is the other read. */
    positionKnown: boolean;
    positionAgeSeconds?: number;
    lastHeartbeatAt?: string;
    activeShipment: boolean;
    sessions: Array<{
        sessionId: string;
        shipmentId: string;
        state: string;
        tracking: boolean;
        connectionCount: number;
        startedAt: string;
        lastHeartbeatAt?: string;
    }>;
}

export interface GeoAgentPosition {
    agentId: string;
    trackingAllow: boolean;
    position: { latitude: number; longitude: number } | null;
    recordedAt: string | null;
    /**
     * The FACT, not a verdict. geo-tracker deliberately ships no `stale` boolean: this service
     * already owns a display threshold (`TRACKING_STATE_STALE_AFTER_MS`) and two definitions of
     * stale on one platform would drift.
     */
    ageSeconds: number | null;
    /** `'tracking_allow_off'`, or absent. Treat an unknown value as withheld and show nothing. */
    withheld?: string;
}

export interface GeoShipmentSession {
    sessionId: string;
    agentId: string;
    startedAt: string;
    endedAt: string | null;
    endReason?: string;
    terminalStatus?: string;
    terminalAt: string | null;
}

export interface GeoShipmentTrail {
    shipmentId: string;
    /** Plural: a reassigned delivery has one session per agent who carried it. */
    sessions: GeoShipmentSession[];
    checkpoints: Array<{
        sessionId: string;
        agentId: string;
        lat: number;
        lng: number;
        heading?: number;
        speed?: number;
        kind: string;
        recordedAt: string;
    }>;
    /** Never present a truncated trail as complete — a silent gap reads as a gap in the record. */
    truncated: boolean;
    limit: number;
}

export interface GeoShipmentEvents {
    shipmentId: string;
    sessions: GeoShipmentSession[];
    transitions: Array<{
        sessionId?: string;
        agentId: string;
        from: string;
        to: string;
        trigger: string;
        reason?: string;
        occurredAt: string;
    }>;
    connections: Array<{
        sessionId: string;
        connectionId: string;
        agentId: string;
        connectedAt: string;
        disconnectedAt: string | null;
        endReason?: string;
    }>;
    truncated: boolean;
    limit: number;
}

/** `agent:presence` — device, connection, sessions. No coordinates. Not audited. */
export function readAgentPresence(
    agentId: string,
    call: GeoDataCall,
): Promise<GeoDataResult<GeoAgentPresence>> {
    if (!SAFE_ID.test(agentId)) return Promise.resolve(rejectedId());
    return read(`/internal/agents/${encodeURIComponent(agentId)}/presence`, call);
}

/** `agent:position` — the live position. Audited by the caller, BEFORE this runs. */
export function readAgentPosition(
    agentId: string,
    call: GeoDataCall,
): Promise<GeoDataResult<GeoAgentPosition>> {
    if (!SAFE_ID.test(agentId)) return Promise.resolve(rejectedId());
    return read(`/internal/agents/${encodeURIComponent(agentId)}/position`, call);
}

/** `shipment:trail` — one delivery's GPS trail. Audited by the caller, BEFORE this runs. */
export function readShipmentTrail(
    shipmentId: string,
    call: GeoDataCall,
    limit?: number,
): Promise<GeoDataResult<GeoShipmentTrail>> {
    if (!SAFE_ID.test(shipmentId)) return Promise.resolve(rejectedId());
    // A NUMBER, coerced, never the raw query value — the one other thing on this door that
    // reaches a URL. geo-tracker ignores an out-of-range limit in favour of its own default, so
    // clamping here is about what leaves this process rather than about what it accepts.
    const query = Number.isInteger(limit) && (limit as number) > 0 ? `?limit=${Number(limit)}` : '';
    return read(`/internal/shipments/${encodeURIComponent(shipmentId)}/trail${query}`, call);
}

/** `shipment:events` — tracking events + connection log. No coordinates. Not audited. */
export function readShipmentEvents(
    shipmentId: string,
    call: GeoDataCall,
    limit?: number,
): Promise<GeoDataResult<GeoShipmentEvents>> {
    if (!SAFE_ID.test(shipmentId)) return Promise.resolve(rejectedId());
    const query = Number.isInteger(limit) && (limit as number) > 0 ? `?limit=${Number(limit)}` : '';
    return read(`/internal/shipments/${encodeURIComponent(shipmentId)}/events${query}`, call);
}

/** Test-only. */
export function resetGeoTrackerDataClient(): void {
    instance = null;
}
