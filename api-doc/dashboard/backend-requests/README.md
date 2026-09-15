# Backend requests

**Amended 2026-09-15** — **round six** added (BR-024 · BR-025 answered, BR-026 open), and the `details.platformCode` bullet below reversed for **429**: it now arrives on a forwarded rate-limit refusal. 403 is unchanged and that asymmetry is now deliberate — see [`RESPONSE-2026-09-15.md`](RESPONSE-2026-09-15.md).

**Verified against source on 2026-09-09** — the four-round index and its close-out links; the platform-rules list, whose `details.platformCode` bullet was corrected for the 403/429 allowlist against `admin/src/core/errors/detail-policy.ts:132-176`; the multipart narrowing and the four `†` permissions, both re-derived from source; and every route the folder names, checked against the live route manifest.

**For the `wi-admin` backend team.** One document per thing the dashboard was asked to build and
cannot, or can only build half of, against the contract as it stands today.

Companion to the two registers already in this folder:

| Document | What it records |
|---|---|
| [`BACKEND-INTEGRATION-MATRIX.md`](../BACKEND-INTEGRATION-MATRIX.md) | Every endpoint the dashboard uses, and the gap register `D1`–`D12` |
| [`DATA-EXPOSURE-REGISTER.md`](../DATA-EXPOSURE-REGISTER.md) | What the API provides that perhaps it should not, or should provide differently |
| **this folder** | What the API does **not** provide that an operator has asked for |

Opened 2026-08-17, from a round of operator requests across eleven screens. **Five more rounds
have run since**, and every request in them is closed **except BR-026**, which is open — see the
index below. ⚠ This sentence read *“three more rounds … every one of them is closed”* until
2026-09-15, when it was two rounds behind and about to be three: a count in prose beside the list
it counts is exactly the drift this folder exists to catch elsewhere.

The dashboard keeps a **verbatim copy** of this folder and is read-only on that side. Nothing there
edits it; corrections to the contract belong upstream and get re-copied. ⚠ **The copy was
re-shaped on 2026-09-08 when this repository split `docs/` into `api-doc/` (the contract) and
`docs/` (the reasoning).** Older notes in this folder that say `docs/admin/api/…` or
`docs/admin/docs/…` are describing the layout before that split; the contract now lives at
`admin/api-doc/`, mirrored in the dashboard at `api-doc/admin/`, and the design records at
`admin/docs/`, mirrored at `api-doc/docs/`.

---

## The index

### Round one — opened 2026-08-17, from a pass over eleven built screens

| # | Request | Blocking screen | Frontend state |
|---|---|---|---|
| [BR-001](BR-001-party-credential-recovery.md) | Send a login link or password-reset link to a user, vendor, agency or agent, over email / WhatsApp / Telegram | Users → *Edit login details*, and the equivalent on three other directories | **Nothing built.** No endpoint exists to build against |
| [BR-002](BR-002-earnings-accounts-projection.md) | `meta.totals` and an owner name on `GET /money/earnings/accounts` | Accounts | Ships a page-scoped, per-currency subtotal and an id |
| [BR-003](BR-003-last-known-location-naming.md) | A place name and an accuracy on `tracking.lastKnown` | Agents → Tracking | Ships coordinates and a Google Maps link-out |
| [BR-004](BR-004-contract-administration.md) | A read for one contract, and a decision on administrative writes | Agencies → Roster · Agents → Agencies | Ships the full terms read-only; only `transfer` is offered |
| [BR-005](BR-005-product-detail.md) | `GET /vendors/:vendorId/products/:productId` with image, stock, price and storage charge | Vendors → Catalogue | Ships the 13 list fields in an expandable card |
| [BR-006](BR-006-agency-name-on-contract-rows.md) | `agency.businessName` on `GET /agents/:agentId/contracts` | Agents → Agencies | Resolves the name client-side, one request per distinct agency |
| [BR-007](BR-007-subscription-owner-view.md) | An owner-scoped subscription read | Billing → Subscriptions | Groups the current page client-side |
| [BR-008](BR-008-vendor-policy-exposure.md) | The vendor's commercial terms, not four booleans | Vendors → Terms | Ships the four booleans and says what is missing |
| [BR-009](BR-009-log-entry-detail.md) | `GET /audit/legacy/:id`, and a declared shape for platform log entries | Audit → Legacy · Dev tools → Logs | Expands the row it already holds |

One operator ask produced no request: **Money → Allocations** turned out to be complete —
`GET /money/earnings/allocations/:allocationId` exists and is fully rendered. What was missing there
was the pager, which is now always on screen.

**Answered:** [`RESPONSE-2026-08-17.md`](RESPONSE-2026-08-17.md).

### Round two — opened 2026-08-24, from reading backend source while building

Not operator asks. Every one of these came out of the dashboard reading wi-admin's source and
finding a contract page that disagreed with it.

| # | Request | Answered in |
|---|---|---|
| [BR-010](BR-010-filedetail-url-and-access.md) | `FileDetail` declares `url: string` and omits `access` entirely | [`RESPONSE-2026-08-24.md`](RESPONSE-2026-08-24.md) |
| [BR-011](BR-011-admin-image-viewing.md) | Administrators can see no private image anywhere in the platform | [`RESPONSE-2026-08-24.md`](RESPONSE-2026-08-24.md) |
| [BR-012](BR-012-documentation-corrections.md) | Two contract pages disagree with the service they describe | [`RESPONSE-2026-08-24.md`](RESPONSE-2026-08-24.md) |
| [BR-013](BR-013-permission-count-prose.md) | `permissions.md`'s prose counts were not re-counted when `files.content.read` landed | [`RESPONSE-2026-08-25.md`](RESPONSE-2026-08-25.md) |
| [BR-014](BR-014-content-wire-shapes.md) | `/content` publishes no response shapes, and the one hint in the docs is misleading | [`RESPONSE-2026-08-25.md`](RESPONSE-2026-08-25.md) |

⚠ **BR-010's answer has since been overtaken.** `access` was confirmed in 2026-08-24 as a closed
set of two; `quota_blocked` is a third value and is live in both services. The current contract is
[`files.md`](../../api/files.md), not that response.

### Round three — opened 2026-08-25, from an operator pass over eight detail screens

| # | Request | Answered in |
|---|---|---|
| [BR-015](BR-015-media-library.md) | A media library, and an upload path for administrators | [`RESPONSE-2026-08-26.md`](RESPONSE-2026-08-26.md) |
| [BR-016](BR-016-names-on-reference-rows.md) | Six places that return an id where an operator needs a name | [`RESPONSE-2026-08-26.md`](RESPONSE-2026-08-26.md) |
| [BR-017](BR-017-order-and-shipment-item-media.md) | Product images and titles on order and shipment items | [`RESPONSE-2026-08-26.md`](RESPONSE-2026-08-26.md) |
| [BR-018](BR-018-vendor-agency-connections.md) | A vendor's delivery-agency connections, as rows rather than counts | [`RESPONSE-2026-08-26.md`](RESPONSE-2026-08-26.md) |
| [BR-019](BR-019-contract-clarifications.md) | Four things the contract leaves undecided that a client now has to decide | [`RESPONSE-2026-08-26.md`](RESPONSE-2026-08-26.md) |

### Round four — opened 2026-09-09, from building the `/automation` module

| # | Request | Answered in |
|---|---|---|
| [BR-020](BR-020-automation-summary-tier-projection.md) | `/automation/summary` discloses to Support exactly what `/automation/failures` withholds from them | [`RESPONSE-2026-09-09.md`](RESPONSE-2026-09-09.md) |

**The answer is (a): the asymmetry is intended and the sentence justifying it was false.** No wire
change — re-copy [`automation.md`](../../api/automation.md) and keep the nav decision. Of the four
rounds this is the first where a request found **two contract pages disagreeing with each other**
rather than a page disagreeing with the service, and the first raised *before* anything was
rendered on the strength of it.

### Round five — opened 2026-09-09, from Phase 6 **live verification** against a running `:8033`

| # | Request | Answered in |
|---|---|---|
| [BR-021](BR-021-credential-link-throttle-ordering.md) | The credential-link throttle is not counted on the attempt, and `users.md` says it is | [`RESPONSE-2026-09-12.md`](RESPONSE-2026-09-12.md) |
| [BR-022](BR-022-list-query-strictness-is-not-uniform.md) | "Every list endpoint silently drops an unrecognised query parameter" is not true of all of them | [`RESPONSE-2026-09-12.md`](RESPONSE-2026-09-12.md) |
| [BR-023](BR-023-quota-blocked-content-route.md) | `files.md` says the content route will not serve a `quota_blocked` file. It serves it | [`RESPONSE-2026-09-12.md`](RESPONSE-2026-09-12.md) |

**All three were right, and all three are the same bug: a sentence that was checkable, false and
load-bearing.** This is the first round found by **measuring against a running service** rather than
by reading, and it is the round that justifies the method — BR-023 had already been implemented six
surfaces deep and shipped before the wire contradicted it.

- **BR-021 → (c), neither option offered.** The two rate-limit counters bound different things and
  wanted opposite orderings, so they are now spent at different points. A **behaviour change**, and
  the only one in this round: a refused channel now costs the *administrator's* allowance and not
  the *party's*.
- **BR-022 → scoped, and the strict set is 12 routes, not the 2 they measured.** Stated now in
  [`api/README.md` § Filtering](../../api/README.md) and pinned by a new suite,
  `test:list-strictness`.
- **BR-023 → corrected, wording adopted nearly verbatim.** `quota_blocked` is a *publishing* state:
  the cap withholds the address, not the bytes.

---

### Round six — opened 2026-09-14, from building two screens against backend *source*

| # | Request | Answered in |
|---|---|---|
| [BR-024](BR-024-party-verification-evidence.md) | Three shipped verdict endpoints show a reviewer nothing to reach a verdict from | [`RESPONSE-2026-09-15.md`](RESPONSE-2026-09-15.md) |
| [BR-025](BR-025-admin-phone-verification.md) | Three shipped `/auth` routes are on no contract page, and a 429 loses its `platformCode` | [`RESPONSE-2026-09-15.md`](RESPONSE-2026-09-15.md) |
| [BR-026](BR-026-activation-split-reaches-wi-admin.md) | The 2026-09-15 activation split has to reach wi-admin before the dashboard can act on it | [`RESPONSE-2026-09-15-BR-026.md`](RESPONSE-2026-09-15-BR-026.md) |

**Both answered requests were right about the gap, and both were partly stale by the time they
were read** — BR-024 was shipped the same day it was written, and two of BR-025's four behaviours
were fixed hours before it was filed, by a concurrent session neither side knew about. That is new,
and it is the cost of a fast channel rather than an argument against one.

- **BR-024 → already shipped**, and the half it got right is the half that was kept: *the backend
  grades nothing.* ⚠ **Two of its acceptance boxes sat unticked for a day** because the answer was
  written about the routes and stood in for the whole document — both were page defects, both are
  now closed (`verification.md`'s error table, `agencies.md`'s two missing `kyc` members).
- **BR-025 → both asks done.** § 1 is a new section in [`auth.md`](../../api/auth.md); § 2 is the
  one **behaviour change** in this round.
- ⚠ **`platformCode` now survives a forwarded 429** — reversing what this README and
  [`errors.md`](../../api/errors.md) both said, verified, on 2026-09-08. **403 was deliberately not
  changed**, and the asymmetry is now the decision: pinned by `test:contract` § 11 in *both*
  directions.
- ⛔ **BR-025 § 3 rested on a false premise**, and it is worth knowing outside the phone flow:
  administrator phone verification does **not** "self-heal when the template is approved" — Meta
  will not let that template be created at all. The fix is an account matter, not a code one, and
  there is a manual in-window workaround that works today.

---

## The rules every request inherits

Stated once here so no document repeats them. All from
[`admin/api-doc/api/README.md`](../../api/README.md) and
[ADR-005](../../../docs/ADR-005-API-CONTRACT.md).

- **Wire fields are `camelCase`.** Both databases are `snake_case`; the translation happens in
  wi-admin and must not leak. Two places it already does — agency `policies` and contract
  `terms.employment` / `terms.remittance` / `terms.feeSplit` — are noted where relevant.
- **Envelope.** Success `{ success: true, data, meta?, message? }` with `data` always present. Error
  `{ success: false, requestId, error: { code, message, statusCode, category, details? } }`. The
  client branches on `error.code`, never on `message`. `details` is *omitted* when absent.
- **Delegated failures carry a second code — except at 403.** A refusal from jovi-mall is
  `PLATFORM_OPERATION_REJECTED` at jovi-mall's original status, with jovi-mall's own code in
  `details.platformCode`. The boundary filters `details` by **category**, and `authorization` (403)
  is the one category with a closed key allowlist that `platformCode` is not on — so it does
  **not** arrive on a forwarded 403. Everywhere else it does.
  ⚠ **This bullet said "403 and 429" from 2026-09-08 until 2026-09-15**, when BR-025 § 2 argued
  that a published error code is no more sensitive at 429 than at 502 and `platformcode` was added
  to the `rate_limit` allowlist. **403 was deliberately left as it was** — a 403 is the one place
  where naming what refused tells a caller what to go after next — so the asymmetry between the two
  is now a decision rather than a leftover, and `test:contract` § 11 pins it in **both** directions.
  See [`errors.md`](../../api/errors.md) § What travels in `details`.
  Every request below states whether it expects to be delegated.
- **Every mutation is audited before it answers**, in the same transaction. Any new write needs a
  catalogued action name, and it must appear in `GET /audit/actions`.
- **Every new error code must be added to [`errors.md`](../../api/errors.md).** The dashboard's
  `src/i18n/error-catalog.test.ts` parses that file and diffs it against
  `src/i18n/locales/en/errors.ts`, where `codes` is `Record<KnownErrorCode, string>` — a code with no
  copy is a **compile error**, and a code in the registry with no entry in `errors.md` fails the
  suite. Ship the two together.
- **A new permission must leave the `†` list.** The dashboard's `RoutedPermissionName` excludes the 4
  catalogued-but-unrouted permissions, and `src/types/permissions.types.ts` is diffed against
  [`permissions.md`](../../api/permissions.md) by a test. Naming a `†` permission in a nav item
  or a gate does not compile.
- **Pagination.** `page` ≥ 1, `limit` default 20 and hard max 100 everywhere, no `?limit=all`.
  `meta = { total, page, limit, pages }` and an empty list reports `pages: 0`.
- **Money is a plain number in the account currency** (default `XAF`), never minor units to divide.
- **`202` is not an error.** A queued dual-control action answers `202` with an approval id.
- **`404` is the denial for out-of-scope records**, not `403`.
- ⚠ **~~No multipart bodies anywhere.~~ NARROWED 2026-08-25 to "wi-admin never *parses* one"**
  ([ADR-021](../../../docs/ADR-021-ADMIN-MEDIA-LIBRARY.md) D-2). `POST /files/upload` pipes the raw
  body through to jovi-mall **unread** — no multer, no busboy, no new dependency. The **1 MB limit
  does not apply there**: it belongs to `express.json`, which is content-type gated and never sees
  the request, so the route declares `ADMIN_UPLOAD_MAX_BYTES` (**32 MiB**) instead. **Every other
  route still accepts no multipart body**, so an image ask is still an ask for *ids plus a
  resolution route* unless it is genuinely an upload — and now one of those can be granted.

## What each document contains

1. **The ask**, in the operator's words.
2. **What exists today**, quoting the contract line that says so.
3. **What the dashboard does in the meantime**, so nobody has to read the source to find out.
4. **The proposed contract** — path, permission, request, response, error codes.
5. **Acceptance**, as a list a reviewer can tick.
