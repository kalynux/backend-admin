import { AuditAction } from './audit.catalog';

/**
 * Every catalogued action that is written from somewhere other than an HTTP route.
 *
 * ── Why this file exists ──────────────────────────────────────────────────────
 * `assertAuditCoverageComplete()` refuses to boot when a catalogued action has no producer.
 * Most actions are produced by a route, which declares them and is therefore self-evident.
 * These are not: they come from a background sweep, a CLI, a middleware, or a branch of a
 * service that no single route owns.
 *
 * Without this registry those actions would look like orphans and the assertion would be
 * unusable — so the honest options were "let a real gap hide among false positives" or
 * "make the exceptions explicit". This is the second.
 *
 * ── What adding a line here costs, deliberately ───────────────────────────────
 * It is a claim, not a check. Nothing verifies that the named file really writes the named
 * action, so an entry here is how a genuinely unwired action could be hidden from the boot
 * assertion — which is exactly what happened to `approvals.*` before Phase 12, informally.
 *
 * So: name the file AND the function, and add a line only when you have just written the
 * call. A key that no longer resolves to real code is a lie the assertion will not catch.
 */
export const NON_ROUTE_AUDIT_PRODUCERS: Readonly<Record<string, readonly AuditAction[]>> = Object.freeze({
    /**
     * The lazy expiry sweep, run from the approval read paths rather than a worker. Nobody
     * requests an expiry, so no route can declare it.
     */
    'dual-control/domain/approval.service.ts#expireOverdue': ['approvals.expired'],

    /**
     * A suspension evicting live sessions. Neither path is a route anybody calls: one is a
     * branch of `POST /auth/refresh` (which declares only reuse detection), the other is the
     * authentication gate itself, which runs before any route.
     */
    'admin-identity/domain/admin-auth.service.ts#refresh': ['administrators.auth.session_terminated'],
    'api/middlewares/authenticate.middleware.ts': ['administrators.auth.session_terminated'],

    /**
     * The CLI has no route by definition. `--purge` is the only path in the service that
     * deletes an audit row, and `--restamp` moves the deletion date of the whole archive.
     */
    'scripts/audit-export.ts': ['audit.purge', 'audit.retention.restamp'],

    /**
     * Boot-time resume of an export that wrote its file and died before stamping. It makes
     * rows deletable, which is the same lever `--restamp` pulls, so it reuses that action.
     */
    'lifecycle.ts#resumeUnstampedExports': ['audit.retention.restamp'],

    /**
     * The first administrator, created before any administrator exists to authenticate as.
     * `actor.kind` is `system` and the context says `CLI`.
     */
    'scripts/bootstrap-admin.ts': ['administrators.create'],

    /**
     * The staff identity-document upload (ADR-023).
     *
     * ⚠ It IS reached by a route — `POST /employees/me/documents/:slot` — and still belongs
     * here, which is the one case in this registry that needs explaining.
     *
     * That route declares `employees.documents.attach`, the `wi-admin` write that files the
     * returned id into a slot. `employees.documents.upload` is emitted one step earlier, by
     * the gateway, as an ATTEMPT committed BEFORE the bytes are streamed — the fail-closed
     * posture that means an unreachable audit store stores no identity document.
     *
     * The route cannot declare both: the audit probe checks a `records` declaration against
     * any 2xx, and the attempt row is written under a different transport (`external` — the
     * bytes land in jovi-mall's database, which no wi-admin ClientSession can join). Declaring
     * the attempt would make every SUCCESSFUL upload look like an unmet declaration.
     */
    'employees/gateways/employee-document.gateway.ts#uploadStaffDocument': ['employees.documents.upload'],
});
