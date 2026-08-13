import { env } from '../../../config/env';

/**
 * When an audit row is allowed to leave the database.
 *
 * ── The rule, in one sentence ─────────────────────────────────────────────────
 * A row is deleted only when BOTH hold: it has been **exported** to a durable file, and
 * it is at least `ADMIN_AUDIT_RETENTION_DAYS` old. Neither alone is sufficient.
 *
 *   never exported        → `purge_after` is ABSENT      → nothing can delete it, ever
 *   exported, age ≥ N     → `purge_after` is in the past → deleted in the export's own run
 *   exported, age < N     → `purge_after` is in the future → the TTL takes it at N days
 *
 * ── Why the date is computed from `occurred_at`, not from the export ──────────
 * The retention floor is a property of the EVENT, not of when somebody got round to
 * exporting it. Computing `now + N` at export time would silently extend every row's life
 * by however long the export was delayed, and would make the same row's fate depend on
 * export scheduling — which is the opposite of a retention policy.
 *
 * The consequence worth stating: exporting a row EARLY does not shorten its life. It
 * still waits out its year. Exporting is a precondition for deletion, never a trigger.
 */

export const MS_PER_DAY = 86_400_000;

/**
 * The instant a row becomes eligible for deletion, given when it happened.
 *
 * @param retentionDays overrides the configured floor — used by `--restamp`, which
 *        recomputes existing rows after `ADMIN_AUDIT_RETENTION_DAYS` changes. Without
 *        that, "the retention period is configurable" would only be true of rows exported
 *        after the change, and already-exported rows would keep dying on the old schedule.
 */
export function purgeAfterFor(occurredAt: Date, retentionDays?: number): Date {
    const days = retentionDays ?? env().ADMIN_AUDIT_RETENTION_DAYS;
    return new Date(occurredAt.getTime() + days * MS_PER_DAY);
}

/** True when a row exported now would be deleted in the same run rather than waiting. */
export function isPastRetention(occurredAt: Date, now: Date, retentionDays?: number): boolean {
    return purgeAfterFor(occurredAt, retentionDays).getTime() <= now.getTime();
}

/**
 * The cutoff a dangling-intent sweep compares `occurred_at` against.
 *
 * A row still at `attempted` older than this describes an action this service started
 * somewhere it could not transact with, whose outcome never came back. ADR-002 D4-a calls
 * that "itself a useful signal" — it is resolved by grepping the other service for the
 * row's `correlation_id`, which is the same value that travelled as `X-Request-Id`.
 */
export function danglingIntentCutoff(now: Date, seconds?: number): Date {
    const window = seconds ?? env().ADMIN_AUDIT_DANGLING_INTENT_S;
    return new Date(now.getTime() - window * 1000);
}
