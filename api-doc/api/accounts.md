# `/accounts` — one party's financial position

**Verified against source on 2026-09-08** — all five routes and their composed guards against the live route manifest; every query parameter, sort allowlist and path-parameter enum against `accounts/validators/account.validator.ts`; the response shapes and every nullability against `accounts/read-models/account.dto.ts` and `money/read-models/payout-destination.dto.ts:137-180`; the two delegated verdicts and the outage behaviour against `accounts/gateways/account.gateway.ts` and `accounts/controllers/account.controller.ts:136-200`.

Base path: `/api/v1/accounts`

What one vendor, agency or agent **holds, is owed, and owes**. Five routes, all net-new —
nothing on the legacy surface could answer that question for a single party.

Design record: [`../../docs/ADR-011-ACCOUNTS-AND-FINANCE.md`](../../docs/ADR-011-ACCOUNTS-AND-FINANCE.md).

| Method | Path | Permission | Audited |
|---|---|---|---|
| `GET` | `/accounts/:ownerType/:ownerId` | `money.earnings.read` **+** `billing.plans.read` **+** `cod.overview.read` | — |
| `GET` | `/accounts/:ownerType/:ownerId/activity` | `money.earnings.read` **+** `billing.plans.read` | — |
| `GET` | `/accounts/:ownerType/:ownerId/payouts` | `money.payouts.read` | — |
| `GET` | `/accounts/:ownerType/:ownerId/credits` | `billing.plans.read` | — |
| `GET` | `/accounts/:ownerType/:ownerId/cash-ledger` | `cod.overview.read` | — |

**Read-only. There are no writes on this mount.**

## Authorization is composed, not invented

Every route requires the permission that owns the data it carries. **No `accounts` permission
family exists, and none should be added** — a new family would duplicate
`money.earnings.read` + `billing.plans.read` + `cod.overview.read` semantically, and gating the
account view on one `accounts.read` would be a side door onto all three.

The sub-routes then **narrow** to the single family whose data they carry. An administrator who
may work the payout queue but not see a COD position gets exactly that, on the same account.

## `:ownerType`

`vendor` · `agency` · `agent` — a **pinned enum**. A bad value is a `400`, not an empty account:
every collection here is keyed `(ownerType, ownerId)`, so an unrecognised type would match
nothing in five places and render as an account whose every block is empty.

**`platform` is excluded deliberately.** The marketplace's own commission account is a singleton
with no directory row, no plan, no credit wallet and no COD liability — every block would be
`null` except one, and that one lives at [`/money/earnings/platform`](money.md).

---

## The three balance models, and why they never mix

This surface carries **three unrelated kinds of number** in one response, and the DTO is built
to make confusing them impossible:

| Balance | `unit` | `direction` | What it is |
|---|---|---|---|
| **Earnings** | `money` | `owed_to_owner` | What the platform owes them |
| **Credits** | `credit` | `spendable_by_owner` | Metered-action units. **Not money.** No currency, no expiry, never payable out |
| **COD cash** | `money` | `owed_to_platform` / `owed_to_agency` | **A liability** — cash they are holding and owe onward |

Four mechanisms enforce the separation:

1. **No top-level `balance`, `total` or `amount`** anywhere.
2. Every balance object carries **`unit` + `currency` + `direction`**.
3. **No grand total exists**, at any level.
4. **`null` means "does not apply to this owner kind"**, which is different from `0` meaning
   "applies, currently empty".

Mechanism 4 is the one to internalise: a vendor's `codCash` is **`null`** because a vendor
cannot hold cash. An agent's `codCash: { held: 0 }` means they can and currently do not.

---

## `GET /accounts/:ownerType/:ownerId`

The account itself. **The heaviest read on the service** — two delegated verdicts and eleven
direct reads, fanned out in parallel.

It is one endpoint rather than four because **the answer is a comparison**: an agent owing
400 000 in cash while owed 380 000 in earnings is a fact about the *pair*, and a dashboard
assembling it from four calls would render the halves at different moments.

| | |
|---|---|
| **Permission** | `money.earnings.read` **+** `billing.plans.read` **+** `cod.overview.read` |
| **Path parameters** | `ownerType` (enum), `ownerId` (24-hex) — **strict**, no query parameters |
| **Pagination** | None |

### Response (200)

```jsonc
{
  "success": true,
  "data": {
    "owner": {
      "type": "agent",
      "id": "6660112233445566778899aa",
      "name": "Eric T.",
      "userId": "665b112233445566778899bb",
      "status": "active",
      "suspended": false,
      "suspendedReason": null,
      "createdAt": "2025-12-01T09:00:00.000Z"
    },

    "profile": {
      "email": "eric.t@example.cm",
      "emailVerified": true,
      "phone": "+237690554433",
      "phoneVerified": true,
      "country": "CM",
      "timezone": "Africa/Douala",
      "preferredLanguage": "fr",
      "kycStatus": "verified",
      "kycVerified": null,
      "kycVerifiedAt": "2025-12-08T11:00:00.000Z",
      "kycRejectionReason": null,
      "onboardingStep": 0
    },

    "subscription": {
      "subscriberPlanId": "6691aabbccddeeff00112240",
      "planId": "6690aabbccddeeff00112240",
      "planCode": "agent_standard",
      "planName": "Standard",
      "status": "active",
      "startedAt": "2026-08-01T00:00:00.000Z",
      "expiresAt": "2026-08-31T00:00:00.000Z",
      "notifyDaysBeforeExpiry": 7,
      "assignedBy": null,
      "paymentReference": null,
      "allowanceGranted": true,
      "entitlements": {
        "planCode": "agent_standard",
        "commissionPercent": null,
        "maxActiveProducts": null,
        "maxStorageBytes": null,
        "maxUnterminatedShipments": 4,
        "liveTrackingEnabled": true
      }
    },

    "balances": {
      "earnings": {
        "unit": "money", "currency": "XAF", "direction": "owed_to_owner",
        "pending": 42000, "available": 380000, "reserve": 0, "requested": 0
      },
      "credits": {
        "unit": "credit", "currency": null, "direction": "spendable_by_owner",
        "balance": 0, "walletExists": false
      },
      "codCash": {
        "unit": "money", "currency": "XAF", "direction": "owed_to_agency",
        "held": 400000, "lastMovementAt": "2026-08-13T07:12:00.000Z"
      }
    },

    "codExposure": {
      "contracts": [
        {
          "contractId": "6661aabbccddeeff00112233",
          "agencyId": "665c0011223344556677889a",
          "agentId": "6660112233445566778899aa",
          "status": "active",
          "outstandingBalance": 400000,
          "outstandingToAgent": 18500,
          "maxThreshold": 150000,
          "lastSettledAt": "2026-08-11T17:04:00.000Z"
        }
      ],
      "reserveHolds": null
    },

    "payouts": {
      "pendingCount": 0,
      "pendingAmount": null,
      "currency": "XAF",
      "lastPaidAt": "2026-07-30T10:00:00.000Z",
      "lastPaidAmount": 210000,
      "destination": { "method": "mobile_money", "isPreferred": true,
                       "masked": { "mobileMoney": { "provider": "MTN", "phoneNumberMasked": null,
                                                   "accountName": "Eric Tchoumi" },
                                    "bank": null, "card": null },
                       "full": null, "revealed": false }
    },

    "flags": {
      "openDiscrepancies": 1,
      "unsettledCollections": 3,
      "shipmentCapAlertedAt": null,
      "overCodThreshold": true
    }
  }
}
```

### Field notes

#### `profile` — the two KYC fields are **not** interchangeable

| Field | Applies to |
|---|---|
| `kycStatus` (string) | **Vendor and agent.** `null` for an agency |
| `kycVerified` (boolean) | **Agency and vendor.** `null` for an agent |

Collapsing them would mean inventing a status word for agencies — a vocabulary this service does
not own.

#### `subscription`

| Field | Notes |
|---|---|
| `status: null` | **No active plan** — the whole block's fields go `null` together |
| `notifyDaysBeforeExpiry` | From the platform's own billing settings, so "expires in N days" is rendered against **its** notice period rather than a number this service picked |
| `assignedBy` | `null` when nobody assigned it (self-service purchase, or the lazily created free default) |
| **`entitlements`** | **A delegated verdict** — what the plan allows, as the platform itself computes it |

#### `codExposure` — `null` for a vendor

| Field | Notes |
|---|---|
| `contracts[].outstandingBalance` | Cash collected under this contract and not yet settled to the agency. **`number \| null`** — `null` when the contract has no `cod` block |
| `contracts[].outstandingToAgent` | Fees the agency owes the agent. **The other direction.** **`number \| null`**, same reason |
| `contracts[].lastSettledAt` | ISO-8601 \| null |
| **`contracts[].maxThreshold`** | The contract's COD ceiling. **`0` blocks all COD** — it does not mean "no limit". `null` when the contract carries no `cod` block at all, which is *not* the same thing |
| `reserveHolds` | **Agency only** — the rolling-reserve slices waiting to mature. `null` for an agent, who has no reserve |

#### `payouts`

| Field | Notes |
|---|---|
| `pendingCount` | **`0` or `1`, never more.** `payout_requests` carries a partial unique index on `(ownerType, ownerId)` where `status: 'pending'`, so an owner has at most one open request |
| `pendingAmount` | `number \| null` — `null` when nothing is pending |
| `currency` | `string \| null` — from the pending request, else the last paid one, else `null` |
| `lastPaidAt` · `lastPaidAmount` | `null` until the owner has been paid once |
| `destination` | See below |

#### `payouts.destination` is **always masked**, and may be absent entirely

**`destination` is an object or `null`** — `null` when this owner has never had a payout request,
and also on a legacy row that predates the destination snapshot. An object of nulls would read as
*"a destination with no details"*, which is a different fact.

When it is present: **`full` is `null`** — the literal value `null`, not an object whose members
are null — and **`revealed` is `false`**. `revealed` is the discriminator; never infer it from
`full`. On this path `masked.mobileMoney.phoneNumberMasked` and `masked.bank.accountNumberMasked`
are **always `null` too**: the digits are not projected out of the database at all, so an operator
recognises a destination by its provider and account name. A card is the exception — `last4` is
the entire number that exists. The digits live behind
[`GET /money/payouts/:payoutId/destination`](money.md#get-moneypayoutspayoutiddestination) alone,
gated on its own permission and audited on every call.

It shows where the owner's **most recent** request was addressed — a hint about where the next
one would go, not a promise. Each request freezes its own snapshot.

#### `flags` — the four things that make an account worth *looking at*

| Flag | Notes |
|---|---|
| `openDiscrepancies` | **`null` for a vendor**, who has none by construction |
| `unsettledCollections` | Allocations whose COD cash the platform has **not physically received** |
| `shipmentCapAlertedAt` | When the owner was last warned they were at their shipment cap |
| `overCodThreshold` | **Agent only.** Their held cash has reached the ceiling that stops further dispatch (compared with `>=`, so a `0` ceiling always reads "over"). `null` for a vendor (no cash), for an agency (no single ceiling — see `codExposure`), **and for an agent who has no ceiling set at all** |

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Bad `ownerType`, malformed `ownerId`, or any query parameter |
| 404 | **`ACCOUNT_OWNER_NOT_FOUND`** | No such vendor, agency or agent. **An owner with no balances is not this** — that reports zeroes |
| 502 | `SERVICE_DEPENDENCY_UNAVAILABLE` | jovi-mall answered 5xx to one of the two delegated verdicts. `details.platformCode` carries its code |
| 503 | `SERVICE_DEPENDENCY_UNAVAILABLE` | jovi-mall is unreachable, or `JOVI_MALL_BASE_URL` is unset |

> **This route fails whole when jovi-mall is down, and that is deliberate.** `balances.earnings`
> and `subscription.entitlements` are the two delegated verdicts; rendering them as `null` would be
> indistinguishable from an owner who is owed nothing and has no plan. **The three sub-lists below
> (`/payouts`, `/credits`, `/cash-ledger`) are entirely direct reads and keep answering** — so a
> dashboard that degrades to them during a platform outage still shows the movement history.

---

## `GET /accounts/:ownerType/:ownerId/activity`

The merged movement feed. **The one cursor-paged list in this service.**

| | |
|---|---|
| **Permission** | `money.earnings.read` **+** `billing.plans.read` — **and deliberately not `cod.overview.read`** |
| **Pagination** | **Cursor.** No `total`, no `pages` |
| **Sorting** | **None** — the feed has one meaningful order and the cursor *is* that order |
| **Filters** | **None**, not even by category |

### Why it is cursor-paged

It merges **five independent collections** — plan purchases, credit top-ups, credit
transactions, earnings ledger rows and payout requests — in application code. Offset paging over
a merge is wrong even with exact counts: `skip(40)` applied to five sources independently does
not compose into rows 40–60 of the merged order. A page count that drifts as you walk it is
silent truncation dressed as a number.

### Why there is no category filter

It would be cheap to implement, and it would change what a cursor **means**: the same `?before=`
would return different rows depending on a filter the cursor does not encode, and a client that
changed the filter mid-walk would silently resume in the wrong place. **One feed, one order, one
cursor.**

### ⚠️ The COD cash ledger is deliberately **not** in this feed

COD cash is not owner value — it is money the owner is **holding and owes onward**. Merging it
here would put a liability and an asset in one column under one running order, which is the
single most likely way somebody misreads this account. It lives at `/cash-ledger` behind its own
permission.

### Query parameters

| Parameter | Type | Notes |
|---|---|---|
| `before` | ISO-8601 instant | **Strictly older than**, never inclusive — an inclusive cursor repeats the boundary row on every page, which on a money feed reads as a duplicate transaction. Omit for the first page |
| `limit` | integer | Default 20, max 100 |

**Strict** — no other parameter is accepted.

### Response (200)

```jsonc
{
  "success": true,
  "data": [
    {
      "id": "66a0aabbccddeeff00112233",
      "category": "earning",
      "type": "earning_release",
      "status": "completed",
      "unit": "money",
      "direction": "in",
      "amount": 25162,
      "currency": "XAF",
      "credits": null,
      "description": "Earnings released for order ORD-2026-008841",
      "gateway": null,
      "source": { "type": "order", "id": "6670aabbccddeeff00112233" },
      "createdAt": "2026-08-13T00:05:00.000Z"
    },
    {
      "id": "6691aabbccddeeff00112240",
      "category": "plan",
      "type": "plan_purchase",
      "status": "completed",
      "unit": "money",
      "direction": "out",
      "amount": 15000,
      "currency": "XAF",
      "credits": 100,
      "description": "Standard plan — 30 days",
      "gateway": "mtn_momo",
      "source": { "type": "subscriber_plan", "id": "6691aabbccddeeff00112240" },
      "createdAt": "2026-08-01T00:00:00.000Z"
    }
  ],
  "meta": { "limit": 20, "nextCursor": "2026-08-01T00:00:00.000Z", "hasMore": true }
}
```

| Field | Notes |
|---|---|
| `id` | **The source document's id** — not synthetic, so a row can be looked up where it lives |
| `category` | `plan` · `credit` · `earning` · `payout` |
| `direction` | **From the owner's perspective**: value arriving vs leaving |
| `amount` | Magnitude in `unit`, **always positive**. The sign lives in `direction` |
| `credits` | `null` on a row that moves no credit |
| `meta.nextCursor` | Pass back as `?before=`. **`null` at the end of the feed** |
| `meta.hasMore` | Derived from the cursor, carried explicitly so a client never has to infer one from the other |

---

## `GET /accounts/:ownerType/:ownerId/payouts`

This owner's payout history — the same rows, projection and masking as
[`GET /money/payouts`](money.md#get-moneypayouts), scoped to one party.

| | |
|---|---|
| **Permission** | **`money.payouts.read` alone.** Requiring the account view's full composition would mean an administrator who may work the payout queue could not open the account it belongs to |
| **Pagination** | `page`, `limit` |
| **Sorting** | `createdAt`, `amount`, `resolvedAt`. Default **`-createdAt`** — the allowlist is shared with `/money/payouts`, not restated |

### Query parameters

| Parameter | Type |
|---|---|
| `status` | string, 1–40 |

### Response (200)

Payout objects, identical shape to `/money/payouts`. **`destination.full` is `null`** here too.

---

## `GET /accounts/:ownerType/:ownerId/credits`

The credit ledger, **with the wallet balance in `meta`**.

| | |
|---|---|
| **Permission** | **`billing.plans.read`.** Credits are a billing artefact — granted by a plan allowance, bought as a pack, spent on metered actions — and **they are not money.** Requiring a `money.*` permission would say they were |
| **Pagination** | `page`, `limit` |
| **Sorting** | `createdAt`, `amount`. Default **`-createdAt`** |

### Query parameters

| Parameter | Type | Notes |
|---|---|---|
| `type` | string, 1–40 | `allowance` · `topup` · `debit` · `adjustment` · `refund` |
| `reasonCode` | string, 1–40 | |

### Response (200)

```jsonc
{
  "success": true,
  "data": [
    {
      "id": "66b0aabbccddeeff00112233",
      "type": "debit",
      "reasonCode": "product_boost",
      "amount": -5,
      "balanceAfter": 95,
      "ref": "66601122334455667788990a",
      "createdAt": "2026-08-12T09:00:00.000Z"
    }
  ],
  "meta": {
    "total": 42,
    "page": 1,
    "limit": 20,
    "pages": 3,
    "wallet": {
      "unit": "credit",
      "currency": null,
      "direction": "spendable_by_owner",
      "balance": 95,
      "walletExists": true
    }
  }
}
```

| Field | Notes |
|---|---|
| **`amount`** | **Signed here**, unlike the activity feed — this is the ledger, and it reads as one |
| `ref` | Whatever caused it — a product id, a message id, a plan id. Free-form |
| **`meta.wallet`** | **A balance object, kept whole.** It keeps `unit`, `currency` and `direction` rather than being flattened into `meta` — stripping those three is exactly what makes somebody add a credit balance to a money balance |
| `wallet.walletExists` | `false` when the owner has no wallet row yet (created lazily). The balance still reads `0` — a missing wallet and an empty one are the same amount of credit, and this flag is what tells them apart for anybody debugging why a grant did not land |

---

## `GET /accounts/:ownerType/:ownerId/cash-ledger`

The COD liability's movements. **A different unit of meaning from `/activity`**, which is why it
is a different endpoint rather than a filter on that one.

| | |
|---|---|
| **Permission** | `cod.overview.read` |
| **Path parameters** | **`ownerType` accepts `agent` and `agency` only** |
| **Pagination** | `page`, `limit` |
| **Sorting** | `createdAt`, `amount`. Default **`-createdAt`** |

### Query parameters

| Parameter | Type |
|---|---|
| `entryType` | string, 1–40 |

### Response (200)

```jsonc
{
  "success": true,
  "data": [
    {
      "id": "6681aabbccddeeff00112233",
      "entryType": "collection",
      "amount": 27500,
      "balanceAfter": 400000,
      "ref": { "type": "cash_collection", "id": "6674aabbccddeeff00112233" },
      "createdAt": "2026-08-13T07:12:00.000Z"
    }
  ],
  "meta": { "total": 118, "page": 1, "limit": 20, "pages": 6 }
}
```

`amount` is **signed** — positive raises the liability, negative discharges it. `balanceAfter` is
what the liability became.

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | **`ownerType=vendor`** → *"A cash ledger exists for agent and agency accounts only"*. A vendor never collects cash, so a `400` naming the reason beats an empty page that reads as "no movements" when the truth is "cannot have any" |
| 404 | `ACCOUNT_OWNER_NOT_FOUND` | |
