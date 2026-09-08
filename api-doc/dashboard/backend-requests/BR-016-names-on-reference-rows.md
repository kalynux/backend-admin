# BR-016 · Six places that return an id where an operator needs a name

**Verified against source on 2026-09-08** — the composite guard now on
`GET /agents/:agentId/cod-allocation` (`agents.read` + `agencies.read`) against the live route
manifest, and the eleven-value closed `EntityType` enum and its routability table against
[`support.md`](../../api/support.md).

> ### ✅ ALL SEVEN CLOSED — and **two** of this page's claims were false
>
> **Answered in [`RESPONSE-2026-08-26.md`](RESPONSE-2026-08-26.md).**
>
> - ⛔ **§ 6 pointed at the wrong field, and following it would have shipped a bug.**
>   `GET /orders`'s existing `vendorName` is `vendors.display_name` — a **personal** name. Reusing
>   it would have repeated the very `businessName`/`contactName` error BR-006 was raised to fix.
>   The shipment's `order.vendorName` comes from `stores.name` instead.
>   ⚠ **`GET /orders` still labels a personal name `vendorName`**, deliberately: correcting it is a
>   breaking change to a paginated endpoint, and the dashboard chose to render it honestly rather
>   than have it changed (`REPLY-2026-08-26.md` § 2 — the dashboard's reply, which lives only in its
>   own copy of this folder). The note in [`orders.md`](../../api/orders.md) and
>   [`shipments.md`](../../api/shipments.md) is what stands between the next reader and the same
>   mistake — **do not delete it.**
> - ⛔ **§ 7's vocabulary is CLOSED, not open.** `EntityType` is a closed enum of **eleven**, pinned
>   at the schema and at both jovi-mall validators.
> - ⛔ **§ 2's premise was wrong** — there is no tier holding `agents.read` without `agencies.read`,
>   so `agencies.read` was **composed onto the route** rather than the decoration being made
>   conditional. § 3 needed no change at all: `agency.businessName` was already on the row.

**Priority: medium — but it is the single most repeated complaint in this round.** Six endpoints,
one shape of fix, and **the precedent is already yours**: [BR-006](BR-006-agency-name-on-contract-rows.md)
added `agency.businessName` to `GET /agents/:agentId/contracts` for exactly this reason, and the
argument you accepted then applies unchanged to all six.

## The ask, in the operator's words

> Where we need the business name and/or the name of the entity, first display the business name;
> if not set, the name; if not set, the id or any other info permitting us to identify the entity.

Applied to specific screens:

> - Agencies → **Contract history**: the agent table is showing just ids, we need name / business name
> - Agents → **Cash**: the "per-contract slices" show the id of the agency, we need the names
> - Agents → **Roster**: under the agency column we see the id or the name, but we need the business name
> - Orders → **Items**: the agency is displaying just the ids; the shipments are displaying the ids, we need the tracking number as well
> - Orders → **Timeline**: the "by" column shows an id and a role, we need the name as well
> - Shipments → **Overview**: under the Order and agency card we only see the id of the vendor
> - Tickets → **Overview**: under "what was reported", the `about` field shows the id, but should let us go to the entity

---

## The argument, once — it is BR-006's, verbatim in shape

You wrote it yourself when you granted BR-006:

> That holds for **one** agency and not for a page of rows: with no batch-by-ids route anywhere on
> this service, the client's alternative is one request per distinct agency, in every client ever
> built against this endpoint. The lookup runs after skip/limit, so it touches at most one page.

Every row below is a page of rows, and there is still no batch-by-ids route for agencies, agents,
vendors or administrators. So the client's only options are N+1 requests per page, or an id.

---

## The six, individually

### 1 · `GET /agencies/:agencyId/contract-history` — the agent's name

**Today:** `{ contractId, agentId, agencyId, type, fromStatus, toStatus, actorRole, actorUserId, reason, occurredAt }`.

`agentId` is the only handle on *who the row is about*, and the screen is a table of them.

**Asking for:** `agent: { id, name }` on each row, `null` where jovi-mall has none.

⚠ **`agent.name`, not `businessName`** — an agent is a person. Please do not mirror the agency
shape here; the two are different kinds of thing and a column headed "Agent" showing a business
name would be wrong in the same way `contactName` under an "Agency" header was wrong.

**Precedent:** [`GET /agencies/:agencyId/agents`](../../api/agencies.md) already decorates
its contract core with an `agent` object, and `GET /agents/:agentId/contracts` decorates the same
core with an `agency` object. This row is the third view of the same relationship and is the only
one still undecorated.

⚠ **`actorUserId` is deliberately left alone.** Your own note says *"read the role, not the id — an
`admin` row's id belongs to the wi-admin database and resolves to nothing in the platform
database."* We are not asking you to resolve it. See § 5 for the one place where an actor name
*is* resolvable.

### 2 · `GET /agents/:agentId/cod-allocation` — the agency on each slice

**Today:** the endpoint has **no documented response shape at all** — `agents.md` gives the
permission, the transport and the error codes and stops. Our type was written from the wire and
carries `CodAllocationSlice.agencyId`.

**Asking for two things:**

1. `agency: { id, businessName, status }` on each slice — the same object
   `GET /agents/:agentId/contracts` already returns.
2. ⚠ **A documented response shape for this endpoint.** It is currently the only route in the
   `/agents` group with none, which is why our type is a transcription — and this repository has
   one very expensive lesson about transcribed contracts (see [BR-014](BR-014-content-wire-shapes.md)).

**Cost:** the slices are per-contract, and `agents/:agentId/contracts` already performs this exact
`$lookup` after skip/limit. There is no pagination here at all — an agent's contract count is
bounded — so it touches at most a handful of agencies.

### 3 · `GET /agents/:agentId/contracts` — `businessName` is there; this one is ours

✅ **No backend change needed.** BR-006 landed and `agency.businessName` is on the row. The
dashboard is rendering `contactName` or the id in the agency column, which is our bug, not yours.
Listed here only so the six asks map cleanly onto the six screens.

### 4 · `GET /orders/:orderId` — the agency and the tracking number on each item

**Today:** `items[].delivery` carries `{ agencyId, shipmentId, status, freeDelivery, hold, pickup }`.

**Asking for:**

| Add | Shape | Why |
|---|---|---|
| `delivery.agencyName` | `string \| null` | The agency's `businessName`. An items table showing four different 24-hex ids is not readable |
| `delivery.trackingNumber` | `string \| null` | ⚠ **This is the ask that matters most on this screen.** `shipmentId` is an internal id; the **tracking number is what a customer quotes on the phone and what an operator searches by** — `GET /shipments?search=` takes a tracking-number prefix, and the id in hand cannot be typed into it |

`null` where the item has no agency or no shipment yet — which is the ordinary state for an
unfulfilled item, not an error.

### 5 · `GET /orders/:orderId/timeline` — the actor's name

**Today:** `{ actorType, actorId }` where `actorType` is `vendor` · `customer` · `system` · `admin`.

**Asking for:** `actorName: string | null` alongside.

⚠ **Unlike § 1, this one is resolvable — and `admin` is the interesting case.** `orders.md` says
of this endpoint: *"`actorType` … Pinned — **this service writes `admin` itself**"*. So a row whose
`actorType` is `admin` was written by wi-admin, its `actorId` is a wi-admin administrator id, and
**wi-admin can resolve it from its own database without any hop**. The other three resolve in
jovi-mall.

If resolving all four is more than it is worth, **resolving `admin` alone is worth having on its
own** — "which of us did this" is the question an order timeline gets opened for, and it is the
one row type the platform database cannot answer.

`null` for `system`, and `null` where the record is gone.

### 6 · `GET /shipments/:shipmentId` — the vendor's name on `order`

**Today:** `order: { id, orderNumber, vendorId, … }`.

**Asking for:** `order.vendorName: string | null` — the vendor's `businessName`.

**Cost is one document.** `GET /orders` already returns `vendorName` on every list row, so the
projection exists; this is a detail read for a single shipment, not a page.

### 7 · `GET /support/tickets/:ticketId` — making `about` navigable

**Today:** `entity: { type, id }` where `type` is a bounded token (`ORDER`, `PRODUCT`, `SHIPMENT`,
`OTHER`, …) and `id` is a 1–120 string.

**We can route `ORDER` and `SHIPMENT` ourselves** — the type maps to a dashboard path and the id is
the path parameter. Two things stop us doing the rest:

| Problem | Asking for |
|---|---|
| ⚠ **`PRODUCT` is not routable.** A product's detail route is `GET /vendors/:vendorId/products/:productId` — it needs **two** ids and the ticket carries one. There is no vendor-agnostic product read anywhere on this service | `entity.vendorId` when `type` is `PRODUCT`. Without it, the one entity type most likely to be on a catalogue complaint is the one we cannot link to |
| **The token vocabulary is open.** `entityType` is *"token, 1–60"* with the documented set ending in a literal `…` | The closed list, or a statement that it is genuinely open. We will render an unrecognised token as plain text either way — but we would rather link the ones we can than guess |

**A resolved `entity.label` would be welcome** (`ORD-2026-008841`, the product title, the tracking
number) and is a nice-to-have, not a blocker: given a routable id we render the link and the
destination screen supplies the name.

---

## Summary

| # | Endpoint | Add | Cost |
|---|---|---|---|
| 1 | `GET /agencies/:agencyId/contract-history` | `agent: { id, name }` | `$lookup` after skip/limit, one page |
| 2 | `GET /agents/:agentId/cod-allocation` | `agency: { id, businessName, status }` **+ a documented shape** | Unpaginated, bounded by contract count |
| 3 | `GET /agents/:agentId/contracts` | — ✅ already correct, ours to fix | — |
| 4 | `GET /orders/:orderId` | `items[].delivery.agencyName`, `items[].delivery.trackingNumber` | One detail read |
| 5 | `GET /orders/:orderId/timeline` | `actorName` — **`admin` rows alone would still be worth it** | wi-admin-local for `admin` |
| 6 | `GET /shipments/:shipmentId` | `order.vendorName` | One document |
| 7 | `GET /support/tickets/:ticketId` | `entity.vendorId` for `PRODUCT`; the closed token list if there is one | One field |

**All seven are `null`-able.** Absent data is `null`, never `""`, never the id substituted
silently, and never a name invented from a neighbouring field — the `businessName` / `contactName`
confusion BR-006 corrected is the exact failure we are trying not to repeat.

---

## What the dashboard does in the meantime

A shared `partyName()` helper implementing the operator's stated fallback — **business name → name
→ contact name → id** — is applied at every one of these sites. Where only an id exists it
renders as a copyable, linked id rather than bare text, so the screen is at least usable.

**Two of them get a client-side join instead of a placeholder**, because a documented endpoint
already carries the answer:

- **§ 2, the COD slices** — joined against `GET /agents/:agentId/contracts`, which carries
  `agency.businessName`. ⚠ That endpoint needs `agents.read` **+ `agencies.read`** where
  `cod-allocation` needs only `agents.read`, so the names appear for tiers 1–2 and the slice falls
  back to the id for anyone holding the narrower grant. **That degradation is exactly why we are
  still asking for the field.**
- **§ 6, the shipment's vendor** — one extra `GET /vendors/:vendorId` behind `vendors.read`. One
  request on one detail screen is affordable; the same trick on § 1 or § 4 would be N+1 per page
  and we are not doing it there.

Nothing is fabricated. Where no endpoint carries the name, the id is what we show.
