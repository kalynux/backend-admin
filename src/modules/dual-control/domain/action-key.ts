import { createHash } from 'crypto';

/**
 * The idempotency key for an approval request.
 *
 * Two calls expressing the SAME intent must produce the same key, so the second returns
 * the pending request the first created instead of queueing a duplicate. Without this a
 * double-clicked button yields two approvals for one intent, and approving both performs
 * the action twice — which for a financial action at Phase 5 means paying twice.
 *
 * ── Why the payload is canonicalised ──────────────────────────────────────────
 * `JSON.stringify` preserves key insertion order, so `{ tier: 1, adminId: 'x' }` and
 * `{ adminId: 'x', tier: 1 }` hash differently despite being the same request. Zod
 * produces object key order from the SCHEMA rather than the request body, so in practice
 * they agree — but relying on that makes the idempotency guarantee depend on a validation
 * library's internals. Sorting the keys makes it depend on nothing.
 */

function canonicalise(value: unknown): unknown {
    if (Array.isArray(value)) {
        // Array ORDER is meaningful — canonicalise the elements, never reorder them.
        return value.map(canonicalise);
    }
    if (value !== null && typeof value === 'object') {
        const source = value as Record<string, unknown>;
        const sorted: Record<string, unknown> = {};
        for (const key of Object.keys(source).sort()) {
            sorted[key] = canonicalise(source[key]);
        }
        return sorted;
    }
    return value;
}

export function canonicalJson(payload: Record<string, unknown>): string {
    return JSON.stringify(canonicalise(payload));
}

/**
 * `sha256(action | targetType | targetId | canonical payload)`.
 *
 * The requester is deliberately NOT part of the key. If two administrators independently
 * request the same promotion, that is one intent with two people behind it, and either
 * of them approving the other's request would be self-approval by a different name. One
 * pending row means the second requester joins the first's request rather than opening a
 * parallel one they could then approve.
 */
export function approvalRequestKey(
    action: string,
    targetType: string,
    targetId: string,
    payload: Record<string, unknown>,
): string {
    return createHash('sha256')
        .update([action, targetType, targetId, canonicalJson(payload)].join('|'))
        .digest('hex');
}
