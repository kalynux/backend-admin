import { ILegacyAdminAction } from '../repositories/legacy-action.read.repository';

/**
 * The wire shape of a legacy admin action.
 *
 * ── Deliberately NOT `AuditEntryDto` ──────────────────────────────────────────
 * A legacy row has no `AuditAction`, no `subject_class` and no `sensitive` flag, because
 * jovi-mall's middleware knows none of wi-admin's vocabulary. Forcing it into the real DTO
 * would mean either lying about those fields or filling them with nulls that a dashboard
 * would then have to special-case — and either way a reader could no longer tell a
 * compliance row from a stop-gap one at a glance.
 *
 * So it is its own shape, and every item says where it came from.
 */
export interface LegacyActionDto {
    id: string;
    occurredAt: string;
    correlationId: string;

    /** Always `'jovi-mall-legacy'`. Present on every item, not just in `meta`. */
    source: 'jovi-mall-legacy';
    /** `request` = the coarse per-request row; `service` = a specific action a service named. */
    kind: 'request' | 'service';

    actor: {
        /**
         * `platform_admin` — a jovi-mall `users` row with `role: 'admin'`.
         *
         * NOT a wi-admin administrator, and the label says so. Those are two identity
         * spaces: a wi-admin administrator holds no `users` row at all (ADR-004 D-1), and
         * mapping one id onto the other is impossible. Inventing a mapping is exactly the
         * lie an audit trail exists to prevent, so the DTO keeps them visibly distinct.
         */
        kind: 'platform_admin' | 'platform_user' | 'anonymous';
        label: string;
        userId: string | null;
        role: string | null;
        name: string | null;
        ip: string | null;
        userAgent: string | null;
    };

    request: {
        method: string;
        path: string;
        statusCode: number | null;
        durationMs: number | null;
    };

    /** Null on a `request` row — the middleware records what was called, not what it meant. */
    action: string | null;
    resource: { type: string; id: string } | null;

    /** Ids and pagination from the URL. Never a request body value. */
    params: Record<string, unknown> | null;
    query: Record<string, unknown> | null;
    /** KEY NAMES ONLY — jovi-mall never stores the values. */
    bodyKeys: string[];
    /** The redacted diff, on `service` rows only. */
    changes: Record<string, unknown> | null;
}

const ACTOR_LABEL: Record<string, string> = {
    platform_admin_user: 'Legacy admin session (jovi-mall)',
    platform_user: 'Platform user (jovi-mall)',
    anonymous: 'Unauthenticated',
};

export function toLegacyActionDto(row: ILegacyAdminAction): LegacyActionDto {
    return {
        id: String(row._id),
        occurredAt: row.occurred_at.toISOString(),
        correlationId: row.correlation_id,

        source: 'jovi-mall-legacy',
        kind: row.source,

        actor: {
            kind: row.actor_kind === 'platform_admin_user'
                ? 'platform_admin'
                : row.actor_kind === 'platform_user' ? 'platform_user' : 'anonymous',
            // Rendered here rather than in the dashboard, so a client cannot accidentally
            // present this row as a wi-admin administrator's action.
            label: ACTOR_LABEL[row.actor_kind] ?? 'Unknown',
            userId: row.actor_user_id ? String(row.actor_user_id) : null,
            role: row.actor_role,
            name: row.actor_name,
            ip: row.ip,
            userAgent: row.user_agent,
        },

        request: {
            method: row.method,
            path: row.path,
            statusCode: row.status_code,
            durationMs: row.duration_ms,
        },

        action: row.action,
        resource: row.resource_type && row.resource_id
            ? { type: row.resource_type, id: row.resource_id }
            : null,

        params: row.params,
        query: row.query,
        bodyKeys: row.body_keys ?? [],
        changes: row.changes,
    };
}
