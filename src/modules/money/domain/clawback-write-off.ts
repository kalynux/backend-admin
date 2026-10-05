import { createAppError } from '../../../core/errors/app-error';
import { ERROR_CODES } from '../../../core/errors/error-codes';
import { AdminIdentity } from '../../admin-identity/domain/admin-identity.types';
import { ActorContext, auditActorOf } from '../../audit/domain/audit-context';
import { AuditContext, AuditIntent } from '../../audit/domain/audit.types';
import { auditedQueue } from '../../audit/domain/audit.writer';
import * as approvals from '../../dual-control/domain/approval.service';
import { registerDualControlHandler } from '../../dual-control/domain/dual-control.registry';
import { IApprovalRequest } from '../../dual-control/models/approval-request.model';
import * as gateway from '../gateways/money.gateway';
import {
    EarningsAccountDebtReadModel,
    EarningsAccountDebtReadRepository,
} from '../repositories/earnings-account.read.repository';

/**
 * Writing off a refund debt (REFUND-FLOW-PLAN § 6.4, owner decision C-6): the direct path, the
 * four-eyes path at ≥ 2,000,000 (`LARGE_WRITE_OFF`), and the handler a second administrator's
 * approval runs. Shaped like `payout-dual-control.ts`, for the same reason — the write happens
 * from two entry points and the rules must live in one.
 *
 * The pre-flight reads the debt DIRECTLY and refuses a write-off larger than it: the approval
 * queue is not the place to discover a request that cannot succeed. jovi-mall enforces the same
 * (`EARNINGS_CLAWBACK_WRITE_OFF_EXCEEDS_DEBT`, `EARNINGS_CLAWBACK_NOTHING_OWED`) under its own
 * compare-and-set; this is the pre-flight, not the control.
 */

const accounts = new EarningsAccountDebtReadRepository();

export const WRITE_OFF_MODE = 'clawback_write_off';

export type WriteOffOutcome =
    | { kind: 'applied'; account: EarningsAccountDebtReadModel | null }
    | { kind: 'queued'; approval: approvals.ApprovalDto; created: boolean };

/** The debt, or 409 when it is smaller than the amount (or there is none). */
export async function loadDebtCovering(
    ownerType: gateway.ClawbackOwnerType,
    ownerId: string,
    amount: number,
): Promise<EarningsAccountDebtReadModel> {
    const account = await accounts.findOwner(ownerType, ownerId);
    const owed = account?.clawback_balance ?? 0;
    if (!account || owed <= 0 || amount > owed) {
        throw createAppError(ERROR_CODES.EARNINGS_CLAWBACK_WRITE_OFF_EXCEEDS_DEBT, 409, undefined, {
            owed,
            requested: amount,
        });
    }
    return account;
}

function labelOf(ownerType: string, ownerId: string): string {
    return `${ownerType} ${ownerId}`;
}

/** Hashed into the approval key: the owner, the amount AND the reason are what was signed for. */
export function writeOffPayload(
    ownerType: gateway.ClawbackOwnerType,
    ownerId: string,
    account: EarningsAccountDebtReadModel,
    input: { amount: number; reason: string },
): Record<string, unknown> {
    return {
        ownerType,
        ownerId,
        amount: input.amount,
        currency: account.currency,
        reason: input.reason,
        mode: WRITE_OFF_MODE,
    };
}

export async function writeOff(
    actor: AdminIdentity,
    ownerType: gateway.ClawbackOwnerType,
    ownerId: string,
    input: { amount: number; reason: string },
    context: ActorContext,
): Promise<WriteOffOutcome> {
    const account = await loadDebtCovering(ownerType, ownerId, input.amount);
    const payload = writeOffPayload(ownerType, ownerId, account, input);

    if (approvals.dualControlRequired('money.earnings.clawback.write_off', payload)) {
        const outcome = await auditedQueue(queuedIntent(actor, context, ownerType, ownerId, payload), async (session) => {
            const result = await approvals.requestApproval({
                action: 'money.earnings.clawback.write_off',
                requester: actor,
                targetType: ownerType,
                targetId: ownerId,
                payload,
                session,
            });
            return { result, approvalId: result.approval.id };
        });
        return { kind: 'queued', approval: outcome.approval, created: outcome.created };
    }

    await perform(ownerType, ownerId, input, account, context, null);
    return { kind: 'applied', account: await accounts.findOwner(ownerType, ownerId) };
}

function perform(
    ownerType: gateway.ClawbackOwnerType,
    ownerId: string,
    input: { amount: number; reason: string },
    account: EarningsAccountDebtReadModel,
    context: ActorContext,
    viaApprovalId: string | null,
): Promise<gateway.PlatformClawbackWriteOff> {
    return gateway.writeOffClawback(
        ownerType,
        ownerId,
        input,
        {
            label: labelOf(ownerType, ownerId),
            before: { clawbackBalance: account.clawback_balance ?? 0 },
            currency: account.currency,
        },
        context,
        viaApprovalId,
    );
}

const QUEUED_ACTION = {
    vendor: 'money.earnings.clawback.write_off_vendor',
    agency: 'money.earnings.clawback.write_off_agency',
    agent: 'money.earnings.clawback.write_off_agent',
} as const;

function queuedIntent(
    actor: AdminIdentity,
    context: AuditContext,
    ownerType: gateway.ClawbackOwnerType,
    ownerId: string,
    payload: Record<string, unknown>,
): AuditIntent {
    return {
        action: QUEUED_ACTION[ownerType],
        actor: auditActorOf(actor),
        target: { type: ownerType, id: ownerId, label: labelOf(ownerType, ownerId) },
        relatedTarget: { type: ownerType, id: ownerId },
        context,
        payload,
    };
}

/**
 * The approver's request performs the write-off. Re-checked against current state: the owner
 * must STILL owe at least the approved amount (a release since may have repaid part of it), and
 * the currency must be the one signed for.
 */
registerDualControlHandler(
    'money.earnings.clawback.write_off',
    async (approval: IApprovalRequest, approver, context) => {
        const ownerType = String(approval.payload.ownerType) as gateway.ClawbackOwnerType;
        const ownerId = String(approval.payload.ownerId);
        const amount = Number(approval.payload.amount);
        const reason = String(approval.payload.reason);

        if (!['vendor', 'agency', 'agent'].includes(ownerType)) {
            throw createAppError(ERROR_CODES.AUTHZ_GRANT_TABLE_INVALID, 500, 'A write-off approval names an unknown owner type');
        }

        const account = await loadDebtCovering(ownerType, ownerId, amount);
        if (account.currency !== approval.payload.currency) {
            throw createAppError(
                ERROR_CODES.AUTHZ_APPROVAL_ALREADY_RESOLVED,
                409,
                'This account’s currency changed since the write-off was approved',
            );
        }

        await perform(ownerType, ownerId, { amount, reason }, account, { ...context, actor: approver }, approval._id.toString());
    },
);
