import { IAdminAccount } from '../../admin-identity/models/admin-account.model';
import { IEmployeeRecord } from '../models/employee-record.model';
import {
    EMPLOYEE_DOCUMENT_SLOTS,
    EMPLOYEE_DOCUMENT_SLOT_NAMES,
    EmployeeDocumentSlot,
    employeeSlotField,
} from '../domain/employee-document.types';
import { maskPayoutMethods, PayoutMethodMasked } from '../domain/employee-payout.types';
import { assessReadiness, ReadinessReport } from '../domain/employee-readiness';
import { IGeoAddress } from '../domain/geo-address.types';

/**
 * ─── What an employee record looks like on the wire ──────────────────────────
 *
 * ── ⚠ THERE IS ONE PROJECTION, NOT TWO ──────────────────────────────────────
 * The employee and the tier-1 Developer reading their file see the SAME body. That is a
 * decision (ADR-023 D-2) and the reasoning runs against the usual instinct:
 *
 * The obvious design grades this — the subject sees everything, the reviewer sees less, or
 * the reverse. But every field here was typed in BY the employee about themselves, except the
 * employment block, which the company states TO them. There is nothing in the record the
 * subject does not already know, and nothing the reviewer may act on without seeing. A
 * projection would be two shapes to keep correct in order to hide a person's own date of
 * birth from them.
 *
 * Where the grading actually lives is **who may open it at all** — the subject, or tier 1, and
 * nobody else. That is enforced in the routes and the service, and it is a far stronger bound
 * than a field list: tier 2 holds `allInFamily('administrators')` and still cannot reach this.
 *
 * ⚠ Do not "fix" this by adding a redacted variant for tier 2. Tier 2 has no read here at all;
 * a redacted body would be a new, wider door, dressed as a narrowing.
 *
 * ── The payout destinations ARE masked, for everybody ────────────────────────
 * The one thing this body does hide, and it hides it from the subject too. See
 * `domain/employee-payout.types.ts`: payout details are write-mostly, echoing an account
 * number to anything that can read a profile turns a session hijack into a banking leak, and
 * nobody needs the digits back.
 *
 * ── Files are ids, never URLs ────────────────────────────────────────────────
 * Every document here is in the PRIVATE `admin-identity/` tree, so a `FileDetail` for one
 * would carry `url: null` by construction. The bytes come from
 * `GET /api/v1/files/:fileId/content`, which is audited and permissioned. Handing back an id
 * is the honest shape; handing back a `FileDetail` would give the dashboard a `url` field that
 * is always null and invite somebody to render it.
 */

export interface EmployeePhoneDto {
    label: string | null;
    number: string;
}

export interface EmployeeRelativeDto {
    fullName: string;
    relationship: string;
    phones: EmployeePhoneDto[];
}

export interface EmployeeEmploymentDto {
    position: string | null;
    department: string | null;
    employmentType: string | null;
    staffNumber: string | null;
    startedOn: string | null;
    endedOn: string | null;
    /** Minor currency units. An integer, or null when the company has not stated one. */
    monthlySalaryMinor: number | null;
    currency: string;
    notes: string | null;
    updatedAt: string | null;
    updatedBy: string | null;
}

/** One document slot, with its cardinality so a client knows whether to append or replace. */
export interface EmployeeDocumentSlotDto {
    slot: EmployeeDocumentSlot;
    cardinality: 'single' | 'multi';
    /** `jovi_mall.files._id` values. Resolve through `/files/:fileId`; the bytes need `/content`. */
    fileIds: string[];
}

export interface EmployeeRecordDto {
    adminId: string;
    /** The account's own status, repeated here so one call drives the onboarding screen. */
    accountStatus: string;

    fullName: string | null;
    dateOfBirth: string | null;
    placeOfBirth: string | null;
    gender: string | null;
    nationality: string | null;
    motherFullName: string | null;
    fatherFullName: string | null;
    phones: EmployeePhoneDto[];
    relatives: EmployeeRelativeDto[];

    idNumber: string | null;
    idType: string | null;
    idExpiresOn: string | null;

    homeAddress: IGeoAddress | null;

    documents: EmployeeDocumentSlotDto[];
    payoutMethods: PayoutMethodMasked[];
    employment: EmployeeEmploymentDto;

    /**
     * What is still missing before a Developer may activate this account.
     *
     * ⚠ Present on the SUBJECT's own read as well as the reviewer's, and that is the point:
     * the employee is the person who can actually fix a gap, so telling only the reviewer
     * would mean every missing field costs a message. Same list, same codes, both readers —
     * computed once by `assessReadiness`, so the button the Developer sees disabled and the
     * checklist the employee sees outstanding can never disagree.
     */
    readiness: ReadinessReport;

    lastSelfUpdateAt: string | null;
    createdAt: string | null;
    updatedAt: string | null;
}

const iso = (value: Date | null | undefined): string | null =>
    value ? new Date(value).toISOString() : null;

/** Read a slot's ids off the document, whatever its cardinality. */
function slotIds(record: IEmployeeRecord | null, slot: EmployeeDocumentSlot): string[] {
    if (!record) return [];
    const raw = (record as unknown as Record<string, unknown>)[employeeSlotField(slot)];
    if (Array.isArray(raw)) return raw.filter(Boolean).map((id) => String(id));
    return raw ? [String(raw)] : [];
}

/**
 * Build the body.
 *
 * `record` may be null — an administrator who has never opened the form has no row. It
 * answers a fully-shaped empty record rather than a 404, because a 404 would make the
 * dashboard's first load an error path for a perfectly normal state, and because
 * `readiness` is exactly as meaningful (and exactly as useful) for an empty record as for a
 * half-finished one.
 */
export function toEmployeeRecordDto(
    account: IAdminAccount,
    record: IEmployeeRecord | null,
): EmployeeRecordDto {
    const employment = record?.employment;

    return {
        adminId: account._id.toString(),
        accountStatus: account.status,

        fullName: record?.full_name ?? null,
        dateOfBirth: iso(record?.date_of_birth),
        placeOfBirth: record?.place_of_birth ?? null,
        gender: record?.gender ?? null,
        nationality: record?.nationality ?? null,
        motherFullName: record?.mother_full_name ?? null,
        fatherFullName: record?.father_full_name ?? null,
        phones: (record?.phones ?? []).map((p) => ({ label: p.label ?? null, number: p.number })),
        relatives: (record?.relatives ?? []).map((r) => ({
            fullName: r.full_name,
            relationship: r.relationship,
            phones: (r.phones ?? []).map((p) => ({ label: p.label ?? null, number: p.number })),
        })),

        idNumber: record?.id_number ?? null,
        idType: record?.id_type ?? null,
        idExpiresOn: iso(record?.id_expires_on),

        homeAddress: record?.home_address ?? null,

        // Built from the slot table, so every slot appears on every read with an empty array
        // when unfilled. A client rendering six upload boxes does not have to know the
        // vocabulary — an absent key would make "no document" and "no such slot" the same.
        documents: EMPLOYEE_DOCUMENT_SLOT_NAMES.map((slot) => ({
            slot,
            cardinality: EMPLOYEE_DOCUMENT_SLOTS[slot],
            fileIds: slotIds(record, slot),
        })),

        payoutMethods: maskPayoutMethods(record?.payout_methods),

        employment: {
            position: employment?.position ?? null,
            department: employment?.department ?? null,
            employmentType: employment?.employment_type ?? null,
            staffNumber: employment?.staff_number ?? null,
            startedOn: iso(employment?.started_on),
            endedOn: iso(employment?.ended_on),
            monthlySalaryMinor: employment?.monthly_salary_minor ?? null,
            currency: employment?.currency ?? 'XAF',
            notes: employment?.notes ?? null,
            updatedAt: iso(record?.employment_updated_at),
            updatedBy: record?.employment_updated_by ? record.employment_updated_by.toString() : null,
        },

        readiness: assessReadiness(account, record),

        lastSelfUpdateAt: iso(record?.last_self_update_at),
        createdAt: iso(record?.created_at),
        updatedAt: iso(record?.updated_at),
    };
}
