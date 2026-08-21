import { ArticleTranslationDoc } from './article.document';

/**
 * `slug_keys` — the flattened `(locale, slug)` index, and the reason it exists.
 *
 * ── Why a flattened string array rather than a compound index ─────────────────
 * MongoDB refuses a compound index on two fields of the same array: `translations.locale`
 * and `translations.slug` are **parallel array paths**, and an index over both is rejected
 * at write time. Flattening the pair into one `"<locale>:<slug>"` string turns it into an
 * ordinary unique multikey index, which is the only way per-locale slug uniqueness is
 * enforceable at all.
 *
 * ── Where the index actually lives, which is not here ─────────────────────────
 * jovi-mall declares it (`article.model.ts`, `{ slug_keys: 1 }, { unique: true, sparse: true }`)
 * because it keeps the Mongoose schema for its public reader. This service owns the WRITES
 * to a collection whose schema and indexes live in another repository — deliberately, and
 * recorded as O-3 in the Phase 5 plan. The consequence to hold on to: **a duplicate slug is
 * refused by an index this repository does not define.** `verify:content` proves that
 * cross-service guarantee rather than assuming it.
 *
 * ── Why this file is separate from the model it came from ─────────────────────
 * `buildSlugKeys` lived on jovi-mall's `article.model.ts`, and the model does not move
 * (its public reader needs it). Copying the derivation without noticing is the exact
 * failure C-6 of the Phase 17 register names: an article whose slug is renamed keeps
 * answering on the old URL only because this function put the old value back.
 *
 * Covered by `test:content`.
 */

/** The lookup key for one `(locale, slug)` pair. */
export function slugKey(locale: string, slug: string): string {
    return `${locale}:${slug}`;
}

/**
 * Every `(locale, slug)` this article answers to — current slugs **and retired ones**.
 *
 * Retired slugs are included so that no *other* article can claim one: a reused slug turns
 * a permanent redirect into a wrong answer, which is worse than the 404 it was avoiding.
 *
 * Duplicate entries *within* one document are fine — Mongo de-duplicates before checking a
 * multikey unique index — which is what lets a translation keep a slug it had, lost, and
 * took back. The `Set` here is for a tidy stored array, not for correctness.
 */
export function buildSlugKeys(translations: ArticleTranslationDoc[]): string[] {
    const keys = new Set<string>();
    for (const translation of translations) {
        keys.add(slugKey(translation.locale, translation.slug));
        for (const previous of translation.previous_slugs) {
            keys.add(slugKey(translation.locale, previous));
        }
    }
    return [...keys];
}
