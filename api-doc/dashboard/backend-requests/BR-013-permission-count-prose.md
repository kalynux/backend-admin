# BR-013 — `permissions.md`'s prose counts were not re-counted when `files.content.read` landed

**Verified against source on 2026-09-08** — every number on this page re-derived by executing
`npm run authz:matrix` and `admin/src/modules/authorization/domain/permission.catalog.ts` /
`tier-grants.ts`: **118** permissions across **20** families, tiers **118 / 101 / 31**, and
**four** catalogued-but-unrouted (`†`) names.

> ### ✅ FIXED — and the numbers this page reports have since moved again
>
> **Answered in [`RESPONSE-2026-08-25.md`](RESPONSE-2026-08-25.md).** The report was correct on
> every figure and the prose was corrected. The dashboard's *"still finds the stale prose counts"*
> assertion did its job and was designed to be deleted.
>
> ⛔ **The 114 / 97 / 30 in the tables below is the 2026-08-25 measurement.** Today it is
> **118 / 101 / 31** of 118, with the `†` count unchanged at **4**. This is the fifth time these
> figures have moved during the programme, which is exactly the argument this page makes:
> **derive, never quote.**
>
> ```bash
> cd backend/admin && npm run authz:matrix
> ```

**Raised 2026-08-25, from the BR-010/011/012 re-copy.** Small, mechanical, and filed rather than
patched locally because [`docs/admin/`](../../) is a byte-for-byte mirror — editing it here
would break the one-command drift check that makes the mirror worth having.

**Nothing is blocked.** This is a documentation correction of exactly the kind BR-012 was, and it
is reported for the same reason: a page that states a number is a claim somebody will act on.

---

## What we measured

`files.content.read` was added to the permission matrix at BR-011 — correctly, and with a good
row. **The prose around the matrix was not re-counted with it.** Measured mechanically against the
re-copied page:

| | The matrix says | The prose says |
|---|---|---|
| Total permissions | **114** | 113 |
| Tier 1 · Developer | **114** of 114 | 113 of 113 |
| Tier 2 · Admin | **97** of 114 | 96 of 113 |
| Tier 3 · Support | **30** of 114 | 29 of 113 |
| Catalogued with no endpoint (`†`) | 4 of **114** | **4** of 113 |
| Families | 20 | 20 ✅ |

The four `†` names are unchanged — `users.sessions.revoke`, `users.roles.manage`,
`notifications.manage`, `developer_tools.webhooks.redeliver`. Only the denominator moved.

### How it was counted

Off the matrix rows themselves, not off any prose, using the same regex our guard uses:

```
^\| `([a-z_]+(?:\.[a-z_]+)+)`( †)? \| *([a-z]+) *\| *([●·]) *\| *([●·]) *\| *([●·]) *\|
```

114 unique rows; `●` counted per tier column. `files.content.read` is
`| read | ● | ● | ● | **audited** |`, so it lands on all three tiers — which is what moves every
one of the three numbers by exactly one, and is the arithmetic we would expect from the BR-011
decision to grant it to Support.

---

## The exact edits

Two places on `docs/api/permissions.md`:

**1 · The tier table at the head of the page**

```diff
-| **1** | Developer | 113 of 113 | Everything, including the developer tools and every escalation-flagged action |
-| **2** | Admin | 96 of 113 | The operational tier — runs the platform day to day, including the money |
-| **3** | Support | 29 of 113 | Ticket work, the lookups needed to answer a ticket, … |
+| **1** | Developer | 114 of 114 | Everything, including the developer tools and every escalation-flagged action |
+| **2** | Admin | 97 of 114 | The operational tier — runs the platform day to day, including the money |
+| **3** | Support | 30 of 114 | Ticket work, the lookups needed to answer a ticket, … |
```

**2 · The `†` note above the matrix**

```diff
-(**4** of 113 permissions — down from 27, and the four that remain each have a written reason
+(**4** of 114 permissions — down from 27, and the four that remain each have a written reason
```

We have not checked whether the same three numbers appear in `authorization.md`, the ADRs or
`README.md` — worth a grep for `of 113` while you are there.

---

## What we did on our side

**Pinned the matrix, not the prose**, on the rule `VERIFICATION-2026-08-24.md` already states and
which BR-012 settled for the error registry: the enumeration is the implementation of the claim,
and a summary of it is a claim about a claim.

- `PERMISSION_NAMES` holds **114**, including `files.content.read`
- `permissions.types.test.ts` asserts 114 / 4 / 20 / 110-routed, counted off the matrix
- the tier fixtures are 114 / 97 / 30, two of the three derived rather than transcribed

We also added a test that **asserts the prose is still wrong**:

```ts
it('still finds the stale prose counts, pending the backend re-count', () => {
    expect(doc, 'the tier header was re-counted — drop the BR-013 notes').toContain(
        '| **1** | Developer | 113 of 113 |',
    );
});
```

That is deliberate. A comment saying "the doc disagrees" rots the moment the doc is fixed and then
misleads the next reader for a year. A test says it out loud and **fails when you make this
change**, which is our cue to delete the notes rather than leave a stale warning in the code.

⚠ **So expect one red test on our side when you re-copy.** That is the design, not a regression —
the fix is ours and it is a deletion.

---

## Acceptance

- [ ] The tier table reads 114 / 114, 97 / 114, 30 / 114
- [ ] The `†` note reads "**4** of 114"
- [ ] A grep for `of 113` across `docs/` finds nothing stale
- [ ] Re-copy → our two doc-parsing guards stay green, and `still finds the stale prose counts`
      goes red so we can delete it

**Effort: minutes.** No code, no contract change, no decision.
