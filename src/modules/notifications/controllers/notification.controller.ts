import { Request, Response } from 'express';
import { env } from '../../../config/env';
import { asyncHandler } from '../../../core/http/async-handler';
import { sendPaginated, sendSuccess } from '../../../core/http/responses';
import { toPageMeta } from '../../../core/http/list-query';
import { createAppError } from '../../../core/errors/app-error';
import { ERROR_CODES } from '../../../core/errors/error-codes';
import { requireAdminIdentity } from '../../admin-identity/domain/admin-identity.types';
import { actorContextOf } from '../../audit/domain/audit-context';
import { IAdminNotification } from '../models/admin-notification.model';
import { notificationSpec } from '../domain/notification.catalog';
import { NotificationType } from '../domain/notification.types';
import { NOTIFICATION_SOURCES } from '../domain/source.registry';
import { readPreferences, updatePreferences } from '../domain/preference.service';
import * as repository from '../repositories/notification.repository';
import {
    ListNotificationsQuery,
    MarkAllReadBody,
    UnreadCountQuery,
    UpdatePreferencesBody,
} from '../validators/notification.validator';

/**
 * `/api/v1/notifications` — the administrator inbox.
 *
 * Thin, like every controller here. The visibility scope lives in the repository (so no
 * handler can forget it) and the rows are produced by the projector (so no handler can
 * create one).
 *
 * ── There is no POST ──────────────────────────────────────────────────────────
 * Nothing on this surface creates a notification, and that is the design rather than an
 * omission. A notification is derived from a committed row by `source.registry.ts`; an
 * endpoint that manufactured one would be the exact hole this phase was asked not to open.
 */

/**
 * Named-field mapping, never a spread.
 *
 * The second of the two locks the rest of this service uses on read models. `source_row_id`
 * and `required_permission` are internal plumbing and stay internal: the first invites a
 * client to construct its own platform URLs, the second describes the authorization model
 * to whoever holds a session.
 */
function toNotificationDto(notification: IAdminNotification): Record<string, unknown> {
    return {
        id: String(notification._id),
        type: notification.type,
        severity: notification.severity,
        title: notification.title,
        body: notification.body,
        source: notification.source_id,
        target: {
            type: notification.target_type,
            id: notification.target_id,
            label: notification.target_label,
        },
        actionPath: notification.action_path,
        occurredAt: notification.occurred_at,
        readAt: notification.read_at ?? null,
        // `?? null` on both, not `undefined`: the two retention fields are stored WITHOUT a
        // default so the TTL's partial filter stays meaningful, and a response whose keys
        // come and go is a response a client has to feature-detect (ADR-005 D-16).
        archivedAt: notification.archived_at ?? null,
        isRead: notification.read_at !== null && notification.read_at !== undefined,
        isArchived: notification.archived_at !== undefined,
    };
}

export class NotificationController {
    /** GET /api/v1/notifications */
    static list = asyncHandler(async (req: Request, res: Response) => {
        const identity = requireAdminIdentity(req);
        const query = req.query as unknown as ListNotificationsQuery;

        const page = await repository.listNotifications(identity.adminId, identity.tier, query);

        // `unreadCount` rides in `meta` beside the four required fields — D-10 permits a
        // list to add summary fields, and the badge and the list must not be two requests
        // that can disagree about the same filter.
        const unreadCount = await repository.countUnread(identity.adminId, identity.tier, {
            type: query.type,
            severity: query.severity,
            source: query.source,
        });

        sendPaginated(res, page.items.map(toNotificationDto), {
            ...toPageMeta(page.total, page.page, page.limit),
            unreadCount,
        });
    });

    /** GET /api/v1/notifications/unread-count */
    static unreadCount = asyncHandler(async (req: Request, res: Response) => {
        const identity = requireAdminIdentity(req);
        const query = req.query as unknown as UnreadCountQuery;

        const count = await repository.countUnread(identity.adminId, identity.tier, query);

        sendSuccess(res, { unreadCount: count });
    });

    /**
     * GET /api/v1/notifications/sources
     *
     * What this inbox can ever tell you, and what each answer is derived from. It exists
     * because "do not invent notification events" is only checkable if the produced set is
     * legible from outside the code — and because an administrator who has never seen a
     * `cod.discrepancy.opened` should be able to tell "none have happened" from "I am not
     * entitled to them".
     */
    static sources = asyncHandler(async (_req: Request, res: Response) => {
        sendSuccess(res, {
            sources: NOTIFICATION_SOURCES.map((source) => ({
                id: source.id,
                describe: source.describe,
                collection: source.collection,
                produces: source.produces,
                requiredPermission: source.gates ?? null,
                severity: source.produces.map((type) => notificationSpec(type).severity),
            })),
        });
    });

    /** PATCH /api/v1/notifications/:notificationId/read */
    static markRead = asyncHandler(async (req: Request, res: Response) => {
        const identity = requireAdminIdentity(req);

        const updated = await repository.setRead(
            identity.adminId,
            identity.tier,
            req.params.notificationId,
            true,
        );

        sendSuccess(res, toNotificationDto(orNotFound(updated)));
    });

    /** PATCH /api/v1/notifications/:notificationId/unread */
    static markUnread = asyncHandler(async (req: Request, res: Response) => {
        const identity = requireAdminIdentity(req);

        const updated = await repository.setRead(
            identity.adminId,
            identity.tier,
            req.params.notificationId,
            false,
        );

        sendSuccess(res, toNotificationDto(orNotFound(updated)));
    });

    /** POST /api/v1/notifications/read-all */
    static markAllRead = asyncHandler(async (req: Request, res: Response) => {
        const identity = requireAdminIdentity(req);
        const body = req.body as MarkAllReadBody;

        const marked = await repository.markAllRead(
            identity.adminId,
            identity.tier,
            { type: body.type, severity: body.severity, source: body.source },
            body.before,
        );

        sendSuccess(res, { marked }, {
            message: marked === 1 ? '1 notification marked read' : `${marked} notifications marked read`,
        });
    });

    /** POST /api/v1/notifications/:notificationId/archive */
    static archive = asyncHandler(async (req: Request, res: Response) => {
        const identity = requireAdminIdentity(req);

        const updated = await repository.setArchived(
            identity.adminId,
            identity.tier,
            req.params.notificationId,
            true,
            env().ADMIN_NOTIFICATIONS_RETENTION_DAYS,
        );

        sendSuccess(res, toNotificationDto(orNotFound(updated)), {
            message: `Archived. It will be removed after ${env().ADMIN_NOTIFICATIONS_RETENTION_DAYS} days; `
                + 'what it was about is unaffected.',
        });
    });

    /** POST /api/v1/notifications/:notificationId/unarchive */
    static unarchive = asyncHandler(async (req: Request, res: Response) => {
        const identity = requireAdminIdentity(req);

        const updated = await repository.setArchived(
            identity.adminId,
            identity.tier,
            req.params.notificationId,
            false,
            env().ADMIN_NOTIFICATIONS_RETENTION_DAYS,
        );

        sendSuccess(res, toNotificationDto(orNotFound(updated)));
    });

    /** GET /api/v1/notifications/preferences */
    static readPreferences = asyncHandler(async (req: Request, res: Response) => {
        const identity = requireAdminIdentity(req);
        sendSuccess(res, { preferences: await readPreferences(identity.adminId) });
    });

    /** PATCH /api/v1/notifications/preferences */
    static updatePreferences = asyncHandler(async (req: Request, res: Response) => {
        const identity = requireAdminIdentity(req);
        const body = req.body as UpdatePreferencesBody;

        const preferences = await updatePreferences(
            identity,
            body.overrides as Partial<Record<NotificationType, boolean | null>>,
            actorContextOf(req),
        );

        sendSuccess(res, { preferences }, {
            // Preferences apply at FAN-OUT, so muting a type stops the next one rather than
            // hiding the ones already delivered. Said on the wire, because the alternative
            // reading — "this cleans up my inbox" — is the obvious one and is wrong.
            message: 'Saved. Preferences apply to notifications raised from now on; '
                + 'anything already in your inbox stays there.',
        });
    });
}

/**
 * A row the caller may not see is indistinguishable from one that does not exist.
 *
 * 404, never 403. Answering "that exists but is not yours" on an inbox tells the caller
 * that a notification was raised, which type it was, and that somebody else received it —
 * a disclosure the permission model exists to prevent. The rest of this service already
 * answers scoped lookups the same way.
 */
function orNotFound(notification: IAdminNotification | null): IAdminNotification {
    if (!notification) {
        throw createAppError(ERROR_CODES.NOTIFICATION_NOT_FOUND, 404);
    }
    return notification;
}
