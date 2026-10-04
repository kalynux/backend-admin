import { Document, Filter, ObjectId } from 'mongodb';
import { Types } from 'mongoose';
import { COLLECTIONS } from '../../../infra/platform/collections';
import { PlatformReadRepository } from '../../../infra/platform/platform.repository';

/**
 * jovi-mall's `role_closure_requests` (its ADR-A10), read directly.
 *
 * The rule of this service: reads go straight to `jovi_mall`, writes are delegated. The
 * writes here are the administrator's request and cancel (delegated, audited) and the
 * user's confirm or decline (jovi-mall, under the user's own session) — so this row is the
 * only place an administrator can see how the user answered.
 */
export interface RoleClosureRequestReadModel extends Document {
    _id: ObjectId;
    user_id: ObjectId;
    role: 'customer' | 'vendor' | 'agency' | 'agent';
    role_entity_id: ObjectId;
    status: 'pending' | 'confirmed' | 'declined' | 'cancelled' | 'expired';
    reason: string;
    requested_by_user_id: ObjectId;
    requested_by_name?: string | null;
    requested_at: Date;
    expires_at: Date;
    warnings?: { code: string; planCode?: string; expiresAt?: Date; amount?: number }[];
    resolved_at?: Date | null;
    resolved_by_user_id?: ObjectId | null;
    resolved_by_source?: 'platform' | 'admin';
    resolved_by_name?: string | null;
    decline_note?: string | null;
    outcome?: { closed_at: Date; account_closed: boolean; ended_relationships: number } | null;
    created_at: Date;
}

const PROJECTION = {
    _id: 1, user_id: 1, role: 1, role_entity_id: 1, status: 1, reason: 1,
    requested_by_user_id: 1, requested_by_name: 1, requested_at: 1, expires_at: 1, warnings: 1,
    resolved_at: 1, resolved_by_user_id: 1, resolved_by_source: 1, resolved_by_name: 1,
    decline_note: 1, outcome: 1, created_at: 1,
};

export class RoleClosureReadRepository extends PlatformReadRepository<RoleClosureRequestReadModel> {
    constructor() {
        super(COLLECTIONS.ROLE_CLOSURE_REQUEST, PROJECTION);
    }

    /** Newest first; a user collects a handful in a lifetime, so one page of 50 is all. */
    async listForUser(userId: string): Promise<RoleClosureRequestReadModel[]> {
        if (!Types.ObjectId.isValid(userId)) return [];
        const page = await this.findPage({ user_id: new ObjectId(userId) } as Filter<RoleClosureRequestReadModel>, {
            page: 1,
            limit: 50,
            sort: { created_at: -1, _id: -1 },
        });
        return page.items;
    }
}

/**
 * The wire shape — the same one jovi-mall's delegated writes answer with, so a screen renders
 * the list and a just-created request with one component.
 *
 * `status` is EFFECTIVE: expiry is lazy upstream, so a stored `pending` past its expiry is
 * reported `expired` here exactly as jovi-mall's DTO does.
 */
export function toRoleClosureDto(row: RoleClosureRequestReadModel, now: Date = new Date()) {
    const status = row.status === 'pending' && row.expires_at.getTime() <= now.getTime() ? 'expired' : row.status;
    return {
        id: row._id.toHexString(),
        userId: row.user_id.toHexString(),
        role: row.role,
        roleEntityId: row.role_entity_id.toHexString(),
        status,
        reason: row.reason,
        requestedBy: { id: row.requested_by_user_id.toHexString(), name: row.requested_by_name ?? null },
        requestedAt: row.requested_at.toISOString(),
        expiresAt: row.expires_at.toISOString(),
        warnings: (row.warnings ?? []).map((w) => ({
            code: w.code,
            planCode: w.planCode ?? null,
            expiresAt: w.expiresAt ? new Date(w.expiresAt).toISOString() : null,
            amount: w.amount ?? null,
        })),
        resolvedAt: row.resolved_at ? row.resolved_at.toISOString() : null,
        resolvedBy: row.resolved_by_user_id
            ? { id: row.resolved_by_user_id.toHexString(), source: row.resolved_by_source ?? 'platform', name: row.resolved_by_name ?? null }
            : null,
        declineNote: row.decline_note ?? null,
        outcome: row.outcome
            ? {
                closedAt: row.outcome.closed_at.toISOString(),
                accountClosed: row.outcome.account_closed,
                endedRelationships: row.outcome.ended_relationships,
            }
            : null,
    };
}
