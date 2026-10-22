import type {
    ListingContactReadModel,
    ListingContactSetReadModel,
} from '../repositories/listing-contact.read.repository';

/**
 * The wire shape of `GET /api/v1/listings/:listingId/contacts` — the ONLY shape on this service
 * that carries a provider's contact values.
 *
 * Both copies, side by side, so a reviewer judging a revision sees the number being REPLACED
 * as well as its replacement — the bait-and-switch the plan's stated defaults guard against
 * (an approved listing swapping its WhatsApp number goes through review like any other edit).
 */

export interface ListingContactSetDto {
    whatsapp: string | null;
    phone: string | null;
    email: string | null;
    website: string | null;
    socials: Array<{ network: string | null; url: string | null }>;
    location: {
        address: string | null;
        latitude: number | null;
        longitude: number | null;
        components: {
            street: string | null;
            neighbourhood: string | null;
            city: string | null;
            region: string | null;
            country: string | null;
            countryCode: string | null;
        };
    } | null;
    video: { url: string | null; host: string | null; checkedAt: string | null } | null;
}

export interface ListingContactsDto {
    listingId: string;
    published: ListingContactSetDto | null;
    pending: ListingContactSetDto | null;
}

function toIso(value: Date | string | null | undefined): string | null {
    if (!value) return null;
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toContactSetDto(set: ListingContactSetReadModel | null | undefined): ListingContactSetDto | null {
    if (!set) return null;
    // GeoJSON order: [longitude, latitude].
    const point = set.location?.coordinates?.coordinates;
    const components = set.location?.components;
    return {
        whatsapp: set.whatsapp ?? null,
        phone: set.phone ?? null,
        email: set.email ?? null,
        website: set.website ?? null,
        socials: (set.socials ?? []).map((s) => ({ network: s.network ?? null, url: s.url ?? null })),
        location: set.location
            ? {
                address: set.location.formatted_address ?? null,
                latitude: Array.isArray(point) ? point[1] : null,
                longitude: Array.isArray(point) ? point[0] : null,
                components: {
                    street: components?.street ?? null,
                    neighbourhood: components?.neighbourhood ?? null,
                    city: components?.city ?? null,
                    region: components?.region ?? null,
                    country: components?.country ?? null,
                    countryCode: components?.country_code ?? null,
                },
            }
            : null,
        video: set.video
            ? { url: set.video.url ?? null, host: set.video.host ?? null, checkedAt: toIso(set.video.checked_at) }
            : null,
    };
}

/** A listing with no contacts row yet (a fresh draft) answers two `null` copies, not a 404. */
export function toListingContactsDto(listingId: string, row: ListingContactReadModel | null): ListingContactsDto {
    return {
        listingId,
        published: toContactSetDto(row?.published),
        pending: toContactSetDto(row?.pending),
    };
}

/**
 * WHICH fields each copy holds — names only. This is what the audit row's `after` records:
 * enough to read back "they saw a listing's WhatsApp and phone", never the number itself,
 * which would otherwise sit in the one store readable without the permission that gates it.
 */
export function presentFieldsOf(dto: ListingContactsDto): { published: string[]; pending: string[] } {
    const of = (set: ListingContactSetDto | null): string[] => {
        if (!set) return [];
        const present: string[] = [];
        if (set.whatsapp) present.push('whatsapp');
        if (set.phone) present.push('phone');
        if (set.email) present.push('email');
        if (set.website) present.push('website');
        if (set.socials.length > 0) present.push('socials');
        if (set.location) present.push('location');
        if (set.video) present.push('video');
        return present;
    };
    return { published: of(dto.published), pending: of(dto.pending) };
}
