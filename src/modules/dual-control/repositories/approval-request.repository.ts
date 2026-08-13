import { ClientSession, Types } from 'mongoose';
import { AdminTier } from '../../admin-identity/domain/admin-identity.types';
import { ApprovalRequestModel, ApprovalStatus, IApprovalRequest } from '../models/approval-request.model';

/**
 * Data access for `admin_approval_requests`.
 *
 * Status transitions go through the `...IfPending` methods, which carry
 * `status: 'pending'` in the FILTER rather than checking it first. Two administrators
 * approving the same request in the same second is a real race — the queue is a shared
 * screen — and a read-then-write would let both succeed and perform the action twice.
 * Filtering on the current status makes the database pick a winner; the loser gets `null`
 * and reports that the request was already decided.
 */

export interface CreateApprovalInput {
    requestKey: string;
    action: string;
    description: string;
    requestedBy: string;
    requestedByTier: AdminTier;
    targetType: string;
    targetId: string;
    payload: Record<string, unknown>;
    expiresAt: Date;
}

export interface ListApprovalsFilter {
    status?: ApprovalStatus;
    action?: string;
    targetId?: string;
    page: number;
    limit: number;
}

export class ApprovalRequestRepository {
    /**
     * @param session when supplied, the row joins the caller's transaction — which is how
     *        `auditedQueue` makes the approval and the audit row recording it commit
     *        together. Optional rather than required because the escalation paths that
     *        predate Phase 11 create without one.
     *
     * The array form of `create` is not optional once a session is involved:
     * `create(doc, options)` is read as a SECOND DOCUMENT by some Mongoose versions, which
     * would silently write the row outside the session. Same trap `auditedTransaction`
     * documents, and the reason both branches spell it out rather than sharing one call.
     */
    async create(input: CreateApprovalInput, session?: ClientSession): Promise<IApprovalRequest> {
        const doc = {
            request_key: input.requestKey,
            action: input.action,
            description: input.description,
            requested_by: new Types.ObjectId(input.requestedBy),
            requested_by_tier: input.requestedByTier,
            target_type: input.targetType,
            target_id: input.targetId,
            payload: input.payload,
            status: 'pending' as const,
            expires_at: input.expiresAt,
        };

        if (!session) return ApprovalRequestModel().create(doc);

        const [created] = await ApprovalRequestModel().create([doc], { session });
        return created;
    }

    async findById(approvalId: string): Promise<IApprovalRequest | null> {
        if (!Types.ObjectId.isValid(approvalId)) return null;
        return ApprovalRequestModel().findById(approvalId);
    }

    /** The row the idempotency key points at, if the intent is already queued. */
    async findPendingByKey(requestKey: string): Promise<IApprovalRequest | null> {
        return ApprovalRequestModel().findOne({ request_key: requestKey, status: 'pending' });
    }

    async list(filter: ListApprovalsFilter): Promise<{ items: IApprovalRequest[]; total: number }> {
        const query: Record<string, unknown> = {};
        if (filter.status) query.status = filter.status;
        if (filter.action) query.action = filter.action;
        if (filter.targetId) query.target_id = filter.targetId;

        const [items, total] = await Promise.all([
            ApprovalRequestModel()
                .find(query)
                .sort({ created_at: -1 })
                .skip((filter.page - 1) * filter.limit)
                .limit(filter.limit),
            ApprovalRequestModel().countDocuments(query),
        ]);

        return { items, total };
    }

    /**
     * Claim a pending request as decided. Returns `null` when it was not pending — either
     * already decided, or claimed by another administrator a moment earlier.
     *
     * `session` is REQUIRED, for the reason `create`'s is optional-but-supplied: a decision
     * on a four-eyes request IS the administrative act, and Phase 12 makes it commit with
     * the row recording it. Typing it required means a decision cannot be claimed outside
     * `auditedTransaction`, which is the only place a session comes from.
     *
     * ⚠️ Inside a transaction the losing side of this compare-and-set may surface as a
     * `WriteConflict` rather than as `null`. `withTransaction` retries transient errors, so
     * the retry re-reads, matches nothing and returns `null` — the intended path. Do not
     * "simplify" the caller by assuming only `null` can mean lost.
     */
    async resolveIfPending(
        approvalId: string,
        status: Exclude<ApprovalStatus, 'pending'>,
        approverId: string | null,
        note: string | null,
        session: ClientSession,
    ): Promise<IApprovalRequest | null> {
        if (!Types.ObjectId.isValid(approvalId)) return null;
        return ApprovalRequestModel().findOneAndUpdate(
            { _id: approvalId, status: 'pending' },
            {
                $set: {
                    status,
                    approver_id: approverId ? new Types.ObjectId(approverId) : null,
                    decided_at: new Date(),
                    decision_note: note,
                },
            },
            { new: true, session },
        );
    }

    /**
     * Record that performing an approved action failed.
     *
     * The row stays `approved` rather than reverting to `pending`: it WAS approved, and
     * silently re-queueing it would let a second approver commit an action the first
     * already agreed to, with nothing recording that the first attempt broke.
     */
    async recordFailure(approvalId: string, reason: string): Promise<void> {
        await ApprovalRequestModel().updateOne(
            { _id: approvalId },
            { $set: { failure_reason: reason } },
        );
    }

    /**
     * The ids of requests whose deadline has passed, newest deadline last, bounded.
     *
     * Replaces the `updateMany` this used to be. An expiry is a state change that ends a
     * pending administrative request, so Phase 12 gives each one its own audit row — and a
     * row per expiry means a row per document, which a bulk update cannot produce.
     *
     * Bounded because the caller runs on a READ path (`loadFresh`, `listApprovals`,
     * `getApproval` all sweep first). A backlog is drained across several reads rather than
     * opening an unbounded number of transactions inside one request.
     */
    async findOverdueIds(now: Date, limit: number): Promise<string[]> {
        const rows = await ApprovalRequestModel()
            .find({ status: 'pending', expires_at: { $lte: now } })
            .select({ _id: 1 })
            .sort({ expires_at: 1 })
            .limit(limit)
            .lean();

        return rows.map((row) => String(row._id));
    }

    /**
     * Stamp ONE overdue request, if it is still pending.
     *
     * Compare-and-set on `status` so two instances sweeping at once cannot both expire the
     * same row and write two audit rows for one event — and so a request approved in the
     * instant between the read above and this write is not clobbered by the sweep. A miss
     * returns `null` and the caller skips it silently, which is the correct outcome: the
     * other party's outcome is already recorded.
     */
    async expireOneIfPending(
        approvalId: string,
        now: Date,
        session: ClientSession,
    ): Promise<IApprovalRequest | null> {
        if (!Types.ObjectId.isValid(approvalId)) return null;
        return ApprovalRequestModel().findOneAndUpdate(
            { _id: approvalId, status: 'pending' },
            { $set: { status: 'expired', decided_at: now } },
            { new: true, session },
        );
    }
}
