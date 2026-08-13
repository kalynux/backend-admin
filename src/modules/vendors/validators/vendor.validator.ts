import { z } from 'zod';
import { listQuery } from '../../../core/http/list-query';
import {
    dateRangeFields,
    dateRangeRule,
    idParam,
    reasonText,
    searchTerm,
} from '../../../core/validation/common.schemas';
import { AUDIT_ACTION_NAMES, AuditAction } from '../../audit/domain/audit.catalog';
import { AUDIT_STATUSES } from '../../audit/domain/audit.types';

/** Request shapes for `/api/v1/vendors`. */

export const VendorIdParamSchema = idParam('vendorId', 'vendor');

/** `/:vendorId/products/:productId` — both ids, both validated. */
export const VendorProductParamsSchema = idParam('vendorId', 'vendor').merge(
    idParam('productId', 'product'),
);

/**
 * jovi-mall's own vendor status values, verbatim from `vendor.model.ts`.
 *
 * Deliberately NOT renamed to something friendlier like `suspended`. A wire vocabulary
 * that disagrees with the column is a translation table somebody has to maintain in both
 * directions, and `inactive` is what an operator will see when they check the database
 * behind a screen that surprised them.
 */
export const VENDOR_STATUSES = ['active', 'pending_verification', 'inactive'] as const;

/** The business-verification verdict. Three values, because `false` meant two things. */
export const VENDOR_KYC_STATUSES = ['pending', 'verified', 'rejected'] as const;

/** `onboarding_step === 0` means finished — see `VendorOnboardingStep` in jovi-mall. */
export const VENDOR_ONBOARDING_FILTERS = ['complete', 'incomplete'] as const;

export const PRODUCT_STATUSES = ['draft', 'active', 'archived', 'pending_review', 'suspended'] as const;
export const PRODUCT_TYPES = ['physical', 'digital', 'service'] as const;
export const PRODUCT_MODES = ['simple', 'advanced'] as const;

/** The closed reason set from jovi-mall's `ProductSuspensionReason`. */
export const PRODUCT_SUSPENSION_REASONS = [
    'default_delivery_agency_removed',
    'product_delivery_agency_removed',
    'agency_connection_paused',
    'agency_storage_suspended',
    'vendor_suspended',
    'platform_oversight',
] as const;

/**
 * What the vendor directory may be ordered by: **wire name → `jovi_mall` field path**.
 *
 * Every entry is index-backed: `created_at`/`updated_at` by the compound
 * `{ status, created_at }` this phase adds to `VendorSchema`, `email` by its own unique
 * index. That is the rule for adding one — a sortable field with no index is a collection
 * scan a client can request by query string.
 *
 * ── Business name is deliberately NOT sortable ────────────────────────────────
 * It lives on `stores`, not `vendors`. Sorting the page by a field on another collection
 * means a `$lookup` before the `$sort`, which cannot use an index and cannot carry the
 * `_id` tiebreaker `toMongoSort` appends to keep skip/limit paging stable. jovi-mall's own
 * `findAvailableForAgencies` does exactly that and pays for it; this surface will not.
 */
export const VENDOR_SORT = {
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    email: 'email',
} as const;

/** As with users: a `created_at` range is the one filter that can become a scan. */
export const VENDOR_MAX_RANGE_DAYS = 366;

export const SearchVendorsQuerySchema = listQuery(VENDOR_SORT, '-createdAt', {
    /**
     * Matches the business name (via a pre-resolved lookup against `stores`), the display
     * name, the email, the phone, and — when the term is a 24-hex id — either the vendor
     * id or its **user** id. That last branch is what makes a support conversation work:
     * an id copied out of the user directory or an order finds the vendor rather than
     * returning nothing and looking broken.
     */
    search: searchTerm.optional(),
    status: z.enum(VENDOR_STATUSES).optional(),
    kycStatus: z.enum(VENDOR_KYC_STATUSES).optional(),
    onboarding: z.enum(VENDOR_ONBOARDING_FILTERS).optional(),
    /** ISO-3166 alpha-2. Uppercased to match how the model stores it. */
    country: z
        .string()
        .trim()
        .length(2)
        .transform((value) => value.toUpperCase())
        .optional(),
    ...dateRangeFields(),
}).superRefine(dateRangeRule({ maxDays: VENDOR_MAX_RANGE_DAYS }));

/**
 * The product list's sort map.
 *
 * ⚠️ **camelCase on BOTH sides, and that is not a typo.** `products` is built on
 * `BaseSchemaOptions`, which uses Mongoose's default `timestamps: true` and therefore
 * stores `createdAt`/`updatedAt`; `vendors` maps its timestamps to `created_at`/`updated_at`.
 * Two collections with opposite conventions in one module is how a sort silently orders by
 * a field that does not exist, so this map is where the difference is written down.
 */
export const VENDOR_PRODUCT_SORT = {
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
    lastOrderedAt: 'lastOrderedAt',
} as const;

export const ListVendorProductsQuerySchema = listQuery(VENDOR_PRODUCT_SORT, '-createdAt', {
    search: searchTerm.optional(),
    status: z.enum(PRODUCT_STATUSES).optional(),
    type: z.enum(PRODUCT_TYPES).optional(),
    mode: z.enum(PRODUCT_MODES).optional(),
    /** Only meaningful alongside `status=suspended`; harmless otherwise. */
    suspensionReason: z.enum(PRODUCT_SUSPENSION_REASONS).optional(),
});

export const SuspendVendorSchema = z.object({
    reason: reasonText('A reason is required to suspend a vendor'),
});

export const RejectVendorKycSchema = z.object({
    reason: reasonText('A reason is required to reject a vendor’s verification'),
});

/** Optional — an approval explains itself; a rejection does not. */
export const ApproveVendorKycSchema = z
    .object({
        note: z.string().trim().max(500).optional(),
    })
    .strict();

export const SuspendVendorProductSchema = z.object({
    note: reasonText('A reason is required to take a product off sale'),
});

/**
 * The platform-governed slice of a vendor's settings.
 *
 * ── The rule that decides what is in here ─────────────────────────────────────
 * A setting is an administrator's to change when its effect lands on somebody OTHER than
 * the vendor — the platform's unpaid-order sweep, the agency receiving the shipment, or
 * the customer waiting on the order. A setting whose only effect is on the vendor's own
 * screen or inbox is theirs.
 *
 * So `notifyDaysBeforeExpiry` (a notification to the vendor, about the vendor) and
 * `customerFlags` (their private CRM vocabulary, referenced by `VendorCustomer.flag_ids`,
 * so editing it fans out) are ABSENT — and `.strict()` makes naming either one a 400 here,
 * before the request reaches jovi-mall. A call that looks like it changed a setting must
 * never come back 200 having changed nothing.
 *
 * **Per-vendor commission is absent and that is not an oversight.** Commission lives on
 * `PricingPlan.commission_percent` and is set by assigning a plan through jovi-mall's
 * existing `POST /api/admin/vendors/:vendorId/plan`. `vendors.settings.manage` does not
 * reach it, and nothing here should be extended to.
 *
 * Bounds mirror `VendorSettingsSchema`'s own `min`/`max`, so an administrator cannot write
 * a value the vendor's own screen would refuse.
 */
export const UpdateVendorSettingsSchema = z
    .object({
        autoCancelUnpaidDays: z.number().int().min(1).max(90).optional(),
        autoRedirectOrdersToAgency: z.boolean().optional(),
        /** `null` clears the cap: every order auto-dispatches while the flag is on. */
        autoRedirectThresholdAmount: z.number().min(0).nullable().optional(),
    })
    .strict()
    .refine((body) => Object.keys(body).length > 0, {
        message: 'Nothing to update',
    });

export const VENDOR_ACTIVITY_SORT = { occurredAt: 'occurred_at' } as const;

/**
 * The actions that can appear in a vendor's history, DERIVED from the audit catalog.
 *
 * A hand-written list is the drift `audit.types.ts` documents: adding an eighth `vendors.*`
 * action must widen this filter automatically, or the dashboard cannot filter on a row it
 * is already displaying.
 */
export const VENDOR_AUDIT_ACTIONS = AUDIT_ACTION_NAMES.filter((action) =>
    action.startsWith('vendors.'),
) as [AuditAction, ...AuditAction[]];

export const ListVendorActivityQuerySchema = listQuery(VENDOR_ACTIVITY_SORT, '-occurredAt', {
    action: z.enum(VENDOR_AUDIT_ACTIONS).optional(),
    status: z.enum(AUDIT_STATUSES as unknown as [string, ...string[]]).optional(),
    ...dateRangeFields(),
}).superRefine(dateRangeRule({ maxDays: VENDOR_MAX_RANGE_DAYS }));

export type SearchVendorsQuery = z.infer<typeof SearchVendorsQuerySchema>;
export type ListVendorProductsQuery = z.infer<typeof ListVendorProductsQuerySchema>;
export type SuspendVendorBody = z.infer<typeof SuspendVendorSchema>;
export type RejectVendorKycBody = z.infer<typeof RejectVendorKycSchema>;
export type SuspendVendorProductBody = z.infer<typeof SuspendVendorProductSchema>;
export type UpdateVendorSettingsBody = z.infer<typeof UpdateVendorSettingsSchema>;
export type ListVendorActivityQuery = z.infer<typeof ListVendorActivityQuerySchema>;
