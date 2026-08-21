import { ArticleCover, ArticleTranslationDoc } from './article.document';
import { RESERVED_ARTICLE_SLUGS, ContentLocale } from './content.types';
import { ArticleBody, countWords } from '../validators/article-body.validator';

/**
 * The article rules that need no database.
 *
 * Extracted for the reason every DB-free rule in this service is: they are the part worth
 * testing, and `test:content` is a plain `ts-node` script with no Mongo. Everything that
 * needs a query — slug uniqueness across articles, the author's existence, the featured
 * rule — lives in `services/article.service.ts` instead.
 */

/** A translation as the editor sends it, before it becomes a stored subdocument. */
export interface TranslationInput {
    locale: ContentLocale;
    slug: string;
    title: string;
    metaTitle?: string;
    excerpt: string;
    body: ArticleBody;
    published: boolean;
}

/** `category`, `page`, `index` — see `RESERVED_ARTICLE_SLUGS` for what each collides with. */
export function isReservedSlug(slug: string): boolean {
    return RESERVED_ARTICLE_SLUGS.includes(slug);
}

/**
 * Merge an incoming translation set over the stored one, **preserving slug history**.
 *
 * The whole point: when a translation's slug changes, the old one is not lost — it is
 * pushed onto `previous_slugs`, which is what lets jovi-mall's public route answer
 * `BLOG_ARTICLE_MOVED` instead of a bare 404 that wastes the old path's inbound links.
 *
 * A slug that changes and then changes *back* keeps only one copy of each retired value,
 * and the slug now in use is removed from the history — it is current, not retired, and
 * leaving it in both places would make the "did this move?" test ambiguous.
 *
 * `word_count` is recomputed here rather than accepted, so it cannot drift from the prose
 * after a revision. That is the second of the three derivations C-6 warns about; the third
 * is `contentChanged` below.
 */
export function mergeTranslations(
    existing: ArticleTranslationDoc[],
    incoming: TranslationInput[],
): ArticleTranslationDoc[] {
    const previousByLocale = new Map(existing.map((translation) => [translation.locale, translation]));

    return incoming.map((translation) => {
        const before = previousByLocale.get(translation.locale);

        const history = new Set<string>(before?.previous_slugs ?? []);
        if (before && before.slug !== translation.slug) history.add(before.slug);
        history.delete(translation.slug);

        return {
            locale: translation.locale,
            slug: translation.slug,
            title: translation.title,
            meta_title: translation.metaTitle ?? null,
            excerpt: translation.excerpt,
            body: translation.body,
            word_count: countWords(translation.body),
            published: translation.published,
            previous_slugs: [...history],
        };
    });
}

/**
 * Did the *prose* change?
 *
 * Stamping `content_updated_at` from a blanket "row was written" timestamp would move it on
 * every save, so toggling `featured` or moving a category would tell a search engine the
 * article was revised. This compares only what a reader would see — the fields that render,
 * plus the cover — and ignores `published`, which is a visibility decision rather than an
 * edit.
 *
 * Adding or removing a language *is* a revision: the article's `hreflang` set changed, and
 * that is a change to the published page.
 */
export function contentChanged(
    before: { translations: ArticleTranslationDoc[]; cover: ArticleCover | null },
    after: { translations: ArticleTranslationDoc[]; cover: ArticleCover | null },
): boolean {
    return fingerprint(before) !== fingerprint(after);
}

function fingerprint(article: {
    translations: ArticleTranslationDoc[];
    cover: ArticleCover | null;
}): string {
    const translations = [...article.translations]
        .sort((a, b) => a.locale.localeCompare(b.locale))
        .map((translation) => ({
            locale: translation.locale,
            slug: translation.slug,
            title: translation.title,
            meta_title: translation.meta_title,
            excerpt: translation.excerpt,
            body: translation.body,
        }));

    return JSON.stringify({ translations, cover: article.cover ?? null });
}

/**
 * Why this article cannot be published yet, as a checklist rather than a first failure.
 *
 * A checklist because publishing is an explicit human action: telling an editor about one
 * missing piece at a time, over three round-trips, is how a publish button earns a
 * reputation for being broken.
 */
export function collectPublishBlockers(article: {
    translations: ArticleTranslationDoc[];
    authorExists: boolean;
}): string[] {
    const blockers: string[] = [];

    if (!article.authorExists) {
        blockers.push('The byline this article credits does not exist — create the author first');
    }
    if (article.translations.length === 0) {
        blockers.push('An article needs at least one translation');
    }
    if (article.translations.length > 0 && !article.translations.some((t) => t.published)) {
        blockers.push('Every translation is marked unpublished — at least one language must be live');
    }

    return blockers;
}
