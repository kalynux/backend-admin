import { ClientSession } from 'mongoose';
import { createAppError } from '../../../core/errors/app-error';
import { ERROR_CODES } from '../../../core/errors/error-codes';
import { env } from '../../../config/env';
import { logger } from '../../../core/logging/logger';
import { AdminIdentity, ADMIN_TIER_LABELS } from '../../admin-identity/domain/admin-identity.types';
import { PermissionName, isPermissionName, permissionSpec } from '../../authorization/domain/permission.catalog';
import { hasPermission } from '../../authorization/domain/permission.resolver';
import { recordAuthorizationDenial } from '../../authorization/domain/denial.recorder';
import { ApprovalRequestRepository } from '../repositories/approval-request.repository';
import { ApprovalStatus, IApprovalRequest } from '../models/approval-request.model';
import { approvalRequestKey } from './action-key';
import { dualControlHandlerFor } from './dual-control.registry';
import { AuditContext, AuditIntent, AuditTarget, toAuditTargetType } from '../../audit/domain/audit.types';
import { auditActorOf, systemActor, systemContext } from '../../audit/domain/audit-context';
import { auditedTransaction } from '../../audit/domain/audit.writer';
import { AuditAction } from '../../audit/domain/audit.catalog';

/**
 * Four-eyes: an action one administrator asks for and a different one commits.
 *
 * PHASE-0:436 promised "financial actions above a threshold require a second admin's
 * approval", then the requirement vanished from every later document. This is it, built
 * generically so the financial endpoints arriving at Phase 5 inherit it by declaring a
 * `dualControl` spec in the catalog rather than by writing any of this again.
 *
 * ── Its live consumer today ───────────────────────────────────────────────────
 * Promoting an administrator to Developer. That is not a placeholder chosen for
 * convenience: it is the single most dangerous write this service has, and it is the rule
 * that makes a compromised Developer account containable — see rule 3 in
 * `escalation.rules.ts`.
 */

const approvals = new ApprovalRequestRepository();

export interface ApprovalDto {
    id: string;
    action: string;
    description: string;
    status: ApprovalStatus;
    requestedBy: string;
    requestedByTier: number;
    requestedByTierLabel: string;
    targetType: string;
    targetId: string;
    payload: Record<string, unknown>;
    approverId: string | null;
    decidedAt: string | null;
    decisionNote: string | null;
    failureReason: string | null;
    expiresAt: string;
    createdAt: string;
}

export function toApprovalDto(row: IApprovalRequest): ApprovalDto {
    return {
        id: row._id.toString(),
        action: row.action,
        description: row.description,
        status: row.status,
        requestedBy: row.requested_by.toString(),
        requestedByTier: row.requested_by_tier,
        requestedByTierLabel: ADMIN_TIER_LABELS[row.requested_by_tier],
        targetType: row.target_type,
        targetId: row.target_id,
        payload: row.payload,
        approverId: row.approver_id ? row.approver_id.toString() : null,
        decidedAt: row.decided_at ? row.decided_at.toISOString() : null,
        decisionNote: row.decision_note,
        failureReason: row.failure_reason,
        expiresAt: row.expires_at.toISOString(),
        createdAt: row.created_at.toISOString(),
    };
}

/**
 * Whether this call must be queued rather than executed.
 *
 * Evaluated against the VALIDATED payload, so a threshold rule reads a number Zod has
 * already parsed rather than a string off the wire.
 */
export function dualControlRequired(action: PermissionName, payload: Record<string, unknown>): boolean {
    const spec = permissionSpec(action).dualControl;
    return spec !== undefined && spec.when(payload);
}

export interface RequestApprovalInput {
    action: PermissionName;
    requester: AdminIdentity;
    targetType: string;
    targetId: string;
    payload: Record<string, unknown>;
    /** Overrides the catalog's `describe`. Used when the caller has richer context. */
    description?: string;
    /**
     * Join the caller's transaction, so the approval row and the audit row recording that
     * it was queued commit together. Supplied by `auditedQueue`; see its header.
     *
     * Only the money paths pass one today. The escalation paths predate it and create
     * without a session, which is why this is optional rather than required.
     */
    session?: ClientSession;
}

export interface RequestApprovalResult {
    approval: ApprovalDto;
    /** False when an identical request was already queued and this call joined it. */
    created: boolean;
}

/**
 * Queue an action for a second administrator.
 *
 * Idempotent on the intent: an identical request returns the pending row rather than
 * opening a second one. Without that, a double-clicked button produces two approvals for
 * one intent and approving both performs the action twice.
 */
export async function requestApproval(input: RequestApprovalInput): Promise<RequestApprovalResult> {
    const spec = permissionSpec(input.action).dualControl;
    if (!spec) {
        throw createAppError(
            ERROR_CODES.AUTHZ_GRANT_TABLE_INVALID,
            500,
            `"${input.action}" is not a dual-controlled action`,
        );
    }

    const key = approvalRequestKey(input.action, input.targetType, input.targetId, input.payload);

    const existing = await approvals.findPendingByKey(key);
    if (existing) {
        return { approval: toApprovalDto(existing), created: false };
    }

    const expiresAt = new Date(Date.now() + env().ADMIN_APPROVAL_TTL_S * 1000);

    try {
        const created = await approvals.create({
            requestKey: key,
            action: input.action,
            description: input.description ?? spec.describe(input.payload),
            requestedBy: input.requester.adminId,
            requestedByTier: input.requester.tier,
            targetType: input.targetType,
            targetId: input.targetId,
            payload: input.payload,
            expiresAt,
        }, input.session);
        return { approval: toApprovalDto(created), created: true };
    } catch (error) {
        if (isDuplicateKey(error)) {
            /**
             * The partial unique index rejected a concurrent duplicate — two administrators
             * asked for the same thing in the same instant, and the read above missed it.
             *
             * WITHOUT a session: re-read and join it, which is what the caller wanted anyway.
             *
             * WITH one: the write error has already aborted the transaction, so a read on
             * this session cannot run and joining is not available. Report it as the
             * conflict it is — a retry takes the `existing` branch above and answers 202
             * with the pending row. Silently swallowing it would be worse here than
             * anywhere: this path is reached from `auditedQueue`, and returning a DTO for a
             * row the aborted transaction never wrote would leave the caller believing a
             * payout is queued when nothing is.
             */
            if (input.session) {
                throw createAppError(
                    ERROR_CODES.AUTHZ_APPROVAL_ALREADY_RESOLVED,
                    409,
                    'An identical request was queued a moment ago — reload the approval queue',
                );
            }

            const raced = await approvals.findPendingByKey(key);
            if (raced) return { approval: toApprovalDto(raced), created: false };
        }
        throw error;
    }
}

function isDuplicateKey(error: unknown): boolean {
    return typeof error === 'object' && error !== null && (error as { code?: number }).code === 11000;
}

// ─────────────────────────────────────────────────────────────────────────────
// Auditing the decisions (Phase 12)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Until Phase 12 this module wrote no audit row at all, and the consequence was precise:
 * the trail recorded that Y changed a tier, and never that Y approved X's request to. The
 * four-eyes decisions — the control protecting the most dangerous writes the service has —
 * were the only administrative acts leaving no evidence.
 *
 * The action an approval PERFORMS was always audited, by its handler, carrying
 * `via_approval_id`. What was missing is the decision itself, which is a different fact:
 * `approvals.rejected` and `approvals.withdrawn` perform nothing, so without a row here
 * they leave no trace whatsoever, and `approvals.expired` erases a pending request with
 * nobody's name on it.
 *
 * Each decision commits with its row (`wi_admin_txn`), which is why `resolveIfPending`
 * takes a required session.
 */
function decisionIntent(
    action: AuditAction,
    actor: { kind: 'administrator'; identity: AdminIdentity } | { kind: 'system' },
    context: AuditContext,
    row: IApprovalRequest,
    payload: Record<string, unknown> | null,
): AuditIntent {
    return {
        action,
        actor: actor.kind === 'administrator'
            ? auditActorOf(actor.identity)
            : systemActor('approval expiry sweep'),
        // The row is ABOUT the approval…
        target: { type: 'approval_request', id: String(row._id), label: row.action },
        // …and `relatedTarget` is what the approval is about, so an account history
        // (`searchByTarget`, which $ors across both) does not miss a four-eyes decision.
        relatedTarget: relatedTargetOf(row),
        context,
        payload,
        viaApprovalId: String(row._id),
    };
}

function relatedTargetOf(row: IApprovalRequest): AuditTarget {
    return {
        type: toAuditTargetType(row.target_type),
        id: row.target_id ?? null,
        label: row.description ?? null,
    };
}

/** The decision's own before/after, so a row says what moved rather than only that it did. */
function decisionState(row: IApprovalRequest, status: ApprovalStatus, by: string | null) {
    return {
        before: { status: 'pending' as const },
        after: { status, decidedBy: by, action: row.action },
    };
}

/**
 * Expire what is overdue, recording each one.
 *
 * ── Why this is no longer a single `updateMany` ───────────────────────────────
 * An expiry ends a pending administrative request without anybody deciding anything, and
 * Phase 12 gives it a row — `approvals.expired`, actor `system`. One row per request means
 * one write per request, which a bulk update cannot produce.
 *
 * That cost lands on a READ path (all three readers below sweep first), so two bounds keep
 * it honest:
 *
 *   - **batch size** — at most `EXPIRY_SWEEP_BATCH` per call. A backlog drains across
 *     several reads instead of opening an unbounded number of transactions in one request.
 *   - **throttle** — at most one sweep per `ADMIN_APPROVAL_SWEEP_MIN_INTERVAL_MS`. Listing
 *     the queue used to run the sweep on every keystroke of a paging client.
 *
 * Both are per-instance and deliberately approximate: the compare-and-set in
 * `expireOneIfPending` is what makes correctness independent of them, so a second instance
 * sweeping the same rows produces skips, not duplicate rows.
 *
 * A failure here must not fail the read that triggered it. An expired-but-unstamped request
 * is refused by `assertDecidable` anyway — it compares `expires_at` against the clock, not
 * only `status` — so the sweep is a bookkeeping convenience, not the enforcement.
 *
 * ⚠ **That sentence was FALSE from the day it was written until 2026-08-20** (F-1, Phase 4
 * step 24). `assertDecidable` branched on `status` alone, so this sweep *was* the whole
 * enforcement, and a request could be approved after its deadline in the window between the
 * two. Fixed at `assertDecidable`, where the reasoning now lives. Kept here because the
 * mis-statement is the lesson: a docstring asserting what a *different* function does is an
 * unverified claim, and this one stopped three `verify:authz` failures from being believed
 * for weeks.
 */
const EXPIRY_SWEEP_BATCH = 50;
let lastSweepAt = 0;

export async function expireOverdue(now: Date = new Date()): Promise<number> {
    if (now.getTime() - lastSweepAt < env().ADMIN_APPROVAL_SWEEP_MIN_INTERVAL_MS) return 0;
    lastSweepAt = now.getTime();

    let expired = 0;

    for (const approvalId of await approvals.findOverdueIds(now, EXPIRY_SWEEP_BATCH)) {
        const row = await approvals.findById(approvalId);
        if (!row) continue;
        if (await expireOneRow(row, now, '#expireOverdue')) expired += 1;
    }

    return expired;
}

/**
 * Stamp ONE overdue request `expired`, as the system actor. Never throws.
 *
 * Extracted from the sweep so a single named row can be stamped **without** one — see
 * `loadFresh`, which needs exactly that and cannot wait for the throttle. Idempotent by
 * construction: `expireOneIfPending` is a compare-and-set on `status: 'pending'`, so a
 * concurrent decision or a second instance produces a skip rather than a duplicate row.
 *
 * @returns whether this call is the one that stamped it.
 */
async function expireOneRow(row: IApprovalRequest, now: Date, source: string): Promise<boolean> {
    const approvalId = row._id.toString();

    try {
        await auditedTransaction<IApprovalRequest>(
            decisionIntent(
                'approvals.expired',
                { kind: 'system' },
                systemContext(`dual-control/domain/approval.service${source}`),
                row,
                { action: row.action, expiresAt: row.expires_at.toISOString() },
            ),
            async (session) => {
                const result = await approvals.expireOneIfPending(approvalId, now, session);
                if (!result) {
                    // Another instance won, or it was decided in between. Not an error —
                    // the outcome is recorded, by whoever got there first.
                    throw new ApprovalAlreadyResolved();
                }
                return { result, ...decisionState(result, 'expired', null) };
            },
        );
        return true;
    } catch (error) {
        if (error instanceof ApprovalAlreadyResolved) return false;
        // Never fail the read this was called from — see the header.
        logger().warn({ approvalId, err: String(error) }, 'approval expiry could not stamp a row');
        return false;
    }
}

/** Internal-only: the sweep losing a race is a skip, not a 409 for the caller. */
class ApprovalAlreadyResolved extends Error {}

/** Lazily stamp overdue requests, then read. No sweeper process to own or monitor. */
/**
 * Load the request a decision is about to be made on, expiring it first if it is overdue.
 *
 * ── Two expiries, and the second is not redundant ─────────────────────────────
 * `expireOverdue()` is the batch sweep and is **throttled** by
 * `ADMIN_APPROVAL_SWEEP_MIN_INTERVAL_MS` — so on any request inside that window it does
 * nothing at all, which is precisely when a caller is most likely to be racing a deadline.
 * The row this call names is then stamped **unthrottled**: one compare-and-set on one
 * document is bounded work that needs no protection, and the throttle exists to stop an
 * unbounded number of transactions opening on a read path.
 *
 * Without it an overdue request was correctly *refused* (`assertDecidable` compares the
 * clock) and left sitting at `pending` — visible in the queue, un-actionable, and with no
 * `approvals.expired` row in the audit trail until some later read happened to sweep it.
 * The refusal and the bookkeeping now agree, which is what `expireOverdue`'s docstring has
 * always claimed. (Phase 4 step 24, the third of F-1's three `verify:authz` assertions.)
 *
 * `assertDecidable` keeps its own clock comparison as the backstop: if this stamp loses a
 * race or fails, the decision is still refused.
 */
async function loadFresh(approvalId: string): Promise<IApprovalRequest> {
    await expireOverdue();

    const row = await approvals.findById(approvalId);
    if (!row) {
        throw createAppError(ERROR_CODES.AUTHZ_APPROVAL_NOT_FOUND, 404);
    }

    const now = new Date();
    if (row.status === 'pending' && row.expires_at.getTime() <= now.getTime()) {
        await expireOneRow(row, now, '#loadFresh');
        // Re-read so the caller sees the stamped status rather than the stale one; falling
        // back to `row` keeps the clock comparison in `assertDecidable` as the guarantee.
        return (await approvals.findById(approvalId)) ?? row;
    }

    return row;
}

export interface ListApprovalsInput {
    status?: ApprovalStatus;
    action?: string;
    targetId?: string;
    page: number;
    limit: number;
}

export async function listApprovals(
    input: ListApprovalsInput,
): Promise<{ items: ApprovalDto[]; total: number }> {
    await expireOverdue();
    const { items, total } = await approvals.list(input);
    return { items: items.map(toApprovalDto), total };
}

export async function getApproval(approvalId: string): Promise<ApprovalDto> {
    return toApprovalDto(await loadFresh(approvalId));
}

/**
 * Approve and PERFORM the action.
 *
 * Three gates before anything happens, in this order:
 *   1. the request is still pending and unexpired
 *   2. the approver is not the requester — the entire point
 *   3. the approver holds the permission the action names, so approving is not a way to
 *      do something you could not have done yourself
 *
 * The handler then re-checks its own preconditions against current state, because the
 * world moves while a request sits in the queue.
 */
export async function approve(
    approvalId: string,
    approver: AdminIdentity,
    note: string | null,
    context: AuditContext,
): Promise<ApprovalDto> {
    const row = await loadFresh(approvalId);

    assertDecidable(row);

    if (row.requested_by.toString() === approver.adminId) {
        recordAuthorizationDenial({
            kind: 'dual_control',
            adminId: approver.adminId,
            tier: approver.tier,
            sessionId: approver.sessionId,
            required: [],
            reason: ERROR_CODES.AUTHZ_APPROVAL_SELF_APPROVAL,
            targetId: row.target_id,
            method: context.method,
            path: context.path,
            requestId: context.requestId,
            ip: context.ip,
            userAgent: context.userAgent,
        });
        throw createAppError(ERROR_CODES.AUTHZ_APPROVAL_SELF_APPROVAL, 403);
    }

    const { action, approverPermission } = resolveAction(row);

    if (!hasPermission(approver.tier, approverPermission)) {
        recordAuthorizationDenial({
            kind: 'dual_control',
            adminId: approver.adminId,
            tier: approver.tier,
            sessionId: approver.sessionId,
            required: [approverPermission],
            reason: ERROR_CODES.AUTHZ_PERMISSION_DENIED,
            targetId: row.target_id,
            method: context.method,
            path: context.path,
            requestId: context.requestId,
            ip: context.ip,
            userAgent: context.userAgent,
        });
        throw createAppError(ERROR_CODES.AUTHZ_PERMISSION_DENIED, 403, undefined, {
            required: [approverPermission],
        });
    }

    const handler = dualControlHandlerFor(action);
    if (!handler) {
        // `assertDualControlHandlersRegistered()` runs at boot, so reaching this means the
        // registry was mutated at runtime — a programming error, not a caller error.
        throw createAppError(
            ERROR_CODES.AUTHZ_GRANT_TABLE_INVALID,
            500,
            `No handler registered for the approved action "${action}"`,
        );
    }

    /**
     * Claim it FIRST. Two administrators hitting approve simultaneously both pass the
     * checks above; the filtered update is what makes exactly one of them the approver,
     * and it must win before the action runs rather than after.
     *
     * The claim and the row recording it commit together — so the approver's decision is
     * evidence even if the action it authorises then fails. The HANDLER deliberately stays
     * outside: it opens its own transaction for the write it performs, and nesting the two
     * would put an arbitrary domain write (and, for a delegated action, an HTTP call)
     * inside a `withTransaction` callback that re-runs on conflict.
     */
    const claimed = await auditedTransaction<IApprovalRequest>(
        decisionIntent('approvals.approved', { kind: 'administrator', identity: approver }, context, row, {
            action: row.action,
            note,
        }),
        async (session) => {
            const result = await approvals.resolveIfPending(approvalId, 'approved', approver.adminId, note, session);
            if (!result) {
                throw createAppError(ERROR_CODES.AUTHZ_APPROVAL_ALREADY_RESOLVED, 409);
            }
            return { result, ...decisionState(result, 'approved', approver.adminId) };
        },
    );

    try {
        // The context travels with it: the handler performs the WRITE, and that write is
        // audited with the approver's request — path, IP and correlation id included.
        // Without this the four-eyes actions, the most consequential writes the service
        // has, would produce the least traceable rows.
        await handler(claimed, approver, context);
    } catch (error) {
        // The row stays `approved` and records why. Reverting it to pending would let a
        // second approver commit an action the first already agreed to, with nothing
        // recording that the first attempt failed.
        const reason = error instanceof Error ? error.message : String(error);
        await approvals.recordFailure(approvalId, reason);
        logger().error({ approvalId, action, err: reason }, 'approved action failed to execute');
        throw error;
    }

    const final = await approvals.findById(approvalId);
    return toApprovalDto(final ?? claimed);
}

/**
 * `context` became required in Phase 12. A rejection performs nothing, so this row is the
 * ONLY record that the request existed and was refused — and a record of a refusal with no
 * path, IP or correlation id is barely a record.
 */
export async function reject(
    approvalId: string,
    approver: AdminIdentity,
    note: string | null,
    context: AuditContext,
): Promise<ApprovalDto> {
    const row = await loadFresh(approvalId);
    assertDecidable(row);

    // Rejecting your own request is just withdrawing it, and refusing that would strand
    // a request its author no longer wants. It is recorded as a rejection by the author,
    // which is honest about who ended it.
    const { approverPermission } = resolveAction(row);
    const isRequester = row.requested_by.toString() === approver.adminId;

    if (!isRequester && !hasPermission(approver.tier, approverPermission)) {
        throw createAppError(ERROR_CODES.AUTHZ_PERMISSION_DENIED, 403, undefined, {
            required: [approverPermission],
        });
    }

    const resolved = await auditedTransaction<IApprovalRequest>(
        decisionIntent('approvals.rejected', { kind: 'administrator', identity: approver }, context, row, {
            action: row.action,
            note,
            byRequester: isRequester,
        }),
        async (session) => {
            const result = await approvals.resolveIfPending(approvalId, 'rejected', approver.adminId, note, session);
            if (!result) {
                throw createAppError(ERROR_CODES.AUTHZ_APPROVAL_ALREADY_RESOLVED, 409);
            }
            return { result, ...decisionState(result, 'rejected', approver.adminId) };
        },
    );

    return toApprovalDto(resolved);
}

/** The requester takes their own request back. Only ever their own. */
export async function withdraw(
    approvalId: string,
    requester: AdminIdentity,
    context: AuditContext,
): Promise<ApprovalDto> {
    const row = await loadFresh(approvalId);
    assertDecidable(row);

    if (row.requested_by.toString() !== requester.adminId) {
        throw createAppError(ERROR_CODES.AUTHZ_APPROVAL_NOT_FOUND, 404);
    }

    const resolved = await auditedTransaction<IApprovalRequest>(
        decisionIntent('approvals.withdrawn', { kind: 'administrator', identity: requester }, context, row, {
            action: row.action,
        }),
        async (session) => {
            const result = await approvals.resolveIfPending(approvalId, 'withdrawn', requester.adminId, null, session);
            if (!result) {
                throw createAppError(ERROR_CODES.AUTHZ_APPROVAL_ALREADY_RESOLVED, 409);
            }
            return { result, ...decisionState(result, 'withdrawn', requester.adminId) };
        },
    );

    return toApprovalDto(resolved);
}

/**
 * Refuse a decision on a request that is not decidable — resolved, withdrawn, or **overdue**.
 *
 * ── The clock is compared HERE, and it was not until 2026-08-20 (F-1) ─────────
 * This branched on `row.status` alone, so a request past `expires_at` that the sweep had not
 * yet stamped was still `pending` and was **approved normally** — a live run answered `202`,
 * not `409`. Enforcement therefore rested entirely on `expireOverdue` having got there first,
 * and that sweep is throttled by `ADMIN_APPROVAL_SWEEP_MIN_INTERVAL_MS` and runs only on a
 * read path, so the window was operational rather than theoretical.
 *
 * ⚠ **The code said otherwise, in writing.** `expireOverdue`'s docstring stated that an
 * expired-but-unstamped request *"is refused by `assertDecidable` anyway (it compares
 * `expires_at`), so the sweep is a bookkeeping convenience, not the enforcement"*. Every
 * clause of that was false, and it is exactly the sentence that stops a reader from checking.
 * The comparison below is what makes it true; the docstring is now accurate rather than
 * aspirational.
 *
 * ── Why the status check stays FIRST ──────────────────────────────────────────
 * A row already stamped `expired` must keep answering `AUTHZ_APPROVAL_EXPIRED`, and a
 * `rejected` or `withdrawn` row must keep answering `AUTHZ_APPROVAL_ALREADY_RESOLVED` with
 * its own status in `details` — an overdue-but-rejected request was rejected, and reporting
 * it as expired would rewrite what happened. The clock only decides the `pending` case.
 *
 * ── This does not make the sweep redundant ────────────────────────────────────
 * It makes it what its docstring always claimed: bookkeeping. The stamped row is what the
 * queue lists and what the audit trail records; this guard only stops one being *acted on*
 * in the gap before the sweep reaches it.
 *
 * @param now injected so the boundary is testable without waiting for one.
 */
function assertDecidable(row: IApprovalRequest, now: Date = new Date()): void {
    if (row.status === 'expired') {
        throw createAppError(ERROR_CODES.AUTHZ_APPROVAL_EXPIRED, 409);
    }
    if (row.status !== 'pending') {
        throw createAppError(ERROR_CODES.AUTHZ_APPROVAL_ALREADY_RESOLVED, 409, undefined, {
            status: row.status,
        });
    }
    if (row.expires_at.getTime() <= now.getTime()) {
        // Same code and same status as a swept row: the caller must not be able to tell
        // whether the sweep had run, and the remedy — raise it again — is identical.
        throw createAppError(ERROR_CODES.AUTHZ_APPROVAL_EXPIRED, 409);
    }
}

/**
 * Recover the catalog entry behind a stored row.
 *
 * `action` is a plain string in Mongo, so a row written before a permission was renamed
 * can name something the catalog no longer has. That is refused rather than guessed at:
 * a request whose action cannot be resolved must not be approvable.
 */
function resolveAction(row: IApprovalRequest): { action: PermissionName; approverPermission: PermissionName } {
    if (!isPermissionName(row.action)) {
        throw createAppError(
            ERROR_CODES.AUTHZ_GRANT_TABLE_INVALID,
            500,
            `Approval request names the unknown action "${row.action}"`,
        );
    }

    const spec = permissionSpec(row.action).dualControl;
    if (!spec || !isPermissionName(spec.approverPermission)) {
        throw createAppError(
            ERROR_CODES.AUTHZ_GRANT_TABLE_INVALID,
            500,
            `"${row.action}" no longer declares a usable dual-control spec`,
        );
    }

    return { action: row.action, approverPermission: spec.approverPermission };
}
