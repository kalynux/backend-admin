# BR-023 · `files.md` says the content route will not serve a `quota_blocked` file. It serves it.

**Raised 2026-09-09, from Phase 6 live verification against a running `:8033`.** Measured, not
inferred — method and transcript in
[VERIFICATION-2026-09-09-LIVE](../../../VERIFICATION-2026-09-09-LIVE.md) § 7.

**Priority: medium, and it has already cost us a feature.** This is not a behaviour complaint — the
route's behaviour is the *useful* one and we would ask you not to change it. It is a documentation
correction, and we are filing it with an unusual amount of detail because **we implemented the
sentence, six surfaces deep, and shipped it.** The dashboard hid images it could have shown for
however long that stood.

---

## The claim

[`files.md:150-158`](../../api/files.md), § *`quota_blocked` — a billing state, not a missing file*:

> `quota_blocked` means **the file owner is over their plan storage cap and this file falls outside
> it.** The file has not been deleted and nothing is broken: it comes back the moment the owner
> upgrades their plan or frees space. `url` is `null`, **and the content route will not help you
> either.**

The first three sentences are exactly right and are why the state is easy to render well. The last
clause is wrong.

## What the wire does

`GET /api/v1/files/:fileId/content`, as a tier-1 administrator, against a file with
`quotaBlockedAt` set — checked in all three trees, because the claim is unqualified:

| File | Key / tree | Library reports | Content route |
|---|---|---|---|
| `6a9d3ef4…` `vendor_page.png` | `images/…` — **public** | `access: "quota_blocked"`, `url: null` | **`200`**, WebP bytes |
| `6a7360c8…` `image/jpeg` | `shipments/…` — private | `access: "quota_blocked"`, `url: null` | **`200`**, JPEG bytes |
| `6a8fb001…` `application/zip` | `digital/…` — private | `access: "quota_blocked"`, `url: null` | **`200`**, zip bytes |

Each was measured twice — before the flag and with it — and the answer was `200` both times. The
files were restored to exactly the state they were found in.

**Why, in source:** jovi-mall's handler
([`admin-file.routes.ts:247-292`](../../../../../backend/jovi-mall/src/modules/catalog/routes/admin-file.routes.ts))
asks `supportsDownloadStream()`, loads the record via `findManyByIds`, and calls
`getDownloadStream(file.key)`. It **never reads `quotaBlockedAt`**, though the mapper does project
it. There is no quota branch to have failed; there is no quota branch.

## So `quota_blocked` is a *publishing* state, and the docs should say so

That is the framing we would suggest, because it makes every other sentence on the page follow:
the quota sweep stops the platform **handing out an address**. It revokes nothing.

⚠ **And for a public tree it could not revoke anything even if you wanted it to.** Those trees are
served by `express.static` straight off disk
([`api/index.ts:628-630`](../../../../../backend/jovi-mall/src/api/index.ts)), which has no database
access. A blocked public file therefore **stays fetchable by anyone who kept its URL**, for as long
as the file exists. Any enforcement in the content route would refuse the one caller who is
authenticated, permissioned and audited while leaving the anonymous holder of a stale link
untouched.

## What it cost us, recorded because you asked us to report rather than work around

We read that clause and built on it. Phase 3 of our contract resync (2026-09-09) added a
`quota_blocked` branch at **six** surfaces which, in each case, *withheld the audited open* on the
stated grounds that it *"cannot succeed"* and would *"spend a disclosure on a request that was never
going to return an image"*:

| Surface | What it did |
|---|---|
| `ImageBox` | returned a placeholder; **no "Click to view" button at all** |
| `FileViewer` | returned a notice; **no "Open the file" button** |
| `LineItemImage` | pre-empted the resolve on order and shipment line items |
| `TicketAttachmentsPanel` | replaced the pre-Attach preview, and said the file *"will not display"* |
| `VendorProductPanels` | replaced the product-gallery tile |
| `MediaLibrary` | made the tile **inert** — no dialog, no open |

The delivery-proof case is the one that stings: BR-011 exists because *"the single most useful image
on the platform for settling a dispute"* was unreachable, you built the route to fix it, and we then
disabled it for any shipment whose owner was over a storage plan.

⚠ **And our tests agreed, because they were written from the same sentence.** Nine of them, one
named *"offers no audited open on a blocked file, **because none can succeed**"*. They passed
against stubs built from the belief they were meant to check. This is the second time this exact
failure mode has hit this repository — the first was `/content` (BR-014), where transcribed types and
tests written from the transcription agreed with each other for months. **A stub cannot contradict
the document that produced it.** It is why we now verify against a running service, and why this BR
exists at all.

All six surfaces were corrected on 2026-09-09: the open is offered, the click works, and the billing
state is drawn *beside* the affordance instead of in place of it.

## Asking for

| | What you would change |
|---|---|
| 1 | **Delete or correct the clause** at `files.md:157`. Suggested: *"`url` is `null`. The content route still serves the bytes — the cap withholds the address, not the file."* |
| 2 | Add a row to the `authorized` / `quota_blocked` table: **Can the content route show it → yes / yes.** The table is what a client implements from, and it is currently the only place a reader could have caught the contradiction |
| 3 | In the `GET /files/:fileId/content` § — which already says *"Any tree, and the public case is NOT a special case"* — add that a quota-blocked file is not a special case either. That paragraph is what made us doubt the other one |
| 4 | If the block *should* apply to the bytes, tell us and we will revert — but please read the `express.static` note above first, and BR-011's own rationale. We think it should not, and we would rather you decided it deliberately than have us assume it from a fixed doc |

**We are not asking you to change the route.** Our correction assumes the current behaviour is
intended, because it is the behaviour BR-011 was granted for.

## One thing we did NOT change

`QUOTA_BLOCKED_COPY` — our single constant for this state — kept everything the page gets right: it
never reads as *missing*, never as *broken*, never as *private*, and it names a plan upgrade as the
next action. That guidance was correct and it is the reason the state renders well. Only the clause
about the bytes was wrong, and one constant meant fixing it once for all six surfaces.
