# Admin dashboard: account statements and a summable activity feed (2026-09-27)

**Audience:** admin-dash. Contract: [api/accounts.md](./api/accounts.md#post-accountsownertypeowneridstatements--account-statement)
and [api/errors.md](./api/errors.md).

## 1. New: `POST /api/v1/accounts/:ownerType/:ownerId/statements`

This generates a vendor's, agency's or agent's **full statement** for a period, as **Excel or PDF**.
You can download it, or **email it to the account holder**. The statement contains:

- orders, with payment date, method and who paid;
- every fee: delivery, commission, COD and bargain;
- products at listed, floor and final price;
- the delivery timeline, agency and agent;
- when cash-on-delivery money reached the platform, and who confirmed it;
- refunds, payouts, credits and plans.

- **Permission:** `money.statements.send`. **Every tier holds it, Support included.**
- **Body:** `{ from: "YYYY-MM-DD", to: "YYYY-MM-DD", format: "xlsx" | "pdf", delivery: "download" | "email" }`, strict. The range is at most 366 days and both days are included.
- **Download:** the response is **the file itself**, not JSON. Read it as a blob and save it using `Content-Disposition`.
- **Email:** the response is `{ delivery, fileName, sent, recipient, bytes }`. `recipient` is masked, for example `j***@example.com`.
- **There is no recipient field.** The platform sends only to the account's registered, **verified** email.
- **Refusals to handle** (for each one, offer the download instead):
  - `409` with `details.platformCode = STATEMENT_RECIPIENT_MISSING` (no email on file)
  - `409` with `details.platformCode = STATEMENT_RECIPIENT_UNVERIFIED` (email not verified)
  - `413 STATEMENT_TOO_LARGE_TO_EMAIL` (the file is over 8 MB)
  - `400 VALIDATION_ERROR` (bad dates or a range longer than a year)
- **Audited:** every request appears on the owner's activity feed as `money.statements.send_vendor`, `_agency` or `_agent`.

## 2. Changed: `GET /api/v1/accounts/:ownerType/:ownerId/activity`

`direction` can now be **`internal`**, for money moving between the owner's own balances: an
`earning_release`, a COD reserve move, or a payout that is pending, rejected or failed. Before this
change a release was `in`, which counted every earning twice, and every payout was `out`.

## 3. Work to do in admin-dash

- [ ] **"Statement" button on the account page** (vendor, agency and agent). It opens a form with a date range, a format and a delivery method.
  - Handle the blob download and the masked-recipient confirmation.
  - Map the three refusals above to "no verified email, download instead" and "too large, download or shorten the period".
- [ ] **Show the button to every tier.** Gate it on `money.statements.send`.
- [ ] **Permission vocabulary +1:** add `money.statements.send` to the local permission mirrors (`permissions.types`, route map, and any test pinning the count).
- [ ] **Audit vocabulary +3:** add `money.statements.send_vendor`, `money.statements.send_agency` and `money.statements.send_agent` to any action-label map. Suggested label: "Sent account statement".
- [ ] **Error-code mirror:** add `STATEMENT_TOO_LARGE_TO_EMAIL`.
- [ ] **Account activity feed:** leave `internal` rows out of totals and render them muted. Update the type to `direction: 'in' | 'out' | 'internal'`.
