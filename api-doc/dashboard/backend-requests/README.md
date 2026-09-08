# Backend requests

**For the `wi-admin` backend team.** One document per thing the dashboard was asked to build and
cannot, or can only build half of, against the contract as it stands today.

Companion to the two registers already in this folder:

| Document | What it records |
|---|---|
| [`BACKEND-INTEGRATION-MATRIX.md`](../BACKEND-INTEGRATION-MATRIX.md) | Every endpoint the dashboard uses, and the gap register `D1`–`D12` |
| [`DATA-EXPOSURE-REGISTER.md`](../DATA-EXPOSURE-REGISTER.md) | What the API provides that perhaps it should not, or should provide differently |
| **this folder** | What the API does **not** provide that an operator has asked for |

Opened 2026-08-17, from a round of operator requests across eleven screens. **Three rounds have run
since**, and every one of them is closed — see the index below.

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
- **Delegated failures carry a second code.** A refusal from jovi-mall is
  `PLATFORM_OPERATION_REJECTED` at jovi-mall's original status, with jovi-mall's own code in
  `details.platformCode`. Every request below states whether it expects to be delegated.
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
