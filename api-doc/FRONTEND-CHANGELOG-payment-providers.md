# Admin dashboard — switching payment aggregators, and `provider` on the money pages

> **Date:** 2026-09-30 · **Status:** ✅ merged — wi-admin `9a58e3f` (the switch), `b276810`
> (`provider` on billing reads), `08d32e2` (standing `errors`); jovi-mall up to `39254e2`. Live
> after the next deploy, **jovi-mall first** · **Audience:** the admin dashboard · **Breaking:**
> nothing on the wire. One **new screen** (developer tier only), two **new permissions**, and new
> nullable fields on the money reads.
>
> The contract pages: [`api/dev-tools.md` § `GET /dev-tools/payments`](./api/dev-tools.md#get-dev-toolspayments) and
> [§ `PUT`](./api/dev-tools.md#put-dev-toolspayments) (the full shapes; this page does not repeat them) ·
> [`api/money.md`](./api/money.md) · [`api/permissions.md`](./api/permissions.md) · jovi-mall's
> [`payments/routing.md`](../../jovi-mall/api-doc/payments/routing.md) (the rules the screen
> enforces) · the other apps' side:
> [jovi-mall `FRONTEND-CHANGELOG-payment-providers.md`](../../jovi-mall/api-doc/FRONTEND-CHANGELOG-payment-providers.md).

| # | Change | Kind |
|---|---|---|
| 1 | A **Payments** screen in developer tools switches the collection aggregator, the payout aggregator, Stripe, and each provider | new screen |
| 2 | `developer_tools.payments.read` / `developer_tools.payments.set`, **tier 1 (developer) only** | new permissions |
| 3 | Payment transactions, top-ups, plan purchases gain a nullable **`provider`**; payout requests gain **`transferGateway`** | new fields |
| 4 | `gateway` values are no longer a closed list | type change |

---

## What changed on the platform

Customers and businesses now choose a **provider** (`MTN`, `ORANGE`; `MOOV` and `CARD` exist and
are off). The **aggregator** that moves the money (NotchPay, My-CoolPay, Stripe; later Campay,
Flutterwave) is chosen by the platform, and **an administrator switches it at runtime** from this
dashboard. No app release is needed. That is the whole point of the change: an aggregator outage
becomes a settings write, not a rebuild of five apps.

## 1. The Payments screen (developer tools)

`GET` / `PUT /api/v1/dev-tools/payments`. Request and response shapes live in
[`api/dev-tools.md`](./api/dev-tools.md); this section is what the screen has to do with them.

**Available even when developer tools are switched off.** Like maintenance mode, this switch
bypasses the `dev_tools.enabled` flag (it is an emergency lever). Do not hide the screen behind
the dev-tools "enabled" state; hide it only behind `developer_tools.payments.read`.

**Show, from the `GET`:**

- **The current settings**: collection aggregator, payout aggregator, Stripe on/off, and each
  provider's on/off, with **who changed it, when, and why** (`updatedBy`, `updatedAt`,
  `reason`). All three are `null` when the platform is still on its defaults.
- **Each aggregator** (`aggregators[]`): whether it is configured, which providers it can collect
  and how (its capability matrix), whether it can pay out, whether it is active for collections or
  payouts. Only offer a switch to an aggregator whose `configured` is `true`.
- **What customers see right now** (`effectiveProviders`): the same list `GET /api/payments/options`
  serves. Show it prominently. A provider that is *enabled* but missing from this list is
  enabled-but-unroutable, and that difference is what an operator needs to notice.
- **Standing problems, in two classes** (`errors[]` and `warnings[]`, always both present). They
  describe the settings **as they stand now**, checked against the live configuration each time
  you load the screen. They are **not** the warnings returned by the last write: credentials can
  be removed after a switch, and whether an aggregator can pay out is a runtime fact.
  - **`errors` → a red banner at the top of the screen: "Payments are broken".** The stored
    settings now break a hard rule (for example `COLLECTION_AGGREGATOR_NOT_CONFIGURED`, after the
    active aggregator's credentials were removed). **New charges are being refused right now.**
    Name each problem and the control that fixes it; this is the state an operator must act on.
  - **`warnings` → a yellow note.** Soft problems on otherwise working settings
    (`PROVIDER_UNROUTABLE`, `PAYOUT_UNAVAILABLE`, `CARD_UNROUTABLE`, `NO_MOBILE_PROVIDER_ENABLED`…).
    Payments work; something the operator may not intend is true.
  - **When `errors` is non-empty, `warnings` is `[]`.** The check stops at the first class, since
    nothing soft matters until the hard problem is fixed. So an empty yellow note under a red
    banner does not mean "no warnings", only "not checked yet".
  - Each item is `{ code, message, provider?, aggregator? }`. **The codes are an open set**: render
    an unknown `code` by its `message`, in the class it arrived in.
  - wi-admin passes both keys through as they are, and each defaults to `[]`. Against a jovi-mall
    older than this split, `errors` is therefore `[]` even if something is broken; the screen
    cannot tell those two cases apart. (jovi-mall 0b58bb7, wi-admin 08d32e2; pinned by
    `test:admin-payment-settings` and `test:devtools`.)
- **Recent outcomes per aggregator** (`stats`), to help decide whether to switch (failover is
  manual by owner decision). They come on **this same `GET`**, over `?window=24h` (default) or
  `7d`: per aggregator `total`, `succeeded`, `failed`, `pending`, `stuckPending` (pending for over
  30 minutes, a settlement that never came), `successRate` and `lastSuccessAt`, broken down per
  source (payments, top-ups, plan purchases) with settle-time percentiles. Two readings to get
  right: **`successRate: null` means nothing was decided in the window, not 0%**, and
  **`lastSuccessAt: null` means none in the window, not "never"**. Field by field:
  [`api/dev-tools.md`](./api/dev-tools.md#get-dev-toolspayments). (`GET /api/v1/system/integrations`
  only gains a flag saying which aggregator is active; it carries no outcome stats.)
- **If jovi-mall itself is unreachable, the whole read fails** (`502`/`503`
  `SERVICE_DEPENDENCY_UNAVAILABLE`), stats included, on purpose: no half-screen to decide from.

**The write (`PUT`):**

- **Partial**: send only what changes. `providers` merges per provider.
- **`reason` is required** and non-empty. It is audited, and it is shown to the next operator.
  Prompt for it in the confirm dialog ("NotchPay outage, moving collections to My-CoolPay").
- **Refusals arrive as `PLATFORM_OPERATION_REJECTED`** (jovi-mall's verdict, relayed). Branch on
  **`details.platformCode`**, not on `error.code`:

  | Status | `details.platformCode` | Meaning |
  |---|---|---|
  | 409 | `PAYMENT_SETTINGS_VERSION_CONFLICT` | Someone else switched first |
  | 422 | `PAYMENT_SETTINGS_INVALID` | A hard rule was broken; `details.errors[]` lists them |
  | 422 | `NOT_FOUND`, with `details.platformSupported: false` | jovi-mall predates payment routing (below) |

- **`expectedVersion` is required**: send the `version` you loaded (`0` when there is no document
  yet). On the version conflict, reload, show what changed, and let the operator decide again.
  Never auto-retry the write.
- **On `PAYMENT_SETTINGS_INVALID`**, `details.errors[]` lists each broken rule as
  `{ code, message, provider?, aggregator? }` (an open list of codes). Show every one, next to
  the control it concerns. The hard rules (full list in routing.md): the collection aggregator
  must be registered, configured, not Stripe, and, when any mobile provider is enabled, able to
  serve at least one of them; Stripe can only be turned **on** when it is configured; the payout
  aggregator must be able to send payouts.
- **Success** returns `previous`, `settings`, `changed`, `warnings` and `convergenceSeconds`.
  (A write never leaves standing `errors`: a hard-rule failure refuses the write instead.) Show
  the write's warnings (e.g. `PROVIDER_UNROUTABLE`: "ORANGE is enabled but the new aggregator can't
  serve it, so customers won't see it") and tell the operator that every server applies the
  change within **`convergenceSeconds`** (5 s).

**Two things the screen must make obvious**, because an operator acting in an outage will not
read the docs:

- **A switch affects new payments only.** A payment already opened stays on the aggregator that
  opened it: it verifies, settles, refunds and takes its OTP there. So after switching away from a
  failing aggregator, its pending payments still depend on it.
- **Switching every mobile provider off is allowed, and it stops mobile money everywhere.** It is
  the deliberate "stop taking mobile money" lever. The write succeeds with the warning
  **`NO_MOBILE_PROVIDER_ENABLED`**, and every app then shows "online payment unavailable" (unless
  cards are on). Give it its own, louder confirmation, and show the warning after the write.
  That is different from `COLLECTION_AGGREGATOR_NO_ENABLED_PROVIDER`, the hard error: it fires
  only when **at least one** mobile provider is enabled and the chosen aggregator can serve
  **none** of them.

## 2. Permissions

| Permission | Tier | Grants |
|---|---|---|
| `developer_tools.payments.read` | 1 (developer) only | the screen, read-only |
| `developer_tools.payments.set` | 1 (developer) only | the write. Audited as `developer_tools.payments.set`, target type `payment_settings`, **fail-closed**: if the audit store is down, the write is refused |

The permission vocabulary grows by two, **125 → 127** (tier totals 127 / 105 / 39, measured with
`npm run authz:matrix` at `08d32e2`). Tiers 2 and 3 are unchanged. Re-copy `api/permissions.md`
and expect the dashboard's permission-mirror suites to move with it (see the bot-memory-reset
instalment for how that looks).

**Against a jovi-mall older than payment routing** (deploy order: jovi-mall first, so this is a
transient state): the `GET` answers **`200` with `platformSupported: false`**, `settings: null`,
empty `aggregators` and `warnings`, and `stats` still filled in. Render it as **"deploy jovi-mall
first"**, never as an empty configuration. A `PUT` answers `422 PLATFORM_OPERATION_REJECTED`
with `details.platformCode: "NOT_FOUND"` and `platformSupported: false`: nothing was switched.
It is a `422` rather than a `503` on purpose, so the message survives the error boundary.

## 3. The money pages: `provider` beside `gateway`

Payment transactions, credit top-ups and plan purchases gain **`provider`** (`MTN` · `ORANGE` ·
`MOOV` · `CARD`, or **`null`** on rows written before 2026-09-30; no backfill). Show it as "Paid
with". Keep showing `gateway` as the aggregator that carried the money: it is what a support
agent quotes to the aggregator's own support, with `gatewayRef`.

Payout requests gain **`transferGateway`** (stored as `transfer_gateway`; both jovi-mall's admin
DTO and wi-admin's payout reads pass it through as `transferGateway`): the aggregator that sent,
or is sending, the payout, stamped at the first transfer attempt. Retries, verification and
callbacks use it. It is passed through **raw**, so the dashboard does the defaulting: a `null` on
a payout that was **already sent** means **NotchPay** (every payout before this change went
through NotchPay); render it that way, not as "unknown". A `null` on a payout not yet attempted
simply means no aggregator has been chosen yet.

## 4. `gateway` is no longer a closed list

`CAMPAY` and `FLUTTERWAVE` will be added as aggregators, and each will appear on new rows **with
no dashboard release**. Anywhere the dashboard types `gateway` as
`'NOTCHPAY' | 'MYCOOLPAY' | 'STRIPE'` (money types, payout badges, the settlement search filter),
widen it to `string` and render an unknown value as its raw name. Filters that list aggregators
should take the list from the Payments screen's `aggregators[]`, not from a constant.

**Update — `CAMPAY` is now a gateway value** (jovi-mall `76bc473`, ADR-A08 P2.1). It can appear as
`gateway` on payments, top-ups and plan purchases, as `transferGateway` on payouts, and as a row in
the Payments screen's `aggregators[]` (collects MTN and ORANGE by push; can pay out). **No dashboard
change is needed** if the rule above is followed: it renders by its raw name, and the Payments
screen lists it from `aggregators[]`. Like My-CoolPay, Campay has **no refund API**, so a refund on
a Campay payment takes the manual path (`gatewayRefundSupported: false` on refund eligibility).

**My-CoolPay can now send payouts** (jovi-mall `83e8535`), so `MYCOOLPAY` can also appear as a
payout's `transferGateway` and be chosen as the payout aggregator on the Payments screen, once its
flag is on and its `payoutAvailable` says so. No dashboard change is needed.

**Update (2026-10-05) — `PAWAPAY` is a gateway value** (ADR-A08 § PawaPay). It appears as a row in
the Payments screen's `aggregators[]` (collects MTN and ORANGE by push; can pay out once
`PAWAPAY_PAYOUTS_ENABLED` is on), as `gateway` on payments, top-ups and plan purchases, and as
`transferGateway` on payouts. **No dashboard change is needed** if the rule above is
followed. Two things an administrator may notice:

- A PawaPay payment's provider reference is a **UUID** (PawaPay requires the merchant to mint one),
  not a `jm_…` string. Our `jm_…` reference is on the PawaPay record too, as **Client reference ID**
  and as metadata **jmRef**; the PawaPay dashboard's search needs the full value.
- On the integrations screen (`GET /api/v1/system/integrations`), the `pawapay` row's
  `callbackKeysLoaded` is `0` until the first PawaPay call. If payments sit pending while it stays
  `0`, or the jovi-mall log shows `[PAWAPAYWebhook] refused: missing_signature`, signed callbacks are
  not switched on in the PawaPay dashboard.

Payouts stuck in `processing` are now re-checked by a reconciliation sweep (jovi-mall `9ab91fa`)
against the aggregator stored on the payout, so fewer of them need an administrator. What the
sweep cannot settle still does.

**New action — resolve a payout whose outcome is unknown** (wi-admin `884bc90`, jovi-mall
`d9f4dcf`). A payout whose transfer request timed out stays `processing` with a
`transferFailureReason` beginning "Outcome unknown", naming the `jm_po_…` reference to look up. The
sweep cannot ask about it (there is no provider transfer id), and mark-paid / reject refuse a
`processing` row. So the payout detail needs one more button:

- `POST /api/v1/money/payouts/:payoutId/resolve-unknown`, body `{ outcome: "paid" | "failed",
  reason (10–500), evidence? }`. Full contract:
  [`api/money.md`](./api/money.md#post-moneypayoutspayoutidresolve-unknown).
- **Offer it only on a `processing` payout whose `transferFailureReason` says the outcome is
  unknown**, and prompt the administrator to check the provider's dashboard for that reference
  first. The reason says what they checked and what it showed.
- **Permission depends on the outcome, and no new permission exists**: `paid` needs
  `money.payouts.mark_paid` and rides its dual control (≥ 2 000 000 XAF answers `202` with an
  approval, like `/mark-paid`); `failed` needs `money.payouts.triage`, so Support can record it.
  Show the `paid` choice only to holders of `mark_paid`, and the `failed` choice to holders of
  `triage`.
- Audited as `money.payouts.resolve_unknown_paid` or `money.payouts.resolve_unknown_failed`,
  fail-closed.
- It is refused too early, until the sweep's quiet period (default 15 min) has passed since the
  transfer was sent, because a callback may still arrive. Show the wait, not an error. And if the
  callback or the sweep settles the payout first, the action is refused as no longer
  `processing`: reload.
- **`failed` keeps the owner's hold.** Retrying the transfer or rejecting the payout is a
  separate, later action.

---

## Re-copy

`api/dev-tools.md`, `api/money.md`, `api/permissions.md`, this file, and from jovi-mall
`payments/routing.md` (new), `payments/README.md`, `error-codes.ts` (gains
`PAYMENT_SETTINGS_INVALID` and `PAYMENT_SETTINGS_VERSION_CONFLICT`, which this dashboard meets as
`details.platformCode` values, and the three `PAYMENT_PROVIDER_*` codes, which it does not meet
at all: they answer the apps that charge).
