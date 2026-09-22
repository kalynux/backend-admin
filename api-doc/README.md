# wi-admin — the API contract

⚠ **Re-counted 2026-09-14: there are 30 pages.** ADR-023 added [`api/employees.md`](./api/employees.md) and [`api/geo.md`](./api/geo.md); a concurrent change added `api/verification.md`.

**Verified against source on 2026-09-08** — the page count as it then stood (27, not 26), the mirror path (`admin-dash/api-doc/docs/`, not `api-doc/admin-internal/`) and the five dashboard suites that read the mirror by path, all re-derived from the trees themselves.

**This half of wi-admin's documentation is written for one reader: a developer building the
admin dashboard.** Everything here is a promise to a client — a path, a guard, a field, a
failure. If a behaviour is not written down in this directory, it is not promised.

`wi-admin` is the **only** service the admin dashboard talks to. It never calls jovi-mall or
geo-tracker directly: where an operation belongs to another service, wi-admin delegates on the
dashboard's behalf and returns the result in its own envelope.

> **Looking for *why* something is the way it is?** That is deliberately not here. The design
> records, the technical set and the phase plans are in [`../docs/`](../docs/). This directory
> answers *how do I call it*; that one answers *why is it like this*.

---

## Where things are

| Directory | What |
|---|---|
| [`api/`](./api/) | **The endpoint reference — 30 pages, one per surface.** Start at [`api/README.md`](./api/README.md), which carries the base URL, the envelope, authentication, CSRF, pagination and the list-query vocabulary that every other page assumes. |
| [`dashboard/`](./dashboard/) | The dashboard-facing working record: the [integration matrix](./dashboard/BACKEND-INTEGRATION-MATRIX.md), the [data-exposure register](./dashboard/DATA-EXPOSURE-REGISTER.md), the [frontend architecture assessment](./dashboard/FRONTEND-ARCHITECTURE-ASSESSMENT.md), and [`backend-requests/`](./dashboard/backend-requests/) — the request/answer channel between the dashboard team and this service. |
| [`FRONTEND-CHANGELOG-phase-2-3.md`](./FRONTEND-CHANGELOG-phase-2-3.md) | What readiness Phases 2–3 changed **for this dashboard**. |
| [`FRONTEND-CHANGELOG-phase-4-5.md`](./FRONTEND-CHANGELOG-phase-4-5.md) | What readiness Phases 4–5 changed — the largest instalment, and the one with breaking renames in it. |
| [`FRONTEND-CHANGELOG-agent-cod-pool-and-emergency-contact.md`](./FRONTEND-CHANGELOG-agent-cod-pool-and-emergency-contact.md) | 2026-09-21: the agent detail shows the **emergency contact**; the COD pool is automatic from plan × KYC; ⚠ `PUT /agents/:agentId/cod-threshold` now **requires `reason`** (it pins), with a new `…/release`; plans gain `maxCodPool`. |

## The four pages to read first

| If you are… | Read |
|---|---|
| calling anything at all | [`api/README.md`](./api/README.md) — envelope, auth, CSRF, paging |
| handling a failure | [`api/errors.md`](./api/errors.md) — the code registry, the nine categories, and what the client is allowed to show |
| hiding or showing a control | [`api/permissions.md`](./api/permissions.md) — the permission list and the grant-by-tier matrix |
| upgrading an existing screen | the `FRONTEND-CHANGELOG-*` pages above, newest last |

---

## ⚠ This directory was created on 2026-09-08 and older notes name the old path

Until that date wi-admin kept **one** folder, `docs/`, holding the ADRs *and* this contract —
so a developer opening it could not tell a promise to a client from an internal decision.
The contract moved here; the reasoning stayed. All three backends now follow one rule:
**`api-doc/` is the contract, `docs/` is the reasoning.**

A note, comment or link that names `admin/docs/api/…` or `admin/docs/dashboard/…` is describing
the layout before that split. The files are the same files — `git mv` carried their history.

**The mirror.** `admin-dash` keeps a byte copy of this directory at `api-doc/admin/`, and a copy
of [`../docs/`](../docs/) at **`api-doc/docs/`** — *not* `api-doc/admin-internal/`, which was the
pre-split name and no longer exists. **Five** admin-dash test suites read out of the mirror by
path — `error-catalog`, `notification-path`, `content-blocks`, `content-contract` and
`permissions.types` — reaching `api/errors.md`, `api/notifications.md`, `api/permissions.md` and
six mirrored source files. So **this directory's internal layout is executed, not just read**:
moving a page inside it is a source change, not a documentation one.
