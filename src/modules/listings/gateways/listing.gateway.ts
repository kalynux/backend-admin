import { platformRequest } from '../../../infra/platform/platform.client';
import { ActorContext, auditActorOf } from '../../audit/domain/audit-context';
import { AuditAction } from '../../audit/domain/audit.catalog';
import { auditedAttempt } from '../../audit/domain/audit.writer';

/**
 * The listing review WRITE half, reached over jovi-mall's `/api/internal/admin/listings`
 * (SERVICE-LISTINGS-PLAN § C-3, behind `requireAdminCaller` there).
 *
 * Delegated, never written directly. An approval copies the pending content and the pending
 * contacts to their published copies in ONE jovi-mall transaction, rewrites
 * `available_fields`, re-indexes, and may publish straight into `suspended` when the
 * provider's wallet is short; a rejection refunds the indexing fee (O-18). A second writer
 * would flip `status` and leave all of it undone.
 *
 * Every call is audited intent → outcome, fail-closed: the intent row commits BEFORE the
 * request, so with the audit store down nothing is changed.
 *
 * jovi-mall's refusals reach the dashboard at their own status as
 * `PLATFORM_OPERATION_REJECTED`, with the original code in `details.platformCode`:
 *   404 `LISTING_NOT_FOUND`       — no such listing
 *   409 `LISTING_STATUS_CONFLICT` — the action is not valid in the current state, or the
 *                                   compare-and-set missed (somebody else decided first)
 * A jovi-mall 5xx or an unreachable jovi-mall is `SERVICE_DEPENDENCY_UNAVAILABLE`. Writes are
 * never retried (`platformRequest` retries GET only).
 *
 * ── Wave-2 seam ──────────────────────────────────────────────────────────────
 * The reveal refund (`POST /listing-reveals/:revealId/refund`) and the reveal blocks
 * (`POST`/`DELETE /listings/:id/reveal-blocks/:customerId`) belong beside these, in a gateway
 * of their own (`listing-reports.gateway.ts`), built with the lead-report screens.
 */

/** jovi-mall's `AdminListingResult` — § C-3 names it without a shape, so only `status` is read. */
export interface PlatformListingResult {
    id?: string;
    status?: string;
    [key: string]: unknown;
}

export interface ListingWriteTarget {
    listingId: string;
    label: string;
    before: Record<string, unknown>;
}

function auditedDelegation(
    action: AuditAction,
    context: ActorContext,
    target: ListingWriteTarget,
    payload: Record<string, unknown> | null,
    perform: () => Promise<PlatformListingResult>,
): Promise<PlatformListingResult> {
    return auditedAttempt(
        {
            action,
            actor: auditActorOf(context.actor),
            target: { type: 'listing', id: target.listingId, label: target.label },
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
            return {
                result,
                before: target.before,
                after: { status: typeof result?.status === 'string' ? result.status : null },
            };
        },
    );
}

async function call(path: string, body: Record<string, unknown>, context: ActorContext): Promise<PlatformListingResult> {
    const result = await platformRequest<PlatformListingResult>({
        method: 'POST',
        path,
        body,
        actor: context.actor,
        requestId: context.requestId,
    });
    return result.data ?? {};
}

/** `POST /listings/:id/approve` `{}` — publishes the copy under review (or the revision). */
export function approve(target: ListingWriteTarget, context: ActorContext): Promise<PlatformListingResult> {
    return auditedDelegation('catalog.listings.approve', context, target, null, () =>
        call(`/listings/${target.listingId}/approve`, {}, context));
}

/** `POST /listings/:id/reject` `{ reasons }` — the provider sees the reasons. */
export function reject(target: ListingWriteTarget, reasons: string[], context: ActorContext): Promise<PlatformListingResult> {
    return auditedDelegation('catalog.listings.reject', context, target, { reasons }, () =>
        call(`/listings/${target.listingId}/reject`, { reasons }, context));
}

/** `POST /listings/:id/suspend` `{ note }` — `platform_oversight`. */
export function suspend(target: ListingWriteTarget, note: string, context: ActorContext): Promise<PlatformListingResult> {
    return auditedDelegation('catalog.listings.suspend', context, target, { note }, () =>
        call(`/listings/${target.listingId}/suspend`, { note }, context));
}

/** `POST /listings/:id/unsuspend` `{ note? }` — restores the exact previous status. */
export function unsuspend(target: ListingWriteTarget, note: string | null, context: ActorContext): Promise<PlatformListingResult> {
    const body = note ? { note } : {};
    return auditedDelegation('catalog.listings.unsuspend', context, target, note ? { note } : null, () =>
        call(`/listings/${target.listingId}/unsuspend`, body, context));
}
