# BR-002 · Totals and owner names on the earnings-accounts directory

**Priority: medium.** Blocks the Accounts screen from answering *"how much do we owe, in total?"*

## The ask

> On the Accounts finance menu, we should be able to see an overall total of all the values
> (available, pending, reserve, requested). The page should be paginable. Also, on top of the id and
> the role, show us the business name of the entity.

## What exists today

**There is no `GET /accounts` list endpoint.** The `/accounts` mount is five routes, every one keyed
to a single owner. The Accounts screen is therefore built on the only list-shaped door onto it:

**`GET /api/v1/money/earnings/accounts`** · `money.earnings.read` · **delegated**

- Query is strict: `ownerType`, `page`, `limit`. Nothing else.
- **No sorting** — *"the platform ranks these itself, over rows this service never sees, so a `sort`
  parameter would be a promise it cannot keep."*
- **No search.**
- **Response shape is undocumented.** [`money.md`](../../admin/api/money.md) gives the endpoint no
  response block, and wi-admin's own gateway types it `PlatformPage<unknown>`
  (`money.gateway.ts:203-214`). `money.controller.ts:239-242` answers with `sendPlatformPage(...)` —
  a verbatim pass-through. The dashboard traced the real shape end to end in jovi-mall's
  `earnings-account.service.ts:265-296` and guards every row with `isEarningsAccountRow` before it
  renders, because nothing promises it.

Each row: `{ ownerType, ownerId, pending, available, reserve, requested, currency, updatedAt }`.

**Two things are missing, and both have precedent in the same file.**

1. **No owner name.** `listPayouts`, immediately below `listEarningsAccounts` in the same controller,
   calls `hydrateOwnerNames`. This one does not. So the directory shows ObjectIds.
2. **No totals, anywhere.** [`accounts.md`](../../admin/api/accounts.md) states it as a design rule:
   *"No grand total exists, at any level."*

## The distinction this request turns on

The prohibition is right about one sum and does not cover the other, and conflating them is what has
kept the screen from answering a reasonable question.

**Across the four balances, for one owner** — `pending + available + reserve + requested`. This is
the forbidden sum and it should stay forbidden. They are stages of one pipeline, not four pots:
`requested` is a claim already staked against `available`, so adding them double-counts. The
dashboard does not compute it and is not asking you to.

**Down one balance, across owners** — every `available` on the platform. Same field, same `unit`,
same `direction: "owed_to_owner"`, one currency at a time. That is not the sum the DTO forbids; it is
the single most useful number on a finance screen, and **only the platform can compute it honestly**,
because it is the only party that can see past page 1.

## What the dashboard does in the meantime

- Renders a **page-scoped, per-currency subtotal** under the table — one line per currency present,
  labelled *"This page only"*. It sums the same four columns down the visible rows and never across
  them. When a page carries two currencies it renders two lines and never coerces.
- Computes it from the **filtered** rows, so a row that fails the shape guard is excluded from the
  table *and* the subtotal.
- Shows the owner as a copyable id plus a role badge, linking to
  `/dashboard/accounts/:ownerType/:ownerId` where the name does appear.

**It deliberately does not resolve the names client-side.** Twenty rows per page across three
directories is twenty extra requests, each behind a permission a `money.earnings.read` holder need
not hold — which would turn this list into a side door onto `/vendors`, `/agencies` and `/agents`,
exactly what the accounts mount's composed authorization exists to prevent.

## The proposed contract

### 1. `meta.totals` — across the whole result set, not the page

```jsonc
"meta": {
  "total": 431, "page": 1, "limit": 20, "pages": 22,
  "totals": [
    { "currency": "XAF", "pending": 4120000, "available": 38900000, "reserve": 250000, "requested": 1200000 }
  ]
}
```

An **array**, one entry per currency in the result set, because a single object would force a
currency choice the data does not support. It respects the active `ownerType` filter — a total that
ignored the filter would disagree with the table above it.

No grand total across the four fields, in keeping with the existing rule.

### 2. `ownerName` on the row

```jsonc
{ "ownerType": "vendor", "ownerId": "665a…", "ownerName": "Douala Fresh Market", … }
```

The **business** name where there is one (a Store, a Magazin), the contact name where there is not,
`null` where neither resolves — the same rule [`billing.md`](../../admin/api/billing.md) already
documents for `owner.name` on a subscription, and the same join `hydrateOwnerNames` already performs
for payouts.

`null`, never `""`. Absent data is absent.

### 3. A `sort` allowlist, and `?search=`

Lower priority, but this is a directory an operator arrives at with a specific owner in mind. Today
they cannot search it and cannot reorder it. If the platform genuinely cannot serve either, a line in
`money.md` saying so is enough — it is the *silence* that is the problem, since the endpoint has no
response block at all.

### 4. Document the response

Whatever ships, give `GET /money/earnings/accounts` a response block in `money.md`. The dashboard has
a runtime shape guard against an undocumented delegated payload; that is a mitigation, not a
substitute.

## Acceptance

- [ ] `meta.totals` is an array, one entry per currency, computed over the whole filtered result set.
- [ ] It respects `?ownerType=`.
- [ ] It carries no sum across the four balances.
- [ ] `ownerName` is on every row: business name, else contact name, else `null` — never `""`.
- [ ] `money.md` gains a response block for this endpoint.
- [ ] A decision is recorded on `sort` and `search`, even if the decision is "not offered".
