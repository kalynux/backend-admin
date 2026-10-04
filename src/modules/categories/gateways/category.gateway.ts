import { platformRequest } from '../../../infra/platform/platform.client';
import { auditedAttempt } from '../../audit/domain/audit.writer';
import { ActorContext } from '../../audit/domain/audit-context';
import { AuditAction } from '../../audit/domain/audit.catalog';

/**
 * The category list's WRITE half, reached over jovi-mall's `/api/internal/admin/categories`.
 *
 * Delegated, never written directly: a merge moves every product holding the source and
 * records the source's spellings as aliases of the target, in one jovi-mall transaction,
 * and the duplicate check that runs on every vendor save reads those aliases. A second
 * writer would rename a row and leave both halves undone.
 *
 * Every call is audited intent → outcome, fail-closed: the intent row commits BEFORE the
 * request, so with the audit store down nothing is changed.
 */

/** What the category looked like before the write, from the caller's own 404 read. */
export type CategorySnapshot = Record<string, unknown> | null;

function auditedDelegation<T>(
    action: AuditAction,
    context: ActorContext,
    target: { id: string; label: string | null },
    payload: Record<string, unknown> | null,
    before: CategorySnapshot,
    perform: () => Promise<T>,
    afterOf: (result: T) => Record<string, unknown> | null,
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
            target: { type: 'category', id: target.id, label: target.label },
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

interface PlatformCategory {
    id: string;
    name: string;
    slug: string;
    aliasKeys: string[];
}

export async function rename(
    categoryId: string,
    name: string,
    before: CategorySnapshot,
    context: ActorContext,
): Promise<{ category: PlatformCategory; previousName: string }> {
    return auditedDelegation(
        'catalog.categories.rename',
        context,
        { id: categoryId, label: (before?.name as string | undefined) ?? null },
        { name },
        before,
        async () => {
            const result = await platformRequest<{ category: PlatformCategory; previousName: string }>({
                method: 'PATCH',
                path: `/categories/${categoryId}`,
                body: { name },
                actor: context.actor,
                requestId: context.requestId,
            });
            return result.data;
        },
        (r) => ({ name: r.category.name, slug: r.category.slug, aliasKeys: r.category.aliasKeys }),
    );
}

/**
 * Merge `categoryId` INTO `targetId`. The audit `after` records how many products moved —
 * the one fact about a merge that cannot be reconstructed later.
 */
export async function merge(
    categoryId: string,
    targetId: string,
    before: CategorySnapshot,
    context: ActorContext,
): Promise<{ source: PlatformCategory; target: PlatformCategory; productsUpdated: number }> {
    return auditedDelegation(
        'catalog.categories.merge',
        context,
        { id: categoryId, label: (before?.name as string | undefined) ?? null },
        { targetId },
        before,
        async () => {
            const result = await platformRequest<{ source: PlatformCategory; target: PlatformCategory; productsUpdated: number }>({
                method: 'POST',
                path: `/categories/${categoryId}/merge`,
                body: { targetId },
                actor: context.actor,
                requestId: context.requestId,
            });
            return result.data;
        },
        (r) => ({ mergedInto: r.target.id, mergedIntoName: r.target.name, productsUpdated: r.productsUpdated }),
    );
}

/** Refused by jovi-mall with 409 CATEGORY_IN_USE while any live product holds it. */
export async function remove(
    categoryId: string,
    before: CategorySnapshot,
    context: ActorContext,
): Promise<{ category: PlatformCategory }> {
    return auditedDelegation(
        'catalog.categories.delete',
        context,
        { id: categoryId, label: (before?.name as string | undefined) ?? null },
        null,
        before,
        async () => {
            const result = await platformRequest<{ category: PlatformCategory }>({
                method: 'DELETE',
                path: `/categories/${categoryId}`,
                actor: context.actor,
                requestId: context.requestId,
            });
            return result.data;
        },
        () => ({ deleted: true }),
    );
}
