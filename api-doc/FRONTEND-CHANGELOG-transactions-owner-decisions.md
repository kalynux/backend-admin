# Frontend changelog — the owner's decisions on transactions (2026-10-15)

**Not deployed yet.** Answers BR-030. Contract: [`api/transactions.md`](api/transactions.md),
[`api/money.md`](api/money.md#the-platforms-own-amounts-are-tier-1-only-2026-10-15-br-030--3),
[`api/permissions.md`](api/permissions.md).

## ⚠ One breaking change, for tier 2 only

`GET /money/earnings/platform`, `…/platform/ledger` and `…/platform/summary` now need
**`money.earnings.platform.read`**, held by tier 1 alone. An Admin gets
`403 AUTHZ_PERMISSION_DENIED`, `details.required: ["money.earnings.platform.read"]`. The dashboard
already shows that screen to Developers only, so nobody's screen changes. Gate it on the
permission and drop `developerOnly`.

## Additive

- **Two transaction kinds:** `cod_collection` (a customer paying cash at the door, `cash`,
  `internal`, every tier) and `earnings_adjustment` (a debt write-off or a payout-driven recovery,
  `internal`, tiers 1–2).
- **Two `links` keys on every row:** `agentId`, `payoutId`. 12 keys now.
- **Two `record` shapes** on the detail read, one per new kind.
- **New reason codes:** `cod_order_payment`, `cod_delivery_fee`, `debt_write_off`,
  `debt_recovered_from_payout`.
- **The order split** carries `platformAmountsWithheld`. When `true` (tiers 2–3), the platform's
  amounts are `null` and each touched line, basis block and adjustment has `withheld: true`. Read
  `withheld`; on this route a bare `null` means "not known yet".
- **The permission vocabulary** moves 142 → **143**, tiers **143 / 120 / 47**.

## Checklist

- [ ] Re-copy `transaction.dto.ts`; give the two kinds a label, a family and a `record` section
- [ ] Show `links.agentId` and `links.payoutId`
- [ ] Re-copy `permissions.md`; `money.earnings.platform.read` in the permission types
- [ ] Platform-earnings nav entry gated on the permission; remove `developerOnly`
- [ ] `OrderMoneySplitPanel`: read `platformAmountsWithheld` / `withheld`, not the caller's level
- [ ] The Transactions *"not on this list"* note: remove both sentences, add the one rare case the page names
