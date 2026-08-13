import { NOTIFICATION_TYPES, NotificationSeverity, NotificationType } from './notification.types';

/**
 * What each notification type MEANS — presentation and default preference, in one place.
 *
 * Deliberately NOT where visibility lives. `requiredPermission` is a property of the
 * SOURCE (`source.registry.ts`), because the source is what knows which committed row it
 * read and therefore who is entitled to hear about it. Splitting it this way keeps this
 * file safe to read as documentation: nothing here can widen who sees what.
 *
 * ── Severity, applied consistently ────────────────────────────────────────────
 * The scale in `notification.types.ts` is only worth having if it is applied the same way
 * every time, so the rule is written out rather than left to taste:
 *
 *   info      — it happened; you may want to know. Nothing is waiting.
 *   warning   — a human is being waited on, and the waiting has a cost.
 *   critical  — money or platform integrity is exposed for as long as this is untouched.
 *
 * A source may override the severity per row (an approval REJECTED reads differently from
 * one approved), but the value here is what the type means by default.
 */
export interface NotificationSpec {
    severity: NotificationSeverity;
    /** One line, present tense, for the ADR and the preferences screen. */
    summary: string;
    /**
     * Whether an administrator receives this without having said anything.
     *
     * Every type ships `true`. The field exists because the preference model stores only
     * overrides, so a future type that should be opt-in has somewhere to say so without a
     * migration — see `notification-preference.model.ts`.
     */
    defaultEnabled: boolean;
}

export const NOTIFICATION_CATALOG: Readonly<Record<NotificationType, NotificationSpec>> = Object.freeze({
    // ── Cash on delivery ─────────────────────────────────────────────────────
    'cod.discrepancy.opened': {
        severity: 'critical',
        summary: 'A break in the cash chain was flagged and is unresolved',
        defaultEnabled: true,
    },
    'cod.remittance.declared': {
        severity: 'warning',
        summary: 'An agency declared a remittance and is waiting for it to be confirmed',
        defaultEnabled: true,
    },

    // ── Money ────────────────────────────────────────────────────────────────
    'money.payout.requested': {
        severity: 'warning',
        summary: 'A payout was requested and has not been paid or rejected',
        defaultEnabled: true,
    },

    // ── Orders ───────────────────────────────────────────────────────────────
    'orders.dispute.opened': {
        severity: 'critical',
        summary: 'An order is frozen by a payment dispute',
        defaultEnabled: true,
    },

    // ── Onboarding awaiting a decision ───────────────────────────────────────
    'agencies.verification.pending': {
        severity: 'warning',
        summary: 'A delivery agency is waiting on verification',
        defaultEnabled: true,
    },
    'vendors.kyc.pending': {
        severity: 'warning',
        summary: 'A vendor is waiting on KYC review before they can go live',
        defaultEnabled: true,
    },

    // ── Platform health ──────────────────────────────────────────────────────
    'system.tracking_dispatch.failed': {
        severity: 'critical',
        summary: 'A lifecycle event exhausted its retries and never reached geo-tracker',
        defaultEnabled: true,
    },

    // ── This service's own machinery ─────────────────────────────────────────
    'approvals.requested': {
        severity: 'warning',
        summary: 'An action is queued for your second signature',
        defaultEnabled: true,
    },
    'approvals.decided': {
        severity: 'info',
        summary: 'An action you queued for approval was decided',
        defaultEnabled: true,
    },
    'audit.export.finished': {
        severity: 'info',
        summary: 'An audit export you requested finished',
        defaultEnabled: true,
    },
} as const satisfies Record<NotificationType, NotificationSpec>);

/** The spec for a type. Total by construction — `satisfies` above makes a gap a build error. */
export function notificationSpec(type: NotificationType): NotificationSpec {
    return NOTIFICATION_CATALOG[type];
}

/**
 * Whether a type reaches an administrator who has expressed no opinion about it.
 *
 * One function rather than an inline `?? true` at the two call sites (fan-out and the
 * preferences read model), so "what the default is" has exactly one answer.
 */
export function isEnabledByDefault(type: NotificationType): boolean {
    return NOTIFICATION_CATALOG[type].defaultEnabled;
}

/** Every type, in catalog order — the preferences screen renders this. */
export const NOTIFICATION_CATALOG_ENTRIES: readonly (NotificationSpec & { type: NotificationType })[] =
    Object.freeze(NOTIFICATION_TYPES.map((type) => ({ type, ...NOTIFICATION_CATALOG[type] })));
