import {
    ArticleAuthorDocument,
    ArticleCover,
    ArticleDocument,
    ArticleTranslationDoc,
} from '../domain/article.document';
import {
    ArticleAuthorType,
    ArticleCategoryKey,
    CONTENT_LOCALES,
    ContentLocale,
    DEFAULT_CONTENT_LOCALE,
} from '../domain/content.types';
import { ArticleBody } from '../validators/article-body.validator';

/**
 * The article shape a logged-out reader gets — reproduced here for **one endpoint**.
 *
 * ── Why a public projection lives in the admin service at all ─────────────────
 * `GET /content/articles/:articleId/preview` returns the PUBLIC shape, at any status,
 * behind the admin guard. That is the design jovi-mall's requirements asked for and the
 * reason it works: previewing never becomes an argument for relaxing the public endpoints.
 * The alternative — a `?includeDrafts=` flag on jovi-mall's public route — would put every
 * unpublished article one query parameter away from a logged-out reader.
 *
 * So this file is a **copy of jovi-mall's `public-article.dto.ts`**, and it must stay one:
 * if the preview and the published page render differently, the preview is worthless. The
 * two are kept honest by fixture rather than by import, the same way the block union is —
 * `test:content` here and `test:blog` there assert the same projection of the same input.
 *
 * ── What it deliberately omits ────────────────────────────────────────────────
 * `_id`, `deletedAt`, every draft-only field, and **both administrative-author stamps**.
 * `created_by_admin` / `updated_by_admin` are staff identity (Phase 17 plan § 3.4); this is
 * the shape a marketing page renders, and nothing on it may name an administrator. Adding a
 * field to `ArticleDocument` does not publish it — that is an edit here, on purpose.
 *
 * ── Optional keys are omitted, not nulled ─────────────────────────────────────
 * `metaTitle` and `updatedAt` are **absent** when unset rather than `null`, matching the
 * frontend's own types where both are `?:`. `cover` is the exception — it is emitted as an
 * explicit `null`, because "this article has no cover" is a state the card renders
 * (generated cover art) rather than a field it skips.
 */

/**
 * The cover as a **reader** receives it: the shared image, plus the alt text for the one
 * language being served.
 *
 * ⚠ **This shape is unchanged on the wire, and that is the point.** The stored `ArticleCover`
 * lost its `alt` when alt text became per-locale, but a public consumer still gets exactly
 * `{ url, alt, width, height }` — the projection reassembles it from the resolved
 * translation. So the marketing frontend needed no change for that migration, and neither did
 * jovi-mall's public response shape.
 */
export interface PublicArticleCover extends ArticleCover {
    alt: string;
}

export interface PublicAuthorDto {
    id: string;
    name: string;
    type: ArticleAuthorType;
    /** Job title, in the requested locale — English if that language has no bio. */
    title: string;
    bio: string;
    avatarUrl: string | null;
}

export interface PublicArticleSummaryDto {
    id: string;
    locale: ContentLocale;
    slug: string;
    title: string;
    metaTitle?: string;
    excerpt: string;
    categoryKey: ArticleCategoryKey;
    author: PublicAuthorDto | null;
    publishedAt: string;
    updatedAt?: string;
    featured: boolean;
    cover: PublicArticleCover | null;
    wordCount: number;
    /**
     * Exactly the locales this article is **published** in — what the frontend turns into
     * `pathByLocale` for `hreflang`. A locale whose translation exists but is still drafted
     * is not in here, because its URL 404s.
     */
    availableLocales: ContentLocale[];
}

export interface PublicArticleDetailDto extends PublicArticleSummaryDto {
    body: ArticleBody;
}

/**
 * Resolve a byline into one language.
 *
 * **The one deliberate fallback in this module.** Article prose never falls back — serving
 * English at a Portuguese URL publishes a page that contradicts its own `lang` attribute and
 * competes with its own original. A bio is different: a blank byline where the structured
 * data expects an author is worse than a bio in the wrong language.
 */
export function toPublicAuthorDto(author: ArticleAuthorDocument, locale: ContentLocale): PublicAuthorDto {
    const translations = author.translations ?? {};
    const translation = translations[locale] ?? translations[DEFAULT_CONTENT_LOCALE];

    return {
        id: author.key,
        name: author.name,
        type: author.type,
        title: translation?.title ?? '',
        bio: translation?.bio ?? '',
        avatarUrl: author.avatar_url ?? null,
    };
}

/** Published locales, in the platform's canonical language order so the list is stable. */
export function availableLocalesOf(article: ArticleDocument): ContentLocale[] {
    const published = new Set(
        article.translations.filter((translation) => translation.published).map((t) => t.locale),
    );
    return CONTENT_LOCALES.filter((locale) => published.has(locale));
}

function baseSummary(
    article: ArticleDocument,
    translation: ArticleTranslationDoc,
    author: ArticleAuthorDocument | null,
): PublicArticleSummaryDto {
    return {
        id: article.key,
        locale: translation.locale,
        slug: translation.slug,
        title: translation.title,
        ...(translation.meta_title ? { metaTitle: translation.meta_title } : {}),
        excerpt: translation.excerpt,
        categoryKey: article.category_key,
        author: author ? toPublicAuthorDto(author, translation.locale) : null,
        // On the public route this is non-null by construction — `published_at` is stamped
        // before `status` becomes `published`. On a PREVIEW it can be null, because the
        // whole point is showing an unpublished article, so `createdAt` stands in.
        publishedAt: (article.published_at ?? article.createdAt).toISOString(),
        ...(article.content_updated_at ? { updatedAt: article.content_updated_at.toISOString() } : {}),
        featured: article.featured,
        cover: coverFor(article, translation),
        wordCount: translation.word_count,
        availableLocales: availableLocalesOf(article),
    };
}

/**
 * The shared cover image, described in the language being served.
 *
 * ── Why `title` stands in when `cover_alt` is unset ───────────────────────────
 * On the PUBLIC route it cannot be: `collectPublishBlockers` refuses to publish a translation
 * that is going live with a cover and no alt text for it, so every published locale has one.
 * This branch exists for `/preview`, which renders unpublished work on purpose and would
 * otherwise emit `alt: ""` — and an empty alt is not "missing", it is the HTML for *this
 * image is decorative, skip it*, which is a lie about a cover.
 *
 * So the fallback is the article's own title in that same language. It is never blank, it is
 * never the wrong language, and it is never seen by a reader — which is why it is a stand-in
 * here rather than the kind of cross-locale fallback the header rules out.
 */
function coverFor(article: ArticleDocument, translation: ArticleTranslationDoc): PublicArticleCover | null {
    if (!article.cover) return null;
    return { ...article.cover, alt: translation.cover_alt ?? translation.title };
}

export function toPublicArticleSummaryDto(
    article: ArticleDocument,
    translation: ArticleTranslationDoc,
    author: ArticleAuthorDocument | null,
): PublicArticleSummaryDto {
    return baseSummary(article, translation, author);
}

export function toPublicArticleDetailDto(
    article: ArticleDocument,
    translation: ArticleTranslationDoc,
    author: ArticleAuthorDocument | null,
): PublicArticleDetailDto {
    return { ...baseSummary(article, translation, author), body: translation.body };
}
