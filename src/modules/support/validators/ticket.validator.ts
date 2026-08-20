import { z } from 'zod';
import { listQuery } from '../../../core/http/list-query';
import {
    dateRangeFields,
    dateRangeRule,
    idParam,
    objectId,
    searchTerm,
} from '../../../core/validation/common.schemas';
import { ADMIN_TIERS } from '../../admin-identity/domain/admin-identity.types';

/** Request shapes for `/api/v1/support/tickets`. */

export const TicketIdParamSchema = idParam('ticketId', 'support ticket');

export const TicketFollowerParamSchema = z.object({
    ticketId: objectId,
    userId: objectId,
}).strict();

export const AttachmentIdParamSchema = idParam('attachmentId', 'ticket attachment');

/**
 * What this list may be ordered by: **wire name → `jovi_mall` field path**.
 *
 * Read by the schema below as the allowlist and by `TicketReadRepository` as the
 * translation, so a field can never be sortable-but-untranslatable.
 *
 * `assignedAt` is deliberately absent. It lives inside `admin_assignment`, which is null for
 * every unassigned ticket — and an unassigned ticket is not a rare edge here but the entire
 * pool, including every system ticket the payout, dispute and booking-refund paths raise.
 * Sorting a list whose commonest state has no value for the sort key puts the queue in an
 * order nobody can predict.
 */
export const TICKET_SORT = {
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
    status: 'status',
    priority: 'priority',
} as const;

/** How far back one page of the queue may reach (ADR-005 D-14). */
export const TICKET_MAX_RANGE_DAYS = 366;

/**
 * `status`, `type`, `priority` and `importance` are **bounded strings, not pinned enums**.
 *
 * ADR-005 D-17: a vocabulary this service does not own gets validated for shape, not for
 * membership. jovi-mall's ticket type list alone has **39** values and grows with the
 * product; copying it here would create a second list that goes stale silently, and the
 * failure mode of drift is a filter that matches nothing while looking correct.
 *
 * Contrast `AGENCY_STATUSES`, which IS pinned — that is a three-value enum this service also
 * writes against. Nothing here writes a status directly; the transitions are jovi-mall's.
 */
const vocabulary = z.string().trim().min(1).max(60);

export const SearchTicketsQuerySchema = listQuery(TICKET_SORT, '-createdAt', {
    /** Matches the subject, or — when the term is a 24-hex id — the ticket id. */
    search: searchTerm.optional(),
    status: vocabulary.optional(),
    type: vocabulary.optional(),
    priority: vocabulary.optional(),
    importance: vocabulary.optional(),
    entityType: vocabulary.optional(),
    entityId: z.string().trim().min(1).max(120).optional(),

    /**
     * Narrow to one administrator's queue, the unclaimed pool, or everything the caller may
     * see.
     *
     * This filters INSIDE the caller's scope and can never widen it — `mine` is a
     * convenience, not a permission, and `all` still means "all that D-3 allows you". A
     * request for somebody else's queue is not expressible here at all, which is why there is
     * no `assignedTo` parameter: the scope decides that, and a parameter that could contradict
     * it would be the one place the two disagree.
     */
    queue: z.enum(['all', 'mine', 'unassigned']).default('all'),

    ...dateRangeFields(),
}).superRefine(dateRangeRule({ maxDays: TICKET_MAX_RANGE_DAYS }));

/**
 * One administrator, as this service sends them to jovi-mall.
 *
 * The mirror of jovi-mall's own `AdminSnapshotSchema`, and the two must stay in step — there
 * is no shared package, and jovi-mall's copy is `.strict()`, so a field added on one side
 * only produces a 400 rather than a silent drop. `test-support.ts` asserts this shape against
 * the jovi-mall source.
 *
 * ⚠ Not a request schema. Nothing a client sends is parsed by this: the snapshot is built
 * from wi-admin's OWN `admin_accounts` record, because the whole reason it exists is that
 * jovi-mall cannot look an administrator up. A client-supplied name and tier would be a
 * client deciding who is handling a ticket and at what privilege.
 */
export const AdminSnapshotShape = z.object({
    id: objectId,
    source: z.literal('admin'),
    name: z.string().min(1).max(200),
    tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    job_title: z.string().max(120).nullable(),
    department: z.string().max(120).nullable(),
    avatar_url: z.string().max(2048).nullable(),
}).strict();

export type AdminSnapshotPayload = z.infer<typeof AdminSnapshotShape>;

/**
 * Handing a ticket to another administrator.
 *
 * The body names the TARGET only. Who is assigning is the authenticated caller, and taking
 * it from the body instead would let an administrator record somebody else as the assigner —
 * which matters here beyond bookkeeping, because the Tier 2 rule keys on the assigner's tier.
 *
 * `tier` is not in the body either: it is read from the target's `admin_accounts` row. A
 * client-supplied tier would decide, through `alsoTiers`, who may subsequently see the
 * ticket.
 */
export const AssignTicketSchema = z.object({
    administratorId: objectId,
}).strict();

/** Claiming an unassigned ticket for yourself. No body — the caller IS the target. */
export const ClaimTicketSchema = z.object({}).strict();

export const UpdateTicketSchema = z.object({
    subject: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().min(1).max(700).optional(),
}).strict().refine(
    (body) => Object.keys(body).length > 0,
    { message: 'Give at least one field to change' },
);

export const UpdateStatusSchema = z.object({ status: vocabulary }).strict();
export const UpdatePrioritySchema = z.object({ priority: vocabulary }).strict();

/** Closing and reopening take no body — the act is the whole statement. */
export const LifecycleSchema = z.object({}).strict();

export const AddFollowerSchema = z.object({
    userId: objectId,
    role: z.enum(['vendor', 'customer', 'agency', 'agent']),
}).strict();

/**
 * An internal note. `isPublic` defaults to FALSE, and the default is the safety property:
 * these are staff notes on somebody's support ticket, and the failure direction of a missing
 * flag must be "the customer does not see it".
 *
 * ⚠ **The flag only became true of the stored note in Phase 4, step 21.** jovi-mall calls it
 * `visibility` and its schema is non-strict, so `isPublic` was dropped in transit and every
 * note filed `'public'`. The translation now happens in `ticket.gateway.ts`; this schema is
 * unchanged in shape, and `test-support.ts` asserts both halves.
 *
 * `content` is capped at **300**, which is jovi-mall's own limit rather than a number chosen
 * here. It was 2000, so a 301–2000 character note passed this validator and came back as a
 * `PLATFORM_OPERATION_REJECTED` naming a limit no wi-admin document mentioned. A boundary
 * that accepts what the next hop refuses is not validating, it is deferring.
 */
export const CreateNoteSchema = z.object({
    content: z.string().trim().min(1).max(300),
    isPublic: z.boolean().default(false),
}).strict();

export const AttachFileSchema = z.object({
    fileId: objectId,
}).strict();

export const ListNotesQuerySchema = z.object({}).strict();

/** The reference lookups backing the ticket-creation form. */
export const ReferenceQuerySchema = z.object({
    search: searchTerm.optional(),
}).strict();

export const CreateTicketSchema = z.object({
    subject: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(700),
    type: vocabulary,
    importance: vocabulary,
    entityType: vocabulary,
    entityId: z.string().trim().min(1).max(120).optional(),
    trackingNumber: z.string().trim().min(1).max(120).optional(),
    attachments: z.array(objectId).max(5).optional(),
}).strict();

export type SearchTicketsQuery = z.infer<typeof SearchTicketsQuerySchema>;
export type AssignTicketBody = z.infer<typeof AssignTicketSchema>;
export type UpdateTicketBody = z.infer<typeof UpdateTicketSchema>;
export type UpdateStatusBody = z.infer<typeof UpdateStatusSchema>;
export type UpdatePriorityBody = z.infer<typeof UpdatePrioritySchema>;
export type AddFollowerBody = z.infer<typeof AddFollowerSchema>;
export type CreateNoteBody = z.infer<typeof CreateNoteSchema>;
export type AttachFileBody = z.infer<typeof AttachFileSchema>;
export type CreateTicketBody = z.infer<typeof CreateTicketSchema>;

/** Exported so the test can assert the tier union covers exactly the real tiers. */
export const SNAPSHOT_TIERS = ADMIN_TIERS;
