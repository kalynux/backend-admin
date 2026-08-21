# `/content` — articles and bylines

Base path: `/api/v1/content`

The blog editor for the marketing site: article drafts, translations, the publish lifecycle,
and the editorial bylines articles are credited to. **Fourteen routes**, and this is the
**only** editorial door onto them — jovi-mall's `/api/admin/articles` and
`/api/admin/article-authors` mounts were deleted when this one was built.

Design records: [`PHASE-5-LEGACY-CLOSEOUT-PLAN.md`](../../../PRODUCTION-READINESS/PHASE-5-LEGACY-CLOSEOUT-PLAN.md)
(Part A — the port), [`../ADR-004-DOMAIN-OWNERSHIP.md`](../ADR-004-DOMAIN-OWNERSHIP.md) D-4
(why this family MOVED rather than delegating),
[`../ADR-005-API-CONTRACT.md`](../ADR-005-API-CONTRACT.md).

| Method | Path | Permission | Transport | Audited |
|---|---|---|---|---|
| `GET` | `/articles` | `content.articles.read` | **owned** | — |
| `POST` | `/articles` | `content.articles.write` | **owned** | ✅ |
| `GET` | `/articles/:articleKey` | `content.articles.read` | **owned** | — |
| `GET` | `/articles/:articleKey/preview` | `content.articles.read` | **owned** | — |
| `PATCH` | `/articles/:articleKey` | `content.articles.write` | **owned** | ✅ |
| `POST` | `/articles/:articleKey/publish` | `content.articles.publish` | **owned** | ✅ |
| `POST` | `/articles/:articleKey/unpublish` | `content.articles.publish` | **owned** | ✅ |
| `POST` | `/articles/:articleKey/archive` | `content.articles.publish` | **owned** | ✅ |
| `DELETE` | `/articles/:articleKey` | `content.articles.delete` | **owned** | ✅ |
| `GET` | `/authors` | `content.authors.read` | **owned** | — |
| `POST` | `/authors` | `content.authors.write` | **owned** | ✅ |
| `GET` | `/authors/:authorKey` | `content.authors.read` | **owned** | — |
| `PATCH` | `/authors/:authorKey` | `content.authors.write` | **owned** | ✅ |
| `DELETE` | `/authors/:authorKey` | `content.authors.delete` | **owned** | ✅ |

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

### 2. The paths key on a stable string, not an ObjectId

`:articleKey` is `getting-paid-on-whatsapp`, not a 24-hex id. The key is stable across
translations *and* across edits, because the marketing frontend derives an article's generated
cover art deterministically from it — a change would repaint an article a reader has already
seen.

The shared `objectId` validator is therefore the wrong one for this surface and would refuse
every real id on it. `ArticleKeySchema` is what both param schemas use.

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

`DELETE /authors/:authorKey` is the same shape and additionally refuses
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

`GET /articles/:articleKey/preview?locale=…` renders the article through the **public**
projection — the same DTO jovi-mall's `GET /api/public/articles/{slug}` serves — at any
status, behind the admin guard.

That is deliberate, and it is the reason previewing never becomes an argument for relaxing the
public endpoints. **Do not add a flag that makes jovi-mall's public route serve drafts.** A
draft is invisible publicly by definition; a preview is an authenticated read of what it would
look like if it were not.

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

So it is stamped from a **content comparison** — only the fields a reader would see, plus the
cover. Toggling `featured` is not a revision. Adding or removing a language **is** one: the
article's `hreflang` set changed, and that is a change to the published page.

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

---

## Coverage

| Suite | What it proves |
|---|---|
| `npm run test:content` | 146 assertions, DB-free. The block union against the cross-repo fixture list, the constructed document against the default table, the three derivations, the lifecycle, the route/permission/audit table, the DTO leak assertions, the tier split. Mutation-tested against four edits. |
| `npm run verify:content` | 46 assertions, needs Mongo **and a running jovi-mall**. That the raw-driver write produces a document jovi-mall's public reader renders; that the `slug_keys` index rejects a duplicate written from here; that a rename keeps the old URL answering; that Support can edit and cannot publish. Skips loudly rather than silently when jovi-mall is unreachable. |

On jovi-mall's side, `npm run test:blog` holds the mirrored fixture list and the public
projection, and `npm run verify:blog` proves the indexes build.
