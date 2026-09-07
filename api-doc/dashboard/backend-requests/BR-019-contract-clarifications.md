# BR-019 · Four things the contract leaves undecided that a client now has to decide

**Priority: low, except § 1 — and § 1 is only low because we have a workaround we do not like.**

None of these asks for a new capability. Each is a place where the dashboard has had to adopt a
convention the contract does not state, which means the convention can be broken by a deploy that
looks entirely reasonable from your side.

---

## 1 · Is the order of `translations[]` on an article stable?

**What we need it for.** The operator ask for the blog is:

> The first blog is the component driver. Once set, all other language blogs added for the same
> article should inherit the same components.

There is no `sourceLocale` field on `AdminArticleDto` and no way to store one, so the dashboard has
to *derive* which translation is the driver. **We have chosen `translations[0]`** — in practice the
language the article was created in, since a create requires at least one translation and later
languages are appended.

**The problem.** `content.md` documents `translations` as *"array — one per language"* and says
nothing about order. So `translations[0]` is an observation, not a contract. A `$sort` added to
the projection, a locale-canonical ordering applied for tidiness, or a Mongo document rewrite
could silently change which language drives the editor — and the failure is quiet: the editor
would start seeding new languages from the wrong source and flagging correctly-translated blocks
as untranslated.

**Asking for one of:**

| | |
|---|---|
| **a** ⭐ | A sentence in `content.md`: *"`translations` is returned in creation order, oldest first, and that order is stable."* Costs nothing if it is already true |
| **b** | A `sourceLocale` field on `AdminArticleDto`, set at create from the first translation and never mutated. Explicit, and it survives any reordering |
| **c** | *"The order is not guaranteed"* — which is also a useful answer. We would switch the driver to `en`, falling back to the canonical-order first locale, and accept being wrong for a French-first article |

**We have shipped (a) as an assumption** and marked it in `content.types.ts`. A one-line
confirmation converts it from an assumption into a contract.

---

## 2 · `GET /orders/:orderId/timeline` — `eventType` is a closed enum, and the contract says it is open

`orders.md` documents the filter as:

> `eventType` — string, 2–60. Dotted tokens like `payment.updated`. **Format-validated, not pinned**

That is accurate about *this service's validator*, and it is misleading about the data. The
values are a **closed Mongoose enum of nine**, in one file —
`backend/jovi-mall/src/modules/orders/order-timeline.model.ts`:

```ts
export type TimelineEventType =
    | 'order.created'
    | 'payment.updated'
    | 'fulfillment.updated'
    | 'delivery.agency_updated'
    | 'order.completed'
    | 'note.added'
    | 'entitlement.revoked'
    | 'entitlement.restored'
    | 'system.action';
```

…and the schema repeats the nine as an `enum`, so a tenth value cannot be written without a code
change. The timeline collection is additionally append-only, with `pre` hooks that throw on
update and delete.

**Why it matters.** The operator asked for the filter to be a select, and a nine-value closed set
is a select. Against a *"format-validated, not pinned"* contract we would have had to keep it
free-text, and against a **silently non-strict `listQuery`** a mistyped value returns the
unfiltered list with a `200` — a filter that looks applied and is not.

**Asking for:** the nine values documented in `orders.md`, and a note saying the set is closed at
the model. That is all.

**What we have done meanwhile**, following this repository's own rule that *a copy can be `diff`ed
and a transcription cannot*: mirrored the file as
admin-dash's `api-doc/jovi-mall/order-timeline-events.ts`, alongside
`ticket-vocabularies.ts` which exists for the same reason, and guarded it with a test that diffs
the mirror against the select's options.

⚠ **Please tell us before adding a tenth event type.** The mirror will not know, and the filter
would then be a picker that cannot express a real value.

---

## 3 · `GET /content/articles/:articleId/preview` returns a shape nothing documents

The operator asked for a customer's-eye preview of an article, and this endpoint is exactly that:

> `/preview` renders the article through the **public** projection — the same DTO jovi-mall's
> `GET /api/public/articles/{slug}` serves — at any status, behind the admin guard.

**But the public DTO is not documented anywhere in `docs/admin/`**, so our service function types
its return as `unknown` and no screen can render it.

**Asking for one of:**

| | |
|---|---|
| **a** ⭐ | A **source mirror** of the public article DTO, the way `article-blocks.ts` and `content-dto.ts` already are. This is precisely the case the mirror rule was written for: fully specified in backend code, absent from a doc page |
| **b** | A `## The public shape` section in `content.md`, as `## The shapes` was added at BR-014 |

**What we are shipping meanwhile:** a **local preview renderer**, built from the nine block types
in `article-blocks.ts` and styled as an article page. It is honest about what it is — it renders
*our* body, not the platform's projection, and it is labelled as an approximation.

⚠ **It is also better than `/preview` for the main use case**, which is why this is low priority:
`/preview` can only render an article that has been **saved**, and the editor wants to see an
unsaved draft. The two are complementary; we would still like the DTO so the saved-state preview
can be exact.

---

## 4 · `GET /agents/:agentId/cod-allocation` has no documented response shape

Restated here from [BR-016 § 2](BR-016-names-on-reference-rows.md) because it is a documentation
gap rather than a field request, and it is the one endpoint in the `/agents` group with none —
`agents.md` gives its permission, transport, parameter list and error codes and then stops.

Our `CodAllocation` and `CodAllocationSlice` types are therefore **transcriptions from the wire**.
This repository has one very expensive lesson about transcribed contracts: the whole `/content`
module was wrong on the wire for months because its types were read from a prose page instead of
from source, and [our own tests agreed with the mistake](BR-014-content-wire-shapes.md) because
they were written from the same reading.

**Asking for:** the response shape in `agents.md`, or a source mirror of the DTO.
