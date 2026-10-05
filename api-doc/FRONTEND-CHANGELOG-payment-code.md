# Admin dashboard — NovaSend, the Orange "code first" flow, and amount limits

> **Date:** 2026-10-05 · **Status:** ✅ built in jovi-mall; **no wi-admin code changed** (the
> Payments screen relays jovi-mall's aggregator list). Live after the next jovi-mall deploy ·
> **Audience:** the admin dashboard · **Breaking:** nothing. One new aggregator name, one new
> `flow` value and two new capability fields on the Payments screen, one new integration row.
>
> Contract: jovi-mall [`payments/routing.md`](../../jovi-mall/api-doc/payments/routing.md) (capability
> types, the `CODE_FIRST` section, the error table) · the other apps' side:
> [jovi-mall `FRONTEND-CHANGELOG-payment-code.md`](../../jovi-mall/api-doc/FRONTEND-CHANGELOG-payment-code.md)
> · operating steps: [`docs/RUNBOOK.md` § NovaSend](../../docs/RUNBOOK.md#novasend).

| # | Change | Where |
|---|---|---|
| 1 | A seventh aggregator, **`NOVASEND`**, in `aggregators[]` | `GET /api/v1/dev-tools/payments` |
| 2 | `capabilities.collect.ORANGE.flow` may be **`"CODE_FIRST"`**, and `requires` may contain **`"paymentCode"`** | same |
| 3 | A capability may carry **`limits: { min, max }`** (XAF) and **`codeUssd`** (string) | same |
| 4 | A **`novasend`** row in the integrations list, with `credentialsSet`, `webhookSecretSet`, `sandbox`, `baseUrl`, `returnUrlSet`, `orangeCodeUssd`, `refundSupported`, `payoutsEnabled`, `activeForCollections`, `activeForPayouts` | `GET /api/v1/system/integrations` |

---

## 1–3 · The Payments screen

Nothing to build if the screen already renders `aggregators[]` from the response rather than from
a hard-coded list; `NOVASEND` then simply appears. Check three things:

- **Type `name` as `string`**, not a closed union, so `NOVASEND` (and any later one) renders.
- **Render `flow` with a fallback** for a value the screen does not know. Label `CODE_FIRST` as
  *"code first (customer dials {codeUssd} before paying)"*.
- **Show `limits`** where present: *"200 – 500,000 FCFA"*. It matters to the person switching:
  while NovaSend collects, **nothing above 500,000 FCFA can be paid by mobile money**, and there is
  no automatic fallback (owner decision).

### Before switching collections to NovaSend: a warning worth drawing

Selecting `NOVASEND` as the **collection** aggregator changes what Orange customers must do: they
dial a code first and type it into the app. An app build that has not shipped that step leaves
those customers stuck. Draw a confirmation on that selection:

> *Orange Money customers will be asked for a payment code they get by dialling {codeUssd}. Make
> sure every app has shipped the payment-code step. Payments above {limits.max} FCFA will be
> refused while NovaSend is active.*

The write itself is unchanged (`PUT /api/v1/dev-tools/payments`, tier 1, audited). jovi-mall
accepts `NOVASEND` once its credentials and webhook secret are set; otherwise the write is refused
with the usual `COLLECTION_AGGREGATOR_NOT_CONFIGURED` in `details.errors[]`.

## 4 · Integrations

The `novasend` row follows the other aggregators' shape. `orangeCodeUssd` is what Orange customers
are told to dial; `sandbox: true` in production means no real money moves (the server also warns at
boot). `refundSupported` is `false`: refunds go out as payouts, as for every mobile aggregator.

## Money pages

Unchanged. A transaction, top-up or plan purchase taken through NovaSend shows
`gateway: "NOVASEND"` (a label), and its stored `gatewayRef` is our own `jm_…` reference, because
NovaSend looks payments up by the merchant's reference.
