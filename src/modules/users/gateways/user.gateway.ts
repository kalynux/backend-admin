import { platformRequest } from '../../../infra/platform/platform.client';
import { auditedAttempt } from '../../audit/domain/audit.writer';
import { ActorContext } from '../../audit/domain/audit-context';
import { AuditAction } from '../../audit/domain/audit.catalog';

/**
 * The user domain's WRITE half, reached over jovi-mall's internal admin API.
 *
 * ── Why a user write is delegated when the read is not ────────────────────────
 * The read is a query and protects nothing. The write is the opposite, and not because of
 * the column: `users.status` is only meaningful because jovi-mall's `requireAuth`, `login`
 * and refresh rotation refuse a non-active account, and the login identifiers are only
 * safe because that service holds the sparse unique indexes and the one definition of
 * what an email or an E.164 number may be. Flipping the column from here would produce a
 * suspension nobody enforced and identifiers nothing validated.
 *
 * That asymmetry — direct read, delegated write, in the SAME domain — is ADR-004 D-2 at
 * its clearest, which is why this module and `user.read.repository.ts` sit side by side.
 *
 * The thin methods below are the whole point: this file should never grow logic.
 */

/**
 * What the user looked like before the write.
 *
 * Captured by the caller from its own direct read — the one it already performed to
 * answer 404 — and handed here so the audit row can record what actually changed rather
 * than only what was asked for. `before`/`after` is the difference between "an
 * administrator submitted a new email" and "this address replaced that one", which is the
 * only form of the record that settles a dispute later.
 */
export type UserSnapshot = Record<string, unknown> | null;

/**
 * Wrap a delegated user mutation in an audit intent.
 *
 * ── Why here rather than in the controller ────────────────────────────────────
 * The same reason the COD gateway does it: this is the transport boundary, every
 * delegated write leaves through `platformRequest` a few lines below, and wrapping at
 * this layer means a method added later inherits auditing by construction rather than by
 * its author remembering.
 *
 * ── Why intent → outcome rather than a transaction ────────────────────────────
 * The write lands in jovi-mall's database, inside jovi-mall's transaction, which a
 * `wi-admin` ClientSession cannot join. So the intent row is committed FIRST — if that
 * fails, the HTTP call is never made — and the outcome is stamped when jovi-mall answers.
 * A crash in between leaves a row at `attempted`, resolved by grepping jovi-mall for the
 * same `correlation_id`, which already travels as `X-Request-Id` on every call.
 */
function auditedDelegation<T>(
    action: AuditAction,
    context: ActorContext,
    target: { id: string; label: string | null },
    payload: Record<string, unknown> | null,
    before: UserSnapshot,
    perform: () => Promise<T>,
): Promise<T> {
    return auditedAttempt(
        {
            action,
            actor: {
                kind: 'administrator',
                id: context.actor.adminId,
                email: context.actor.email,
                displayName: context.actor.displayName,
                tier: context.actor.tier,
                sessionId: context.actor.sessionId,
            },
            target: { type: 'user', id: target.id, label: target.label },
            context: {
                method: context.method,
                path: context.path,
                requestId: context.requestId,
                ip: context.ip,
                userAgent: context.userAgent,
            },
            payload,
        },
        async () => {
            const result = await perform();
            return { result, before, after: asState(result) };
        },
    );
}

/**
 * Reduce jovi-mall's answer to the fields worth diffing.
 *
 * Not the whole response: an audit row storing every field of every write becomes
 * unreadable, and `sanitiseState` would be truncating it. These are the fields this
 * surface can change, so a diff over them is complete by construction.
 */
function asState(result: unknown): Record<string, unknown> | null {
    const user = result as PlatformUser | null;
    if (!user || typeof user !== 'object') return null;

    return {
        email: user.email ?? null,
        phone: user.phone ?? null,
        status: user.status ?? null,
        suspendedReason: user.suspendedReason ?? null,
    };
}

/** jovi-mall's user DTO — `toAdminUserDto` on the other side. */
export interface PlatformUser {
    id: string;
    email: string | null;
    phone: string | null;
    roles: string[];
    status: string;
    suspendedAt: string | null;
    suspendedReason: string | null;
    suspendedBy: { id: string | null; source: string; name: string | null } | null;
    createdAt: string;
    updatedAt: string;
}

export interface UpdateContactInput {
    /** Absent = leave alone. `null` = clear the identifier. */
    email?: string | null;
    phone?: string | null;
}

/**
 * Change the login identifiers.
 *
 * Forwarded as sent, `null`s included — the clear-versus-leave-alone distinction is the
 * whole contract, and collapsing an absent key into a null here would silently delete
 * the identifier the caller did not mention.
 */
export async function updateContact(
    userId: string,
    input: UpdateContactInput,
    before: UserSnapshot,
    context: ActorContext,
): Promise<PlatformUser> {
    return auditedDelegation(
        'users.update',
        context,
        { id: userId, label: labelOf(before) },
        { ...input },
        before,
        async () => {
            const result = await platformRequest<PlatformUser>({
                method: 'PATCH',
                path: `/users/${userId}`,
                body: input,
                actor: context.actor,
                requestId: context.requestId,
            });
            return result.data;
        },
    );
}

/**
 * Suspend an account.
 *
 * jovi-mall refuses with `USER_STATUS_CONFLICT` (409) when the account is not currently
 * active — a compare-and-set, because two administrators can hold one user's screen open
 * and the loser must be told the state moved rather than overwrite the winner's reason.
 * That code reaches the dashboard unchanged, in `details.platformCode`.
 */
export async function suspend(
    userId: string,
    reason: string,
    before: UserSnapshot,
    context: ActorContext,
): Promise<PlatformUser> {
    return auditedDelegation(
        'users.suspend',
        context,
        { id: userId, label: labelOf(before) },
        { reason },
        before,
        async () => {
            const result = await platformRequest<PlatformUser>({
                method: 'POST',
                path: `/users/${userId}/suspend`,
                body: { reason },
                actor: context.actor,
                requestId: context.requestId,
            });
            return result.data;
        },
    );
}

/**
 * Lift a suspension.
 *
 * Its own audit action rather than a flag on `users.suspend`: reinstatement is the act
 * that CLEARS the reason and the actor stamp off the user row, so this row is the only
 * surviving record that the suspension happened at all.
 */
export async function restore(
    userId: string,
    before: UserSnapshot,
    context: ActorContext,
): Promise<PlatformUser> {
    return auditedDelegation(
        'users.reinstate',
        context,
        { id: userId, label: labelOf(before) },
        null,
        before,
        async () => {
            const result = await platformRequest<PlatformUser>({
                method: 'POST',
                path: `/users/${userId}/restore`,
                actor: context.actor,
                requestId: context.requestId,
            });
            return result.data;
        },
    );
}

/**
 * A human-readable snapshot for the audit row, so a feed reads without a join.
 *
 * The email or phone AS IT WAS when the action ran — which for a contact edit is exactly
 * the identifier being replaced, and therefore the one a reader needs to recognise the
 * row six months later.
 */
function labelOf(before: UserSnapshot): string | null {
    if (!before) return null;
    const email = typeof before.email === 'string' ? before.email : null;
    const phone = typeof before.phone === 'string' ? before.phone : null;
    return email ?? phone;
}
