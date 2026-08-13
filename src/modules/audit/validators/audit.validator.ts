import { z } from 'zod';
import { listQuery } from '../../../core/http/list-query';
import {
    boolFlag,
    dateRangeFields,
    dateRangeRule,
    idParam,
    objectId,
    searchTerm,
} from '../../../core/validation/common.schemas';
import { PERMISSION_FAMILIES } from '../../authorization/domain/permission.types';
import { AUDIT_ACTION_NAMES } from '../domain/audit.catalog';
import { AUDIT_STATUSES, AUDIT_TARGET_TYPES } from '../domain/audit.types';

/** Request shapes for `/api/v1/audit`. */

export const AuditIdParamSchema = idParam('auditId', 'audit entry');
export const ExportIdParamSchema = idParam('exportId', 'export');

/**
 * Wire name → column. Only one key: an audit feed is a chronology, and offering a sort by
 * actor or action would invite full-collection scans on the largest table in `wi-admin`
 * for an ordering nobody reads a trail in. Filter by those instead.
 */
export const AUDIT_SORT = { occurredAt: 'occurred_at' } as const;

/**
 * The maximum span of a single query, in days.
 *
 * `admin_audit_log` becomes the largest collection in this database, and an unbounded
 * range is a scan an administrator can point at production by accident (ADR-005 D-14).
 * A quarter covers every review anyone actually runs; anything wider is an export.
 */
export const AUDIT_MAX_RANGE_DAYS = 92;

export const ListAuditQuerySchema = listQuery(AUDIT_SORT, '-occurredAt', {
    actorId: objectId.optional(),
    // Pinned enums: all three vocabularies are ours (ADR-005 D-17), so a typo is a 400
    // naming the valid values rather than a filter that silently matches nothing.
    action: z.enum(AUDIT_ACTION_NAMES).optional(),
    actionFamily: z.enum(PERMISSION_FAMILIES as unknown as [string, ...string[]]).optional(),
    status: z.enum(AUDIT_STATUSES as unknown as [string, ...string[]]).optional(),
    targetType: z.enum(AUDIT_TARGET_TYPES as unknown as [string, ...string[]]).optional(),
    /** Not `objectId`: a target may be a session UUID or a composite key. */
    targetId: z.string().trim().min(1).max(128).optional(),
    correlationId: z.string().trim().min(1).max(128).optional(),
    /** Money, escalation, destructive and four-eyes rows only. */
    sensitiveOnly: boolFlag.optional(),
    search: searchTerm.optional(),
    ...dateRangeFields(),
}).superRefine(dateRangeRule({ maxDays: AUDIT_MAX_RANGE_DAYS }));

/**
 * An export's range.
 *
 * `from`/`to` are REQUIRED here, unlike the feed's. An export with no range means "the
 * whole collection", and the API path is bounded by row count — asking for it there is
 * almost always a mistake rather than an intention. The CLI takes an open range.
 */
export const CreateExportSchema = z
    .object({
        from: dateRangeFields().from,
        to: dateRangeFields().to,
    })
    .superRefine((body, ctx) => {
        if (!body.from || !body.to) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: [body.from ? 'to' : 'from'],
                message: 'An export needs both `from` and `to`. Use the CLI for an open-ended export.',
            });
            return;
        }
        dateRangeRule()(body, ctx);
    });

export const ListExportsQuerySchema = listQuery(
    { startedAt: 'started_at' } as const,
    '-startedAt',
    {},
);

export type ListAuditQuery = z.infer<typeof ListAuditQuerySchema>;
export type CreateExportBody = z.infer<typeof CreateExportSchema>;
export type ListExportsQuery = z.infer<typeof ListExportsQuerySchema>;
