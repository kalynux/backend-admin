import { Router } from 'express';
import { defineRoute, permission, records } from '../../../api/route-manifest';
import { VendorController } from '../controllers/vendor.controller';
import {
    ApproveVendorKycSchema,
    ListVendorActivityQuerySchema,
    ListVendorAgenciesQuerySchema,
    ListVendorProductsQuerySchema,
    RejectVendorKycSchema,
    SearchVendorsQuerySchema,
    SuspendVendorProductSchema,
    SuspendVendorSchema,
    UpdateVendorSettingsSchema,
    VendorIdParamSchema,
    VendorProductParamsSchema,
} from '../validators/vendor.validator';

/**
 * `/api/v1/vendors` — platform vendor management.
 *
 * PHASE-0 found this domain had no admin surface anywhere: an administrator could not look
 * a vendor up, could not verify one, and could not stop one trading. Two capabilities
 * existed in jovi-mall as dead code with zero callers — `setLegitVerified` and
 * `updateStatus` — so vendor verification and vendor suspension had never been performable
 * by anyone. Eleven routes cover the whole of it.
 *
 * ── Read and write hold different permissions, deliberately ───────────────────
 * `vendors.read` is a Support-tier lookup — answering a ticket needs it. The seven writes
 * are not: they are granted to Admin and above through `allInFamily('vendors')`, which
 * Support's grant does not include. That split is the reason the permissions are
 * per-operation rather than one `vendors.manage`.
 *
 * ── Four permissions, and why not one ─────────────────────────────────────────
 * Suspension, verification, product oversight and settings are four different jobs with
 * four different blast radii — a KYC reviewer should not be able to take a shop offline.
 * They were declared this way in the catalog before any of them was buildable; this is the
 * phase that uses them.
 *
 * ── Route order ───────────────────────────────────────────────────────────────
 * No literal sibling of `/:vendorId` exists, so Express resolves every path here without
 * ambiguity. Keep it that way: a future literal (say `/export`) MUST be declared above
 * them all.
 */
const router = Router();
const mountedAt = '/vendors';

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/',
    access: permission('vendors.read'),
    validate: { query: SearchVendorsQuerySchema },
    handler: VendorController.search,
});

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/:vendorId',
    access: permission('vendors.read'),
    validate: { params: VendorIdParamSchema },
    handler: VendorController.get,
});

/**
 * The catalogue, as platform oversight sees it — the "product-related operational
 * information" this domain is accountable for.
 *
 * Behind `vendors.read` rather than a products permission: the question is "what is this
 * vendor selling and what state is it in", scoped to one vendor by the path. A catalogue
 * search ACROSS vendors is a different surface with a different permission, and this is
 * deliberately not it.
 */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/:vendorId/products',
    access: permission('vendors.read'),
    validate: { params: VendorIdParamSchema, query: ListVendorProductsQuerySchema },
    handler: VendorController.products,
});

/**
 * One listing, in full — image, price, stock, the responsible agency by name, and what its
 * storage rate comes to for this product.
 *
 * The same `vendors.read` as the list, and scoped by both ids for the same reason the two
 * writes below are: the ownership is the authorisation, so a product belonging to another
 * vendor is a 404 rather than a 403.
 *
 * Declared AFTER `/:vendorId/products` and before nothing that could shadow it — the two
 * paths differ in segment count, so Express separates them without ambiguity. The POST
 * sub-resources at the same path are different methods.
 *
 * Unlike every other vendor read this one is DELEGATED. See the controller for the
 * argument; the short form is that a file id becomes a URL only where the storage provider
 * is configured, and that is not here.
 */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/:vendorId/products/:productId',
    access: permission('vendors.read'),
    validate: { params: VendorProductParamsSchema },
    handler: VendorController.product,
});

/**
 * The delivery-agency connections, as rows rather than as the seven counts on the detail
 * (BR-018). The mirror image of `/agencies/:agencyId/agents`, and a **direct read** — a
 * connection document is a record, and ADR-004 D-2 as amended by ADR-009 D-1 / ADR-011 D-1
 * says to read a record directly and delegate only a verdict.
 *
 * BOTH permissions, in `all` mode, for the reason the roster states in the other
 * direction: the rows name agencies and carry their business names and commercial state,
 * so gating on `vendors.read` alone would be a second door onto the agency directory.
 * `/agents/:agentId/contracts` and `/shipments/:shipmentId/offers` are guarded the same
 * way. Both tiers holding either hold both, so it costs nobody access.
 *
 * Declared above `/:vendorId/products/:productId` and below `/:vendorId/products` — no
 * path here can shadow it, since `agencies` is a distinct second segment.
 */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/:vendorId/agencies',
    access: permission('vendors.read', 'agencies.read'),
    validate: { params: VendorIdParamSchema, query: ListVendorAgenciesQuerySchema },
    handler: VendorController.agencies,
});

/**
 * The activity feed needs BOTH permissions, in `all` mode.
 *
 * `vendors.read` because the subject is a vendor, and `audit.read` because the rows are
 * audit rows and the repository applies the audit read scope to them. Requiring only the
 * first would make this endpoint a second door onto the trail that bypasses the permission
 * governing it — and requiring only the second would let somebody read a vendor's history
 * without being allowed to look the vendor up. Both tiers that hold either hold both, so
 * this costs nobody access; it states the dependency so that a future tier change cannot
 * quietly open a side door.
 */
/**
 * The identity documents behind the KYC verdict.
 *
 * ⚠ **`vendors.read`, the same Support-tier lookup as the detail** — deliberately, rather than
 * `vendors.kyc.review`. Support answers "why was my shop rejected" tickets and cannot do it
 * from a status alone; the review permission governs the WRITE, which is the act with
 * consequences. That is the same call the header above makes for the rest of this module.
 *
 * What it returns is metadata and file HANDLES, never bytes. The picture comes from
 * `GET /api/v1/files/:fileId/content`, behind `files.content.read` and **audited** — looking at
 * somebody's identity card is the disclosure, and that is where the row belongs. Same split as
 * `files.resolve` versus `files.content.read`, for the same reason.
 *
 * A DELEGATED read, unusually for this module: the documents are in a private storage tree and
 * the rule that hides their URLs must not be applied a second time on this side. See the
 * gateway.
 *
 * Declared among the `/:vendorId/…` siblings, which cannot shadow each other — different
 * literal second segments.
 */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/:vendorId/verification',
    access: permission('vendors.read'),
    validate: { params: VendorIdParamSchema },
    handler: VendorController.verification,
});

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/:vendorId/activity',
    access: permission('vendors.read', 'audit.read'),
    validate: { params: VendorIdParamSchema, query: ListVendorActivityQuerySchema },
    handler: VendorController.activity,
});

/**
 * Suspend and restore are POST sub-resources rather than a `PATCH { status }`.
 *
 * ADR-005 D-4: the permission and the audit row attach to the ACTION. `vendors.suspend`
 * governs both directions, but they are separate audit actions — `vendors.suspend` and
 * `vendors.reinstate` — and a status field on a PATCH body could not carry the required
 * reason on one direction and forbid it on the other.
 *
 * Both are heavier than they look: suspending takes the vendor's whole catalogue off sale,
 * and restoring re-runs the activation gate on every listing rather than blindly
 * republishing. jovi-mall does that work inside one transaction; this is the door to it.
 */
defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/:vendorId/suspend',
    access: permission('vendors.suspend'),
    validate: { params: VendorIdParamSchema, body: SuspendVendorSchema },
    audit: records('vendors.suspend'),
    handler: VendorController.suspend,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/:vendorId/restore',
    access: permission('vendors.suspend'),
    validate: { params: VendorIdParamSchema },
    audit: records('vendors.reinstate'),
    handler: VendorController.restore,
});

/**
 * Approve and reject, likewise separate actions under one permission.
 *
 * Rejection requires a reason and approval does not: an approval explains itself, and a
 * rejection the vendor cannot see the cause of is one they can only respond to by
 * re-submitting blind.
 */
defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/:vendorId/kyc/approve',
    access: permission('vendors.kyc.review'),
    validate: { params: VendorIdParamSchema, body: ApproveVendorKycSchema },
    audit: records('vendors.kyc.approve'),
    handler: VendorController.approveKyc,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/:vendorId/kyc/reject',
    access: permission('vendors.kyc.review'),
    validate: { params: VendorIdParamSchema, body: RejectVendorKycSchema },
    audit: records('vendors.kyc.reject'),
    handler: VendorController.rejectKyc,
});

/**
 * Product oversight — one listing at a time, under the vendor that owns it.
 *
 * Nested under `/:vendorId` rather than a top-level `/products/:productId`, because the
 * ownership is the authorisation: jovi-mall scopes the write by both ids, so a product id
 * from another vendor cannot be acted on by naming this one.
 *
 * Its suspension reason (`platform_oversight`) is distinct from the vendor cascade's, so
 * that reinstating the vendor can never silently republish a listing an administrator took
 * down on its own merits. Only the restore below lifts it.
 */
defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/:vendorId/products/:productId/suspend',
    access: permission('vendors.products.manage'),
    validate: { params: VendorProductParamsSchema, body: SuspendVendorProductSchema },
    audit: records('vendors.products.suspend'),
    handler: VendorController.suspendProduct,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/:vendorId/products/:productId/restore',
    access: permission('vendors.products.manage'),
    validate: { params: VendorProductParamsSchema },
    audit: records('vendors.products.restore'),
    handler: VendorController.restoreProduct,
});

/**
 * The platform-governed settings — auto-cancel and auto-redirect only.
 *
 * A PATCH rather than POST sub-resources because these ARE fields, with no before/after
 * asymmetry and no required reason. What may be written is decided by the schema, and the
 * rule behind it is in that schema's header: a setting is an administrator's when its
 * effect lands on somebody other than the vendor.
 */
defineRoute(router, {
    mountedAt,
    method: 'patch',
    path: '/:vendorId/settings',
    access: permission('vendors.settings.manage'),
    validate: { params: VendorIdParamSchema, body: UpdateVendorSettingsSchema },
    audit: records('vendors.settings.update'),
    handler: VendorController.updateSettings,
});

export const vendorRoutes = router;
