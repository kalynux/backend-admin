import { Router } from 'express';
import { defineRoute, permission, records } from '../../../api/route-manifest';
import { UserController } from '../controllers/user.controller';
import {
    ListUserActivityQuerySchema,
    ResetBotMemorySchema,
    SearchUsersQuerySchema,
    SendCredentialSchema,
    SuspendUserSchema,
    UpdateUserSchema,
    UserIdParamSchema,
} from '../validators/user.validator';

/**
 * `/api/v1/users` — platform user management.
 *
 * PHASE-0 found this domain had no admin surface anywhere: an administrator could not look
 * a user up at all, let alone suspend one. Six routes now cover the whole of it — list,
 * detail, edit, suspend, restore and the account's administrative history.
 *
 * ── Read and write hold different permissions, deliberately ───────────────────
 * `users.read` is a Support-tier lookup — answering a ticket needs it. The three writes
 * are not: `users.update` and `users.suspend` are Admin and above, granted through
 * `allInFamily('users')`, which Support's grant does not include. That split is the reason
 * the permissions are per-operation rather than one `users.manage`; PHASE-0:274 found the
 * legacy service putting a read overview and a money-moving write behind one identical
 * guard, and this is the shape that cannot do that.
 *
 * ── Route order ──────────────────────────────────────────────────────────────
 * `/:userId/activity` is a distinct path segment, so Express matches it without ambiguity
 * against `/:userId` — no literal-before-param problem here. Keep it that way: a future
 * literal sibling of `/:userId` (say `/export`) MUST be declared above it.
 */
const router = Router();
const mountedAt = '/users';

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/',
    access: permission('users.read'),
    validate: { query: SearchUsersQuerySchema },
    handler: UserController.search,
});

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/:userId',
    access: permission('users.read'),
    validate: { params: UserIdParamSchema },
    handler: UserController.get,
});

/**
 * The activity feed needs BOTH permissions, in `all` mode.
 *
 * `users.read` because the subject is a user, and `audit.read` because the rows are audit
 * rows and the repository applies the audit read scope to them. Requiring only the first
 * would make this endpoint a second door onto the trail that bypasses the permission
 * governing it — and requiring only the second would let somebody read a user's history
 * without being allowed to look the user up. Both tiers that hold either hold both, so
 * this costs nobody access; it states the dependency so that a future tier change cannot
 * quietly open a side door.
 */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/:userId/activity',
    access: permission('users.read', 'audit.read'),
    validate: { params: UserIdParamSchema, query: ListUserActivityQuerySchema },
    handler: UserController.activity,
});

defineRoute(router, {
    mountedAt,
    method: 'patch',
    path: '/:userId',
    access: permission('users.update'),
    validate: { params: UserIdParamSchema, body: UpdateUserSchema },
    audit: records('users.update'),
    handler: UserController.update,
});

/**
 * Suspend and restore are POST sub-resources rather than a `PATCH { status }`.
 *
 * ADR-005 D-4: the permission and the audit row attach to the ACTION. `users.suspend`
 * governs both directions, but they are separate audit actions — `users.suspend` and
 * `users.reinstate` — and a status field on a PATCH body could not carry the required
 * reason on one direction and forbid it on the other.
 */
defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/:userId/suspend',
    access: permission('users.suspend'),
    validate: { params: UserIdParamSchema, body: SuspendUserSchema },
    audit: records('users.suspend'),
    handler: UserController.suspend,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/:userId/restore',
    access: permission('users.suspend'),
    validate: { params: UserIdParamSchema },
    audit: records('users.reinstate'),
    handler: UserController.restore,
});

/**
 * Credential recovery — sending somebody a way back into their own account.
 *
 * ── `users.password.reset` has left the `†` list ─────────────────────────────
 * It was catalogued-and-unbuilt because "jovi-mall has no administrator-initiated password
 * flow" and issuing a credential needed a delivery channel and an expiry policy neither
 * service had decided on. Both now exist, and the route was built ON them rather than
 * beside them: the token is `PasswordResetService`'s, with its 30 minutes, its single use
 * and its `password_changed_at` revocation. A third entrance, not a second mechanism.
 *
 * ⚠ **Neither is granted to tier 3.** Support answers delivery tickets; a support agent who
 * can mail a working link to any vendor can take over any shop, and the audit row would
 * look like routine help. `assertGrantTableValid()` does not catch this by itself — the
 * permissions carry no `financial` or `destructive` flag — so the protection is that
 * SUPPORT names its grants by hand and neither of these is among them.
 *
 * ── Two permissions, not one, and two audit actions ──────────────────────────
 * A reset link grants nothing until the person chooses a password, and evicts every
 * session when they do; its worst case is a locked-out user. A sign-in link IS a session —
 * whoever opens the message is signed in as that customer. Folding them together would
 * mean granting the first silently granted the second, with nothing in the trail to tell
 * the two acts apart.
 *
 * POST sub-resources rather than a `PATCH { credential }` for ADR-005 D-4's reason: the
 * permission and the audit row attach to the ACTION.
 */
defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/:userId/password-reset-link',
    access: permission('users.password.reset'),
    validate: { params: UserIdParamSchema, body: SendCredentialSchema },
    audit: records('users.password_reset_link.send'),
    handler: UserController.sendPasswordResetLink,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/:userId/login-link',
    access: permission('users.login_link.send'),
    validate: { params: UserIdParamSchema, body: SendCredentialSchema },
    audit: records('users.login_link.send'),
    handler: UserController.sendLoginLink,
});

/**
 * Resetting the customer bot's conversation memory for one person, so their next chat
 * starts fresh.
 *
 * ── The one `users.*` write every tier holds ─────────────────────────────────
 * `users.bot_memory.reset` is granted to Support as well as Admin and Developer, by the
 * owner's decision. The header's read/write split does not bend for it: it is still its own
 * permission, separate from `users.read`, and it cannot edit, suspend or send anything. What
 * it resets is only the bot's memory of the chat, which jovi-mall owns.
 *
 * A POST sub-resource for ADR-005 D-4's reason, and the path is jovi-mall's own
 * (`/users/:userId/bot-memory/reset`), as it is for suspend and restore. `reason` is optional
 * (see `ResetBotMemorySchema`).
 */
defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/:userId/bot-memory/reset',
    access: permission('users.bot_memory.reset'),
    validate: { params: UserIdParamSchema, body: ResetBotMemorySchema },
    audit: records('users.bot_memory.reset'),
    handler: UserController.resetBotMemory,
});

export const userRoutes = router;
