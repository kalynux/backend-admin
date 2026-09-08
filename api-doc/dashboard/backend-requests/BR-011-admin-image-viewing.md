# BR-011 · Administrators cannot see any private image, anywhere in the platform

**Verified against source on 2026-09-08** — `GET /files/:fileId/content`, its permission
`files.content.read` and its `records:files.content.read` audit declaration against the live route
manifest; the seven-route `/files` mount against the same; and the absence of
`FILE_VIEW_NOT_SUPPORTED` and of `files.view_private` against
`admin/src/core/errors/error-codes.ts` and
`admin/src/modules/authorization/domain/permission.catalog.ts`.

> ### ✅ BUILT — but **as a byte stream, not a signed URL**, so it is not what this page specifies
>
> **Answered in [`RESPONSE-2026-08-24.md`](RESPONSE-2026-08-24.md); live contract
> [`files.md`](../../api/files.md).**
>
> ```
> GET /api/v1/files/:fileId/content    files.content.read    tiers 1·2·3    AUDITED, fail-closed
> ```
>
> **It returns the file's raw bytes.** Not JSON, not `{ url, expiresAt }` — `fetch` it and make a
> blob URL. The signed-URL design was rejected because the configured provider is `local`, which
> has **no `getSignedUrl` at all**, so signing would have meant standing up a new unauthenticated
> public route serving private bytes — a smaller copy of the hole ADR-A01 D-2 was written to close.
>
> ⛔ Three names this page proposes **do not exist and must not be branched on**:
> `GET /files/:fileId/view-url`, the permission `files.view_private` (the real one is
> **`files.content.read`**), and the code `FILE_VIEW_NOT_SUPPORTED` (no registry defines it — the
> provider question it was for went away with the signed-URL design). `reason` is **not** required
> on this read.
>
> ⛔ *"Its entire `files` module is four routes"* is the 2026-08-24 state; it is **seven** today,
> the media library having added `library`, `orphans` and `upload` (BR-015).

**Priority: high. This is a capability the platform does not have, not a bug.** It needs a design
decision before it needs code, and the decision has a security shape — so this document proposes
one rather than assuming it.

**The operator ask is broader than delivery proofs**, and it should be solved once:

> Operators need to see the photo to resolve a dispute — and not only delivery-proof photos.
> **Any image in the system should be visually viewable by an administrator.**

---

## What exists today

**Nothing. There is no path by which the dashboard can display a private image.**

Two facts combine to close it:

**1 · wi-admin is not a proxy and has no file-streaming route.** Its entire `files` module is four
routes: two resolvers, an orphan listing and a permanent delete. None of them returns bytes. This
is deliberate (ADR-009 D-6) — building a URL means a second copy of the storage configuration in a
second deployment.

**2 · A private file has no URL to give.** `backend/jovi-mall/src/core/storage/storage-trees.ts`
marks each tree public or private; a private one resolves as `url: null, access: "authorized"` (see
[BR-010](BR-010-filedetail-url-and-access.md) for the shape). The two trees that matter most to an
administrator are exactly the private ones:

| Tree | Holds | Today |
|---|---|---|
| **`shipments/`** | delivery-proof photographs | `url: null` — **cannot be shown** |
| **`digital/`** | digital product files | `url: null` — cannot be shown |

So the single most useful image on the platform for settling a dispute — the photo the courier took
at the door — is the one image an administrator cannot look at.

### The ingredient that already exists

`backend/jovi-mall/src/core/storage/storage-provider.interface.ts:52-57` already declares the right
primitive:

```ts
/**
 * Get signed URL for temporary access (optional, for private files)
 */
getSignedUrl?(key: string, expiresInSeconds: number): Promise<string>;
```

It is optional, and implementation is uneven:

| Provider | `getSignedUrl` | `getDownloadStream` |
|---|---|---|
| **Firebase** | ✅ fully implemented (`firebase-storage.provider.ts:127`) | — |
| **Cloudinary** | ❌ `throw … 501 "Method not implemented."` | ❌ also 501 |
| **Local** | ❌ not implemented at all | — |

⚠ **`STORAGE_PROVIDER` defaults to `'local'`** (`storage.instance.ts:29`), so on a default
deployment the primitive is absent entirely.

---

## What the dashboard does in the meantime

Renders the metadata and **says plainly that the image cannot be shown**, rather than putting an
`<img>` around a `null` and letting it fail as a broken icon.

`src/types/files.types.ts` exports `isDisplayableImage()`, which requires
`access === 'public' && url !== null && mimeType.startsWith('image/')`. Every render site goes
through it. Nothing in `src/` builds a URL from `key` — the contract says `key` is diagnostic, and
we treat it that way.

**This is honest but not useful.** An operator settling a delivery dispute is told a photograph
exists and that they may not look at it.

---

## The proposed contract

One route on wi-admin, delegated to jovi-mall, returning a short-lived link rather than bytes.

### `GET /api/v1/files/:fileId/view-url`

| | |
|---|---|
| **Permission** | **A new one — `files.view_private`** (see *Why a new permission* below) |
| **Transport** | Delegated |
| **Audited** | **Yes — this is a disclosure, not a read** |

**Response `200`**

```jsonc
{
  "success": true,
  "data": {
    "url": "https://storage.example.com/shipments/…?X-Goog-Expires=300&X-Goog-Signature=…",
    "expiresAt": "2026-08-24T09:19:02.000Z",
    "mimeType": "image/jpeg",
    "originalName": "proof-6670.jpg"
  }
}
```

**Errors**

| Status | Code | When |
|---|---|---|
| 404 | `FILE_NOT_FOUND` | No such file, or it was swept |
| 409 | `FILE_VIEW_NOT_SUPPORTED` | The active storage provider cannot mint a signed URL. **A real, expected state on `local` and `cloudinary`** — it must be distinguishable from an outage so the dashboard can say "this deployment cannot show private images" rather than "something went wrong" |
| 502/503 | `SERVICE_DEPENDENCY_UNAVAILABLE` | jovi-mall unreachable |

### Why a new permission rather than `files.resolve`

`files.resolve` is held by **every tier**, and the reasoning in
[`files.md`](../../api/files.md) is explicit and good: *"the caller is already holding the id,
which means they already passed the guard on the record that carried it."*

**That reasoning does not carry over.** Resolving an id into a name and a size discloses metadata;
minting a signed URL to a private tree discloses **the contents of a photograph of somebody's front
door**. Those are different acts, and the platform already separates acts of that kind — revealing
a payout destination is its own permission (`money.payouts.destination.read`), flagged `financial`,
and it is the **only audited read on the service** for exactly this reason.

We would expect `files.view_private` to look like that one: its own name, tiers 1 and 2 at least,
and **audited on every use**. Whether Support (tier 3) should hold it is a real question and yours
to answer — see below.

### Why audited

The platform has a precedent and it is unambiguous. Three reads are audited today, and all three
are audited because *the output is the disclosure*:

- `money/payouts/:id/destination` — reveals a bank account
- `agents/:id/live-position` — reveals where a person is now
- `shipments/:id/tracking-trail` — reveals where a person has been

A delivery-proof photograph belongs in that list. It shows a location, often a residence, sometimes
a person.

**We are not asking for the `reason` field** that the two tracking reads require. That is a heavier
control and we do not think a dispute-resolution workflow can carry it on every image. But if you
decide it should, the dashboard already has the dialog built (`RevealPositionDialog`) and can reuse
it — say so and we will.

---

## Questions we need answered, because they are yours and not ours

**1 · Which storage provider is production actually running?** The answer changes the size of this
job entirely:

- **Firebase** → the primitive exists; this is a route and a permission, and little else.
- **Cloudinary** → `getSignedUrl` must be implemented first. Cloudinary supports signed delivery
  URLs, so this is real but bounded work.
- **Local** → needs implementing, and "signed URL" for local storage means minting and validating
  a token yourselves.

**2 · Should Support (tier 3) hold it?** The argument for: they answer the delivery tickets, and
refusing them escalates every one. The argument against: a delivery-proof photo is somebody's home.
The platform made exactly this call once already and went *for* the wider grant — Support holds
`agents.tracking.read` — **and paid for it with an audit row**. We think the same trade applies
here, but it is your decision and the dashboard will gate on whatever you publish.

**3 · How long should a link live?** We suggest **5 minutes**. Long enough to open, short enough
that a link pasted into a chat is dead before it is read. If you pick a different number, put it in
the response as `expiresAt` regardless — the dashboard will not cache past it, and we would rather
read the value than hard-code an assumption.

**4 · Scope — every image, or the private ones?** The ask is "any image in the entire system".
Public images already work, so in practice this route is only needed for private trees. We suggest
it answer for **any** file id and simply return the public URL when the tree is public — one code
path in the dashboard, and the caller never has to know which tree a file is in. Say if you would
rather it 400 on a public file.

---

## Acceptance

- [ ] A decision recorded on which storage provider production runs, and `getSignedUrl` implemented
      for it if it is not Firebase
- [ ] `GET /api/v1/files/:fileId/view-url` exists, delegated, returning `url` + `expiresAt`
- [ ] A permission distinct from `files.resolve`, catalogued in
      [`permissions.md`](../../api/permissions.md) and **not** marked `†`
- [ ] The read is audited, with a catalogued action name appearing in `GET /audit/actions`
- [ ] `FILE_VIEW_NOT_SUPPORTED` (or equivalent) is a distinct code in
      [`errors.md`](../../api/errors.md) **and** in `error-codes.ts`, so a provider that
      cannot sign is distinguishable from an outage
- [ ] An answer on tier 3, and on whether a `reason` is required
- [ ] Whether the route answers for public files too, or refuses them

> **Note on our error guard.** `src/i18n/error-catalog.test.ts` now diffs against **both**
> `errors.md` and `error-codes.ts`, because the two currently disagree by 16 codes
> ([BR-012](BR-012-documentation-corrections.md)). Any new code needs to land in both or our build
> goes red — which is the intended behaviour, but worth knowing before you ship.
