# Frontend changelog — service listings (admin dashboard)

**Backend state:** branch `informational-service`, **not yet deployed**. Reference:
[api/listings.md](api/listings.md). Cross-role summary: `jovi-mall/api-doc/FRONTEND-CHANGELOG-service-listings.md`.

## The review queue (built 2026-10-22)

1. **Listings** menu under Catalog: the queue (`GET /api/v1/listings`), filter by status and
   review state. A row that is a **revision** of a live listing says so.
2. **Detail**: public fields next to the pre-flags. A **"Show hidden contacts"** button calls
   `GET /listings/:id/contacts`: say that the view is recorded. Open the video link from there.
3. **Approve**, **Reject** (1–5 reasons), **Take offline** (a note), **Put back**. Every tier may do
   all four.

## Lead reports (new, 2026-11-07)

4. A support ticket of type `LISTING_LEAD_REPORT` shows a **lead panel** from the ticket detail's
   new `listingLead` field: the listing, the customer in full (phone, e-mail, account age, roles),
   the reveals the provider named with their cost and refund state, and what the provider asked for.
5. From that panel:
   - **Refund** a reveal (`POST /listings/reveals/:revealId/refund`, a note, the ticket id). Only
     Developer and Admin hold it — hide it for Support.
   - **Block this customer on this listing** (`POST /listings/:listingId/reveal-blocks/:customerId`,
     a reason, the ticket id) and **Lift** (`DELETE …`). Every tier.
   - **Open the lead** (`GET /listings/leads/:leadId`) for the customer's other leads across
     providers — several numbers belonging to one person is the drain pattern.
6. **Leads tab** on a listing: `GET /listings/:listingId/leads`.
7. Close the ticket as usual when done; a refund or a block does not close it.
