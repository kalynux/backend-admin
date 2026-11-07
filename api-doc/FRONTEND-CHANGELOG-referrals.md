# Admin dashboard: the referral program

**2026-11-02 · not deployed yet · additive.** Contract: [api/referrals.md](./api/referrals.md).

## Permissions: 149 → 153, tiers 153 / 129 / 51

A new `referrals` family, and the permission list your mirror test diffs has four more rows.

| Permission | Tiers |
|---|---|
| `referrals.read` | 1 2 3 |
| `referrals.partners.decide` | 1 2 3 |
| `referrals.partners.balance` | 1 2 |
| `referrals.settings.write` | 1 |

## A new Referrals section

1. **Applications:** `GET /referrals/partners?status=pending`, with approve and reject.
2. **Partners:** search by code, phone or email, and filter by status.
3. **Partner detail:** identity, status with its history, terms, balances, referred accounts, rewards, and the verbs valid for the status.

   | Status | Verbs |
   |---|---|
   | `pending` | approve, reject |
   | `active` | suspend, terminate |
   | `suspended` | reinstate, terminate, release the balance |
   | `terminated` | allow a new application, release the balance |
   | `rejected` | allow a new application |

4. **Settings (tier 1 to edit, everyone to read):** on/off, a rate and duration per category, the minimum withdrawal, the wait. ⚠ Say beside the form that a rate reaches existing referrals on their next commission, while a duration reaches new referrals only.
5. **Per-partner terms (tier 1):** each field shows the value, whether it is custom, and a reset (sends `null`).
6. **Rewards:** the list and detail, with `onSameCommission`, and links to the order or booking.
7. **Summary:** what the program has cost, from `GET /referrals/summary`.

## Things to get right

- **Reasons are public.** The reason on a rejection, suspension or termination reaches the partner, so label the field accordingly.
- **`commissionWithheld: true` is not zero.** Below tier 1 the commission figures are `null`. Show "hidden", never 0.
- **Don't offer a way to change a referrer.** None exists, on purpose.
- **Show a frozen balance as frozen.** Use `balanceFrozen`.

## Existing screens

- **Payouts** gains the owner type `referral_partner`, named by the partner's code. A partner's ticket carries their code, how many accounts they referred, and a warning when the payout number is the phone of an account they referred.
- **Accounts** and **clawbacks** can list `referral_partner`, and its debt can be written off. A write-off has one more audit action, `money.earnings.clawback.write_off_referral_partner`.
- **Transactions** gains the ledger reasons `referral_reward`, `referral_reward_matured` and `referral_reward_clawback`, on rows whose party role is `referral_partner`.
- **Audit** gains the targets `referral_partner` and `referral_settings`, and the actions `referrals.settings.update` and `referrals.partner.*`.
- **Closing an account or a role** has a new blocker, `referral_balance`, for an account's last role while its referral wallet holds or owes money.
