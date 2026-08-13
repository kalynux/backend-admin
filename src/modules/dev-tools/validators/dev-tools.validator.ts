import { z } from 'zod';
import { FEATURE_FLAG_NAMES } from '../domain/feature-flag.catalog';

/**
 * The flag name is a pinned enum, not a free string (ADR-005 D-17: the vocabulary is ours).
 *
 * So `PUT /dev-tools/feature-flags/audit.route_prboe` is a 400 naming the valid values,
 * rather than an upsert that silently creates a flag nothing reads — which would look like
 * it worked and change nothing.
 */
export const FeatureFlagParamSchema = z.object({
    flag: z.enum(FEATURE_FLAG_NAMES),
});

export const SetFeatureFlagSchema = z.object({
    enabled: z.boolean(),
    /**
     * Required, and bounded at both ends.
     *
     * A flag flipped with no stated reason is a mystery to whoever finds it weeks later,
     * and this row is the only place that context can live. Ten characters is enough to
     * refuse "test" and "x" without demanding an essay.
     */
    reason: z.string().trim().min(10).max(500),
});

/**
 * The worker key is NOT pinned here, deliberately.
 *
 * The registry lives in jovi-mall, and duplicating its keys into this service would create
 * a second list that drifts the moment a worker is added or renamed there. jovi-mall
 * answers 404 `DEV_TOOLS_WORKER_UNKNOWN` with the valid keys, which is the same information
 * arriving from the service that actually knows it.
 */
export const WorkerKeyParamSchema = z.object({
    workerKey: z.string().trim().min(1).max(64).regex(/^[a-z][a-z0-9-]*$/),
});

export const ReplayOutboxSchema = z.object({
    limit: z.number().int().min(1).max(1000).optional(),
    /**
     * Specific rows, when an operator knows which ones. Absent means "the oldest failed
     * rows up to `limit`", which is the common case after an outage.
     */
    eventIds: z.array(z.string().trim().min(1)).min(1).max(1000).optional(),
});

// ═══ Phase 14 ═════════════════════════════════════════════════════════════════
//
// Both schemas MIRROR jovi-mall's exactly and are never laxer. The cross-repo duplication is
// unavoidable — there is no shared package — and the mitigation is that jovi-mall re-validates
// everything. This copy exists to give a good 400 before the network hop, never to be the only
// check. Each suite asserts its own copy.

export const SetMaintenanceSchema = z.object({
    mode: z.enum(['off', 'readonly', 'down']),
    /**
     * Required for anything but `off`, and that is not bureaucracy: this string is shown to
     * every refused caller in the 503 body AND recorded in the audit row. A window with no
     * stated reason is the one nobody else can confidently end.
     */
    reason: z.string().trim().min(8).max(500).optional(),
    /** Bounded at 24h. An unbounded window is the one everybody forgets is open. */
    expiresInMinutes: z.number().int().min(1).max(1440).optional(),
    blockWebhooks: z.boolean().optional(),
    pauseWorkers: z.boolean().optional(),
}).refine(
    (value) => value.mode === 'off' || Boolean(value.reason),
    { path: ['reason'], message: 'A reason is required to open a maintenance window' },
);

/**
 * The database is a NAME, never an index — matching jovi-mall.
 *
 * Not pinned to an enum here, for the same reason `WorkerKeyParamSchema` is not: the catalogue
 * lives in jovi-mall and a second copy would drift. jovi-mall answers 404
 * `DEV_TOOLS_CACHE_DB_UNKNOWN` listing the valid names.
 */
export const FlushCacheSchema = z.object({
    db: z.string().trim().regex(/^[A-Z][A-Z0-9_]*$/, 'Use the database NAME (e.g. SLOT_LOCK_DB), not its index'),
    prefix: z.string().trim().min(1).max(200).optional(),
    limit: z.number().int().min(1).max(10_000).optional(),
    /** Defaults to true on jovi-mall's side — one default, one place. */
    dryRun: z.boolean().optional(),
    /** Must repeat `db`. Checked there too; here it fails before the hop. */
    confirm: z.string(),
});

/** `?probe=smtp,telegram` — which on-demand integration probes to run this request. */
export const IntegrationQuerySchema = z.object({
    probe: z.string().trim().max(200).optional(),
});

// ═══ Phase 15 ═════════════════════════════════════════════════════════════════
//
// Same rule as Phase 14's pair: these MIRROR jovi-mall's and are never laxer, they exist to give
// a good 400 before the network hop, and jovi-mall re-validates everything regardless.

/**
 * `GET /system/platform/logs`.
 *
 * `q` is bounded at 100 characters here as well as there. The bound is a pattern-length defence:
 * jovi-mall escapes the term and applies it as a literal, and a caller-supplied `$regex` would
 * otherwise be a ReDoS against that process and a scan amplifier against a collection with no
 * text index.
 */
export const LogQuerySchema = z.object({
    level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).optional(),
    since: z.string().datetime({ offset: true }).optional(),
    until: z.string().datetime({ offset: true }).optional(),
    requestId: z.string().trim().min(1).max(200).optional(),
    q: z.string().trim().min(1).max(100).optional(),
    source: z.enum(['ring', 'persisted']).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
    /** A cursor, never an offset — the capped collection evicts from the front as it is written. */
    before: z.string().trim().length(24).optional(),
});

/**
 * `GET /system/errors` (Phase 16).
 *
 * Narrower than `LogQuerySchema` on purpose: no `level` (every error is warn+ already) and
 * no free-text `q`. The two taxonomy filters replace it, and both are equality matches
 * against bounded values rather than a regex against a collection with no text index.
 *
 * `category` is not enumerated HERE even though it is a closed set, because doing so would
 * put a fourth copy of the nine names in the codebase; jovi-mall's own schema enumerates it
 * and answers 400 on a typo, which is the same outcome one hop later.
 */
export const PlatformErrorQuerySchema = z.object({
    since: z.string().datetime({ offset: true }).optional(),
    until: z.string().datetime({ offset: true }).optional(),
    requestId: z.string().trim().min(1).max(200).optional(),
    category: z.string().trim().min(1).max(40).optional(),
    code: z.string().trim().min(1).max(100).optional(),
    source: z.enum(['ring', 'persisted']).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
    before: z.string().trim().length(24).optional(),
});

/**
 * `GET /system/platform/cache/keys`.
 *
 * Note what is absent relative to `FlushCacheSchema`: no `confirm`. Requiring an operator to type
 * a database name in order to *look* trains reflexive confirmation-typing, which is exactly what
 * would hollow out the guard on the path that deletes. Looking is not clearing.
 */
export const CacheKeysQuerySchema = z.object({
    db: z.string().trim().regex(/^[A-Z][A-Z0-9_]*$/, 'Use the database NAME (e.g. SLOT_LOCK_DB), not its index'),
    prefix: z.string().trim().min(1).max(200).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
    withSize: z.enum(['true', 'false']).optional(),
});

/**
 * `GET /system/platform/database`.
 *
 * The collection name is shape-checked here and pinned to jovi-mall's FROZEN registry there —
 * the same division as `FlushCacheSchema.db`, and for the same reason: duplicating a catalogue
 * jovi-mall owns would create a second list that drifts.
 */
export const DatabaseInspectQuerySchema = z.object({
    collection: z
        .union([z.string().trim().regex(/^[a-z][a-z0-9_]*$/), z.array(z.string().trim().regex(/^[a-z][a-z0-9_]*$/))])
        .optional()
        .transform((value) => (value === undefined ? undefined : Array.isArray(value) ? value.join(',') : value)),
});

/**
 * `POST /dev-tools/outbox/prune`.
 *
 * `status` is a LITERAL, not an enum with three members — pruning `failed` destroys the input to
 * `outbox/replay` and pruning `pending` destroys undelivered events. A field that could take
 * another value is one somebody eventually passes another value to. The 7-day floor is jovi-mall's
 * and is repeated here so the refusal arrives before the hop.
 */
export const PruneOutboxSchema = z.object({
    olderThanDays: z.number().int().min(7).max(365),
    status: z.literal('sent'),
    limit: z.number().int().min(1).max(50_000).optional(),
    /** Defaults to true on jovi-mall's side — one default, one place. */
    dryRun: z.boolean().optional(),
    /** Must repeat `olderThanDays`, because the age is what decides the blast radius. */
    confirm: z.string(),
});

export type SetFeatureFlagBody = z.infer<typeof SetFeatureFlagSchema>;
export type ReplayOutboxBody = z.infer<typeof ReplayOutboxSchema>;
export type SetMaintenanceBody = z.infer<typeof SetMaintenanceSchema>;
export type FlushCacheBody = z.infer<typeof FlushCacheSchema>;
export type PruneOutboxBody = z.infer<typeof PruneOutboxSchema>;
export type LogQuery = z.infer<typeof LogQuerySchema>;
export type CacheKeysQuery = z.infer<typeof CacheKeysQuerySchema>;
export type DatabaseInspectQuery = z.infer<typeof DatabaseInspectQuerySchema>;
