# ADR-021 — The administrator's media library, and the first file this service can create

**Verified against source on 2026-09-08** — the three decisions it records, against the live manifest and source: the library is a direct read (`files.library.read`), the upload is an unparsed stream proxy capped by `ADMIN_UPLOAD_MAX_BYTES` (**32 MiB**, `src/config/env.ts:329`) answering **415** `FILE_UPLOAD_NOT_MULTIPART` (`file.controller.ts:328-339`), and wi-admin builds `FileDetail.url` itself (`src/infra/storage/file-detail.ts`). D-3's reversal of ADR-009 D-6 is stated on both pages. Every route, error code, permission and audit action this page names was re-checked against the live route manifest and the four registries — `permission.catalog.ts`, `audit.catalog.ts`, and both services' `error-codes.ts`. ⚠ **This is a dated design record.** Its *Context* sections describe what PHASE-0 or the phase found **at the time** and are correct as history, not as a description of the service today; where a decision is still the live rule it says so at its own D-item.

**Date:** 2026-08-25 · **Status:** Accepted and **IMPLEMENTED**
**Scope:** wi-admin, jovi-mall. **geo-tracker is not touched.**
**Amends:** **ADR-009 D-6** (*"this service resolves no file URLs"* — no longer true of one
route) and the standing contract rule *"wi-admin accepts no multipart bodies anywhere"*
(narrowed to *"wi-admin never **parses** one"*). Both were stated as settled; both are
amended here in writing rather than left to rot.
**Answers:** [BR-015](../api-doc/dashboard/backend-requests/BR-015-media-library.md)

---

## Context

BR-015 asked for a **Media** menu and a **media picker** — a listing of every file on the
platform with its owner and its usage, and a way for an administrator to upload one. It
blocked five screens at once: the blog's image block, the blog's cover image (which had no
editor at all, because nothing could produce a URL), the ticket-attachment form, the picker
itself and the listing.

The request was unusually well researched, and its central observation was correct:
**four of the five pieces already existed in jovi-mall.** What was missing was doors.

Four facts, measured against source rather than assumed, shaped every decision below.

### F-1 · jovi-mall's file listing is already admin-aware, and is unreachable

`FileManagementController.listFiles` carries the comment `// Admins: no owner filter (see
all files)` and does exactly that: every non-admin role is scoped to its own
`ownerType`/`ownerId`, with a fail-closed `else` for an unrecognised one, and an `admin`
caller falls through to the unfiltered collection. **BR-015's claim about this is true.**

It is also **dead code on that path.** `requireAuth` has no `admin` branch — Phase 5 Part B
removed it — nothing mints a token carrying that role, and such a token falls through to a
`401` with no role entity. The listing an administrator would want has been sitting there,
correct and unreachable, since that phase.

### F-2 · The listing that exists cannot answer two of the three questions asked

`ListFilesQuerySchema` covers the filter bar. It does **not** cover:

- **usage** — *"is this file used, and by what"*. That is a join onto `file_references`,
  which `GET /api/files` does not perform.
- **the owner's NAME** — `IFile` carries `ownerType` and `ownerId`, and `ownerId` is an id
  in a different id space per owner type. Resolving it means reading `stores`,
  `agency_magazins`, `delivery_agents`, `customers` — **and, for `ownerType: 'admin'`,
  `wi_admin.admin_accounts`, a database jovi-mall cannot read at all.**

### F-3 · Uploading exists, has an administrator's limit, and has no door

`POST /api/files/upload` declares role-based ceilings including `admin: 2 GB`,
`ownerType: 'admin'` is legal throughout the file layer, and `by-type` intake is documented
as *"general media intake for EVERY role"*. The router's own header then says an `admin`
*"can no longer arrive on it at all"*. The capability was built; the door was deliberately
closed.

### F-4 · An admin upload lands in a PUBLIC tree

Verified, because the blog half of the request depends on it and BR-015 asked for a
definitive answer. `uploadFiles` runs `folder: 'by-type'`; `resolveTypeFolder` maps every
`MediaCategory` onto one of `images` · `videos` · `audio` · `documents` · `archives` ·
`other`; `storage-trees.ts` classifies **all six `public`**. So an administrator's blog
cover resolves `access: 'public'` with a real URL. **The blog half closes.**

---

## D-1 · The media library is a DIRECT READ of `jovi_mall`

**Decision.** `GET /api/v1/files/library` queries `files` and `file_references` in the
shared database, from wi-admin, with no hop.

This is ADR-009 D-1 / ADR-011 D-1 applied rather than an exception to it: *delegate a read
whose answer is a **verdict** the platform acts on; read directly a read whose answer is a
**record**.* A file row and a reference row are records. There is no verdict anywhere on
this surface.

It is also the only shape that works. Delegating would have meant building this query **in
jovi-mall**, with a single caller — and F-2 says the `admin` owner name still could not have
been resolved there, so the answer would have had to come back to wi-admin to be completed
anyway. A second endpoint in the wrong service that still cannot finish the job is not a
delegation, it is a detour.

**Consequence worth stating:** the library keeps working while jovi-mall is down. That is a
side effect rather than a goal, and `docs/api/files.md` documents it because a client's
error handling should know which routes on this mount fail together.

### Alternatives rejected

| | Why not |
|---|---|
| Delegate to a new jovi-mall endpoint | Its only caller would be this service, for a read with no invariant — and it cannot resolve an administrator's name (F-2) |
| Re-open `GET /api/files` to an admin session | Structurally impossible — F-1. There is no such session |
| Extend `POST /files/resolve` with a `?search=` | It **resolves an explicit id set and must never enumerate**. That property is what makes it grantable to every tier |

---

## D-2 · Upload is a STREAM PROXY, and the no-multipart rule is narrowed, not abandoned

**Decision.** `POST /api/v1/files/upload` pipes the caller's **raw, unparsed**
`multipart/form-data` body through to a new jovi-mall internal route, which stamps
`ownerType: 'admin'` and `ownerId` from `X-Actor-Id`.

The contract said, twice, *"wi-admin accepts no multipart bodies anywhere."* The amended
rule is:

> **wi-admin never *parses* a multipart body.**

That is not word-play, it is the property the original sentence was protecting. wi-admin
holds **no `multer`, no `busboy`, and gained no npm dependency**. `express.json` and
`express.urlencoded` are content-type gated, so a multipart request matches neither and
arrives with the socket unread — which is exactly what makes it pipeable.

**The 1 MB body limit is likewise untouched**: it belongs to `express.json`, which never
sees this request. That is *why* the route declares a ceiling of its own (D-4) — without one
there would be no limit on this path at all.

### Alternatives rejected

**Option 1, the upload ticket** — wi-admin mints a short-lived single-use credential and the
browser posts bytes directly to jovi-mall. BR-015 preferred it, and its argument was the
strongest of the three: it upholds D-6 rather than reversing it. Rejected on three counts:

- it is **a second authentication scheme**, minted here and verified there, for one
  endpoint — with a single-use store, a clock both services must agree on, and a new
  **unauthenticated jovi-mall route that accepts bytes on production of a bearer string**;
- it puts the dashboard on **two origins**. The dashboard talks to this service and to
  nothing else, by design (`README.md`, first line);
- **its audit row would be a lie.** wi-admin would record *"a ticket was minted"*, and a
  minted ticket never used is indistinguishable in the trail from one that was.

**Option 3, re-open jovi-mall's public upload to an `admin` session** — BR-015 called this
undesirable. It is **structurally impossible** (F-1), and the response document says so:
there is no `admin` session to re-open it to.

---

## D-3 · wi-admin builds public URLs itself — ⚠ this REVERSES ADR-009 D-6

**Decision.** `FileDetail.url` on the library is constructed **in this service**, from a
verbatim copy of jovi-mall's storage-tree classification and from `STORAGE_PROVIDER` /
`STORAGE_LOCAL_URL` configured here under **identical variable names**.

ADR-009 D-6 says *"wi-admin has no storage layer and must not grow one — copying it would
duplicate `STORAGE_PROVIDER` configuration across two services."* Every previous file
feature upheld it: the resolve delegates, and even the byte proxy at `GET /:fileId/content`
was argued as upholding it, because a proxy holds no bucket name and no signing key.

**This is the first thing on this service that holds storage configuration, and the owner
chose it knowingly.** The alternative was one batched `POST /files/resolve` hop per page of
a browse screen — a second round trip on every keystroke of a picker's search box, to
recompute a string concatenation from a key wi-admin has already read.

**What D-6 was protecting was never the arithmetic.** For `local` a URL *is* a
concatenation. It was **two copies of one configuration in two deployments, drifting
silently.** So the reversal is bounded by D-5's containment, and by two limits worth stating
plainly:

- this service still holds **no bucket, no credential, no signing key**, and cannot read or
  write an object. It can compute a URL for a key it has already read, and nothing more;
- **only two of the three implemented providers are reproduced** — `local` and `firebase`.
  `cloudinary`'s URL comes from the SDK's own builder, which infers a resource type from the
  key and injects transformation segments; reimplementing that from outside is guesswork
  that would be right for images and quietly wrong for video and raw. Under `cloudinary`
  every `url` is `null` and `meta.publicUrlsConfigured` is `false`. **A plausible-looking
  wrong URL is worse than no URL**, because it is indistinguishable from a working one until
  somebody clicks it.

⚠ **`STORAGE_LOCAL_URL` is now a SIXTH value shared across a service boundary**, and like
the other five **nothing compares the two sides, so a mismatch is silent.** It fails no
boot and logs nothing; it produces URLs that 404 on a screen full of thumbnails, which reads
as *"the files are gone"*. The names were deliberately kept **identical** on both sides —
the lesson already written down when `GEO_TRACKER_ADMIN_TOKEN` was given a matching name, on
the grounds that a new shared value should not also be a new name to remember.

---

## D-4 · The upload's constraints are declared here, not inherited

**Decision.** `ADMIN_UPLOAD_MAX_BYTES` — **32 MiB, the whole request body** — is enforced by
wi-admin, before the hop. The accepted MIME list and the file-count cap are **published**
and enforced by jovi-mall's pipeline.

BR-015 asked for this explicitly: *"a 2 GB limit is jovi-mall's per-role figure; whatever
wi-admin's is, please state it."*

jovi-mall's 2 GB is keyed on a **session role**, and it does still resolve on this path —
`requireAdminCaller` fabricates `role: 'admin'`, so the lookup hits the `admin` entry rather
than the customer fallback. **That was checked rather than assumed**, because the failure
mode of the fallback is silent: a 100 MB ceiling that only bites on a large file. It is a
backstop and never the binding limit.

32 MiB is sized for what an administrator actually uploads. jovi-mall's own upload policy
caps an image at 10 MB and a PDF at 25 MB, so this is the largest artefact it will accept
plus multipart framing, and no more.

**The split between enforced and published is forced by D-2** and is stated rather than
hidden: a service that does not parse the body cannot see a part boundary, a field name or
a per-part content type. It can count bytes, and it does — **twice**, on `Content-Length`
when the client sends one and on the bytes as they flow when it does not, because a chunked
upload declares no length and a ceiling that only reads a header is one any client can opt
out of.

The MIME list is deliberately **not** an environment variable. A deployment-tunable
allowlist here would let an operator advertise a type jovi-mall then refuses — a refusal no
client could explain.

---

## D-5 · The containment L-3 requires — three mechanisms, and none of them implies another

D-3 creates a second copy of a classification whose failure is **invisible**: a tree
reclassified in jovi-mall and not here makes this service publish a **public URL for a
private file** — a delivery-proof photograph or a vendor's saleable digital product,
fetchable by anyone holding the link, forever. That is precisely the defect ADR-A01 D-2
closed on the other side, reintroduced in a service whose whole audience is administrators,
and **nothing about the resulting URL would look wrong.**

| Mechanism | What it proves | What it does NOT prove |
|---|---|---|
| **Verbatim copy** with a `── COPIED VERBATIM from jovi-mall ──` header naming the source | Where the data came from | That it is still current |
| **`test:files` § 8** re-reads jovi-mall's `storage-trees.ts` from disk and diffs both directions | The two **sources** agree | That this service's construction matches |
| **`verify:files` § 6** resolves real ids through jovi-mall's own `POST /files/resolve` and asserts `url` and `access` are byte-identical | The two **answers** agree | Nothing about a tree neither side exercises |

The middle row is modelled on `test:data-access` § 2's `COLLECTIONS` check deliberately —
same shape, same failure mode, same reasoning. **Neither the second nor the third implies
the other**: a correct tree map with a wrong `STORAGE_LOCAL_URL` passes the diff and fails
the parity check; a matching URL for a tree both sides misclassify passes the parity check
and fails the diff.

Two behavioural rules complete it:

- **Fail closed.** An unrecognised tree is **private** ⇒ `url: null`. A stale copy then
  degrades in the safe direction: a missing image rather than a published private file.
- **A provider that cannot be reproduced faithfully yields `null` plus one logged warning**,
  never a plausible-looking wrong URL.

All three mechanisms were **perturbation-tested** on 2026-08-25 rather than assumed: flipping
a tree turns two assertions red, spreading the raw database row into the DTO turns three red,
and replacing the escaped search builder with a bare `new RegExp` turns one red. A drift
check that passes because it compares an empty set to an empty set is a failure mode this
repository has already been bitten by.

---

## D-6 · The library is NOT audited; the upload is

**Decision.** `files.library.read` records nothing. `files.upload` is audited, fail-closed
on the intent.

The upload needs no argument: it is a write, and every write on this service is audited.
What is worth recording is **why the row matters more than most** — jovi-mall stamps the
file `ownerId: <X-Actor-Id>`, an id in *this* service's database that jovi-mall can never
dereference, and it audits nothing on its own side because it authenticates a **service**,
not a person. This row is the only record of who uploaded the file. Same reasoning as
ADR-020 D-5.

**The library is the interesting half, and the dashboard argued for the opposite.** Their
case, in their words: this route discloses something the other four cannot — **it
enumerates** — and *"the caller already holds the id"*, the reasoning that makes
`files.resolve` safe at every tier, *"does not survive a listing."*

That is correct as far as it goes, and it was declined on two grounds:

1. **ADR-006 D-5's exception test is the disclosure itself, not the shape of the query.**
   The four audited reads on this platform — a payout destination, a live position, a
   tracking trail, a file's bytes — all pass *"the output IS the disclosure"*. A filename, a
   size and an owner do not.
2. **`files.orphans.read` already enumerates on this mount, unaudited**, and has since Phase
   5 Part B. Auditing the library and not the orphan listing is an inconsistency nobody
   could state. Auditing both puts a row in the compliance trail every time an operator
   pages a media picker — more rows in a minute than the four real disclosures produce in a
   week, which **dilutes** a record whose value depends on being sparse.

⚠ **Adding it later is purely additive** — a catalogued action and one line on the route. No
shape changes and nothing to undo first. The decision is recorded here, and in
`docs/api/files.md` in the dashboard's own terms, so it can be **revisited rather than
rediscovered**.

---

## D-7 · The reference sample is capped, and the cap is on the wire

**Decision.** `usage.referenceCount` is the true total; `usage.references` holds at most
**5**; `meta.referenceSampleCap` states the cap on every response.

BR-015 asked for exactly this, and its reasoning is the record: *"a stock photo on 400
products must not put 400 rows in one file's cell. A `referenceCount` with a truncated
`references` array is the right answer; a page that quietly drops the rest is not."*

The cap travels **unconditionally**, not only when truncation occurred, because a client
needs it to know the shape is possible at all. ADR-005 D-13 forbids a silent truncation, and
a capped array with no declared cap is one.

The `entityType`/`entityId` filter carries the same discipline at 500 ids, with
`meta.entityFilterTruncated` when it bites — the `STORE_SEARCH_CAP` precedent.

`usage.references[].label` is **`null` on every row**, which the dashboard asked for:
*"`null` is fine and expected — we render the id. Do not add a lookup per entity type if it
is expensive."* It would be — twelve entity types, each a different collection with its own
projection — and the field exists so the shape need not change the day one is worth paying
for.

---

## What was NOT changed

- **geo-tracker.** Untouched. It has no interest in a stored file.
- **jovi-mall's `POST /api/files/upload` response shape.** It answers raw `File` rows with no
  `url`. wi-admin builds the `FileDetail` locally (D-3) rather than changing a response that
  every vendor, agency, agent and customer upload on the platform already receives.
- **`FileManagementController.listFiles`.** Left exactly as it is. It is unreachable by an
  administrator (F-1) and reachable and correct for everyone else.
- **The `ownerId` id-space mismatch in jovi-mall.** Its upload stamps `ownerId` from
  `role_entity._id` (a `customers._id` for a customer) while its own listing scopes a
  customer by `users._id` — so a customer cannot list their own uploads there. **Observed
  and not fixed**: it is jovi-mall's bug on jovi-mall's surface, it is invisible from this
  one, and the library reads the value the uploader actually wrote. Recorded so the next
  person to touch that path does not rediscover it.

---

## The known gap

**Nothing anywhere exercises the upload round trip.** `verify:files` sends JSON, so
exercising the proxy needs a multipart client and bytes jovi-mall's sniffing pipeline will
accept as an image. Everything this service owns about the route is asserted offline — the
content-type gate, the byte ceiling, the audit spec, the declared limits and the absence of
a body schema — but **the first real upload is the first proof the proxy streams
correctly.** Stated here rather than left to be discovered.
