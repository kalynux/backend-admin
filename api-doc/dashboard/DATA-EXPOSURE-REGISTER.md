# Data exposure register

**Verified against source on 2026-09-08** — a dated working record, left as history. Its seven items and their resolution banners re-read; the live-tracking answers on item 1 (the two audit actions `agents.tracking.position.read` / `shipments.tracking.trail.read`, the `reason` bounds, and `withheld: "tracking_allow_off"`) confirmed against `admin/src/modules/agents/domain/tracking-disclosure.ts:139-206` and `audit/domain/audit.catalog.ts:392-398`. No claim on this page was found to be false.

**For the `wi-admin` backend team.** Written by the dashboard, from the dashboard's side of the
contract. Nothing here is a dashboard bug — every item is something the API hands us that we then
have to decide whether to draw.

Companion to [`BACKEND-INTEGRATION-MATRIX.md`](BACKEND-INTEGRATION-MATRIX.md), which records what the
backend *does not* provide. This one records what it provides that perhaps it should not, or should
provide differently.

Opened 2026-08-15 during Phase 8 (agencies and agents), extended the same day by Phase 9 (orders and
shipments). Add to it as later phases find more.

---

## How to read this

Each item says what arrives, who can see it, what the dashboard currently does, and what we are
asking for. The dashboard's rule is *do not expose sensitive information merely because a response
happens to contain it* — so we already withhold or gate several of these client-side. That is a
mitigation, not a fix: **the data still crosses the wire to every browser holding the permission**,
and any other client built against the same API gets it with no mitigation at all.

**Tier reminder.** `agents.read` and `agencies.read` are held by **tier 3 (Support)** — 23 of 110
permissions, the tier that answers delivery tickets. Everything below is visible to them unless
stated otherwise.

### What is already handled well, so it is not on this list

Credit where due: `AGENT_LIST_PROJECTION` / `AGENT_DETAIL_EXTRAS` are **whitelists**, and the
repository names what it refuses and why — `legal_identity` (driver's licence and national ID
numbers), `payout_details` (bank accounts and mobile-money MSISDNs), `home_base.location` (a
2dsphere point on a residence), `wa`. (`emergency_contact`, a third party's name and phone, was on
this list until **2026-09-21**, when the owner reversed it: it is now on the agent **detail** only,
never the list, under `agents.read`, so Support sees it. See ADR-009 § Amendment 2026-09-21.) The agency
repository refuses `payout_details` and `wa` on the same reasoning. `trust_signals` and `device` are
enumerated field by field rather than taken whole, with a comment explaining that the alternative
lets a sensitive field added next year arrive automatically.

None of that reaches the dashboard, so none of it needed handling here. The items below are the
residue.

---

## 1. `tracking.lastKnown.position` — a person's coordinates, ungated and unaudited

> ### ✅ ANSWERED 2026-08-17 — and the premise was not true
>
> **Backend note, added with BR-003's implementation.** See
> [ADR-018](../../docs/ADR-018-DASHBOARD-BACKEND-REQUESTS.md) F-1 and D-2.
>
> **This block was empty on every agent in the database, so the disclosure described below was
> not occurring.** geo-tracker POSTs its tracking-state notifications to
> `TRACKING_STATE_NOTIFY_PATH`, whose published default is `/api/tracking/agent-state` —
> jovi-mall served no such path. A receiver *had* been built, at
> `POST /api/internal/agents/:agentId/tracking-state`, and the notifier has never called it.
> Delivery is best-effort and a non-2xx is logged and dropped, so neither side raised anything
> and `last_known_tracking_state` stayed at its schema default (`status: "unknown"`,
> `last_position: null`) since the tracking lifecycle shipped.
>
> That is now fixed in both repositories, and geo-tracker's notification carries a `position` it
> never carried — so the question below becomes live for the first time.
>
> **Decision on both asks: the block stays under `agents.read`. No new permission, no audited
> read.** The product owner accepted the reading in the "deliberate product decision" paragraph
> below — a last-known position is a historical record rather than live tracking, withholding it
> is harmful in exactly the situation an operator opens the screen for, and a denied tracking
> verdict means *do not track them now* rather than *erase where they were last seen*.
>
> `lastKnown.place` was added on the same terms and inherits the same gate.
> `position.accuracyMetres` was **not** added: geo-tracker records no accuracy anywhere, so the
> field would be `null` on every row in every circumstance.

**Priority: high.**

`GET /agents/:agentId` returns, under plain `agents.read`:

```jsonc
"tracking": {
  "allowed": false,
  "lastKnown": {
    "status": "tracking",
    "position": { "type": "Point", "coordinates": [9.7043, 4.0511] },
    "reportedAt": "2026-08-15T09:12:04.000Z",
    "isStale": true
  }
}
```

**What we are flagging.** The block ships **unconditionally**:

- regardless of `tracking.allowed` — a person who has had tracking switched off still has their last
  position returned on every detail read;
- regardless of the `/tracking-policy` verdict, including `no_approved_agency`, whose own
  documentation says *"nobody is entitled to watch an unaffiliated person move around"*;
- with no permission of its own, so tier-3 Support receives it while answering an unrelated ticket;
- with no audit row, unlike `GET /money/payouts/:payoutId/destination`, which is the service's one
  audited read precisely because **the disclosure is the action**. This is the same class of
  disclosure and has no equivalent.

**What the dashboard does.** The Tracking panel always calls `/tracking-policy` first and renders the
authoritative verdict. The coordinates themselves sit behind an explicit *"Show last known position"*
action — the payout-destination reveal pattern — with `isStale` and `reportedAt` shown above them,
rendered as copyable text and never as a live map marker.

**A deliberate product decision, for you to overrule if you disagree.** We do **not** gate the reveal
on `trackingAllowed`. A last-known position is a historical record rather than live tracking, and
withholding it is harmful in exactly the situation an operator opens the screen for — a delivery gone
wrong, an agent unreachable. A denied verdict means *do not track them now*; it does not erase where
they were last seen. If your reading of the policy differs, say so and we will gate it.

**Asks.**

1. Gate the field on a permission of its own, or drop it from the detail payload and serve it from
   `/tracking-policy`, which already resolves the verdict and already has the agent loaded.
2. Audit the disclosure, whichever way it is served. We cannot do this from the client — there is no
   endpoint to call.

> ### 📌 Both asks were GRANTED — for a different field, at Phase 6.I (2026-08-22)
>
> **Backend note.** See [ADR-020](../../docs/ADR-020-ADMIN-DATA-DOOR.md) D-4 … D-6.
>
> `tracking.lastKnown` itself is **unchanged**: still `agents.read`, still unaudited, still
> shipped with `isStale`. The 2026-08-17 answer above stands, and the product reasoning behind
> it — a last-known position is a historical record, and a denied verdict means *do not track
> them now* rather than *erase where they were last seen*.
>
> What changed is that the sentence *"the live position lives in geo-tracker and this service
> has no door to it"* is **no longer true**. geo-tracker gained a service-caller authorization
> path, so `GET /agents/:agentId/live-position` now exists — and it is precisely what asks 1
> and 2 described:
>
> - **Its own permission** (`agents.tracking.read`; the delivery trail is
>   `shipments.tracking.read`), rather than riding `agents.read`.
> - **Audited on every call**, `agents.tracking.position.read`, with the row committed
>   **before** the disclosure and its failure not caught — so with the audit store down,
>   nothing is disclosed. Same posture as `GET /money/payouts/:payoutId/destination`.
> - **A `reason` is required**, 3–200 characters, recorded on the row.
> - **Tracking Allow gates it**, which the stale mirror deliberately is not: an agent who has
>   not granted it answers `position: null, withheld: "tracking_allow_off"` — and no timestamp
>   either, because that they are streaming is itself part of what the opt-out withholds.
>
> **Support holds both new permissions.** That was decided rather than defaulted — *"where is
> my delivery right now"* is what a ticket asks — and the audit is the other half of the same
> decision. Widening the audience and adding the record were one choice.
>
> **For the dashboard, the practical consequence is that these are two different fields
> answering two different questions.** `tracking.lastKnown` is *where were they last seen*
> (free, unaudited, safe to render on every detail load). `live-position` is *where are they
> now* (a stated reason, an audit row per call, and a permission not everyone holds). The
> reveal pattern you already built for `lastKnown` is the right shape for the new one too —
> but every reveal is now a recorded event, so do not poll it behind the operator's back.
>
> `GET /shipments/:shipmentId/tracking-trail` is the third: a delivery's GPS trail, audited on
> the same terms. Note there is deliberately **no** agent-scoped trail read anywhere — a trail
> is reachable only by naming a delivery, on both sides of the boundary.

---

## 2. Five nested objects ship `snake_case`

> ### ✅ FIXED 2026-08-17 — all five, and **this is a breaking change**
>
> Every one is named-field mapped and camelCase now, and each is documented field by field:
> `agent.vehicle`, `agent.device` and `agent.trustSignals` in `agents.md`; `agency.policies` in
> `agencies.md`; `contract.terms.{employment,remittance,feeSplit}` in the new `contracts.md`.
>
> **One correction beyond the casing:** `agent.vehicle` was *documented* as `{ type, plate }`
> while *serving* `{ vehicle_type, plate_number, color, photo_file_id }` — the contract and the
> wire disagreed on the field names too. It is now `{ type, plateNumber, color, photoFileId }`,
> and `type` is the vehicle type (`bike` · `car` · `van` · `truck`), not the `"motorcycle"` the
> old example showed.
>
> The projections stay wide on `agency.policies` (and now on the vendor's, item BR-008) with the
> **mapper as the second lock** — a field added upstream reaches the read model and stops there.
> One consequence for the dashboard: the forward-compatible "Other terms recorded" passthrough
> will now always be empty, so it is belt-and-braces rather than a drift detector.

**Priority: medium — a contract-conformance bug, not a privacy one.**

`README.md` promises: *"Wire fields are `camelCase`. Both databases are snake_case; the translation
happens in wi-admin and never leaks."* For these five it leaks, because the controller assigns the
Mongo sub-document **whole** instead of mapping named fields:

| Field | Documented as | Actually ships | Assigned at |
|---|---|---|---|
| `agent.vehicle` | `{ type, plate }` | `{ vehicle_type, plate_number, color, photo_file_id }` | `agent.controller.ts:150` |
| `agent.device` | `{ platform, appVersion }` | 8 keys incl. `app_version`, `location_permission`, `battery_optimization_exempt`, `reported_at` | `agent.controller.ts:226` |
| `agent.trustSignals` | undocumented | 13 keys, all `snake_case` | `agent.controller.ts:236` |
| `agency.policies` | undocumented | `IAgencyPolicies` — 4 nested blocks, all `snake_case` | `agency.controller.ts:145` |
| `contract.terms.{employment,remittance,feeSplit}` | undocumented | 3 raw sub-documents | `contract.dto.ts:88-90` |

Each of these files carries a header saying *"Named-field mapping, not a spread — the second lock
after the projection"*, and holds to it everywhere except these five assignments.

The projections themselves are enumerated (your own `test-agents.ts:254-262` pins that), so the key
sets are bounded and we have typed them as they actually ship. If you fix the mappers our types
break, which is the correct failure mode — but please tell us, rather than shipping it as a patch.

**Ask.** Either map the named fields, or qualify the camelCase promise in `README.md` and document
these five shapes. Note that `agency.policies` and `contract.terms.*` are argued for on the backend
as considered exceptions *to the projection rule*; that argument does not extend to the casing.

---

## 3. `PUT /agents/:agentId/cod-threshold` under-records its own audit row

> ### ✅ FIXED 2026-08-17 — diagnosis confirmed exactly as written below
>
> `asState()` now reads **both** shapes — `cod.maxThreshold` on an agent and `maxThreshold` at
> the top level on a `CodAllocation` — rather than branching on the action, so a future endpoint
> answering either is covered without anybody remembering this.
>
> The two documentation errors rode along and are corrected: the gateway is annotated
> `Promise<PlatformCodAllocation>` with the shape declared, and `agents.md` documents the real
> response instead of "the updated agent". Your judgement that the response shape itself is good
> is recorded there too — a fresh allocation tells a client the resulting headroom, where an
> agent would have to be re-read.

**Priority: medium — an audit-integrity bug.**

The endpoint answers with a `CodAllocation` (`{ agentId, maxThreshold, allocated, headroom,
contracts[] }`), because jovi-mall's handler runs `setAgentThreshold` then `getAllocation` and returns
the latter. wi-admin forwards it untouched.

But `agent.gateway.ts`'s `asState()` builds the audit row's `after` by reading
`agent.cod?.maxThreshold` — and an allocation carries `maxThreshold` at the **top level**. So
`after.codMaxThreshold` is always `null`, on the one write on this surface flagged `financial`.

Two related documentation errors ride along: `agents.md` describes the response as "the updated
agent", and `agent.gateway.ts:273-278` annotates it `Promise<PlatformAgent>`.

**Ask.** Fix `asState()` to read the allocation shape, and correct the annotation and the doc. The
response shape itself is good — the fresh allocation is more useful to a client than the agent.

---

## 4. Residual personal data on `/agents`, by design but worth a second look

> ### ✅ ANSWERED 2026-08-17 — confirmed intended as-is
>
> The tier-3 read scope on the agent detail stands. `device.*` and `homeBase.label` answer
> genuine dispatch questions — `device_location_disabled` is a real ineligibility reason, and the
> home base bounds the service radius — and a narrower Support projection would make "why can
> this agent not be assigned" unanswerable at the tier that asks it most often.
>
> One change rode along from item 2: `device` and `trustSignals` are camelCase and documented
> now, so what Support sees is at least legible in the contract.


**Priority: low — recorded so the decision is explicit rather than inherited.**

All under `agents.read`, i.e. visible to Support:

| Field | What it is | Dashboard treatment |
|---|---|---|
| `homeBase.label` | The area a person lives in, e.g. `"Bonapriso, Douala"` | Detail only, never a list row |
| `vehicle.plate_number` | A licence plate — identifies a person off-platform | Detail only, in the Operational panel |
| `device.*` | An 8-field device fingerprint: OS, app version, location-permission state, battery-optimisation exemption | Detail only, collapsed by default, framed as dispatch diagnostics |
| `email`, `phone` | Contact PII, on **list rows** | Kept — the directory is unusable without a searchable identifier |
| `statusReason`, `ban.reason`, `tracking.reason` | Free text an administrator wrote about a person | Shown where the state they explain is shown |

`device.*` and `homeBase.label` both answer genuine dispatch questions —
`device_location_disabled` is a real `IneligibilityReason`, and the home base bounds the service
radius — so we are not asking for their removal. We are asking whether Support needs them, or whether
these belong behind the tier-2 grant.

**Ask.** Confirm the tier-3 read scope on the agent detail is intended as-is. If a narrower Support
projection is wanted, it is a backend change; we would rather not approximate one client-side, because
a second client would not have it.

---

## 5. Agency business-identity documents

> ### ✅ ANSWERED 2026-08-17 — no change, and none needed
>
> Business identifiers rather than personal ones, and appropriate for an administrator.
> `policies.documents[]` is now documented in `agencies.md` as links to off-platform term
> sheets that this service never fetches or previews — which is exactly what the dashboard does
> with them.


**Priority: low.**

`GET /agencies/:agencyId` returns `kyc.registrationNumber` and `kyc.transportLicenseId` under
`agencies.read` — business identifiers rather than personal ones, and plausibly fine for an
administrator. Recorded because they are identity documents and the surrounding fields are gated more
tightly.

`policies.documents[]` holds up to two URLs to off-platform term sheets. The dashboard renders them as
links and never fetches or previews them, since we resolve no file URLs anywhere.

**Ask.** None, unless you disagree. Flagged for completeness.

---

## 6. Three order writes return the whole raw platform document

> ### ✅ FIXED 2026-08-20 — Phase 4 step 16 (4.B.4)
>
> All three writes now answer with an **`OrderDetailDto`**: the order is re-read through
> `ORDER_DETAIL_PROJECTION` and mapped by `toOrderDetailDto` — so `delivery_address.coordinates`,
> `raw_input` and `items[].delivery.pickup_location.address_snapshot` are excluded by the same two
> locks that guard the read, and nothing snake_case leaves. `dispatch` keeps
> `{ shipmentsAssigned, order }`; only the `order` half changed, and `0` is still a no-op rather
> than an error.
>
> **The fix is one function, deliberately.** `readOrderDetail(orderId)` in
> `order.controller.ts` is what `GET /orders/:orderId` answers through as well, so the write and
> the read cannot disagree — which is the class this finding is, not just the instance. A field
> added to the DTO reaches all four surfaces or none.
>
> **⚠ Keep the client-side mitigation.** `orders.service.ts` discarding `data` structurally, and
> `OrderDetail.test.tsx` asserting stubbed coordinates never reach the DOM, are defence in depth
> against the *next* delegated write — not a workaround for this one. They should survive the
> fix. Adopting the returned DTO to save a refetch is a separate, optional change.
>
> Documentation corrected with it: `orders.md` in all three places (it described two of them as
> "the updated order"), and `BACKEND-INTEGRATION-MATRIX.md`'s Phase 9 correction 1 and its
> **camelCase** rule row, which carried dispatch as the one documented casing exception. There is
> now no exception.


**Priority: high.** Found in Phase 9 (orders and shipments).

**What arrives.** `POST /orders/:orderId/cancel`, `POST /orders/:orderId/dispute/resolve` and the
`order` half of `POST /orders/:orderId/dispatch` answer with jovi-mall's **entire Mongoose order
document**, forwarded untouched. It is snake_case, and it carries — among everything else —

- `delivery_address`, a full `GeoAddress` including **`coordinates`** (2dsphere-indexed) and
  **`raw_input`**, the text the customer typed before picking a geocoding result;
- every `items[]` entry whole, including `delivery.pickup_location.address_snapshot`, which embeds
  the coordinates of a vendor's premises;
- `payment_intent_id` and `price_breakdown`.

**Why that is the finding.** wi-admin's own read of the same order deliberately withholds exactly
those fields. `ORDER_DETAIL_PROJECTION` names `delivery_address.formatted_address` and
`.components` as dotted paths *specifically* to exclude `coordinates` and `raw_input`, `toOrderDetailDto`
refuses them a second time, and the repository's comment says why: *"the precise latitude and
longitude of a private home is a different thing with a different blast radius"*.

Neither lock sits in the path of a delegated write's response. **So the write hands back the PII the
read refuses** — to any holder of `orders.intervene` or `orders.disputes.resolve`.

**Who can see it.** Tier 1 and tier 2. Not Support, which holds neither write. Narrower than the
other items here, and still the wrong direction.

**What the dashboard does.** `services/orders.service.ts` **discards `data` entirely** on all three —
the functions return only `{ message }`, and dispatch returns only `{ shipmentsAssigned }`. That is
structural rather than disciplinary: there is no order object for a call site to reach into, so
rendering one is impossible rather than merely discouraged. Every caller refetches through the
projected read. `OrderDetail.test.tsx` stubs a cancel response containing real coordinates and
asserts they never reach the DOM.

**Ask.** Map the write responses through `toOrderDetailDto` before answering — wi-admin already
re-reads the order to build the audit row's `before`, so the mapper is one call away — or answer with
a thin acknowledgement and let the client refetch, which is what every client will do anyway.

**Documentation note.** `orders.md:339` and `:379` both describe these as "the updated order", which
reads as the camelCase DTO. `BACKEND-INTEGRATION-MATRIX.md:378` calls dispatch "the one documented
place the storage casing surfaces" — it is three places, and the casing is the smaller half of the
problem.

---

## 7. The COD block on a shipment needs no `cod.*` permission

> ### ✅ ANSWERED 2026-08-17 — confirmed intended
>
> A support agent answering "the driver says he never got the cash" needs the collection state,
> and withholding it pushes them toward a surface they cannot reach. The delivery code itself
> stays excluded twice over, and your note that the projection whitelist is the *only* guard —
> because this service reads with the raw driver, which does not honour `select: false` — is
> correct and worth keeping visible.


**Priority: low — recorded for a decision, not as a fault.**

`GET /shipments/:shipmentId` returns `cod` — the collection id, its status, the expected amount, the
verification method, the attempt count and the lock flag — under **`shipments.read` alone**, which
tier 3 Support holds. Every other cash surface on the service sits behind the `cod` family, and seven
of those permissions are flagged `financial` and refused to Support at boot.

The delivery code itself is properly protected, twice over, and that is the part that matters: the
projection whitelist excludes `code_plain` and `code_hash`, and the mapper has no line for either.
Worth knowing that the whitelist is the *only* guard — jovi-mall marks the column `select: false`,
but wi-admin reads with the raw MongoDB driver, which does not honour it.

**Ask.** None, if this is intended: a support agent answering "the driver says he never got the cash"
needs the collection state, and withholding it would push them to a surface they cannot reach.
Recorded so the asymmetry with `/cod` is a decision rather than an oversight.

---

## Cross-reference

Contract drift found alongside these, tracked in the phase plans rather than here because it is
correctness rather than exposure.

**Phase 8:** the `/tracking-policy` response has seven fields and a fourth `denyReason` value the
docs omit; `cod-allocation` and `eligibility` have no documented response shape; agency
deactivate/reactivate are idempotent no-ops rather than the documented `409`; and the delegated
failure codes are published nowhere, with agencies using a `DELIVERY_` prefix that defeats the
obvious guess.

**Phase 9:** `meta.searchMatchesTruncated` is undocumented on both new lists; `disputedAt` is the
dispute queue's default sort key and is not on the row it sorts; `assignment.offerCount` is a capped
read indistinguishable from a total; `shipment.read.repository.ts`'s `findForOrder` is dead code
whose docstring describes a field the order detail does not have; `SHIPMENT_NO_ELIGIBLE_AGENTS` is a
partial success rather than a refusal; a `502` on refund is not disambiguable by any client; and
`shipments.md:159` shows `"source": "wi-admin"` for the fourth time across four doc pages.

**Also Phase 9, and closer to exposure than to drift:** there is **no path from an order to its
customer's account**. `orders.customer_id` is a `customers._id`; `GET /users/:userId` and
`?search=<24hex>` both key on `users._id`. The join exists in the database — `customers.user_id` is
`required: true, unique: true` — but `CustomerRefReadRepository` projects only
`{_id, name, phone, email}`, so it never reaches the wire. A one-field projection widening plus a
`customerUserId` on the order DTOs would close it. Until then the dashboard offers "their other
orders" and says on the detail why there is no account link, so the absence does not read as a bug.
