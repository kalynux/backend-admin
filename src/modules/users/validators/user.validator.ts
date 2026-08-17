import { z } from 'zod';
import { listQuery } from '../../../core/http/list-query';
import {
    dateRangeFields,
    dateRangeRule,
    idParam,
    reasonText,
    searchTerm,
} from '../../../core/validation/common.schemas';
import { clearable } from '../../../core/validation/zod.helpers';
import { AUDIT_ACTION_NAMES, AuditAction } from '../../audit/domain/audit.catalog';
import { AUDIT_STATUSES } from '../../audit/domain/audit.types';

/** Request shapes for `/api/v1/users`. */

export const UserIdParamSchema = idParam('userId', 'user');

/**
 * jovi-mall's role vocabulary, pinned.
 *
 * `admin` is deliberately absent. Since the Phase 0.5 patch no `users` row can hold that
 * role — `auth.schemas.ts` refuses it on both register and add-role — so offering it as a
 * filter would advertise a search that can only ever return nothing, and offering it as a
 * *value* anywhere would suggest this surface can mint one.
 */
export const USER_ROLES = ['vendor', 'agency', 'agent', 'customer'] as const;
export type UserRoleName = (typeof USER_ROLES)[number];

export const USER_STATUSES = ['active', 'suspended'] as const;

/**
 * What this list may be ordered by: **wire name → `jovi_mall` field path**.
 *
 * Read by the schema below (as the allowlist) and by `UserReadRepository` (as the
 * translation), so a field can never be sortable-but-untranslatable or vice versa. The
 * snake_case on the right is jovi-mall's schema; the camelCase on the left is this API's —
 * the map is the only place the two meet.
 *
 * Every entry is backed by an index: `created_at` and `updated_at` by the compound
 * `{ status, roles, created_at }` the model declares, `login_email` by its own sparse
 * unique index. That is the rule for adding one — a sortable field with no index is a
 * collection scan a client can request by query string.
 */
export const USER_SORT = {
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    email: 'login_email',
} as const;

/**
 * How far back a single page of the directory may reach.
 *
 * `users` is the largest people-collection on the platform and a `created_at` range is
 * the one filter here that can turn into an unbounded scan (ADR-005 D-14). A year covers
 * any cohort question an administrator actually asks from a list screen.
 */
export const USER_MAX_RANGE_DAYS = 366;

export const SearchUsersQuerySchema = listQuery(USER_SORT, '-createdAt', {
    /**
     * Matches an email, a phone number, or — when the term is itself a 24-hex id — the
     * user id. The last case is what makes a support conversation work: an id copied out
     * of an order, a ticket or an audit row is pasted into the one box on the screen and
     * finds the person, instead of returning nothing and looking broken.
     */
    search: searchTerm.optional(),
    role: z.enum(USER_ROLES).optional(),
    status: z.enum(USER_STATUSES).optional(),
    ...dateRangeFields(),
}).superRefine(dateRangeRule({ maxDays: USER_MAX_RANGE_DAYS }));

/**
 * A contact edit. Both identifiers are clearable — `''`/`null` removes one.
 *
 * ── Why the FORMAT is not validated here ──────────────────────────────────────
 * jovi-mall owns the login identifiers, and it already holds one definition of what each
 * one may be: `core/validation/{email,phone}.ts`, an RFC 5322 dot-atom rule and a strict
 * E.164 rule, both normalising transforms, both used by every platform write path. A copy
 * of those regexes here would be a second definition of a rule this service does not own,
 * and the failure mode of drift is silent — an address accepted at this door that every
 * later edit by its owner would refuse.
 *
 * So this schema validates SHAPE (present, trimmed, bounded, and at least one field sent)
 * and delegates FORMAT. A malformed address comes back from jovi-mall as a 400 carrying
 * its own message and `details.platformCode`, at the same status — which is exactly what
 * `platformRequest`'s error mapping exists for.
 *
 * The bounds are RFC 5321's, and they are here rather than there for one reason only:
 * an unbounded string should not be forwarded over the wire at all.
 */
export const UpdateUserSchema = z
    .object({
        email: clearable(z.string().trim().min(3).max(254)),
        phone: clearable(z.string().trim().min(4).max(24)),
    })
    .strict()
    .refine((body) => body.email !== undefined || body.phone !== undefined, {
        message: 'Nothing to update — send `email`, `phone`, or both',
    });

export const SuspendUserSchema = z.object({
    reason: reasonText('A reason is required to suspend an account'),
});

/**
 * Sending somebody a way back into their own account.
 *
 * ── `channel` is a pinned enum ───────────────────────────────────────────────
 * An unrecognised value is a 400, never a silent fallback to email. A fallback would send
 * a credential to an address the operator did not choose, on a request they believed had
 * failed — which is the one outcome worse than a refusal here.
 *
 * ── There is deliberately no destination field ───────────────────────────────
 * The address is read from the party's own record. An operator who could type one could
 * mail a working credential for somebody else's account to themselves, and no permission
 * short of withholding the endpoint entirely would stop it. `.strict()` makes an attempt
 * to send one a 400 rather than a silently ignored key.
 *
 * ── `reason` is required ─────────────────────────────────────────────────────
 * This is an administrator acting on somebody else's ability to sign in, without their
 * knowledge and without their asking. The audit row needs a why, and the person on the
 * other end may later need to be told one.
 */
export const SendCredentialSchema = z
    .object({
        channel: z.enum(['email', 'whatsapp', 'telegram']),
        reason: reasonText('A reason is required to send someone a credential'),
    })
    .strict();

/**
 * The activity feed's query — the audit list, narrowed to one user.
 *
 * A deliberate subset of `ListAuditQuerySchema`: no `targetType`/`targetId` (the path
 * fixes both), no `actorId` (an account's history is not filtered by who acted), and no
 * `search` (there is one subject, so a text search over actor names is not the question
 * this screen asks). What remains is the chronology plus the two filters that make a long
 * history readable.
 */
export const USER_ACTIVITY_SORT = { occurredAt: 'occurred_at' } as const;

/**
 * The actions that can appear in a user's history, DERIVED from the audit catalog rather
 * than typed out.
 *
 * A hand-written list is the drift that `audit.types.ts` documents at length: jovi-mall
 * kept two copies of its agent notification types, they diverged, and eight situations
 * silently stopped being delivered. Adding a fourth `users.*` action should widen this
 * filter automatically or the dashboard cannot filter on the row it is already showing.
 */
export const USER_AUDIT_ACTIONS = AUDIT_ACTION_NAMES.filter((action) =>
    action.startsWith('users.'),
) as [AuditAction, ...AuditAction[]];

export const ListUserActivityQuerySchema = listQuery(USER_ACTIVITY_SORT, '-occurredAt', {
    action: z.enum(USER_AUDIT_ACTIONS).optional(),
    status: z.enum(AUDIT_STATUSES as unknown as [string, ...string[]]).optional(),
    ...dateRangeFields(),
}).superRefine(dateRangeRule({ maxDays: USER_MAX_RANGE_DAYS }));

export type SearchUsersQuery = z.infer<typeof SearchUsersQuerySchema>;
export type UpdateUserBody = z.infer<typeof UpdateUserSchema>;
export type SuspendUserBody = z.infer<typeof SuspendUserSchema>;
export type SendCredentialBody = z.infer<typeof SendCredentialSchema>;
export type ListUserActivityQuery = z.infer<typeof ListUserActivityQuerySchema>;
