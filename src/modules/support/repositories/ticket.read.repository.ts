import { Document, Filter, ObjectId } from 'mongodb';
import { containsInsensitive, toMongoSort } from '../../../core/data/mongo-list';
import { COLLECTIONS } from '../../../infra/platform/collections';
import { Paginated, PlatformReadRepository } from '../../../infra/platform/platform.repository';
import { ResourceScope } from '../../authorization/domain/resource-scope';
import { SearchTicketsQuery, TICKET_SORT } from '../validators/ticket.validator';

/**
 * Reading support tickets straight out of `jovi_mall`.
 *
 * ── Why this domain reads directly ────────────────────────────────────────────
 * ADR-009 D-1, generalised at ADR-011 D-1: **delegate a read whose answer is a verdict the
 * platform acts on; read directly a read whose answer is a record.** A ticket, a note, a
 * follower row and an attachment are all records. There is no verdict on this surface.
 *
 * Every WRITE is delegated, and the reason here is concrete rather than precautionary:
 * jovi-mall creates tickets in-process from the payout, dispute and booking-refund paths, and
 * every ticket write publishes on its in-process event bus. A second writer would move the row
 * and notify nobody. `PlatformReadRepository` has no write method, so that is not something
 * this file could break by accident.
 *
 * ── The scope is a FILTER, and that is the security property ──────────────────
 * `resource-scope.ts:20-29` is explicit: a scope folded into the query is one nobody can
 * forget, and a record outside it is **not found** rather than found-and-refused. So a Support
 * administrator asking for an Admin's ticket gets a 404, not a 403 — a 403 confirms the record
 * exists, which is exactly what somebody probing for another tier's queue wants to learn.
 *
 * Every read method here takes the scope as a REQUIRED parameter for that reason. It cannot be
 * defaulted, and there is no unscoped variant to reach for.
 */

export interface AdminSnapshotRead extends Document {
    id: string;
    source: 'platform' | 'admin';
    name: string;
    tier: 1 | 2 | 3;
    job_title?: string | null;
    department?: string | null;
    avatar_url?: string | null;
}

export interface TicketReadModel extends Document {
    _id: ObjectId;
    subject: string;
    description?: string;
    type: string;
    status: string;
    priority: string;
    importance: string;
    priority_locked?: boolean;
    entity_type: string;
    entity_id: string;
    tracking_number?: string | null;
    created_by_role: string;
    created_by_user_id?: ObjectId | null;
    created_by_admin?: AdminSnapshotRead | null;
    assigned_to_role?: string | null;
    assigned_to_user_id?: ObjectId | null;
    admin_assignment?: {
        admin: AdminSnapshotRead;
        assigned_by?: AdminSnapshotRead | null;
        assigned_at: Date;
    } | null;
    terminalAt?: Date | null;
    createdAt: Date;
    updatedAt: Date;
}

/**
 * The list whitelist.
 *
 * `description` is deliberately absent from the list: it is up to 700 characters of
 * customer-written free text, and a hundred of them is a payload nobody's queue screen
 * renders. The detail projection adds it.
 *
 * A whitelist rather than an exclusion list, for the reason every projection in this service
 * is one: an exclusion protects only what somebody thought of, so a field added to `tickets`
 * next year would arrive here automatically.
 */
const TICKET_LIST_PROJECTION = {
    _id: 1,
    subject: 1,
    type: 1,
    status: 1,
    priority: 1,
    importance: 1,
    priority_locked: 1,
    entity_type: 1,
    entity_id: 1,
    tracking_number: 1,
    created_by_role: 1,
    created_by_user_id: 1,
    created_by_admin: 1,
    assigned_to_role: 1,
    assigned_to_user_id: 1,
    admin_assignment: 1,
    terminalAt: 1,
    createdAt: 1,
    updatedAt: 1,
} as const;

const TICKET_DETAIL_PROJECTION = {
    ...TICKET_LIST_PROJECTION,
    description: 1,
} as const;

/**
 * The scope, as a Mongo clause.
 *
 * This is the single most load-bearing function in the module: it is what makes D-3 true of
 * the data rather than true of a controller somebody remembered to write.
 *
 * ── Why `null` and `$exists: false` are BOTH matched ──────────────────────────
 * `admin_assignment` defaults to `null` on new documents, but every ticket written before the
 * field existed has no such path at all — and `{ 'admin_assignment.admin.id': null }` matches
 * both while `{ admin_assignment: null }` matches only the first. Unassigned is the pool, the
 * pool is where every system ticket starts, and a filter that missed the older half would
 * quietly hide most of the queue.
 */
export function scopeFilter(scope: ResourceScope): Filter<TicketReadModel> {
    switch (scope.kind) {
        case 'all':
            return {};

        case 'none':
            // Deliberately unsatisfiable rather than throwing: a caller with no scope should
            // read an empty list, not an error that tells them a scope decision was made.
            return { _id: { $in: [] } };

        case 'assigned': {
            const clauses: Filter<TicketReadModel>[] = [
                { 'admin_assignment.admin.id': { $in: [...scope.adminIds] } },
            ];

            if (scope.includeUnassigned) {
                clauses.push({ 'admin_assignment.admin.id': null });
            }

            if (scope.alsoTiers.length > 0) {
                clauses.push({ 'admin_assignment.admin.tier': { $in: [...scope.alsoTiers] } });
            }

            return { $or: clauses };
        }

        case 'own_or_platform_subject':
            // Not answerable for a ticket — that variant describes audit rows, which have no
            // assignee. Fail closed rather than guess, matching `isTicketInScope`.
            return { _id: { $in: [] } };
    }
}

export class TicketReadRepository extends PlatformReadRepository<TicketReadModel> {
    constructor() {
        super(COLLECTIONS.TICKET, TICKET_LIST_PROJECTION);
    }

    async search(query: SearchTicketsQuery, scope: ResourceScope, callerId: string): Promise<Paginated<TicketReadModel>> {
        const filter: Filter<TicketReadModel> = {
            deletedAt: null,
            ...scopeFilter(scope),
        };

        if (query.status) filter.status = query.status;
        if (query.type) filter.type = query.type;
        if (query.priority) filter.priority = query.priority;
        if (query.importance) filter.importance = query.importance;
        if (query.entityType) filter.entity_type = query.entityType;
        if (query.entityId) filter.entity_id = query.entityId;

        /**
         * `queue` narrows INSIDE the scope and can never widen it — it is `$and`-ed with the
         * scope clause above rather than replacing it. `mine` and `unassigned` are both
         * already subsets of every scope this service produces, so the intersection is the
         * point: an Admin asking for `unassigned` gets the pool, and a Support administrator
         * asking for the same gets the same pool, because the pool is in both scopes.
         */
        if (query.queue === 'mine') {
            filter['admin_assignment.admin.id'] = callerId;
        } else if (query.queue === 'unassigned') {
            filter['admin_assignment.admin.id'] = null;
        }

        if (query.search) {
            // A 24-hex term is an id, not a subject fragment. Checked first because an
            // unanchored regex over `subject` cannot use an index and an id lookup can.
            if (/^[a-f\d]{24}$/i.test(query.search)) {
                filter._id = new ObjectId(query.search);
            } else {
                filter.subject = containsInsensitive(query.search) as never;
            }
        }

        if (query.from || query.to) {
            filter.createdAt = {
                ...(query.from ? { $gte: new Date(query.from) } : {}),
                ...(query.to ? { $lte: new Date(query.to) } : {}),
            } as never;
        }

        return this.findPage(filter, {
            page: query.page,
            limit: query.limit,
            sort: toMongoSort(query.sort, TICKET_SORT),
        });
    }

    /**
     * One ticket, scoped.
     *
     * The scope is in the FILTER rather than checked after the read, so a ticket outside it
     * is indistinguishable from one that does not exist. That is the 404-not-403 rule, and it
     * only holds if no caller can reach an unscoped variant — which is why none exists.
     */
    async findScoped(ticketId: string, scope: ResourceScope): Promise<TicketReadModel | null> {
        const found = await this.collection().findOne(
            { _id: new ObjectId(ticketId), deletedAt: null, ...scopeFilter(scope) } as Filter<TicketReadModel>,
            { projection: TICKET_DETAIL_PROJECTION },
        );
        return (found as TicketReadModel | null) ?? null;
    }
}

/**
 * The one field of an attachment this service reads: which ticket owns it.
 *
 * ── Why a whole repository for a single id ────────────────────────────────────
 * `DELETE /tickets/attachments/:attachmentId` is keyed on the ATTACHMENT, matching
 * jovi-mall's route, so the ticket's scope cannot be applied until the ticket is known.
 * This is the read that makes it known — and the moment it exists, the delete goes through
 * the same `loadScoped` + `assertMayAct` pair as every other write on the surface, rather
 * than through a second copy of the scope rule.
 *
 * ── Why the projection is two fields ──────────────────────────────────────────
 * An attachment row carries `file_name`, `mime_type`, `uploaded_by_user_id`, and a
 * `visible_to_user_ids` list. None of it is needed to answer "whose ticket is this", and
 * an attachment on a ticket the caller may not see is precisely the row whose metadata must
 * not leave the database. `{_id, ticket_id}` is the whole answer.
 */
export interface TicketAttachmentOwnerRead extends Document {
    _id: ObjectId;
    ticket_id: ObjectId;
}

const ATTACHMENT_OWNER_PROJECTION = {
    _id: 1,
    ticket_id: 1,
} as const;

export class TicketAttachmentReadRepository extends PlatformReadRepository<TicketAttachmentOwnerRead> {
    constructor() {
        super(COLLECTIONS.TICKET_ATTACHMENT, ATTACHMENT_OWNER_PROJECTION);
    }

    /**
     * The owning ticket's id, or null when no such attachment exists.
     *
     * Deliberately **unscoped**, and that is safe only because of what the caller does next:
     * it returns an id, never a record, and the id is immediately fed to `findScoped`, which
     * is where the scope is applied. A caller that used this answer for anything else would
     * be reintroducing the hole this closes.
     *
     * jovi-mall hard-deletes attachments (`ticket-attachment.service.ts:208`), so there is no
     * `deletedAt` to filter — unlike `tickets`, which is soft-deleted.
     */
    async findTicketIdByAttachment(attachmentId: string): Promise<string | null> {
        const found = await this.findOneBy({ _id: new ObjectId(attachmentId) } as Filter<TicketAttachmentOwnerRead>);
        return found?.ticket_id ? found.ticket_id.toString() : null;
    }
}
