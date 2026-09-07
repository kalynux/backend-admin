/**
 * Which storage trees are public, and which are reachable only through an authorized route.
 *
 * ── COPIED VERBATIM from jovi-mall ────────────────────────────────────────────
 *   source: jovi-mall/src/core/storage/storage-trees.ts  (the STORAGE_TREE_VISIBILITY export)
 *
 * This is the second artifact worth duplicating across the two services, and it is worth it
 * for the same narrow reason as `infra/platform/collections.ts`: it is pure frozen constants
 * with zero imports, so copying it carries no behaviour and no dependency graph.
 *
 * ── Why this file exists here at all ──────────────────────────────────────────
 * Because the owner chose to build `FileDetail.url` in this service rather than delegate it
 * (BR-015, decision L-3), and `url` is `null` for a file in a private tree. Deciding that
 * requires knowing the classification, so the classification has to be here. It is the
 * price of L-3 and it is why L-3 needed containment rather than just a decision.
 *
 * ⚠ **Getting this map wrong publishes a private file's URL**, which is precisely the defect
 * ADR-A01 D-2 closed on the other side: a delivery-proof photograph or a vendor's saleable
 * digital product, fetchable by anyone holding the link, forever. A stale copy here would
 * reintroduce it in a service whose whole audience is administrators, and nothing about the
 * resulting URL would look wrong.
 *
 * ── Keeping it in step ────────────────────────────────────────────────────────
 * `scripts/test/test-files.ts` re-reads jovi-mall's file from disk and asserts this map is
 * identical to it — same keys, same verdicts, no extras on either side. A tree added or
 * reclassified there fails a suite here rather than silently changing what this service
 * publishes. That is the same mechanism `test:data-access` applies to `COLLECTIONS`, and it
 * exists because the failure it guards is invisible in every other way.
 *
 * `verify:files` carries the other half: it resolves a sample of real ids through jovi-mall's
 * own `POST /files/resolve` and asserts the `url` and `access` this service builds locally are
 * byte-identical to the ones jovi-mall returns. The source diff proves the two files AGREE;
 * the live check proves this service's construction actually MATCHES. Neither implies the
 * other.
 */

export type TreeVisibility = 'public' | 'private';

/**
 * Every storage tree jovi-mall writes, with its verdict.
 *
 * The reasoning for each classification lives at the source, and is deliberately not
 * duplicated here — a copied justification is a justification that can drift from the
 * decision it describes while still reading as authoritative. What must match byte for byte
 * is the data, and that is what the test asserts.
 */
export const STORAGE_TREE_VISIBILITY: Readonly<Record<string, TreeVisibility>> = Object.freeze({
    // Type folders (`by-type` general media intake) — one per MediaCategory.
    images: 'public',
    videos: 'public',
    audio: 'public',
    documents: 'public',
    archives: 'public',
    other: 'public',

    // Purpose folders.
    products: 'public',
    variants: 'public',
    'vendor-policy-documents': 'public',
    'agency-policy-documents': 'public',
    system: 'public',

    // PRIVATE. Served only by an authorized route.
    digital: 'private',
    shipments: 'private',
    'ticket-attachments': 'private',
});

/**
 * The tree a storage key belongs to.
 *
 * ⚠ **BACKSLASHES ARE POSSIBLE.** jovi-mall's local provider builds keys with `path.join`, so
 * a key written on Windows carries `\`. Normalising here rather than at the call sites is what
 * stops "is this private?" answering differently on a developer's machine than in the
 * container — and this service reads those keys straight out of Mongo, so it inherits whatever
 * the writing host produced.
 */
export function treeOfKey(key: string): string | null {
    const normalized = key.replace(/\\/g, '/').replace(/^\/+/, '');
    const [tree] = normalized.split('/');
    return tree || null;
}

/**
 * Is this stored file behind an authorized route rather than a public URL?
 *
 * ⚠ **Fails CLOSED on an unrecognised tree.** A key whose tree nobody classified is treated as
 * private, because the alternative — assume public — is the original defect's own failure mode.
 * Here it also covers the copy going stale in the safe direction: a tree added in jovi-mall and
 * not yet mirrored across reads as private and yields `url: null`, which renders as a missing
 * image. The opposite default would publish it.
 */
export function isPrivateStorageKey(key: string): boolean {
    const tree = treeOfKey(key);
    if (!tree) return true;
    return STORAGE_TREE_VISIBILITY[tree] !== 'public';
}
