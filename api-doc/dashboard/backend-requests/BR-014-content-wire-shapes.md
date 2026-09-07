# BR-014 — `/content` publishes no response shapes, and the one hint in the docs is misleading

**Raised 2026-08-25, while building the article body editor.** This one is not a nice-to-have.

**The dashboard's entire `/content` module was wrong on the wire, and had been since it was
built.** We found it, we fixed our side against your source, and everything below is either a
request for documentation or a naming question that is yours to answer. **Nothing is blocked on
you** — but the gap that caused this is still open, and the next module ported the same way will
land in the same place.

---

## What happened

`content.md` carries **thirty-six field tables about behaviour and zero JSON examples**. There is
no article field table, no author field table, and no request-body table. It is a good page about
*rules* and it says nothing about *shapes*.

With nothing to build against, the shapes were read from
`docs/jovi-mall/admin/articles.md` — the page the capability moved *from* — whose obsolete banner
says that beyond the base path only two things changed: **"keys instead of ids"**, and the
permissions.

**That sentence was read as being about the payload. It is only about the path.** The routes are
`/articles/:articleKey` and `/authors/:authorKey`; the *fields* were never renamed. They are `id`
and `authorId`.

Every consequence below follows from that one sentence.

---

## What was wrong, measured against your source

Read from `read-models/article.dto.ts` and `validators/article.validator.ts`, not from a doc.

| Where | We sent / read | The contract | Consequence |
|---|---|---|---|
| `CreateArticleSchema` | `key` | **`id`** | `.strict()` → **every article create was a 400** |
| `CreateAuthorSchema` | `key`, `bio` | **`id`**, `translations` | `.strict()` → **every byline create was a 400** |
| `CreateAuthorSchema` | *(absent)* | **`type`, required** | Missing required field |
| `AdminArticleDto` | `article.key` | `article.id` | Detail screen rendered `undefined` as its title |
| `AdminArticleDto` | `authorKey` | `authorId` + a resolved `author` object | Byline link pointed at `undefined` |
| `AdminArticleDto` | `contentUpdatedAt` | **`updatedAt`**, and `lastSavedAt` for the row write | Two dates, both blank |
| `AdminArticleDto` | `wordCount` on the article | **per translation** | Blank |
| `AdminArticleAuthorDto` | scalar `bio` | `translations: Record<locale, {title, bio}>` | Bio column blank on every row |
| `ListAuthorsQuerySchema` | `?search&sort&page&limit` | **`z.object({}).strict()`** | **Every byline list load was a 400** |
| `SearchArticlesQuerySchema` | `categoryKey`, `authorKey`, `search` | `category`, `author`, *(no search)* | Non-strict → silently **stripped**. A search box that looked like it worked and returned the unfiltered list |
| Both deletes | `Promise<null>` | `{ id, deleted }` | Harmless, but wrong |

⚠ **The stripped filters are the part worth dwelling on.** A `400` is a bad afternoon. A filter
that is silently dropped by a non-strict schema is a screen that **looks correct and lies**, and
nothing on either side reports it. Your own D-17 makes exactly this argument about stale enum
filters; it applies to parameter *names* too.

### Why none of our tests caught it

`content.service.test.ts` asserted the author create body was `{ key, name, bio }` — because the
code sent `{ key, name, bio }`. **A test written from the same misreading as the code cannot catch
the misreading.** That is the real lesson here, and it is why the fix below is not "we corrected
the field names".

---

## What we did

**Mirrored two more of your source files**, on the precedent `error-codes.ts` set and for the
reason that precedent exists — *a copy can be `diff`ed and a transcription cannot*:

| Mirror | Source |
|---|---|
| `docs/admin/content-dto.ts` | `content/read-models/article.dto.ts` |
| `docs/admin/content-validators.ts` | `content/validators/article.validator.ts` |
| `docs/admin/content-domain.ts` | `content/domain/content.types.ts` |
| `docs/admin/article-blocks.ts` | `content/validators/article-body.validator.ts` *(already there)* |

Then wrote `src/types/content-contract.test.ts`, which **parses those mirrors and diffs every
interface and every `z.object` against our types** — both directions. It is what would have caught
this on day one, and it caught nothing after the correction because the correction was made from
the same source it reads.

⚠ **This means `diff -r backend/admin/docs frontend/admin-dash/docs/admin` now reports five extra
names, not three**: `dashboard`, `error-codes.ts`, `article-blocks.ts`, `content-domain.ts`,
`content-dto.ts`, `content-validators.ts`. Anyone wiring that into CI needs the updated
expectation.

---

## What we are asking for

### 1 · `content.md` needs field tables · **the actual ask**

Three tables, in the style every other page on the service already uses:

- **`AdminArticleDto`** — including that `updatedAt` is content revisions only, that `lastSavedAt`
  is the row write, and that `wordCount` is per translation
- **`AdminArticleAuthorDto`** — including that there is no scalar `bio` and that `type` is required
- **The request bodies** — `id` / `authorId` named explicitly, and `translations` as a full-array
  replace

A single worked JSON example of each would have prevented all of this. Every other module page on
this service has one; `/content` is the exception, and it is the module that was ported rather
than designed here — which is presumably why.

### 2 · A decision on `:articleKey` versus `id` · **yours to make**

The path says `key`, the payload says `id`, and they are the same string. We are **not** asking you
to change the wire — that would break jovi-mall's reader for a cosmetic win. We are asking you to
**write down which name is canonical**, so the next reader does not have to guess as we did.

If it is `id`, `ArticleKeyParamSchema` / `AuthorKeyParamSchema` and the two route params are the
odd ones out and could be renamed on a quiet day. If the path is right, one sentence in
`content.md` saying *"the path calls it a key, the payload calls it an id, they are the same
value"* closes it forever.

### 3 · Retire or re-banner `docs/jovi-mall/admin/articles.md`

Its banner is the proximate cause. *"Only the base path, the keys and the permissions changed"* is
true and reads as though it covers the payload. Either delete the page, or make the banner say
**"the PATH parameters became keys; the payload fields did not change"**.

⚠ Two sibling pages carry the same obsolete banner — `catalogue-vectorisation.md` and
`profile.md`. Worth the same look.

---

## Two smaller things, while we were in there

**`ARTICLE_SORT` has no `slug`, and the reason is good** — it lives inside `translations`, so
sorting by it would order by whichever locale Mongo reached first. Not documented in
`content.md`'s sort section. Worth a line; it is the kind of absence a client otherwise files as a
bug.

**The author list being unpaginated is a deliberate and undocumented exception** to the service's
list contract. `content.md` does not mention it, so a client written from the pagination rules in
`README.md` — which is what we did — sends `page` and `limit` and gets a `400` with no hint that
the exception is intentional. One sentence.

---

## Acceptance

- [ ] `content.md` carries a field table for the article DTO, the author DTO, and the write bodies
- [ ] It names `id` and `authorId` explicitly, and says the path parameter is the same value
- [ ] It states that `wordCount` is per translation and that `updatedAt` ≠ `lastSavedAt`
- [ ] It states that `GET /authors` is unpaginated and takes no parameters
- [ ] It names the list filters `category` / `author` and says there is no `search`
- [ ] `docs/jovi-mall/admin/articles.md` is retired, or its banner is corrected to say the payload
      did **not** change
- [ ] A decision recorded on `key` versus `id`

**Nothing here blocks us.** Our types are pinned to your source and guarded both directions; the
editor, the create flow and the byline form are built and green. This is about the next person.
