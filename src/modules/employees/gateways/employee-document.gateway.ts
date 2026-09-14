import { platformRequest, platformUpload } from '../../../infra/platform/platform.client';
import { env } from '../../../config/env';
import { ActorContext, auditActorOf } from '../../audit/domain/audit-context';
import { auditedAttempt } from '../../audit/domain/audit.writer';
import { EmployeeDocumentSlot } from '../domain/employee-document.types';

/**
 * ─── The staff identity documents, delegated ─────────────────────────────────
 *
 * The one gateway on this service that streams a body at a route other than `/files/upload`,
 * and the reason is the whole of ADR-023 D-4: **`/files/upload` writes to a PUBLIC tree.**
 *
 * jovi-mall's admin upload route passes `folder: 'by-type'`, `resolveTypeFolder` maps every
 * media category onto one of `images|videos|audio|documents|archives|other`, and
 * `storage-trees.ts` classifies **all six `public`**. So an administrator's blog cover
 * resolves to a real, permanent, guessable URL — which is exactly what that route is for, and
 * exactly what must never happen to a photograph of somebody's national identity card.
 *
 * The new route writes to `admin-identity/`, classified `private`. Same service token, same
 * actor headers, same proxy shape; a different folder, and therefore a different answer to
 * "can a stranger holding the link fetch this".
 *
 * ── ⚠ Do NOT "simplify" this by pointing it back at `/files/upload` ─────────
 * The two differ in one string and the difference is the entire privacy mechanism. There is
 * no `sensitive` flag on a file and no second gate — the tree decides, alone.
 */

/** What jovi-mall answers for a created staff document. Its own `FileDetail`. */
export interface UploadedStaffDocument {
    id: string;
    key: string;
    /** Always `null` here — `admin-identity` is a private tree, by construction. */
    url: string | null;
    /** Always `'authorized'` here, for the same reason. */
    access: string;
    mimeType: string;
    size: number;
    originalName: string | null;
}

/** One upload, as the caller hands it over. The body is the caller's own `req`, unread. */
export interface StaffDocumentUploadInput {
    body: NodeJS.ReadableStream;
    contentType: string;
    contentLength: number | null;
    /** Recorded on the audit row so the trail says WHAT was uploaded, not merely that. */
    slot: EmployeeDocumentSlot;
}

/**
 * Stream an administrator's identity document at jovi-mall, and record that they did it.
 *
 * ── Audited, fail-closed on the intent ────────────────────────────────────────
 * `auditedAttempt` commits the intent BEFORE the body is streamed and does not catch a failure
 * of that write — the `openContent` posture, applied to a write. With the audit store
 * unreachable, no identity document is stored.
 *
 * ⚠ The intent's `target.id` is **null**, because the file does not exist yet, and is stamped
 * from the outcome. A crash mid-upload leaves an `attempted` row with no target — read
 * conservatively, that means a file MAY exist and this service cannot say. A placeholder id
 * would be worse: it would name a record that never existed.
 *
 * ⚠ **The payload never names the FILE, only the slot and the byte count.** It cannot: this
 * service does not parse the multipart body and has no filename to record without inventing
 * one. Putting a guess in a compliance record is worse than an honest gap — and the one thing
 * that must never be near the audit store is the content itself.
 */
export async function uploadStaffDocument(
    input: StaffDocumentUploadInput,
    context: ActorContext,
): Promise<UploadedStaffDocument[]> {
    const maxBytes = env().ADMIN_UPLOAD_MAX_BYTES;

    return auditedAttempt(
        {
            action: 'employees.documents.upload',
            actor: auditActorOf(context.actor),
            // Unknowable until jovi-mall answers — see the ⚠ above.
            target: { type: 'administrator', id: context.actor.adminId, label: context.actor.email },
            context,
            payload: {
                slot: input.slot,
                declaredBytes: input.contentLength,
                contentType: input.contentType,
                maxBytes,
            },
        },
        async () => {
            const result = await platformUpload<UploadedStaffDocument[]>({
                path: '/identity-documents',
                body: input.body,
                contentType: input.contentType,
                contentLength: input.contentLength,
                maxBytes,
                actor: context.actor,
                requestId: context.requestId,
            });

            const files = Array.isArray(result.data) ? result.data : [];

            return {
                result: files,
                before: null,
                /**
                 * What was created, and never the CONTENT. Ids, the resolved types and the
                 * byte counts — the same rule `files.upload` follows, for the same reason.
                 *
                 * ⚠ `mimeType` is jovi-mall's SNIFFED and possibly CONVERTED type, not what
                 * the client claimed. The row records what exists, which is the point of
                 * recording it.
                 */
                after: {
                    slot: input.slot,
                    count: files.length,
                    fileIds: files.map((file) => file.id),
                    mimeTypes: files.map((file) => file.mimeType),
                    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
                },
            };
        },
    );
}

/**
 * Drop one of the caller's own documents at jovi-mall — reference row removed, file
 * soft-deleted.
 *
 * ⚠ **Not audited here.** The caller (`employee.service.ts`) performs this INSIDE an audited
 * transaction that also removes the id from the slot, because the two must be recorded as one
 * act: a row saying "detached a file" beside a row saying "cleared a slot" describes one
 * operation as two, and a reader cannot tell whether a lone "detached" row means the slot
 * write failed.
 *
 * ⚠ **And it therefore runs AFTER the commit, not inside it.** `auditedTransaction` may re-run
 * its callback on a write conflict, so an HTTP call inside one fires twice. The consequence is
 * real and worth stating: if this call fails after the slot write committed, the record is
 * correct and jovi-mall holds an orphaned file. That is the safe direction — a file nothing
 * points at is swept eventually; a slot pointing at a deleted file renders as a broken
 * document forever.
 */
export async function detachStaffDocument(
    fileId: string,
    context: ActorContext,
): Promise<void> {
    await platformRequest<{ id: string; removed: boolean }>({
        method: 'delete',
        path: `/identity-documents/${fileId}`,
        actor: context.actor,
        requestId: context.requestId,
    });
}
