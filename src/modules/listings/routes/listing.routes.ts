import { Router } from 'express';
import { defineRoute, permission, records } from '../../../api/route-manifest';
import { ListingController } from '../controllers/listing.controller';
import {
    ApproveListingSchema,
    ListingIdParamSchema,
    ListListingsQuerySchema,
    RejectListingSchema,
    SuspendListingSchema,
    UnsuspendListingSchema,
} from '../validators/listing.validator';

/**
 * `/api/v1/listings` — informational service listings (2026-10-19).
 *
 * A provider vendor's listing is published by an administrator, always (L-5): the provider
 * submits, a reviewer approves or rejects with reasons, and an edit to a live listing is a
 * revision reviewed the same way while the approved copy stays live. The review exists to make
 * sure no contact detail was slipped into the public text or the photos — the contacts are
 * what customers pay the provider's credits to see.
 *
 * Every tier works the queue (O-12, O-13): `catalog.listings.read` for the queue,
 * `catalog.listings.contacts.read` for the hidden contacts (audited on every read, BEFORE the
 * read), `catalog.listings.review` to approve / reject, `catalog.listings.suspend` to take a
 * listing offline and put it back. Every write is delegated to jovi-mall (§ C-3).
 *
 * ── Wave-2 seam ──────────────────────────────────────────────────────────────
 * The lead-report actions (reveal refund under `catalog.listings.reveals.refund`, block / lift
 * under `catalog.listings.reveal-block`) and the leads / reveals lists are built later. They
 * register on THIS router — one mount per prefix — and their audit actions
 * (`catalog.listings.reveals.refund`, `…reveal_block`, `…reveal_unblock`) stay producer-less
 * until then.
 *
 * Design record: PRODUCTION-READINESS/SERVICE-LISTINGS-PLAN.md (§ Admin, § C-6).
 */
const router = Router();
const mountedAt = '/listings';

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/',
    access: permission('catalog.listings.read'),
    validate: { query: ListListingsQuerySchema },
    handler: ListingController.list,
});

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/:listingId',
    access: permission('catalog.listings.read'),
    validate: { params: ListingIdParamSchema },
    handler: ListingController.get,
});

/**
 * The hidden contacts — the one route on this service that emits a provider's WhatsApp,
 * phone, email, links, pin and video. A READ that is audited, `external`: the row commits
 * before `listing_contacts` is touched, so with the audit store down nothing is disclosed
 * (`domain/listing-contacts-disclosure.ts`). Deeper than `/:listingId`, so not shadowed by it.
 */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/:listingId/contacts',
    access: permission('catalog.listings.contacts.read'),
    validate: { params: ListingIdParamSchema },
    audit: records('catalog.listings.contacts.read'),
    handler: ListingController.contacts,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/:listingId/approve',
    access: permission('catalog.listings.review'),
    validate: { params: ListingIdParamSchema, body: ApproveListingSchema },
    audit: records('catalog.listings.approve'),
    handler: ListingController.approve,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/:listingId/reject',
    access: permission('catalog.listings.review'),
    validate: { params: ListingIdParamSchema, body: RejectListingSchema },
    audit: records('catalog.listings.reject'),
    handler: ListingController.reject,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/:listingId/suspend',
    access: permission('catalog.listings.suspend'),
    validate: { params: ListingIdParamSchema, body: SuspendListingSchema },
    audit: records('catalog.listings.suspend'),
    handler: ListingController.suspend,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/:listingId/unsuspend',
    access: permission('catalog.listings.suspend'),
    validate: { params: ListingIdParamSchema, body: UnsuspendListingSchema },
    audit: records('catalog.listings.unsuspend'),
    handler: ListingController.unsuspend,
});

export const listingRoutes = router;
