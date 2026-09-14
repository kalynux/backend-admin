import { IAdminAccount } from '../../admin-identity/models/admin-account.model';
import { mfaRequiredForTier } from '../../admin-identity/domain/mfa.service';
import { IEmployeeRecord } from '../models/employee-record.model';
import {
    ACTIVATION_REQUIRED_SLOTS,
    employeeSlotField,
} from './employee-document.types';

/**
 * ─── The activation gate ─────────────────────────────────────────────────────
 *
 * What an administrator's employee record must contain before a Developer may turn their
 * account on (ADR-023 D-5).
 *
 * ── ⚠ THE BACKEND ENFORCES THIS, AND THAT IS A DELIBERATE DIVERGENCE ────────
 * jovi-mall's applicant KYC module states, as an owner decision taken the same week, that
 * **nothing is required** and the dashboard computes the verdict. The owner chose the
 * opposite here. The two are not inconsistent, because the subjects are not comparable:
 *
 *   An APPLICANT is a member of the public the platform is deciding whether to admit.
 *   Refusing their submission for incompleteness denies them the one thing they need — to be
 *   told, by a human, what is missing and why — and the required/optional split is a REVIEW
 *   POLICY that changes when the reviewers change their minds.
 *
 *   An EMPLOYEE is a person the company is about to hand administrative access to its own
 *   platform. The Developer activating them is a colleague who can say what is missing in a
 *   message, so there is no equivalent cost — and the failure being guarded against, somebody
 *   waved through on a blank file, is a risk the company carries itself.
 *
 * ── ⚠ A PURE FUNCTION, returning a REPORT rather than throwing ──────────────
 * Two callers need two different things from the same rule: the activation endpoint needs a
 * verdict to refuse on, and the record read needs a checklist so the dashboard can show the
 * employee what is still outstanding and the Developer why the button is disabled. A function
 * that threw would serve the first and force the second to reimplement it — which is exactly
 * how two copies of one policy start disagreeing.
 *
 * So this returns every unmet requirement, always, and the caller decides what that means.
 */

/** One unmet requirement, in a shape a dashboard can render without a lookup table. */
export interface ReadinessGap {
    /** Stable machine key. Safe to branch on; safe to translate against. */
    code: string;
    /** Which part of the record it belongs to — the dashboard groups by this. */
    section: 'identity' | 'documents' | 'personal' | 'contact' | 'address' | 'payout' | 'security';
    /** One line, written for the person who has to fix it. */
    message: string;
}

export interface ReadinessReport {
    /** True when `gaps` is empty. Activation is refused while this is false. */
    ready: boolean;
    gaps: ReadinessGap[];
}

/**
 * Is this slot filled?
 *
 * Reads through `employeeSlotField` rather than naming the column, so a slot whose
 * cardinality changes does not silently start reporting "missing" against an array it is
 * comparing to null.
 */
function slotFilled(
    record: IEmployeeRecord | null,
    slot: (typeof ACTIVATION_REQUIRED_SLOTS)[number],
): boolean {
    if (!record) return false;
    const raw = (record as unknown as Record<string, unknown>)[employeeSlotField(slot)];
    if (Array.isArray(raw)) return raw.length > 0;
    return Boolean(raw);
}

const SLOT_LABELS: Record<string, string> = {
    id_card_front: 'the front of your identity document',
    id_card_back: 'the back of your identity document',
    selfie_with_id: 'a photograph of you holding your identity document',
    home_address_sketch: 'a hand-drawn sketch of how to reach your home',
    home_exterior_photo: 'a photograph of you in front of your home',
    signed_contract: 'your signed contract',
};

/**
 * Grade a record against the activation requirements.
 *
 * `record` may be null — an administrator who has never opened the form has no row — and that
 * is not a special case worth branching on at the call sites: a null record is simply one
 * that fails every requirement, which is the truthful answer and produces a complete
 * checklist for a dashboard to render on first load.
 */
export function assessReadiness(
    account: IAdminAccount,
    record: IEmployeeRecord | null,
): ReadinessReport {
    const gaps: ReadinessGap[] = [];

    const miss = (code: string, section: ReadinessGap['section'], message: string) =>
        gaps.push({ code, section, message });

    /**
     * Two-factor, and ONLY where this administrator's tier actually requires it.
     *
     * `mfaRequiredForTier` reads `ADMIN_MFA_REQUIRED_TIER`, so a deployment that requires MFA
     * of Developers alone does not have activation of a Support account blocked on a control
     * that deployment decided not to ask for. Hardcoding "MFA always" here would make this
     * gate quietly override an existing configuration knob, in a second place, where nobody
     * looking at that knob would find it.
     */
    if (mfaRequiredForTier(account.tier) && !account.mfa_enrolled) {
        miss(
            'mfa_not_enrolled',
            'security',
            'Two-factor authentication must be activated on this account',
        );
    }

    /**
     * ⚠ **A MISSING record is graded exactly like an EMPTY one, and the checks below run
     * either way.**
     *
     * The obvious shape — `if (!record) { miss('record_missing'); }` and then guard every
     * field check behind `if (record)` — was what this function did first, and it was wrong:
     * an administrator who had never opened the form got back a report containing ONE gap,
     * so the dashboard rendered a checklist with a single line on it and the employee could
     * not see what they were being asked for until they had already started. The DTO's own
     * docblock promised the opposite ("a complete checklist to render on first load"), which
     * is how the contradiction was caught.
     *
     * There is also no separate `record_missing` code, deliberately. It would fire alongside
     * all eight field gaps — saying the same thing a ninth time — and it is not something the
     * employee can act on independently of them. "No record" and "empty record" mean the same
     * thing to everybody who reads this report, so they produce the same report.
     *
     * `r` is typed loosely rather than through a null guard so every check below reads the
     * same whether or not a document exists; an absent field and an absent record are both
     * `undefined` here, and both are gaps.
     */
    const r = (record ?? {}) as Partial<IEmployeeRecord>;

    if (!r.full_name) miss('full_name_missing', 'personal', 'Your full legal name is required');
    if (!r.date_of_birth) miss('date_of_birth_missing', 'personal', 'Your date of birth is required');
    if (!r.id_number) {
        miss('id_number_missing', 'identity', 'Your identity document number is required');
    }
    if (!r.home_address) {
        miss(
            'home_address_missing',
            'address',
            'A geocoded home address is required — search for it and pick a result',
        );
    }
    if (!r.phones || r.phones.length === 0) {
        miss('phone_missing', 'contact', 'At least one phone number is required');
    }
    if (!r.payout_methods || r.payout_methods.length === 0) {
        miss('payout_missing', 'payout', 'At least one payout destination is required');
    }

    for (const slot of ACTIVATION_REQUIRED_SLOTS) {
        if (!slotFilled(record, slot)) {
            miss(
                `document_missing:${slot}`,
                'documents',
                `Upload ${SLOT_LABELS[slot] ?? slot}`,
            );
        }
    }

    return { ready: gaps.length === 0, gaps };
}
