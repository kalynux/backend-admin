# `/agents` — delivery agents

Base path: `/api/v1/agents`

Seventeen routes: the directory, the detail, contracts and their history, the administrative
activity feed, three delegated **verdict** reads, **two live-tracking reads** (Phase 6.I), and
six writes.

Design record: [`../ADR-009-DELIVERY-NETWORK.md`](../ADR-009-DELIVERY-NETWORK.md).

| Method | Path | Permission | Transport | Audited |
|---|---|---|---|---|
| `POST` | `/agents/transfer` | `agents.transfer` | **delegated** | ✅ |
| `GET` | `/agents` | `agents.read` | direct read | — |
| `GET` | `/agents/:agentId` | `agents.read` | direct read | — |
| `GET` | `/agents/:agentId/contracts` | `agents.read` **+** `agencies.read` | direct read | — |
| `GET` | `/agents/:agentId/contract-history` | `agents.read` | direct read | — |
| `GET` | `/agents/:agentId/activity` | `agents.read` **+** `audit.read` | direct read | — |
| `GET` | `/agents/:agentId/tracking-policy` | `agents.read` | **delegated** | — |
| `GET` | `/agents/:agentId/cod-allocation` | `agents.read` **+** `agencies.read` | **delegated** | — |
| `GET` | `/agents/:agentId/eligibility` | `agents.read` | **delegated** | — |
| `GET` | `/agents/:agentId/assignability` | `agents.read` **+** `agencies.read` | **delegated** | — |
| `GET` | `/agents/:agentId/tracking-presence` | `agents.tracking.read` | **geo-tracker** | — |
| `GET` | `/agents/:agentId/live-position` | `agents.tracking.read` | **geo-tracker** | ✅ |
| `PUT` | `/agents/:agentId/status` | `agents.status.set` | **delegated** | ✅ |
| `PUT` | `/agents/:agentId/kyc` | `agents.kyc.review` | **delegated** | ✅ |
| `PUT` | `/agents/:agentId/tracking` | `agents.tracking.set` | **delegated** | ✅ |
| `PUT` | `/agents/:agentId/cod-threshold` | `agents.cod_threshold.set` | **delegated** | ✅ |
| `POST` | `/agents/:agentId/ban` | `agents.ban` | **delegated** | ✅ |
| `POST` | `/agents/:agentId/unban` | `agents.ban` | **delegated** | ✅ |

`agents.read` covers the six business reads including the three verdicts, and Support holds it —
answering a ticket about a stalled delivery needs to see whether the agent is even dispatchable.
None of the writes are Support's. Two are sharper than the rest: `agents.ban` is `destructive`
and `agents.cod_threshold.set` is `financial`, so neither could be granted by family expansion.

**`agents.tracking.read` is separate, and it is the Phase 6.I addition.** It gates the two reads
that reach geo-tracker's data door rather than jovi-mall. Support holds it too — *"where is my
delivery right now"* is what a ticket asks — and what balances that is the other half of the same
decision: the live-position read writes an audit row **before** it discloses anything, and a
failed audit write means nothing is disclosed. See
[the live-tracking section](#live-tracking--the-geo-tracker-data-door).

> **`POST /agents/transfer` is declared before `/:agentId`.** Express matches in declaration
> order; reversed, the literal `transfer` would be read as an agent id.

## What this surface deliberately does not offer

| Missing | Why |
|---|---|
| ~~**A live position**~~ | **No longer true — Phase 6.I built it** ([ADR-020](../ADR-020-ADMIN-DATA-DOOR.md)). `GET /agents/:agentId/live-position`, its own permission, audited on every call. Struck through rather than deleted because "wi-admin has no geo-tracker data door" was the standing answer for three phases and is still what most of this repository says |
| **Editing contract terms** | A live contract's terms change by proposal between the two parties, never by edit — an administrator imposing a fee split neither party proposed would bind an agent to a number nobody agreed. `transfer` moves a relationship rather than rewriting one |
| **Approving a pending contract** | Same reasoning, sharper: a contract with `terms.proposedBy: null` exists precisely because nobody has stated terms, so approving it binds an agent to a default that pays **zero** |
| **Adjusting a contract's `cod.threshold`** | A third reason, not the same one. It is that contract's slice of a pool bounded across every allocating contract, `0` **blocks all COD** rather than meaning "no limit", and the arithmetic is jovi-mall's. `PUT /agents/:agentId/cod-threshold` sets the agent's whole pool and is the lever that exists |

> **Freezing and ending a relationship ARE offered**, as of the dashboard-request round —
> `POST /contracts/:contractId/{suspend,reinstate,terminate}`, documented in
> [contracts.md](contracts.md). "Do not let an administrator impose terms" and "do not let an
> administrator stop an abusive relationship" are different claims, and only the first was ever
> argued here. Terminate still requires the counterparty and the outstanding balances cleared;
> there is no override.
| **Creating an agent** | They sign up. An agent is a platform identity, not an agency-owned record |

---

## `GET /agents`

The directory — a list that did not exist before this service.

| | |
|---|---|
| **Permission** | `agents.read` |
| **Pagination** | `page`, `limit` |
| **Sorting** | `createdAt`, `updatedAt`, `trustScore`. Default **`-createdAt`** |

`name` is deliberately not sortable — no index backs it.

`trustScore` carries a caveat: it is index-served **only** when `status`, `kycStatus` and
`banned` are all supplied as filters. Unfiltered it is a blocking sort, which is acceptable
because sorting a whole roster by trust is a report, not a screen.

### Query parameters

Six independent filters, **one per state axis**. They are separate because the questions an
administrator asks are conjunctions across them — *"who is active but unverified"*, *"who is
banned and still marked available"*, *"who has tracking off"*. A single collapsed `state` filter
could express none of them.

| Parameter | Type | Notes |
|---|---|---|
| `search` | string, 1–120 | Matches name, email, phone, or — when 24-hex — the agent id |
| `status` | `pending_verification` \| `active` \| `inactive` \| `suspended` | The account status |
| `kycStatus` | `unverified` \| `pending` \| `verified` \| `rejected` | Identity documents |
| `availability` | `online` \| `offline` \| `on_break` | What the agent set |
| `workingState` | `idle` \| `working` \| `at_capacity` | What the platform computed |
| `banned` | boolean flag | The platform-wide override |
| `trackingAllowed` | boolean flag | |
| `from` / `to` | ISO-8601 instant | Creation range. **Max span 366 days** |

`availability` and `workingState` are separate on purpose: collapsing them makes *"is this agent
offline, or just full?"* unanswerable.

### Response (200)

```jsonc
{
  "success": true,
  "data": [
    {
      "id": "6660112233445566778899aa",
      "userId": "665b112233445566778899bb",
      "name": "Eric T.",
      "email": "eric.t@example.cm",
      "phone": "+237690554433",
      "avatarFileId": "6660112233445566778899cc",
      "status": "active",
      "statusReason": null,
      "kycStatus": "verified",
      "banned": false,
      "onboardingComplete": true,
      "operational": {
        "availability": "online",
        "availabilityChangedAt": "2026-08-13T06:02:00.000Z",
        "workingState": "working",
        "activeShipments": 2,
        "maxActiveShipments": 4
      },
      "trackingAllowed": true,
      "trustScore": 87,
      "trustSource": "computed",
      "createdAt": "2025-12-01T09:00:00.000Z",
      "updatedAt": "2026-08-13T08:44:00.000Z"
    }
  ],
  "meta": { "total": 486, "page": 1, "limit": 20, "pages": 25 }
}
```

| Field | Notes |
|---|---|
| `avatarFileId` | **An opaque id.** This service resolves no file URLs |
| `operational.activeShipments` | The **authoritative** count — the one the accept path compare-and-sets on, not the recomputed label beside it |
| `trustScore` | The **effective** COD trust score — the pinned override when one exists, the computed score otherwise. `null` if never computed. Changed at Phase 6.J; see [the detail section](#️-codtrustscore-is-the-effective-score--this-changed-at-phase-6j) |
| `trustSource` | `"override"` or `"computed"`. Display only — never branch on it. ⚠ The `trustScore` **sort** still orders by the computed score, because that is the indexed field |

---

## `GET /agents/:agentId`

| | |
|---|---|
| **Permission** | `agents.read` |
| **Path parameter** | `agentId` — 24-hex |

### Response (200)

Every list field, plus:

```jsonc
{
  "success": true,
  "data": {
    "…all list fields…": "…",
    "emailVerified": true,
    "phoneVerified": true,
    "vehicle": {
      "type": "bike",
      "plateNumber": "LT 4412 A",
      "color": "red",
      "photoFileId": "6612aabbccddeeff00112233"
    },
    "homeBase": { "label": "Bonapriso, Douala", "serviceRadiusKm": 12 },

    "kyc": {
      "status": "verified",
      "reference": "ID-CHECK-2026-0412",
      "rejectionReason": null,
      "verifiedAt": "2025-12-08T11:00:00.000Z",
      "verifiedBy": { "id": "665f…", "source": "wi-admin", "name": "Ada Nkemelu" }
    },

    "ban": { "banned": false, "reason": null, "bannedAt": null, "by": null },

    "tracking": {
      "allowed": true,
      "reason": null,
      "changedAt": "2026-02-02T10:00:00.000Z",
      "changedBy": { "id": "665f…", "role": "admin", "source": "wi-admin", "name": "Ada Nkemelu" },
      "lastKnown": {
        "status": "streaming",
        "position": { "type": "Point", "coordinates": [9.7043, 4.0511] },
        "place": {
          "label": "Bonapriso, Douala, Cameroun",
          "source": "reverse_geocode:nominatim",
          "resolvedAt": "2026-08-13T08:41:14.000Z"
        },
        "reportedAt": "2026-08-13T08:41:12.000Z",
        "source": "geo_tracker",
        "isStale": true
      }
    },

    "device": {
      "platform": "android",
      "appVersion": "3.4.1",
      "locationPermission": "always",
      "locationServicesEnabled": true,
      "backgroundLocationEnabled": true,
      "batteryOptimizationExempt": false,
      "pushEnabled": true,
      "reportedAt": "2026-08-13T08:40:00.000Z"
    },
    "capacity": { "max": 4, "active": 2, "reconciledAt": "2026-08-13T08:00:00.000Z" },
    "cod": {
      "trustScore": 87,
      "computedTrustScore": 87,
      "trustSource": "computed",
      "trustOverride": null,
      "maxThreshold": 250000
    },
    "trustSignals": {
      "onTimeRate": 0.94,
      "assignmentResponseRate": 0.88,
      "completedShipments": 412,
      "customerRatingAvg": 4.6,
      "customerRatingCount": 188,
      "agencyRatingAvg": 4.8,
      "agencyRatingCount": 31,
      "vendorRatingAvg": null,
      "vendorRatingCount": 0,
      "codCleanReturnCount": 96,
      "codDiscrepancyCount": 2,
      "codVolumeReturned": 3820000,
      "computedAt": "2026-08-13T02:00:00.000Z"
    },
    "settings": { "autoAcceptAssignments": false, "navigationApp": "google_maps" },
    "timezone": "Africa/Douala",
    "preferredLanguage": "fr"
  }
}
```

### ⚠️ `cod.trustScore` is the EFFECTIVE score — this changed at Phase 6.J

An agent has a **computed** trust score and, sometimes, an **administrator's pinned override**
that outranks it. Every gate in jovi-mall acts on the override when one exists (O-7).

**This DTO used to report `cod.trust_score` alone**, so on exactly the agents where a human had
overridden the machine, this screen showed the number the platform was *not* using — a support
agent reading 35 beside a dispatch that had just succeeded had no way to explain it.

| Field | Meaning |
|---|---|
| `trustScore` | **What every gate acts on.** The override's score when pinned, the computed score otherwise |
| `computedTrustScore` | The derived score, always — what would apply if the override were released |
| `trustSource` | `"override"` or `"computed"`. **For display only, never branch on it** |
| `trustOverride` | `{ score, reason, setAt, setByName }` when pinned, else `null` |

All four ship together on purpose: a screen showing only `trustScore` cannot tell an administrator
that a human pinned it, nor what releasing it would do. The same four now appear on
`GET /cod/holders` rows, which had the identical defect.

> `SearchAgentsQuerySchema`'s `trustScore` **sort** still orders by the computed `cod.trust_score`,
> because that is the indexed field. An overridden agent therefore sorts by the score that is not
> being applied to them. Left as-is deliberately — an index on a nullable override sub-field to fix
> a sort ordering is not worth the write cost — but do not describe that column as "effective".

---

### ⚠️ `tracking.lastKnown` is a stale business mirror, not a live position

`position` is written by geo-tracker's **best-effort** notifier. No assignment rule reads it,
and serving it as a live position is a bug.

- `isStale` is computed on read: **`true` when the report is older than 2 minutes**, or absent.
- **Render this as "last seen", never as a live marker on a map.** A live marker would simply
  stop moving and nobody would be told.

> **⚠️ This paragraph used to end "and this service has no door to it". That is no longer
> true, and the distinction still matters.**
>
> A door was opened at Phase 6.I ([ADR-020](../ADR-020-ADMIN-DATA-DOOR.md)): geo-tracker gained
> a **service-caller** authorization path, so administrators reach live tracking data without
> gaining platform user rows. See
> [`GET /agents/:agentId/live-position`](#get-agentsagentidlive-position).
>
> **`tracking.lastKnown` is still not that.** It remains jovi-mall's stale business mirror,
> under `agents.read`, unaudited, answering *"where were they last seen"*. The live read is a
> different permission, is audited on every call, and answers *"where are they now"*. Two
> questions, two sources, two exposures — do not substitute one for the other.

For the authoritative tracking POLICY, call
[`GET /agents/:agentId/tracking-policy`](#get-agentsagentidtracking-policy).

#### `lastKnown.place` — a name for the position

```jsonc
"place": { "label": "Bonapriso, Douala, Cameroun",
           "source": "reverse_geocode:nominatim",
           "resolvedAt": "2026-08-13T08:41:14.000Z" }
```

- **Resolved server-side, once per position**, and stored beside it — not on read.
  Reverse-geocoding per render would be a bill per operator who opens the tab, and would hand
  the same person's coordinates to a geocoding provider once per *viewer* rather than once per
  *position*.
- **`null` when nothing resolved** — never `""`, and never a coordinate pair dressed up as a
  name. Resolution failure is not fatal: the position and the state still arrive.
- `source` is an **open string** naming the resolver — it carries the active provider, and a
  future "nearest landmark" or "agency coverage region" resolution would be additive. Render it
  raw; do not `switch` on it.
- ⚠️ **It inherits the position's exposure and then some.** `[9.7043, 4.0511]` needs a tool to
  read; "Bonapriso, Douala" does not. Whatever decides whether to reveal the coordinates decides
  the same thing about this.
- Coordinates remain GeoJSON **`[longitude, latitude]`**, in that order.

#### There is no `accuracyMetres`, and that is a finding rather than an omission

**geo-tracker records no GPS accuracy anywhere.** Its WebSocket `location_update` frame does not
carry one, so nothing on the platform has ever known how good a fix is. Adding it starts at the
agent mobile application, then the frame, then geo-tracker's location domain, then the
notification, then this mirror — four layers, one of which is a release of a phone app.

A field that is `null` on every row in every circumstance would teach a client to expect data
that does not exist, so none is shipped.

#### Why this block was empty until now

`last_known_tracking_state` was the schema default (`status: "unknown"`, `position: null`) on
every agent in the database, and the reason was a path mismatch between two services:
geo-tracker POSTed its tracking-state notifications to `/api/tracking/agent-state`, which
jovi-mall did not serve. Delivery is best-effort, so every notification was dropped and logged.
jovi-mall now serves that path, and geo-tracker's notification carries the agent's last fix —
which is what gives this block coordinates to hold and a place to name.

### Other field notes

| Field | Notes |
|---|---|
| `homeBase` | **Label and radius only.** The geographic point is not projected — it is a person's residence |
| `kyc.verifiedBy` | Present only while `status === "verified"` |
| `ban.by` | Present only while banned |
| `capacity.active` vs `operational.activeShipments` | Same authoritative number, surfaced in both blocks |

### Errors

| Status | Code |
|---|---|
| 400 | `VALIDATION_ERROR` — "Not a valid delivery agent id" |
| 404 | `NOT_FOUND` — "Delivery agent not found" |

---

## `GET /agents/:agentId/contracts`

Every agency this agent works with.

| | |
|---|---|
| **Permission** | `agents.read` **+** `agencies.read` |
| **Pagination** | `page`, `limit` |
| **Sorting** | `createdAt` only. Default **`-createdAt`** |

### Query parameters

| Parameter | Type | Notes |
|---|---|---|
| `status` | string, 1–40 | Contract status — a bounded string, not a pinned enum |
| `primaryOnly` | boolean flag | Only contracts allocating COD headroom |

Every status is returned by default, terminal rows included.

### Response (200)

The same contract core as the [agency roster](agencies.md#get-agenciesagencyidagents) — `cod`,
`payment`, `terms`, `lifecycle` — but decorated with `agency` instead of `agent`:

```jsonc
{
  "success": true,
  "data": [
    {
      "id": "6661aabbccddeeff00112233",
      "agentId": "6660112233445566778899aa",
      "agencyId": "665c0011223344556677889a",
      "status": "active",
      "isPrimary": true,
      "cod":     { "threshold": 150000, "outstandingBalance": 42000, "lastSettledAt": "…" },
      "payment": { "outstandingToAgent": 18500, "lastPaidAt": "…" },
      "terms":   { "coverageRegions": [], "proposedBy": "agency", "version": 3, "…": "…" },
      "lifecycle": { "…": "…" },
      "agency": {
        "id": "665c0011223344556677889a",
        "businessName": "Littoral Express Delivery",
        "status": "active",
        "contactName": "Nadège M.",
        "country": "CM"
      }
    }
  ],
  "meta": { "total": 3, "page": 1, "limit": 20, "pages": 1 }
}
```

> ### ⚠️ `businessName` is the business; `contactName` is a **person**
>
> `contactName` is the agency's contact individual — it always was, and a column headed
> "Agency" rendering it has been showing a human's name.
>
> `businessName` is new (dashboard-request round) and comes off the Magazin. It used to be
> withheld on the grounds that a second `$lookup` was not worth "a label the dashboard can
> resolve from the agency id". That holds for **one** agency and not for a page of rows: with
> no batch-by-ids route anywhere on this service, the client's alternative is one request per
> distinct agency, in every client ever built against this endpoint. The lookup runs after
> skip/limit, so it touches at most one page.
>
> **`null` where the Magazin has none** — an agency mid-onboarding legitimately has no business
> name yet and must still be identifiable by its id. `null`, never `""`, and never silently
> substituted with `contactName`.

The same two reading traps apply as on the roster: `terms.coverageRegions: []` means **all
regions**, and `terms.proposedBy` — not `origin` — decides whose turn it is on a pending
contract.

**`terms.employment`, `terms.remittance` and `terms.feeSplit` are documented field by field in
[contracts.md](contracts.md)**, and ship **camelCase** as of the dashboard-request round — they
previously carried jovi-mall's raw sub-documents.

For one contract by its own id, plus the three administrative interventions, see
[contracts.md](contracts.md).

---

## `GET /agents/:agentId/contract-history`

What **everyone** did to this agent's relationships (`actorRole` is `agent`, `agency`, `admin`
or `system`).

| | |
|---|---|
| **Permission** | `agents.read` |
| **Query / response** | Identical to [`GET /agencies/:agencyId/contract-history`](agencies.md#get-agenciesagencyidcontract-history) |

Each row carries `agent: { id, name }`, exactly as the agency-side feed does. On **this** feed
every row names the agent in the path, so the object is the same on all of them — it is carried
anyway, because the two feeds share one shape and a client branching on which endpoint it called
to know whether `agent` is present will get it wrong.

⚠ `name`, **not** `businessName` — an agent is a person.

---

## `GET /agents/:agentId/activity`

What **administrators** did to this agent. Not their platform activity — shipments, COD
collections and earnings live in other domains behind other permissions.

| | |
|---|---|
| **Permission** | `agents.read` **+** `audit.read` |
| **Sorting** | `occurredAt` only. Default `-occurredAt` |
| **Filters** | `action` (only `agents.*`, derived from the catalog), `status`, `from`/`to` (max 366 days) |
| **Response** | Audit entries — see [audit.md](audit.md#get-audit) |

---

# The three delegated verdict reads

These are **not** recomputed here. They are the platform's own answers, and a second
implementation would be a second definition of who may be dispatched or watched.

## `GET /agents/:agentId/tracking-policy`

jovi-mall's own tracking verdict — the exact function geo-tracker consumes.

| | |
|---|---|
| **Permission** | `agents.read` |
| **Transport** | Delegated |
| **Parameters** | None |

### Response (200)

`data` is jovi-mall's verdict object: `trackingAllowed` plus a `denyReason` when refused.

| `denyReason` | Meaning |
|---|---|
| `tracking_disabled` | The Tracking Allow flag is off |
| `agent_not_active` | The agent's account status blocks it |
| `no_approved_agency` | No approved contract. **Tracking exists to serve a delivery relationship — nobody is entitled to watch an unaffiliated person move around** |

### Errors

`404 NOT_FOUND` (no such agent), `502`/`503 SERVICE_DEPENDENCY_UNAVAILABLE`.

---

## `GET /agents/:agentId/cod-allocation`

The agent's COD pool, its per-contract slices, and the remaining headroom — the view to consult
before changing either level.

| | |
|---|---|
| **Permission** | `agents.read` **+** `agencies.read` |
| **Transport** | **Delegated verdict, decorated locally** — see below |
| **Parameters** | None |
| **Pagination** | **None.** `contracts` is unpaginated and bounded by the agent's contract count, which is single digits |
| **Errors** | `404 NOT_FOUND`, `502`/`503 SERVICE_DEPENDENCY_UNAVAILABLE` |

`agencies.read` joined this route with the `agency` object below: the slices now carry an
agency's business name **and its account status**, so `agents.read` alone would make this a
second door onto the agency directory. It is the same dependency
[`GET /agents/:agentId/contracts`](#get-agentsagentidcontracts) states for the same object, and
**it costs nobody access** — grants are per tier, tier 2 is built as `union(SUPPORT, …)` and
tier 1 holds everything, so all three tiers that hold `agents.read` hold `agencies.read`.

### Why this one is delegated *and* mapped

The arithmetic is jovi-mall's and stays there: `ALLOCATING_CONTRACT_STATUSES` is the judgement
that `paused` and `suspended` contracts still hold headroom while `deactivated` ones do not, and
a copy here would drift silently and report headroom that does not exist. What wi-admin adds is
a **name**, which jovi-mall cannot produce — the business name lives on the Magazin, which this
endpoint's subject there has no reason to join.

### Response (200)

```jsonc
{
  "success": true,
  "data": {
    "agentId": "6660112233445566778899aa",
    "maxThreshold": 500000,
    "allocated": 350000,
    "headroom": 150000,
    "contracts": [
      {
        "contractId": "6661aabbccddeeff00112233",
        "agencyId": "665c0011223344556677889a",
        "agency": {
          "id": "665c0011223344556677889a",
          "businessName": "Littoral Express Delivery",
          "status": "active"
        },
        "status": "active",
        "threshold": 200000,
        "outstandingBalance": 45000
      }
    ]
  }
}
```

| Field | Notes |
|---|---|
| `maxThreshold` | The agent's **global** pool. Defaults to `0`, so a new agent can carry no COD at all until it is set |
| `allocated` | Sum of `threshold` across the **allocating** contracts listed. `active`, `paused` and `suspended` all consume the pool — **pausing does not free capacity**, because the agent may still be holding that agency's cash. `pending` and `deactivated` do not, and are absent from `contracts` |
| `headroom` | `maxThreshold - allocated`. Never negative |
| `contracts[].status` | ⚠ **The CONTRACT's status** |
| `contracts[].agency.status` | ⚠ **The AGENCY's account status** — `active` · `pending_verification` · `inactive`. The two sit side by side and mean different things: the first decides whether the slice consumes the pool, the second whether the agency may trade at all |
| `contracts[].agency.businessName` | The Magazin's name. `null` where the Magazin has none — an agency mid-onboarding must still be identifiable by its id. **`null`, never `""`, and never `display_name`**, which is the agency's contact *person* |
| `contracts[].agency` | `null` when the agency row is gone. The slice still consumes the pool, so the row is kept |

> This endpoint had **no documented response shape at all** until BR-016 § 2, which is why the
> dashboard's type was transcribed off the wire. `PUT /agents/:agentId/cod-threshold` answers
> with this same shape.

---

## `GET /agents/:agentId/eligibility`

Could **this agency** dispatch to **this agent** right now?

| | |
|---|---|
| **Permission** | `agents.read` |
| **Transport** | Delegated |

### Query parameters

| Parameter | Type | Rules |
|---|---|---|
| `agencyId` | 24-hex | **Required.** Strict — no other parameter is accepted |

**Eligibility is pairwise and there is no agency-free answer.** The rule set includes holding an
approved contract with the dispatching agency, so a single-argument verdict would have to pick
an agency silently and would report a blocker the caller was not asking about.

### Response (200)

jovi-mall's verdict, which **reports every failed rule at once** — the property a local
reimplementation loses first, and the reason this read is delegated.

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Missing `agencyId`, or an extra parameter |
| 404 | `NOT_FOUND` | No such agent |
| 502 / 503 | `SERVICE_DEPENDENCY_UNAVAILABLE` | |

---

## `GET /agents/:agentId/assignability`

**Why can this agent not take this work?** — every gate, with the numbers behind each one.

| | |
|---|---|
| **Permission** | `agents.read` **+** `agencies.read` |
| **Transport** | Delegated |
| **Audited** | No |

### What this adds over `/eligibility`

`/eligibility` answers only the **platform** half of the assignment question. There are two halves:

| Family | Gates | Reachable before this endpoint |
|---|---|---|
| **platform** | banned · KYC · active · available · tracking allowed · device location · capacity | ✅ `/eligibility` |
| **contract** | active contract · coverage region · per-shipment value ceiling · **COD exposure** | ❌ **nowhere** |

The contract half is where the numbers are, and its absence had a concrete cost: an agency refused
with `COD_AGENT_EXPOSURE_EXCEEDED` could read its own COD threshold off three screens in this
service and could see **neither** the agent's actual exposure **nor** the trust multiplier that had
halved that threshold. Support was looking at the wrong number with no way to know it.

### Query parameters

| Parameter | Type | Rules |
|---|---|---|
| `agencyId` | 24-hex | **Required** — the answer is pairwise, as with `/eligibility` |
| `shipmentId` | 24-hex | **Optional.** Strict — no other parameter is accepted |

`shipmentId` is optional deliberately. Support reaches this endpoint having been told *"I can't
assign my agent"*, holding an agency and an agent and no shipment id; requiring one would make the
diagnostic unreachable at the moment it is wanted. Without it the two shipment-scoped gates report
`"skipped"` and the cash gate answers *"is this agent already at their limit for this agency?"*.

### Response (200)

jovi-mall's payload, passed through unmodified. Full field-by-field shape, the four gate statuses,
the remedy vocabulary and a worked example are in **`jovi-mall/api-doc/admin/agents.md`** under
`GET /internal/admin/agents/:agentId/assignability` — not restated here, per the rule that a
delegated read is documented against its source rather than transcribed (BR-014).

Three things a screen built on this must get right:

1. **Exposure is agent-wide; the limit is per-contract.** `exposure.total` spans **every** agency the
   agent serves — the cash is one physical pot — while `limit.contractThreshold` belongs only to
   `agencyId`. Do not present the total as this agency's.
2. **`contractThreshold` is not the limit.** `effectiveLimit` is: the threshold scaled by the trust
   tier. Showing the threshold alone tells an operator the opposite of what the gate decided.
3. **`assignable` is false only when a gate `failed`.** `skipped` and `not_applicable` do not.

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Missing `agencyId`, a malformed id, or an extra parameter |
| 404 | `NOT_FOUND` | No such agent |
| 404 | (delegated) | No such shipment, or it belongs to a different agency than `agencyId` |
| 502 / 503 | `SERVICE_DEPENDENCY_UNAVAILABLE` | |

---

# Live tracking — the geo-tracker data door

**New at Phase 6.I.** Design record: [ADR-020](../ADR-020-ADMIN-DATA-DOOR.md); the wire contract
on the other side is `geo-tracker/api-doc/service-data-door.md`.

For three phases this service had **no** geo-tracker data door, because every geo-tracker read
resolves per-agent visibility by asking jovi-mall *as the viewer* and an administrator has no
platform user row. geo-tracker now has a **service-caller** authorization path — a second path,
separate from the viewer one — so administrators reach tracking data without gaining platform
identities.

**Both reads below are inert when the door is not configured**, answering
`503 TRACKING_DOOR_UNCONFIGURED`. That is a supported deployment posture, not a fault.

**Three things bound what an administrator can reach through it**, and only the first is this
service's:

1. **Permission.** `agents.tracking.read` for the two agent-scoped reads;
   `shipments.tracking.read` for the delivery's trail (see
   [shipments.md](./shipments.md)). Support holds both.
2. **Scope**, on geo-tracker's side: the credential holds a configured set of capabilities, and
   the sharp ones are granted by name.
3. **Subject**, structurally: geo-tracker has **no endpoint that takes an agent id and answers
   with a trail**. "Where has this person been this week" is not a question any permission here
   can produce. A trail is always scoped to one delivery.

---

## `GET /agents/:agentId/tracking-presence`

Is this agent's device connected, opted in, and how many deliveries are they running?

| | |
|---|---|
| **Permission** | `agents.tracking.read` |
| **Transport** | geo-tracker (data door) |
| **Parameters** | None — the query is `.strict()` and empty, so a `reason` is refused |
| **Audited** | No |

### Response (200)

```jsonc
{
  "agentId": "…",
  "connected": true,
  "connectionId": "8f14e45f-…",
  "device": { "locationEnabled": true, "locationPermissionGranted": true,
              "trackingEnabled": true, "lastSeenAt": "2026-08-22T09:41:02.000Z" },
  "trackingAllow": true,
  "positionKnown": true,
  "positionAgeSeconds": 12,
  "lastHeartbeatAt": "2026-08-22T09:41:00.000Z",
  "activeShipment": true,
  "sessions": [
    { "sessionId": "3f1c8a52-…", "shipmentId": "…", "state": "online",
      "tracking": true, "connectionCount": 3,
      "startedAt": "2026-08-22T08:02:11.000Z",
      "lastHeartbeatAt": "2026-08-22T09:41:00.000Z" }
  ]
}
```

**No coordinates, deliberately.** `positionKnown` and `positionAgeSeconds` answer *is the phone
reporting* — the operational question — without answering *where*. That is why this read needs no
reason and writes no audit row; it is also why it is safe to call on every render of an agent
screen, which the live-position read is not.

**An empty `sessions` array on a connected, opted-in agent is normal.** That is an idle agent:
locatable but not tracked. A tracking session belongs to a shipment, and this agent has none.

`state` is geo-tracker's lifecycle vocabulary — `online`, `degraded`, `network_lost`,
`disconnected`, `location_disabled`, `tracking_disabled`, `app_background`, `app_foreground`.
`connectionCount: 3` means one delivery whose agent's phone dropped twice, not three deliveries.

---

## `GET /agents/:agentId/live-position`

Where the agent is now.

| | |
|---|---|
| **Permission** | `agents.tracking.read` |
| **Transport** | geo-tracker (data door) |
| **Parameters** | `reason` — **required**, 3–200 characters after trimming |
| **Audited** | **Yes — `agents.tracking.position.read`, and the row commits BEFORE the read** |

### `reason` is required, and it is recorded

This is the one field that turns *"an administrator looked"* into *"an administrator looked, and
said why"*. geo-tracker independently refuses this read without one, so a client cannot skip it
by calling that service directly with the same credential.

Put the ticket, the dispute, or the incident in it. It lands in the audit row's payload and in
geo-tracker's log, and it is what a later reader has to work with.

### The audit ordering, because it changes what a failure means

The row is committed **first**, and a failure of that write is **not** caught — so with the audit
store unreachable, **nothing is disclosed**. This is the same fail-closed posture as
`GET /money/payouts/:payoutId/destination`, and it is the reason this permission can be held by
Support at all.

A row left at `attempted` means the position **may** have been disclosed. Read it conservatively.

**The row never contains coordinates.** It records that a position was disclosed, whether it
actually was, the subject and the reason — putting the values in would move a person's location
into the one store readable without the permission gating it.

### Response (200) — served

```jsonc
{
  "agentId": "…",
  "trackingAllow": true,
  "position": { "latitude": 4.0511, "longitude": 9.7043 },
  "recordedAt": "2026-08-22T09:41:00.000Z",
  "ageSeconds": 12
}
```

### Response (200) — withheld

```jsonc
{
  "agentId": "…",
  "trackingAllow": false,
  "position": null,
  "recordedAt": null,
  "ageSeconds": null,
  "withheld": "tracking_allow_off"
}
```

**Tracking Allow gates this read on geo-tracker's side**, and the timestamp is withheld with the
coordinates: that an agent is currently streaming is itself part of what the opt-out withholds.
`withheld` is a closed set — absent, or `"tracking_allow_off"`. Treat an unknown value as
withheld and show nothing.

This is stricter than the stale mirror on the detail read, which ships regardless of the flag. It
is a different question: *where were they last seen* is a historical record; *where are they now*
is live tracking, and Tracking Allow is the platform's own gate on that.

### `ageSeconds`, and there is no `stale` flag

geo-tracker reports the **fact** and this service applies its own display threshold — shipping a
second definition of "stale" on the platform would give the two a way to drift. Use the same
2-minute line the detail read's `isStale` uses if you want one.

**Render this as a timestamped reading, not as a live marker.** It is a point read, not a stream:
a marker drawn from it stops moving and tells nobody it has stopped. Polling is the client's
decision, and every poll is an audit row.

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Missing or blank `reason`, or one over 200 characters |
| 404 | `NOT_FOUND` | No such agent (checked here, before anything is audited) |
| 502 | `TRACKING_DOOR_REFUSED` | geo-tracker refused. `details.upstreamCode` says which: `SERVICE_SCOPE_FORBIDDEN` (the credential lacks the scope — `details.scope` names it), `SERVICE_TOKEN_INVALID` (the shared secret has drifted), `SERVICE_DOOR_NOT_CONFIGURED` (geo-tracker's half is closed) |
| 503 | `TRACKING_DOOR_UNCONFIGURED` | This deployment has no data door |
| 503 | `TRACKING_DOOR_UNAVAILABLE` | geo-tracker unreachable, or too slow |

The three are separate codes because each is fixed by a different person. Do not collapse them
into "tracking unavailable" on the screen.

---

# Writes

Four `PUT`s — one per single-valued sub-resource with a conditional reason — plus ban/unban and
transfer. Splitting `status` into four imperatives would be worse: `pending_verification` is not
a verb anybody says.

## `PUT /agents/:agentId/status`

| | |
|---|---|
| **Permission** | `agents.status.set` |
| **Transport** | Delegated |
| **Body** | **Strict** |

### Request body

| Field | Type | Rules |
|---|---|---|
| `status` | `pending_verification` \| `active` \| `inactive` \| `suspended` | Required |
| `reason` | string, 3–500 | **Required when `status` is `suspended`.** Refused — not ignored — otherwise: a reason silently dropped on an activation would be a message an administrator believes they recorded and did not |

```json
{ "status": "suspended", "reason": "Three no-show pickups in one week — see ticket TCK-2026-1187" }
```

### Response (200)

The updated agent, message `"Agent status set to suspended"`.

**Contracts are left intact, deliberately** — reinstatement restores them.

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Missing reason on a suspension, an unknown field, or an invalid status |
| 404 | `NOT_FOUND` | |
| 409 | `PLATFORM_OPERATION_REJECTED` | The platform refused the transition |
| 502 / 503 | `SERVICE_DEPENDENCY_UNAVAILABLE` | |

### Audit

`agents.status.set`

---

## `PUT /agents/:agentId/kyc`

**The write that lets an agent work.** Eligibility passes only on `verified`, so this is a gate,
not a label.

| | |
|---|---|
| **Permission** | `agents.kyc.review` |
| **Body** | **Strict** |

### Request body

| Field | Type | Rules |
|---|---|---|
| `status` | `unverified` \| `pending` \| `verified` \| `rejected` | Required |
| `reference` | string, ≤ 200 | Optional. A free-form pointer to whatever document set was checked, off-platform |
| `rejectionReason` | string, 3–500 | **Required when `status` is `rejected`** — "your documents were rejected" with no cause is an unactionable message that generates a support ticket by construction |

```json
{ "status": "rejected", "rejectionReason": "The ID photo is illegible — re-upload a clear scan" }
```

### Response (200)

The updated agent, message `"Identity documents marked rejected"`.

Moving an agent **off** `verified` makes them undispatchable immediately. It does not touch
their contracts, and in-flight shipments they already hold are unaffected.

### Audit

`agents.kyc.review`

---

## `PUT /agents/:agentId/tracking`

Set whether the agent may be tracked — the administrator half of Tracking Allow.

| | |
|---|---|
| **Permission** | `agents.tracking.set` |
| **Body** | **Strict** |

### Request body

| Field | Type | Rules |
|---|---|---|
| `allowed` | boolean | Required |
| `reason` | string, 3–500 | **Required when disabling.** This is the field an agent is most likely to dispute — it makes them undispatchable — and unlike KYC there is no document to point at |

```json
{ "allowed": false, "reason": "Agent requested removal from tracking pending an HR review" }
```

### Response (200) — and what actually happens

Enabling:

> `"Tracking enabled — this agent can be dispatched and located again"`

Disabling:

> `"Tracking disabled — this agent will not be dispatched, and their live position stops being
> recorded. Anyone already watching keeps their subscription and simply receives nothing."`

Both halves are stated rather than the flattering one. Precisely:

| Effect | Happens? |
|---|---|
| New dispatch is blocked | ✅ |
| The live position is suppressed in geo-tracker, and open sessions move to `tracking_disabled` | ✅ — pushed as an event |
| Any tracking session is **closed** | ❌ — whether a delivery is over is the platform's call, and this event does not make it |
| Existing watchers are **revoked** | ❌ — visibility derives from shipments, not this flag. They stay subscribed and receive nothing |

An **administrator** revocation is never refused. (The refusal an agent hits when trying to
switch tracking off mid-shipment is the opposite situation and lives in geo-tracker.)

### Audit

`agents.tracking.set`

---

## `PUT /agents/:agentId/cod-threshold`

Set the agent's **whole COD pool** — the ceiling every contract sub-allocates from.

| | |
|---|---|
| **Permission** | `agents.cod_threshold.set` — flagged `financial`, so **never granted to Support**, and it had to be named into the Admin grant by hand |
| **Body** | **Strict** |

### Request body

| Field | Type | Rules |
|---|---|---|
| `maxThreshold` | number | Required. Finite and non-negative |

Bounds beyond that are **not** checked here. jovi-mall owns the min/max and, more importantly,
owns the rule this write can actually fail: **lowering the pool below what its contracts have
already allocated is refused there**, and that check needs the contracts.

```json
{ "maxThreshold": 250000 }
```

### Response (200)

⚠️ **A `CodAllocation`, not the updated agent** — the previous wording here was wrong.

```jsonc
{
  "success": true,
  "data": {
    "agentId": "665b…",
    "maxThreshold": 250000,
    "allocated": 180000,
    "headroom": 70000,
    "contracts": [ /* per-contract slices */ ]
  },
  "message": "COD threshold updated"
}
```

jovi-mall runs the write and then returns a **fresh allocation**, which is the more useful
answer — a client gets the resulting headroom rather than an agent it has to re-read. Note
`maxThreshold` sits at the **top level** here, not under `cod` as it does on an agent.

That difference was also a real defect: this service's audit `after` read `cod.maxThreshold`
and therefore recorded `null` on every row of the one write on this surface flagged
`financial`. Fixed in the dashboard-request round; both shapes are read now.

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Negative or non-finite |
| 404 | `NOT_FOUND` | |
| 409 / 422 | `PLATFORM_OPERATION_REJECTED` | Below what contracts have allocated, or outside the platform's bounds. `details.platformCode` names which |

### Audit

`agents.cod_threshold.set`

---

## `POST /agents/:agentId/ban`

A platform-wide override consulted by every gate.

| | |
|---|---|
| **Permission** | `agents.ban` — flagged `destructive` |

### Request body

| Field | Type | Rules |
|---|---|---|
| `reason` | string | **Required.** 3–500 characters |

```json
{ "reason": "Confirmed theft of COD cash — police report CM/DLA/2026/4412" }
```

### Response (200)

The updated agent, message `"Agent banned from the platform"`.

**Deliberately not a cascade over contracts.** Flipping each contract to paused would be lossy —
un-banning could not tell which were already paused. One flag suppresses every contract at once,
and lifting it restores exactly the prior state.

> **The consequence worth knowing:** a contract-level reactivation while the ban stands *writes*
> `active`, and the agent stays unusable because every gate still refuses. A dashboard showing a
> contract as active must also show the ban.

### Audit

`agents.ban`

---

## `POST /agents/:agentId/unban`

| | |
|---|---|
| **Permission** | `agents.ban` (the same one) |
| **Request body** | None |
| **Response** | The updated agent, message `"Platform ban lifted"` |

Its own route and its own audit action although it shares the permission: **lifting a ban clears
the reason, the timestamp and the actor stamp off the agent record, so the audit row is the only
surviving evidence the ban ever happened.**

### Audit

`agents.unban`

---

## `POST /agents/transfer`

Move an agent from one agency to another.

**Admin-only, and the reason is the point: an agency must not be able to pull an agent off a
rival's roster.**

| | |
|---|---|
| **Permission** | `agents.transfer` |
| **Transport** | Delegated |
| **Body** | **Strict** |

### Request body

| Field | Type | Rules |
|---|---|---|
| `agentId` | 24-hex | Required |
| `fromAgencyId` | 24-hex | Required |
| `toAgencyId` | 24-hex | Required. **Must differ from `fromAgencyId`** |
| `reason` | string, 3–500 | Required |

```json
{
  "agentId": "6660112233445566778899aa",
  "fromAgencyId": "665c0011223344556677889a",
  "toAgencyId": "665c001122334455667788ab",
  "reason": "Agency consolidation — Littoral Express roster merged into Wouri Logistics"
}
```

### Response (200)

The platform's transfer result, message `"Agent transferred"`.

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Same source and destination ("The destination agency must differ from the source"), a malformed id, or an unknown field |
| 404 | `NOT_FOUND` | No such agent |
| 409 / 422 | `PLATFORM_OPERATION_REJECTED` | No contract with the source agency, or the destination refuses. `details.platformCode` names it |
| 502 / 503 | `SERVICE_DEPENDENCY_UNAVAILABLE` | |

### Audit

`agents.transfer`
