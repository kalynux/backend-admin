import { Router } from 'express';
import { defineRoute, permission, records } from '../../../api/route-manifest';
import { ReviewController } from '../controllers/review.controller';
import {
    ListReviewsQuerySchema,
    RepublishReviewSchema,
    ReviewIdParamSchema,
    ReviewReasonSchema,
} from '../validators/review.validator';

/**
 * `/api/v1/reviews` — ratings and reviews of products and deliveries (2026-10-05).
 *
 * Every review publishes the moment it is written (owner decision). Moderation is AFTER the
 * fact: an administrator can hide a review (unpublish), put it back (republish), or delete
 * it for good — after which its author may write a new one, which a hidden review's author
 * may not. The list reads `reviews` directly; the three writes are delegated to jovi-mall,
 * which recomputes the ratings each one moves.
 *
 * All three tiers hold all three permissions by the owner's decision — Support included,
 * delete included (`TIER_3_DESTRUCTIVE_ALLOWLIST`). Every write is audited fail-closed.
 */
const router = Router();
const mountedAt = '/reviews';

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/',
    access: permission('reviews.read'),
    validate: { query: ListReviewsQuerySchema },
    handler: ReviewController.list,
});

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/:reviewId',
    access: permission('reviews.read'),
    validate: { params: ReviewIdParamSchema },
    handler: ReviewController.get,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/:reviewId/unpublish',
    access: permission('reviews.moderate'),
    validate: { params: ReviewIdParamSchema, body: ReviewReasonSchema },
    audit: records('reviews.unpublish'),
    handler: ReviewController.unpublish,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/:reviewId/republish',
    access: permission('reviews.moderate'),
    validate: { params: ReviewIdParamSchema, body: RepublishReviewSchema },
    audit: records('reviews.republish'),
    handler: ReviewController.republish,
});

defineRoute(router, {
    mountedAt,
    method: 'delete',
    path: '/:reviewId',
    access: permission('reviews.delete'),
    validate: { params: ReviewIdParamSchema, body: ReviewReasonSchema },
    audit: records('reviews.delete'),
    handler: ReviewController.remove,
});

export const reviewRoutes = router;
