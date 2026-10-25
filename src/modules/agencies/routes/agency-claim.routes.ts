import { Router } from 'express';
import { defineRoute, permission, records } from '../../../api/route-manifest';
import { AgencyClaimController } from '../controllers/agency-claim.controller';
import {
    AgencyClaimEligibilityQuerySchema,
    AgencyClaimIdParamSchema,
    ChargeAgencyClaimSchema,
    ListAgencyClaimsQuerySchema,
} from '../validators/agency-claim.validator';

/**
 * `/api/v1/agency-claims` — damage claims on an agency (owner decision F-8, 2026-10-22).
 *
 * A claim is allowed only inside the agency's OWN window (its damage-claim deadline, counted
 * from its parcel's delivery) and up to its OWN max refund per item; it charges the agency (never
 * its rider) and credits the vendor, and the agency reads the explanation on its earnings screen.
 *
 * READS under `agencies.read` (Support answers "why was this agency charged"); the CHARGE under
 * `agencies.claims.charge`, `financial` — it moves an agency's money — so it is granted by name in
 * the tier-2 money block and refused to Support at boot, like `agencies.cod.restrict`.
 *
 * Its own prefix rather than `/agencies/claims`: every `/agencies/<literal>` must be declared
 * above `/:agencyId`, and a claim is filed by PARCEL, not by agency.
 */
const router = Router();
const mountedAt = '/agency-claims';

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/',
    access: permission('agencies.read'),
    validate: { query: ListAgencyClaimsQuerySchema },
    handler: AgencyClaimController.list,
});

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/eligibility',
    access: permission('agencies.read'),
    validate: { query: AgencyClaimEligibilityQuerySchema },
    handler: AgencyClaimController.eligibility,
});

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/:claimId',
    access: permission('agencies.read'),
    validate: { params: AgencyClaimIdParamSchema },
    handler: AgencyClaimController.get,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/',
    access: permission('agencies.claims.charge'),
    validate: { body: ChargeAgencyClaimSchema },
    audit: records('agencies.claims.charge'),
    handler: AgencyClaimController.charge,
});

export const agencyClaimRoutes = router;
