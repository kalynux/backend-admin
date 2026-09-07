import { Document, ObjectId } from 'mongodb';
import {
    ArticleAuthorType,
    ArticleCategoryKey,
    ArticleStatus,
    ContentLocale,
} from './content.types';
import { ArticleBody } from '../validators/article-body.validator';

/**
 * The STORED shape of an article and an author, and the builders that construct one.
 *
 * ── Why this file carries a default table ─────────────────────────────────────
 * This service writes `articles` and `article_authors` through the **raw MongoDB driver**
 * (`PlatformOwnedRepository`), because jovi-mall exports no schemas and importing a
 * compiled Model registers it on this process's connection (ADR-004 D-3). The driver
 * applies **no Mongoose defaults, no validators and no `timestamps`** — so every default
 * jovi-mall's `ArticleSchema` used to apply for free has to be applied here, by hand.
 *
 * A missing default is not a crash. It is a document that looks right in the editor and
 * that jovi-mall's public DTO renders wrong: `translation.word_count` reading `undefined`
 * into `wordCount`, `previous_slugs` absent so a `[...spread]` throws, `createdAt` absent so
 * `publishedAt` falls back to `undefined.toISOString()`. Nothing in either repository would
 * see it before a reader did.
 *
 * So the defaults live in ONE place — `newArticleDocument` / `newAuthorDocument` below —
 * rather than at the two or three call sites that construct a document, and
 * `test:content` asserts the constructed object field-for-field against the table in the
 * Phase 5 plan (§ A.2). The mutation that must turn that suite red is deleting a line here.
 *
 * ── The mapping, against jovi-mall's `ArticleSchema` ──────────────────────────
 *
 * | Field                          | Default | jovi-mall source            |
 * |--------------------------------|---------|-----------------------------|
 * | `createdAt` / `updatedAt`      | now     | `timestamps: true`          |
 * | `deletedAt` / `purgeAt`        | `null`  | `core/base.schema.ts`       |
 * | `status`                       | `draft` | `article.model.ts`          |
 * | `featured`                     | `false` | "                           |
 * | `cover`                        | `null`  | "                           |
 * | `published_at`                 | `null`  | "                           |
 * | `content_updated_at`           | `null`  | "                           |
 * | `archived_at`                  | `null`  | "                           |
 * | `translations` / `slug_keys`   | `[]`    | "                           |
 * | `source_locale`                | first translation's locale | **none — see below** |
 * | translation `meta_title`       | `null`  | `ArticleTranslationSchema`  |
 * | translation `cover_alt`        | `null`  | " (per-locale, see below)   |
 * | translation `word_count`       | `0`     | " (derived, never accepted) |
 * | translation `published`        | `true`  | "                           |
 * | translation `previous_slugs`   | `[]`    | "                           |
 * | author `avatar_url`            | `null`  | `ArticleAuthorSchema`       |
 * | author `translations`          | `{}`    | " (a Mongoose `Map`)        |
 *
 * ⚠ **`translations` on an author is a Mongoose `Map`, which BSON stores as a plain
 * object.** Reading and writing it as `Record<locale, …>` through the driver is the same
 * bytes; constructing an actual `Map` and handing it to the driver is not, and would store
 * `{}`.
 *
 * ⚠ **`source_locale` is the one row above with no jovi-mall counterpart**, and the only
 * field on this document that exists on the writer's side alone. That direction of the
 * asymmetry is safe — see the field itself for why, and `platform-collections.ts` for why
 * the OTHER direction is not.
 */

// ─── Articles ────────────────────────────────────────────────────────────────

/**
 * A cover image. Optional — an article without one gets generated cover art on the site.
 *
 * ⚠ **The alt text is NOT here.** It lives on each translation as `cover_alt`, because it is
 * prose: one article is published in up to five languages off one image, and a single shared
 * `alt` puts English words on the French page's `og:image` and into a French screen reader.
 * Every other reader-facing string on this document is already per-locale; this one was the
 * exception, and it was an oversight rather than a decision.
 *
 * The image itself stays shared. `url`, `width` and `height` are properties of the file, not
 * of the prose, and duplicating them per locale would mean five uploads before an article
 * could publish.
 */
export interface ArticleCover {
    url: string;
    /** Required, both of them: they reserve the box so a loading image does not shift the page. */
    width: number;
    height: number;
}

export interface ArticleTranslationDoc {
    locale: ContentLocale;
    slug: string;
    title: string;
    meta_title: string | null;
    excerpt: string;
    body: ArticleBody;
    /**
     * Alt text for the article's shared cover image, in **this** language.
     *
     * `null` while unwritten, which is legal on a draft and refused at publish — see
     * `collectPublishBlockers`. Only a translation that is actually going live needs one, so
     * a drafted language does not block the languages beside it.
     *
     * Inline images inside `body` carry their own `alt` and always have: `body` is
     * per-translation, so those were never the problem this field fixes.
     */
    cover_alt: string | null;
    /** Words in `body`, derived on write — never accepted from the editor. */
    word_count: number;
    /** Whether this language is live. A drafted language 404s until this flips. */
    published: boolean;
    /** Slugs this translation used to have, oldest first. */
    previous_slugs: string[];
}

/**
 * Which administrator last touched an article — an **internal** record.
 *
 * ⚠ **This is not the byline** (Phase 17 plan § 3.4). `article_authors` is the editorial
 * author the public site renders; this is staff identity and must never reach a public DTO.
 * `read-models/public-article.dto.ts` does not read it, and `test:content` asserts that.
 *
 * Smaller than the ticket snapshot on purpose: that one is shown to a customer, so it
 * carries a job title and a department and is read from `admin_accounts`. This one is never
 * shown to anybody outside this service, so the request's own identity is the whole source
 * and no extra query is paid per write.
 */
export interface AdminAuthorStamp {
    id: string;
    source: 'admin';
    name: string;
    tier: 1 | 2 | 3;
}

export interface ArticleDocument extends Document {
    _id?: ObjectId;
    /** The article's stable public id — `getting-paid-on-whatsapp`, not an ObjectId. */
    key: string;
    category_key: ArticleCategoryKey;
    /** `ArticleAuthor.key`, not an ObjectId — authors are addressed by their stable id too. */
    author_key: string;

    status: ArticleStatus;
    featured: boolean;
    cover: ArticleCover | null;

    published_at: Date | null;
    content_updated_at: Date | null;
    archived_at: Date | null;

    translations: ArticleTranslationDoc[];

    /**
     * The language this article was written in FIRST — the editor's *component driver*.
     *
     * ⚠ **Stored rather than derived, and that is the entire point of the field.** The
     * editor seeds a new language's blocks from the article's original one, and the only
     * other way to know which language that is, is `translations[0]` — which is not a fact
     * about the article. `translations` is a **full-array replace** (`mergeTranslations`
     * returns `incoming.map(…)`, so the stored order is the order of whichever `PATCH` last
     * sent it), and nothing rejects a reordered array. A client that sorts the array for
     * display and sends it back has silently repointed the driver, and the failure is
     * quiet: the editor then seeds new languages from the wrong source and flags
     * correctly-translated blocks as untranslated. BR-019 § 1 is that question, asked.
     *
     * Set once, at create, from the first translation of the create body, and **never
     * mutated** — not by a `PATCH`, not by adding a language, not by removing one. A field
     * that moves is the thing it exists to replace.
     *
     * ⚠ **jovi-mall's `ArticleSchema` does not declare it, and must not need to.** Which
     * language came first is an *editor* concern; the public reader resolves one locale
     * from the URL and never asks. This direction of the asymmetry is safe only because
     * jovi-mall has no runtime writer for `articles` — a Mongoose write with `strict` on
     * would drop the field — and the dangerous direction is the other one, which
     * `platform-collections.ts` describes.
     *
     * `null` on any document written before the field existed. Deliberately not backfilled:
     * this is pre-production, and nothing seeds articles (jovi-mall's `seed:blog` writes the
     * byline only), so those documents are ones a person created through this editor. The
     * DTO answers for them — see `read-models/article.dto.ts`.
     */
    source_locale: ContentLocale | null;

    /**
     * `"<locale>:<slug>"` for every current **and** retired slug.
     *
     * The lookup key for jovi-mall's `GET /api/public/articles/{slug}` and the only place
     * slug uniqueness is enforced — by a unique multikey index that **lives in jovi-mall's
     * schema**, not here (Phase 5 plan O-3). Derived on every write by `buildSlugKeys`.
     */
    slug_keys: string[];

    /** Internal staff record. See `AdminAuthorStamp`. */
    created_by_admin: AdminAuthorStamp | null;
    updated_by_admin: AdminAuthorStamp | null;

    createdAt: Date;
    updatedAt: Date;
    deletedAt: Date | null;
    purgeAt: Date | null;
}

/**
 * A brand-new article document, with every default applied.
 *
 * `translations` and `slug_keys` are passed in already derived — `mergeTranslations` and
 * `buildSlugKeys` are the domain's job and this is only the defaults.
 */
export function newArticleDocument(input: {
    key: string;
    categoryKey: ArticleCategoryKey;
    authorKey: string;
    featured: boolean;
    cover: ArticleCover | null;
    translations: ArticleTranslationDoc[];
    slugKeys: string[];
    admin: AdminAuthorStamp;
    now: Date;
}): ArticleDocument {
    return {
        key: input.key,
        category_key: input.categoryKey,
        author_key: input.authorKey,

        // A create always lands as a draft — publishing is a separate, checklisted decision.
        status: 'draft',
        // Stored now, applied at publish: a draft cannot hold the featured slot because the
        // one-per-locale rule can only be evaluated against articles that are actually live.
        featured: input.featured,
        cover: input.cover,

        published_at: null,
        content_updated_at: null,
        archived_at: null,

        translations: input.translations,
        // Derived HERE rather than taken as a parameter, for the reason every default in
        // this function is here: the create body's first translation is the only definition
        // of "the language this was written in", and a caller that had to pass it could
        // pass something else. `?? null` covers nothing a validator allows —
        // `TranslationsSchema` requires at least one — but BSON omits an `undefined` path,
        // and a document missing this key is one the DTO cannot tell from a legacy one.
        source_locale: input.translations[0]?.locale ?? null,
        slug_keys: input.slugKeys,

        created_by_admin: input.admin,
        updated_by_admin: input.admin,

        createdAt: input.now,
        updatedAt: input.now,
        deletedAt: null,
        purgeAt: null,
    };
}

// ─── Authors ─────────────────────────────────────────────────────────────────

/** The translated half of a byline: job title and bio. The NAME is not translated. */
export interface ArticleAuthorTranslationDoc {
    title: string;
    bio: string;
}

export interface ArticleAuthorDocument extends Document {
    _id?: ObjectId;
    /** Stable public id — `wimall-editorial`. Articles reference this, not an ObjectId. */
    key: string;
    /** **Not translated.** A person's name is the same in five languages. */
    name: string;
    type: ArticleAuthorType;
    avatar_url: string | null;
    /**
     * Keyed by locale. Stored as a plain object because jovi-mall declares it as a Mongoose
     * `Map`, and BSON stores a `Map` as a plain object — see the ⚠ in this file's header.
     */
    translations: Partial<Record<ContentLocale, ArticleAuthorTranslationDoc>>;

    createdAt: Date;
    updatedAt: Date;
    deletedAt: Date | null;
    purgeAt: Date | null;
}

export function newAuthorDocument(input: {
    key: string;
    name: string;
    type: ArticleAuthorType;
    avatarUrl: string | null;
    translations: Partial<Record<ContentLocale, ArticleAuthorTranslationDoc>>;
    now: Date;
}): ArticleAuthorDocument {
    return {
        key: input.key,
        name: input.name,
        type: input.type,
        avatar_url: input.avatarUrl,
        translations: input.translations,

        createdAt: input.now,
        updatedAt: input.now,
        deletedAt: null,
        purgeAt: null,
    };
}
