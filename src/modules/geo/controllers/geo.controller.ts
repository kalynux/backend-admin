import { Request, Response } from 'express';
import { asyncHandler } from '../../../core/http/async-handler';
import { sendSuccess } from '../../../core/http/responses';
import { requireAdminIdentity } from '../../admin-identity/domain/admin-identity.types';
import { reverseGeocode, searchAddresses } from '../gateways/geo.gateway';
import { GeoReverseQuery, GeoSearchQuery } from '../validators/geo.validator';

/**
 * `/api/v1/geo` — turning what somebody typed into a storable address.
 *
 * The client's workflow is the platform's standard one, and it is two calls: search here,
 * show the candidates, then post the SELECTED candidate verbatim to whichever record is being
 * edited. The candidate is stored as-is, which is what makes a stored address traceable back
 * to the provider that resolved it.
 */
export class GeoController {
    /**
     * GET /api/v1/geo/search?q=&limit=&country=&lang=
     *
     * Answers `{ provider, query, results[] }` — jovi-mall's shape, forwarded rather than
     * reshaped. Reshaping it here would mean the candidate a client receives is not the
     * candidate the storing schema expects, and the two would have to be kept in step by
     * hand across a service boundary.
     */
    static search = asyncHandler(async (req: Request, res: Response) => {
        const admin = requireAdminIdentity(req);
        const query = req.query as unknown as GeoSearchQuery;

        const data = await searchAddresses(
            { q: query.q, limit: query.limit, country: query.country, lang: query.lang },
            admin,
            req.requestId,
        );

        sendSuccess(res, data);
    });

    /**
     * GET /api/v1/geo/reverse?lat=&lng=
     *
     * `result` may legitimately be `null` — a coordinate in the middle of nowhere has no
     * address, and that is an answer rather than a failure. Clients must render the null case
     * rather than treating it as an error.
     */
    static reverse = asyncHandler(async (req: Request, res: Response) => {
        const admin = requireAdminIdentity(req);
        const { lat, lng } = req.query as unknown as GeoReverseQuery;

        sendSuccess(res, await reverseGeocode(lat, lng, admin, req.requestId));
    });
}
