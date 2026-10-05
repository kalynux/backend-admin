import { platformRequest } from '../../../infra/platform/platform.client';
import { auditedAttempt } from '../../audit/domain/audit.writer';
import { ActorContext } from '../../audit/domain/audit-context';
import { AuditAction } from '../../audit/domain/audit.catalog';

/**
 * The review WRITE half, reached over jovi-mall's `/api/internal/admin/reviews`.
 *
 * Delegated, never written directly: every one of the three verbs recomputes the product's,
 * agent's or agency's rating aggregate and, for a delivery review, nudges the agent's trust
 * recompute. A second writer would flip `status` and leave all of that unfired.
 *
 * Every call is audited intent → outcome, fail-closed: the intent row commits BEFORE the
 * request, so with the audit store down nothing is changed. jovi-mall keeps only the LAST
 * action on the review itself, so this trail is the review's only complete history.
 *
 * jovi-mall's refusals arrive as `PLATFORM_OPERATION_REJECTED` at their own status, with the
 * original code in `details.platformCode`:
 *   409 `REVIEW_STATUS_CONFLICT` — already hidden / already visible (`details.status` says which)
 *   404 `REVIEW_NOT_FOUND`       — no such review, or already deleted
 */

/** What the review looked like before the write, from the caller's own 404 read. */
export type ReviewSnapshot = Record<string, unknown>;

/** jovi-mall's `AdminReviewDto`, as much of it as this side reads back. */
export interface PlatformReview {
    id: string;
    status: 'published' | 'unpublished';
    moderation: {
        action: 'unpublished' | 'republished' | 'deleted';
        at: string;
        reason: string | null;
    } | null;
}

function auditedDelegation(
    action: AuditAction,
    context: ActorContext,
    reviewId: string,
    label: string,
    payload: Record<string, unknown> | null,
    before: ReviewSnapshot,
    perform: () => Promise<PlatformReview>,
    afterOf: (result: PlatformReview) => Record<string, unknown>,
): Promise<PlatformReview> {
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
            target: { type: 'review', id: reviewId, label },
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
            return { result, before, after: afterOf(result) };
        },
    );
}

async function call(
    method: 'POST' | 'DELETE',
    path: string,
    body: Record<string, unknown>,
    context: ActorContext,
): Promise<PlatformReview> {
    const result = await platformRequest<PlatformReview>({
        method,
        path,
        body,
        actor: context.actor,
        requestId: context.requestId,
    });
    return result.data;
}

const afterOf = (r: PlatformReview) => ({ status: r.status, action: r.moderation?.action ?? null });

/** Hide a published review. Its star leaves the rating at once. */
export async function unpublish(
    reviewId: string,
    reason: string,
    label: string,
    before: ReviewSnapshot,
    context: ActorContext,
): Promise<PlatformReview> {
    return auditedDelegation(
        'reviews.unpublish', context, reviewId, label, { reason }, before,
        () => call('POST', `/reviews/${reviewId}/unpublish`, { reason }, context),
        afterOf,
    );
}

/** Put a hidden review back. Its star returns to the rating. */
export async function republish(
    reviewId: string,
    reason: string | null,
    label: string,
    before: ReviewSnapshot,
    context: ActorContext,
): Promise<PlatformReview> {
    const body = reason ? { reason } : {};
    return auditedDelegation(
        'reviews.republish', context, reviewId, label, reason ? { reason } : null, before,
        () => call('POST', `/reviews/${reviewId}/republish`, body, context),
        afterOf,
    );
}

/** Delete a review for good. Its author may then write a new one about the same subject. */
export async function remove(
    reviewId: string,
    reason: string,
    label: string,
    before: ReviewSnapshot,
    context: ActorContext,
): Promise<PlatformReview> {
    return auditedDelegation(
        'reviews.delete', context, reviewId, label, { reason }, before,
        () => call('DELETE', `/reviews/${reviewId}`, { reason }, context),
        () => ({ deleted: true }),
    );
}
