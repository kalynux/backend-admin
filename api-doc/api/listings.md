# Service listings — `/api/v1/listings`

A **service provider** (a vendor of kind `provider`) publishes listings whose contact details
customers unlock by tapping; the provider pays credits per unlocked contact. An administrator
publishes every listing (L-5), and works the provider's reports on suspicious leads (L-29, L-31).
Design record: `backend/PRODUCTION-READINESS/SERVICE-LISTINGS-PLAN.md` § Admin, § C-6.

Reads are direct (`listings`, `listing_contacts`, `listing_leads`, `listing_reveals`,
`listing_reveal_blocks`, `provider_contact_consents`); **every write is delegated** to jovi-mall
(`/api/internal/admin/listings/*`, `/api/internal/admin/listing-reveals/*`) and audited
fail-closed (the intent row commits before the call).

## Permissions

| Permission | Tiers | Flags | What |
|---|---|---|---|
| `catalog.listings.read` | 1 · 2 · 3 | — | the queue, a listing, its leads |
| `catalog.listings.contacts.read` | 1 · 2 · 3 | — | the hidden contacts; **every view audited before the read** |
| `catalog.listings.review` | 1 · 2 · 3 | — | approve / reject |
| `catalog.listings.suspend` | 1 · 2 · 3 | — | take offline / put back |
| `catalog.listings.reveal-block` | 1 · 2 · 3 | — | block / lift a customer on one listing |
| `catalog.listings.reveals.refund` | 1 · 2 | **financial** | refund a reveal (credits back to the provider) |

## The review queue

| Route | Permission | Audit |
|---|---|---|
| `GET /listings?status&reviewState&…` | `read` | — |
| `GET /listings/:listingId` | `read` | — |
| `GET /listings/:listingId/contacts` | `contacts.read` | `catalog.listings.contacts.read` (`external`) |
| `POST /listings/:listingId/approve` `{}` | `review` | `catalog.listings.approve` |
| `POST /listings/:listingId/reject` `{ reasons[1..5] (3–500) }` | `review` | `catalog.listings.reject` |
| `POST /listings/:listingId/suspend` `{ note (3–500) }` | `suspend` | `catalog.listings.suspend` |
| `POST /listings/:listingId/unsuspend` `{ note? }` | `suspend` | `catalog.listings.unsuspend` |

The detail carries the public fields beside the **pre-flags** (phone numbers, emails and links
found in the public text), so a reviewer can spot a contact slipped into the description; photos
are checked by eye, and the reviewer opens the video link (it plays, it shows the way, it is
appropriate). An approval with the provider below the first-reveal cost publishes the listing
straight into "paused for credits"; it comes back at the next top-up.

## Lead reports (2026-11-07)

A provider's **Report** on a lead opens a support ticket of type `LISTING_LEAD_REPORT` on entity
`LISTING_LEAD`. `GET /api/v1/support/tickets/:ticketId` then carries **`listingLead`**: the lead,
the reveals the provider named with their refund state, and what they asked for (`wants`:
`refund`, `check_customer`). A tier without `catalog.listings.read` gets the ids and wishes only.

| Route | Permission | Audit |
|---|---|---|
| `GET /listings/:listingId/leads?page&limit&sort` | `read` | — |
| `GET /listings/leads/:leadId` | `read` | — |
| `POST /listings/reveals/:revealId/refund` `{ note (3–500), ticketId? }` | `reveals.refund` | `catalog.listings.reveals.refund` (`listing_reveal`) |
| `POST /listings/:listingId/reveal-blocks/:customerId` `{ reason (3–500), ticketId? }` | `reveal-block` | `catalog.listings.reveal_block` |
| `DELETE /listings/:listingId/reveal-blocks/:customerId` `{ note? }` | `reveal-block` | `catalog.listings.reveal_unblock` |

A lead row shows what the provider **cannot** see: the customer's full phone and e-mail, when the
profile and the account were created, every role on the account, and (on the detail) the
customer's **other leads** across providers — how a drain with several numbers is spotted. Plus
the reveals (field, cost, `chargedIntoDebt`, refund), the active block, and the opt-in.

- **Refund**: credits the reveal's cost back to the provider (a `refund` ledger row,
  `listing_reveal_refund`), paying any debt first, and may bring credit-paused listings back.
  Once per reveal: a second is `409` with `details.platformCode: LISTING_REVEAL_ALREADY_REFUNDED`.
  The customer keeps the contact.
- **Block**: the customer can no longer unlock that listing's contacts; they are told only "this
  business can't be reached right now". One active block per customer and listing
  (`409 … LISTING_REVEAL_BLOCK_EXISTS`); lifting with none is `404 … LISTING_REVEAL_BLOCK_NOT_FOUND`.

jovi-mall refusals arrive as `PLATFORM_OPERATION_REJECTED` at their own status, with the original
code in `details.platformCode`.
