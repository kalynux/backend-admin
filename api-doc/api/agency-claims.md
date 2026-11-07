# Damage claims on an agency — `/api/v1/agency-claims`

🆕 2026-10-22 (owner decision F-8). Plan: `PRODUCTION-READINESS/REFUND-FEES-AND-AGENCY-LIABILITY-PLAN.md`.

A **damage claim** charges a delivery agency for **one parcel** that was damaged in delivery, and
gives the money to the **vendor**, who carried the broken goods. It is allowed only:

- **inside the agency's own window** — its damage-claim deadline counted from its parcel's delivery
  (at least 3 days when it pays returns). The problem is dated by the order's customer's first
  problem report about the order or the parcel, the refund it follows, or now;
- **up to its own limit** — its *max refund per item* × the damaged items. An agency that set no
  per-item limit cannot be claimed against.

The agency is charged the claim **plus its investigation fee**: first from its money still held for
that parcel, then its available balance, then as a debt its next earnings pay first. **Its rider is
never charged.** The vendor is credited the claim; the platform the investigation fee. **One claim per
parcel**; a claim cannot be edited or undone.

The agency reads the claim, with a sentence explaining it, on its earnings screen; the vendor reads
the credit on theirs.

| Route | Permission | Audit |
|---|---|---|
| `GET /agency-claims` — newest first. Query `agencyId?`, `vendorId?`, `shipmentId?`, `page`, `limit` | `agencies.read` | — |
| `GET /agency-claims/eligibility?shipmentId=&refundRequestId=` — can this parcel be claimed now, and its limits | `agencies.read` | — |
| `GET /agency-claims/:claimId` | `agencies.read` | — |
| `POST /agency-claims` — charge it | **`agencies.claims.charge`** (financial — tiers 1 + 2, **never Support**) | `agencies.claims.charge`, fail-closed, filed against the **agency** |

Every route is **delegated** to jovi-mall (`/api/internal/admin/agency-claims`): whether an agency owes
money is jovi-mall's rule, read against the parcel's history and the customer's reports.

## Eligibility

```jsonc
{
  "shipmentId": "…", "orderId": "…", "orderNumber": "ORD-2026-000123", "trackingNumber": "TRK-…",
  "agencyId": "…", "vendorId": "…", "currency": "XAF",
  "deliveredAt": "2026-10-20T09:00:00.000Z", "firstProblemAt": "2026-10-21T08:00:00.000Z",
  "raisedAt": "2026-10-21T08:00:00.000Z",
  "windowDays": 2, "windowEndsAt": "2026-10-22T09:00:00.000Z", "insideWindow": true,
  "maxPerItem": 5000, "investigationFee": 1000,
  "existingClaimId": null,
  "eligible": true,
  "reason": null   // not_delivered · no_agency · no_per_item_limit · outside_window · already_claimed
}
```

Show `maxPerItem × items` as the ceiling, and the investigation fee that will be added. When
`eligible` is false, say why from `reason`; `outside_window` should show `windowEndsAt`.

## Charge

```json
{ "shipmentId": "…", "itemCount": 1, "amount": 5000, "note": "Screen cracked; photos on ticket T-…", "refundRequestId": "…" }
```

| Field | Rule |
|---|---|
| `shipmentId` | The parcel |
| `itemCount` | 1–1000 damaged items |
| `amount` | Whole XAF, > 0, at most `maxPerItem × itemCount` |
| `note` | 3–1000 characters: what was damaged and how it was established |
| `refundRequestId` | Optional — the refund it follows (its opening date can start the window) |

**`201`** with the claim:

```jsonc
{
  "id": "…", "kind": "damage", "shipmentId": "…", "orderId": "…", "orderNumber": "ORD-…", "trackingNumber": "TRK-…",
  "agencyId": "…", "vendorId": "…", "refundRequestId": null,
  "itemCount": 1, "claimedAmount": 5000, "maxPerItem": 5000, "cap": 5000,
  "amount": 5000, "investigationFee": 1000, "currency": "XAF",
  "deliveredAt": "…", "raisedAt": "…", "windowDays": 2,
  "note": "…", "createdBy": { "id": "…", "name": "Alice" },
  "reasonCode": "damage_claim", "reasonParams": { … },
  "explanation": "Damage claim on order ORD-…, parcel TRK-…: 1 item(s) damaged in delivery, reported on 2026-10-21, within your 2-day damage-claim window. Your terms allow up to 5,000 XAF per item, so 5,000 XAF was charged, plus your investigation fee of 1,000 XAF.",
  "takenFrom": { "pending": 1500, "reserve": 0, "available": 0, "debt": 4500 },
  "createdAt": "…"
}
```

Refusals arrive as `PLATFORM_OPERATION_REJECTED` with `details.platformCode`:

| `platformCode` | When |
|---|---|
| `AGENCY_CLAIM_OUTSIDE_WINDOW` (422) | raised after the agency's window — `details.windowEndsAt` |
| `AGENCY_CLAIM_EXCEEDS_CAP` (422) | above `maxPerItem × itemCount` — `details.cap` |
| `AGENCY_CLAIM_EXISTS` (409) | the parcel already has a claim |
| `AGENCY_CLAIM_NOT_ELIGIBLE` (422) | not delivered, no agency, no per-item limit |
| `SHIPMENT_NOT_FOUND` (404) | no such parcel |
