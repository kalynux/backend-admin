import { Request, Response } from 'express';
import { actorContextOf } from '../../audit/domain/audit-context';
import { asyncHandler } from '../../../core/http/async-handler';
import { createAppError } from '../../../core/errors/app-error';
import { ERROR_CODES } from '../../../core/errors/error-codes';
import { sendCreated, sendSuccess } from '../../../core/http/responses';
import * as gateway from '../gateways/agency-claim.gateway';
import { AgencyReadRepository } from '../repositories/agency.read.repository';
import {
    AgencyClaimEligibilityQuery,
    ChargeAgencyClaimBody,
    ListAgencyClaimsQuery,
} from '../validators/agency-claim.validator';

const agencies = new AgencyReadRepository();

/**
 * Damage claims on an agency (owner decision F-8, 2026-10-22). Every route delegates to
 * jovi-mall (see `gateways/agency-claim.gateway.ts` for why the reads do too); the charge is
 * audited fail-closed against the agency. Contract: `api-doc/api/agency-claims.md`.
 */
export class AgencyClaimController {
    /** GET /api/v1/agency-claims — newest first, optionally one agency's, vendor's or parcel's. */
    static list = asyncHandler(async (req: Request, res: Response) => {
        const query = req.query as unknown as ListAgencyClaimsQuery;
        const page = await gateway.listAgencyClaims(query, actorContextOf(req));
        sendSuccess(res, page.data, { meta: { ...page.meta } });
    });

    /**
     * GET /api/v1/agency-claims/eligibility?shipmentId=&refundRequestId= — whether a claim on this
     * parcel is possible, and its limits (the agency's window, its per-item limit, its fee).
     */
    static eligibility = asyncHandler(async (req: Request, res: Response) => {
        const query = req.query as unknown as AgencyClaimEligibilityQuery;
        sendSuccess(res, await gateway.agencyClaimEligibility(query, actorContextOf(req)));
    });

    /** GET /api/v1/agency-claims/:claimId */
    static get = asyncHandler(async (req: Request, res: Response) => {
        sendSuccess(res, await gateway.agencyClaim(req.params.claimId, actorContextOf(req)));
    });

    /**
     * POST /api/v1/agency-claims — charge the agency for a parcel damaged in delivery. **201** with
     * the claim. The eligibility is read first: it is the audit row's `before`, it names the agency
     * the row is filed against, and it 404s an unknown parcel before any audit intent is written.
     */
    static charge = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as ChargeAgencyClaimBody;
        const context = actorContextOf(req);
        const eligibility = await gateway.agencyClaimEligibility(
            { shipmentId: body.shipmentId, refundRequestId: body.refundRequestId },
            context,
        );
        if (!eligibility.agencyId) {
            throw createAppError(ERROR_CODES.NOT_FOUND, 404, 'This parcel has no delivery agency to charge');
        }
        const agency = await agencies.findById(eligibility.agencyId);
        const label = (agency as { businessName?: string } | null)?.businessName ?? null;
        const claim = await gateway.chargeAgencyClaim(body, eligibility, label, context);
        sendCreated(res, claim, { message: 'Damage claim charged to the agency' });
    });
}
