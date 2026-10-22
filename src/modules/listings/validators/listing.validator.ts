import { z } from 'zod';
import { listQuery } from '../../../core/http/list-query';
import { dateRangeFields, dateRangeRule, idParam, objectId, searchTerm } from '../../../core/validation/common.schemas';

/**
 * Request shapes for `/api/v1/listings` — informational service listings
 * (PRODUCTION-READINESS/SERVICE-LISTINGS-PLAN.md § C-3, § C-6).
 */

export const ListingIdParamSchema = idParam('listingId', 'listing');

/**
 * jovi-mall's vocabularies (`modules/listings/domain/listing.types.ts`), verbatim. There is no
 * shared package, so these are copies — and `test:listings` reads jovi-mall's file as text and
 * fails if either side moves alone.
 */
export const LISTING_STATUSES = ['draft', 'pending_review', 'rejected', 'live', 'suspended', 'archived'] as const;
export const LISTING_REVIEW_STATES = ['editing', 'pending_review', 'rejected'] as const;
export const LISTING_SUSPENSION_REASONS = ['insufficient_credits', 'platform_oversight', 'plan_quota_exceeded'] as const;
/** The sensitive fields — names only. Their VALUES live in `listing_contacts` and nowhere else. */
export const LISTING_CONTACT_FIELDS = ['whatsapp', 'phone', 'email', 'website', 'socials', 'location', 'video'] as const;

/**
 * Wire name → database path. `listings` uses snake_case timestamps (`created_at`).
 *
 * `submittedAt` is the review queue's order, and the index behind it is jovi-mall's
 * `listing_review_queue` `{ 'review.state': 1, 'review.submitted_at': 1 }`.
 */
export const LISTING_SORT = {
    submittedAt: 'review.submitted_at',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    publishedAt: 'published_at',
} as const;

/**
 * The review queue and the listing directory, one list.
 *
 * **Oldest submission first by default** — the queue is worked from the front, and a
 * listing waiting longest is the one a provider is most likely to be chasing. The directory
 * view (no `reviewState`) sends `sort=-createdAt`. A listing that was never submitted has no
 * `review.submitted_at` and sorts first ascending; filter on `reviewState=pending_review` for
 * the queue proper.
 *
 * `from` / `to` are over the SUBMISSION instant, half-open. `search` is the house name for the
 * free-text term (every other list on this service calls it that); it matches the title and
 * the company name of either copy, regex-escaped.
 *
 * Built on `listQuery`, so it strips an unknown key rather than refusing it — the general
 * rule `test:list-strictness` pins.
 */
export const ListListingsQuerySchema = listQuery(LISTING_SORT, 'submittedAt', {
    reviewState: z.enum(LISTING_REVIEW_STATES).optional(),
    status: z.enum(LISTING_STATUSES).optional(),
    vendorId: objectId.optional(),
    search: searchTerm.optional(),
    ...dateRangeFields(),
}).superRefine(dateRangeRule());
export type ListListingsQuery = z.infer<typeof ListListingsQuerySchema>;

/** Approve — `{}` exactly, as jovi-mall's contract (§ C-3) takes it. */
export const ApproveListingSchema = z.object({}).strict();
export type ApproveListingBody = z.infer<typeof ApproveListingSchema>;

/**
 * Reject — one to five reasons, 3–500 characters each. The provider SEES these: they are the
 * only explanation a provider gets for why their listing is not live.
 */
export const RejectListingSchema = z.object({
    reasons: z.array(z.string().trim().min(3).max(500)).min(1).max(5),
}).strict();
export type RejectListingBody = z.infer<typeof RejectListingSchema>;

/** Suspend — `platform_oversight`, with a required note (3–500). */
export const SuspendListingSchema = z.object({
    note: z.string().trim().min(3).max(500),
}).strict();
export type SuspendListingBody = z.infer<typeof SuspendListingSchema>;

/** Unsuspend — putting it back needs no justification; one may be given. */
export const UnsuspendListingSchema = z.object({
    note: z.string().trim().min(3).max(500).optional(),
}).strict();
export type UnsuspendListingBody = z.infer<typeof UnsuspendListingSchema>;
