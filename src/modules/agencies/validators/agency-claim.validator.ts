import { z } from 'zod';
import { paginationFields } from '../../../core/http/list-query';
import { idParam, objectId, reasonText } from '../../../core/validation/common.schemas';

/**
 * Damage claims on an agency (owner decision F-8, 2026-10-22) — the wi-admin side of jovi-mall's
 * `/api/internal/admin/agency-claims`. Bounds mirror jovi-mall's strict schemas, so a body this
 * accepts is never a wrapped 400 there.
 */

/** `POST /api/v1/agency-claims` */
export const ChargeAgencyClaimSchema = z
    .object({
        shipmentId: objectId,
        /** How many items were damaged in delivery. */
        itemCount: z.number().int().min(1).max(1000),
        /** What is claimed, whole XAF; ≤ the agency's max refund per item × itemCount (jovi-mall refuses above). */
        amount: z.number().int().positive(),
        /** What was damaged and how it was established — read by the next administrator. */
        note: reasonText('Say what was damaged and how it was established', { min: 3, max: 1000 }),
        /** The refund this claim follows, when there is one. */
        refundRequestId: objectId.optional(),
    })
    .strict();

/** `GET /api/v1/agency-claims/eligibility` */
export const AgencyClaimEligibilityQuerySchema = z
    .object({ shipmentId: objectId, refundRequestId: objectId.optional() })
    .strict();

/** `GET /api/v1/agency-claims` */
export const ListAgencyClaimsQuerySchema = z
    .object({
        ...paginationFields,
        agencyId: objectId.optional(),
        vendorId: objectId.optional(),
        shipmentId: objectId.optional(),
    })
    .strict();

export const AgencyClaimIdParamSchema = idParam('claimId', 'damage claim').strict();

export type ChargeAgencyClaimBody = z.infer<typeof ChargeAgencyClaimSchema>;
export type AgencyClaimEligibilityQuery = z.infer<typeof AgencyClaimEligibilityQuerySchema>;
export type ListAgencyClaimsQuery = z.infer<typeof ListAgencyClaimsQuerySchema>;
