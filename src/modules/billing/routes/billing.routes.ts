import { Router } from 'express';
import { defineRoute, permission, records } from '../../../api/route-manifest';
import { BillingController } from '../controllers/billing.controller';
import {
    AssignSubscriptionSchema,
    CreatePlanSchema,
    ListPlanSubscribersQuerySchema,
    ListPlansQuerySchema,
    ListSubscriptionsQuerySchema,
    PlanIdParamSchema,
    SubscriptionIdParamSchema,
    SubscriptionOwnerParamSchema,
    UpdatePlanSchema,
} from '../validators/billing.validator';

/**
 * `/api/v1/billing` — the subscription catalog, and who is on it.
 *
 * Five ports of the seven legacy billing rows plus three net-new reads. The other two
 * legacy rows are not missing: `POST /{vendors,agencies,agents}/:id/plan` were three paths
 * for one capability, and they land here as the single
 * `POST /subscriptions/:ownerType/:ownerId`, with the gateway picking jovi-mall's path.
 *
 * ── Read and write hold different permissions, and delete holds a third ───────
 * `billing.plans.read` is the whole read half — the catalog, a plan, its subscribers and
 * the cross-owner queue — and reaches Support through nothing: `allInFamily('billing')` is
 * in the tier-2 grant, and Support's list does not include the family. The writes split
 * three ways: `billing.plans.manage` for create and edit, `billing.plans.delete` (flagged
 * `destructive`, so `allInFamily` refuses to expand it and a human had to type it into the
 * tier-2 list by name), and `billing.subscriptions.assign` (flagged `financial` — it
 * changes what somebody is billed).
 *
 * ── Route order ──────────────────────────────────────────────────────────────
 * `/plans` and `/subscriptions` are distinct first segments, and every sub-route under
 * `/plans/:planId` sits at a deeper path, so Express matches them without ambiguity. Keep
 * it that way: a future literal SIBLING of `/:planId` — say `/plans/export` — MUST be
 * declared above it, or it is read as a plan id.
 */
const router = Router();
const mountedAt = '/billing';

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/plans',
    access: permission('billing.plans.read'),
    validate: { query: ListPlansQuerySchema },
    handler: BillingController.listPlans,
});

/**
 * The plan detail — net-new. The legacy catalog was list-only, so `commission_percent`,
 * the multiplier every future order's split uses, could be read only by finding the row
 * in a page.
 */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/plans/:planId',
    access: permission('billing.plans.read'),
    validate: { params: PlanIdParamSchema },
    handler: BillingController.getPlan,
});

/**
 * Who is on this plan — net-new, and the read that belongs immediately before an edit to
 * its commission.
 *
 * `billing.plans.read` alone, deliberately. The rows name owners, but they name them the
 * way a subscription does — an id, a type and a display name — and carry nothing from the
 * vendor, agency or agent record that `vendors.read` / `agencies.read` / `agents.read`
 * exist to gate. Compare `/agencies/:id/agents`, which DOES require `agents.read`, because
 * its rows carry KYC and ban state off the agent documents themselves.
 */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/plans/:planId/subscribers',
    access: permission('billing.plans.read'),
    validate: { params: PlanIdParamSchema, query: ListPlanSubscribersQuerySchema },
    handler: BillingController.listPlanSubscribers,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/plans',
    access: permission('billing.plans.manage'),
    validate: { body: CreatePlanSchema },
    audit: records('billing.plans.create'),
    handler: BillingController.createPlan,
});

defineRoute(router, {
    mountedAt,
    method: 'patch',
    path: '/plans/:planId',
    access: permission('billing.plans.manage'),
    validate: { params: PlanIdParamSchema, body: UpdatePlanSchema },
    audit: records('billing.plans.update'),
    handler: BillingController.updatePlan,
});

/**
 * DELETE rather than a POST sub-resource, and that is the opposite call from
 * `/agencies/:id/deactivate`.
 *
 * The rule ADR-005 D-2 states is that the permission and the audit row attach to the
 * ACTION — which is why an agency's three status moves are three POSTs rather than one
 * PATCH. It says nothing against a verb that already means what the action is. There is
 * exactly one way to remove a plan from the catalog, it holds its own permission and its
 * own audit action, and DELETE is what it is. jovi-mall spells it the same way.
 */
defineRoute(router, {
    mountedAt,
    method: 'delete',
    path: '/plans/:planId',
    access: permission('billing.plans.delete'),
    validate: { params: PlanIdParamSchema },
    audit: records('billing.plans.delete'),
    handler: BillingController.deletePlan,
});

/**
 * The cross-owner subscription queue — net-new.
 *
 * Declared above `POST /subscriptions/:ownerType/:ownerId` for readability rather than
 * necessity: they differ in method, and Express would not confuse a two-segment path with
 * a bare one in any case.
 */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/subscriptions',
    access: permission('billing.plans.read'),
    validate: { query: ListSubscriptionsQuerySchema },
    handler: BillingController.listSubscriptions,
});

/**
 * One route where jovi-mall keeps three.
 *
 * `:ownerType` is a path segment rather than a body field because it selects which of
 * jovi-mall's three paths the gateway calls AND which of the three audit actions the row
 * carries — and which action is recorded is not something a request body should pick. The
 * three actions exist because the audit query filters on `target_type`/`target_id` and
 * does not consult `related_target_*`, so a single action targeting the plan would be
 * invisible on `GET /vendors/:id/activity`.
 */
/**
 * One subscription by its own id — declared BEFORE the two-segment owner read below.
 *
 * Express matches on segment count, so the two cannot shadow each other; the order is for
 * a reader rather than the router.
 */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/subscriptions/:subscriptionId',
    access: permission('billing.plans.read'),
    validate: { params: SubscriptionIdParamSchema },
    handler: BillingController.getSubscription,
});

/**
 * Every term one owner holds, partitioned by the platform's own status.
 *
 * The same path shape as the POST below, so assign and read are symmetric. The value over
 * `GET /subscriptions?ownerId=` is that `current` is the PLATFORM's determination rather
 * than a client's ranking of an open status vocabulary over one page — see the controller.
 */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/subscriptions/:ownerType/:ownerId',
    access: permission('billing.plans.read'),
    validate: { params: SubscriptionOwnerParamSchema },
    handler: BillingController.listSubscriptionsForOwner,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/subscriptions/:ownerType/:ownerId',
    access: permission('billing.subscriptions.assign'),
    validate: { params: SubscriptionOwnerParamSchema, body: AssignSubscriptionSchema },
    audit: records('billing.subscriptions.assign_vendor', 'billing.subscriptions.assign_agency', 'billing.subscriptions.assign_agent'),
    handler: BillingController.assignSubscription,
});

export const billingRoutes = router;
