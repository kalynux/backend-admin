/**
 * Editorial vocabulary — the pieces the editor, the stored document and jovi-mall's public
 * reader all agree on.
 *
 * ── Why this list is duplicated rather than imported ──────────────────────────
 * Ownership of `articles` and `article_authors` moved here (ADR-004 D-4, executed at Phase
 * 5 Part A): this service is the only writer, jovi-mall keeps the Mongoose schema and the
 * indexes for its public reader, and **there is no shared package between the two
 * repositories and there will not be one**. So the vocabulary exists twice, on purpose, and
 * the drift is caught the way `test:rich-description` catches the vendor dashboard's:
 * `test:content` here and `test:blog` there assert the SAME fixture list, byte for byte.
 * Neither repository imports the other; both go red when they disagree.
 *
 * The block union and every validation rule live in `validators/article-body.validator.ts`;
 * the TypeScript shapes are *inferred from those schemas* rather than declared twice, so a
 * rule and its type cannot drift. This file holds only what is not a Zod schema.
 */

/**
 * The platform's five languages. **The same list jovi-mall's `SUPPORTED_LANGUAGES` holds**,
 * not a second one — an article locale is a platform locale.
 *
 * Ordered, and the order is load-bearing: `availableLocalesOf` filters this array, so the
 * `hreflang` set a page emits is stable across requests rather than following whatever
 * order the translations happen to be stored in.
 */
export const CONTENT_LOCALES = ['en', 'fr', 'pt', 'es', 'ar'] as const;
export type ContentLocale = (typeof CONTENT_LOCALES)[number];

/** The fallback locale for an author bio — and the ONLY fallback anywhere in this module. */
export const DEFAULT_CONTENT_LOCALE: ContentLocale = 'en';

/**
 * The five categories, with stable keys.
 *
 * **This service knows only the key.** Labels are translated in the frontend message
 * catalog and the URL slug is the frontend's too — five words per language belong with the
 * rest of the site chrome, and routing them through the API would mean a deploy to fix a
 * typo.
 *
 * Adding a sixth key is a frontend change as well, so it is a two-repo change — and worth
 * resisting: a category with one article in it is an empty hub that dilutes the internal
 * linking it exists to concentrate.
 */
export const ARTICLE_CATEGORY_KEYS = ['selling', 'payments', 'delivery', 'growth', 'guides'] as const;
export type ArticleCategoryKey = (typeof ARTICLE_CATEGORY_KEYS)[number];

/**
 * Author identity type. **Not cosmetic** — it becomes the `@type` of the `author` node in
 * the article's `BlogPosting` structured data. A house byline like "The WiMall team" is an
 * `Organization`; marking it `Person` asserts to a search engine that a human by that name
 * exists, which is the class of claim that earns a manual action rather than a warning.
 */
export const ARTICLE_AUTHOR_TYPES = ['Person', 'Organization'] as const;
export type ArticleAuthorType = (typeof ARTICLE_AUTHOR_TYPES)[number];

/** Draft and archived articles are invisible to every public endpoint. */
export const ARTICLE_STATUSES = ['draft', 'published', 'archived'] as const;
export type ArticleStatus = (typeof ARTICLE_STATUSES)[number];

/**
 * Slugs that would collide with a route rather than resolve to an article.
 *
 * - `category` — collides with the frontend's `/blog/category/…` hub.
 * - `page`     — collides with the path-based pagination `/blog/page/2`; reserving it now
 *                costs nothing and reserving it later means retiring a published URL.
 * - `index`    — collides with jovi-mall's own `GET /api/public/articles/index`, which is
 *                matched before `/:slug` and would shadow such an article entirely.
 *
 * Rejected at the editor (`400 BLOG_SLUG_RESERVED`) rather than at read time, because by
 * read time the URL is already published.
 */
export const RESERVED_ARTICLE_SLUGS: readonly string[] = ['category', 'page', 'index'];
