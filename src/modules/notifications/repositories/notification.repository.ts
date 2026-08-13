import { FilterQuery, Types } from 'mongoose';
import { toMongoSort } from '../../../core/data/mongo-list';
import { toPageMeta } from '../../../core/http/list-query';
import { AdminTier } from '../../admin-identity/domain/admin-identity.types';
import { grantedTo } from '../../authorization/domain/permission.resolver';
import { AdminNotificationModel, IAdminNotification } from '../models/admin-notification.model';
import { ListNotificationsQuery, NOTIFICATION_SORT } from '../validators/notification.validator';

/**
 * Reading one administrator's inbox.
 *
 * ── The scope is applied here, not in the controller ──────────────────────────
 * Every query in this file starts from `visibleTo(adminId, tier)`. That mirrors the
 * convention `auditScopeFilter` sets for the trail and jovi-mall's `findByIdAndAgency`
 * sets for its own scoping: a scope assembled at the query layer is one nobody can forget
 * to apply. A controller that composes its own filter is one refactor away from omitting it.
 */

export interface NotificationPage {
    items: IAdminNotification[];
    total: number;
    page: number;
    limit: number;
    pages: number;
}

/**
 * The rows this administrator may see, right now.
 *
 * TWO conditions, and the second is not redundant:
 *
 *  1. `admin_id` — fan-out already decided the audience when the row was written.
 *  2. `required_permission` is null, or is a permission the caller's CURRENT tier holds.
 *
 * Without (2), visibility would be frozen at the instant of delivery. An administrator
 * demoted from tier 1 to tier 3 keeps every financial alert already in their inbox, and
 * keeps reading them for as long as the rows live. Re-checking makes a demotion take effect
 * on the whole inbox on the next request, which is the same posture
 * `authenticate.middleware.ts` takes by re-reading the tier from Mongo rather than trusting
 * the token.
 *
 * `grantedTo` is an in-memory `Set` built once at module load, so this costs a spread, not
 * a query.
 */
function visibleTo(adminId: string, tier: AdminTier): FilterQuery<IAdminNotification> {
    return {
        admin_id: new Types.ObjectId(adminId),
        $or: [
            { required_permission: null },
            { required_permission: { $in: [...grantedTo(tier)] } },
        ],
    };
}

/**
 * Translate the validated query into the rest of the filter.
 *
 * Pure and exported — the DB-free suite imports it directly, which is the only way to check
 * a filter whose failure mode is "returns rows, answers a different question".
 *
 * ── `$and`, never a spread ────────────────────────────────────────────────────
 * `visibleTo` already contributes a top-level `$or`. Merging a second one in — and `status`
 * does not, but a future filter might — would silently replace it, and replacing the
 * VISIBILITY clause is the one merge in this module that leaks. Composing under `$and`
 * makes that impossible rather than unlikely; the orders repository writes the same
 * warning over its own `buildFilter` for the same reason.
 */
export function buildNotificationFilter(
    adminId: string,
    tier: AdminTier,
    query: Partial<ListNotificationsQuery>,
): FilterQuery<IAdminNotification> {
    const clauses: FilterQuery<IAdminNotification>[] = [visibleTo(adminId, tier)];

    // `status` is derived from two timestamp columns rather than stored, so there is exactly
    // one definition of "unread" and no way for a column to disagree with the truth.
    switch (query.status ?? 'unread') {
        case 'unread':
            clauses.push({ read_at: null, archived_at: { $exists: false } });
            break;
        case 'read':
            clauses.push({ read_at: { $ne: null }, archived_at: { $exists: false } });
            break;
        case 'archived':
            clauses.push({ archived_at: { $exists: true } });
            break;
        case 'all':
            // Still excludes archived: "all" means the whole inbox, and an archived row has
            // left it. `?status=archived` is how you look in the drawer.
            clauses.push({ archived_at: { $exists: false } });
            break;
    }

    if (query.type) clauses.push({ type: query.type });
    if (query.severity) clauses.push({ severity: query.severity });
    if (query.source) clauses.push({ source_id: query.source });

    if (query.from || query.to) {
        const range: Record<string, Date> = {};
        if (query.from) range.$gte = query.from;
        // Half-open `[from, to)`, matching `dateRangeFields` — consecutive ranges tile
        // exactly and no row is counted twice at a boundary.
        if (query.to) range.$lt = query.to;
        clauses.push({ occurred_at: range });
    }

    return { $and: clauses };
}

export async function listNotifications(
    adminId: string,
    tier: AdminTier,
    query: ListNotificationsQuery,
): Promise<NotificationPage> {
    const filter = buildNotificationFilter(adminId, tier, query);

    const [items, total] = await Promise.all([
        AdminNotificationModel()
            .find(filter)
            .sort(toMongoSort(query.sort, NOTIFICATION_SORT))
            .skip((query.page - 1) * query.limit)
            .limit(query.limit)
            .lean<IAdminNotification[]>()
            .exec(),
        AdminNotificationModel().countDocuments(filter),
    ]);

    return { items, ...toPageMeta(total, query.page, query.limit) };
}

/** The badge. Same visibility clause as the list, by construction. */
export async function countUnread(
    adminId: string,
    tier: AdminTier,
    query: Partial<ListNotificationsQuery> = {},
): Promise<number> {
    return AdminNotificationModel().countDocuments(
        buildNotificationFilter(adminId, tier, { ...query, status: 'unread' }),
    );
}

/**
 * Mark one row read or unread.
 *
 * Scoped by `visibleTo`, so a caller cannot touch a row addressed to someone else — and a
 * row they may not see returns `null`, which the controller turns into a 404. Not a 403:
 * telling someone a notification exists that they may not read is itself a disclosure, and
 * the rest of this service already answers that shape of question with 404.
 */
export async function setRead(
    adminId: string,
    tier: AdminTier,
    notificationId: string,
    read: boolean,
): Promise<IAdminNotification | null> {
    return AdminNotificationModel()
        .findOneAndUpdate(
            { $and: [visibleTo(adminId, tier), { _id: new Types.ObjectId(notificationId) }] },
            { $set: { read_at: read ? new Date() : null } },
            { new: true },
        )
        .lean<IAdminNotification>()
        .exec();
}

/** Bulk mark-read, scoped by the caller's filter. Returns how many actually changed. */
export async function markAllRead(
    adminId: string,
    tier: AdminTier,
    query: Partial<ListNotificationsQuery>,
    before?: Date,
): Promise<number> {
    const clauses: FilterQuery<IAdminNotification>[] = [
        buildNotificationFilter(adminId, tier, { ...query, status: 'unread' }),
    ];
    if (before) clauses.push({ occurred_at: { $lte: before } });

    const result = await AdminNotificationModel().updateMany(
        { $and: clauses },
        { $set: { read_at: new Date() } },
    );

    return result.modifiedCount;
}

/**
 * Archive or restore one row.
 *
 * Archiving stamps `purge_after` at the same time, because the TTL's partial filter keys on
 * `archived_at` existing — a row needs both to be deletable, and writing them together is
 * what makes "archived AND aged" true of every row that index can see.
 *
 * Restoring `$unset`s both. It must not leave `purge_after` behind: a row with a purge date
 * and no `archived_at` is outside the partial index and would never be collected, which is
 * a leak rather than a deletion, but it is still a field that lies about what happens next.
 */
export async function setArchived(
    adminId: string,
    tier: AdminTier,
    notificationId: string,
    archived: boolean,
    retentionDays: number,
): Promise<IAdminNotification | null> {
    const now = new Date();

    const update = archived
        ? {
            $set: {
                archived_at: now,
                purge_after: new Date(now.getTime() + retentionDays * 24 * 60 * 60 * 1000),
            },
        }
        : { $unset: { archived_at: 1, purge_after: 1 } };

    return AdminNotificationModel()
        .findOneAndUpdate(
            { $and: [visibleTo(adminId, tier), { _id: new Types.ObjectId(notificationId) }] },
            update,
            { new: true },
        )
        .lean<IAdminNotification>()
        .exec();
}
