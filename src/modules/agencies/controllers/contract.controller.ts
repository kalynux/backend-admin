import { Request, Response } from 'express';
import { asyncHandler } from '../../../core/http/async-handler';
import { createAppError } from '../../../core/errors/app-error';
import { ERROR_CODES } from '../../../core/errors/error-codes';
import { sendSuccess } from '../../../core/http/responses';
import { actorContextOf } from '../../audit/domain/audit-context';
import * as gateway from '../gateways/contract.gateway';
import { toContractDetailDto } from '../read-models/contract.dto';
import {
    ContractReadModel,
    ContractReadRepository,
} from '../repositories/contract.read.repository';
import { ContractReasonBody } from '../validators/contract.validator';

/**
 * `/api/v1/contracts` — ONE agent↔agency contract, addressable by its own id.
 *
 * ── Why a mount of its own rather than a path under `/agents` or `/agencies` ──
 * A contract belongs to both and to neither. Hanging it off either directory would make
 * the url claim a primary party that does not exist, and would force a caller holding only
 * a contract id — which is what a support ticket carries — to know an agent id first.
 *
 * The read requires BOTH `agencies.read` and `agents.read`, matching the roster: it
 * discloses a party from each directory, so holding one permission is not enough. The
 * writes require `agents.contracts.manage`.
 */

const contracts = new ContractReadRepository();

/**
 * Load the contract or 404 — and it is the same read the response would make anyway.
 *
 * Reading before delegating buys the two things jovi-mall's answer cannot provide: the
 * previous state for the audit diff, and a 404 that says "no such contract" rather than a
 * `PLATFORM_OPERATION_REJECTED` wrapping one.
 */
async function loadOr404(contractId: string): Promise<ContractReadModel> {
    const contract = await contracts.findByIdWithBoth(contractId);
    if (!contract) {
        throw createAppError(ERROR_CODES.CONTRACT_NOT_FOUND, 404, 'Contract not found');
    }
    return contract;
}

export class ContractController {
    /** GET /api/v1/contracts/:contractId — the full terms, with both parties named. */
    static get = asyncHandler(async (req: Request, res: Response) => {
        const contract = await loadOr404(req.params.contractId);

        sendSuccess(res, toContractDetailDto(contract));
    });

    /**
     * POST /api/v1/contracts/:contractId/suspend — body `{ reason }`.
     *
     * Freezes the relationship: no new assignments, terms and balances untouched. It does
     * NOT invent or alter a single term, which is the line the family's other refusals sit
     * on — see the gateway.
     */
    static suspend = asyncHandler(async (req: Request, res: Response) => {
        const before = await loadOr404(req.params.contractId);
        const body = req.body as ContractReasonBody;

        const result = await gateway.suspend(
            req.params.contractId,
            before.agent_id.toString(),
            body.reason,
            gateway.contractAuditState(before),
            actorContextOf(req),
        );

        sendSuccess(res, result, { message: 'Contract suspended' });
    });

    /** POST /api/v1/contracts/:contractId/reinstate — body `{ reason }`. */
    static reinstate = asyncHandler(async (req: Request, res: Response) => {
        const before = await loadOr404(req.params.contractId);
        const body = req.body as ContractReasonBody;

        const result = await gateway.reinstate(
            req.params.contractId,
            before.agent_id.toString(),
            body.reason,
            gateway.contractAuditState(before),
            actorContextOf(req),
        );

        sendSuccess(res, result, { message: 'Contract reinstated' });
    });

    /**
     * POST /api/v1/contracts/:contractId/terminate — body `{ reason }`.
     *
     * ⚠ **A 200 here does not mean the contract ended.** Deactivation needs the
     * counterparty's agreement and the outstanding COD and agent payment cleared; when
     * they are not met the answer carries `contract: null`, a `pendingRequest` and the
     * `blockers`. The message says which happened, and a client must branch on the data
     * rather than on the status.
     *
     * There is no override, deliberately: ending a relationship that still owes an agent
     * money is how that money stops being anybody's responsibility.
     */
    static terminate = asyncHandler(async (req: Request, res: Response) => {
        const before = await loadOr404(req.params.contractId);
        const body = req.body as ContractReasonBody;

        const result = await gateway.terminate(
            req.params.contractId,
            before.agent_id.toString(),
            body.reason,
            gateway.contractAuditState(before),
            actorContextOf(req),
        );

        const completed = (result as { contract?: unknown } | null)?.contract !== null;

        sendSuccess(res, result, {
            message: completed
                ? 'Contract terminated'
                : 'Termination requested — it completes once the counterparty agrees and the outstanding balances are clear',
        });
    });
}
