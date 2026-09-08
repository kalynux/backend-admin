# BR-008 · A vendor's commercial terms, and completing the agency's

**Verified against source on 2026-09-08** — the projected vendor `policies` content (its `returns`,
`cancellation` and `support` blocks and the derived booleans) against
[`vendors.md`](../../api/vendors.md) and `admin/src/modules/vendors/read-models/vendor-policies.dto.ts`, and
`policyVersionPausedConnections` against [`agencies.md`](../../api/agencies.md).

> ### ✅ BUILT — the asymmetry is closed, and the answer went **against** the caution in § 1
>
> **Answered in [`RESPONSE-2026-08-17.md`](RESPONSE-2026-08-17.md).** A vendor's commercial terms
> are **not** more sensitive than an agency's — they are published to every customer on the
> storefront, a strictly wider audience than the connected vendors the agency exception was granted
> for. So `policies` now carries `returns`, `cancellation` and `support` in full, each `null` when
> the vendor stored none, with the three booleans kept and **derived** from the content. That was a
> **breaking** change. `policyVersionPausedConnections` is on the agency detail. **No policy write
> was added**, and that remains the position.
>
> ⛔ *"Vendor — four booleans"* and *"`agencies.md` documents the whole block as `{ "…": "…" }`"*
> are the 2026-08-17 state; both blocks are documented field by field now, and both are camelCase
> on the wire. The dashboard's *"which terms are not available"* section can go.

**Priority: medium.** One asymmetry between two directories, plus a small hardening ask on the one
that already works.

## The ask

> Just like agency, we should be able to see exactly what they set up on their terms (policy).

Read against the three directories: give **vendors** a terms view, give **agents** one, and make the
**agency** one richer.

## What exists today

### Agency — good, and worth using as the model

`GET /agencies/:agencyId` returns `policies` **whole**, and the backend's own comment records why that
was a considered exception rather than an oversight:

> *"these are commercial terms already visible to every connected vendor, so there is no field that
> could be added to them which this surface should not see."*

That reasoning is sound, and the result is a real screen: pricing (storage-based and pickup-based),
additional fees (COD handling, failed delivery, RTO, peak surcharge), returns, damage, COD limits,
notes and up to two off-platform document links. The dashboard renders every field of it.

Two caveats, neither fatal:

- **`agencies.md` documents the whole block as `{ "…the agency's own commercial terms…": "…" }`.** The
  dashboard's types were read out of jovi-mall's `delivery-agency.model.ts:159-222`, not out of the
  contract.
- **It ships `snake_case`** (`monthly_storage_fee_per_sku`, `return_window_days`,
  `claim_deadline_days`), against README's camelCase promise. Already on
  [`DATA-EXPOSURE-REGISTER.md`](../DATA-EXPOSURE-REGISTER.md).

### Vendor — four booleans

`GET /vendors/:vendorId` returns:

```jsonc
"policies": {
  "policyVersion": 4,
  "hasReturnPolicy": true,
  "hasCancellationPolicy": true,
  "hasSupportPolicy": false
}
```

[`vendors.md`](../../api/vendors.md) is explicit that this is **"presence, not content"**, and
notes that *"~30 fields of the vendor's own commercial terms exist"* upstream and are not projected.

So an administrator can see *that* a vendor has a return policy and not *what it says* — which is
precisely the question a dispute lands on.

### Agent — nothing, and correctly so

An agent has no policy document of their own. Their terms are **per-contract**, and they already ship:
`terms.employment`, `terms.remittance`, `terms.feeSplit`, `coverageRegions`, `shipmentValueCeiling`.
See [BR-004](BR-004-contract-administration.md) for the documentation problem there. **No new endpoint
is needed for the agent half of this ask** — the data exists, and the dashboard now renders it from
inside the Agencies tab, where it belongs.

## What the dashboard does in the meantime

- **Vendor → new Terms tab.** Renders the four booleans honestly as presence flags, states the version,
  explains what a version bump does — *it pauses every agency connection pending re-approval* — and
  cross-links `counts.agencyConnections.pausedReapproval`, which is the only place that consequence is
  currently visible. It then says plainly which terms are not available. **It does not invent the
  missing fields.**
- **Agency → Terms tab** gains a forward-compatible passthrough: any key in `policies` the type does
  not recognise renders under *"Other terms recorded"* rather than being dropped. The block is
  undocumented and projected whole, so it will gain fields; silent drift becomes a visible fact.
  Unknown values render as text nodes only.
- Neither tab offers an edit, and that stays true regardless of this request — see below.

## The proposed contract

### 1. Project the vendor's policy content, the way the agency's already is

```jsonc
"policies": {
  "policyVersion": 4,
  "returns":      { "…the vendor's own terms…" },
  "cancellation": { "…" },
  "support":      { "…" }
}
```

The presence booleans can stay — `hasReturnPolicy` is cheap and a client may want it before rendering
a block — but they should be derived from the content rather than being the only thing available.

**The question to answer explicitly:** is a vendor's commercial policy more sensitive than an
agency's? The agency exception was argued on the grounds that the terms are *already visible to every
connected party*. A vendor's return and cancellation policy is shown to every customer on the
storefront, which is a strictly wider audience. If that argument carries, the same passthrough is
justified. If it does not, record why — the asymmetry is currently unexplained, and that is the part
that reads as an oversight.

### 2. Document both blocks, and fix the casing once

If the vendor block ships as a second whole-subdocument passthrough, the `snake_case` leak becomes two
rather than one. Better to map both to `camelCase` in the same change, and document the field names in
`vendors.md` and `agencies.md`.

**If you do, tell us.** The dashboard's `AgencyPolicies` type is pinned to the current `snake_case`
shape deliberately — an aspirational camelCase type would render `undefined` and nobody would notice —
so a fix breaks our build loudly, which is correct only if it is expected.

### 3. The paused-connection count for a policy version

On the agency detail:

```jsonc
"policyVersion": 4,
"policyVersionPausedConnections": 12
```

`policyVersion` is the field with the largest blast radius on that screen — bumping it pauses **every**
vendor connection for re-approval — and there is currently no way to see how many are sitting in that
state as a result. The vendor side has `counts.agencyConnections.pausedReapproval`; the agency side has
nothing equivalent.

### 4. What is **not** being asked for: an edit

Both surfaces refuse policy writes, and both refusals are right. Restating so this request is not read
as opening the door:

> *"Pricing, returns and damage terms are the agency's own commercial record, negotiated with the
> vendors connected to it. Every edit bumps `policyVersion`, which pauses those connections for
> re-approval — an administrator changing a price on their behalf would silently re-open every
> relationship they have."*

This is a **read** request. Please do not add a write.

## Acceptance

- [ ] A decision is recorded on whether vendor policy content is projected, with the reasoning either
      way in `vendors.md`.
- [ ] If projected, the field names are documented, not left as `{ "…": "…" }`.
- [ ] The agency `policies` block is documented field by field in `agencies.md`.
- [ ] The `snake_case` leak is either fixed in both **and announced**, or recorded as a deliberate
      exception in the contract.
- [ ] `policyVersionPausedConnections` (or equivalent) exists on the agency detail.
- [ ] No policy write is added.
