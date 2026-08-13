import { z } from 'zod';
import { paginationFields } from '../../../core/http/list-query';

/**
 * The legacy feed's query.
 *
 * Narrower than the real audit query on purpose. `action` is a free string here rather than
 * a pinned `z.enum` — jovi-mall's verbs (`DELIVERY_AGENCY_DEACTIVATED`) are its own
 * vocabulary, not `AUDIT_CATALOG`'s, and pinning them would mean maintaining a second closed
 * list for a surface that is being deleted.
 *
 * There is no `search` parameter, deliberately. The real feed's is what makes ADR-006 D-4's
 * `combineFilters` load-bearing — an `$or` search clause silently overwriting the `$or`
 * scope clause — and this feed has no need for one: every field worth filtering on is an
 * exact match. Not offering it removes the trap rather than defusing it.
 */
export const ListLegacyActionsQuerySchema = z.object({
    ...paginationFields,
    actorUserId: z.string().trim().length(24).optional(),
    action: z.string().trim().min(1).max(100).optional(),
    resourceType: z.string().trim().min(1).max(60).optional(),
    source: z.enum(['request', 'service']).optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
});

export type ListLegacyActionsQuery = z.infer<typeof ListLegacyActionsQuerySchema>;
