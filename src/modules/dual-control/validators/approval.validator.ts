import { z } from 'zod';
import { paginationFields } from '../../../core/http/list-query';
import { idParam } from '../../../core/validation/common.schemas';
import { APPROVAL_STATUSES } from '../models/approval-request.model';

/**
 * Request shapes for `/api/v1/approvals`.
 *
 * `validate()` REPLACES the request member with the parsed value, so coercion and
 * defaults below reach the controller — `page` arrives as a number, not the string Express
 * put there.
 */

export const ApprovalIdParamSchema = idParam('approvalId', 'approval');

export const ListApprovalsQuerySchema = z.object({
    // Defaults to the pending queue: the overwhelmingly common read is "what is waiting
    // for me", and making that the default keeps the dashboard's polling call trivial.
    status: z.enum(APPROVAL_STATUSES as unknown as [string, ...string[]]).default('pending'),
    action: z.string().min(1).optional(),
    /**
     * NOT `objectId`: an approval's target is whatever the queued action operates on, and
     * a future dual-controlled action may key on something that is not a Mongo id.
     */
    targetId: z.string().min(1).optional(),
    ...paginationFields,
});

export const DecisionBodySchema = z.object({
    /**
     * Why. Optional, but this is the field a later audit review actually reads — an
     * approval with no note is a signature with no reason.
     */
    note: z.string().trim().min(1).max(500).optional(),
});

export type ListApprovalsQuery = z.infer<typeof ListApprovalsQuerySchema>;
export type DecisionBody = z.infer<typeof DecisionBodySchema>;
