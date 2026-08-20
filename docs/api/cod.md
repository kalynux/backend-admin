# `/cod` — cash on delivery

Base path: `/api/v1/cod`

Platform oversight of the cash chain: who is holding the platform's money, the two settlement
paths, the flags raised when the chain breaks, and the trust score that bounds how much one
person may carry.

Design records: [`../ADR-004-DOMAIN-OWNERSHIP.md`](../ADR-004-DOMAIN-OWNERSHIP.md),
[`../ADR-011-ACCOUNTS-AND-FINANCE.md`](../ADR-011-ACCOUNTS-AND-FINANCE.md).

| Method | Path | Permission | Transport | Audited |
|---|---|---|---|---|
| `GET` | `/cod/overview` | `cod.overview.read` | **delegated** | — |
| `GET` | `/cod/holders` | `cod.holders.read` | direct read | — |
| `GET` | `/cod/remittances` | `cod.remittances.read` | **delegated** | — |
| `GET` | `/cod/remittances/:remittanceId` | `cod.remittances.read` | direct read | — |
| `POST` | `/cod/remittances/:remittanceId/confirm` | `cod.remittances.confirm` | **delegated** | ✅ |
| `POST` | `/cod/remittances/:remittanceId/reject` | `cod.remittances.reject` | **delegated** | ✅ |
| `GET` | `/cod/deposits` | `cod.deposits.read` | **delegated** | — |
| `POST` | `/cod/deposits` | `cod.deposits.create` | **delegated** | ✅ |
| `GET` | `/cod/deposits/:depositId` | `cod.deposits.read` | direct read | — |
| `POST` | `/cod/deposits/:depositId/confirm` | `cod.deposits.confirm` | **delegated** | ✅ |
| `POST` | `/cod/deposits/:depositId/reject` | `cod.deposits.reject` | **delegated** | ✅ |
| `GET` | `/cod/discrepancies` | `cod.discrepancies.read` | direct read | — |
| `GET` | `/cod/discrepancies/:discrepancyId` | `cod.discrepancies.read` | direct read | — |
| `POST` | `/cod/discrepancies/:discrepancyId/resolve` | `cod.discrepancies.resolve` | **delegated** | ✅ |
| `GET` | `/cod/agents/:agentId/trust-events` | `cod.holders.read` **+** `agents.read` | direct read | — |
| `POST` | `/cod/agents/:agentId/trust-adjustment` | `cod.trust.adjust` | **delegated** | ✅ |

**Nothing on this surface is Support's.** Every permission here is Admin and above, and seven
are flagged `financial` — including `cod.deposits.create`, the one route that asserts money
arrived.

## The cash model in one paragraph

Liability flows **upward in two layers**: an agent owes their agency, and an agency owes the
platform. There is **no `platform` holder** — the platform is the creditor at the top of the
chain and does not owe itself. Two settlement paths discharge that liability:

- **Remittance** — the agency hands cash up to the platform. Confirming it settles collections
  FIFO and unlocks the agency's earnings.
- **Deposit** — the agent hands cash back. `recipient: "agency"` is the normal route and clears
  the agent's leg only. **`recipient: "platform"` skipped the middle leg and clears both.**

That asymmetry is visible in the data: a confirmed platform deposit carries **two** cash-ledger
movements, an agency deposit **one**.

## Mixed transport

Delegated: the **overview** (three totals the platform itself branches on) and **every write,
without exception**.

Direct: the **records** — holders, remittance and deposit details, discrepancies, the cash
ledger, trust events.

Two list endpoints (`GET /remittances`, `GET /deposits`) stay delegated for a narrower reason:
they have been live since an earlier phase and converting them would change their shape for no
gain. Their **details** are direct reads, so one resource is served through two transports —
the detail shape is a strict superset of the list shape.

---

## `GET /cod/overview`

The platform-wide cash position.

| | |
|---|---|
| **Permission** | `cod.overview.read` |
| **Transport** | **Delegated** — a copy of this arithmetic here would be a second opinion about how much money exists |
| **Parameters** | None |
| **Pagination** | None |

### Response (200)

`data` is the platform's own overview object: totals across every cash account, cross-referenced
against unsettled collections.

### Errors

`502` / `503 SERVICE_DEPENDENCY_UNAVAILABLE`.

---

## `GET /cod/holders`

Who is currently holding platform cash. **One route for both owner types**, because they are two
layers of a single liability model.

| | |
|---|---|
| **Permission** | `cod.holders.read` |
| **Pagination** | `page`, `limit` |
| **Sorting** | `balance`, `lastMovementAt`, `createdAt`. Default **`-balance`** — the question this screen answers is "who is holding the most of our money" |

### Query parameters

| Parameter | Type | Notes |
|---|---|---|
| `ownerType` | `agent` \| `agency` | **Pinned, and `platform` is refused** — a caller asking for it has misread the model, and an empty `200` would let them go on misreading it |
| `ownerId` | 24-hex | |
| `includeSettled` | boolean flag, default **`false`** | A settled account (balance zero) is not a holder. Set `true` when reconciling — *"did this agency's liability actually reach zero"* |

### Response (200)

```jsonc
{
  "success": true,
  "data": [
    {
      "ownerType": "agent",
      "owner": { "id": "6660112233445566778899aa", "name": "Eric T." },
      "balance": 84500,
      "currency": "XAF",
      "version": 41,
      "lastMovementAt": "2026-08-13T07:12:00.000Z",
      "trust": { "score": 87, "maxThreshold": 250000 }
    },
    {
      "ownerType": "agency",
      "owner": { "id": "665c0011223344556677889a", "name": "Littoral Express" },
      "balance": 1240000,
      "currency": "XAF",
      "version": 812,
      "lastMovementAt": "2026-08-13T06:40:00.000Z",
      "trust": null
    }
  ],
  "meta": { "total": 96, "page": 1, "limit": 20, "pages": 5 }
}
```

| Field | Notes |
|---|---|
| `balance` | Outstanding liability, minor units. **Never negative** |
| `version` | The compare-and-set counter, surfaced so a stale screen is detectable. **It is not a balance — do not compute with it** |
| `lastMovementAt` | When the balance last moved |
| **`trust`** | **`null` for an agency** — the "does not apply to this owner kind" rule, not "unknown". A trust score bounds how much cash one *person* may carry; an agency's exposure is bounded by its contracts, a different mechanism entirely |

---

# Remittances — the agency handing cash up

## `GET /cod/remittances`

| | |
|---|---|
| **Permission** | `cod.remittances.read` |
| **Transport** | **Delegated** |
| **Pagination** | `page`, `limit` |
| **Sorting** | **None offered** — the ordering belongs to the platform |

### Query parameters

| Parameter | Type | Notes |
|---|---|---|
| `status` | string | The status vocabulary is the platform's; not pinned, so a new status is filterable the day it ships |
| `agencyId` | 24-hex | |

### Response (200)

A paginated array of remittances (see the detail shape below, minus `cashMovements`), with
standard `{ total, page, limit, pages }` meta.

---

## `GET /cod/remittances/:remittanceId`

Net-new — the legacy surface had a list and no way to open a row.

| | |
|---|---|
| **Permission** | `cod.remittances.read` |
| **Transport** | Direct read |

### Response (200)

```jsonc
{
  "success": true,
  "data": {
    "id": "6680aabbccddeeff00112233",
    "agencyId": "665c0011223344556677889a",
    "agency": { "id": "665c0011223344556677889a", "name": "Littoral Express" },
    "amount": 1240000,
    "currency": "XAF",
    "reference": "BICEC/2026/08/13/44127",
    "note": "Weekly settlement",
    "status": "confirmed",
    "declaredAt": "2026-08-13T06:00:00.000Z",
    "declaredByUserId": "665b998877665544332211ff",
    "resolvedAt": "2026-08-13T08:15:00.000Z",
    "resolvedBy": { "id": "665f…", "source": "wi-admin", "name": "Ada Nkemelu" },
    "rejectionReason": null,
    "createdAt": "2026-08-13T06:00:00.000Z",
    "updatedAt": "2026-08-13T08:15:00.000Z",
    "cashMovements": [
      {
        "id": "6681aabbccddeeff00112233",
        "ownerType": "agency",
        "ownerId": "665c0011223344556677889a",
        "entryType": "remittance_confirmed",
        "amount": -1240000,
        "balanceAfter": 0,
        "refType": "agency_remittance",
        "refId": "6680aabbccddeeff00112233",
        "createdAt": "2026-08-13T08:15:00.000Z"
      }
    ]
  }
}
```

| Field | Notes |
|---|---|
| `reference` | The external bank/transfer/receipt id — **evidence, not a credential** |
| `resolvedBy` | **`null` while still `declared`.** A stamp rendered without checking reads as "resolved by nobody", which is a claim rather than an absence |
| `resolvedBy.source` | Which identity space the id belongs to. An `admin` id resolves in **neither** database's user collection — which is why the name is a snapshot |
| **`cashMovements`** | **What confirming it *moved*.** Empty for a `declared` or `rejected` remittance, and that emptiness is the point: a declaration is a claim, and nothing has moved until an administrator confirms it |
| `cashMovements[].amount` | **Signed** — positive raises the liability, negative discharges it |
| `cashMovements[].balanceAfter` | What the balance **became**. The number a remittance row alone cannot tell you |

### Errors

`400 VALIDATION_ERROR`, `404 NOT_FOUND`.

---

## `POST /cod/remittances/:remittanceId/confirm`

Confirm that the cash arrived. **Settles collections FIFO inside the platform's transaction and
unlocks the escrow they back.**

| | |
|---|---|
| **Permission** | `cod.remittances.confirm` — `financial` |
| **Transport** | Delegated |
| **Request body** | None |
| **Response** | The platform's result, message `"Remittance confirmed"` |

### Errors

| Status | Code | When |
|---|---|---|
| 404 | `NOT_FOUND` | No such remittance — checked here, before delegating |
| 409 / 422 | `PLATFORM_OPERATION_REJECTED` | No longer `declared` |
| 502 / 503 | `SERVICE_DEPENDENCY_UNAVAILABLE` | |

### Audit

`cod.remittances.confirm`

---

## `POST /cod/remittances/:remittanceId/reject`

| | |
|---|---|
| **Permission** | `cod.remittances.reject` — `financial` |

### Request body

| Field | Type | Rules |
|---|---|---|
| `reason` | string | **Required.** 3–500 characters |

```json
{ "reason": "Bank reference BICEC/2026/08/13/44127 does not appear on the statement" }
```

### Response (200)

The platform's result, message `"Remittance declaration rejected"`. **Nothing is settled.**

### Audit

`cod.remittances.reject`

---

# Deposits — the agent handing cash back

## `GET /cod/deposits`

| | |
|---|---|
| **Permission** | `cod.deposits.read` |
| **Transport** | **Delegated** |
| **Pagination** | `page`, `limit` |
| **Sorting** | None offered |

### Query parameters

| Parameter | Type | Notes |
|---|---|---|
| `status` | string | |
| `recipient` | string | `agency` (the normal route) or `platform` (skipped the middle leg) |
| `agencyId` | 24-hex | |

---

## `POST /cod/deposits`

Record cash an agent paid the **platform directly**, bypassing the agency.

| | |
|---|---|
| **Permission** | `cod.deposits.create` — `financial`. **The one route here that asserts money arrived**, and it settles both legs of the chain |
| **Transport** | Delegated |
| **Status** | `201` |
| **Body** | **Strict** — every field here is money or the evidence for it. A mistyped `reference` silently dropped would record cash arriving with nothing tying the claim to a bank statement |

### Request body

| Field | Type | Rules |
|---|---|---|
| `agentId` | 24-hex | Required |
| `agencyId` | 24-hex | Required |
| `amount` | integer | Required, positive. **Minor units** |
| `reference` | string | Required, 1–200 characters |
| `note` | string | Optional, ≤ 500 characters |

Whether *this* agent may hand over *this* amount is the platform's answer — it is bounded by the
**contract's** outstanding balance, which this service does not read and must not guess.

```json
{
  "agentId": "6660112233445566778899aa",
  "agencyId": "665c0011223344556677889a",
  "amount": 84500,
  "reference": "AFRILAND/DEP/2026-08-13/8841",
  "note": "Agent walked the cash into the Akwa branch"
}
```

### Response (201)

The platform's result, message
`"Direct deposit recorded — the agent and the agency were both cleared"`.

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Non-integer or non-positive amount, missing reference, unknown field |
| 404 | `NOT_FOUND` | No delivery agent, or no delivery agency, with that id — both are checked here before delegating |
| 409 / 422 | `PLATFORM_OPERATION_REJECTED` | Amount exceeds the contract's outstanding balance, agent not depositable. `details.platformCode` names it |
| 502 / 503 | `SERVICE_DEPENDENCY_UNAVAILABLE` | |

### Audit

`cod.deposits.create`

---

## `GET /cod/deposits/:depositId`

Net-new. **Its cash movements are the two-sided settlement made visible.**

| | |
|---|---|
| **Permission** | `cod.deposits.read` |
| **Transport** | Direct read |

### Response (200)

```jsonc
{
  "success": true,
  "data": {
    "id": "6682aabbccddeeff00112233",
    "agentId": "6660112233445566778899aa",
    "agencyId": "665c0011223344556677889a",
    "agent":  { "id": "6660112233445566778899aa", "name": "Eric T." },
    "agency": { "id": "665c0011223344556677889a", "name": "Littoral Express" },
    "amount": 84500,
    "currency": "XAF",
    "note": "Agent walked the cash into the Akwa branch",
    "recipient": "platform",
    "status": "confirmed",
    "reference": "AFRILAND/DEP/2026-08-13/8841",
    "declaredAt": "2026-08-13T09:00:00.000Z",
    "declaredByUserId": "6660112233445566778899aa",
    "resolvedAt": "2026-08-13T09:20:00.000Z",
    "recordedBy": { "id": "665f…", "source": "wi-admin", "name": "Ada Nkemelu" },
    "rejectionReason": null,
    "recordedAt": "2026-08-13T09:00:00.000Z",
    "createdAt": "2026-08-13T09:00:00.000Z",
    "updatedAt": "2026-08-13T09:20:00.000Z",
    "cashMovements": [
      { "id": "…", "ownerType": "agent",  "ownerId": "6660…", "entryType": "deposit_confirmed",
        "amount": -84500, "balanceAfter": 0, "refType": "agent_deposit", "refId": "6682…",
        "createdAt": "2026-08-13T09:20:00.000Z" },
      { "id": "…", "ownerType": "agency", "ownerId": "665c…", "entryType": "deposit_confirmed",
        "amount": -84500, "balanceAfter": 1155500, "refType": "agent_deposit", "refId": "6682…",
        "createdAt": "2026-08-13T09:20:00.000Z" }
    ]
  }
}
```

> **Two movements for a confirmed `platform` deposit, one for an `agency` one.** That asymmetry
> *is* the cash model: a deposit to the agency lowers the agent's liability alone; a deposit that
> skipped the agency settles **both** legs, because the cash physically bypassed the middle one.
> Reading two `balanceAfter` values on one deposit is how an operator sees that without being
> told.

| Field | Notes |
|---|---|
| `recordedBy.source` | **The stamp that carries both an agency user and an administrator.** The same methods are reached by the agency desk and by the platform, and `source` is the only way to tell the ids apart |
| `recordedAt` | The platform's name for this record's creation time. Kept alongside `createdAt` |

---

## `POST /cod/deposits/:depositId/confirm`

| | |
|---|---|
| **Permission** | `cod.deposits.confirm` — `financial` |
| **Request body** | None |
| **Response** | The platform's result, message `"Deposit confirmed — the agent and the agency were both cleared"` |

### Audit

`cod.deposits.confirm`

---

## `POST /cod/deposits/:depositId/reject`

| | |
|---|---|
| **Permission** | `cod.deposits.reject` — `financial` |

### Request body

| Field | Type | Rules |
|---|---|---|
| `reason` | string | **Required.** 3–500 characters |

### Response (200)

The platform's result, message
`"Deposit declaration rejected — nothing was settled"`.

### Audit

`cod.deposits.reject`

---

# Discrepancies — a flagged break in the chain

## `GET /cod/discrepancies`

| | |
|---|---|
| **Permission** | `cod.discrepancies.read` |
| **Transport** | Direct read |
| **Pagination** | `page`, `limit` |
| **Sorting** | `createdAt`, `openedAt`, `resolvedAt`. Default **`-createdAt`** |

### Query parameters

| Parameter | Type | Notes |
|---|---|---|
| `status` | string, 1–40 | The platform's vocabulary; not pinned |
| `type` | string, 1–40 | Also the platform's, and it has already grown once (`deposit_not_confirmed` arrived with the two-sided deposit flow) |
| `agencyId` | 24-hex | |
| `agentId` | 24-hex | |
| `from` / `to` | ISO-8601 instant | **Max span 366 days** |

### Response (200)

```jsonc
{
  "success": true,
  "data": [
    {
      "id": "6683aabbccddeeff00112233",
      "agentId": "6660112233445566778899aa",
      "agencyId": "665c0011223344556677889a",
      "agent":  { "id": "6660…", "name": "Eric T." },
      "agency": { "id": "665c…", "name": "Littoral Express" },
      "type": "late_deposit",
      "amount": 84500,
      "currency": "XAF",
      "status": "open",
      "raisedBy": "system",
      "raisedByUserId": null,
      "depositId": null,
      "note": "Cash held 6 days past the remittance window",
      "resolutionNote": null,
      "resolvedBy": null,
      "openedAt": "2026-08-11T00:05:00.000Z",
      "resolvedAt": null,
      "createdAt": "2026-08-11T00:05:00.000Z",
      "updatedAt": "2026-08-11T00:05:00.000Z"
    }
  ],
  "meta": { "total": 14, "page": 1, "limit": 20, "pages": 1 }
}
```

| Field | Notes |
|---|---|
| `amount` | **`null` for a non-monetary flag — not zero**, which would mean "nothing at stake" |
| `raisedBy` | `system` \| `agency` \| `admin` \| `agent`. **The last is how an agent disputes** |
| `depositId` | The deposit at issue, for `deposit_not_confirmed` and agent disputes |
| `resolvedBy` | The **actor stamp** of whoever closed it — `{ id, source, name }`, the same shape `RemittanceDto.resolvedBy` uses. `null` while `open` |

> ⚠ **`resolvedBy` replaced `resolvedByUserId` on 2026-08-20** (Phase 4 step 22, J7). It was a
> bare id string — and resolving a discrepancy is an **admin-only** act, so since the admin split
> that id has been a wi-admin one, resolving in neither database, rendered next to a remittance on
> the same screen that shows a name. `source: 'admin'` now says so and `name` carries the snapshot.
>
> **Clients:** read `resolvedBy?.id` where you read `resolvedByUserId`, and render `name` when
> `source === 'admin'` — that id resolves nowhere, so linking it goes to a dead page.

---

## `GET /cod/discrepancies/:discrepancyId`

The flag, plus the deposit it names and the trust penalty it caused.

| | |
|---|---|
| **Permission** | `cod.discrepancies.read` |
| **Transport** | Direct read |

### Response (200)

Every list field, plus:

| Field | Type | Notes |
|---|---|---|
| `deposit` | object \| null | The deposit this flag is about, resolved. `null` when it names none |
| `trustEvents` | array | The trust movements this flag caused |

> **`trustEvents` is often empty, and that is the system working.**
> `deposit_not_confirmed` is the **agency's** failure and deliberately carries no agent penalty;
> `late_deposit` costs the agent **once**, no matter how many agencies are owed.

---

## `POST /cod/discrepancies/:discrepancyId/resolve`

Close a discrepancy.

| | |
|---|---|
| **Permission** | `cod.discrepancies.resolve` — `financial` |
| **Transport** | Delegated |

### Request body

| Field | Type | Rules |
|---|---|---|
| `resolution` | `resolved` \| `written_off` | **Required.** Pinned — this service *sends* this value |
| `note` | string | **Required**, 1–500 characters, in **both** directions |

Two outcomes, and they mean very different things to whoever absorbs the shortfall:

| Value | Means |
|---|---|
| `resolved` | Recovered, or explained |
| `written_off` | **The platform took the loss** |

The note is required either way. Unlike a deactivation, neither outcome is the "undo" of the
other — writing money off is a decision in its own right.

```json
{ "resolution": "written_off", "note": "Agent left the platform; XAF 84,500 unrecoverable" }
```

### Response (200)

The platform's result, message `"Discrepancy written_off"` (or `"Discrepancy resolved"`).

### Audit

`cod.discrepancies.resolve`

---

# Trust — why an agent's COD ceiling moved

## `GET /cod/agents/:agentId/trust-events`

An agent's conduct record: every penalty they have taken, and why.

| | |
|---|---|
| **Permission** | `cod.holders.read` **+** `agents.read` — the rows are a named agent's conduct record, so gating on the cash permission alone would be a second door onto their history |
| **Transport** | Direct read |
| **Pagination** | `page`, `limit` |
| **Sorting** | `createdAt` only. Default **`-createdAt`** |

There is **no cross-agent trust feed** — a platform-wide list of score movements is a report,
not a screen.

### Query parameters

| Parameter | Type | Notes |
|---|---|---|
| `eventType` | string, 1–40 | |
| `from` / `to` | ISO-8601 instant | Max span 366 days |

### Response (200)

```jsonc
{
  "success": true,
  "data": [
    {
      "id": "6684aabbccddeeff00112233",
      "agentId": "6660112233445566778899aa",
      "agencyId": "665c0011223344556677889a",
      "eventType": "late_deposit_penalty",
      "delta": -8,
      "scoreAfter": 87,
      "refType": "cod_discrepancy",
      "refId": "6683aabbccddeeff00112233",
      "note": null,
      "createdAt": "2026-08-11T00:05:00.000Z"
    }
  ],
  "meta": { "total": 6, "page": 1, "limit": 20, "pages": 1 }
}
```

| Field | Notes |
|---|---|
| `agencyId` | **`null` for a platform-wide adjustment** that names no agency |
| `delta` | **Signed.** Negative is a penalty |
| `scoreAfter` | The score immediately after — **the audit snapshot, not a recomputation** |
| `refType` / `refId` | The record that explains the movement. `null` on a manual adjustment |

---

## `POST /cod/agents/:agentId/trust-adjustment`

Move an agent's trust score by hand.

| | |
|---|---|
| **Permission** | **`cod.trust.adjust` alone** — `financial` |
| **Transport** | Delegated |

The asymmetry with the read above is deliberate: reading the history exposes the agent's conduct
record, which is agent data. Moving the score does not read it — it sends a delta and a note, and
the platform computes what the score becomes.

### Request body

| Field | Type | Rules |
|---|---|---|
| `delta` | integer | **Required.** `-100` … `100`. The score itself is `0…100`, so one adjustment can span the whole range either way and no more |
| `note` | string | **Required**, 1–500 characters |

The resulting score is **clamped by the platform**, not here. The note is required because this
is the one trust movement no rule produced — every other row is explained by the discrepancy it
references; this one is explained only by the person who made it.

```json
{ "delta": 15, "note": "Discrepancy DSC-2026-441 was our error — restoring the penalty" }
```

### Response (200)

The platform's result, message `"Trust score adjusted"`.

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Delta out of range or non-integer, missing note |
| 404 | `NOT_FOUND` | No such agent |
| 502 / 503 | `SERVICE_DEPENDENCY_UNAVAILABLE` | |

### Audit

`cod.trust.adjust`
