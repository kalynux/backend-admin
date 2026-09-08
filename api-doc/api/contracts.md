# `/contracts` — one agent↔agency contract

**Verified against source on 2026-09-08** — the four routes and their guards against the live route manifest, and every `details.platformCode` value against jovi-mall's `src/core/error-codes.ts` (`CONTRACT_REQUEST_ALREADY_PENDING` was named here and does not exist; the real code is `CONTRACT_STATUS_REQUEST_ALREADY_PENDING`).

Four routes: the full terms of one contract, and the three administrative interventions
that may be performed on it.

Added in the dashboard-request round (BR-004).

---

## Why a mount of its own

A contract belongs to both an agent and an agency, and to neither. Hanging it off either
directory would make the url claim a primary party that does not exist, and would force a
caller holding only a contract id — which is what a support ticket carries — to look up an
agent first.

The same rows are still readable from both ends, decorated with the party the reader does
not already know: `GET /agencies/:agencyId/agents` (the roster) and
`GET /agents/:agentId/contracts`. This mount is the third view, and the only addressable
one.

---

## `GET /api/v1/contracts/:contractId`

| | |
|---|---|
| **Permission** | `agencies.read` **+** `agents.read`, in `all` mode |
| **Transport** | Direct read |
| **Audited** | No |

Both permissions, matching the roster: this payload names a party from each directory, so
holding one is not enough to see it.

### Response `200`

Every field of `ContractCore` — the same shape both list endpoints return — plus **both**
decorations.

```jsonc
{
  "id": "665d…", "agentId": "665a…", "agencyId": "665c…",
  "status": "active",
  "origin": "join_request",
  "isPrimary": true,

  "cod":     { "threshold": 150000, "outstandingBalance": 42000, "lastSettledAt": "2026-08-14T…" },
  "payment": { "outstandingToAgent": 18500, "lastPaidAt": "2026-08-10T…" },

  "terms": {
    "employment":  { "type": "contractor", "employeeRef": "AG-114", "startedAt": "…", "endsAt": null },
    "remittance":  { "cadence": "weekly", "dayOfWeek": 1, "dayOfMonth": null, "graceHours": 24 },
    "feeSplit":    { "model": "percentage", "agentSharePercent": 70, "agentFlatFee": null, "currency": "XAF" },
    "coverageRegions": [],
    "shipmentValueCeiling": 500000,
    "proposedBy": "agency",
    "version": 3
  },

  "lifecycle": {
    "approvedAt": "…", "suspendedAt": null, "suspensionReason": null,
    "deactivatedAt": null, "deactivationReason": null,
    "withdrawnAt": null, "withdrawalReason": null
  },

  "agent":  { "id": "665a…", "name": "…", "status": "active", "kycStatus": "verified",
              "availability": "online", "banned": false },
  "agency": { "id": "665c…", "businessName": "Littoral Express Delivery",
              "status": "active", "contactName": "Nadège M.", "country": "CM" },

  "createdAt": "…", "updatedAt": "…"
}
```

### Field notes that are load-bearing

| Field | Note |
|---|---|
| `terms.employment` · `.remittance` · `.feeSplit` | **camelCase since the dashboard-request round.** These three used to ship jovi-mall's raw sub-documents (`employment_type`, `day_of_week`, `agent_share_percent`). Every field is named now, and documented below |
| `terms.coverageRegions: []` | **No restriction, not "covers nowhere".** jovi-mall's coverage rule fails open, and it must: an empty array is the schema default on every contract ever written, so the strict reading would make the whole roster undispatchable at once. Render this as **"all regions"** |
| `terms.proposedBy` | **This — not `origin` — decides whose turn it is to answer on a pending contract.** The two disagree the moment anybody counters. `null` means nobody has stated terms, so the contract is **not approvable by anyone** |
| `terms.feeSplit.currency` | **The only money block here carrying one.** `cod` and `payment` do not, so a client rendering those has no symbol to print from the contract alone |
| `terms.remittance.dayOfWeek` | **`0` is Sunday.** Meaningful only on a `weekly` cadence; `null` otherwise |
| `terms.remittance.dayOfMonth` | 1–28 only, so February cannot skip a remittance |
| `agency.businessName` | The Magazin's name. **`null` where it has none** — an agency mid-onboarding legitimately has none and must still be identifiable by its id |
| `agency.contactName` | **A PERSON**, the agency's contact individual — not the business. Never substitute one for the other |
| `agent` / `agency` | **`null` when the joined row is missing.** A contract pointing at an agent that does not exist is a broken state, and precisely the one an administrator opens this screen to find, so the join preserves the row |

#### `terms.employment`

| Field | Type | Meaning |
|---|---|---|
| `type` | string | `employee` · `contractor` · `freelancer`. jovi-mall's vocabulary, not pinned |
| `employeeRef` | string \| null | The agency's own staff reference. Free text |
| `startedAt` | ISO \| null | |
| `endsAt` | ISO \| null | `null` on an open-ended engagement, which is most of them |

Excluded from the negotiation cycle upstream — it has its own route and the agency sets it
unilaterally.

#### `terms.remittance`

| Field | Type | Meaning |
|---|---|---|
| `cadence` | string | `per_delivery` · `daily` · `weekly` · `biweekly` · `monthly` · `on_demand` |
| `dayOfWeek` | number \| null | **0 = Sunday.** `weekly` only |
| `dayOfMonth` | number \| null | 1–28. `monthly` only |
| `graceHours` | number \| null | How long after the due moment before the agent is late |

#### `terms.feeSplit`

| Field | Type | Meaning |
|---|---|---|
| `model` | string | `percentage` · `flat`. Decides which amount below is meaningful |
| `agentSharePercent` | number \| null | |
| `agentFlatFee` | number \| null | |
| `currency` | string \| null | |

---

## The three writes

All three are **delegated**, all three require a `reason` of 3–500 characters, all three are
audited under their own action name, and all three hold `agents.contracts.manage` — Admin
and Developer, never Support.

### What they do NOT do

They **freeze or end a relationship**. They invent, alter and approve nothing.

`agents.md` refuses contract writes on the grounds that *"a live contract's terms change by
proposal between the two parties, never by edit"*. That reasoning is right and is untouched:

| Refused | Why |
|---|---|
| **Approve a pending contract** | `proposedBy: null` contracts exist precisely because nobody has stated terms. Approving one binds an agent to a default that pays zero |
| **Edit terms / counter-offer** | The contract is pricing deliveries right now against its agreed `feeSplit`. Rewriting it under the agent is what the negotiation exists to prevent |
| **Adjust `cod.threshold`** | A third reason, not the same one: this is the contract's slice of a pool bounded across every allocating contract, `0` **blocks all COD** rather than meaning "no limit", and the arithmetic is `AgentCodThresholdService`'s. It has its own endpoint, its own permission and its own `financial` flag |

What was *not* argued anywhere is the case these three serve: an agency abusing an agent, or
an agent under investigation, is a situation an administrator should be able to stop without
transferring anybody — the same lever `agencies.deactivate` already provides one level up.

### `POST /api/v1/contracts/:contractId/suspend`

Body `{ reason }`. Stops new assignments. Terms and balances untouched.

Runs jovi-mall's own agency-scoped `suspend`, where the transition is unilateral for the
agency — so it clears immediately rather than waiting on the agent, which is the point.
Deliberately **not** gated on outstanding COD: an agency suspending an agent over a cash
shortfall is exactly the situation a COD gate would block.

Legal from `active` and `paused`.

### `POST /api/v1/contracts/:contractId/reinstate`

Body `{ reason }`. Back to `active` from `paused` or `suspended`.

The reason is required here and stored by neither service — jovi-mall has no column for a
reinstatement reason. It lives in the audit row, which is where the durable record of an
administrator's intervention belongs anyway.

### `POST /api/v1/contracts/:contractId/terminate`

Body `{ reason }`.

> ### ⚠️ A `200` here does not mean the contract ended
>
> Deactivation requires the counterparty's agreement **and** the §4 cash conditions: the
> agent's outstanding COD settled, and what the agency owes them paid. When those are not
> met the contract does not move.
>
> ```jsonc
> { "success": true,
>   "data": {
>     "contract": null,
>     "pendingRequest": { "id": "665e…" },
>     "blockers": { "outstandingCod": 42000, "outstandingPayment": 18500, "clear": false }
>   },
>   "message": "Termination requested — it completes once the counterparty agrees and the outstanding balances are clear" }
> ```
>
> **Branch on `data.contract`, never on the status.** `null` means requested; an object
> means done.
>
> **There is no override, and there will not be one.** Ending a relationship that still owes
> an agent money is how that money stops being anybody's responsibility — and an
> administrator is exactly the party who could do it without either side noticing.

Legal from `pending`, `active`, `paused` and `suspended`.

### Errors, all three

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Missing or short `reason`; an unknown key in the body (the schema is strict, so an attempt to send `terms` is a 400 rather than a silent no-op) |
| 404 | `CONTRACT_NOT_FOUND` | No such contract |
| 403 | `AUTHZ_PERMISSION_DENIED` | |
| 409 | `PLATFORM_OPERATION_REJECTED` | jovi-mall refused. `details.platformCode` is `CONTRACT_INVALID_TRANSITION` (wrong `from` status), `CONTRACT_TRANSITION_NOT_PERMITTED`, or `CONTRACT_STATUS_REQUEST_ALREADY_PENDING` |

### Audit

| Action | Sensitive | Records |
|---|---|---|
| `agents.contracts.suspend` | — | `status`, `suspensionReason` before and after |
| `agents.contracts.reinstate` | — | as above |
| `agents.contracts.terminate` | — | as above, plus `terminationBlockers` and `completed` — the honest record of a verb that did not complete |

Three names for one permission, because suspending and reinstating are opposite acts and a
single label makes the trail unreadable.

The audit **target is the agent**, not the contract: the target vocabulary has no `contract`
member, and the agent is the party whose livelihood these verbs touch — the record a
reviewer will search by. The contract id is in the payload.
