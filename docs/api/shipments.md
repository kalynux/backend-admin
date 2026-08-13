# `/shipments` — shipment administration

Base path: `/api/v1/shipments`

Entirely net-new: there was no admin shipment surface anywhere before this service. An
administrator investigating a stalled delivery could see the order and the agency and nothing in
between.

Design record: [`../ADR-010-ORDERS-AND-SHIPMENTS.md`](../ADR-010-ORDERS-AND-SHIPMENTS.md).

| Method | Path | Permission | Transport | Audited |
|---|---|---|---|---|
| `GET` | `/shipments` | `shipments.read` | direct read | — |
| `GET` | `/shipments/:shipmentId` | `shipments.read` | direct read | — |
| `GET` | `/shipments/:shipmentId/offers` | `shipments.read` **+** `agents.read` | direct read | — |
| `GET` | `/shipments/:shipmentId/activity` | `shipments.read` **+** `audit.read` | direct read | — |
| `POST` | `/shipments/:shipmentId/reassign` | `shipments.reassign` | **delegated** | ✅ |
| `POST` | `/shipments/:shipmentId/cancel` | `shipments.cancel` | **delegated** | ✅ |

## Two things this surface deliberately does not do

**No status transition.** Driving a delivery through `picked_up → in_transit → delivered` is
the agent's job and the agency desk's. An admin transition would also need a third actor
carrying neither an agency nor an agent id, which would strip both ownership predicates out of
the compare-and-set that makes two actors on one shipment safe.

**`cancel` reaches only `assigned`.** It maps to the platform's `reject`, which refuses
anything past pickup, and that refusal is inherited rather than widened — a picked-up parcel is
physically with somebody, and the domain's answer is a **reassignment** or a return. Disable the
button outside `assigned`; the `422` carries `details.status`.

## Why the writes are delegated, and why it matters here most

**A reassignment emits the outbox row that closes the old agent's live tracking session in
geo-tracker.** A second writer would move `agent_id` correctly and leave a person who is no
longer delivering being watched.

## Status vocabulary

Validated by **format, not membership**: the shipment status enum is a **cross-service
contract**, duplicated in geo-tracker's Go, and the platform extends it without asking
(`handing_over` was added for post-pickup reassignment). Pinning it here would mean 400-ing
filters for a status the platform is actively writing.

Values in use today, for reference only:

`pending` · `assigned` · `handing_over` · `picked_up` · `in_transit` · `agent_delivered` ·
`delivered` · `failed` · `returned` · `rejected` · `pending_agency_reassignment`

`assignmentState` is a separate axis — `unassigned` · `offered` · `accepted` — and is the
assignment mirror, **not** the status.

---

## `GET /shipments`

| | |
|---|---|
| **Permission** | `shipments.read` |
| **Pagination** | `page`, `limit` |
| **Sorting** | `createdAt` only. Default **`-createdAt`** |

`updatedAt` is deliberately not sortable — every sortable field costs an index on a hot write
collection.

### Query parameters

| Parameter | Type | Notes |
|---|---|---|
| `search` | string, 1–120 | Tracking-number **prefix**, or a 24-hex id of a shipment, order, agent or agency |
| `status` | status token | Format-validated |
| `assignmentState` | status token | `unassigned` \| `offered` \| `accepted` |
| `agencyId` | 24-hex | |
| `agentId` | 24-hex | |
| `orderId` | 24-hex | |
| `unassigned` | boolean flag | No agent bound yet — out on offer, or never offered |
| `held` | boolean flag | Frozen by the agency-deactivation cascade |
| `from` / `to` | ISO-8601 instant | Creation range. **Max span 366 days** |

### Response (200)

```jsonc
{
  "success": true,
  "data": [
    {
      "id": "6671aabbccddeeff00112233",
      "trackingNumber": "WM-SH-2026-114402",
      "status": "assigned",
      "orderId": "6670aabbccddeeff00112233",
      "orderNumber": "ORD-2026-008841",
      "agency": { "id": "665c0011223344556677889a", "name": "Littoral Express" },
      "agent":  { "id": "6660112233445566778899aa", "name": "Eric T." },
      "assignmentState": "accepted",
      "held": false,
      "itemCount": 3,
      "deliveryFeeSnapshot": 1500,
      "createdAt": "2026-08-12T10:30:00.000Z",
      "updatedAt": "2026-08-12T11:02:00.000Z"
    }
  ],
  "meta": { "total": 8841, "page": 1, "limit": 20, "pages": 443 }
}
```

`agent` is `null` while unassigned. `held` means the agency-deactivation cascade froze it.

---

## `GET /shipments/:shipmentId`

The investigation view.

| | |
|---|---|
| **Permission** | `shipments.read` |
| **Path parameter** | `shipmentId` — 24-hex |

### Response (200)

Every list field, plus:

```jsonc
{
  "success": true,
  "data": {
    "…all list fields…": "…",

    "order": { "id": "6670…", "orderNumber": "ORD-2026-008841", "…": "…" },

    "assignment": {
      "state": "accepted",
      "currentOfferId": "6673aabbccddeeff00112233",
      "offeredAgentId": "6660112233445566778899aa",
      "updatedAt": "2026-08-12T11:02:00.000Z",
      "offerCount": 4
    },

    "statusHistory": [
      { "status": "pending",  "at": "2026-08-12T10:30:00.000Z", "byUserId": null, "byRole": "system" },
      { "status": "assigned", "at": "2026-08-12T11:02:00.000Z",
        "byUserId": "6660112233445566778899aa", "byRole": "agent" }
    ],

    "handover": null,

    "deliveryFailures": [
      { "status": "failed", "reason": "customer_unreachable", "note": "Three calls, no answer",
        "fromStatus": "in_transit", "reportedByAgentId": "6660…",
        "reportedAt": "2026-08-12T16:40:00.000Z" }
    ],

    "agentCancellation": null,

    "rejection": {
      "reason": "platform_intervention",
      "note": "Agency deactivated mid-route",
      "at": "2026-08-12T17:00:00.000Z",
      "by": { "id": "665f…", "source": "wi-admin", "name": "Ada Nkemelu" }
    },

    "customerConfirmation": null,
    "hold": null,

    "cod": {
      "collectionId": "6674aabbccddeeff00112233",
      "status": "pending",
      "expectedAmount": 27500,
      "currency": "XAF",
      "collectedAt": null,
      "verificationMethod": "delivery_code",
      "codeAttempts": 1,
      "codeLocked": false,
      "settledAmount": null,
      "settledAt": null
    },

    "offers": [ { "…see the offers endpoint…": "…" } ],

    "items": [
      { "orderItemId": "6670…40", "productId": "66601122334455667788990a",
        "variantId": null, "quantity": 3 }
    ],

    "deliveryProofFileId": "6675aabbccddeeff00112233",

    "tracking": {
      "outbox": { "pending": 0, "failed": 1, "lastEventAt": "2026-08-12T17:00:01.000Z",
                  "lastError": "connect ECONNREFUSED" }
    }
  }
}
```

### Field notes — the ones that matter

| Field | Notes |
|---|---|
| **`handover`** | Where a replacement agent collects. **Textual only** — the geographic point is excluded by projection *and* by the mapping. Its `source` is very often `previous_agent_location`, i.e. a delivery agent's last known GPS position, and that value does not leave through here |
| **`cod`** | The cash state. **Never the delivery code.** `codePlain`/`codeHash` are excluded twice over — the code is a bearer credential over the customer's cash |
| `cod.codeLocked` | Too many wrong code attempts |
| `rejection.by.source` | **Says which database the id resolves in.** An `admin` id resolves in neither the platform database nor as a platform user |
| `statusHistory[].byRole` | `agent`, `agency`, `admin` or `system` |
| **`tracking.outbox`** | **Outbox health, not a trackability verdict.** How many events for this shipment are still pending or have failed, and when the last one went out |

#### Why `tracking.outbox` is worth a panel

The platform's outbox is **not transactional** — a crash between commit and enqueue loses the
event permanently. The consequence lands exactly here: *a reassignment whose release event was
lost leaves a tracking session open on an agent who is no longer delivering.*

`failed > 0` or a stale `lastEventAt` on a shipment that has just been reassigned is the signal.
Whether the shipment is *trackable* is the platform's policy and is deliberately not recomputed
here.

### Errors

| Status | Code |
|---|---|
| 400 | `VALIDATION_ERROR` — "Not a valid shipment id" |
| 404 | `NOT_FOUND` |

---

## `GET /shipments/:shipmentId/offers`

The offer trail — every agent this shipment was offered to, in which round, and how they
answered.

| | |
|---|---|
| **Permission** | `shipments.read` **+** `agents.read` — the rows name agents, their round and their refusal reasons, so gating on `shipments.read` alone would be a second door onto the agent directory |
| **Pagination** | **None** — an offer trail is bounded by the assignment rounds |
| **Parameters** | None |

### Response (200)

```jsonc
{
  "success": true,
  "data": [
    {
      "id": "6673aabbccddeeff00112233",
      "agentId": "6660112233445566778899aa",
      "agentName": "Eric T.",
      "status": "accepted",
      "origin": "auto_assignment",
      "round": 2,
      "sessionId": "6676aabbccddeeff00112233",
      "createdBy": null,
      "expiresAt": "2026-08-12T11:05:00.000Z",
      "respondedAt": "2026-08-12T11:02:00.000Z",
      "rejectionReason": null,
      "createdAt": "2026-08-12T11:00:00.000Z"
    },
    {
      "id": "6673aabbccddeeff00112230",
      "agentId": "6660112233445566778899bb",
      "agentName": "Paul N.",
      "status": "rejected",
      "origin": "auto_assignment",
      "round": 1,
      "sessionId": "6676aabbccddeeff00112233",
      "createdBy": null,
      "expiresAt": "2026-08-12T10:35:00.000Z",
      "respondedAt": "2026-08-12T10:33:00.000Z",
      "rejectionReason": "too_far",
      "createdAt": "2026-08-12T10:30:00.000Z"
    }
  ]
}
```

| Field | Notes |
|---|---|
| `round` | Which auto-assignment round produced the offer |
| `sessionId` | **`null` for a manual offer**; set when it came from an auto-assignment session |
| `createdBy` | `{ role, userId, name }` on a manually created offer; `null` otherwise |
| `expiresAt` | Offers time out |

---

## `GET /shipments/:shipmentId/activity`

What **administrators** did to this shipment.

| | |
|---|---|
| **Permission** | `shipments.read` **+** `audit.read` |
| **Sorting** | `occurredAt` only. Default `-occurredAt` |
| **Filters** | `action` (only `shipments.*`, derived from the catalog), `status`, `from`/`to` (max 366 days) |
| **Response** | Audit entries — see [audit.md](audit.md#get-audit) |

---

## `POST /shipments/:shipmentId/reassign`

Move a shipment to a different agent.

| | |
|---|---|
| **Permission** | `shipments.reassign` |
| **Transport** | Delegated |
| **Body** | **Strict** |

### Request body

| Field | Type | Rules |
|---|---|---|
| `agentId` | 24-hex | **Optional.** Omitted **pre-pickup** means auto-assign down a fresh ranking. **Past pickup it is required** — the platform refuses with `SHIPMENT_REASSIGN_REQUIRES_MANUAL_AGENT` |
| `reason` | string | **Required.** 3–500 characters |
| `pickupLocation` | object | Optional. Where the replacement agent collects, when overriding the derived point |

`pickupLocation` (strict):

| Field | Type |
|---|---|
| `label` | string, ≤ 200 |
| `note` | string, ≤ 500 |
| `coordinates` | `[number, number]` |
| `address` | object |

The pre-pickup / post-pickup rule is **not pre-checked here**, deliberately — it is the platform
assignment service's rule, and a copy in this validator would drift the day a status is added to
it.

```json
{
  "agentId": "6660112233445566778899cc",
  "reason": "Original agent's vehicle broke down at Bonabéri",
  "pickupLocation": { "label": "Total Bonabéri forecourt", "note": "Parcel with the station manager" }
}
```

### Response (200)

The platform's reassignment result, message `"Shipment reassigned"`.

### What actually happens

The old agent is **released, not terminated** — an event with `shipmentTrackable: false`, which
is the existing "left this agent" release. The shipment is then re-offered, and **the new
agent's tracking session opens only when they accept**, so two agents are never tracked at once.

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Missing reason, malformed id, unknown field |
| 404 | `NOT_FOUND` | |
| 409 / 422 | `PLATFORM_OPERATION_REJECTED` | Past pickup with no `agentId`, the target agent is ineligible, the status moved. `details.platformCode` names which |
| 502 / 503 | `SERVICE_DEPENDENCY_UNAVAILABLE` | |

### Audit

`shipments.reassign`

---

## `POST /shipments/:shipmentId/cancel`

Pull a shipment back for re-routing. **Only reaches `assigned`.**

| | |
|---|---|
| **Permission** | `shipments.cancel` — flagged `destructive` |
| **Transport** | Delegated |
| **Body** | **Strict** |

### Request body

| Field | Type | Rules |
|---|---|---|
| `reason` | status token | Optional, **defaults to `platform_intervention`** — the reason an administrator owns. Other values come from the platform's own rejection-reason set |
| `note` | string | **Required.** 3–200 characters |

The note is required here where the agency's equivalent is optional, and it is stored **on the
shipment** rather than only in the audit trail: this service's audit database is one jovi-mall
cannot read, and the vendor whose delivery just vanished has to be able to be told why by the
service that holds their data.

```json
{ "note": "Agency deactivated mid-route — re-routing to Wouri Logistics" }
```

### Response (200)

The platform's result, message `"Shipment cancelled and returned for re-routing"`.

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Missing note, unknown field |
| 404 | `NOT_FOUND` | |
| **422** | `PLATFORM_OPERATION_REJECTED` | **Past pickup.** `details.status` carries the current status — use it to explain why, and to disable the button next time |
| 502 / 503 | `SERVICE_DEPENDENCY_UNAVAILABLE` | |

### Audit

`shipments.cancel`
