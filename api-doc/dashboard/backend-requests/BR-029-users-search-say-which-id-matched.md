# BR-029 · `GET /users?search=<id>`: say which kind of id matched

**Raised 2026-10-13.** A follow-up to [BR-028](BR-028-search-by-id-finds-nothing.md), taking up
the offer in [your reply](RESPONSE-2026-10-12-BR-028.md) § Ask 1:

> No `meta` field says which kind of id matched. If an operator being shown a different id from
> the one they pasted turns out to confuse people, say so and a `meta` hint is a small addition.

The owner has asked for it. **Priority: low** — the dashboard works without it and nothing is
wrong on the wire. One additive field on one read.

The other offer in that section, `customerUserId` on the order detail, is **declined with
thanks**: landing on a one-row list and clicking through is fine.

---

## Why we want it

Since BR-028 a 24-hex `search` term is tried as five ids, and the row that comes back is the
account — so its `id` is not the id that was typed. The dashboard says so above the table, but it
has to *work it out*, and what it can work out is thin:

| What the operator pasted | What the dashboard can say today | What it should say |
|---|---|---|
| a customer id | "that id is a customer, vendor, agency or agent profile's" | "that is this person's **customer** id" |
| a vendor id | the same sentence | "that is this person's **vendor** id" |
| a user id | nothing — the row's `id` equals the term | nothing |
| a customer id, with `role=vendor` set, 0 rows | "no account matches that id under the other filters" — **a guess**; the same sentence is shown for an id that is nobody's | "that id is a customer's — the role filter is hiding the account" |
| an id that is nobody's, with `role=vendor` set | the same guess, and a *Search this id alone* button that leads to a second empty page | "that id is no account's or profile's" — and no button |

The first two rows are the request. The last two are why we would like the hint to describe the
**id**, not the page — see question 1.

Our derivation is `rows.every(row => row.id !== term)`: an id search whose rows do not carry the
id must have arrived through a profile. It cannot name the kind, and it has nothing to stand on
when there are no rows.

## The ask

On `GET /users`, when `search` was read as an id — exactly 24 hexadecimal characters — add to
`meta` what the term resolved as. You already have the answer before the page is read:
`findUserIdsBehindProfileId` asks all four profile collections, and its comment says why it asks
all four rather than returning the first hit.

A shape that would serve us, offered as a starting point and not a requirement:

```jsonc
"meta": {
  "total": 1, "page": 1, "limit": 20, "pages": 1,
  "idMatch": {
    "kinds": ["customer"]          // any of: user · customer · vendor · agency · agent
  }
}
```

What we need from it, whatever it is called:

1. **Absent when the term was not read as an id.** A name, an email, a phone, a partial id — no
   key at all, as `details` is omitted rather than `null`. That is also what an older wi-admin
   sends, so "absent" has one meaning on our side: *nothing to say, keep deriving*.
2. **Present and empty when a whole id resolved as nothing.** `"kinds": []` is the honest answer
   to an order id pasted into the user directory, and it is different from absent.
3. **A list, not a single value.** Your resolver's own comment allows for one id being found in
   more than one collection. We will render however many there are.
4. **An open vocabulary.** We will treat an unrecognised kind as unknown and print it raw, so a
   sixth profile kind is an additive change.

No new permission, no new route, no change to `data`.

## Questions for you

1. **Can it describe the id independently of `role`, `status` and the date range?** The resolver
   runs before those filters are applied, so `?search=<customerId>&role=vendor` could answer
   `total: 0` with `kinds: ["customer"]`. That is what turns our *Search this id alone* button
   from a guess into a fact. It discloses nothing the caller cannot get by removing the filter
   themselves — but it does tell them an id exists as a customer's without returning the row, so
   say if you would rather it only describe rows actually returned. We would still take that
   narrower version.
2. **Should it say `user` when the term is the account's own id?** We would use it only to stay
   silent, so leaving `user` out and returning `[]` for a plain user id would do — but then `[]`
   means two things (a user's own id, and nobody's id), which defeats point 2 above. We would
   rather have `user` in the list.
3. **Per row, or once in `meta`?** An id search returns one account in every case we can think
   of, so `meta` is enough for us. If you can see a case where two accounts come back for one id
   and the kinds differ between them, a per-row field is the right place and we will read it
   there instead.

## What we will do when it lands

- Replace the derived sentence on the Users list with one that names the kind.
- Use question 1's answer, if granted, to show *Search this id alone* only when the id is known
  to belong to somebody.
- Keep the derivation as the fallback for a wi-admin that does not send the field — deploy order
  will not matter for this one.

Nothing on our side is built against the field until its name and shape are in `users.md`.
