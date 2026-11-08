# Frontend changelog (admin dashboard) — listing reviews and provider referrals (2026-11-08)

Plan and owner decisions: `PRODUCTION-READINESS/LISTING-REVIEWS-SAVES-REFERRALS-PLAN.md`. Contracts:
[api/reviews.md](./api/reviews.md), [api/referrals.md](./api/referrals.md). No permission changes.

## 1 · Reviews: a third subject, `listing`

Customers can now review a **service listing** (once they unlocked one of its contacts).

1. **Filter:** `GET /api/v1/reviews?subjectType=listing` is accepted. Add "Service listings" to the subject
   filter.
2. **Row:** a listing review carries `listing: { id, name }` (the listing's title). `product`, `agent` and
   `agency` are null on it; `vendor.id` is the provider, and `vendor.name` is usually `null` (it is a shop
   name, and a provider has no shop). Link the listing name to the listing's screen. The row never carries
   a contact detail.
3. **`publiclyVisible`** is `true` for a published listing review (it shows on the listing's page). It does
   not check whether the listing itself is live right now.
4. Unpublish, republish and delete work exactly as for products. The provider is notified of each
   published review; nothing is sent when an administrator acts.

## 2 · Referrals: the `provider` category

A service provider referred by a partner earns that partner a percentage of the **full price** the provider
pays Wi-Mall for plans and credit packs (not a commission).

1. **Settings** (`GET` / `PATCH /api/v1/referrals/settings`): `terms.provider` beside vendor, customer,
   agency. Add a "Service providers" row to the rate and duration table.
2. **Partner terms** (`PATCH /api/v1/referrals/partners/:id/terms`): `terms.provider` too.
3. **Category filters and labels:** `category=provider`, label "Service provider", on the referred list and
   the rewards list.
4. **A provider reward** has `commissionId: null`, `commissionEarned: null`, and instead
   `paymentKind: "plan" | "credits"` and `payment: { kind, id, amountPaid }`. Show "Plan purchase" or
   "Credit pack" and the price paid where a commission reward shows its order and commission. `amountPaid`
   is visible to every tier (plan prices are public). `paymentKind` and `payment` are `null` on commission
   rewards.
5. **Reward detail:** `onSameCommission` lists the rewards on the same **payment** for a provider reward.
   Label the section from `reward.payment` ("Other rewards on this payment").
6. A reversed payment (lost dispute, completed refund) shows the reward `reversed` with its clawback in
   `adjustments` (`refundKey` like `credit_topup_reversed`).
