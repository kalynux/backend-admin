# Referral program: `/api/v1/referrals`

Partners earn a percentage of the vendor commission Wi-Mall earns on accounts they referred. Reads come
straight from the shared database; every write is delegated to jovi-mall and audited fail-closed.

| Permission | Tiers | What |
|---|---|---|
| `referrals.read` | 1 2 3 | Settings, partners, referred accounts, rewards |
| `referrals.partners.decide` | 1 2 3 | Approve, reject, suspend, reinstate, terminate, allow a new application |
| `referrals.partners.balance` | 1 2 | Release a suspended or terminated partner's frozen balance (financial) |
| `referrals.settings.write` | 1 | Global and per-partner rates and durations, and switching the program on or off (financial) |

## Settings

### `GET /referrals/settings`

```json
{
  "enabled": false,
  "terms": {
    "vendor": { "ratePercent": 3, "durationMonths": 6 },
    "customer": { "ratePercent": 3, "durationMonths": 6 },
    "agency": { "ratePercent": 3, "durationMonths": 6 },
    "provider": { "ratePercent": 3, "durationMonths": 6 }
  },
  "minPayoutAmount": 1000,
  "rewardWaitDays": 14,
  "updatedAt": null,
  "updatedBy": null
}
```

The program starts **off**. While it is off nobody can apply, no code is honoured, and commissions earned
pay nothing, even after it is switched on again.

### `PATCH /referrals/settings`

Any subset. Rate 0 to 25, up to two decimals; duration 1 to 120 whole months.

```json
{ "enabled": true, "terms": { "customer": { "ratePercent": 2 } } }
```

Say this on the screen, because the two behave differently:

- **A rate** applies to the next commission, on referrals that already exist too. Rewards already earned never change.
- **A duration** applies to new referrals only. An existing referral's end date never moves.

## Partners

### `GET /referrals/partners`

`?status=&search=&page=&limit=&sort=-appliedAt`. `search` matches the start of a code, phone or email.
`status` is `pending` · `active` · `rejected` · `suspended` · `terminated`, so `?status=pending` is the
applications queue.

```json
{
  "id": "…", "userId": "…", "name": "Ulrich Mbarga", "phone": "+237…", "email": null,
  "appliedAsRole": "customer", "status": "active", "code": "ULRICH123",
  "appliedAt": "…", "approvedAt": "…",
  "balances": { "currency": "XAF", "pending": 630, "available": 2100, "requested": 0, "clawback": 0 }
}
```

### `GET /referrals/partners/:partnerId`

The row above plus:

```json
{
  "motivation": "I know many shops",
  "termsAcceptedAt": "…",
  "statusReason": null,
  "canReapply": false,
  "balanceFrozen": false,
  "balanceReleased": null,
  "terms": {
    "vendor": { "ratePercent": 5, "rateIsCustom": true, "durationMonths": 6, "durationIsCustom": false }
  },
  "referred": { "referred": 12, "earning": 9 },
  "history": [{ "from": "pending", "to": "active", "at": "…", "by": "Ada Admin", "reason": null }]
}
```

No payout destination appears here: reading one is the audited act on the payout queue
(`GET /money/payouts`, with `ownerType=referral_partner`).

### `GET /referrals/partners/:partnerId/referred`

`?category=&page=&limit=&sort=-registeredAt`.

```json
{
  "id": "…", "partnerId": "…", "userId": "…", "name": "Carine N", "phone": "+237…",
  "category": "customer", "codeUsed": "ULRICH123", "channel": "whatsapp",
  "registeredAt": "…", "expiresAt": "…", "earning": true, "totalEarned": 420
}
```

### `GET /referrals/partners/:partnerId/rewards`

The reward list below, for one partner.

### Decisions

Each answers `{ partner, result }` with the fresh detail, and the message says what happened.

| Route | Permission | Body |
|---|---|---|
| `POST /partners/:id/approve` | `referrals.partners.decide` | `{ reason? }` |
| `POST /partners/:id/reject` | `referrals.partners.decide` | `{ reason }` |
| `POST /partners/:id/suspend` | `referrals.partners.decide` | `{ reason }` |
| `POST /partners/:id/reinstate` | `referrals.partners.decide` | `{ reason? }` |
| `POST /partners/:id/terminate` | `referrals.partners.decide` | `{ reason }` |
| `POST /partners/:id/allow-reapply` | `referrals.partners.decide` | `{}` |
| `POST /partners/:id/release-balance` | `referrals.partners.balance` | `{ reason }` |
| `PATCH /partners/:id/terms` | `referrals.settings.write` | `{ terms: { vendor: { ratePercent: 5, durationMonths: null } } }` |

⚠ **The reason on a rejection, suspension or termination is shown to the partner**, on their page and in the WhatsApp message or email.

A verb from the wrong status answers `409` with `details.platformCode: REFERRAL_PARTNER_STATUS_CONFLICT`.

What each one means:

- **Suspend:** no new rewards for that period, even after reinstating. The link keeps working, but people who use it register normally and are not referred. The balance is frozen. Earned rewards stay recorded. A payout already waiting is not cancelled: its ticket gets a note.
- **Terminate:** the same, permanently, unless an administrator allows a new application. The person keeps the same code if approved again.
- **Allow a new application:** the only way back for a rejected or terminated person.
- **Release a balance:** lets a suspended or terminated partner withdraw. Reinstating clears it.
- **Per-partner terms:** `null` returns a field to the global value, and each field stands alone.

There is no way to change who referred whom. That is deliberate.

## Rewards

### `GET /referrals/rewards`

`?status=&category=&orderId=&bookingId=&from=&to=&page=&limit=&sort=-earnedAt`.

```json
{
  "id": "…", "partnerId": "…", "relationshipId": "…", "referredUserId": "…", "referredName": "Carine N",
  "category": "customer", "sourceType": "order", "orderId": "…", "bookingId": null, "vendorId": "…",
  "commissionId": "…", "commissionWithheld": false, "commissionEarned": 7000,
  "sharePercent": 100, "ratePercent": 3, "rateSource": "global",
  "amount": 210, "clawedAmount": 90, "remaining": 120, "currency": "XAF",
  "status": "released", "earnedAt": "…", "availableFrom": "…", "releasedAt": "…", "reversedAt": null,
  "adjustments": [{ "at": "…", "refundKey": "…", "commissionRetained": 4000, "amountBefore": 210, "amountAfter": 120 }]
}
```

⚠ **`commissionEarned` and `commissionRetained` are amounts of what the platform earned, so they stay at
tier 1** (`money.earnings.platform.read`). Below it they are `null` and `commissionWithheld` is `true`. Don't
render that as zero.

`sharePercent` is 100 except on a prepaid order with two agencies, where each agency's partner earns on its
share by parcel value.

🆕 **A provider reward (2026-11-08, jovi-mall RS-3).** `category: "provider"` is a service provider, who earns
their partner a percentage of the **full price** they pay Wi-Mall for a plan or a credit pack, not a commission:

```json
{
  "category": "provider", "sourceType": "credit_topup", "orderId": null, "bookingId": null,
  "commissionId": null, "commissionWithheld": false, "commissionEarned": null,
  "paymentKind": "credits", "payment": { "kind": "credits", "id": "…", "amountPaid": 3000 },
  "sharePercent": 100, "ratePercent": 3, "amount": 90, "status": "held"
}
```

`paymentKind` is `plan` | `credits` | `null` (null on a commission reward); `payment` is null on a commission
reward. A plan's price is public, so `payment.amountPaid` is shown to **every tier**. A reversed payment (a lost
card dispute, or a completed refund) claws the whole reward back. Filter with `?category=provider`.

### `GET /referrals/rewards/:rewardId`

`{ reward, onSameCommission: [...] }`: this reward and every other referred account that generated one on the
same commission — or, for a provider reward (2026-11-08), on the same payment (`reward.payment` says which).

## Summary

### `GET /referrals/summary`

`?from=&to=`, on when rewards were earned.

```json
{
  "rewards": [{ "currency": "XAF", "status": "released", "amount": 2100, "count": 10 }],
  "partners": { "pending": 2, "active": 14, "suspended": 1 }
}
```

`amount` is net of refunds. This is what the program costs Wi-Mall. It is reported here and is never taken
off the commission rows, so `GET /money/earnings/platform` still shows the whole commission, and statements
and order splits are unaffected.

## Money screens

- `GET /money/payouts?ownerType=referral_partner` lists partners' withdrawals, owner named by code, handled like any other payout.
- `GET /money/earnings/accounts?ownerType=referral_partner` lists their wallets.
- A partner's debt appears on `GET /money/earnings/clawbacks`, and `POST /money/earnings/clawbacks/referral_partner/:id/write-off` forgives it.
- Their ledger rows appear on `/money/transactions` with the reasons `referral_reward`, `referral_reward_matured` and `referral_reward_clawback`.
