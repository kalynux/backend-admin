import { z } from 'zod';
import { listQuery } from '../../../core/http/list-query';
import {
    boolFlag,
    dateRangeFields,
    dateRangeRule,
    idParam,
    isoDateTime,
    objectId,
    searchTerm,
} from '../../../core/validation/common.schemas';

/** Request shapes for `/api/v1/billing`. */

export const PlanIdParamSchema = idParam('planId', 'pricing plan');

/**
 * The three roles a plan — and therefore a subscription — can belong to.
 *
 * **Pinned, not a bounded string**, and the reason is the same one that pinned
 * `AGENCY_STATUSES` rather than the seven-value `ContractStatus`: this service WRITES
 * against this vocabulary. `POST /billing/plans` files a plan under one of these, and
 * `POST /billing/subscriptions/:ownerType/:ownerId` is mapped to one of exactly three
 * jovi-mall paths by a switch in `billing.gateway.ts`. A fourth value would be a request
 * with nowhere to go, and refusing it at the edge says so; letting it through would
 * produce a 500 from a lookup that found no path.
 *
 * Contrast `SUBSCRIPTION_STATUS` below, which this service only ever reads.
 */
export const BILLING_OWNER_TYPES = ['vendor', 'agency', 'agent'] as const;
export type BillingOwnerType = (typeof BILLING_OWNER_TYPES)[number];

/**
 * `:ownerType/:ownerId` — the pair that replaces jovi-mall's three assign routes.
 *
 * Two params rather than `idParam`, which builds a single-key object. The discriminator
 * comes first in the path because that is the order it is read in: *what kind of owner*,
 * then *which one*.
 */
export const SubscriptionOwnerParamSchema = z.object({
    ownerType: z.enum(BILLING_OWNER_TYPES),
    ownerId: objectId,
});

// ─────────────────────────────────────────────────────────────────────────────
// The plan catalog
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the catalog may be ordered by: **wire name → `jovi_mall` field path**.
 *
 * No index backs any of these, and that is fine here rather than an oversight worth
 * fixing: `pricing_plans` holds a handful of tiers per role — the whole collection is a
 * page — so every sort in this map is an in-memory sort over a set smaller than the
 * default `limit`. jovi-mall's own catalog read sorts `{sort_order: 1, price: 1}` for the
 * same reason. Contrast `SUBSCRIPTION_SORT`, which pages a row-per-owner collection and
 * did need indexes added in this change.
 */
export const PLAN_SORT = {
    sortOrder: 'sort_order',
    price: 'price',
    name: 'name',
    createdAt: 'created_at',
} as const;

/**
 * The catalog list.
 *
 * `sortOrder` ascending is the default rather than `-createdAt`, because `sort_order` is
 * the field the platform put there to say what order these belong in — a catalog listed
 * newest-first shows the tiers in the order somebody happened to create them.
 */
export const ListPlansQuerySchema = listQuery(PLAN_SORT, 'sortOrder', {
    role: z.enum(BILLING_OWNER_TYPES).optional(),
    /** `is_active: false` is a defined-but-not-purchasable tier, which is a real state. */
    isActive: boolFlag.optional(),
    /**
     * Soft-deleted plans, off by default.
     *
     * They are excluded rather than gone: `deletedAt` is set and existing subscribers keep
     * running on the archived tier, so "which plan is this vendor on" can name a row this
     * list would not otherwise show. Opting in is how that row gets read.
     */
    includeArchived: boolFlag.default(false),
    /** Matches the plan code or its display name — or, for a 24-hex term, the plan id. */
    search: searchTerm.optional(),
});

/**
 * A plan code: lower-case, no spaces.
 *
 * jovi-mall lower-cases it in the schema and constrains it no further. Two additions
 * here, both create-only and neither able to refuse a plan that already exists (the code
 * is immutable after creation):
 *
 *  - `.toLowerCase()` at the edge, so the duplicate check jovi-mall runs against the
 *    stored lower-cased value is decided by what the administrator sees, not by what
 *    Mongoose does to it afterwards.
 *  - a character class, because the code is a stable identifier the platform looks tiers
 *    up by (`freePlanCode(ownerType)`), and `'agency free'` with a space is a code nobody
 *    can type into a config file later.
 */
const planCode = z
    .string()
    .trim()
    .toLowerCase()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9_-]+$/, 'A plan code may hold only lower-case letters, digits, _ and -');

/**
 * The plan body, in this service's camelCase, mapped to jovi-mall's snake_case by the
 * gateway.
 *
 * Every limit is `nullable().optional()` and the two are NOT the same thing: `null` sets
 * "unlimited" (the platform's own meaning for these columns), while omitting the key
 * leaves the stored value alone on a PATCH. Collapsing them would make "remove this cap"
 * unexpressible.
 */
const PlanFields = z.object({
    role: z.enum(BILLING_OWNER_TYPES),
    code: planCode,
    name: z.string().trim().min(2).max(80),
    price: z.number().min(0),
    currency: z.string().trim().toUpperCase().length(3).optional(),
    /** `null` = never expires, which is what the free tier of every role is. */
    termDays: z.number().int().min(1).nullable(),
    creditAllowance: z.number().int().min(0),
    maxActiveProducts: z.number().int().min(0).nullable().optional(),
    maxStorageBytes: z.number().int().min(0).nullable().optional(),
    /** What every future order's split multiplies by. Vendor plans only, in practice. */
    commissionPercent: z.number().min(0).max(100).nullable().optional(),
    maxUnterminatedShipments: z.number().int().min(0).nullable().optional(),
    liveTrackingEnabled: z.boolean().optional(),
    isActive: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
});

/**
 * Create a plan.
 *
 * `role` is REQUIRED here where jovi-mall defaults it to `'vendor'`. A default is right
 * for a self-service caller that only has one role to be; it is wrong for an
 * administrator creating tiers for three of them, where the failure mode is a silent one
 * — an agency plan filed under `vendor`, invisible on the agency catalog, and only
 * noticed when somebody tries to assign it and gets `BILLING_PLAN_ROLE_MISMATCH`.
 *
 * `.strict()` so a mistyped field is a 400 rather than a silent no-op. That matters more
 * on this body than on most: `commissionPercent` misspelled is a plan that quietly prices
 * every order at the platform default.
 */
export const CreatePlanSchema = PlanFields.strict();

/**
 * Edit a plan. `role` and `code` are absent, and being absent from a `.strict()` object
 * means sending one is a 400.
 *
 * jovi-mall `delete`s both keys off the update and carries on. Refusing is the better
 * answer for an administrative client: an operator who sent `code` believes they renamed
 * it, and a 200 that silently discarded the field is how they find out months later.
 */
export const UpdatePlanSchema = PlanFields.omit({ role: true, code: true })
    .partial()
    .strict()
    .refine((body) => Object.keys(body).length > 0, {
        message: 'Send at least one field to change',
    });

// ─────────────────────────────────────────────────────────────────────────────
// Subscriptions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What a subscription list may be ordered by.
 *
 * Unlike the catalog, this collection holds a row per owner per term, so these are real
 * queries against real indexes — `{plan_id: 1, created_at: -1}` and `{created_at: -1}`
 * were added to `subscriber-plan.model.ts` in this change, beside the
 * `{status: 1, expires_at: 1}` the expiry worker already had.
 */
export const SUBSCRIPTION_SORT = {
    createdAt: 'created_at',
    startedAt: 'started_at',
    expiresAt: 'expires_at',
    updatedAt: 'updated_at',
} as const;

/** How far back one page of a subscription list may reach (ADR-005 D-14). */
export const BILLING_MAX_RANGE_DAYS = 366;

/**
 * jovi-mall's subscriber-plan status vocabulary, as a bounded string.
 *
 * The opposite call from `BILLING_OWNER_TYPES` above, deliberately: this service never
 * writes a status. Assigning a plan produces one — jovi-mall decides whether that is
 * `active` or `pending_activation` from the current term's expiry — and the expiry worker
 * produces the other two. ADR-005 D-17: a vocabulary that is not ours is validated for
 * shape, not membership, because a pinned copy goes stale in silence and the failure mode
 * of drift is a filter that matches nothing while answering 200.
 */
const subscriptionStatus = z.string().trim().min(1).max(40).optional();

const subscriptionFilters = {
    status: subscriptionStatus,
    ownerType: z.enum(BILLING_OWNER_TYPES).optional(),
    ...dateRangeFields(),
};

/** `GET /billing/plans/:planId/subscribers` — who is on this plan. */
export const ListPlanSubscribersQuerySchema = listQuery(SUBSCRIPTION_SORT, '-createdAt', {
    ...subscriptionFilters,
}).superRefine(dateRangeRule({ maxDays: BILLING_MAX_RANGE_DAYS }));

/**
 * `GET /billing/subscriptions` — the cross-owner queue.
 *
 * `expiringBefore` is the filter this endpoint exists for. It is an instant rather than a
 * day count for the reason `isoDateTime` documents: "the next seven days" is a different
 * seven days in Douala than in Lisbon, and the client is the only party that knows which.
 */
export const ListSubscriptionsQuerySchema = listQuery(SUBSCRIPTION_SORT, '-createdAt', {
    ...subscriptionFilters,
    ownerId: objectId.optional(),
    planId: objectId.optional(),
    planCode: z.string().trim().min(1).max(40).optional(),
    expiringBefore: isoDateTime.optional(),
}).superRefine(dateRangeRule({ maxDays: BILLING_MAX_RANGE_DAYS }));

/**
 * Assign a plan to an owner.
 *
 * `paymentReference` is jovi-mall's `paymentRef`, renamed on the wire to match the field
 * the subscription DTO reads back. It is optional because this endpoint exists for the
 * case where payment was confirmed out of band, which sometimes has a reference and
 * sometimes is a bank transfer somebody eyeballed.
 *
 * What is NOT validated here: that the plan is active, and that its role matches the
 * owner. jovi-mall checks both (`BILLING_PLAN_INACTIVE` and `BILLING_PLAN_ROLE_MISMATCH`,
 * 409 each) and those are its verdicts to make — a copy here would be a second opinion
 * about what a plan may be assigned to, and the codes reach the dashboard unchanged in
 * `details.platformCode`.
 */
export const AssignSubscriptionSchema = z
    .object({
        planId: objectId,
        paymentReference: z.string().trim().min(1).max(200).optional(),
    })
    .strict();

export type ListPlansQuery = z.infer<typeof ListPlansQuerySchema>;
export type ListPlanSubscribersQuery = z.infer<typeof ListPlanSubscribersQuerySchema>;
export type ListSubscriptionsQuery = z.infer<typeof ListSubscriptionsQuerySchema>;
export type CreatePlanBody = z.infer<typeof CreatePlanSchema>;
export type UpdatePlanBody = z.infer<typeof UpdatePlanSchema>;
export type AssignSubscriptionBody = z.infer<typeof AssignSubscriptionSchema>;
export type SubscriptionOwnerParams = z.infer<typeof SubscriptionOwnerParamSchema>;
