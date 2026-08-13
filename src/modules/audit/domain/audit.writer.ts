import { ClientSession, Types } from 'mongoose';
import { adminConnection } from '../../../infra/mongo/connections';
import { logger, requestLogger } from '../../../core/logging/logger';
import { AuthorizationDenial, setDenialSink } from '../../authorization/domain/denial.recorder';
import { PERMISSION_CATALOG } from '../../authorization/domain/permission.catalog';
import { isSensitive } from '../../authorization/domain/permission.types';
import { AuditLogModel, IAuditLog } from '../models/audit-log.model';
import { AuditAction, auditSpec } from './audit.catalog';
import { subjectClassOf } from './audit-subject';
import { sanitiseState } from './audit-state';
import { noteEmission } from './audit-emission';
import {
    AuditIntent,
    AuditOutcomeDetail,
    AuditResult,
    AuditStatus,
    AuditTarget,
    familyOf,
} from './audit.types';

/**
 * The only way an action gets recorded, and the only place a transaction is opened.
 *
 * ── The rule that picks a function ────────────────────────────────────────────
 *
 *   Can this write join a `wi-admin` ClientSession?
 *     yes → auditedTransaction   (row and state change commit together)
 *     no  → auditedAttempt       (intent committed first, outcome stamped after)
 *
 * "No" is broader than it looks. jovi-mall is obvious. Redis is not — session revocation
 * lands there and cannot be transacted with. And `connections.ts` calls
 * `createConnection()` TWICE, so `platform` and `admin` are two MongoClients with two
 * session pools: even a direct write to `jovi_mall` is outside a `wi-admin` transaction,
 * on the same mongod. The `transport` declared in `audit.catalog.ts` is what decides,
 * once, per action — not each call site.
 *
 * ── Why this file is the only caller of startSession() ───────────────────────
 * Three layers make an unaudited administrator mutation hard to write, mirroring the
 * `defineRoute` pattern (helper → boot assertion → source scan):
 *
 *   1. the escalation-critical repository methods take a REQUIRED `ClientSession`, so an
 *      unaudited mutation does not compile
 *   2. a session can only come from here
 *   3. `test-audit.ts` scans the source and fails if `startSession(` appears anywhere else
 *
 * ── `noteEmission`, and why it sits at the ENTRY of each writer ───────────────
 * Every entry point below marks its action on the request's emission scope, which the route
 * probe compares against what the route declared (`audit-emission.ts`).
 *
 * At the entry rather than after the insert succeeds, deliberately. The probe answers "did
 * the code path that records this run?", not "did Mongo accept the document" — and the
 * second question is already answered loudly elsewhere: a fail-closed write propagates and
 * kills the action, and a best-effort one logs `AUDIT GAP` at `fatal`. Marking after the
 * insert would make the probe report a second, quieter symptom of a failure that is already
 * screaming, and would say nothing new.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Row construction
// ─────────────────────────────────────────────────────────────────────────────

function isSensitiveAction(action: AuditAction): boolean {
    const spec = auditSpec(action);
    if (spec.permission === null) return false;
    return isSensitivePermission(spec.permission);
}

/**
 * Is this permission flagged `financial` / `escalation` / `destructive` / `dualControl`?
 *
 * Copied onto the row at write time rather than resolved on read: read-scoping and
 * alerting both filter on it, and joining the permission catalog inside a query is not
 * something Mongo can do.
 *
 * Takes a `string` rather than a `PermissionName` because `denialRow` reads
 * `AuthorizationDenial.required`, which crosses the module boundary as names that were
 * valid when the route declared them. An unknown name answers `false` rather than
 * throwing — a denial must never fail to record because a permission was renamed.
 */
function isSensitivePermission(name: string): boolean {
    const permission = PERMISSION_CATALOG[name as keyof typeof PERMISSION_CATALOG];
    return permission !== undefined && isSensitive(permission);
}

function mergeTarget(base: AuditTarget, override?: Partial<AuditTarget>): AuditTarget {
    if (!override) return base;
    return {
        type: override.type ?? base.type,
        id: override.id ?? base.id,
        label: override.label ?? base.label ?? null,
    };
}

/**
 * Build the document. Pure — no I/O — and exported so `test-audit.ts` can assert the
 * mapping without a database, the same trick `toAppError` uses for `test-data-access.ts`.
 */
export function toAuditRow(
    intent: AuditIntent,
    status: AuditStatus,
    options: {
        target?: Partial<AuditTarget>;
        before?: Record<string, unknown> | null;
        after?: Record<string, unknown> | null;
        outcome?: AuditOutcomeDetail;
        completedAt?: Date | null;
        occurredAt?: Date;
    } = {},
): Partial<IAuditLog> {
    const action = intent.action as AuditAction;
    const spec = auditSpec(action);
    const target = mergeTarget(intent.target, options.target);

    const payload = sanitiseState(intent.payload);
    const before = sanitiseState(options.before ?? options.outcome?.before ?? null);
    const after = sanitiseState(options.after ?? options.outcome?.after ?? null);

    return {
        occurred_at: options.occurredAt ?? new Date(),
        completed_at: options.completedAt ?? (status === 'attempted' ? null : new Date()),
        correlation_id: intent.context.requestId,

        actor_kind: intent.actor.kind,
        actor_id: intent.actor.id ? new Types.ObjectId(intent.actor.id) : null,
        actor_email: intent.actor.email,
        actor_display_name: intent.actor.displayName,
        actor_tier: intent.actor.tier,
        session_id: intent.actor.sessionId,
        ip: intent.context.ip,
        user_agent: intent.context.userAgent,
        method: intent.context.method,
        path: intent.context.path,

        action,
        action_family: familyOf(action),
        status,
        sensitive: isSensitiveAction(action),
        payload: payload.value,
        before: before.value,
        after: after.value,
        state_truncated: payload.truncated || before.truncated || after.truncated,

        target_type: target.type,
        target_id: target.id,
        target_label: target.label ?? null,
        subject_class: subjectClassOf(target.type),
        related_target_type: intent.relatedTarget?.type ?? null,
        related_target_id: intent.relatedTarget?.id ?? null,

        outcome_code: options.outcome?.code ?? null,
        outcome_status: options.outcome?.statusCode ?? null,
        outcome_message: options.outcome?.message?.slice(0, 500) ?? null,
        denial_kind: null,
        required_permissions: [],
        via_approval_id: intent.viaApprovalId ? new Types.ObjectId(intent.viaApprovalId) : null,
        delegated: spec.transport === 'delegated',
        platform_code: options.outcome?.platformCode ?? null,
    };
}

function outcomeFrom(error: unknown): AuditOutcomeDetail {
    const candidate = error as {
        code?: unknown;
        statusCode?: unknown;
        message?: unknown;
        details?: { platformCode?: unknown };
    };

    return {
        code: typeof candidate?.code === 'string' ? candidate.code : null,
        statusCode: typeof candidate?.statusCode === 'number' ? candidate.statusCode : null,
        message: typeof candidate?.message === 'string' ? candidate.message : String(error),
        platformCode:
            typeof candidate?.details?.platformCode === 'string' ? candidate.details.platformCode : null,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// In-flight tracking, so the drain cannot cut a row off
// ─────────────────────────────────────────────────────────────────────────────

const pending = new Set<Promise<unknown>>();

/**
 * Hold a best-effort write so `drain()` can wait for it.
 *
 * `lifecycle.ts` closes Mongo immediately after the HTTP server, so a fire-and-forget
 * insert issued during the last request would be cancelled mid-flight. Everything
 * best-effort goes through here.
 */
export function trackPending(promise: Promise<unknown>): void {
    pending.add(promise);
    void promise.finally(() => pending.delete(promise));
}

/**
 * Wait for in-flight best-effort writes. Called from `drain()` BEFORE `closeAll()`.
 *
 * Bounded: a stuck write must not hold a deploy open. What it drops on timeout is a
 * best-effort row — never a fail-closed one, which is already committed by the time its
 * action returns.
 */
export async function flushPendingAudit(timeoutMs = 5_000): Promise<number> {
    if (pending.size === 0) return 0;

    const outstanding = pending.size;
    const settled = Promise.allSettled([...pending]);
    const deadline = new Promise<'timeout'>((resolve) => {
        const timer = setTimeout(() => resolve('timeout'), timeoutMs);
        timer.unref?.();
    });

    const winner = await Promise.race([settled, deadline]);
    if (winner === 'timeout') {
        logger().warn({ outstanding }, 'audit flush timed out — some best-effort rows may be lost');
    }
    return outstanding;
}

/** Test-only: forget in-flight promises between suites. */
export function resetPendingAudit(): void {
    pending.clear();
}

// ─────────────────────────────────────────────────────────────────────────────
// i. A write that lands in wi-admin — row and change in ONE transaction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Perform a `wi-admin` write and record it atomically.
 *
 * If the audit insert fails, the transaction aborts and the state change is rolled back:
 * **an action that cannot be audited does not happen.** That is the whole guarantee.
 *
 * ⚠️ `perform` MAY RUN MORE THAN ONCE. `session.withTransaction()` re-invokes its callback
 * on a transient error (a write conflict, a primary step-down). So `perform` must contain
 * no Redis call, no HTTP call, and nothing else that is not a `wi-admin` write — anything
 * else fires twice on a retry. Side effects belong AFTER this returns.
 */
export async function auditedTransaction<T>(
    intent: AuditIntent,
    perform: (session: ClientSession) => Promise<AuditResult<T>>,
): Promise<T> {
    noteEmission(intent.action);
    const session = await adminConnection().startSession();
    let captured: AuditResult<T> | null = null;

    try {
        await session.withTransaction(async () => {
            // Reset per attempt: a retried transaction must not keep the previous
            // attempt's result, which described a state that was rolled back.
            captured = null;

            const outcome = await perform(session);
            const row = toAuditRow(intent, 'succeeded', {
                target: outcome.target,
                before: outcome.before,
                after: outcome.after,
            });

            // Array form, always. `create(doc, options)` is read as a SECOND DOCUMENT by
            // some Mongoose versions, which would silently write the row outside the
            // session — defeating the entire point of this function.
            await AuditLogModel().create([row], { session });

            captured = outcome;
        });
    } catch (error) {
        // Nothing happened — the transaction rolled back — so fail-closed is already
        // satisfied. Record the attempt best-effort, outside any transaction, and never
        // let a failure here mask the original error.
        trackPending(
            AuditLogModel()
                .create([toAuditRow(intent, 'failed', { outcome: outcomeFrom(error) })])
                .catch((writeError: unknown) => {
                    requestLogger(intent.context.requestId).error(
                        { action: intent.action, err: String(writeError) },
                        'failed to record a failed audited transaction',
                    );
                }),
        );
        throw error;
    } finally {
        await session.endSession();
    }

    // `withTransaction` resolved, so the callback committed and `captured` is set.
    return (captured as unknown as AuditResult<T>).result;
}

/**
 * `auditedTransaction`, but it hands back the row's id so a post-commit fact can be added.
 *
 * ── The problem it solves ─────────────────────────────────────────────────────
 * Some facts are only knowable AFTER the commit. Suspension, a level change and a password
 * reset all destroy the target's sessions, and that happens post-commit by necessity —
 * Redis cannot join a Mongo transaction, and `withTransaction` re-runs its callback, so a
 * revocation inside it could fire twice.
 *
 * The count was therefore lost. Only `revokeAdministratorSessions`, whose whole purpose is
 * the revocation, recorded `sessionsEnded`; a suspension row never said how many devices it
 * cut off — which is exactly the question asked when reconstructing an incident.
 */
export async function auditedTransactionWithRow<T>(
    intent: AuditIntent,
    perform: (session: ClientSession) => Promise<AuditResult<T>>,
): Promise<{ result: T; auditId: Types.ObjectId }> {
    noteEmission(intent.action);
    const session = await adminConnection().startSession();
    let captured: { outcome: AuditResult<T>; auditId: Types.ObjectId } | null = null;

    try {
        await session.withTransaction(async () => {
            // Reset per attempt: a retry must not keep the previous attempt's row id,
            // which names a document that was rolled back.
            captured = null;

            const outcome = await perform(session);
            const row = toAuditRow(intent, 'succeeded', {
                target: outcome.target,
                before: outcome.before,
                after: outcome.after,
            });

            const [written] = await AuditLogModel().create([row], { session });
            captured = { outcome, auditId: written._id };
        });
    } catch (error) {
        trackPending(
            AuditLogModel()
                .create([toAuditRow(intent, 'failed', { outcome: outcomeFrom(error) })])
                .catch((writeError: unknown) => {
                    requestLogger(intent.context.requestId).error(
                        { action: intent.action, err: String(writeError) },
                        'failed to record a failed audited transaction',
                    );
                }),
        );
        throw error;
    } finally {
        await session.endSession();
    }

    const settled = captured as unknown as { outcome: AuditResult<T>; auditId: Types.ObjectId };
    return { result: settled.outcome.result, auditId: settled.auditId };
}

/**
 * Append a fact to a row that has already committed.
 *
 * ── Why amending a committed row is acceptable here ───────────────────────────
 * The precedent is `stampOutcome`, which already updates a committed row for every
 * `auditedAttempt` — an intent-first row is meaningless until its outcome lands. This is
 * the same move under a tighter rule: it `$set`s keys that were ABSENT, inside `after`, and
 * never overwrites what the transaction wrote. So the committed statement of what changed
 * stays exactly as committed, and what arrives later is added beside it.
 *
 * Best-effort and logged. A suspension that worked must not become a 500 because a
 * bookkeeping detail could not be attached afterwards — the row already says the account
 * was suspended, which is the part that matters.
 */
export async function appendOutcomeFacts(
    auditId: Types.ObjectId,
    facts: Record<string, unknown>,
): Promise<void> {
    const sanitised = sanitiseState(facts);
    if (!sanitised.value) return;

    // Dotted paths under `after`, so this cannot replace the object the transaction wrote.
    const update: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(sanitised.value)) {
        update[`after.${key}`] = value;
    }

    trackPending(
        AuditLogModel()
            .updateOne({ _id: auditId }, { $set: update })
            .catch((error: unknown) => {
                logger().error(
                    { auditId: auditId.toString(), err: String(error) },
                    'could not append post-commit facts to an audit row',
                );
            }),
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// ii. Anything that cannot join that transaction — intent → outcome
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Record the intent, perform the action, stamp the outcome.
 *
 * The intent row is committed FIRST and awaited. If it fails, `perform` is never called —
 * that is the fail-closed gate for writes this service cannot transact with. A crash
 * between the two leaves a row at `attempted`: the **dangling intent** ADR-002 D4-a calls
 * "itself a useful signal", resolvable by grepping the other service for the same
 * `correlation_id`.
 */
export async function auditedAttempt<T>(
    intent: AuditIntent,
    perform: () => Promise<AuditResult<T>>,
): Promise<T> {
    noteEmission(intent.action);
    // Not caught: a failure here must propagate and stop the action.
    const [row] = await AuditLogModel().create([toAuditRow(intent, 'attempted')]);

    try {
        const outcome = await perform();
        await stampOutcome(row._id, 'succeeded', {
            target: outcome.target,
            before: outcome.before,
            after: outcome.after,
        });
        return outcome.result;
    } catch (error) {
        await stampOutcome(row._id, 'failed', { outcome: outcomeFrom(error) });
        throw error;
    }
}

/**
 * Move a row off `attempted`.
 *
 * Filtered on the current status — the same compare-and-set discipline the approval
 * repository uses — so a retried or duplicated stamp cannot overwrite a terminal state.
 * Failures are logged, never thrown: the action already happened, and turning a
 * successful suspension into a 500 because the second write failed would be a worse lie
 * than a row stuck at `attempted`, which at least announces itself.
 */
async function stampOutcome(
    id: Types.ObjectId,
    status: Exclude<AuditStatus, 'attempted'>,
    options: {
        target?: Partial<AuditTarget>;
        before?: Record<string, unknown> | null;
        after?: Record<string, unknown> | null;
        outcome?: AuditOutcomeDetail;
    },
): Promise<void> {
    const before = sanitiseState(options.before ?? options.outcome?.before ?? null);
    const after = sanitiseState(options.after ?? options.outcome?.after ?? null);

    try {
        await AuditLogModel().updateOne(
            { _id: id, status: 'attempted' },
            {
                $set: {
                    status,
                    completed_at: new Date(),
                    before: before.value,
                    after: after.value,
                    state_truncated: before.truncated || after.truncated,
                    outcome_code: options.outcome?.code ?? null,
                    outcome_status: options.outcome?.statusCode ?? null,
                    outcome_message: options.outcome?.message?.slice(0, 500) ?? null,
                    platform_code: options.outcome?.platformCode ?? null,
                    ...(options.target?.id ? { target_id: options.target.id } : {}),
                    ...(options.target?.label ? { target_label: options.target.label } : {}),
                },
            },
        );
    } catch (error) {
        logger().error(
            { auditId: id.toString(), status, err: String(error) },
            'failed to stamp an audit outcome — the row stays at attempted',
        );
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// iii. Observations, queued actions, denials
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A completed fact with nothing to roll back — a login, a lockout, a rejected code.
 *
 * **Best-effort, deliberately.** There is no action to refuse: the login already
 * succeeded or failed on its own terms. Applying the fail-closed rule here would mean an
 * audit-store outage blocks every login, including the one needed to fix it — and
 * `session.service.ts` already made exactly this call for exactly this data ("failing to
 * write history must not deny a valid login"). A failure is logged at `fatal`, because a
 * gap in the authentication record is not a routine warning.
 */
export function recordEvent(
    intent: AuditIntent,
    status: Extract<AuditStatus, 'succeeded' | 'failed'>,
    outcome?: AuditOutcomeDetail,
): void {
    noteEmission(intent.action);
    trackPending(
        AuditLogModel()
            .create([toAuditRow(intent, status, { outcome })])
            .catch((error: unknown) => {
                logger().fatal(
                    { action: intent.action, requestId: intent.context.requestId, err: String(error) },
                    'AUDIT GAP: an identity event could not be recorded',
                );
            }),
    );
}

/**
 * An action accepted and queued for a second administrator — the 202 of ADR-005 D-4.
 *
 * Session-aware: it is written in the same transaction as the approval-request insert, so
 * a queued action and the record of queueing it cannot disagree.
 */
export async function recordQueued(
    intent: AuditIntent,
    approvalId: string,
    session: ClientSession,
): Promise<void> {
    noteEmission(intent.action);
    const row = toAuditRow({ ...intent, viaApprovalId: approvalId }, 'queued', {
        target: { type: 'approval_request', id: approvalId },
    });
    await AuditLogModel().create([row], { session });
}

/**
 * Queue an action for a second administrator, and record that it was queued — atomically.
 *
 * ── Why this exists, and why it is here rather than in the dual-control module ─
 * `recordQueued` above needs a `ClientSession`, and this file is the only place one may be
 * opened — `test-audit.ts` scans the source and fails if `startSession(` appears anywhere
 * else. That rule is what makes "an action that cannot be audited does not happen"
 * structural rather than a convention, and queueing is an action.
 *
 * It was written at Phase 3.5 and had no caller until Phase 11. The consequence was a real
 * gap rather than a tidy one: `administrators.tier.set` and `administrators.suspend` queue
 * without recording it, so a request that sits in the queue and then EXPIRES unapproved
 * leaves no audit row at all — the trail says nobody ever asked. `AUDIT_STATUSES` has
 * carried `'queued'` since Phase 3.5 and no row has ever held it.
 *
 * Phase 11 is where that stops being acceptable: a 2,000,000 XAF mark-paid request is worth
 * recording at the moment somebody makes it, not only if a second person agrees.
 *
 * ── The guarantee ─────────────────────────────────────────────────────────────
 * The approval row and the row saying it was queued commit together. If the audit insert
 * fails, the approval is rolled back and the endpoint errors — so there is no state in which
 * an action is waiting for a second administrator and nothing records that it was asked for.
 *
 * ⚠️ `perform` MAY RUN MORE THAN ONCE — `withTransaction` re-invokes its callback on a
 * transient error. It must contain nothing but `wi-admin` writes: no Redis, no HTTP.
 *
 * @param perform must both create the approval and return its id, using the session it is
 *        handed. Returning an id from a row written outside the session would produce
 *        exactly the disagreement this function exists to prevent.
 */
export async function auditedQueue<T>(
    intent: AuditIntent,
    perform: (session: ClientSession) => Promise<{ result: T; approvalId: string }>,
): Promise<T> {
    const session = await adminConnection().startSession();
    let captured: { result: T; approvalId: string } | null = null;

    try {
        await session.withTransaction(async () => {
            // Reset per attempt: a retried transaction must not keep the previous attempt's
            // approval id, which named a row that was rolled back.
            captured = null;

            const outcome = await perform(session);
            await recordQueued(intent, outcome.approvalId, session);
            captured = outcome;
        });
    } finally {
        await session.endSession();
    }

    // `withTransaction` resolved, so the callback committed and `captured` is set.
    return (captured as unknown as { result: T; approvalId: string }).result;
}

/**
 * Build the row for a refusal.
 *
 * ── Why this does not go through `toAuditRow` ─────────────────────────────────
 * It cannot. `toAuditRow` resolves `auditSpec(action)` to read the declared transport, and
 * a denial's action — `permission.denied`, `escalation.denied`, `dual_control.denied` — is
 * not in the catalog and **cannot be added to it**: `assertAuditCatalogValid()` requires
 * the first segment be a real `PermissionFamily`, and `permission`, `escalation` and
 * `dual_control` are not families (`permissions` is, and renaming to match would make the
 * row lie about which of the three refused).
 *
 * That is a deliberate asymmetry, not an oversight. A denial is a **non-action**: it has no
 * catalogued action because nothing was performed, and the catalog is a registry of things
 * that happen.
 *
 * Exported for the same reason `toAuditRow` is — `test-audit.ts` asserts the mapping
 * without a database, which is how the `sensitive` bug below is now pinned.
 */
export function denialRow(denial: AuthorizationDenial): Partial<IAuditLog> {
    const targetType = denial.targetId ? 'administrator' : 'none';

    return {
        occurred_at: new Date(),
        completed_at: new Date(),
        correlation_id: denial.requestId,

        actor_kind: 'administrator',
        actor_id: new Types.ObjectId(denial.adminId),
        actor_email: null,
        actor_display_name: null,
        actor_tier: denial.tier,
        session_id: denial.sessionId,
        ip: denial.ip,
        user_agent: denial.userAgent,
        method: denial.method,
        path: denial.path,

        // A denial is not one of the catalogued actions — nothing was performed. The
        // family comes from the permission that was refused, so a denial appears in the
        // same family filter as the action it was refused for.
        action: `${denial.kind}.denied`,
        action_family: denial.required.length > 0 ? familyOf(denial.required[0]) : 'permissions',
        status: 'denied',
        /**
         * Derived, not `false`.
         *
         * This was hardcoded `false` from Phase 3.5 until Phase 12, which had it exactly
         * backwards: `sensitive` is what read-scoping and alerting filter on, so a refused
         * attempt at `administrators.tier.set` (escalation) or `orders.refund` (financial)
         * — the single most interesting row a security review reads — was filed as routine.
         *
         * ANY refused permission being sensitive marks the row. A denial names the
         * permissions the caller did NOT have, so "they reached for something sensitive"
         * is the fact worth recording, whether or not the rest of the set was mundane.
         */
        sensitive: denial.required.some(isSensitivePermission),
        payload: null,
        before: null,
        after: null,
        state_truncated: false,

        target_type: targetType,
        target_id: denial.targetId ?? null,
        target_label: null,
        subject_class: subjectClassOf(targetType),
        related_target_type: null,
        related_target_id: null,

        outcome_code: denial.reason,
        outcome_status: 403,
        outcome_message: null,
        denial_kind: denial.kind,
        required_permissions: [...denial.required],
        via_approval_id: null,
        delegated: false,
        platform_code: null,
    };
}

/**
 * A refusal. This is the BODY that `recordAuthorizationDenial` swaps in — its signature,
 * its three call sites and its error-swallowing all stay exactly as Phase 3 left them.
 * (`authorize.middleware.ts`, `administrator.service.ts`, `approval.service.ts` — the
 * middleware's two guards share one call.)
 *
 * Best-effort by the same argument as `recordEvent`, and one stronger: a denial is a
 * **non-action**. "An action that cannot be audited must not happen" is already satisfied,
 * because nothing happened. What must not happen is a clean 403 turning into a 500.
 */
export function recordDenial(denial: AuthorizationDenial): void {
    const row = denialRow(denial);

    trackPending(
        AuditLogModel()
            .create([row])
            .catch((error: unknown) => {
                // Degrade to exactly the Phase-3 behaviour rather than losing the denial:
                // the full payload still reaches the log, at `error` because a denial that
                // could not be persisted is worth noticing.
                requestLogger(denial.requestId).error(
                    { authz: denial, err: String(error) },
                    'AUDIT GAP: authorization denied, but the row could not be written',
                );
            }),
    );
}

/**
 * Point `recordAuthorizationDenial` at this module. Called once, from `createApp()`.
 *
 * The direction matters: audit depends on authorization, never the reverse. That keeps
 * `denial.recorder.ts` free of any database import, so the bootstrap CLI and the DB-free
 * suites can load the permission guard without registering a model on a connection they
 * never open — and it is why the sink is installed at composition time rather than being
 * this module's default.
 */
export function installAuditDenialSink(): void {
    setDenialSink(recordDenial);
}
