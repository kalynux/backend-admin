import { env } from '../../../config/env';

/**
 * What an administration upload may be — **declared, never discovered** (BR-015 · ADR-021 D-4).
 *
 * The dashboard asked for exactly this and gave the reason: *"a 2 GB limit is jovi-mall's
 * per-role figure; whatever wi-admin's is, please state it."* A client that has to learn a
 * ceiling by hitting it shows the operator a failed upload where it could have shown a
 * disabled button.
 *
 * ── ⚠ Only ONE of these is enforced here, and the split is the thing to understand ──────
 *
 * | Constraint | Enforced by | Why |
 * |---|---|---|
 * | `maxBytes` | **this service**, before the hop | Countable without parsing — a header, and then the bytes themselves |
 * | `maxFiles` · `acceptedMimeTypes` · `fieldName` | **jovi-mall's pipeline** | Each needs the multipart body PARSED, and this service deliberately never parses one |
 *
 * That is decision L-2 showing through: wi-admin pipes an unread body across. It can count
 * bytes as they pass and it cannot see a part boundary, a field name or a `Content-Type`
 * per part — so the three lower rows are **published, not policed**. They are here so a
 * picker can filter its file dialog and refuse an obvious mistake locally; the authority is
 * the far side, and a file that slips past a client lands as an ordinary
 * `PLATFORM_OPERATION_REJECTED` carrying jovi-mall's `UPLOAD_POLICY_VIOLATION`.
 *
 * ⚠ **Publishing a list this service cannot enforce is a real hazard, and it is contained
 * by not making it configurable.** An `ADMIN_UPLOAD_ACCEPTED_MIME_TYPES` environment
 * variable would let a deployment advertise `video/mp4` — which jovi-mall's general upload
 * config has commented OUT — and every such upload would be refused at the far end by a
 * rule nobody could see from here. A constant mirrored from a named source can go stale;
 * a knob can be turned wrong on a Tuesday.
 */

/**
 * The MIME types jovi-mall's general upload pipeline accepts on `folder: 'by-type'`.
 *
 * ── COPIED from jovi-mall ────────────────────────────────────────────────────
 *   source: jovi-mall/src/core/uploads/upload-config.ts  (`getDefaultUploadConfig().perMimeType`,
 *           the entries with `allowed: true`)
 *
 * ⚠ Unlike `infra/storage/storage-trees.ts`, this copy is **not** diffed by a test, and the
 * difference is deliberate rather than an omission. Getting the tree map wrong publishes a
 * private file's URL — a silent security failure. Getting this list wrong shows an operator
 * a file type in a picker that the upload then refuses, out loud, with jovi-mall's own
 * violation attached. One needs a guard; the other announces itself.
 *
 * ⚠ **`image/png` is ACCEPTED and CONVERTED.** jovi-mall's policy for it carries
 * `convertTo: 'webp'`, so a PNG cover uploaded here comes back as `image/webp` with a
 * `.webp` key. That is not a fault and the returned `FileDetail` is the truth — a client
 * that stores what it *sent* rather than what came back will have the wrong `mimeType`.
 */
export const ADMIN_UPLOAD_ACCEPTED_MIME_TYPES: readonly string[] = Object.freeze([
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'application/pdf',
    'application/zip',
    'audio/mpeg',
    'audio/wav',
]);

/**
 * The multipart field name jovi-mall's multer instance is bound to.
 *
 * `uploadMultiple` is `multer(...).array('files', 10)`. A part sent under any other name is
 * not an error there — it is simply not seen, so the request arrives with zero files and is
 * refused as `NO_FILES_UPLOADED`, which reads as "you sent nothing" to a client that sent
 * something. Published so a picker cannot get it wrong.
 */
export const ADMIN_UPLOAD_FIELD_NAME = 'files';

/** jovi-mall's `maxFilesPerRequest` for the general pipeline, and multer's own array cap. */
export const ADMIN_UPLOAD_MAX_FILES = 10;

/** The constraints, as a client is told them. Shape matches the `meta.upload` block. */
export interface AdminUploadLimits {
    /** The whole request body, in bytes. `ADMIN_UPLOAD_MAX_BYTES`. */
    maxBytes: number;
    maxFiles: number;
    fieldName: string;
    acceptedMimeTypes: readonly string[];
}

/**
 * Resolved per call rather than captured at module load: `env()` is memoised, but a test
 * that swaps the environment and re-imports would otherwise hold the first value forever.
 */
export function adminUploadLimits(): AdminUploadLimits {
    return {
        maxBytes: env().ADMIN_UPLOAD_MAX_BYTES,
        maxFiles: ADMIN_UPLOAD_MAX_FILES,
        fieldName: ADMIN_UPLOAD_FIELD_NAME,
        acceptedMimeTypes: ADMIN_UPLOAD_ACCEPTED_MIME_TYPES,
    };
}
