import { platformRequest } from '../../../infra/platform/platform.client';
import { ActorContext } from '../../audit/domain/audit-context';
import { auditedAttempt } from '../../audit/domain/audit.writer';

/**
 * The file surface, delegated to jovi-mall.
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
 * The two housekeeping operations (Phase 5 Part B) delegate for a second reason on top of
 * that one: jovi-mall owns the `files` collection, the `file_references` rows the orphan
 * query is the complement of, and the storage client the delete calls. There is nothing
 * here to own.
 *
 * ── Not audited, EXCEPT the delete ───────────────────────────────────────────
 * ADR-006 D-5: reads are not audited, with exactly one exception on this service — the
 * payout destination, where the disclosure IS the action. Resolving a file id the caller
 * is already holding is not that; it is the second half of a read they already made. Nor
 * is the orphan listing, which discloses nothing a file listing does not already say.
 *
 * `hardDelete` is audited, and it is the only UNRECOVERABLE operation on this service's
 * whole surface. Intent → outcome rather than a transaction, for the ordinary reason: the
 * write lands in jovi-mall's database, which a `wi-admin` ClientSession cannot join.
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

// ─────────────────────────────────────────────────────────────────────────────
// Housekeeping — Phase 5 Part B
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What jovi-mall answers for an orphan: its whole `File` domain entity, storage key and all.
 *
 * Declared as its own shape rather than reusing `FileDetail` because the two are genuinely
 * different payloads. `FileDetail` is a RESOLVED file — it carries `url`, built from the
 * active storage provider — and this is a RAW row, which carries `key` and no url. Sharing
 * one interface would make the field this gateway exists to withhold look optional rather
 * than absent.
 */
export interface PlatformOrphanFile {
    id: string;
    key: string;
    mimeType: string;
    size: number;
    originalName?: string;
    ownerType?: string;
    createdAt: string;
    [field: string]: unknown;
}

/**
 * An orphan as an operator sees it — Phase 5 **D-10**.
 *
 * ⚠ **No `key`.** The operator has to be able to judge a file before an unrecoverable
 * delete, and what makes that judgement possible is the filename, the type, the size and
 * whose it was. The storage key is an internal locator: it adds nothing to the judgement
 * and everything to a leak, being the path inside the bucket and naming the owner's tree.
 */
export interface OrphanFile {
    id: string;
    originalName: string | null;
    mimeType: string;
    size: number;
    ownerType: string | null;
    createdAt: string;
}

/**
 * The counts jovi-mall returns beside the rows.
 *
 * A type alias rather than an interface, so it carries the implicit index signature that
 * `sendSuccess`'s `meta` (a `Record<string, unknown>`) requires. An interface does not —
 * the same trap `CascadeCounts` in the agency gateway already carries a note about.
 */
export type OrphanListMeta = {
    count: number;
    olderThan: string;
};

/**
 * jovi-mall's raw row → the operator's view. **This is where the key is dropped.**
 *
 * Exported and pure so `test:files` can assert the leak directly — build it from a row
 * carrying every field jovi-mall's `File` entity has, serialise the result, and assert the
 * key (and the provider, and the soft-delete stamps) are absent. That is the house form:
 * `test:public-catalog` proves its DTOs the same way, because a projection asserted by
 * source scan proves the code SAYS the right thing rather than that it DOES it.
 *
 * Every field is named explicitly. A spread would publish whatever jovi-mall's `File` gains
 * next, silently, and the thing it gained most recently is `orphanedAt`.
 */
export function toOrphanFile(row: PlatformOrphanFile): OrphanFile {
    return {
        id: row.id,
        originalName: row.originalName ?? null,
        mimeType: row.mimeType,
        size: row.size,
        ownerType: row.ownerType ?? null,
        createdAt: row.createdAt,
    };
}

/**
 * Files nothing references, older than a cutoff.
 *
 * ⚠ **The projection is applied HERE, not in the controller.** This is the one place
 * jovi-mall's raw row enters the service, so a route added later cannot reach the storage
 * key by forgetting to project — the same argument that puts the audit wrapper in the
 * gateways rather than in the controllers.
 *
 * `olderThan` is omitted rather than defaulted when the caller sends nothing: jovi-mall
 * defaults it to seven days ago, and one default in one place is why this does not restate
 * it. The cutoff actually used comes back in `meta`.
 */
export async function listOrphans(
    input: { olderThan?: Date },
    context: ActorContext,
): Promise<{ files: OrphanFile[]; meta: OrphanListMeta | null }> {
    const result = await platformRequest<PlatformOrphanFile[]>({
        method: 'GET',
        path: '/files/orphans',
        query: input.olderThan ? { olderThan: input.olderThan.toISOString() } : undefined,
        actor: context.actor,
        requestId: context.requestId,
    });

    const rows = Array.isArray(result.data) ? result.data : [];

    return {
        files: rows.map(toOrphanFile),
        meta: (result.meta as OrphanListMeta | undefined) ?? null,
    };
}

/**
 * Delete a file permanently. There is no undo, on either side of the hop.
 *
 * jovi-mall removes the row first and then deletes the object BEST-EFFORT, treating its own
 * database as the source of truth — so a storage failure leaves the row gone and logs. Read
 * a `succeeded` outcome on this row as "the record is gone", not "the bytes are".
 *
 * The audit payload records the file as the operator saw it before confirming, because
 * afterwards there is nothing left to look it up in. `after` is `null` by construction: the
 * record no longer exists, so there is no state to diff against, and a gateway that invented
 * one here would be describing a document it cannot read.
 */
export async function hardDelete(
    fileId: string,
    before: OrphanFile | null,
    context: ActorContext,
): Promise<void> {
    await auditedAttempt(
        {
            action: 'files.delete',
            actor: {
                kind: 'administrator',
                id: context.actor.adminId,
                email: context.actor.email,
                displayName: context.actor.displayName,
                tier: context.actor.tier,
                sessionId: context.actor.sessionId,
            },
            target: { type: 'file', id: fileId, label: before?.originalName ?? null },
            context: {
                method: context.method,
                path: context.path,
                requestId: context.requestId,
                ip: context.ip,
                userAgent: context.userAgent,
            },
            payload: before
                ? {
                    originalName: before.originalName,
                    mimeType: before.mimeType,
                    size: before.size,
                    ownerType: before.ownerType,
                }
                : null,
        },
        async () => {
            await platformRequest<unknown>({
                method: 'DELETE',
                path: `/files/${fileId}/permanent`,
                actor: context.actor,
                requestId: context.requestId,
            });

            return {
                result: undefined,
                before: (before as unknown as Record<string, unknown> | null) ?? null,
                after: null,
            };
        },
    );
}
