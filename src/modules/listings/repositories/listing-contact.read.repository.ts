import { Document, Filter, ObjectId } from 'mongodb';
import { COLLECTIONS } from '../../../infra/platform/collections';
import { PlatformReadRepository } from '../../../infra/platform/platform.repository';

/**
 * A provider's HIDDEN contacts — the one read of `listing_contacts` on this service.
 *
 * ⛔ **Nothing but `domain/listing-contacts-disclosure.ts` may use this class**, and that file
 * uses it only INSIDE `auditedAttempt`, after the intent row has committed. The contacts are
 * what a customer pays a provider's credits to see (L-6, L-7); a reviewer needs them to catch
 * a WhatsApp number painted on a sign in the third photo, and every such look is recorded
 * (`catalog.listings.contacts.read`, `external`). `test:listings` fails if any other file in
 * this service names `COLLECTIONS.LISTING_CONTACT` or imports this repository.
 *
 * The projection is still a whitelist. `location` is projected by its human-readable parts
 * and its point, never whole: `provider_place_id`, `raw_input` and `resolved_at` answer no
 * reviewer's question.
 */

export interface ListingContactSetReadModel {
    whatsapp?: string | null;
    phone?: string | null;
    /** The second phone number (jovi-mall, 2026-11-08). Unlocked together with `phone`. */
    phone2?: string | null;
    email?: string | null;
    website?: string | null;
    socials?: Array<{ network?: string; url?: string }>;
    location?: {
        formatted_address?: string;
        coordinates?: { type?: 'Point'; coordinates?: [number, number] };
        components?: {
            street?: string | null;
            neighbourhood?: string | null;
            city?: string | null;
            region?: string | null;
            country?: string | null;
            country_code?: string | null;
        };
    } | null;
    video?: { url?: string; host?: string; checked_at?: Date | null } | null;
}

export interface ListingContactReadModel extends Document {
    _id: ObjectId;
    listing_id: ObjectId;
    vendor_id: ObjectId;
    published?: ListingContactSetReadModel | null;
    pending?: ListingContactSetReadModel | null;
}

function contactSetPaths(copy: 'published' | 'pending'): Record<string, 1> {
    return {
        [`${copy}.whatsapp`]: 1,
        [`${copy}.phone`]: 1,
        [`${copy}.phone2`]: 1,
        [`${copy}.email`]: 1,
        [`${copy}.website`]: 1,
        [`${copy}.socials.network`]: 1,
        [`${copy}.socials.url`]: 1,
        [`${copy}.location.formatted_address`]: 1,
        [`${copy}.location.coordinates`]: 1,
        [`${copy}.location.components.street`]: 1,
        [`${copy}.location.components.neighbourhood`]: 1,
        [`${copy}.location.components.city`]: 1,
        [`${copy}.location.components.region`]: 1,
        [`${copy}.location.components.country`]: 1,
        [`${copy}.location.components.country_code`]: 1,
        [`${copy}.video.url`]: 1,
        [`${copy}.video.host`]: 1,
        [`${copy}.video.checked_at`]: 1,
    };
}

export const LISTING_CONTACT_PROJECTION = {
    _id: 1,
    listing_id: 1,
    vendor_id: 1,
    ...contactSetPaths('published'),
    ...contactSetPaths('pending'),
} as const;

export class ListingContactReadRepository extends PlatformReadRepository<ListingContactReadModel> {
    constructor() {
        super(COLLECTIONS.LISTING_CONTACT, LISTING_CONTACT_PROJECTION);
    }

    /** One row per listing (`listing_contact_one_per_listing`), or null for a listing with none yet. */
    async findByListingId(listingId: string): Promise<ListingContactReadModel | null> {
        if (!ObjectId.isValid(listingId)) return null;
        return this.findOneBy({ listing_id: new ObjectId(listingId) } as Filter<ListingContactReadModel>);
    }
}
