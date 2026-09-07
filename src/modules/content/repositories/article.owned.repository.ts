import { Filter } from 'mongodb';
import { toMongoSort } from '../../../core/data/mongo-list';
import { COLLECTIONS } from '../../../infra/platform/collections';
import { Paginated, PlatformOwnedRepository } from '../../../infra/platform/platform.repository';
import { ArticleDocument } from '../domain/article.document';
import { slugKey } from '../domain/slug-keys';
import { ARTICLE_SORT, SearchArticlesQuery } from '../validators/article.validator';

/**
 * `articles` — the one collection family this service **owns outright**.
 *
 * ── Why this is an owned repository and not a gateway ─────────────────────────
 * ADR-004 D-4, executed at Phase 5 Part A: `ArticleService` and `ArticleAuthorService` had
 * no non-admin caller in jovi-mall — its public site reads through a separate
 * `public-article.service` — so ownership moved here rather than the writes being delegated
 * the way tickets, agencies and money are. `PlatformOwnedRepository`'s type parameter
 * accepts only collections marked `access: 'owned'` in `platform-collections.ts`, so this
 * class could not be pointed at `users` even by accident. **This is that base class's first
 * consumer**; it has existed unused since Phase 4.
 *
 * ── Three things ownership does NOT buy, worth knowing before editing ─────────
 *
 * **1. It is not transactional, and the audit row knows it.** `connections.ts` opens two
 * MongoClients, so a write to `jovi_mall` is outside any `wi-admin` session
 * (`audit.types.ts` says so at the `external` transport). Every content audit action is
 * `transport: 'external'` and goes through `auditedAttempt` — intent first, outcome after —
 * exactly as a delegated family does.
 *
 * **2. The schema and the indexes live in jovi-mall.** It keeps `article.model.ts` for its
 * public reader, including the unique multikey index on `slug_keys`. So this service owns
 * the writes to a collection whose constraints another repository declares (Phase 5 plan
 * O-3). Slug uniqueness is enforced by an index this repository does not define, and
 * `verify:content` is what proves that still holds rather than assuming it.
 *
 * **3. The raw driver applies no defaults and no `timestamps`.** Every insert goes through
 * `newArticleDocument`, and every update through the two methods below that stamp
 * `updatedAt` themselves. A caller cannot forget, because there is no update path here that
 * does not stamp it.
 *
 * ── Query shapes carried across verbatim ──────────────────────────────────────
 * `slugTakenByAnother`'s `excludeKey` (what lets an article re-save the slug it already
 * holds), `findFeaturedSharingLocales`' `$elemMatch` (matching locale AND published on the
 * SAME translation, not two independent dotted predicates), and the `_id` tie-break on every
 * published sort. Each was read out of jovi-mall's `article.repository.ts` rather than
 * rewritten.
 */

/**
 * The list whitelist — **every field except `translations.body`.**
 *
 * A deliberate deviation from the legacy shape, and the reason is the house rule
 * `TICKET_LIST_PROJECTION` already follows: a body is up to 400 blocks, and a page of
 * twenty articles in five languages is a payload no editor's inbox renders. The detail read
 * adds it back.
 *
 * Inclusion projections cannot be mixed with exclusions, so the translation fields are
 * named one by one rather than written as `{ translations: 1, 'translations.body': 0 }`,
 * which Mongo refuses outright.
 *
 * A whitelist rather than an exclusion list, for the reason every projection in this
 * service is one: an exclusion protects only what somebody thought of.
 *
 * ⚠ **The cost of that whitelist is that a NEW translation field is invisible here until
 * it is added below, and the symptom is a plausible value rather than an error.** It has
 * happened once already: `cover_alt` landed on `ArticleTranslationDoc` and on the summary
 * DTO without landing here, so every row of the editor's inbox reported
 * `coverAlt: null` — indistinguishable from "nobody has written it", on the one field
 * whose whole purpose is to warn the inbox that a publish will be refused. Adding a field
 * to `ArticleTranslationDoc` means adding it here in the same change.
 */
const ARTICLE_LIST_PROJECTION = {
    _id: 1,
    key: 1,
    category_key: 1,
    author_key: 1,
    status: 1,
    featured: 1,
    cover: 1,
    published_at: 1,
    content_updated_at: 1,
    archived_at: 1,
    source_locale: 1,
    slug_keys: 1,
    created_by_admin: 1,
    updated_by_admin: 1,
    createdAt: 1,
    updatedAt: 1,
    'translations.locale': 1,
    'translations.slug': 1,
    'translations.title': 1,
    'translations.meta_title': 1,
    'translations.excerpt': 1,
    'translations.cover_alt': 1,
    'translations.word_count': 1,
    'translations.published': 1,
    'translations.previous_slugs': 1,
} as const;

/** The detail whitelist — the same fields, with whole translations including the body. */
const ARTICLE_DETAIL_PROJECTION = {
    _id: 1,
    key: 1,
    category_key: 1,
    author_key: 1,
    status: 1,
    featured: 1,
    cover: 1,
    published_at: 1,
    content_updated_at: 1,
    archived_at: 1,
    source_locale: 1,
    slug_keys: 1,
    created_by_admin: 1,
    updated_by_admin: 1,
    createdAt: 1,
    updatedAt: 1,
    translations: 1,
} as const;

/** Live rows only. `deletedAt: null` matches a missing path as well as an explicit null. */
const LIVE: Filter<ArticleDocument> = { deletedAt: null };

export class ArticleOwnedRepository extends PlatformOwnedRepository<'articles', ArticleDocument> {
    constructor() {
        super(COLLECTIONS.ARTICLE, ARTICLE_LIST_PROJECTION);
    }

    // ── Reads ────────────────────────────────────────────────────────────────

    /** By stable public id, whatever its status — the editor's read. Full body. */
    async findByKey(key: string): Promise<ArticleDocument | null> {
        const found = await this.collection().findOne(
            { key, ...LIVE } as Filter<ArticleDocument>,
            { projection: ARTICLE_DETAIL_PROJECTION },
        );
        return (found as ArticleDocument | null) ?? null;
    }

    /**
     * Does any **other** article answer to this `(locale, slug)`?
     *
     * `excludeKey` is the article being edited — re-saving it with the slug it already has
     * must not collide with itself. Matches retired slugs too, because `slug_keys` holds
     * both: a reused slug turns a permanent redirect into a wrong answer.
     */
    async slugTakenByAnother(locale: string, slug: string, excludeKey: string): Promise<boolean> {
        const count = await this.countBy({
            slug_keys: slugKey(locale, slug),
            key: { $ne: excludeKey },
            ...LIVE,
        } as Filter<ArticleDocument>);
        return count > 0;
    }

    /** The editor's list. Every status by default — a draft inbox is the point of it. */
    async search(query: SearchArticlesQuery): Promise<Paginated<ArticleDocument>> {
        const filter: Filter<ArticleDocument> = { ...LIVE };

        if (query.status) filter.status = query.status;
        if (query.category) filter.category_key = query.category;
        if (query.author) filter.author_key = query.author;
        // A dotted path into the array is right here and `$elemMatch` would be wrong: the
        // question is "does this article have a translation in that language at all",
        // regardless of whether that translation is live. The editor is looking for work.
        if (query.locale) filter['translations.locale'] = query.locale;

        return this.findPage(filter, {
            page: query.page,
            limit: query.limit,
            sort: toMongoSort(query.sort, ARTICLE_SORT),
        });
    }

    /**
     * Published articles that are `featured` and share a **live** locale with the given list.
     *
     * `$elemMatch` rather than two dotted predicates: `translations.locale` and
     * `translations.published` matched independently would return an article whose English
     * translation is live and whose French one is drafted when the caller asked about French.
     */
    async findFeaturedSharingLocales(locales: string[], excludeKey: string): Promise<ArticleDocument[]> {
        if (locales.length === 0) return [];
        return this.findBy({
            featured: true,
            status: 'published',
            key: { $ne: excludeKey },
            ...LIVE,
            translations: { $elemMatch: { locale: { $in: locales }, published: true } },
        } as Filter<ArticleDocument>);
    }

    /** Guards the author delete: a byline credited on an article cannot be removed. */
    async countByAuthor(authorKey: string): Promise<number> {
        return this.countBy({ author_key: authorKey, ...LIVE } as Filter<ArticleDocument>);
    }

    /** Article counts for a set of author keys, in one pass rather than one query each. */
    async countsByAuthors(authorKeys: string[]): Promise<Map<string, number>> {
        if (authorKeys.length === 0) return new Map();

        const rows = await this.aggregateBy<{ _id: string; count: number }>([
            { $match: { author_key: { $in: authorKeys }, deletedAt: null } },
            { $group: { _id: '$author_key', count: { $sum: 1 } } },
        ]);

        const counts = new Map<string, number>();
        for (const key of authorKeys) counts.set(key, 0);
        for (const row of rows) counts.set(row._id, row.count);
        return counts;
    }

    // ── Writes ───────────────────────────────────────────────────────────────

    /**
     * Insert a fully-defaulted document.
     *
     * Takes the whole document rather than a partial, on purpose: `newArticleDocument` is
     * the only place the defaults live, and accepting a partial here would let a caller
     * construct one without it.
     */
    async insert(document: ArticleDocument): Promise<string> {
        return this.insertOneDoc(document);
    }

    /**
     * `$set` a field subset and re-read.
     *
     * **`updatedAt` is stamped here, not by the caller.** Mongoose's `timestamps: true` did
     * this for jovi-mall; the raw driver does not, and a caller who forgets produces a row
     * whose `lastSavedAt` is a lie. There is no update path on this repository that skips it.
     */
    async updateByKey(key: string, set: Partial<ArticleDocument>): Promise<ArticleDocument | null> {
        await this.updateOneBy(
            { key, ...LIVE } as Filter<ArticleDocument>,
            { $set: { ...set, updatedAt: new Date() } },
        );
        return this.findByKey(key);
    }

    /**
     * Promote or demote the featured flag, without disturbing anything else.
     *
     * Its own method rather than `updateByKey` because the one-featured-per-locale rule
     * demotes OTHER articles, and doing that through the general update would re-read a
     * document nobody is going to look at, once per competitor.
     */
    async setFeatured(key: string, featured: boolean): Promise<void> {
        await this.updateOneBy(
            { key, ...LIVE } as Filter<ArticleDocument>,
            { $set: { featured, updatedAt: new Date() } },
        );
    }

    /**
     * Soft delete — a `deletedAt` stamp, matching what jovi-mall's editor did.
     *
     * ⚠ The permission is named `content.articles.delete` and flagged `destructive`, and the
     * catalogued summary used to say "permanently delete". It does not, and it never did:
     * the row stays, and the service refuses the call outright once the article has ever
     * been published. `destructive: true` stays for a different reason — it keeps the name
     * out of `allInFamily()`, which is what withholds it from Support.
     */
    async softDeleteByKey(key: string): Promise<void> {
        const now = new Date();
        await this.updateOneBy(
            { key, ...LIVE } as Filter<ArticleDocument>,
            { $set: { deletedAt: now, updatedAt: now } },
        );
    }
}

export const articleRepository = new ArticleOwnedRepository();
