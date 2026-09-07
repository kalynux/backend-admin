import { platformRequest, platformStream, platformUpload } from '../../../infra/platform/platform.client';
import { toFileDetail } from '../../../infra/storage/file-detail';
import { adminUploadLimits } from '../domain/upload-limits';
import { createAppError } from '../../../core/errors/app-error';
import { ERROR_CODES } from '../../../core/errors/error-codes';
import { ActorContext, auditActorOf } from '../../audit/domain/audit-context';
import { auditedAttempt } from '../../audit/domain/audit.writer';

/**
 * The file surface that is DELEGATED to jovi-mall — which, since BR-015, is no longer all of it.
 *
 * ⚠ **Read the D-6 paragraph below as history, not as the current rule.** This file's four
 * operations still delegate and the reasoning for each still holds. What changed is the claim
 * the module used to make about the whole service: the media library
 * (`repositories/file-library.read.repository.ts`) reads `jovi_mall.files` DIRECTLY and builds
 * `FileDetail.url` here, from `infra/storage/public-url.ts`. That **reverses ADR-009 D-6** for
 * that one route, deliberately and by owner decision — `docs/ADR-021-ADMIN-MEDIA-LIBRARY.md`
 * D-3 is the record, and it carries the three containment mechanisms the reversal required.
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
 * ── Why THESE FOUR delegate, and why that is no longer an argument about D-6 ─
 * A URL is `storage.getPublicUrl(key)` and the provider comes from `STORAGE_PROVIDER`.
 * Building one here means a second copy of the storage configuration in a second
 * deployment, which is the duplication D-6 refused — and until BR-015 that argument
 * carried the whole module.
 *
 * It no longer decides anything, because the library now does exactly what this paragraph
 * said not to. The four operations here delegate on their own merits instead, and those
 * are the reasons that survive: `resolveMany` is the batch form of a shape jovi-mall
 * already serves, and the three below write, stream or destroy — none of which this
 * service may do to a collection jovi-mall owns (ADR-004 D-2, unamended: **writes are
 * still delegated without exception**).
 *
 * The two housekeeping operations (Phase 5 Part B) delegate for a second reason on top of
 * that one: jovi-mall owns the `files` collection, the `file_references` rows the orphan
 * query is the complement of, and the storage client the delete calls. There is nothing
 * here to own.
 *
 * ── Audited: the delete, and ONE of the reads ────────────────────────────────
 * ADR-006 D-5: reads are not audited, because a read leaves no state to reconstruct and
 * the permission gate is the whole control. The exceptions are all one shape — **the
 * output IS the disclosure** — and this module now holds one of them.
 *
 * `resolveMany` is NOT audited: it is the second half of a read the caller already made,
 * turning an id they are holding into a name and a size. Nor is the orphan listing, which
 * discloses nothing a file listing does not already say.
 *
 * `openContent` **is** audited (BR-011), fail-closed. Opening a private file discloses a
 * delivery-proof photograph or a vendor's saleable product — a different act from
 * resolving its name, and the reason it carries a different permission. The row is what
 * makes granting it to Support defensible, exactly as with `agents.tracking.read`.
 *
 * `hardDelete` is audited, and it is the only UNRECOVERABLE operation on this service's
 * whole surface. All three use intent → outcome rather than a transaction, for the
 * ordinary reason: the work happens in jovi-mall, which a `wi-admin` ClientSession cannot
 * join.
 */

/**
 * The canonical file wire shape — **declared in `infra/storage/file-detail.ts`**, and
 * re-exported here so the existing import path keeps working.
 *
 * ── Why it moved (BR-015 · decision L-3) ─────────────────────────────────────
 * It lived here while every `FileDetail` on this service was DELEGATED, and a pin of
 * jovi-mall's payload belongs beside the client that receives it. The Media library gave the
 * shape a SECOND producer — `toFileDetail`, which builds it locally from a row read straight
 * out of `jovi_mall.files` — and two producers of one wire shape need one type rather than two
 * that happen to agree. The declaration and its full field documentation are there; nothing
 * about the wire changed.
 */
import type { FileDetail } from '../../../infra/storage/file-detail';
export type { FileDetail };

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
// Content — BR-011
// ─────────────────────────────────────────────────────────────────────────────

/** An open byte stream from jovi-mall, plus what the bytes turned out to be. */
export interface FileContent {
    stream: NodeJS.ReadableStream;
    contentType: string;
    contentLength: number | null;
    contentDisposition: string | null;
}

/**
 * Open a file's contents, and record that it was opened (BR-011).
 *
 * ── This service PROXIES bytes, and that is a first ───────────────────────────
 * Nothing else here streams. It is not a reversal of ADR-009 D-6 ("this service resolves
 * no file URLs") — D-6 is about not owning a second copy of `STORAGE_PROVIDER`, and a
 * proxy owns none: it holds no storage configuration, no bucket name and no signing key,
 * and jovi-mall decides everything about the bytes including their content type.
 *
 * The alternative the dashboard proposed was a short-lived signed URL, which would have
 * kept the bytes off this hop. It was not taken because the configured provider (`local`)
 * has no `getSignedUrl` at all, so "sign it" means inventing a signing scheme AND standing
 * up a new unauthenticated route that serves private bytes to whoever holds the link. A
 * proxied read is authenticated for its whole life and needs no new public surface.
 *
 * ── The ordering IS the control ───────────────────────────────────────────────
 * `auditedAttempt` commits the intent BEFORE jovi-mall is asked, and does not catch a
 * failure of that write — so with the audit store down, nothing is disclosed. `transport:
 * 'delegated'`, so `recordEvent` (best-effort, swallows failures) is the wrong writer
 * here: the row IS the control, not a note about something that already happened.
 *
 * `after` is stamped from the RESPONSE HEADERS, which arrive before any byte is piped to
 * the client — so the row describes what was disclosed and is committed while it is still
 * true. It records the type and the size and **never the content**; putting bytes near the
 * audit store would make the trail the leak, the same rule the payout and tracking
 * disclosures follow.
 *
 * ⚠ A stream that fails MID-TRANSFER leaves a `succeeded` row. That is correct and worth
 * knowing when reading the trail back: the disclosure had already begun, and a partial
 * image is still an image. The row means "this file was opened", never "this file was
 * received intact".
 */
export async function openContent(
    fileId: string,
    label: string | null,
    context: ActorContext,
): Promise<FileContent> {
    return auditedAttempt(
        {
            action: 'files.content.read',
            actor: auditActorOf(context.actor),
            target: { type: 'file', id: fileId, label },
            context,
            payload: { fileId },
        },
        async () => {
            const result = await platformStream({
                method: 'GET',
                path: `/files/${fileId}/content`,
                actor: context.actor,
                requestId: context.requestId,
            }).catch(rethrowUnsupportedProvider);

            return {
                result,
                after: {
                    disclosed: true,
                    mimeType: result.contentType,
                    size: result.contentLength,
                },
            };
        },
    );
}

/**
 * jovi-mall's "my provider cannot serve bytes" → this service's own code.
 *
 * ── Why it is translated rather than forwarded ────────────────────────────────
 * Left alone, this arrives as `PLATFORM_OPERATION_REJECTED` with the real answer buried in
 * `details.platformCode`. That is the right default for a *delegated verdict* — jovi-mall
 * refused a business rule and its code is the explanation — but it is the wrong shape
 * here, because this is not a verdict about the request at all. It is a standing fact
 * about the deployment: it will be true for every file, forever, until somebody changes
 * `STORAGE_PROVIDER`.
 *
 * A client has to render those two differently — "that didn't work" versus "this platform
 * cannot display private files" — and asking it to branch on a nested `platformCode` for
 * one case makes the distinction easy to miss and easy to lose. So it gets a first-class
 * code, and `platformCode` still travels in `details` for anyone who wants the origin.
 *
 * ⚠ **Only this one is translated.** A 404, a 503, an unreachable jovi-mall — all keep
 * their ordinary shapes. Translating more would mean a second copy of jovi-mall's registry
 * growing here one code at a time, which is exactly what the opaque-`platformCode`
 * convention exists to prevent.
 */
function rethrowUnsupportedProvider(error: unknown): never {
    const details = (error as { details?: { platformCode?: string } } | null)?.details;

    if (details?.platformCode === 'STORAGE_DOWNLOAD_NOT_SUPPORTED') {
        throw createAppError(
            ERROR_CODES.FILE_CONTENT_NOT_SUPPORTED,
            409,
            'This deployment’s storage provider cannot display file contents',
            { platformCode: details.platformCode },
        );
    }

    throw error;
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

// ─────────────────────────────────────────────────────────────────────────────
// Upload — BR-015
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What jovi-mall answers for a created file: its `File` domain entity, one per uploaded
 * part.
 *
 * ⚠ **Not a `FileDetail`** — it carries `provider`, `checksum` and the soft-delete stamps,
 * and it carries **no `url` and no `access`**, because jovi-mall's upload route answers the
 * raw rows rather than running them through `resolveFileDetails`. Declared as its own shape
 * for the same reason `PlatformOrphanFile` is: sharing one interface would make the fields
 * this gateway drops look optional rather than absent.
 */
export interface UploadedPlatformFile {
    id: string;
    key: string;
    mimeType: string;
    size: number;
    originalName?: string;
    [field: string]: unknown;
}

/** One upload, as the caller hands it over. The body is the caller's own `req`, unread. */
export interface UploadInput {
    body: NodeJS.ReadableStream;
    contentType: string;
    contentLength: number | null;
}

/**
 * Stream an administrator's upload at jovi-mall, and record that they did it (BR-015).
 *
 * ── The first WRITE path for files on this service ────────────────────────────
 * There has never been one. `README.md` and `files.md` both stated *"wi-admin accepts no
 * multipart bodies anywhere"*, so the media picker the dashboard asked for would have been
 * permanently empty: no administrator could put a file on the platform through this
 * service, and jovi-mall's own upload route stopped being reachable by an `admin` session
 * at Phase 5 Part B.
 *
 * ── Why a PROXY, and not the upload ticket the BR preferred ───────────────────
 * BR-015 offered three shapes and starred the ticket: wi-admin mints a short-lived
 * single-use credential and the BROWSER posts the bytes to jovi-mall. The owner took the
 * proxy (L-2), and the reasons are worth keeping beside the code that implements it:
 *
 *   - **The ticket is a new authentication scheme**, minted here and verified there, for
 *     one endpoint. Its single-use property needs a store, its expiry needs a clock both
 *     services agree on, and an unauthenticated route that accepts bytes on production of a
 *     bearer string is a new public surface. The proxy adds no credential at all — it uses
 *     the service token already on every hop.
 *   - **It would have put the dashboard on two origins.** The dashboard talks to this
 *     service and to nothing else, by design (`README.md`, first line); an upload posted
 *     directly at jovi-mall means a second base URL, a second CORS allowlist, and a browser
 *     that must be told which host to send a file to.
 *   - **The audit row would have been a lie.** wi-admin would record "a ticket was minted",
 *     not "a file was uploaded" — and the two come apart exactly when it matters, because
 *     a minted ticket that is never used is indistinguishable in the trail from one that is.
 *
 * What the proxy costs is the body crossing this hop. What it does NOT cost is the rule the
 * contract actually stated: this service still never **parses** a multipart body, holds no
 * multer and no busboy, and gained no dependency. See `platformUpload` and ADR-021 D-2.
 *
 * ── The `FileDetail` is built HERE (L-3), and that is what closes the BR ───────
 * The dashboard needs `url` back on the same response — *"because the blog cover and image
 * block store a URL, not an id"* — and jovi-mall's upload route answers raw `File` rows
 * with no `url` on them. Rather than change that shared route's response shape (it serves
 * every vendor, agency, agent and customer upload on the platform), the rows are run
 * through the same local `toFileDetail` the media library uses. One URL builder on this
 * service, used by both new routes, proved byte-identical to jovi-mall's by `verify:files`.
 *
 * ⚠ **The `url` is real, not `null`.** Verified rather than assumed: `uploadFiles` there
 * calls `uploadIntakeService.execute({ folder: 'by-type', … })`, `resolveTypeFolder` maps
 * every `MediaCategory` onto one of `images|videos|audio|documents|archives|other`, and
 * `storage-trees.ts` classifies **all six `public`**. So an administrator's blog cover
 * resolves with `access: 'public'` and a working URL, and the blog half of BR-015 closes.
 *
 * ── Audited, fail-closed on the intent ────────────────────────────────────────
 * `auditedAttempt` commits the intent BEFORE the body is streamed and does not catch a
 * failure of that write — the `openContent` posture, for a write instead of a disclosure.
 * `transport: 'delegated'`: the row lands in jovi-mall's database, which no `wi-admin`
 * ClientSession can join.
 *
 * ⚠ The intent's `target.id` is **`null`**, because the file does not exist yet, and is
 * stamped from the outcome. A crash mid-upload therefore leaves an `attempted` row with no
 * target — read conservatively, that means a file MAY exist and this service cannot say.
 * A placeholder id would have been worse: it would name a record that never existed.
 */
export async function uploadFiles(
    input: UploadInput,
    context: ActorContext,
): Promise<FileDetail[]> {
    const limits = adminUploadLimits();

    return auditedAttempt(
        {
            action: 'files.upload',
            actor: auditActorOf(context.actor),
            // Unknowable until jovi-mall answers — see the ⚠ above.
            target: { type: 'file', id: null, label: null },
            context,
            /**
             * What was ATTEMPTED, from the only two facts available before the body is
             * read: the declared length and the multipart content type. Never a filename —
             * this service cannot see one without parsing, and inventing one from a header
             * would put a guess in the compliance record.
             */
            payload: {
                declaredBytes: input.contentLength,
                contentType: input.contentType,
                maxBytes: limits.maxBytes,
            },
        },
        async () => {
            const result = await platformUpload<UploadedPlatformFile[]>({
                path: '/files/upload',
                body: input.body,
                contentType: input.contentType,
                contentLength: input.contentLength,
                maxBytes: limits.maxBytes,
                actor: context.actor,
                requestId: context.requestId,
            });

            const rows = Array.isArray(result.data) ? result.data : [];
            const files = rows.map((row) =>
                toFileDetail({
                    id: row.id,
                    key: row.key,
                    mimeType: row.mimeType,
                    size: row.size,
                    originalName: row.originalName ?? null,
                }),
            );

            return {
                result: files,
                /**
                 * `before` is `null` by construction — nothing existed to diff against.
                 *
                 * `after` records what was created and never the CONTENT: ids, names, the
                 * resolved types and the byte counts. Putting bytes near the audit store
                 * would make the trail the leak, the rule `openContent` and the payout and
                 * tracking disclosures all follow.
                 *
                 * ⚠ `mimeType` here is jovi-mall's SNIFFED and possibly CONVERTED type, not
                 * what the client claimed: a PNG is stored as WebP by that pipeline's own
                 * policy. The row records what exists, which is the point of recording it.
                 */
                before: null,
                after: {
                    count: files.length,
                    fileIds: files.map((file) => file.id),
                    originalNames: files.map((file) => file.originalName ?? null),
                    mimeTypes: files.map((file) => file.mimeType),
                    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
                },
                /**
                 * One row per REQUEST, and the target names the first file.
                 *
                 * A request may carry up to ten parts and the audit schema addresses one
                 * record, so the alternatives were a row per file — which would multiply
                 * every upload into ten rows describing one operator action — or a
                 * `target: 'none'` row with the ids in the payload, which was rejected at
                 * `files.delete` for moving the only searchable handle out of the column an
                 * operator queries. The ids of every file are in `after` regardless; this is
                 * about what the row is FINDABLE by.
                 */
                target: files.length > 0
                    ? { id: files[0].id, label: files[0].originalName ?? null }
                    : undefined,
            };
        },
    );
}
