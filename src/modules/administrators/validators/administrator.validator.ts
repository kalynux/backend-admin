import { z } from 'zod';
import { paginationFields } from '../../../core/http/list-query';
import { boolFlag, idParam, reasonText, searchTerm } from '../../../core/validation/common.schemas';
import { clearable } from '../../../core/validation/zod.helpers';
import { ADMIN_STATUSES, ADMIN_TIERS } from '../../admin-identity/domain/admin-identity.types';

/**
 * Request shapes for `/api/v1/administrators`.
 *
 * ── Note what these schemas do NOT accept ─────────────────────────────────────
 * `tier` is absent from both the create and the update body except where it is the entire
 * point (`PUT /:adminId/tier`). Levels change through one endpoint, guarded by one
 * permission, dual-controlled at the top — a `tier` field quietly accepted by a profile
 * PATCH would route the most dangerous write in the service through the least examined
 * path.
 *
 * `status` is absent for the same reason: suspension has its own endpoint because it has
 * its own consequences (every session dies) and its own required reason.
 */

const TierSchema = z
    .number()
    .int()
    .refine((value): value is 1 | 2 | 3 => (ADMIN_TIERS as readonly number[]).includes(value), {
        message: 'Administrator level must be 1 (Developer), 2 (Admin) or 3 (Support)',
    });

export const AdminIdParamSchema = idParam('adminId', 'administrator');

/**
 * `paginationFields`, not `listQuery` — this list offers no `sort`.
 *
 * Its order is the compound `{ tier: 1, created_at: -1 }`: administrators grouped by level,
 * newest first within a level, which is the directory an administrator actually reads. A
 * single sort key cannot express that, and `listQuery` deliberately models one key plus the
 * `_id` tiebreaker rather than growing a compound-sort grammar for one endpoint. An
 * endpoint whose natural order is compound keeps it and offers no `sort` until somebody
 * needs one — see ADR-005 §Sorting.
 */
export const ListAdministratorsQuerySchema = z.object({
    tier: z.coerce.number().int().pipe(TierSchema).optional(),
    status: z.enum(ADMIN_STATUSES as unknown as [string, ...string[]]).optional(),
    search: searchTerm.optional(),
    ...paginationFields,
});

export const CreateAdministratorSchema = z.object({
    email: z.string().trim().toLowerCase().email('A valid email address is required'),
    displayName: z.string().trim().min(2, 'Display name is required').max(120),
    tier: TierSchema,
    jobTitle: z.string().trim().max(120).optional(),
    department: z.string().trim().max(120).optional(),
});

/**
 * `clearable()` on the optional text fields: sending `''` or `null` empties them.
 *
 * Without it a job title can be set but never removed — `z.string().max(120).optional()`
 * treats an absent key as "unchanged" and rejects the empty string, so there is no value
 * that means "clear this".
 */
export const UpdateAdministratorSchema = z
    .object({
        displayName: z.string().trim().min(2).max(120).optional(),
        jobTitle: clearable(z.string().trim().max(120)),
        department: clearable(z.string().trim().max(120)),
        timezone: z.string().trim().min(1).max(64).optional(),
        preferredLanguage: z.string().trim().min(2).max(10).optional(),
    })
    .refine((body) => Object.keys(body).length > 0, { message: 'No fields to update' });

export const SetTierSchema = z.object({
    tier: TierSchema,
});

/** The administrator plus one of their session ids. */
export const AdminSessionParamSchema = z.object({
    adminId: z.string().regex(/^[a-f\d]{24}$/i, 'Not a valid administrator id'),
    // A session id is a UUID, not an ObjectId — `objectId` would refuse every real one.
    sessionId: z.string().trim().min(8).max(128),
});

export const ListSessionsQuerySchema = z.object({
    /**
     * `boolFlag`, not `z.coerce.boolean()`: the latter reads the string `'false'` as
     * `true`, so a client explicitly asking for live sessions only would get the full
     * history. See `common.schemas.ts`.
     */
    includeEnded: boolFlag.optional(),
});

export const SuspendAdministratorSchema = z.object({
    /**
     * Required, deliberately. jovi-mall's agent module enforces reason-on-negative-action
     * and PHASE-0:107 calls it the strongest thing about that surface; an unexplained
     * suspension of a colleague is worse still.
     */
    reason: reasonText('A reason is required to suspend an administrator'),
});

export type ListAdministratorsQuery = z.infer<typeof ListAdministratorsQuerySchema>;
export type ListSessionsQuery = z.infer<typeof ListSessionsQuerySchema>;
export type CreateAdministratorBody = z.infer<typeof CreateAdministratorSchema>;
export type UpdateAdministratorBody = z.infer<typeof UpdateAdministratorSchema>;
export type SetTierBody = z.infer<typeof SetTierSchema>;
export type SuspendAdministratorBody = z.infer<typeof SuspendAdministratorSchema>;
