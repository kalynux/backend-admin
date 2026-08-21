import {
    AdminAuthorStamp,
    ArticleAuthorDocument,
    ArticleCover,
    ArticleDocument,
} from '../domain/article.document';
import { ArticleAuthorType, ArticleCategoryKey, ArticleStatus, ContentLocale } from '../domain/content.types';
import { availableLocalesOf } from './public-article.dto';
import { ArticleBody } from '../validators/article-body.validator';

/**
 * The editor's view — everything the public projection hides.
 *
 * Deliberately a different shape from `PublicArticleSummaryDto` rather than "the public one
 * plus flags": drafts, retired slugs and per-locale publish state are the editor's whole job
 * and none of them belong on a public page. Keeping the two apart is also what stops a
 * "return drafts with a flag" preview from creeping into jovi-mall's public endpoints.
 *
 * ── The list/detail split, which the legacy shape did not have ────────────────
 * jovi-mall's editor list returned full bodies on every row. This one does not: the list
 * DTO carries every translation **without its body**, and the detail DTO adds it back. Same
 * call `TICKET_LIST_PROJECTION` makes, for the same reason — a page of twenty articles in
 * five languages, each body up to 400 blocks, is a payload no inbox renders. The repository
 * projection and this pair are two halves of one decision; changing either alone produces a
 * DTO reading fields that were never fetched.
 *
 * ── camelCase on the wire, snake_case in the collection ───────────────────────
 * The stored shape is jovi-mall's and stays snake_case, because its public reader serves the
 * same documents. Every wi-admin DTO presents camelCase (ADR-005), so the translation
 * happens here and nowhere else.
 */

export interface AdminAuthorRefDto {
    id: string;
    name: string;
    type: ArticleAuthorType;
}

/** The administrative author — see `domain/admin-author.ts` for why it is not the byline. */
export interface AdminAuthorStampDto {
    id: string;
    name: string;
    tier: 1 | 2 | 3;
}

export interface AdminArticleTranslationSummaryDto {
    locale: ContentLocale;
    slug: string;
    title: string;
    metaTitle: string | null;
    excerpt: string;
    wordCount: number;
    published: boolean;
    /**
     * Retired slugs, oldest first. Each one answers `BLOG_ARTICLE_MOVED` on jovi-mall's
     * public route — which is the whole reason the editor is shown them.
     */
    previousSlugs: string[];
}

export interface AdminArticleTranslationDto extends AdminArticleTranslationSummaryDto {
    body: ArticleBody;
}

interface AdminArticleBaseDto {
    id: string;
    status: ArticleStatus;
    categoryKey: ArticleCategoryKey;
    authorId: string;
    /** Resolved so the list does not need a second call; null if the byline was removed. */
    author: AdminAuthorRefDto | null;
    featured: boolean;
    cover: ArticleCover | null;
    publishedAt: string | null;
    /** Content revisions only — a `featured` toggle does not move this. */
    updatedAt: string | null;
    archivedAt: string | null;
    availableLocales: ContentLocale[];
    createdBy: AdminAuthorStampDto | null;
    updatedBy: AdminAuthorStampDto | null;
    createdAt: string;
    /**
     * When the row was last written, for any reason.
     *
     * Named apart from the content `updatedAt` above because conflating "somebody saved
     * this" with "the prose changed" is what would put a wrong `dateModified` in the
     * structured data.
     */
    lastSavedAt: string;
}

/** A row of the editor's inbox. Every translation, **without its body**. */
export interface AdminArticleSummaryDto extends AdminArticleBaseDto {
    translations: AdminArticleTranslationSummaryDto[];
}

/** One article, whole. */
export interface AdminArticleDto extends AdminArticleBaseDto {
    translations: AdminArticleTranslationDto[];
}

function toStampDto(stamp: AdminAuthorStamp | null | undefined): AdminAuthorStampDto | null {
    if (!stamp) return null;
    // `source` is deliberately not on the wire: it is always `'admin'` on anything this
    // service wrote, and a field with one possible value teaches a client nothing.
    return { id: stamp.id, name: stamp.name, tier: stamp.tier };
}

function baseOf(article: ArticleDocument, author: ArticleAuthorDocument | null): AdminArticleBaseDto {
    return {
        id: article.key,
        status: article.status,
        categoryKey: article.category_key,
        authorId: article.author_key,
        author: author ? { id: author.key, name: author.name, type: author.type } : null,
        featured: article.featured,
        cover: article.cover ?? null,
        publishedAt: article.published_at ? article.published_at.toISOString() : null,
        updatedAt: article.content_updated_at ? article.content_updated_at.toISOString() : null,
        archivedAt: article.archived_at ? article.archived_at.toISOString() : null,
        availableLocales: availableLocalesOf(article),
        createdBy: toStampDto(article.created_by_admin),
        updatedBy: toStampDto(article.updated_by_admin),
        createdAt: article.createdAt.toISOString(),
        lastSavedAt: article.updatedAt.toISOString(),
    };
}

function toTranslationSummary(
    translation: ArticleDocument['translations'][number],
): AdminArticleTranslationSummaryDto {
    return {
        locale: translation.locale,
        slug: translation.slug,
        title: translation.title,
        metaTitle: translation.meta_title ?? null,
        excerpt: translation.excerpt,
        wordCount: translation.word_count,
        published: translation.published,
        previousSlugs: [...translation.previous_slugs],
    };
}

export function toAdminArticleSummaryDto(
    article: ArticleDocument,
    author: ArticleAuthorDocument | null,
): AdminArticleSummaryDto {
    return {
        ...baseOf(article, author),
        translations: article.translations.map(toTranslationSummary),
    };
}

export function toAdminArticleDto(
    article: ArticleDocument,
    author: ArticleAuthorDocument | null,
): AdminArticleDto {
    return {
        ...baseOf(article, author),
        translations: article.translations.map((translation) => ({
            ...toTranslationSummary(translation),
            body: translation.body,
        })),
    };
}

// ─── Authors ─────────────────────────────────────────────────────────────────

export interface AdminArticleAuthorDto {
    id: string;
    name: string;
    type: ArticleAuthorType;
    avatarUrl: string | null;
    translations: Record<string, { title: string; bio: string }>;
    /**
     * How many live articles credit this byline. Zero is what makes a delete possible, so
     * the editor can see the answer before pressing a button that will be refused.
     */
    articleCount: number;
}

export function toAdminArticleAuthorDto(
    author: ArticleAuthorDocument,
    articleCount: number,
): AdminArticleAuthorDto {
    const translations: Record<string, { title: string; bio: string }> = {};
    for (const [locale, translation] of Object.entries(author.translations ?? {})) {
        if (translation) translations[locale] = { title: translation.title, bio: translation.bio };
    }

    return {
        id: author.key,
        name: author.name,
        type: author.type,
        avatarUrl: author.avatar_url ?? null,
        translations,
        articleCount,
    };
}
