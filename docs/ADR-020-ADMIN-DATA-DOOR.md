# ADR-020 — The administrator's door into geo-tracker data

**Date:** 2026-08-18 (evidence gathered 2026-08-17)
**Status:** Accepted — the *position* is decided; the design is Phase 6.I
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
- Nothing changes today. Until Phase 6.I ships, the admin surface still serves the flag, the
  verdict, the device flags and a **stale-labelled** `last_known_tracking_state`.
