import { Router } from 'express';
import { defineRoute, selfService } from '../../../api/route-manifest';
import { GeoController } from '../controllers/geo.controller';
import { GeoReverseQuerySchema, GeoSearchQuerySchema } from '../validators/geo.validator';

/**
 * `/api/v1/geo` — address search for every form on the dashboard that stores a place.
 *
 * ── ⚠ Why `selfService` and not a permission ────────────────────────────────
 * `selfService` means "authenticated, and no permission, because the route acts on the
 * caller's own identity". This route acts on no identity at all, which is a stronger case for
 * the same verdict: it reads a public gazetteer through a third-party geocoder and touches no
 * platform data, no administrator record and no person. There is no subject to grade by, so a
 * permission would have to be invented — and an invented permission is one somebody later
 * grants to a tier for the wrong reason.
 *
 * The alternative considered was `geo.search`, granted to every tier. That is the same
 * authorization outcome expressed as a name that implies a policy exists. `selfService` with a
 * reason is the honest form, and it is what `/permissions/me` and `/permissions/catalog`
 * already do for the same argument.
 *
 * ── ⚠ It IS on the onboarding allowlist, and it has to be ───────────────────
 * A pending administrator cannot finish their employee record without a geocoded home address,
 * and they cannot geocode one without this. It is safe there for exactly the reason above:
 * there is nothing on this route a person who has not been activated should not see.
 *
 * ── Not audited ─────────────────────────────────────────────────────────────
 * A read is audited only when the disclosure IS the action (ADR-006 D-5, and the one exception
 * on this service is a payout destination). The address an administrator actually stores is
 * recorded by the audited write that stores it. See the gateway.
 */
const router = Router();
const mountedAt = '/geo';

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/search',
    access: selfService('Address search reads a public gazetteer — no platform data, no subject to grade'),
    validate: { query: GeoSearchQuerySchema },
    handler: GeoController.search,
});

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/reverse',
    access: selfService('Reverse geocoding reads a public gazetteer — no platform data, no subject to grade'),
    validate: { query: GeoReverseQuerySchema },
    handler: GeoController.reverse,
});

export const geoRoutes = router;
