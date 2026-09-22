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
 *
 * `toAfter` defaults to `asState`, the user-row diff that every account write records. A
 * write whose result is not a user row passes its own mapper. The bot-memory reset is the
 * one that does, and it records the new memory epoch.
 */
function auditedDelegation<T>(
    action: AuditAction,
    context: ActorContext,
    target: { id: string; label: string | null },
    payload: Record<string, unknown> | null,
    before: UserSnapshot,
    perform: () => Promise<T>,
    toAfter: (result: T) => Record<string, unknown> | null = asState,
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
            return { result, before, after: toAfter(result) };
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

// ─────────────────────────────────────────────────────────────────────────────
// Credential recovery
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What comes back from a send. Deliberately thin, and the omissions are the design.
 *
 * ⚠ **No token, no link, no unmasked destination.** An operator who could read the link
 * could use it, which would make "help this vendor back into their shop" and "sign in as
 * this vendor" the same button. The masked destination is enough to confirm it went to the
 * right person; `expiresAt` is enough to tell them how long they have.
 */
export interface CredentialDeliveryResult {
    kind: 'password_reset' | 'login';
    channel: 'email' | 'whatsapp' | 'telegram';
    /** `+2376••••4417` · `j••••t@example.com` · `@handle`. */
    destinationMasked: string;
    expiresAt: string;
    sentAt: string;
}

/**
 * Send a password-reset link over one channel.
 *
 * ── Why the destination is not a parameter ───────────────────────────────────
 * It is read from the party's own record inside jovi-mall. Accepting one here would let an
 * operator mail a working credential for somebody else's account to an address they chose,
 * and no permission short of "may not use this endpoint" would prevent it.
 *
 * Delegated because the credential lives there: the token is minted by
 * `PasswordResetService.issueResetLinkFor`, which is the same 30-minute single-use token
 * the self-service flow uses, redeemed at the same endpoint, carrying the same
 * `password_changed_at` stamp that evicts every live session on redemption.
 *
 * Refusals arrive as `PLATFORM_OPERATION_REJECTED` with `USER_CHANNEL_UNAVAILABLE` or
 * `USER_CREDENTIAL_LINK_THROTTLED` in `details.platformCode`.
 */
export async function sendPasswordResetLink(
    userId: string,
    channel: string,
    reason: string,
    before: UserSnapshot,
    context: ActorContext,
): Promise<CredentialDeliveryResult> {
    return auditedDelegation(
        'users.password_reset_link.send',
        context,
        { id: userId, label: labelOf(before) },
        // The reason and the channel, never the destination — the audit row records what
        // was ASKED for, and the masked destination arrives in the outcome.
        { channel, reason },
        before,
        async () => {
            const result = await platformRequest<CredentialDeliveryResult>({
                method: 'POST',
                path: `/users/${userId}/password-reset-link`,
                body: { channel },
                actor: context.actor,
                requestId: context.requestId,
            });
            return result.data;
        },
    );
}

/**
 * Send a customer a passwordless sign-in link.
 *
 * ⚠ **Its own permission and its own audit action, not a variant of the reset above.** A
 * reset link grants nothing until the person chooses a password; this one IS a session.
 * Collapsing the two would mean a tier granted "help people back in" silently also got
 * "sign in as a customer", with nothing in the trail to tell the two acts apart.
 *
 * Customers only, refused by jovi-mall with `USER_LOGIN_LINK_ROLE_UNSUPPORTED` otherwise —
 * `MessagingLoginService` scopes every session it mints to `customer` as a literal.
 */
export async function sendLoginLink(
    userId: string,
    channel: string,
    reason: string,
    before: UserSnapshot,
    context: ActorContext,
): Promise<CredentialDeliveryResult> {
    return auditedDelegation(
        'users.login_link.send',
        context,
        { id: userId, label: labelOf(before) },
        { channel, reason },
        before,
        async () => {
            const result = await platformRequest<CredentialDeliveryResult>({
                method: 'POST',
                path: `/users/${userId}/login-link`,
                body: { channel },
                actor: context.actor,
                requestId: context.requestId,
            });
            return result.data;
        },
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// The customer bot's conversation memory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What a bot-memory reset answers: jovi-mall's result, reduced to its three named fields.
 *
 * `memoryEpoch` is jovi-mall's counter for this person's bot memory, and a reset moves it
 * forward. wi-admin does not interpret it. It is passed on so the dashboard, and the audit
 * row, can show that a reset happened.
 */
export interface BotMemoryResetResult {
    userId: string;
    memoryEpoch: number;
    /** ISO-8601. */
    resetAt: string;
}

/**
 * Named fields, not a pass-through. The same rule as `toUserDto`: a field jovi-mall adds to
 * its answer later does not reach the dashboard or the audit row until someone names it here.
 */
function toBotMemoryReset(result: BotMemoryResetResult): BotMemoryResetResult {
    return {
        userId: result.userId,
        memoryEpoch: result.memoryEpoch,
        resetAt: result.resetAt,
    };
}

/** The audit row's `after`. The epoch and the instant; the user id is already the target. */
function asBotMemoryState(result: BotMemoryResetResult): Record<string, unknown> {
    return { memoryEpoch: result.memoryEpoch, resetAt: result.resetAt };
}

/**
 * Make the customer bot start this person's next conversation fresh.
 *
 * Delegated because the bot's memory lives on jovi-mall's side of the boundary. It is
 * reached at `POST /api/internal/admin/users/:userId/bot-memory/reset` with an empty body.
 * It deletes no order, message record or account data.
 *
 * `before` is used for the row's LABEL only. The row's own `before` is recorded as null,
 * because the account is not what changed (see the `users.bot_memory.reset` entry in
 * `audit.catalog.ts`). The reason goes in the payload as `null` when none was given, so
 * "no reason was offered" can be told apart from "the field was lost".
 *
 * A POST, so `platformRequest` never retries it. Its failures map the same way every other
 * delegation's do: an unknown user from jovi-mall arrives as `PLATFORM_OPERATION_REJECTED`
 * at 404, an unreachable jovi-mall as `SERVICE_DEPENDENCY_UNAVAILABLE`.
 */
export async function resetBotMemory(
    userId: string,
    reason: string | null,
    before: UserSnapshot,
    context: ActorContext,
): Promise<BotMemoryResetResult> {
    return auditedDelegation(
        'users.bot_memory.reset',
        context,
        { id: userId, label: labelOf(before) },
        { reason },
        null,
        async () => {
            const result = await platformRequest<BotMemoryResetResult>({
                method: 'POST',
                path: `/users/${userId}/bot-memory/reset`,
                body: {},
                actor: context.actor,
                requestId: context.requestId,
            });
            return toBotMemoryReset(result.data);
        },
        asBotMemoryState,
    );
}
