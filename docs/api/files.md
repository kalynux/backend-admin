# `/files` — resolving a file id, and the housekeeping pair

Four routes, two jobs.

**Resolution** — turning a `*FileId` this service already handed you into something you
can render. Added in the dashboard-request round to close gap **D2**.

**Housekeeping** — finding uploads no record refers to, and destroying them. Added at
Phase 5 Part B, moved off jovi-mall's public `/api/files` router where they had been its
only two admin-only routes.

| Method | Path | Permission | Tiers | Audited |
|---|---|---|---|---|
| GET | `/api/v1/files?ids=…` | `files.resolve` | 1 · 2 · 3 | No |
| GET | `/api/v1/files/orphans` | `files.orphans.read` | 1 · 2 | No |
| GET | `/api/v1/files/:fileId` | `files.resolve` | 1 · 2 · 3 | No |
| DELETE | `/api/v1/files/:fileId/permanent` | `files.delete` | **1 only** | Yes |

Every one of them is **delegated** to jovi-mall.

---

## Why this exists

Every DTO on this service ships file references as opaque ids — `logoFileId`,
`avatarFileId`, `bannerFileId`, `deliveryProofFileId`, `store.logoFileId`,
`vehicle.photoFileId` — and several documents say so plainly: *"An opaque id. This service
resolves no file URLs."*

That is still true, and it is deliberate (ADR-009 D-6): a URL is
`storage.getPublicUrl(key)`, and building one here means a second copy of the storage
configuration in a second deployment. What the contract then said, however, was that a
client should resolve them *"against jovi-mall"* — which the admin dashboard cannot do,
because it talks to this service and to nothing else, by design.

So every avatar, logo, banner and delivery proof on the admin surface rendered as a
placeholder. These routes close that **without** reversing D-6: the resolution is
delegated to jovi-mall, where the provider is configured.

---

## What a resolved file looks like

```jsonc
{
  "id": "6612a4f0c1a2b3d4e5f60718",
  "key": "vendors/665a.../logo-1f2e3d.png",
  "url": "https://cdn.example.com/vendors/665a.../logo-1f2e3d.png",
  "mimeType": "image/png",
  "size": 48213,
  "originalName": "shop-logo.png"
}
```

| Field | Notes |
|---|---|
| `id` | The id you asked with. Key your own map on this — see the ordering note below |
| `key` | The storage path. Diagnostic; do not build a URL from it |
| `url` | What to render. Built by jovi-mall from the active `STORAGE_PROVIDER` |
| `mimeType` | **Check it before rendering an `<img>`.** A product's media may be a video or a spec sheet |
| `size` | Bytes |
| `originalName` | What the uploader called it. **May be absent** — the one optional field |

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

**The listing is a different name, and that is the whole safeguard.** `files.orphans.read`
enumerates — by definition, since an orphan is *found* rather than named — so it is not on
`files.resolve` and must never be folded into it. If you need "which files does nothing refer
to", that is the permission; `files.resolve` will never grow an answer to it.

### The tier split, and the mechanism behind it

| Permission | Tiers | Why |
|---|---|---|
| `files.resolve` | 1 · 2 · 3 | Discloses nothing the caller did not already hold |
| `files.orphans.read` | 1 · 2 | Enumerates. Swept into Admin by `allInFamily('files')`; Support has no reason to |
| `files.delete` | 1 | `destructive: true`, which is what excludes it from that sweep |

⚠️ **`files.orphans.read` is tiers 1 and 2**, not tier 1 alone. Several comments in this
repository said "tier-1-only" — a forecast written when the permission was catalogued and
never reconciled with the grant table, which has always disagreed. The tier-1-only half of the
pair is the **delete**, and `destructive: true` is what makes that structural rather than a
list somebody typed. Corrected at Phase 5 Part B and pinned by `test:files` § 5.

---

## What this is not

- **Not an upload.** wi-admin accepts no multipart bodies anywhere, and that is unchanged —
  an orphan listing and a delete are not a write path for files (Phase 4 G-2, Phase 5 O-4).
- **Not a proxy.** The `url` points at storage; this service does not stream bytes.
- **Not a cleanup job.** jovi-mall runs its own `LonelyFileDeletionService` on a schedule;
  the delete here is an operator acting on one file, and it neither triggers nor replaces
  that sweep.
- **Not a permission check on the file.** It resolves metadata for an id you were given. If
  a payload should not have carried a file id, the fix belongs on that payload's projection.
