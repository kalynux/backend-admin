import { Express, RequestHandler, Router } from 'express';
import { ZodTypeAny } from 'zod';
import { createAppError } from '../core/errors/app-error';
import { ERROR_CODES } from '../core/errors/error-codes';
import { validate } from '../core/validation/validate';
import { PermissionName } from '../modules/authorization/domain/permission.catalog';
import {
    requireAdmin,
    requireAdminAllowingMfaEnrolment,
    requireAdminAllowingPendingActivation,
} from './middlewares/authenticate.middleware';
import { requireAnyPermission, requirePermission } from './middlewares/authorize.middleware';
import { requireCsrfToken } from './middlewares/csrf.middleware';
import { requireServiceToken } from './middlewares/service-token.middleware';
import { AuditAction } from '../modules/audit/domain/audit.catalog';
import { logger } from '../core/logging/logger';
import { emittedInScope, withEmissionScope } from '../modules/audit/domain/audit-emission';

/**
 * The only sanctioned way to register a route, and the reason an unguarded one cannot
 * ship.
 *
 * ── The problem this solves ───────────────────────────────────────────────────
 * Authorization that is attached by remembering to attach it is authorization that is
 * eventually forgotten — jovi-mall has two admin routes guarded inline rather than by
 * their router, which PHASE-0:275 flags as "easy to lose track of". With 81 endpoints
 * arriving at Phase 5 and nine domains at Phase 6, "remember the guard" is not a plan.
 *
 * So `defineRoute` inverts it: a route cannot be registered without SAYING who may call
 * it, because `access` is a required field. There is no default, and no way to pass
 * "none" that is not a deliberate, named, allowlisted choice.
 *
 * Three layers, each catching what the one before it misses:
 *
 *   1. this helper — declaring access is structurally required
 *   2. `assertRouteManifestComplete()` at boot — a route that reached Express without
 *      passing through here fails startup
 *   3. `test-authz.ts` — a source scan refusing any raw `router.get(` in a routes file
 *
 * ── Phase 12 gave auditing the same three layers ──────────────────────────────
 * `audit` is required on a mutating method, `assertAuditCoverageComplete()` checks the
 * declaration and refuses a catalogued action nobody produces, and `test-authz.ts` counts
 * declarations against mutating routes per file. The gap it closes was real: the whole
 * four-eyes decision path and the audit purge shipped recording nothing.
 *
 * ── The chain it builds ───────────────────────────────────────────────────────
 *   auditProbe → before → gate → requireCsrfToken → validate → handler
 *
 * matching the order Phase 2 established by hand in `auth.routes.ts`. `validate` sits
 * after the guards on purpose: an unauthorized caller should not be able to probe a
 * schema, and `validate.ts:10` notes the intent that what a request must look like and
 * who may send it are read together.
 *
 * CSRF is attached unconditionally. It already no-ops on safe methods and on bearer
 * clients (`csrf.middleware.ts:54-62`), so attaching it always costs nothing and removes
 * the entire "forgot CSRF on a new mutating route" failure mode.
 */

/**
 * Split so the type can require an audit declaration on a write and merely permit one on a
 * read — see `RouteDefinition` for why a read is sometimes audited too.
 */
export type SafeMethod = 'get';
export type MutatingMethod = 'post' | 'put' | 'patch' | 'delete';
export type HttpMethod = SafeMethod | MutatingMethod;

/**
 * What this route promises to record.
 *
 * ── Why a route declares this at all (Phase 12) ───────────────────────────────
 * Authorization on this service is enforced by construction: `access` is a required field,
 * a boot assertion refuses a route that bypassed `defineRoute`, and a source scan refuses a
 * raw `router.post(`. Auditing was enforced by *remembering* — which is the failure mode
 * this file's own header warns about, and it duly happened: the entire four-eyes queue and
 * the audit purge shipped unrecorded and stayed that way for two phases, because nothing
 * anywhere could notice.
 *
 * So a mutating route now says what it records, and three layers check it. See
 * `audit-coverage.ts` for what the declaration does and does not prove.
 */
export type RouteAudit =
    /** Emits at least one of these on every 2xx. The strongest, and the default choice. */
    | { kind: 'records'; actions: readonly AuditAction[] }
    /**
     * MAY emit one of these — some success paths legitimately record nothing.
     *
     * Two real cases, and the reason this variant exists rather than weakening `records`:
     * `POST /auth/refresh` records only when it detects token reuse, and
     * `PUT /administrators/:adminId/tier` returns the administrator unchanged when the
     * requested tier is the current one. Both are successes with nothing to say.
     */
    | { kind: 'may'; actions: readonly AuditAction[] }
    /**
     * The action is not knowable from the route: `POST /approvals/:id/approve` performs
     * whatever was queued, so its row names the queued action, not this endpoint.
     */
    | { kind: 'dynamic'; reason: string; oneOf?: readonly AuditAction[] }
    /** Records nothing, deliberately. Allowlisted — see `NO_AUDIT_ROUTE_ALLOWLIST`. */
    | { kind: 'none'; reason: string };

export const records = (...actions: [AuditAction, ...AuditAction[]]): RouteAudit =>
    ({ kind: 'records', actions });

export const mayRecord = (...actions: [AuditAction, ...AuditAction[]]): RouteAudit =>
    ({ kind: 'may', actions });

export const dynamicAudit = (reason: string, oneOf?: readonly AuditAction[]): RouteAudit =>
    ({ kind: 'dynamic', reason, oneOf });

export const noAudit = (reason: string): RouteAudit => ({ kind: 'none', reason });

export type RouteAccess =
    /**
     * No identity at all. The route IS the credential check (login) or carries its own
     * (refresh). Restricted to `PUBLIC_ROUTE_ALLOWLIST` — see the boot assertion.
     */
    | { kind: 'public'; reason: string }
    /**
     * Authenticated, but no permission: the route acts on the caller's own identity and
     * every administrator has it by definition (`/auth/me`, `/permissions/me`).
     *
     * A named choice rather than a default, so "I could not think of a permission" and
     * "this genuinely operates on yourself" cannot be confused.
     */
    | { kind: 'self'; reason: string }
    /**
     * Authenticated by a session that may still owe mandatory MFA enrolment. Only the
     * handful of routes that exist to finish or abandon enrolment.
     */
    | { kind: 'mfa-enrolment'; reason: string }
    /**
     * A CREDENTIALED NON-PERSON (ADR-022). No administrator identity, no tier, no
     * permission — a shared secret proving the caller is a configured machine.
     *
     * ── Why this is a kind of its own and not `public` ────────────────────────
     * A service-token route is not public, and calling it public would put a credentialed
     * endpoint in `PUBLIC_ROUTE_ALLOWLIST` — a list whose whole value is that reading it
     * tells you exactly what the world can reach. It is not `self` or `permission` either:
     * both of those begin with `requireAdmin`, and there is no administrator here.
     *
     * Restricted to `SERVICE_ROUTE_ALLOWLIST` for the same reason `public` is restricted:
     * opening this door is a two-file change that shows up in a diff as exactly that.
     */
    | { kind: 'service'; reason: string }
    | { kind: 'permission'; permissions: readonly PermissionName[]; mode: 'all' | 'any' };

export const publicRoute = (reason: string): RouteAccess => ({ kind: 'public', reason });
export const selfService = (reason: string): RouteAccess => ({ kind: 'self', reason });
export const mfaEnrolment = (reason: string): RouteAccess => ({ kind: 'mfa-enrolment', reason });
export const serviceToken = (reason: string): RouteAccess => ({ kind: 'service', reason });

export const permission = (...permissions: PermissionName[]): RouteAccess => ({
    kind: 'permission',
    permissions,
    mode: 'all',
});

export const anyPermission = (...permissions: PermissionName[]): RouteAccess => ({
    kind: 'permission',
    permissions,
    mode: 'any',
});

/**
 * The complete list of routes that may be reached with no identity.
 *
 * Keyed `METHOD /full/path`. Anything declaring `publicRoute()` that is not listed here
 * fails startup — so opening a route to the world is a two-file change that shows up in
 * a diff as exactly that, rather than a one-word edit inside a route file.
 */
export const PUBLIC_ROUTE_ALLOWLIST: ReadonlySet<string> = new Set([
    'POST /api/v1/auth/login',
    'POST /api/v1/auth/mfa/verify',
    'POST /api/v1/auth/refresh',
]);

/**
 * The complete list of routes reachable by a machine holding a shared secret rather than
 * by an administrator (ADR-022).
 *
 * Keyed `METHOD /full/path`, mirroring `PUBLIC_ROUTE_ALLOWLIST` exactly. It holds ONE
 * entry and the intent is that it keeps holding one: this service's identity model is
 * "administrators, graded by tier", and every service caller added here is a caller that
 * model does not describe.
 *
 * The bound to point the next "just one more machine endpoint" request at: a service
 * route may only WRITE something a machine observed about itself. It may never read
 * platform data, because there is no tier to grade the answer by — which is the whole
 * reason the read half of this feature sits on `/api/v1/automation` behind three
 * permissions instead.
 */
export const SERVICE_ROUTE_ALLOWLIST: ReadonlySet<string> = new Set([
    'POST /api/internal/automation/failures',
]);

/**
 * The complete list of routes a **pending** administrator may reach — an account that has been
 * created, can sign in, and has not yet been activated by a Developer (ADR-023 D-1).
 *
 * Keyed `METHOD /full/path`, mirroring the two allowlists above and for the same reason:
 * opening a route to somebody who has not been let in yet is a one-line change in a list whose
 * whole value is that reading it tells you exactly what such a person can reach. A route not
 * listed here is closed to them, so one added next year is closed by default.
 *
 * ── ⚠ WHY AN ALLOWLIST RATHER THAN "any `selfService` route" ────────────────
 * That rule is the obvious one, it is one line instead of thirty, and it is WRONG — which is
 * worth recording, because it will be proposed again.
 *
 * `selfService` means "authenticated, no permission, because the route acts on the caller's
 * own identity". Three of the routes carrying it are the DUAL-CONTROL approval endpoints —
 * `POST /approvals/:id/approve`, `/reject`, `/withdraw` — and they are declared that way
 * because the permission they need is resolved PER REQUEST against the queued action rather
 * than at mount time. They are not self-service in any other sense: approving is the single
 * most consequential act on this service, and a kind-based rule would hand it to an
 * administrator nobody has admitted yet.
 *
 * ── What is here, and the one rule that puts it here ─────────────────────────
 * Everything a new administrator needs to finish onboarding, and nothing else:
 *   - their session (who am I, sign out, change my password, list and revoke my devices)
 *   - two-factor enrolment (also reachable through the MFA gate, which lifts both half-states)
 *   - their own profile and their own employee record, including document upload
 *   - address search, so they can geocode their home address
 *   - the permission vocabulary, so the dashboard can render at all
 *
 * ⚠ `GET /permissions/me` is here and is safe: a pending administrator's grants are real —
 * their tier is set at creation — and the answer tells them what they WILL be able to do.
 * Withholding it means the dashboard cannot decide which shell to render and falls back to
 * an error page. It grants nothing; `requireAdmin` still refuses every route it names.
 *
 * ⚠ `GET /administrators/me/activity` is here deliberately. An audit trail somebody cannot
 * see their own entry in is one they have no way to challenge, and that argument does not
 * start applying on the day they are activated. It is scoped to their own rows.
 *
 * ── ⚠ THIS LIST IS NOT THE COMPLETE INVENTORY, AND THE GAP IS DELIBERATE ────
 * FOUR more routes are reachable by a pending administrator and are NOT here, because this
 * list is not what opens them: `GET /auth/me`, `POST /auth/logout`, `POST /auth/mfa/enroll`
 * and `POST /auth/mfa/activate` declare `mfaEnrolment()` access, and that gate lifts BOTH
 * half-states — an administrator mid-enrolment and an administrator awaiting activation.
 *
 * They are not listed because a route here that this list does not actually gate would be
 * worse than an omission: somebody deleting the entry to close the route would close nothing,
 * and believe they had. The boot assertion refuses any non-`self` entry for that reason.
 *
 * So: to answer *"what can a pending administrator reach"*, read this list AND the four
 * `mfaEnrolment()` routes. To answer *"what does this list control"*, read this list alone.
 */
export const ONBOARDING_ROUTE_ALLOWLIST: ReadonlySet<string> = new Set([
    // ── Session and credentials ──────────────────────────────────────────────
    // The MFA enrolment pair and `/auth/me` and `/auth/logout` are absent on purpose — see
    // the ⚠ above. They come through `mfaEnrolment()`, which lifts both half-states.
    'GET /api/v1/auth/sessions',
    'POST /api/v1/auth/logout-all',
    'POST /api/v1/auth/password',
    'DELETE /api/v1/auth/sessions/:sessionId',

    // ── Their own directory record ───────────────────────────────────────────
    'GET /api/v1/administrators/me',
    'PATCH /api/v1/administrators/me',
    'GET /api/v1/administrators/me/activity',

    // ── Their own employee record — the point of the whole state ─────────────
    'GET /api/v1/employees/me',
    'PATCH /api/v1/employees/me',
    'PUT /api/v1/employees/me/avatar',
    'POST /api/v1/employees/me/documents/:slot',
    'DELETE /api/v1/employees/me/documents/:slot/:fileId',

    // ── Geocoding, so the home address can be resolved ───────────────────────
    'GET /api/v1/geo/search',
    'GET /api/v1/geo/reverse',

    // ── So the dashboard can render a shell ──────────────────────────────────
    'GET /api/v1/permissions/me',
]);

/**
 * The complete list of MUTATING routes that record nothing.
 *
 * Keyed `METHOD /full/path`, mirroring `PUBLIC_ROUTE_ALLOWLIST` and for the same reason:
 * declaring `noAudit()` is not enough on its own, so choosing not to record a write is a
 * two-file change that shows up in a diff as exactly that.
 *
 * It was empty through Phase 12, and that was the finding: every one of the 61 mutating
 * routes mapped to a catalogued action, a `mayRecord`, or the dual-control `dynamicAudit`.
 *
 * ── Phase 13 adds the first five, all of them inbox hygiene ───────────────────
 * Marking a notification read, unread, archived or unarchived changes nothing about the
 * platform and nothing about this service's configuration. It records that an
 * administrator looked at their own inbox — and ADR-006 D-5 already decided that reads are
 * not audited, with one deliberate exception (a payout destination, where the disclosure
 * IS the action). A read receipt is on the far side of that line.
 *
 * Auditing them would also actively damage the trail it is meant to protect: an
 * administrator triaging a morning's alerts generates dozens of rows that say nothing about
 * what anybody DID, diluting the record a security review reads. What the administrator
 * then does about the notification — resolve the discrepancy, mark the payout paid — is
 * audited by the endpoint that does it, which is where the action actually is.
 *
 * The one write on that surface that IS audited is the preference change
 * (`notifications.preferences.update_self`), because it is durable configuration that
 * changes what this service does in future rather than a record of having looked.
 */
export const NO_AUDIT_ROUTE_ALLOWLIST: ReadonlySet<string> = new Set([
    /**
     * ── ADR-022 adds the sixth, and it is a different kind of thing ───────────
     * The five below are an administrator's own inbox hygiene. This one has no
     * administrator at all: it is a machine reporting that it failed.
     *
     * The audit trail is defined as "the append-only record of every administrator
     * action" and its actor field expects a person. A row here would have to invent one,
     * and inventing an actor in an audit trail is worse than omitting the row — it makes
     * the trail's central claim false. The report is itself a durable record in
     * `admin_automation_failures`; what is not recorded is an administrator having done
     * something, because none did.
     */
    'POST /api/internal/automation/failures',

    'POST /api/v1/notifications/read-all',
    'PATCH /api/v1/notifications/:notificationId/read',
    'PATCH /api/v1/notifications/:notificationId/unread',
    'POST /api/v1/notifications/:notificationId/archive',
    'POST /api/v1/notifications/:notificationId/unarchive',
]);

interface RouteDefinitionBase {
    /** Path within the router this is registered on, e.g. `/:adminId/tier`. */
    path: string;
    access: RouteAccess;
    handler: RequestHandler;
    /** Extra middleware to run BEFORE the gate — rate limiters, in practice. */
    before?: RequestHandler[];
    validate?: { body?: ZodTypeAny; query?: ZodTypeAny; params?: ZodTypeAny };
    /** Prefix this router is mounted at, for the manifest's full path. */
    mountedAt: string;
    /**
     * The API prefix this router hangs off. Defaults to `/api/v1` — the dashboard surface,
     * and every route on the service but one.
     *
     * `/api/internal` is the exception (ADR-022): a machine door, outside the versioned
     * contract because nothing there is a promise to a dashboard. It is a field rather
     * than a hardcoded string so the manifest's full paths stay true, which is what the
     * two allowlists and the boot assertion are keyed on.
     */
    apiPrefix?: '/api/v1' | '/api/internal';
}

/**
 * A route declaration. `audit` is REQUIRED on a mutating method, OPTIONAL on a read.
 *
 * ── Why required on a write ───────────────────────────────────────────────────
 * Same shape `access` uses: a mutation cannot be registered without saying what it records,
 * so "nobody decided" is not a state a route can be in. The type is the first of three
 * layers — see `audit-coverage.ts`.
 *
 * ── Why merely optional on a read, rather than forbidden ──────────────────────
 * The obvious rule is "reads are not audited" (ADR-006 D-5 records what MOVED, and the
 * request log already has the rest), and it holds for all but one route on the service.
 * The exception is real and was built deliberately in Phase 11:
 * `GET /money/payouts/:payoutId/destination` reveals a beneficiary's account number, and a
 * DISCLOSURE is an action even though nothing changed. Its audit row is the control — the
 * intent commits before the digits are read, so with the audit store down nothing is
 * disclosed.
 *
 * So the axis is not read-versus-write, it is "did anything happen that the trail should
 * hold". Every write qualifies by definition; a read qualifies when it hands out something
 * the permission exists to protect. Forbidding `audit` on a GET would have made that
 * endpoint undeclarable and left its catalogued action looking like a producer-less orphan.
 */
export type RouteDefinition =
    | (RouteDefinitionBase & { method: SafeMethod; audit?: RouteAudit })
    | (RouteDefinitionBase & { method: MutatingMethod; audit: RouteAudit });

export interface RouteDeclaration {
    method: HttpMethod;
    /** The full path as Express will match it, e.g. `/api/v1/administrators/:adminId/tier`. */
    fullPath: string;
    access: RouteAccess;
    /** Null for a read; always present for a mutation. */
    audit: RouteAudit | null;
}

const manifest: RouteDeclaration[] = [];

/** Every route declared so far. Read by the boot assertion and the authz tests. */
export function routeManifest(): readonly RouteDeclaration[] {
    return manifest;
}

/** Test-only: empty the manifest so a suite can register a synthetic router. */
export function resetRouteManifest(): void {
    manifest.length = 0;
}

function joinPath(prefix: string, mountedAt: string, path: string): string {
    const base = `${prefix}${mountedAt}`;
    if (path === '/') return base;
    return `${base}${path}`;
}

/**
 * @param routeKey `METHOD /full/path`, used to look this route up in
 *        `ONBOARDING_ROUTE_ALLOWLIST`. Passed in rather than derived, because the caller has
 *        already built it for the manifest and the two must be the same string.
 */
function gateFor(access: RouteAccess, routeKey: string): RequestHandler[] {
    /**
     * ⚠ The allowlist is consulted for `self` ONLY.
     *
     * A `permission` route is never opened to a pending administrator, whatever the list says,
     * and that is enforced here rather than by trusting the list to stay correct: an
     * unactivated account reaching anything behind a permission would defeat the entire state.
     * The boot assertion refuses such an entry outright, so this is the second of two locks.
     */
    const onboarding = access.kind === 'self' && ONBOARDING_ROUTE_ALLOWLIST.has(routeKey);

    switch (access.kind) {
        case 'public':
            return [];
        case 'self':
            return [onboarding ? requireAdminAllowingPendingActivation : requireAdmin];
        case 'mfa-enrolment':
            return [requireAdminAllowingMfaEnrolment];
        // Note what is absent: `requireAdmin`. A service caller is not a person, and
        // nothing downstream may treat it as one — see the middleware's header.
        case 'service':
            return [requireServiceToken];
        case 'permission':
            return [
                requireAdmin,
                access.mode === 'all'
                    ? requirePermission(...access.permissions)
                    : requireAnyPermission(...access.permissions),
            ];
    }
}

/**
 * Watch whether a route emitted what it declared, and complain if not.
 *
 * Runs FIRST in the chain — before the gate — so the scope wraps everything downstream,
 * including a writer reached from a guard (a denial row) rather than the handler.
 *
 * Three properties, all load-bearing:
 *
 *   - it never touches the response. The comparison happens on `finish`, when the status
 *     line is long gone; the only honest output is a log line.
 *   - it only complains about `records` at a 2xx. A `mayRecord` route legitimately emits
 *     nothing, a `dynamic` one names an action this layer cannot predict, and a non-2xx
 *     may have failed before reaching the writer.
 *   - it is `fatal`, matching the `AUDIT GAP` level the writer uses. An action that
 *     succeeded while recording nothing is the exact condition this phase exists to make
 *     impossible, so if it ever fires, something is wrong that no test caught.
 */
function auditProbe(audit: RouteAudit, label: string): RequestHandler {
    return (req, res, next) => {
        withEmissionScope(() => {
            res.on('finish', () => {
                if (audit.kind !== 'records') return;
                if (res.statusCode < 200 || res.statusCode >= 300) return;

                const emitted = emittedInScope();
                if (emitted && audit.actions.some((action) => emitted.has(action))) return;

                logger().fatal(
                    {
                        route: label,
                        requestId: req.requestId,
                        declared: audit.actions,
                        emitted: emitted ? [...emitted] : [],
                    },
                    'AUDIT DECLARATION UNMET: the route succeeded and recorded none of the actions it declares',
                );
            });

            next();
        });
    };
}

/**
 * Register a route and record what may reach it.
 *
 * @example
 *   defineRoute(router, {
 *       mountedAt: '/administrators',
 *       method: 'put',
 *       path: '/:adminId/tier',
 *       access: permission('administrators.tier.set'),
 *       validate: { params: AdminIdParamSchema, body: SetTierSchema },
 *       audit: mayRecord('administrators.tier.set'),
 *       handler: AdministratorsController.setTier,
 *   });
 */
export function defineRoute(router: Router, definition: RouteDefinition): void {
    const fullPath = joinPath(definition.apiPrefix ?? '/api/v1', definition.mountedAt, definition.path);
    const routeKey = `${definition.method.toUpperCase()} ${fullPath}`;

    if (definition.access.kind === 'permission' && definition.access.permissions.length === 0) {
        throw createAppError(
            ERROR_CODES.AUTHZ_ROUTE_UNDECLARED,
            500,
            `${definition.method.toUpperCase()} ${fullPath} declares permission access with no permissions`,
        );
    }

    const chain: RequestHandler[] = [
        // First, so the emission scope covers the guards too — a denial writes a row.
        ...(definition.audit ? [auditProbe(definition.audit, `${definition.method.toUpperCase()} ${fullPath}`)] : []),
        ...(definition.before ?? []),
        ...gateFor(definition.access, routeKey),
        requireCsrfToken,
        ...(definition.validate ? [validate(definition.validate)] : []),
        definition.handler,
    ];

    router[definition.method](definition.path, ...chain);

    manifest.push({
        method: definition.method,
        fullPath,
        access: definition.access,
        audit: definition.audit ?? null,
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Boot assertion
// ─────────────────────────────────────────────────────────────────────────────

interface ExpressLayer {
    route?: { path: unknown; methods: Record<string, boolean> };
    name?: string;
    handle?: { stack?: ExpressLayer[] };
    regexp?: RegExp;
}

/**
 * Recover the paths Express actually registered, so a route that bypassed `defineRoute`
 * can be spotted.
 *
 * This reads `app._router.stack`, which is Express 4 internals and the one fragile piece
 * of this design. It is used ONLY for detection — never for the authorization decision —
 * so if a future Express changes the shape, the failure is a loud startup error we
 * notice, not a silent hole. The source-scan test in `test-authz.ts` is the backstop that
 * does not depend on internals at all.
 */
function collectRegisteredRoutes(app: Express): string[] {
    const found: string[] = [];

    const walk = (layers: ExpressLayer[] | undefined, prefix: string): void => {
        if (!layers) return;

        for (const layer of layers) {
            if (layer.route && typeof layer.route.path === 'string') {
                for (const [method, enabled] of Object.entries(layer.route.methods)) {
                    if (!enabled) continue;
                    const path = layer.route.path === '/' ? prefix : `${prefix}${layer.route.path}`;
                    found.push(`${method.toUpperCase()} ${path || '/'}`);
                }
                continue;
            }

            if (layer.name === 'router' && layer.handle?.stack) {
                walk(layer.handle.stack, prefix + mountPathOf(layer));
            }
        }
    };

    // Express 4 exposes the root stack as `app._router`; it is undefined until the first
    // route or middleware is registered, which by this point has always happened.
    const root = (app as unknown as { _router?: { stack?: ExpressLayer[] } })._router;
    walk(root?.stack, '');

    return found;
}

/**
 * Recover a router's mount prefix from the regexp Express compiled for it.
 *
 * Express does not keep the original string. This unescapes the generated pattern, which
 * is reliable for the literal prefixes this service uses (`/api/v1`, `/administrators`)
 * and returns '' for anything it cannot read — a miss makes the assertion report a path
 * that looks wrong, which is a visible failure rather than a silent pass.
 */
function mountPathOf(layer: ExpressLayer): string {
    const source = layer.regexp?.source;
    if (!source) return '';
    if (source === '^\\/?(?=\\/|$)') return '';

    const match = /^\^\\\/(?<path>.*?)\\\/\?\(\?=\\\/\|\$\)$/.exec(source);
    if (!match?.groups?.path) return '';

    return `/${match.groups.path.replace(/\\(.)/g, '$1')}`;
}

/**
 * Refuse to start when a route reached the router without declaring who may call it, or
 * when a route claims to be public without being allowlisted.
 *
 * Called from `createApp()` after `/api/v1` is mounted. Health lives outside `/api/v1`
 * and is deliberately exempt: it is mounted before the rate limiter precisely so an
 * orchestrator can reach it, and it exposes no data.
 */
export function assertRouteManifestComplete(app: Express): void {
    const problems: string[] = [];

    const declared = new Map<string, RouteDeclaration>();
    for (const route of manifest) {
        const key = `${route.method.toUpperCase()} ${route.fullPath}`;
        if (declared.has(key)) {
            problems.push(`${key} is declared more than once`);
        }
        declared.set(key, route);

        if (route.access.kind === 'public' && !PUBLIC_ROUTE_ALLOWLIST.has(key)) {
            problems.push(`${key} declares public access but is not in PUBLIC_ROUTE_ALLOWLIST`);
        }

        // Same shape, same reason (ADR-022). Without this, adding a second machine door
        // would be a one-word edit inside a route file rather than a visible decision.
        if (route.access.kind === 'service' && !SERVICE_ROUTE_ALLOWLIST.has(key)) {
            problems.push(`${key} declares service-token access but is not in SERVICE_ROUTE_ALLOWLIST`);
        }

        // The converse, which `public` does not need because `/api/v1` is scanned whole:
        // an `/api/internal` route that forgot `serviceToken()` would declare some
        // administrator gate on a path no administrator can reach, and look merely broken.
        if (route.fullPath.startsWith('/api/internal') && route.access.kind !== 'service') {
            problems.push(`${key} is on /api/internal but does not declare serviceToken() access`);
        }
    }

    /**
     * The onboarding allowlist, checked in BOTH directions (ADR-023 D-1).
     *
     * ── Entry names a real route ─────────────────────────────────────────────
     * An entry with a typo, a renamed path or a stale method is worse than useless: it
     * silently grants nothing, so the route it was meant to open stays closed to every new
     * administrator and the list still *reads* as though it had been handled. That failure
     * mode has no symptom until somebody's first day.
     *
     * ── Entry is `self` ──────────────────────────────────────────────────────
     * The stronger of the two. `gateFor` already refuses to apply the relaxed gate to anything
     * but a `self` route, so an entry naming a `permission` route grants nothing — but it
     * would sit in the list looking like a decision somebody made, and the next person to
     * "fix" the apparent inconsistency would be removing the second lock rather than the
     * mistake. Refusing at boot means such an entry never survives a first run.
     */
    for (const key of ONBOARDING_ROUTE_ALLOWLIST) {
        const route = declared.get(key);
        if (!route) {
            problems.push(`${key} is in ONBOARDING_ROUTE_ALLOWLIST but no such route is declared`);
            continue;
        }
        if (route.access.kind !== 'self') {
            problems.push(
                `${key} is in ONBOARDING_ROUTE_ALLOWLIST but declares ${route.access.kind} access — `
                + 'only selfService() routes may be reached before activation (ADR-023 D-1)',
            );
        }
    }

    for (const registered of collectRegisteredRoutes(app)) {
        // `/api/v1` and `/api/internal` are both in scope. `/health` sits outside them
        // deliberately — mounted before the rate limiter so an orchestrator can always
        // reach it, and exposing nothing that needs a decision.
        const path = registered.slice(registered.indexOf(' ') + 1);
        if (!path.startsWith('/api/v1') && !path.startsWith('/api/internal')) continue;

        if (!declared.has(registered)) {
            problems.push(`${registered} was registered without defineRoute() — it declares no access rule`);
        }
    }

    if (problems.length > 0) {
        throw createAppError(
            ERROR_CODES.AUTHZ_ROUTE_UNDECLARED,
            500,
            `Route access declarations are incomplete:\n  - ${problems.join('\n  - ')}`,
            { problemCount: problems.length, problems },
        );
    }
}
