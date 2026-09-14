import { Router } from 'express';
import { defineRoute, mayRecord, permission, records, selfService } from '../../../api/route-manifest';
import { AdministratorController } from '../controllers/administrator.controller';
import {
    AdminIdParamSchema,
    AdminSessionParamSchema,
    CreateAdministratorSchema,
    ListAdministratorsQuerySchema,
    ListSessionsQuerySchema,
    SetTierSchema,
    SuspendAdministratorSchema,
    UpdateAdministratorSchema,
} from '../validators/administrator.validator';
import { ListAuditQuerySchema } from '../../audit/validators/audit.validator';

/**
 * `/api/v1/administrators` — the surface that decides who may use this service.
 *
 * Until this existed, an administrator could only be created by the bootstrap CLI, and no
 * API could change a level, suspend an account, or sign someone else out. The CLI is now
 * restricted to the first administrator only, so this is the way.
 *
 * ── There is deliberately no DELETE ───────────────────────────────────────────
 * Suspension is the model. A deleted administrator leaves audit rows and session history
 * pointing at nothing, and "who did this" stops being answerable — which is the one
 * question an administrator audit trail exists to answer. Do not add one.
 *
 * ── Route order matters ───────────────────────────────────────────────────────
 * `/me` is declared before `/:adminId`. Express matches in registration order, so the
 * reverse would read "me" as an id and fail on the ObjectId check.
 */
const router = Router();
const mountedAt = '/administrators';

// ─── The caller's own record — no permission, by definition ──────────────────

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/me',
    access: selfService('Every administrator may read their own record'),
    handler: AdministratorController.me,
});

defineRoute(router, {
    mountedAt,
    method: 'patch',
    path: '/me',
    // Editing your own display name is not an administrative act over an account.
    // Requiring `administrators.update` here would mean a Support administrator cannot
    // maintain their own profile.
    access: selfService('Every administrator may edit their own profile'),
    validate: { body: UpdateAdministratorSchema },
    audit: records('administrators.profile.update_self'),
    handler: AdministratorController.updateMe,
});

// The caller's own audit entries. `selfService` for the same reason `/me` is: an audit
// trail people cannot see their own entry in is one they have no way to challenge.
// Declared with the other `/me` routes, before `/:adminId`.
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/me/activity',
    access: selfService('Every administrator may read what was recorded about their own actions'),
    validate: { query: ListAuditQuerySchema },
    handler: AdministratorController.myActivity,
});

// ─── The directory ───────────────────────────────────────────────────────────

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/',
    access: permission('administrators.read'),
    validate: { query: ListAdministratorsQuerySchema },
    handler: AdministratorController.list,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/',
    access: permission('administrators.create'),
    validate: { body: CreateAdministratorSchema },
    audit: records('administrators.create'),
    handler: AdministratorController.create,
});

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/:adminId',
    access: permission('administrators.read'),
    validate: { params: AdminIdParamSchema },
    handler: AdministratorController.get,
});

defineRoute(router, {
    mountedAt,
    method: 'patch',
    path: '/:adminId',
    access: permission('administrators.update'),
    validate: { params: AdminIdParamSchema, body: UpdateAdministratorSchema },
    audit: records('administrators.update'),
    handler: AdministratorController.update,
});

// ─── The two audit feeds ─────────────────────────────────────────────────────
//
// Both read `admin_audit_log` through the same repository and the same read scope. They
// differ only in which side of the row they key on — which is exactly why every row
// records an actor AND a target.

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/:adminId/activity',
    access: permission('audit.read'),
    validate: { params: AdminIdParamSchema, query: ListAuditQuerySchema },
    handler: AdministratorController.activity,
});

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/:adminId/history',
    access: permission('audit.read'),
    validate: { params: AdminIdParamSchema, query: ListAuditQuerySchema },
    handler: AdministratorController.history,
});

// ─── Consequential writes ────────────────────────────────────────────────────
//
// Each of these additionally runs the escalation rules in the service: the permission
// says "may you manage administrators", the rules say "may you manage THIS one".

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/:adminId/suspend',
    access: permission('administrators.suspend'),
    validate: { params: AdminIdParamSchema, body: SuspendAdministratorSchema },
    audit: records('administrators.suspend'),
    handler: AdministratorController.suspend,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/:adminId/reinstate',
    access: permission('administrators.suspend'),
    validate: { params: AdminIdParamSchema },
    audit: records('administrators.reinstate'),
    handler: AdministratorController.reinstate,
});

/**
 * Let a pending administrator in (ADR-023 D-1).
 *
 * ── Tier 1, through an `escalation`-flagged permission ───────────────────────
 * Not because activation is an especially senior act, but because it REQUIRES READING THE
 * EMPLOYEE RECORD, and only tier 1 may read one. An Admin able to activate would be waving
 * through a person whose file they cannot open.
 *
 * The consequence was accepted deliberately: a tier-2 Admin can create a Support account and
 * cannot turn it on, so every new hire waits on a Developer.
 *
 * ── `mayRecord`, not `records` ───────────────────────────────────────────────
 * Activating an already-active account returns it unchanged and writes nothing, which is an
 * idempotent success rather than a failure — two Developers clicking one button, or one
 * retrying after a timeout. The audit probe checks a `records` declaration against ANY 2xx, so
 * `records` here would log a `fatal` AUDIT GAP on every such retry.
 *
 * Same reasoning as `administrators.tier.set` below, reached from a different direction: there
 * a success may record nothing because it QUEUED, here because it did nothing.
 */
defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/:adminId/activate',
    access: permission('administrators.activate'),
    validate: { params: AdminIdParamSchema },
    audit: mayRecord('administrators.activate'),
    handler: AdministratorController.activate,
});

defineRoute(router, {
    mountedAt,
    method: 'put',
    path: '/:adminId/tier',
    // ⚠ This said "the only escalation-flagged permission in the catalog" and there are now
    // THREE — `administrators.mfa.reset` joined at Phase 12 and `administrators.activate` at
    // ADR-023. What is still true of this one, and is the point the comment was making:
    // Developer tier only, and promoting TO Developer additionally queues for a second
    // Developer.
    access: permission('administrators.tier.set'),
    validate: { params: AdminIdParamSchema, body: SetTierSchema },
    /**
     * `mayRecord`, not `records`: setting the tier a target already holds returns them
     * unchanged and writes nothing (`administrator.service.ts` — idempotent by design, so a
     * retry is not a failure). A promotion to Developer queues instead of applying, and
     * `auditedQueue` records THAT under the same action name at `status: 'queued'`.
     */
    audit: mayRecord('administrators.tier.set'),
    handler: AdministratorController.setTier,
});

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/:adminId/sessions',
    access: permission('administrators.sessions.read'),
    validate: { params: AdminIdParamSchema, query: ListSessionsQuerySchema },
    handler: AdministratorController.listSessions,
});

defineRoute(router, {
    mountedAt,
    method: 'delete',
    path: '/:adminId/sessions',
    access: permission('administrators.sessions.revoke'),
    validate: { params: AdminIdParamSchema },
    audit: records('administrators.sessions.revoke'),
    handler: AdministratorController.revokeSessions,
});

// One session, not all of them. Declared AFTER the collection route above — Express
// matches in order and these do not overlap, but keeping the specific path second matches
// the ordering convention the rest of this file follows.
defineRoute(router, {
    mountedAt,
    method: 'delete',
    path: '/:adminId/sessions/:sessionId',
    access: permission('administrators.sessions.revoke'),
    validate: { params: AdminSessionParamSchema },
    audit: records('administrators.sessions.revoke_one'),
    handler: AdministratorController.revokeSession,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/:adminId/password-reset',
    access: permission('administrators.password.reset'),
    validate: { params: AdminIdParamSchema },
    audit: records('administrators.password.reset'),
    handler: AdministratorController.resetPassword,
});

/**
 * Clear a lost authenticator so the administrator can enrol a new one.
 *
 * Its own permission, `escalation`-flagged and therefore tier 1 only — separate from the
 * password reset beside it because they remove different controls, and handing over both
 * from one call would hand over the account.
 *
 * A sibling of `password-reset` rather than a `DELETE /:adminId/mfa`: ADR-005 D-4 attaches
 * the permission and the audit row to the ACTION, and this is a reset, not a deletion of a
 * sub-resource the caller could later recreate.
 */
defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/:adminId/mfa-reset',
    access: permission('administrators.mfa.reset'),
    validate: { params: AdminIdParamSchema },
    audit: records('administrators.mfa.reset'),
    handler: AdministratorController.resetMfa,
});

export const administratorRoutes = router;
