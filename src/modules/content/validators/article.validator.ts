import { z } from 'zod';
import { listQuery } from '../../../core/http/list-query';
import {
    ARTICLE_AUTHOR_TYPES,
    ARTICLE_CATEGORY_KEYS,
    ARTICLE_STATUSES,
    CONTENT_LOCALES,
} from '../domain/content.types';
import { ArticleBodySchema } from './article-body.validator';

/**
 * Request shapes for `/api/v1/content`.
 *
 * Reserved-slug and cross-article uniqueness checks are **not** here — they need the
 * database, so they live in `ArticleService`. Everything expressible without a query is
 * here, so a malformed body never reaches a service.
 *
 * ── What changed in the port, and what deliberately did not ───────────────────
 * The list query is rebuilt on this service's shared `listQuery` vocabulary (`page`,
 * `limit`, `sort` with an allowlist), because `test:contract` pins that shape and a second
 * pagination dialect on one service is how `meta.pages` came to mean two things before.
 * Everything else — the key and slug regexes, the cover shape, the full-array replace on
 * `translations`, `publishedAt` for imports — is carried across **unchanged**, because
 * every one of them is a rule about data jovi-mall's public reader will serve.
 */

const LocaleSchema = z.enum(CONTENT_LOCALES);

/**
 * A stable public id: `getting-paid-on-whatsapp`.
 *
 * ASCII-only, unlike a slug — it is never in a URL a reader sees, it is the key the
 * frontend hashes to generate an article's cover art, and keeping it ASCII means it reads
 * the same in a log line, a CSV export and a support conversation.
 *
 * ⚠ **This, not `objectId`, is what the routes key on.** Articles and authors are addressed
 * by their stable string key everywhere — in the path, in `author_key`, in `slug_keys`. The
 * shared 24-hex `objectId` validator would refuse every real id on this surface.
 */
export const ArticleKeySchema = z
    .string()
    .trim()
    .min(3)
    .max(200)
    .regex(
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
        'An id is lowercase letters, digits and single hyphens (e.g. "getting-paid-on-whatsapp")',
    );

/**
 * A localized slug.
 *
 * Deliberately wider than the id: Arabic and Portuguese slugs are legitimate, and forcing
 * ASCII would push `ar` articles onto transliterated paths that are worse for the reader
 * and worse for the keyword. Lowercase letters (any script), digits, single hyphens —
 * which still refuses spaces, slashes, uppercase and punctuation, i.e. everything that
 * makes a slug unsafe in a path.
 */
export const ArticleSlugSchema = z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(
        /^[\p{Ll}\p{Lo}\p{Nd}]+(?:-[\p{Ll}\p{Lo}\p{Nd}]+)*$/u,
        'A slug is lowercase letters, digits and single hyphens — no spaces, slashes or capitals',
    );

const CoverSchema = z
    .object({
        url: z
            .string()
            .trim()
            .min(1)
            .max(2048)
            .refine(
                (url) => /^https?:\/\//i.test(url) || (url.startsWith('/') && !url.startsWith('//')),
                'A cover url must be an http(s):// URL or an internal path starting with "/"',
            ),
        alt: z.string().trim().min(1).max(300),
        // Required for the same reason an inline image's are: they reserve the box. A cover
        // is also the `og:image`, so 16:9 at >= 1200px wide is the recommendation
        // (1200x630 is the social-card floor) — a recommendation, not a rule.
        width: z.number().int().positive(),
        height: z.number().int().positive(),
    })
    .strict();

/**
 * One language of an article.
 *
 * `published` defaults to true: adding a translation normally means shipping it. Set it
 * false to draft a language on a live article — that locale then 404s, which is the correct
 * behaviour for a missing translation and the reason there is no fallback anywhere else.
 */
export const ArticleTranslationSchema = z
    .object({
        locale: LocaleSchema,
        slug: ArticleSlugSchema,
        title: z.string().trim().min(1).max(200),
        metaTitle: z.string().trim().min(1).max(200).optional(),
        excerpt: z.string().trim().min(1).max(400),
        body: ArticleBodySchema,
        published: z.boolean().optional().default(true),
    })
    .strict();

/** The translations array, with the one rule that spans its elements: one row per language. */
const TranslationsSchema = z
    .array(ArticleTranslationSchema)
    .min(1, 'An article needs at least one translation')
    .max(CONTENT_LOCALES.length)
    .superRefine((translations, ctx) => {
        const seen = new Map<string, number>();
        translations.forEach((translation, index) => {
            const first = seen.get(translation.locale);
            if (first !== undefined) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: [index, 'locale'],
                    message: `Duplicate translation for "${translation.locale}" (already given at index ${first})`,
                });
                return;
            }
            seen.set(translation.locale, index);
        });
    });

/**
 * Create an article. Always lands as a **draft** — `status` is not settable here, because
 * "created" and "published" are different decisions and the second one has a checklist
 * (`POST /:articleKey/publish`) that a create body could quietly skip.
 */
export const CreateArticleSchema = z
    .object({
        id: ArticleKeySchema,
        categoryKey: z.enum(ARTICLE_CATEGORY_KEYS),
        authorId: ArticleKeySchema,
        featured: z.boolean().optional().default(false),
        cover: CoverSchema.nullable().optional(),
        translations: TranslationsSchema,
    })
    .strict();

export type CreateArticleBody = z.infer<typeof CreateArticleSchema>;

/**
 * Update an article. `id` is absent on purpose — it is stable across edits by contract, and
 * the frontend derives an article's generated cover art from it.
 *
 * `translations`, when given, is a **full-array replace**, not a merge: a partial merge has
 * no way to express "remove the Spanish translation", and a per-locale endpoint would leave
 * the array's one cross-element rule (unique locales) unenforceable. Omit the key to leave
 * every translation untouched.
 */
export const UpdateArticleSchema = z
    .object({
        categoryKey: z.enum(ARTICLE_CATEGORY_KEYS).optional(),
        authorId: ArticleKeySchema.optional(),
        featured: z.boolean().optional(),
        cover: CoverSchema.nullable().optional(),
        translations: TranslationsSchema.optional(),
    })
    .strict()
    .refine((body) => Object.keys(body).length > 0, 'Nothing to update');

export type UpdateArticleBody = z.infer<typeof UpdateArticleSchema>;

/**
 * `POST /:articleKey/publish`.
 *
 * `publishedAt` exists for one case: importing an article that was published elsewhere and
 * needs to keep its date. Left out, first publish stamps now — and a *re*-publish never
 * re-stamps, because `published_at` is the sort key the index, the sitemap and the
 * prev/next links share.
 */
export const PublishArticleSchema = z
    .object({
        publishedAt: z.coerce.date().optional(),
    })
    .strict();

export type PublishArticleBody = z.infer<typeof PublishArticleSchema>;

/** Unpublish and archive take no body; declared so `.strict()` refuses a stray field. */
export const NoBodySchema = z.object({}).strict();

export const ArticleKeyParamSchema = z.object({ articleKey: ArticleKeySchema }).strict();
export const AuthorKeyParamSchema = z.object({ authorKey: ArticleKeySchema }).strict();

/**
 * What the editor's list may be ordered by: **wire name → stored field path**.
 *
 * `updatedAt` is the default rather than `publishedAt`, and that is the editor's question
 * rather than the reader's: a draft has no `published_at` at all, and a draft inbox sorted
 * by a field most of its rows do not have is in an order nobody can predict. jovi-mall's
 * public list sorts the other way for the same reason in reverse.
 *
 * `slug` is deliberately absent — it lives inside the `translations` array, so sorting by it
 * would order by whichever locale Mongo reached first.
 */
export const ARTICLE_SORT = {
    updatedAt: 'updatedAt',
    createdAt: 'createdAt',
    publishedAt: 'published_at',
    status: 'status',
} as const;

/** The editor's list. Every status by default — a draft inbox is the point of it. */
export const SearchArticlesQuerySchema = listQuery(ARTICLE_SORT, '-updatedAt', {
    status: z.enum(ARTICLE_STATUSES).optional(),
    category: z.enum(ARTICLE_CATEGORY_KEYS).optional(),
    locale: LocaleSchema.optional(),
    author: ArticleKeySchema.optional(),
});

export type SearchArticlesQuery = z.infer<typeof SearchArticlesQuerySchema>;

/** `GET /:articleKey/preview?locale=…` — the public shape, at any status. */
export const PreviewQuerySchema = z.object({ locale: LocaleSchema }).strict();

export type PreviewQuery = z.infer<typeof PreviewQuerySchema>;

// ─── Authors ─────────────────────────────────────────────────────────────────

const AuthorTranslationsSchema = z.record(
    z.enum(CONTENT_LOCALES),
    z
        .object({
            title: z.string().trim().min(1).max(120),
            bio: z.string().trim().min(1).max(1000),
        })
        .strict(),
);

export const CreateAuthorSchema = z
    .object({
        id: ArticleKeySchema,
        name: z.string().trim().min(1).max(200),
        type: z.enum(ARTICLE_AUTHOR_TYPES),
        avatarUrl: z.string().trim().url().max(2048).nullable().optional(),
        // English is required, and it is the only one: it is the fallback every other locale
        // resolves to, so an author without it can produce a blank byline in four languages.
        translations: AuthorTranslationsSchema.refine(
            (translations) => Boolean(translations.en),
            'An author needs at least an English title and bio — it is the fallback for every other language',
        ),
    })
    .strict();

export type CreateAuthorBody = z.infer<typeof CreateAuthorSchema>;

export const UpdateAuthorSchema = z
    .object({
        name: z.string().trim().min(1).max(200).optional(),
        type: z.enum(ARTICLE_AUTHOR_TYPES).optional(),
        avatarUrl: z.string().trim().url().max(2048).nullable().optional(),
        /** Full replace, same reasoning as an article's translations. */
        translations: AuthorTranslationsSchema.refine(
            (translations) => Boolean(translations.en),
            'An author needs at least an English title and bio — it is the fallback for every other language',
        ).optional(),
    })
    .strict()
    .refine((body) => Object.keys(body).length > 0, 'Nothing to update');

export type UpdateAuthorBody = z.infer<typeof UpdateAuthorSchema>;

/**
 * The author list is **not paginated**, and that is a deliberate exception to this
 * service's list contract.
 *
 * There are two house bylines. A pager over a set that will plausibly never exceed twenty
 * rows costs a `countDocuments` per call and buys a control the editor never touches — and
 * the list carries a per-author `articleCount`, which is a query each. Sorted by name, whole.
 */
export const ListAuthorsQuerySchema = z.object({}).strict();
