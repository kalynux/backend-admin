/**
 * The administrator inbox's vocabulary — ONE `as const` array per enumeration.
 *
 * ── Why this file exists at all ───────────────────────────────────────────────
 * Every array here feeds both the Zod schema (as a filter allowlist) and the Mongoose
 * schema (as the stored enum). That is not tidiness; it is the direct lesson of the defect
 * ADR-005 D-17 records. jovi-mall kept two hand-maintained copies of its agent notification
 * types, they drifted, and eight `agent_contract.*` situations existed in the TypeScript
 * union and not in the Mongoose enum — so every one of those notifications threw a
 * `ValidationError` on write and the agent was simply never told. Eight situations, silent,
 * for as long as nobody read the logs.
 *
 * A second copy of any of these arrays re-creates that bug exactly.
 *
 * ── Why the names look like permission names ──────────────────────────────────
 * They share the family segment on purpose: `cod.*`, `money.*`, `orders.*` line up with
 * `PermissionFamily`, so a reader can see from the type alone which part of the service a
 * notification is about, and the source registry's `requiredPermission` is nearly always
 * in the matching family. It is a readability convention, not an assertion — unlike the
 * audit catalog, nothing here derives a permission FROM the name.
 */

/**
 * Every situation the inbox can carry.
 *
 * A member of this array with no producer in `source.registry.ts` FAILS THE BOOT
 * (`assertNotificationCoverageComplete`). That is the mechanism behind this phase's one
 * hard rule: a notification type cannot be invented, because declaring one without a
 * committed row behind it stops the service from starting.
 */
export const NOTIFICATION_TYPES = [
    // Cash on delivery
    'cod.discrepancy.opened',
    'cod.remittance.declared',
    // Money
    'money.payout.requested',
    // Orders
    'orders.dispute.opened',
    // Onboarding awaiting a decision
    'agencies.verification.pending',
    'vendors.kyc.pending',
    // Platform health
    'system.tracking_dispatch.failed',
    // This service's own machinery
    'approvals.requested',
    'approvals.decided',
    'audit.export.finished',
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/**
 * How loudly a dashboard should render it.
 *
 * Three, not five: an administrator triaging a list can hold three tiers in their head, and
 * a scale nobody can apply consistently is a scale that means nothing by its third month.
 *
 *  - `info`     — something happened that you may want to know about.
 *  - `warning`  — something is waiting on a human, and waiting has a cost.
 *  - `critical` — money or platform integrity is exposed while this is untouched.
 */
export const NOTIFICATION_SEVERITIES = ['info', 'warning', 'critical'] as const;

export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];

/**
 * The `?status=` filter on the list.
 *
 * DERIVED, not stored. There is no `status` column: `unread` is `read_at == null`, `read`
 * is `read_at != null`, `archived` is `archived_at` present. Storing it as well would give
 * two sources for one fact and a way for them to disagree — the same class of bug as the
 * drifted enum above, one layer down.
 *
 * `unread` and `read` both exclude archived rows, because an archived notification has left
 * the inbox; whether it was read on the way out is not what the filter is asking.
 */
export const NOTIFICATION_STATUS_FILTERS = ['unread', 'read', 'archived', 'all'] as const;

export type NotificationStatusFilter = (typeof NOTIFICATION_STATUS_FILTERS)[number];
