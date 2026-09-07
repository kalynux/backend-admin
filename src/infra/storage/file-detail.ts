import { buildPublicUrl } from './public-url';
import { isPrivateStorageKey } from './storage-trees';

/**
 * The canonical file wire shape, identical to jovi-mall's `FileDetail`.
 *
 * ── One definition, two producers ────────────────────────────────────────────
 * Until BR-015 this type lived in `modules/files/gateways/file.gateway.ts` and described a
 * payload that was always DELEGATED — a pin of what jovi-mall sends back. It now has a second
 * producer: `toFileDetail` below, which builds the same shape locally from a row read straight
 * out of `jovi_mall.files` (decision L-3). Two producers of one wire shape is exactly the
 * situation that needs one type rather than two agreeing ones, so the declaration moved here
 * and the gateway re-exports it.
 *
 * ⚠ **This pin was WRONG in two ways until BR-010**, and both were wrong in the same
 * direction: it declared `url: string` and omitted `access` entirely, so it described a private
 * file as having a URL and gave no way to tell that it does not. Nothing on the wire ever
 * changed — jovi-mall has sent both fields since ADR-A01 D-2 — so the damage was confined to
 * readers of the type, which is exactly the population a hand-written pin exists to inform.
 */
export interface FileDetail {
    id: string;
    key: string;
    /**
     * The publicly fetchable URL, or **`null`**.
     *
     * `null` has FOUR causes now, and a client cannot tell them apart from the `url` alone —
     * deliberately, because it renders them the same way. Only the fourth is distinguishable,
     * via `access`, and only because it is the one a person can DO something about:
     *
     *   1. the file is in a **private storage tree** (`shipments/`, `digital/`,
     *      `ticket-attachments/`). This is the normal, expected answer, not a fault — a client
     *      that treats it as one shows a broken-image icon on every delivery proof in the
     *      system. Use `GET /files/:fileId/content` to display these;
     *   2. this deployment has **no reproducible `STORAGE_PROVIDER`** configured on the
     *      wi-admin side (see `public-url.ts`). `publicUrlsAreConfigured()` is how a route
     *      reports that as a fact rather than leaving it to be inferred;
     *   3. jovi-mall answered `null` on a delegated resolve, for cause 1 on its own side;
     *   4. the owner is over their plan's storage cap and this file falls outside it —
     *      `access: 'quota_blocked'`. Not private, not missing, and not a fault: the file is
     *      intact and returns unchanged when they upgrade or free room.
     *
     * `null` rather than the authorized route's path is deliberate and is a **type change**:
     * a path is a string indistinguishable from a working URL, so every client would keep
     * rendering it and silently show nothing.
     */
    url: string | null;
    /**
     * Which of the three the `url` above is — a **closed set of three**.
     *
     *   `public`        `url` is a real, fetchable address.
     *   `authorized`    a private tree; `url` is `null` and `id` is the only handle. Display
     *                   these through `GET /files/:fileId/content`.
     *   `quota_blocked` the owner is over their plan's storage cap and this file falls
     *                   outside it. `url` is `null` and the content route will not help —
     *                   this is a BILLING state, so the useful thing to render is a
     *                   placeholder saying so, not a broken image and not "file missing".
     *
     * ⚠ The first two are derived from the tree's classification; the third is stored per
     * file (`files.quotaBlockedAt`) and **outranks** them, so a blocked file in a private
     * tree reports `quota_blocked` rather than `authorized`. Reporting the tree would send a
     * client to the content route to discover a billing problem.
     *
     * ⚠ Check this **and** `url !== null` before rendering an `<img>`. `access: 'public'` alone
     * is not enough: a public tree legitimately holds PDFs and video, and product media does.
     * A third condition, `mimeType.startsWith('image/')`, is what the dashboard actually gates
     * on and it is right to.
     */
    access: 'public' | 'authorized' | 'quota_blocked';
    mimeType: string;
    size: number;
    originalName?: string;
}

/** The columns `toFileDetail` needs off a `jovi_mall.files` row. */
export interface StoredFileRow {
    id: string;
    key: string;
    mimeType: string;
    size: number;
    originalName?: string | null;
    /**
     * Set while the owner is over their plan storage cap and this file falls outside it.
     * Written by jovi-mall's plan-quota sweep; wi-admin only ever reads it.
     *
     * Optional so a narrower projection still compiles — an omitted value reads as "not
     * blocked", which is correct for every file that has never been through the sweep.
     * ⚠ But a read model that projects file columns MUST include it: omitting it does not
     * fail, it silently republishes a URL jovi-mall has stopped handing out.
     */
    quotaBlockedAt?: Date | null;
}

/**
 * A raw `files` row → the canonical `FileDetail`.
 *
 * ── A deliberate mirror of jovi-mall's `toFileDetail` ────────────────────────
 *   source: jovi-mall/src/modules/catalog/read-models/file-detail.resolver.ts
 *
 * That function is described there as "the single place any `FileDetail` on the platform is
 * built". After L-3 that sentence is no longer true, and this is the other place — so the two
 * must agree by construction and be **proved** to agree rather than assumed to:
 * `verify:files` resolves the same ids through both paths and asserts the results are
 * byte-identical.
 *
 * The order of the three decisions matters and is copied exactly:
 *
 *   1. **quota first.** A blocked file is blocked whatever tree it is in, and reporting it as
 *      merely `authorized` would send a client to the content route to discover a billing
 *      problem — an answer about the wrong subject.
 *   2. privacy, decided from the KEY's tree;
 *   3. the URL, built ONLY for a file that is neither. Building it first and blanking it after
 *      would leave the construction running on keys it must never run on, where a logging line
 *      or a future refactor could leak it.
 */
export function toFileDetail(row: StoredFileRow): FileDetail {
    if (row.quotaBlockedAt) {
        return {
            id: row.id,
            key: row.key,
            url: null,
            access: 'quota_blocked',
            mimeType: row.mimeType,
            size: row.size,
            ...(row.originalName ? { originalName: row.originalName } : {}),
        };
    }

    const isPrivate = isPrivateStorageKey(row.key);

    return {
        id: row.id,
        key: row.key,
        url: isPrivate ? null : buildPublicUrl(row.key),
        access: isPrivate ? 'authorized' : 'public',
        mimeType: row.mimeType,
        size: row.size,
        ...(row.originalName ? { originalName: row.originalName } : {}),
    };
}
