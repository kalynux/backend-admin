import { FilterQuery, Types } from 'mongoose';
import { matchAnyField, toMongoSort } from '../../../core/data/mongo-list';
import { toPageMeta } from '../../../core/http/list-query';
import { PaginationMeta } from '../../../core/http/responses';
import { AdminIdentity } from '../../admin-identity/domain/admin-identity.types';
import { AuditLogModel, IAuditLog } from '../models/audit-log.model';
import { auditScopeFilter, combineFilters } from '../domain/audit-subject';
import { AUDIT_SORT, ListAuditQuery } from '../validators/audit.validator';

/**
 * Reading `admin_audit_log`.
 *
 * ── The filter is assembled HERE, never in a controller ──────────────────────
 * The same rule `user.read.repository.ts` states: "a filter assembled at the query layer
 * is one nobody can forget to apply." It matters more here than anywhere else in the
 * service, because the filter this layer adds is the tier-3 read scope — forget it once
 * and a Support administrator reads the administrator directory.
 */

export interface AuditPage {
    items: IAuditLog[];
    meta: PaginationMeta;
}

export class AuditRepository {
    /**
     * A page of the trail, scoped to the caller.
     *
     * ⚠️ **The one line in this module most likely to be got wrong.** The tier-3 scope is
     * an `$or`, and `matchAnyField` also returns an `$or`. The idiom used elsewhere in
     * this service —
     *
     *     Object.assign(filter, matchAnyField(...))     // ← WRONG here
     *
     * would overwrite the scope's `$or` with the search's, handing a Support administrator
     * the entire administrator directory the moment they typed anything into a search box.
     * `combineFilters` composes them under `$and` instead; `test-audit.ts` asserts it.
     */
    async search(query: ListAuditQuery, viewer: AdminIdentity): Promise<AuditPage> {
        const filter = combineFilters(
            auditScopeFilter(viewer.tier, viewer.adminId),
            buildQueryFilter(query),
            query.search
                ? matchAnyField(['actor_email', 'actor_display_name', 'target_label'], query.search)
                : null,
        ) as FilterQuery<IAuditLog>;

        const [items, total] = await Promise.all([
            AuditLogModel()
                .find(filter)
                .sort(toMongoSort(query.sort, AUDIT_SORT))
                .skip((query.page - 1) * query.limit)
                .limit(query.limit),
            AuditLogModel().countDocuments(filter),
        ]);

        return { items, meta: toPageMeta(total, query.page, query.limit) };
    }

    /**
     * One row, still scoped.
     *
     * Returns null rather than throwing on an out-of-scope row, so the controller answers
     * 404 — a 403 on a specific id would confirm the row exists, which is an existence
     * oracle over exactly the rows the scope exists to hide.
     */
    async findById(auditId: string, viewer: AdminIdentity): Promise<IAuditLog | null> {
        if (!Types.ObjectId.isValid(auditId)) return null;

        const filter = combineFilters(
            auditScopeFilter(viewer.tier, viewer.adminId),
            { _id: new Types.ObjectId(auditId) },
        ) as FilterQuery<IAuditLog>;

        return AuditLogModel().findOne(filter);
    }

    /**
     * What this administrator DID — the actor feed.
     *
     * One of the two questions the trail answers, and the reason every row carries an
     * actor AND a target. Scoped like any other read, so a Support administrator asking
     * for their own activity gets it, and asking for someone else's gets only the
     * platform-facing part of it.
     */
    async searchByActor(
        adminId: string,
        query: ListAuditQuery,
        viewer: AdminIdentity,
    ): Promise<AuditPage> {
        return this.search({ ...query, actorId: adminId }, viewer);
    }

    /**
     * What was done TO this administrator — the target feed, i.e. the account's history.
     *
     * `$or` across the target and the RELATED target: an action that went through
     * four-eyes has the approval as its target and the administrator as its related one,
     * so without the second branch an account history would silently omit every
     * dual-controlled change — the most consequential ones.
     */
    async searchByTarget(
        adminId: string,
        query: ListAuditQuery,
        viewer: AdminIdentity,
    ): Promise<AuditPage> {
        const targeted = {
            $or: [
                { target_type: 'administrator', target_id: adminId },
                { related_target_type: 'administrator', related_target_id: adminId },
            ],
        };

        const filter = combineFilters(
            auditScopeFilter(viewer.tier, viewer.adminId),
            buildQueryFilter(query),
            targeted,
        ) as FilterQuery<IAuditLog>;

        const [items, total] = await Promise.all([
            AuditLogModel()
                .find(filter)
                .sort(toMongoSort(query.sort, AUDIT_SORT))
                .skip((query.page - 1) * query.limit)
                .limit(query.limit),
            AuditLogModel().countDocuments(filter),
        ]);

        return { items, meta: toPageMeta(total, query.page, query.limit) };
    }

    /** The oldest row still held, so a feed can explain why it stops. */
    async oldestRetainedAt(): Promise<Date | null> {
        const oldest = await AuditLogModel().findOne().sort({ occurred_at: 1 }).select('occurred_at');
        return oldest?.occurred_at ?? null;
    }

    /**
     * Rows still at `attempted` past the dangling window.
     *
     * An action this service started somewhere it could not transact with, whose outcome
     * never came back. ADR-002 D4-a calls this "itself a useful signal" — each one is
     * resolved by grepping the other service for the row's `correlation_id`.
     */
    async findDanglingIntents(cutoff: Date, limit = 100): Promise<IAuditLog[]> {
        return AuditLogModel()
            .find({ status: 'attempted', occurred_at: { $lt: cutoff } })
            .sort({ occurred_at: 1 })
            .limit(limit);
    }
}

/**
 * The caller's own filters — never the scope, which `search` adds separately so it cannot
 * be lost in a refactor of this function.
 */
function buildQueryFilter(query: ListAuditQuery): Record<string, unknown> {
    const filter: Record<string, unknown> = {};

    if (query.actorId) filter.actor_id = new Types.ObjectId(query.actorId);
    if (query.action) filter.action = query.action;
    if (query.actionFamily) filter.action_family = query.actionFamily;
    if (query.status) filter.status = query.status;
    if (query.targetType) filter.target_type = query.targetType;
    if (query.targetId) filter.target_id = query.targetId;
    if (query.correlationId) filter.correlation_id = query.correlationId;
    if (query.sensitiveOnly === true) filter.sensitive = true;

    // Half-open `[from, to)` — see `dateRangeFields`. Consecutive ranges tile exactly and
    // no row is counted twice at a boundary.
    if (query.from || query.to) {
        const range: Record<string, Date> = {};
        if (query.from) range.$gte = query.from;
        if (query.to) range.$lt = query.to;
        filter.occurred_at = range;
    }

    return filter;
}
