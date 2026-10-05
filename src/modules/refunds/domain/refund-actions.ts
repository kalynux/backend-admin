import { createAppError, AppError } from '../../../core/errors/app-error';
import { ERROR_CODES } from '../../../core/errors/error-codes';
import { AdminIdentity } from '../../admin-identity/domain/admin-identity.types';
import { ActorContext, auditActorOf } from '../../audit/domain/audit-context';
import { AuditContext, AuditIntent, AuditTarget } from '../../audit/domain/audit.types';
import { auditedQueue } from '../../audit/domain/audit.writer';
import { recordAuthorizationDenial } from '../../authorization/domain/denial.recorder';
import { PermissionName } from '../../authorization/domain/permission.catalog';
import { hasPermission } from '../../authorization/domain/permission.resolver';
import * as approvals from '../../dual-control/domain/approval.service';
import { registerDualControlHandler } from '../../dual-control/domain/dual-control.registry';
import { IApprovalRequest } from '../../dual-control/models/approval-request.model';
import * as gateway from '../gateways/refund.gateway';
import { labelOfRefund, toRefundAuditState } from '../read-models/refund-request.dto';
import { RefundRequestReadModel, RefundRequestReadRepository } from '../repositories/refund-request.read.repository';
import { ACTIONABLE_FROM, RefundVerb } from './refund-vocabulary';

/**
 * Every write on the refund queue: the pre-flights, the four-eyes path for approval, and the
 * one handler a second administrator's approval runs.
 *
 * ── Why a domain file rather than controller code ─────────────────────────────
 * Approving happens from TWO entry points — the controller below the threshold, the dual-control
 * handler at or above it — and from a third (`create` with `approveNow`). The rules must live in
 * one place. Same shape as `money/domain/payout-dual-control.ts`, whose reasoning this follows
 * point for point.
 *
 * ── The amount is read off the ROW ────────────────────────────────────────────
 * `LARGE_REFUND.when` reads a payload, and `POST /refunds/:refundId/approve` has no body. The
 * request is read first and the payload built from its `gross_amount` — a body able to name the
 * amount could name 1,999,999 and skip the second administrator (`ApproveRefundSchema` is
 * `.strict()` for that reason).
 *
 * ── Pre-flights, not controls ─────────────────────────────────────────────────
 * jovi-mall enforces every status rule and R-7 under its own compare-and-set. These run first so
 * a doomed action is refused with a clear code instead of being queued for a second
 * administrator who then cannot succeed however they decide.
 */

const requests = new RefundRequestReadRepository();

export type RefundWriteOutcome =
    | { kind: 'applied'; request: RefundRequestReadModel }
    | { kind: 'queued'; approval: approvals.ApprovalDto; created: boolean };

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

export async function loadRefundOr404(refundId: string): Promise<RefundRequestReadModel> {
    const row = await requests.findById(refundId);
    if (!row) throw createAppError(ERROR_CODES.NOT_FOUND, 404, 'Refund request not found');
    return row;
}

/** Re-read after a write so the response has the same shape as `GET /refunds/:refundId`. */
async function reread(row: RefundRequestReadModel): Promise<RefundRequestReadModel> {
    return (await requests.findById(row._id.toString())) ?? row;
}

export function assertActionable(row: RefundRequestReadModel, verb: RefundVerb): void {
    const allowed: readonly string[] = ACTIONABLE_FROM[verb];
    if (!allowed.includes(row.status)) {
        throw createAppError(ERROR_CODES.REFUND_REQUEST_STATUS_CONFLICT, 409, undefined, {
            status: row.status,
            allowedFrom: [...allowed],
        });
    }
}

/**
 * R-7: a TYPED destination must be approved by somebody other than the administrator who typed
 * it. jovi-mall answers the same with `409 REFUND_SECOND_APPROVER_REQUIRED`; this is its
 * pre-flight, and it also runs in the dual-control handler against the actual performer.
 */
export function assertNotSelfApproval(row: RefundRequestReadModel, approverId: string): void {
    if (row.destination?.source === 'typed' && row.requested_by?.id === approverId) {
        throw createAppError(ERROR_CODES.REFUND_SECOND_APPROVER_REQUIRED, 409);
    }
}

/** The order or booking a request is about, as the audit row's related target. */
export function relatedTargetOf(row: RefundRequestReadModel): AuditTarget | null {
    if (row.source_kind === 'order') return { type: 'order', id: row.source_id.toString(), label: row.order_number ?? null };
    if (row.source_kind === 'booking') return { type: 'booking', id: row.source_id.toString(), label: row.order_number ?? null };
    return null;
}

export function auditContextOf(row: RefundRequestReadModel): gateway.RefundAuditContext {
    return {
        refundId: row._id.toString(),
        label: labelOfRefund(row),
        before: toRefundAuditState(row),
        related: relatedTargetOf(row),
    };
}

function denyUnless(actor: AdminIdentity, required: PermissionName, targetId: string | null, context: AuditContext): void {
    if (hasPermission(actor.tier, required)) return;
    recordAuthorizationDenial({
        kind: 'permission',
        adminId: actor.adminId,
        tier: actor.tier,
        sessionId: actor.sessionId,
        required: [required],
        reason: ERROR_CODES.AUTHZ_PERMISSION_DENIED,
        targetId: targetId ?? undefined,
        method: context.method,
        path: context.path,
        requestId: context.requestId,
        ip: context.ip,
        userAgent: context.userAgent,
    });
    throw createAppError(ERROR_CODES.AUTHZ_PERMISSION_DENIED, 403, undefined, { required: [required] });
}

/**
 * Who the request is FROM, on jovi-mall's vocabulary. Decided from what the caller may do —
 * never from the body: a requester who could not approve it is Support (R-2: always needs an
 * approver), one who could is an administrator.
 */
export function requestedByRoleFor(actor: AdminIdentity): 'admin' | 'support' {
    return hasPermission(actor.tier, 'orders.refund') ? 'admin' : 'support';
}

// ─────────────────────────────────────────────────────────────────────────────
// Create
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateInput extends Omit<gateway.CreateRefundInput, 'requestedByRole'> {
    approveNow: boolean;
}

/** What happened to an `approveNow`, reported beside the created request. */
export type ApproveNowOutcome =
    | { status: 'not_requested' }
    | { status: 'applied' }
    | { status: 'queued'; approval: approvals.ApprovalDto; created: boolean }
    /** R-7: a typed number needs a SECOND administrator — the creator cannot approve it. */
    | { status: 'second_approver_required' }
    /** The request exists; approving it failed. The error is the approve call's own. */
    | { status: 'failed'; error: { code: string; message: string; details: Record<string, unknown> | null } };

export async function createRequest(
    actor: AdminIdentity,
    input: CreateInput,
    context: ActorContext,
): Promise<{ request: RefundRequestReadModel | null; createdId: string; approveNow: ApproveNowOutcome }> {
    // Refused BEFORE anything is written: asking to approve without being an approver.
    if (input.approveNow) denyUnless(actor, 'orders.refund', null, context);

    const created = await gateway.createRefundRequest(
        { ...input, requestedByRole: requestedByRoleFor(actor) },
        {
            refundId: null,
            label: null,
            before: null,
            related: input.sourceKind === 'order' || input.sourceKind === 'booking'
                ? { type: input.sourceKind, id: input.sourceId }
                : null,
        },
        context,
    );

    const createdId = String(created.id);
    let row = await requests.findById(createdId);

    if (!input.approveNow || !row) {
        return { request: row, createdId, approveNow: { status: 'not_requested' } };
    }

    if (row.destination?.source === 'typed') {
        return { request: row, createdId, approveNow: { status: 'second_approver_required' } };
    }

    try {
        const outcome = await approve(actor, createdId, context);
        if (outcome.kind === 'queued') {
            return {
                request: row,
                createdId,
                approveNow: { status: 'queued', approval: outcome.approval, created: outcome.created },
            };
        }
        row = outcome.request;
        return { request: row, createdId, approveNow: { status: 'applied' } };
    } catch (error) {
        /**
         * The request EXISTS. Answering this as an error would tell the client nothing was
         * created, and a retry would hit `REFUND_ALREADY_OPEN`. So the create succeeds and the
         * failed approval is reported beside it (its audit row is already `failed`).
         */
        if (!(error instanceof AppError)) throw error;
        return {
            request: await reread(row),
            createdId,
            approveNow: {
                status: 'failed',
                error: { code: error.code, message: error.message, details: error.details ?? null },
            },
        };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Approve — four-eyes at ≥ 2,000,000 (`LARGE_REFUND`)
// ─────────────────────────────────────────────────────────────────────────────

/** The marker hashed into the approval key, so this signature cannot be spent on another act. */
export const REFUND_APPROVE_MODE = 'refund_approve';

/**
 * The dual-control payload — built from the ROW. Every field participates in the approval key:
 * the amount and currency mean an approval signed for one number cannot be spent on another.
 */
export function approvePayload(row: RefundRequestReadModel): Record<string, unknown> {
    return {
        refundId: row._id.toString(),
        sourceKind: row.source_kind,
        sourceId: row.source_id.toString(),
        sourceLabel: row.order_number ?? null,
        amount: row.gross_amount,
        currency: row.currency,
        destinationSource: row.destination?.source ?? null,
        mode: REFUND_APPROVE_MODE,
    };
}

/**
 *   1. read the request (404)
 *   2. refuse it now unless `awaiting_approval` — do NOT queue an impossible action
 *   3. R-7: refuse the administrator who typed the number
 *   4. at or above the threshold: queue it (202), recording that it was queued
 *   5. otherwise: delegate immediately
 */
export async function approve(
    actor: AdminIdentity,
    refundId: string,
    context: ActorContext,
): Promise<RefundWriteOutcome> {
    const row = await loadRefundOr404(refundId);
    assertActionable(row, 'approve');
    assertNotSelfApproval(row, actor.adminId);

    const payload = approvePayload(row);

    if (approvals.dualControlRequired('orders.refund', payload)) {
        const outcome = await auditedQueue(queuedApproveIntent(actor, context, row, payload), async (session) => {
            const result = await approvals.requestApproval({
                action: 'orders.refund',
                requester: actor,
                targetType: 'refund',
                targetId: refundId,
                payload,
                session,
            });
            return { result, approvalId: result.approval.id };
        });
        return { kind: 'queued', approval: outcome.approval, created: outcome.created };
    }

    await gateway.approveRefundRequest(
        refundId,
        { ...auditContextOf(row), amount: row.gross_amount, currency: row.currency },
        context,
    );
    return { kind: 'applied', request: await reread(row) };
}

/**
 * The intent behind a QUEUED approval. `recordQueued` re-targets the row at the approval request;
 * the refund rides as the related target. The pending request is found at
 * `GET /approvals?targetId=<refundId>`; when it is committed, the approve row itself targets the
 * refund and carries `via_approval_id`.
 */
function queuedApproveIntent(
    actor: AdminIdentity,
    context: AuditContext,
    row: RefundRequestReadModel,
    payload: Record<string, unknown>,
): AuditIntent {
    return {
        action: 'orders.refund.approve',
        actor: auditActorOf(actor),
        target: { type: 'refund', id: row._id.toString(), label: labelOfRefund(row) },
        relatedTarget: { type: 'refund', id: row._id.toString() },
        context,
        payload,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// The other verbs — never queued
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reject. Not dual-controlled at any amount — the reversible direction: nothing leaves the
 * platform and the hold on the seller's earnings lifts (`LARGE_PAYOUT`'s asymmetry).
 */
export async function reject(refundId: string, reason: string, context: ActorContext): Promise<RefundRequestReadModel> {
    const row = await loadRefundOr404(refundId);
    assertActionable(row, 'reject');
    await gateway.rejectRefundRequest(refundId, reason, auditContextOf(row), context);
    return reread(row);
}

/**
 * Retry a failed transfer. Not queued: the money was already approved (four-eyes included when
 * it applied), and jovi-mall reuses the same transfer reference, so a retry cannot pay twice.
 */
export async function retry(refundId: string, context: ActorContext): Promise<RefundRequestReadModel> {
    const row = await loadRefundOr404(refundId);
    assertActionable(row, 'retry');
    await gateway.retryRefundRequest(refundId, auditContextOf(row), context);
    return reread(row);
}

/** Record a payment made outside the platform. ⛔ Never from `sending` (the pre-flight list). */
export async function settleExternally(
    refundId: string,
    input: { method: string; reference: string | null; proofFileId: string },
    context: ActorContext,
): Promise<RefundRequestReadModel> {
    const row = await loadRefundOr404(refundId);
    assertActionable(row, 'settleExternal');
    await gateway.settleRefundExternally(refundId, input, auditContextOf(row), context);
    return reread(row);
}

/**
 * Decide a transfer stuck in `sending`. jovi-mall also refuses one younger than its minimum age
 * (a callback may still be on its way) — a condition this service cannot see and does not guess.
 */
export async function resolveUnknown(
    refundId: string,
    input: { outcome: 'arrived' | 'failed'; note: string },
    context: ActorContext,
): Promise<RefundRequestReadModel> {
    const row = await loadRefundOr404(refundId);
    assertActionable(row, 'resolveUnknown');
    await gateway.resolveUnknownRefund(refundId, input, auditContextOf(row), context);
    return reread(row);
}

// ─────────────────────────────────────────────────────────────────────────────
// The handler — what a second administrator's approval actually does
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Registered at module scope; `refund.routes.ts` imports this file for side effect so the boot
 * assertion (`assertDualControlHandlersRegistered`) sees it.
 *
 * Everything below the first line is a RE-CHECK against current state — an approval can sit
 * for `ADMIN_APPROVAL_TTL_S`:
 *   1. the request still exists and is still `awaiting_approval` (the double-approve guard)
 *   2. its amount and currency are what the approver signed for
 *   3. R-7 against the PERFORMER: the approving administrator did not type the number
 * The actor on the resulting row is the approver, with `via_approval_id` back to the request.
 */
registerDualControlHandler('orders.refund', async (approval: IApprovalRequest, approver, context) => {
    if (approval.payload.mode !== REFUND_APPROVE_MODE) {
        throw createAppError(
            ERROR_CODES.AUTHZ_GRANT_TABLE_INVALID,
            500,
            `An orders.refund approval carries an unknown mode "${String(approval.payload.mode)}"`,
        );
    }

    const refundId = String(approval.payload.refundId);
    const row = await loadRefundOr404(refundId);
    assertActionable(row, 'approve');

    if (row.gross_amount !== approval.payload.amount || row.currency !== approval.payload.currency) {
        throw createAppError(
            ERROR_CODES.AUTHZ_APPROVAL_ALREADY_RESOLVED,
            409,
            'This refund’s amount or currency changed since the approval was requested',
            { approvedAmount: approval.payload.amount, currentAmount: row.gross_amount },
        );
    }

    assertNotSelfApproval(row, approver.adminId);

    await gateway.approveRefundRequest(
        refundId,
        { ...auditContextOf(row), amount: row.gross_amount, currency: row.currency },
        { ...context, actor: approver },
        approval._id.toString(),
    );
});
