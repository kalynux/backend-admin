import { platformRequest } from '../../../infra/platform/platform.client';
import { ActorContext } from '../../audit/domain/audit-context';

/**
 * File resolution, delegated to jovi-mall.
 *
 * ── The gap ──────────────────────────────────────────────────────────────────
 * Every DTO on this service ships file references as opaque ids — `logoFileId`,
 * `avatarFileId`, `bannerFileId`, `deliveryProofFileId`, `store.logoFileId` — and the
 * contract says so plainly: "this service resolves no file URLs" (ADR-009 D-6). It then
 * told the dashboard to resolve them "against jovi-mall". The dashboard cannot: it talks
 * to this service and to nothing else, by design (`README.md`, first line). So the
 * instruction pointed at a door that did not exist, and every avatar and logo on the admin
 * surface rendered as a placeholder — the dashboard's gap **D2**.
 *
 * ── Why delegation rather than resolving here ────────────────────────────────
 * A URL is `storage.getPublicUrl(key)` and the provider comes from `STORAGE_PROVIDER`.
 * Building one here means a second copy of the storage configuration in a second
 * deployment, which is precisely the duplication D-6 refuses. Delegating UPHOLDS D-6
 * rather than reversing it: the resolution stays where the provider is configured, and
 * this service gains a client, not a storage layer.
 *
 * ── Not audited ──────────────────────────────────────────────────────────────
 * ADR-006 D-5: reads are not audited, with exactly one exception on this service — the
 * payout destination, where the disclosure IS the action. Resolving a file id the caller
 * is already holding is not that; it is the second half of a read they already made.
 */

/**
 * The canonical file wire shape, identical to jovi-mall's `FileDetail`.
 *
 * Declared rather than passed through as `unknown` because a client renders `url` into an
 * `<img>` and `mimeType` decides whether that is even valid — this is one of the few
 * delegated payloads small and stable enough to be worth pinning on both sides.
 */
export interface FileDetail {
    id: string;
    key: string;
    url: string;
    mimeType: string;
    size: number;
    originalName?: string;
}

/**
 * Resolve up to 100 ids in one call.
 *
 * ⚠ **Ids that resolve to nothing are ABSENT from the result**, not present-and-null.
 * Files are soft-deleted and swept by file-cleanup, so a record legitimately outlives the
 * picture it points at; the caller's job is to render what exists. That also means the
 * result may be shorter than the request and the order is not the request's — callers key
 * by `id`.
 */
export async function resolveMany(
    fileIds: string[],
    context: ActorContext,
): Promise<FileDetail[]> {
    const result = await platformRequest<{ files: FileDetail[] }>({
        method: 'POST',
        path: '/files/resolve',
        body: { fileIds },
        actor: context.actor,
        requestId: context.requestId,
    });
    return result.data?.files ?? [];
}
