import { Schema } from 'mongoose';
import { z } from 'zod';

/**
 * ─── GeoAddress, as wi-admin stores it ───────────────────────────────────────
 *
 * The platform's canonical geocoded-address value object: a human-readable address paired
 * with the geospatial data the provider returned, so nothing relies on plain text for
 * mapping.
 *
 * ── ⚠ A DELIBERATE COPY of jovi-mall's `core/types/geo-address.types.ts` ─────
 * Copied for the reason `storage-trees.ts` and the payout shape are: there is no shared
 * package, and this shape has to exist on both sides. It is a value object with no behaviour
 * beyond validation.
 *
 * ── The WIRE shape is the contract, and it is why this must not drift ────────
 * The client does not invent a `GeoAddress`. It calls `GET /api/v1/geo/search` — which wi-admin
 * delegates to jovi-mall's geocoder, the SAME provider chain every other address on the
 * platform is resolved by — picks a candidate, and posts it back here to be stored. So the
 * fields below are jovi-mall's candidate shape, and a divergence would mean a candidate this
 * service produced could not be stored by the service that produced it.
 *
 * ⚠ **`provider` is an append-only enum.** It is persisted on every stored row, so removing a
 * name orphans every address already carrying it. Adding one is free. There is deliberately
 * no `'chain'` value even though a deployment may run the chained provider: a stored row must
 * record which SERVICE resolved the address, because that is what makes `provider_place_id`
 * resolvable later. A row saying "chain" would name the plumbing and lose the fact.
 */

export const GEO_PROVIDERS = [
    'nominatim', 'google', 'mapbox', 'here', 'geoapify', 'locationiq',
] as const;

export type GeoProviderName = (typeof GEO_PROVIDERS)[number];

// ─── Mongoose ────────────────────────────────────────────────────────────────

/** GeoJSON Point. `[longitude, latitude]` — in that order, which is the usual mistake. */
const GeoPointSchema = new Schema(
    {
        type: { type: String, enum: ['Point'], required: true, default: 'Point' },
        coordinates: {
            type: [Number],
            required: true,
            validate: {
                validator: (value: number[]) => Array.isArray(value) && value.length === 2,
                message: 'coordinates must be [longitude, latitude]',
            },
        },
    },
    { _id: false },
);

/** All parts nullable — provider coverage varies, and rural Cameroon rarely has a postcode. */
const GeoAddressComponentsSchema = new Schema(
    {
        street: { type: String, default: null, trim: true },
        neighbourhood: { type: String, default: null, trim: true },
        city: { type: String, default: null, trim: true },
        region: { type: String, default: null, trim: true },
        country: { type: String, default: null, trim: true },
        country_code: { type: String, default: null, trim: true, uppercase: true },
        postal_code: { type: String, default: null, trim: true },
    },
    { _id: false },
);

export const GeoAddressSchema = new Schema(
    {
        formatted_address: { type: String, required: true, trim: true },
        coordinates: { type: GeoPointSchema, required: true },
        provider: { type: String, enum: GEO_PROVIDERS, required: true },
        provider_place_id: { type: String, default: null, trim: true },
        components: { type: GeoAddressComponentsSchema, required: true, default: () => ({}) },
        /** The free-form text the user typed before selecting this result. */
        raw_input: { type: String, default: null, trim: true },
        resolved_at: { type: Date, required: true, default: Date.now },
    },
    { _id: false },
);

// ─── TypeScript ──────────────────────────────────────────────────────────────

export interface IGeoPoint {
    type: 'Point';
    coordinates: [number, number];
}

export interface IGeoAddressComponents {
    street: string | null;
    neighbourhood: string | null;
    city: string | null;
    region: string | null;
    country: string | null;
    country_code: string | null;
    postal_code: string | null;
}

export interface IGeoAddress {
    formatted_address: string;
    coordinates: IGeoPoint;
    provider: GeoProviderName;
    provider_place_id: string | null;
    components: IGeoAddressComponents;
    raw_input: string | null;
    resolved_at: Date;
}

// ─── Zod ─────────────────────────────────────────────────────────────────────

const GeoPointZodSchema = z.object({
    type: z.literal('Point').default('Point'),
    coordinates: z
        .tuple([
            z.number().min(-180).max(180), // longitude FIRST — GeoJSON order
            z.number().min(-90).max(90),
        ]),
});

const GeoAddressComponentsZodSchema = z.object({
    street: z.string().trim().nullable().optional().default(null),
    neighbourhood: z.string().trim().nullable().optional().default(null),
    city: z.string().trim().nullable().optional().default(null),
    region: z.string().trim().nullable().optional().default(null),
    country: z.string().trim().nullable().optional().default(null),
    country_code: z.string().trim().toUpperCase().nullable().optional().default(null),
    postal_code: z.string().trim().nullable().optional().default(null),
});

/**
 * A geocoding result the client selected and is sending back to store.
 *
 * ⚠ **`resolved_at` is stamped SERVER-SIDE and any client value is ignored.** It records when
 * the address was geocoded, and a client-supplied timestamp is a claim about a provider call
 * this service did not observe. Everything else is the candidate verbatim.
 */
export const GeoAddressZodSchema = z
    .object({
        formatted_address: z.string().trim().min(1, 'A formatted address is required'),
        coordinates: GeoPointZodSchema,
        provider: z.enum(GEO_PROVIDERS),
        provider_place_id: z.string().trim().nullable().optional().default(null),
        components: GeoAddressComponentsZodSchema.optional().default({}),
        raw_input: z.string().trim().max(300).nullable().optional().default(null),
    })
    .transform((value) => ({ ...value, resolved_at: new Date() }));

export type GeoAddressInput = z.input<typeof GeoAddressZodSchema>;
