import { Types } from 'mongoose';
import { AdminAccountModel } from '../../admin-identity/models/admin-account.model';
import { AdminTier } from '../../admin-identity/domain/admin-identity.types';
import { hasPermission } from '../../authorization/domain/permission.resolver';
import { AdminNotificationModel } from '../models/admin-notification.model';
import { NotificationPreferenceModel } from '../models/notification-preference.model';
import { isEnabledByDefault, notificationSpec } from './notification.catalog';
import { NotificationDraft, NotificationSource } from './source.registry';
import { NotificationType } from './notification.types';

/**
 * Turning one draft into rows — the only writer of `admin_notifications` there is.
 *
 * ── Fan-out, and why it happens here rather than at read ──────────────────────
 * A draft names an AUDIENCE (a permission, or named administrators). This resolves that to
 * concrete recipients and writes one row each. The alternative — one row plus a filter at
 * read time — was rejected because the unread count and the list would then be two queries
 * that have to agree about visibility, and the moment they disagree the badge shows a
 * number the list cannot produce.
 *
 * ── Nothing here is allowed to fail an administrative action ──────────────────
 * The projector calls this from a background tick, never inside a request, and never inside
 * the transaction that produced the source row. That is the deliberate inverse of the audit
 * subsystem's D-1 ("an action that cannot be audited does not happen"), because the two
 * carry different weight: an audit row is evidence and a notification is a receipt for
 * something already recorded elsewhere. Making the inbox load-bearing would mean an
 * administrator cannot suspend an account while the notification collection is unhealthy,
 * which trades a real capability for a convenience.
 */

/** What a fan-out did, for the projector's log and the watermark's counters. */
export interface FanOutResult {
    delivered: number;
    /** Recipients skipped because they muted the type. Worth seeing in a log. */
    muted: number;
    /** Rows that already existed. The normal case on a re-read; never an error. */
    duplicates: number;
}

/**
 * Administrators who should receive a draft.
 *
 * ── The audience is a role, not a list ────────────────────────────────────────
 * A permission audience resolves against the CURRENT roster and the CURRENT grant table
 * every time, so an administrator hired today is in tomorrow's audience without anybody
 * maintaining a distribution list. `grantedTo` is a static in-memory set built once at
 * module load (`permission.resolver.ts`), so this costs one Mongo read and a `Set.has` per
 * candidate — no cache, nothing to invalidate.
 *
 * Suspended accounts are excluded. Filling the inbox of an account that cannot sign in
 * produces rows nobody will ever read and an unread count that is wrong the moment they
 * are reinstated.
 */
async function resolveRecipients(draft: NotificationDraft): Promise<Types.ObjectId[]> {
    if (draft.audience.kind === 'admins') {
        const ids = draft.audience.adminIds.filter((id) => Types.ObjectId.isValid(id));
        if (ids.length === 0) return [];

        // Still checked against the roster: a named recipient may have been suspended or
        // deleted between the source row being written and this tick reading it.
        const accounts = await AdminAccountModel()
            .find({ _id: { $in: ids.map((id) => new Types.ObjectId(id)) }, status: 'active' })
            .select({ _id: 1 })
            .lean()
            .exec();

        return accounts.map((account) => account._id);
    }

    const permission = draft.audience.permission;

    const accounts = await AdminAccountModel()
        .find({ status: 'active' })
        .select({ _id: 1, tier: 1 })
        .lean()
        .exec();

    return accounts
        .filter((account) => hasPermission(account.tier as AdminTier, permission))
        .map((account) => account._id);
}

/**
 * Which of these administrators have muted this type.
 *
 * One query for the whole recipient set rather than one per recipient: a fan-out to every
 * tier-1 and tier-2 administrator is the common case and N round trips for a boolean is
 * the kind of thing that only shows up as a problem once the roster grows.
 *
 * Absent preference document, or absent override, means the catalog's `defaultEnabled` —
 * resolved through `isEnabledByDefault` so "what the default is" has one answer.
 */
async function mutedAmong(
    adminIds: Types.ObjectId[],
    type: NotificationType,
): Promise<Set<string>> {
    if (adminIds.length === 0) return new Set();

    const preferences = await NotificationPreferenceModel()
        .find({ admin_id: { $in: adminIds } })
        .select({ admin_id: 1, overrides: 1 })
        .lean()
        .exec();

    const muted = new Set<string>();

    for (const preference of preferences) {
        const override = preference.overrides.find((entry) => entry.type === type);
        if (override && !override.enabled) muted.add(String(preference.admin_id));
    }

    // A type that is opt-in by default mutes everyone who has not opted in. No type ships
    // that way today; the branch is what makes `defaultEnabled` mean something.
    if (!isEnabledByDefault(type)) {
        const optedIn = new Set(
            preferences
                .filter((preference) => preference.overrides.some((e) => e.type === type && e.enabled))
                .map((preference) => String(preference.admin_id)),
        );
        for (const id of adminIds) {
            if (!optedIn.has(String(id))) muted.add(String(id));
        }
    }

    return muted;
}

/**
 * Write one draft to everyone entitled to it.
 *
 * ── Why `updateOne(..., $setOnInsert, upsert)` and not `insertMany` ───────────
 * The projector re-reads rows it has already delivered — that is the design, not a flaw
 * (see `notification-watermark.model.ts`). So the write has to be a no-op the second time,
 * and it has to be a no-op WITHOUT overwriting anything: a plain upsert with `$set` would
 * quietly resurrect a notification the administrator had already read or archived every
 * time the sweep passed over its source row again.
 *
 * `$setOnInsert` is what makes re-delivery invisible. `read_at`, `archived_at` and
 * `purge_after` are never touched after creation by this path.
 */
export async function fanOut(
    source: NotificationSource,
    draft: NotificationDraft,
    rowId: string,
): Promise<FanOutResult> {
    const recipients = await resolveRecipients(draft);
    if (recipients.length === 0) return { delivered: 0, muted: 0, duplicates: 0 };

    const muted = await mutedAmong(recipients, draft.type);
    const targets = recipients.filter((id) => !muted.has(String(id)));
    if (targets.length === 0) return { delivered: 0, muted: muted.size, duplicates: 0 };

    const sourceKey = `${source.id}:${draft.key}`;
    const severity = draft.severity ?? notificationSpec(draft.type).severity;

    const operations = targets.map((adminId) => ({
        updateOne: {
            filter: { source_key: sourceKey, admin_id: adminId },
            update: {
                $setOnInsert: {
                    admin_id: adminId,
                    type: draft.type,
                    severity,
                    title: draft.title,
                    body: draft.body,
                    source_id: source.id,
                    source_collection: source.collection,
                    // The ROW, not the idempotency key — two sources discriminate their key
                    // by status (`<id>:approved`) and provenance should still point at one
                    // document somebody can go and read.
                    source_row_id: rowId,
                    source_key: sourceKey,
                    required_permission:
                        draft.audience.kind === 'permission' ? draft.audience.permission : null,
                    target_type: draft.target.type,
                    target_id: draft.target.id,
                    target_label: draft.target.label,
                    action_path: draft.actionPath,
                    occurred_at: draft.occurredAt,
                    read_at: null,
                },
            },
            upsert: true,
        },
    }));

    // `ordered: false` so one recipient's failure does not abandon the rest of the batch.
    //
    // The expected failure is E11000 on `{ source_key, admin_id }`: two ticks overlapping,
    // or one tick racing a second process, both finding no document and both attempting the
    // insert. That is the unique index doing precisely its job, so it is swallowed rather
    // than propagated — the row the loser wanted to write is already there, written by the
    // winner, with the same content. Anything else rethrows.
    try {
        const result = await AdminNotificationModel().bulkWrite(operations, { ordered: false });
        return {
            delivered: result.upsertedCount,
            muted: muted.size,
            duplicates: targets.length - result.upsertedCount,
        };
    } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;

        const written = (error as { result?: { upsertedCount?: number } }).result?.upsertedCount ?? 0;
        return { delivered: written, muted: muted.size, duplicates: targets.length - written };
    }
}

/**
 * A bulk write that failed only on duplicate keys.
 *
 * `bulkWrite` with `ordered: false` reports E11000 as code 11000 on the error itself and,
 * for a mixed batch, per-operation under `writeErrors`. Both are checked: a batch where
 * SOME operations hit a duplicate is the common shape here, and treating it as a hard
 * failure would abandon the recipients whose writes actually succeeded.
 */
function isDuplicateKeyError(error: unknown): boolean {
    const candidate = error as { code?: number; writeErrors?: { code?: number }[] };
    if (candidate?.code === 11000) return true;

    const writeErrors = candidate?.writeErrors;
    return Array.isArray(writeErrors) && writeErrors.length > 0
        && writeErrors.every((writeError) => writeError?.code === 11000);
}
