# `/files` — resolving a file id

Two routes, one operation: turning a `*FileId` this service already handed you into
something you can render.

Added in the dashboard-request round to close gap **D2**.

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

## Why every tier holds `files.resolve`

The caller is already holding the id, which means they already passed the guard on the
record that carried it. Gating this behind `agencies.read` would mean a `vendors.read`
holder cannot see a vendor's own logo; gating it behind all six read permissions would be a
rule nobody could state.

What keeps it narrow is the **shape**, not the tier: it **resolves an explicit id set and
cannot enumerate**. There is no listing form here and there will not be one — a file id is
an unguessable 24-hex value, and the listing is `files.orphans.read`, which is tier 1 only
and is not on this mount.

---

## What this is not

- **Not an upload.** wi-admin accepts no multipart bodies anywhere, and that is unchanged.
- **Not a proxy.** The `url` points at storage; this service does not stream bytes.
- **Not a permission check on the file.** It resolves metadata for an id you were given. If
  a payload should not have carried a file id, the fix belongs on that payload's projection.
