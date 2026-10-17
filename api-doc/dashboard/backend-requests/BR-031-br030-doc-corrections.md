# BR-031 · Two pages still state the old figures after BR-030

**Opened 2026-10-15. Status: open. Documentation only — no code, no wire change.**

Found while building BR-030's checklist
([`FRONTEND-CHANGELOG-transactions-owner-decisions.md`](../../FRONTEND-CHANGELOG-transactions-owner-decisions.md))
against the pages re-copied the same day. Both are places where a page's own new text is right
and an older line on the same page was not updated to match. `npm run authz:matrix` was run
against `backend/admin` and printed **143 / 120 / 47**, so the source is right in both cases.

---

## 1 · `permissions.md` — the level table still says 142

The re-measure note at the top of [`permissions.md`](../../api/permissions.md) says *"143
permissions … tier totals 143 / 120 / 47"*, and the matrix has the
`money.earnings.platform.read` row. The level table further down still reads:

```
| **1** | Developer | 142 of 142 | …
| **2** | Admin | 120 of 142 | …
| **3** | Support | 47 of 142 | …
```

**Ask:** `143 of 143`, `120 of 143`, `47 of 143`.

**Why it matters here:** the dashboard's `permissions.types.test.ts` counts the matrix rows and
checks that the page's own prose agrees with them. It is red on exactly this table, and we do not
change the test to match a page; it goes green when the corrected page is re-copied.

---

## 2 · `money.md` — three endpoint sections name the old permission

The route table at the top of [`money.md`](../../api/money.md) and its *"The platform's own
amounts are tier 1 only"* section both say the three routes need `money.earnings.platform.read`.
The three endpoint sections below still print the old permission in their **Permission** row:

| Section | Says | Should say |
|---|---|---|
| `## GET /money/earnings/platform` | `money.earnings.read` | `money.earnings.platform.read` |
| `## GET /money/earnings/platform/summary` | `money.earnings.read` | `money.earnings.platform.read` |
| `## GET /money/earnings/platform/ledger` | `money.earnings.read` | `money.earnings.platform.read` |

Nothing on the dashboard was built from these three rows. They are what a reader lands on from a
link to one endpoint, though, so they are the rows most likely to be believed.

---

## Acceptance

- [ ] `permissions.md`'s level table says 143 of 143 · 120 of 143 · 47 of 143
- [ ] The three `money.md` endpoint sections name `money.earnings.platform.read`

## What the dashboard does meanwhile

Nothing changes on screen. One test, *"states the same counts in prose that its matrix
enumerates"*, stays red until the corrected `permissions.md` is re-copied.
