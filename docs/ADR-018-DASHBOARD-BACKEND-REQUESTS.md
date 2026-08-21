# ADR-018 — Answering the dashboard's backend requests

**Date:** 2026-08-17
**Status:** Accepted, implemented
**Scope:** wi-admin, jovi-mall, geo-tracker

---

## Context

The admin dashboard built eleven screens against `docs/api/` and filed nine numbered requests
for what it could not finish, in
[`docs/dashboard/backend-requests/`](./dashboard/backend-requests/). Each states the ask, quotes
the contract line that refuses it, says what the dashboard shipped in the meantime, and proposes
a contract.

They are not all endpoint requests. Several are explicitly *"decide, don't build"* — a recorded
position is the deliverable, and five of the nine acceptance lists contain items only a written
answer can satisfy. This ADR is that record.

The response to the dashboard team is
[`docs/dashboard/backend-requests/RESPONSE-2026-08-17.md`](./dashboard/backend-requests/RESPONSE-2026-08-17.md),
which is the acceptance-list view of the same work.

---

## Findings that changed the shape of the work

Three of these invalidate premises the requests were written on. They are recorded first because
two of the decisions below only make sense against them.

### F-1 · The tracking-state pipe had never worked

geo-tracker POSTs tracking-state notifications to `TRACKING_STATE_NOTIFY_PATH`, whose default —
published in `geo-tracker/api-doc/tracking-notifications.md` since the tracking lifecycle
shipped — is `/api/tracking/agent-state`. **jovi-mall served no such path.** Its `/api/tracking`
mount had exactly one route, `visible-agents`.

A receiver *had* been built, at `POST /api/internal/agents/:agentId/tracking-state`, and the
notifier has never called it. Delivery is best-effort by design and a non-2xx is logged and
dropped, so neither side ever raised anything.

**Consequence: `DeliveryAgent.last_known_tracking_state` was the schema default —
`status: "unknown"`, `last_position: null` — on every agent in the database.** Which means
[`DATA-EXPOSURE-REGISTER.md` §1](./dashboard/DATA-EXPOSURE-REGISTER.md), "a person's coordinates,
ungated and unaudited", described a disclosure that was not occurring: the field it flags has
never held a coordinate.

### F-2 · The notification carried no coordinates

`session/domain/events.go`'s `TrackingTransition` was
`{SessionID, AgentID, ShipmentID, From, To, Trigger, Reason, OccurredAt}`. Fixing F-1 alone
would have given jovi-mall a status and a timestamp and still no position.

### F-3 · GPS accuracy exists nowhere on the platform

`grep Accuracy` over geo-tracker's location domain returns nothing. The WebSocket
`location_update` frame does not carry one, so no component has ever known how good a fix is.
BR-003's `position.accuracyMetres` is not deliverable without a change to the agent mobile
application, and then the frame, and then two services.

### F-4 · BR-005's hardest part was already built

`jovi-mall/src/modules/inventory/domain/services/storage-fee.calculator.ts` is a pure
`quoteStorageFee(pricing, catalogStock, size)`, and `inventory-row.resolver.ts` already
assembles resolved images, catalogue stock, reservations, depot and vendor name in a fixed
number of queries. The product detail reuses both rather than reimplementing either.

The calculator's own header carries the fact that decided BR-005's `storage` block: **the
platform does not track, invoice or act on storage payment.** The rate has been collected at
agency onboarding since day one and never charged, and `EarningsQuoteService` deliberately
excludes it from the per-order split because it is rent rather than a delivery fee.

---

## Decisions

### D-1 · Credential recovery is a third entrance, not a second mechanism

`users.password.reset` leaves the `†` list, and `users.login_link.send` joins the catalog.
`POST /users/:userId/{password-reset-link,login-link}`, delegated, audited, `reason` required,
rate-limited per party **and** per administrator.

Both mint through jovi-mall machinery that already existed —
`PasswordResetService.issueResetLinkFor` and `MessagingLoginService` — so the token, its
lifetime, its single-use semantics and (for the reset) the `password_changed_at` stamp that
evicts every live session are the ones the self-service and bot flows already use. A second
store is how two entrances drift on expiry or on single-use.

Four properties are load-bearing:

1. **The destination is never accepted from the caller.** It is read from the party's own
   record. An operator who could type an address could mail a working credential for somebody
   else's account to themselves, and no permission short of withholding the endpoint prevents it.
2. **The response carries no token, no link and no unmasked destination.** Otherwise "help this
   vendor back into their shop" and "sign in as this vendor" become the same button.
3. **Two permissions, not one, and two audit actions.** A reset link grants nothing until the
   person chooses a password; a sign-in link *is* a session. Folding them together would mean a
   tier granted the first silently got the second, with nothing in the trail to distinguish the
   acts.
4. **Neither reaches tier 3.** Support answers delivery tickets; a support agent who can mail a
   working link to any vendor can take over any shop. `assertGrantTableValid()` does not catch
   this — neither permission carries a `financial` or `destructive` flag — so the protection is
   that SUPPORT names its grants by hand, and `test:users` asserts the absence.

**No dual control.** Considered and declined: four-eyes guards three actions today, all
irreversible or privilege-granting. A reset link is neither, and making routine account recovery
a two-person job pushes operators toward reading passwords over the phone — the workflow this
replaces.

**No verified-destination gate**, and this is F-shaped rather than a choice: jovi-mall's `users`
row carries no `email_verified`. Verification flags live on the **role** entities, a user may
hold several roles, and `login_email` is the login identifier itself — the address
`POST /auth/forgot-password` already mails a live reset token to, anonymously, with no check.
Gating the administrator path more tightly than the path an attacker can drive protects nothing.
**`USER_CHANNEL_UNVERIFIED` is therefore not in the registry.**

**Telegram is in scope**, contrary to BR-001's expectation that it would need a new field. The
platform stores no `chatId` on any party, but `channel_connections` already *is* the
`(user, channel, external_id)` mapping — an agent, vendor or customer who has run `/connect` with
the bot has a chat to reach. One who has not gets `USER_CHANNEL_UNAVAILABLE`, which is the honest
answer rather than a gap.

### D-2 · `lastKnown` stays under `agents.read`, and the pipe is fixed instead

DATA-EXPOSURE §1 asked for the block to be gated on its own permission and its read audited. The
product owner declined both, and F-1 is why the question is less urgent than it looked: the field
has never carried a coordinate, so the disclosure being weighed had not been happening.

What ships instead is the data, working:

- **geo-tracker** carries the agent's last fix on the notification (`position: {latitude,
  longitude, recordedAt}` — named fields, never a GeoJSON pair, so the `[lng, lat]` inversion
  happens exactly once and on the side that stores it). Read only for the transitions that are
  actually sent, so the hot path is untouched.
- **jovi-mall** serves the advertised `POST /api/tracking/agent-state`, guarded by the existing
  service token; the internal route stays. It reverse-geocodes the position **once per position**
  and stores the result, rather than resolving on read — per-render geocoding is a bill per
  operator who opens the tab, and hands the same person's coordinates to a provider once per
  *viewer* rather than once per *position*.
- **wi-admin** projects `lastKnown.place`.

Two things this receiver deliberately does not do:

- **No `eventId` dedup store.** Applying a notification is a `$set` of the same fields to the
  same values, so a redelivery is a no-op by construction; a dedup table would be a second store
  kept correct to prevent nothing. The real risk is *ordering* — an older event overwriting a
  newer state — which is guarded on `occurredAt`, and that also covers the case dedup misses
  entirely: two different events delivered out of sequence.
- **No 4xx or 5xx, ever.** geo-tracker treats any status ≥ 300 as a dropped best-effort delivery,
  so a 404 for an unknown agent would put a permanent error line in its logs for a condition
  nobody can fix. The outcome is in the body.

**`accuracyMetres` is not shipped** (F-3). A field that is `null` on every row in every
circumstance teaches a client to expect data that does not exist.

### D-3 · An administrator may freeze or end a contract, never write its terms

`GET /contracts/:contractId` plus `POST /contracts/:contractId/{suspend,reinstate,terminate}`,
under a new `agents.contracts.manage`.

`agents.md` refused contract writes on the grounds that *"a live contract's terms change by
proposal between the two parties, never by edit"*. That reasoning is right, unchanged, and is an
argument about **terms**. It is not an argument about freezing a relationship — and *"do not let
an administrator impose terms"* and *"do not let an administrator stop an abusive relationship"*
are different claims, only the first of which was ever made. `agencies.deactivate` already
provides the same lever one level up.

Refused, with reasons that are not interchangeable:

| Refused | Ground |
|---|---|
| Approve a pending contract | `terms.proposedBy: null` exists precisely because nobody has stated terms. Approving binds an agent to a default that pays zero |
| Edit terms / counter-offer | The contract is pricing deliveries right now against its agreed `feeSplit` |
| Adjust `cod.threshold` | A third ground: it is the contract's slice of a pool bounded across every allocating contract, `0` blocks all COD rather than meaning "no limit", and the arithmetic is `AgentCodThresholdService`'s |

Each write resolves the contract's own `agency_id` and runs jovi-mall's ordinary agency-scoped
transition, so the authority matrix, the legal `from` states, the status-request row and the
membership-event history are the same code an agency desk runs. An administrator gets a different
**door**, never different **rules**.

**Terminate routinely does not terminate, and the response says so.** Deactivation needs the
counterparty's agreement and the §4 cash conditions — outstanding COD settled, agent paid — so
`contract: null` with a `pendingRequest` and `blockers` is an ordinary outcome. **There is no
override**, because ending a relationship that still owes an agent money is how that money stops
being anybody's responsibility, and an administrator is exactly the party who could do it without
either side noticing.

### D-4 · A record whose *projection* needs local machinery is delegated

ADR-009 D-1: records are read directly, verdicts are delegated. `GET /vendors/:vendorId/products/:productId`
is a record and is delegated anyway, and the reason is **D-6 rather than an exception to D-1**.

Two things in that payload can only be built where they live: `media` needs
`storage.getPublicUrl(key)` and therefore `STORAGE_PROVIDER`, which this service must not
duplicate; and `storage` needs `quoteStorageFee`, a copy of which would be a second opinion about
what a vendor owes their agency.

Stated as a rule so the next case does not have to be re-argued:

> **Delegate a read whose answer is a verdict the platform acts on. Read directly a read whose
> answer is a record — unless projecting that record requires machinery this service may not own,
> in which case delegate the projection rather than duplicating the machinery.**

### D-5 · File resolution is delegated, and it resolves rather than enumerates

`GET /api/v1/files` and `GET /api/v1/files/:fileId`, under a new `files.resolve`, delegated to a
new `POST /internal/admin/files/resolve`.

ADR-009 D-6 — "this service resolves no file URLs" — is upheld, not reversed: the resolution
stays where the provider is configured, and this service gains a client rather than a storage
layer. What D-6 got wrong was its *consequence*: it told the dashboard to resolve ids "against
jovi-mall", and the dashboard talks to this service and to nothing else, by design. Every avatar,
logo, banner and delivery proof on the admin surface rendered as a placeholder (gap **D2**).

`files.resolve` is granted to **every tier**, including Support, because it discloses nothing new:
the caller already holds the id, which means they already passed the guard on the record carrying
it. What keeps it narrow is the shape, not the tier — **it takes an explicit id set and has no
listing form, and must not grow one.**

> ⚠️ **The last sentence of this paragraph was superseded on 2026-08-20, in both halves.** It read:
> *"`files.orphans.read` is the listing and stays tier-1-only and unmounted."*
>
> Phase 5 Part B **mounted** it (`GET /api/v1/files/orphans`), and it was never tier-1-only —
> `allInFamily('files')` has always swept it into tier 2, so the grant table disagreed with this
> sentence on the day it was written. See `ADR-017-PHASE-17-CLOSEOUT.md` § Correction.
>
> **What the paragraph above still gets right is the part that matters**, and Part B did not touch
> it: `files.resolve` takes an explicit id set, has no listing form, and must not grow one. The
> listing is a *separate permission* on a *separate route* — which is precisely why mounting it
> costs the every-tier grant nothing.

### D-6 · The five casing leaks are fixed, and the vendor's terms are projected

All five sub-documents that reached the wire in jovi-mall's `snake_case` are now named-field
mapped: `agent.vehicle`, `agent.device`, `agent.trustSignals`, `agency.policies`, and
`contract.terms.{employment,remittance,feeSplit}`. Each is documented field by field.

`agent.vehicle` was additionally documented as `{type, plate}` while serving
`{vehicle_type, plate_number, color, photo_file_id}` — the contract and the wire disagreed on the
field names as well as the casing.

**The vendor's policy content is projected**, closing an asymmetry that was never argued. The
agency's `policies` is taken whole on the grounds that *"these are commercial terms already
visible to every connected vendor"*. That argument carries here **a fortiori**: a vendor's return
and cancellation policy is published to every **customer** on the storefront, a strictly wider
audience. Withholding from an administrator what is published to the public was the part that
read as an oversight. The presence booleans stay, derived from the content rather than replaced
by it.

Both blocks keep a wide projection with a **named mapper** as the second lock, so a field added
upstream reaches the read model and stops there.

**No policy write was added**, on either side. Every edit bumps `policyVersion`, which pauses
every connection for re-approval. What the agency detail gains instead is
`policyVersionPausedConnections` — the consequence of that bump, which had no surface anywhere.

### D-7 · Totals across owners are the platform's to compute; owner names are this service's

`GET /money/earnings/accounts` gains `meta.totals` and `ownerName`, and the two come from
different places on purpose.

`accounts.md`'s rule — *"no grand total exists, at any level"* — is about the sum **across the
four balances for one owner**, which double-counts (`requested` is a claim already staked against
`available`). That stays forbidden. The sum **down one balance across owners** is a different
question with the same unit, the same direction and one currency at a time, and **only jovi-mall
can answer it honestly** because only it can see past page 1. One entry per currency, as an
array: a single object would force a currency choice the data does not support.

`ownerName` is hydrated **here**, because that is what this controller already does four lines
away for payouts and allocations — one batched read per owner type, never one per row. It has to
be server-side: twenty rows across three directories is twenty client requests, each behind a
permission a `money.earnings.read` holder need not hold, which would make this list the side door
onto `/vendors`, `/agencies` and `/agents` that the accounts mount's composed authorization
exists to prevent.

### D-8 · No batch `?ids=` resolver on the directories

BR-006 §4 suggested `GET /agencies?ids=…` and left the decision open. **Declined**, and the reason
is D-7's: a bounded ids list on a directory is a way to read that directory, and the callers who
want one are exactly the callers who do not hold its permission. Every N+1 the dashboard actually
has is removed by a specific join instead — `agency.businessName` on the contract rows,
`deliveryAgency` on the catalogue rows, `ownerName` on the accounts rows.

`GET /files?ids=` is the one batch route added, and it is not a directory read: file ids are
unguessable, the answer is metadata, and there is no listing form.

### D-9 · The legacy audit feed is list-only, by design

No `GET /audit/legacy/:id`. A legacy row already carries everything the writer stored — unlike an
`AuditEntryDto`, whose detail route adds four fields the list omits — so a detail route would
return the row the client is already holding. What it would add is addressability, against a
module that is deleted at cutover. Recorded in `audit.md` so the absence stops reading as an
omission.

---

## Consequences

- **113 permissions**, up from 110; **27 are `†`**, down from 28. Three added
  (`users.login_link.send`, `agents.contracts.manage`, `files.resolve`), one routed
  (`users.password.reset`).
- **190 versioned endpoints across 20 route groups**, up from 179 across 18. The new groups are
  `/contracts` and `/files`.
- **Five audit actions added**, all delegated: `users.password_reset_link.send`,
  `users.login_link.send` (both `sensitive`), and `agents.contracts.{suspend,reinstate,terminate}`.
- **Six error codes added**, three of which arrive only as `details.platformCode`.
- **Three breaking wire changes**, all announced in the response document: the five casing fixes,
  `deliveryAgencyId` → `deliveryAgency` on the catalogue row, and vendor `policies` gaining
  content beside its booleans.
- **jovi-mall gained `/internal/admin/files`** and three routes on existing internal mounts.
- **geo-tracker's notification gained a field.** An event-shape change made in both repos
  together — the third instance of that rule, after the tracking-session lifecycle and Tracking
  Allow.
- **`DeliveryAgent.last_known_tracking_state` gained `last_place`.** No migration: the block is
  schema-defaulted and the new field is `null` until a position arrives.

## Verification

1434 assertions across 18 wi-admin suites, `tsc --noEmit` and `eslint --max-warnings 0` clean;
jovi-mall's suites green with `tsc` and lint clean; geo-tracker `go build`, `go vet` (both build
tags) and `go test ./...` clean.

Three things only a live run proves, each of which fails silently otherwise:

1. **The tracking pipe.** With `NODE_API_SERVICE_TOKEN` set, drive a geo-tracker state transition
   and assert the agent's `last_known_tracking_state` gains a status, a position and a place.
   This has never once worked, so there is no prior behaviour to regress against.
2. **Credential recovery end to end**, on each of the three channels: a masked destination back,
   a live link in the message, single use, and the reset actually revoking sessions.
3. **`GET /vendors/:vendorId/products/:productId` returns an image URL that loads.**

## Still open

**One item, as of 2026-08-20.** The list was three; Phase 4 closed two of them, and the
distinction between *how* they closed is the useful part — one was fixed, one was answered.

- **A live position for administrators.** Unchanged: ADR-009 D-2 stands, narrowed only by
  ADR-015 D-5's unauthenticated `/healthz` · `/readyz` · `/metrics` door, which exposes no
  agent. Opening the **data** door means either minting platform `users` rows for
  administrators or giving geo-tracker a service-caller identity, and neither is small.
  Owned by **6.I**.

### Closed

- ~~**DATA-EXPOSURE §6**~~ — three order writes returned jovi-mall's raw document, including
  `delivery_address.coordinates` and `raw_input`, which the corresponding read deliberately
  withholds. ✅ **FIXED 2026-08-20**, Phase 4 step 16 (wi-admin `0106944`). All three answer with
  an `OrderDetailDto` re-read through `ORDER_DETAIL_PROJECTION`, so the write and the read can
  never disagree again. Recorded in `dashboard/DATA-EXPOSURE-REGISTER.md` § 6.

- ~~**`accuracyMetres`**~~ (F-3) — ✅ **CLOSED AS OUT OF SCOPE 2026-08-20**, Phase 4 step 23,
  by owner decision (Phase 4 plan D-1 ★). **Answered, not merely dropped**: it is now listed in
  `PRODUCTION-READINESS/07-UNBUILT-SCOPE.md` § 3, which is the one place a future reader looks
  to find out whether an absence was a decision.

  **The reason is that it cannot be closed from here.** GPS accuracy exists nowhere on the
  platform, and the field would have to originate **outside all three repositories**:

  1. the **Flutter agent application** would have to read the platform accuracy estimate off
     the device and put it on the wire — nothing else can produce the number;
  2. geo-tracker's WebSocket `location_update` frame and its location domain would have to
     carry it (`grep Accuracy` over that domain returns nothing today);
  3. it would have to reach the checkpoint trail, since a live position is not what an
     administrator reads — `last_known_tracking_state` is, and ADR-009 D-2 keeps it that way;
  4. only then could wi-admin surface it.

  None of those four exists. Leaving it on an open register that no work in these repositories
  can discharge is the failure mode this closure is against: an item nobody can act on makes
  every other item on the list look equally inert.

  **What was shipped instead stands and is the right answer for the request behind it.** The
  BR-003 pipeline delivers a real position with `capturedAt` and a reverse-geocoded place name,
  and `accuracyMetres` was deliberately not shipped as a permanent `null` — *a field that is
  `null` on every row in every circumstance teaches a client to expect data that does not
  exist.* Closing it changes nothing on the wire.

  ↩ **If it is ever wanted, it starts in the agent app, not here** — and it is then a
  four-part change across two repositories and a mobile release, which is the shape a
  requester needs to know before asking.
