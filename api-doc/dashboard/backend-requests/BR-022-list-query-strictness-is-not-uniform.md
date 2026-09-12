# BR-022 · "Every list endpoint silently drops an unrecognised query parameter" is not true of all of them

**Raised 2026-09-09, from Phase 6 live verification against a running `:8033`.** Measured, not
read. Full transcript in [VERIFICATION-2026-09-09-LIVE](../../../VERIFICATION-2026-09-09-LIVE.md)
§ 1.

**Priority: low.** Nothing is broken. This is a request to sharpen a rule that is currently stated
service-wide, is relied on service-wide, and is **three different behaviours** wearing one
sentence — which makes the rule useless for deciding what a given endpoint will do.

---

## The rule as it stands

Documentation inconsistency **#5**, confirmed by you at BR-014 and deliberately left unfixed:

> `listQuery` is not `.strict()`, service-wide. An unrecognised query parameter is **silently
> dropped** on every list endpoint — `categoryKey` instead of `category` returns the unfiltered
> list with a `200`.

We repeat it in our own `CLAUDE.md` and in
[`content.service.ts`](../../../../src/services/content.service.ts)'s header, and we tell readers
to check a filter name against the endpoint's page because of it. Fair enough. But **"every list
endpoint" is measurably wrong**, and the endpoint where it is wrong is the one BR-014 was about.

## Three behaviours, measured

All as tier 1 against `:8033`.

| Request | Result |
|---|---|
| `GET /content/articles?categoryKey=nonsense` | **200**, `meta.total: 1` — the unfiltered list. Silently dropped ✅ matches the rule |
| `GET /content/articles?search=zzzz` | **200**, `meta.total: 1` — unfiltered. Silently dropped ✅ matches the rule (and `content.md` is right that there is no `search`) |
| `GET /content/articles?category=__no_such_category__` | **400 `VALIDATION_ERROR`** — a *recognised* key with a value outside its enum is refused |
| `GET /content/authors?page=2&limit=1` | **400 `VALIDATION_ERROR`** — ❌ **does not match the rule at all.** This endpoint is strict |
| `GET /content/articles/:id/preview?locale=en&stray=1` | **400 `VALIDATION_ERROR`**, `unrecognized_keys` — strict, and `content.md` says so |
| `GET /audit?targetType=not_a_real_target` | **400 `VALIDATION_ERROR`**, and the message **enumerates all 23 permitted values** |
| `GET /automation/failures?channel=carrier-pigeon` | **400**, enum message naming `telegram \| whatsapp \| unknown` |
| `GET /automation/failures?windowHours=721` | **400**, `too_big`, naming the 720 ceiling |

So the axes are:

1. **an unrecognised KEY** — silently dropped on `/content/articles`, **refused** on
   `/content/authors` and on `/preview`;
2. **a recognised key with an out-of-range VALUE** — refused everywhere we looked, with a message
   that names the permitted set. This is excellent and is what makes a misspelt *value* harmless.

The dangerous case is exactly one of those four squares: an unrecognised **key** that is silently
dropped. It is not the whole service.

## Why this is worth sharpening rather than leaving

**Because the general rule licenses the wrong inference in both directions.**

BR-014 records that our byline list *"sent `page`/`limit` at an endpoint that takes no
parameters"*, and we corrected it. We now know that request was answering **400**, not returning an
unpaginated list — the bug was louder than either of us assumed at the time. Had we trusted
inconsistency #5 rather than fixing it, we would have expected a silent drop and gone looking for
the wrong symptom.

In the other direction: a reader who takes the rule at face value writes a client that never
checks for a 400 on a list request, because "an unrecognised parameter is dropped". That client
breaks on `/content/authors` today.

## What we are asking for

Not a behaviour change. **Widening `listQuery` to `.strict()` service-wide is a change with its own
blast radius** and you have already declined it for good reason; we are not reopening that.

We are asking for the **rule to name its scope**, in the one place it is stated as a service-wide
fact:

| | Change |
|---|---|
| 1 | State it as *"most list endpoints"* and say which are strict. `/content/authors` (no parameters at all) and `GET /content/articles/:articleId/preview` are the two we have found; a grep for `.strict()` on your side will produce the complete set faster than our probing will |
| 2 | Separate the two axes explicitly — an unrecognised **key** may be dropped; a recognised key with a bad **value** is always refused, and the refusal names the permitted set. The second half is a genuinely good property and is currently buried under a warning about the first |
| 3 | On `/content/authors` specifically: `content.md` says the endpoint takes no query parameters, which is true. Adding *"and refuses any"* would have saved BR-014 a step |

## What the dashboard does meanwhile

Nothing changes; both endpoints are already called correctly. `AuthorListQuery` is
`Record<string, never>` and `listAuthors()` sends no query string at all — the BR-014 correction,
which the wire now confirms was not merely tidier but necessary. We have left our own prose alone
pending your answer rather than guessing at the strict set.
