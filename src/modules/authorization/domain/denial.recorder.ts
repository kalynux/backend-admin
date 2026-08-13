import { requestLogger } from '../../../core/logging/logger';
import { AdminTier } from '../../admin-identity/domain/admin-identity.types';
import { PermissionName } from './permission.catalog';

/**
 * The single place an authorization refusal is recorded.
 *
 * ── Why one function ──────────────────────────────────────────────────────────
 * A denial is the primary signal that an account is compromised or is being used beyond
 * its remit — it is the thing a security review actually reads. The audit subsystem that
 * will persist these is the NEXT phase (D4), and the temptation now is either to skip
 * recording entirely or to half-build the audit collection here and have that phase
 * rework it.
 *
 * Instead every refusal in the service — the permission guard, the escalation rules, the
 * dual-control gate — calls this one function.
 *
 * ── Phase 3.5 landed, and the promise held ────────────────────────────────────
 * A denial is now a durable `admin_audit_log` row. Nothing here moved to achieve that:
 * the signature is the same, all four call sites are untouched, and no schema is named in
 * this file. `createApp()` installs the audit writer through `setDenialSink()` — the seam
 * that already existed — so the dependency runs audit → authorization and never back, and
 * a process that installs nothing (the bootstrap CLI, the DB-free suites) keeps logging.
 *
 * The swallow below still guarantees a refusal never turns a clean 403 into a 500, and
 * the audit sink degrades to logging the full payload if its write fails — exactly the
 * behaviour this function had before.
 *
 * The row carries `requestId` as its `correlation_id`, so a denial and the request that
 * produced it join on the same key, across both services.
 */

export type DenialKind =
    /** The caller's tier does not grant the permission the route declares. */
    | 'permission'
    /** The caller holds the permission but may not apply it to this target. */
    | 'escalation'
    /** The action needs a second administrator and the caller tried to bypass that. */
    | 'dual_control';

export interface AuthorizationDenial {
    kind: DenialKind;
    adminId: string;
    tier: AdminTier;
    sessionId: string;
    /** The permission(s) the route required. Empty for a pure escalation refusal. */
    required: readonly PermissionName[];
    /** The rule that refused, as an ERROR_CODES value — the machine-readable reason. */
    reason: string;
    /** The administrator or record acted upon, when the refusal was about a target. */
    targetId?: string;
    method: string;
    path: string;
    requestId: string;
    ip: string | null;
    /**
     * Added in Phase 12. Every denial row carried a null `user_agent` for the life of the
     * audit subsystem, not because the value was unavailable — all three call sites have it
     * in scope — but because this interface had nowhere to put it.
     *
     * It matters most on exactly the rows worth reading: a repeated escalation refusal is
     * one of the few signals that distinguishes a confused administrator from a stolen
     * session, and the client string is half of that judgement.
     */
    userAgent: string | null;
}

export type DenialSink = (denial: AuthorizationDenial) => void;

/**
 * The default sink, and the fallback for any process without a database — the bootstrap
 * CLI, and every DB-free suite that exercises the permission guard.
 *
 * `warn`, not `error`: a refusal is the system working. It is worth alerting on a RATE of
 * these, not on any single one.
 */
function logSink(denial: AuthorizationDenial): void {
    requestLogger(denial.requestId).warn({ authz: denial }, 'authorization denied');
}

let sink: DenialSink = logSink;

export function recordAuthorizationDenial(denial: AuthorizationDenial): void {
    try {
        sink(denial);
    } catch {
        // Recording a refusal must never turn a clean 403 into a 500. The caller is
        // being denied either way; losing the log line is the lesser failure.
    }
}

/**
 * Point denials somewhere else.
 *
 * Two callers. `createApp()` installs the audit writer here at boot, which is how the
 * durable sink arrives without this module importing the audit module — the dependency
 * runs audit → authorization, never back, and the bootstrap CLI keeps the log sink by
 * simply never installing one. Tests use it to capture.
 */
export function setDenialSink(next: DenialSink): void {
    sink = next;
}

/** Restore the structured-log sink. */
export function resetDenialSink(): void {
    sink = logSink;
}
