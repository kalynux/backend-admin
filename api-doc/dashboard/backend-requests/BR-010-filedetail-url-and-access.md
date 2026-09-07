# BR-010 · `FileDetail` declares `url: string` and omits `access` entirely

> ⚠ **A later note, 2026-09-08.** Question 3 below asks whether `'public' | 'authorized'` is a
> closed set. It was answered *"yes, closed at two"* on 2026-08-24 and that answer has since
> been overtaken: `quota_blocked` is a third value, live in both services. The current contract
> is [`../../api/files.md`](../../api/files.md). This page is left as the record of the request.

**Priority: high, effort: minutes.** This is a two-line correction to a type and a paragraph in a
doc page. Nothing on the wire changes — the *data* is already right, and only the service's own
description of it is wrong.

Already filed on the backend side as **F-57** in
`backend/FRONTEND-SYNC/03-FINDINGS-REGISTER.md`. This document is the frontend half: what we
observed, what we built against, and what we need confirmed before we change it.

---

## The ask

> Confirm the real shape of a resolved file, and correct the two places that state it wrongly, so
> the dashboard is not the only party holding the true version.

---

## What exists today

**`GET /api/v1/files` and `GET /api/v1/files/:fileId` return jovi-mall's `FileDetail` verbatim.**
wi-admin pins that shape by hand rather than passing it through as `unknown`, at
`backend/admin/src/modules/files/gateways/file.gateway.ts:47-56`:

```ts
export interface FileDetail {
    id: string;
    key: string;
    url: string;          // ← line 50
    mimeType: string;
    size: number;
    originalName?: string;
}
```

That pin is wrong in two ways, and [`files.md`](../../api/files.md) repeats the first and
omits the second:

| | wi-admin's pin | `files.md` | What jovi-mall actually sends |
|---|---|---|---|
| `url` | `string` | *"What to render"* | **`string \| null`** — `null` for a file in a private storage tree |
| `access` | **absent** | mentioned **zero times** | `'public' \| 'authorized'` |

### Why `url` is null, and why it is not an error

`backend/jovi-mall/src/core/storage/storage-trees.ts` classifies every storage tree as `public` or
`private`. A file in a private tree has no public URL to build, so the resolver sends `null`.

Two trees an administrator meets constantly are private:

- **`shipments/`** — delivery-proof photographs
- **`digital/`** — digital product files

Both resolve as `url: null, access: "authorized"`. **This is the normal, expected answer for those
files, not a fault.** A client that treats it as one shows a broken-image icon on every delivery
proof in the system.

### The one that is worth stating out loud

**Support-ticket attachments are the exception, and not for a comforting reason.** They land in
`documents/` or `images/` — both **public** trees — so they resolve with a real, working URL.
Which means a support attachment is **publicly reachable by URL to anyone who has that URL**, with
no authentication.

We are not asking for that to change here. We are asking for it to be *written down*, because a
reader of `files.md` today would have no way to know it.

---

## What the dashboard does in the meantime

**We built against the real shape, not the documented one**, and left a marker at every point where
the two disagree.

`src/types/files.types.ts` declares:

```ts
url: string | null;
access: 'public' | 'authorized' | (string & {});
```

and exports the check every render site uses:

```ts
export function isDisplayableImage(file: FileDetail): boolean {
    return file.access === 'public' && file.url !== null && file.mimeType.startsWith('image/');
}
```

Both conditions, not either — `access` alone is not enough, because a public tree can still hold a
PDF or a video, and a product's media legitimately does.

`src/services/files.service.test.ts` pins the behaviour so a later "tidy-up" toward the documented
shape fails the suite rather than shipping.

**We are holding this deliberately.** Because our types are pinned to observed behaviour rather
than to the contract, we would rather not "correct" them toward a document we believe to be wrong
— so this is the reply we are waiting on before touching them.

---

## The proposed correction

No new route, no new permission, no wire change.

**1 · The gateway pin** — `backend/admin/src/modules/files/gateways/file.gateway.ts`:

```ts
export interface FileDetail {
    id: string;
    key: string;
    /** `null` for a file in a private storage tree — there is no public URL to build. */
    url: string | null;
    /** Whether the storage tree is public. Check before rendering an `<img>`. */
    access: 'public' | 'authorized';
    mimeType: string;
    size: number;
    originalName?: string;
}
```

**2 · [`files.md`](../../api/files.md)** — the field table under *"What a resolved file looks
like"* gains an `access` row, and the `url` row stops saying "what to render" unconditionally. A
sentence naming `shipments/` and `digital/` as the private trees an administrator will actually
meet is worth more than the type change on its own.

**3 · One line on the ticket-attachment exception**, in either `files.md` or
[`support.md`](../../api/support.md): that support attachments resolve publicly, and what
that means for anyone sharing a link.

---

## What we need back

Three yes/no answers. Nothing here blocks us — we are already rendering the real shape — but we
will not change our types on our own reading of somebody else's source.

1. **Is `url: string | null` correct?** We believe yes, from `storage-trees.ts`. Confirm.
2. **Is `access` always present**, or optional on some paths? We type it as required; if it can be
   absent on any route, say which and we will widen it.
3. **Is `'public' | 'authorized'` the closed set**, or can a third value appear? If it can grow, we
   will keep our open union and treat anything unrecognised as *not* displayable — which is the
   safe direction, but we would rather know than infer.

## Acceptance

- [ ] `FileDetail.url` is `string | null` in `file.gateway.ts`
- [ ] `FileDetail.access` exists in `file.gateway.ts`
- [ ] `files.md` documents `access`, its two values, and what each means for rendering
- [ ] `files.md` names `shipments/` and `digital/` as private trees, with `url: null` as expected
- [ ] The support-attachment public-URL consequence is written down somewhere a reader will find it
- [ ] A reply to the three questions above, so the dashboard can drop this document's workaround note
