# `/agencies` — delivery agencies

Base path: `/api/v1/agencies`

The delivery network's businesses: the directory, the detail, the agent roster, the contract
history, and the three lifecycle verbs.

Design record: [`../ADR-009-DELIVERY-NETWORK.md`](../ADR-009-DELIVERY-NETWORK.md).

| Method | Path | Permission | Transport | Audited |
|---|---|---|---|---|
| `GET` | `/agencies` | `agencies.read` | direct read | — |
| `GET` | `/agencies/:agencyId` | `agencies.read` | direct read | — |
| `GET` | `/agencies/:agencyId/agents` | `agencies.read` **+** `agents.read` | direct read | — |
| `GET` | `/agencies/:agencyId/contract-history` | `agencies.read` | direct read | — |
| `GET` | `/agencies/:agencyId/activity` | `agencies.read` **+** `audit.read` | direct read | — |
| `POST` | `/agencies/:agencyId/verify` | `agencies.verify` | **delegated** | ✅ |
| `POST` | `/agencies/:agencyId/reject` | `agencies.verify` | **delegated** | ✅ |
| `POST` | `/agencies/:agencyId/deactivate` | `agencies.deactivate` | **delegated** | ✅ |
| `POST` | `/agencies/:agencyId/reactivate` | `agencies.reactivate` | **delegated** | ✅ |

`agencies.read` is a Support-level lookup — answering a ticket about a stalled delivery needs
it. The three writes are Admin and above; `agencies.deactivate` is `destructive` and had to be
granted by name rather than by family expansion.

## The read rule for this domain

**Delegate a read whose answer is a *verdict* the platform acts on; read directly a read whose
answer is a *record*.** Directories, rosters and contract histories are records. Agent
eligibility, tracking policy and COD allocation are verdicts and are delegated — those three
live on the [agents](agents.md) surface.

## What this surface deliberately does not offer

| Missing | Why |
|---|---|
| **Editing an agency's policies** | Pricing, returns and damage terms are the agency's own commercial record, negotiated with the vendors connected to it. Every edit bumps `policyVersion`, which **pauses those connections for re-approval** — an administrator changing a price on their behalf would silently re-open every relationship they have. Unchanged by the dashboard-request round, which projected the terms' *content* and added no write |
| **Un-verifying** | Revoking a verification that gates nothing would be theatre. `deactivate` is the real lever |
| **Creating an agency** | Onboarding is a four-step flow that provisions a Magazin along the way. A row inserted from here would be missing it, and every later read would report a business with no name |

---

## `GET /agencies`

The directory.

| | |
|---|---|
| **Permission** | `agencies.read` |
| **Pagination** | `page`, `limit` |
| **Sorting** | `createdAt`, `updatedAt`, `status`. Default **`-createdAt`** |

**Business name is deliberately not sortable.** It lives on the Magazin, reached by a
`$lookup`, so no index on the joined collection can serve a sort on it. Sort a rendered page by
name client-side instead.

### Query parameters

| Parameter | Type | Notes |
|---|---|---|
| `search` | string, 1–120 | Matches the **business name** (on the Magazin), the contact name, the email, the phone, or — when the term is a 24-hex id — the agency id |
| `status` | `active` \| `pending_verification` \| `inactive` | |
| `verified` | boolean flag | Whether the business-verification flag is set. **Distinct from `status`, and the two can legitimately disagree** — nothing enforces verification today, so an `active` unverified agency is a real state, and finding those is exactly why this filter exists |
| `autoAssign` | boolean flag | Whether the agency opted into auto-assignment |
| `country` | 2 letters | ISO-3166 alpha-2, upper-cased |
| `from` / `to` | ISO-8601 instant | Creation range. **Max span 366 days** |

### Response (200)

```jsonc
{
  "success": true,
  "data": [
    {
      "id": "665c0011223344556677889a",
      "userId": "665b998877665544332211ff",
      "businessName": "Littoral Express",
      "logoFileId": "665c00112233445566778900",
      "contactName": "Nadège M.",
      "country": "CM",
      "status": "active",
      "onboardingComplete": true,
      "verified": true,
      "verifiedLegacyMirror": true,
      "autoAssignEnabled": true,
      "createdAt": "2025-09-12T08:00:00.000Z",
      "updatedAt": "2026-08-04T15:31:00.000Z"
    }
  ],
  "meta": { "total": 37, "page": 1, "limit": 20, "pages": 2 }
}
```

| Field | Notes |
|---|---|
| `businessName` | From the Magazin. `null` — never `""` — when absent |
| `logoFileId` | **An opaque id.** This service resolves no file URLs |
| `contactName` | The agency's contact **person**, not the business. `businessName` above is the business, off the Magazin. Never render one under a heading meant for the other — a column headed "Agency" showing `contactName` shows a human |
| `onboardingComplete` | `onboarding_step === 0` is the COMPLETE sentinel; the boolean is computed once so nobody reads it backwards |
| `verified` / `verifiedLegacyMirror` | **Both mirrors are shown deliberately.** The first is canonical, the second deprecated. They are written together, so a **disagreement means a hand-edited document** — showing both makes that visible instead of hiding it |

---

## `GET /agencies/:agencyId`

| | |
|---|---|
| **Permission** | `agencies.read` |
| **Path parameter** | `agencyId` — 24-hex |

### Response (200)

Every list field, plus:

```jsonc
{
  "success": true,
  "data": {
    "…all list fields…": "…",
    "email": "ops@littoralexpress.cm",
    "emailVerified": true,
    "phone": "+237677001122",
    "phoneVerified": true,
    "coverageAreas": ["Littoral", "Sud-Ouest"],
    "kyc": {
      "registrationNumber": "RC/DLA/2019/B/1234",
      "transportLicenseId": "TL-CM-88213",
      "verifiedAt": "2025-09-20T10:00:00.000Z",
      "verifiedBy": { "id": "665f…", "source": "wi-admin", "name": "Ada Nkemelu" }
    },
    "policies": {
      "pricing": {
        "storageBased": {
          "enabled": true,
          "monthlyStorageFeePerSku": 500,
          "pickPackFeePerOrder": 250,
          "localDeliveryFee": 1000,
          "outOfRegionDeliveryFee": 2500
        },
        "pickupBased": {
          "enabled": false,
          "baseRateFirstKg": 800,
          "additionalPerKg": 200,
          "outOfRegionSurcharge": 1500
        },
        "additionalFees": {
          "codHandlingFee": { "type": "percentage", "value": 2 },
          "failedDeliveryFee": 500,
          "rtoFee": 1200,
          "peakSeasonSurcharge": null
        },
        "notes": null
      },
      "returns": {
        "payer": "vendor",
        "handlingFee": 300,
        "returnWindowDays": 7,
        "notes": null
      },
      "damage": {
        "claimDeadlineDays": 3,
        "maxRefundPerItem": 50000,
        "inspector": "admin",
        "investigationFee": 0,
        "notes": null
      },
      "cod": { "enabled": true, "maxOrderAmount": 200000 },
      "documents": []
    },
    "policyVersion": 4,
    "policyVersionPausedConnections": 12,
    "timezone": "Africa/Douala",
    "preferredLanguage": "fr"
  }
}
```

| Field | Notes |
|---|---|
| `coverageAreas` | From the Magazin |
| `kyc.verifiedBy` | **Present only while verified.** An unverified agency carrying a stale approver would read as approved on any screen that renders the block without checking the flag first |
| `policies` | The agency's own terms, read-only here. `null` when unset. **camelCase and field-by-field since the dashboard-request round** — it previously shipped jovi-mall's raw sub-document, four nested blocks of `snake_case`. Each inner block is independently `null` when the agency has stored none |
| `policies.pricing.storageBased.enabled: false` | **The agency does not offer warehousing at all** — different from offering it at zero. Say so rather than printing a rate nobody agreed to |
| `policies.pricing.additionalFees.codHandlingFee.type` | `percentage` or `fixed`, and it decides how `value` reads |
| `policies.cod.maxOrderAmount` | **`null` means no ceiling**, not zero. Zero would block every COD order |
| `policies.damage.inspector` · `.investigationFee` | **Administrator-controlled upstream**, not the agency's to set — which is why they can differ from everything else in the block |
| `policies.documents[]` | Up to two links to off-platform term sheets. URLs to somewhere else entirely: render them as links, and note this service never fetches or previews them |
| `policyVersion` | Bumping it pauses every vendor connection for re-approval — which is why nothing here edits policies |
| **`policyVersionPausedConnections`** | How many vendor connections are sitting in `paused_reapproval` **right now**. New in the dashboard-request round: `policyVersion` is the field with the largest blast radius on this screen and there was no way to see the consequence. The vendor side has had `counts.agencyConnections.pausedReapproval` all along; the two count the same collection, from opposite ends |

> **Why `policies` is projected whole when nothing else here is.** These are commercial terms
> already visible to every vendor connected to the agency, so there is no field that could be
> added to them which this surface should not see. The projection stays wide and the **mapper**
> is the lock: a field added upstream reaches the read model and stops there rather than
> appearing on the wire uninvited.

### Errors

| Status | Code |
|---|---|
| 400 | `VALIDATION_ERROR` — "Not a valid delivery agency id" |
| 404 | `NOT_FOUND` — "Delivery agency not found" |

---

## `GET /agencies/:agencyId/agents`

The roster: which agents this agency holds contracts with.

**A roster is not a list of agents this agency can dispatch to.** That is an eligibility
question, it is pairwise, and it lives at
[`GET /agents/:agentId/eligibility`](agents.md#get-agentsagentideligibility).

| | |
|---|---|
| **Permission** | `agencies.read` **+** `agents.read` |
| **Pagination** | `page`, `limit` |
| **Sorting** | `createdAt` only. Default **`-createdAt`** |

Requiring `agents.read` too states the dependency: the rows carry agent names, statuses, KYC
and ban state, so without it this would be a second door onto the agent directory.

### Query parameters

| Parameter | Type | Notes |
|---|---|---|
| `status` | string, 1–40 | Contract status. **A bounded string, not a pinned enum** — the vocabulary is jovi-mall's and this service never writes it, so pinning would go stale (it gained `withdrawn` recently) |
| `primaryOnly` | boolean flag | Only contracts that currently allocate COD headroom |

**Every contract status is returned by default, terminal rows included.** A live-only default
would make a relationship's history impossible to fetch, which on an administrative surface is
most of what the screen is for.

### Response (200)

```jsonc
{
  "success": true,
  "data": [
    {
      "id": "6661aabbccddeeff00112233",
      "agentId": "6660112233445566778899aa",
      "agencyId": "665c0011223344556677889a",
      "status": "active",
      "origin": "agent_request",
      "isPrimary": true,
      "cod": {
        "threshold": 150000,
        "outstandingBalance": 42000,
        "lastSettledAt": "2026-08-11T17:04:00.000Z"
      },
      "payment": {
        "outstandingToAgent": 18500,
        "lastPaidAt": "2026-08-05T09:00:00.000Z"
      },
      "terms": {
        "employment": { "type": "contractor", "employeeRef": "AG-114",
                        "startedAt": "2026-01-04T00:00:00.000Z", "endsAt": null },
        "remittance": { "cadence": "weekly", "dayOfWeek": 1,
                        "dayOfMonth": null, "graceHours": 24 },
        "feeSplit":   { "model": "percentage", "agentSharePercent": 70,
                        "agentFlatFee": null, "currency": "XAF" },
        "coverageRegions": [],
        "shipmentValueCeiling": 500000,
        "proposedBy": "agency",
        "version": 3
      },
      "lifecycle": {
        "approvedAt": "2026-01-14T08:00:00.000Z",
        "suspendedAt": null, "suspensionReason": null,
        "deactivatedAt": null, "deactivationReason": null,
        "withdrawnAt": null, "withdrawalReason": null
      },
      "createdAt": "2026-01-10T12:00:00.000Z",
      "updatedAt": "2026-08-11T17:04:00.000Z",
      "agent": {
        "id": "6660112233445566778899aa",
        "name": "Eric T.",
        "status": "active",
        "kycStatus": "verified",
        "availability": "online",
        "banned": false
      }
    }
  ],
  "meta": { "total": 12, "page": 1, "limit": 20, "pages": 1 }
}
```

#### Fields worth reading carefully

| Field | Notes |
|---|---|
| `cod.threshold` | **This contract's slice** of the agent's global COD pool — not the pool itself |
| `cod.outstandingBalance` | What the agent currently owes **this** agency |
| `payment.outstandingToAgent` | What this agency currently owes the agent |
| `terms.coverageRegions` | **An empty array means NO RESTRICTION, not "covers nowhere".** The coverage rule fails open, and it must: an empty array is the schema default on every contract ever written. **Render this as "all regions"** |
| `terms.proposedBy` | Who made the standing proposal. **This — not `origin` — decides whose turn it is to answer on a pending contract**, and the two disagree the moment anybody counters. Rendering `origin` alone is how a dashboard draws the wrong button |
| `agent` | **`null` when the joined agent row is missing** — a contract pointing at an agent that does not exist. That is a broken state, and precisely the one an administrator opens this screen to find, which is why the join preserves the row rather than dropping it |

---

## `GET /agencies/:agencyId/contract-history`

jovi-mall's own record of what happened to this agency's relationships — **what everyone did**
(`actorRole` is `agent`, `agency`, `admin` or `system`).

Its sibling `/activity` is what **administrators** did. They are two endpoints rather than one
merged feed because they live in two databases reached by two clients, where a merged page
total would be a sum of two counts and `meta.pages` a lie.

| | |
|---|---|
| **Permission** | `agencies.read` — this is **not** audit data, and the audit read scope does not apply |
| **Pagination** | `page`, `limit` |
| **Sorting** | `occurredAt` only. Default **`-occurredAt`** |

### Query parameters

| Parameter | Type | Notes |
|---|---|---|
| `type` | string, 1–60 | Event type. **A bounded string, not an enum** — a 24-value vocabulary jovi-mall owns, which has already drifted against its own schema once |
| `actorRole` | `agent` \| `agency` \| `admin` \| `system` | |
| `from` / `to` | ISO-8601 instant | Max span 366 days |

### Response (200)

```jsonc
{
  "success": true,
  "data": [
    {
      "id": "6662aabbccddeeff00112233",
      "contractId": "6661aabbccddeeff00112233",
      "agentId": "6660112233445566778899aa",
      "agencyId": "665c0011223344556677889a",
      "agent": { "id": "6660112233445566778899aa", "name": "Ibrahim T." },
      "type": "CONTRACT_APPROVED",
      "fromStatus": "pending",
      "toStatus": "active",
      "actorRole": "agency",
      "actorUserId": "665b998877665544332211ff",
      "reason": null,
      "occurredAt": "2026-01-14T08:00:00.000Z"
    }
  ],
  "meta": { "total": 44, "page": 1, "limit": 20, "pages": 3 }
}
```

| Field | Notes |
|---|---|
| **`agent`** | Who the row is **about**. `{ id, name }`, or `null` when the agent record is gone — a broken state the row is kept to show, never a fabricated label |
| `agent.name` | ⚠ **`name`, not `businessName`.** An agent is a **person**. The mirror decoration on [`GET /agents/:agentId/contracts`](agents.md#get-agentsagentidcontracts) carries `businessName` because an agency is a business; the two are different kinds of thing and a company name under a column headed "Agent" would be wrong in the same way `contactName` under "Agency" was |

The lookup runs **after** `skip`/`limit`, in one batched read, so it touches at most one page
however deep the history goes. The same decoration is on
[`GET /agents/:agentId/contract-history`](agents.md#get-agentsagentidcontract-history), where
every row names the agent in the path — carried anyway, because the two feeds share one shape
and a client branching on which endpoint it called to know whether `agent` is present will get
it wrong.

> **`actorUserId` has no `source` companion, and is deliberately NOT resolved.** Read the
> **role**, not the id — an `admin` row's id belongs to the wi-admin database and resolves to
> nothing in the platform database, and the other three roles write ids from three different
> collections. The **agent** is the subject of the row and is unambiguous; the **actor** is not.
> The one place an actor name *is* resolved is
> [`GET /orders/:orderId/timeline`](orders.md#get-ordersorderidtimeline), whose `actorType`
> tells you which of three id spaces to look in.

---

## `GET /agencies/:agencyId/activity`

What **administrators** did to this agency: every verification, deactivation and reactivation.

Not the agency's platform activity — its shipments, orders and COD remittances live in other
domains behind other permissions.

| | |
|---|---|
| **Permission** | `agencies.read` **+** `audit.read` |
| **Pagination** | `page`, `limit` |
| **Sorting** | `occurredAt` only. Default **`-occurredAt`** |

### Query parameters

| Parameter | Type | Notes |
|---|---|---|
| `action` | enum | Only `agencies.*` actions — derived from the audit catalog |
| `status` | `attempted` \| `succeeded` \| `failed` \| `denied` \| `queued` | |
| `from` / `to` | ISO-8601 instant | Max span 366 days |

### Response (200)

Audit entries — identical shape to [`GET /audit`](audit.md#get-audit).

---

## `POST /agencies/:agencyId/verify`

Approve the business verification. **This is the exit from `pending_verification`**, and it had
none before: nothing moved an agency off that status except `reactivate`, an endpoint whose name
says the opposite and which also runs the product-restore cascade.

| | |
|---|---|
| **Permission** | `agencies.verify` |
| **Transport** | Delegated |
| **Body** | `{}` — **strict**, so any field is a `400` |

**No reason field, deliberately.** A reason would be theatre: the act is an approval, the actor
is stamped on the agency and on the audit row, and a free-text field nobody must fill produces a
column of empty strings. Contrast `deactivate` below, where the reason *is* the record.

### Response (200)

The updated agency, with the message `"Agency verified — it may now operate"`.

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | A field was sent |
| 404 | `NOT_FOUND` | |
| 409 | `PLATFORM_OPERATION_REJECTED` | jovi-mall performs it as a compare-and-set, so two administrators on one screen cannot overwrite each other's stamp |
| 502 / 503 | `SERVICE_DEPENDENCY_UNAVAILABLE` | |

### Audit

`agencies.verify`

---

## `POST /agencies/:agencyId/reject`

Refuse the business verification, with a reason. The other half of the review.

| | |
|---|---|
| **Permission** | `agencies.verify` — see below |
| **Transport** | Delegated |
| **Body** | `{ "reason": "Transport licence has expired" }` — required, 3–500 chars |

**It holds `agencies.verify`, not a permission of its own.** That permission is the *review
capability*, named for its happy path, exactly as `vendors.kyc.review` and `agents.kyc.review`
each cover both of their outcomes. ADR-005 D-4 attaches the permission and the audit row to the
action; here the two verdicts are one action with two results, so the **audit action** is what
separates them.

**The reason is FORWARDED to jovi-mall and stored on the agency**, unlike the deactivation
reason below, which is audit-only. The distinction is who reads it: a deactivation reason is
for an administrator reviewing the decision later, and a rejection reason is for the **agency**,
who has to know what to fix and cannot read this database.

### ⚠ It changes no status

jovi-mall leaves the agency at `pending_verification` — it is not deactivated, and no cascade
runs. A non-`active` agency is already refused by product activation, pickup resolution, COD
eligibility and vendor default-agency selection, so this records a verdict rather than adding
enforcement.

**There is deliberately no un-reject.** The agency is still pending, so `POST /verify` accepts
them once they fix what the reason named.

### Response (200)

The updated agency, with the message `"Agency verification rejected"`.

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Missing, blank, under 3 or over 500 characters |
| 404 | `NOT_FOUND` | |
| 409 | `PLATFORM_OPERATION_REJECTED` | Another administrator reached a verdict first — the same compare-and-set as `verify` |
| 502 / 503 | `SERVICE_DEPENDENCY_UNAVAILABLE` | |

### Audit

`agencies.reject` — with the reason in the payload as well as on the agency.

---

## `POST /agencies/:agencyId/deactivate`

Stop an agency operating. **This cascades**: every vendor product defaulting to the agency is
suspended, and their in-flight order items are put on hold.

| | |
|---|---|
| **Permission** | `agencies.deactivate` — flagged `destructive` |
| **Transport** | Delegated |

### Request body

| Field | Type | Rules |
|---|---|---|
| `reason` | string | **Required.** 3–500 characters |

The reason requirement is **new here** — jovi-mall's own endpoint takes none. Vendors will ask
why their listings went dark, and without it the only answer available is "an administrator did
it".

> The reason is carried in the **audit row's payload and nowhere else.** No column is added to
> the agency record, because no agency-facing screen shows a deactivation reason.

```json
{ "reason": "Licence lapsed — no valid transport licence on file since 2026-07-31" }
```

### Response (200)

```jsonc
{
  "success": true,
  "data": { "id": "665c0011223344556677889a", "status": "inactive", "…": "…" },
  "meta": { "products": 214, "orderItems": 37 },
  "message": "Agency deactivated. 214 product(s) suspended, 37 order item(s) put on hold."
}
```

The counts are in **`meta`** rather than `data` because they describe what the write *did*,
not what the agency now *is*. They are the number a vendor's support ticket will be about.

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Missing or too-short reason |
| 404 | `NOT_FOUND` | |
| 409 | `PLATFORM_OPERATION_REJECTED` | Already inactive |
| 502 / 503 | `SERVICE_DEPENDENCY_UNAVAILABLE` | |

### Audit

`agencies.deactivate`

---

## `POST /agencies/:agencyId/reactivate`

Bring an agency back and run the restore cascade.

| | |
|---|---|
| **Permission** | `agencies.reactivate` |
| **Transport** | Delegated |

### Request body

| Field | Type | Rules |
|---|---|---|
| `reason` | string | **Optional**, 3–500 characters |

The asymmetry with `deactivate` is deliberate: undoing a restriction needs no justification,
imposing one does.

### Response (200)

```jsonc
{
  "success": true,
  "data": { "id": "665c0011223344556677889a", "status": "active", "…": "…" },
  "meta": { "products": 197, "orderItems": 37 },
  "message": "Agency reactivated. 197 product(s) restored, 37 order item(s) resumed."
}
```

> **Fewer products usually come back than went down, and that is correct.** A listing that no
> longer passes its own activation gate stays suspended. The gap is visible in the audit row's
> `after`; show both numbers, or an operator will read it as a partial failure.

### Audit

`agencies.reactivate`
