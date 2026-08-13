import { AdminTier } from '../../admin-identity/domain/admin-identity.types';
import { ErrorCategory, SUPPORT_HINTS, isErrorCategory } from '../../../core/errors/error-category';

/**
 * The developer → admin → support exposure ladder (Phase 16).
 *
 * ── Why this lives in wi-admin and not in jovi-mall ───────────────────────────
 * wi-admin is the only service that knows an administrator's tier. jovi-mall receives
 * `X-Actor-Tier` on every internal call and its own middleware says plainly that the header
 * "is accepted for logging and is never read for a decision" — which is correct, because
 * the token authenticating that call is a FULL-PRIVILEGE credential. Anyone holding it
 * could set the header to `1`. Projecting there would be theatre; projecting here is
 * enforcement, because `req.admin.tier` came out of a verified session.
 *
 * So jovi-mall's `/api/internal/admin/system/errors` returns the whole record, and this is
 * the sieve on the way out.
 *
 * ── The three rungs are not three sizes of the same answer ────────────────────
 * Developer and Admin differ by DEPTH: a stack and a cause chain name our files and our
 * call graph, which is a developer's concern; the error message itself
 * (`MongoServerError: connection timed out`) is what an operator diagnosing an incident
 * actually needs, so Admin keeps it.
 *
 * Support differs in KIND. They do not get a smaller version of the internal record; they
 * get **what the caller saw, plus the reference and the category**. That is enough to say
 * "your payment failed at an external provider at 14:02, reference req_abc, I have escalated
 * it" and it is not a disclosure channel. The reason is specific and load-bearing:
 * `log-query.service.ts` carries a `PII_WARNING` saying log lines are free text and can hold
 * an email from an SMTP failure or a phone number from a WhatsApp send error. Support talks
 * to the public. They must never be handed free text this service did not compose.
 */

/** One error, as jovi-mall stores it. Mirrors `jovi-mall`'s `HttpErrorRecord`. */
export interface PlatformErrorRecord {
    at: string;
    level: string;
    msg: string;
    requestId: string | null;
    actorId: string | null;
    method?: string;
    routeGroup?: string;
    path?: string;
    status?: number;
    err?: { type: string; message: string; stack: string | null } | null;
    httpError?: {
        category: string;
        code: string;
        statusCode: number;
        routeGroup: string;
        actorRole: string | null;
        clientMessage: string;
        internalMessage: string;
        details: Record<string, unknown> | null;
        causeMessage: string | null;
        masked: boolean;
    } | null;
}

/**
 * The platform roles Support is allowed to see errors for.
 *
 * Deliberately the four public-facing ones and anonymous traffic. An error raised by an
 * administrator or by an internal service caller is not a support conversation — it is an
 * operations problem, and showing it to tier 3 would leak how the platform's own machinery
 * fails without anybody having asked for that.
 *
 * This is the same row-level narrowing `resource-scope.ts` already applies to tickets and
 * audit for tier 3, and it exists for the same reason: the permission answers "may you read
 * this surface", the scope answers "which rows on it".
 */
const SUPPORT_VISIBLE_ROLES: ReadonlySet<string> = Object.freeze(
    new Set(['vendor', 'agency', 'agent', 'customer']),
);

/** Support view — what the caller already saw, plus a reference and a category. */
export interface SupportErrorView {
    at: string;
    requestId: string | null;
    category: string;
    code: string;
    statusCode: number;
    method?: string;
    routeGroup?: string;
    actorRole: string | null;
    /** The message the caller was actually shown. Composed by us, never free text. */
    message: string;
    /** What to tell them, per category. */
    hint: string;
}

/** Admin view — the operational diagnosis, without the shape of the codebase. */
export interface AdminErrorView extends SupportErrorView {
    path?: string;
    actorId: string | null;
    /** What the code threw. Absent for a masked category — see below. */
    internalMessage?: string;
    details?: Record<string, unknown> | null;
    errorType?: string;
    masked: boolean;
}

/** Developer view — everything, verbatim. */
export interface DeveloperErrorView extends AdminErrorView {
    stack?: string | null;
    causeMessage?: string | null;
    /** The raw stored line, for anything the typed views do not name. */
    raw: PlatformErrorRecord;
}

export type ProjectedErrorView = SupportErrorView | AdminErrorView | DeveloperErrorView;

function categoryOf(record: PlatformErrorRecord): ErrorCategory {
    const raw = record.httpError?.category;
    return isErrorCategory(raw) ? raw : 'internal';
}

/**
 * Project one stored error for one administrator's tier.
 *
 * Lower tier number = more privilege (1 Developer, 2 Admin, 3 Support), which is worth
 * saying out loud every time it is relied on.
 */
export function projectErrorRecord(
    record: PlatformErrorRecord,
    tier: AdminTier,
): ProjectedErrorView {
    const http = record.httpError;
    const category = categoryOf(record);

    const support: SupportErrorView = {
        at: record.at,
        requestId: record.requestId,
        category,
        code: http?.code ?? 'INTERNAL_SERVER_ERROR',
        statusCode: http?.statusCode ?? record.status ?? 500,
        method: record.method,
        routeGroup: http?.routeGroup ?? record.routeGroup,
        actorRole: http?.actorRole ?? null,
        // The CLIENT message, never `msg` and never `internalMessage`. `msg` is a log line
        // and log lines are free text; `clientMessage` is the sentence we already showed
        // this person, so repeating it to the agent helping them is disclosing nothing new.
        message: http?.clientMessage ?? 'Something went wrong',
        hint: SUPPORT_HINTS[category],
    };

    if (tier === 3) return support;

    const admin: AdminErrorView = {
        ...support,
        path: record.path,
        actorId: record.actorId,
        errorType: record.err?.type,
        masked: http?.masked ?? false,
        // The internal message and the raw details are the operational diagnosis. An Admin
        // gets them for EVERY category — including the masked ones, which is the point:
        // "what did the payment gateway actually say" is precisely the question a masked
        // 502 leaves unanswered, and answering it is why this surface exists.
        internalMessage: http?.internalMessage,
        details: http?.details ?? null,
    };

    if (tier === 2) return admin;

    return {
        ...admin,
        // A stack names our files, our functions and our call graph. That is the shape of
        // the codebase rather than the state of the platform, and it is the one thing a
        // Developer needs that an Admin does not.
        stack: record.err?.stack ?? null,
        causeMessage: http?.causeMessage ?? null,
        raw: record,
    };
}

/**
 * Should this record be visible to this tier at all?
 *
 * Only tier 3 is narrowed. Tiers 1 and 2 see every error the platform recorded, which is
 * what an operations surface is for.
 */
export function isVisibleToTier(record: PlatformErrorRecord, tier: AdminTier): boolean {
    if (tier !== 3) return true;
    const role = record.httpError?.actorRole;
    // `null` is anonymous or unauthenticated traffic — a logged-out shopper hitting a broken
    // public page is exactly the kind of report Support fields, so it stays visible.
    if (role === null || role === undefined) return true;
    return SUPPORT_VISIBLE_ROLES.has(role);
}

/**
 * Is this query narrow enough for the tier asking it?
 *
 * Tier 3 must name a `requestId`, or a `code` with a bounded window. An open feed for
 * Support is precisely the "unfiltered feed of every warning in the platform" that
 * `developer_tools.logs.read`'s own docstring refuses to give tier 2 — and Support is a
 * tier below that.
 *
 * The projection alone is not enough to make an open feed safe: even the Support view names
 * a route group, a role and a timestamp for every failure on the platform, and a scrollable
 * list of those is a reconnaissance feed regardless of how little each row says. A support
 * conversation always starts with a reference or a symptom, so requiring one costs nothing
 * real.
 */
export function isQueryNarrowEnough(
    tier: AdminTier,
    query: { requestId?: string; code?: string; since?: string },
): boolean {
    if (tier !== 3) return true;
    if (query.requestId) return true;
    return Boolean(query.code && query.since);
}
