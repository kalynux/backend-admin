import { Request, Response } from 'express';
import { requestContext } from '../../audit/domain/audit-context';
import { asyncHandler } from '../../../core/http/async-handler';
import { toPageMeta } from '../../../core/http/list-query';
import { sendCreated, sendPaginated, sendSuccess } from '../../../core/http/responses';
import { AdminStatus, AdminTier, requireAdminIdentity } from '../../admin-identity/domain/admin-identity.types';
import * as administrators from '../domain/administrator.service';
import { activateAdministrator } from '../domain/activation.service';
import { AuditRepository } from '../../audit/repositories/audit.repository';
import { toAuditEntryDto } from '../../audit/domain/audit.dto';
import { ListAuditQuery } from '../../audit/validators/audit.validator';
import {
    CreateAdministratorBody,
    ListAdministratorsQuery,
    ListSessionsQuery,
    SetTierBody,
    SuspendAdministratorBody,
    UpdateAdministratorBody,
} from '../validators/administrator.validator';

/**
 * `/api/v1/administrators`.
 *
 * Thin by design: not one escalation rule lives here. They are all in
 * `administrator.service.ts`, because the same rules must hold when the dual-control
 * handler performs the same write without any controller involved.
 */

const auditEntries = new AuditRepository();

/**
 * `applied` → 200/201 with the administrator; `queued` → **202** with the approval.
 *
 * 202 rather than 403: a queued action was accepted and is waiting for a second
 * administrator. Answering 403 would report a permitted action as a refused one, and the
 * dashboard would show an error where it should show "waiting for approval".
 */
function sendOutcome(res: Response, outcome: administrators.WriteOutcome): void {
    if (outcome.kind === 'applied') {
        sendSuccess(res, outcome.administrator);
        return;
    }

    sendSuccess(res, outcome.approval, {
        status: 202,
        message: outcome.created
            ? 'Submitted for a second administrator’s approval'
            : 'An identical request is already awaiting approval',
    });
}

export class AdministratorController {
    /** GET /api/v1/administrators */
    static list = asyncHandler(async (req: Request, res: Response) => {
        const query = req.query as unknown as ListAdministratorsQuery;

        const { items, total } = await administrators.listAdministrators({
            tier: query.tier as AdminTier | undefined,
            status: query.status as AdminStatus | undefined,
            search: query.search,
            page: query.page,
            limit: query.limit,
        });

        sendPaginated(res, items, toPageMeta(total, query.page, query.limit));
    });

    /**
     * GET /api/v1/administrators/me
     *
     * Declared BEFORE `/:adminId` in the router — Express matches in order, and `me`
     * would otherwise be read as an id and fail the ObjectId check.
     */
    static me = asyncHandler(async (req: Request, res: Response) => {
        const identity = requireAdminIdentity(req);
        sendSuccess(res, await administrators.getAdministrator(identity.adminId));
    });

    /** PATCH /api/v1/administrators/me — the caller's own profile. No permission needed. */
    static updateMe = asyncHandler(async (req: Request, res: Response) => {
        const identity = requireAdminIdentity(req);
        const body = req.body as UpdateAdministratorBody;

        sendSuccess(res, await administrators.updateOwnProfile(identity, body, requestContext(req)));
    });

    /** GET /api/v1/administrators/:adminId */
    static get = asyncHandler(async (req: Request, res: Response) => {
        sendSuccess(res, await administrators.getAdministrator(req.params.adminId));
    });

    /**
     * GET /api/v1/administrators/:adminId/activity — what this administrator DID.
     *
     * The actor half of the trail. Answers oversight: "what has this person been doing".
     */
    static activity = asyncHandler(async (req: Request, res: Response) => {
        const identity = requireAdminIdentity(req);
        const query = req.query as unknown as ListAuditQuery;

        const page = await auditEntries.searchByActor(req.params.adminId, query, identity);
        sendPaginated(res, page.items.map(toAuditEntryDto), page.meta);
    });

    /**
     * GET /api/v1/administrators/:adminId/history — what was done TO this account.
     *
     * The target half. Answers account review: created by whom, promoted when, suspended
     * why — including the changes that went through four-eyes, which are recorded against
     * the approval and related back to the account.
     *
     * This is the question the account row cannot answer on its own: `applyReinstatement`
     * clears `suspended_by` and `suspended_reason`, so without the trail a suspension that
     * was later lifted leaves no trace it ever happened.
     */
    static history = asyncHandler(async (req: Request, res: Response) => {
        const identity = requireAdminIdentity(req);
        const query = req.query as unknown as ListAuditQuery;

        const page = await auditEntries.searchByTarget(req.params.adminId, query, identity);
        sendPaginated(res, page.items.map(toAuditEntryDto), page.meta);
    });

    /**
     * GET /api/v1/administrators/me/activity — the caller's own.
     *
     * `selfService`, so every administrator can see what has been recorded about them
     * without holding `audit.read`. An audit trail people cannot see their own entry in is
     * one they have no way to challenge.
     */
    static myActivity = asyncHandler(async (req: Request, res: Response) => {
        const identity = requireAdminIdentity(req);
        const query = req.query as unknown as ListAuditQuery;

        const page = await auditEntries.searchByActor(identity.adminId, query, identity);
        sendPaginated(res, page.items.map(toAuditEntryDto), page.meta);
    });

    /** POST /api/v1/administrators */
    static create = asyncHandler(async (req: Request, res: Response) => {
        const identity = requireAdminIdentity(req);
        const body = req.body as CreateAdministratorBody;

        const result = await administrators.createAdministrator(identity, body, requestContext(req));

        sendCreated(res, result, {
            message: 'Administrator created. The password below is shown once and is stored nowhere else.',
        });
    });

    /** PATCH /api/v1/administrators/:adminId */
    static update = asyncHandler(async (req: Request, res: Response) => {
        const identity = requireAdminIdentity(req);
        const body = req.body as UpdateAdministratorBody;

        sendSuccess(
            res,
            await administrators.updateAdministrator(identity, req.params.adminId, body, requestContext(req)),
        );
    });

    /** POST /api/v1/administrators/:adminId/suspend */
    static suspend = asyncHandler(async (req: Request, res: Response) => {
        const identity = requireAdminIdentity(req);
        const body = req.body as SuspendAdministratorBody;

        sendOutcome(
            res,
            await administrators.suspendAdministrator(identity, req.params.adminId, body.reason, requestContext(req)),
        );
    });

    /** POST /api/v1/administrators/:adminId/reinstate */
    static reinstate = asyncHandler(async (req: Request, res: Response) => {
        const identity = requireAdminIdentity(req);

        sendOutcome(
            res,
            await administrators.reinstateAdministrator(identity, req.params.adminId, requestContext(req)),
        );
    });

    /**
     * POST /api/v1/administrators/:adminId/activate
     *
     * `sendSuccess`, not `sendOutcome` — activation is never queued for a second Developer.
     * Promotion to tier 1 is dual-controlled because it creates a peer; activation merely lets
     * somebody hold the level they were already created at, under `assertMayCreate`. See
     * `domain/activation.service.ts`.
     */
    static activate = asyncHandler(async (req: Request, res: Response) => {
        const identity = requireAdminIdentity(req);

        sendSuccess(
            res,
            await activateAdministrator(identity, req.params.adminId, requestContext(req)),
            { message: 'Administrator activated' },
        );
    });

    /** PUT /api/v1/administrators/:adminId/tier */
    static setTier = asyncHandler(async (req: Request, res: Response) => {
        const identity = requireAdminIdentity(req);
        const body = req.body as SetTierBody;

        sendOutcome(
            res,
            await administrators.setAdministratorTier(identity, req.params.adminId, body.tier, requestContext(req)),
        );
    });

    /**
     * GET /api/v1/administrators/:adminId/sessions[?includeEnded=true]
     *
     * Live sessions by default. `includeEnded=true` reads the durable history instead —
     * who signed in from where, when it ended, and which of nine reasons ended it.
     */
    static listSessions = asyncHandler(async (req: Request, res: Response) => {
        const identity = requireAdminIdentity(req);
        const query = req.query as unknown as ListSessionsQuery;

        sendSuccess(
            res,
            await administrators.listAdministratorSessions(
                identity,
                req.params.adminId,
                requestContext(req),
                { includeEnded: query.includeEnded === true },
            ),
        );
    });

    /**
     * DELETE /api/v1/administrators/:adminId/sessions/:sessionId
     *
     * One device, not all of them — so a compromised session can be cut off without
     * signing the administrator out everywhere.
     */
    static revokeSession = asyncHandler(async (req: Request, res: Response) => {
        const identity = requireAdminIdentity(req);

        const result = await administrators.revokeAdministratorSession(
            identity,
            req.params.adminId,
            req.params.sessionId,
            requestContext(req),
        );

        sendSuccess(res, result, { message: 'Session ended' });
    });

    /** DELETE /api/v1/administrators/:adminId/sessions */
    static revokeSessions = asyncHandler(async (req: Request, res: Response) => {
        const identity = requireAdminIdentity(req);

        const result = await administrators.revokeAdministratorSessions(
            identity,
            req.params.adminId,
            requestContext(req),
        );

        sendSuccess(res, result, { message: `Ended ${result.revoked} session(s)` });
    });

    /** POST /api/v1/administrators/:adminId/password-reset */
    static resetPassword = asyncHandler(async (req: Request, res: Response) => {
        const identity = requireAdminIdentity(req);

        const result = await administrators.resetAdministratorPassword(
            identity,
            req.params.adminId,
            requestContext(req),
        );

        sendSuccess(res, result, {
            message: 'Password reset and every session ended. The password below is shown once.',
        });
    });

    /**
     * POST /api/v1/administrators/:adminId/mfa-reset
     *
     * The break-glass path for a lost authenticator. Before it existed, `mfa_enrolled` was
     * a one-way door: re-enrolment 409s, nothing cleared the flag, and MFA is mandatory
     * for the senior tiers — so a wiped phone made the account permanently unusable.
     */
    static resetMfa = asyncHandler(async (req: Request, res: Response) => {
        const identity = requireAdminIdentity(req);

        const result = await administrators.resetAdministratorMfa(
            identity,
            req.params.adminId,
            requestContext(req),
        );

        sendSuccess(res, result, {
            message: 'Two-factor enrolment cleared and every session ended. '
                + 'They must sign in with their password and enrol a new authenticator.',
        });
    });
}
