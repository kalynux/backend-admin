# `/files` — resolving a file id, opening one, browsing them all, and the housekeeping pair

Seven routes, five jobs.

**Resolution** — turning a `*FileId` this service already handed you into something you
can render. Added in the dashboard-request round to close gap **D2**.

**Content** — the bytes themselves, for any file including the private ones a resolve
cannot give a URL for. Added at BR-011.

**The media library** — every file on the platform, with its owner's *name* and what
refers to it. Added at BR-015, and it is the **media picker's** source: `?ownerType=admin`
is the one parameter that makes *"only files uploaded by the administration"* true.

**Upload** — putting a file on the platform as the administration. Added at BR-015, and it
is the first write path for files this service has ever had.

**Housekeeping** — finding uploads no record refers to, and destroying them. Added at
Phase 5 Part B, moved off jovi-mall's public `/api/files` router where they had been its
only two admin-only routes.

| Method | Path | Permission | Tiers | Transport | Audited |
|---|---|---|---|---|---|
| GET | `/api/v1/files?ids=…` | `files.resolve` | 1 · 2 · 3 | delegated | No |
| GET | `/api/v1/files/library` | **`files.library.read`** | 1 · 2 | **direct read** | No |
| POST | `/api/v1/files/upload` | **`files.upload`** | 1 · 2 | **stream proxy** | ✅ Yes |
| GET | `/api/v1/files/orphans` | `files.orphans.read` | 1 · 2 | delegated | No |
| GET | `/api/v1/files/:fileId` | `files.resolve` | 1 · 2 · 3 | delegated | No |
| GET | `/api/v1/files/:fileId/content` | **`files.content.read`** | 1 · 2 · 3 | delegated (stream) | ✅ **audited read** |
| DELETE | `/api/v1/files/:fileId/permanent` | `files.delete` | **1 only** | delegated | Yes |

> ### ⚠ This page used to say "every one of them is delegated to jovi-mall". That is no longer true.
>
> BR-015 added the two transports that are firsts on this mount, and a client has to know
> which is which because they fail differently:
>
> | Transport | What it means | What an outage of jovi-mall does |
> |---|---|---|
> | **delegated** | wi-admin calls jovi-mall's internal admin API and forwards the answer | `503 SERVICE_DEPENDENCY_UNAVAILABLE` |
> | **direct read** | wi-admin queries the `jovi_mall` database itself. No hop | **Still works.** The library is readable while jovi-mall is down |
> | **stream proxy** | wi-admin pipes your raw request body through to jovi-mall, unread | `503`, same as delegated |
>
> The library is a **direct read** because its answer is a *record*, not a verdict
> (ADR-009 D-1), and because two of the three things it returns are things jovi-mall
> cannot produce: the usage join, and an owner name that for `ownerType: 'admin'` lives in
> **wi-admin's own database**. See [ADR-021](../ADR-021-ADMIN-MEDIA-LIBRARY.md) D-1.

---

## Why this exists

Every DTO on this service ships file references as opaque ids — `logoFileId`,
`avatarFileId`, `bannerFileId`, `deliveryProofFileId`, `store.logoFileId`,
`vehicle.photoFileId` — and several documents say so plainly: *"An opaque id. This service
resolves no file URLs."*

That was the rule (ADR-009 D-6): a URL is `storage.getPublicUrl(key)`, and building one here
means a second copy of the storage configuration in a second deployment. What the contract
then said, however, was that a client should resolve them *"against jovi-mall"* — which the
admin dashboard cannot do, because it talks to this service and to nothing else, by design.

So every avatar, logo, banner and delivery proof on the admin surface rendered as a
placeholder. The **resolution** routes closed that **without** reversing D-6: the resolution
is delegated to jovi-mall, where the provider is configured.

> ### ⚠ **AMENDED at BR-015 — D-6 no longer holds without qualification**
>
> **`GET /files/library` builds its own URLs**, in this service, from a copy of jovi-mall's
> storage-tree classification and the same `STORAGE_PROVIDER` / `STORAGE_LOCAL_URL`
> variable names. That reverses D-6 for exactly one route, knowingly
> ([ADR-021](../ADR-021-ADMIN-MEDIA-LIBRARY.md) D-3), because the alternative was a
> `POST /files/resolve` hop per page of a browse screen.
>
> **Every other route on this mount still delegates**, and the D-6 reasoning above is still
> the reason they do. What changed is not "this service now owns storage" — it owns no
> bucket, no credential and no signing key — but that it can now compute a public URL for a
> key it has already read.
>
> The practical consequence for you is one field in `meta`: on the library,
> `publicUrlsConfigured` tells you whether **wi-admin's** side is set up, which is a new way
> for `url` to be `null` that does not exist on the delegated routes.

---

## What a resolved file looks like

**A file in a public tree** — a vendor's logo, an avatar, product media:

```jsonc
{
  "id": "6612a4f0c1a2b3d4e5f60718",
  "key": "images/2026/08/1f2e3d_logo.png",
  "url": "https://cdn.example.com/images/2026/08/1f2e3d_logo.png",
  "access": "public",
  "mimeType": "image/png",
  "size": 48213,
  "originalName": "shop-logo.png"
}
```

**A file in a private tree** — a delivery proof, a digital product. **This is the normal
answer for those files, not a fault:**

```jsonc
{
  "id": "6612a4f0c1a2b3d4e5f60719",
  "key": "shipments/2026/08/9c8b7a_proof.jpg",
  "url": null,
  "access": "authorized",
  "mimeType": "image/jpeg",
  "size": 214880,
  "originalName": "proof-6670.jpg"
}
```

| Field | Notes |
|---|---|
| `id` | The id you asked with. Key your own map on this — see the ordering note below |
| `key` | The storage path. Diagnostic; do not build a URL from it |
| `url` | **`string \| null`.** The publicly fetchable URL when `access` is `public`, built from the active `STORAGE_PROVIDER` — by jovi-mall on every route here except `GET /files/library`, which builds it itself (BR-015 · ADR-021 D-3) and is proved byte-identical by `verify:files`. **`null` whenever `access` is `authorized`** — see below |
| `access` | **`"public" \| "authorized"`.** A closed set of two. `authorized` means the file lives in a private storage tree, there is no URL to hand you, and `id` is the only handle |
| `mimeType` | **Check it before rendering an `<img>`.** A public tree legitimately holds videos and spec sheets, and product media does |
| `size` | Bytes |
| `originalName` | What the uploader called it. **May be absent** — the one optional field |

### `url: null` is an answer, not an error

jovi-mall classifies every storage tree as public or private
(`core/storage/storage-trees.ts`, ADR-A01 D-2) and builds every `FileDetail` on the platform
through one function, so this holds on **every** route that returns one — here, and inside
every DTO that embeds a resolved file.

A private tree is not served by jovi-mall's static mount, so there is no public URL to
build. `null` rather than an authorized route's path is deliberate: a path would be a string
indistinguishable from a working URL, and every client would keep rendering it and silently
show nothing.

**The two private trees an administrator meets constantly:**

| Tree | Holds | Resolves as |
|---|---|---|
| `shipments/` | delivery-proof photographs | `url: null`, `access: "authorized"` |
| `digital/` | digital product files | `url: null`, `access: "authorized"` |

A client that treats this as a failure shows a broken-image icon on **every delivery proof in
the system**. Render the metadata and say the file cannot be displayed.

### Both conditions before an `<img>`, not either

```ts
const displayable = file.access === 'public' && file.url !== null
                 && file.mimeType.startsWith('image/');
```

`access` alone is not enough — a public tree holds PDFs and video. `url !== null` alone is
not enough either, for the same reason.

**To DISPLAY a private file, use [`GET /api/v1/files/:fileId/content`](#get-apiv1filesfileidcontent)**
— it streams the bytes for any file, private trees included, and is the only way to see one.
`url` remains `null` for those files and always will; the content route is a different
mechanism, not a URL this endpoint could have returned.

### ⚠ Support-ticket attachments are public, and permanently so

An attachment is an ordinary upload: it lands in `documents/` or `images/`, both **public**
trees, and is attached to the ticket by id afterwards. So it resolves with a real, working
URL — and that URL is **unauthenticated and does not expire**. Anyone who has the link can
fetch the file, indefinitely, with no session.

This is a property of how attachments are stored rather than a decision made about them:
`storage/ticket-attachments/` is classified private but **nothing writes it**, and making
attachments private cannot be done by moving a directory — it needs a dedicated
ticket-attachment upload path, which is its own decision.

**Treat an attachment URL as a shareable secret.** Do not paste one into a channel that
outlives the ticket.

---

## `GET /api/v1/files`

Batch resolution — the form a list screen wants.

| | |
|---|---|
| **Permission** | `files.resolve` — held by **every** tier |
| **Transport** | Delegated |
| **Audited** | No |

### Query

| Parameter | Type | Rules |
|---|---|---|
| `ids` | string | **Required.** Comma-separated 24-hex ids, **1–100**. `?ids=6612…,6613…` |

One documented separator rather than repeated `?ids=`, because Express parses
`?ids=a&ids=b` as an array and `?ids=a` as a string, so every consumer would have to
normalise.

**100 is the same ceiling `limit` has everywhere on this service.** A caller can therefore
always resolve a whole page of rows in one request, and can never ask for more than a page.

### Response `200`

```jsonc
{ "success": true, "data": { "files": [ /* FileDetail */ ] } }
```

> ### ⚠️ The response may be shorter than the request, and is not in request order
>
> An id that resolves to nothing is **absent**, not present-and-null. Files are
> soft-deleted and swept by jovi-mall's file-cleanup, so a record legitimately outlives the
> picture it points at — a vendor whose logo was swept still has a `logoFileId`. That is a
> state to render (initials, a placeholder), not an error.
>
> **Key the result by `id`.** Do not zip it against your request array.

### Errors

`400 VALIDATION_ERROR` — no ids, more than 100, or one that is not 24-hex.

---

## `GET /api/v1/files/:fileId`

The single form, for a detail screen.

| | |
|---|---|
| **Permission** | `files.resolve` |
| **Transport** | Delegated |
| **Audited** | No |

### Response `200`

The `FileDetail` object itself, not wrapped in `files`.

### Errors

| Status | Code | When |
|---|---|---|
| 404 | `FILE_NOT_FOUND` | The id resolved to nothing |

**Unlike the batch form, this one raises.** The difference is what the caller can do about
it: a list renders the rows it got and shows a placeholder for the rest, while a caller
that asked for exactly one file and got an empty object cannot tell "gone" from "the field
was empty" without a second branch.

---

## `GET /api/v1/files/:fileId/content`

**The bytes.** The only way to display a file in a private tree, and the answer to
[BR-011](../dashboard/backend-requests/BR-011-admin-image-viewing.md).

| | |
|---|---|
| **Permission** | **`files.content.read`** — its own name, held by tiers 1 · 2 · 3 |
| **Transport** | Delegated — **this service streams jovi-mall's response through** |
| **Audited** | ✅ **Yes, fail-closed** — the row commits *before* the bytes are fetched |
| **`reason` required** | No |

### Response `200`

**Raw bytes — this is the one route on this service that does not answer an envelope.**

| Header | Notes |
|---|---|
| `Content-Type` | jovi-mall's, verbatim. It is the authority on what the bytes are; do not infer from the extension |
| `Content-Length` | Forwarded when jovi-mall sends it. **Check it** — see the truncation note below |
| `Content-Disposition` | `inline; filename="…"`, so a browser displays rather than downloads |
| `Cache-Control` | `private, no-store` |

### Errors

| Status | Code | When |
|---|---|---|
| 404 | `FILE_NOT_FOUND` | No such file, or it was swept |
| 409 | `FILE_CONTENT_NOT_SUPPORTED` | **This deployment's storage provider cannot read file bytes.** Not an outage — see below |
| 502 / 503 | `SERVICE_DEPENDENCY_UNAVAILABLE` | jovi-mall unreachable |

### It answers for **any** file, and that is deliberate

Public trees included. A public file streams exactly the same way, so the dashboard needs
**one code path** and never has to branch on `access` to decide which call to make. It is
also the more private choice for a public file: the `url` from a resolve is
unauthenticated, and this is not.

⚠ **`digital/` is included too**, which means an administrator can retrieve a vendor's
saleable product file. That is the decided scope — an operator resolving a dispute about a
digital sale needs to see what was sold — and it is a large part of why this read is
audited.

### Bytes, not a signed URL — and what that means for the client

BR-011 proposed a short-lived signed URL. **Streaming was chosen instead**, because the
configured storage provider (`local`) has no signing primitive at all: minting one would
mean inventing a signing scheme *and* standing up a new unauthenticated route serving
private bytes to anyone holding the link for its lifetime. That is a smaller copy of the
hole the private-tree split was written to close.

**The practical consequence: a bare `<img src>` will not work**, because the request needs
the caller's bearer token and an `<img>` tag cannot carry one. Fetch it and make an object
URL:

```ts
const response = await api.get(`/files/${fileId}/content`, { responseType: 'blob' });
const objectUrl = URL.createObjectURL(response.data);
// …render <img src={objectUrl}/>, and URL.revokeObjectURL(objectUrl) when it unmounts.
```

There is no expiry to respect and nothing to cache past — the object URL lives exactly as
long as you keep it.

### `FILE_CONTENT_NOT_SUPPORTED` is a configuration state, not an incident

jovi-mall can read bytes on the `local` storage provider and **not** on `firebase` or
`cloudinary`. On those deployments this route answers `409` for *every* file, permanently,
until `STORAGE_PROVIDER` changes.

**Render it as "this platform cannot display private files", not as an error.** A retry
button here will never succeed, and an "something went wrong" banner sends an operator
hunting an outage that is not happening. `details.platformCode` carries jovi-mall's own
`STORAGE_DOWNLOAD_NOT_SUPPORTED` for anyone who wants the origin.

### ⚠ A mid-stream failure cannot become an error status

Once the first byte is sent the status line is already committed, so a failure after that
point closes the connection instead of answering a 5xx — the client sees a **truncated
body**, not an error. That is why `Content-Length` is forwarded: compare it against what
you received before treating a short image as a corrupt one.

Everything that can fail cleanly — the 404, the provider check, the audit write — happens
before any byte moves.

### Why it is audited, and why no `reason`

Three reads on this service were audited before this one, and all three for the same
reason: **the output is the disclosure.** A payout destination reveals a bank account; a
live position reveals where a person is; a trail reveals where they have been. A
delivery-proof photograph belongs on that list — it shows a location, usually a residence,
sometimes a person.

The row records **that** a file was opened, which file, and what it turned out to be
(`mimeType`, `size`). It carries **no content and no storage key**. It commits *before*
jovi-mall is asked and its failure is not caught, so with the audit store unreachable
nothing is disclosed.

**No `reason` is required**, unlike `agents/:id/live-position` and
`shipments/:id/tracking-trail`. Those answer a question an operator asks rarely and
deliberately; this one is opened repeatedly inside a single dispute, and a prompt per image
becomes a box somebody types "dispute" into forever. If that judgement turns out to be
wrong the change is additive — a required field, and clients reuse the dialog they already
have.

---

## `GET /api/v1/files/library`

**The media library**, and the picker's source. Every file on the platform, with its
owner's name and what refers to it.

| | |
|---|---|
| **Permission** | **`files.library.read`** — tiers **1 and 2**. Support does not enumerate files |
| **Transport** | **Direct read** — wi-admin queries `jovi_mall.files` and `file_references` itself. There is no hop, and this route keeps working while jovi-mall is down |
| **Audited** | **No** — and the dashboard asked for the opposite. See the note at the end of this section |
| **Pagination** | `page` / `limit`, `limit` **max 100** |

### ⚠ `limit` is 100 here — you asked which wins, and this is the answer

jovi-mall's `ListFilesQuerySchema` caps at 50. **It does not apply.** This read never
reaches that validator — nothing about this request goes to jovi-mall at all — and 100 is
the ceiling every list on this service has. Ask for up to 100; 101 is a `400`.

### ⚠ Sorting is `sort=-createdAt`, **not** `sortBy` + `sortOrder`

Every list on this service takes a single `sort` token validated against an allowlist, so
no client string ever reaches a Mongo sort document. jovi-mall's file listing uses
`sortBy`/`sortOrder`; this one does not, and the two are not interchangeable.

**This matters more than a naming difference, because getting it wrong is silent.** The
list-query schema on this service is not `.strict()`, so an unrecognised parameter is
**dropped rather than rejected** — send `sortBy=size` and you get a `200` in the default
order, with nothing anywhere saying your sort was ignored. That is a known service-wide
property and not specific to this route; it is why the form is stated here outright.

### Query

| Parameter | Type | Rules |
|---|---|---|
| `page` / `limit` | int | `limit` **1–100**, default 20 |
| `sort` | string | One of `createdAt` · `updatedAt` · `size` · `originalName`, prefix `-` for descending. Default `-createdAt` |
| `search` | string | 1–120 chars. Case-insensitive substring on `originalName`. Regex-escaped server-side |
| `mimeType` | string | Exact match. **Wins over `category`** when both are sent |
| `category` | enum | `image` · `video` · `audio` · `document` · `archive` · `other` |
| `provider` | enum | `local` · `s3` · `gcs` · `r2` · `firebase` · `cloudinary` — see the warning below |
| `ownerType` | enum | `vendor` · `admin` · `customer` · `agent` · `agency` · `system`. **`admin` is the picker's filter** |
| `minSize` / `maxSize` | int | Bytes. `minSize` must be ≤ `maxSize` |
| `createdAfter` / `createdBefore` | ISO-8601 **instant** | Must carry a zone — `2026-08-01T00:00:00.000Z`, not `2026-08-01` |
| `usage` | enum | `used` · `unused` — see the warning below |
| `entityType` / `entityId` | enum + 24-hex | *"What files does this ticket use."* **Both or neither** — one alone is a `400` |

> ### ⚠ The `provider` filter accepts six values, of which only three can ever appear
>
> BR-015's filter table lists six because that is `IFile.provider`'s **Mongoose enum** — the
> column's legal domain. Only **three** are implemented: `storage.config.ts` declares
> `local`, `firebase` and `cloudinary`, and `s3` / `gcs` / `r2` have **no provider
> implementation in jovi-mall at all**. No row can carry one unless somebody wrote it by
> hand.
>
> The filter is accepted at its widest anyway — refusing `s3` would refuse a value the
> database is schema-permitted to hold — and answers honestly: `?provider=s3` is an empty
> page because nothing is stored that way, not because the parameter was rejected.
>
> **A third number matters for `url`:** wi-admin can reproduce the public-URL form of
> **two** of the three real providers (`local`, `firebase`). Under `cloudinary` every `url`
> is `null` and `meta.publicUrlsConfigured` is `false` — see below.

> ### ⚠ `usage` is derived from `orphanedAt`, and is **not** the exact complement of `referenceCount`
>
> `unused` means jovi-mall's file-reference layer has stamped the file as having no live
> references. `used` means it has not — **which includes a file that was never attached to
> anything.** The field's own documentation says so.
>
> So a file uploaded a minute ago and not yet used reports `usage: used` and
> `referenceCount: 0` on the same row. That is not a contradiction: the filter is the
> indexed answer and the count is the precise one. **Render the count.**

### Response `200`

```jsonc
{
  "success": true,
  "data": [
    {
      "id": "6612a4f0c1a2b3d4e5f60718",
      "key": "images/2026/08/1f2e3d_logo.png",
      "url": "http://localhost:8022/api/files/images/2026/08/1f2e3d_logo.png",
      "access": "public",
      "mimeType": "image/png",
      "size": 48213,
      "originalName": "shop-logo.png",
      "createdAt": "2026-08-11T09:14:00.000Z",

      "owner": { "type": "admin", "id": "6511aabbccddeeff00112233", "name": "Ada Mensah" },

      "usage": {
        "referenceCount": 2,
        "references": [
          { "entityType": "ticket",  "entityId": "6680…", "field": "attachments", "label": null },
          { "entityType": "product", "entityId": "6660…", "field": "media",       "label": null }
        ]
      }
    }
  ],
  "meta": {
    "total": 412, "page": 1, "limit": 20, "pages": 21,
    "referenceSampleCap": 5,
    "publicUrlsConfigured": true
  }
}
```

A row is a **`FileDetail`** — the same seven fields every other file route on this service
returns, so a component that renders one renders these — plus `createdAt`, `owner` and
`usage`.

| Field | Notes |
|---|---|
| `url` / `access` | Exactly as documented at the top of this page. ⚠ On this route they are built **by wi-admin**, not by jovi-mall — see the containment note below |
| `owner.type` | The `FileOwnerType` value verbatim. **Treat it as open** — render an unrecognised value rather than rejecting it. `null` on a legacy row with no owner |
| `owner.id` | The owner's id **in its own id space** — a `vendors._id`, a `delivery_agents._id`, and for `admin` a **wi-admin `admin_accounts._id`**. Never a `users._id` |
| `owner.name` | **`null`, never `""` and never the id.** Four things produce `null` and you cannot tell them apart, deliberately, because you render them the same way: `ownerType: "system"` (which has no name by construction), a deleted role record, an owner mid-onboarding with no business name yet, and an administrator removed from this service |
| `usage.referenceCount` | Live references only, and the **true** total — never `references.length` |
| `usage.references` | **Capped at `meta.referenceSampleCap`.** See below |
| `usage.references[].label` | **`null` on every row today.** This is the built answer, not a placeholder — see below |

> ### The reference array is capped, and the cap is in `meta` — as you asked
>
> You wrote: *"a stock photo on 400 products must not put 400 rows in one file's cell. A
> `referenceCount` with a truncated `references` array is the right answer; a page that
> quietly drops the rest is not."* That is what this does.
>
> `referenceCount` is the true total; `references` holds at most
> `meta.referenceSampleCap` of them. **The cap is sent on every response, not only when
> something was truncated**, because you need it to know the shape is possible at all —
> render `referenceCount > references.length` as "and N more".

> ### `label` is `null` on every row, and that is the decision you asked for
>
> You said *"`null` is fine and expected — we render the id. Do not add a lookup per entity
> type if it is expensive."* It would be: `entityType` has twelve values, so filling the
> label means a read of a different collection per type present on the page, each with its
> own projection and its own permission question, to produce a caption.
>
> The field is on the wire so the shape does not have to change on the day one of those is
> worth paying for. **Do not treat a `null` label as an error.**

> ### `meta.publicUrlsConfigured` — so a page of `null` URLs is diagnosable
>
> `url: null` has **three** causes on this route and only one of them is about the file:
> the file is in a private tree (normal, expected), or **this deployment** has no
> reproducible `STORAGE_PROVIDER` configured on the wi-admin side, or it has one whose URL
> form wi-admin cannot reproduce (`cloudinary`).
>
> `publicUrlsConfigured: false` means the last two. Render "file previews are not
> configured on this deployment" rather than a page of broken images — the same
> `configured: false` shape the two geo-tracker doors already use, and for the same reason:
> *"not set up here"* and *"there is nothing to show"* are different answers.

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | `limit > 100`, an inverted size or date range, a date without a zone, or `entityType`/`entityId` sent without its partner |
| 403 | `AUTHZ_PERMISSION_DENIED` | Support — this permission is tiers 1 and 2 |

### ⚠ Two caps, and both are reported rather than silent

`entityType`/`entityId` resolves through `file_references` first and is capped at **500**
file ids. When it bites, `meta.entityFilterTruncated: true` and `meta.entityFilterCap: 500`
appear. ADR-005 D-13 forbids a silent truncation, so a broad answer says so.

### ⚠ Why this route is not audited, and how to push back

`files.content.read` is audited because *"the output is the disclosure"*. You argued this
route discloses something the other four cannot — **it enumerates** — and that the
"caller already holds the id" reasoning does not survive a listing. That argument is
correct as far as it goes, and it was **declined** on two grounds:

1. ADR-006 D-5's exception test is the disclosure itself, not the shape of the query. A
   payout destination, a live position, a trail and a file's bytes all pass it. A filename,
   a size and an owner do not.
2. `files.orphans.read` **already enumerates on this mount, unaudited**, and has since
   Phase 5 Part B. Auditing the library and not the orphan listing would be an inconsistency
   nobody could state; auditing both would put a row in the compliance trail every time an
   operator pages a media picker — more rows in a minute than the four real disclosures
   produce in a week, which dilutes the record rather than deepening it.

**If you still want it, say so — it is purely additive.** A catalogued action and one line
on the route; no shape changes and nothing to undo first. The decision is recorded at
[ADR-021](../ADR-021-ADMIN-MEDIA-LIBRARY.md) D-6 so it can be revisited rather than
rediscovered.

---

## `POST /api/v1/files/upload`

**Put a file on the platform as the administration.** The first write path for files this
service has ever had, and what makes the media picker non-empty.

| | |
|---|---|
| **Permission** | **`files.upload`** — tiers **1 and 2** |
| **Transport** | **Stream proxy** — wi-admin pipes your raw multipart body through to jovi-mall, unread |
| **Audited** | **Yes** — it is a write, and every write on this service is audited |
| **Max bytes** | **33 554 432 (32 MiB)**, the whole request body. Configurable as `ADMIN_UPLOAD_MAX_BYTES` |
| **Max files** | **10** per request |
| **Field name** | **`files`** |

### Request

`multipart/form-data`, with one or more parts under the field name **`files`**.

```
POST /api/v1/files/upload
Content-Type: multipart/form-data; boundary=…
X-CSRF-Token: …

--…
Content-Disposition: form-data; name="files"; filename="cover.png"
Content-Type: image/png
…bytes…
```

There is no other field. Nothing else in the body is read.

### The constraints, declared rather than discovered

You asked for these by name, so they are here, in the response `meta`, and in
configuration:

| Constraint | Value | Enforced by |
|---|---|---|
| Max bytes | **32 MiB**, whole request body | **wi-admin**, before the hop |
| Max files | 10 | jovi-mall's pipeline |
| Field name | `files` | jovi-mall's pipeline |
| Accepted MIME types | `image/jpeg` · `image/png` · `image/webp` · `image/gif` · `application/pdf` · `application/zip` · `audio/mpeg` · `audio/wav` | jovi-mall's pipeline |

> ### ⚠ Only the byte ceiling is enforced *here*, and it is worth knowing why
>
> This service **never parses a multipart body** — that is the whole design (see below) — so
> it cannot see a part boundary, a field name or a per-part content type. It can count bytes
> as they pass, and it does. The other three constraints are **published, not policed**:
> filter your file dialog with them, and expect jovi-mall to be the authority.
>
> A file that slips past your client comes back as `PLATFORM_OPERATION_REJECTED` with
> `details.platformCode: "UPLOAD_POLICY_VIOLATION"` and a `details.violations[]` array
> naming the offending file. That is a normal refusal, not a bug.

> ### ⚠ 32 MiB is **wi-admin's** number, not jovi-mall's 2 GB
>
> BR-015 noted jovi-mall's per-role figure of *"Admin: 2 GB per file"*. That limit is keyed
> on a session role, and it does still resolve for this path — `requireAdminCaller`
> fabricates `role: 'admin'`, so the lookup hits the `admin` entry rather than the customer
> fallback. **It is a backstop and never the binding limit.**
>
> 32 MiB is sized for what an administrator actually uploads: blog imagery and ticket
> attachments. jovi-mall's own upload policy caps an image at 10 MB and a PDF at 25 MB, so
> this is the largest artefact it will accept plus room for multipart framing, and no more.
> Refusing here means a doomed body is never streamed across the hop.

### Response `201`

```jsonc
{
  "success": true,
  "data": {
    "files": [
      {
        "id": "6612a4f0c1a2b3d4e5f60718",
        "key": "images/2026/08/1f2e3d_cover.webp",
        "url": "http://localhost:8022/api/files/images/2026/08/1f2e3d_cover.webp",
        "access": "public",
        "mimeType": "image/webp",
        "size": 48213,
        "originalName": "cover.png"
      }
    ]
  },
  "meta": {
    "count": 1,
    "maxBytes": 33554432,
    "maxFiles": 10,
    "fieldName": "files",
    "acceptedMimeTypes": ["image/jpeg", "image/png", "image/webp", "image/gif",
                          "application/pdf", "application/zip", "audio/mpeg", "audio/wav"]
  }
}
```

**`data.files` is an array even for one file** — the route accepts up to ten, so the shape
has to describe ten. It is the same `{ files: [...] }` shape `GET /files?ids=` answers on
this mount, so a client that handles one handles the other. Order matches your parts.

**`url` is on the response, as you asked** — *"because the blog cover and image block store
a URL, not an id."*

> ### ⚠ **An admin upload lands PUBLIC. Here is the definitive answer you asked for.**
>
> **Yes**, and it is a property of where the bytes go rather than anything the route
> chooses. jovi-mall's upload runs `folder: 'by-type'`, which files each part under the
> folder for its own detected media type — one of `images/`, `videos/`, `audio/`,
> `documents/`, `archives/`, `other/` — and **all six of those trees are classified
> `public`**.
>
> So an administrator's blog cover comes back with `access: "public"` and a real,
> unauthenticated `url` that an anonymous reader can fetch. **The blog half of BR-015
> closes.** You cannot ask for a private tree here and there is no reason to want one.
>
> This is pinned by `test:files` § 8 against jovi-mall's own source, so a reclassification
> of `images/` fails a suite here rather than silently emptying every article cover on the
> marketing site.

> ### ⚠ What you get back is what was **stored**, which may not be what you sent
>
> jovi-mall's pipeline sniffs the real type (a spoofed extension is filed as whatever the
> bytes actually are) and **converts PNG to WebP** by its own policy. So `mimeType` and the
> key's extension describe the stored object.
>
> **Read the response; do not echo your request.** A client that saves `image/png` because
> that is what it uploaded will have the wrong type on record.

### Errors

| Status | Code | When |
|---|---|---|
| 413 | `FILE_UPLOAD_TOO_LARGE` | Body over `ADMIN_UPLOAD_MAX_BYTES`. `details.maxBytes` carries the limit |
| 415 | `FILE_UPLOAD_NOT_MULTIPART` | The `Content-Type` is not `multipart/form-data` |
| 400 | `PLATFORM_OPERATION_REJECTED` | jovi-mall's pipeline refused a file — `details.platformCode` is `UPLOAD_POLICY_VIOLATION`, `details.violations[]` names it |
| 403 | `AUTHZ_PERMISSION_DENIED` | Support — this permission is tiers 1 and 2 |
| 503 | `SERVICE_DEPENDENCY_UNAVAILABLE` | jovi-mall unreachable or not configured |

### ⚠ "wi-admin accepts no multipart bodies anywhere" — narrowed, not abandoned

You quoted that rule from `README.md` and this page, and took it as binding. It was, and
the narrowing is precise:

> **wi-admin never *parses* a multipart body.**

It holds no `multer` and no `busboy`, gained **no npm dependency**, and reads none of your
body. `express.json` and `express.urlencoded` are content-type gated, so a
`multipart/form-data` request matches neither parser and arrives with the socket unread —
which is exactly what lets it be piped straight to jovi-mall.

The 1 MB body limit is likewise unchanged: it belongs to `express.json`, which never sees
this request. That is *why* this route declares and enforces its own byte ceiling — without
it there would be no limit on this path at all.

**Your preferred shape (option 1, the upload ticket) was not taken**, and the reasons are
recorded in [ADR-021](../ADR-021-ADMIN-MEDIA-LIBRARY.md) D-2: a ticket is a second
authentication scheme for one endpoint, it needs a new unauthenticated route on jovi-mall
that accepts bytes on production of a bearer string, it puts your browser on a second
origin, and its audit row would record *"a ticket was minted"* rather than *"a file was
uploaded"* — which come apart exactly when it matters.

**Option 3 is not merely undesirable, it is structurally impossible.** Re-opening
jovi-mall's `POST /api/files/upload` to an `admin` session requires an `admin` session, and
there is none: `requireAuth` has no `admin` branch, nothing mints a token carrying that
role, and such a token falls through to a `401` with no role entity. There is nothing to
re-open it to.

---

## `GET /api/v1/files/orphans`

Uploads that no live record refers to — the candidates for the delete below.

| | |
|---|---|
| **Permission** | `files.orphans.read` — tiers **1 and 2**. Support does not enumerate files |
| **Transport** | Delegated |
| **Audited** | No — it is a read (ADR-006 D-5) |

### Query

| Parameter | Type | Rules |
|---|---|---|
| `olderThan` | ISO-8601 instant | Optional. **Must be at least 24 hours in the past.** Absent means seven days ago |

> ### The 24-hour floor, and why it is refused rather than clamped
>
> A file is uploaded and attached seconds later. A window reaching into the last minute
> would list files that are about to be referenced and feed them to an unrecoverable
> delete, so the request is refused rather than quietly widened — a clamp would answer
> 200 with rows for a window the caller did not ask for.
>
> Both services enforce it. jovi-mall refuses the same thing, and repeating the rule here
> means the refusal arrives before the hop.

### Response `200`

```jsonc
{
  "success": true,
  "data": {
    "files": [
      {
        "id": "6612a4f0c1a2b3d4e5f60718",
        "originalName": "shop-logo.png",
        "mimeType": "image/png",
        "size": 48213,
        "ownerType": "vendor",
        "createdAt": "2026-07-04T11:22:33.000Z"
      }
    ]
  },
  "meta": { "count": 1, "olderThan": "2026-08-13T00:00:00.000Z" }
}
```

`meta.olderThan` is the cutoff jovi-mall **actually applied**, which is the one to render —
not the one you sent, and not a default recomputed here.

> ### ⚠️ The row deliberately withholds the storage `key`
>
> Unlike a resolved `FileDetail`, an orphan row carries **no `key` and no `url`**, and no
> `provider`, `checksum` or `ownerId` either.
>
> The operator has to be able to judge a file before destroying it, and what makes that
> judgement possible is the **filename**, the type, the size and whose it was. The storage
> key is an internal locator: it is the path inside the bucket, it names the owner's tree,
> and it adds nothing to the judgement. So the six fields above are the whole row —
> everything needed to decide, and nothing else.
>
> `originalName` and `ownerType` are `null` rather than absent when jovi-mall has none.

### Errors

`400 VALIDATION_ERROR` — `olderThan` is not an ISO instant, or is inside the last 24 hours.

---

## `DELETE /api/v1/files/:fileId/permanent`

**There is no undo.** The database row goes, then the object goes from storage.

| | |
|---|---|
| **Permission** | `files.delete` — **tier 1 only**, and flagged `destructive` |
| **Transport** | Delegated |
| **Audited** | **Yes** — `files.delete`, targeting the file |

### Body — the confirmation is required

```jsonc
{ "confirmFileId": "6612a4f0c1a2b3d4e5f60718" }
```

| Field | Rules |
|---|---|
| `confirmFileId` | **Required.** Must equal the `:fileId` in the path, byte for byte |

This is the `dev-tools/outbox/prune` pattern: make the operator restate the value that
decides the blast radius. There it is the retention age; here it is the file id, because the
id is the whole of what this operation acts on. A mismatch is refused **before** anything
reaches jovi-mall.

### Response `200`

```jsonc
{ "success": true, "data": { "id": "6612a4f0c1a2b3d4e5f60718", "deleted": true } }
```

> ### ⚠️ A success means the record is gone, not that the bytes are
>
> jovi-mall deletes the row first and then removes the object **best-effort**, treating its
> own database as the source of truth. A storage failure is logged there and the delete
> stands rather than rolling back into a half state. Read the audit row the same way.

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `FILE_DELETE_NOT_CONFIRMED` | `confirmFileId` is missing or does not match the path |
| 400 | `VALIDATION_ERROR` | Either id is not 24-hex |
| 404 | `PLATFORM_OPERATION_REJECTED` | jovi-mall has no file with this id |

### What the audit row records

The file **as the operator saw it before confirming** — `originalName`, `mimeType`, `size`,
`ownerType` — because afterwards there is nothing left to look it up in. `target_type` is
`file` and `target_id` is the deleted id, so the row is findable by the one handle anybody
still has. `after` is `null` by construction: the record no longer exists.

The listing is re-read on the way in to capture that snapshot. A file **absent** from the
listing still deletes — the window may have moved, or it may no longer be an orphan, and
jovi-mall is the authority on whether the delete may proceed. The audit payload is `null` in
that case rather than the request failing.

---

## Why every tier holds `files.resolve`

The caller is already holding the id, which means they already passed the guard on the
record that carried it. Gating this behind `agencies.read` would mean a `vendors.read`
holder cannot see a vendor's own logo; gating it behind all six read permissions would be a
rule nobody could state.

What keeps it narrow is the **shape**, not the tier: it **resolves an explicit id set and
cannot enumerate**. A file id is an unguessable 24-hex value, and `?ids=` is capped at 100.

**Each listing is a different name, and that is the whole safeguard.** `files.orphans.read`
enumerates — by definition, since an orphan is *found* rather than named — so it is not on
`files.resolve` and must never be folded into it. If you need "which files does nothing refer
to", that is the permission; `files.resolve` will never grow an answer to it.

⚠ **There are TWO listings now**, and the rule held rather than bending: BR-015's media
library got `files.library.read`, its own name and its own tier, rather than widening
`files.resolve` to take a `?search=`. The sentence to carry forward is not "the listing is
`files.orphans.read`" — it is **a route that enumerates gets its own permission**, which is
now stated twice and applies to the third one as well.

### The tier split, and the mechanism behind it

| Permission | Tiers | Why |
|---|---|---|
| `files.resolve` | 1 · 2 · 3 | Discloses nothing the caller did not already hold |
| `files.content.read` | 1 · 2 · 3 | **Does** disclose — so it is a separate name, and it is audited |
| `files.orphans.read` | 1 · 2 | Enumerates. Swept into Admin by `allInFamily('files')`; Support has no reason to |
| `files.library.read` | 1 · 2 | Enumerates — the same line, drawn a second time (BR-015) |
| `files.upload` | 1 · 2 | A write. Neither destructive nor flagged, so the family sweep reaches Admin and stops |
| `files.delete` | 1 | `destructive: true`, which is what excludes it from that sweep |

⚠️ **The reasoning above stops at the metadata, and `files.content.read` is where it stops.**
"The caller is already holding the id" justifies disclosing a name and a size. It does not
justify disclosing a photograph of somebody's front door, or a vendor's saleable `digital/`
file — those are a different act, so they get a different name. Do not fold the two together;
`test:files` § 5 asserts they stay distinct.

It reaches tier 3 anyway, on a different argument: Support answers the proof-photo disputes,
and refusing them escalates every ticket to somebody who knows less about it. That is the same
trade already made for `agents.tracking.read` — **and it is paid for the same way, with a
fail-closed audit row on every read.** The grant and the record were one decision.

⚠️ **`files.orphans.read` is tiers 1 and 2**, not tier 1 alone. Several comments in this
repository said "tier-1-only" — a forecast written when the permission was catalogued and
never reconciled with the grant table, which has always disagreed. The tier-1-only half of the
pair is the **delete**, and `destructive: true` is what makes that structural rather than a
list somebody typed. Corrected at Phase 5 Part B and pinned by `test:files` § 5.

---

## What this is not

- ⚠ **This bullet used to read "Not an upload — wi-admin accepts no multipart bodies
  anywhere, and that is unchanged". BR-015 makes the first three words false and the rest
  precise.** There **is** an upload now (`POST /files/upload`), and the rule it was written
  to protect survives in a narrower form: **wi-admin never *parses* a multipart body.** It
  holds no `multer`, no `busboy` and gained no dependency; your body is piped to jovi-mall
  unread. The 1 MB limit that used to be cited alongside it belongs to `express.json`, which
  is content-type gated and never sees a multipart request — which is precisely why the
  upload route declares and enforces a byte ceiling of its own
  ([ADR-021](../ADR-021-ADMIN-MEDIA-LIBRARY.md) D-2).
- **Not a storage layer**, and this one holds — but it is now the *narrow* claim. ⚠ It used
  to read *"Not a proxy — this service does not stream bytes"*, and the content route made
  that false; **BR-015 makes the "no `STORAGE_PROVIDER`" half false too.** The library
  builds public URLs here, from `STORAGE_PROVIDER` and `STORAGE_LOCAL_URL` configured on
  *this* side (ADR-021 D-3). What this service still does **not** hold is a bucket, a
  credential, a signing key or any way to read or write an object: it can compute a URL for
  a key it has already read, and nothing more. Everything else about a file still happens in
  jovi-mall.
- ⚠ **Not a second copy of the storage classification that nobody checks.** It *is* a second
  copy — `infra/storage/storage-trees.ts` mirrors jovi-mall's tree map verbatim — and that
  is contained rather than trusted: `test:files` § 8 re-reads jovi-mall's file from disk and
  fails if the two disagree, and `verify:files` § 6 asserts the URL built here is
  byte-identical to the one jovi-mall returns for the same id. A tree reclassified there
  turns a suite here red instead of silently publishing a private file's URL.
- **Not a cleanup job.** jovi-mall runs its own `LonelyFileDeletionService` on a schedule;
  the delete here is an operator acting on one file, and it neither triggers nor replaces
  that sweep.
- **Not a permission check on the file.** `files.resolve` resolves metadata for an id you
  were given. If a payload should not have carried a file id, the fix belongs on that
  payload's projection. **`files.content.read` is the exception** and is checked on its own
  merits — that is the entire reason it is a second permission.
