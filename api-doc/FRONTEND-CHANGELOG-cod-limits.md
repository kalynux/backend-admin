# Admin dashboard changelog — COD limits, salaried contracts, fee proposals (2026-10-02)

**Backend change: 2026-10-02 · Not deployed yet.** Deploy prerequisite: jovi-mall's index
migration `npm run migrate:delivery-fee-proposal-indexes` must run before jovi-mall starts (the
release as a whole; nothing on this page reads the new collection). wi-admin has **no** migration.
Both repositories ship together: wi-admin's three new routes delegate to a jovi-mall route that
does not exist in the currently deployed jovi-mall (`GET/PUT /api/internal/admin/agencies/:id/cod-limit`).

Cross-role records: `jovi-mall/api-doc/FRONTEND-CHANGELOG-cod-limits.md`,
`…/FRONTEND-CHANGELOG-contract-salary.md`, `…/FRONTEND-CHANGELOG-delivery-fee-proposals.md`.
Decision record: `jovi-mall/docs/ADR-A09-COD-LIMITS-AND-DELIVERY-FEES.md`. This file is what the
**admin dashboard** — which talks to wi-admin only — has to change.

## ⛔ Read first

1. **The permission vocabulary moves 127 → 128** (`agencies.cod_limit.set`). Tier totals are now
   **128 / 106 / 39** (measured from `TIER_GRANTS`). The dashboard's mirrored permission list and
   its `permissions.types` / `route-map` suites move with it.
2. **`pool.source` gains `"default"`**, replacing `"plan"`. A closed enum in the dashboard breaks.
3. **`feeSplit.model` gains `"monthly_salary"`** and `feeSplit` gains `agentMonthlySalary`.

---

## 1 · Agency COD limit (new)

Every delivery agency may hold at most **1 000 000 XAF** of cash on delivery that has not reached
the platform (in-flight COD shipments + collected-but-unremitted cash). An administrator can pin
another amount — above or below — and release it.

| Method | Path | Permission | Audit |
|---|---|---|---|
| `GET` | `/api/v1/agencies/:agencyId/cod-limit` | `agencies.read` | — |
| `PUT` | `/api/v1/agencies/:agencyId/cod-limit` | **`agencies.cod_limit.set`** (new, `financial`) | `agencies.cod_limit.set` |
| `POST` | `/api/v1/agencies/:agencyId/cod-limit/release` | `agencies.cod_limit.set` | `agencies.cod_limit.release` |

- PUT body `{ maxAmount: integer ≥ 0, reason }` (`.strict()`); release body `{ reason }` (`.strict()`).
  wi-admin checks only "non-negative integer"; **jovi-mall** owns the ceiling (100 000 000,
  `COD_CONFIG.AGENCY_COD_LIMIT_MAX`) and answers `400 VALIDATION_ERROR` with
  `details: { requested, min, max }` above it — relayed as-is.
- All three answer `{ success, data }` with `data`:

  ```ts
  {
    agencyId: string;
    limit: number;
    source: 'default' | 'override';
    defaultLimit: number;               // 1 000 000
    exposure: { inFlight: number; inFlightCount: number; collectedUnremitted: number; collectedCount: number; total: number };
    headroom: number;                   // max(0, limit − total)
    overLimit: boolean;                 // total > limit
    override: { amount: number; reason: string; setAt: string; setByUserId: string | null;
                setBySource: string; setByName: string | null } | null;
  }
  ```

  The exposure is **delegated** — jovi-mall computes it (`CodLimitsService.report`); wi-admin
  never re-derives it.
- The new permission is **financial**: granted to Developer and Admin (named in the tier-2 money
  block beside `agents.cod_threshold.set`), never to Support. Gate the pin/release buttons on it;
  the read needs only `agencies.read`.
- A pin **below** current holdings is accepted — show `overLimit: true` prominently; it blocks the
  next vendor dispatch to that agency until cash comes back.
- Release is a separate audit action because jovi-mall clears the pin entirely: the audit row is
  then the only record the pin existed. The audit `before`/`after` carry `codLimit` and
  `codLimitSource`.
- The agency is notified of a pin / release (`cod.limit.pinned` / `cod.limit.released`); the
  **reason and author are not** sent to it.

Suggested UI: a "Cash on delivery" card on the agency detail — gauge `exposure.total / limit`, the
source badge, the pin with reason and author, Pin / Release actions (reason required).

## 2 · Agent COD pool: `default` replaces `plan`

- `cod.pool.source` (agent detail) and `pool.source` (`GET /api/v1/agents/:agentId/cod-allocation`,
  pin/release answers) read `"default"` where they read `"plan"`; the ceiling is **500 000 for every
  verified agent**, whatever plan they hold. A not-yet-resynced agent may still read `"plan"` —
  render it as "default". `planCode` is always `null` (deprecated).
- The agent pin (`PUT /api/v1/agents/:agentId/cod-threshold`, `POST …/cod-threshold/release`) is
  unchanged on the wire; it now overrides the 500 000 default rather than the plan. Copy: "back to
  the default", not "back to the plan". The agent is notified (`cod.pool.pinned` / `.released`).
- Billing plan editor: `maxCodPool` is **dormant** — it no longer moves any agent's pool and editing
  it re-syncs nothing. Hide it or label it "not used".

## 3 · Contracts: the `monthly_salary` pay model

wi-admin's contract reads (`terms.feeSplit`, see [`api/contracts.md`](./api/contracts.md)) gain one
field and one model value (`src/modules/agencies/read-models/contract.dto.ts`):

```ts
feeSplit: {
  model: 'percentage' | 'flat' | 'monthly_salary' | null;
  agentSharePercent: number | null;   // percentage only
  agentFlatFee: number | null;        // flat only (minor units per delivery)
  agentMonthlySalary: number | null;  // monthly_salary only (minor units per MONTH) — NEW
  currency: string | null;
}
```

Only the amount matching `model` is meaningful — a stale value under another model may sit beside it
(a partial patch keeps it); ignore it. Render `monthly_salary` as "Salaried — X / month (agency pays
off-platform)". **The salary is never a platform payment**: jovi-mall pays the agent 0 per delivery
and writes no agent allocation, and nothing schedules, tracks or pays the salary. No wi-admin write
path changed.

## 4 · Existing screens whose numbers can now move (no shape change)

- **Shipments** (`deliveryFeeSnapshot`): a vendor-approved delivery-fee proposal on an order already
  paid online **rewrites** the shipment's `delivery_fee_snapshot` to the approved fee. It stays "the
  fee actually charged".
- **Money → allocations** (`GET /api/v1/money/earnings/allocations`): the vendor's held
  `('order', vendor)` allocation is **re-priced in place** by `snapshot − newFee` on that approval
  (jovi-mall `planFeeApplication`), with an earnings-ledger row whose `reasonCode` is
  `delivery_fee_adjustment` on the **vendor's** account. wi-admin exposes no per-vendor earnings
  ledger, so that row is not visible in the dashboard; the allocation's `amount` simply changes.
- **Statements** and vendor analytics read the adjusted allocation.
- **Order dispatch** (`POST /api/v1/orders/:orderId/dispatch`, `orders.intervene`) is **not gated**
  by the agency limit or the vendor's terms — the administrator is the platform. It also clears a
  vendor-side COD-limit hold (the hand-off resets `cod_limit_hold`).

## 5 · Not surfaced in wi-admin (gaps, by design of this change)

None of these has a wi-admin read today; support answers them from the error log or by asking:

- a vendor's **COD terms** (`codEnabled`, `maxCashPerAgency`);
- which shipments are **held** by a COD limit (`cod_limit_hold`) or were **forced** past one
  (`cod_limit_force`, and an offer's `cod_limit_forced`);
- **delivery-fee proposals** (the `delivery_fee_proposals` collection);
- an agency's `assignment_settings.agents_can_propose_delivery_fee`.

## 6 · Errors you may see relayed

- `COD_AGENCY_LIMIT_EXCEEDED` (422) and `COD_VENDOR_NOT_ACCEPTED` (422) are platform codes for
  vendor dispatch and checkout; they reach the admin dashboard only through support tickets and the
  error log (`/api/v1/system/errors`).
- The `DELIVERY_FEE_PROPOSAL_*` family (12 codes) and `SHIPMENT_DELIVERY_FEE_PENDING` likewise —
  see `jovi-mall/api-doc/errors/README.md` § Delivery-fee proposals.
