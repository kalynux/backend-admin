# `/content` — articles and bylines

Base path: `/api/v1/content`

The blog editor for the marketing site: article drafts, translations, the publish lifecycle,
and the editorial bylines articles are credited to. **Fourteen routes**, and this is the
**only** editorial door onto them — jovi-mall's `/api/admin/articles` and
`/api/admin/article-authors` mounts were deleted when this one was built.

Design records: [`PHASE-5-LEGACY-CLOSEOUT-PLAN.md`](../../../PRODUCTION-READINESS/PHASE-5-LEGACY-CLOSEOUT-PLAN.md)
(Part A — the port), [`../../docs/ADR-004-DOMAIN-OWNERSHIP.md`](../../docs/ADR-004-DOMAIN-OWNERSHIP.md) D-4
(why this family MOVED rather than delegating),
[`../../docs/ADR-005-API-CONTRACT.md`](../../docs/ADR-005-API-CONTRACT.md).

| Method | Path | Permission | Transport | Audited |
|---|---|---|---|---|
| `GET` | `/articles` | `content.articles.read` | **owned** | — |
| `POST` | `/articles` | `content.articles.write` | **owned** | ✅ |
| `GET` | `/articles/:articleId` | `content.articles.read` | **owned** | — |
| `GET` | `/articles/:articleId/preview` | `content.articles.read` | **owned** | — |
| `PATCH` | `/articles/:articleId` | `content.articles.write` | **owned** | ✅ |
| `POST` | `/articles/:articleId/publish` | `content.articles.publish` | **owned** | ✅ |
| `POST` | `/articles/:articleId/unpublish` | `content.articles.publish` | **owned** | ✅ |
| `POST` | `/articles/:articleId/archive` | `content.articles.publish` | **owned** | ✅ |
| `DELETE` | `/articles/:articleId` | `content.articles.delete` | **owned** | ✅ |
| `GET` | `/authors` | `content.authors.read` | **owned** | — |
| `POST` | `/authors` | `content.authors.write` | **owned** | ✅ |
| `GET` | `/authors/:authorId` | `content.authors.read` | **owned** | — |
| `PATCH` | `/authors/:authorId` | `content.authors.write` | **owned** | ✅ |
| `DELETE` | `/authors/:authorId` | `content.authors.delete` | **owned** | ✅ |

**`owned` is not `direct read` and not `delegated`** — it is the third transport, and this is
the only family that uses it. See [§ 1](#1-owned-is-a-third-transport-and-it-buys-less-than-it-looks).

Two `:id` namespaces under one mount, mirroring the two routers jovi-mall used to have
without paying for a second mount.

---

## Who may do what

| Permission | Developer | Admin | Support |
|---|---|---|---|
| `content.articles.read` | ● | ● | ● |
| `content.articles.write` | ● | ● | ● |
| `content.articles.publish` | ● | ● | · |
| `content.articles.delete` | ● | ● | · |
| `content.authors.read` | ● | ● | ● |
| `content.authors.write` | ● | ● | ● |
| `content.authors.delete` | ● | ● | · |

**Support may write prose and may not decide what the public sees.** Editing an article or a
byline is copy work; publishing is an editorial decision and deleting removes a record.

Two details worth stating because they are easy to get backwards:

- **Support may edit a PUBLISHED article.** `content.articles.write` is deliberately not
  narrowed to drafts. A "write" that stops at a state boundary is a rule nobody can infer
  from the permission's name, and the boundary defends nothing that is not already defended:
  pulling a live article down requires `publish`, which Support does not hold. What is left
  is a Support administrator fixing a typo in live prose, which is the reason to grant it.
- **The four Support grants are typed out by name, not expanded from the family.** The
  instinct is that `allInFamily('content')` would be safe because it refuses to expand
  anything flagged sensitive, and both `delete` names are `destructive`. It does refuse those
  two — and it does **not** refuse `content.articles.publish`, which carries no flag at all.
  The family form would hand Support the one permission this split exists to withhold.

---

## The shapes

Read from `read-models/article.dto.ts` and `validators/article.validator.ts`. Everything on the
wire is camelCase; the stored collection is jovi-mall's and stays snake_case, so the two never
match and the DTO is the only translation (ADR-005).

### `AdminArticleDto` — one article

```json
{
  "id": "getting-paid-on-whatsapp",
  "status": "published",
  "categoryKey": "payments",
  "authorId": "wimall-editorial",
  "author": { "id": "wimall-editorial", "name": "The WiMall team", "type": "Organization" },
  "featured": false,
  "cover": { "url": "/covers/getting-paid.jpg", "width": 1600, "height": 900 },
  "publishedAt": "2026-07-08T08:00:00.000Z",
  "updatedAt": "2026-07-30T09:20:00.000Z",
  "archivedAt": null,
  "availableLocales": ["en", "fr"],
  "sourceLocale": "en",
  "createdBy": { "id": "6511…", "name": "Ada Mensah", "tier": 2 },
  "updatedBy": { "id": "6511…", "name": "Ada Mensah", "tier": 2 },
  "createdAt": "2026-07-01T11:04:22.000Z",
  "lastSavedAt": "2026-08-02T15:41:09.000Z",
  "translations": [
    {
      "locale": "en",
      "slug": "getting-paid-on-whatsapp",
      "title": "Getting paid on WhatsApp",
      "metaTitle": "Getting paid — MoMo, OM and cash",
      "excerpt": "How the money reaches you.",
      "coverAlt": "A market stall taking a mobile payment",
      "wordCount": 812,
      "published": true,
      "previousSlugs": ["getting-paid"],
      "body": [{ "type": "paragraph", "text": [{ "type": "text", "text": "Commission is taken…" }] }]
    }
  ]
}
```

| Field | Type | Notes |
|---|---|---|
| `id` | string | The stable public id. **Same value as the `:articleId` path parameter** — see [§ 2](#2-the-identifier-is-a-stable-string-called-id-not-an-objectid) |
| `status` | `draft` · `published` · `archived` | |
| `categoryKey` | `selling` · `payments` · `delivery` · `growth` · `guides` | **The key only.** Labels and the URL slug are the frontend's message catalog — see [§ Categories](#categories-are-keys-and-the-labels-are-yours) |
| `authorId` | string | The byline's id — an `article_authors` key, **not** an ObjectId and **not** an administrator |
| `author` | object · `null` | Resolved inline so a list needs no second call. `null` if the byline was removed |
| `featured` | boolean | At most one per locale — see [§ At most one featured article per locale](#at-most-one-featured-article-per-locale) |
| `cover` | object · `null` | `{ url, width, height }`. ⚠ **No `alt` here** — it is per-locale, as `translations[].coverAlt` |
| `publishedAt` | ISO 8601 · `null` | Stamped once and kept across an unpublish/republish cycle |
| `updatedAt` | ISO 8601 · `null` | ⚠ **Content revisions only.** `null` until a published article's prose changes. A `featured` toggle does not move it — see [§ `content_updated_at` is not `updatedAt`](#content_updated_at-is-not-updatedat) |
| `archivedAt` | ISO 8601 · `null` | |
| `availableLocales` | array | Exactly the **published** locales, in the platform's canonical order. A drafted language is absent, because its URL 404s |
| `sourceLocale` | `en` · `fr` · `pt` · `es` · `ar` · `null` | ⚠ **The language the article was written in first** — set at create from the first translation of the create body and **never mutated** afterwards. Use it, not `translations[0]`, wherever you need the original language. Always names a locale that is present in `translations`. See [§ `translations[]`](#translations) |
| `createdBy` / `updatedBy` | object · `null` | The **administrator** who touched it — `{ id, name, tier }`. Internal to this service; never in a public DTO. **Not the byline** — see [§ 4](#4-two-kinds-of-author-and-they-must-not-merge) |
| `createdAt` | ISO 8601 | |
| `lastSavedAt` | ISO 8601 | ⚠ **When the row was last written, for any reason.** Deliberately named apart from `updatedAt`: conflating "somebody saved this" with "the prose changed" is what would put a wrong `dateModified` in the structured data |
| `translations` | array | One per language. ⚠ **Its ORDER is not a contract** — see [§ `translations[]`](#translations) before deriving anything from a position in it |

**`GET /articles` returns `AdminArticleSummaryDto`, which is this shape with every translation
**minus its `body`**.** The detail route adds it back. Twenty articles in five languages, each
body up to 400 blocks, is a payload no inbox renders — so do not build a list screen expecting
`body`, and do not fetch the list to populate an editor.

### `translations[]`

| Field | Type | Notes |
|---|---|---|
| `locale` | `en` · `fr` · `pt` · `es` · `ar` | |
| `slug` | string | **Localized and unique within its locale.** Not the English slug under a language prefix |
| `title` | string | |
| `metaTitle` | string · `null` | `<title>` override. `null`, not absent, on this admin DTO |
| `excerpt` | string | |
| `coverAlt` | string · `null` | Alt text for the article's **shared** cover, in this language. `null` until written; refused at publish if this language is going live and the article has a cover |
| `wordCount` | number | ⚠ **Per translation, not per article** — derived on write from `body`, never accepted from the editor |
| `published` | boolean | Whether **this language** is live. `false` on a published article means that locale 404s |
| `previousSlugs` | array | Retired slugs, oldest first. Each still answers `BLOG_ARTICLE_MOVED` on the public route, which is why the editor is shown them |
| `body` | array of blocks | **Detail route only.** See [§ Bodies are typed blocks](#bodies-are-typed-blocks-never-html) |

#### The order of this array is **not** a contract — use `sourceLocale`

**`translations` comes back in the order the last write sent it, and this service never
reorders it.** That is a description of what happens, not a promise about what you will get:
a `PATCH` carrying `translations` is a full-array replace, and the stored order becomes the
order of *that array*. Send `[fr, en]` on a Tuesday and `translations[0]` is `fr` from then
on — with no error, no warning and nothing on either side that reports it.

So `translations[0]` is **not** "the language the article was created in". It is "the first
element of whichever array was PATCHed most recently", and a client that sorts the array for
display before sending it back has changed it without meaning to.

⚠ **Derive an original language from [`sourceLocale`](#adminarticledto--one-article), never
from a position.** It is stamped at create from the first translation of the create body and
is never written again — so it survives a reordered `PATCH`, and it would survive a `$sort`
or a canonical ordering if either were ever added here. It always names a locale that is
present in `translations`, so it can be used with `find()` and no fallback.

Two things it is **not**, so nobody has to guess:

- **Not `availableLocales`.** That one *is* canonically ordered (`en · fr · pt · es · ar`,
  filtered), and it lists only **published** languages. It answers "which URLs exist",
  which is a different question from "which language came first".
- **Not backfilled.** An article created before this field existed stores nothing, and the
  DTO answers `translations[0].locale` for it — the value the field *would* hold, since
  nothing seeds articles and every such row was written by this editor in the order its
  create body listed. This codebase writes no data migrations, so the fallback is the fix.

### `AdminArticleAuthorDto` — one byline

```json
{
  "id": "wimall-editorial",
  "name": "The WiMall team",
  "type": "Organization",
  "avatarUrl": null,
  "translations": {
    "en": { "title": "Editorial", "bio": "We write about selling on WhatsApp." },
    "fr": { "title": "Rédaction", "bio": "Nous écrivons sur la vente via WhatsApp." }
  },
  "articleCount": 14
}
```

| Field | Type | Notes |
|---|---|---|
| `id` | string | Same value as the `:authorId` path parameter |
| `name` | string | Not localized — a name is a name in every language |
| `type` | `Person` · `Organization` | ⚠ **Not cosmetic.** It becomes the `@type` of the `author` node in the article's `BlogPosting` structured data. Marking a house byline `Person` asserts to a search engine that a human by that name exists |
| `avatarUrl` | string · `null` | |
| `translations` | object, keyed by locale | ⚠ **There is no scalar `bio` and no scalar `title`.** Both are per-locale, and `en` is always present |
| `articleCount` | number | How many live articles credit this byline. Zero is what makes a delete possible, so the editor can see the answer before pressing a button that would be refused |

### The write bodies

**`POST /articles`**

| Field | Type | Rules |
|---|---|---|
| `id` | string | **Required.** Lowercase ASCII letters, digits, single hyphens. 3–200 |
| `categoryKey` | enum | **Required** |
| `authorId` | string | **Required.** Same format as `id` |
| `featured` | boolean | Optional, defaults `false` |
| `cover` | object · `null` | Optional. `{ url, width, height }` — **`alt` is refused here**, it belongs on the translation |
| `translations` | array | **Required, at least one.** See below |

**`status` is not settable.** A create always lands as a **draft**: "created" and "published"
are different decisions, and the second one has a checklist a create body could quietly skip.

**`PATCH /articles/:articleId`** takes the same fields **except `id`**, all optional, and
refuses an empty body. `id` is absent on purpose — it is stable by contract, and the frontend
derives an article's generated cover art from it.

**`translations[]` on a write**

| Field | Type | Rules |
|---|---|---|
| `locale` | enum | **Required.** Duplicates within one array are a `400` |
| `slug` | string | **Required.** Lowercase letters (**any script** — Arabic and Portuguese slugs are legitimate), digits, single hyphens. 1–200 |
| `title` | string | **Required.** 1–200 |
| `metaTitle` | string | Optional, 1–200 |
| `excerpt` | string | **Required.** 1–400 |
| `body` | array of blocks | **Required.** `.strict()` throughout |
| `coverAlt` | string | Optional, 1–300. Required at **publish** when the article has a cover and this language is live |
| `published` | boolean | Optional, **defaults `true`** — adding a translation normally means shipping it |

⚠ **`translations` is a FULL-ARRAY REPLACE, never a merge.** Send every language you want to
keep. Omit the key entirely to leave all of them untouched. A partial merge has no way to
express "remove the Spanish translation", and a per-locale endpoint would leave the array's one
cross-element rule (unique locales) unenforceable.

**`POST /articles`, `POST /authors` and both `PATCH`es are `.strict()`** — an unknown field is a
`400` on the whole request, not a silently stripped key.

**`POST /authors`**

| Field | Type | Rules |
|---|---|---|
| `id` | string | **Required.** Same format as an article id |
| `name` | string | **Required.** 1–200 |
| `type` | `Person` · `Organization` | **Required.** No default — see the note on structured data above |
| `avatarUrl` | string · `null` | Optional, must be a URL |
| `translations` | object keyed by locale | **Required, and `en` is required within it.** `{ title (1–120), bio (1–1000) }` per locale |

English is required because it is the fallback every other locale resolves to — an author
without it can produce a blank byline in four languages.

**`PATCH /authors/:authorId`** takes the same fields except `id`, all optional, refuses an empty
body, and `translations` is a **full replace** on the same reasoning as an article's.

### The lifecycle bodies, and the deletes

`POST /:articleId/publish` takes an optional `publishedAt` (ISO 8601) — for importing an article
published elsewhere that needs to keep its date. `unpublish` and `archive` take **no body**, and
`.strict()` refuses a stray field.

**Both deletes return `{ "id": "…", "deleted": true }`**, not an empty body.

### Reads: what the list endpoints accept

**`GET /articles`** — `page`, `limit`, `sort`, plus four filters:

| Parameter | Values |
|---|---|
| `status` | `draft` · `published` · `archived` |
| `category` | ⚠ **`category`, not `categoryKey`** |
| `author` | ⚠ **`author`, not `authorId`** — the byline's id |
| `locale` | `en` · `fr` · `pt` · `es` · `ar` |

**There is no `search`.** No free-text search over articles exists on this surface.

⚠ **The query schema is not `.strict()`, so an unrecognised parameter is silently dropped** —
which means a misspelt filter returns the *unfiltered* list and nothing on either side reports
it. A `400` is a bad afternoon; a stripped filter is a screen that looks correct and lies.
This is the service-wide `listQuery` behaviour, not a `/content` quirk.

`sort` accepts `updatedAt` (the default, `-updatedAt`), `createdAt`, `publishedAt` and `status`.

- **`updatedAt` is the default rather than `publishedAt`**, and that is the editor's question
  rather than the reader's: a draft has no `publishedAt` at all, and a draft inbox sorted by a
  field most of its rows lack is in an order nobody can predict.
- **`slug` is deliberately absent.** It lives inside the `translations` array, so sorting by it
  would order by whichever locale Mongo reached first. It is not a missing feature.

**`GET /authors`** — ⚠ **unpaginated, and it takes NO parameters at all.** Its schema is
`z.object({}).strict()`, so sending `page` or `limit` is a `400`. This is a deliberate exception
to this service's list contract: there are two house bylines, a set that will plausibly never
exceed twenty rows, and a pager over it would cost a `countDocuments` per call plus the
per-author `articleCount` query, to buy a control the editor never touches. Sorted by name,
whole.

---

## Four things that are not obvious from the route list

### 1. `owned` is a third transport, and it buys less than it looks

Every other ported family reaches jovi-mall over HTTP. This one does not: it writes the
`articles` and `article_authors` collections in the `jovi_mall` database **directly**, through
`PlatformOwnedRepository` on the raw MongoDB driver. jovi-mall's editor is deleted, not
dual-mounted.

What that changes, and what it does not:

- **It does not buy an atomic audit.** `infra/mongo/connections.ts` opens **two**
  `MongoClient`s — one for `wi-admin`, one for `jovi_mall` — and a `ClientSession` belongs to
  a client, so even a direct write to `jovi_mall` is outside a `wi-admin` transaction. All
  nine audited actions are `transport: 'external'` and go through `auditedAttempt` exactly as
  a delegated family does: the intent row commits first, the write runs, the outcome is
  stamped after. A crash between the two leaves a resolvable `attempted` row.
- **It does not move the schema.** jovi-mall keeps `ArticleSchema`, `ArticleAuthorSchema` and
  **their indexes**, because its public reader needs the schema and `autoIndex` is off in
  production, so the indexes come from its migration ledger. This service owns the *writes* to
  a collection another repository *declares*.
- **What it does buy is the absence of an HTTP hop.** That is the whole of it.

⚠ **The consequence to hold on to: the raw driver applies no Mongoose defaults, no validators
and no `timestamps`.** Every default jovi-mall's schema used to apply for free is applied by
hand in `domain/article.document.ts`, in one place, and `test:content` § 2 asserts the
constructed document field for field. A missing default is not a crash — it is a document that
looks right in the editor and that jovi-mall's public DTO renders wrong, and nothing in either
repository would see it before a reader did.

### 2. The identifier is a stable string called `id`, not an ObjectId

`:articleId` is `getting-paid-on-whatsapp`, not a 24-hex id. It is stable across translations
*and* across edits, because the marketing frontend derives an article's generated cover art
deterministically from it — a change would repaint an article a reader has already seen.

The shared `objectId` validator is therefore the wrong one for this surface and would refuse
every real id on it. `ArticleKeySchema` is what both param schemas use — that schema keeps its
name because it validates the string's **format** and is also what `authorId` is checked
against, so it is not a param name.

**`id` is the canonical name, in the path and in the payload.** These params were
`:articleKey` / `:authorKey` until 2026-08-25 while the payload called the same string `id` /
`authorId`. Nothing on the wire disagreed — a client never sees a param *name* — but this page
did, and BR-014 is what that cost: the dashboard read a note about paths as a note about
payloads, built its `/content` module on `key`, and every create 400ed against `.strict()`
while every list filter was silently stripped. There is now one name everywhere. The stored
column is still `key` and always will be; nothing on the wire exposes it.

### 3. `DELETE` is a soft delete, and it is refused once the article has ever been published

The permission is flagged `destructive`, which is right for a different reason — the flag's
mechanical effect is to keep the name out of `allInFamily()`, and that is what withholds it
from Support.

The operation itself is narrower than the verb suggests:

| | |
|---|---|
| What it does | stamps `deletedAt`. Nothing is removed. |
| When it is refused | `409 BLOG_ARTICLE_DELETE_NOT_ALLOWED` whenever `published_at` is set |
| The test is `published_at`, not `status` | an already-*unpublished* article was still live once, and its address may have inbound links |
| The remedy for a published mistake | `POST /archive` — the URL keeps answering `410 Gone` with its category hub, so the links are not wasted |

`DELETE /authors/:authorId` is the same shape and additionally refuses
(`409 BLOG_AUTHOR_IN_USE`, with the count) while any article credits the byline. That refusal
is what keeps `author` non-null on every published article: jovi-mall's public DTO resolves
the byline by key, and a dangling reference would put an article carrying `BlogPosting`
structured data on the site with no author node at all.

### 4. Two kinds of "author", and they must not merge

| | `article_authors` | `created_by_admin` / `updated_by_admin` |
|---|---|---|
| What it is | the **editorial byline** the public site renders | which **administrator** touched the article |
| Who sees it | everybody, on the marketing site | this service only |
| Where it lives | its own collection, addressed by `key` | a stamp on the article document |
| In a public DTO | yes — that is its purpose | **never** |

The administrative stamp carries an id, a name and a **tier**. `test:content` § 7 serialises
every public DTO and asserts none of the three appears in it, because `/preview` hands that
exact payload shape to an editor and it is the same projection jovi-mall's public route
serves.

---

## `/preview` returns the PUBLIC shape

`GET /articles/:articleId/preview?locale=…` renders the article through the **public**
projection — the same DTO jovi-mall's `GET /api/public/articles/{slug}` serves — at any
status, behind the admin guard.

That is deliberate, and it is the reason previewing never becomes an argument for relaxing the
public endpoints. **Do not add a flag that makes jovi-mall's public route serve drafts.** A
draft is invisible publicly by definition; a preview is an authenticated read of what it would
look like if it were not.

`?locale=` is **required**, and the query schema is `.strict()` — unlike the list endpoints, an
unrecognised parameter here is a `400` rather than a silent drop. An article with no
translation in that language answers `404 BLOG_ARTICLE_NOT_FOUND` with `details: { id, locale }`.

### The public shape

Source: [`read-models/public-article.dto.ts`](../../src/modules/content/read-models/public-article.dto.ts).
**This is wi-admin's own file**, not a jovi-mall shape reached over HTTP — the projection is
reproduced here so that a preview needs no call to the other service. It is a
`PublicArticleDetailDto`, wrapped in this service's usual `{ success: true, data }` envelope.

```json
{
  "id": "getting-paid-on-whatsapp",
  "locale": "en",
  "slug": "getting-paid-on-whatsapp",
  "title": "Getting paid on WhatsApp",
  "metaTitle": "Getting paid — MoMo, OM and cash",
  "excerpt": "How the money reaches you.",
  "categoryKey": "payments",
  "author": {
    "id": "wimall-editorial",
    "name": "The WiMall team",
    "type": "Organization",
    "title": "Editorial",
    "bio": "We write about selling on WhatsApp.",
    "avatarUrl": null
  },
  "publishedAt": "2026-07-08T08:00:00.000Z",
  "updatedAt": "2026-07-30T09:20:00.000Z",
  "featured": false,
  "cover": {
    "url": "/covers/getting-paid.jpg",
    "alt": "A market stall taking a mobile payment",
    "width": 1600,
    "height": 900
  },
  "wordCount": 812,
  "availableLocales": ["en", "fr"],
  "body": [{ "type": "paragraph", "text": [{ "type": "text", "text": "Commission is taken…" }] }]
}
```

| Field | Type | Notes |
|---|---|---|
| `id` | string | The article's stable public id — the same value `AdminArticleDto.id` carries |
| `locale` | `en` · `fr` · `pt` · `es` · `ar` | The language being rendered — the one `?locale=` asked for |
| `slug` | string | **This language's** slug |
| `title` | string | **Flattened from the translation**, not the article |
| `metaTitle` | string | ⚠ **Omitted entirely when unset — not `null`.** The admin DTO nulls it; this one drops the key |
| `excerpt` | string | |
| `categoryKey` | `selling` · `payments` · `delivery` · `growth` · `guides` | |
| `author` | object · `null` | The **byline**, resolved into this language — see below. `null` if the byline was removed. ⚠ Never an administrator |
| `publishedAt` | ISO 8601 | Always present. ⚠ **On a preview it can be the article's `createdAt`** — see below |
| `updatedAt` | ISO 8601 | ⚠ **Omitted when unset — not `null`.** Content revisions only, same value as `AdminArticleDto.updatedAt` |
| `featured` | boolean | |
| `cover` | object · `null` | ⚠ **An explicit `null` when absent**, unlike the two optional keys above — "this article has no cover" is a state the card renders (generated cover art) rather than a field it skips |
| `wordCount` | number | This language's, derived from its `body` |
| `availableLocales` | array | The **published** locales, canonically ordered. ⚠ On a draft this is `[]` |
| `body` | array of blocks | This language's whole block document. Detail only; the summary shape omits it |

**`cover`** — `PublicArticleCover`:

| Field | Type | Notes |
|---|---|---|
| `url` · `width` · `height` | string · number · number | The shared image. Identical in every language |
| `alt` | string | ⚠ **Assembled per language** from `translations[].coverAlt`. **Never empty** — an empty `alt` is the HTML for *this image is decorative, skip it*, which is a lie about a cover |

**`author`** — `PublicAuthorDto`:

| Field | Type | Notes |
|---|---|---|
| `id` · `name` · `type` | string · string · `Person` \| `Organization` | Shared across languages |
| `title` · `bio` | string | ⚠ **Resolved into one language, and the ONE fallback in this module** — a byline with no bio in the requested language falls back to English. Article prose never falls back |
| `avatarUrl` | string · `null` | |

**Two values differ between a preview and the published page, and both are the point of the
endpoint:**

- **`publishedAt` falls back to `createdAt`.** A draft has no `published_at`, and the field is
  non-optional on the wire. On jovi-mall's public route this branch is unreachable — the stamp
  is written before `status` becomes `published`. Do not render a preview's `publishedAt` as
  a publication date.
- **`cover.alt` falls back to this language's `title`.** Also unreachable publicly: publish
  refuses a live translation that has a cover and no `coverAlt`. So a preview of a draft can
  show a cover described by its own headline, which is the honest stand-in and not what will
  ship. The [publish checklist](#the-publish-lifecycle) is what tells you it needs writing.

**What is deliberately absent, in both places:** `status`, `previousSlugs`, the whole
`translations` array, `sourceLocale`, `lastSavedAt`, and — the one that matters —
**`createdBy` / `updatedBy`**. Those are staff identity, and `/preview` hands this payload to a
screen, so `test:content` § 7 serialises every public DTO and asserts none of the three
appears in it.

⚠ **This shape is duplicated in jovi-mall**, at `src/modules/blog/dto/public-article.dto.ts`,
because its public reader serves the same documents and there is no shared package between the
two repositories. The two files agree today — verified field-for-field, not assumed — and
`test:content` § 7 now reads jovi-mall's copy off disk and diffs the interfaces against this
one, so a change on either side turns this suite red. **If the preview and the published page
render differently, the preview is worthless**, and that assertion is the only thing standing
between here and there.

**Clients: mirror the source file rather than transcribing this table.** Copy
`src/modules/content/read-models/public-article.dto.ts` beside the mirrors BR-014 established
(`content-dto.ts`, `content-validators.ts`, `content-domain.ts`, `article-blocks.ts`) and diff
against it — a copy can be `diff`ed and a transcription cannot. The tables above are for
reading; the file is the contract.

---

## The publish lifecycle

```
        ┌──────────────── unpublish ◄───────────────┐
        ▼                                           │
   ┌─────────┐   publish    ┌───────────┐   archive │  ┌──────────┐
   │  draft  │─────────────►│ published │───────────┴─►│ archived │
   └─────────┘              └───────────┘              └──────────┘
        │                                                   ▲
        │                        archive                    │
        └───────────────────────────────────────────────────┘

   DELETE is legal only from `draft`, and only while `published_at` is still null.
```

Publicly, through jovi-mall:

| Status | jovi-mall's public route answers |
|---|---|
| `draft` | `404` — it was never live |
| `published` | the article |
| `archived` | `410 Gone`, carrying `categoryKey` so the site can offer the hub |

`draft` and `archived` are both invisible and are **not** interchangeable. That distinction is
the whole reason `archive` exists as a separate verb, and it is why the trail records
publish / unpublish / archive as three actions on one permission rather than one action.

**`published_at` is stamped once and kept.** A republish does not re-stamp it: it is the sort
key jovi-mall's index, sitemap and prev/next links all share, so re-stamping would silently
reorder pages that link to each other. Send `publishedAt` explicitly only when importing an
article that was published elsewhere and needs to keep its date.

**Unpublishing and archiving both clear `featured`.** A draft cannot hold the index slot — the
site would lead with an article whose every URL 404s.

---

## Translations, slugs, and the redirect

### One article, many translations

Not one document per language. `hreflang` and the sitemap's language alternates are only
reconstructible if the languages are one document.

**Five locales — `en` · `fr` · `pt` · `es` · `ar` — and they are the platform's, not the blog's.**
`CONTENT_LOCALES` is the same list as jovi-mall's `SUPPORTED_LANGUAGES`, because an article
locale *is* a platform locale. Adding a sixth is a platform change, not an editorial one. The
array is **ordered**, and the order is load-bearing: `availableLocales` filters it, so the
`hreflang` set a page emits is stable across requests rather than following whatever order the
translations happen to be stored in.

**What is translated, and what is shared.** The line is *prose versus not-prose*, and it is
worth knowing before designing an editor screen:

| Per language | Shared across the article |
|---|---|
| `title` · `metaTitle` · `excerpt` | `id` — the stable public identifier |
| **`body`** — the whole block document | `categoryKey` · `authorId` · `featured` |
| `slug`, and its retired history | `cover.url` · `cover.width` · `cover.height` — one image |
| `coverAlt` — the cover's description | `status`, `publishedAt`, `archivedAt` |
| `published` — this language's own live flag | |
| `wordCount` — derived from this language's body | |

So a language is a **complete article**: its own headline, its own prose, its own URL, its own
meta description and its own publish decision. It is not a translation *layer* over an English
original, and nothing in the model privileges one locale over another — `en` is the fallback
for an **author bio** and for nothing else.

⚠ **The cover image is shared and its alt text is not.** `cover` carries `{ url, width, height }`
and the description lives on each translation as `coverAlt`. One image serves five languages —
`url`/`width`/`height` are properties of the file, and requiring five uploads before an article
could publish would be busywork — but the alt string is prose, read aloud by a screen reader and
carried as the `og:image` description on social cards, so a single shared one puts English words
on the French page. A translation going live with a cover and no `coverAlt` is a **publish
blocker**, listed per language so the editor knows which one to open. It is not a write-time
refusal: `PATCH` can add a cover without sending `translations`, and requiring it there would
block an editor mid-draft.

**Inline images inside `body` were never affected** — `body` is per-translation, so their `alt`
has always been per-language.

### Categories are keys, and the labels are yours

`categoryKey` is one of five stable keys and **this service never sends a label**. The
translated names and the URL slug live in the frontend's message catalog: five words per
language belong with the rest of the site chrome, and routing them through the API would mean a
deploy to fix a typo. A client renders its own `en`/`fr` names off the key.

Adding a sixth key is therefore a two-repo change — and worth resisting, since a category with
one article in it is an empty hub that dilutes the internal linking it exists to concentrate.

`translations`, when sent on a `PATCH`, is a **full-array replace**, not a merge — a partial
merge has no way to express "remove the Spanish translation", and a per-locale endpoint would
leave the array's one cross-element rule (unique locales) unenforceable. Omit the key entirely
to leave every translation untouched.

A translation may be individually unpublished (`published: false`) on a live article: that
language 404s until it flips, which is the correct behaviour for a missing translation and the
reason there is no language fallback anywhere in the reader.

### `slug_keys`, and the index that lives in another repository

Every `(locale, slug)` pair — current **and retired** — is flattened to `"<locale>:<slug>"` in
one array. It exists because MongoDB refuses a compound unique index on `translations.locale`
+ `translations.slug`: they are parallel array paths, and an index over both is rejected at
write time. Flattening turns it into an ordinary unique multikey index.

Retired slugs stay in it for two reasons, and both matter:

1. A renamed article keeps answering its old address — jovi-mall returns
   `BLOG_ARTICLE_MOVED` carrying the current slug, so the frontend can emit a 301. (This API
   cannot emit it: the address needing the redirect is the *page*, not the endpoint.)
2. No **other** article can claim a retired slug, because a reused one turns a permanent
   redirect into a wrong answer — worse than the 404 it was avoiding.

⚠ **The uniqueness index is declared in jovi-mall, not here.** `ensure:indexes` in this
service covers the `wi-admin` database only. So a duplicate slug is refused by an index this
repository does not define, and `verify:content` proves that cross-service guarantee rather
than assuming it — an index that builds but does not bind looks exactly like one that works.

A duplicate answers `409 BLOG_SLUG_TAKEN`. The reserved slugs `category`, `page` and `index`
answer `400 BLOG_SLUG_RESERVED` — each collides with a jovi-mall public route.

---

## Bodies are typed blocks, never HTML

`body` is a discriminated union of nine block types, `.strict()` throughout: an unknown block
type **and** an unknown key on a known block are both `400`s.

This is a security boundary, not a schema preference. The marketing frontend renders blocks
through React components rather than `dangerouslySetInnerHTML`, so what the union accepts is
what renders. jovi-mall stores `body` as Mongoose `Mixed`, which means **no schema check
exists on the read side at all** — this validator is the only one there is.

Link `href`s are restricted at parse time to `https:`, `http:`, `mailto:`, `tel:` and internal
paths, and an internal path may **not** carry a locale prefix (`/fr/pricing` is refused — the
renderer adds the locale, so a prefixed path renders as `/fr/fr/pricing`).

⚠ **The block union now exists in BOTH repositories and there is no shared package.** This
service validates what it writes; jovi-mall types what it reads. They are pinned to each other
by a fixture list duplicated verbatim — `test:content` § 1 here, `test:blog` § 2b there — so a
change to either turns both suites red. **Adding or changing a block type is a two-repo change,
in one commit**, and it is a three-repo change if the marketing frontend's `ArticleBody.tsx`
needs a new branch.

`word_count` is **derived** on write and never accepted from the editor. `readingMinutes` is
deliberately not stored or sent — the frontend computes it from the body it is about to render.

---

## `content_updated_at` is not `updatedAt`

`featured`, `categoryKey` and a translation's `published` flag all move the document. Stamping
a revision date off "the row was written" would put a `dateModified` in the article's
structured data for a revision that never happened.

So it is stamped from a **content comparison** — only the fields a reader would see: each
translation's `title`, `slug`, `metaTitle`, `excerpt`, `body` and `coverAlt`, plus the cover
itself. Toggling `featured` is not a revision. Adding or removing a language **is** one: the
article's `hreflang` set changed, and that is a change to the published page. Rewriting a
`coverAlt` is one too — it is what a screen reader announces and what the `og:image` carries.

On the wire this is `updatedAt`. **`lastSavedAt` is the other one** — the row write, moved by
every save including the ones above that are not revisions.

---

## At most one featured article per locale

Featuring an article **demotes** whatever it would have competed with, rather than answering a
`409`.

`featured` is per-article while the rule is per-locale, so an editor featuring a French article
has no way to know what is currently featured in the four other languages it also publishes in.
Refusing would ask them to go and find out. It is an editorial nicety in any case — the index
falls back to the newest article when nothing is featured.

---

## Errors

| Code | Status | When |
|---|---|---|
| `BLOG_ARTICLE_NOT_FOUND` | 404 | no live article with that key |
| `BLOG_ARTICLE_KEY_TAKEN` | 409 | the key is already in use |
| `BLOG_ARTICLE_ALREADY_PUBLISHED` | 409 | `publish` on a published article |
| `BLOG_ARTICLE_NOT_PUBLISHABLE` | 422 | `details.blockers` is the full checklist, not the first failure |
| `BLOG_ARTICLE_DELETE_NOT_ALLOWED` | 409 | `DELETE` on an article that has ever been published |
| `BLOG_SLUG_TAKEN` | 409 | another article answers that `(locale, slug)`, current or retired |
| `BLOG_SLUG_RESERVED` | 400 | `category`, `page` or `index` |
| `BLOG_AUTHOR_NOT_FOUND` | 404 | no live byline with that key |
| `BLOG_AUTHOR_KEY_TAKEN` | 409 | the byline key is already in use |
| `BLOG_AUTHOR_IN_USE` | 409 | `details.articleCount` articles still credit the byline |

`BLOG_ARTICLE_NOT_PUBLISHABLE` returns a **checklist** rather than a first failure, because
publishing is an explicit human action: telling an editor about one missing piece at a time,
over three round-trips, is how a publish button earns a reputation for being broken.

`details.blockers` is an array of sentences meant to be shown as written. The conditions:

| Blocker | When |
|---|---|
| The byline does not exist | `authorId` names no live author |
| No translations | the array is empty |
| Every language is drafted | no translation has `published: true` |
| The cover has no alt text in `"<locale>"` | the article has a `cover` and a **published** translation has no `coverAlt` — **one row per language**, so the editor knows which to open |

A **drafted** language missing its `coverAlt` blocks nothing: it is not on the site, so it is
work in progress rather than a defect, and blocking on it would stop an editor shipping English
because the Arabic draft is unfinished.

---

## Coverage

| Suite | What it proves |
|---|---|
| `npm run test:content` | 177 assertions, DB-free. The block union against the cross-repo fixture list, the constructed document against the default table, the three derivations, the lifecycle, the route/permission/audit table, the DTO leak assertions, the tier split. Since BR-019: what `translations[]` order actually is, `sourceLocale` in all four of its states, both repository projections, and the public shape diffed against jovi-mall's own copy of it. Mutation-tested against four edits. |
| `npm run verify:content` | 46 assertions **plus the one BR-019 added**, needs Mongo **and a running jovi-mall**. That the raw-driver write produces a document jovi-mall's public reader renders — `source_locale` included, read from the raw document because the DTO's fallback would hide a key that never landed; that the `slug_keys` index rejects a duplicate written from here; that a rename keeps the old URL answering; that Support can edit and cannot publish. Skips loudly rather than silently when jovi-mall is unreachable. ⚠ The count is deliberately not restated: it comes from a live run, and this suite has not been run since the assertion was added. |

On jovi-mall's side, `npm run test:blog` (95) holds the mirrored fixture list and the public
projection — including the matching cover-alt assertions, since the two projections must agree
on the same input — and `npm run verify:blog` proves the indexes build.
