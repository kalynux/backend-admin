import { createAppError } from '../../../core/errors/app-error';
import { ERROR_CODES } from '../../../core/errors/error-codes';
import { AdminIdentity } from '../../admin-identity/domain/admin-identity.types';
import { PERMISSION_NAMES, PermissionName, permissionSpec } from '../../authorization/domain/permission.catalog';
import { IApprovalRequest } from '../models/approval-request.model';
import { AuditContext } from '../../audit/domain/audit.types';

/**
 * What actually happens when the second administrator approves.
 *
 * ── Why a registry rather than a switch ───────────────────────────────────────
 * The approval endpoint is generic — it does not know what it is approving. A dual-
 * controlled action registers the code that performs it, keyed by the permission that
 * names it, and the approval endpoint dispatches.
 *
 * The consequence worth stating: the APPROVER's request performs the write. The requester
 * recorded an intent; the approver commits it. Anything else ("approved — now go and
 * repeat your original call") leaves the action undone whenever the requester never comes
 * back, and makes the approval a suggestion rather than a control.
 *
 * ── The obligation every handler has ──────────────────────────────────────────
 * A handler MUST re-check its preconditions against current state. An approval sits in
 * the queue for up to a day; in that time the target can be suspended, demoted, or
 * deleted, and the requester's own level can change. The escalation rules that ran when
 * the request was made say nothing about the world at approval time, so every handler
 * re-runs them. See `administrators/domain/administrator.service.ts`.
 */

/**
 * The approver's request context, threaded to the handler.
 *
 * Needed because the handler performs the WRITE, and every write on this service is
 * audited with the request that caused it. Without this the row committed by an approval
 * would carry no path, no IP and no correlation id — the four-eyes actions, which are the
 * most consequential writes the service has, would be the least traceable ones.
 *
 * This used to be a local interface, declared "so the registry does not depend on that
 * module" — a fair instinct that produced a third copy of `AuditContext`. Depending on the
 * *audit* module rather than the administrators module keeps that independence and leaves
 * one definition: `audit.types.ts` is where the shape belongs, since the only reason this
 * context exists is to reach an audit row.
 */
export type DualControlHandler = (
    approval: IApprovalRequest,
    approver: AdminIdentity,
    context: AuditContext,
) => Promise<void>;

const handlers = new Map<PermissionName, DualControlHandler>();

/**
 * Register the code that performs `action` once approved.
 *
 * Called at module scope by the module that owns the action, so registration has happened
 * by the time `createApp()` asserts completeness.
 */
export function registerDualControlHandler(action: PermissionName, handler: DualControlHandler): void {
    if (!permissionSpec(action).dualControl) {
        // Registering a handler for an action the catalog does not dual-control means one
        // of the two is wrong, and the failure mode if it is the catalog is that the
        // action executes immediately with no second approver.
        throw createAppError(
            ERROR_CODES.AUTHZ_GRANT_TABLE_INVALID,
            500,
            `"${action}" has a dual-control handler but no dualControl spec in the catalog`,
        );
    }
    handlers.set(action, handler);
}

export function dualControlHandlerFor(action: PermissionName): DualControlHandler | undefined {
    return handlers.get(action);
}

/** Test-only: drop registrations so a suite can install its own. */
export function resetDualControlHandlers(): void {
    handlers.clear();
}

/**
 * Refuse to start when a dual-controlled action has no handler.
 *
 * Without this, the failure surfaces as a 500 at approval time — after a request has sat
 * in the queue, after someone has agreed to it, and with the action still undone. Better
 * to never start.
 */
export function assertDualControlHandlersRegistered(): void {
    const missing = PERMISSION_NAMES.filter(
        (name) => permissionSpec(name).dualControl !== undefined && !handlers.has(name),
    );

    if (missing.length > 0) {
        throw createAppError(
            ERROR_CODES.AUTHZ_GRANT_TABLE_INVALID,
            500,
            `Dual-controlled actions with no registered handler: ${missing.join(', ')}`,
            { missing },
        );
    }
}
