import { Router } from 'express';
import { defineRoute, permission, records } from '../../../api/route-manifest';
import { UserController } from '../controllers/user.controller';
import {
    ListUserActivityQuerySchema,
    SearchUsersQuerySchema,
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

export const userRoutes = router;
