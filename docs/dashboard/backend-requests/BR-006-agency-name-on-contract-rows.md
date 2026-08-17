# BR-006 · The agency's business name on contract rows — and the id→name problem generally

**Priority: low individually, medium as a pattern.** The specific fix is one field. The pattern
behind it costs this dashboard a request per row on four screens.

## The ask

> We should be seeing the agency business name under the Agencies tab in the agent directory, not the
> owner name.

The operator is exactly right, and the current column is mislabelled rather than merely sparse.

## What exists today

`GET /api/v1/agents/:agentId/contracts` decorates each contract with:

```jsonc
"agency": { "id": "665c…", "status": "active", "contactName": "Nadège M.", "country": "CM" }
```

Four fields. **`contactName` is the agency's contact *person*, not the business** — `agencies.md`
says so in the field note, and the dashboard's own type repeats it. The column headed *"Agency"* has
been rendering a human's name.

The omission is deliberate and documented:

> **"The agency's business name is not here.** It lives on the Magazin, and joining a second
> collection to decorate a list that is already a join would cost an extra lookup per page for a
> label the dashboard can resolve from the agency id — `GET /agencies/:agencyId` is one request away."

That reasoning holds for *one* agency. It does not hold for a page of rows, and it assumes a cost the
client can pay silently, which brings us to the general problem.

## The general problem: there is no batch lookup anywhere

Across all 179 routes there is **no fetch-by-ids endpoint** and no `?ids=` parameter. So every
"resolve this id to a name" need on this dashboard is N+1, against a `limit` capped at 100.

Four places it bites today:

| Screen | Id with no name | Distinct ids per page | Does the screen already hold the read? |
|---|---|---|---|
| Agents → Agencies | `agency.businessName` | bounded by the domain (an agent holds a handful of contracts) | **Yes** — the tab needs `agents.read` + `agencies.read` |
| Vendors → Catalogue | `deliveryAgencyId` → agency name | ~1 (a vendor's catalogue points at its default agency) | **No** — the tab needs only `vendors.read` |
| Accounts | `ownerId` → owner name | **20**, across **three** directories | **No** — `money.earnings.read` implies none of them |
| Money → Allocations | `beneficiary.name` | already hydrated ✅ | — |

The last row is the point: `GET /money/payouts` and `GET /money/earnings/allocations` **already
hydrate owner names** in the same controller where `GET /money/earnings/accounts` does not. The
capability exists; it is applied inconsistently.

## What the dashboard does in the meantime

A single `AgencyNameLink` component with one rule, enforced in one place:

> Resolve a name in the client only when the screen **already required the permission that owns that
> name**, and only when the number of distinct ids on a page is **bounded by the domain** rather than
> by the page size.

- **Agents → Agencies: resolves.** Passes both halves. The business name becomes the primary line,
  `contactName` is demoted to a sub-line and relabelled *"Contact person"*.
- **Vendors → Catalogue: resolves, gated on `can('agencies.read')`.** Without it, the id renders and
  no request fires. There is precedent — `subscriptionColumns` already links an owner to its
  directory only when the caller holds that directory's read.
- **Accounts: does not resolve.** Fails both halves; twenty requests per page across three
  directories would make a `money.earnings.read` holder a side door onto all three, which is what the
  accounts mount's composed authorization exists to prevent. See
  [BR-002](BR-002-earnings-accounts-projection.md).

Results are memoised for the session in a narrow module-level cache that stores **a display label
only, never an authorization outcome** — `can()` is re-evaluated on every render and the first request
is still authorized server-side — and that **clears on session end**, so a name cached under one
administrator cannot survive into another's session.

## The proposed contract

### 1. `agency.businessName` on `GET /agents/:agentId/contracts`

```jsonc
"agency": { "id": "665c…", "businessName": "Littoral Express Delivery",
            "status": "active", "contactName": "Nadège M.", "country": "CM" }
```

`null` where the Magazin has none — an agency mid-onboarding legitimately has no business name yet and
must still be identifiable. `null`, never `""`.

The cost argument against it was one extra `$lookup` on a query that is already a join, weighed
against a label the client could fetch. With no batch route, the client's alternative is **one request
per distinct agency, in every client ever built against this endpoint**. The lookup is cheaper.

### 2. `deliveryAgency: { id, businessName }` on `GET /vendors/:vendorId/products`

Same change, different collection. Folded into [BR-005](BR-005-product-detail.md) for the detail
route, but the **list** needs it too — that is where the catalogue is read.

This one also removes a permission question rather than just a request: today the name is only
reachable by a caller who holds `agencies.read`, which the catalogue tab does not require.

### 3. `ownerName` on `GET /money/earnings/accounts`

See [BR-002](BR-002-earnings-accounts-projection.md). Same field, same join, and
`hydrateOwnerNames` already exists one function away in the same controller.

### 4. The general one: consider a batch resolver

Not blocking, and offered as a suggestion rather than a requirement.

```
GET /api/v1/agencies?ids=665c…,665d…,665e…
```

A bounded `ids` list (say 100, matching the page cap) on the three directory list endpoints, returning
the same rows the list already returns and applying the same scope rules — an out-of-scope id is
simply absent from the response, not a `404`.

That would turn every N+1 on this dashboard into a single request, and it generalises beyond the
three cases above. Whether it is worth building depends on how many more of these you expect; the
alternative is hydrating each one individually as it comes up, which is where we are now.

## Acceptance

- [ ] `agency.businessName` is on every row of `GET /agents/:agentId/contracts`, `null` when unset.
- [ ] `agencies.md` and `agents.md` record that `contactName` is a person and `businessName` is the
      business, on both contract endpoints.
- [ ] `deliveryAgency: { id, businessName }` replaces `deliveryAgencyId` on the product list.
- [ ] `ownerName` is on the earnings-accounts row (BR-002).
- [ ] A decision is recorded on a batch `?ids=` resolver, even if the decision is "no".
