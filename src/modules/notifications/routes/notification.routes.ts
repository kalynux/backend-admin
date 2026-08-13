import { Router } from 'express';
import { defineRoute, noAudit, permission, records, selfService } from '../../../api/route-manifest';
import { NotificationController } from '../controllers/notification.controller';
import {
    ListNotificationsQuerySchema,
    MarkAllReadBodySchema,
    NotificationIdParamSchema,
    UnreadCountQuerySchema,
    UpdatePreferencesBodySchema,
} from '../validators/notification.validator';

/**
 * `/api/v1/notifications` — the administrator inbox. Phase 13, `docs/ADR-013-NOTIFICATIONS.md`.
 *
 * ── The fifth notification stack ──────────────────────────────────────────────
 * `PHASE-0:124` measured it: jovi-mall carries four stacks — vendor, agency, agent,
 * customer — and the administrator, alone among the five roles, had none. `PHASE-0:307`
 * named what the missing one was supposed to carry, and all four of those are in the source
 * registry: disputes, COD discrepancies, payouts, failed webhooks.
 *
 * ── Two access kinds, and the split is not arbitrary ──────────────────────────
 * The inbox itself requires `notifications.read` — catalogued in Phase 3, granted to every
 * tier, and until now attached to no route. PREFERENCES are `selfService`, because gating an
 * administrator's own configuration behind a tier permission would stop a Support-tier
 * administrator configuring theirs, and a preference nobody can set is not a preference.
 *
 * Note what the permission does NOT do: holding `notifications.read` does not decide WHICH
 * notifications you see. That is per-row, from the permission each source declares, checked
 * both at fan-out and again on every read — see `notification.repository.ts`.
 *
 * ── `notifications.manage` is deliberately unrouted ───────────────────────────
 * It reads "configure which events raise an administrator alert", which is service-wide by
 * its wording. This phase ships per-administrator preferences instead, and a global switch
 * over the source registry is the natural thing to put behind it later. Left catalogued and
 * granted, exactly as it is today — the alternative, repurposing it to gate self-service
 * preferences, would make the name describe something it does not do.
 *
 * ── Route ORDER is load-bearing ───────────────────────────────────────────────
 * Every literal path is declared BEFORE `/:notificationId/*`. Express resolves by
 * registration order, so `preferences`, `unread-count`, `read-all` and `sources` would each
 * be swallowed as an id if they came after — and `idParam` would then answer a well-formed
 * request with a validation error naming a parameter the caller never sent. jovi-mall
 * documents the same trap over its own notification routes.
 */
const router = Router();
const mountedAt = '/notifications';

// ─── Reads. Literal paths first ──────────────────────────────────────────────

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/',
    access: permission('notifications.read'),
    validate: { query: ListNotificationsQuerySchema },
    handler: NotificationController.list,
});

/**
 * The badge.
 *
 * jovi-mall gave this to customers alone; vendor, agency and agent all have to read
 * `meta.unreadCount` off a full list they do not otherwise want, and one of them has a
 * `countUnread` service method with no route in front of it. A dashboard polling for a
 * number should not have to fetch twenty rows to get it.
 */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/unread-count',
    access: permission('notifications.read'),
    validate: { query: UnreadCountQuerySchema },
    handler: NotificationController.unreadCount,
});

/** What this inbox can ever say, and what each answer is derived from. */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/sources',
    access: permission('notifications.read'),
    handler: NotificationController.sources,
});

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/preferences',
    access: selfService('Every administrator may read their own notification preferences'),
    handler: NotificationController.readPreferences,
});

// ─── Writes ──────────────────────────────────────────────────────────────────

/**
 * The one audited write on this surface.
 *
 * A preference is durable configuration that changes what this service does in future —
 * unlike a read receipt, which records only that somebody looked. `permission: null` on the
 * catalog action, mirroring `administrators.profile.update_self`: the route is
 * `selfService`, so `checkPermissionCoherence` has no permission to reconcile it against
 * and returns early.
 */
defineRoute(router, {
    mountedAt,
    method: 'patch',
    path: '/preferences',
    access: selfService('Every administrator may configure their own notification preferences'),
    validate: { body: UpdatePreferencesBodySchema },
    audit: records('notifications.preferences.update_self'),
    handler: NotificationController.updatePreferences,
});

/**
 * Bulk mark-read.
 *
 * Scoped by the same filters the list takes, and by `before`, so the gesture means "mark
 * read what I was looking at" rather than "discard anything that arrived while I was
 * reading". See `MarkAllReadBodySchema`.
 */
defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/read-all',
    access: permission('notifications.read'),
    validate: { body: MarkAllReadBodySchema },
    audit: noAudit('A read receipt on your own inbox is not an administrative action'),
    handler: NotificationController.markAllRead,
});

// ─── Per-notification. AFTER every literal path ──────────────────────────────

defineRoute(router, {
    mountedAt,
    method: 'patch',
    path: '/:notificationId/read',
    access: permission('notifications.read'),
    validate: { params: NotificationIdParamSchema },
    audit: noAudit('A read receipt on your own inbox is not an administrative action'),
    handler: NotificationController.markRead,
});

/**
 * The undo. Present because the alternative to a reversible read receipt is an
 * administrator who mis-clicks losing track of something the platform is waiting on them
 * for, with no way back.
 */
defineRoute(router, {
    mountedAt,
    method: 'patch',
    path: '/:notificationId/unread',
    access: permission('notifications.read'),
    validate: { params: NotificationIdParamSchema },
    audit: noAudit('A read receipt on your own inbox is not an administrative action'),
    handler: NotificationController.markUnread,
});

/**
 * Archive — a soft stamp, and the only deletion path there is.
 *
 * There is no `DELETE`. Archiving sets `archived_at` and `purge_after`, and the TTL removes
 * the row later; nothing on this surface destroys anything on demand. What the notification
 * was ABOUT is untouched either way — it lives in `admin_audit_log` and in the platform row
 * the projector derived it from, both of which outlive the receipt.
 */
defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/:notificationId/archive',
    access: permission('notifications.read'),
    validate: { params: NotificationIdParamSchema },
    audit: noAudit('Filing your own inbox is not an administrative action'),
    handler: NotificationController.archive,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/:notificationId/unarchive',
    access: permission('notifications.read'),
    validate: { params: NotificationIdParamSchema },
    audit: noAudit('Filing your own inbox is not an administrative action'),
    handler: NotificationController.unarchive,
});

export default router;
