# ADR-008 — Vendor management

**Status:** accepted · **Implements:** the vendor-management brief; the `vendors` half of
blueprint Phase 6 · **Follows:** [ADR-004](./ADR-004-DOMAIN-OWNERSHIP.md) (ownership),
[ADR-005](./ADR-005-API-CONTRACT.md) (contract), [ADR-007](./ADR-007-USER-MANAGEMENT.md)
(the shape this mirrors)

---

## Context

PHASE-0 found the vendor domain had no admin surface anywhere. There was no
`/api/admin/vendors` in jovi-mall and no `/api/v1/vendors` here; the only vendor-touching
admin endpoint on the platform was `POST /api/admin/vendors/:vendorId/plan`, which assigns
a billing plan. An administrator could not look a vendor up.

Two capabilities existed in jovi-mall as **dead code with zero callers**:

- `VendorRepository.setLegitVerified` — business verification. The blueprint names wiring
  it as the work (`IMPLEMENTATION-BLUEPRINT.md:186`).
- `VendorRepository.updateStatus` — vendor status. Keyed on `user_id` rather than the
  vendor id, and unguarded.

So vendor verification and vendor suspension had never been performable by anyone.

Exploration turned up a third fact that shaped the whole phase. **`Vendor.status` was
enforced nowhere.** The three guards that would read it — `requireActiveUser`,
`requireRoleEntityActive`, `requireLegitBusiness` in `jovi-mall/src/modules/auth/guards/index.ts`
— all have zero call sites. Its only reader anywhere was
`VendorRepository.findAvailableForAgencies`, which hides `inactive` vendors from the agency
directory. This is exactly the state `User.status` was in before ADR-007, and shipping a
suspend button over it would have shipped a label.

Two latent defects were found alongside, and both are fixed here because this phase makes
them reachable:

1. **`setLegitVerified` was half a no-op.** It `$set` both a top-level `legit_verified` and
   `kyc_details.legit_verified`, but the top-level schema path was commented out
   (`vendor.model.ts:349`), so Mongoose strict mode silently stripped it. The one reader of
   that field, `requireLegitBusiness`, therefore evaluated `undefined !== true` — it would
   have denied **every** vendor the day anybody attached it.
2. **`markEmailVerified` was an unconditional `status: 'active'`.** Harmless while nothing
   wrote any other value; the moment an administrator can suspend a vendor, it means a
   suspended vendor lifts their own suspension by re-clicking an old verification link.

---

## Decisions

### D-1 · Direct read, delegated write — and the gap is wider than it was for users

The list, the detail, the vendor's catalogue and the activity feed read `jovi_mall`
directly. All seven writes go over `/api/internal/admin/vendors`.

For users the argument was that a suspension is only *meaningful* because jovi-mall's auth
path refuses a non-active account. Here it is stronger: suspending a vendor **takes their
entire catalogue off sale inside the same transaction**, and reinstating them **re-runs the
activation gate on every listing** rather than republishing blindly. A second writer would
move the status, miss the cascade, and leave a "suspended" vendor still selling.

### D-2 · Suspension blocks the vendor's API access — narrowly, and by one value only

`requireAuth` and `login` refuse a vendor whose role entity is `inactive`
(`403 AUTH_VENDOR_SUSPENDED`).

**`=== 'inactive'`, never `!== 'active'`.** `pending_verification` is the schema default at
vendor registration, so the negated form would have refused every vendor who never verified
their email — a mass lockout on the deploy that shipped it. Refusing only `inactive` is
provably a no-op against existing data, because nothing wrote that value before this phase.

`test-vendors.ts` asserts the narrow form is what is in the file, and
`verify-vendors-live.ts` plants a `pending_verification` vendor specifically to prove it
stays untouched. A future "tidy-up" into `!== 'active'` fails a suite rather than
production.

Its own error code, not `AUTH_ACCOUNT_SUSPENDED`: "your login is suspended" and "your shop
is suspended" have different remedies, and one account can hold both `vendor` and
`customer`. **The two statuses do not cascade into one another**, in either direction —
ADR-007's rule, read from the other side.

### D-3 · Two new suspension reasons, deliberately disjoint from every existing sweep

`ProductSuspensionReason` gains `vendor_suspended` (the cascade) and `platform_oversight`
(one listing, by an administrator). The platform now has four disjoint reason sets:

| Set | Members | Owner |
|---|---|---|
| `DELIVERY_AGENCY_REASONS` | 3 | `ProductDeliveryAgencySuspensionService` |
| `agency_storage_suspended` | 1 | `AgencyStorageSuspensionService` |
| `vendor_suspended` | 1 | `ProductPlatformSuspensionService` |
| `platform_oversight` | 1 | `ProductPlatformSuspensionService` |

**None may ever be widened to include another's members.** The consequence that matters:
reinstating a vendor must not republish a listing an administrator took down on its merits,
so oversight gets its own reason and its own restore endpoint. `platform_oversight` is a
human act, so — exactly like `agency_storage_suspended` — nothing automatic clears it.

The cascade covers **every product type**, unlike the delivery-agency one. That sweep is
physical-only because it is about delivery; a digital download has no agency to break. A
vendor suspension is about the vendor, and a shop whose downloads and bookable services
kept selling would not be suspended in any sense a customer could observe.

The Mongoose `enum` is now spread from `PRODUCT_SUSPENSION_REASONS` rather than
hand-maintained beside the union — jovi-mall's own convention, and the drift that already
cost that codebase eight silently-undelivered notifications.

### D-4 · The restore hole is closed in the activation gate, not in the cascade

The cascade takes listings off sale, but it is not the only thing that puts them back.
Three other paths restore a product to `active`: the delivery-agency cascade, the
agency-storage unsuspend, and the vendor's own activation. Without a guard, an agency
problem resolved **while a vendor is suspended** would walk their listings back onto the
storefront — `restoreForVendor` sweeps by its own reasons and knows nothing about the
vendor's status.

So the rule lives in `ProductStatusValidationService.collectActivationBlockers`, the one
function that answers "may this product be on sale":

```
vendor.status === 'inactive'  →  CATALOG_PRODUCT_VENDOR_SUSPENDED
```

That closes all four paths at once, and closes the ones added later by construction. The
vendor was already loaded there for physical products; it is now loaded once above that
branch and reused.

### D-5 · The KYC verdict is three-valued, and its reason lives in jovi-mall

`kyc_details` gains `status: 'pending' | 'verified' | 'rejected'`, `verified_at`,
`rejection_reason` and a reviewer actor stamp — the shape `DeliveryAgent.kyc` already uses.

The boolean alone could not tell **never reviewed** from **reviewed and rejected**: both
were `false`. A review queue is unbuildable over that, which is why the list's `kycStatus`
filter needed three values and why the queue would otherwise have opened empty.
`legit_verified` stays as the boolean projection of `status === 'verified'`, because
`agency-vendor-browse.dto.ts` renders `kycVerified` from it; the two are written in one
`$set` and never apart.

**The rejection reason is stored in jovi-mall, not only in wi-admin's audit row.**
jovi-mall cannot read this database — that is the point of the separation — so a reason
held only here could never be shown to the vendor it is about, and a rejection somebody
cannot see the cause of is one they can only answer by re-submitting blind.

No migration: existing rows carry `legit_verified: false` and pick up `status: 'pending'`
from the schema default. The list filter's `pending` branch is deliberately tolerant of
rows written before the field existed, so the queue is correct with or without a backfill.

**Verification still gates nothing.** It is visible to agencies and it is now settable and
explicable, but no vendor behaviour depends on it. That was an explicit product decision —
gating selling on it would lock out the entire existing roster until each vendor is
reviewed. Recorded here so nobody later assumes it was already enforced.

### D-6 · The directory is three queries, not one aggregation

The business name lives on `stores`, so the obvious move is jovi-mall's own `$lookup` +
`$facet` pipeline. It is not taken. A post-`$lookup` `$sort` cannot use an index and cannot
carry the `_id` tiebreaker that keeps skip/limit paging stable, so every page would
blocking-sort every matched vendor in memory.

Instead: resolve the search term against `stores` first (one indexed query), page `vendors`
on its own index, then hydrate the page's stores in one batched read.

Two costs, both accepted and both stated on the wire rather than hidden:

- **Business name is not a sort key.** `VENDOR_SORT` offers `createdAt`, `updatedAt` and
  `email`, each index-backed.
- **The store pre-match is capped at 500.** ADR-005 D-13 forbids a silent cap, so the
  response carries `meta.businessNameMatchesTruncated` when it bites.

A 24-hex search term is tried as the vendor id **and** as the user id. Every other admin
screen identifies this person by their user id, so that is what gets pasted in.

### D-7 · Product audit rows target the vendor

`vendors.products.suspend` and `vendors.products.restore` are filed under
`target: 'vendor'`, with the product id and title in `payload`.

A `product` target type would be cheap to add — `audit-subject.ts` classifies by an
exhaustive `Record`, so a miss is a compile error. But the vendor activity feed filters on
`targetType: 'vendor'`, so a separate type would silently drop every product takedown out
of the one feed where an administrator would look for it: *this vendor's listings went
dark, why*. Promote it when a product admin screen exists to read it — not before.

### D-8 · `vendors.settings.manage` governs order settings, not commission

The permission's catalog summary said "commission and platform settings" and that was
wrong. Commission lives on `PricingPlan.commission_percent` and is set by assigning a plan
through jovi-mall's existing `POST /api/admin/vendors/:vendorId/plan`.

What this governs is three scalars on `vendor_settings`, chosen by one rule: **a setting is
the administrator's when its effect lands on somebody other than the vendor.**

| Field | Admin | Why |
|---|---|---|
| `auto_cancel_unpaid_days` | write | Drives a platform sweep worker; a vendor setting it to 90 keeps stock reserved against orders nobody will fulfil |
| `auto_redirect_orders_to_agency` | write | Decides whether shipments advance without vendor confirmation — the effect lands on the agency and the customer, and it is the lever support needs when a vendor goes dark |
| `auto_redirect_threshold_amount` | write | Inseparable from the flag; changing one alone is how a cap silently disappears |
| `notify_days_before_expiry` | read only | A notification to the vendor, about the vendor |
| `customer_flags[]` | neither | Their private CRM vocabulary, referenced by `VendorCustomer.flag_ids` |

`.strict()` means naming an excluded field is a **400 here, before the wire**. A request
that looks like it changed a commission must never come back 200 having changed nothing.

`Vendor.policies.return_policy.inspector` is excluded despite being admin-flavoured:
writing `policies` bumps `policy_version`, which pauses every agency connection pending
reapproval, and that cascade belongs to the vendor's own policy path.

### D-9 · No new permissions, and no new flags

The five in the catalog since Phase 3 cover all eleven routes. Reusing them means **zero
policy change**: Support already holds `vendors.read`, Admin already sweeps
`allInFamily('vendors')`.

⚠️ **None is flagged sensitive, and that is load-bearing.** `allInFamily()` excludes
sensitive entries, so flagging `vendors.suspend` would silently drop it from tier 2 — and
`assertGrantTableValid()` would **not** catch it, because tier 1 still holds everything. If
a vendor write ever earns a flag, it must also be named by hand in ADMIN's explicit list,
beside `audit.export`. `test-vendors.ts` asserts the current state with that reason
attached.

---

## The surface

| Method | Path | Access |
|---|---|---|
| GET | `/vendors` | `vendors.read` |
| GET | `/vendors/:vendorId` | `vendors.read` |
| GET | `/vendors/:vendorId/products` | `vendors.read` |
| GET | `/vendors/:vendorId/activity` | `vendors.read` **+** `audit.read` (`all`) |
| POST | `/vendors/:vendorId/suspend` | `vendors.suspend` |
| POST | `/vendors/:vendorId/restore` | `vendors.suspend` |
| POST | `/vendors/:vendorId/kyc/approve` | `vendors.kyc.review` |
| POST | `/vendors/:vendorId/kyc/reject` | `vendors.kyc.review` |
| POST | `/vendors/:vendorId/products/:productId/suspend` | `vendors.products.manage` |
| POST | `/vendors/:vendorId/products/:productId/restore` | `vendors.products.manage` |
| PATCH | `/vendors/:vendorId/settings` | `vendors.settings.manage` |

**Not offered, deliberately:** billing, earnings and payouts (behind `billing.read` and
`money.read`, with their own surfaces — assembling them here would let `vendors.read` alone
reach what those permissions gate); editing the vendor's profile, addresses, policies or
payout destinations (theirs); a catalogue search across vendors (a different surface).

---

## Consequences

- **A vendor suspension is now a real act with a blast radius.** It stops their API access
  and their sales. The response and the audit row both carry the cascade counts, because
  "this took 47 listings off sale" is a fact only that row will hold.
- **A restore returns fewer listings than the suspension took, routinely.** Anything that
  no longer passes the activation gate stays down. That is correct, not a partial failure,
  and both numbers are reported so an operator is not left guessing.
- **Two jovi-mall bugs are fixed as a side effect**, and one wi-admin bug: the
  `role-profile.read.repository.ts` vendor entry projected the dead top-level
  `legit_verified`, so the **user** detail screen has been reporting a stale or empty
  verification verdict for every vendor since Phase 6.
- **`requireLegitBusiness` is still dead code**, now carrying a warning. Deleting the three
  unreferenced guards is its own change; attaching this one without moving it to
  `kyc_details.legit_verified` would refuse every vendor.

### Deploy note

The enforcement in D-2 is the only behaviour change against live traffic, and it is
designed to be a no-op. Confirm before rolling out:

```
db.vendors.countDocuments({ status: 'inactive' })   // must be 0
```

Nothing wrote that value before this phase — `updateStatus` had no callers and
`markEmailVerified` only ever wrote `'active'`. ADR-007 called for the same check on
`users.status`, where it was **not** a no-op.

---

## Still open

- **A `review.status` backfill.** The `pending` filter is correct without one, at the cost
  of a two-branch `$or`. Worth running only if the vendor collection grows large.
- **Re-review on a KYC data change.** A vendor editing their national ID number no longer
  resets their verification — the old reset was an artefact of Mongoose replacing the
  whole sub-document, which also fired when they re-submitted the same number. If
  re-review should be required, it is a deliberate rule that needs a notification, not a
  silent flip.
- **`UserSchema.index({ updated_at: -1 })`.** `USER_SORT`'s comment claims `updated_at` is
  covered by `{ status, roles, created_at }`. It is not. One line, separable from this
  phase — and `VENDOR_SORT` has the same gap.
- **Deleting the three dead auth guards** in jovi-mall.
