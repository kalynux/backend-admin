import { randomUUID } from 'crypto';
import { Request } from 'express';
import { AdminIdentity, requireAdminIdentity } from '../../admin-identity/domain/admin-identity.types';
import { AuditActor, AuditContext } from './audit.types';

/**
 * The one place a request becomes an audit row's actor and context.
 *
 * ── Why this file exists ──────────────────────────────────────────────────────
 * Phase 3.5 landed as a retrofit across nine modules, and each one grew its own
 * `contextOf(req)`. By Phase 12 there were TWELVE — nine controller-local `contextOf`s,
 * three more in `auth.controller.ts`, and two in `administrator.service.ts` — plus six
 * module-private `GatewayContext` interfaces describing the same five fields.
 *
 * They had already drifted in shape — `approval.controller.ts` read
 * `req.headers['user-agent'] ?? null` while `auth.controller.ts` type-guarded it — though
 * not in behaviour: Node **discards** duplicate `user-agent` headers (only `set-cookie` is
 * ever an array, and most others are joined), which is why `@types/node` declares it
 * `string | undefined`. Both forms were correct. The point is that nothing said so, and
 * the next reader had to re-derive it; twelve copies means twelve chances to reach for a
 * header where the answer differs.
 *
 * The real argument is narrower and holds anyway: five field reads with four non-obvious
 * rules attached, restated twelve times, is where a rule gets dropped silently. None of
 * the copies bounded the header's length, and only some of them said why `originalUrl`.
 *
 * ── The rules encoded here, once ──────────────────────────────────────────────
 *  - `req.originalUrl`, never `req.path` — inside a router `req.path` has already had the
 *    mount prefix stripped, so `/administrators/x/tier` records as `/x/tier`.
 *  - the header is bounded before storage; see `MAX_USER_AGENT_CHARS`.
 *  - the `typeof` check is kept as a total function over the declared type rather than as
 *    a fix — it costs nothing and does not depend on remembering Node's duplicate rules.
 *  - an actor's `tier` is the level held AT THE TIME. They may be demoted before anyone
 *    reads the row, which is exactly why it is snapshotted rather than joined.
 */

/**
 * `User-Agent` is attacker-controlled and unbounded. Nothing else on the row is, so this
 * is the one field that could inflate a document on purpose — and `sanitiseState`'s byte
 * cap does not apply to it (that guards `payload`/`before`/`after`, not the columns).
 */
export const MAX_USER_AGENT_CHARS = 512;

/** Request context for an audit row. Built once per request, at the controller edge. */
export function requestContext(req: Request): AuditContext {
    return {
        method: req.method,
        path: req.originalUrl,
        requestId: req.requestId,
        ip: req.ip ?? null,
        userAgent: userAgentOf(req),
    };
}

/** The acting administrator, as an audit row remembers them: snapshots, not references. */
export function auditActorOf(identity: AdminIdentity): AuditActor {
    return {
        kind: 'administrator',
        id: identity.adminId,
        email: identity.email,
        displayName: identity.displayName,
        tier: identity.tier,
        sessionId: identity.sessionId,
    };
}

/**
 * Context plus the identity that produced it.
 *
 * Replaces the seven identical `GatewayContext` interfaces. A gateway needs both halves —
 * the actor for the row and `context.actor` again for `platformRequest`'s `X-Actor-*`
 * headers — so passing them as one value is what stops a call site pairing an actor with
 * somebody else's request.
 */
export interface ActorContext extends AuditContext {
    actor: AdminIdentity;
}

/**
 * For a route reached through `requireAdmin`, where `req.admin` is guaranteed.
 *
 * Delegates the absent-identity case to `requireAdminIdentity`, which already answers it
 * with a 401 naming the likely cause ("is requireAdmin mounted on this route?"). Throwing
 * rather than defaulting is the point: an audit row attributed to nobody is worse than a
 * failed request, and this is the same argument jovi-mall's `requireAdminCaller` makes
 * when it refuses a missing `X-Actor-Id` instead of substituting a placeholder.
 */
export function actorContextOf(req: Request): ActorContext {
    return { ...requestContext(req), actor: requireAdminIdentity(req) };
}

/**
 * The actor for work no administrator asked for in the moment: the approval-expiry sweep,
 * the retention purge, the export CLI, the bootstrap.
 *
 * `kind: 'system'` is load-bearing, not decorative. `'administrator'` with a null id would
 * put the sweep in the same bucket as a real person whose id failed to resolve, and
 * `actor_kind` is what a reader filters on to answer "did a human do this?".
 *
 * @param label  what to show where a name would go — `'approval expiry sweep'`. The
 *               bootstrap CLI already establishes this convention with `'bootstrap CLI'`.
 */
export function systemActor(label: string): AuditActor {
    return { kind: 'system', id: null, email: null, displayName: label, tier: null, sessionId: null };
}

/**
 * Context for that same work.
 *
 * This matters more than it looks. `correlation_id`, `method` and `path` are all
 * `required: true` on `IAuditLog`, so a system row that omits them throws at insert —
 * and under D-1 a throwing audit insert CANCELS THE ACTION it was recording. A sweep that
 * cannot describe itself would therefore stop expiring approvals. Hence a real correlation
 * id (minted, so the row still joins its own log lines) and `method: 'SYSTEM'`, which is
 * deliberately not an HTTP verb: it must not be mistaken for a request in the feed.
 *
 * @param source  where the work runs — a file path and function, e.g.
 *                `approval.service#expireOverdue`. It lands in `path`, which is what a
 *                reader greps when they want to know what produced a row.
 */
export function systemContext(source: string, correlationId?: string): AuditContext {
    return {
        method: 'SYSTEM',
        path: source,
        requestId: correlationId ?? `sys-${randomUUID()}`,
        ip: null,
        userAgent: null,
    };
}

function userAgentOf(req: Request): string | null {
    const raw = req.headers['user-agent'];
    // Not `?? null`: a repeated header arrives as string[], and the column is string|null.
    if (typeof raw !== 'string') return null;
    return raw.slice(0, MAX_USER_AGENT_CHARS);
}
