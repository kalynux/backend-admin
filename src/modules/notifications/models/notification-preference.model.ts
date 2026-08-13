import { Schema, Document, Types, Model } from 'mongoose';
import { adminConnection } from '../../../infra/mongo/connections';
import { NOTIFICATION_TYPES, NotificationType } from '../domain/notification.types';

/**
 * `admin_notification_preferences` — one document per administrator, in `wi-admin`.
 *
 * Mirrors what jovi-mall's four stacks already give every other role
 * (`*_notification_preferences`): the administrator decides which situations reach them.
 * Applied at FAN-OUT, not at read — a muted type produces no row at all, so muting is not
 * a filter someone can forget to apply and not a way for the unread count to disagree with
 * the list.
 *
 * ── Why overrides, and not a flag per type ────────────────────────────────────
 * The document stores only the types this administrator has an OPINION about. Everything
 * else resolves to `notification.catalog.ts`'s `defaultEnabled`. That is what makes adding
 * a notification type a one-line change: a dense `Record<NotificationType, boolean>` would
 * need a migration for every new member, and until it ran, every existing administrator
 * would hold a document that silently disagrees with the catalog about a type it has never
 * heard of.
 *
 * ── Why an array and not a Map ────────────────────────────────────────────────
 * Every notification type contains dots (`cod.discrepancy.opened`). Dotted keys inside a
 * document are a long-standing MongoDB sharp edge, and a `Map` keyed by type would walk
 * straight into it. An array of `{ type, enabled }` cannot.
 */

export const NOTIFICATION_PREFERENCE_COLLECTION = 'admin_notification_preferences';

export interface INotificationPreferenceOverride {
    type: NotificationType;
    enabled: boolean;
}

export interface INotificationPreference extends Document {
    _id: Types.ObjectId;
    admin_id: Types.ObjectId;
    /** Sparse by design — absent means "whatever the catalog says". */
    overrides: INotificationPreferenceOverride[];
    created_at: Date;
    updated_at: Date;
}

const OverrideSchema = new Schema<INotificationPreferenceOverride>(
    {
        type: { type: String, required: true, enum: NOTIFICATION_TYPES },
        enabled: { type: Boolean, required: true },
    },
    { _id: false },
);

const NotificationPreferenceSchema = new Schema<INotificationPreference>(
    {
        admin_id: { type: Schema.Types.ObjectId, required: true, ref: 'AdminAccount' },
        // `[]`, never null — ADR-005 D-16.
        overrides: { type: [OverrideSchema], required: true, default: [] },
    },
    {
        timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
        collection: NOTIFICATION_PREFERENCE_COLLECTION,
    },
);

/**
 * One document per administrator, enforced by the database rather than by a read-then-write.
 *
 * The preference write is an upsert and the projector reads these on every tick; without
 * the constraint, two concurrent upserts for an administrator who has never saved
 * preferences before would both insert, and which of the two the projector then read would
 * be arbitrary.
 */
NotificationPreferenceSchema.index({ admin_id: 1 }, { unique: true });

let cached: Model<INotificationPreference> | null = null;

export function NotificationPreferenceModel(): Model<INotificationPreference> {
    if (!cached) {
        cached = adminConnection().model<INotificationPreference>(
            'NotificationPreference',
            NotificationPreferenceSchema,
        );
    }
    return cached;
}

export function resetNotificationPreferenceModel(): void {
    cached = null;
}
