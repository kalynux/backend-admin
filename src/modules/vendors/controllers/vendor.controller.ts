import { Request, Response } from 'express';
import { actorContextOf } from '../../audit/domain/audit-context';
import { ObjectId } from 'mongodb';
import { asyncHandler } from '../../../core/http/async-handler';
import { createAppError } from '../../../core/errors/app-error';
import { ERROR_CODES } from '../../../core/errors/error-codes';
import { toPageMeta } from '../../../core/http/list-query';
import { sendPaginated, sendSuccess } from '../../../core/http/responses';
import { requireAdminIdentity } from '../../admin-identity/domain/admin-identity.types';
import { toAuditEntryDto } from '../../audit/domain/audit.dto';
import { AuditRepository } from '../../audit/repositories/audit.repository';
import { ListAuditQuery } from '../../audit/validators/audit.validator';
import { UserReadRepository } from '../../users/repositories/user.read.repository';
import * as gateway from '../gateways/vendor.gateway';
import {
    StoreReadModel,
    StoreReadRepository,
} from '../repositories/store.read.repository';
import {
    VendorConnectionReadRepository,
    VendorOrderReadRepository,
    VendorSettingsReadRepository,
} from '../repositories/vendor-context.read.repository';
import {
    VendorProductReadModel,
    VendorProductReadRepository,
} from '../repositories/vendor-product.read.repository';
import { VendorReadModel, VendorReadRepository } from '../repositories/vendor.read.repository';
import {
    ListVendorActivityQuery,
    ListVendorProductsQuery,
    RejectVendorKycBody,
    SearchVendorsQuery,
    SuspendVendorBody,
    SuspendVendorProductBody,
    UpdateVendorSettingsBody,
} from '../validators/vendor.validator';

/**
 * `/api/v1/vendors` — platform vendor management.
 *
 * The second domain where both halves of ADR-004 meet in one module, and the one where the
 * split is starkest. The list, the detail, the catalogue and the activity feed are
 * **direct reads**; every write is **delegated**, because suspending a vendor is not a
 * column change — it takes their whole catalogue off sale inside one transaction, and
 * reinstating them re-runs the activation gate on every listing.
 *
 * ── What this surface deliberately does NOT offer ─────────────────────────────
 *
 *  - **billing, earnings and payouts.** They sit behind `billing.read` and `money.read` and
 *    already have their own admin surfaces. Assembling them here would let `vendors.read`
 *    alone reach data those permissions exist to gate. The detail carries the ids; the
 *    dashboard composes those panels from those modules.
 *  - **per-vendor commission.** It lives on the billing `PricingPlan` and is set by
 *    assigning a plan through jovi-mall's existing `POST /api/admin/vendors/:id/plan`.
 *    `vendors.settings.manage` governs the vendor's ORDER settings, not their rate.
 *  - **editing the vendor's profile.** Their business name, addresses, policies and payout
 *    destinations are theirs. An administrator suspends, verifies and oversees; they do
 *    not act as the vendor.
 */

const vendors = new VendorReadRepository();
const stores = new StoreReadRepository();
const products = new VendorProductReadRepository();
const settings = new VendorSettingsReadRepository();
const connections = new VendorConnectionReadRepository();
const orders = new VendorOrderReadRepository();
const users = new UserReadRepository();
const audit = new AuditRepository();

interface VendorListItemDto {
    id: string;
    userId: string;
    businessName: string | null;
    storeSlug: string | null;
    displayName: string | null;
    email: string | null;
    phone: string | null;
    country: string | null;
    status: string;
    kycStatus: string;
    verified: boolean;
    onboardingStep: number;
    onboardingComplete: boolean;
    createdAt: string;
    updatedAt: string;
}

/**
 * Named-field mapping, not a spread.
 *
 * The projection already excludes `payout_details` and `kyc_details.national_id_number`;
 * building the DTO by naming fields is the second of the two locks, and the one that
 * survives somebody widening the projection for a new screen.
 */
function toVendorListItemDto(
    vendor: VendorReadModel,
    store: StoreReadModel | undefined,
): VendorListItemDto {
    return {
        id: vendor._id.toString(),
        userId: vendor.user_id.toString(),
        businessName: store?.name ?? null,
        storeSlug: store?.slug ?? null,
        displayName: vendor.display_name ?? null,
        email: vendor.email ?? null,
        phone: vendor.phone ?? null,
        country: vendor.country ?? null,
        status: vendor.status,
        // Rows written before the verdict existed carry no `status`; `pending` is what
        // they mean, and coercing here keeps the wire vocabulary closed.
        kycStatus: vendor.kyc_details?.status ?? 'pending',
        verified: vendor.kyc_details?.legit_verified === true,
        onboardingStep: vendor.onboarding_step,
        // 0 is COMPLETED in jovi-mall's `VendorOnboardingStep`. The inversion is easy to
        // read backwards, so the boolean is computed once, here.
        onboardingComplete: vendor.onboarding_step === 0,
        createdAt: toIso(vendor.created_at) ?? String(vendor.created_at),
        updatedAt: toIso(vendor.updated_at) ?? String(vendor.updated_at),
    };
}

function toIso(value: Date | null | undefined): string | null {
    if (!value) return null;
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toActor(
    id: ObjectId | null | undefined,
    source: string | undefined,
    name: string | null | undefined,
) {
    return { id: id?.toString() ?? null, source: source ?? 'platform', name: name ?? null };
}

function toProductDto(product: VendorProductReadModel) {
    return {
        id: product._id.toString(),
        title: product.title ?? null,
        slug: product.slug ?? null,
        category: product.category ?? null,
        type: product.type ?? null,
        status: product.status,
        // Documents predating the field have no key at all — jovi-mall's readers coerce
        // the same way, and a `null` here would be a third meaning nobody handles.
        mode: product.mode ?? 'advanced',
        hasVariants: product.hasVariants ?? false,
        suspension: product.suspension?.reason
            ? {
                  reason: product.suspension.reason,
                  previousStatus: product.suspension.previousStatus ?? null,
                  at: toIso(product.suspension.suspendedAt),
                  byAgencyId: product.suspension.suspendedByAgencyId?.toString() ?? null,
                  note: product.suspension.note ?? null,
              }
            : null,
        deliveryAgencyId: product.delivery?.agency_id?.toString() ?? null,
        lastOrderedAt: toIso(product.lastOrderedAt),
        createdAt: toIso(product.createdAt) ?? String(product.createdAt),
        updatedAt: toIso(product.updatedAt) ?? String(product.updatedAt),
    };
}

/**
 * The fields a write can change, as the audit row's `before`.
 *
 * Deliberately the same keys the gateway derives its `after` from, so the two halves of a
 * diff line up. A `before` shaped differently from its `after` is a diff nobody can read.
 * `businessName` rides along for the audit LABEL rather than the diff — it is what makes a
 * feed readable without a join.
 */
function toAuditState(
    vendor: VendorReadModel,
    store: StoreReadModel | null,
): Record<string, unknown> {
    return {
        businessName: store?.name ?? null,
        displayName: vendor.display_name ?? null,
        email: vendor.email ?? null,
        status: vendor.status,
        suspendedReason: vendor.suspended_reason ?? null,
        kycStatus: vendor.kyc_details?.status ?? 'pending',
        kycRejectionReason: vendor.kyc_details?.rejection_reason ?? null,
    };
}

/**
 * Load the vendor or 404 — and its store, because every write needs both: the row as the
 * audit `before`, and the business name as the audit label.
 *
 * Reading before delegating costs two indexed lookups and buys the two things the gateway
 * cannot get from jovi-mall's answer: the previous state, and a 404 that says "no such
 * vendor" rather than a `PLATFORM_OPERATION_REJECTED` wrapping one.
 */
async function loadOr404(
    vendorId: string,
): Promise<{ vendor: VendorReadModel; store: StoreReadModel | null }> {
    const vendor = await vendors.findById(vendorId);
    if (!vendor) throw createAppError(ERROR_CODES.NOT_FOUND, 404, 'Vendor not found');

    const store = await stores.findForVendor(vendorId);
    return { vendor, store };
}

export class VendorController {
    /**
     * GET /api/v1/vendors — search and filter the directory.
     *
     * ── Three queries, not one aggregation ────────────────────────────────────
     * The business name lives on `stores`, so the obvious move is a `$lookup`. It is not
     * taken: a post-`$lookup` `$sort` cannot use an index and cannot carry the `_id`
     * tiebreaker that keeps skip/limit paging stable, so every page would blocking-sort
     * every matched vendor in memory. Instead the term is resolved against `stores` FIRST
     * (one indexed query), the vendor page is served from its own index, and the page's
     * stores are hydrated in one batched read. See `VENDOR_SORT` for what that costs.
     */
    static search = asyncHandler(async (req: Request, res: Response) => {
        const query = req.query as unknown as SearchVendorsQuery;

        // Only when a term is present: an unqualified list must not pay for a store scan.
        const nameMatch = query.search
            ? await stores.findVendorIdsByName(query.search)
            : { ids: [], truncated: false };

        const page = await vendors.search(
            {
                search: query.search,
                status: query.status,
                kycStatus: query.kycStatus,
                onboarding: query.onboarding,
                country: query.country,
                from: query.from,
                to: query.to,
                page: query.page,
                limit: query.limit,
                sort: query.sort,
            },
            nameMatch.ids,
        );

        const storesByVendor = await stores.findForVendors(page.items.map((v) => v._id));

        sendPaginated(
            res,
            page.items.map((vendor) =>
                toVendorListItemDto(vendor, storesByVendor.get(vendor._id.toString())),
            ),
            {
                ...toPageMeta(page.total, page.page, page.limit),
                // ADR-005 D-13 forbids a SILENT cap. A term matching more business names
                // than the lookup returns would otherwise produce a short list that reads
                // as complete.
                ...(nameMatch.truncated ? { businessNameMatchesTruncated: true } : {}),
            },
        );
    });

    /**
     * GET /api/v1/vendors/:vendorId
     *
     * The vendor, their store, the account behind them, their settings, and an operational
     * block: how many products in each state, how many orders and when the last arrived,
     * and how many agency connections in each state.
     *
     * Six reads, none of them a scan. The two count blocks are one `$group` each rather
     * than five `countDocuments` calls, because five counts are five index scans answering
     * one question — and they can disagree with each other if a row moves between them.
     */
    static get = asyncHandler(async (req: Request, res: Response) => {
        const vendorId = req.params.vendorId;

        const vendor = await vendors.findDetailById(vendorId);
        if (!vendor) throw createAppError(ERROR_CODES.NOT_FOUND, 404, 'Vendor not found');

        const [store, account, vendorSettings, productCounts, orderTally, connectionCounts] =
            await Promise.all([
                stores.findForVendor(vendorId),
                // The users module's own repository rather than a second projection of the
                // same collection: what this screen needs — status, roles, suspension — is
                // exactly what it already returns, and one projection of `users` is one
                // place to audit.
                users.findById(vendor.user_id.toString()),
                settings.findForVendor(vendorId),
                products.countByStatus(vendorId),
                orders.tallyForVendor(vendorId),
                connections.countByStatus(vendorId),
            ]);

        sendSuccess(res, {
            ...toVendorListItemDto(vendor, store ?? undefined),

            store: store
                ? {
                      id: store._id.toString(),
                      name: store.name,
                      slug: store.slug,
                      description: store.description ?? null,
                      logoFileId: store.logo_file_id?.toString() ?? null,
                      bannerFileId: store.banner_file_id?.toString() ?? null,
                      supportEmail: store.support_email ?? null,
                      supportPhone: store.support_phone ?? null,
                      supportWhatsapp: store.support_whatsapp ?? null,
                      // The vendor's own vacation switch — NOT an admin suspension. Two
                      // different things that both make a shop look closed, and the screen
                      // has to be able to tell them apart.
                      isOpen: store.is_open ?? true,
                      createdAt: toIso(store.created_at),
                  }
                : null,

            /**
             * The `users` row behind the vendor. A separate axis from `status` above: this
             * one says whether the person may sign in at all, that one whether the shop may
             * trade. Suspending either does not touch the other.
             */
            account: account
                ? {
                      id: account._id.toString(),
                      email: account.login_email ?? null,
                      phone: account.login_phone ?? null,
                      roles: account.roles ?? [],
                      status: account.status,
                      suspension:
                          account.status === 'suspended'
                              ? {
                                    at: toIso(account.suspended_at),
                                    reason: account.suspended_reason ?? null,
                                    by: toActor(
                                        account.suspended_by_user_id,
                                        account.suspended_by_source,
                                        account.suspended_by_name,
                                    ),
                                }
                              : null,
                  }
                : null,

            // Present only while suspended. An active vendor carrying a stale reason reads
            // as suspended on any screen that renders the block without checking first.
            suspension:
                vendor.status === 'inactive'
                    ? {
                          at: toIso(vendor.suspended_at),
                          reason: vendor.suspended_reason ?? null,
                          fromStatus: vendor.suspended_from_status ?? null,
                          by: toActor(
                              vendor.suspended_by_user_id,
                              vendor.suspended_by_source,
                              vendor.suspended_by_name,
                          ),
                      }
                    : null,

            verification: {
                status: vendor.kyc_details?.status ?? 'pending',
                verified: vendor.kyc_details?.legit_verified === true,
                rejectionReason: vendor.kyc_details?.rejection_reason ?? null,
                verifiedAt: toIso(vendor.kyc_details?.verified_at),
                reviewedBy:
                    (vendor.kyc_details?.status ?? 'pending') !== 'pending'
                        ? toActor(
                              vendor.kyc_details?.reviewed_by_user_id,
                              vendor.kyc_details?.reviewed_by_source,
                              vendor.kyc_details?.reviewed_by_name,
                          )
                        : null,
            },

            contact: {
                emailVerified: vendor.email_verified ?? false,
                phoneVerified: vendor.phone_verified ?? false,
                whatsappVerified: vendor.wa?.verified ?? false,
                timezone: vendor.timezone ?? null,
                preferredLanguage: vendor.preferred_language ?? null,
            },

            addresses: (vendor.business_addresses ?? []).map((address) => ({
                id: address._id?.toString() ?? null,
                label: address.label ?? null,
                addressLine1: address.address_line1 ?? null,
                addressLine2: address.address_line2 ?? null,
                city: address.city ?? null,
                state: address.state ?? null,
            })),

            /**
             * Presence, not content. `policies` carries ~30 fields of the vendor's own
             * commercial terms, and the question a detail screen asks is "have they set
             * this up" — the terms themselves are the vendor's to read and write.
             */
            policies: {
                policyVersion: vendor.policy_version ?? 0,
                hasReturnPolicy: vendor.policies?.return_policy?.return_eligible !== undefined,
                hasCancellationPolicy: vendor.policies?.cancellation_policy?.cancellable !== undefined,
                hasSupportPolicy: vendor.policies?.support_policy?.availability !== undefined,
            },

            /**
             * jovi-mall's schema defaults where no document exists: `vendor_settings` is
             * created lazily on first read or write, so a vendor who never touched a
             * setting has none — and reporting nulls would make the screen look broken
             * rather than untouched.
             */
            settings: {
                autoRedirectOrdersToAgency: vendorSettings?.auto_redirect_orders_to_agency ?? false,
                autoRedirectThresholdAmount: vendorSettings?.auto_redirect_threshold_amount ?? null,
                autoCancelUnpaidDays: vendorSettings?.auto_cancel_unpaid_days ?? 3,
                notifyDaysBeforeExpiry: vendorSettings?.notify_days_before_expiry ?? 7,
            },

            defaultDeliveryAgencyId: vendor.default_delivery_agency_id?.toString() ?? null,

            counts: {
                products: productCounts,
                orders: { total: orderTally.total, lastOrderAt: toIso(orderTally.lastOrderAt) },
                agencyConnections: connectionCounts,
            },
        });
    });

    /**
     * GET /api/v1/vendors/:vendorId/products — the catalogue, as oversight sees it.
     *
     * Filterable by status, type, mode and suspension reason. The reason filter is the one
     * that earns its place: "which of this vendor's listings did WE take down, and which
     * did their agency" is unanswerable without it, and the two have very different
     * remedies.
     */
    static products = asyncHandler(async (req: Request, res: Response) => {
        const query = req.query as unknown as ListVendorProductsQuery;

        // 404 first: an empty catalogue for a vendor that does not exist reads as "they
        // sell nothing" rather than "no such vendor".
        await loadOr404(req.params.vendorId);

        const page = await products.search(req.params.vendorId, {
            search: query.search,
            status: query.status,
            type: query.type,
            mode: query.mode,
            suspensionReason: query.suspensionReason,
            page: query.page,
            limit: query.limit,
            sort: query.sort,
        });

        sendPaginated(
            res,
            page.items.map(toProductDto),
            toPageMeta(page.total, page.page, page.limit),
        );
    });

    /** POST /api/v1/vendors/:vendorId/suspend */
    static suspend = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as SuspendVendorBody;
        const { vendor, store } = await loadOr404(req.params.vendorId);

        const updated = await gateway.suspend(
            req.params.vendorId,
            body.reason,
            toAuditState(vendor, store),
            actorContextOf(req),
        );

        sendSuccess(res, updated, {
            message: `Vendor suspended — ${updated.suspendedProductCount ?? 0} listing(s) taken off sale`,
        });
    });

    /**
     * POST /api/v1/vendors/:vendorId/restore
     *
     * The message names both numbers deliberately. A listing that no longer passes the
     * activation gate stays suspended, so fewer come back than went down — that is correct
     * rather than a partial failure, and an operator who is not told will read it as one.
     */
    static restore = asyncHandler(async (req: Request, res: Response) => {
        const { vendor, store } = await loadOr404(req.params.vendorId);

        const updated = await gateway.restore(
            req.params.vendorId,
            toAuditState(vendor, store),
            actorContextOf(req),
        );

        sendSuccess(res, updated, {
            message: `Vendor restored — ${updated.restoredProductCount ?? 0} listing(s) back on sale`,
        });
    });

    /** POST /api/v1/vendors/:vendorId/kyc/approve */
    static approveKyc = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as { note?: string };
        const { vendor, store } = await loadOr404(req.params.vendorId);

        const updated = await gateway.approveKyc(
            req.params.vendorId,
            body?.note,
            toAuditState(vendor, store),
            actorContextOf(req),
        );

        sendSuccess(res, updated, { message: 'Business verification approved' });
    });

    /** POST /api/v1/vendors/:vendorId/kyc/reject */
    static rejectKyc = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as RejectVendorKycBody;
        const { vendor, store } = await loadOr404(req.params.vendorId);

        const updated = await gateway.rejectKyc(
            req.params.vendorId,
            body.reason,
            toAuditState(vendor, store),
            actorContextOf(req),
        );

        sendSuccess(res, updated, { message: 'Business verification rejected' });
    });

    /** POST /api/v1/vendors/:vendorId/products/:productId/suspend */
    static suspendProduct = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as SuspendVendorProductBody;
        const { vendor, store } = await loadOr404(req.params.vendorId);

        const result = await gateway.suspendProduct(
            req.params.vendorId,
            req.params.productId,
            body.note,
            toAuditState(vendor, store),
            actorContextOf(req),
        );

        sendSuccess(res, result, { message: 'Product taken off sale' });
    });

    /** POST /api/v1/vendors/:vendorId/products/:productId/restore */
    static restoreProduct = asyncHandler(async (req: Request, res: Response) => {
        const { vendor, store } = await loadOr404(req.params.vendorId);

        const result = await gateway.restoreProduct(
            req.params.vendorId,
            req.params.productId,
            toAuditState(vendor, store),
            actorContextOf(req),
        );

        sendSuccess(res, result, { message: 'Product put back on sale' });
    });

    /** PATCH /api/v1/vendors/:vendorId/settings */
    static updateSettings = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as UpdateVendorSettingsBody;
        const { vendor, store } = await loadOr404(req.params.vendorId);

        const updated = await gateway.updateSettings(
            req.params.vendorId,
            { ...body },
            toAuditState(vendor, store),
            actorContextOf(req),
        );

        sendSuccess(res, updated, { message: 'Vendor settings updated' });
    });

    /**
     * GET /api/v1/vendors/:vendorId/activity — what administrators have done to this vendor.
     *
     * ── What this feed is, and what it is not ─────────────────────────────────
     * It is the audit trail filtered to this vendor as its target: every suspension,
     * reinstatement, verification decision, product takedown and settings change, who made
     * it, from where, and whether it succeeded.
     *
     * It is NOT the vendor's own platform activity — their orders, their shipments, their
     * catalogue edits. Those live in other domains behind other permissions, and assembling
     * them here would let `vendors.read` alone reach data those permissions exist to gate.
     *
     * The audit repository applies its own per-tier read scope on top of this filter.
     * `vendor` rows are `platform_actor`, which every tier may read — so a Support
     * administrator sees this feed, deliberately: they already hold `vendors.read`, and
     * seeing what was done to a vendor they can look up is the point of the role.
     */
    static activity = asyncHandler(async (req: Request, res: Response) => {
        const identity = requireAdminIdentity(req);
        const query = req.query as unknown as ListVendorActivityQuery;

        await loadOr404(req.params.vendorId);

        const page = await audit.search(
            {
                page: query.page,
                limit: query.limit,
                sort: query.sort,
                action: query.action,
                status: query.status,
                from: query.from,
                to: query.to,
                // The subject is fixed by the path — a caller cannot widen it.
                targetType: 'vendor',
                targetId: req.params.vendorId,
            } as ListAuditQuery,
            identity,
        );

        sendPaginated(res, page.items.map(toAuditEntryDto), page.meta);
    });
}
