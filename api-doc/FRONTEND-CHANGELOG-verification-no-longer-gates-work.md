# Verification no longer gates work or withdrawals — admin dashboard

> **Date:** 2026-09-27 · **Breaking:** no. No route, permission or response shape changed. What an
> agent's KYC verdict *means* changed, one remedy action is new, and one jovi-mall error code is
> gone. The platform-side record is
> `jovi-mall/api-doc/FRONTEND-CHANGELOG-verification-no-longer-gates-work.md`.

**The owner decision.** Identity verification is a **trust badge, not a licence to work**, and
*"we should not block someone's money just because he is not verified."*

- An **unverified agent** may contract with agencies, appear in the agency directory and take
  **prepaid** shipments. Only **cash on delivery** needs a verified agent (and a verified agency).
- An **unverified vendor, agency or agent** withdraws their whole balance. The optional payout
  allowance for unverified owners is **deleted**.

---

## 1. Agent KYC review — `PUT /api/v1/agents/:agentId/kyc`

Unchanged request and response. **The meaning of the verdict changed:** `verified` now unlocks
**cash-on-delivery work**, not work. Moving an agent off `verified` stops their COD dispatch only;
prepaid work continues.

- [ ] Relabel the action / help text: *"Verify identity — allows cash-on-delivery orders."*
- [ ] Remove any confirmation saying the agent "cannot be dispatched" / "cannot work" until verified.

## 2. Eligibility — `GET /api/v1/agents/:agentId/eligibility`

The `kyc` rule and the reason `kyc_not_verified` are **gone**. Reasons are now:
`agent_not_found` · `platform_banned` · `agent_not_active` · `membership_not_approved` ·
`not_available` · `tracking_not_allowed` · `device_location_disabled` · `device_location_unknown` ·
`at_capacity`.

- [ ] Delete the row / copy for `kyc_not_verified`.

## 3. Assignability — `GET /api/v1/agents/:agentId/assignability`

- The **platform** family no longer contains a KYC gate.
- For an unverified agent on a **COD** shipment, the **contract** gate `cod_exposure` fails with
  `reason: "AGENT_KYC_NOT_VERIFIED"` and `observed.blocker: "kyc_not_verified"`. The raw verdict
  (`contractPolicy.codVerdict`) carries `kycStatus`.
- **New remedy action `verify_agent_kyc`**, `params: { kycStatus }` — the only remedy for that
  blocker. Nothing an agency can do fixes it.

- [ ] Render `verify_agent_kyc` as a link to the agent's KYC review (§ 1), labelled e.g.
  *"Verify this agent's identity (currently: {kycStatus})"*. Keep the generic fallback for
  unknown actions.

See `api-doc/api/agents.md` § assignability.

## 4. COD pool — dormant slices

An unverified agent's contracts may now carry a COD threshold (their pool stays `0`). On
verification the pool opens to the plan value; if the slices add up to more, `/cod-allocation`
shows `overAllocatedBy > 0` — the same display you already have for a plan downgrade.

- [ ] Nothing to build. Optionally, when `pool.source === "not_verified"`, label contract
  thresholds *"dormant until verified"*.

## 5. Transfer and reassign

- `POST /api/v1/agents/transfer` no longer refuses an unverified agent.
- `POST /api/v1/shipments/:shipmentId/reassign` to an unverified agent on a **COD** shipment
  answers `PLATFORM_OPERATION_REJECTED` with `details.platformCode: "AGENT_KYC_NOT_VERIFIED"`
  (before, it came as `AGENT_NOT_ELIGIBLE_FOR_ASSIGNMENT`). A prepaid shipment is accepted.

- [ ] Map `platformCode: "AGENT_KYC_NOT_VERIFIED"` → *"This agent isn't verified and can't carry cash on delivery."*

## 6. Payout queue — `GET /api/v1/money/payouts` (+ `/:payoutId`)

Unchanged shape. The row's `verification: { verified, verdict }` is **information for the
reviewer — it limits nothing**. There is no longer any cap on what an unverified owner withdraws,
so a payout amount always equals the owner's whole available balance at request time.

- [ ] Keep the verified / not-verified badge; remove any "capped", "allowance" or "partial payout"
  wording.
