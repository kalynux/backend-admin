import { PermissionFamily } from '../../authorization/domain/permission.types';

/**
 * The vocabulary of the audit trail.
 *
 * Every value here is OURS, so every one of them is a pinned enum on the wire
 * (ADR-005 D-17) and every array below feeds both a Mongoose enum and a Zod enum from
 * one definition. That is not tidiness: jovi-mall kept two copies of its agent
 * notification types, they drifted, and eight situations existed in the union and not in
 * the enum — so every one of those notifications threw a ValidationError and the agent
 * was simply never told. One array, two consumers.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Status — the intent → outcome vocabulary
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `attempted` is the only non-terminal value, and it is the whole reason D4 chose
 * intent→outcome over a single row written afterwards: an action that reaches a system
 * this service cannot transact with (jovi-mall, Redis) is recorded BEFORE it is
 * performed, so a crash mid-flight leaves evidence rather than silence.
 *
 * A row still `attempted` after `ADMIN_AUDIT_DANGLING_INTENT_S` is a **dangling intent**
 * — ADR-002 D4-a calls that case "itself a useful signal". Resolve one by grepping the
 * other service for the same `correlation_id`.
 */
export const AUDIT_STATUSES = ['attempted', 'succeeded', 'failed', 'denied', 'queued'] as const;
export type AuditStatus = (typeof AUDIT_STATUSES)[number];

// ─────────────────────────────────────────────────────────────────────────────
// Actors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `system` covers work no administrator asked for in the moment — the approval-expiry
 * sweep, the purge, the bootstrap CLI. `anonymous` covers a login attempt against an
 * address that matches no account: there is genuinely no actor, and recording one would
 * be a lie.
 */
export const AUDIT_ACTOR_KINDS = ['administrator', 'system', 'anonymous'] as const;
export type AuditActorKind = (typeof AUDIT_ACTOR_KINDS)[number];

// ─────────────────────────────────────────────────────────────────────────────
// Targets
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What an action was done TO.
 *
 * Closed, because `subject_class` (and therefore who may read the row) is derived from
 * it — an unknown target type would have no classification and would either leak or
 * vanish. `none` is explicit for actions with no target at all, so "no target" and
 * "somebody forgot the target" are different states.
 */
export const AUDIT_TARGET_TYPES = [
    // Platform actors
    'user', 'vendor', 'agency', 'agent', 'customer',
    // Platform records
    'order', 'shipment', 'remittance', 'deposit', 'discrepancy', 'payout', 'ticket',
    'article', 'plan',
    // This service's own records
    'administrator', 'admin_session', 'approval_request', 'audit_export',
    // Phase 12 operational targets. Both classify as `internal`: a flag flip and a worker
    // run are this service's own machinery, not facts about a platform actor or record.
    'feature_flag', 'worker',
    // Phase 14. Worth its own target type rather than `none`: opening a maintenance window is
    // the single most consequential thing an operator can do to this platform, and a
    // `target: 'none'` row for it would be a poor trail.
    'maintenance_window',
    // Phase 5 Part B. Same argument, one step further: `files.delete` is the only
    // UNRECOVERABLE operation on this surface, and it addresses exactly one record. A
    // `target: 'none'` row would put the deleted file's id in the payload and nothing in
    // the column an operator searches, which is precisely the row you need to find after
    // somebody deletes the wrong thing.
    'file',
    'none',
] as const;
export type AuditTargetType = (typeof AUDIT_TARGET_TYPES)[number];

/**
 * Narrow a stored string to a target type, falling back to `none`.
 *
 * `approval_requests.target_type` is a plain string in Mongo — it names what the queued
 * action is about, and it was written when the request was made, possibly before a rename.
 * A decision recorded months later has to classify it anyway.
 *
 * `none` is the safe fallback rather than a throw, for two reasons that point the same
 * way: an unrecognised value must not stop a four-eyes decision from being recorded
 * (fail-closed on the audit write would mean the decision cannot happen at all), and
 * `none` classifies as `internal`, the MOST restrictive `subject_class` — so an
 * unclassifiable row is withheld from Support rather than leaked to them.
 */
export function toAuditTargetType(value: string | null | undefined): AuditTargetType {
    return (AUDIT_TARGET_TYPES as readonly string[]).includes(value ?? '')
        ? (value as AuditTargetType)
        : 'none';
}

export interface AuditTarget {
    type: AuditTargetType;
    /**
     * String, not ObjectId: some targets are session ids (UUIDs) and some are composite.
     * A single column that sometimes holds an ObjectId and sometimes a UUID is a column
     * that cannot be typed as either.
     */
    id: string | null;
    /** A snapshot — an email, a reference — so a row reads without a join. */
    label?: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Subject classification — the read-scoping axis
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Who a row is ABOUT, coarsely, so a tier-3 reader can be scoped without the query
 * needing to know every target type.
 *
 * `internal` is the load-bearing one: administrators, sessions, approvals and exports are
 * this service's own machinery, and Support may not see them — that is what preserves
 * "Support has no sight of the administrator directory" through the audit feed, which
 * would otherwise be a side door onto it.
 */
export const AUDIT_SUBJECT_CLASSES = ['platform_actor', 'platform_record', 'internal'] as const;
export type AuditSubjectClass = (typeof AUDIT_SUBJECT_CLASSES)[number];

// ─────────────────────────────────────────────────────────────────────────────
// Transport — which writer function an action is allowed to use
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where the state change this row describes actually lands, which decides how it can be
 * audited:
 *
 *  - `wi_admin_txn` — this service's own database. The row and the change commit in ONE
 *    transaction, so an unaudited action is impossible rather than unlikely.
 *  - `delegated`    — jovi-mall, over HTTP. Cannot join a transaction, so intent→outcome.
 *  - `external`     — Redis, or the platform connection. Also cannot join: note that
 *    `connections.ts` opens TWO MongoClients, so even a direct write to `jovi_mall` is
 *    outside a `wi-admin` session. Intent→outcome.
 *  - `observation`  — nothing to roll back (a login happened, a lockout engaged). Recorded
 *    best-effort: there is no action to refuse, and refusing a login because the audit
 *    store hiccupped would make the audit subsystem a lockout with no break-glass path.
 */
export const AUDIT_TRANSPORTS = ['wi_admin_txn', 'delegated', 'external', 'observation'] as const;
export type AuditTransport = (typeof AUDIT_TRANSPORTS)[number];

// ─────────────────────────────────────────────────────────────────────────────
// The intent a call site describes
// ─────────────────────────────────────────────────────────────────────────────

/** The acting administrator, reduced to what a row keeps. Snapshots, not references. */
export interface AuditActor {
    kind: AuditActorKind;
    id: string | null;
    email: string | null;
    displayName: string | null;
    /** The level held AT THE TIME — the same reasoning as `admin_sessions.tier_at_login`. */
    tier: number | null;
    sessionId: string | null;
}

/** Request context. Built once per request by the controllers' `contextOf(req)`. */
export interface AuditContext {
    method: string;
    /** `req.originalUrl` — `req.path` inside a router drops the mount prefix. */
    path: string;
    requestId: string;
    ip: string | null;
    userAgent: string | null;
}

export interface AuditIntent {
    action: string;
    actor: AuditActor;
    target: AuditTarget;
    context: AuditContext;
    /** The VALIDATED input, redacted and capped before storage. */
    payload?: Record<string, unknown> | null;
    /**
     * The record an action is *about* when the target is a wrapper around it — an
     * approval's target is the approval, and this is the administrator it concerns.
     * Without it, "what was done to this account" misses everything that went through
     * four-eyes.
     */
    relatedTarget?: AuditTarget | null;
    /** Set when the action was committed by an approval rather than requested directly. */
    viaApprovalId?: string | null;
}

/** What a performed action reports back, so the row can record what actually changed. */
export interface AuditResult<T> {
    result: T;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
    /** Fills in a target only knowable after the write — a created administrator's id. */
    target?: Partial<AuditTarget>;
}

/** How an action ended, for the outcome stamp. */
export interface AuditOutcomeDetail {
    code?: string | null;
    statusCode?: number | null;
    message?: string | null;
    platformCode?: string | null;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
}

/** `family.resource.action` → `family`. Denormalised onto the row so a family filter is not a regex. */
export function familyOf(action: string): PermissionFamily {
    return action.split('.')[0] as PermissionFamily;
}
