# wi-admin — internal documentation

**Verified against source on 2026-09-08** — the 21 `ADR-*.md` in this folder (`ls docs/ADR-*.md`),
the permission total (**118**, `npm run authz:matrix`) and every anchor in the topic table against
the headings it points at. ADR-022 was missing from the decision table and the count read *twenty*;
five anchors were repointed after this round's heading corrections.

**Written 2026-09-06 from source** (DOC-PROGRAM Phase 2 · decision E-4). Every number and claim on
these pages was read out of `src/` or `scripts/`, or produced by a runnable check named where it is
used. Where a figure disagreed with an existing document, the measurement won and the disagreement
is filed in [`../../DOC-PROGRAM/03-FINDINGS.md`](../../DOC-PROGRAM/03-FINDINGS.md).

⚠ **This folder was split on 2026-09-08, and half of what older notes place here has moved.**
It used to hold the ADRs *and* the API contract in one directory, which meant a developer opening it
could not tell which pages described a promise to a client and which recorded an internal decision.
The contract half — `api/`, `dashboard/` and the two `FRONTEND-CHANGELOG-*` pages — now lives in
[`../api-doc/`](../api-doc/), so all three backends follow one rule: **`api-doc/` is the contract,
`docs/` is the reasoning.** A note that names `admin/docs/api/…` is describing the old layout.

**What stays here is everything a client of this service does not need**: the design records, the
technical set, and the phase plans. If you are building a screen, you want
[`../api-doc/`](../api-doc/) instead.

| Layer | Where | Answers |
|---|---|---|
| **Wire contract** | [`../api-doc/api/`](../api-doc/api/) | *How do I call it?* |
| **Technical record** — how it is built, what must not break | **the six pages below** | *How does it work?* |
| **Decision records** | the 21 `ADR-*.md` beside this file | *Why is it like this?* |
| **Dashboard-facing** — requests, integration matrix | [`../api-doc/dashboard/`](../api-doc/dashboard/) | *What does the admin-dash need?* |
| **Orientation** | [`../README.md`](../README.md), [`./IMPLEMENTATION-BLUEPRINT.md`](./IMPLEMENTATION-BLUEPRINT.md) | *Where do I start?* |

⚠ **The ADRs are cited from everywhere, never absorbed, and they must not be moved.**
[`../../CLAUDE.md`](../../CLAUDE.md), `admin-dash`'s mirror and roughly fifty links point at their
current paths — which is exactly why the 2026-09-08 split moved the *other* half and left these
where they were. They are also long for a reason: almost every one records *why* a decision went the
way it did, usually with the failure that forced it, and **a summary keeps the rule and loses the
reason.**

---

## The fifteen topics, and where each is answered

| Topic | Here | Deeper |
|---|---|---|
| Architecture | [ARCHITECTURE.md § 1](./ARCHITECTURE.md#1--three-layers-two-databases-one-composition-root) | [ADR-002](./ADR-002-TARGET-ARCHITECTURE.md) |
| Module layout | [ARCHITECTURE.md § 2](./ARCHITECTURE.md#2--twenty-three-modules) | — |
| APIs · endpoints · request/response schemas | [ARCHITECTURE.md § 3](./ARCHITECTURE.md#3--the-route-surface--240-routes-and-none-of-them-is-registered-by-hand) | [`./api/`](../api-doc/api/), [ADR-005](./ADR-005-API-CONTRACT.md) |
| Authentication and authorization | [CONTRACTS.md § 1](./CONTRACTS.md#1--authentication--a-revocable-server-side-session) · [§ 2](./CONTRACTS.md#2--authorization--118-permissions-granted-by-tier) | [ADR-003](./ADR-003-GRANULAR-PERMISSIONS.md) |
| Business rules | [CONSTRAINTS.md](./CONSTRAINTS.md) | the ADRs, per domain |
| Database interactions | [DATA.md § 1](./DATA.md#1--two-connections-and-only-one-of-them-can-be-written) | [ADR-001](./ADR-001-DATA-ACCESS-MODEL.md), [ADR-004](./ADR-004-DOMAIN-OWNERSHIP.md) |
| Redis usage | [DATA.md § 3](./DATA.md#3--redis--three-reserved-indices-one-of-them-deliberately-unused) | — |
| Events | [CONTRACTS.md § 5](./CONTRACTS.md#5--events-and-notifications) | [ADR-013](./ADR-013-NOTIFICATIONS.md) |
| Webhooks | [CONTRACTS.md § 6](./CONTRACTS.md#6--webhooks) | [ADR-015](./ADR-015-DEVELOPER-TOOLS.md) |
| Error handling | [CONTRACTS.md § 7](./CONTRACTS.md#7--errors--88-codes-nine-categories-and-the-tier-ladder) | [ADR-016](./ADR-016-ERROR-SYSTEM.md) |
| Validation rules | [CONTRACTS.md § 8](./CONTRACTS.md#8--validation) | [ADR-005](./ADR-005-API-CONTRACT.md) |
| External services | [OPERATIONS.md § 2](./OPERATIONS.md#2--external-services--three-clients-none-of-which-may-ever-throw) | [ADR-020](./ADR-020-ADMIN-DATA-DOOR.md), [ADR-021](./ADR-021-ADMIN-MEDIA-LIBRARY.md) |
| Background jobs | [OPERATIONS.md § 1](./OPERATIONS.md#1--background-work--exactly-one-scheduled-job) | [ADR-013](./ADR-013-NOTIFICATIONS.md) |
| Configuration / environment | [OPERATIONS.md § 3](./OPERATIONS.md#3--configuration--53-variables-all-53-in-the-schema) | [`../.env.example`](../.env.example) |
| Service-to-service communication | [CONTRACTS.md § 9](./CONTRACTS.md#9--service-to-service) | [`../../CLAUDE.md`](../../CLAUDE.md) |
| Implementation constraints | [CONSTRAINTS.md](./CONSTRAINTS.md) | — |
| **Audit** (a sixteenth, and this service's centre of gravity) | [DATA.md § 2](./DATA.md#2--the-audit-store) | [ADR-006](./ADR-006-AUDIT.md), [ADR-012](./ADR-012-AUDIT-COMPLETION.md) |

Deployment, rollback and secret rotation are answered **outward**, at
[`../../docs/RUNBOOK.md`](../../docs/RUNBOOK.md) and
[ADR-019](../../docs/ADR-019-RELEASE-SHAPE.md) — they span all three services, so a per-service copy
would be three copies of one procedure. (Note ADR-019 is the one ADR in this numbering that lives at
the workspace root rather than in this folder, because it is not wi-admin's decision.)

## The twenty-one decision records

| ADR | Decides |
|---|---|
| [001](./ADR-001-DATA-ACCESS-MODEL.md) | read `jovi_mall` directly, write only through its internal API |
| [002](./ADR-002-TARGET-ARCHITECTURE.md) | the three-service shape |
| [003](./ADR-003-GRANULAR-PERMISSIONS.md) | granular permissions in code, granted by tier |
| [004](./ADR-004-DOMAIN-OWNERSHIP.md) | who owns which domain, and the synthetic actor |
| [005](./ADR-005-API-CONTRACT.md) | the envelope, the list query, the vocabulary |
| [006](./ADR-006-AUDIT.md) · [012](./ADR-012-AUDIT-COMPLETION.md) | the audit subsystem and its completion |
| [007](./ADR-007-USER-MANAGEMENT.md) · [008](./ADR-008-VENDOR-MANAGEMENT.md) · [009](./ADR-009-DELIVERY-NETWORK.md) · [010](./ADR-010-ORDERS-AND-SHIPMENTS.md) · [011](./ADR-011-ACCOUNTS-AND-FINANCE.md) | the domain phases |
| [013](./ADR-013-NOTIFICATIONS.md) | notifications, and the projector |
| [014](./ADR-014-SYSTEM-OPERATIONS.md) | the operations surface — **and the frozen `/api/health`** |
| [015](./ADR-015-DEVELOPER-TOOLS.md) | developer tools, and the operations door into geo-tracker |
| [016](./ADR-016-ERROR-SYSTEM.md) | the error system, shared across all three services |
| [017](./ADR-017-PHASE-17-CLOSEOUT.md) | the legacy port close-out |
| [018](./ADR-018-DASHBOARD-BACKEND-REQUESTS.md) | the dashboard's backend requests |
| [020](./ADR-020-ADMIN-DATA-DOOR.md) | the **data** door into geo-tracker — a second, separate door |
| [021](./ADR-021-ADMIN-MEDIA-LIBRARY.md) | the media library, and who builds a file URL |
| [022](./ADR-022-AUTOMATION-FAILURE-AUDIT.md) | the n8n automation failure board — **and why a `success` execution is not evidence the bot worked** |
| [023](./ADR-023-ADMINISTRATOR-EMPLOYEE-RECORD.md) | the staff employment record, and the `pending` account — **and why this one DOES grade, where the applicant module deliberately does not** |

⚠ **ADR-022 was absent from this table until 2026-09-08**, and the count read *twenty*. It landed
on 2026-09-07, the day after this page was written from source. ADR-023 landed on 2026-09-14 and was added to the table in the same change. There are now **22**
`ADR-*.md` files in this folder (019 is the workspace-root exception noted above, and 019 is not
among them).

---

## The one-paragraph version

wi-admin is the backend the **administration dashboard** talks to, and it is a different kind of
service from the other two: it owns almost no domain logic. **94.6 % of admin behaviour already
exists in jovi-mall**, so wi-admin *delegates over HTTP* rather than reimplementing — it **reads the
shared `jovi_mall` database directly** and **writes only through jovi-mall's internal API**
(ADR-001), a rule made structural by a base repository that **has no write method to call**. What it
owns outright, in its **own private Mongo database**, is the things administrators must not share
with the platform: **identity** (administrators hold no `users` row anywhere), **118 granular
permissions granted by tier** (2026-09-08 — `npm run authz:matrix`, and the figure moves every
phase), **114 catalogued audit actions**, four-eyes approvals, feature flags and notifications. Its centre of gravity is the audit trail, and that is why it **refuses to start
against a standalone `mongod`**: an audited write is a state change and its audit row committing
together, and without transactions the service would degrade to *"audited, probably"* while looking
perfectly healthy.
