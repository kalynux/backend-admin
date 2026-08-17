# `/agents` — delivery agents

Base path: `/api/v1/agents`

Fifteen routes: the directory, the detail, contracts and their history, the administrative
activity feed, three delegated **verdict** reads, and six writes.

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
| `GET` | `/agents/:agentId/cod-allocation` | `agents.read` | **delegated** | — |
| `GET` | `/agents/:agentId/eligibility` | `agents.read` | **delegated** | — |
| `PUT` | `/agents/:agentId/status` | `agents.status.set` | **delegated** | ✅ |
| `PUT` | `/agents/:agentId/kyc` | `agents.kyc.review` | **delegated** | ✅ |
| `PUT` | `/agents/:agentId/tracking` | `agents.tracking.set` | **delegated** | ✅ |
| `PUT` | `/agents/:agentId/cod-threshold` | `agents.cod_threshold.set` | **delegated** | ✅ |
| `POST` | `/agents/:agentId/ban` | `agents.ban` | **delegated** | ✅ |
| `POST` | `/agents/:agentId/unban` | `agents.ban` | **delegated** | ✅ |

`agents.read` covers all six reads including the three verdicts, and Support holds it —
answering a ticket about a stalled delivery needs to see whether the agent is even dispatchable.
None of the writes are Support's. Two are sharper than the rest: `agents.ban` is `destructive`
and `agents.cod_threshold.set` is `financial`, so neither could be granted by family expansion.

> **`POST /agents/transfer` is declared before `/:agentId`.** Express matches in declaration
> order; reversed, the literal `transfer` would be read as an agent id.

## What this surface deliberately does not offer

| Missing | Why |
|---|---|
| **A live position** | See the tracking block below. wi-admin has no data door into geo-tracker |
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
| `trustScore` | The COD trust score, `null` if never computed |

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
    "cod": { "trustScore": 87, "maxThreshold": 250000 },
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

### ⚠️ `tracking.lastKnown` is a stale business mirror, not a live position

`position` is written by geo-tracker's **best-effort** notifier. No assignment rule reads it,
and serving it as a live position is a bug.

- `isStale` is computed on read: **`true` when the report is older than 2 minutes**, or absent.
- **Render this as "last seen", never as a live marker on a map.** A live marker would simply
  stop moving and nobody would be told.
- The live position lives in geo-tracker, behind Tracking Allow, and **this service has no door
  to it**. Every geo-tracker data read requires a real platform user JWT and resolves per-agent
  visibility by looking that user up — and a wi-admin administrator has no platform user row,
  deliberately.

For the authoritative tracking answer, call
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

The agent's COD pool, its per-contract slices, and the remaining headroom.

| | |
|---|---|
| **Permission** | `agents.read` |
| **Transport** | Delegated |
| **Parameters** | None |
| **Errors** | `404 NOT_FOUND`, `502`/`503 SERVICE_DEPENDENCY_UNAVAILABLE` |

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
