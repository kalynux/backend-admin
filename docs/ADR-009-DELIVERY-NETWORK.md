# ADR-009 — Agency and delivery-agent administration

**Status:** Accepted · **Date:** 2026-08-11 · **Phase:** 9
**Amends:** ADR-004's *Agents* row (read: HTTP → direct read)
**Depends on:** ADR-004 (transports) · ADR-005 (list contract) · ADR-006 (the trail) ·
ADR-007 (the `/users` precedent this copies) · ADR-008 (vendors, the same split taken further)

---

## Context

The delivery network was the last large legacy surface with no home here: 11 agent
endpoints and 4 delivery-agency endpoints on jovi-mall's `/api/admin/*`. It is also the
domain where the platform's two hardest seams meet — the jovi-mall ↔ geo-tracker tracking
contract, and the six independent state axes an agent carries.

Four findings, measured against the code rather than assumed, shaped every decision below.

### F-1 · There was no agent list, anywhere

`GET /api/admin/agents/:agentId` existed. `GET /api/admin/agents` did not, and never had.
An administrator could not find an agent they did not already have the id of. The only
agent listing on any admin surface was `GET /api/admin/cod/agents`, which returns cash
holders — a different population answering a different question.

### F-2 · `legit_verified` enforces nothing, and `pending_verification` had no exit

- `requireLegitBusiness` (`auth/guards/index.ts:48`) has **zero call sites**. It is dead
  code, and it was the only consumer of the flag.
- `DeliveryAgencyRepository.setLegitVerified` had **zero callers** and no endpoint.
- `delivery_agencies.status` had exactly **two writers** in the entire codebase, both in
  `AdminAgencyService`: `deactivate` and `reactivate`.
- `findAvailableForVendors` filters `status: { $ne: 'inactive' }`, so a
  `pending_verification` agency is already browsable and contractable.

Net: every agency is created at `pending_verification`, and nothing moved it off except
`PATCH /:id/reactivate` — an endpoint whose name says the opposite and which additionally
runs the whole product-restore cascade over products that were never suspended. The only
surviving trace of the intended meaning is a warning string in `agency-profile.dto.ts:296`
telling agencies their functionality is limited until verified. It is not.

### F-3 · The admin Tracking Allow switch reached geo-tracker through no path at all

`agent.tracking_allow_changed` was published (`agent-tracking-policy.service.ts:152`) and
had **zero subscribers**. And `visible-agents.service.ts` never consults `tracking.allowed`
for any role, so even geo-tracker's `RevokeForAgent` sweep — which re-checks every watcher
— would have kept them all.

So the flag was enforced on exactly one side: `assertEligible` refused to dispatch a *new*
shipment, while geo-tracker went on recording the agent's position and broadcasting it to
every watcher. An administrator pressing "disable tracking" changed strictly less than the
button claimed.

### F-4 · Neither collection was indexed for the screens being built

`delivery_agencies` declared **no index at all** beyond the unique `user_id` its field
definition creates — including none behind `findAllForAdmin`, which already filters and
pages. `delivery_agents` had five indexes and **none on a timestamp**, while `-createdAt`
is the only sensible default order for an administrative directory.

---

## Decisions

### D-1 · Records are read directly; verdicts are delegated; writes are delegated

> **Delegate a read whose answer is a VERDICT the platform acts on.
> Read directly a read whose answer is a RECORD.**

| Read | Path | Because |
|---|---|---|
| agency + agent directory, detail, roster, contract history | **direct** | records; no invariant to protect |
| `agentTrackingPolicyService.resolve` | **delegated** | geo-tracker consumes this exact function; a copy is a second tracking policy |
| `agentEligibilityService.evaluate` | **delegated** | the dispatcher branches on it, and it reports *every* blocker at once — the property a reimplementation loses first |
| `agentCodThresholdService.getAllocation` | **delegated** | for `ALLOCATING_CONTRACT_STATUSES`, the judgement that `paused`/`suspended` still hold headroom and `deactivated` does not |
| every write | **delegated** | ADR-004 D-2, unchanged |

This **amends one cell** of ADR-004's table: the Agents row said `read: HTTP`. Agencies
already said `direct read`.

The reason for the amendment is not "there is no service to call". jovi-mall *has* an agent
read service — `AgentDirectoryService` — and it is the wrong one. Its hard filter is
`assertCanHoldContract` plus completed onboarding, because listing an agent who cannot
accept a contract renders a button whose request dead-ends. **That filter excludes exactly
the population an administrator opens the screen to find**: unverified KYC, banned,
suspended, mid-onboarding. Delegating would mean writing a *second* directory service in
the service being migrated away from, whose only consumer is this one.

Being honest about the third delegated read: the argument is drift of a classification
list, not the protection of an invariant. It is a weaker case than the first two, and it is
still the right call.

### D-2 · The tracking boundary, and what this surface may show

> **Reaffirmed by Phase 14 (`ADR-014-SYSTEM-OPERATIONS.md`).** That phase built the operations
> surface across jovi-mall and this service and **did not touch geo-tracker at all** — no door was
> opened, not even for service-level health. A reader arriving at ADR-014 looking for one should
> stop here.


The two gates, as implemented: the **live position** is gated on **Tracking Allow alone** —
deliberately not on having a shipment, because locating an idle opted-in agent is how the
platform finds who is nearest a pickup. The **durable trail** is gated on an open tracking
session, i.e. an active shipment.

**wi-admin can read neither, and this phase does not build a door.** Every geo-tracker read
endpoint requires a real jovi-mall user JWT and resolves per-agent visibility by calling
`/api/tracking/visible-agents` *as the viewer* — which does a `findById` on `users`. A
wi-admin administrator has no `users` row, deliberately (ADR-004 D-1). Opening that door
means either minting platform user rows for administrators, or adding a service-caller
identity geo-tracker does not have. Both are out of scope, and neither is a small decision.

What this surface serves instead: the business flag and its actor stamp, the delegated
policy verdict with its `denyReason`, the device capability flags, availability, capacity,
and `last_known_tracking_state`.

**`last_known_tracking_state.last_position` IS served, and that is a considered call.**
jovi-mall's own admin detail already returns it, so withholding it would be a silent parity
break somebody re-adds as a missing-field bug. It ships with a derived `isStale` beside it
and the DTO documents what it is: a business mirror, stale by construction, written by
geo-tracker's best-effort notifier. **A dashboard must render it as "last seen", never as a
live marker on a map** — the marker would stop moving and nobody would be told.

`home_base.location` is **not** served: a 2dsphere point on a person's residence, and not
tracking state. `home_base.label` answers the operational question.

### D-3 · The Tracking Allow gap is closed, and it is a two-repo change

F-3 is fixed rather than documented, because shipping a write that does less than its name
says is the thing ADR-007 D-5 refuses.

- **jovi-mall** — a new outbox event type `agent.tracking_allow_changed` carrying
  `trackingAllowed`, subscribed by `TrackingEventSubscriber`, dispatched by the existing
  worker. It carries **no shipment verdicts**: this event says nothing about any shipment.
- **geo-tracker** — `TrackingAllowed *bool` on `webhook/domain.Event`, a new
  `SessionLifecycle.SetTrackingAllow`, and a session-service implementation that writes the
  device's Tracking Allow state and drives every open session to `tracking_disabled`.

Three properties are load-bearing:

1. **It is never refused.** `ReportDevice` returns `ErrTrackingAllowLocked` for an *agent*
   revoking mid-delivery, because that would strand a shipment dispatched on their promise.
   This is the *platform* withdrawing that permission — the case the lock exists to serve,
   not one it should block. A separate method, not a bypass flag on the existing one.
2. **It ends nothing.** Whether a delivery is over is jovi-mall's decision and this event
   does not carry it. Sessions stay open with their trails intact and simply stop producing
   GPS. It reaches `StateTrackingDisabled`, which the lifecycle already described as
   "geo-tracker's device view diverged from what jovi-mall assigned against" — a state that
   until now was not deliberately reachable.
3. **It does not revoke a watcher.** `visible-agents` derives visibility from shipments and
   never consults the flag, so an agency watching stays subscribed and receives nothing.
   The endpoint's response message says both halves rather than the flattering one.

### D-4 · Verification is made coherent, or it would not have shipped

`agencies.verify` is a new permission and one new jovi-mall endpoint performing **one
compare-and-set**: `status: 'pending_verification' → 'active'`, both `legit_verified`
mirrors, and a `kyc_details.verified_by` actor stamp — together or not at all. A racing
second administrator gets `null` from the CAS and a `409 DELIVERY_AGENCY_STATUS_CONFLICT`.

A pure `legit_verified = true` would have been ADR-007 D-1's exact anti-pattern: a button
that flips a column nobody reads. Moving `status` in the same write is what makes it mean
something — `findAvailableForVendors` filters on it — and it retires the misuse of
`reactivate` as the approval path.

**There is no `unverify`.** Revoking a verification that gates nothing is theatre;
`deactivate` is the real lever. **`requireLegitBusiness` remains dead code** — recorded
here, as ADR-007 recorded jovi-mall's commented-out password check.

### D-5 · Two feeds per subject, never one merged

`/:id/activity` (the wi-admin audit trail) and `/:id/contract-history`
(`agent_membership_events`) stay separate. Three reasons, descending in strength:

1. **They cannot be paginated together honestly.** They live in two databases reached by
   two MongoClients, so there is no `$unionWith`. A merged `total` is a sum of two counts,
   which makes `meta.pages` a lie the moment the two interleave.
2. **They carry different permissions.** The trail needs `audit.read` (its read scope
   applies); membership events are jovi-mall domain records gated by `agents.read` alone.
   Merged, a tier holding one without the other loses the whole feed.
3. **They answer different questions.** The membership feed's `actor_role` is
   `agent | agency | admin | system` — what *everyone* did. The trail is what
   *administrators* did.

**Both `activity` feeds are empty on day one.** jovi-mall's `auditLogger` is a console stub,
so every historical deactivation is unrecoverable. `contract-history` is the only feed with
history in it. This is stated so the empty feed is not filed as a bug.

### D-6 · Files are opaque ids on the wire

jovi-mall resolves `logo_file_id` / `avatar_file_id` through `resolveFileDetail`, which is
storage-provider-aware. wi-admin has no storage layer and must not grow one — copying it
would duplicate `STORAGE_PROVIDER` configuration across two services. The DTOs carry
`logoFileId` / `avatarFileId`; the dashboard resolves them against jovi-mall.

This is the one place the phase deliberately serves *less* than jovi-mall's DTO.

### D-7 · The projection guarantee is extended to the joined read paths

`PlatformReadRepository`'s constructor promises that "an omitted projection returns whole
documents, which is how a credential ends up in a response". That held for `findPage` and
**not** for `aggregateBy`, which passes its pipeline straight through. Every read model
until now was a single collection, so nobody walked through the hole; the agency directory
is the first needing a `$lookup`.

Fixed rather than worked around: `aggregatePage(page, {match, join, project})` and
`aggregateOne(stages, project)` both spread the repository's own projection and let a caller
only **add**. A domain whose detail is wider than its list gives the base the **narrow**
projection and names the extras at the call site — so the default is the safe one and the
widening is a visible diff.

`aggregatePage`'s two stage lists also encode the paging strategy: `match` runs first, where
an index can serve the sort; `join` runs *inside* the items branch after skip/limit, so a
`$lookup` touches at most one page. The agency directory is the deliberate exception — it
searches on a joined field, so it must join before it pages, and the call site says so.

### D-8 · Sensitive fields, named with their reasons

| Field | Why never projected |
|---|---|
| `legal_identity` | `drivers_license_number`, `national_id_number` — government identity documents |
| `payout_details` | Bank account numbers and mobile-money MSISDNs; masked even for the owner |
| `emergency_contact` | A **third party's** name and phone — the only field whose subject never joined the platform |
| `home_base.location` | A 2dsphere point on a person's residence |
| `wa`, `avatar_url` | A messaging-channel binding; a deprecated field |
| agency `payout_details`, `wa` | As above |

`trust_signals` and `device` are **enumerated field by field**, not taken as whole
sub-documents: `trust_signals: 1` would let a sensitive field added upstream next year
arrive automatically, which is the exact failure a whitelist exists to prevent. The one
sub-document taken whole is the agency's `policies`, and it is argued for on its own terms
— those are commercial terms already visible to every connected vendor.

`agent_membership_events.metadata` is a `Mixed` field jovi-mall writes freely, and is
excluded for the same reason.

---

## Consequences

- **`LEGACY_ENDPOINT_COUNT` 76 → 61.** The two `/plan` rows and the three `/cod/agent*`
  rows survive: they belong to billing and COD. `test-agents.ts` asserts this keyed on the
  **permission family**, because a path prefix cannot tell them apart.
- **`PermissionSpec.phase` widened** to include `9`.
- **`delivery_agents` gains three indexes and `delivery_agencies` two.** `autoIndex` is on
  and a failed build is *silent*, which is why the live suite asserts them.
- **The agency router's paths became relative** and `api/index.ts` absorbed the
  `/delivery-agencies` segment, so the same factory serves both mounts. Public URLs are
  byte-identical; that one line is the only edit to `api/index.ts`.
- **J6's deferred actor stamps landed.** `kyc.verified_by`, `platform_ban.banned_by`,
  `tracking.changed_by` and the agency's `kyc_details.verified_by` now carry
  `_source`/`_name` companions. Without them those columns fill with ids that resolve to
  nothing in `jovi_mall` and no discriminator — the state ADR-004 D-1 says is only safe
  *because* of the companions. `actorStampOrCleared` is new: it writes an actor or three
  nulls from one call, because the clearing direction (an unban) is the one that gets
  forgotten.
- **The business name is not sortable** on the agency directory, and will not become so
  without inverting the pipeline to drive from `agency_magazins` — which loses every agency
  without one.

## Still open

- **A geo-tracker read door for wi-admin.** Live position, session health and the
  checkpoint trail remain unreachable from this service (D-2). Deciding it means deciding
  whether administrators get platform identities or geo-tracker gets a service-caller model.
- **`requireLegitBusiness` is dead code** in jovi-mall (F-2). `agencies.verify` now writes a
  flag whose only *enforced* half is the `status` beside it.
- **`agent_action_audit` has no read path.** geo-tracker's spatial audit is write-only by
  contract; surfacing it is net-new, including its authorization, which has no precedent in
  that module.
- **jovi-mall's `auditLogger` is still a console stub** (D-5).
- **No deactivation-reason column** on `delivery_agencies`. The reason lives in the audit
  row; add the column when an agency-facing screen renders it (ADR-006 D-7's test).

## Verification

| Suite | Assertions | Needs |
|---|---:|---|
| `npm run test:agents` | 70 | nothing |
| `npm run test:agencies` | 54 | nothing |
| geo-tracker `go test ./...` | — | nothing |

The two highest-value assertions are `test-agents.ts` §5's cross-repo path check — the only
thing in either repo that catches a route rename across the service boundary — and §4's
structural tracking checks, which assert the boundary rather than trusting it.
