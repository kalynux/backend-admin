import { env } from '../../config/env';
import { logger } from '../../core/logging/logger';

/**
 * Building a public storage URL in THIS service — BR-015, decision L-3.
 *
 * ── This reverses ADR-009 D-6, knowingly ─────────────────────────────────────
 * D-6 says "this service resolves no file URLs", and every previous file feature upheld it:
 * `POST /files/resolve` delegates, and even the byte proxy at `GET /:fileId/content` was
 * argued as upholding D-6 because a proxy holds no bucket name and no signing key. This file
 * is the first thing on this service that does hold storage configuration, and the owner chose
 * it deliberately over the alternative (one batched `/files/resolve` hop per page of the Media
 * library). The amendment is written up rather than left implicit — see
 * `docs/ADR-021-ADMIN-MEDIA-LIBRARY.md`.
 *
 * ── What D-6 was actually protecting, and how it is contained ────────────────
 * The risk was never the arithmetic — for `local` a URL is a string concatenation. It was
 * TWO COPIES OF ONE CONFIGURATION IN TWO DEPLOYMENTS, drifting silently. So:
 *
 *   1. The variable names below are **identical to jovi-mall's**. That is the newest lesson
 *      on this platform written down: `GEO_TRACKER_ADMIN_TOKEN` was given a matching name on
 *      purpose, on the grounds that a fifth shared value should not also be a fourth name to
 *      remember. `STORAGE_LOCAL_URL` here IS `STORAGE_LOCAL_URL` there.
 *   2. `storage-trees.ts` beside this file is a verbatim copy, diffed against jovi-mall's by
 *      `test:files`.
 *   3. `verify:files` asserts the URL built here is byte-identical to the one jovi-mall
 *      returns from `POST /files/resolve` for the same id. That is the only check that proves
 *      the two deployments actually agree, and it is why it exists.
 *
 * ⚠ **Nothing compares one side's value against the other's, so a MISMATCH IS SILENT** — the
 * same property the four existing cross-service secrets have, and the reason `docs/RUNBOOK.md`
 * has a rotation section. A wrong `STORAGE_LOCAL_URL` here does not fail a boot or log an
 * error; it produces URLs that 404, on a screen full of thumbnails, which reads as "the files
 * are gone".
 *
 * ── Inert when unconfigured, never wrong ─────────────────────────────────────
 * `STORAGE_PROVIDER` is optional here, matching this service's house rule that optional means
 * genuinely inert rather than silently degraded. Unset, or set to a provider whose URL form
 * cannot be reproduced faithfully, every `url` is `null` and a warning is logged ONCE. A
 * `null` url is a shape every client on this platform already handles — it is the normal
 * answer for a private file — whereas a plausible-looking wrong URL is indistinguishable from
 * a working one until somebody clicks it.
 */

/**
 * The providers whose public-URL form this service can reproduce EXACTLY.
 *
 * ⚠ Deliberately narrower than either enum on the other side, and the gap is the point:
 *
 *   - `IFile.provider` (the Mongoose model) allows six — `local | s3 | gcs | r2 | firebase |
 *     cloudinary`. TWO of those (`s3`, `gcs`) have **no provider implementation in jovi-mall at
 *     all**; `storage.config.ts` declares four. The model's enum is still wider than the
 *     factory's, and a row carrying one of the two phantom values cannot be resolved by either
 *     service. (`r2` was a phantom until 2026-09-09 and is now implemented on both sides — it
 *     is the reason this paragraph says two rather than three.)
 *   - `cloudinary` IS implemented there, and is excluded here anyway. Its URL comes from
 *     `cloudinary.url(key, { secure, fetch_format: 'auto', quality: 'auto' })` — the SDK's own
 *     builder, which infers a resource type from the key and injects transformation segments.
 *     Reimplementing that from the outside is guesswork that would be right for images and
 *     quietly wrong for video and raw. Closing it is a one-line change the day a deployment
 *     selects that provider: add the `cloudinary` package and call `cloudinary.url` with the
 *     same options (URL building is local and needs only `cloud_name` — no API call, no
 *     credentials).
 */
const REPRODUCIBLE_PROVIDERS = ['local', 'firebase', 'r2'] as const;
export type ReproduciblePublicUrlProvider = (typeof REPRODUCIBLE_PROVIDERS)[number];

/** One warning per process, not one per file row on a 100-row page. */
let unsupportedProviderWarned = false;

function warnOnce(provider: string | undefined, reason: string): void {
    if (unsupportedProviderWarned) return;
    unsupportedProviderWarned = true;
    logger().warn(
        { provider: provider ?? null, reason },
        'Storage URLs cannot be built in wi-admin; every FileDetail.url will be null. '
        + 'See infra/storage/public-url.ts and ADR-021.',
    );
}

/**
 * The public URL jovi-mall would return for this key, or `null` when this service cannot
 * build it faithfully.
 *
 * ⚠ **Keyed on the ACTIVE provider, not on the file row's `provider` field** — and that is a
 * deliberate copy of a jovi-mall behaviour rather than an oversight. `toFileDetail` there calls
 * `storage.getPublicUrl(key)` on the configured provider whatever the row says, so a file
 * written under `local` and later migrated to `firebase` resolves through the new provider on
 * both sides. Reading `row.provider` here would be *more* defensible in isolation and would
 * make the two services disagree, which is the one outcome this whole file is built to avoid.
 * If that behaviour is ever wrong it is wrong in jovi-mall first, and fixing it there is what
 * should change this.
 */
export function buildPublicUrl(key: string): string | null {
    const config = env();
    const provider = config.STORAGE_PROVIDER;

    if (!provider) {
        warnOnce(provider, 'STORAGE_PROVIDER is not set');
        return null;
    }

    if (!isReproducible(provider)) {
        warnOnce(provider, 'this provider’s URL form cannot be reproduced outside jovi-mall');
        return null;
    }

    if (provider === 'local') {
        // Verbatim from `LocalStorageProvider.getPublicUrl`: normalise to forward slashes and
        // concatenate. The backslash case is real — see `treeOfKey`.
        const normalizedKey = key.replace(/\\/g, '/');
        return `${config.STORAGE_LOCAL_URL}/${normalizedKey}`;
    }

    if (provider === 'r2') {
        /**
         * Verbatim from `R2StorageProvider.getPublicUrl`: normalise to forward slashes and
         * concatenate against the public bucket's Cloudflare custom domain. **No
         * `encodeURIComponent`** — jovi-mall does not encode either, and encoding on one side
         * alone is exactly the silent divergence `verify:files` § 6 exists to catch.
         *
         * The trailing-slash strip is duplicated from jovi-mall's `storage.instance.ts` on
         * purpose: a trailing slash would emit `//key` on BOTH sides, so the parity check would
         * pass while every image 404'd. Three layers refuse it — there, here, and at boot.
         *
         * ⚠ This line is never reached for a private key: `toFileDetail` applies
         * `isPrivateStorageKey` first, exactly as jovi-mall's resolver does. Over there the
         * provider THROWS in that case, because its signature has no `null` to return; here the
         * shape is `string | null` and the guard upstream has already returned it.
         */
        const base = config.STORAGE_R2_PUBLIC_URL;
        if (!base) {
            warnOnce(provider, 'STORAGE_R2_PUBLIC_URL is not set');
            return null;
        }
        const normalizedKey = key.replace(/\\/g, '/');
        return `${base.replace(/\/+$/, '')}/${normalizedKey}`;
    }

    // Verbatim from `FirebaseStorageProvider.getPublicUrl`, including the branch: a public
    // bucket gets the storage.googleapis.com form, a private one the firebasestorage.googleapis
    // media form. Both are what jovi-mall emits, so both are what this must emit.
    const bucket = config.STORAGE_FIREBASE_BUCKET;
    if (!bucket) {
        warnOnce(provider, 'STORAGE_FIREBASE_BUCKET is not set');
        return null;
    }

    return config.STORAGE_FIREBASE_PUBLIC
        ? `https://storage.googleapis.com/${bucket}/${key}`
        : `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(key)}?alt=media`;
}

function isReproducible(provider: string): provider is ReproduciblePublicUrlProvider {
    return (REPRODUCIBLE_PROVIDERS as readonly string[]).includes(provider);
}

/**
 * Can this deployment build URLs at all?
 *
 * Exported so a route can report the fact rather than leaving a client to infer it from a page
 * of `null`s — the same `configured: false` shape the two geo-tracker doors already use, and
 * the same reason: "not set up here" and "there is nothing to show" are different answers and
 * a client renders them differently.
 */
export function publicUrlsAreConfigured(): boolean {
    const config = env();
    if (!config.STORAGE_PROVIDER || !isReproducible(config.STORAGE_PROVIDER)) return false;
    if (config.STORAGE_PROVIDER === 'local') return true;
    if (config.STORAGE_PROVIDER === 'r2') return Boolean(config.STORAGE_R2_PUBLIC_URL);
    return Boolean(config.STORAGE_FIREBASE_BUCKET);
}
