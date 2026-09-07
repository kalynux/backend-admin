# BR-015 · A media library, and an upload path for administrators

**Priority: high.** It blocks five separate asks at once, and **four of the five pieces already
exist in jovi-mall** — what is missing is the doors.

## The ask

> We need a **Media** menu (with the orphan-file screen folded into it as a submenu) showing all
> the images in the system — the full file details, the owner (name and role), and whether the
> file is used or linked to an entity.
>
> A **media dialog** is needed as a picker in four places: the blog's image block, the blog's
> cover image, the ticket-attachment form, and anywhere an image must be chosen rather than
> resolved. **The picker must offer only files uploaded by the administration.**

Downstream of it, and blocked by it:

| Screen | What it needs the picker for |
|---|---|
| Blog → article body → `image` block | `url`, `width`, `height` for a block the editor cannot type by hand |
| Blog → cover image | Same three fields. **There is no cover editor at all today** — the field is rendered read-only because nothing can produce a URL |
| Support → ticket → Attachments | `POST /support/tickets/:ticketId/attachments` takes a `fileId` of an **already-uploaded** file. An operator has no way to produce one |
| Media menu | The listing itself |

---

## What exists today

**On wi-admin: nothing that lists files, and nothing that uploads.**

The `/files` mount is five routes and every one of them starts from an id the caller already
holds — `?ids=`, `/:fileId`, `/:fileId/content` — plus `/orphans`, which is the inverse listing
(files nothing refers to) and is not a library. `files.md` states the rule the mount was built
on, and we are not asking to break it:

> `/resolve` **resolves an explicit id set and cannot enumerate** … It must never become a
> `GET /files` that enumerates the collection.

That rule is right, and the same page already states the shape of the exception:
**"a listing on this mount needs its own permission and its own tier"** — which `files.orphans.read`
already demonstrates. This request is a second listing under that same rule, not a widening of
`files.resolve`.

**Uploads: `README.md` and `files.md` both state it flatly** — *"wi-admin accepts no multipart
bodies anywhere"*, body limit 1 MB. So the picker, as specified, would be **permanently empty**:
no administrator has ever been able to upload anything through this service.

---

## What already exists in jovi-mall — this is the important half

### 1 · The listing exists, and it is already admin-aware

`src/api/routes/file-upload.routes.ts` → `GET /api/files`, handled by
`FileManagementController.listFiles`. Its own comment:

```ts
// Admins: no owner filter (see all files)
```

Every non-admin role is scoped to its own `ownerType`/`ownerId`, with an explicit fail-closed
`else` for an unrecognised role. An `admin` caller falls through to the unfiltered collection —
**exactly the Media menu's requirement, already implemented.**

`ListFilesQuerySchema` (`src/api/validators/file-management.validator.ts`) is already the shape
this dashboard's filter bar wants:

| Parameter | Values |
|---|---|
| `page` / `limit` | limit max **50** — ⚠ *narrower than wi-admin's 100* |
| `search` | case-insensitive substring on `originalName` |
| `mimeType` | exact |
| `category` | `image` · `video` · `audio` · `document` · `archive` · `other` |
| `provider` | `local` · `s3` · `gcs` · `r2` · `firebase` · `cloudinary` |
| `ownerType` | `vendor` · `admin` · `customer` · `agent` · `agency` · `system` |
| `minSize` / `maxSize`, `createdAfter` / `createdBefore` | |
| `sortBy` | `createdAt` · `updatedAt` · `size` · `originalName` (+ `sortOrder`) |

### 2 · The owner is on the file record

`IFile` (`src/modules/catalog/models/file.model.ts`) carries `ownerType` and `ownerId`, *"set
once on upload, never mutated"*. `FileOwnerType` includes **`admin`** and **`system`** — so
"uploaded by the administration" is a filter on data that already exists, not a new concept.

⚠ **`ownerId` is an id, not a name.** The Media menu's "owner (name, role)" needs the role from
`ownerType` and the *name* resolved per owner type — see the ask below.

### 3 · "Is it used, and by what" is already modelled

`IFileReference` (`src/modules/catalog/models/file-reference.model.ts`) is *"the single source of
truth for what references this file"* — one live row per `(fileId, entityType, entityId, field)`,
with a `{ fileId, deletedAt }` index put there for exactly this query. `entityType` is a
twelve-value union: `product`, `variant`, `digital_asset`, `ticket`, `vendor`, `store`, `agency`,
`agency_magazin`, `customer`, `agent`, `admin`, `shipment`.

`File.orphanedAt` is maintained by the same layer — non-null means the live reference count is 0.

### 4 · Upload exists, and it already has an administrator's limit

`POST /api/files/upload` (same router) declares role-based per-file size limits, and the list
includes **`Admin: 2 GB per file`**. `ownerType: 'admin'` is a legal value throughout the file
layer.

⚠ **But an administrator can no longer reach that router.** Its header says so:

> this surface is the one a vendor, agency, agent or customer session reaches, and an `admin`
> role can no longer arrive on it at all.

So the capability is built and the door was deliberately closed at Phase 5 Part B. **We are asking
for the door, not the capability.**

---

## What we are asking for

### A · `GET /api/v1/files/library` — the listing

A **new permission**, not `files.resolve`. It enumerates, so by the mount's own rule it gets its
own name and its own tier.

| | Proposed |
|---|---|
| **Path** | `GET /api/v1/files/library` — a literal segment declared before `/:fileId`, as `/orphans` already is |
| **Permission** | `files.library.read` |
| **Tiers** | **1 · 2.** Support does not enumerate files — the same line `files.orphans.read` draws |
| **Transport** | Delegated, like every other route on this mount |
| **Audited** | ⚠ **Our recommendation: yes.** See the note below |

**Query** — jovi-mall's `ListFilesQuerySchema` passed through, plus:

| Parameter | Why |
|---|---|
| `ownerType` | Already exists. **The picker sends `ownerType=admin`** — this one parameter is what makes "only files uploaded by the administration" true |
| `usage` | `used` · `unused` — derived from `orphanedAt`, so the Media menu can answer "what is not attached to anything" without being the orphan screen |
| `entityType` / `entityId` | Optional: "what files does this ticket use". Backed by the existing `{ entityType, entityId, deletedAt }` index |

⚠ **`limit` is 50 at jovi-mall and 100 everywhere on wi-admin.** Please state which wins on this
route rather than leaving the client to discover it — we will honour whichever you declare.

**Row shape** — `FileDetail` (the type this dashboard already has), plus:

```jsonc
{
  "id": "6612a4f0c1a2b3d4e5f60718",
  "key": "images/2026/08/1f2e3d_logo.png",
  "url": "https://cdn.example.com/…",
  "access": "public",
  "mimeType": "image/png",
  "size": 48213,
  "originalName": "shop-logo.png",
  "createdAt": "2026-08-11T09:14:00.000Z",

  "owner": {
    "type": "admin",
    "id": "6511aabbccddeeff00112233",
    "name": "Ada Mensah"
  },

  "usage": {
    "referenceCount": 2,
    "references": [
      { "entityType": "ticket",  "entityId": "6680…", "field": "attachments", "label": "TCK-2026-0413" },
      { "entityType": "product", "entityId": "6660…", "field": "media",       "label": "Plantain — 1 kg" }
    ]
  }
}
```

| Field | Notes |
|---|---|
| `owner.name` | **The ask names this explicitly.** `null` where the owner type has no resolvable name (`system`), or where the record is gone — `null`, never `""`, never the id substituted silently |
| `owner.type` | The `FileOwnerType` value verbatim. ⚠ Please keep it **open** on our side — we will render an unrecognised value rather than reject it |
| `usage.referenceCount` | Live rows only. `0` is what the Media menu shows as "not attached" |
| `usage.references` | ⚠ **Cap it and say so in `meta`** — a stock photo on 400 products must not put 400 rows in one file's cell. A `referenceCount` with a truncated `references` array is the right answer; a page that quietly drops the rest is not |
| `usage.references[].label` | Best-effort human handle. **`null` is fine and expected** — we render the id. Do not add a lookup per entity type if it is expensive; the count and the type already carry most of the value |

> ### ⚠ Why we think this read should be audited
>
> `files.content.read` is audited because *"the output is the disclosure"*. This route discloses
> less per row — metadata, not bytes — but it discloses something the other four cannot:
> **it enumerates.** The argument that makes `files.resolve` safe for every tier is that a caller
> already holds the id and a 24-hex id is unguessable. That argument does not survive a listing.
>
> We are not asking for a `reason` prompt — this is a browse surface and a per-page box becomes
> one somebody types "media" into forever, which is the same judgement you made on
> `files.content.read`. An unattributed row per listing seems right; the decision is yours.

### B · `POST /api/v1/files/upload` — or a delegated equivalent

**This is the piece that has a real design decision in it, and we are not assuming the answer.**

The constraint is stated twice in the contract and we take it as binding: *wi-admin accepts no
multipart bodies anywhere, body limit 1 MB.* We can see three shapes and have a preference:

| | Shape | What it costs |
|---|---|---|
| **1** ⭐ | **wi-admin mints a short-lived, single-use upload ticket; the browser posts the bytes to jovi-mall.** `POST /api/v1/files/upload-ticket` returns `{ uploadUrl, token, expiresAt, maxBytes, allowedMimeTypes }`; jovi-mall gains an internal route that accepts the ticket, stamps `ownerType: 'admin'`, `ownerId: <adminId>`, and answers the created `FileDetail` | wi-admin keeps its no-multipart rule intact and owns no storage configuration — **ADR-009 D-6 upheld, not reversed**, exactly as the content stream upheld it. Costs one new concept: the ticket |
| **2** | **wi-admin proxies the multipart body through**, as it already proxies the content stream in the other direction | Reverses the no-multipart rule and the 1 MB body limit, on a service whose whole shape argues against it. We would not choose this |
| **3** | **Re-open jovi-mall's `POST /api/files/upload` to an `admin` session** | Cheapest, but it re-opens a door Phase 5 Part B deliberately closed, and it puts an administrator back on the surface *"a vendor, agency, agent or customer session reaches"*. We would not choose this either |

Whichever you pick, the pieces we need from it are the same:

| | |
|---|---|
| **Permission** | `files.upload` — a new name. Tier **1 · 2** |
| **Audited** | **Yes.** It creates a record and it is a write; every other write on this service is audited |
| **Result** | The created `FileDetail` — `id`, `url`, `access`, `mimeType`, `size`, `originalName`. ⚠ **We need `url` back on the same response**, because the blog cover and image block store a URL, not an id |
| **Constraints declared, not discovered** | Max bytes and the accepted MIME list, in the response or in the docs. A 2 GB limit is jovi-mall's per-role figure; whatever wi-admin's is, please state it |

⚠ **The blog needs `access: "public"`.** An article's `cover.url` and an `image` block's `url` are
stored strings served to anonymous readers, so a file in a private tree is unusable there —
`url` is `null` and always will be. **Please say which tree an admin upload lands in**, and if it
is configurable, how the caller asks for a public one. If admin uploads can only land private,
the blog half of this request does not close and we need to know that before building the picker.

### C · The dimensions problem — for information, no action needed

`ArticleBodyImageSchema` and `CoverSchema` both require `width` and `height` as positive
integers, and `FileDetail` carries neither. **We will read them client-side** from the loaded
image's `naturalWidth`/`naturalHeight` before saving the block. That works and needs nothing from
you — recorded here so it is not mistaken for an oversight, and so that if `File` ever grows
image dimensions we know to stop guessing.

---

## What the dashboard will do while this is open

| Piece | Interim |
|---|---|
| Media menu | **Built, but partial.** The orphan screen moves under it unchanged. The library tab renders an explicit "this needs `GET /files/library`" state naming this request — not an empty table, which reads as "there are no files" |
| Media picker | **Not built.** A picker with nothing to offer is worse than no picker |
| Blog image block | Stays a URL field with validation against `ImageUrlSchema`, and says the picker is coming |
| Blog cover | ✅ **A cover editor ships now** — `PATCH /content/articles/:articleId` already accepts `cover`, so url + width + height become editable immediately. Only the *picker* waits |
| Ticket attachments | Stays a file-id field. The **preview ships now** — a chosen id resolves through `GET /files/:fileId` and displays through `GET /files/:fileId/content`, so an operator can see what they are about to attach even though they cannot browse for it |

**Nothing is mocked and no shape is invented.** Every field named above is one we can point at in
jovi-mall's source today.
