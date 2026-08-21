import { createAppError } from '../../../core/errors/app-error';
import { ERROR_CODES } from '../../../core/errors/error-codes';
import { Paginated } from '../../../infra/platform/platform.repository';
import {
    AdminAuthorStamp,
    ArticleAuthorDocument,
    ArticleDocument,
    ArticleTranslationDoc,
    newArticleDocument,
} from '../domain/article.document';
import {
    collectPublishBlockers,
    contentChanged,
    isReservedSlug,
    mergeTranslations,
    TranslationInput,
} from '../domain/article-content.rules';
import { ContentLocale, RESERVED_ARTICLE_SLUGS } from '../domain/content.types';
import { buildSlugKeys } from '../domain/slug-keys';
import {
    ArticleAuthorOwnedRepository,
    articleAuthorRepository,
} from '../repositories/article-author.owned.repository';
import { ArticleOwnedRepository, articleRepository } from '../repositories/article.owned.repository';
import {
    CreateArticleBody,
    PublishArticleBody,
    SearchArticlesQuery,
    UpdateArticleBody,
} from '../validators/article.validator';

/**
 * The editor's half — every write, and the reads that show drafts.
 *
 * ## The lifecycle
 *
 * ```
 *   create ──▶ draft ──publish──▶ published ──archive──▶ archived
 *                 ▲                    │                     │
 *                 └────unpublish───────┘                     │
 *                 └───────────────unpublish──────────────────┘
 * ```
 *
 * `draft` and `archived` are both invisible publicly, but they are **not** the same state
 * and collapsing them would lose the distinction that matters: an archived URL answers
 * `410 Gone` with its category, so a reader who followed an inbound link is sent to the hub
 * instead of nowhere, and a search engine drops it cleanly. A draft URL simply 404s,
 * because it was never published in the first place.
 *
 * ## Where the rules live
 *
 * Shape rules are in the Zod schemas (`validators/`), rules that need no database are in
 * `domain/article-content.rules.ts`, and this class holds only what needs a query: slug
 * uniqueness across articles, the author's existence, and the featured-article rule.
 *
 * ## What this service is NOT
 *
 * It is not a gateway. Ownership of `articles` moved here (ADR-004 D-4) and these writes
 * land in `jovi_mall` through this service's own connection — so **nothing publishes an
 * event**, and nothing needs to: jovi-mall's blog had no in-process subscribers, which is
 * precisely the property that made the ownership move safe when tickets' did not.
 *
 * The audit row is written one layer up, by the controller, through `auditedAttempt`. It is
 * `transport: 'external'` rather than `wi_admin_txn` — two MongoClients, so a write to
 * `jovi_mall` cannot join a `wi-admin` session. Owning the collection buys no atomicity.
 */
export class ArticleService {
    constructor(
        private readonly articles: ArticleOwnedRepository = articleRepository,
        private readonly authors: ArticleAuthorOwnedRepository = articleAuthorRepository,
    ) {}

    // ─── Reads ─────────────────────────────────────────────────────────────────

    /**
     * The editor's list, plus the byline of each row resolved in one extra query.
     *
     * Resolved here rather than left to the client for the reason jovi-mall resolved it:
     * a list screen showing twenty rows would otherwise make twenty author calls, and the
     * byline is two strings.
     */
    async list(query: SearchArticlesQuery): Promise<{
        page: Paginated<ArticleDocument>;
        authorsByKey: Map<string, ArticleAuthorDocument>;
    }> {
        const page = await this.articles.search(query);
        const authorsByKey = await this.authors.findByKeys(page.items.map((article) => article.author_key));
        return { page, authorsByKey };
    }

    async getByKey(key: string): Promise<{
        article: ArticleDocument;
        author: ArticleAuthorDocument | null;
    }> {
        const article = await this.requireArticle(key);
        return { article, author: await this.resolveAuthor(article) };
    }

    /**
     * The byline of an article already in hand.
     *
     * Separate from `getByKey` so a caller holding the article — every write handler does,
     * because the service returned it — resolves the author without re-reading the article
     * itself. An article read is a full document including every body; the byline is two
     * strings and a locale map.
     */
    async resolveAuthor(article: ArticleDocument): Promise<ArticleAuthorDocument | null> {
        return this.authors.findByKey(article.author_key);
    }

    /**
     * The editor's preview: exactly the public detail shape, for an article at any status.
     *
     * It exists so that previewing never becomes a reason to relax jovi-mall's public
     * endpoints. The shape is produced by the same projection the reader gets, so what an
     * editor approves is what ships — and it is behind `content.articles.read`, which is
     * the whole difference.
     *
     * ⚠ **Do not "fix" this by adding a draft flag to the public route.** That was the
     * design jovi-mall's own requirements asked not to be used, and it would put every
     * unpublished article one query parameter away from a logged-out reader.
     */
    async previewTranslation(key: string, locale: ContentLocale): Promise<{
        article: ArticleDocument;
        translation: ArticleTranslationDoc;
    }> {
        const article = await this.requireArticle(key);
        const translation = article.translations.find((t) => t.locale === locale);
        if (!translation) {
            throw createAppError(
                ERROR_CODES.BLOG_ARTICLE_NOT_FOUND,
                404,
                'This article has no translation in that language',
                { id: key, locale },
            );
        }
        return { article, translation };
    }

    // ─── Writes ────────────────────────────────────────────────────────────────

    /** Creates a **draft**. Publishing is a separate, checklisted decision. */
    async create(input: CreateArticleBody, admin: AdminAuthorStamp): Promise<ArticleDocument> {
        const existing = await this.articles.findByKey(input.id);
        if (existing) {
            throw createAppError(ERROR_CODES.BLOG_ARTICLE_KEY_TAKEN, 409, undefined, { id: input.id });
        }

        const translations = mergeTranslations([], input.translations as TranslationInput[]);
        await this.assertSlugsAvailable(translations, input.id);

        const author = await this.authors.findByKey(input.authorId);
        if (!author) {
            throw createAppError(ERROR_CODES.BLOG_AUTHOR_NOT_FOUND, 404, undefined, { authorId: input.authorId });
        }

        await this.articles.insert(
            newArticleDocument({
                key: input.id,
                categoryKey: input.categoryKey,
                authorKey: input.authorId,
                // Stored and applied at publish time, where the one-per-locale rule can
                // actually be evaluated against the articles it competes with.
                featured: input.featured,
                cover: input.cover ?? null,
                translations,
                slugKeys: buildSlugKeys(translations),
                admin,
                now: new Date(),
            }),
        );

        return this.requireArticle(input.id);
    }

    async update(key: string, input: UpdateArticleBody, admin: AdminAuthorStamp): Promise<ArticleDocument> {
        const article = await this.requireArticle(key);

        const set: Partial<ArticleDocument> = { updated_by_admin: admin };

        if (input.categoryKey !== undefined) set.category_key = input.categoryKey;

        if (input.authorId !== undefined && input.authorId !== article.author_key) {
            const nextAuthor = await this.authors.findByKey(input.authorId);
            if (!nextAuthor) {
                throw createAppError(ERROR_CODES.BLOG_AUTHOR_NOT_FOUND, 404, undefined, { authorId: input.authorId });
            }
            set.author_key = input.authorId;
        }

        if (input.cover !== undefined) set.cover = input.cover ?? null;

        let nextTranslations = article.translations;
        if (input.translations !== undefined) {
            nextTranslations = mergeTranslations(article.translations, input.translations as TranslationInput[]);
            await this.assertSlugsAvailable(nextTranslations, key);
            set.translations = nextTranslations;
            set.slug_keys = buildSlugKeys(nextTranslations);
        }

        // Only a *published* article can be revised — a draft has no readers and no
        // `dateModified` for a revision to describe.
        if (article.status === 'published') {
            const changed = contentChanged(
                { translations: article.translations, cover: article.cover },
                {
                    translations: nextTranslations,
                    cover: input.cover !== undefined ? (input.cover ?? null) : article.cover,
                },
            );
            if (changed) set.content_updated_at = new Date();
        }

        const updated = (await this.articles.updateByKey(key, set)) ?? article;

        // Featured last, and only after the write: the rule reads the article's live locale
        // set, which the translations above may have just changed.
        if (input.featured !== undefined && input.featured !== article.featured) {
            await this.applyFeatured(updated, input.featured);
            return this.requireArticle(key);
        }

        return updated;
    }

    /**
     * Publish.
     *
     * `published_at` is stamped on the **first** publish only. A republish after an
     * unpublish keeps the original date, because it is the sort key the index, the sitemap
     * and the prev/next links share — re-stamping it silently reorders pages that link to
     * each other. `publishedAt` in the body overrides it, for importing an article that went
     * live elsewhere.
     */
    async publish(key: string, input: PublishArticleBody, admin: AdminAuthorStamp): Promise<ArticleDocument> {
        const article = await this.requireArticle(key);
        if (article.status === 'published') {
            throw createAppError(ERROR_CODES.BLOG_ARTICLE_ALREADY_PUBLISHED, 409, undefined, { id: key });
        }

        const author = await this.authors.findByKey(article.author_key);
        const blockers = collectPublishBlockers({
            translations: article.translations,
            authorExists: author !== null,
        });
        if (blockers.length > 0) {
            throw createAppError(ERROR_CODES.BLOG_ARTICLE_NOT_PUBLISHABLE, 422, undefined, { id: key, blockers });
        }

        const updated = await this.articles.updateByKey(key, {
            status: 'published',
            published_at: input.publishedAt ?? article.published_at ?? new Date(),
            archived_at: null,
            updated_by_admin: admin,
        });

        const result = updated ?? article;
        if (result.featured) await this.applyFeatured(result, true);

        return this.requireArticle(key);
    }

    /**
     * Back to `draft` — for an article pulled while it is corrected.
     *
     * Not the way to retire an article for good: that is `archive`, which keeps the URL
     * answering `410` with its category rather than 404-ing an address other sites link to.
     */
    async unpublish(key: string, admin: AdminAuthorStamp): Promise<ArticleDocument> {
        const article = await this.requireArticle(key);
        const updated = await this.articles.updateByKey(key, {
            status: 'draft',
            archived_at: null,
            // A draft cannot hold the featured slot: the index would lead with an article
            // whose every URL 404s.
            featured: false,
            updated_by_admin: admin,
        });
        return updated ?? article;
    }

    /** Retire for good. The URL keeps answering — `410 Gone`, with the hub to fall back to. */
    async archive(key: string, admin: AdminAuthorStamp): Promise<ArticleDocument> {
        const article = await this.requireArticle(key);
        const updated = await this.articles.updateByKey(key, {
            status: 'archived',
            archived_at: new Date(),
            featured: false,
            updated_by_admin: admin,
        });
        return updated ?? article;
    }

    /**
     * Delete — **only an article that was never published**, and even then a soft delete.
     *
     * Once an address has been live it may have inbound links, and a 404 wastes them. The
     * remedy for a published mistake is `archive` (410 + the category hub), so this refuses
     * with `409 BLOG_ARTICLE_DELETE_NOT_ALLOWED` and says so. `published_at` rather than
     * `status` is the test: an already-unpublished article was still live once.
     */
    async remove(key: string): Promise<ArticleDocument> {
        const article = await this.requireArticle(key);
        if (article.published_at !== null) {
            throw createAppError(ERROR_CODES.BLOG_ARTICLE_DELETE_NOT_ALLOWED, 409, undefined, {
                id: key,
                publishedAt: article.published_at.toISOString(),
            });
        }
        await this.articles.softDeleteByKey(key);
        // Returned for the audit row's `after` state — the caller has nothing else to read
        // once the row is gone from every live query.
        return article;
    }

    // ─── Rules that need a query ───────────────────────────────────────────────

    /**
     * At most one featured article per locale.
     *
     * Implemented as a demotion rather than a `409`: `featured` is per-article while the
     * rule is per-locale, so an editor featuring a French article has no way to know what is
     * currently featured in the four other languages it also publishes in. Refusing would
     * ask them to go and find out; demoting states the rule and moves on. It is an editorial
     * nicety anyway — the index falls back to the newest article when nothing is featured.
     */
    private async applyFeatured(article: ArticleDocument, featured: boolean): Promise<void> {
        if (!featured) {
            await this.articles.setFeatured(article.key, false);
            return;
        }

        const locales = article.translations
            .filter((translation) => translation.published)
            .map((translation) => translation.locale);

        const competitors = await this.articles.findFeaturedSharingLocales(locales, article.key);
        for (const competitor of competitors) {
            await this.articles.setFeatured(competitor.key, false);
        }

        await this.articles.setFeatured(article.key, true);
    }

    /**
     * Slug availability, per locale, across every article.
     *
     * Checks **retired** slugs too (`slug_keys` holds both), so no article can claim a slug
     * another one redirects from — a reused slug turns a permanent redirect into a wrong
     * answer, which is worse than the 404 it was avoiding.
     *
     * ⚠ Check-then-write, narrowed by the unique index on `slug_keys` — **an index declared
     * in jovi-mall's schema, not in this repository** (Phase 5 plan O-3). Two editors racing
     * on the same slug lose the second write to an `11000`, which the error handler maps to
     * a 409. The check is what turns the common case into a named error; the index is what
     * makes the race safe, and it is enforced by a service that no longer writes here.
     */
    private async assertSlugsAvailable(
        translations: ArticleTranslationDoc[],
        ownKey: string,
    ): Promise<void> {
        for (const translation of translations) {
            if (isReservedSlug(translation.slug)) {
                throw createAppError(ERROR_CODES.BLOG_SLUG_RESERVED, 400, undefined, {
                    locale: translation.locale,
                    slug: translation.slug,
                    reserved: [...RESERVED_ARTICLE_SLUGS],
                });
            }

            const taken = await this.articles.slugTakenByAnother(translation.locale, translation.slug, ownKey);
            if (taken) {
                throw createAppError(ERROR_CODES.BLOG_SLUG_TAKEN, 409, undefined, {
                    locale: translation.locale,
                    slug: translation.slug,
                });
            }
        }
    }

    async requireArticle(key: string): Promise<ArticleDocument> {
        const article = await this.articles.findByKey(key);
        if (!article) {
            throw createAppError(ERROR_CODES.BLOG_ARTICLE_NOT_FOUND, 404, undefined, { id: key });
        }
        return article;
    }
}

export const articleService = new ArticleService();
