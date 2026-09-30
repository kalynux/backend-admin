import { createAppError } from '../../../core/errors/app-error';
import { ERROR_CODES } from '../../../core/errors/error-codes';
import { AdminIdentity } from '../../admin-identity/domain/admin-identity.types';
import { ActorContext } from '../../audit/domain/audit-context';
import { AuditContext, AuditIntent } from '../../audit/domain/audit.types';
import { auditActorOf } from '../../audit/domain/audit-context';
import { auditedQueue } from '../../audit/domain/audit.writer';
import * as approvals from '../../dual-control/domain/approval.service';
import { registerDualControlHandler } from '../../dual-control/domain/dual-control.registry';
import { IApprovalRequest } from '../../dual-control/models/approval-request.model';
import { recordAuthorizationDenial } from '../../authorization/domain/denial.recorder';
import { PermissionName } from '../../authorization/domain/permission.catalog';
import { hasPermission } from '../../authorization/domain/permission.resolver';
import * as gateway from '../gateways/money.gateway';
import {
    PayoutRequestReadModel,
    PayoutRequestReadRepository,
} from '../repositories/payout-request.read.repository';

/**
 * Marking a payout paid: the direct path, the four-eyes path, and the one write both share.
 *
 * ── Why this is a domain file rather than controller code ─────────────────────
 * Because the write happens twice, from two entry points, and the rules must not live in
 * only one of them. A payout under the threshold is paid by the controller; one at or above
 * it is paid by the APPROVER's request, through the handler at the bottom of this file,
 * with no controller involved at all. `administrator.service.ts` is shaped the same way and
 * for the same reason — "not one escalation rule lives in the controller".
 *
 * ── The subtlety that will bite anybody editing this ──────────────────────────
 * **`LARGE_PAYOUT.when` is evaluated against a payload, and the amount is not in the
 * request body.** `POST /money/payouts/:payoutId/mark-paid` carries an optional reference
 * and nothing else; the amount lives on the row. So the payout is read first and the
 * payload is built from what was found. A body that could name the amount could name
 * 1,999,999 and skip the second administrator — which is why `MarkPaidSchema` is `.strict()`
 * and an `amount` key is a 400 rather than a silently ignored field.
 *
 * ── Registration ──────────────────────────────────────────────────────────────
 * `registerDualControlHandler` is called at module scope, and `money.routes.ts` imports this
 * file for side effect so registration completes before `assertDualControlHandlersRegistered()`
 * runs in `createApp()`. Without that import the service refuses to boot — designed
 * behaviour, and far better than discovering it at approval time, after a request has sat in
 * the queue and somebody has agreed to it.
 */

/**
 * How a payout is settled.
 *
 * `manual` — an administrator sent the money themselves and is recording an external
 * reference. The only route for a bank or card destination, and the fallback when the
 * gateway is unavailable.
 *
 * `gateway` — the platform sends it through the payment gateway. Answers with the payout in
 * `processing`, not `paid`: the transfer is confirmed asynchronously.
 *
 * Both are `money.payouts.mark_paid`, deliberately. They are two ways to perform one
 * action — assert that money left — so they share a permission, and therefore share the
 * ≥2,000,000 XAF four-eyes rule with no second threshold to drift from the first.
 */
export type PayoutMode = 'manual' | 'gateway';

const payouts = new PayoutRequestReadRepository();

/**
 * Every mark-paid either happens now or is queued for a second administrator. One shape for
 * both, so the controller answers 200 or 202 from the same value rather than from a guess
 * about which path it took.
 */
export type PayoutWriteOutcome =
    | { kind: 'applied'; payout: gateway.PlatformPayoutRequest }
    | { kind: 'queued'; approval: approvals.ApprovalDto; created: boolean };

/**
 * Load a payout or 404 — and return the row, because every path needs it twice: to refuse a
 * request against a payout that does not exist, and as the audit `before`.
 *
 * Reading before delegating costs one indexed lookup and buys the two things the gateway
 * cannot get from jovi-mall's answer: the previous state, and a 404 that says "no such
 * payout" rather than a `PLATFORM_OPERATION_REJECTED` wrapping one.
 *
 * The row is masked — `PAYOUT_LIST_PROJECTION` never read the destination — so the write
 * path holds no beneficiary account number at any point. That is what makes "the disclosure
 * endpoint is the only reader" a property of the module rather than a convention.
 */
export async function loadPayoutOr404(payoutId: string): Promise<PayoutRequestReadModel> {
    const row = await payouts.findById(payoutId);
    if (!row) throw createAppError(ERROR_CODES.NOT_FOUND, 404, 'Payout request not found');
    return row;
}

/**
 * The audit `before` — in the camelCase the gateway's `after` mapper emits, so the two
 * halves of one row line up.
 *
 * `before` is read out of `jovi_mall` by this service and `after` comes back over HTTP; a
 * row storing `paidReference` beside `paid_reference` renders as every field having changed.
 */
export function toPayoutAuditState(row: PayoutRequestReadModel): Record<string, unknown> {
    return {
        status: row.status,
        amount: row.amount,
        currency: row.currency,
        resolvedAt: row.resolved_at ? row.resolved_at.toISOString() : null,
        paidReference: row.paid_reference ?? null,
        rejectionReason: row.rejection_reason ?? null,
    };
}

/**
 * How an administrator recognises a payout in a feed: the money and who it is for.
 *
 * Never the destination — that would put a beneficiary's account details in the audit
 * store, the one place they would then be readable without the permission that gates them.
 * Never the id either: the row already carries it.
 */
export function labelOfPayout(row: PayoutRequestReadModel): string {
    return `${row.currency} ${row.amount} → ${row.owner_type} ${row.owner_id.toString()}`;
}

/** The gateway's audit context, built once from a row both write paths already hold. */
export function auditContextOfPayout(
    row: PayoutRequestReadModel,
): gateway.PayoutAuditContext {
    return {
        label: labelOfPayout(row),
        before: toPayoutAuditState(row),
        ownerType: row.owner_type,
        ownerId: row.owner_id.toString(),
        amount: row.amount,
        currency: row.currency,
    };
}

/**
 * Refuse a payout that is not `pending`, **before** anything else happens.
 *
 * On the direct path this saves a round trip. On the four-eyes path it is the point: a
 * request queued against an already-resolved payout puts something in front of a second
 * administrator that cannot succeed however they decide, and the approval queue is not a
 * place to discover that.
 */
/**
 * What each mode may act on.
 *
 * ⚠ **`failed` is sendable and `processing` is not**, and both halves matter. A payout whose
 * transfer failed is precisely the one an administrator needs to retry, so refusing it would
 * strand the money with no way forward but rejection. A payout whose transfer is IN FLIGHT
 * must be refused by both modes: sending again risks a second transfer, and recording a
 * manual payment claims a settlement the gateway is about to report on its own.
 *
 * jovi-mall enforces the same rule — this is the pre-flight, not the control.
 */
const SENDABLE_FROM = ['pending', 'failed'] as const;

function assertPending(row: PayoutRequestReadModel, mode: PayoutMode = 'manual'): void {
    const allowed: readonly string[] = mode === 'gateway' ? SENDABLE_FROM : ['pending'];
    if (!allowed.includes(row.status)) {
        throw createAppError(ERROR_CODES.PAYOUT_NOT_PENDING, 409, undefined, {
            status: row.status,
        });
    }
}

/**
 * The dual-control payload — and the key an identical request joins.
 *
 * `approvalRequestKey` hashes this object, so every field in it participates in idempotency.
 * The amount being here is what makes a stale approval unreachable by a changed one: an
 * amount that somehow differed between two requests yields a different key and cannot join
 * a pending approval signed for the other number.
 *
 * `mode` participates for a reason worth stating: approving a GATEWAY send and approving a
 * MANUAL record are not the same act, even for the same payout and the same amount. One
 * instructs the platform to move money; the other asserts a human already did. Hashing the
 * mode means an approver who agreed to one cannot have their signature spent on the other.
 *
 * `reference` is normalised to `null` rather than left `undefined` for the same reason —
 * `JSON.stringify` drops an undefined value, so omitting the key and sending it explicitly
 * as null would otherwise hash the same and one operator's reference would silently ride on
 * another's request.
 */
function markPaidPayload(
    row: PayoutRequestReadModel,
    reference: string | null,
    mode: PayoutMode,
): Record<string, unknown> {
    return {
        payoutId: row._id.toString(),
        ownerType: row.owner_type,
        ownerId: row.owner_id.toString(),
        amount: row.amount,
        currency: row.currency,
        reference,
        mode,
    };
}

/**
 * Mark a payout paid — the entry point the controller calls.
 *
 * Five steps, in this order and for the reasons above:
 *   1. read the payout (404)
 *   2. refuse it now if it is not pending — do NOT queue an impossible action
 *   3. build the payload from the ROW, never from the body
 *   4. at or above the threshold: queue it, record that it was queued, answer 202
 *   5. otherwise: delegate immediately
 */
export async function markPaid(
    actor: AdminIdentity,
    payoutId: string,
    reference: string | null,
    context: ActorContext,
    mode: PayoutMode = 'manual',
): Promise<PayoutWriteOutcome> {
    const row = await loadPayoutOr404(payoutId);
    assertPending(row, mode);

    const payload = markPaidPayload(row, reference, mode);

    if (approvals.dualControlRequired('money.payouts.mark_paid', payload)) {
        /**
         * The approval row and the audit row saying it was queued commit TOGETHER.
         *
         * Without that pairing an audit-store failure would leave a payout waiting for a
         * second administrator with nothing recording that anybody asked — and an approval
         * that expires unapproved would then leave no trace at all. `auditedQueue` is the
         * only way to open a transaction from outside the audit writer; see its header for
         * why this was worth building rather than following the administrator paths, which
         * queue without recording it.
         */
        const outcome = await auditedQueue(queuedIntent(actor, context, row, payload), async (session) => {
            const result = await approvals.requestApproval({
                action: 'money.payouts.mark_paid',
                requester: actor,
                targetType: 'payout',
                targetId: payoutId,
                payload,
                session,
            });
            return { result, approvalId: result.approval.id };
        });

        return { kind: 'queued', approval: outcome.approval, created: outcome.created };
    }

    const payout = mode === 'gateway'
        ? await gateway.sendPayout(payoutId, auditContextOfPayout(row), context)
        : await gateway.markPayoutPaid(payoutId, reference, auditContextOfPayout(row), context);

    return { kind: 'applied', payout };
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolving a transfer whose outcome is UNKNOWN
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The dual-control `mode` of a queued "confirm this unknown transfer as paid".
 *
 * It rides `money.payouts.mark_paid`'s approval, not an action of its own, for the reason
 * `/send` does: `LARGE_PAYOUT` hangs off that name, and confirming money left IS asserting
 * money left — a second threshold would drift from the first. The mode is hashed into the
 * approval key, so an approver who signed for this cannot have the signature spent on a
 * manual mark-paid or a gateway send, nor the reverse.
 */
export const RESOLVE_PAID_MODE = 'resolve_paid';

export interface ResolveUnknownInput {
    outcome: 'paid' | 'failed';
    reason: string;
    evidence: string | null;
}

/**
 * Only a `processing` payout has an unknown outcome to decide. Everything else already has an
 * exit (`mark-paid`, `/send` to retry, `/reject`). jovi-mall enforces the same rule, plus the
 * reconciliation sweep's quiet period (409 `EARNINGS_PAYOUT_TRANSFER_IN_FLIGHT`) which this
 * service cannot see and does not guess — this is the pre-flight, not the control.
 */
function assertProcessing(row: PayoutRequestReadModel): void {
    if (row.status !== 'processing') {
        throw createAppError(ERROR_CODES.PAYOUT_NOT_PROCESSING, 409, undefined, {
            status: row.status,
        });
    }
}

/**
 * The permission each outcome needs. The route admits EITHER; this is where the choice of
 * outcome narrows it.
 *
 *   paid   → `money.payouts.mark_paid` — it asserts money left, exactly as mark-paid does
 *   failed → `money.payouts.triage`    — nothing moves: the hold is KEPT (ADR-024 D-7), and
 *            the payout goes where a refused transfer goes, to be retried or rejected. Support
 *            may already reject a payout outright, which releases the hold; recording that a
 *            transfer did not happen is strictly weaker.
 */
export function permissionForOutcome(outcome: ResolveUnknownInput['outcome']): PermissionName {
    return outcome === 'paid' ? 'money.payouts.mark_paid' : 'money.payouts.triage';
}

/** Hashed into the approval key — the reason and evidence are part of what was signed for. */
function resolvePaidPayload(row: PayoutRequestReadModel, input: ResolveUnknownInput): Record<string, unknown> {
    return {
        payoutId: row._id.toString(),
        ownerType: row.owner_type,
        ownerId: row.owner_id.toString(),
        amount: row.amount,
        currency: row.currency,
        reason: input.reason,
        evidence: input.evidence,
        mode: RESOLVE_PAID_MODE,
    };
}

/**
 * Resolve a transfer whose outcome is unknown — the entry point the controller calls.
 *
 *   1. the outcome's own permission (403, recorded as a denial)
 *   2. read the payout (404) and refuse it now unless `processing` (409)
 *   3. `failed`: delegate immediately — no money moves, so no quorum
 *   4. `paid`: the mark-paid threshold, with the amount off the ROW; queue (202) or delegate
 */
export async function resolveUnknown(
    actor: AdminIdentity,
    payoutId: string,
    input: ResolveUnknownInput,
    context: ActorContext,
): Promise<PayoutWriteOutcome> {
    const required = permissionForOutcome(input.outcome);
    if (!hasPermission(actor.tier, required)) {
        recordAuthorizationDenial({
            kind: 'permission',
            adminId: actor.adminId,
            tier: actor.tier,
            sessionId: actor.sessionId,
            required: [required],
            reason: ERROR_CODES.AUTHZ_PERMISSION_DENIED,
            targetId: payoutId,
            method: context.method,
            path: context.path,
            requestId: context.requestId,
            ip: context.ip,
            userAgent: context.userAgent,
        });
        throw createAppError(ERROR_CODES.AUTHZ_PERMISSION_DENIED, 403, undefined, { required: [required] });
    }

    const row = await loadPayoutOr404(payoutId);
    assertProcessing(row);

    if (input.outcome === 'failed') {
        const payout = await gateway.resolveUnknownPayout(payoutId, input, auditContextOfPayout(row), context);
        return { kind: 'applied', payout };
    }

    const payload = resolvePaidPayload(row, input);

    if (approvals.dualControlRequired('money.payouts.mark_paid', payload)) {
        const outcome = await auditedQueue(
            queuedIntent(actor, context, row, payload, 'money.payouts.resolve_unknown_paid'),
            async (session) => {
                const result = await approvals.requestApproval({
                    action: 'money.payouts.mark_paid',
                    requester: actor,
                    targetType: 'payout',
                    targetId: payoutId,
                    payload,
                    session,
                });
                return { result, approvalId: result.approval.id };
            },
        );
        return { kind: 'queued', approval: outcome.approval, created: outcome.created };
    }

    const payout = await gateway.resolveUnknownPayout(payoutId, input, auditContextOfPayout(row), context);
    return { kind: 'applied', payout };
}

/**
 * The intent behind a QUEUED mark-paid.
 *
 * `recordQueued` re-targets the row at the `approval_request` — the row is about the
 * request, not yet about the payout, and its `subject_class` is `internal` accordingly. The
 * payout rides along as the **related** target so the row is not orphaned.
 *
 * Consequence worth knowing before wiring a dashboard: `buildQueryFilter` matches on
 * `target_type`/`target_id` and does not consult `related_target_*`, so this row does NOT
 * appear on `GET /money/payouts/:payoutId/activity`. The pending request is found instead
 * through `GET /approvals?targetId=<payoutId>`, which `ListApprovalsFilter` already
 * supports. When the approval is committed, the row for the write itself DOES target the
 * payout and carries `via_approval_id` — so the payout's own feed shows what happened, and
 * the approvals queue shows what was asked.
 */
function queuedIntent(
    actor: AdminIdentity,
    context: AuditContext,
    row: PayoutRequestReadModel,
    payload: Record<string, unknown>,
    action: 'money.payouts.mark_paid' | 'money.payouts.resolve_unknown_paid' = 'money.payouts.mark_paid',
): AuditIntent {
    return {
        action,
        actor: auditActorOf(actor),
        target: { type: 'payout', id: row._id.toString(), label: labelOfPayout(row) },
        relatedTarget: { type: 'payout', id: row._id.toString() },
        context,
        payload,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// The handler — what a second administrator's approval actually does
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Registered at module scope so it exists before `createApp()` asserts that every
 * dual-controlled action has one.
 *
 * ── Everything below the first line is a RE-CHECK, and none of it is optional ──
 * An approval sits in the queue for up to `ADMIN_APPROVAL_TTL_S`. In that time the payout
 * can have been paid by somebody else, rejected, or (in principle) edited. The verdict
 * recorded when the request was made says nothing about the world now, which is the
 * obligation the registry's header states and the reason `applyTierChange` compare-and-sets
 * on the level it expected.
 *
 *   1. the payout still exists          → gone means the row was deleted under us
 *   2. it is still `pending`            → the double-pay guard, and the one that matters
 *   3. the amount and currency still    → the approver signed for a number; paying a
 *      match what was signed for           different one is not what they agreed to
 *   4. the threshold is re-evaluated    → and a miss is NOT a refusal, see below
 *
 * The actor on the resulting audit row is the APPROVER, not the requester — they are the
 * one who performed it — and `via_approval_id` ties the row back to the request, so the pair
 * reads as "X asked, Y did it". That id lands on jovi-mall's `resolved_by` as the approver
 * too, with `resolved_by_source: 'admin'` and a name snapshot beside it, which is why step
 * 0's F-B had to land before this path could go live.
 */
registerDualControlHandler(
    'money.payouts.mark_paid',
    async (approval: IApprovalRequest, approver, context) => {
        const payoutId = String(approval.payload.payoutId);
        const reference = typeof approval.payload.reference === 'string'
            ? approval.payload.reference
            : null;

        const mode: PayoutMode = approval.payload.mode === 'gateway' ? 'gateway' : 'manual';
        // Confirming an UNKNOWN transfer as paid: its precondition is `processing`, the
        // opposite of the other two modes', and it is re-checked just the same.
        const resolving = approval.payload.mode === RESOLVE_PAID_MODE;

        const row = await loadPayoutOr404(payoutId);
        if (resolving) assertProcessing(row);
        else assertPending(row, mode);

        /**
         * The payout must still be the one that was signed for.
         *
         * `amount` and `currency` are immutable on a `pending` payout today, so this is a
         * guard against a future in which they are not, and against a hand-edited row. It is
         * cheap and it fails closed, which is the right trade on the one write in this
         * service that moves money out of the platform.
         */
        if (row.amount !== approval.payload.amount || row.currency !== approval.payload.currency) {
            throw createAppError(
                ERROR_CODES.AUTHZ_APPROVAL_ALREADY_RESOLVED,
                409,
                'This payout’s amount or currency changed since the request was approved',
                { approvedAmount: approval.payload.amount, currentAmount: row.amount },
            );
        }

        /**
         * Re-evaluating the threshold is deliberate, and a MISS is deliberately not a
         * refusal.
         *
         * If the amount has fallen below 2,000,000 since the request was made, the approval
         * was over-cautious rather than invalid: two administrators agreed to something that
         * one could have done alone. Refusing it would strand the payout and teach operators
         * to avoid the queue. The check earns its place by documenting that the case was
         * considered — the alternative is a reader wondering whether it was.
         */

        /**
         * The approver's request performs the write, in whichever mode was signed for.
         *
         * Reading the mode off the APPROVAL rather than re-deciding it here is the point: the
         * second administrator agreed to a specific act, and `approvalRequestKey` hashed the
         * mode, so an approval for one can never be spent on the other.
         */
        if (resolving) {
            await gateway.resolveUnknownPayout(
                payoutId,
                {
                    outcome: 'paid',
                    reason: String(approval.payload.reason),
                    evidence: typeof approval.payload.evidence === 'string' ? approval.payload.evidence : null,
                },
                auditContextOfPayout(row),
                { ...context, actor: approver },
                approval._id.toString(),
            );
            return;
        }

        if (mode === 'gateway') {
            await gateway.sendPayout(
                payoutId,
                auditContextOfPayout(row),
                { ...context, actor: approver },
                approval._id.toString(),
            );
            return;
        }

        await gateway.markPayoutPaid(
            payoutId,
            reference,
            auditContextOfPayout(row),
            { ...context, actor: approver },
            approval._id.toString(),
        );
    },
);
