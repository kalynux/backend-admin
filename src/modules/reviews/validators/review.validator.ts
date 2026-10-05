import { z } from 'zod';
import { listQuery } from '../../../core/http/list-query';
import { boolFlag, idParam, objectId, searchTerm } from '../../../core/validation/common.schemas';

/** Request shapes for `/api/v1/reviews`. */

export const ReviewIdParamSchema = idParam('reviewId', 'review');

/** camelCase on both sides — `reviews` uses Mongoose's default timestamps. */
export const REVIEW_SORT = {
    createdAt: 'createdAt',
    rating: 'rating',
} as const;

/**
 * jovi-mall's `REVIEW_STATUSES`, verbatim. Two since 2026-10-05: every review publishes on
 * submission, so `pending` (held for a moderator) and `rejected` no longer exist.
 */
export const REVIEW_STATUSES = ['published', 'unpublished'] as const;
export const REVIEW_SUBJECT_TYPES = ['product', 'delivery'] as const;
export const REVIEW_AUTHOR_ROLES = ['customer', 'vendor', 'agency'] as const;

/**
 * Newest first by default — "what was written lately" is the question a moderation screen
 * opens on. Every filter narrows; none set means every live (not deleted) review.
 */
export const ListReviewsQuerySchema = listQuery(REVIEW_SORT, '-createdAt', {
    status: z.enum(REVIEW_STATUSES).optional(),
    subjectType: z.enum(REVIEW_SUBJECT_TYPES).optional(),
    authorRole: z.enum(REVIEW_AUTHOR_ROLES).optional(),
    rating: z.coerce.number().int().min(1).max(5).optional(),
    /** Only reviews carrying a title or a body — the ones with words that could be abusive. */
    hasText: boolFlag.optional(),
    /** Case-insensitive substring of the title or the body. */
    search: searchTerm.optional(),
    productId: objectId.optional(),
    vendorId: objectId.optional(),
    agentId: objectId.optional(),
    agencyId: objectId.optional(),
});
export type ListReviewsQuery = z.infer<typeof ListReviewsQuerySchema>;

/**
 * Unpublish and delete — the reason is REQUIRED (3–500 characters), as jovi-mall requires.
 * It is never shown to the author or the public: it is the note for the next administrator.
 */
export const ReviewReasonSchema = z.object({
    reason: z.string().trim().min(3).max(500),
}).strict();
export type ReviewReasonBody = z.infer<typeof ReviewReasonSchema>;

/** Republish — undoing a hide needs no justification; one may be given. */
export const RepublishReviewSchema = z.object({
    reason: z.string().trim().min(3).max(500).optional(),
}).strict();
export type RepublishReviewBody = z.infer<typeof RepublishReviewSchema>;
