import { createAppError } from '../core/errors/app-error';
import { ERROR_CODES } from '../core/errors/error-codes';
import { AUDIT_ACTION_NAMES, AuditAction, auditSpec, isAuditAction } from '../modules/audit/domain/audit.catalog';
import { NON_ROUTE_AUDIT_PRODUCERS } from '../modules/audit/domain/audit.producers';
import { NO_AUDIT_ROUTE_ALLOWLIST, RouteAudit, RouteDeclaration, routeManifest } from './route-manifest';

/**
 * Audit coverage, asserted at boot.
 *
 * ── The gap this closes ───────────────────────────────────────────────────────
 * `assertRouteManifestComplete` proves every route declared WHO may call it.
 * This proves every mutation declared WHAT it records, and — the half that actually caught
 * something — that every action the catalog declares is produced by somebody.
 *
 * That second check is not hypothetical. Five `approvals.*` actions and both `audit.*`
 * actions sat in the catalog for two phases with no writer anywhere: the entire four-eyes
 * decision path and the only operation that DELETES an audit row were catalogued, believed
 * done, and silently recording nothing. Nothing in the service could notice, because
 * "declared" and "written" had no relationship a machine could check.
 *
 * ── What a declaration proves, and what it does not ───────────────────────────
 * An `audit:` declaration is a **promise, checked three ways** — the type refuses a mutating
 * route without one, this assertion refuses an action the catalog does not know or a
 * permission the route does not hold, and `test-authz.ts` refuses a route file that bypassed
 * the helper.
 *
 * What it does **not** prove is that a row was written. The writer call sits deep in a
 * service or a gateway, and a handler could return 200 having recorded nothing. So the
 * declaration closes the *design* gap (nobody decided what this route records) and the
 * *coverage* gap (an action nobody produces); it does not close the *implementation* gap.
 * The runtime probe in `audit-emission.ts` is the smoke detector for that last one — a
 * detector, never a lock, because by the time it can know, the response is already sent.
 */

interface CoverageProblem {
    route: string;
    problem: string;
}

export function assertAuditCoverageComplete(): void {
    const problems: CoverageProblem[] = [];
    const produced = new Set<AuditAction>();

    for (const route of routeManifest()) {
        const label = `${route.method.toUpperCase()} ${route.fullPath}`;

        if (route.audit === null) {
            // A read with no declaration is the normal case and needs no check: the type
            // already guarantees a mutation cannot reach here with `audit: null`.
            continue;
        }

        checkDeclaration(route, label, problems, produced);
    }

    for (const actions of Object.values(NON_ROUTE_AUDIT_PRODUCERS)) {
        for (const action of actions) produced.add(action);
    }

    for (const action of AUDIT_ACTION_NAMES) {
        if (produced.has(action)) continue;
        problems.push({
            route: action,
            problem:
                'catalogued but produced by nothing — no route declares it and no entry in '
                + 'NON_ROUTE_AUDIT_PRODUCERS claims it. Either wire it, register its producer, '
                + 'or delete it from the catalog',
        });
    }

    if (problems.length > 0) {
        throw createAppError(
            ERROR_CODES.AUDIT_COVERAGE_INCOMPLETE,
            500,
            `Audit coverage is incomplete:\n${problems.map((p) => `  ${p.route}: ${p.problem}`).join('\n')}`,
            { problems },
        );
    }
}

function checkDeclaration(
    route: RouteDeclaration,
    label: string,
    problems: CoverageProblem[],
    produced: Set<AuditAction>,
): void {
    const audit = route.audit as RouteAudit;

    if (audit.kind === 'none') {
        if (!NO_AUDIT_ROUTE_ALLOWLIST.has(label)) {
            problems.push({
                route: label,
                problem:
                    `declares noAudit("${audit.reason}") but is not in NO_AUDIT_ROUTE_ALLOWLIST. `
                    + 'Choosing not to record a write is a two-file change on purpose',
            });
        }
        return;
    }

    const actions = audit.kind === 'dynamic' ? (audit.oneOf ?? []) : audit.actions;

    if (audit.kind !== 'dynamic' && actions.length === 0) {
        problems.push({ route: label, problem: 'declares an audit action list that is empty' });
        return;
    }

    for (const action of actions) {
        if (!isAuditAction(action)) {
            problems.push({ route: label, problem: `names "${action}", which is not in AUDIT_CATALOG` });
            continue;
        }

        produced.add(action);
        checkPermissionCoherence(route, label, action, problems);
    }
}

/**
 * A route may only claim actions its own permission governs.
 *
 * Free to check, and it keeps the catalog's naming convention — "where an action is governed
 * by a permission it REUSES that permission's name" — true mechanically rather than by
 * habit. The failure it prevents is a route quietly recording somebody else's action, which
 * would make a permission-scoped read of the trail (`GET /users/:id/activity` filters by
 * family) show rows the reader's permission does not cover.
 *
 * Actions with `permission: null` are exempt: identity events belong to no permission
 * because every administrator performs them on themselves by definition.
 *
 * The non-obvious passes are worth knowing about, because they look like violations:
 *   - `POST /:adminId/reinstate` is guarded by `administrators.suspend` and records
 *     `administrators.reinstate`, whose spec permission IS `administrators.suspend`
 *   - `POST /:vendorId/kyc/approve` is guarded by `vendors.kyc.review` and records
 *     `vendors.kyc.approve`, likewise
 * In both, one permission governs two opposite acts that need distinct rows.
 */
function checkPermissionCoherence(
    route: RouteDeclaration,
    label: string,
    action: AuditAction,
    problems: CoverageProblem[],
): void {
    const governing = auditSpec(action).permission;
    if (governing === null) return;
    if (route.access.kind !== 'permission') return;

    if (!route.access.permissions.includes(governing)) {
        problems.push({
            route: label,
            problem:
                `records "${action}", governed by "${governing}", which this route does not require `
                + `(it requires ${route.access.permissions.join(', ')})`,
        });
    }
}
