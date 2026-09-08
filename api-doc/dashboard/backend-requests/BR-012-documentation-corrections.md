# BR-012 · Two contract pages disagree with the service they describe

**Verified against source on 2026-09-08** — both reported defects and their present state: the
error registry against `admin/src/core/errors/error-codes.ts` (**88** declared, **88** documented),
and the composite-guard counts against the live route manifest (**17** `all`-mode, **3** `any`-mode).

> ### ✅ BOTH FIXED — and both numbers have moved again since, which is the point of the request
>
> **Answered in [`RESPONSE-2026-08-24.md`](RESPONSE-2026-08-24.md).** All sixteen codes landed in
> [`errors.md`](../../api/errors.md), and `GET /contracts/:contractId` is in the composite-guard
> table with the reasoning this page supplied.
>
> ⛔ **Every count below is a 2026-08-24 measurement. Do not quote them.**
>
> | This page | Today |
> |---|---|
> | *"`errors.md` publishes **73** codes; the service defines **82**"* | **88 declared, 88 documented** — pinned by `npm run test:error-docs`, which did not exist when this was filed |
> | *"Thirteen endpoints … the real number is **fourteen**"* | **Seventeen** `all`-mode, plus **three** `any`-mode |
>
> The general lesson was acted on: [`permissions.md`](../../api/permissions.md) and
> [`errors.md`](../../api/errors.md) now say how to re-derive their figures instead of stating
> them, and `test:error-docs` makes the registry half enforceable in the repository that owns both
> sides.
>
> ⚠ The paths in this page (`docs/admin/api/…`) predate the 2026-09-08 `docs/` → `api-doc/` +
> `docs/` split. The contract is `admin/api-doc/`, mirrored at `api-doc/admin/`.

**Priority: medium, effort: small.** No code changes, no wire changes. Two doc pages under
`backend/admin/docs/api/` are behind the service, and we cannot fix them from here —
[`docs/admin/`](../../) is a **verbatim mirror** and read-only on this side, by design.

Both were found on 2026-08-24 by reading backend source, and both are **confirmed at the line
number given**. Neither is a wrong specification; both are omissions that will mislead the next
reader.

---

## 1 · `errors.md` publishes 73 codes; the service defines 82

**Where:** [`docs/admin/api/errors.md`](../../api/errors.md) versus
`backend/admin/src/core/errors/error-codes.ts`.

The registry tables in `errors.md` carry **73** rows. `ERROR_CODES` declares **82**. The sixteen
missing ones all belong to surfaces that shipped after the page was last revised:

| Missing from `errors.md` | Module | Confirmed thrown at |
|---|---|---|
| `TRACKING_DOOR_UNCONFIGURED` · `TRACKING_DOOR_REFUSED` · `TRACKING_DOOR_UNAVAILABLE` | tracking data door | `modules/agents/domain/tracking-disclosure.ts` |
| `TICKET_NOT_FOUND` · `TICKET_ALREADY_ASSIGNED` | support | `modules/support/controllers/ticket.controller.ts` |
| `FILE_DELETE_NOT_CONFIRMED` | files | `modules/files/controllers/file.controller.ts` |
| `BLOG_ARTICLE_NOT_FOUND` · `BLOG_ARTICLE_KEY_TAKEN` · `BLOG_ARTICLE_NOT_PUBLISHABLE` · `BLOG_ARTICLE_ALREADY_PUBLISHED` · `BLOG_ARTICLE_DELETE_NOT_ALLOWED` · `BLOG_SLUG_TAKEN` · `BLOG_SLUG_RESERVED` · `BLOG_AUTHOR_NOT_FOUND` · `BLOG_AUTHOR_KEY_TAKEN` · `BLOG_AUTHOR_IN_USE` | content | `modules/content/services/article.service.ts` |

*(Four were spot-checked against their throw sites; the rest were matched by name against
`ERROR_CODES`.)*

Seven codes travel the other way — `AUTH_ACCOUNT_SUSPENDED`, the three `BILLING_*`, the two
`CONTRACT_*`, `MESSAGING_DELIVERY_FAILED`. Those are **correct**: they are jovi-mall's codes,
catalogued in `errors.md` because they arrive as `details.platformCode`, and wi-admin rightly never
declares them.

### Why this matters more than a count

`errors.md` says an error page's job is to let a client **branch on `code`**. A code that reaches
an operator with no entry anywhere is rendered by its category instead — plausible, and wrong. Ten
of the sixteen are the blog editor's, and several of them are the *useful* ones: an editor who is
told "something went wrong" rather than "another article already uses that web address" cannot fix
it.

### What we did on our side, and what it means for you

We added all sixteen to the dashboard's registry with English and French copy, and we
**strengthened our guard rather than relaxing it**. `src/i18n/error-catalog.test.ts` now diffs
`KNOWN_ERROR_CODES` against **both** `errors.md` **and** the mirrored `error-codes.ts`:

> The implementation is the source of truth. A document — including the backend's own — is a claim
> about it, and a claim is not evidence.
> — admin-dash's `VERIFICATION-2026-08-24.md` § 1

**The practical consequence for you:** a module that ships a new error code without a docs update
now turns the dashboard's build red, naming the code. That is the behaviour we want, but you should
know it exists before the next module lands.

### The fix

Add the sixteen rows to `errors.md`, each with its status, category and meaning. Four deserve more
than one line:

- **`BLOG_ARTICLE_NOT_PUBLISHABLE` (422)** — `details.blockers` is the **full checklist**, not the
  first failure. Worth stating, because a client that renders one line at a time makes publishing
  feel broken. (We render all of them.)
- **`BLOG_ARTICLE_DELETE_NOT_ALLOWED` (409)** — the test is `published_at`, **not `status`**. An
  already-*unpublished* article still refuses deletion. That is surprising and correct, and nothing
  currently says it outside the source.
- **`BLOG_AUTHOR_IN_USE` (409)** — carries `details.articleCount`.
- **`TICKET_ALREADY_ASSIGNED` (409)** — the one code that makes `availableActions.claim` a
  best-effort hint rather than a guarantee.

---

## 2 · The composite-guard table is missing a row, and the prose miscounts

**Where:** [`docs/admin/api/permissions.md`](../../api/permissions.md) § *Composite guards*.

The page says:

> Thirteen endpoints require **more than one** permission (`all` mode) …

and lists thirteen rows. **The real number is fourteen.** The missing row is:

| Endpoint | Requires |
|---|---|
| `GET /contracts/:contractId` | `agencies.read` + `agents.read` |

Confirmed at `backend/admin/src/modules/agencies/routes/contract.routes.ts:39`:

```ts
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/:contractId',
    access: permission('agencies.read', 'agents.read'),   // ← line 39
    ...
```

The page is also the **only** document that gets this wrong.
admin-dash's `ROUTE-MAP.md` shows the `+` on that row, and
its `MIGRATION-2026-08.md` § 8 states *"15 routes are composite guards
(not 13): 14 require all of two or three permissions, and exactly one is `any`-mode"*. So
`permissions.md` disagrees with two of its own siblings.

Worth noting *why* it is a composite guard, since the reason is good and the page has room for it:
the payload names a party from **each** directory — an agent and an agency — so holding one
permission is not enough to see it. That is the same argument the `/accounts` composite already
makes, and it is the argument for `/contracts` existing as its own mount at all.

### The fix

Add the row; change "Thirteen" to "Fourteen". Optionally add the sentence about the one `any`-mode
guard being separate, so the page's 14 and the migration doc's 15 stop looking like a
contradiction.

---

## Why we are not fixing these ourselves

[`docs/README.md`](../../../docs/README.md) is explicit, and we agree with it:

> ### `admin/` — treat as read-only
> A **byte-for-byte** copy of `backend/admin/docs/`. If a page here is wrong, it is wrong upstream:
> fix it in `backend/admin` and re-copy. Do not annotate it — corrections belong in the authored
> pages above, which is what keeps the one-command drift check honest.

Editing the mirror would break `diff -r backend/admin/docs frontend/admin-dash/docs/admin`, which
is the cheapest staleness detector either side has. So: upstream, then re-copy.

---

## Acceptance

- [ ] The sixteen codes are in `errors.md`, with status, category and meaning
- [ ] `BLOG_ARTICLE_NOT_PUBLISHABLE`'s `details.blockers` is documented as a full checklist
- [ ] `BLOG_ARTICLE_DELETE_NOT_ALLOWED` is documented as testing `published_at`, not `status`
- [ ] `GET /contracts/:contractId` is in the composite-guard table
- [ ] The prose says "Fourteen", not "Thirteen"
- [ ] Both pages re-copied into `frontend/admin-dash/docs/admin/`, and
      `diff -r backend/admin/docs frontend/admin-dash/docs/admin` reports only the four known
      exceptions

> After the re-copy, the dashboard's two doc-parsing guards
> (`src/types/permissions.types.test.ts`, `src/i18n/error-catalog.test.ts`) should stay green with
> no `src/` change. If either goes red, that is a genuine disagreement and worth a message rather
> than a local fix.
