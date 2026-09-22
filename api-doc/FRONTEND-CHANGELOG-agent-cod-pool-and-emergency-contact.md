# Admin dashboard — agent emergency contact, and the COD pool that now comes from the plan

> **Date:** 2026-09-21 · **Audience:** the admin dashboard · **Breaking:** ⚠ **one** request body
> (`PUT /api/v1/agents/:agentId/cod-threshold` now requires `reason`)
>
> The rule behind it, across every app:
> [jovi-mall/api-doc/FRONTEND-CHANGELOG-cod-pool.md](../../jovi-mall/api-doc/FRONTEND-CHANGELOG-cod-pool.md)

| # | Change | Kind |
|---|---|---|
| 1 | The agent detail shows the **emergency contact** | additive |
| 2 | The COD pool is **automatic** (plan × KYC). The detail and the allocation read explain where it came from | additive |
| 3 | ⚠ **`PUT …/cod-threshold` pins** the pool and **requires `reason`** | **breaking** |
| 4 | New **`POST …/cod-threshold/release`** | additive |
| 5 | Plans gain **`limits.maxCodPool`**; account entitlements gain `maxCodPool` | additive |
| 6 | KYC review answers with the resulting pool; assignability reports `poolBinds` | additive |
| 7 | New worker **`agent-cod-pool-reconcile`**: press it once after deploy | ops |

---

## 1 · Emergency contact on the agent detail

`GET /api/v1/agents/:agentId` has a new top-level field:

```json
"emergencyContact": { "name": "Ada Mbarga", "phone": "+237670000002" }
```

- `null` when the agent has not given one. Never `{ name: null, phone: null }`.
- `phone` is E.164, as the agent entered it in the agent app. **Render it as a contact card with a
  click-to-call (`tel:`)**. There is no admin write; the agent owns this data.
- **Detail only.** It is **not** on `GET /api/v1/agents` rows and never will be (pinned by a test).
  Don't add a list column for it.
- Permission `agents.read`, so **Support sees it**. That is intended: Support takes the call.

Why it was missing: it had been withheld on purpose as a third party's personal data (ADR-009 D-8).
The owner reversed that on 2026-09-21. See
[ADR-009 § Amendment 2026-09-21](../docs/ADR-009-DELIVERY-NETWORK.md).

---

## 2 · The COD pool is automatic now

An agent's COD pool (`cod.maxThreshold`) is the most cash-on-delivery money they may carry across
every agency. **Nobody types it in any more.** jovi-mall derives it:

| `source` | Ceiling | When |
|---|---|---|
| `not_verified` | **0** | KYC not `verified`. Always wins, even over a pin |
| `override` | the pin | An administrator pinned a value (§ 3), above or below the plan |
| `plan` | the plan's `maxCodPool` | Otherwise. **Free 500 000 · Plus 1 000 000 · Pro 2 000 000** |

The agent can choose to carry **less** than the ceiling from the agent app. A change of ceiling (new
plan, verdict, pin) resets their choice.

### `GET /api/v1/agents/:agentId`: `cod` gains two blocks

```json
"cod": {
  "trustScore": 87, "computedTrustScore": 87, "trustSource": "computed", "trustOverride": null,
  "maxThreshold": 500000,
  "pool": {
    "ceiling": 500000,
    "source": "plan",
    "planCode": "agent_free",
    "selfLimited": false,
    "syncedAt": "2026-09-21T09:30:00.000Z"
  },
  "poolOverride": null
}
```

| Field | Show it as |
|---|---|
| `maxThreshold` | "COD pool: 500 000 XAF". This is what every gate uses |
| `pool.source` + `pool.planCode` | "from Agent Free plan" · "pinned by an administrator" · "0: identity not verified". **Display only, never branch on it** |
| `pool.selfLimited` | "The agent chose to carry less than their 500 000 limit" |
| `pool.syncedAt: null` | "Not yet synced": an agent from before this change still showing the old number (see § 7) |
| `poolOverride` | `{ amount, reason, setAt, setByName, setBySource }` or `null`. Show who pinned it, when and why, and offer **Release** (§ 4) |

### `GET /api/v1/agents/:agentId/cod-allocation`: three new fields

```json
{
  "agentId": "…",
  "maxThreshold": 500000,
  "allocated": 350000,
  "headroom": 150000,
  "overAllocatedBy": 0,
  "pool": { "ceiling": 500000, "source": "plan", "planCode": "agent_free", "selfLimited": false, "syncedAt": "…" },
  "override": null,
  "contracts": [ … unchanged … ]
}
```

- `overAllocatedBy > 0` means the contracts hold **more** than the pool. Only an automatic change
  causes it (plan downgrade, KYC withdrawn). Show it as a warning. It explains a `headroom` of 0 that
  otherwise looks like a bug. While it lasts, no agency can raise a slice, and jovi-mall caps every
  dispatch at the pool.
- `pool` / `override`: same meaning as on the detail.

---

## 3 · ⚠ BREAKING: `PUT /api/v1/agents/:agentId/cod-threshold` pins, and needs a `reason`

```http
PUT /api/v1/agents/:agentId/cod-threshold
{ "maxThreshold": 750000, "reason": "Trusted long-standing agent; approved by ops lead" }
```

| Field | Before | Now |
|---|---|---|
| `maxThreshold` | number ≥ 0 | **integer** ≥ 0 |
| `reason` | none | **required**, 3–500 chars |
| meaning | *set* the pool | **pin** it: replaces the plan's value until released |

A request without `reason` now answers **`400 VALIDATION_ERROR`**. Add a required reason field to the
dialog, and relabel the action from "Set COD pool" to **"Pin COD pool"** (it overrides the plan).

- Permission unchanged: `agents.cod_threshold.set` (`financial`, never Support).
- Response unchanged in shape (a `CodAllocation`), now with `pool` and `override`, and `message`
  `"COD pool pinned"`.
- On an **unverified** agent the pin is stored but the pool stays 0. Say so in the confirmation
  ("will apply once their identity is verified").
- Errors, all as `PLATFORM_OPERATION_REJECTED` with `details.platformCode`:
  - `422 AGENT_COD_THRESHOLD_BELOW_ALLOCATED`: the pool would fall below what contracts hold.
    jovi-mall's details list the contracts. Show them.
  - `422 AGENT_COD_THRESHOLD_OUT_OF_BOUNDS`: outside 0–5 000 000.
  - `409 AGENT_COD_POOL_CONFLICT`: the pool changed at that instant. Re-read and retry.

## 4 · New: `POST /api/v1/agents/:agentId/cod-threshold/release`

```http
POST /api/v1/agents/:agentId/cod-threshold/release
{ "reason": "Review closed; back to the plan value" }
```

- Back to the plan's value (or 0 while unverified). Same permission as the pin.
- Own audit action **`agents.cod_threshold.release`** (the pin stays `agents.cod_threshold.set`).
  The agent activity feed accepts `?action=agents.cod_threshold.release`.
- ⚠ Refused with `AGENT_COD_THRESHOLD_BELOW_ALLOCATED` when the plan's value is below what
  contracts already hold. The pin was holding the pool up. Say so in the error: lower the contract
  slices first, or pin a smaller value instead.
- Show the button only when `poolOverride` is not `null`.

---

## 5 · Plans and account entitlements

**Plans** (`GET/POST/PATCH /api/v1/billing/plans…`): `limits.maxCodPool` on every plan, and
`maxCodPool` in the create/update body.

- Agent plans only. `null` on vendor and agency plans.
- ⚠ **On an agent plan, `null` means NO COD**, not unlimited. Every other limit in that block uses
  `null` for "unlimited". Render it as "0: no cash on delivery", and don't share one formatter.
- Editing `maxCodPool` on an existing agent plan **re-syncs every agent immediately**. Tell the
  editor: "Agents on this plan will get the new COD pool now."

**Accounts** (`GET /api/v1/accounts/agent/:id`): `entitlements.maxCodPool`, the **plan's** number.
The agent's actual pool (after KYC, a pin, or their own choice) is `cod.maxThreshold` on the agent
detail. Don't present the two as the same thing.

---

## 6 · Two passthroughs that now carry more

- **`PUT /api/v1/agents/:agentId/kyc`** answers with a `codPool` block beside `kyc`. A `verified`
  verdict opens the pool from the plan; any other verdict closes it to 0. Show the result in the
  success toast, for example "Verified: COD pool now 500 000 XAF".
- **`GET /api/v1/agents/:agentId/assignability`**: the `cod_exposure` gate's `observed.limit` gains
  `agentPool` and `poolBinds`. When `poolBinds` is `true`, the agent's own pool, not the agency's
  slice, set the limit. Say "limited by the agent's COD pool" rather than blaming the contract.

## 7 · Operations: run the reconcile once after deploy

Agents that existed before this change have `pool.syncedAt: null` and keep their **old** pool until
the first sync. The nightly worker **`agent-cod-pool-reconcile`** (04:30) converges them. It is
listed in the dev-tools workers screen and is **triggerable**, so run it once right after the
deploy.

⚠ That first sync **replaces** any pool an administrator had set by hand under the old model with
the plan's value: there was no way to tell a deliberate number from a default one. Re-apply such a
value as a **pin** (§ 3) if it mattered.

---

## Checklist

- [ ] Agent detail: emergency-contact card with click-to-call (detail only)
- [ ] Agent detail + allocation: show `pool` (source label, plan, self-limited, not-yet-synced) and `poolOverride`
- [ ] Allocation: warn when `overAllocatedBy > 0`
- [ ] ⚠ Pin dialog: required `reason`, integer amount, relabel as "Pin", note for unverified agents
- [ ] Release action (only when a pin exists), with required `reason`
- [ ] Error copy for `AGENT_COD_THRESHOLD_BELOW_ALLOCATED` (list contracts) and `AGENT_COD_POOL_CONFLICT` (retry)
- [ ] Plan editor: `maxCodPool` (agent plans), `null` = "no COD"; note that edits apply to agents immediately
- [ ] Account entitlements: show `maxCodPool` as the plan's value
- [ ] KYC review toast shows the resulting `codPool`
- [ ] Assignability: explain `poolBinds: true`
- [ ] Activity feed: add `agents.cod_threshold.release` to the action filter labels
