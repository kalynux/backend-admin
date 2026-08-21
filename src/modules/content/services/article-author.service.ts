import { createAppError } from '../../../core/errors/app-error';
import { ERROR_CODES } from '../../../core/errors/error-codes';
import {
    ArticleAuthorDocument,
    ArticleAuthorTranslationDoc,
    newAuthorDocument,
} from '../domain/article.document';
import { ContentLocale } from '../domain/content.types';
import {
    ArticleAuthorOwnedRepository,
    articleAuthorRepository,
} from '../repositories/article-author.owned.repository';
import { ArticleOwnedRepository, articleRepository } from '../repositories/article.owned.repository';
import { CreateAuthorBody, UpdateAuthorBody } from '../validators/article.validator';

/**
 * Bylines. A small surface with one rule worth stating — see `remove`.
 *
 * ⚠ **This is the EDITORIAL author, not the administrative one.** `article_authors` is what
 * the public site renders in a byline and what becomes the `author` node of an article's
 * `BlogPosting` structured data. Which administrator wrote an article is a separate,
 * internal record (`created_by_admin` / `updated_by_admin`, `AdminAuthorStamp`). Merging the
 * two would publish staff identity on a marketing page — Phase 17 plan § 3.4, and the reason
 * the two live in different files with different shapes.
 */
export class ArticleAuthorService {
    constructor(
        private readonly authors: ArticleAuthorOwnedRepository = articleAuthorRepository,
        private readonly articles: ArticleOwnedRepository = articleRepository,
    ) {}

    /** Every byline, sorted by name, each with the number of articles crediting it. */
    async list(): Promise<Array<{ author: ArticleAuthorDocument; articleCount: number }>> {
        const authors = await this.authors.listAll();
        const counts = await this.articles.countsByAuthors(authors.map((author) => author.key));
        return authors.map((author) => ({ author, articleCount: counts.get(author.key) ?? 0 }));
    }

    async getByKey(key: string): Promise<{ author: ArticleAuthorDocument; articleCount: number }> {
        const author = await this.requireAuthor(key);
        const articleCount = await this.articles.countByAuthor(key);
        return { author, articleCount };
    }

    async create(input: CreateAuthorBody): Promise<{ author: ArticleAuthorDocument; articleCount: number }> {
        const existing = await this.authors.findByKey(input.id);
        if (existing) {
            throw createAppError(ERROR_CODES.BLOG_AUTHOR_KEY_TAKEN, 409, undefined, { id: input.id });
        }

        await this.authors.insert(
            newAuthorDocument({
                key: input.id,
                name: input.name,
                type: input.type,
                avatarUrl: input.avatarUrl ?? null,
                translations: toTranslationRecord(input.translations),
                now: new Date(),
            }),
        );

        return { author: await this.requireAuthor(input.id), articleCount: 0 };
    }

    async update(
        key: string,
        input: UpdateAuthorBody,
    ): Promise<{ author: ArticleAuthorDocument; articleCount: number }> {
        const author = await this.requireAuthor(key);

        const set: Partial<ArticleAuthorDocument> = {};
        if (input.name !== undefined) set.name = input.name;
        if (input.type !== undefined) set.type = input.type;
        if (input.avatarUrl !== undefined) set.avatar_url = input.avatarUrl ?? null;
        if (input.translations !== undefined) set.translations = toTranslationRecord(input.translations);

        const updated = (await this.authors.updateByKey(key, set)) ?? author;
        const articleCount = await this.articles.countByAuthor(key);
        return { author: updated, articleCount };
    }

    /**
     * Refused while any article credits this byline (`409 BLOG_AUTHOR_IN_USE`).
     *
     * It is what makes `author` non-null on every published article: jovi-mall's public DTO
     * resolves the byline by key, and a dangling reference would put an article carrying
     * `BlogPosting` structured data on the site with no author node at all. Re-point the
     * articles first.
     *
     * ⚠ The count is over LIVE articles only, drafts included. An archived article still
     * counts — its URL still answers `410` with its category, and a byline it credits is
     * still referenced by a document a reader can reach.
     */
    async remove(key: string): Promise<ArticleAuthorDocument> {
        const author = await this.requireAuthor(key);
        const count = await this.articles.countByAuthor(key);
        if (count > 0) {
            throw createAppError(ERROR_CODES.BLOG_AUTHOR_IN_USE, 409, undefined, { id: key, articleCount: count });
        }
        await this.authors.softDeleteByKey(key);
        // Returned for the audit row's `after` state — nothing else can read it now.
        return author;
    }

    private async requireAuthor(key: string): Promise<ArticleAuthorDocument> {
        const author = await this.authors.findByKey(key);
        if (!author) {
            throw createAppError(ERROR_CODES.BLOG_AUTHOR_NOT_FOUND, 404, undefined, { id: key });
        }
        return author;
    }
}

/**
 * The wire's `{ en: {…}, fr: {…} }` into the stored shape.
 *
 * A plain object, **never a JS `Map`** — jovi-mall declares this path as a Mongoose `Map`,
 * which BSON stores as an object, so a real `Map` handed to the raw driver serialises to
 * `{}` and silently erases every bio. The one place the conversion happens, so there is one
 * place to get it wrong.
 */
function toTranslationRecord(
    translations: Partial<Record<ContentLocale, { title: string; bio: string }>>,
): Partial<Record<ContentLocale, ArticleAuthorTranslationDoc>> {
    const record: Partial<Record<ContentLocale, ArticleAuthorTranslationDoc>> = {};
    for (const [locale, translation] of Object.entries(translations)) {
        if (translation) record[locale as ContentLocale] = { title: translation.title, bio: translation.bio };
    }
    return record;
}

export const articleAuthorService = new ArticleAuthorService();
