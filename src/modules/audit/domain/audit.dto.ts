import { IAuditLog } from '../models/audit-log.model';
import { IAuditExport } from '../models/audit-export.model';
import { AUDIT_CATALOG, isAuditAction } from './audit.catalog';

/**
 * What the audit trail looks like on the wire.
 *
 * camelCase, `id` not `_id`, ISO-8601 UTC strings, absent data as `null` and never
 * omitted, arrays as `[]` — ADR-005 D-8, D-14, D-15, D-16. Built by naming fields, never
 * by spreading a document: the row carries `payload`, `before` and `after`, and a spread
 * would put all three on a list response that has no business showing them.
 */

export interface AuditEntryDto {
    id: string;
    occurredAt: string;
    completedAt: string | null;
    correlationId: string;

    action: string;
    /** The catalog's one-line description, so a feed reads without a lookup table. */
    actionSummary: string | null;
    actionFamily: string;
    status: string;
    sensitive: boolean;

    actor: {
        kind: string;
        id: string | null;
        email: string | null;
        displayName: string | null;
        /** The level held AT THE TIME, not the level now. */
        tier: number | null;
        sessionId: string | null;
    };

    target: {
        type: string;
        id: string | null;
        label: string | null;
        subjectClass: string;
    };

    relatedTarget: { type: string; id: string | null } | null;

    request: {
        method: string;
        path: string;
        ip: string | null;
        userAgent: string | null;
    };

    outcome: {
        code: string | null;
        statusCode: number | null;
        message: string | null;
        denialKind: string | null;
        requiredPermissions: string[];
        platformCode: string | null;
    };

    viaApprovalId: string | null;
    delegated: boolean;

    exportedAt: string | null;
    /** When this row becomes eligible for deletion. Null until it has been exported. */
    purgeAfter: string | null;
}

/** The detail view adds the state the list deliberately omits. */
export interface AuditEntryDetailDto extends AuditEntryDto {
    payload: Record<string, unknown> | null;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    /** True when a value was too large to store and was replaced by a summary. */
    stateTruncated: boolean;
}

export function toAuditEntryDto(row: IAuditLog): AuditEntryDto {
    return {
        id: row._id.toString(),
        occurredAt: row.occurred_at.toISOString(),
        completedAt: row.completed_at?.toISOString() ?? null,
        correlationId: row.correlation_id,

        action: row.action,
        actionSummary: isAuditAction(row.action) ? AUDIT_CATALOG[row.action].summary : null,
        actionFamily: row.action_family,
        status: row.status,
        sensitive: row.sensitive,

        actor: {
            kind: row.actor_kind,
            id: row.actor_id?.toString() ?? null,
            email: row.actor_email,
            displayName: row.actor_display_name,
            tier: row.actor_tier,
            sessionId: row.session_id,
        },

        target: {
            type: row.target_type,
            id: row.target_id,
            label: row.target_label,
            subjectClass: row.subject_class,
        },

        relatedTarget: row.related_target_type
            ? { type: row.related_target_type, id: row.related_target_id }
            : null,

        request: {
            method: row.method,
            path: row.path,
            ip: row.ip,
            userAgent: row.user_agent,
        },

        outcome: {
            code: row.outcome_code,
            statusCode: row.outcome_status,
            message: row.outcome_message,
            denialKind: row.denial_kind,
            requiredPermissions: row.required_permissions ?? [],
            platformCode: row.platform_code,
        },

        viaApprovalId: row.via_approval_id?.toString() ?? null,
        delegated: row.delegated,

        exportedAt: row.exported_at?.toISOString() ?? null,
        purgeAfter: row.purge_after?.toISOString() ?? null,
    };
}

/**
 * The detail view.
 *
 * `payload`/`before`/`after` appear ONLY here. A feed is a feed — putting the state on
 * every list row would multiply the response size by the largest change in the page, and
 * a list is scanned rather than read.
 */
export function toAuditEntryDetailDto(row: IAuditLog): AuditEntryDetailDto {
    return {
        ...toAuditEntryDto(row),
        payload: row.payload,
        before: row.before,
        after: row.after,
        stateTruncated: row.state_truncated,
    };
}

export interface AuditExportDto {
    id: string;
    status: string;
    source: string;
    requestedBy: string | null;
    requestedByName: string | null;
    rangeFrom: string | null;
    rangeTo: string | null;
    fileName: string | null;
    byteSize: number | null;
    rowCount: number | null;
    sha256: string | null;
    retentionDays: number;
    startedAt: string;
    completedAt: string | null;
    stampedAt: string | null;
    stampedCount: number | null;
    purgedAt: string | null;
    purgedCount: number | null;
    failureReason: string | null;
    /** True once the file is durable and its rows may be stamped or purged. */
    downloadable: boolean;
}

export function toAuditExportDto(row: IAuditExport): AuditExportDto {
    return {
        id: row._id.toString(),
        status: row.status,
        source: row.source,
        requestedBy: row.requested_by?.toString() ?? null,
        requestedByName: row.requested_by_name,
        rangeFrom: row.range_from?.toISOString() ?? null,
        rangeTo: row.range_to?.toISOString() ?? null,
        // The path is deliberately NOT exposed — a server filesystem path is nothing a
        // dashboard can use and something an attacker can.
        fileName: row.file_name,
        byteSize: row.byte_size,
        rowCount: row.row_count,
        sha256: row.sha256,
        retentionDays: row.retention_days,
        startedAt: row.started_at.toISOString(),
        completedAt: row.completed_at?.toISOString() ?? null,
        stampedAt: row.stamped_at?.toISOString() ?? null,
        stampedCount: row.stamped_count,
        purgedAt: row.purged_at?.toISOString() ?? null,
        purgedCount: row.purged_count,
        failureReason: row.failure_reason,
        downloadable: row.status === 'complete' && Boolean(row.file_path),
    };
}
