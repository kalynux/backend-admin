import { platformRequest } from '../../../infra/platform/platform.client';
import { auditedAttempt } from '../../audit/domain/audit.writer';
import { ActorContext } from '../../audit/domain/audit-context';
import { AuditAction } from '../../audit/domain/audit.catalog';
import { AuditTarget } from '../../audit/domain/audit.types';
import { BillingOwnerType, CreatePlanBody, UpdatePlanBody } from '../validators/billing.validator';

/**
 * The billing domain's WRITE half, reached over jovi-mall's internal admin API.
 *
 * ── Why a plan write is delegated when the catalog read is not ────────────────
 * Not for symmetry, and not because the insert is hard. Three reasons, in ascending order
 * of how badly a second writer would fail:
 *
 *  1. `pricing_plans` enforces one code per role through a **partial** unique index
 *     (`deletedAt: null`), and jovi-mall turns its 11000 into
 *     `BILLING_PLAN_CODE_EXISTS`. A second writer reproduces the insert and reports the
 *     collision as an opaque database error.
 *  2. Editing a plan is not editing a record. `commission_percent` is the multiplier every
 *     future order's split uses, and `max_active_products` can put a vendor over their cap
 *     retroactively.
 *  3. **Assigning** one is a transaction paired with a post-commit event. It expires the
 *     current term, grants the plan's credit allowance exactly once inside the same
 *     transaction that activates it — or queues the new plan as `pending_activation` when
 *     the current one still has time left — and emits `plan.activated`, which
 *     `AgentPlanCapacityConsumer` reads in-process to resize an agent's
 *     `capacity.max_active_shipments`. A second writer would move the rows and leave every
 *     agent on that plan carrying their old capacity, silently.
 *
 * The thin methods below are the whole point: this file should never grow logic.
 */

/** What the thing looked like before the write, captured from the caller's own read. */
export type BillingSnapshot = Record<string, unknown> | null;

/**
 * Wrap a delegated billing mutation in an audit intent.
 *
 * In the gateway rather than the controller, matching every other gateway here: this is
 * the transport boundary, every delegated write leaves through `platformRequest` a few
 * lines below, and wrapping here means a method added later inherits auditing by
 * construction rather than by its author remembering.
 *
 * The `target` is a whole `AuditTarget` rather than an id, which is the one shape
 * difference from the agency and shipment gateways. This module writes against **four**
 * target types — `plan` for the catalog, and `vendor`/`agency`/`agent` for an assignment —
 * so the type cannot be a constant in this function the way `'agency'` is in that one.
 *
 * Intent → outcome rather than a transaction, because the write lands in jovi-mall's
 * database inside jovi-mall's transaction, which a `wi-admin` ClientSession cannot join.
 * The intent row commits FIRST — if that fails the HTTP call is never made — and the
 * outcome is stamped when jovi-mall answers.
 */
function auditedDelegation<T>(
    action: AuditAction,
    context: ActorContext,
    target: AuditTarget,
    payload: Record<string, unknown> | null,
    before: BillingSnapshot,
    asState: (result: T) => Record<string, unknown> | null,
    perform: () => Promise<{ result: T; target?: Partial<AuditTarget> }>,
): Promise<T> {
    return auditedAttempt(
        {
            action,
            actor: {
                kind: 'administrator',
                id: context.actor.adminId,
                email: context.actor.email,
                displayName: context.actor.displayName,
                tier: context.actor.tier,
                sessionId: context.actor.sessionId,
            },
            target,
            context: {
                method: context.method,
                path: context.path,
                requestId: context.requestId,
                ip: context.ip,
                userAgent: context.userAgent,
            },
            payload,
        },
        async () => {
            const outcome = await perform();
            return {
                result: outcome.result,
                target: outcome.target,
                before,
                after: asState(outcome.result),
            };
        },
    );
}

/**
 * Reduce jovi-mall's answer to the fields worth diffing — **in the controller's spelling**.
 *
 * Two functions rather than one that inspects the response, because this gateway's four
 * writes return two different documents and guessing which is which from the keys present
 * is a discrimination that fails quietly the first time either schema gains a field.
 *
 * The keys are the CAMELCASE ones `toAuditState` uses on the way in. That is the whole
 * point of mapping rather than passing the response through: `before` is read out of
 * `jovi_mall` by this service and `after` comes back over HTTP, so a row storing
 * `commissionPercent` beside `commission_percent` renders as every field having changed.
 * The agency gateway aligns the two halves the same way.
 *
 * An empty state is `null` rather than `{}`, and `DELETE /plans/:id` produces exactly
 * that: jovi-mall answers `data: null`, so the record of what was archived is entirely the
 * `before` on the same row.
 */
function planState(result: PlatformPlan | null): Record<string, unknown> | null {
    if (!result || typeof result !== 'object') return null;
    return {
        role: result.role ?? null,
        code: result.code ?? null,
        name: result.name ?? null,
        price: result.price ?? null,
        isActive: result.is_active ?? null,
        commissionPercent: result.commission_percent ?? null,
        archivedAt: result.deletedAt ?? null,
    };
}

function subscriptionState(result: PlatformSubscription | null): Record<string, unknown> | null {
    if (!result || typeof result !== 'object') return null;
    return {
        planCode: result.plan_code ?? null,
        status: result.status ?? null,
        expiresAt: result.expires_at ?? null,
    };
}

/** jovi-mall's `IPricingPlan`, as much of it as this gateway names. */
export interface PlatformPlan {
    _id?: string;
    role?: string;
    code?: string;
    name?: string;
    price?: number;
    is_active?: boolean;
    commission_percent?: number | null;
    deletedAt?: string | null;
    [key: string]: unknown;
}

/** jovi-mall's `ISubscriberPlan`, as much of it as this gateway names. */
export interface PlatformSubscription {
    _id?: string;
    plan_code?: string;
    status?: string;
    expires_at?: string | null;
    [key: string]: unknown;
}

/**
 * camelCase in, snake_case out — the only place the plan body's two spellings meet.
 *
 * Built key by key on `!== undefined` rather than by spreading the parsed body, because
 * `null` and "absent" mean different things on a PATCH: `null` clears a cap to
 * "unlimited", absent leaves the stored value alone. A spread through `JSON.stringify`
 * would drop `undefined` and get the same answer by accident; doing it here makes the
 * rule visible and lets `test-billing.ts` assert it.
 */
function toPlatformPlanBody(input: Partial<CreatePlanBody>): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    const set = (key: string, value: unknown): void => {
        if (value !== undefined) body[key] = value;
    };

    set('role', input.role);
    set('code', input.code);
    set('name', input.name);
    set('price', input.price);
    set('currency', input.currency);
    set('term_days', input.termDays);
    set('credit_allowance', input.creditAllowance);
    set('max_active_products', input.maxActiveProducts);
    set('max_storage_bytes', input.maxStorageBytes);
    set('commission_percent', input.commissionPercent);
    set('max_unterminated_shipments', input.maxUnterminatedShipments);
    set('live_tracking_enabled', input.liveTrackingEnabled);
    set('is_active', input.isActive);
    set('sort_order', input.sortOrder);

    return body;
}

// ─────────────────────────────────────────────────────────────────────────────
// The plan catalog
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a pricing plan.
 *
 * The intent's target id is `null` and is filled in from the response — the
 * `administrators.create` pattern, and the only shape an audited create can take, since
 * the id does not exist when the row is written. The `label` carries the code from the
 * request, so even a create that FAILS leaves a row naming what was attempted.
 *
 * A duplicate code is `409 BILLING_PLAN_CODE_EXISTS`, which reaches the dashboard
 * unchanged in `details.platformCode`.
 */
export async function createPlan(
    input: CreatePlanBody,
    context: ActorContext,
): Promise<PlatformPlan> {
    return auditedDelegation(
        'billing.plans.create',
        context,
        { type: 'plan', id: null, label: `${input.role}:${input.code}` },
        // The whole validated body. Unlike a reason or a status, a plan's fields ARE the
        // action — "created a plan" without them records that something was priced.
        { ...input },
        null,
        planState,
        async () => {
            const result = await platformRequest<PlatformPlan>({
                method: 'POST',
                path: '/billing/plans',
                body: toPlatformPlanBody(input),
                actor: context.actor,
                requestId: context.requestId,
            });
            return {
                result: result.data,
                target: { id: result.data?._id ? String(result.data._id) : null },
            };
        },
    );
}

/**
 * Edit a pricing plan.
 *
 * `before` is the caller's own read of the plan, and on this action it is the only history
 * those numbers have: jovi-mall keeps no version of a plan's previous commission.
 */
export async function updatePlan(
    planId: string,
    input: UpdatePlanBody,
    before: BillingSnapshot,
    context: ActorContext,
): Promise<PlatformPlan> {
    return auditedDelegation(
        'billing.plans.update',
        context,
        { type: 'plan', id: planId, label: labelOf(before) },
        { ...input },
        before,
        planState,
        async () => {
            const result = await platformRequest<PlatformPlan>({
                method: 'PATCH',
                path: `/billing/plans/${planId}`,
                body: toPlatformPlanBody(input),
                actor: context.actor,
                requestId: context.requestId,
            });
            return { result: result.data };
        },
    );
}

/**
 * Archive a pricing plan — jovi-mall's soft delete.
 *
 * Existing subscribers are untouched: the row stays, `deletedAt` is stamped, and every
 * owner already on the tier keeps running on it until their term ends. That is why the
 * audit action is worded "archived" and why the catalog read has an `includeArchived`
 * filter — the plan a subscription names may no longer be in the default list.
 *
 * jovi-mall answers `data: null` here, so the record of what was archived is entirely the
 * `before` on this row.
 */
export async function deletePlan(
    planId: string,
    before: BillingSnapshot,
    context: ActorContext,
): Promise<null> {
    return auditedDelegation(
        'billing.plans.delete',
        context,
        { type: 'plan', id: planId, label: labelOf(before) },
        null,
        before,
        planState,
        async () => {
            await platformRequest<null>({
                method: 'DELETE',
                path: `/billing/plans/${planId}`,
                actor: context.actor,
                requestId: context.requestId,
            });
            return { result: null };
        },
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Subscriptions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * jovi-mall keeps three paths that differ only in which owner type they name, because its
 * public mount's URLs are live. This is the three-line switch that collapses them into one
 * route here — routing, not logic.
 */
const ASSIGN_PATH: Record<BillingOwnerType, (ownerId: string) => string> = {
    vendor: (ownerId) => `/billing/vendors/${ownerId}/plan`,
    agency: (ownerId) => `/billing/agencies/${ownerId}/plan`,
    agent: (ownerId) => `/billing/agents/${ownerId}/plan`,
};

/**
 * One audit action per owner type, and this is the decision worth reading twice.
 *
 * `AuditActionSpec.target` is a single `AuditTargetType`, and `buildQueryFilter` in the
 * audit repository matches on `target_type`/`target_id` only — it does **not** consult
 * `related_target_*`. A single `billing.subscriptions.assign` action targeting `plan`,
 * with the owner carried as a related target, would therefore be **invisible on
 * `GET /vendors/:id/activity`** — the one feed somebody actually opens when asking what
 * happened to a vendor's billing. Three actions puts each row on its subject's own feed.
 *
 * Same reasoning as `agents.unban` being its own action rather than `agents.ban` with a
 * flag, and it is asserted end to end by step 7 of the manual checklist.
 */
const ASSIGN_ACTION: Record<BillingOwnerType, AuditAction> = {
    vendor: 'billing.subscriptions.assign_vendor',
    agency: 'billing.subscriptions.assign_agency',
    agent: 'billing.subscriptions.assign_agent',
};

/**
 * Assign a plan to a vendor, agency or agent.
 *
 * `before` is the owner's CURRENT subscription, read by the controller — which is what
 * makes this row answer "moved from what to what" rather than only "was given a plan".
 *
 * The refusals are jovi-mall's and are inherited rather than re-checked here: an inactive
 * plan is `409 BILLING_PLAN_INACTIVE`, a plan belonging to another role is
 * `409 BILLING_PLAN_ROLE_MISMATCH`, and an owner who already has a queued term is
 * `409 BILLING_PENDING_PLAN_EXISTS`. Each reaches the dashboard in `details.platformCode`.
 *
 * `paymentReference` is renamed to jovi-mall's `paymentRef` here and nowhere else.
 */
export async function assignSubscription(
    ownerType: BillingOwnerType,
    ownerId: string,
    input: { planId: string; paymentReference?: string },
    audit: { ownerLabel: string | null; planLabel: string | null },
    before: BillingSnapshot,
    context: ActorContext,
): Promise<PlatformSubscription> {
    return auditedDelegation(
        ASSIGN_ACTION[ownerType],
        context,
        { type: ownerType, id: ownerId, label: audit.ownerLabel },
        // `plan` names the tier assigned. Without it the row says an owner's plan changed
        // and not to what — and the plan lives in the other database, so a feed rendered
        // from this row cannot look it up.
        {
            planId: input.planId,
            plan: audit.planLabel,
            paymentReference: input.paymentReference ?? null,
        },
        before,
        subscriptionState,
        async () => {
            const result = await platformRequest<PlatformSubscription>({
                method: 'POST',
                path: ASSIGN_PATH[ownerType](ownerId),
                body: { planId: input.planId, paymentRef: input.paymentReference },
                actor: context.actor,
                requestId: context.requestId,
            });
            return { result: result.data };
        },
    );
}

/**
 * How an administrator recognises a plan in a feed: `role:code`.
 *
 * The code rather than the display name, because the code is what the platform looks a
 * tier up by and what an operator quotes; the name is marketing copy that can change
 * under a live subscription. The role is in front because a code is only unique within
 * one — `free` exists three times.
 *
 * Read off the caller's own `toAuditState`, so the label and the `before` diff cannot
 * describe two different plans.
 */
function labelOf(before: BillingSnapshot): string | null {
    if (!before) return null;
    const role = typeof before.role === 'string' ? before.role : null;
    const code = typeof before.code === 'string' ? before.code : null;
    if (!code) return null;
    return role ? `${role}:${code}` : code;
}
