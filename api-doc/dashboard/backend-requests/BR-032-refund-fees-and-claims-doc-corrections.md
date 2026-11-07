# BR-032 · Three doc gaps left by the 2026-10-22 round (delivery pause, refund fees, damage claims)

**Opened 2026-10-25. Status: ✅ ANSWERED 2026-11-01 — [`RESPONSE-2026-11-01-BR-032-033.md`](RESPONSE-2026-11-01-BR-032-033.md). Documentation only — no code, no wire change.**

Found while building the two 2026-10-22 changelogs
([`FRONTEND-CHANGELOG-delivery-pause.md`](../../FRONTEND-CHANGELOG-delivery-pause.md),
[`FRONTEND-CHANGELOG-refund-fees-and-claims.md`](../../FRONTEND-CHANGELOG-refund-fees-and-claims.md))
against the pages copied from `backend/admin/api-doc` at `439bfb2`. Measured the same day against
`backend/admin`: `npm run authz:matrix` printed **144 / 121 / 47** and `dump-routes.js` printed
**`TOTAL 320`** (319 routes), so the source is right in every case below — only the pages lag it.

---

## 1 · `permissions.md` — no matrix row for `agencies.claims.charge` (blocks a green suite)

The new note at the top of [`permissions.md`](../../api/permissions.md) says *"144 permissions,
tier totals 144 / 121 / 47 … `agencies.claims.charge` (financial, tiers 1 + 2, never Support)"*,
and the level table says `144 of 144` · `121 of 144` · `47 of 144`. But the `### agencies` matrix
still has six rows and no `agencies.claims.charge`, so the page's own matrix enumerates 143.

**Ask:** add the row under `### agencies`, after `agencies.cod.restrict`. From
`permission.catalog.ts` and `tier-grants.ts`:

```
| `agencies.claims.charge` | write | ● | ● | · | financial | Charge a damage claim to a delivery agency for a parcel damaged in delivery, up to its own per-item limit (2026-10-22) |
```

**Why it matters here:** the dashboard's `permissions.types.test.ts` diffs its permission list
against the matrix rows and checks the prose against the counted rows. Two assertions are red on
exactly this — *"declares every documented permission, and no others"* (`agencies.claims.charge`
is declared here, taken from source) and *"states the same counts in prose that its matrix
enumerates"* (143 rows against a stated 144). We do not change the test to match a page; both go
green when the corrected page is re-copied.

---

## 2 · `refunds.md` — the eligibility example puts the two fees one level too high

The worked JSON under `GET /refunds/eligibility` shows:

```jsonc
"attributionPreview": {
  …
  "feeAmount": 238, "netAmount": 5762,
  "paymentFee": 120, "transferFee": 118,     // ← here
  "byReasonKind": { "cancellation": { …, "paymentFee": 120, "transferFee": 118 }, … }
}
```

jovi-mall's `RefundEligibilityDto` (`payments/services/refund-eligibility.service.ts`) declares
`paymentFee` / `transferFee` **only on each `byReasonKind` row** (`AttributionPreviewRow`); the
`attributionPreview` object itself carries `feeAmount` and `netAmount` and no split. wi-admin
passes the shape through unchanged, so the two top-level keys never arrive.

**Ask (either):** remove the two keys from the `attributionPreview` level of the example — or, if
they were meant to be there, add them to `attributionPreview` in jovi-mall and keep the example.

**What the dashboard does:** reads the split from `byReasonKind[<selected reason>]`, which is
present in both readings. Nothing breaks either way; the ask is so the next reader is not misled.

---

## 3 · `audit.md` — the three new actions are not in its catalogue

`audit.catalog.ts` gained `agencies.claims.charge` (target `agency`),
`money.earnings.pause_shipment` and `money.earnings.resume_shipment` (target `shipment`).
[`audit.md`](../../api/audit.md) names none of them. (It already lacked the refund and
categories actions — see the earlier rounds — so this may be better done as one re-derivation
from the catalogue than as three rows.)

**What the dashboard does:** the agency feed offers `agencies.claims.charge` as a filter (its
`?action=` enum is every `agencies.*` action); the shipment feed labels the two pause actions but
does not offer them as filters, because that feed's enum is `shipments.*` only and an offered one
would be a `400`.

---

## Acceptance

- [ ] `permissions.md` has an `agencies.claims.charge` row: `write`, ● ● ·, `financial`
- [ ] `refunds.md`'s eligibility example and jovi-mall's DTO agree on where `paymentFee` / `transferFee` sit
- [ ] `audit.md` lists `agencies.claims.charge` and `money.earnings.{pause,resume}_shipment`

## What the dashboard does meanwhile

Everything in both changelogs is built and nothing on screen waits on this. Two tests in
`permissions.types.test.ts` stay red until the corrected `permissions.md` is re-copied.
