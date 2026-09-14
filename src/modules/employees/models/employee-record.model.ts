import { Schema, Document, Types, Model } from 'mongoose';
import { adminConnection } from '../../../infra/mongo/connections';
import {
    EMPLOYEE_DOCUMENT_SLOT_NAMES,
    EmployeeDocumentSlot,
    employeeSlotField,
    EMPLOYEE_DOCUMENT_SLOTS,
} from '../domain/employee-document.types';
import { GeoAddressSchema, IGeoAddress } from '../domain/geo-address.types';
import { IEmployeePayoutMethod, PayoutMethodSchema } from '../domain/employee-payout.types';

/**
 * `admin_employee_records` — everything the company holds about a member of its own staff,
 * in the PRIVATE `wi-admin` database (ADR-023).
 *
 * ── ⚠ WHY THIS IS A SEPARATE COLLECTION AND NOT FIELDS ON `admin_accounts` ───
 * Three reasons, and the third is the one that actually decides it.
 *
 *   **Different audience.** `admin_accounts` is the DIRECTORY: every administrator who holds
 *   `administrators.read` — which is tiers 1 and 2 — sees a name, a level and a status. This
 *   is an EMPLOYMENT FILE: a salary, a date of birth, a mother's maiden name, a photograph of
 *   somebody's front door. Only the employee themselves and a tier-1 Developer may see it
 *   (ADR-023 D-2). Two audiences that far apart should not share a document, because then the
 *   only thing standing between them is a projection somebody hand-wrote.
 *
 *   **Different write path.** Almost every field here is written by the EMPLOYEE about
 *   themselves. `admin_accounts.tier` and `.status` are written by other people about them.
 *   Mixing self-service writes and administrative writes into one `updateOne` is how an
 *   employee ends up able to set their own level.
 *
 *   **`allInFamily('administrators')` is granted to tier 2.** That is not a hypothetical: it
 *   is `tier-grants.ts` today. If this data hung off the account document, the permission
 *   that lets an Admin manage the directory would be one over-broad projection away from
 *   their colleagues' salaries. A separate collection behind a separate family (`employees`,
 *   tier 1 only) makes that mistake impossible to make by accident rather than merely
 *   inadvisable.
 *
 * ── The relationship is 1:1 and LAZY ─────────────────────────────────────────
 * `admin_id` is unique. A record is created on first write (or first read, as an empty
 * shell) rather than alongside the account, so an administrator created before this feature
 * shipped has no row and is not broken by its absence — `null` is a valid answer everywhere.
 *
 * ── Files are ids, and the bytes are in jovi-mall ────────────────────────────
 * Every `*_file_id` here names a `jovi_mall.files._id` in the private `admin-identity/`
 * storage tree. This service holds the id and the SLOT; jovi-mall holds the bytes and one
 * `file_references` row and knows nothing about what the picture is of. That split is
 * ADR-023 D-4 and it is why there is no `admin-identity` reader in jovi-mall.
 */

export const EMPLOYEE_RECORD_COLLECTION = 'admin_employee_records';

// ─────────────────────────────────────────────────────────────────────────────
// Sub-shapes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A phone number the employee or the company can be reached on.
 *
 * `label` is free text on purpose — "personal", "work", "the one that actually rings" — and
 * the platform has no use for a closed vocabulary here. `number` is E.164, validated by the
 * same rule the rest of the platform uses, because a number that cannot be dialled from
 * outside the country is not a contact.
 */
export interface IEmployeePhone {
    label: string | null;
    number: string;
}

const EmployeePhoneSchema = new Schema<IEmployeePhone>(
    {
        label: { type: String, default: null, trim: true },
        number: { type: String, required: true, trim: true },
    },
    { _id: false },
);

/**
 * Somebody to call who is not the employee — a parent, a sibling, a partner.
 *
 * ⚠ **`relationship` is free text and is deliberately NOT an enum.** Family shapes do not fit
 * a dropdown, and an employee forced to file their guardian under "other" has been asked to
 * misdescribe their own life so a database can be tidy. Nothing branches on this value.
 */
export interface IEmployeeRelative {
    full_name: string;
    relationship: string;
    phones: IEmployeePhone[];
}

const EmployeeRelativeSchema = new Schema<IEmployeeRelative>(
    {
        full_name: { type: String, required: true, trim: true },
        relationship: { type: String, required: true, trim: true },
        phones: { type: [EmployeePhoneSchema], default: [] },
    },
    { _id: false },
);

/**
 * The employment terms — the one block on this record the EMPLOYEE MAY NOT WRITE.
 *
 * Everything else here is self-service: an employee maintains their own address, their own
 * phone numbers, their own payout destination. This block is what the company says about
 * them, and it is written by a tier-1 Developer through a separate route behind a separate
 * permission (`employees.employment.write`). An employee who could set their own salary
 * would make this collection worthless as a record of anything.
 *
 * They can still READ it, and that is not an oversight — an employee who cannot see their own
 * stated salary, start date or contract type has been handed a payslip they cannot check.
 */
export interface IEmployeeEmployment {
    /** Free text: the internal job title the company uses, distinct from the account's. */
    position: string | null;
    department: string | null;
    employment_type: string | null;
    /** Internal staff number, if the company issues one. */
    staff_number: string | null;
    started_on: Date | null;
    ended_on: Date | null;
    /**
     * Monthly gross salary in MINOR CURRENCY UNITS — the platform's convention everywhere
     * (`earnings.config.ts`: "Money values are integers in minor currency units").
     *
     * ⚠ An integer, never a float. A salary stored as `450000.00` in a double is a salary
     * that will one day be `449999.99999`, and a payroll figure that does not reconcile is
     * a conversation with a person rather than a rounding error.
     */
    monthly_salary_minor: number | null;
    currency: string;
    /** Free text the Developer maintaining the record can use for terms, notes, anything. */
    notes: string | null;
}

const EmployeeEmploymentSchema = new Schema<IEmployeeEmployment>(
    {
        position: { type: String, default: null, trim: true },
        department: { type: String, default: null, trim: true },
        employment_type: { type: String, default: null, trim: true },
        staff_number: { type: String, default: null, trim: true },
        started_on: { type: Date, default: null },
        ended_on: { type: Date, default: null },
        monthly_salary_minor: { type: Number, default: null, min: 0 },
        currency: { type: String, required: true, default: 'XAF', uppercase: true, trim: true },
        notes: { type: String, default: null, trim: true },
    },
    { _id: false },
);

// ─────────────────────────────────────────────────────────────────────────────
// The record
// ─────────────────────────────────────────────────────────────────────────────

export interface IEmployeeRecord extends Document {
    _id: Types.ObjectId;
    /** The `admin_accounts._id` this record belongs to. Unique — the relationship is 1:1. */
    admin_id: Types.ObjectId;

    // ── Personal ─────────────────────────────────────────────────────────────
    /**
     * The employee's LEGAL name, as it appears on the identity document above it.
     *
     * ⚠ Deliberately not `admin_accounts.display_name`, and merging them would be wrong. A
     * display name is what colleagues call you and you may change it freely; this is what the
     * state calls you and a reviewer compares it against a scanned card. They frequently
     * differ for perfectly ordinary reasons, and a system that assumes they agree will one
     * day refuse a real person.
     */
    full_name: string | null;
    date_of_birth: Date | null;
    place_of_birth: string | null;
    gender: string | null;
    nationality: string | null;
    mother_full_name: string | null;
    father_full_name: string | null;
    phones: IEmployeePhone[];
    relatives: IEmployeeRelative[];

    // ── Identity ─────────────────────────────────────────────────────────────
    /**
     * The number on the identity document, as the employee typed it.
     *
     * ⚠ It proves nothing on its own — that was the whole finding behind the applicant KYC
     * module: a verification decision resting on a string the applicant typed is either a
     * rubber stamp or a refusal. It is here because a reviewer needs to compare it against
     * the scan, not because storing it verifies anything.
     */
    id_number: string | null;
    id_type: string | null;
    id_expires_on: Date | null;

    /** Where the employee lives, geocoded through jovi-mall's provider chain. */
    home_address: IGeoAddress | null;

    // Document slots. Shape mirrors the applicant KYC block deliberately — see
    // `domain/employee-document.types.ts` for the slot vocabulary and its cardinalities.
    id_card_front_file_id: Types.ObjectId | null;
    id_card_back_file_id: Types.ObjectId | null;
    selfie_with_id_file_id: Types.ObjectId | null;
    home_address_sketch_file_ids: Types.ObjectId[];
    home_exterior_photo_file_id: Types.ObjectId | null;
    signed_contract_file_ids: Types.ObjectId[];

    // ── Money ────────────────────────────────────────────────────────────────
    /**
     * Where the company pays this person. Ordered; index 0 is the preferred destination,
     * exactly as it is for a vendor, an agency and an agent.
     */
    payout_methods: IEmployeePayoutMethod[];

    // ── Employment ───────────────────────────────────────────────────────────
    employment: IEmployeeEmployment;

    // ── Provenance ───────────────────────────────────────────────────────────
    /**
     * When the employee last changed anything in the self-service half.
     *
     * Not a lock and not a submission: unlike the applicant KYC record, this one is never
     * frozen. An employee moves house, changes their phone and switches bank; a record they
     * cannot correct after activation would be stale within a year, and the activation
     * decision is about the PERSON rather than about a snapshot of their paperwork.
     */
    last_self_update_at: Date | null;
    /** When a Developer last changed the employment block. Null until one does. */
    employment_updated_at: Date | null;
    employment_updated_by: Types.ObjectId | null;

    created_at: Date;
    updated_at: Date;
}

/** Built from the slot table so a new slot cannot be added in one place and not the other. */
function documentSlotFields(): Record<string, unknown> {
    const fields: Record<string, unknown> = {};
    for (const slot of EMPLOYEE_DOCUMENT_SLOT_NAMES) {
        fields[employeeSlotField(slot as EmployeeDocumentSlot)] =
            EMPLOYEE_DOCUMENT_SLOTS[slot as EmployeeDocumentSlot] === 'multi'
                ? { type: [Schema.Types.ObjectId], default: [] }
                : { type: Schema.Types.ObjectId, default: null };
    }
    return fields;
}

const EmployeeRecordSchema = new Schema<IEmployeeRecord>(
    {
        admin_id: { type: Schema.Types.ObjectId, required: true, unique: true, ref: 'AdminAccount' },

        full_name: { type: String, default: null, trim: true },
        date_of_birth: { type: Date, default: null },
        place_of_birth: { type: String, default: null, trim: true },
        gender: { type: String, default: null, trim: true },
        nationality: { type: String, default: null, trim: true },
        mother_full_name: { type: String, default: null, trim: true },
        father_full_name: { type: String, default: null, trim: true },
        phones: { type: [EmployeePhoneSchema], default: [] },
        relatives: { type: [EmployeeRelativeSchema], default: [] },

        id_number: { type: String, default: null, trim: true },
        id_type: { type: String, default: null, trim: true },
        id_expires_on: { type: Date, default: null },

        home_address: { type: GeoAddressSchema, default: null },

        ...documentSlotFields(),

        payout_methods: { type: [PayoutMethodSchema], default: [] },

        employment: { type: EmployeeEmploymentSchema, required: true, default: () => ({}) },

        last_self_update_at: { type: Date, default: null },
        employment_updated_at: { type: Date, default: null },
        employment_updated_by: { type: Schema.Types.ObjectId, default: null, ref: 'AdminAccount' },
    },
    {
        timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
        collection: EMPLOYEE_RECORD_COLLECTION,
    },
);

/**
 * ⚠ **There is deliberately NO `2dsphere` index on `home_address.coordinates`.**
 *
 * The platform indexes every other geocoded address because something ranks by proximity to
 * it — an agent to a pickup, a shipment to a drop-off. Nothing ranks staff by distance, and
 * a `2dsphere` index is the one index shape on this platform that BRICKS the document when
 * the field is null-in-an-array (see the geopoint note in the delivery models). Adding an
 * index nothing queries, whose failure mode is a write that cannot be saved, would be paying
 * a real risk for no read.
 */

/**
 * Strip nothing on serialisation, because nothing here is a credential — and that is worth
 * saying rather than leaving to inference.
 *
 * `admin_accounts` carries a `toJSON` transform deleting `password_hash` and `mfa_secret`,
 * as a backstop under the DTO. This collection holds no secret of that kind: it holds
 * personal data, which is protected by WHO MAY READ IT (tier 1 or the subject) rather than
 * by field-level redaction. A transform here would suggest there is a safe way to serialise
 * the whole document to a wider audience, and there is not.
 *
 * The payout destinations are the one exception, and they are masked in the DTO — see
 * `read-models/employee-record.dto.ts`.
 */

let cached: Model<IEmployeeRecord> | null = null;

/** Lazy, for the reason `AdminAccountModel()` is: registration needs an open connection. */
export function EmployeeRecordModel(): Model<IEmployeeRecord> {
    if (!cached) {
        cached = adminConnection().model<IEmployeeRecord>('AdminEmployeeRecord', EmployeeRecordSchema);
    }
    return cached;
}

/** Test-only: drop the memoized model so a fresh connection can re-register it. */
export function resetEmployeeRecordModel(): void {
    cached = null;
}
