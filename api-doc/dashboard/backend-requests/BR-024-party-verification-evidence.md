# BR-024 · The evidence behind a verification verdict — for vendors, agencies and agents

> ### ✅ ANSWERED, and it was already being built — live contract [`verification.md`](../../api/verification.md)
>
> **Shipped 2026-09-14, the same day this was written.** Three routes, one per party:
>
> ```
> GET /api/v1/vendors/:vendorId/verification     vendors.read
> GET /api/v1/agencies/:agencyId/verification    agencies.read
> GET /api/v1/agents/:agentId/verification       agents.read
> ```
>
> **The half of this request that was right is the half we kept**: the backend grades nothing —
> *"There is no `estimatedVerdict` field. No `complete`. No `required` column. … The response is
> **facts**; the badge is **yours**"* — and its per-role checklist is the same table this document
> proposed, rule for rule. `jovi-mall test:kyc` § 4 fails if a completeness check ever appears on
> that side. `src/lib/verification-review.ts` is that policy, and it is now the shipped one.
>
> ⛔ **Five things this document proposed were wrong, and each was decided the other way for a
> stated reason. They are worth reading before the next request.**
>
> | This asked for | What shipped | Why |
> |---|---|---|
> | the **review** permission (`vendors.kyc.review` …) | the ordinary **`*.read`** | Support holds `read`, answers *"why was my shop rejected"* tickets, and **cannot answer one from a status alone**. The verdict keeps its own permission; the evidence does not need to |
> | **audited**, as a fifth audited read | **not audited** | *"They disclose different things."* This hands over names, sizes, types and handles — roughly what `files.resolve` already gives any tier. **Looking at the picture is the disclosure**, and `files.content.read` already records that. Auditing both makes every review two rows and tells an investigator nothing |
> | `*FileId` strings to resolve | embedded **`FileDetail`** objects | No second request per document. The dashboard renders them through `ImageBox`'s `file` variant |
> | one sketch per address | **arrays** — `homeAddressSketches[]`, `storeAddressSketches[]`, capped by `limits.multiSlotMaxFiles` | An applicant may legitimately send four photographs of one hand-drawn map |
> | an explicit `premises.present` flag | derived from **`storeAddresses[]`** — and **absent, not `[]`, for an agent** | The array is the answer. ⚠ `undefined` vs `[]` is load-bearing: *the question does not apply* against *they have no shop* |
>
> ✅ **And it brought something this request did not think to ask for, which turned out to matter
> more than anything in it: `submittedAt`, `locked`, and the queue rule.** `status: "pending"` is
> also the schema default on a vendor and an agency, so **filtering a review queue on `status`
> lists every account that ever registered**. The timestamp is what separates *a draft nobody
> asked you to look at* from *waiting for you*, and the estimator now refuses to grade a draft at
> all — badging a half-filled one *evidence incomplete* is true and is not a finding.
>
> ⚠ **One thing to fix on the page**: its error table lists `404 KYC_SUBJECT_NOT_FOUND` as an
> `error.code`. It is declared in `jovi-mall/src/core/error-codes.ts`, is in **neither** wi-admin
> registry, and this read is **delegated** — so it arrives as `PLATFORM_OPERATION_REJECTED` with
> the code in `details.platformCode`. A client branching on `error.code` would never match it.
> `PLATFORM_CODE_KYC_SUBJECT_NOT_FOUND` in `src/types/verification.types.ts` says so.
>
> ⛔ The storage-tree ask below is **already done** — `kyc: 'private'` is live, which is why every
> document resolves `url: null` / `access: "authorized"`. Everything under *"The data that exists
> nowhere"* now exists.
>
> ---
>
> ### ✅ Closed out 2026-09-15 — the last two acceptance boxes
>
> Both were still open a day after this was marked answered, which is worth noticing: **the
> banner above was written about the ROUTES and quietly stood in for the whole document.** Two
> items in it were about pages rather than code, and nobody ticked them.
>
> **1 · The `KYC_SUBJECT_NOT_FOUND` row is fixed.** The ⚠ above described the defect and left it
> in place. [`verification.md`](../../api/verification.md)'s error table now names
> `PLATFORM_OPERATION_REJECTED` as the `error.code` and puts `KYC_SUBJECT_NOT_FOUND` where it
> actually arrives — `details.platformCode` — with the reason stated on the row.
>
> **2 · `agencies.md` carries `status` and `rejectionReason`.** Confirmed against
> `toAgencyDetailDto` (`agency.controller.ts:175-192`): the DTO emits **six** members and the
> page showed **four**. Both are now in the worked JSON and in the field notes, each carrying the
> reason it exists — *`pending_verification` is where an agency sits **both** before a review and
> after a refused one*, and the rejection sentence is shown to the agency, so it had better be
> visible to the operator who wrote it.
>
> ⚠ **Your diagnosis of how that happened is the durable part and it is now on the page too**:
> this dashboard transcribed a page that lagged its own service, so `AgencyKyc` declared four
> fields and the review dialog re-derived the verdict from `verified` + `agency.status` —
> reproducing precisely the ambiguity the backend had already removed. **A transcription cannot
> be diffed and a copy can.** Same conclusion as BR-025 § 1; same remedy.

**Priority: high.** Three shipped write endpoints ask an administrator to reach a verdict, and
**none of the three shows them anything to reach it from.** This is not a missing convenience; it
is a missing input to a decision the service records, audits, forwards to the party, and — on
`/agents` — enforces.

## The ask

> Currently the only information an admin can base himself on to apply a verification verdict is
> some number, which can't actually be verified. Here is the detail that needs to be shown in the
> verification popup, with a badge estimating the verdict. The required-or-optional sets of the
> information state values are what should be used to state the estimation verdict, with a
> prepopulated reason based on the verdict, to assist admins in quick and fast judgements.
>
> **The estimation check and the prepopulated reason are handled by the frontend. The backend just
> provides the data, or stores the reason.**

The division of labour in that last sentence is the shape of this request. Nothing below asks for
an `estimatedVerdict` field, a completeness score or a suggested reason. Those are computed in
`src/lib/verification-review.ts` from presence alone, are unit-tested, and are the dashboard's
job. **What is asked for is the presence.**

### What the operator checks, per party

| | Vendor | Agency | Agent |
|---|---|---|---|
| Business-premises address, geocoded | optional (*store*) | optional (*magazin / store*) | — |
| Home address, geocoded | **required when there are no premises** | **required when there is no magazin** | **required** |
| Hand-drawn sketch of the premises location | **required once a premises address is set up** | **required once a magazin address is set up** | — |
| Hand-drawn sketch of the home location | **required when there are no premises** | **required when there is no magazin** | **required** |
| ID card scan — front | **required** | **required** | **required** |
| ID card scan — back | **required** | **required** | **required** |
| ID number | **required** | **required** | **required** |
| Selfie holding the ID card | **required** | **required** | **required** |
| Plate number | — | — | optional |
| Photograph of the vehicle **with the agent beside it** | — | — | **required** |

⚠ **Exactly one of the two address sets is ever required**, and that is deliberate rather than a
simplification. A party who trades from premises has told us where to find them; a party who does
not is asked where they live instead. Requiring both would refuse every shopkeeper on the platform
for withholding a home address nobody needs — and an agency that works only for vendors holding
their own stock legitimately rents no magazin at all.

⚠ **The hand-drawn sketch is not a lesser substitute for a geocode**, and the two are checked
separately because they fail separately. Over much of the delivery area a geocoder resolves to a
neighbourhood and the last two hundred metres are carried by a landmark and an arrow.

---

## What exists today

The whole evidence base, on all three surfaces, in full:

| Party | What `GET /:id` returns for the reviewer | Contract |
|---|---|---|
| **Vendor** | `verification: { status, verified, rejectionReason, verifiedAt, reviewedBy }` — **the verdict and its author. No input of any kind.** | [`vendors.md`](../../api/vendors.md) |
| **Agency** | `kyc: { registrationNumber, transportLicenseId, verifiedAt, verifiedBy }` — **two strings a person typed** | [`agencies.md`](../../api/agencies.md) |
| **Agent** | `kyc.reference` — **one string**, documented as *"a free-form pointer to whatever document set was checked, **off-platform**"* | [`agents.md`](../../api/agents.md) |

A pointer to a document set held somewhere else is not evidence. It is a claim that evidence
exists, recorded by the same person whose judgement it is meant to support.

### Three more things the reviewer cannot see

1. **No address on any of the three carries coordinates.** `GET /vendors/:vendorId` projects
   `addresses[]` as `{ id, label, addressLine1, addressLine2, city, state }` and drops `geo`;
   `GET /agents/:agentId` projects `homeBase` as `{ label, serviceRadiusKm }` and drops
   `location`; `GET /agencies/:agencyId` returns `coverageAreas` (region *names*) and no
   headquarters address at all. **jovi-mall stores the geocode for all three** — see below — so
   *"is this address valid"* is currently unanswerable from a field that exists one service away.
2. ✅ ~~**An agency's verdict is not on the wire.**~~ **It is — and this dashboard was not reading
   it.** See *the documentation half* below; the fix was ours and is shipped.
3. **No party has a "does this party have premises" flag**, so the conditional requirements above
   have no input. Inferring it from `business_addresses.length > 0` is wrong in both directions: a
   vendor with no shop may still record a pickup point, and an agency may record a coverage region
   with no magazin. **A party refused for not supplying a home address they were never asked for
   is the exact failure the flag prevents.**

---

## What the dashboard ships in the meantime

**A complete review dialog whose evidence rows all read "not reported".** It is the honest render
and it is deliberately not a placeholder that will need rewriting.

- One **Review verification** button per detail screen, replacing the two toolbar verdict buttons
  on `/vendors` and `/agencies`. Those asked the operator to pick an outcome *before* being shown
  anything to pick it from, which is the complaint in one sentence.
- `src/lib/verification-review.ts` — the checklist, the estimate and the drafted reason, pure and
  unit-tested against the shapes proposed below. It is finished; when the route lands, one
  `null` per call site becomes a fetch.
- 🔴 **Four evidence states, and the fourth is the point.** `provided` · `missing` ·
  `not_applicable` · **`unavailable`**. `missing` is a statement about the party; `unavailable` is
  a statement about the projection. **Every evidence row is `unavailable` today**, and the
  estimate is therefore `indeterminate` — it suggests no verdict, drafts no reason and preselects
  nothing. Collapsing the two would manufacture a rejection out of a gap in the contract and
  forward it, under the operator's name, to an applicant who had in fact uploaded the document.
- What the record *does* carry is shown beside the checklist and labelled as context rather than
  evidence — an agency's two reference strings, an agent's `kyc.reference` and vehicle
  photograph, a vendor's business addresses, with a line saying they carry no coordinates.

---

## The data that already exists in jovi-mall

Three of the ten rows are one projection away. They are listed first because they cost nothing but
a mapper.

| Row | Where it already is |
|---|---|
| Vendor **ID number** | `vendors.kyc_details.national_id_number` — `VendorKycDetailsSchema`, with the comment *"Vendors can submit their national_id_number, but legit_verified is admin-controlled"* |
| Agent **ID number** | `delivery_agents.legal_identity.national_id_number`, beside `drivers_license_number`. ⚠ Marked SENSITIVE and *"never exposed by the agent profile DTO"* — which is a reason for the permission below, not a reason to withhold it from the reviewer whose whole job is to check it |
| **Geocoded addresses** | `GeoAddress` (`core/types/geo-address.types.ts`) — `formatted_address`, GeoJSON `coordinates`, `provider`, `provider_place_id`, `components`, `raw_input`, `resolved_at`. Embedded on `vendors.business_addresses[].geo`, on the magazin's `headquarters_addresses[].geo`, and on customers' saved addresses. **The distinction the reviewer needs is already modelled**: `geo: null` means the party typed text and never selected a search result |

Agent home base is the partial case: `home_base.location` is a bare `GeoPoint` with a `label` and a
radius, not a `GeoAddress`. A point is enough to answer *"does this resolve to a place"*; it
cannot answer *"to which address"*. Either is usable — say which, and the dashboard renders it.

## The data that exists nowhere

- The **ID card scans** (front and back) and the **selfie holding the ID**.
- The **hand-drawn location sketches**, home and premises.
- The **vehicle photograph with the agent beside it**. ⚠ `vehicle_info.photo_file_id` exists and
  is **not this**: it is documented as *"photo of the vehicle"*. A picture of a van proves a van
  exists; this row is that *this agent* has *that van*. The dashboard renders them in separate
  sections so nobody ticks the second by looking at the first.
- The **home address** for a vendor or an agency. `vendors` has `business_addresses` only;
  `delivery_agencies` has the magazin. Neither models a residential address for the natural
  person behind the account.
- The **premises flag** (item 3 above).

### 🔴 These files must land in a PRIVATE storage tree

`STORAGE_TREE_VISIBILITY` (`core/storage/storage-trees.ts`, ADR-A01 D-2) classifies every tree,
and the six `by-type` intake folders — `images`, `documents`, … — are all `public`, served
straight off disk by `express.static` with no database access. **A national ID card uploaded into
`images/` is fetchable by anyone holding its URL, forever**, exactly as the digital and shipments
trees were before that ADR. So the ask is a row:

```ts
// A party's identity documents: an ID card, and a photograph of them holding it.
kyc: 'private',
```

with the upload path naming `folder: 'kyc'`. `test:uploads` already asserts that every folder a
writer in `src/` can name is classified, so this is enforced rather than remembered. The files
then resolve as `url: null`, `access: "authorized"`, and
[`GET /api/v1/files/:fileId/content`](../../api/files.md) is the only door — which is the
behaviour the dashboard is already built for, and which writes an audit row naming the operator
who opened each document.

---

## The proposed contract

### One route per party, behind the review permission

```
GET /api/v1/vendors/:vendorId/verification     vendors.kyc.review
GET /api/v1/agencies/:agencyId/verification    agencies.verify
GET /api/v1/agents/:agentId/verification       agents.kyc.review
```

⚠ **Not nested on the detail read, and the reason is the tier table.** `vendors.read`,
`agencies.read` and `agents.read` are all held by **tier 3 Support**
([`permissions.md`](../../api/permissions.md)); the three review permissions are tier 1–2.
Nesting the block on `GET /:id` would hand every support agent who opens a vendor that vendor's
national ID number and their ID-card file ids, as a side effect of looking at an order. The
review permissions already name exactly the population that is meant to see this, so the door
should be the permission that already exists rather than a new one.

**Audited.** The service has four audited reads — the payout-destination reveal,
`GET /agents/:agentId/live-position`, `GET /shipments/:shipmentId/tracking-trail` and
`GET /files/:fileId/content` — and the rule they share is that the *read itself* is a disclosure
about a person. A bundle containing someone's national ID number and the ids of their identity
documents belongs in that set. `targetType` `vendor` / `agency` / `agent`; suggested action
`vendors.kyc.evidence.read` and siblings. ⚠ The dashboard is built for this: the bundle is
fetched when the review dialog **opens**, never on mounting the detail screen, so the row records
a deliberate act.

### The response

```jsonc
{
  "success": true,
  "data": {
    "identity": {
      "idNumber": "110234567",
      "idCardFrontFileId": "6650aa11bb22cc33dd44ee01",
      "idCardBackFileId": "6650aa11bb22cc33dd44ee02",
      "selfieWithIdFileId": "6650aa11bb22cc33dd44ee03"
    },
    "home": {
      "geo": {
        "formattedAddress": "Rue Njo-Njo, Bonapriso, Douala, Cameroun",
        "coordinates": [9.7043, 4.0511],
        "provider": "nominatim",
        "providerPlaceId": "way:123456789",
        "resolvedAt": "2026-08-02T09:14:00.000Z"
      },
      "rawAddress": "Derrière la pharmacie Bonapriso",
      "sketchFileId": "6650aa11bb22cc33dd44ee04"
    },
    "premises": {
      "present": true,
      "label": "Main Shop",
      "geo": null,
      "rawAddress": "Akwa, en face du marché",
      "sketchFileId": "6650aa11bb22cc33dd44ee05"
    },
    "vehicle": null,
    "submittedAt": "2026-08-02T09:20:00.000Z"
  }
}
```

| Field | Notes |
|---|---|
| `identity` | Always present; each member `null` when the party has not supplied it |
| `home` | `null` when the party records no residential address at all. `geo: null` beside a non-null `rawAddress` is the **"typed but never geocoded"** state, and the dashboard renders it as *not geocoded*, never as *no address* |
| `premises` | `null` for an agent. `present` is the **explicit** answer to *"does this party operate physical premises"* — not derived by the client, for the reason in item 3 above |
| `vehicle` | `null` for a vendor and an agency. `photoWithAgentFileId` is a **new field**, not `vehicle_info.photo_file_id` |
| `coordinates` | GeoJSON `[longitude, latitude]`, matching `GeoAddress` and every other position on this service |
| every `*FileId` | An opaque id, resolved through `GET /files?ids=` and displayed through the audited content route. **No URLs here** — these files are in a private tree and have none |

The shape is party-agnostic on purpose: one dialog, one checklist builder and one estimator serve
all three, which is why the vendor and agent blocks differ only by which members are `null`.

### Errors

| Status | Code | When |
|---|---|---|
| 403 | `AUTHZ_PERMISSION_DENIED` | Missing the review permission |
| 404 | `NOT_FOUND` | No such party, or out of scope |
| 502 / 503 | `SERVICE_DEPENDENCY_UNAVAILABLE` | If any part is delegated |

No new error codes are needed. A party with nothing on file is a `200` with a body of nulls, not a
`404` — *"they have uploaded nothing"* is the single most important answer this route gives.

### The schema changes this needs in jovi-mall

Ordered by whether anything is blocked on them.

1. **`kyc: 'private'` in `STORAGE_TREE_VISIBILITY`**, and the parties' own upload path naming it.
   Everything else waits on this: there is nowhere safe to put an ID card today.
2. **A shared identity-documents sub-document**, on `vendors.kyc_details`,
   `delivery_agencies.kyc_details` and `delivery_agents.kyc` alike —
   `id_card_front_file_id`, `id_card_back_file_id`, `selfie_with_id_file_id`, all
   `Schema.Types.ObjectId, ref: MODELS.FILE, default: null`, reference-counted the way
   `avatar_file_id` and `vehicle_info.photo_file_id` already are. Vendor and agent already carry
   the **number** (`national_id_number`); ⚠ the **agency does not** — `IAgencyKycDetails` has
   `registration_number` and `transport_license_id`, which are the *business*, not the person.
3. **`location_sketch_file_id`** on each address that can be sketched: the vendor's
   `BusinessAddressSchema`, the magazin's `HeadquartersAddressSchema`, and the new home address.
4. **A home address** for a vendor and an agency — a single `GeoAddressSchema` embed plus a
   sketch id, following `business_addresses[].geo` exactly. ⚠ If it goes in an array, mind
   `dropNullLocation`: a stored `location: null` beside a real point breaks 2dsphere key
   extraction and makes **every subsequent write to that document** fail, whatever it touches.
5. **`has_physical_premises: Boolean`** on vendor and agency, written by the party during
   onboarding. ⚠ Do **not** derive it server-side from the address array — the derivation is
   wrong in both directions and the failure lands on the applicant.
6. **`vehicle_info.photo_with_agent_file_id`** on the agent, beside the existing photo rather
   than replacing it. The old one keeps its meaning.
7. **Promote `home_base.location`** to a `GeoAddressSchema`, or state that the bare point plus
   `label` is the answer. Either is workable; the dashboard needs to know which.

### The documentation half — and a correction to this request's first draft

⚠ **This started as an ask and turned out to be a dashboard defect**, found while writing the
paragraph that asserted it. It is left in rather than deleted, because *why* it was believed is
the useful part.

**`agencies.md` is behind the service on `kyc`.** Its worked JSON (line 127) shows four members —
`registrationNumber`, `transportLicenseId`, `verifiedAt`, `verifiedBy` — and `toAgencyDetailDto`
in `admin/src/modules/agencies/controllers/agency.controller.ts` emits **six**. The two the page
omits are the two that matter most to a reviewer, and the DTO's own docstrings say why:

| Field | The source's own words |
|---|---|
| `status` | *"The verdict, added Phase 6 Step 4. **Not derivable from the agency's `status`**: `pending_verification` is where an agency sits both before a review and after a refused one, which is exactly the ambiguity this removes."* |
| `rejectionReason` | *"Set on `rejected` — and shown to the agency, who has to know what to fix."* |

This dashboard transcribed the page, so `AgencyKyc` declared four fields, and the review dialog
**derived** the verdict from `verified` and `agency.status` — reproducing precisely the ambiguity
the backend had already removed. A re-applying agency read as one nobody had looked at, and the
sentence they had been given was nowhere on the screen. Both are fixed; the type now names the
controller as its source and says why.

**The ask is therefore a page edit, not a field**: add `status` and `rejectionReason` to
`agencies.md`'s `kyc` example and field notes. ⚠ It is the fourth time a page in this bundle has
lagged its own service and the third time this repository has shipped the lag — `/content` is the
large one (BR-014), and the standing lesson applies again: **a transcription cannot be diffed and
a copy can.** If the `kyc` block is worth getting right, a source mirror of `AgencyDetailDto` is
worth more than another careful reading.

---

## Acceptance

- [ ] `kyc` is classified `private` in `STORAGE_TREE_VISIBILITY` and `test:uploads` covers it.
- [ ] The three routes exist, each guarded by its party's **review** permission, and each writes
      an audit row on a successful read.
- [ ] A vendor, an agency and an agent with nothing uploaded each answer `200` with a body of
      nulls — never a `404`.
- [ ] `premises.present` is a stored field, not derived from the address array.
- [ ] `home.geo === null` with `home.rawAddress !== null` is reachable and distinguishable from
      `home === null`.
- [ ] `coordinates` is `[longitude, latitude]` on every geo block.
- [ ] Every `*FileId` resolves through `GET /files?ids=` with `url: null` and
      `access: "authorized"`, and streams through `GET /files/:fileId/content`.
- [ ] `photoWithAgentFileId` is a distinct field from `vehicle_info.photo_file_id`; neither
      shadows the other.
- [x] `agencies.md`'s `kyc` example and field notes carry `status` and `rejectionReason`, which
      the controller has emitted since Phase 6 Step 4.
- [ ] Every new field appears in [`vendors.md`](../../api/vendors.md),
      [`agencies.md`](../../api/agencies.md) and [`agents.md`](../../api/agents.md), and the three
      routes appear in the route manifest with their permission and audit flag.
