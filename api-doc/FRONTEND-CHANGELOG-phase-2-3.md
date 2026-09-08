# Admin dashboard — what Phase 2 and Phase 3 changed

**Verified against source on 2026-09-08** — a dated changelog, left as history; every route and permission it names checked against the live route manifest and the permission catalog.

Your slice of Phases **2** (Deployability) and **3** (Cross-service correctness) of
[`PRODUCTION-READINESS/10-IMPLEMENTATION-PLAN.md`](../../PRODUCTION-READINESS/10-IMPLEMENTATION-PLAN.md).

- **Written:** 2026-08-21 · **Phase 2:** 2026-08-18 → 08-19 · **Phase 3:** 2026-08-19
- **Design records:**
  [`PHASE-2-DEPLOYABILITY-PLAN.md`](../../PRODUCTION-READINESS/PHASE-2-DEPLOYABILITY-PLAN.md) ·
  [`PHASE-3-CROSS-SERVICE-PLAN.md`](../../PRODUCTION-READINESS/PHASE-3-CROSS-SERVICE-PLAN.md)
- **The platform-wide half:**
  [`jovi-mall/api-doc/FRONTEND-CHANGELOG-phase-2-3.md`](../../jovi-mall/api-doc/FRONTEND-CHANGELOG-phase-2-3.md)
- **API reference, unchanged by these phases:** [api/](./api/)

---

## Short version

**No `/api/v1/*` endpoint changed** — not a path, a permission, a field, an error code or the
envelope. Phase 2 was deployability (wi-admin got an image, a volume and its own migration
ledger) and Phase 3 was the jovi-mall ↔ geo-tracker seam, which **wi-admin was not part of**:
the phase plan's own header says *"Target repos: jovi-mall and geo-tracker. wi-admin is not
touched."*

What lands on your screens is **behaviour behind endpoints you already call**.

| # | Change | Your work |
|---|---|---|
| 1 | Tracking Allow is now **transactional + reconciled every 15 min** | **Copy change** — you can finally promise the effect |
| 2 | The **database screen's permanent phantom index drift is gone** | Small — an always-red badge goes green |
| 3 | Migration state is now **answerable**, but **not over HTTP** | Backlog item, if you want it |
| 4 | Probes and the frozen `GET /api/health` | Small |
| 5 | Restart/keep-alive behaviour | Small |
| 6 | Audit exports moved to a **named volume** | None — but know why |
| 7 | Still **no geo-tracker data door** | Confirmation |

---

## 1 · `PUT /agents/:agentId/tracking` now actually holds up its end

The endpoint, the permission (`agents.tracking.set`), the payload and the audit row are all
unchanged. What changed is the reliability of the effect it promises.

**What it was.** The flag write (`DeliveryAgent.tracking.allowed`) was a **bare database write**
followed by a fire-and-forget event publish, in **no transaction at all**. And Tracking Allow was
the one event in the whole cross-service contract with **no reconciliation path of any kind** —
no retry, no sweep, no aggregate that eventually corrects it. A lost event meant an
administrator's revocation never reached geo-tracker and the agent went on streaming a live
position after being told they may not be tracked.

**What it is now.**

- The flag write and its outbox row **commit together**, in one transaction. If the event cannot
  be written, the flag does not change and your call returns an error — retry it. Previously the
  flag would have changed with the event silently lost, which looked like success and was worse.
- A new background worker **re-pushes every revoked agent every 15 minutes** as a backstop, so a
  lost event self-corrects within that window rather than never.
- It is scoped to `allowed === false` deliberately: a lost *revocation* leaves an agent streaming
  when they should not be; a lost *grant* self-heals the moment an administrator looks at it.

**What this means for the UI copy.** The effects table in
[api/agents.md § `PUT /agents/:agentId/tracking`](./api/agents.md) is unchanged and still
correct — and now it is also *dependable*:

| Effect | Holds |
|---|---|
| The live position is suppressed in geo-tracker; open sessions move to `tracking_disabled` | ✅ pushed as an event, transactionally, plus a 15-minute backstop |
| New dispatch to that agent stops | ✅ |
| Any tracking session is **closed** | ❌ — whether a delivery is over is the platform's call, and this event does not make it |
| Watchers are revoked | ❌ — they stay subscribed and receive nothing |

The confirmation dialog can now say *"the agent's live position will stop being shared"* without
a hedge. It still must **not** say *"active deliveries will be cancelled"* or *"the agency will
lose the shipment"* — neither is true, by design.

Also unchanged and still true: an **administrator's** revocation is never refused. The
`ErrTrackingAllowLocked` guard that blocks switching tracking off mid-shipment protects against
the **agent** changing their mind, which is the opposite situation.

---

## 2 · `GET /system/platform/database` no longer reports a phantom missing index

If your database screen has had a permanently red drift badge — one index reported **missing**
and a matching one reported **extra**, on `products`, forever — that was a false positive and it
is fixed.

MongoDB reports a `$text` index as the internal sentinel `{_fts: 'text', _ftsx: 1}` with the real
fields in a **sibling `weights` document, alphabetised**. So the declared schema
(`{title:'text', tags:'text', description:'text'}`) disagreed with the live shape on both the key
and its order. It is the only `$text` index in the codebase, which is why exactly one phantom
pair appeared.

Both sides are canonicalised now. The boot log reads **`index drift: none` across 88 collections
/ 353 declared indexes**.

Two things to build against:

- **Drift is now a signal.** It was safe to ignore before because it was always non-zero. If your
  screen de-emphasised it, undo that.
- **Drift is expected on a cold start**, and legitimately so. `autoIndex` is now **off in
  production** (still on in development), so a fresh database has every index missing until the
  first migration runs. Drift is logged at `warn` and deliberately **does not fail readiness** —
  gating readiness on it would deadlock a first-ever bring-up. Your screen should distinguish
  *"never migrated"* from *"drifted after migrating"*, or at least not alarm on the former.
- **Field weights on a text index are still not compared.** A re-weighted text index is a
  relevance change, not a missing constraint, and is deliberately out of scope.

---

## 3 · Migration state is answerable now — but not through an API

Phase 2 built a migration ledger in **both** Node services:

| | Collection | Runner |
|---|---|---|
| jovi-mall | `schema_migrations` | `npm run migrate:status` / `migrate:up` (`--only`, `--dry-run`) |
| wi-admin | `admin_schema_migrations` | `ensure:indexes` records its own row; `npm run migrate:status` reads it back |

Forward-only, no down migrations, checksummed, append-only, with four states — `not_applied`,
`applied`, `applied-but-changed`, `failed`. All 15 jovi-mall migrations were rehearsed, applied
and stamped against the dev database, and the ledger survived a full stack teardown and recreate.

**None of this is exposed over HTTP.** There is no `/api/v1/system/migrations`. If a "deployment
state" or "schema version" panel is wanted on the dashboard, that is a **backend request** to
open — it does not exist today, and inventing a client-side equivalent would mean reading
jovi-mall's collection directly, which the data-access model forbids for anything but a
type-enforced read.

Two design notes if you do ask for it: wi-admin deliberately got a **ledger and not a runner**
(it has one migration-shaped script; the moment it has two, order becomes a fact somebody must
declare), and migrations are run from a separate **toolbox** container image, never from the
runtime image — the runtime image cannot run one at all.

---

## 4 · Probes, and the one path that must never become a health check

| Service | Liveness (drives restart) | Readiness (drives de-pooling) |
|---|---|---|
| wi-admin | `GET /health/live` | `GET /health/ready` |
| jovi-mall | `GET /api/health/live` | `GET /api/health/ready` |
| geo-tracker | `GET /healthz` | `GET /readyz` |

`GET /api/health` on jovi-mall is a **frozen wire contract**: exact path, exact body
`{status, timestamp}`, **unconditional 200**, **no `{success, data}` envelope**, exempt from rate
limiting and from maintenance mode. It is now pinned by a test (`test:system`) rather than by a
comment — the comment claiming a test existed was, until Phase 2, false, which is precisely why
nobody had written one.

**Why you should care:** geo-tracker registers that path as a **readiness** checker and treats
any status ≥ 300 as an error. Putting readiness semantics there means a jovi-mall Redis wobble
de-pools geo-tracker and **every live WebSocket tracking session dies** — for a fault in a
service that is itself healthy (ADR-014 D-1). If your system screens surface it, label it
*reachability*, not health; it answers 200 with the database down.

The cascade was **demonstrated live** during Phase 2 rather than argued: with Mongo stopped,
`/api/health` stayed 200, both readiness probes correctly 503'd, geo-tracker's `/readyz` stayed
**200 and in rotation**, and restart counts stayed at 0 on all three containers.

`GET /api/v1/system/geo-tracker` and `/api/v1/system/geo-tracker/metrics` are **unchanged**.
Their two guarantees still hold and still matter: the path set is a closed literal, and the
client **can never throw** — making geo-tracker a readiness dependency of wi-admin would
recreate that same coupled-failure amplifier in the opposite direction.

---

## 5 · Restart behaviour

wi-admin already had `src/lifecycle.ts` — jovi-mall copied its shape. What changed for you:

- All three services now **drain on a real `SIGTERM`** and exit 0. This was proven in a
  container, which matters because Windows cannot deliver a real `SIGTERM` to a child process, so
  the handler had never been exercised anywhere.
- An accepted request **completes** rather than being truncated (budget: `SHUTDOWN_TIMEOUT_MS`,
  default 10 s).
- Idle keep-alive sockets close after **65 s**. If anything between your dashboard and wi-admin
  pools connections, keep its idle timeout below that.
- ⚠ **A latent bug was found in jovi-mall's copy of the drain and flagged, not fixed, in
  `admin/src/lifecycle.ts`:** `drain()` was re-runnable after completing, re-flushing a log sink
  into a connection the first pass had closed. jovi-mall latched it on success. wi-admin has the
  same shape and therefore the same latent behaviour. Not a dashboard concern, but if you see an
  odd shutdown log, that is the known cause.

---

## 6 · Audit exports moved to a named volume

Operational, and worth knowing because it protects a chain you surface.

`ADMIN_AUDIT_EXPORT_DIR` defaults to `./var/audit-exports` — a **container-filesystem path**
holding the durable artefacts the audit retention chain depends on. Retention is
*exported-AND-aged*: an image that loses those files leaves rows stamped `exported` with nothing
to point at.

`var/` is now gitignored, `.dockerignore`d and mounted as a **named Docker volume**, and the five
NDJSON files that were tracked in git were removed from the index. Same treatment jovi-mall's
`storage/` got, for the same reason (ADR-019 D-1a, which had named only jovi-mall's uploads).

No API change. If the dashboard ever offers a "download this export" affordance, the bytes now
live on a volume rather than inside the image.

---

## 7 · Still no geo-tracker data door — Phase 3 did not change this

Worth stating plainly, because Phase 3's headline items *sound* like they should reach you and
do not.

Phase 3 gave every watcher of a delivery an **ETA**, and made a dropped tracking subscription
report **truthfully** why it was dropped. Both live on the geo-tracker WebSocket, and **an
administrator cannot open it**: every geo-tracker data read requires a real jovi-mall user JWT
and resolves per-agent visibility by looking that user up in `users`. A wi-admin administrator
has **no `users` row**, deliberately.

So the admin surface still serves the business-side answer only — the flag, the policy verdict,
the device flags, and `last_known_tracking_state` **labelled stale**. Never a live position, a
trail, or an ETA. ADR-009 D-2 and ADR-015 D-5 stand unamended; the narrow exception remains the
three unauthenticated service-level paths in § 4.

**Q-1 — "does an administrator get to see a live position?" — was answered during Phase D:
geo-tracker gains a service-caller model, and administrators still get no `users` row.** That is
**Phase 6 work (6.I)**, not built. Its scope is a scope model, a transport and the audit
question. Do not design a live-position admin screen against these phases.

---

## 8 · Two facts about jovi-mall that change what its data means

Both are jovi-mall-side reliability fixes with no wi-admin code change, but they alter what your
delegated reads report.

**Lifecycle events can no longer be lost.** The tracking outbox now writes **inside** the
transaction that causes it, across nine write sites. Previously a crash between commit and
enqueue lost the event permanently. Any admin screen that cross-reads a shipment's status against
its tracking state should now find them consistent rather than occasionally diverged.

🔴 **The auto-confirm sweep never emitted anything, ever.** A prepaid delivery the customer never
confirmed was auto-confirmed to `delivered` — a terminal status — and geo-tracker was never told,
so the tracking session stayed open until its TTL. This is fixed. If you have ever investigated
*"why is this agent still shown as on a delivery that closed days ago"*, that was it.

---

## 9 · What explicitly did not change

- **Every `/api/v1/*` endpoint, permission, envelope and error code.**
- **The audit subsystem's fail-closed posture** and its exported-AND-aged retention.
- **The developer → admin → support error-detail ladder.** It still lives in wi-admin only, and
  jovi-mall still receives `X-Actor-Tier` and never reads it for a decision.
- **Rate limits.** Phase 2 froze the *exemption* lists with tests; no ceiling moved. The store
  still fails open on a Redis outage, which is not optional — the naive integration turns a Redis
  outage into a 500 on every request.
- **`/api/internal/admin/*` remains the only admin door into jovi-mall.** Phase 5 closed the
  public one; nothing here reopened anything.
