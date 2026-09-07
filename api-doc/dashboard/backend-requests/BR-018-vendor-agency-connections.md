# BR-018 · A vendor's delivery-agency connections, as rows rather than counts

**Priority: high.** The screen has been asked for explicitly, and there is **no endpoint of any
kind** behind it — not a narrower one, not a paginated one, nothing.

## The ask

> Vendors → **Overview** → under "Delivery agency connections": we should be able to see a table
> of the agencies associated with the vendor — the name, the total number of products held by
> those agencies, and any other information relating the vendor to those agencies. **Just like the
> roster tab under the Agencies menu.**

The comparison is the useful part of the ask. `GET /agencies/:agencyId/agents` answers *"who works
for this agency, and on what terms"* as a table of decorated relationship rows. This asks for the
mirror image on the other side of the platform: *"which agencies does this vendor ship through,
and on what terms"*.

---

## What exists today

**Seven integers.** `GET /vendors/:vendorId` returns:

```jsonc
"counts": {
  "agencyConnections": {
    "total": 9, "active": 6, "pending": 1, "pausedReapproval": 1,
    "rejected": 1, "withdrawn": 0, "terminated": 0
  }
}
```

That is the entire universe. An operator can see that six connections are active and **cannot see
which six**. The `/vendors` route group is twelve routes and none of them enumerates a connection.

The two half-answers that exist, and why neither is the screen:

| Source | What it gives | Why it is not enough |
|---|---|---|
| `defaultDeliveryAgencyId` on the vendor | **One** agency, and only if a default is set | It is the default, not the roster. A vendor with nine connections shows one |
| `deliveryAgency: { id, businessName }` on each product row | The agencies actually carrying stock | ⚠ **It is the product's resolved agency, not the connection.** A `pending` or `paused_reapproval` connection carries no products and is invisible here — and those are precisely the rows an operator opens this panel to act on |

---

## The data exists, in full, and it is already a first-class module

`backend/jovi-mall/src/modules/agency-connections/` — `connection.model.ts` defines
`IVendorAgencyConnection` as *"consensual link between a vendor and a delivery agency. Exactly one
document ever exists per `(vendor_id, agency_id)` pair"*, with a unique index enforcing it.

It carries considerably more than the counts summarise:

| Field | |
|---|---|
| `status` | The six-value `ConnectionStatus` the counts are already grouped by |
| `requester_role` · `requested_by_user_id` · `requested_at` | **Who asked** — vendor or agency. On a `pending` row this is the whole question |
| `responded_by_user_id` · `responded_at` | |
| `vendor_policy_version_at_approval` · `agency_policy_version_at_approval` | Snapshots taken at approval |
| `reapproval_required_from` · `paused_at` · `paused_reason` | ⚠ **Which side must act, and why** — set only while `paused_reapproval`. `vendor_policy_changed` or `agency_policy_changed` |
| `rejection` · `withdrawal` · `termination` | Each with role, actor, timestamp and reason/note. `termination.reason` is `unilateral` or `reapproval_declined` |
| `status_history[]` | The full trail |

The module already exposes both sides to their own sessions —
`routes/vendor-connection.routes.ts` and `routes/agency-connection.routes.ts`. **What has no door
is the administrative view.**

---

## What we are asking for

### `GET /api/v1/vendors/:vendorId/agencies`

| | Proposed |
|---|---|
| **Permission** | `vendors.read` **+** `agencies.read` — a composite `all`-mode guard |
| **Transport** | Delegated |
| **Pagination** | `page`, `limit` |
| **Sorting** | `createdAt` (default `-createdAt`), and `status` if it is cheap |
| **Filter** | `status` — the six-value token |
| **Audited** | No. It is a read of a business relationship, not a disclosure |

> ### Why the composite guard, and why not `vendors.read` alone
>
> The rows name agencies and carry their business names and commercial state, so gating on
> `vendors.read` alone would be a second door onto the agency directory — **the exact argument
> `shipments.md` gives for `GET /shipments/:shipmentId/offers` requiring `shipments.read` +
> `agents.read`.** `GET /agents/:agentId/contracts` is guarded the same way for the same reason.
>
> ⚠ **If that is too strict, please say so rather than widening it silently.** The alternative —
> `vendors.read` alone, with `agency.businessName` withheld from anyone lacking `agencies.read` —
> is a projection that changes by caller, and `GET /system/errors` is the only endpoint on this
> service that does that. We would rather have the composite guard.

### The row

```jsonc
{
  "success": true,
  "data": [
    {
      "id": "6690aabbccddeeff00112233",
      "agency": {
        "id": "665c0011223344556677889a",
        "businessName": "Littoral Express Delivery",
        "status": "active",
        "contactName": "Nadège M.",
        "country": "CM"
      },
      "status": "active",
      "isDefault": true,
      "productCount": 42,

      "requestedBy": "agency",
      "requestedAt": "2026-02-11T09:00:00.000Z",
      "respondedAt": "2026-02-11T14:20:00.000Z",

      "policyVersions": { "vendorAtApproval": 3, "agencyAtApproval": 7 },

      "reapproval": { "requiredFrom": null, "pausedAt": null, "pausedReason": null },
      "rejection": null,
      "withdrawal": null,
      "termination": null,

      "createdAt": "2026-02-11T09:00:00.000Z",
      "updatedAt": "2026-08-02T10:11:00.000Z"
    }
  ],
  "meta": { "total": 9, "page": 1, "limit": 20, "pages": 1 }
}
```

| Field | Notes |
|---|---|
| **`agency`** | The same decoration `GET /agents/:agentId/contracts` returns. `businessName` **`null`** where the Magazin has none — never `""`, never `contactName` substituted. The `businessName` / `contactName` distinction [BR-006](BR-006-agency-name-on-contract-rows.md) established holds here unchanged |
| **`productCount`** | ⚠ **The ask names this explicitly** — *"the total number of products held by those agencies"*. Count of this vendor's products whose resolved delivery agency is this one, using whatever definition `deliveryAgency` on the product row already uses (product override, else the vendor default) |
| **`isDefault`** | Whether this is the vendor's `defaultDeliveryAgencyId`. It is one boolean and it saves the client a second comparison against a field on a different payload |
| `requestedBy` | `requester_role` — **`vendor` or `agency`.** On a `pending` row this is the entire question, exactly as `terms.proposedBy` is on a pending contract |
| `reapproval.pausedReason` | `vendor_policy_changed` · `agency_policy_changed` · `null`. **This is what makes a paused row actionable** — it says whose policy change caused it and, with `requiredFrom`, who has to move |
| `rejection` / `withdrawal` / `termination` | ⚠ **`null` when it did not happen**, present as a whole object when it did — the `dispute` pattern from `GET /orders/:orderId`, not a block of nulls that reads as "unknown" |
| `status` | The six-value token. We will render an unrecognised value rather than reject it |

**`status_history` is deliberately not requested here.** A list row does not want it. If a
connection detail read is ever built, that is where it belongs.

### ⚠ One question we cannot answer ourselves

Is `productCount` cheap? It is a `countDocuments` per row against the vendor's catalogue, and a
vendor with nine connections and 4,000 listings is nine counts. **If it is expensive, we would
rather have the field omitted than have the endpoint be slow** — say so and we will render the
column as "—" with a note, or drop it. What we cannot do is compute it: `GET
/vendors/:vendorId/products` has **no `deliveryAgencyId` filter**, so the client's only route to
the number is paging the entire catalogue and tallying `deliveryAgency.id` by hand.

*(If a `deliveryAgencyId` filter on the products list is easier than a count on this one, that
would also close it — `meta.total` on a filtered page is the same number.)*

---

## What the dashboard does in the meantime

The Overview panel keeps the seven counts and gains an explicit, named gap — *"the individual
connections need `GET /vendors/:vendorId/agencies`; see BR-018"* — rather than an empty table that
reads as "this vendor works with nobody".

**One partial view ships now**, and it is labelled as partial: the agencies that appear on the
vendor's own catalogue rows, derived from `deliveryAgency` on `GET /vendors/:vendorId/products`
and de-duplicated, with the product tally that page can honestly support. ⚠ **It is explicitly
captioned as "agencies currently carrying stock", not "connections"** — because a pending,
paused, rejected or terminated connection cannot appear in it, and presenting that subset as the
roster would be worse than presenting nothing.
