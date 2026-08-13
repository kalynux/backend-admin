import { platformRequest } from '../../../infra/platform/platform.client';
import { auditedAttempt } from '../../audit/domain/audit.writer';
import { ActorContext } from '../../audit/domain/audit-context';
import { AuditAction } from '../../audit/domain/audit.catalog';

/**
 * The order domain's WRITE half, reached over jovi-mall's internal admin API.
 *
 * ── Why an order write is delegated when the read is not ──────────────────────
 * The read is a query and protects nothing. Each of these four is the opposite, and none
 * of them is a status column:
 *
 *  - **cancel** runs six guards that span three collections (the fulfilment window, the
 *    paid-requires-a-refund rule, and a `countDocuments` over that order's shipments to see
 *    whether a COD parcel already left the agency), then appends a timeline row and
 *    publishes `order.cancelled` — which two notification stacks consume, telling the
 *    customer and the vendor.
 *  - **dispatch** mints shipments, mirrors their status onto the order's items, appends a
 *    timeline row and publishes one `shipment.assigned` per shipment, which is what starts
 *    the auto-assignment broadcast.
 *  - **refund** calls a payment gateway, writes a `RefundTransaction` before the call and
 *    finalises it after, and reverses escrow across every actor on the order.
 *  - **resolveDispute** unwinds payment status, fulfilment status, the gateway transaction
 *    and earnings, and opens a support ticket.
 *
 * A second process could reproduce any of the database writes and would still miss every
 * event, silently. That is ADR-004 D-2, and it is why this file sits beside
 * `order.read.repository.ts` rather than replacing it.
 *
 * The thin methods below are the whole point: this file should never grow logic.
 */

/**
 * What the order looked like before the write.
 *
 * Captured by the caller from its own direct read — the one it already performed to answer
 * 404 — and handed here so the audit row records what actually changed rather than only
 * what was asked for.
 */
export type OrderSnapshot = Record<string, unknown> | null;

/**
 * Wrap a delegated order mutation in an audit intent.
 *
 * In the gateway rather than the controller, matching every other domain module: this is
 * the transport boundary, every delegated write leaves through `platformRequest` below,
 * and wrapping here means a method added later inherits auditing by construction rather
 * than by its author remembering.
 *
 * Intent → outcome rather than a transaction, because the write lands in jovi-mall's
 * database inside jovi-mall's transaction, which a wi-admin `ClientSession` cannot join.
 * The intent row commits FIRST — if that fails the HTTP call is never made — and the
 * outcome is stamped when jovi-mall answers. A crash in between leaves a row at
 * `attempted`, resolvable by grepping jovi-mall for the same `correlation_id`, which
 * already travels as `X-Request-Id` on every call.
 */
function auditedDelegation<T>(
    action: AuditAction,
    context: ActorContext,
    target: { id: string; label: string | null },
    payload: Record<string, unknown> | null,
    before: OrderSnapshot,
    perform: () => Promise<T>,
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
            target: { type: 'order', id: target.id, label: target.label },
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
            const result = await perform();
            return { result, before, after: asState(result) };
        },
    );
}

/**
 * Reduce jovi-mall's answer to the fields worth diffing.
 *
 * Not the whole response: an audit row storing every field of every write becomes
 * unreadable. These are the fields this surface can change — plus the facts that cannot be
 * reconstructed later.
 *
 * `shipmentsDispatched` is one: the count is visible on the shipments afterwards, but not
 * the fact that THIS action created them rather than the vendor's own dispatch.
 *
 * The refund block is the sharper one. **`overridden` is the whole reason this row
 * exists.** jovi-mall stores the amount and the reason on the `RefundTransaction`; what it
 * cannot store is "this was nine days outside the vendor's fourteen-day return window",
 * because that is a fact about a policy evaluated once, at the moment of the override,
 * against terms the vendor may edit tomorrow. This row is the only place it will ever live.
 */
function asState(result: unknown): Record<string, unknown> | null {
    if (!result || typeof result !== 'object') return null;
    const state: Record<string, unknown> = {};

    const order = (result as { order?: PlatformOrder }).order ?? (result as PlatformOrder);
    if (order && typeof order === 'object') {
        if ('payment_status' in order) state.paymentStatus = order.payment_status ?? null;
        if ('fulfillment_status' in order) state.fulfillmentStatus = order.fulfillment_status ?? null;
        if ('dispute_hold' in order) state.disputeActive = order.dispute_hold?.active ?? false;
        if ('total_amount' in order) state.totalAmount = order.total_amount ?? null;
    }

    const dispatched = (result as { shipmentsAssigned?: number }).shipmentsAssigned;
    if (typeof dispatched === 'number') state.shipmentsDispatched = dispatched;

    const refund = result as Partial<PlatformRefundResult>;
    if (typeof refund.refundId === 'string') {
        state.refundId = refund.refundId;
        state.amount = refund.amount ?? null;
        state.currency = refund.currency ?? null;
        state.totalRefunded = refund.totalRefunded ?? null;
        state.fullyRefunded = refund.fullyRefunded ?? null;
        state.withinVendorPolicy = refund.withinVendorPolicy ?? null;
        state.overridden = (refund.overrides?.length ?? 0) > 0;
        state.overrides = refund.overrides ?? [];
    }

    return Object.keys(state).length > 0 ? state : null;
}

/** How an administrator recognises an order six months later. */
function labelOf(before: OrderSnapshot): string | null {
    const value = before?.orderNumber;
    return typeof value === 'string' ? value : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// jovi-mall's wire shapes
// ─────────────────────────────────────────────────────────────────────────────

/** The raw order document jovi-mall echoes back. snake_case — it is a Mongoose document. */
export interface PlatformOrder {
    _id?: string;
    order_number?: string;
    payment_status?: string;
    fulfillment_status?: string;
    total_amount?: number;
    currency?: string;
    dispute_hold?: { active?: boolean; reason?: string | null } | null;
}

export interface PlatformDispatchResult {
    order: PlatformOrder | null;
    shipmentsAssigned: number;
}

export interface PlatformRefundResult {
    refundId: string;
    status: 'completed';
    amount: number;
    currency: string;
    totalRefunded: number;
    fullyRefunded: boolean;
    /** False when the refund went beyond what the vendor's own policy would have allowed. */
    withinVendorPolicy: boolean;
    overrides: string[];
}

export interface PlatformRefundEligibility {
    eligible: boolean;
    maxRefundable: number;
    remaining: number;
    currency: string | null;
    reasonCode?: string;
    gateway: string | null;
    gatewayRefundSupported: boolean;
    isCod: boolean;
    vendorPolicy: {
        eligible: boolean;
        maxRefundable: number;
        remaining: number;
        currency: string | null;
        reasonCode?: string;
        refundProcessingDays: number | null;
        returnShippingPayer: string | null;
    };
    overrides: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// The operations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve an order's payment dispute.
 *
 * jovi-mall answers **409 `ORDER_DISPUTE_NOT_ACTIVE`** when there was nothing to resolve.
 * That refusal is new and deliberate: the underlying service is idempotent because a Stripe
 * webhook retries, but an operator is not a webhook, and "resolved as won" for an order
 * that was never disputed is a lie a support ticket gets closed on. The code reaches the
 * dashboard unchanged, in `details.platformCode`.
 */
export async function resolveDispute(
    orderId: string,
    outcome: 'won' | 'lost',
    before: OrderSnapshot,
    context: ActorContext,
): Promise<PlatformOrder> {
    return auditedDelegation(
        'orders.disputes.resolve',
        context,
        { id: orderId, label: labelOf(before) },
        { outcome },
        before,
        async () => {
            const result = await platformRequest<PlatformOrder>({
                method: 'POST',
                path: `/orders/${orderId}/dispute/resolve`,
                body: { outcome },
                actor: context.actor,
                requestId: context.requestId,
            });
            return result.data;
        },
    );
}

/**
 * Cancel an order.
 *
 * The six guards are jovi-mall's `OrderService.assertCancellable`, shared verbatim with the
 * customer's own cancel endpoint — an administrator is exempt from exactly one of them, the
 * VENDOR's cancellation policy, because a return window is the vendor's promise to their
 * customer and the platform is not party to it. 409 when already cancelled, 422 past
 * `processing`, once money has been taken, or once a COD parcel has left the agency.
 */
export async function cancel(
    orderId: string,
    reason: string,
    before: OrderSnapshot,
    context: ActorContext,
): Promise<PlatformOrder> {
    return auditedDelegation(
        'orders.cancel',
        context,
        { id: orderId, label: labelOf(before) },
        { reason },
        before,
        async () => {
            const result = await platformRequest<PlatformOrder>({
                method: 'POST',
                path: `/orders/${orderId}/cancel`,
                body: { reason },
                actor: context.actor,
                requestId: context.requestId,
            });
            return result.data;
        },
    );
}

/**
 * Hand a paid-but-undispatched order to its delivery agency.
 *
 * Its own audit action beside `orders.cancel` although they share the `orders.intervene`
 * permission — the `vendors.suspend` / `vendors.reinstate` reasoning. They are opposite
 * interventions, and a single action name makes the activity feed unreadable.
 *
 * `shipmentsAssigned: 0` is a NO-OP, not an error: the usual cause is that the vendor's
 * auto-redirect dispatched it a moment earlier.
 */
export async function dispatch(
    orderId: string,
    reason: string | undefined,
    before: OrderSnapshot,
    context: ActorContext,
): Promise<PlatformDispatchResult> {
    return auditedDelegation(
        'orders.dispatch',
        context,
        { id: orderId, label: labelOf(before) },
        reason ? { reason } : null,
        before,
        async () => {
            const result = await platformRequest<PlatformDispatchResult>({
                method: 'POST',
                path: `/orders/${orderId}/dispatch`,
                body: reason ? { reason } : {},
                actor: context.actor,
                requestId: context.requestId,
            });
            return result.data;
        },
    );
}

/**
 * Refund an order, in full or in part.
 *
 * `overridePolicy` waives the VENDOR's commercial terms and nothing else. Every money
 * invariant is jovi-mall's and holds regardless: an amount above the remaining refundable
 * balance is `REFUND_AMOUNT_EXCEEDS_MAX`, a COD order is `REFUND_ORDER_IS_COD`, and a
 * gateway with no refund API is `REFUND_GATEWAY_NOT_SUPPORTED` — the last of which is an
 * EXPECTED outcome (only Stripe implements one) and arrives as a 4xx carrying its
 * `platformCode`, never a 502.
 *
 * Without the flag, a refund that exceeds the vendor's policy is refused with
 * **422 `REFUND_POLICY_OVERRIDE_REQUIRED`** carrying exactly which gates it would cross.
 */
export async function refund(
    orderId: string,
    input: { amount?: number; reason: string; overridePolicy?: boolean },
    before: OrderSnapshot,
    context: ActorContext,
): Promise<PlatformRefundResult> {
    return auditedDelegation(
        'orders.refund',
        context,
        { id: orderId, label: labelOf(before) },
        { amount: input.amount ?? null, reason: input.reason, overridePolicy: input.overridePolicy ?? false },
        before,
        async () => {
            const result = await platformRequest<PlatformRefundResult>({
                method: 'POST',
                path: `/orders/${orderId}/refund`,
                body: input,
                actor: context.actor,
                requestId: context.requestId,
            });
            return result.data;
        },
    );
}

/**
 * What may be refunded, and which of the vendor's gates a refund would cross.
 *
 * **Not audited, and not wrapped** — it is a read. It is delegated rather than computed
 * here for the ADR-008 D-1 reason: its answer is a VERDICT the platform acts on, and a copy
 * of the refund arithmetic in this service would be a second definition of what a customer
 * is owed. It is also why the route holds `orders.refund` rather than `orders.read`: the
 * answer is a ceiling on money leaving the platform, not a record.
 */
export async function refundEligibility(
    orderId: string,
    context: ActorContext,
): Promise<PlatformRefundEligibility> {
    const result = await platformRequest<PlatformRefundEligibility>({
        method: 'GET',
        path: `/orders/${orderId}/refund-eligibility`,
        actor: context.actor,
        requestId: context.requestId,
    });
    return result.data;
}
