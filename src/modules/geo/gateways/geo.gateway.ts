import { platformRequest } from '../../../infra/platform/platform.client';
import { AdminIdentity } from '../../admin-identity/domain/admin-identity.types';

/**
 * ─── Address search, delegated to jovi-mall ──────────────────────────────────
 *
 * ── Why this is delegated when ADR-004 D-2 says to read records directly ─────
 * It does not read a record. Geocoding is a call to a THIRD PARTY — Geoapify, LocationIQ or
 * Nominatim — and the thing being delegated is not data but a provider configuration: a chain
 * order, two API keys, a cache, a language default and a set of failover rules that
 * deliberately do not fail over on a 401.
 *
 * Reproducing that here would mean a second copy of all of it, and — worse — a second spender
 * on one free-tier quota with nothing anywhere adding the two together. That is the exact
 * hazard `CLAUDE.md` records about the Geoapify and LocationIQ keys, where the symptom lands
 * in a different service from the cause. One geocoder, one chain, one quota, one place to
 * change the provider.
 *
 * ── ⚠ Nothing here is cached on this side, deliberately ─────────────────────
 * jovi-mall's geocoding layer already has a cache (`geocoding.cache.ts`). A second cache in
 * front of it would serve stale candidates with a `provider_place_id` the first cache had
 * already replaced, and the two would disagree about a result's freshness with no way to tell
 * which was right. Staff address entry is a handful of calls a month; there is nothing here to
 * optimise.
 */

export interface GeoCandidate {
    /** Provider's canonical one-line address. */
    formatted_address: string;
    coordinates: { type: 'Point'; coordinates: [number, number] };
    provider: string;
    provider_place_id: string | null;
    components: Record<string, string | null>;
    [field: string]: unknown;
}

export interface GeoSearchResult {
    provider: string;
    query: string;
    results: GeoCandidate[];
}

export interface GeoReverseResult {
    provider: string;
    result: GeoCandidate | null;
}

export interface GeoSearchParams {
    q: string;
    limit?: number;
    country?: string;
    lang?: string;
}

/**
 * Free-form text to ranked candidates.
 *
 * ⚠ **Not audited, and that is the ADR-006 D-5 line rather than an omission.** A read is not
 * audited unless it discloses something the permission exists to protect — the one exception
 * on this service being a payout destination. This discloses a public gazetteer to a caller
 * who typed the query: the answer contains nothing about the platform, nothing about a person,
 * and nothing this service holds. The request log already records that it happened.
 *
 * What IS recorded is the address the administrator finally stores, by the audited write that
 * stores it. That is where the fact lives, and it is the fact worth having.
 */
export async function searchAddresses(
    params: GeoSearchParams,
    actor: AdminIdentity,
    requestId: string,
): Promise<GeoSearchResult> {
    const { data } = await platformRequest<GeoSearchResult>({
        method: 'get',
        path: '/geo/search',
        query: {
            q: params.q,
            ...(params.limit !== undefined ? { limit: params.limit } : {}),
            ...(params.country ? { country: params.country } : {}),
            ...(params.lang ? { lang: params.lang } : {}),
        },
        actor,
        requestId,
    });
    return data;
}

/** A coordinate to its best-matching address, or `result: null` when the provider has none. */
export async function reverseGeocode(
    lat: number,
    lng: number,
    actor: AdminIdentity,
    requestId: string,
): Promise<GeoReverseResult> {
    const { data } = await platformRequest<GeoReverseResult>({
        method: 'get',
        path: '/geo/reverse',
        query: { lat, lng },
        actor,
        requestId,
    });
    return data;
}
