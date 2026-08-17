# BR-004 · Reading and administering one agent↔agency contract

**Priority: medium. This is a policy question first and an endpoint request second.** The contract
currently refuses most of what is being asked for, on stated grounds. Please decide, rather than
build.

## The ask

> From the Roster tab under the agency directory, we should be able to open their contract terms and
> perform administrative actions on those.

## What exists today

### The read: everything is already on the wire, and none of it was being shown

`GET /agencies/:agencyId/agents` (the roster) and `GET /agents/:agentId/contracts` return **the same
rows through the same mapper**, decorated with `agent` on one side and `agency` on the other. Both
already carry:

```jsonc
"terms": {
  "employment":  { "employment_type", "employee_ref", "started_at", "ends_at" },
  "remittance":  { "cadence", "day_of_week", "day_of_month", "grace_hours" },
  "feeSplit":    { "model", "agent_share_percent", "agent_flat_fee", "currency" },
  "coverageRegions": [], "shipmentValueCeiling": 500000,
  "proposedBy": "agency", "version": 3
},
"lifecycle": {
  "approvedAt", "suspendedAt", "suspensionReason",
  "deactivatedAt", "deactivationReason", "withdrawnAt", "withdrawalReason"
},
"cod": { "threshold", "outstandingBalance", "lastSettledAt" },
"payment": { "outstandingToAgent", "lastPaidAt" }
```

So the read half of the ask needs **no backend change** — the dashboard was fetching all of this and
rendering only `coverageRegions`. That is now fixed on our side.

Two documentation problems remain, though, and they are real:

1. **[`agencies.md`](../../admin/api/agencies.md) writes three of these sub-objects as `{ "…": "…" }`.**
   `terms.employment`, `terms.remittance` and `terms.feeSplit` have **no documented field names at
   all**. The dashboard typed them by reading jovi-mall's
   `agent-agency-membership.model.ts`. That is not a contract; it is archaeology.
2. **Those same three ship `snake_case`**, against README's *"wire fields are camelCase … the
   translation happens in wi-admin and never leaks."* `contract.dto.ts:88-90` assigns
   `contract.employment`, `contract.remittance_terms` and `contract.fee_split` **whole**, so the
   storage casing reaches the browser. The dashboard types them as they actually ship, deliberately —
   an aspirational camelCase type would render `undefined` and nobody would notice. Already on
   [`DATA-EXPOSURE-REGISTER.md`](../DATA-EXPOSURE-REGISTER.md).

### The writes: one exists, the rest are refused

**`POST /api/v1/agents/transfer`** — `agents.transfer`, delegated, body
`{ agentId, fromAgencyId, toAgencyId, reason }`. That is the entire administrative surface on a
membership.

There is no `PATCH` or `POST` on any contract path. [`agents.md`](../../admin/api/agents.md) says why:

> **Editing contract terms** — *"A live contract's terms change by proposal between the two parties,
> never by edit — an administrator imposing a fee split neither party proposed would bind an agent to
> a number nobody agreed. `transfer` moves a relationship rather than rewriting one."*

That reasoning is sound and this request does not dispute it. It disputes the *scope*: "do not let an
administrator invent terms" and "do not let an administrator end an abusive relationship" are
different claims, and only the first is argued.

## What the dashboard does in the meantime

- Every field above renders, from both ends, in a panel opened per row — no new route, because
  there is no `GET` for one contract to deep-link to.
- `transfer` is offered from the roster as well as from the agent.
- Approve / pause / suspend / deactivate / edit-terms render as **withheld affordances with the
  reason attached**, not as disabled buttons. A disabled button reads as *"you lack a permission"*,
  which would be the wrong diagnosis.
- Four traps the panel is written around, all stated by the contract and all silent failures:
  `coverageRegions: []` means **no restriction**; `proposedBy` (not `origin`) decides whose turn it
  is, and `null` means the contract is **not approvable by anyone**; `feeSplit` is the only contract
  money block carrying a `currency`, so `cod` and `payment` are printed without a symbol;
  `remittance.day_of_week` is `0 = Sunday`.

## The proposed contract

### 1. `GET /api/v1/contracts/:contractId` — a read, first and separately

Permission `agencies.read` **+** `agents.read`, matching the roster. Returns the same `ContractCore`
plus **both** decorations (`agent` and `agency`), so one route serves both directions.

This is worth having on its own merits, regardless of the writes: it makes a contract
**addressable**. Today an operator cannot send a colleague a link to one, and a support ticket
referencing a contract id has nowhere to point.

Include the contract's own history inline or by reference — `GET /agencies/:id/contract-history`
already exists but is agency-scoped and is not audit data.

### 2. Document and fix the three sub-objects

Name every field of `terms.employment`, `terms.remittance` and `terms.feeSplit` in `agencies.md` and
`agents.md`, and map them to `camelCase` in `contract.dto.ts`. **When you do, tell us** — our types
are pinned to the current `snake_case` shape and will break loudly, which is the correct failure mode
but only if it is expected.

### 3. The decision to take on writes

Not a request for endpoints — a request for a recorded position on each:

| Action | Our reading |
|---|---|
| **Suspend / reinstate a contract** | The strongest case. An agency abusing an agent, or an agent under investigation, is a situation an administrator should be able to freeze without transferring anybody. It does not invent terms; it pauses a relationship, exactly as `agencies.deactivate` already does one level up |
| **Deactivate / terminate** | Same argument, terminal. Note the platform never hard-deletes anything with an audit trail, so this is a status flip |
| **Approve a pending contract** | **We recommend refusing.** `proposedBy: null` contracts exist precisely because nobody has stated terms, and approving them would bind an agent to a default that pays zero. This is the case `agents.md` argues, and it is right |
| **Edit terms / counter-offer** | **We recommend refusing**, same reasoning |
| **Adjust the COD slice** | Genuinely ambiguous. `cod.threshold` is this contract's slice of the agent's global pool, `0` **blocks all COD** rather than meaning "no limit", and the sum across allocating contracts may never exceed `agent.cod.maxThreshold`. An admin write here has real operational value and real blast radius. If it ships, jovi-mall must own the arithmetic and refuse — wi-admin must not pre-check it |

Anything that does ship is **delegated**, carries `PLATFORM_OPERATION_REJECTED` with
`details.platformCode`, requires a `reason` of 3–500 characters, and needs a catalogued audit action.
Consider whether suspending a contract that holds an outstanding COD balance should be dual-controlled
— the balance reconciles against a relationship that is no longer live.

## Acceptance

- [ ] `GET /contracts/:contractId` exists, gated on both read permissions, carrying both decorations.
- [ ] `terms.employment`, `terms.remittance`, `terms.feeSplit` are documented field by field.
- [ ] Their casing is either fixed to `camelCase` **and announced**, or the exception is recorded in
      the contract as deliberate.
- [ ] A written position exists on each of the six actions above, in `agents.md`'s *does not offer*
      table or as endpoints.
- [ ] Any new write is delegated, reasoned, audited and catalogued.
