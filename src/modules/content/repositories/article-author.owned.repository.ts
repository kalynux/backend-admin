import { Filter } from 'mongodb';
import { COLLECTIONS } from '../../../infra/platform/collections';
import { PlatformOwnedRepository } from '../../../infra/platform/platform.repository';
import { ArticleAuthorDocument } from '../domain/article.document';

/**
 * `article_authors` — the editorial bylines.
 *
 * Owned alongside `articles` (ADR-004 D-4). Everything said in the sibling repository's
 * header applies here: the raw driver, no Mongoose defaults, `updatedAt` stamped by the
 * write methods below, and the unique index on `key` declared in jovi-mall's schema rather
 * than this repository's.
 *
 * ── Why authors are a separate collection at all ──────────────────────────────
 * So that fixing a typo in a bio does not mean rewriting every article that carries it, and
 * so the same byline is provably the same entity across articles — which is what makes the
 * `author` node in each article's `BlogPosting` structured data consistent. They are still
 * served **inline on every article** by jovi-mall's public reader; there is no public
 * `/authors` endpoint and no reason for one while there are two house bylines.
 *
 * ⚠ **`translations` is a plain object here and a Mongoose `Map` in jovi-mall.** BSON
 * stores a `Map` as a plain object, so the bytes are identical and the public reader's
 * `author.translations.get(locale)` keeps working. Constructing an actual JS `Map` and
 * handing it to the driver would NOT be identical — it serialises to `{}`. The one
 * conversion point is `toTranslationRecord` in the service.
 */

/**
 * Everything. There is no large field on an author — the bio is capped at 1000 characters
 * per locale — so unlike articles there is no list/detail split to make.
 */
const AUTHOR_PROJECTION = {
    _id: 1,
    key: 1,
    name: 1,
    type: 1,
    avatar_url: 1,
    translations: 1,
    createdAt: 1,
    updatedAt: 1,
} as const;

const LIVE: Filter<ArticleAuthorDocument> = { deletedAt: null };

export class ArticleAuthorOwnedRepository extends PlatformOwnedRepository<'article_authors', ArticleAuthorDocument> {
    constructor() {
        super(COLLECTIONS.ARTICLE_AUTHOR, AUTHOR_PROJECTION);
    }

    // ── Reads ────────────────────────────────────────────────────────────────

    async findByKey(key: string): Promise<ArticleAuthorDocument | null> {
        return this.findOneBy({ key, ...LIVE } as Filter<ArticleAuthorDocument>);
    }

    /**
     * Keyed by author key, so a page of articles resolves its bylines in ONE query.
     *
     * The batch path is the one that matters: an editor's inbox of twenty articles would
     * otherwise make twenty author reads for what is, in practice, two house bylines.
     */
    async findByKeys(keys: string[]): Promise<Map<string, ArticleAuthorDocument>> {
        const unique = [...new Set(keys)];
        if (unique.length === 0) return new Map();

        const docs = await this.findBy({ key: { $in: unique }, ...LIVE } as Filter<ArticleAuthorDocument>);
        return new Map(docs.map((doc) => [doc.key, doc]));
    }

    /** Sorted by name, whole — see `ListAuthorsQuerySchema` for why this is not paged. */
    async listAll(): Promise<ArticleAuthorDocument[]> {
        return this.findBy(LIVE as Filter<ArticleAuthorDocument>, { sort: { name: 1 } });
    }

    // ── Writes ───────────────────────────────────────────────────────────────

    /** Insert a fully-defaulted document — built by `newAuthorDocument`, never by hand. */
    async insert(document: ArticleAuthorDocument): Promise<string> {
        return this.insertOneDoc(document);
    }

    /** `$set` a field subset and re-read. `updatedAt` is stamped here, never by the caller. */
    async updateByKey(
        key: string,
        set: Partial<ArticleAuthorDocument>,
    ): Promise<ArticleAuthorDocument | null> {
        await this.updateOneBy(
            { key, ...LIVE } as Filter<ArticleAuthorDocument>,
            { $set: { ...set, updatedAt: new Date() } },
        );
        return this.findByKey(key);
    }

    /**
     * Soft delete, and only ever after the service has proved no article credits this
     * byline — a dangling `author_key` would put an article carrying `BlogPosting`
     * structured data on the public site with no author node at all.
     */
    async softDeleteByKey(key: string): Promise<void> {
        const now = new Date();
        await this.updateOneBy(
            { key, ...LIVE } as Filter<ArticleAuthorDocument>,
            { $set: { deletedAt: now, updatedAt: now } },
        );
    }
}

export const articleAuthorRepository = new ArticleAuthorOwnedRepository();
