# BR-028 · Searching by id finds nothing unless the id is exactly the right kind, whole

**Raised 2026-10-12**, from an operator report: *"the Users screen says we can search by user id,
and searching by a user id does not work at all."*

**Priority: medium.** Nothing is broken in the sense of a wrong answer — every case below returns
a correct `200` with an empty page. That is the problem: an operator who pastes an id in good faith
gets the same empty page a misspelt email gets, and concludes the search is broken.

**Measured, not read.** `SearchUsersQuerySchema` and `buildFilter` from
`src/modules/users/` were run unmodified against a throwaway `mongod` (port 27117, scratch
`dbpath`, not the dev database) holding one user and that user's customer profile. The other lists
were read from source; their search clauses have the same shape.

---

## What we measured

One user, `_id: 665f1c2a9b3e4a91c7d2e5f0`, with a `customers` row whose `user_id` points at it.

| `GET /users?search=` | Rows | |
|---|---|---|
| `665f1c2a9b3e4a91c7d2e5f0` | **1** | the documented case, and it works |
| `665F1C2A9B3E4A91C7D2E5F0` | **1** | case is fine |
| `  665f1c2a9b3e4a91c7d2e5f0  ` | **1** | `searchTerm` trims |
| `665f1c2a` (first 8 characters) | 0 | |
| `d2e5f0` (last 6) | 0 | |
| `"665f1c2a9b3e4a91c7d2e5f0"` | 0 | |
| `ObjectId("665f1c2a9b3e4a91c7d2e5f0")` | 0 | |
| `https://admin.wi-mall.com/dashboard/users/665f1c2a9b3e4a91c7d2e5f0` | 0 | |
| `66b0000000000000000000c3` — **the same person's customer id** | 0 | |
| `670112` (part of the phone) | **1** | text matches on a part |
| `awa@` (part of the email) | **1** | |

So the id branch does exactly what [`users.md`](../../api/users.md) says and nothing near it. A
name, an email and a phone match on a part; an id matches only when it is all 24 characters **and**
is a `users._id`.

## What we have already done on our side

No backend change was needed for any of this, and none is being asked for:

- **Wrappers are stripped before the request is made.** A quoted id, `ObjectId("…")` and a pasted
  link are reduced to the bare id in the search box, on every list whose `search` takes one.
- **Our own shortened ids no longer copy as `665f1c…e5f0`.** Table cells draw an id head-and-tail;
  selecting one used to put the eleven drawn characters on the clipboard, ellipsis included. The
  whole id is now what a selection takes.
- **The empty state says why.** A shortened id, a partial id and a whole id that matched nothing
  each get their own sentence, and the Users screen links a stray whole id across to Vendors,
  Agencies, Agents and Orders with the term carried.

What is left is the part only the service can do.

---

## Ask 1 — `GET /users?search=<24hex>` should also find the account behind a profile id

**This is the one that matters.** Of the ids this dashboard shows for a person, most are not user
ids: a vendor, an agency, an agent and a customer each have a profile with its own `_id`, and that
is the id on their page, on an order and on a shipment. `users.md` says the id branch exists so
that *"an id copied out of an order, a ticket or an audit row finds the person"* — and the id on an
order is `customer_id`, a `customers._id`, which this search cannot match.

The customer case has no workaround at all. There is no customer directory and no customer read;
`customers.user_id` (required, unique) is the only join, and no projection carries it. Our own
`Order.customerId` type carries a note that a link from it to `/users/:id` would 404 on every
order, and the order screen tells the operator the same.

**Proposed:** when the term is a 24-hex id, add to the existing `$or` the user ids resolved from
the four profile collections —

```
users._id ∈ { term }
          ∪ customers.find({ _id: term }).user_id
          ∪ vendors.find({ _id: term }).user_id
          ∪ delivery_agencies.find({ _id: term }).user_id
          ∪ delivery_agents.find({ _id: term }).user_id
```

Four point reads on `_id`, only when the term is id-shaped. It is the same resolve-then-`$in`
shape `vendor.read.repository.ts` already uses for `storeMatchIds` and the order list uses for
`resolved.customerIds`.

**Questions for you:**

1. Is there an objection to the user directory answering for a profile id? It discloses nothing a
   `users.read` holder cannot already reach by opening the vendor, agency or agent — except for the
   customer, where today there is no path at all. Tier 3 holds `users.read`; say so if the customer
   join should be withheld from it.
2. If you would rather not widen `search`, the narrower alternative is a `customerUserId` on the
   order list and detail projections (and wherever else a `customerId` is served). That closes
   the customer gap and leaves the other three to the cross-links we
   already built. We would take either; the first is the one operators will find without being
   told.

## Ask 2 — `GET /agencies` and `GET /agents` should match the user id, as `GET /vendors` does

| List | A 24-hex term matches |
|---|---|
| `/vendors` | `_id` **or `user_id`** |
| `/agencies` | `_id` only |
| `/agents` | `_id` only |

Both read models already project `user_id`. One more branch in `agencySearchClause` and
`agentSearchClause`:

```ts
branches.push({ user_id: new ObjectId(term) });
```

The vendor list's own comment gives the reason — *"every other admin screen names this person by
their user id"*. It is as true of an agency and an agent, and both of their detail pages show a
*User id* an operator can copy and then cannot search by.

## Ask 3 — decide whether a partial id should match, and say so in the contract either way

An operator who sees `amina@` match assumes `665f1c2a` will. We are **not** asking for a
`$toString` regex — that is a collection scan on `users`.

A **prefix** can be served from the `_id` index as a range, with no scan:

```ts
// term = '665f1c2a' (8–23 hex characters)
{ _id: { $gte: new ObjectId(term.padEnd(24, '0')), $lte: new ObjectId(term.padEnd(24, 'f')) } }
```

A suffix or a middle cannot, and should stay unmatched.

**Question:** is prefix matching worth having? If yes, a floor of 8 characters keeps the range
narrow (8 hex characters is the timestamp — one second of signups). If no, that is a fine answer;
we already tell the operator an id only matches whole. Either way, see Ask 5.

## Ask 4 — `GET /audit?search=`: document what it matches, and consider the id

[`audit.md`](../../api/audit.md) documents `search` as *"1–120 characters"* and nothing else.
Source (`audit.repository.ts`) matches `actor_email`, `actor_display_name` and `target_label`.

Our search box said *"Action, actor, resource"* on the strength of that silence, so an action name
or an id typed there found nothing. We have corrected the label and now route a pasted id to
`?targetId=` / `?actorId=` from the empty state.

1. **Please state the three fields in `audit.md`.**
2. **Optional:** a 24-hex `search` term could also match `target_id` and `actor_id`, which is what
   an operator pasting an id into the trail means. `targetId` is a string on this collection
   (session UUIDs, composite keys), so it is an equality on a string, not an ObjectId. We do not
   need this — the two filters exist and we now surface them — so decline it freely.

## Ask 5 — one sentence in every `search` row that takes an id

`users.md`, `vendors.md`, `agencies.md`, `agents.md`, `orders.md`, `shipments.md`, `billing.md`
and `support.md` each say a 24-hex term is read as an id. None says the converse, which is the
half that bites:

> **An id matches only whole — exactly 24 hexadecimal characters.** A shorter or longer term, or
> one with anything round it, is not read as an id; it falls through to the text fields and
> matches none of them.

And per page, **which** ids: `agencies.md` and `agents.md` should say the user id is *not* matched
(or, after Ask 2, that it is); `users.md` should say a profile id is not (or, after Ask 1, that it
is).

---

## What we are not asking for

- **No change to `searchTerm`.** Stripping quotes and wrappers is a client concern and is done.
- **No customer directory.** Ask 1 closes the gap that would otherwise argue for one.
- **No new permission, no new route.** Everything above is a wider match on an existing read.

## If you take Asks 1 and 2

Tell us and we will: drop the *"this search takes the agency's own id, not the user id"* sentence
from the Agencies and Agents empty states, drop the Users screen's cross-links for the directories
the search now resolves itself, and re-copy the pages. No client change is required for the asks
to take effect — the terms are already sent as the service wants them.
