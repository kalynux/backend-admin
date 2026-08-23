# ADR-020 — The administrator's door into geo-tracker data

**Date:** 2026-08-18 (evidence gathered 2026-08-17) · **design added 2026-08-22**
**Status:** Accepted and **IMPLEMENTED** — D-1 and D-2 decided the position on 2026-08-18;
D-3 … D-7 are the design, written and built by Phase 6.I step 15 on 2026-08-22
**Scope:** wi-admin, geo-tracker
**Amends:** ADR-009 D-2 and ADR-015 D-5 — both of which recorded "no geo-tracker data door" as
the standing answer. It is no longer the standing answer.
**Answers:** [Q-1](../../PRODUCTION-READINESS/11-DECISIONS-REGISTER.md#q-1--does-an-administrator-get-to-see-a-live-position)
of the Phase D register · closes [06 · X-4](../../PRODUCTION-READINESS/06-CROSS-SERVICE.md)'s
blocking half

---

## Context

Deferred three times — ADR-009 D-2, ADR-015 D-5, and ADR-018's "still open" — because both exits
are structural and neither is small. The state of things, verified:

- Every geo-tracker **data** read requires a real jovi-mall user JWT and resolves per-agent
  visibility by calling `/api/tracking/visible-agents` **as the viewer**, which does a `findById`
  on `users`.
- A wi-admin administrator has **no `users` row**, deliberately. `requireAdminCaller` synthesises
  the whole `req.auth` shape from request headers with no database query, which is why
  `*_by_user_id` fields written through that door carry an id resolving to nothing in jovi-mall,
  and why the `*_source` / `*_name` companion machinery exists at all.
- Phase 15 opened `/healthz`, `/readyz` and `/metrics` at `GET /api/v1/system/geo-tracker[/metrics]`
  as an **operations** door: a closed literal path set, no identity, no agent, and a client that
  **can never throw**. ADR-015 D-5 named it an exception precisely so it would not be read as a
  precedent for data.

So today an administrator sees the business-side answer only — the flag, the policy verdict, the
device flags, and `last_known_tracking_state` **labelled stale** — and never a live position or a
trail.

---

## D-1 · Decision

**geo-tracker gains a service-caller model. Administrators do not get platform `users` rows.**

The rejected alternative is worth recording with its reason: minting `users` rows for
administrators would give a live position with no new authorization model, at the cost of
collapsing the identity separation the entire admin architecture is built on — and every
synthetic-actor mechanism that exists *because* of it (ADR-001, ADR-004's `*_source`
discriminator, `requireAdminCaller`). That is a larger change than the one chosen, and it is
irreversible in a way this one is not.

---

## D-2 · What "a service-caller model" must satisfy

The decision is the position, not the design. Phase 6.I writes the design, and it is bounded by
four constraints that follow from the service it is being added to.

**1 · It is a second authorization path in a service that has exactly one.** geo-tracker's
authorization today is one question — *may this viewer see this agent* — asked one way. A
service caller does not have a viewer. The new path must be visibly separate in the source, not
a branch inside the existing one, or the single-question property that makes the current model
auditable is lost.

**2 · It needs its own scope model, or an administrator gets everything.** This is the sentence
that has blocked the question three times and it does not go away by deciding. "wi-admin may
read tracking data" without a scope is a credential that reads any agent's trail for any reason.
The scope model is the deliverable; the transport is the easy half.

**3 · The caller is a full-privilege credential, so the grading happens in wi-admin.** The same
rule already governs `INTERNAL_ADMIN_SERVICE_TOKEN`: jovi-mall receives `X-Actor-Tier` and never
reads it for a decision, because whoever holds the token could set the header. geo-tracker must
take the same position — it authenticates the *service*, and wi-admin decides which
administrator tier may ask. Do not put tier logic in Go.

**4 · It must not become a readiness dependency of wi-admin.** ADR-015 D-5's "the client can
never throw" rule exists because making geo-tracker a readiness dependency of wi-admin
recreates ADR-014 D-1's coupled-failure amplifier in the opposite direction. A data door is
allowed to fail a request; it is not allowed to fail the service.

**A fifth, from wi-admin's own register:** `DATA-EXPOSURE-REGISTER.md` §1 flagged a person's
coordinates as *"ungated and unaudited"*. Gating them is what this ADR decides. **Auditing them
is not yet decided** — a live-position read is a read of a person's location by someone they
have no relationship with, and this is the one read in the corpus where an audit row on a
*read* is arguable. Phase 6.I answers it; note it is currently unanswered rather than answered
"no".

---

---

# The design — added 2026-08-22, Phase 6.I step 15

D-1 and D-2 above are the position and its constraints. What follows is the design they
bounded, decided and built in one change across two repositories.

## D-3 · The transport: four reads under `/internal/*`, in a module of their own

geo-tracker gains `internal/modules/serviceaccess/` — a **module**, not a branch — plus its
own middleware, its own error codes, and a path namespace disjoint from every other one in
the service. Constraint 1 is satisfied structurally rather than by convention:

| Path | Question | Credential | Resolved by |
|---|---|---|---|
| `/ws/track`, `/tracking/*`, `/locations/*` | *may this **viewer** see this **agent**?* | jovi-mall user token | jovi-mall, **as the viewer** |
| `/internal/*` | *does this **caller** hold this **scope**?* | `GEO_TRACKER_ADMIN_TOKEN` | geo-tracker, against configured scopes |
| `/webhooks/*` | *did jovi-mall sign this?* | HMAC-SHA256 | geo-tracker |

Both authorization paths remain **single-question** models, which is the property that made
the first auditable and is why it was worth preserving in the second. The rejected shape was
a `…or the caller is a service` branch inside `authz.Service.Authorize`: a viewer path with a
service escape hatch is two policies sharing one function, and nobody reading it can say which
one refused a request.

The module deliberately **exports no `Service()`** to other modules, unlike `authz`. If a
second module ever needed to ask this question, that would mean a second surface had grown
behind this credential without going through these four routes.

The credential is `GEO_TRACKER_ADMIN_TOKEN`, **the same variable name on both sides** — the
fifth secret shared across a service boundary on this platform and the first that needs no
translation table. Three of the other four differ, which is the reason rotation needs a
runbook at all. Empty is the default and means *this deployment has no data door*: the routes
still exist and answer `503 SERVICE_DOOR_NOT_CONFIGURED`, matching the webhook verifier's
posture with an empty secret, because a door that silently 404s is indistinguishable from a
build that predates it.

## D-4 · The scope model — three axes, and only one of them is configuration

This is what D-2 constraint 2 called the deliverable. *"wi-admin may read tracking data"* is a
credential that reads **any agent's trail for any reason**; the model falsifies that sentence
one clause at a time.

**Axis 1 — CAPABILITY (configurable).** A closed vocabulary, granted one scope at a time via
`GEO_TRACKER_ADMIN_SCOPES`:

| Scope | Grants | Coordinates |
|---|---|---|
| `agent:presence` | device, connection, Tracking Allow, session summaries | no |
| `agent:position` | the agent's live position | **yes** |
| `shipment:trail` | one delivery's GPS trail | **yes** |
| `shipment:events` | one delivery's tracking events + connection log | no |

Unset grants `agent:presence` **alone**. Neither obvious default was taken: everything would
make the model decoration (one variable would grant coordinates and nobody would discover it),
and nothing would make a freshly configured door answer 403 to everything, which reads as a
broken deployment rather than a policy. Presence is the one capability that emits neither
coordinates nor a trail — i.e. exactly the two things the model exists to bound. An **unknown**
scope name is fatal at boot rather than dropped: a typo that silently narrowed a grant would
surface days later as an unexplainable 403.

**Axis 2 — SUBJECT (structural, and this is the strongest bound).** Historical data is
reachable **only by naming a shipment**. There is no `/internal/agents/{id}/trail`, and no
listing endpoint of any kind — the door cannot enumerate agents, cannot enumerate shipments,
and cannot answer *"where has this person been this week"*. **A configuration mistake cannot
widen this axis**, which is why the sharpest data sits behind it. It turns a surveillance
credential into a case-file one: an investigation is always about a delivery.

The live position stays agent-scoped, because an idle agent has no shipment and *"where is
this unreachable agent"* is one of the situations an operator opens the screen for.

**Axis 3 — PURPOSE.** Any read whose scope emits coordinates must carry a `reason`
(3–200 characters); without it, `400 SERVICE_REASON_REQUIRED`. Enforced on the scope predicate
(`Scope.EmitsCoordinates`) rather than per handler, so a read added later cannot omit it, and
enforced **independently on both sides** so that neither service depends on the other's
validation for its own policy.

**Tracking Allow gates the position read, which is stricter than the viewer path.** There the
gate is upstream — jovi-mall only grants a viewer an agent they have a shipment relationship
with. A service caller has no relationship to check, so the gate is applied at the door: what
sits in Redis after a revocation is residue, not an answer. The timestamp is withheld with the
coordinates, because that an agent is currently streaming is itself part of what the opt-out
withholds.

## D-5 · O-6 answered — **yes, audited; in wi-admin, fail-closed; not in geo-tracker**

D-2's fifth constraint left this *unanswered rather than answered "no"*. The answer:

**Every coordinate-emitting read is audited** — `agents.tracking.position.read` and
`shipments.tracking.trail.read` — with the row committed **before** the read and its failure
**not caught**, so with the audit store unreachable nothing is disclosed. That is the
`money.payouts.destination.read` posture, and the reasoning transfers exactly: for a
disclosure, *"who may"* is not the interesting question, *"who did, and how often"* is. An
administrator who unmasks forty positions in an afternoon is copying a roster of people's
movements, and nothing else in this service would ever see it. The two reads that emit no
coordinates (`presence`, `events`) are **not** audited — a row per render would be the
volume-with-nothing-to-say that "reads are not actions" exists to avoid, and it would dilute
the trail the other two depend on being sparse.

**The audit lives in wi-admin**, for three reasons and the third settles it:

1. **This is where the actor is known.** geo-tracker authenticates a *service*, not a person.
   `X-Admin-Actor` reaches it and is advisory by construction, so a row written there would
   attribute a disclosure to an unverifiable string.
2. **This is where the machinery is** — retention, scoping, export, the activity feeds.
   geo-tracker would need all four built for one table.
3. **`tracking_audit` must stay written by nothing.** That table has **no retention policy of
   any kind**, and its `viewer_id` would hold a jovi-mall user id. The workspace `CLAUDE.md`
   records the consequence: anything that starts writing it inherits a retention obligation
   **and reopens `ADR-B02-CLOSED-ACCOUNT-TRAIL`**, which currently rests on geo-tracker
   holding no customer identity at all. Auditing where the human is already known avoids
   buying that, for nothing gained.

geo-tracker's half is **corroboration, not a trail**: a log line per disclosure (credential,
actor, reason, subject, whether coordinates were actually returned) and
`geotracker_service_reads_total{scope,outcome}`. Two records that should agree; a divergence
means one of them is wrong.

**No coordinates in the audit row.** It records *that* a location was disclosed, the subject,
and the stated reason — putting the values in would move a person's position into the one
store readable without the permission gating it, and the trail would become the leak.

## D-6 · Grading stays in wi-admin, and it is TWO permissions rather than one

Constraint 3 in force: geo-tracker contains no tier logic, `X-Admin-Actor` is recorded and
never consulted, and the whole administrator model stays on this side.

The door is gated by **two** permissions, not one, and the split was forced by
`assertAuditCatalogValid()` refusing a `shipments.*` audit action governed by an `agents.*`
permission. The rule was right about more than naming:

- **`agents.tracking.read`** — presence and the live position. *Live surveillance of a person.*
- **`shipments.tracking.read`** — a delivery's trail and its tracking events. *A case file.*

Two different exposures, so an operator can grant them apart — which also lines this catalog up
with geo-tracker's own scope model, where `agent:position` and `shipment:trail` are already
separate. Both are unflagged (nothing financial, nothing destructive, nothing escalating; every
route is a `GET`).

**Support (tier 3) holds both**, and that was a decision rather than a default. *"Where is my
delivery right now"* is one of the commonest things a ticket asks, and refusing it to the tier
that answers tickets escalates every one of them. **The audit in D-5 is the other half of that
decision** — widening the audience and adding the record were one choice, not two. The
credential itself is the same regardless of tier: geo-tracker sees one caller.

## D-7 · Never a readiness dependency — three layers, restated for a data door

Constraint 4 is the most expensive mistake available in this step, and the temptation is
larger here than it was for the operations door, because a data client looks like something
worth health-checking.

The rule is unchanged and the client is a second file rather than a mode of the first:

1. **`geo-tracker-data.client.ts` never throws.** Every status is a result object. A
   non-throwing client cannot propagate a geo-tracker outage into anything, however it is
   wired later — stronger than remembering not to call it.
2. **It is not in `/health/ready` or `SystemController.health`**, and `test:devtools` scans
   both for either client. That scan was **widened in this change**: it matched
   `geo-tracker\.client`, which does not match `geo-tracker-data.client`, so the new door would
   have slipped through the one pin that exists to keep it out.
3. **Failing a REQUEST is the controller's job**, not the client's — `TRACKING_DOOR_REFUSED` /
   `TRACKING_DOOR_UNAVAILABLE` / `TRACKING_DOOR_UNCONFIGURED`, three codes because three
   different people fix them. That boundary *is* the difference between failing a request and
   failing the service.

The two doors also keep **separate base-URL variables** (`GEO_TRACKER_OPS_BASE_URL` /
`GEO_TRACKER_DATA_BASE_URL`) although they usually name the same host. That is the lever that
lets a deployment take the operations reads and open no data door at all, and it keeps a data
call one variable away from ever being made with no credential.

---

## Consequences

- **Phase 6.I is unblocked** and its scope is now known: a scope model, a service-caller
  transport, and the audit question above. It was previously "do not start until Q-1 is answered
  by a person with the authority to change the architecture."
- **ADR-009 D-2 and ADR-015 D-5 are amended, not contradicted.** Their reasoning stands — the
  data door was refused *because no decision had been taken*, and Phase 15's ops door was
  designed not to be a precedent. It is not being used as one here; a separate decision was made.
- **geo-tracker source will change** for the first time on this question. Everything in the
  workspace `CLAUDE.md` about geo-tracker's authorization being "one path with one question"
  becomes stale the day it lands, and must be updated in the same change.

  ✅ **Done 2026-08-22, in this change** — the workspace `CLAUDE.md`, geo-tracker's own
  `CLAUDE.md`, its `api-doc/README.md` and this service's `agents.md` all now describe two
  authorization paths. The rule that made this a Consequence rather than a follow-up is the
  one this repository's documentation debt exists because somebody broke.
- ~~Nothing changes today. Until Phase 6.I ships, the admin surface still serves the flag, the
  verdict, the device flags and a **stale-labelled** `last_known_tracking_state`.~~

  **Superseded 2026-08-22.** The admin surface serves all of that **and** a live position, a
  presence read, a delivery's GPS trail and its tracking events. The stale mirror stays exactly
  as it was — same field, same `agents.read` gate, same `isStale` label — and answers a
  *different question*: `tracking.lastKnown` is *where were they last seen*, the new reads are
  *where are they now* and *where did this delivery go*. Do not substitute one for the other.

### Two things this deliberately did **not** do

- **`tracking_audit` is still written by nothing**, and that is now a decision with a stated
  reason rather than an accident (D-5). It keeps ADR-B02 closed.
- **Administrators still hold no jovi-mall `users` row.** The rejected alternative in D-1 stays
  rejected, and every synthetic-actor mechanism that exists because of it is untouched.

### What this changed on the far side, for the record

geo-tracker gained: one module (`serviceaccess`), five error codes, one metric
(`geotracker_service_reads_total`), two config variables, one session-domain read
(`ShipmentSessions` / `SessionRecordStore.ListForShipment`, needed because reading a delivery
rather than an agent had no entry point), and one api-doc. **No migration** — the shipment
index it queries has existed since `0005`. No existing route, event shape or webhook body
changed, so this was a **two-repo change deployed in either order**: geo-tracker's door is inert
until a token is set, and wi-admin's reads answer `configured: false` until one is.
