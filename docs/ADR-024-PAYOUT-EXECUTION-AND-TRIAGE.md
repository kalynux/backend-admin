# ADR-024 — Payout execution, and a review stage below the tier that pays

**Status:** accepted · **Date:** 2026-09-15 · **Phase:** — (owner-driven)

## Context

Two problems, one workflow, and they are worth stating separately because only one of them is
about permissions.

**1. Nothing on this platform sent money out.** Every payout was an administrator opening their
banking app, moving the money by hand, and typing an external reference into
`POST /money/payouts/:id/mark-paid`. Both mobile-money gateways have a disbursement API and
neither was wired; `PaymentGateway` had no seat for one. `PHASE-1-PAYMENTS-PLAN.md:483` put
disbursement explicitly out of scope — *"that is Phase 6 territory and needs IP allowlisting
decisions"*. This is that work.

**2. Payout review was a tier-1/2 bottleneck, while tier 3 could already see the requests.**
Every payout opens a `PAYOUT_REQUEST` ticket assigned to the admin pool, and `resource-scope.ts`
gives a Support administrator the unassigned queue. So the request was on their screen and every
permission naming it was withheld: they could read the conversation and do nothing about it.

## Decisions

### D-1 · Tier-3 rejection is terminal; endorsement is advisory

A reviewer can endorse a request as genuine or reject it outright. Rejecting is the same
terminal write a tier-1/2 administrator performs — same fields, same code path, same event —
because rejection is terminal and terminal outcomes are statuses.

**There is no `rejected` triage verdict.** Storing one beside `status: 'rejected'` would be two
fields free to disagree about whether a request is closed.

**How it is reached:** `POST /money/payouts/:id/reject` takes
`anyPermission('money.payouts.reject', 'money.payouts.triage')`. One route, one write, two ways
in — rather than a second reject route writing the same terminal state through different code.

⚠ **This was missed on the first pass and is worth recording, because the omission was
self-consistent.** `/triage` was built to endorse only, and `/reject` was left on
`money.payouts.reject` alone — so a reviewer could endorse and nothing else. Everything compiled,
every suite passed, and the permission's `financial` flag plus its grant-table exemption (D-4)
were both justified by a capability the permission did not actually have. It surfaced while
writing the dashboard brief, from the question "which control does a reviewer press to reject?",
and is now pinned by `test:money`.

### D-2 · The pre-screen is OPTIONAL, and that is the point

A payout nobody has endorsed is exactly as payable as one that has been. Making endorsement a
precondition would turn the reviewing tier into a bottleneck on cash — an empty Support queue
would stall payments — which is the opposite of the problem this solves.

⛔ Consequence for every dashboard: **do not disable an approve control on a missing
endorsement.**

### D-3 · The ≥ 2,000,000 XAF four-eyes rule is unchanged and orthogonal

A triage endorsement is not a signature. A large payout can therefore involve three people: a
reviewer who endorses, an administrator who requests, and a second who approves. That was
considered and kept — treating an endorsement as one of the two eyes would mean the quorum on
the platform's largest irreversible transfers was no longer two money-authorised administrators.

This is free rather than built: `/send` **reuses `money.payouts.mark_paid`** rather than taking
a permission of its own, so `LARGE_PAYOUT` already applies to it. A separate permission would
have created a second threshold with nothing keeping the two in step.

### D-4 · `money.payouts.triage` is flagged `financial`, and the grant table takes a named exemption

This is the load-bearing decision in the authorization half, and it was nearly got wrong.

**Rejecting a payout is not money-neutral.** `requestPayout` moves the owner's whole balance
`available_balance → requested_balance` the moment the ticket opens; `reject` calls
`revertPayoutToAvailableInSession` to move it back. That is why `money.payouts.reject` carries
`financial: true` and why `assertGrantTableValid()` refuses to boot if tier 3 holds it.

Two ways to admit the new permission were available:

1. flag it non-financial, which would be **false**, and precisely the misdescription ADR-011 D-8
   warns against — the flags are load-bearing, not documentation;
2. flag it honestly and narrow the rule.

We took (2), with `TIER_3_FINANCIAL_ALLOWLIST` — a list of names, mirrored in `test-authz.ts`,
so admitting a second one is a deliberate two-file change. Dropping the blanket ban instead
would have silently unguarded eleven other financial permissions.

**The line the allowlist draws:** *Support may release a hold back to the owner it belongs to.
Support may never send money out of the platform.*

### D-5 · `cod.triage` is NOT financial, and the asymmetry is real

The same pre-screen on COD deposits and remittances needed **no** exemption. A payout request
holds money from the moment it opens; a COD deposit or remittance in `declared` holds
**nothing** — only a CONFIRMED one moves cash. So endorsing one moves nothing and rejecting one
moves nothing either.

⚠ It is also a smaller surface than it looks. jovi-mall's `assertConfirmer` refuses an
administrator on an **agency-recipient** deposit, which is the normal route: that handover is
confirmed by the agency itself — a counter-signature between two *organisations*, which is a
stronger control than two admin tiers — and the platform never saw the cash. Triage therefore
reaches platform-recipient deposits and all agency remittances.

### D-6 · Endorsement is a FIELD on the record, never a status

Three things key on `status === 'pending'` and all three break if an `endorsed` state is added:

1. the partial unique index enforcing one open request per owner — an endorsed payout would fall
   out of it and the owner could open a second one against money they still have not got;
2. `assertPending` in the dual-control handler, which refuses anything not `pending` — an
   endorsed payout would become **unpayable**;
3. the queue filter and the allowance window.

Keeping it beside the status means the entire existing state machine is untouched by triage,
which is also what makes D-2 true by construction.

### D-7 · A failed transfer keeps the funds held

`processing` and `failed` are both non-terminal **and both still holding the owner's money**. A
failed transfer has not returned anything, so releasing the hold would offer the owner a balance
the provider may yet settle. An administrator retries or rejects.

⛔ **`processing → rejected` is refused** (`409`). This is the single most important refusal in
the change: releasing a hold while a transfer may still be in flight is how a payout is sent
twice — once by the transfer that was never actually dead, and once out of the balance that came
back. For the same reason, a *thrown* error after the claim deliberately leaves the payout in
`processing` rather than rolling it back: a timeout tells us nothing about whether the provider
received the transfer.

### D-8 · The double-send guard is a compare-and-set that mints the reference

`pending|failed → processing` and the minting of the merchant reference happen in **one atomic
update, before any HTTP call**. A second request loses that race and sends nothing.

A retry **reuses the stored reference** rather than minting a fresh one, so a transfer that
actually succeeded and merely failed to report is deduplicated by the provider instead of paying
the owner twice. Minting per attempt would defeat that completely.

### D-9 · Webhook direction is decided once, by the adapter, and never crossed

`NormalizedWebhookEvent` gained a required `direction` (`collection` | `payout`). The processor
refuses to cross it: a payout event settles only payouts and never falls through; a collection
event never touches a payout row.

The hazard this closes is specific. `route()` falls through to the order orchestrator for
anything it cannot place — deliberately, so an unprefixed legacy reference still finds its way
home. Without a direction check that same fall-through would hand a `transfer.*` callback to the
payment orchestrator. Unknown or absent event types default to `collection`, which preserves
today's behaviour for every existing callback byte-for-byte.

## What this does not change

- **jovi-mall still authorizes nothing on tier.** It serves `/triage` and `/send` as two routes
  behind one service token and does not read `X-Actor-Tier` for any decision — that header is
  advisory and the token is a full-privilege credential, so branching on it would be a check the
  caller sets for itself. All tier logic stays here (ADR-020 D-2 constraint 3).
- **Manual `mark-paid` survives**, and must: it is the only way to settle a **bank** or **card**
  destination, which no gateway here can reach, and the fallback when the gateway is down.
- **`money.payouts.destination.read` is not granted to Support.** ADR-011 D-5's reasoning is
  unchanged — that field is the material a fraudulent payout instruction is built from, and a
  reviewer who never sends money has no use for it. Triage works from the masked destination,
  the amount, the owner and the KYC verdict.

## Consequences

- Tier 3 gains five permissions: `money.payouts.read`, `money.payouts.triage`,
  `cod.overview.read`, `cod.remittances.read`, `cod.deposits.read`, `cod.triage`.
- `PayoutRequest.status` gains `processing` and `failed`; the partial unique index widens to
  `PAYOUT_HELD_STATUSES` (`migrate:payout-lifecycle-index` drops the legacy
  `owner_type_1_owner_id_1`, which is a *name* collision as much as a filter change).
- A new operational dependency that is not in any file: **NotchPay IP-allowlists transfers and
  does not allowlist collection.** See `docs/RUNBOOK.md` § "Configuration that is an OPS STEP".

## Still open

- **No alerting on a stalled `processing` payout.** If `transfer.complete` is not subscribed in
  the NotchPay dashboard, money moves and the platform never records it — the payout simply sits
  in `processing`. A sweep that re-reads `GET /transfers/{id}` for anything `processing` beyond a
  threshold is the obvious next thing and is not built.
- **`transfer.reversed` on an already-`paid` payout is recorded, not corrected.**
  `markPayoutPaidInSession` has permanently deducted the balance and there is no column to put it
  back into; the reversal is noted on the row and the ticket for a human. Same posture as a
  wrongly-confirmed COD deposit, and it deserves a real reversal path if it ever happens twice.
- **The NotchPay transfer body is verified against their OpenAPI, not against a live call.**
  Their prose documentation contradicts itself three ways; `openapi.yaml` in their PHP SDK is the
  only self-consistent source and is what the adapter follows. Confirm in the sandbox before the
  first live transfer.
- **`orders.refund` still has no dual-control threshold**, unchanged from ADR-010 and ADR-011.
  Nobody has named an amount.
