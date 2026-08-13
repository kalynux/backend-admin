import { ClientSession, Types } from 'mongoose';
import { AdminIdentity } from '../../admin-identity/domain/admin-identity.types';
import { AuditContext } from '../../audit/domain/audit.types';
import { auditActorOf } from '../../audit/domain/audit-context';
import { auditedTransaction } from '../../audit/domain/audit.writer';
import { NotificationPreferenceModel } from '../models/notification-preference.model';
import { NOTIFICATION_CATALOG_ENTRIES, isEnabledByDefault } from './notification.catalog';
import { NOTIFICATION_TYPES, NotificationType } from './notification.types';

/**
 * An administrator's own notification preferences.
 *
 * Self-service throughout — every route that reaches this is `selfService`, and there is no
 * function here that takes somebody else's id. Gating an administrator's own inbox
 * configuration behind a tier permission would stop a Support-tier administrator
 * configuring theirs, which is the opposite of what a preference is for.
 */

export interface PreferenceEntry {
    type: NotificationType;
    summary: string;
    severity: string;
    /** What actually happens today. */
    enabled: boolean;
    /** What the catalog says when this administrator has expressed no opinion. */
    defaultEnabled: boolean;
    /** True when `enabled` comes from this administrator rather than from the catalog. */
    overridden: boolean;
}

/**
 * The whole preference screen, in catalog order.
 *
 * Every type is returned, including ones never overridden — a screen that renders only the
 * overrides cannot show what is available to change, and an administrator cannot mute a
 * type they have never received.
 */
export async function readPreferences(
    adminId: string,
    session?: ClientSession,
): Promise<PreferenceEntry[]> {
    const document = await NotificationPreferenceModel()
        .findOne({ admin_id: new Types.ObjectId(adminId) })
        .session(session ?? null)
        .lean()
        .exec();

    const overrides = new Map<string, boolean>(
        (document?.overrides ?? []).map((entry) => [entry.type, entry.enabled]),
    );

    return NOTIFICATION_CATALOG_ENTRIES.map((entry) => {
        const override = overrides.get(entry.type);
        return {
            type: entry.type,
            summary: entry.summary,
            severity: entry.severity,
            enabled: override ?? entry.defaultEnabled,
            defaultEnabled: entry.defaultEnabled,
            overridden: override !== undefined,
        };
    });
}

/**
 * Apply a sparse patch.
 *
 * Three states, and the third is why the body accepts `null` rather than only a boolean:
 *
 *   absent  → unchanged
 *   `true`  → always deliver, whatever the catalog default becomes
 *   `false` → never deliver
 *   `null`  → REMOVE the override; the type follows the catalog again
 *
 * Without `null` there is no way to stop overriding a type — only to set it to whatever the
 * default happens to be today, which looks identical and silently stops tracking the
 * catalog the moment the default changes. It is the same distinction jovi-mall's
 * `clearable()` helper exists to preserve for PATCH fields.
 */
export async function updatePreferences(
    actor: AdminIdentity,
    patch: Partial<Record<NotificationType, boolean | null>>,
    context: AuditContext,
): Promise<PreferenceEntry[]> {
    const adminId = actor.adminId;

    // `auditedTransaction`, not a bare write: this is a `wi-admin` write that can join a
    // `ClientSession`, which is the whole of D-2's test. The audit row and the preference
    // change commit together or not at all.
    //
    // Note the asymmetry with the notifications themselves, which are deliberately NOT
    // transactional (see `notification.writer.ts`). A receipt is not evidence; a
    // configuration change is.
    return auditedTransaction(
        {
            action: 'notifications.preferences.update_self',
            actor: auditActorOf(actor),
            target: { type: 'administrator', id: adminId, label: actor.email },
            context,
            payload: { ...patch },
        },
        async (session) => {
            // Read inside the transaction. `perform` may run more than once —
            // `withTransaction` retries — so a `before` captured outside it may describe a
            // state that has already been superseded by the time this commits.
            const document = await NotificationPreferenceModel()
                .findOne({ admin_id: new Types.ObjectId(adminId) })
                .session(session)
                .lean()
                .exec();

            const overrides = new Map<string, boolean>(
                (document?.overrides ?? []).map((entry) => [entry.type, entry.enabled]),
            );
            const before = Object.fromEntries(overrides);

            for (const [type, value] of Object.entries(patch)) {
                if (value === null) overrides.delete(type);
                else if (typeof value === 'boolean') overrides.set(type, value);
            }

            // Only types the catalog still knows about survive a write. A type removed from
            // the catalog would otherwise sit in the document forever and fail the
            // subdocument's enum validation on the next unrelated save.
            const next = NOTIFICATION_TYPES
                .filter((type) => overrides.has(type))
                .map((type) => ({ type, enabled: overrides.get(type) as boolean }));

            await NotificationPreferenceModel().updateOne(
                { admin_id: new Types.ObjectId(adminId) },
                { $set: { overrides: next }, $setOnInsert: { admin_id: new Types.ObjectId(adminId) } },
                { upsert: true, session },
            );

            const entries = await readPreferences(adminId, session);

            return { result: entries, before, after: Object.fromEntries(overrides) };
        },
    );
}

/** Whether a type reaches this administrator. Used by the tests; fan-out batches its own. */
export async function isEnabledFor(adminId: string, type: NotificationType): Promise<boolean> {
    const document = await NotificationPreferenceModel()
        .findOne({ admin_id: new Types.ObjectId(adminId) })
        .lean()
        .exec();

    const override = (document?.overrides ?? []).find((entry) => entry.type === type);
    return override ? override.enabled : isEnabledByDefault(type);
}
