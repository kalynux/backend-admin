import axios, { AxiosError, AxiosInstance, Method } from 'axios';
import { Transform } from 'stream';
import { env } from '../../config/env';
import { logger, requestLogger } from '../../core/logging/logger';
import { createAppError } from '../../core/errors/app-error';
import { ERROR_CODES } from '../../core/errors/error-codes';
import { CLIENT_SAFE_CATEGORIES, ErrorCategory } from '../../core/errors/error-category';
import { AdminIdentity } from '../../modules/admin-identity/domain/admin-identity.types';

/**
 * HTTP client for jovi-mall — the platform service.
 *
 * Why this exists at all, given both services share a database: the business logic behind
 * the admin surface is overwhelmingly shared with the vendor, agency, agent and customer
 * paths, and five background workers. Reimplementing FIFO cash settlement or escrow
 * release here would be a second copy of the invariants. So this service reaches that
 * logic over `/api/internal/admin/*` and lets jovi-mall execute it — which also means
 * jovi-mall's in-process domain-event subscribers fire naturally, which no amount of
 * careful direct-database writing would achieve.
 *
 * That is ADR-004 D-2 in one sentence: **admin reads `jovi_mall` directly where it needs
 * to, and writes it only through here.**
 *
 * INERT WHEN UNCONFIGURED. With `JOVI_MALL_BASE_URL` unset there is no client, readiness
 * reports `not_configured`, and a delegated route answers 503 — the same convention
 * jovi-mall itself uses for an unset `GEO_TRACKER_BASE_URL`. Phase 4 kept the variable
 * optional so the service still boots for local work on the domains that do not need it;
 * Phase 5 makes it required, when most of the surface does.
 */

let instance: AxiosInstance | null = null;

export function isPlatformConfigured(): boolean {
    return Boolean(env().JOVI_MALL_BASE_URL);
}

function client(): AxiosInstance | null {
    if (!isPlatformConfigured()) return null;
    if (instance) return instance;

    const config = env();
    instance = axios.create({
        baseURL: config.JOVI_MALL_BASE_URL,
        timeout: config.JOVI_MALL_TIMEOUT_MS,
        headers: {
            'Content-Type': 'application/json',
            // jovi-mall's service-token guard reads this. It is never logged: the
            // redaction list covers `req.headers["x-service-token"]` and `*.serviceToken`.
            ...(config.JOVI_MALL_SERVICE_TOKEN ? { 'X-Service-Token': config.JOVI_MALL_SERVICE_TOKEN } : {}),
        },
    });

    return instance;
}

/*
 * `platformClientFor(requestId)` used to live here, mutating
 * `defaults.headers.common['X-Request-Id']` on the shared Axios instance. It was deleted
 * in Phase 3.5, for two reasons: it had zero callers, and mutating a shared instance's
 * default headers is a race — two concurrent requests would stamp each other's
 * correlation id, which is precisely the value the audit trail joins on.
 *
 * `platformRequest` below sets the actor and correlation headers PER CALL, so the
 * correlation id already reaches jovi-mall correctly on every delegated request, and
 * jovi-mall's own `requestIdMiddleware` adopts it verbatim.
 */

export interface PlatformPingResult {
    configured: boolean;
    ok: boolean;
    durationMs: number;
    error?: string;
}

/**
 * Reachability probe against jovi-mall's public health endpoint (`GET /api/health`),
 * which needs no authentication. It proves the host is up and routable; it does not
 * prove the internal admin API exists — that arrives in Phase 4 and gets its own check.
 */
export async function pingPlatform(): Promise<PlatformPingResult> {
    const startedAt = Date.now();
    const http = client();

    if (!http) {
        return { configured: false, ok: false, durationMs: 0 };
    }

    try {
        await http.get('/api/health');
        return { configured: true, ok: true, durationMs: Date.now() - startedAt };
    } catch (error) {
        const message = axios.isAxiosError(error) ? error.message : String(error);
        logger().warn({ err: message }, 'jovi-mall reachability check failed');
        return { configured: true, ok: false, durationMs: Date.now() - startedAt, error: message };
    }
}

/** Test-only: drop the memoized instance so a new environment takes effect. */
export function resetPlatformClient(): void {
    instance = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// The operation layer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Headers that carry the acting administrator across the boundary.
 *
 * jovi-mall's `requireAdminCaller` builds its whole `req.auth` from these and reads no
 * database — see ADR-004 D-1. `X-Actor-Id` is the **wi-admin** `admin_accounts._id`: it
 * lands in columns declared `ref: MODELS.USER` that will never resolve, which is a
 * decision (nothing populates them) rather than an oversight.
 */
export const ACTOR_HEADERS = {
    ID: 'X-Actor-Id',
    NAME: 'X-Actor-Name',
    /**
     * Advisory only. jovi-mall logs it and does NOT authorize on it — authorization is
     * resolved here, before delegation, and stays single-sided (ADR-003:125-128).
     */
    TIER: 'X-Actor-Tier',
    REQUEST_ID: 'X-Request-Id',
} as const;

export function actorHeaders(actor: AdminIdentity, requestId: string): Record<string, string> {
    return {
        [ACTOR_HEADERS.ID]: actor.adminId,
        [ACTOR_HEADERS.NAME]: actor.displayName,
        [ACTOR_HEADERS.TIER]: String(actor.tier),
        [ACTOR_HEADERS.REQUEST_ID]: requestId,
    };
}

export interface PlatformRequest {
    method: Method;
    /** Path BELOW the internal admin mount, e.g. `/cod/remittances/:id/confirm`. */
    path: string;
    actor: AdminIdentity;
    requestId: string;
    body?: unknown;
    query?: Record<string, string | number | boolean | undefined>;
}

/** jovi-mall's error envelope — byte-identical to this service's, deliberately. */
interface PlatformErrorBody {
    success: false;
    requestId?: string;
    error?: {
        code?: string;
        message?: string;
        statusCode?: number;
        /**
         * jovi-mall's Phase-16 taxonomy value. OPTIONAL, and its absence is meaningful:
         * a jovi-mall that predates Phase 16 sends no category, and `toAppError` then
         * forwards no `details` at all — failing closed on a service whose exposure
         * rules we cannot read.
         */
        category?: string;
        details?: Record<string, unknown>;
    };
}

const INTERNAL_ADMIN_PREFIX = '/api/internal/admin';

/**
 * Retry only what is safe to repeat.
 *
 * jovi-mall has no idempotency keys, and its write paths are transactional with
 * post-commit side effects — a retried `confirm` would settle a remittance twice and emit
 * its event twice. A read costs nothing to repeat, so reads retry once on a transport
 * failure and writes never do.
 */
const RETRYABLE_METHODS = new Set(['GET', 'HEAD']);
const RETRY_ATTEMPTS = 2;

/**
 * Call an operation on jovi-mall's internal admin API as the given administrator.
 *
 * Returns the `data` payload from jovi-mall's success envelope. Throws an `AppError`
 * carrying jovi-mall's own error code and status — the two services share an envelope, so
 * a downstream 409 reaches the dashboard as a 409 with its original code rather than as an
 * opaque 502.
 */
export async function platformRequest<T>(request: PlatformRequest): Promise<{ data: T; meta?: unknown }> {
    const http = client();

    if (!http) {
        // Accurate rather than convenient: the endpoint exists and the caller was
        // authorized, but the service that owns the data is not configured.
        throw createAppError(
            ERROR_CODES.SERVICE_DEPENDENCY_UNAVAILABLE,
            503,
            'This operation is served by jovi-mall, which is not configured (JOVI_MALL_BASE_URL)',
        );
    }

    const method = String(request.method).toUpperCase();
    const attempts = RETRYABLE_METHODS.has(method) ? RETRY_ATTEMPTS : 1;

    let lastTransportError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            const response = await http.request({
                method: request.method,
                url: `${INTERNAL_ADMIN_PREFIX}${request.path}`,
                params: request.query,
                data: request.body,
                headers: actorHeaders(request.actor, request.requestId),
            });

            const payload = response.data as { data?: T; meta?: unknown };
            return { data: payload?.data as T, meta: payload?.meta };
        } catch (error) {
            if (!axios.isAxiosError(error)) throw error;

            // A response means jovi-mall decided something. Surface its decision as-is —
            // retrying a 409 would just produce another 409.
            if (error.response) {
                throw toAppError(error, request);
            }

            // No response: connection refused, DNS failure, or the timeout elapsed.
            lastTransportError = error;
            if (attempt < attempts) {
                requestLogger(request.requestId).warn(
                    { method, path: request.path, attempt },
                    'jovi-mall unreachable, retrying (read)',
                );
                continue;
            }
        }
    }

    const message = lastTransportError instanceof Error ? lastTransportError.message : String(lastTransportError);
    requestLogger(request.requestId).error(
        { method, path: request.path, err: message },
        'jovi-mall request failed',
    );

    throw createAppError(
        ERROR_CODES.SERVICE_DEPENDENCY_UNAVAILABLE,
        503,
        'jovi-mall is unreachable',
        { operation: `${method} ${request.path}` },
    );
}

/** What jovi-mall answered for a byte-stream read, before any of it is piped. */
export interface PlatformStream {
    stream: NodeJS.ReadableStream;
    /** Verbatim from jovi-mall — it is the authority on what the bytes are. */
    contentType: string;
    /** `null` when jovi-mall sent no `Content-Length`. */
    contentLength: number | null;
    /** Verbatim, or `null`. Re-emitting it unparsed keeps the filename jovi-mall chose. */
    contentDisposition: string | null;
}

/**
 * Fetch a jovi-mall response as a STREAM rather than a parsed envelope (BR-011).
 *
 * ── Why this is a sibling of `platformRequest` and not an option on it ────────
 * `platformRequest` is typed around jovi-mall's success envelope: it reaches into
 * `response.data.data` and hands back a payload. A streamed response has no envelope at
 * all — `response.data` IS the stream — so an option flag would give one function two
 * incompatible return types and a caller no way to know which it got. Two functions, two
 * shapes.
 *
 * ── ⚠ The trap: on an ERROR, `response.data` is a STREAM too ──────────────────
 * With `responseType: 'stream'` axios does not parse a non-2xx body either, so
 * `error.response.data` is an unread stream and `toAppError` — which reads
 * `data.error.code` — would find `undefined` on every field and report a bare
 * `PLATFORM_OPERATION_REJECTED` with no `platformCode`. jovi-mall's real answer,
 * including `STORAGE_DOWNLOAD_NOT_SUPPORTED`, would be silently discarded: the caller
 * would be told "the platform rejected this" for a condition it is supposed to render as
 * "this deployment cannot show private files".
 *
 * So the error stream is drained and re-parsed as JSON before `toAppError` sees it, and
 * the parsed body is written back onto the error object — which is what lets the ONE
 * translation function serve both call shapes rather than growing a second copy.
 *
 * ── No retry, deliberately ────────────────────────────────────────────────────
 * `platformRequest` retries a GET once on a transport failure. A stream cannot be retried
 * that way: by the time a mid-transfer failure is observable the response has begun and
 * some bytes may already be on the wire, so a second attempt would concatenate two partial
 * bodies. The caller retries the whole request instead.
 */
export async function platformStream(request: PlatformRequest): Promise<PlatformStream> {
    const http = client();

    if (!http) {
        throw createAppError(
            ERROR_CODES.SERVICE_DEPENDENCY_UNAVAILABLE,
            503,
            'This operation is served by jovi-mall, which is not configured (JOVI_MALL_BASE_URL)',
        );
    }

    try {
        const response = await http.request({
            method: request.method,
            url: `${INTERNAL_ADMIN_PREFIX}${request.path}`,
            params: request.query,
            headers: actorHeaders(request.actor, request.requestId),
            responseType: 'stream',
        });

        const length = Number(response.headers['content-length']);

        return {
            stream: response.data as NodeJS.ReadableStream,
            contentType: String(response.headers['content-type'] ?? 'application/octet-stream'),
            contentLength: Number.isFinite(length) ? length : null,
            contentDisposition: (response.headers['content-disposition'] as string | undefined) ?? null,
        };
    } catch (error) {
        if (!axios.isAxiosError(error)) throw error;

        if (error.response) {
            error.response.data = await readErrorBody(error.response.data);
            throw toAppError(error, request);
        }

        requestLogger(request.requestId).error(
            { method: String(request.method).toUpperCase(), path: request.path, err: error.message },
            'jovi-mall stream request failed',
        );

        throw createAppError(
            ERROR_CODES.SERVICE_DEPENDENCY_UNAVAILABLE,
            503,
            'jovi-mall is unreachable',
            { operation: `${String(request.method).toUpperCase()} ${request.path}` },
        );
    }
}

/** An upload to stream at jovi-mall: the caller's own unread request body. */
export interface PlatformUpload extends Omit<PlatformRequest, 'body' | 'method'> {
    /** The inbound `req`, unread. Piped straight through — see below. */
    body: NodeJS.ReadableStream;
    /** The inbound `Content-Type`, **verbatim, boundary included**. */
    contentType: string;
    /** Forwarded when the client sent one; `null` for a chunked upload. */
    contentLength: number | null;
    /** Refuse a body larger than this, mid-flight. Bytes. */
    maxBytes: number;
}

/**
 * Stream a request BODY at jovi-mall — the mirror of `platformStream` (BR-015 · L-2).
 *
 * ── The third transport on this client, and why it is a third function ────────
 * `platformRequest` serialises a JSON body and unwraps an envelope; `platformStream`
 * streams a RESPONSE. This streams a REQUEST and unwraps an envelope, which is neither of
 * them — and the reason it is not an option on `platformRequest` is the same reason
 * `platformStream` is not: the input types are incompatible. `platformRequest` takes
 * `body: unknown` and hands it to axios as JSON. Handing it a stream would produce a
 * request whose `Content-Type` says `application/json` and whose body is multipart, which
 * jovi-mall's multer would reject in a way that reads as a client error.
 *
 * ── ⚠ THE BODY IS NEVER PARSED HERE, and that is decision L-2 ─────────────────
 * This is the narrowing of *"wi-admin accepts no multipart bodies anywhere"* into
 * *"wi-admin never PARSES one"* (ADR-021 D-2). It works because `express.json` and
 * `express.urlencoded` are **content-type gated**: `app.ts` mounts them with their default
 * type matchers, so a `multipart/form-data` request matches neither and reaches the handler
 * with `req` unread and still flowing. No multer, no busboy, no new dependency — the body
 * this function is handed is the socket.
 *
 * That is also why the ceiling below is enforced HERE rather than by a body-parser limit:
 * the 1 MB `express.json` limit never sees this request, so without an explicit count there
 * would be no ceiling on it at all.
 *
 * ── The byte gate is a Transform, and it must be ──────────────────────────────
 * `Content-Length` is checked by the caller before we get here, but a chunked upload sends
 * none — and a ceiling that only reads a header is one any client can opt out of by
 * declining to declare a length. So the body is piped through a counter that destroys the
 * stream past `maxBytes`. Axios surfaces that as a transport failure, which is translated
 * to the caller's `FILE_UPLOAD_TOO_LARGE` by the sentinel below rather than becoming a
 * confusing 503.
 *
 * ── No retry, and here it is not even a judgement call ────────────────────────
 * `platformRequest` retries a GET once. A request body is consumed by the first attempt —
 * the socket cannot be rewound — so a second attempt would send an empty body. It is also a
 * WRITE, which that function refuses to retry anyway. Both rules point the same way.
 *
 * `maxRedirects: 0` and axios's own body caps lifted: `maxBodyLength` defaults to 10 MB on
 * the Node adapter and would silently cap the proxy below this service's own declared
 * ceiling, producing a refusal neither `ADMIN_UPLOAD_MAX_BYTES` nor jovi-mall accounts for.
 */
export async function platformUpload<T>(request: PlatformUpload): Promise<{ data: T; meta?: unknown }> {
    const http = client();

    if (!http) {
        throw createAppError(
            ERROR_CODES.SERVICE_DEPENDENCY_UNAVAILABLE,
            503,
            'This operation is served by jovi-mall, which is not configured (JOVI_MALL_BASE_URL)',
        );
    }

    const { stream, exceeded } = capBytes(request.body, request.maxBytes);

    try {
        const response = await http.request({
            method: 'POST',
            url: `${INTERNAL_ADMIN_PREFIX}${request.path}`,
            params: request.query,
            data: stream,
            headers: {
                ...actorHeaders(request.actor, request.requestId),
                // Verbatim, because the multipart BOUNDARY is inside it. Rebuilding this
                // header — or letting the instance default `application/json` stand — makes
                // the body unparseable on the far side.
                'Content-Type': request.contentType,
                ...(request.contentLength !== null
                    ? { 'Content-Length': String(request.contentLength) }
                    : {}),
            },
            maxRedirects: 0,
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
        });

        const payload = response.data as { data?: T; meta?: unknown };
        return { data: payload?.data as T, meta: payload?.meta };
    } catch (error) {
        /**
         * Checked BEFORE the axios branch, deliberately. Destroying the request stream
         * surfaces as a transport error with no response, which is indistinguishable from
         * "jovi-mall is down" — and answering 503 for an oversized upload sends an operator
         * looking for an outage instead of shrinking their file.
         */
        if (exceeded()) {
            throw createAppError(
                ERROR_CODES.FILE_UPLOAD_TOO_LARGE,
                413,
                'This upload is larger than the administration upload limit',
                { maxBytes: request.maxBytes },
            );
        }

        if (!axios.isAxiosError(error)) throw error;

        if (error.response) {
            throw toAppError(error, { method: 'POST', path: request.path });
        }

        requestLogger(request.requestId).error(
            { method: 'POST', path: request.path, err: error.message },
            'jovi-mall upload failed',
        );

        throw createAppError(
            ERROR_CODES.SERVICE_DEPENDENCY_UNAVAILABLE,
            503,
            'jovi-mall is unreachable',
            { operation: `POST ${request.path}` },
        );
    }
}

/**
 * Pass a stream through, counting, and destroy it past `max`.
 *
 * Returns the flag as a THUNK rather than a boolean: the value is only known after the
 * stream has run, and a boolean captured at call time would always read `false`.
 */
function capBytes(
    source: NodeJS.ReadableStream,
    max: number,
): { stream: NodeJS.ReadableStream; exceeded: () => boolean } {
    let seen = 0;
    let tripped = false;

    const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
            seen += chunk.length;
            if (seen > max) {
                tripped = true;
                // An Error rather than `push(null)`: ending the stream cleanly would send a
                // TRUNCATED multipart body to jovi-mall, which reads there as a corrupt
                // upload rather than an oversized one. Failing the request is the honest
                // outcome, and the sentinel above turns it into the right status.
                callback(new Error('upload exceeds the administration upload limit'));
                return;
            }
            callback(null, chunk);
        },
    });

    source.pipe(counter);

    return { stream: counter, exceeded: () => tripped };
}

/**
 * Drain an error response body into a parsed envelope.
 *
 * Bounded at 64 KB and **never throws**: this runs while an error is already being
 * reported, so a failure here must degrade to "no envelope" — which `toAppError` handles,
 * falling back to the status alone — rather than replacing jovi-mall's refusal with a
 * parse error from the code trying to explain it. Returns `undefined` on anything
 * unreadable, which is exactly what a body-less error response looks like.
 */
async function readErrorBody(data: unknown): Promise<unknown> {
    if (data === null || typeof data !== 'object' || typeof (data as NodeJS.ReadableStream).on !== 'function') {
        // Not a stream — axios parsed it after all (an empty body, or a non-stream error
        // path). Hand it straight to `toAppError`.
        return data;
    }

    const MAX_ERROR_BODY_BYTES = 64 * 1024;

    try {
        const chunks: Buffer[] = [];
        let total = 0;

        for await (const chunk of data as AsyncIterable<Buffer | string>) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            total += buffer.length;
            if (total > MAX_ERROR_BODY_BYTES) break;
            chunks.push(buffer);
        }

        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        return undefined;
    }
}

/**
 * Translate jovi-mall's error envelope into one of ours.
 *
 * Its code registry is its own (506 codes) and this service's is deliberately separate, so
 * the code is passed through as an opaque string in `details.platformCode` rather than
 * pretended to be a local one. The STATUS is preserved, because that is the part the
 * dashboard branches on.
 *
 * Exported for `test-data-access.ts`. A mirror of this in the test would assert that the
 * mirror is correct, which is not the question.
 */
export function toAppError(error: AxiosError, request: Pick<PlatformRequest, 'method' | 'path'>): Error {
    const status = error.response?.status ?? 502;
    const body = error.response?.data as PlatformErrorBody | undefined;
    const platformCode = body?.error?.code;
    const message = body?.error?.message;

    // 5xx from jovi-mall is not the caller's fault; report it as a dependency failure so
    // it is logged with a stack rather than as a routine client error.
    if (status >= 500) {
        return createAppError(
            ERROR_CODES.SERVICE_DEPENDENCY_UNAVAILABLE,
            502,
            message ?? 'jovi-mall failed to complete the operation',
            { platformCode, platformStatus: status, operation: `${String(request.method).toUpperCase()} ${request.path}` },
        );
    }

    // ── Forwarding jovi-mall's `details` is now conditional (Phase 16) ────────
    //
    // This used to spread `body.error.details` wholesale — an unbounded passthrough of
    // another service's payload into ours. Mostly harmless once jovi-mall filters on its
    // own boundary, and "mostly" is not a boundary: this also runs against an older
    // jovi-mall build that has not deployed Phase 16 yet, and against a jovi-mall 502
    // whose details were never meant for anyone outside it.
    //
    // The rule is jovi-mall's OWN verdict, not a second opinion: its envelope now carries
    // `category`, and the details travel only when that category is one it considers
    // client-safe. When the field is absent (a pre-Phase-16 jovi-mall), nothing is
    // forwarded — failing closed on a service whose exposure rules we cannot read.
    //
    // `platformCode` always survives. It is a published contract, it is the dashboard's
    // only handle on WHY a delegated write was refused, and it is not a payload.
    const platformCategory = body?.error?.category;
    const forwardable = platformCategory !== undefined
        && CLIENT_SAFE_CATEGORIES.has(platformCategory as ErrorCategory)
        && body?.error?.details !== undefined;

    return createAppError(
        ERROR_CODES.PLATFORM_OPERATION_REJECTED,
        status,
        message ?? 'The platform rejected this operation',
        { platformCode, ...(forwardable ? body!.error!.details : {}) },
    );
}

