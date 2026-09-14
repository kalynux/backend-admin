import { z } from 'zod';

/**
 * ─── The staff identity document set ─────────────────────────────────────────
 *
 * What a tier-1 Developer looks at when deciding whether a new administrator is a real
 * person the company can hold responsible for the access it is about to hand them.
 *
 * ── The relationship to the applicant KYC slots ──────────────────────────────
 * jovi-mall's `core/types/kyc-documents.types.ts` collects almost exactly this set from
 * vendors, agencies and agents. This is deliberately a SEPARATE vocabulary rather than an
 * import or a copy, for the same reason the storage tree is separate: the two describe
 * different people under different obligations, and they have already diverged.
 *
 * What differs today:
 *   - `home_exterior_photo` is here and not there. Asked for explicitly: a photograph of the
 *     employee standing in front of their house, which together with the sketch and the
 *     geocoded address is three independent ways to find where somebody actually lives.
 *   - `signed_contract` is here and not there. An applicant has no employment contract.
 *   - `store_address_sketch` and `vehicle_with_agent` are there and not here. An
 *     administrator has no shop and delivers nothing.
 *
 * Sharing one enum would have meant every future slot on either side appearing on both, with
 * half of them permanently null and every reader having to ask why.
 *
 * ── ⚠ THESE STRINGS ARE A PUBLIC CONTRACT ───────────────────────────────────
 * They are the `:slot` path segment on the upload and delete routes, and the keys of the
 * `documents` object on every read. Renaming one breaks the dashboard.
 *
 * Two cardinalities, and the difference is not cosmetic:
 *
 *   **single** — REPLACED on re-upload. There is one front of one identity card, so a second
 *   upload means "the first was bad". The displaced file is detached and soft-deleted rather
 *   than left lying around: it is a photograph of a national identity card, and the grace
 *   period on an unreferenced file is not the right place for one.
 *
 *   **multi** — APPENDED, up to {@link EMPLOYEE_MULTI_SLOT_MAX_FILES}. An employee may have a
 *   sketch of the approach from two directions, or a contract plus two addenda; the count is
 *   theirs, not ours to derive.
 */
export const EMPLOYEE_DOCUMENT_SLOTS = {
    id_card_front: 'single',
    id_card_back: 'single',
    selfie_with_id: 'single',
    home_address_sketch: 'multi',
    home_exterior_photo: 'single',
    signed_contract: 'multi',
} as const;

export type EmployeeDocumentSlot = keyof typeof EMPLOYEE_DOCUMENT_SLOTS;
export type EmployeeSlotCardinality = (typeof EMPLOYEE_DOCUMENT_SLOTS)[EmployeeDocumentSlot];

export const EMPLOYEE_DOCUMENT_SLOT_NAMES = Object.keys(
    EMPLOYEE_DOCUMENT_SLOTS,
) as EmployeeDocumentSlot[];

/**
 * The ceiling on a multi-value slot, per slot.
 *
 * Ten, matching the applicant side, and the real constraint is the same one: a reviewer's
 * patience rather than disk. A record with forty sketches is not more verifiable than one
 * with three. The bytes are separately capped by jovi-mall's upload policy.
 */
export const EMPLOYEE_MULTI_SLOT_MAX_FILES = 10;

/** The Mongoose field name backing a slot. */
export function employeeSlotField(slot: EmployeeDocumentSlot): string {
    return EMPLOYEE_DOCUMENT_SLOTS[slot] === 'multi' ? `${slot}_file_ids` : `${slot}_file_id`;
}

export function isEmployeeDocumentSlot(value: unknown): value is EmployeeDocumentSlot {
    return typeof value === 'string' && value in EMPLOYEE_DOCUMENT_SLOTS;
}

/**
 * The `:slot` path parameter.
 *
 * Closed, so `POST /me/employee-record/documents/passport_scan` answers 400 naming the slots
 * that exist rather than 200 having stored nothing. A write that silently does nothing is the
 * hardest thing there is for a frontend author to diagnose, because every observable signal
 * says it worked.
 */
export const EmployeeSlotParamSchema = z.object({
    slot: z.enum(EMPLOYEE_DOCUMENT_SLOT_NAMES as [EmployeeDocumentSlot, ...EmployeeDocumentSlot[]]),
});

export const EmployeeDocumentParamSchema = EmployeeSlotParamSchema.extend({
    fileId: z.string().trim().regex(/^[0-9a-fA-F]{24}$/, 'Must be a 24-character hex id'),
});

/**
 * The slots the ACTIVATION GATE requires (ADR-023 D-5).
 *
 * ⚠ **This is a backend-enforced required set, and it is a deliberate DIVERGENCE from the
 * applicant KYC module** — whose own header states, as an owner decision taken the same week,
 * that nothing is required and the dashboard grades. The owner chose the opposite here, and
 * the two are not inconsistent because the subjects are not comparable:
 *
 *   An APPLICANT is a member of the public the platform is deciding whether to admit.
 *   Refusing their submission for incompleteness means refusing them the one thing they
 *   actually need — to be told, by a human, what is missing and why.
 *
 *   An EMPLOYEE is a person the company is about to hand administrative access to its own
 *   platform. There is no analogous cost to refusing: the Developer activating them is a
 *   colleague who can say what is missing in a message, and the failure mode being guarded
 *   against — somebody waved through with a blank file — is one the company carries itself.
 *
 * `signed_contract` is NOT in this set, and that is the one judgement call inside the
 * decision: an employee frequently starts before the paperwork is countersigned, and a gate
 * that blocks activation on a document the COMPANY owes THEM would stop the wrong person.
 */
export const ACTIVATION_REQUIRED_SLOTS: readonly EmployeeDocumentSlot[] = [
    'id_card_front',
    'id_card_back',
    'selfie_with_id',
];
