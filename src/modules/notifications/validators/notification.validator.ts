import { z } from 'zod';
import { listQuery } from '../../../core/http/list-query';
import { dateRangeFields, dateRangeRule, idParam } from '../../../core/validation/common.schemas';
import {
    NOTIFICATION_SEVERITIES,
    NOTIFICATION_STATUS_FILTERS,
    NOTIFICATION_TYPES,
} from '../domain/notification.types';
import { NOTIFICATION_SOURCES } from '../domain/source.registry';

/**
 * The inbox's request vocabulary.
 *
 * Every enum here is `z.enum([...THE_ONE_ARRAY])` — never a hand-typed list. This is the
 * vocabulary D-17 calls "ours", and the reason for pinning it rather than accepting a
 * bounded string is that the type union and the Mongoose enum must come from a single
 * source. Two copies is the exact defect that cost jovi-mall eight silently-undelivered
 * notification situations.
 */

/**
 * Wire name → database path. Read by BOTH `sortSchema` (as the allowlist) and `toMongoSort`
 * (as the translation), so a field cannot be sortable-but-untranslatable.
 *
 * `occurredAt` and not `createdAt` is the default, and the two genuinely differ here:
 * `created_at` is when the projector noticed, `occurred_at` is when the thing happened. An
 * inbox ordered by when a background sweep ran would reorder itself for reasons that have
 * nothing to do with the platform — a slow tick, a restart, a source added later.
 */
export const NOTIFICATION_SORT = {
    occurredAt: 'occurred_at',
    createdAt: 'created_at',
    severity: 'severity',
} as const;

const SOURCE_IDS = NOTIFICATION_SOURCES.map((source) => source.id) as [string, ...string[]];

export const ListNotificationsQuerySchema = listQuery(NOTIFICATION_SORT, '-occurredAt', {
    /**
     * Derived, not stored — `unread` is `read_at: null`. Defaults to `unread`, because the
     * question somebody opens an inbox asking is "what have I not dealt with", and a list
     * that opens on everything ever makes them apply a filter before it is useful.
     */
    status: z.enum(NOTIFICATION_STATUS_FILTERS).default('unread'),
    type: z.enum(NOTIFICATION_TYPES).optional(),
    severity: z.enum(NOTIFICATION_SEVERITIES).optional(),
    // Bounded by the registry rather than by a free string: a source id that produces
    // nothing is a filter that can only ever return an empty page (ADR-005 D-17's
    // "a filter offers only values that can occur").
    source: z.enum(SOURCE_IDS).optional(),
    ...dateRangeFields(),
}).superRefine(dateRangeRule({ maxDays: 366 }));

export type ListNotificationsQuery = z.infer<typeof ListNotificationsQuerySchema>;

/**
 * The unread badge takes the same filters as the list, minus paging and sorting.
 *
 * Deliberately the same vocabulary: a count that cannot be narrowed the way the list can is
 * a count the dashboard cannot reconcile with what it is showing. `status` is absent
 * because the endpoint's whole subject is unread.
 */
export const UnreadCountQuerySchema = z.object({
    type: z.enum(NOTIFICATION_TYPES).optional(),
    severity: z.enum(NOTIFICATION_SEVERITIES).optional(),
    source: z.enum(SOURCE_IDS).optional(),
});

export type UnreadCountQuery = z.infer<typeof UnreadCountQuerySchema>;

export const NotificationIdParamSchema = idParam('notificationId', 'notification');

/**
 * Bulk mark-as-read, scoped by the SAME filters the list accepts.
 *
 * An unscoped "mark everything read" is a button that silently discards whatever arrived
 * between the page rendering and the click. Taking the filter means "mark read what I was
 * looking at", which is what the gesture means to the person making it.
 */
export const MarkAllReadBodySchema = z.object({
    type: z.enum(NOTIFICATION_TYPES).optional(),
    severity: z.enum(NOTIFICATION_SEVERITIES).optional(),
    source: z.enum(SOURCE_IDS).optional(),
    /**
     * Only rows at or before this instant, so the gesture cannot swallow a notification the
     * caller has never seen. The dashboard sends the `occurredAt` of the newest row it
     * rendered; absent means "everything unread right now".
     */
    before: z.coerce.date().optional(),
}).strict();

export type MarkAllReadBody = z.infer<typeof MarkAllReadBodySchema>;

/**
 * Preference overrides — sparse, and a `null` clears one.
 *
 * The absent/`null`/value distinction matches `clearable()` in jovi-mall: a type the caller
 * does not mention keeps whatever it had, and `null` removes the override so the type falls
 * back to the catalog's `defaultEnabled`. Without the third state there is no way to say
 * "stop overriding this" — only "override it to the value that happens to be the default
 * today", which silently stops tracking the catalog.
 */
export const UpdatePreferencesBodySchema = z.object({
    overrides: z.record(
        z.enum(NOTIFICATION_TYPES),
        z.boolean().nullable(),
    ),
}).strict();

export type UpdatePreferencesBody = z.infer<typeof UpdatePreferencesBodySchema>;
