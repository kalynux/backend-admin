# Frontend changelog (admin dashboard) — a listing's second phone number (2026-11-08)

Contract: [api/listings.md](./api/listings.md) (§ contacts). No permission change. Not deployed yet.

A provider may now give **two phone numbers** on a listing.

1. `GET /api/v1/listings/:listingId/contacts` (permission `catalog.listings.contacts.read`, audited before the
   read, unchanged): each copy, `published` and `pending`, now carries **`phone2`**, a second E.164 number or
   `null`.
2. **Show it under the phone row**, in both copies side by side, so a reviewer judging a revision sees a second
   number added, changed or removed, the same bait-and-switch check as for the first number.
3. Both numbers are **one contact field** (`phone`): unlocked and charged together. Reveal rows, reports and
   refunds still name `phone` once; the audit row's field list says `phone` once.
4. Nothing else on the listing screens changes.
