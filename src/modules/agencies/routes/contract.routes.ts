import { Router } from 'express';
import { defineRoute, permission, records } from '../../../api/route-manifest';
import { ContractController } from '../controllers/contract.controller';
import {
    ContractIdParamSchema,
    ContractReasonSchema,
} from '../validators/contract.validator';

/**
 * `/api/v1/contracts` — one agent↔agency contract, by its own id.
 *
 * ── The read ─────────────────────────────────────────────────────────────────
 * `agencies.read` + `agents.read`, in `all` mode, matching the roster: this payload names
 * a party from each directory, so holding one permission is not enough to see it. It makes
 * a contract ADDRESSABLE, which it was not — an operator could not link a colleague to
 * one, and a support ticket quoting a contract id had nowhere to point.
 *
 * ── The writes, and the three that are not here ──────────────────────────────
 * Suspend, reinstate, terminate. There is no approve, no edit-terms and no COD-threshold
 * write, and those refusals are argued in `gateways/contract.gateway.ts` rather than
 * inherited: "do not let an administrator impose terms" and "do not let an administrator
 * stop an abusive relationship" are different claims, and only the first was ever made.
 *
 * Every write is delegated, requires a 3–500 character reason, and is audited under its
 * own action name — three names for one permission, because suspending and reinstating are
 * opposite acts and a single label makes the trail unreadable.
 *
 * ⚠ `terminate` is the one verb on this service that routinely answers 200 without doing
 * what its name says: deactivation needs the counterparty and the cash conditions, and the
 * audit row records which happened.
 */
const router = Router();
const mountedAt = '/contracts';

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/:contractId',
    access: permission('agencies.read', 'agents.read'),
    validate: { params: ContractIdParamSchema },
    handler: ContractController.get,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/:contractId/suspend',
    access: permission('agents.contracts.manage'),
    validate: { params: ContractIdParamSchema, body: ContractReasonSchema },
    audit: records('agents.contracts.suspend'),
    handler: ContractController.suspend,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/:contractId/reinstate',
    access: permission('agents.contracts.manage'),
    validate: { params: ContractIdParamSchema, body: ContractReasonSchema },
    audit: records('agents.contracts.reinstate'),
    handler: ContractController.reinstate,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/:contractId/terminate',
    access: permission('agents.contracts.manage'),
    validate: { params: ContractIdParamSchema, body: ContractReasonSchema },
    audit: records('agents.contracts.terminate'),
    handler: ContractController.terminate,
});

export { router as contractRoutes };
