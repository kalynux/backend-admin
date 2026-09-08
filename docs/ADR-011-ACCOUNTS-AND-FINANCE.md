# ADR-011 — Accounts and financial information

**Verified against source on 2026-09-08** — the four money mounts against the live manifest — `/accounts` 5 · `/billing` 10 · `/money` 14 · `/cod` 16 — and the composed `all`-mode guard on `GET /accounts/:ownerType/:ownerId`. Every route, error code, permission and audit action this page names was re-checked against the live route manifest and the four registries — `permission.catalog.ts`, `audit.catalog.ts`, and both services' `error-codes.ts`. ⚠ **This is a dated design record.** Its *Context* sections describe what PHASE-0 or the phase found **at the time** and are correct as history, not as a description of the service today; where a decision is still the live rule it says so at its own D-item.

**Status:** accepted · **Date:** 2026-08-12 · **Phase:** 11
**Amends:** ADR-004's *Money*, *Billing / plans* and *COD / cash* rows (read: HTTP → the
verdict/record split)
**Depends on:** [ADR-004](./ADR-004-DOMAIN-OWNERSHIP.md) (transports),
[ADR-005](./ADR-005-API-CONTRACT.md) (the list contract),
[ADR-006](./ADR-006-AUDIT.md) (the trail), [ADR-009](./ADR-009-DELIVERY-NETWORK.md) (D-1,
the split this generalises), [ADR-010](./ADR-010-ORDERS-AND-SHIPMENTS.md) (the shape this
mirrors)

> **Numbered 011 by the code, not by date.** `api/index.ts` cites
> `ADR-011-ACCOUNTS-AND-FINANCE.md` from three mounts; ADR-006's Phase 12 addendum cites
> `ADR-011-AUDIT-COMPLETION.md`, which was never written. Same tiebreak ADR-010 used
> against ADR-009: **the number a source file already links wins.** ADR-006's link is
> re-pointed at `ADR-012-AUDIT-COMPLETION.md`, which the audit phase still owes.

---

## Context

Ten phases ported the administrative surface. **The money was what was left**, and the
measurement was worse than "not ported yet".

**Twenty-one legacy finance endpoints** lived only on jovi-mall's `/api/admin/*` — billing
7, COD 8 of 13, money 6. Behind them, six collections were declared readable in
`platform-collections.ts` and read by **nothing**.

The consequence, measured rather than assumed: an administrator holding a vendor id could
not answer *what does this account hold, what is it owed, what does it owe, and what has
moved through it.* `AdminEarningsController` served the **platform singleton only**.
`earnings_allocations` — the unique `(source, beneficiary)` row every split is computed
from — had no admin surface anywhere, which left `hold_release_at`,
`requires_cash_settlement` and `cash_settled_at` (between them the entire answer to *why
has this money not been released*) readable only in a database shell. `credit_wallets`,
`payment_transactions` and `refund_transactions` had none either.

And the one account-shaped screen that did exist was leaking. `GET /api/admin/payout-requests`
returned `r.toObject()` raw — **including `payout_method_snapshot`, which holds plaintext
mobile-money MSISDNs and bank account numbers.** jovi-mall masks those for the owner
(`maskPayoutMethods`); it did not mask them for the administrator queue. That was live, and
it is finding F-A below.

The governing constraint for the phase was the brief's own: **restrict sensitive financial
information by administrator permission, and never expose payment credentials, provider
secrets, private keys or authentication secrets.**

---

## Decisions

### D-1 · Records are read directly, verdicts are delegated — ADR-009 D-1 applied to money

ADR-004's table gave Money, Billing and COD `read: HTTP`, on a reason that does not survive
contact with the collections: *escrow release is shared with a worker*, *`plan.activated`
drives agent capacity in-process*, *FIFO settlement runs under a guarded compare-and-set*.
Every one of those is an argument about **writes**. ADR-009 D-1 already put the line where
it actually falls, and this phase generalises it from the delivery network to the money:

> **Delegate a read whose answer is a VERDICT the platform acts on.
> Read directly a read whose answer is a RECORD.**

| Read | Path | Because |
|---|---|---|
| `earnings_ledgers`, `earnings_allocations`, `earnings_reserve_holds` | **direct** | append-only rows saying what MOVED |
| `payout_requests` (list + detail + destination) | **direct** | records; the protection here is the projection, not the transport |
| `payment_transactions`, `refund_transactions` | **direct** | gateway settlements, already terminal |
| `pricing_plans`, `subscriber_plans`, `plan_purchases`, `billing_settings` | **direct** | records |
| `credit_wallets`, `credit_transactions`, `credit_topups` | **direct** | records |
| COD remittance / deposit / discrepancy details, cash accounts, cash ledger, trust events | **direct** | records |
| `earningsAccountService.getBalances` | **delegated** | a balance is four sub-balances reconciled against the ledger; a copy is a second opinion about how much money exists |
| `EarningsAccountRepository.listForAdmin` (cross-owner balances) | **delegated** | the same reconciliation, ranked — never a raw scan of `earnings_accounts` |
| `EntitlementService.getEntitlements` | **delegated** | numbers the platform itself branches on (product caps, commission, shipment caps) |
| `codSummaryService.adminOverview` | **delegated** | sums every cash account and cross-references unsettled collections; three totals the platform branches on |
| every write | **delegated** | ADR-004 D-2, unchanged |

**This amends three cells of ADR-004's table.** The plan named two (Money, Billing); COD is
the third, because step 4 made that module mixed-transport and its Phase-4 header — *"reads
are delegated too, not read from the shared database"* — became false. All three rows now
read `direct read (records) + HTTP (verdicts)`.

What did **not** change: writes. All fifteen writes across the three modules are delegated,
because each one is a transaction paired with a post-commit emission. Assigning a plan
expires the current term, grants a credit allowance exactly once inside the same
transaction, and emits `plan.activated`, which `AgentPlanCapacityConsumer` reads in-process
to resize an agent's shipment capacity. A second writer moves the rows and leaves every
agent on that plan at their old cap.

### D-2 · `/accounts` is its own mount, and adds no permission family

Not under `/money`, and not `/vendors/:id/account` × 3.

1. **The subject is a party, not a money record.** `/money` holds ledgers, allocations,
   payouts and settlements. This mount's subject is a vendor, an agency or an agent, and
   its answer spans three unrelated balance models.
2. **Under `/money` it would smuggle billing and COD data behind a `money.*` gate.** The
   overview carries the subscriber plan, the credit wallet and the COD liability;
   `GET /money/accounts/:id` gated on `money.earnings.read` is exactly the side door that
   `permission('shipments.read', 'agents.read')` on `/shipments/:id/offers` exists to
   prevent.
3. **Three per-role copies is how `maskPayoutMethods` ended up with three copies in
   jovi-mall.** One mount, one `ownerType` discriminator.

**No `accounts` permission family is added.** Every route here is an `all`-mode composition
of permissions that already own the data:

| Route | Composition |
|---|---|
| `GET /:ownerType/:ownerId` | `money.earnings.read` + `billing.plans.read` + `cod.overview.read` |
| `GET /:ownerType/:ownerId/activity` | `money.earnings.read` + `billing.plans.read` |
| `GET /:ownerType/:ownerId/payouts` | `money.payouts.read` |
| `GET /:ownerType/:ownerId/credits` | `billing.plans.read` |
| `GET /:ownerType/:ownerId/cash-ledger` | `cod.overview.read` |

A new family would need a `PermissionFamily` member, `tier-grants.ts` entries and the audit
family assertion — for permissions that duplicate three existing ones semantically. The
composition also has the better failure mode: an administrator who may see earnings but not
COD gets a 403 on the overview rather than a silently thinner one.

`ownerType` is `z.enum(['vendor','agency','agent'])` — **our** vocabulary, because *which
owner kinds get an account page* is this surface's decision. `platform` is excluded; the
singleton lives at `/money/earnings/platform`.

### D-3 · Three unrelated balance models in one response, and five mechanisms that stop them mixing

An owner holds a credit wallet, an earnings account and a COD cash account. They are
denominated differently, owed in opposite directions, and two of them do not apply to every
owner kind. The DTO is built so that adding them together is not something a client can do
by accident:

1. **No top-level `balance`, `total` or `amount`.** Every number lives inside a named
   object. Asserted by source scan in `test-accounts.ts`.
2. **Every balance object carries `unit`** (`'money' | 'credit'`) **and `currency`.** A
   credit balance's currency is `null`, not `'XAF'`.
3. **Every balance object carries `direction`** — the field that stops the arithmetic:
   `earnings → 'owed_to_owner'`, `credits → 'spendable_by_owner'`,
   `codCash → 'owed_to_platform' | 'owed_to_agency'`.
4. **`null` means "does not apply to this owner kind"; `0` means "applies, currently
   empty".** A vendor gets `codCash: null`; a settled agent gets `codCash: { held: 0 }`.
   Conflating them is the difference between *cannot owe* and *owes nothing*.
5. **No grand total, and the DTO comment says why.** Adding a liability to an asset across
   two units is not a number. Even `pending + available + reserve + requested` is omitted:
   that arithmetic is jovi-mall's, and `getBalances` does not return it.

Two corrections the build made to the plan's own sketch, both of the class the DTO exists
to prevent:

- **`codCash.direction` is `owed_to_agency` for an AGENT.** The plan wrote
  `owed_to_platform` for both. `cod-cash-account.model.ts` says an agent's cash is owed to
  their **agency** and the agency's to the **platform** — which is exactly why a deposit and
  a remittance are different verbs. A liability label naming the wrong creditor is the error
  this DTO is for.
- **`subscription` is always an OBJECT** with nullable fields, never nullable itself.
  `entitlements` lives inside it, and a null subscription would take the entitlements block
  with it — making *no plan* and *could not determine the plan* the same shape.
- **`balances.credits` is never null, and carries `walletExists`.** All three owner kinds
  can hold credits, so the plan's `| null` would never be emitted. The real distinction is
  *no wallet row yet* against *wallet at zero*, and that is what the flag carries.

**The COD cash ledger is deliberately not in the activity feed** and has its own route. It
is a liability, not owner value, and merging the two is the single most likely way somebody
misreads the account. Its params schema accepts `agent | agency` only, so a vendor is a 400
naming the reason rather than an empty page that reads as *no movements* when the truth is
*cannot have movements*.

### D-4 · The payout destination is masked by PROJECTION, and the two routing values are renamed

Masking in a mapper means the plaintext was read, travelled through a read model, and was
dropped by a function somebody can edit. Masking in the projection means it never left
Mongo.

`payout-request.read.repository.ts` therefore declares **two projections over one
collection** — the only place in the service where that happens, and it is the reason:

- `PAYOUT_LIST_PROJECTION` — whitelist by dotted path. `mobile_money.phone_number`,
  `bank.account_number` and `card.gateway_token` are simply not in it. Every list, every
  detail and every `/accounts` block reads through this.
- `PAYOUT_DESTINATION_PROJECTION` — used by exactly one method, on one route.

**The two routing values are RENAMED by that projection**, to `revealed_mobile_money_number`
and `revealed_bank_account_number`, via a computed `find` projection (`'$path.to.field'`,
MongoDB 4.4+; the dev server is 7.0.5 and the shape was probed before it was committed to).

That rename is what makes the phase's **exactly-one-occurrence** rule reachable at all. A
dotted inclusion would have put `phone_number` in the projection, in the read model **and**
in the mapper — three occurrences, and a ban-list scan that can only be a comment. Renamed,
the plaintext path appears once in the whole module.

Consequence worth knowing before editing the test: **the scan matches full dotted paths,
never bare names**, because `revealed_bank_account_number` contains the substring
`account_number`.

A visible cost, taken deliberately: **the masked destination shows no last-four.** With the
plaintext outside `PAYOUT_LIST_PROJECTION` the queue literally cannot render `••••3456`, so
`phoneNumberMasked` / `accountNumberMasked` are **`null`** there and the operator recognises
a destination by provider plus account name. This is tighter than jovi-mall's own admin
queue, which still shows the last four. Card `last4` **is** shown — no PAN is ever stored.
**Do not "fix" those nulls.**

### D-5 · The disclosure is a read that is audited, and it fails closed

`GET /money/payouts/:payoutId/destination` is the only path in the service that puts a
beneficiary's account number on the wire. It is gated on its own permission and it **writes
an audit row on every call**.

| | |
|---|---|
| `AuditAction` | `money.payouts.destination.read` |
| `target` | `payout` — already in `AUDIT_TARGET_TYPES`, already `platform_record`. **No `audit.types.ts` or `audit-subject.ts` edit anywhere in Phase 11.** |
| `transport` | **`external`** |
| writer | `auditedAttempt` |
| `sensitive` | `true`, derived from the permission's `financial` flag |
| `payload` | `{ payoutId, ownerType, ownerId }` — never the revealed value |
| `after` | `{ revealedMethods: ['mobile_money'] }` — which *kinds*, not the values |

**Why a read is audited at all.** *Reads are not actions* holds everywhere else because a
read leaves no state to reconstruct, so the permission gate is the whole control. This one
breaks that in a specific way: **its output is the material a fraudulent payout instruction
is built from.** For a disclosure, *who may* is not the interesting question — *who did, and
how often* is. An administrator who unmasks forty destinations in an hour is copying the
payout roster, and nothing else in this service would see it. `sensitive: true` puts that on
the alerting axis for free. Same reasoning that made `audit.export` `destructive` rather
than merely gated.

**Why `external`, not `observation`.** `observation` (`recordEvent`) is best-effort and
swallows a write failure — right for a login, which already happened on its own terms, and
wrong here, where **the audit row IS the control**. `auditedAttempt` commits the intent
first and does not catch, so with the audit store unreachable the disclosure never runs.
Fail-closed is the only acceptable posture for the one endpoint that emits a bank account
number.

**The ordering is the design, and it is pinned positionally by a test** (`test-money.ts` §6)
because a version that read first and audited after would pass every other assertion in the
file:

1. read the payout **masked** — 404, and the label the audit row is recognised by;
2. commit the intent, and stop here if that fails;
3. only now read the routing values, through the narrow projection;
4. 422 `PAYOUT_DESTINATION_ABSENT` if there is no snapshot at all — the row stamps `failed`
   and the attempt stays on the record, which is the point: somebody asked;
5. stamp `after` with which *kinds* were revealed.

Three narrowings the build decided and the plan did not:

- **`card.gateway_token` is never revealed, not even by the unmask.** The operational need
  is *where do I send the money* — an MSISDN or an account number. Nobody sends money **to**
  a gateway token; it is a pull credential. `full.card` is typed `null`.
- **A card payout is therefore `revealed: true` with an empty `full` and
  `revealedMethods: []`**, not a 422. The disclosure genuinely has nothing to add. 422 is
  reserved for a payout with **no snapshot at all** (legacy rows), and that failed attempt
  is still recorded.
- **The 404 comes from the masked read, before the audit intent.** A mistyped id writes no
  disclosure row, because it is not an attempted disclosure.

**Why this lives in `domain/payout-disclosure.ts`.** Every other audit intent in `/money` is
built in the gateway, because every other audited action there is a delegated write and the
gateway is the transport boundary. This one delegates nothing, so it has no gateway to live
in — and putting the ordering rule in the controller would put it in the one layer meant to
be thin.

### D-6 · The masker is copied — the fourth copy — and the ADR says so

`toMaskedDestinationDto` and `maskTail` live in
`src/modules/money/read-models/payout-destination.dto.ts`. That is a **fourth copy** of
logic jovi-mall already has three of. Sharing is unavailable: separate packages, no shared
library, and importing a jovi-mall module registers models on the importing process's
default connection (ADR-004 D-3).

The honest response is not to pretend otherwise but to make drift **detectable**:
`test-money.ts` reads `jovi-mall/src/core/types/payout.types.ts` from source and asserts
both maskers agree on a fixed vector — `'237670123456' → '••••••••3456'`, `'1234'`, `'12'`,
`''`. Same trick `test-data-access.ts` uses on the collection constants.

**One type, two mappers, and they cannot disagree.** `toRevealedDestinationDto` delegates
its masked half to `toMaskedDestinationDto` and overrides exactly the two values it has —
and the spread is of that mapper's *output*, which is never handed plaintext.
`toMaskedDestinationDto` hard-codes `full: null, revealed: false`, and it cannot leak
because **it never receives the plaintext**: its projection excluded it.

`revealed` is the discriminator and is **never inferred from `full`** — see the card case
in D-5, where `revealed: true` and `full` is empty.

### D-7 · Dual control on `money.payouts.mark_paid` at 2,000,000 XAF, with the amount read from the record

`LARGE_PAYOUT` mirrors `EARNINGS_CONFIG.AUTO_PAYOUT_THRESHOLD` — the amount at which the
platform itself stops auto-paying and asks a human. `2_000_000` is inlined, matching
`PROMOTE_TO_DEVELOPER`'s inline `payload.tier === 1`, and `test-money.ts` asserts it equals
jovi-mall's constant read from source.

**The subtlety that shaped the controller: `when` is evaluated against the payload, and the
amount is not in the request body.** `POST /money/payouts/:payoutId/mark-paid` carries only
`{ reference? }`. So unlike `administrators.tier.set`, the controller must direct-read the
payout, refuse now with **409 `PAYOUT_NOT_PENDING`** if it is not pending (never queue an
approval for an already-impossible action), and only then build
`{ payoutId, ownerType, ownerId, amount, currency, reference }` and evaluate.
`approvalRequestKey` hashes that payload, so an amount that differed between two requests
yields a different key and cannot join a stale pending approval.

The registered handler re-checks against current state — an approval can sit for
`ADMIN_APPROVAL_TTL_S` — refusing a payout that is gone or no longer pending rather than
double-paying, and confirming the amount and currency still match what the approver signed
for. If `LARGE_PAYOUT.when` no longer trips, the approval was over-cautious, not invalid:
proceed.

**Rejecting is never queued.** That direction is reversible; a quorum belongs on the
irreversible one.

Two mechanisms this decision forced into shared code:

- **`auditedQueue()` in `audit.writer.ts`, and `recordQueued` finally has a caller.**
  `recordQueued` needs a `ClientSession` and only that file may open one (`test-audit.ts`
  scans for `startSession(`), so queueing and its audit row now commit in one transaction.
  `requestApproval` / `ApprovalRequestRepository.create` gained an optional session; with
  one, a duplicate-key race is a **409** rather than joining the pending row, because the
  aborted transaction cannot re-read.
- **A queued mark-paid does NOT appear on `/money/payouts/:id/activity`.** `recordQueued`
  targets the `approval_request`; the payout rides as `related_target`, and
  `buildQueryFilter` does not consult it. Pending requests are found via
  `GET /approvals?targetId=<payoutId>`. The row for the *write* does target the payout and
  carries `via_approval_id`.

### D-8 · `financial` now means two things, and the second is fenced by an allowlist

The flag was reused rather than adding a `disclosure` flag, because the two mechanisms it
already drives are exactly the two this permission needs: `assertGrantTableValid()` refuses
a `financial` permission to tier 3, and `allInFamily('money')` refuses to expand one. Tier
1–2 access falls out with no new mechanism, and
`'money.payouts.destination.read'` is named **by hand** into the tier-2 ADMIN block —
without that it is granted to no tier and the service refuses to boot.

The cost is that `financial` no longer implies `write`, and that is stated in the flag's own
docstring: **do not reach for it on a read merely because the read concerns money.**
`money.earnings.read` and `cod.overview.read` are unflagged and belong that way. Reach for
it when disclosing the value is itself the risk.

`test-authz.ts` guards this with a `FINANCIAL_READ_ALLOWLIST` of exactly one name rather
than a blanket ban, plus an assertion that the allowlisted name still exists and is still
flagged. **Adding another financial read is a two-file change on purpose.**

`money.payments.read` is the counter-example. It is a **new permission of its own** rather
than a `money.earnings.read` + `orders.read` composition — neither summary describes reading
gateway settlements — and it is deliberately **unflagged**: its answer is *did this payment
go through*, and the fields that would make it sharp (the raw gateway payload, its hash, the
idempotency key) are excluded **by projection, not by permission**. That is what lets it sit
in Support's grant, where a `financial` permission could not.

### D-9 · The activity feed is cursor-paged, and a page may come back longer than `limit`

The account activity feed merges five sources — `plan_purchases → plan`, `credit_topups` +
`credit_transactions → credit`, `earnings_ledgers → earning`, `payout_requests → payout` —
modelled on jovi-mall's own `VendorTransaction`, and giving its reserved `payout` category
its rows at last.

**Merged in application code, not `$unionWith`.** `PlatformReadRepository` takes one
collection and one projection at construction and `assertReadOnlyPipeline` polices stage
lists; a five-way union needs one repository projecting the union of five schemas, which is
the widened-projection shape the two-lock convention exists to prevent.

**Cursor-paged, and it is the only such list in the service.** ADR-005 D-10 chose offset
paging knowingly and named the exception — *revisit it for an endpoint that streams an
export, not for the surface as a whole.* This is that revisit for a different reason: a
five-way merge cannot produce an exact `total` or an exact deep page, and an approximate
page count is precisely the silent truncation the contract forbids. So the response carries
`cursorMeta(nextCursor, limit)` — `{ limit, nextCursor, hasMore }` — with **no `total` and
no `pages`**, and the DTO header says this is the one endpoint without them and why.

> *A note for the next reader:* the codebase cites "ADR-005 D-13" for the no-silent-truncation
> rule in nine places, from phases before this one. D-13 is **Sorting**; the paging decision
> is **D-10**. The shorthand is left as it is rather than renumbered across nine files, but
> D-10 is the decision being departed from here.

**`mergeActivity` never splits a tie group**, and that is the rule most likely to look like a
bug. A bare `$lt` cursor drops rows sharing the boundary instant, and here that is routine
rather than theoretical: `assignPlan` writes the plan purchase and its credit allowance in
**one transaction**, so two collections carry the same `created_at`. The page is therefore
extended to the end of the tie group, which means **a page can come back longer than
`limit`**, and a final page can be empty. Deliberate: an over-long page is visible, a missing
money row is not.

**The top-up dedup rule was carried over, not rediscovered.** A paid top-up writes rows in
`credit_topups` **and** `credit_transactions` (`topup_purchase` / `topup_reversal`); every
credit read here excludes the ledger half, as jovi-mall's `VendorTransactionService` does.
Without it the feed double-counts, and it is pinned by a drift test that reads their source.

`/credits` answers through `sendSuccess`, **not** `sendPaginated`: `PaginationMeta` admits
scalars only, so `sendPaginated` would flatten the wallet and strip a balance of exactly the
`unit` / `currency` / `direction` that stop somebody adding it to a money figure.

### D-10 · `user_payment_methods` is absent from the collection table — the non-decision, recorded

Nine collections were added to `platform-collections.ts` at `access: 'read'`:
`cod_cash_ledger`, `cod_trust_events`, `earnings_allocations`, `earnings_reserve_holds`,
`credit_wallets`, `credit_transactions`, `credit_topups`, `plan_purchases`,
`billing_settings` — each with a `note` naming the invariant that keeps its writes in
jovi-mall.

**`user_payment_methods` was deliberately not added, and this is where that is recorded so
it is not re-raised as an omission.** It holds `gateway_customer_id` and
`gateway_instrument_id`, declared SECRET in jovi-mall and protected by DTO only — no
`select: false`, which would not help here anyway, since wi-admin reads with the raw driver
(the same mechanism as ADR-010 F-3). Leaving the collection out of the table means
`PlatformReadRepository` **cannot be pointed at it**: the type parameter accepts only
declared collections, so this is a compile error rather than a code-review question.

The same two fields are also embedded on `customers.saved_payment_methods`, which is
reachable; the customer projection excludes them by whitelist.

Nothing in the account surface needs a stored instrument. *Where the platform sends money*
is `payout_requests.payout_method_snapshot` (D-4/D-5). *How a customer paid* is
`payment_transactions`, whose gateway internals are banned separately.

### D-11 · Currency comes from `earnings_accounts` — the one direct read of it — and D-1 still holds

`earnings_ledgers` rows carry no currency. jovi-mall's own feed calls `getBalances` for that
one string, which here would put an HTTP call on an otherwise-entirely-direct feed and make
the account activity page fail when jovi-mall is down.

So `EarningsCurrencyReadRepository` reads `earnings_accounts` directly, and the projection
is `_id / owner_type / owner_id / currency` — **it cannot express a balance.** That is what
keeps D-1 intact: the delegated-balance rule is about the reconciled numbers, and this
projection has none of them. `test-accounts.ts` §5 scans the module for `pending_balance`,
`available_balance`, `reserve_balance` and `requested_balance` and refuses all four.

Also decided at build time, and worth stating because the alternative looks tidier:
**`listBefore` was added to money's ledger and payout repositories, and `listForOwner` to
cod's cash ledger, rather than declaring new projections inside `accounts/`.** One
projection per collection — and on `payout_requests` that projection is the one keeping a
beneficiary's account number in the database.

---

## The surface

`/api/v1` gained three mounts and completed a fourth: **43 routes**, of which **20 are
net-new**. The other 23 are the 5 COD routes Phase 4 already had, plus 18 routes retiring
all **21** legacy endpoints — 18 rather than 21 because two routes collapse a set each
(`POST /billing/subscriptions/:ownerType/:ownerId` absorbs three legacy paths,
`GET /cod/holders` absorbs two). The service composes at **141 routes**.

### `/billing` — 8 routes: 5 retiring 7 legacy endpoints, 3 net-new

| Method | Path | Access | Transport |
|---|---|---|---|
| `GET` | `/plans` | `billing.plans.read` | direct |
| `GET` | `/plans/:planId` | `billing.plans.read` | direct — net-new |
| `GET` | `/plans/:planId/subscribers` | `billing.plans.read` | direct — net-new |
| `POST` | `/plans` | `billing.plans.manage` | **delegated** |
| `PATCH` | `/plans/:planId` | `billing.plans.manage` | **delegated** |
| `DELETE` | `/plans/:planId` | `billing.plans.delete` | **delegated** (soft delete) |
| `GET` | `/subscriptions` | `billing.plans.read` | direct — net-new cross-owner queue |
| `POST` | `/subscriptions/:ownerType/:ownerId` | `billing.subscriptions.assign` | **delegated** |

The three net-new reads answer questions the legacy surface could not: a plan **detail**
(the catalog was list-only, so `commission_percent` was visible only by scanning a page),
the list of subscribers **on** a plan — asked immediately before editing that commission,
and too owner-scoped in jovi-mall to answer — and a cross-owner queue of terms about to
lapse. `billing_settings` gets no endpoint of its own; it is per-owner, and is read inside
the account view so *expires in N days* uses the platform's own `notify_days_before_expiry`.

The single wi-admin write path collapses the three legacy
`/{vendors,agencies,agents}/:id/plan` rows via a three-line switch in `billing.gateway.ts`.
That is routing, not logic.

### `/money` — 14 routes: 6 ports, 8 net-new

| Method | Path | Access | Transport |
|---|---|---|---|
| `GET` | `/earnings/platform` | `money.earnings.read` | **delegated** |
| `GET` | `/earnings/platform/ledger` | `money.earnings.read` | direct |
| `GET` | `/earnings/accounts` | `money.earnings.read` | **delegated** — net-new |
| `GET` | `/earnings/allocations` | `money.earnings.read` | direct — net-new |
| `GET` | `/earnings/allocations/:allocationId` | `money.earnings.read` | direct — net-new |
| `GET` | `/payouts` | `money.payouts.read` | direct, destination masked by projection |
| `GET` | `/payouts/:payoutId` | `money.payouts.read` | direct |
| `GET` | `/payouts/:payoutId/destination` | `money.payouts.destination.read` | direct, **audited** — D-5 |
| `GET` | `/payouts/:payoutId/activity` | `money.payouts.read` + `audit.read` | wi-admin's own DB |
| `POST` | `/payouts/:payoutId/mark-paid` | `money.payouts.mark_paid` | **delegated, dual-controlled ≥ 2,000,000** |
| `POST` | `/payouts/:payoutId/reject` | `money.payouts.reject` | **delegated** |
| `GET` | `/payments` | `money.payments.read` | direct — net-new |
| `GET` | `/payments/:transactionId` | `money.payments.read` | direct — net-new |
| `GET` | `/refunds` | `money.payments.read` | direct — net-new |

`/payouts/:id/activity` requires **both** `money.payouts.read` and `audit.read`, in `all`
mode: the rows name who resolved a payout and when, and gating on the payout permission
alone would make it a second door onto the audit trail.

### `/cod` — 16 routes: 5 already live, 7 retiring the remaining 8 legacy endpoints, 4 net-new

`GET /overview` and every write stay **delegated**; the records became **direct**.
`GET /holders` is the route that retires two legacy endpoints at once — `GET /cod/agents`
and `GET /cod/agencies` become one route with `?ownerType=agent|agency`, because they were
one question about two populations. The four net-new reads are the remittance detail, the
deposit detail, the discrepancy detail, and `GET /agents/:agentId/trust-events` — why an
agent's COD ceiling moved, which requires `cod.holders.read` **and** `agents.read`.

Two things the completion decided that the plan did not:

- **`GET /remittances` and `GET /deposits` stayed delegated** while their details became
  direct. The plan's route table has no row for them, and jovi-mall's own DTOs are already
  named-field mappings, so converting would change two live shapes for nothing. The cost is
  one resource on two transports, and `cod.dto.ts` pays it with a **superset rule asserted
  against jovi-mall's source**: every field the list DTO emits appears on the detail under
  the same name. **Do not "tidy" that away.**
- **Every COD write now reads its record first** — 404, audit `before`, and a label. Phase
  4's rows had no `before` because nothing here could read the record; that is no longer
  true, and leaving 2 of 7 writes without one would have been unexplainable.

### `/accounts` — all net-new

Five routes, the compositions in D-2. `GET /:ownerType/:ownerId` is the account view of D-3;
`/activity` is the cursor-paged merge of D-9; `/payouts`, `/credits` and `/cash-ledger` are
the three per-model feeds.

---

## The projection ban list

Enforced by **both** locks — the projection whitelist and named-field DTO mapping — and
source-scanned by `test-money.ts`, `test-billing.ts` and `test-cod.ts`, **including the
whole-subdocument forms** (`payout_method_snapshot: 1`, `verification: 1`, `mobile_money: 1`,
`bank: 1`, `card: 1`) that would drag a field back in.

| Field | Why never projected |
|---|---|
| `payout_requests.…mobile_money.phone_number` | The destination MSISDN. With an account name it is enough to social-engineer a redirect. Masked by default; full value only via D-5. |
| `…bank.account_number` | The destination bank account. Same treatment. |
| `…card.gateway_token` | A pull credential against a card. **Never disclosed, not even by the unmask.** |
| `vendors.payout_details` · `delivery_agencies.payout_details` · `delivery_agents.payout_details` | The same three values on the owner rows. Masked everywhere. |
| `payment_transactions.rawGatewayPayloads` | Raw provider JSON — payer phone, email, card metadata — with no schema bounding what a gateway put there. Same class as `agent_membership_events.metadata` (ADR-009 D-8): unbounded third-party content cannot be whitelisted field by field. |
| `payment_transactions.gatewayPayloadHash` | Webhook-verification material; moves an attacker measurably closer to forging a settlement callback. |
| `payment_transactions.idempotencyKey` | Dedup material; knowing it lets a caller suppress or collide a legitimate write. |
| `cash_collections.code_plain` | The customer's plaintext COD delivery OTP — the only API path by which a COD shipment reaches `delivered`. `select: false` **does not protect it** from the raw driver (ADR-010 F-3). |
| `cash_collections.code_hash` | A short numeric OTP's SHA-256 is brute-forced offline in milliseconds. |
| `cash_collections.verification.location` · `.ip` · `.device_info` | The agent's GPS fix, IP and device at handoff. `verification.method` alone is projected — `code` against `auto_no_code` is what a dispute turns on. |
| `user_payment_methods.gateway_customer_id` · `.gateway_instrument_id` | D-10 — the collection is absent from the table entirely, so no repository can be pointed at it. |
| `STRIPE_SECRET_KEY` · `*_WEBHOOK_SECRET` · `NOTCHPAY_API_KEY` · `MYCOOLPAY_API_KEY` · `FCM_PRIVATE_KEY` · `JWT_SECRET` · `INTERNAL_ADMIN_SERVICE_TOKEN` | Env-held, unreachable from a Mongo read. **Phase 11 builds no config-read endpoint of any kind.** |

**Reuse, do not re-declare.** `CashCollectionReadRepository` already carries the correct
ban-listed projection; no second projection of `cash_collections` was declared.

The ban-list scan in `test-money.ts` §3 was **relaxed, not widened**, and that matters on
resume: it walks the whole module directory (it was a hand-maintained file list, which would
have missed `payout-disclosure.ts` entirely) and asserts the two routing values are named
**exactly once each, inside `PAYOUT_DESTINATION_PROJECTION`**, matched as full dotted paths.
`gateway_token` and the three gateway internals stay at zero.

---

## Findings

Recorded as numbered findings per the ADR-008/009/010 precedent: fix what you are about to
build on top of, in the same phase.

| # | Finding | Disposition |
|---|---|---|
| **F-A** | `AdminPayoutRequestsController.list` returned `r.toObject()` and `.getById` the raw document — **`payout_method_snapshot` unmasked, on a live dashboard.** | **Fixed, step 0.** All four endpoints now map named fields through `earnings/dto/admin-payout-request.dto.ts`. Blocking, because Phase 11 mounts that same router internally. |
| **F-B** | `payout_requests.resolved_by` and `subscriber_plans.assigned_by` were `ref: MODELS.USER` with **no `*_source` / `*_name` companions**. A wi-admin write would have left an id resolving in no collection with no discriminator — the state ADR-004 D-1 says is safe *only because* of the companions. | **Fixed, step 0.** `...actorStampFields('resolved_by')` / `('assigned_by')`, all three written through `actorStamp()`. Blocking: without it Phase 11 manufactures dangling ids from its first call. |
| **F-C** | `POST /api/payments/initiate` and `/verify` carry no `requireAuth`. | **WITHDRAWN — not a defect.** A payment link is *shareable* by design: a mother orders and sends the link to her son, who holds no account and must still be able to pay it. The surrounding code shows it was considered, not forgotten — `GET /:transactionId` on the same router **is** authenticated and payer-scoped, and 404s rather than 403s so the id is not an existence oracle. The open responses are narrow (`{ transactionId, status, instructions, message }`; no amount, no counterparty, no payer PII), so guessing an id buys the ability to pay somebody else's order. **Nothing to do. Recorded so it is not re-raised.** |
| **F-D** | The three admin finance controllers hand-rolled `res.status(200).json({success:true,…})` instead of `sendSuccess`/`sendPaginated`, and `AdminPayoutRequestsController` called `.parse()` inline rather than using validator middleware. | **Fixed, step 1**, while the factory conversion had all three files open. |
| **F-E** | `toAuditRow` never checks `intent.target.type` against `auditSpec(action).target`. The catalog's `target` column is documentation, not a constraint — a call site can record a `payout` action against a `vendor` target, silently changing `subject_class` and therefore **who may read the row**. | **Still open.** The plan assigned it no step and this phase added thirteen call sites that would benefit. If it lands, guard it **before** `mergeTarget`, or `recordQueued`'s deliberate `approval_request` override — now live via `auditedQueue` — breaks. |
| **F-F** | `cod.routes.ts`'s header said "Four endpoints out of the thirteen" while declaring five, and "Phase 5 adds the remaining nine" when eight remained. | **Fixed, step 4**, alongside the mixed-transport header rewrite. |

### Two defects this phase found in its own service

Both were live, both were invisible to every DB-free suite, and both were found only because
a new endpoint traversed an old path.

- **Every agent name on every shipment list, shipment detail and offer row was `null`, since
  Phase 9/10.** `AgentReadRepository.findNamesByIds` projected **`display_name`** against
  `delivery_agents`, where the field is **`name`** (`display_name` is the *agency's*). Mongo
  answers a projection of a missing field with silence, and `AgentReadModel extends Document`
  makes the property access compile — so it hid behind a well-formed 200. Fixed, plus a drift
  guard in `test-agents.ts` that reads jovi-mall's model and refuses any projected path not
  declared there (`*_source` / `*_name` excepted when `actorStampFields('<prefix>')` generates
  them). The guard was verified to catch the original bug.
- **`GET /api/v1/agencies` and `GET /api/v1/agencies/:id` answered 500 on every request since
  Phase 9.** `AgencyReadRepository` passed `{ magazin: MAGAZIN_PROJECTION }` as the **outer**
  `$project` on both read paths. That object carries `_id: 0`, which is legal inside the
  `$lookup`'s own pipeline and **illegal one stage later** — a nested exclusion inside an
  inclusion projection, which Mongo refuses outright. Valid TypeScript, valid JSON, invalid
  only to `$project`. Found because `/accounts/agency/:id` reads an agency through the same
  repository and was the first *live* suite to touch that path. Fixed with
  `KEEP_MAGAZIN = { magazin: 1 }` — the inner `$project` is the whitelist, the outer only
  names the field. `assertInclusionOnly` now **recurses** (it checked the top level only,
  which is why it did not catch it) and is exported.

The lesson both carry: **a projection error is silent by construction.** The two mechanisms
added here — the model-derived drift guard and the recursive inclusion check — are the
generalisable part.

---

## Consequences

**`LEGACY_ENDPOINT_COUNT` 59 → 38.** All 21 finance rows are gone: billing 7, COD 8, money
6. The jovi-mall `/api/admin/*` twins stay live until the Phase 8 cutover, dual-mounted
through the ADR-004 D-5 factory.

**jovi-mall gained three internal endpoints and one repository method**, all delegated
*verdicts*: `GET /earnings/balances/:ownerType/:ownerId`, `GET /earnings/accounts` (backed by
a new `EarningsAccountRepository.listForAdmin`), and
`GET /billing/entitlements/:ownerType/:ownerId`. `getBalances` was already generic over owner
and had only ever been called with `'platform'`.

**Two indexes were added to jovi-mall's `subscriber-plan.model.ts`** (`{plan_id, created_at}`,
`{created_at}`). Every query there is single-owner, so the two cross-owner lists — the plan's
subscriber list and the expiry queue — would have been collection scans. Phase 9 precedent:
`delivery_agencies` gained its first indexes with its directory.

**`billing.plans.delete` was granted to no tier but Developer**, because it is flagged
`destructive` and `allInFamily('billing')` refuses those — a Phase-3 omission nobody hit while
no route declared it. It is now named into the tier-2 ADMIN block beside
`content.articles.delete`. **Reverse it in one line if that is not wanted.**

**`money.payments.read` is swept into Admin by `allInFamily('money')` and was additionally
granted to Support explicitly**, so Support can answer *did this payment go through* without
holding anything that moves money.

**Four new DB-free suites and four new live ones.** `test:billing` 72, `test:cod` 67,
`test:money` 94, `test:accounts` 51; sixteen DB-free suites green at **1269 assertions**.
`verify:billing` 49 (needs a running jovi-mall), `verify:cod` 30, `verify:money` 62,
`verify:accounts` 47 (Mongo only; its OVERVIEW section additionally needs jovi-mall and skips
loudly without it). jovi-mall's `test:payout-methods` 53 → 62.

**Thirteen new audit actions, and no new target type.** `billing.subscriptions.assign` is
**three** actions — `assign_vendor` / `assign_agency` / `assign_agent` — because
`AuditActionSpec.target` is a single `AuditTargetType` and `buildQueryFilter` matches on
`target_type` / `target_id` only. One action with `target: 'plan'` and the owner as
`relatedTarget` would **silently never appear on `/vendors/:id/activity`**. Precedent:
`agents.unban`, `administrators.reinstate`.

**The service still works when jovi-mall is down, and more of it than before.** Every direct
read in these four modules answers; only the verdicts and the writes 502 with jovi-mall's own
code in `details.platformCode`. That is the practical payoff of D-1 and it is the reverse of
what ADR-004's original rows implied.

---

## Deploy notes

**Order matters at step 0.** F-A and F-B ship to jovi-mall *before* any wi-admin route
reaches them. F-B is the harder constraint: a payout marked paid by an admin caller before
the `*_source` / `*_name` companions exist writes a dangling id into a live money record,
and there is no backfill that can recover who it was.

**`LEGACY_ENDPOINT_COUNT` is shared.** If `test:authz` fails on the count after a merge,
another phase moved it concurrently — reconcile rather than overwrite. It fails loudly by
construction.

**Exercise the fail-closed path by hand at least once.** Break the audit connection and call
`GET /money/payouts/:id/destination`: it must error and disclose nothing. That property (D-5)
is the reason for the transport choice, and no automated suite in this repo can assert it.

**The dual-control boot assertion is load-bearing.**
`src/modules/money/domain/payout-dual-control.ts` registers at module scope and
`money.routes.ts` imports it for side effect, so registration completes before
`assertDualControlHandlersRegistered()` runs in `createApp()`. Without the import the service
refuses to boot — designed behaviour, and better than discovering it at approval time.

---

## Still open

- **F-E is unfixed.** The catalog's `target` column remains documentation. Thirteen new call
  sites now depend on it being right.
- **`toAuditRow`'s sibling problem: nothing asserts the ban list at runtime.** The projection
  scans are source scans in the test suite. A projection built dynamically would evade them.
  No such projection exists today, and `assertInclusionOnly` is the closest runtime guard.
- **The approval-expiry sweep is throttled.** A concurrent refactor of `dual-control/` added
  `ADMIN_APPROVAL_SWEEP_MIN_INTERVAL_MS` (default 10s) with a module-level `lastSweepAt`, so
  `approve()`'s "don't act on an expired one" guard — which calls `expireOverdue()` — is
  best-effort for up to that interval. Nothing in Phase 11 touches that path, and the
  `LARGE_PAYOUT` handler re-checks payout state independently, so a stale approval cannot
  double-pay. It still deserves an owner.
- **Nobody has named an amount for `orders.refund`.** ADR-010 left dual control on refunds
  unwired for exactly that reason; this phase wired the machinery for payouts and the
  precedent now exists.
- **No alerting on the disclosure row.** `sensitive: true` puts
  `money.payouts.destination.read` on the alerting axis, and there is still no alerting —
  the same gap ADR-006 recorded for `administrators.auth.refresh_reuse_detected`. Forty
  unmasks in an hour is currently a query somebody has to think to run.
- **wi-admin has no door into geo-tracker**, and this phase did not build one. Unchanged from
  ADR-009 D-2.
