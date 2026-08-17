import { Router } from 'express';
import { AuthController } from '../controllers/auth.controller';
import { defineRoute, mayRecord, mfaEnrolment, publicRoute, records, selfService } from '../../../api/route-manifest';
import {
    authRateLimiter,
    refreshRateLimiter,
} from '../../../api/middlewares/auth-rate-limit.middleware';
import {
    ChangePasswordSchema,
    LoginSchema,
    MfaVerifySchema,
    MfaActivateSchema,
    SessionIdParamSchema,
} from '../validators/auth.validator';

/**
 * `/api/v1/auth` — administrator authentication.
 *
 * Guards are attached PER ROUTE, never as a router-wide `router.use(requireAdmin)`. That
 * is the rule set in `src/api/index.ts`: jovi-mall stacks five routers on one prefix, so a
 * request re-resolves authentication up to five times, and this router mixes public routes
 * (login, refresh) with authenticated ones — a blanket guard would make the public ones
 * unreachable.
 *
 * ── Rewritten onto `defineRoute` in Phase 3 ───────────────────────────────────
 * The handlers, their order and their behaviour are unchanged; what changed is that each
 * route now DECLARES who may reach it, and that declaration is checked at boot. The three
 * public routes here are the entire contents of `PUBLIC_ROUTE_ALLOWLIST` — adding a fourth
 * means editing that list too, which is exactly the friction an unauthenticated route
 * should have.
 *
 * `defineRoute` also attaches `requireCsrfToken` to every route. It self-skips safe
 * methods and bearer clients, so the public routes are unaffected and the authenticated
 * ones keep the protection Phase 2 attached by hand.
 */
const router = Router();
const mountedAt = '/auth';

// ─── Public — no identity yet, by definition ─────────────────────────────────
//
// The strict limiter covers these THREE routes only, not the router. It exists to bound
// credential guessing and every route it covers accepts a credential. Applying it
// router-wide also throttled `/me`, which an authenticated dashboard polls — 10/min is
// nowhere near enough for that, and the failure looked like a broken session rather than
// a rate limit.

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/login',
    access: publicRoute('The credential check itself — there is no identity to require yet'),
    before: [authRateLimiter],
    validate: { body: LoginSchema },
    /**
     * A login records on EVERY outcome, which is why this is `records` and not `mayRecord`:
     * success mints a session, and each distinct failure (unknown address, locked out, bad
     * password, suspended account) writes its own row. `lockout_engaged` is separate again,
     * because the attempt that trips the lock and the lock itself are different facts.
     *
     * All `observation` transport — best-effort by ADR-006 D-1, since refusing a login
     * because the audit store hiccupped would turn this subsystem into a lockout with no
     * break-glass path.
     */
    audit: records(
        'administrators.auth.login_succeeded',
        'administrators.auth.login_failed',
        'administrators.auth.lockout_engaged',
        // An MFA-enrolled administrator's correct password ends here, not at a session.
        'administrators.auth.mfa_challenged',
    ),
    handler: AuthController.login,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/mfa/verify',
    access: publicRoute('Second factor of an in-progress login, keyed by a short-lived challenge'),
    before: [authRateLimiter],
    validate: { body: MfaVerifySchema },
    /**
     * A rejected code records `mfa_failed`; an accepted one completes the login and records
     * `login_succeeded` from `issueSession`. There is no third outcome, so `records`.
     */
    audit: records('administrators.auth.mfa_failed', 'administrators.auth.login_succeeded'),
    handler: AuthController.verifyMfa,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/refresh',
    // Not behind `requireAdmin`: the entire purpose is to be callable once the access
    // token has expired. Its own credential is the refresh token, which `auth.refresh()`
    // verifies and rotates.
    access: publicRoute('Carries its own credential — the refresh token — and is rate limited in its own bucket'),
    // Its OWN bucket, not the credential one. A refresh presents a token the
    // caller already holds, so it is not a guess; sharing the login ceiling meant
    // a few tab reloads produced a 429, which a client cannot distinguish from a
    // dead session and acts on by signing a live operator out.
    before: [refreshRateLimiter],
    /**
     * The clearest `mayRecord` on the service: a successful rotation records NOTHING.
     *
     * Deliberate, and load-bearing for the trail's readability — an active administrator
     * refreshes every fifteen minutes, so recording each one would bury every real action
     * under a tide of routine token rotation (`admin-auth.service.ts` says as much at the
     * call site). What DOES record is reuse detection, which means a refresh token was
     * presented twice and the session is destroyed — the single highest-value row in the
     * log.
     */
    audit: mayRecord('administrators.auth.refresh_reuse_detected'),
    handler: AuthController.refresh,
});

// ─── Authenticated ───────────────────────────────────────────────────────────
//
// `selfService`, not a permission: every one of these acts on the caller's own identity
// and session. A permission would have to be granted to all three tiers to be correct,
// which is noise rather than policy.

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/me',
    // Accepts a scoped enrolment session: an administrator midway through mandatory MFA
    // setup must be able to see who they are.
    access: mfaEnrolment('Reachable mid-enrolment so the dashboard can identify the caller'),
    handler: AuthController.me,
});

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/sessions',
    access: selfService('Lists the caller’s own sessions'),
    handler: AuthController.listSessions,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/logout',
    access: mfaEnrolment('Reachable mid-enrolment so an administrator can back out'),
    audit: records('administrators.auth.logout'),
    handler: AuthController.logout,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/logout-all',
    access: selfService('Ends the caller’s own sessions everywhere'),
    audit: records('administrators.auth.logout_all'),
    handler: AuthController.logoutAll,
});

/**
 * Change your own password.
 *
 * `selfService`, not a permission: every administrator may change their own password by
 * definition, and requiring a permission would mean a tier could be locked out of it. It
 * requires the current password, so a hijacked session cannot take the account over.
 *
 * Behind `authRateLimiter` like the credential routes — it accepts a password, so it is a
 * credential endpoint whatever the mount says, and an unbounded one would be an oracle for
 * guessing the current password from inside a stolen session.
 */
defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/password',
    access: selfService('Every administrator may change their own password'),
    before: [authRateLimiter],
    validate: { body: ChangePasswordSchema },
    audit: records('administrators.auth.password_changed'),
    handler: AuthController.changePassword,
});

defineRoute(router, {
    mountedAt,
    method: 'delete',
    path: '/sessions/:sessionId',
    // Scoped to the caller's OWN sessions in `admin-auth.service.ts`. Revoking another
    // administrator's session is an administrative act over their account and lives at
    // `DELETE /administrators/:adminId/sessions`, behind a permission.
    access: selfService('Revokes one of the caller’s own sessions'),
    validate: { params: SessionIdParamSchema },
    audit: records('administrators.auth.session_revoked'),
    handler: AuthController.revokeSession,
});

// ─── The two routes a scoped enrolment session exists to reach ───────────────

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/mfa/enroll',
    access: mfaEnrolment('The enrolment a mandatory-MFA session exists to complete'),
    audit: records('administrators.auth.mfa_enrolled'),
    handler: AuthController.enrolMfa,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/mfa/activate',
    access: mfaEnrolment('Confirms enrolment with a first correct code'),
    validate: { body: MfaActivateSchema },
    audit: records('administrators.auth.mfa_activated'),
    handler: AuthController.activateMfa,
});

export const authRoutes = router;
