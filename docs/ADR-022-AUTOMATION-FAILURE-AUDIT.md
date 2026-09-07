# ADR-022 — Auditing the automation layer's failures

**Date:** 2026-09-07
**Status:** Accepted and **IMPLEMENTED** — built the same day
**Scope:** wi-admin, n8n (the automation layer), jovi-mall (one redaction-parity line only)
**Amends:** nothing. It **adds** the first inbound service caller wi-admin has ever had, which
ADR-002's identity model did not anticipate.

---

## Context

On 2026-09-07 a customer messaged the bot on both channels while jovi-mall was down. Telegram
produced a graceful "I cannot reach the service right now"; WhatsApp produced **silence**.

The proximate cause was mundane: the Meta access token behind `wi-mall-wa-adapter`'s and `wi-mall-core`'s
Graph credential had expired, Meta refused the send with `OAuthException` code 190, and the token
was replaced. What the incident actually exposed is two things nobody could see:

1. **All three n8n executions were recorded `success`.** Not one of them reported anything.
2. **Nobody would have found out.** There is no surface anywhere in the platform on which an
   administrator can see that the customer bot is failing.

The first is not an n8n defect and not a bug in the workflows. `wi-mall-core` carries **fifteen
error-swallowing nodes** — every HTTP node sets `neverError: true`, and `sync identity`,
`AI Agent` and `hand to bargainer` use `continueErrorOutput` — because the design goal is that a
customer always gets an answer. The workflow is *built* never to fail. It succeeded at what it was
designed to do while the platform behind it was down.

The consequence is the decisive input to this design:

> **Execution status is not a failure signal on this platform.** A monitor keyed on
> `status = 'error'` would have shown a clean board through the entire incident.

---

## D-1 · Decision — push, not pull

wi-admin does **not** poll n8n's public API. n8n reports to wi-admin.

Pull was the initial recommendation and it was rejected by the owner. Both directions were
weighed:

| | pull (`GET /api/v1/executions?status=error`) | push (Error Trigger → wi-admin) |
|---|---|---|
| storage | none | a collection, and a retention policy it then owes |
| inbound door | none | **the first this service has had** |
| durability | bounded by n8n's own pruning | outlives it |
| soft failures | invisible | **reportable** |

The last row is what settles it. A pull surface can only ever report what n8n itself considers a
failure, and n8n considers almost nothing on this platform a failure. Push lets the workflow say
*"I succeeded and it still went badly"* — the exact statement the incident needed and no status
field can carry.

The costs are real and are paid explicitly in D-3 and D-4.

---

## D-2 · The two kinds, and why one would not do

`execution_failed` — n8n's Error Trigger fired; the run died. Rare by construction, and made
meaningful again by D-6.

`degraded_turn` — the run **succeeded** and the customer still got a worse answer than they
should have, because a fallback branch ran. Reported explicitly from inside `wi-mall-core`,
because nothing in n8n's data model records it.

Collapsing these into one kind would lose the distinction an operator most needs: whether the
automation layer broke, or whether it correctly absorbed something else breaking. During the
incident every row would have been the second kind.

---

## D-3 · The inbound door — a new access kind, not a reuse

`POST /api/internal/automation/failures`, guarded by `AUTOMATION_REPORT_TOKEN`.

Three structural choices, each rejecting an easier option:

**It is not on `/api/v1`.** That prefix is the versioned contract the dashboard consumes, and its
defining property is that every route on it resolves to an administrator with a tier. Keeping the
machine door outside it makes "nothing on the versioned surface is reachable without an
administrator" true by construction rather than by a check somebody can get wrong later.

**It is not `publicRoute()`.** `PUBLIC_ROUTE_ALLOWLIST` earns its value from being readable as
*exactly what the world can reach*. A credentialed endpoint listed there would make that list
lie. A new `RouteAccess` kind — `serviceToken()` — with its own `SERVICE_ROUTE_ALLOWLIST` keeps
both lists true, and lets `test:automation` assert the service kind is used exactly once.

**It is not a branch inside `authenticate.middleware.ts`.** This is geo-tracker's `serviceaccess`
reasoning applied here: a caller path with a service escape hatch is two policies sharing one
function, and nobody reading it can say which one refused a request. The guard sets **no
`req.admin`** — nothing downstream may treat a machine as a person.

### The boundary, stated so the next request can be measured against it

> A service route may only **write** something the machine observed about **itself**. It may never
> read platform data, because there is no tier to grade the answer by.

That is why the read half is `/api/v1/automation` behind three permissions rather than a second
verb on this door.

---

## D-4 · An unconditional TTL, against the standing rule

This service is deliberately hostile to TTLs. `approval-request.model.ts` refuses one outright —
*"a TTL would quietly erase the record of an attempt"* — and `admin_audit_log` has one only behind
a partial filter making every deletion traceable to an exported file.

`admin_automation_failures` has a plain TTL (`ADMIN_AUTOMATION_RETENTION_DAYS`, default 30). The
justification is not that the rule is inconvenient; it is that **neither reason applies**:

- the approval rule protects the record of an **attempt by a person**. There is no person.
- the audit rule guarantees a deleted row survives in a durable export. **Nothing consumes these
  rows** — no export, no compliance obligation, no reconciliation. They exist to be read on a
  dashboard within days of the failure they describe.

⚠ **If that ever stops being true — if anything begins reconciling against these rows — this
decision has to be revisited in the same change.** That is the obligation `ADR-B02` places on
geo-tracker's `tracking_audit`, and it applies here for the same reason.

### This is not the audit trail, and must not become it

`admin_audit_log` is *"the append-only record of every administrator action"*, written
`w: 'majority', j: true`. A failure report has no actor. A row there would have to invent one, and
an invented actor in an audit trail is worse than an absent row: it makes the trail's central
claim false. `POST /api/internal/automation/failures` is therefore `noAudit()` and allowlisted,
and `test-audit.ts` now asserts that an allowlisted machine door genuinely declares
`serviceToken()` — so `/api/internal/` cannot become a prefix anybody uses to skip the trail.

---

## D-5 · The customer identifier is hashed, and the digest is never emitted

A degraded-turn report knows which customer it happened to. Storing a Telegram chat id or a
WhatsApp phone number in the clear would put a customer identifier into a collection with no
disclosure controls, reachable by tier 3, purely as a side effect of monitoring a machine.

`external_id_hash` is a salted SHA-256 — salted with `AUTOMATION_REPORT_TOKEN`, because an
unsalted digest of an E.164 number is reversible by hashing the number space. It keeps the one
property an operator needs (*is this one customer ten times, or ten customers once?*) and gives up
the one nobody needs.

**The digest never leaves the projection**, at any tier. Handing hashes out would let a caller
correlate a customer across every report. `summary` computes the distinct count server-side, which
is the only question the hash exists to answer.

---

## D-6 · Making failures real in n8n — and the one node where `neverError` is now wrong

`neverError: true` is correct where a 4xx body carries `error.customerMessage` **and its own
`reply`**, so the failure renders itself. That is true of every jovi-mall bot-surface node and it
stays.

It is **false** of `send telegram` and `send whatsapp`. Their 4xx comes from Telegram or Meta,
carries no customer copy, and has nothing downstream to render it. There, `neverError` bought only
invisibility — a green execution for a message nobody received. Both now fail properly.

Expect **two rows for one incident**, and they are both true: a send node throwing inside
`wi-mall-core` kills the sub-workflow, which fails the adapter's Execute Workflow node
(`waitForSubWorkflow: true`), so the adapter reports as well. The idempotency key is scoped per
workflow so both survive; what it collapses is one workflow reporting one execution twice, which
is what an n8n retry produces.

### The reporters must never break the flow they report on

`report outage` and `report agent down` carry `neverError: true` **and**
`onError: continueRegularOutput` — the exact option rejected two paragraphs above, for the
opposite reason. Those two carry a customer's message; these carry a report *about* a failure. A
wi-admin outage must not cost a customer their reply.

They are positioned **below and right of** their fallback sibling on the canvas, because n8n's v1
execution order follows position: the customer's reply is composed and sent first. Their timeout
is **3s**, not 20s — during a correlated outage every second here is added latency on a message
somebody is waiting for.

---

## D-7 · Two new permissions, because one is not expressible

The ladder mirrors `/system/errors` exactly — one route, three answers, `anyPermission` on the
route and the projection deciding what each rung gets.

| Rung | Permission | Sees |
|---|---|---|
| 1 Developer | `developer_tools.logs.read` *(reused)* | everything, stack included |
| 2 Admin | `system.automation.read` *(new)* | workflow, node, message, timing |
| 3 Support | `support.automation.lookup` *(new)* | that a channel is degraded, and when |

**One name for all three rungs is not expressible.** The stack trace is raw internal state, which
belongs to `developer_tools` — and `assertGrantTableValid()` refuses that family to any tier but 1
at boot. That constraint is the whole reason this needs two new names.

The **family is the enforcement mechanism**, not the name: `allInFamily('system')` puts the Admin
name in tier 2, `allInFamily('support')` puts the Support name in tier 3, and strict nesting
carries both upward. Neither is flagged sensitive — a flag would make `allInFamily()` skip it, and
the route would 403 for every caller while looking correct.

**Support is included deliberately.** "The bot did not reply to me" is a ticket, and an agent who
cannot see that the automation layer was degraded escalates it to somebody who knows less about it
than they do — the same argument that put `agents.tracking.read` on that grant. What they are
denied is machine detail, which on a support call is not a secret so much as a false lead.

Unlike the error journal there is **no per-row filter and no query narrowing for tier 3**. Both
exist there because the subject is a customer's failed request. The subject here is a machine.

---

## D-8 · Coverage is an allowlist, and it will drift

The reporter is wired as the `errorWorkflow` on **nine** workflows: `wi-mall-core`,
`wi-mall-tg-adapter`, `wi-mall-wa-adapter`, `wi-mall-typing`, `wi-mall-mcp`, `wi-mall-bargain`,
`wi-mall-bargain-tools`, `wi-mall-vectoriser`, `wi-mall-product-search`.

Not wired: `wi-mall-flow` (superseded), the dev harnesses, unrelated automations on the instance,
and — deliberately — **the reporter itself**, which would loop a wi-admin outage.

Every workflow belonging to this backend now carries the `wi-mall-` prefix; the two adapters were
renamed on 2026-09-07 (they were `tg-adapter` / `wa-adapter`). The prefix is not cosmetic here —
`workflow_name` travels on every report, so a failure row now identifies its owner without a
lookup against an instance that also hosts unrelated automations.

⚠ **`wi-mall-typing` is the one whose reports mean the least, and it was wired anyway.** Every
node in it already carries `onError: continueRegularOutput`, so a failure there is nearly
impossible and a typing indicator is a garnish. It costs nothing — `errorWorkflow` changes no
execution behaviour — and the alternative is a permanent hole in the allowlist that reads as
coverage. The one thing to watch is its `executionTimeout: 180`: if the ping loop ever exceeds
that it will produce a genuine `execution_failed` per turn, which would be noisy rather than
wrong. Its own caps (Telegram 20 × 4 s, WhatsApp 5 × 20 s) sit below the timeout, so this should
not fire.

⚠ **A new wi-mall workflow is invisible until somebody sets its `errorWorkflow`.** This is the
same cost `GEO_TRACKER_METRIC_ALLOWLIST` pays, written down here rather than discovered during an
incident.

---

## Consequences

- **wi-admin has an inbound service caller.** The next integration will want to use it; D-3's
  boundary is what to measure that request against.
- **`AUTOMATION_REPORT_TOKEN` is a new shared secret**, and the first whose other side is not one
  of the three backends. Same name on both sides. Nothing compares the two values, so a mismatch
  is silent — and it surfaces as failure reports that **stop arriving**, which looks exactly like
  nothing failing. `docs/RUNBOOK.md` § Rotation.
- **The door is inert when unset**, on both sides: 503 `AUTOMATION_DOOR_UNCONFIGURED` inbound, and
  `configured: false` on the reads. A deployment with no automation layer is supported.
  `configured: false` matters most on an empty summary, which otherwise cannot be told from
  "nothing failed".
- **A jovi-mall outage produces one degraded-turn row per inbound message.** Small, TTL'd, and
  accepted. The rate limiter is a backstop and fails open (ADR-016).
- **jovi-mall was touched once**, to add the header name to `core/audit/redact.ts` — the drift
  test asserting the two redaction lists agree is only worth having if it is kept exact.
