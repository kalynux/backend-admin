import { NextFunction, Request, RequestHandler, Response } from 'express';
import { requestContext } from '../../modules/audit/domain/audit-context';
import { createAppError } from '../../core/errors/app-error';
import { ERROR_CODES } from '../../core/errors/error-codes';
import { requireAdminIdentity } from '../../modules/admin-identity/domain/admin-identity.types';
import { PermissionName } from '../../modules/authorization/domain/permission.catalog';
import {
    hasAllPermissions,
    hasAnyPermission,
    missingPermissions,
} from '../../modules/authorization/domain/permission.resolver';
import { recordAuthorizationDenial } from '../../modules/authorization/domain/denial.recorder';

/**
 * The authorization gate — "may you", after `requireAdmin` has settled "who are you".
 *
 * ── Ordering is an invariant, not a convention ────────────────────────────────
 * These guards MUST sit after `requireAdmin`, which is what `defineRoute` guarantees.
 * That ordering is doing real work, and reversing it would be a security change rather
 * than a style change:
 *
 *   - a SUSPENDED administrator is refused by `requireAdmin` before this runs, and their
 *     sessions are destroyed on the way out (`authenticate.middleware.ts:100-106`)
 *   - an administrator who owes mandatory MFA holds a session scoped to the enrolment
 *     endpoints and is refused everywhere else, also before this runs (`:113-121`)
 *   - `tier` is re-read from Mongo on that pass, so the level this guard reads is the
 *     level the account holds NOW, not the one minted into the token
 *
 * So there is deliberately no status or MFA check here. If you find yourself adding one,
 * the ordering has been broken somewhere upstream.
 *
 * ── What a 403 says ───────────────────────────────────────────────────────────
 * `details.required` names the permission. It does NOT name the caller's tier or what
 * they hold — jovi-mall's `requireRole` returns `{ required, actual }`, and echoing the
 * caller's own standing back to them is a gratuitous leak. The required name alone makes
 * a 403 debuggable, and any authenticated administrator can read the catalog anyway.
 */

type Mode = 'all' | 'any';

function buildGuard(mode: Mode, names: readonly PermissionName[]): RequestHandler {
    if (names.length === 0) {
        // A guard that requires nothing is an open route wearing a guard's clothes. Fail
        // at import time, when the route file is loaded, rather than at request time.
        throw createAppError(
            ERROR_CODES.AUTHZ_ROUTE_UNDECLARED,
            500,
            'requirePermission() was called with no permission name',
        );
    }

    return (req: Request, _res: Response, next: NextFunction): void => {
        // Throws 401 if this ran without `requireAdmin` — an honest failure rather than
        // a crash on undefined, and it makes a misassembled chain obvious in testing.
        const identity = requireAdminIdentity(req);

        const permitted =
            mode === 'all'
                ? hasAllPermissions(identity.tier, names)
                : hasAnyPermission(identity.tier, names);

        if (permitted) return next();

        recordAuthorizationDenial({
            kind: 'permission',
            adminId: identity.adminId,
            tier: identity.tier,
            sessionId: identity.sessionId,
            required: mode === 'all' ? missingPermissions(identity.tier, names) : names,
            reason: ERROR_CODES.AUTHZ_PERMISSION_DENIED,
            // `requestContext` supplies method/path/requestId/ip/userAgent — including the
            // `originalUrl` rule (inside a router `req.path` has lost the mount prefix, and
            // a denial reading `/tier` rather than `/api/v1/administrators/:id/tier` is not
            // worth logging). One definition, in the audit module, rather than a fifth copy.
            ...requestContext(req),
        });

        next(
            createAppError(ERROR_CODES.AUTHZ_PERMISSION_DENIED, 403, undefined, {
                required: [...names],
                mode,
            }),
        );
    };
}

/**
 * Require EVERY named permission.
 *
 * The default, and the safe reading of a multi-name declaration: a route that touches
 * both money and administrators should need both, not either.
 *
 *   defineRoute(router, { access: permission('cod.remittances.confirm'), ... })
 */
export function requirePermission(...names: PermissionName[]): RequestHandler {
    return buildGuard('all', names);
}

/**
 * Require ANY of the named permissions.
 *
 * For a genuinely alternative surface — a record reachable by two different jobs — not as
 * a way to soften a route that is failing for someone. Rare on purpose.
 */
export function requireAnyPermission(...names: PermissionName[]): RequestHandler {
    return buildGuard('any', names);
}
