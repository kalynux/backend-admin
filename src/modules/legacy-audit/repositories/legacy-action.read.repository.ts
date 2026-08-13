import { Document, Filter } from 'mongodb';
import { COLLECTIONS } from '../../../infra/platform/collections';
import { PlatformReadRepository } from '../../../infra/platform/platform.repository';
import { PaginationMeta } from '../../../core/http/responses';
import { toPageMeta } from '../../../core/http/list-query';
import { AdminTier } from '../../admin-identity/domain/admin-identity.types';
import { legacyScopeFilter } from '../domain/legacy-scope';

/**
 * The interim admin-action record, read out of `jovi_mall`.
 *
 * ── Why a direct read and not an ingest ───────────────────────────────────────
 * ADR-004 D-2 already sanctions reading `jovi_mall` directly, and this is the ordinary case:
 * append-only rows with no invariant to protect. The alternative — jovi-mall POSTing rows
 * into `admin_audit_log` — would invert the dependency direction AND create a way to author
 * audit rows over HTTP, which is the one thing the real trail's design forbids.
 */
export interface ILegacyAdminAction extends Document {
    _id: unknown;
    occurred_at: Date;
    correlation_id: string;
    source: 'request' | 'service';
    stream: string;
    actor_kind: string;
    actor_user_id: unknown;
    actor_role: string | null;
    actor_name: string | null;
    ip: string | null;
    user_agent: string | null;
    method: string;
    path: string;
    status_code: number | null;
    duration_ms: number | null;
    action: string | null;
    resource_type: string | null;
    resource_id: string | null;
    params: Record<string, unknown> | null;
    query: Record<string, unknown> | null;
    body_keys: string[];
    changes: Record<string, unknown> | null;
}

export interface LegacyActionQuery {
    page: number;
    limit: number;
    actorUserId?: string;
    action?: string;
    resourceType?: string;
    source?: 'request' | 'service';
    from?: Date;
    to?: Date;
}

export class LegacyActionReadRepository extends PlatformReadRepository<ILegacyAdminAction> {
    constructor() {
        /**
         * The projection names every field, as the base class requires.
         *
         * `body_keys` is included and is safe by construction — jovi-mall stores key NAMES
         * only, never values. `changes` is included because on a `source: 'service'` row it
         * is the hand-authored, redacted diff that makes the row worth reading; on a
         * `source: 'request'` row it is always null.
         */
        super(COLLECTIONS.ADMIN_ACTION_LOG, {
            occurred_at: 1, correlation_id: 1, source: 1, stream: 1,
            actor_kind: 1, actor_user_id: 1, actor_role: 1, actor_name: 1,
            ip: 1, user_agent: 1,
            method: 1, path: 1, status_code: 1, duration_ms: 1,
            action: 1, resource_type: 1, resource_id: 1,
            params: 1, query: 1, body_keys: 1, changes: 1,
        });
    }

    async search(
        query: LegacyActionQuery,
        viewerTier: AdminTier,
    ): Promise<{ items: ILegacyAdminAction[]; meta: PaginationMeta }> {
        const filter = buildFilter(query, viewerTier);

        const [items, total] = await Promise.all([
            this.collection()
                .find(filter, { projection: this.projection })
                // `_id` as the tiebreaker so a page boundary is stable when two rows share
                // a millisecond — the same rule the real audit feed follows.
                .sort({ occurred_at: -1, _id: -1 })
                .skip((query.page - 1) * query.limit)
                .limit(query.limit)
                .toArray() as Promise<ILegacyAdminAction[]>,
            this.collection().countDocuments(filter),
        ]);

        return {
            items,
            meta: toPageMeta(total, query.page, query.limit),
        };
    }
}

/**
 * The scope clause and the search clause are combined under `$and`, never merged.
 *
 * ADR-006 D-4 calls the equivalent line in the real repository "the single most dangerous
 * line in the module": the scope is an `$or`, and `Object.assign`-ing another `$or` on top
 * silently REPLACES it. The same trap exists here, so the same shape avoids it.
 */
function buildFilter(query: LegacyActionQuery, viewerTier: AdminTier): Filter<ILegacyAdminAction> {
    const clauses: Filter<ILegacyAdminAction>[] = [];

    const scope = legacyScopeFilter(viewerTier);
    if (scope) clauses.push(scope as Filter<ILegacyAdminAction>);

    if (query.actorUserId) clauses.push({ actor_user_id: query.actorUserId } as Filter<ILegacyAdminAction>);
    if (query.action) clauses.push({ action: query.action } as Filter<ILegacyAdminAction>);
    if (query.resourceType) clauses.push({ resource_type: query.resourceType } as Filter<ILegacyAdminAction>);
    if (query.source) clauses.push({ source: query.source } as Filter<ILegacyAdminAction>);

    if (query.from || query.to) {
        const range: Record<string, Date> = {};
        if (query.from) range.$gte = query.from;
        if (query.to) range.$lt = query.to;
        clauses.push({ occurred_at: range } as Filter<ILegacyAdminAction>);
    }

    if (clauses.length === 0) return {};
    if (clauses.length === 1) return clauses[0];
    return { $and: clauses };
}
