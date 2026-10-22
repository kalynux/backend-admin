import { platformRequest } from '../../../infra/platform/platform.client';
import { ActorContext, auditActorOf } from '../../audit/domain/audit-context';
import { AuditAction } from '../../audit/domain/audit.catalog';
import { auditedAttempt } from '../../audit/domain/audit.writer';
import { AuditTargetType } from '../../audit/domain/audit.types';

/**
 * The lead-report WRITE half (L-25, L-29, L-31), reached over jovi-mall's internal admin API
 * (SERVICE-LISTINGS-PLAN § C-3, behind `requireAdminCaller` there):
 *
 *   POST   /listing-reveals/:revealId/refund                  `{ ticketId?, note }`
 *   POST   /listings/:id/reveal-blocks/:customerId            `{ reason, ticketId? }`
 *   DELETE /listings/:id/reveal-blocks/:customerId            `{ note? }`
 *
 * Delegated, never written directly. A refund writes a `refund` ledger row
 * (`listing_reveal_refund`, `ref: revealId`), credits the provider's wallet — which pays any
 * debt first and may RESUME listings suspended for credits — and stamps the reveal, in one
 * jovi-mall transaction, idempotent per reveal. A block is what makes the reveal refuse with
 * the neutral `LISTING_UNREACHABLE`; the partial unique index is what allows one active block.
 * A second writer here would get the row right and skip all of that.
 *
 * Every call is audited intent → outcome, fail-closed: the intent row commits BEFORE the
 * request, so with the audit store down nothing moves.
 *
 * jovi-mall's refusals reach the dashboard at their own status as
 * `PLATFORM_OPERATION_REJECTED`, with the original code in `details.platformCode`:
 *   404 `LISTING_REVEAL_NOT_FOUND`        — refund of an unknown reveal
 *   409 `LISTING_REVEAL_ALREADY_REFUNDED` — a second refund of one reveal
 *   404 `LISTING_NOT_FOUND`               — block / lift on an unknown listing
 *   409 `LISTING_REVEAL_BLOCK_EXISTS`     — block when one is already active
 *   404 `LISTING_REVEAL_BLOCK_NOT_FOUND`  — lift with no active block
 * A jovi-mall 5xx or an unreachable jovi-mall is `SERVICE_DEPENDENCY_UNAVAILABLE`. Writes are
 * never retried (`platformRequest` retries GET only).
 */

/** § C-3: `{ revealId, refundedCredits, balanceAfter }`. Read defensively — absent = null. */
export interface PlatformRevealRefundResult {
    revealId?: string;
    refundedCredits?: number;
    balanceAfter?: number;
    [key: string]: unknown;
}

/** § C-3 leaves the block responses unshaped; nothing is read from them but their success. */
export type PlatformRevealBlockResult = Record<string, unknown>;

export interface RevealWriteTarget {
    revealId: string;
    label: string;
    before: Record<string, unknown>;
}

export interface RevealBlockWriteTarget {
    listingId: string;
    customerId: string;
    label: string;
    before: Record<string, unknown>;
}

function auditedDelegation<T>(
    action: AuditAction,
    context: ActorContext,
    target: { type: AuditTargetType; id: string; label: string; before: Record<string, unknown> },
    payload: Record<string, unknown> | null,
    perform: () => Promise<T>,
    afterOf: (result: T) => Record<string, unknown>,
): Promise<T> {
    return auditedAttempt(
        {
            action,
            actor: auditActorOf(context.actor),
            target: { type: target.type, id: target.id, label: target.label },
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
            return { result, before: target.before, after: afterOf(result) };
        },
    );
}

async function call<T>(method: 'POST' | 'DELETE', path: string, body: Record<string, unknown>, context: ActorContext): Promise<T> {
    const result = await platformRequest<T>({
        method,
        path,
        body,
        actor: context.actor,
        requestId: context.requestId,
    });
    return (result.data ?? {}) as T;
}

/** `POST /listing-reveals/:revealId/refund` `{ ticketId?, note }` — moves credits back (tiers 1 + 2). */
export function refundReveal(
    target: RevealWriteTarget,
    input: { note: string; ticketId: string | null },
    context: ActorContext,
): Promise<PlatformRevealRefundResult> {
    const body = input.ticketId ? { ticketId: input.ticketId, note: input.note } : { note: input.note };
    return auditedDelegation<PlatformRevealRefundResult>(
        'catalog.listings.reveals.refund',
        context,
        { type: 'listing_reveal', id: target.revealId, label: target.label, before: target.before },
        { ticketId: input.ticketId, note: input.note },
        () => call('POST', `/listing-reveals/${target.revealId}/refund`, body, context),
        (result) => ({
            refunded: true,
            refundedCredits: typeof result?.refundedCredits === 'number' ? result.refundedCredits : null,
            balanceAfter: typeof result?.balanceAfter === 'number' ? result.balanceAfter : null,
        }),
    );
}

/** `POST /listings/:id/reveal-blocks/:customerId` `{ reason, ticketId? }` — L-29. */
export function blockCustomer(
    target: RevealBlockWriteTarget,
    input: { reason: string; ticketId: string | null },
    context: ActorContext,
): Promise<PlatformRevealBlockResult> {
    const body = input.ticketId ? { reason: input.reason, ticketId: input.ticketId } : { reason: input.reason };
    return auditedDelegation<PlatformRevealBlockResult>(
        'catalog.listings.reveal_block',
        context,
        { type: 'listing', id: target.listingId, label: target.label, before: target.before },
        { customerId: target.customerId, reason: input.reason, ticketId: input.ticketId },
        () => call('POST', `/listings/${target.listingId}/reveal-blocks/${target.customerId}`, body, context),
        () => ({ customerId: target.customerId, blocked: true }),
    );
}

/** `DELETE /listings/:id/reveal-blocks/:customerId` `{ note? }` — lifts the active block. */
export function liftBlock(
    target: RevealBlockWriteTarget,
    note: string | null,
    context: ActorContext,
): Promise<PlatformRevealBlockResult> {
    const body = note ? { note } : {};
    return auditedDelegation<PlatformRevealBlockResult>(
        'catalog.listings.reveal_unblock',
        context,
        { type: 'listing', id: target.listingId, label: target.label, before: target.before },
        { customerId: target.customerId, note },
        () => call('DELETE', `/listings/${target.listingId}/reveal-blocks/${target.customerId}`, body, context),
        () => ({ customerId: target.customerId, blocked: false }),
    );
}
