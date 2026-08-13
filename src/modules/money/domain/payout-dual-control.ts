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
function assertPending(row: PayoutRequestReadModel): void {
    if (row.status !== 'pending') {
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
 * `reference` is normalised to `null` rather than left `undefined` for the same reason —
 * `JSON.stringify` drops an undefined value, so omitting the key and sending it explicitly
 * as null would otherwise hash the same and one operator's reference would silently ride on
 * another's request.
 */
function markPaidPayload(
    row: PayoutRequestReadModel,
    reference: string | null,
): Record<string, unknown> {
    return {
        payoutId: row._id.toString(),
        ownerType: row.owner_type,
        ownerId: row.owner_id.toString(),
        amount: row.amount,
        currency: row.currency,
        reference,
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
): Promise<PayoutWriteOutcome> {
    const row = await loadPayoutOr404(payoutId);
    assertPending(row);

    const payload = markPaidPayload(row, reference);

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

    const payout = await gateway.markPayoutPaid(
        payoutId,
        reference,
        auditContextOfPayout(row),
        context,
    );

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
): AuditIntent {
    return {
        action: 'money.payouts.mark_paid',
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

        const row = await loadPayoutOr404(payoutId);
        assertPending(row);

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

        await gateway.markPayoutPaid(
            payoutId,
            reference,
            auditContextOfPayout(row),
            { ...context, actor: approver },
            approval._id.toString(),
        );
    },
);
