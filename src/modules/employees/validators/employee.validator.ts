import { z } from 'zod';
import { objectId } from '../../../core/validation/common.schemas';
import { clearable } from '../../../core/validation/zod.helpers';
import { GeoAddressZodSchema } from '../domain/geo-address.types';
import { PayoutMethodsZodSchema } from '../domain/employee-payout.types';

/**
 * Request shapes for the employee record.
 *
 * ── ⚠ EVERY SCHEMA HERE IS `.strict()` ──────────────────────────────────────
 * Not the service-wide default — `query-strictness-is-not-uniform` is a real finding, and 11
 * of 66 query schemas are strict while the rest are not. These are strict deliberately, and
 * the reason is specific to this surface: the body is a person's identity record, and the
 * failure mode of a lenient schema is a field silently ignored. An employee who corrects
 * their date of birth, gets a 200, and finds the old value still there has been told the save
 * worked when it did not — on a record whose accuracy is the entire point of collecting it.
 *
 * A strict schema turns a typo into a 400 naming the key. That is the right trade here even
 * though it is not the right trade for a list query.
 *
 * ── `clearable()` throughout, and what that buys ─────────────────────────────
 * `.optional()` alone means "the key may be absent" — it gives no way to EMPTY a field once
 * set, because `''` fails the constraint and `null` fails the type. An employee who typed the
 * wrong mother's name must be able to take it back. See `core/validation/zod.helpers.ts`.
 */

const shortText = (max = 200) => z.string().trim().min(1).max(max);

/**
 * Full E.164. Defined here as well as in the payout types because they are different
 * contracts that happen to agree today: a contact number and a payout destination are
 * validated for different reasons, and collapsing them would mean relaxing one relaxes both.
 */
const E164 = z
    .string()
    .trim()
    .regex(/^\+[1-9]\d{6,14}$/, 'Must be a full international number, e.g. +237670000000');

const PhoneSchema = z
    .object({
        label: clearable(z.string().trim().max(40)),
        number: E164,
    })
    .strict();

const RelativeSchema = z
    .object({
        fullName: shortText(160),
        relationship: shortText(60),
        /**
         * At least one number, because a relative with no contact detail is a name in a
         * database rather than somebody who can be reached — which is the entire reason the
         * block exists.
         */
        phones: z.array(PhoneSchema).min(1, 'Give at least one number for this contact').max(5),
    })
    .strict();

/**
 * A date the client sends as a calendar day, not an instant.
 *
 * ⚠ `YYYY-MM-DD` and nothing else. An ISO instant would carry a timezone, and a date of birth
 * shifted by an offset is a person who is a day older in one reading than another — which is
 * exactly the sort of discrepancy that makes an identity document appear not to match.
 * Parsed as UTC midnight so the stored value round-trips to the same calendar day everywhere.
 */
const calendarDate = z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
    .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)), 'Not a real date')
    .transform((value) => new Date(`${value}T00:00:00.000Z`));

/**
 * The self-service half — everything the employee says about themselves.
 *
 * ⚠ **`employment` is deliberately absent and must stay absent.** It is written through a
 * separate route behind `employees.employment.write`, which is tier 1. An employee able to
 * PATCH their own salary makes this collection worthless as a record of anything, and
 * `.strict()` above is what turns an attempt into a 400 rather than a silently dropped key.
 */
export const UpdateEmployeeRecordSchema = z
    .object({
        fullName: clearable(shortText(160)),
        dateOfBirth: clearable(calendarDate),
        placeOfBirth: clearable(shortText(160)),
        gender: clearable(shortText(40)),
        nationality: clearable(shortText(80)),
        motherFullName: clearable(shortText(160)),
        fatherFullName: clearable(shortText(160)),

        idNumber: clearable(shortText(60)),
        idType: clearable(shortText(60)),
        idExpiresOn: clearable(calendarDate),

        /**
         * A FULL REPLACE when present, not a merge — the same contract the platform's payout
         * lists use. Merging an array is ambiguous (is the second entry an addition or a
         * correction of the first?) and the answer differs per caller.
         *
         * `null` clears the list. An empty array does the same thing and is accepted, because
         * a form that removes its last row naturally submits `[]`.
         */
        phones: z.array(PhoneSchema).max(5).nullable().optional(),
        relatives: z.array(RelativeSchema).max(5).nullable().optional(),

        /**
         * A geocoding result the client selected from `GET /api/v1/geo/search`.
         *
         * ⚠ The client does not invent this. It is the candidate verbatim, so the stored row
         * records which provider resolved it and carries a `provider_place_id` that can be
         * looked up later. A free-text address with coordinates typed in by hand would
         * validate and would be unverifiable, which is the thing the geocoded shape exists to
         * prevent.
         */
        homeAddress: GeoAddressZodSchema.nullable().optional(),

        payoutMethods: PayoutMethodsZodSchema.nullable().optional(),
    })
    .strict()
    /**
     * An empty PATCH is refused rather than treated as a no-op.
     *
     * A body with no recognised key almost always means the client sent the wrong shape —
     * camelCase where snake_case was meant, or a nested object where a flat one was. Answering
     * 200 to that is the silent-success failure this file's header is about.
     */
    .refine((body) => Object.keys(body).length > 0, {
        message: 'Send at least one field to update',
    });

export type UpdateEmployeeRecordInput = z.infer<typeof UpdateEmployeeRecordSchema>;

/**
 * The employment block — written by a tier-1 Developer ABOUT an employee.
 *
 * Separate schema, separate route, separate permission. See the ⚠ on the self-service schema.
 */
export const UpdateEmploymentSchema = z
    .object({
        position: clearable(shortText(120)),
        department: clearable(shortText(120)),
        employmentType: clearable(shortText(60)),
        staffNumber: clearable(shortText(60)),
        startedOn: clearable(calendarDate),
        endedOn: clearable(calendarDate),
        /**
         * Monthly gross in MINOR CURRENCY UNITS — the platform's convention everywhere.
         *
         * ⚠ `.int()` is load-bearing, not tidiness. A salary accepted as `450000.5` is stored
         * as a float, and a payroll figure that does not reconcile is a conversation with a
         * person rather than a rounding error. A client sending major units will be refused by
         * this rather than silently paying somebody 1/100th of their wage.
         */
        monthlySalaryMinor: clearable(z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)),
        currency: clearable(z.string().trim().length(3).toUpperCase()),
        notes: clearable(z.string().trim().max(2000)),
    })
    .strict()
    .refine((body) => Object.keys(body).length > 0, {
        message: 'Send at least one field to update',
    })
    /**
     * An employment that ended before it began is a data-entry slip, and it is worth catching
     * here because nothing downstream would notice: no query orders by these, so the record
     * would simply be wrong and stay wrong.
     *
     * Only checked when BOTH arrive in the same request — a `endedOn` sent alone cannot be
     * compared against a `startedOn` this schema has never seen, and reaching into the stored
     * document from a validator would put a database read in a pure function.
     */
    .refine(
        (body) =>
            !(body.startedOn instanceof Date && body.endedOn instanceof Date) ||
            body.endedOn >= body.startedOn,
        { message: 'The end date cannot be before the start date', path: ['endedOn'] },
    );

export type UpdateEmploymentInput = z.infer<typeof UpdateEmploymentSchema>;

/** `:adminId` on the reviewer-facing reads. */
export const EmployeeAdminIdParamSchema = z.object({ adminId: objectId });

/**
 * The avatar, set by id after uploading through `POST /api/v1/files/upload`.
 *
 * Two calls rather than one multipart route here, deliberately: the upload proxy already
 * exists, is already audited, and already answers a `FileDetail`. A second multipart endpoint
 * would be a second place to get the byte cap and the audit posture right, for a picture.
 */
export const SetAvatarSchema = z
    .object({ fileId: objectId.nullable() })
    .strict();
