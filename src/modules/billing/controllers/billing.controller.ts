import { Request, Response } from 'express';
import { ObjectId } from 'mongodb';
import { asyncHandler } from '../../../core/http/async-handler';
import { createAppError } from '../../../core/errors/app-error';
import { ERROR_CODES } from '../../../core/errors/error-codes';
import { toPageMeta } from '../../../core/http/list-query';
import { sendCreated, sendMessage, sendPaginated, sendSuccess } from '../../../core/http/responses';
import { actorContextOf } from '../../audit/domain/audit-context';
import { AgencyReadRepository } from '../../agencies/repositories/agency.read.repository';
import { AgentReadRepository } from '../../agents/repositories/agent.read.repository';
import { StoreReadRepository } from '../../vendors/repositories/store.read.repository';
import { VendorReadRepository } from '../../vendors/repositories/vendor.read.repository';
import * as gateway from '../gateways/billing.gateway';
import {
    PricingPlanReadModel,
    PricingPlanReadRepository,
} from '../repositories/pricing-plan.read.repository';
import {
    SubscriberPlanReadModel,
    SubscriberPlanReadRepository,
} from '../repositories/subscriber-plan.read.repository';
import {
    OwnerNames,
    ownerKey,
    toPlanDto,
    toSubscriptionDto,
} from '../read-models/billing.dto';
import {
    AssignSubscriptionBody,
    BillingOwnerType,
    CreatePlanBody,
    ListPlanSubscribersQuery,
    ListPlansQuery,
    ListSubscriptionsQuery,
    SubscriptionOwnerParams,
    UpdatePlanBody,
} from '../validators/billing.validator';

/**
 * `/api/v1/billing` — the subscription catalog and who is on it.
 *
 * Both halves of ADR-004 meet here, split by the refinement ADR-009 D-1 made and this
 * phase applies to money: **read the record, delegate the derivation and every write.**
 * The catalog, the plan detail and the two subscription lists are direct reads of
 * `pricing_plans` and `subscriber_plans`; the four writes go over the internal API,
 * because assigning a plan grants a credit allowance inside the transaction that
 * activates it and emits `plan.activated`, which resizes an agent's capacity in-process.
 *
 * ── Three of the eight routes had no legacy equivalent ────────────────────────
 * The legacy surface was list-only. A plan's `commission_percent` — the multiplier every
 * order's split uses — could be seen only by scanning a page of the catalog, there was no
 * way to ask **who is on a plan** before editing its commission, and no cross-owner view
 * of which terms are about to lapse. All three are reads over collections that were
 * already declared readable in `platform-collections.ts` and read by nothing.
 *
 * ── What this surface deliberately does NOT offer ─────────────────────────────
 *  - **Cancelling or extending a subscription.** The expiry worker owns the lifecycle,
 *    and a hand-written `expires_at` would either skip the `plan.activated` emission that
 *    resizes capacity or fire it twice. Assigning a plan is the lever, and it is the one
 *    with the transaction behind it.
 *  - **An entitlements endpoint.** It exists internally
 *    (`GET /api/internal/admin/billing/entitlements/:ownerType/:ownerId`, added at step 1)
 *    and is a delegated verdict — but it is read *in context*, on the account view, beside
 *    the plan that grants it. A standalone route would answer numbers with nothing to
 *    compare them against.
 *  - **Editing `billing_settings`.** It is the owner's own notice preference. An
 *    administrator changing when somebody is warned about their own expiry is not an
 *    administrative act; it is impersonation.
 */

const plans = new PricingPlanReadRepository();
const subscriptions = new SubscriberPlanReadRepository();

// The owner directories, for the display names a subscription row cannot carry. Owned by
// the modules that own those collections — `delivery_agents` holds `legal_identity` and
// `payout_details`, so a second projection of it declared here would be a second thing to
// get right. Same rule `hydrateNames` follows in the shipment controller.
const vendors = new VendorReadRepository();
const stores = new StoreReadRepository();
const agencies = new AgencyReadRepository();
const agents = new AgentReadRepository();

/**
 * Load a plan or 404 — and return the row, because every write needs it twice: to refuse a
 * request against a plan that does not exist, and as the audit `before`.
 *
 * Reading before delegating costs one indexed lookup and buys the two things the gateway
 * cannot get from jovi-mall's answer: the previous state, and a 404 that says "no such
 * plan" rather than a `PLATFORM_OPERATION_REJECTED` wrapping one.
 */
async function loadPlanOr404(planId: string): Promise<PricingPlanReadModel> {
    const plan = await plans.findById(planId);
    if (!plan) throw createAppError(ERROR_CODES.NOT_FOUND, 404, 'Pricing plan not found');
    return plan;
}

/**
 * The fields a write can change, as the audit row's `before` — in the same camelCase the
 * gateway's `planState` emits for the `after`, so the two halves of one row line up.
 *
 * `role` and `code` are here despite being immutable: they are what
 * `billing.gateway.ts#labelOf` builds the row's label from, and a feed six months later
 * has to name the plan without a join into the other database.
 */
function toPlanAuditState(plan: PricingPlanReadModel): Record<string, unknown> {
    return {
        role: plan.role,
        code: plan.code,
        name: plan.name,
        price: plan.price,
        isActive: plan.is_active ?? true,
        commissionPercent: plan.commission_percent ?? null,
        archivedAt: plan.deletedAt ? plan.deletedAt.toISOString() : null,
    };
}

/** The same, for the subscription an assignment is about to replace. */
function toSubscriptionAuditState(row: SubscriberPlanReadModel | null): Record<string, unknown> | null {
    if (!row) return null;
    return {
        planCode: row.plan_code ?? null,
        status: row.status,
        expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
    };
}

/**
 * Display names for a page of subscriptions — one batched read per owner type present.
 *
 * The name is the BUSINESS one wherever there is one: a vendor's Store, an agency's
 * Magazin. That is what the owner is called on every other screen, and `display_name` on
 * either row is a contact person. An agent has no business identity, so their own name is
 * the answer and `AgentReadRepository` already resolves it.
 *
 * A page containing one owner type costs one query; a mixed page costs three. Never one
 * per row.
 */
async function hydrateOwnerNames(rows: SubscriberPlanReadModel[]): Promise<OwnerNames> {
    const idsFor = (type: string): ObjectId[] =>
        [
            ...new Set(
                rows.filter((row) => row.owner_type === type).map((row) => row.owner_id.toString()),
            ),
        ].map((id) => new ObjectId(id));

    const vendorIds = idsFor('vendor');
    const agencyIds = idsFor('agency');
    const agentIds = idsFor('agent');

    const [vendorStores, agencyNames, agentNames] = await Promise.all([
        stores.findForVendors(vendorIds),
        agencies.findNamesByIds(agencyIds),
        agents.findNamesByIds(agentIds),
    ]);

    const names: OwnerNames = new Map();
    vendorStores.forEach((store, vendorId) => {
        names.set(ownerKey('vendor', vendorId), store.name ?? null);
    });
    agencyNames.forEach((name, agencyId) => names.set(ownerKey('agency', agencyId), name));
    agentNames.forEach((name, agentId) => names.set(ownerKey('agent', agentId), name));

    return names;
}

/**
 * Confirm the owner exists, and return how a feed should name them.
 *
 * `ACCOUNT_OWNER_NOT_FOUND` rather than the generic `NOT_FOUND`: on a path carrying
 * `:ownerType/:ownerId`, "not found" alone leaves an operator unable to tell a mistyped id
 * from an id belonging to the wrong kind of owner — pasting an agency id under
 * `/vendor/` is the obvious way to get here.
 */
async function loadOwnerLabelOr404(
    ownerType: BillingOwnerType,
    ownerId: string,
): Promise<string | null> {
    if (ownerType === 'vendor') {
        const vendor = await vendors.findById(ownerId);
        if (!vendor) throw ownerNotFound(ownerType);
        const store = await stores.findForVendor(ownerId);
        return store?.name ?? vendor.display_name ?? null;
    }

    if (ownerType === 'agency') {
        const agency = await agencies.findById(ownerId);
        if (!agency) throw ownerNotFound(ownerType);
        return agency.magazin?.name ?? agency.display_name ?? null;
    }

    // `name`, not `display_name` — that is the agency's field. `delivery_agents` carries a
    // person's own name and nothing else; an agent has no business identity to fall back on.
    const agent = await agents.findById(ownerId);
    if (!agent) throw ownerNotFound(ownerType);
    return agent.name ?? null;
}

function ownerNotFound(ownerType: BillingOwnerType): Error {
    return createAppError(
        ERROR_CODES.ACCOUNT_OWNER_NOT_FOUND,
        404,
        `No ${ownerType} with that id`,
    );
}

export class BillingController {
    /**
     * GET /api/v1/billing/plans — the catalog, every role at once by default.
     *
     * jovi-mall's legacy endpoint fanned out one query per role and flattened the results,
     * which is the same answer through three round trips; one filter does it here.
     */
    static listPlans = asyncHandler(async (req: Request, res: Response) => {
        const query = req.query as unknown as ListPlansQuery;

        const page = await plans.search({
            role: query.role,
            isActive: query.isActive,
            includeArchived: query.includeArchived,
            search: query.search,
            page: query.page,
            limit: query.limit,
            sort: query.sort,
        });

        sendPaginated(res, page.items.map(toPlanDto), toPageMeta(page.total, page.page, page.limit));
    });

    /**
     * GET /api/v1/billing/plans/:planId — net-new.
     *
     * The catalog was list-only, so a plan's `commission_percent` could be read only by
     * finding its row in a page — and it is the number every future order's split
     * multiplies by. Archived plans answer here rather than 404ing; see the repository.
     */
    static getPlan = asyncHandler(async (req: Request, res: Response) => {
        sendSuccess(res, toPlanDto(await loadPlanOr404(req.params.planId)));
    });

    /**
     * GET /api/v1/billing/plans/:planId/subscribers — net-new: who is on this plan.
     *
     * The question asked immediately before editing a plan's commission, and one the
     * platform could not answer about itself: every read of `subscriber_plans` in
     * jovi-mall is scoped to a single owner.
     *
     * The plan id comes from the path and is not a filter a caller can widen — the
     * validator's query shape carries no `planId`.
     */
    static listPlanSubscribers = asyncHandler(async (req: Request, res: Response) => {
        const query = req.query as unknown as ListPlanSubscribersQuery;

        // 404 first: a subscriber list for a plan that does not exist should say so, not
        // answer an empty page that reads as "nobody is on it".
        const plan = await loadPlanOr404(req.params.planId);

        const page = await subscriptions.search({
            planId: req.params.planId,
            ownerType: query.ownerType,
            status: query.status,
            from: query.from,
            to: query.to,
            page: query.page,
            limit: query.limit,
            sort: query.sort,
        });

        const owners = await hydrateOwnerNames(page.items);
        const planRefs = new Map([
            [
                plan._id.toString(),
                { id: plan._id.toString(), code: plan.code, name: plan.name, role: plan.role },
            ],
        ]);

        sendPaginated(
            res,
            page.items.map((row) => toSubscriptionDto(row, planRefs, owners)),
            toPageMeta(page.total, page.page, page.limit),
        );
    });

    /**
     * GET /api/v1/billing/subscriptions — net-new: the cross-owner queue.
     *
     * Two questions in one endpoint, both of which needed a query nothing in the platform
     * had: which terms are about to lapse (`expiringBefore`), and which owners have a plan
     * queued behind their current one (`status=pending_activation`) — the second being the
     * state that silently becomes active without anybody acting.
     */
    static listSubscriptions = asyncHandler(async (req: Request, res: Response) => {
        const query = req.query as unknown as ListSubscriptionsQuery;

        const page = await subscriptions.search({
            ownerType: query.ownerType,
            ownerId: query.ownerId,
            planId: query.planId,
            planCode: query.planCode,
            status: query.status,
            expiringBefore: query.expiringBefore,
            from: query.from,
            to: query.to,
            page: query.page,
            limit: query.limit,
            sort: query.sort,
        });

        const planIds = [...new Set(page.items.map((row) => row.plan_id.toString()))].map(
            (id) => new ObjectId(id),
        );

        const [planRefs, owners] = await Promise.all([
            plans.findRefsByIds(planIds),
            hydrateOwnerNames(page.items),
        ]);

        sendPaginated(
            res,
            page.items.map((row) => toSubscriptionDto(row, planRefs, owners)),
            toPageMeta(page.total, page.page, page.limit),
        );
    });

    /**
     * GET /api/v1/billing/subscriptions/:ownerType/:ownerId — every term one owner holds.
     *
     * ── Why this is not the cross-owner list filtered by owner ─────────────────
     * An owner holds SEVERAL rows at once: one `active`, optionally one
     * `pending_activation` queued behind it, plus the history. The list can be filtered to
     * them, but it is server-paginated, so an owner's rows can straddle a page boundary —
     * a client grouping them groups *some* of their terms and has no way to know it did.
     *
     * And "which one is live" is a judgement the client should not be making. `status` is
     * the platform's vocabulary and this service never writes it, so a client ranking an
     * open list of values guesses, and its guess changes silently when a fifth value
     * appears upstream. Here `current` is the row that actually says `active`, which a
     * partial unique index upstream guarantees is at most one.
     *
     * ⚠ `current: null` means the owner has no active plan — NOT "we could not determine
     * it". The same fact `GET /accounts/:ownerType/:ownerId` reports by setting the whole
     * subscription block's fields to `null` together.
     *
     * Unpaginated, and `meta.total` is the count rather than a page size: an owner
     * accumulates one term per renewal, which is single digits over a platform's lifetime.
     */
    static listSubscriptionsForOwner = asyncHandler(async (req: Request, res: Response) => {
        const { ownerType, ownerId } = req.params as { ownerType: BillingOwnerType; ownerId: string };

        // 404s on an owner that does not exist, so "no such vendor" and "this vendor has
        // never had a plan" are distinguishable — the second is an ordinary state and the
        // first is a broken link.
        const ownerName = await loadOwnerLabelOr404(ownerType, ownerId);

        const rows = await subscriptions.listAllForOwner(ownerType, ownerId);

        const planIds = [...new Set(rows.map((row) => row.plan_id.toString()))].map(
            (id) => new ObjectId(id),
        );
        const planRefs = await plans.findRefsByIds(planIds);
        const owners: OwnerNames = new Map([[ownerKey(ownerType, ownerId), ownerName]]);

        const dtos = rows.map((row) => toSubscriptionDto(row, planRefs, owners));

        /**
         * Partitioned by the platform's own status, never by recency.
         *
         * `expiresAt` is deliberately not consulted: `null` there is the never-expiring
         * free tier rather than "unknown", so ordering by it puts the free tier either
         * first or last depending on the comparison and neither is meaningful.
         *
         * An unrecognised status falls into `history` rather than being dropped — a row
         * this service cannot classify is still a row the owner has.
         */
        const current = dtos.find((row) => row.status === 'active') ?? null;
        const queued = dtos.find((row) => row.status === 'pending_activation') ?? null;
        const history = dtos.filter((row) => row !== current && row !== queued);

        sendSuccess(
            res,
            {
                owner: { type: ownerType, id: ownerId, name: ownerName },
                current,
                queued,
                history,
            },
            { meta: { total: dtos.length } },
        );
    });

    /**
     * GET /api/v1/billing/subscriptions/:subscriptionId — one term, by its own id.
     *
     * Makes a subscription ADDRESSABLE, which it was not: an operator could not link a
     * colleague to one, and a `paymentReference` quoted in a support ticket had nowhere to
     * point.
     *
     * No path collision with the owner-scoped read above: that one takes two segments and
     * this takes one.
     */
    static getSubscription = asyncHandler(async (req: Request, res: Response) => {
        const row = await subscriptions.findById(req.params.subscriptionId);
        if (!row) {
            throw createAppError(ERROR_CODES.NOT_FOUND, 404, 'Subscription not found');
        }

        const [planRefs, owners] = await Promise.all([
            plans.findRefsByIds([row.plan_id]),
            hydrateOwnerNames([row]),
        ]);

        sendSuccess(res, toSubscriptionDto(row, planRefs, owners));
    });

    /**
     * POST /api/v1/billing/plans — create a tier.
     *
     * 201, because this one genuinely creates a resource — the only route on this mount
     * that does. A duplicate code is jovi-mall's `409 BILLING_PLAN_CODE_EXISTS`, reaching
     * the dashboard in `details.platformCode`.
     */
    static createPlan = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as CreatePlanBody;

        const created = await gateway.createPlan(body, actorContextOf(req));

        sendCreated(res, created, { message: `Plan ${body.code} created` });
    });

    /**
     * PATCH /api/v1/billing/plans/:planId
     *
     * The audit row is the only history a plan's numbers have: jovi-mall keeps no previous
     * version of a commission. `before` comes from the read a line above, which is why the
     * 404 and the diff are one lookup rather than two.
     */
    static updatePlan = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as UpdatePlanBody;
        const before = await loadPlanOr404(req.params.planId);

        const updated = await gateway.updatePlan(
            req.params.planId,
            body,
            toPlanAuditState(before),
            actorContextOf(req),
        );

        sendSuccess(res, updated, { message: 'Plan updated' });
    });

    /**
     * DELETE /api/v1/billing/plans/:planId — archive it.
     *
     * A soft delete: the row stays, `deletedAt` is stamped, and every owner already on the
     * tier keeps running on it until their term ends. The message says "archived" rather
     * than "deleted" for that reason, and `?includeArchived=true` is how the row is read
     * afterwards.
     *
     * `sendMessage` rather than `sendSuccess(res, null)`: jovi-mall answers no body, and
     * an envelope whose `data` is null with nothing else in it tells the dashboard nothing.
     */
    static deletePlan = asyncHandler(async (req: Request, res: Response) => {
        const before = await loadPlanOr404(req.params.planId);

        await gateway.deletePlan(
            req.params.planId,
            toPlanAuditState(before),
            actorContextOf(req),
        );

        sendMessage(res, `Plan ${before.code} archived — existing subscribers keep it until their term ends`);
    });

    /**
     * POST /api/v1/billing/subscriptions/:ownerType/:ownerId — assign a plan.
     *
     * jovi-mall's three `/{vendors,agencies,agents}/:id/plan` routes, collapsed into one.
     * The owner type is a path segment rather than a body field because it selects which
     * of those three the gateway calls and which of the three audit actions the row
     * carries — and an audit action is not something a request body should be able to pick.
     *
     * Three reads precede the delegation, and each buys something the gateway cannot get
     * from jovi-mall's answer:
     *
     *   the owner   a `ACCOUNT_OWNER_NOT_FOUND` that names the owner type, and the label
     *               that makes the row readable on `/vendors/:id/activity`
     *   the plan    a 404 for a plan that does not exist, and the tier's `role:code` for
     *               the payload — the plan lives in the other database, so a feed rendered
     *               from this row cannot look it up later
     *   the current the `before` diff, so the row says what the owner moved FROM
     *   subscription
     *
     * What is NOT re-checked here: that the plan is active and that its role matches the
     * owner. jovi-mall answers both (`BILLING_PLAN_INACTIVE`, `BILLING_PLAN_ROLE_MISMATCH`,
     * 409 each) and they are its verdicts to make.
     */
    static assignSubscription = asyncHandler(async (req: Request, res: Response) => {
        const { ownerType, ownerId } = req.params as unknown as SubscriptionOwnerParams;
        const body = req.body as AssignSubscriptionBody;

        const [ownerLabel, plan] = await Promise.all([
            loadOwnerLabelOr404(ownerType, ownerId),
            loadPlanOr404(body.planId),
        ]);

        const current = await subscriptions.findActiveForOwner(ownerType, ownerId);

        const assigned = await gateway.assignSubscription(
            ownerType,
            ownerId,
            body,
            { ownerLabel, planLabel: `${plan.role}:${plan.code}` },
            toSubscriptionAuditState(current),
            actorContextOf(req),
        );

        sendSuccess(res, assigned, { message: `Plan ${plan.code} assigned to the ${ownerType}` });
    });
}
