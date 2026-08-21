/**
 * Content — the editorial surface this service took OWNERSHIP of, with no infrastructure.
 *
 * Phase 5 Part A ported jovi-mall's blog editor here and deleted it there (ADR-004 D-4,
 * Phase 5 D-1). That makes this the one ported family that does not delegate: it writes
 * `articles` and `article_authors` in the `jovi_mall` database **directly**, through
 * `PlatformOwnedRepository` on the raw MongoDB driver. No Mongo, no Redis, no jovi-mall
 * process is needed to run this file.
 *
 * Three sections carry the weight and the rest are guard rails:
 *
 *   §1  **the block union, against a fixture list duplicated in jovi-mall.** There is no
 *       shared package and both repositories now carry a copy of `ArticleBodySchema` —
 *       this one validates what is written, jovi-mall's types what is read. The list below
 *       is byte-for-byte the one in `jovi-mall/scripts/test/test-blog.ts` § 2b, so a change
 *       to either union turns both suites red. The house precedent is
 *       `test-rich-description.ts`, which pins the vendor dashboard's formatters the same
 *       way (Phase 5 C-15).
 *   §2  **the constructed document, field for field, against the default table.** The raw
 *       driver applies no Mongoose defaults, no validators and no `timestamps`, so every
 *       default jovi-mall's `ArticleSchema` used to give for free is applied by hand in
 *       `article.document.ts`. A missing one is not a crash — it is a document that looks
 *       right in the editor and that jovi-mall's public DTO renders wrong, and nothing in
 *       either repository would see it before a reader did. This is the assertion that
 *       catches that whole class.
 *   §7  **the DTO leak assertions.** `created_by_admin` is staff identity and
 *       `article_authors` is the byline the public site renders; they are two concepts and
 *       must not merge (Phase 17 plan § 3.4). `/preview` returns the *public* shape behind
 *       the admin guard, which is why previewing never becomes a reason to relax
 *       jovi-mall's public endpoints.
 *
 * Mutation-tested. Each of these four edits must turn this suite red:
 *   - drop `updatedAt` from `newArticleDocument`                        → §2
 *   - drop retired slugs from `buildSlugKeys`                           → §3
 *   - grant `content.articles.publish` to `SUPPORT` in `tier-grants.ts` → §8
 *   - let `remove()` through on an article with a `published_at`        → §5
 *
 *   npm run test:content
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { suite } from './_assert';

// Env must be set before importing anything that reads config at module load.
process.env.NODE_ENV = 'test';
process.env.MONGO_URI_PLATFORM = 'mongodb://localhost:27017/jovi_mall_test';
process.env.MONGO_URI_ADMIN = 'mongodb://localhost:27017/wi_admin_test';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.ADMIN_JWT_SECRET = 'test-access-secret-value-32-chars-long';
process.env.ADMIN_JWT_REFRESH_SECRET = 'test-refresh-secret-value-32-chars-long';
process.env.ADMIN_DASHBOARD_ORIGINS = 'http://localhost:5173';

import {
    ArticleBodySchema,
    HrefSchema,
    countWords,
    headingIds,
} from '../../src/modules/content/validators/article-body.validator';
import {
    ArticleKeySchema,
    ArticleSlugSchema,
    CreateArticleSchema,
    CreateAuthorSchema,
} from '../../src/modules/content/validators/article.validator';
import {
    ArticleTranslationDoc,
    AdminAuthorStamp,
    newArticleDocument,
    newAuthorDocument,
} from '../../src/modules/content/domain/article.document';
import { buildSlugKeys, slugKey } from '../../src/modules/content/domain/slug-keys';
import {
    collectPublishBlockers,
    contentChanged,
    isReservedSlug,
    mergeTranslations,
} from '../../src/modules/content/domain/article-content.rules';
import { RESERVED_ARTICLE_SLUGS } from '../../src/modules/content/domain/content.types';
import {
    availableLocalesOf,
    toPublicArticleDetailDto,
    toPublicArticleSummaryDto,
    toPublicAuthorDto,
} from '../../src/modules/content/read-models/public-article.dto';
import { toAdminArticleDto } from '../../src/modules/content/read-models/article.dto';
import { AUDIT_CATALOG } from '../../src/modules/audit/domain/audit.catalog';
import { subjectClassOf } from '../../src/modules/audit/domain/audit-subject';
import { TIER_GRANTS } from '../../src/modules/authorization/domain/tier-grants';
import { permissionSpec } from '../../src/modules/authorization/domain/permission.catalog';
import { routeManifest } from '../../src/api/route-manifest';

// Importing the routes file is what registers its declarations in the manifest.
import '../../src/modules/content/routes/content.routes';

const t = suite('content (Phase 5 Part A)');

const accepts = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) =>
    schema.safeParse(value).success;
const rejects = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) =>
    !schema.safeParse(value).success;

const paragraph = (text: string) => ({ type: 'paragraph' as const, text: [{ type: 'text' as const, text }] });
const heading = (id: string, text = 'A heading') => ({ type: 'heading' as const, level: 2 as const, id, text });

const ADMIN: AdminAuthorStamp = { id: 'a1', source: 'admin', name: 'Dev One', tier: 1 };
const NOW = new Date('2026-08-20T10:00:00.000Z');

// ─────────────────────────────────────────────────────────────────────────────
t.section('1. The block union — the CROSS-REPO fixture list (C-15)');
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⚠ **This array is duplicated in jovi-mall and the duplication is the point.**
 *
 * `jovi-mall/scripts/test/test-blog.ts` § 2b holds the identical list. Neither repository
 * imports the other — there is no shared package and there will not be one — so the two
 * unions are kept in step by both sides asserting the same inputs reach the same verdict.
 *
 * Editing a case here without editing jovi-mall's copy is the failure this guards, and it
 * is silent in production: this service would accept a block jovi-mall's reader cannot
 * type, or refuse one its public DTO already serves. Change both, in one commit.
 */
const SHARED_BLOCK_FIXTURES: ReadonlyArray<{ name: string; body: unknown; accepted: boolean }> = [
    { name: 'a minimal paragraph', body: [paragraph('Hello.')], accepted: true },
    { name: 'an empty body', body: [], accepted: false },
    { name: 'a raw-html block', body: [{ type: 'html', html: '<script>x</script>' }], accepted: false },
    {
        name: 'an unknown key on a known block',
        body: [{ type: 'paragraph', text: [{ type: 'text', text: 'Hi.' }], html: '<b>x</b>' }],
        accepted: false,
    },
    { name: 'a heading with no id', body: [{ type: 'heading', level: 2, text: 'No id' }], accepted: false },
    { name: 'a heading at level 4', body: [{ type: 'heading', level: 4, id: 'x', text: 'Deep' }], accepted: false },
    { name: 'two headings sharing an id', body: [heading('pricing'), heading('pricing')], accepted: false },
    { name: 'two headings with distinct ids', body: [heading('pricing'), heading('payouts')], accepted: true },
    {
        name: 'an image without dimensions',
        body: [{ type: 'image', url: 'https://cdn.example/a.jpg', alt: 'A' }],
        accepted: false,
    },
    {
        name: 'an image with dimensions',
        body: [{ type: 'image', url: 'https://cdn.example/a.jpg', alt: 'A', width: 1600, height: 900 }],
        accepted: true,
    },
    {
        name: 'a javascript: href',
        body: [{ type: 'paragraph', text: [{ type: 'link', text: 'x', href: 'javascript:alert(1)' }] }],
        accepted: false,
    },
    {
        name: 'a locale-prefixed internal href',
        body: [{ type: 'paragraph', text: [{ type: 'link', text: 'x', href: '/fr/pricing' }] }],
        accepted: false,
    },
    {
        name: 'an unprefixed internal href',
        body: [{ type: 'paragraph', text: [{ type: 'link', text: 'x', href: '/pricing' }] }],
        accepted: true,
    },
    { name: 'a divider alone', body: [{ type: 'divider' }], accepted: true },
    { name: 'an empty faq', body: [{ type: 'faq', items: [] }], accepted: false },
    {
        name: 'a faq with one pair',
        body: [{ type: 'faq', items: [{ question: 'Q?', answer: 'A.' }] }],
        accepted: true,
    },
    {
        name: 'a callout with an unknown tone',
        body: [{ type: 'callout', tone: 'danger', text: [{ type: 'text', text: 'x' }] }],
        accepted: false,
    },
];

for (const fixture of SHARED_BLOCK_FIXTURES) {
    t.assert(`${fixture.name} is ${fixture.accepted ? 'ACCEPTED' : 'REFUSED'}`, () =>
        ArticleBodySchema.safeParse(fixture.body).success === fixture.accepted);
}

t.assert('the shared fixture list has not silently shrunk (jovi-mall holds 17 too)', () =>
    SHARED_BLOCK_FIXTURES.length === 17);

// The protocol allowlist, directly — the security boundary the union rests on.
t.assert('data: URLs are refused', () => rejects(HrefSchema, 'data:text/html;base64,PHNjcmlwdD4='));
t.assert('protocol-relative //host is refused', () => rejects(HrefSchema, '//evil.example'));
t.assert('mailto: is accepted', () => accepts(HrefSchema, 'mailto:hello@example.com'));
t.assert('a fragment is accepted', () => accepts(HrefSchema, '#how-it-works'));

// ─────────────────────────────────────────────────────────────────────────────
t.section('2. The constructed document — every raw-driver default, field for field');
// ─────────────────────────────────────────────────────────────────────────────

const translations: ArticleTranslationDoc[] = mergeTranslations([], [
    {
        locale: 'en',
        slug: 'getting-paid',
        title: 'Getting paid',
        excerpt: 'How the money reaches you.',
        body: ArticleBodySchema.parse([paragraph('Commission is taken at payment, not at payout.')]),
        published: true,
    },
]);

const doc = newArticleDocument({
    key: 'getting-paid',
    categoryKey: 'payments',
    authorKey: 'wimall-editorial',
    featured: false,
    cover: null,
    translations,
    slugKeys: buildSlugKeys(translations),
    admin: ADMIN,
    now: NOW,
});

/**
 * The table from Phase 5 plan § A.2, asserted one row at a time.
 *
 * Deliberately NOT a single deep-equal: a deep-equal failure says "the object differs" and
 * a reader then has to diff it by eye. One assertion per field names the missing default in
 * the failure line, which is the whole reason this section exists.
 */
t.assert('status defaults to draft (a create is never a publish)', () => doc.status === 'draft');
t.assert('featured is carried, not defaulted away', () => doc.featured === false);
t.assert('cover defaults to null', () => doc.cover === null);
t.assert('published_at defaults to null', () => doc.published_at === null);
t.assert('content_updated_at defaults to null', () => doc.content_updated_at === null);
t.assert('archived_at defaults to null', () => doc.archived_at === null);
t.assert('deletedAt defaults to null', () => doc.deletedAt === null);
t.assert('purgeAt defaults to null', () => doc.purgeAt === null);
t.assert('createdAt is stamped (no `timestamps: true` on the raw driver)', () =>
    doc.createdAt instanceof Date && doc.createdAt.getTime() === NOW.getTime());
t.assert('updatedAt is stamped', () =>
    doc.updatedAt instanceof Date && doc.updatedAt.getTime() === NOW.getTime());
t.assert('slug_keys is present and derived', () =>
    Array.isArray(doc.slug_keys) && doc.slug_keys.includes('en:getting-paid'));
t.assert('translations is an array', () => Array.isArray(doc.translations));

t.assert('per-translation meta_title defaults to null', () => doc.translations[0].meta_title === null);
t.assert('per-translation word_count is DERIVED, never accepted', () => doc.translations[0].word_count > 0);
t.assert('per-translation previous_slugs defaults to []', () =>
    Array.isArray(doc.translations[0].previous_slugs) && doc.translations[0].previous_slugs.length === 0);
t.assert('per-translation published is carried', () => doc.translations[0].published === true);

t.assert('both admin stamps are written on create', () =>
    doc.created_by_admin?.id === 'a1' && doc.updated_by_admin?.id === 'a1');

// No field may be `undefined`: BSON omits an undefined path, so the document would be
// stored missing it and jovi-mall's reader would see exactly the absent-default failure
// this section exists to prevent.
t.assert('no top-level field is undefined (BSON would omit it)', () =>
    Object.values(doc).every((value) => value !== undefined));

const author = newAuthorDocument({
    key: 'wimall-editorial',
    name: 'The WiMall team',
    type: 'Organization',
    avatarUrl: null,
    translations: { en: { title: 'Editorial', bio: 'We write about selling on WhatsApp.' } },
    now: NOW,
});

t.assert('author avatar_url defaults to null', () => author.avatar_url === null);
t.assert('author deletedAt/purgeAt default to null', () =>
    author.deletedAt === null && author.purgeAt === null);
t.assert('author timestamps are stamped', () =>
    author.createdAt.getTime() === NOW.getTime() && author.updatedAt.getTime() === NOW.getTime());

/**
 * `translations` on an author is a Mongoose `Map` in jovi-mall, and BSON stores a `Map` as
 * a plain object. Constructing an actual `Map` here and handing it to the driver stores
 * `{}` — a byline with no title and no bio, in every language.
 */
t.assert('author translations is a PLAIN OBJECT, not a Map (BSON would store {})', () =>
    !(author.translations instanceof Map) && author.translations.en?.title === 'Editorial');

// ─────────────────────────────────────────────────────────────────────────────
t.section('3. The three derivations C-6 warns about');
// ─────────────────────────────────────────────────────────────────────────────

t.assert('slugKey is locale-prefixed', () => slugKey('fr', 'vendre') === 'fr:vendre');

const renamed = mergeTranslations(translations, [
    {
        locale: 'en',
        slug: 'how-to-get-paid',
        title: 'Getting paid',
        excerpt: 'How the money reaches you.',
        body: ArticleBodySchema.parse([paragraph('Commission is taken at payment, not at payout.')]),
        published: true,
    },
]);

t.assert('renaming a slug RETIRES the old one', () =>
    renamed[0].previous_slugs.length === 1 && renamed[0].previous_slugs[0] === 'getting-paid');

// The assertion the mutation test targets. Drop retired slugs from buildSlugKeys and every
// renamed URL stops resolving — silently, because the new one still works.
t.assert('buildSlugKeys keeps RETIRED slugs — this IS the redirect', () => {
    const keys = buildSlugKeys(renamed);
    return keys.includes('en:how-to-get-paid') && keys.includes('en:getting-paid');
});

t.assert('a slug renamed BACK is not left in both places', () => {
    const back = mergeTranslations(renamed, [
        {
            locale: 'en',
            slug: 'getting-paid',
            title: 'Getting paid',
            excerpt: 'How the money reaches you.',
            body: ArticleBodySchema.parse([paragraph('Commission is taken at payment, not at payout.')]),
            published: true,
        },
    ]);
    return !back[0].previous_slugs.includes('getting-paid')
        && back[0].previous_slugs.includes('how-to-get-paid');
});

t.assert('slug keys are per-locale — one slug in two languages is two keys', () => {
    const both = mergeTranslations([], [
        { locale: 'en', slug: 'shared', title: 'T', excerpt: 'E', body: ArticleBodySchema.parse([paragraph('x y')]), published: true },
        { locale: 'fr', slug: 'shared', title: 'T', excerpt: 'E', body: ArticleBodySchema.parse([paragraph('x y')]), published: true },
    ]);
    return buildSlugKeys(both).length === 2;
});

const richBody = ArticleBodySchema.parse([
    heading('how-it-works', 'How it works'),
    {
        type: 'paragraph',
        text: [
            { type: 'text', text: 'Commission is taken ' },
            { type: 'text', text: 'at payment', bold: true },
            { type: 'text', text: ', not at payout.' },
        ],
    },
    { type: 'image', url: '/a.jpg', alt: 'alt text is not prose', width: 4, height: 3 },
]);

// 3 (heading) + 8 (paragraph). The spans concatenate with no separator, so the bold run
// "at payment" joins its neighbours rather than counting as its own words — otherwise every
// bold phrase in an article would inflate the count.
t.assert('countWords counts prose across spans without splitting on formatting', () =>
    countWords(richBody) === 11);
t.assert('countWords ignores image alt text', () => {
    const longerAlt = ArticleBodySchema.parse(
        richBody.map((block) =>
            block.type === 'image' ? { ...block, alt: 'many more words than before in here' } : block),
    );
    return countWords(longerAlt) === countWords(richBody);
});
t.assert('headingIds recovers the table of contents in order', () =>
    JSON.stringify(headingIds(richBody)) === JSON.stringify(['how-it-works']));

// `contentChanged` — the third derivation. Stamping content_updated_at off a blanket
// "row was written" would tell a search engine an article was revised when somebody
// toggled `featured`.
const before = { translations, cover: null };
t.assert('an unchanged article is not a revision', () =>
    !contentChanged(before, { translations: [...translations], cover: null }));
t.assert('a title edit IS a revision', () => {
    const edited = translations.map((tr) => ({ ...tr, title: 'A different title' }));
    return contentChanged(before, { translations: edited, cover: null });
});
t.assert('toggling `published` is NOT a revision (visibility, not an edit)', () => {
    const toggled = translations.map((tr) => ({ ...tr, published: false }));
    return !contentChanged(before, { translations: toggled, cover: null });
});
t.assert('adding a language IS a revision (the hreflang set changed)', () => {
    const added = [...translations, { ...translations[0], locale: 'fr' as const, slug: 'se-faire-payer' }];
    return contentChanged(before, { translations: added, cover: null });
});
t.assert('a cover change IS a revision', () =>
    contentChanged(before, {
        translations: [...translations],
        cover: { url: '/c.jpg', alt: 'Cover', width: 1600, height: 900 },
    }));
t.assert('translation ORDER does not make a revision', () => {
    const two = [...translations, { ...translations[0], locale: 'fr' as const, slug: 'se-faire-payer' }];
    return !contentChanged({ translations: two, cover: null }, { translations: [...two].reverse(), cover: null });
});

// ─────────────────────────────────────────────────────────────────────────────
t.section('4. Slug and key rules');
// ─────────────────────────────────────────────────────────────────────────────

t.assert('an ASCII slug is accepted', () => accepts(ArticleSlugSchema, 'comment-vendre-sur-whatsapp'));
t.assert('a non-ASCII slug is accepted (ar/pt slugs are legitimate)', () =>
    accepts(ArticleSlugSchema, 'كيفية-البيع'));
t.assert('a slug with a space is refused', () => rejects(ArticleSlugSchema, 'comment vendre'));
t.assert('a slug with a slash is refused', () => rejects(ArticleSlugSchema, 'blog/post'));
t.assert('an uppercase slug is refused', () => rejects(ArticleSlugSchema, 'Getting-Paid'));

t.assert('an article KEY must be ASCII kebab (it is a log key, not a URL)', () =>
    accepts(ArticleKeySchema, 'getting-paid') && rejects(ArticleKeySchema, 'كيفية-البيع'));

/**
 * ⚠ **The paths key on a stable string, so the shared `objectId` validator is the wrong
 * one and swapping it in would refuse every real id on this surface.**
 *
 * Note what is NOT asserted here: that a 24-hex string is refused. It is **accepted**, and
 * correctly — `507f1f77bcf86cd799439011` is lowercase alphanumeric and therefore a
 * well-formed article key. The two validators are not opposites; `objectId` is the strictly
 * narrower one. So the assertion that actually catches the swap is the other direction: a
 * real, hyphenated key must pass, and `objectId` must not appear on this surface.
 */
t.assert('a real hyphenated key is accepted (objectId would refuse it)', () =>
    accepts(ArticleKeySchema, 'getting-paid-on-whatsapp'));
t.assert('a 24-hex string is also a well-formed key — the two are not opposites', () =>
    accepts(ArticleKeySchema, '507f1f77bcf86cd799439011'));
t.assert('no content param schema uses the shared objectId validator', () => {
    const raw = readFileSync(
        join(__dirname, '..', '..', 'src', 'modules', 'content', 'validators', 'article.validator.ts'),
        'utf8',
    );
    // The file's own header NAMES `objectId` to explain why it is NOT used here, so a naive
    // scan reads the explanation as the offence — the trap `test-authz.ts` documents at its
    // own route scan. Strip comments first, exactly as it does.
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    return !/\bobjectId\b/.test(src)
        && /ArticleKeyParamSchema[\s\S]{0,120}ArticleKeySchema/.test(src)
        && /AuthorKeyParamSchema[\s\S]{0,120}ArticleKeySchema/.test(src);
});

t.assert('"category" is reserved (collides with the hub route)', () => isReservedSlug('category'));
t.assert('"page" is reserved (collides with /blog/page/2)', () => isReservedSlug('page'));
t.assert('"index" is reserved (collides with GET /api/public/articles/index)', () =>
    isReservedSlug('index'));
t.assert('a normal slug is not reserved', () => !isReservedSlug('getting-paid'));
t.assert('the reserved list is exactly those three (jovi-mall asserts the same three)', () =>
    RESERVED_ARTICLE_SLUGS.length === 3);

t.assert('a create payload always lands as a draft — `status` is not settable', () =>
    rejects(CreateArticleSchema, {
        id: 'getting-paid',
        categoryKey: 'payments',
        authorId: 'wimall-editorial',
        status: 'published',
        translations: [{ locale: 'en', slug: 'x', title: 'T', excerpt: 'E', body: [paragraph('a b')] }],
    }));

t.assert('duplicate locales in one translations array are refused', () =>
    rejects(CreateArticleSchema, {
        id: 'getting-paid',
        categoryKey: 'payments',
        authorId: 'wimall-editorial',
        translations: [
            { locale: 'en', slug: 'a', title: 'T', excerpt: 'E', body: [paragraph('a b')] },
            { locale: 'en', slug: 'b', title: 'T', excerpt: 'E', body: [paragraph('a b')] },
        ],
    }));

t.assert('an author needs an English title and bio — it is every locale’s fallback', () =>
    rejects(CreateAuthorSchema, {
        id: 'x',
        name: 'X',
        type: 'Person',
        translations: { fr: { title: 'Rédaction', bio: 'Bio.' } },
    }));

/**
 * `excludeKey` is what lets an article re-save the slug it already holds. Without it every
 * PATCH that does not change the slug collides with the article making it.
 */
const REPO_SRC = readFileSync(
    join(__dirname, '..', '..', 'src', 'modules', 'content', 'repositories', 'article.owned.repository.ts'),
    'utf8',
);
t.assert('slugTakenByAnother excludes the article being edited', () =>
    /key:\s*\{\s*\$ne:\s*excludeKey\s*\}/.test(REPO_SRC));
t.assert('findFeaturedSharingLocales uses $elemMatch, not two dotted predicates', () =>
    /translations:\s*\{\s*\$elemMatch:/.test(REPO_SRC));
t.assert('every repository read filters deletedAt', () => REPO_SRC.includes('deletedAt: null'));

// ─────────────────────────────────────────────────────────────────────────────
t.section('5. The lifecycle — what is legal, and the one refusal that matters');
// ─────────────────────────────────────────────────────────────────────────────

t.assert('an article with no translations cannot be published', () =>
    collectPublishBlockers({ translations: [], authorExists: true }).length === 1);
t.assert('an article whose byline does not exist cannot be published', () =>
    collectPublishBlockers({ translations, authorExists: false }).length === 1);
t.assert('an article with every language drafted cannot be published', () =>
    collectPublishBlockers({
        translations: translations.map((tr) => ({ ...tr, published: false })),
        authorExists: true,
    }).length === 1);
t.assert('blockers are a CHECKLIST, not a first failure', () =>
    collectPublishBlockers({ translations: [], authorExists: false }).length === 2);
t.assert('a complete article has no blockers', () =>
    collectPublishBlockers({ translations, authorExists: true }).length === 0);

/**
 * The delete refusal, by source scan.
 *
 * It is a **soft** delete and it is refused once the article has **ever** been published —
 * `published_at`, not `status`, because an already-unpublished article was still live once
 * and its address may have inbound links. The remedy is `archive` (410 + the category hub).
 *
 * Scanned rather than exercised because `remove()` needs a repository; the mutation this
 * has to catch is deleting the guard, and the guard's shape is what makes it visible.
 */
const SERVICE_SRC = readFileSync(
    join(__dirname, '..', '..', 'src', 'modules', 'content', 'services', 'article.service.ts'),
    'utf8',
);
t.assert('remove() refuses once published_at is set', () =>
    /published_at\s*!==\s*null/.test(SERVICE_SRC)
    && SERVICE_SRC.includes('BLOG_ARTICLE_DELETE_NOT_ALLOWED'));
t.assert('remove() is a SOFT delete', () => SERVICE_SRC.includes('softDeleteByKey'));
t.assert('the delete guard tests published_at, NOT status', () =>
    !/status\s*===\s*'published'[\s\S]{0,200}BLOG_ARTICLE_DELETE_NOT_ALLOWED/.test(SERVICE_SRC));

t.assert('publishing an already-published article is a conflict', () =>
    SERVICE_SRC.includes('BLOG_ARTICLE_ALREADY_PUBLISHED'));
t.assert('unpublish clears featured (a draft cannot hold the index slot)', () =>
    /status:\s*'draft'[\s\S]{0,300}featured:\s*false/.test(SERVICE_SRC));
t.assert('archive stamps archived_at and clears featured', () =>
    /status:\s*'archived'[\s\S]{0,200}archived_at:\s*new Date\(\)[\s\S]{0,200}featured:\s*false/.test(SERVICE_SRC));
t.assert('publish does not RE-stamp published_at on a republish', () =>
    SERVICE_SRC.includes('input.publishedAt ?? article.published_at ?? new Date()'));
t.assert('the featured rule DEMOTES rather than 409s', () =>
    SERVICE_SRC.includes('applyFeatured') && !SERVICE_SRC.includes('BLOG_FEATURED_TAKEN'));
t.assert('the author delete is refused while an article credits the byline', () =>
    readFileSync(
        join(__dirname, '..', '..', 'src', 'modules', 'content', 'services', 'article-author.service.ts'),
        'utf8',
    ).includes('BLOG_AUTHOR_IN_USE'));

// ─────────────────────────────────────────────────────────────────────────────
t.section('6. Routes, permissions and the nine audited actions');
// ─────────────────────────────────────────────────────────────────────────────

const contentRoutes = routeManifest().filter((r) => r.fullPath.startsWith('/api/v1/content'));

t.assert('fourteen content routes are declared — one per legacy row', () =>
    contentRoutes.length === 14);

const EXPECTED_ROUTES: ReadonlyArray<[string, string, string]> = [
    ['get', '/api/v1/content/articles', 'content.articles.read'],
    ['post', '/api/v1/content/articles', 'content.articles.write'],
    ['get', '/api/v1/content/articles/:articleKey', 'content.articles.read'],
    ['get', '/api/v1/content/articles/:articleKey/preview', 'content.articles.read'],
    ['patch', '/api/v1/content/articles/:articleKey', 'content.articles.write'],
    ['post', '/api/v1/content/articles/:articleKey/publish', 'content.articles.publish'],
    ['post', '/api/v1/content/articles/:articleKey/unpublish', 'content.articles.publish'],
    ['post', '/api/v1/content/articles/:articleKey/archive', 'content.articles.publish'],
    ['delete', '/api/v1/content/articles/:articleKey', 'content.articles.delete'],
    ['get', '/api/v1/content/authors', 'content.authors.read'],
    ['post', '/api/v1/content/authors', 'content.authors.write'],
    ['get', '/api/v1/content/authors/:authorKey', 'content.authors.read'],
    ['patch', '/api/v1/content/authors/:authorKey', 'content.authors.write'],
    ['delete', '/api/v1/content/authors/:authorKey', 'content.authors.delete'],
];

for (const [method, path, expected] of EXPECTED_ROUTES) {
    t.assert(`${method.toUpperCase()} ${path} → ${expected}`, () => {
        const route = contentRoutes.find((r) => r.method === method && r.fullPath === path);
        if (route?.access.kind !== 'permission') return false;
        const granted = route.access.permissions as readonly string[];
        return granted.length === 1 && granted[0] === expected;
    });
}

t.assert('every content route is mounted under ONE prefix (D-12)', () =>
    contentRoutes.every((r) => r.fullPath.startsWith('/api/v1/content/')));

t.assert('the paths key on the stable string key, never an ObjectId param', () =>
    contentRoutes.every((r) => !r.fullPath.includes(':id') && !r.fullPath.includes(':articleId')));

const CONTENT_ACTIONS = [
    'content.articles.create',
    'content.articles.update',
    'content.articles.publish',
    'content.articles.unpublish',
    'content.articles.archive',
    'content.articles.delete',
    'content.authors.create',
    'content.authors.update',
    'content.authors.delete',
] as const;

t.assert('exactly nine content actions are catalogued', () =>
    Object.keys(AUDIT_CATALOG).filter((a) => a.startsWith('content.')).length === 9);

for (const action of CONTENT_ACTIONS) {
    t.assert(`${action} is catalogued and external`, () => {
        const entry = AUDIT_CATALOG[action];
        return entry !== undefined && entry.transport === 'external' && entry.target === 'article';
    });
}

/**
 * `transport: 'external'` rather than `wi_admin_txn`, and this is C-12.
 *
 * The instinct on reading "this service owns the collection" is that the audit row and the
 * change can now commit together. They cannot: `connections.ts` opens TWO MongoClients and
 * a `ClientSession` belongs to one, so even a direct write to `jovi_mall` is outside a
 * `wi-admin` session. Ownership bought the absence of an HTTP hop and nothing else.
 *
 * The cast is deliberate and worth reading. Without it `tsc` rejects the comparison as
 * impossible — the nine entries are literal-typed `'external'`, so **the type system
 * already proves this today**. The runtime check is here for the edit that would change
 * that: somebody writing `wi_admin_txn` into one of those entries makes the compile-time
 * proof go away silently, and this is what is left standing.
 */
t.assert('no content action claims a wi-admin transaction (C-12)', () =>
    CONTENT_ACTIONS.every((action) => (AUDIT_CATALOG[action].transport as string) !== 'wi_admin_txn'));

t.assert('`article` is classified platform_record — Support may read its audit', () =>
    subjectClassOf('article') === 'platform_record');

t.assert('the nine audited routes are exactly the nine mutations', () => {
    const audited = contentRoutes.filter((r) => r.audit !== null && r.audit.kind === 'records');
    return audited.length === 9 && audited.every((r) => r.method !== 'get');
});

t.assert('every content READ is unaudited', () =>
    contentRoutes.filter((r) => r.method === 'get').every((r) => r.audit === null || r.audit.kind !== 'records'));

// ─────────────────────────────────────────────────────────────────────────────
t.section('7. The DTOs — and the two things that must never leak');
// ─────────────────────────────────────────────────────────────────────────────

const publishedDoc = {
    ...doc,
    status: 'published' as const,
    published_at: new Date('2026-07-08T08:00:00.000Z'),
    translations: mergeTranslations([], [
        {
            locale: 'en',
            slug: 'getting-paid',
            title: 'Getting paid',
            excerpt: 'How the money reaches you.',
            body: ArticleBodySchema.parse([paragraph('Commission is taken at payment.')]),
            published: true,
        },
        {
            locale: 'fr',
            slug: 'se-faire-payer',
            title: 'Se faire payer',
            excerpt: 'Comment.',
            body: ArticleBodySchema.parse([paragraph('La commission est prise au paiement.')]),
            published: false,
        },
    ]),
};

t.assert('availableLocales lists only PUBLISHED languages', () =>
    JSON.stringify(availableLocalesOf(publishedDoc)) === JSON.stringify(['en']));

const summary = toPublicArticleSummaryDto(publishedDoc, publishedDoc.translations[0], author);
const detail = toPublicArticleDetailDto(publishedDoc, publishedDoc.translations[0], author);

t.assert('the public summary carries no body', () => !('body' in summary));
t.assert('the public detail carries the body', () => Array.isArray(detail.body));
t.assert('publishedAt is ISO 8601 UTC', () => summary.publishedAt === '2026-07-08T08:00:00.000Z');

/**
 * ⚠ **The leak assertion this section exists for.**
 *
 * `created_by_admin` / `updated_by_admin` are staff identity — an administrator's id, name
 * and TIER. `article_authors` is the editorial byline the public site renders. They are two
 * concepts (Phase 17 plan § 3.4), and the public DTO is served straight through to
 * jovi-mall's marketing site by `/preview`, so a stamp reaching it publishes the name and
 * privilege level of whoever edited the page.
 *
 * Serialised and searched rather than key-checked, because the stamp could arrive nested.
 */
const serialisedPublic = JSON.stringify({ summary, detail });
t.assert('no public DTO carries created_by_admin', () => !serialisedPublic.includes('created_by_admin'));
t.assert('no public DTO carries updated_by_admin', () => !serialisedPublic.includes('updated_by_admin'));
t.assert('no public DTO carries an administrator name', () => !serialisedPublic.includes('Dev One'));
t.assert('no public DTO carries an administrator tier', () => !/"tier"/.test(serialisedPublic));

t.assert('the public author DTO resolves the requested locale', () =>
    toPublicAuthorDto(author, 'en').title === 'Editorial');
t.assert('a missing author locale falls back to English (a blank byline is worse)', () =>
    toPublicAuthorDto(author, 'pt').title === 'Editorial');

/**
 * `/preview` returns the PUBLIC shape behind the admin guard.
 *
 * That is why previewing never becomes a reason to relax jovi-mall's public endpoints — a
 * flag that made `/api/public/articles` serve drafts is the thing this design avoids.
 */
const PREVIEW_SRC = readFileSync(
    join(__dirname, '..', '..', 'src', 'modules', 'content', 'controllers', 'content.controller.ts'),
    'utf8',
);
t.assert('the preview handler builds a PUBLIC dto, not the admin one', () =>
    /preview[\s\S]{0,900}toPublicArticleDetailDto/.test(PREVIEW_SRC));

// The admin DTO is allowed to carry the stamp — that is what it is for.
const adminDto = toAdminArticleDto(publishedDoc, author);
t.assert('the ADMIN dto does carry the administrator stamp', () =>
    JSON.stringify(adminDto).includes('Dev One'));

// ─────────────────────────────────────────────────────────────────────────────
t.section('8. Tier grants — A.6 and O-1');
// ─────────────────────────────────────────────────────────────────────────────

const support = new Set<string>(TIER_GRANTS[3]);

t.assert('Support holds content.articles.read', () => support.has('content.articles.read'));
t.assert('Support holds content.articles.write', () => support.has('content.articles.write'));
t.assert('Support holds content.authors.read', () => support.has('content.authors.read'));
t.assert('Support holds content.authors.write', () => support.has('content.authors.write'));

// The mutation target: granting publish to SUPPORT must turn this red.
t.assert('Support does NOT hold content.articles.publish (D-2)', () =>
    !support.has('content.articles.publish'));
t.assert('Support does NOT hold content.articles.delete', () => !support.has('content.articles.delete'));
t.assert('Support does NOT hold content.authors.delete', () => !support.has('content.authors.delete'));

t.assert('tier 3 holds exactly four content permissions', () =>
    TIER_GRANTS[3].filter((n) => n.startsWith('content.')).length === 4);

/**
 * ⚠ **The flag is NOT what withholds publish, and this is Phase 5 P-1.**
 *
 * The plan credits the two `destructive: true` deletes for making the grant a by-name one.
 * `allInFamily()` already excludes those — that is what the flag does. What it does not
 * exclude is `content.articles.publish`, which carries no flag at all, so the family form
 * would have handed Support the one permission D-2 exists to withhold.
 *
 * This asserts the premise directly: if somebody ever flags publish as sensitive, this goes
 * red and the comment in `tier-grants.ts` needs rewriting — it would then be true.
 */
t.assert('content.articles.publish carries NO sensitive flag (so allInFamily WOULD sweep it)', () => {
    const spec = permissionSpec('content.articles.publish');
    return !spec.destructive && !spec.financial && !spec.escalation && !spec.dualControl;
});
t.assert('both content deletes ARE destructive (allInFamily excludes them on its own)', () =>
    permissionSpec('content.articles.delete').destructive === true
    && permissionSpec('content.authors.delete').destructive === true);

/** O-1: Support may edit a PUBLISHED article — `write` is not narrowed to drafts. */
t.assert('content.articles.write is not narrowed to drafts (O-1)', () => {
    const src = readFileSync(
        join(__dirname, '..', '..', 'src', 'modules', 'content', 'services', 'article.service.ts'),
        'utf8',
    );
    // The update path must not refuse on status. If one is ever added, O-1 was reversed and
    // this assertion is the place that says so.
    return !/async update\([\s\S]{0,600}status\s*===\s*'published'[\s\S]{0,100}throw/.test(src);
});

process.exit(t.finish());
