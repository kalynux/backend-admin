import { z } from 'zod';

/**
 * Query validation for address search.
 *
 * ⚠ **Mirrors jovi-mall's `modules/geo/validators/geo.validator.ts` field for field**, and it
 * has to: this service forwards the parsed values to that endpoint, so a rule that is looser
 * here produces a request jovi-mall refuses with a 400 the administrator cannot act on, and a
 * rule that is tighter here silently removes a capability the platform has.
 *
 * ⚠ `country` is forwarded as the CSV STRING, not as the parsed array jovi-mall's own schema
 * transforms it into. The gateway puts it on the query string, and jovi-mall parses it there
 * — splitting it here and re-joining it would be two transformations that must agree.
 */
export const GeoSearchQuerySchema = z.object({
    /** Free-form address text the user typed. */
    q: z.string().trim().min(1, 'Search query is required').max(300),
    /** Max candidates (1–20). The provider applies its own default when omitted. */
    limit: z.coerce.number().int().min(1).max(20).optional(),
    /** Comma-separated ISO-3166-1 alpha-2 codes to bias results, e.g. `cm,ng`. */
    country: z
        .string()
        .trim()
        .regex(/^[a-zA-Z]{2}(,[a-zA-Z]{2})*$/, 'Use comma-separated two-letter country codes')
        .optional(),
    /** Preferred result language (BCP-47, e.g. `fr`). */
    lang: z.string().trim().max(10).optional(),
});

export type GeoSearchQuery = z.infer<typeof GeoSearchQuerySchema>;

export const GeoReverseQuerySchema = z.object({
    lat: z.coerce.number().min(-90).max(90),
    lng: z.coerce.number().min(-180).max(180),
});

export type GeoReverseQuery = z.infer<typeof GeoReverseQuerySchema>;
