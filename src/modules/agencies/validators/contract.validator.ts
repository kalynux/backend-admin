import { z } from 'zod';
import { idParam, reasonText } from '../../../core/validation/common.schemas';

/** `/api/v1/contracts/:contractId`. */
export const ContractIdParamSchema = idParam('contractId', 'contract');

/**
 * The body every administrative intervention carries.
 *
 * `reason` is required on all three verbs, including reinstate — and that is deliberate
 * even though jovi-mall has no column to store a reinstatement reason. This is somebody
 * outside the relationship acting on it, so the audit row has to answer "why" for both
 * directions; a reinstatement with no explanation is exactly as hard to review as a
 * suspension with none. The reason lives in the audit trail, which is append-only and is
 * the durable record of an administrator's intervention anyway.
 *
 * `.strict()` so a client sending `terms` or `codThreshold` here gets a 400 rather than a
 * silent no-op. Those are the writes this surface deliberately refuses, and a request that
 * looks like it changed a fee split must never come back 200 having changed nothing.
 */
export const ContractReasonSchema = z
    .object({
        reason: reasonText('A reason is required'),
    })
    .strict();

export type ContractReasonBody = z.infer<typeof ContractReasonSchema>;
