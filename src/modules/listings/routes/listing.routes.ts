import { Router } from 'express';
import { defineRoute, permission, records } from '../../../api/route-manifest';
import { ListingController } from '../controllers/listing.controller';
import { ListingReportsController } from '../controllers/listing-reports.controller';
import {
    BlockCustomerSchema,
    LeadIdParamSchema,
    LiftBlockSchema,
    ListListingLeadsQuerySchema,
    RefundRevealSchema,
    RevealBlockParamsSchema,
    RevealIdParamSchema,
} from '../validators/listing-reports.validator';
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
 * ── Lead reports (L-25, L-29, L-31; routed 2026-11-07) ───────────────────────
 * A provider's "Report" on a lead opens a `LISTING_LEAD_REPORT` ticket in jovi-mall. From it an
 * administrator reads the lead in full (`/leads/:leadId`, `/:listingId/leads`), refunds reveals
 * (`/reveals/:revealId/refund`, `catalog.listings.reveals.refund` — financial, tiers 1 + 2) and
 * blocks or lifts the customer on that listing (`/:listingId/reveal-blocks/:customerId`,
 * `catalog.listings.reveal-block`). All three writes are delegated and audited fail-closed.
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

/**
 * One lead in full — the customer's real identity and their other leads (L-29, L-31). Declared
 * BEFORE `/:listingId` so `leads` is never read as a listing id.
 */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/leads/:leadId',
    access: permission('catalog.listings.read'),
    validate: { params: LeadIdParamSchema },
    handler: ListingReportsController.lead,
});

/**
 * Refund one reveal from a provider's report (L-25). `financial`: it credits the provider's
 * wallet. Named by the REVEAL, so it sits beside the lead routes rather than under a listing.
 */
defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/reveals/:revealId/refund',
    access: permission('catalog.listings.reveals.refund'),
    validate: { params: RevealIdParamSchema, body: RefundRevealSchema },
    audit: records('catalog.listings.reveals.refund'),
    handler: ListingReportsController.refund,
});

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/:listingId',
    access: permission('catalog.listings.read'),
    validate: { params: ListingIdParamSchema },
    handler: ListingController.get,
});

/** Who unlocked this listing's contacts, newest first, the customer in full (L-31). */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/:listingId/leads',
    access: permission('catalog.listings.read'),
    validate: { params: ListingIdParamSchema, query: ListListingLeadsQuerySchema },
    handler: ListingReportsController.leads,
});

/** Block a customer from unlocking this listing's contacts (L-29). Lifted by the DELETE below. */
defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/:listingId/reveal-blocks/:customerId',
    access: permission('catalog.listings.reveal-block'),
    validate: { params: RevealBlockParamsSchema, body: BlockCustomerSchema },
    audit: records('catalog.listings.reveal_block'),
    handler: ListingReportsController.block,
});

defineRoute(router, {
    mountedAt,
    method: 'delete',
    path: '/:listingId/reveal-blocks/:customerId',
    access: permission('catalog.listings.reveal-block'),
    validate: { params: RevealBlockParamsSchema, body: LiftBlockSchema },
    audit: records('catalog.listings.reveal_unblock'),
    handler: ListingReportsController.unblock,
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
