# Backend Integration Matrix

**Phase 0 — discovery only. No code was written.**
Date: 2026-08-13 · Source of truth: `docs/admin/api/` (21 files) · Service: `wi-admin`, port **8033**, base path **`/api/v1`**

Every endpoint, permission and field below was read out of `docs/admin/api/`. Nothing is inferred.
Where a module needs something the contract does not provide, it is listed as a **gap**, not filled in.

**The dashboard calls wi-admin and nothing else.** No jovi-mall URL, no geo-tracker URL, no second
token, no second base URL.

---

## Summary — the twelve requested modules

| Frontend module | Backend endpoint(s) | Permission(s) | Data model |
|---|---|---|---|
| **Dashboard** (home) | **No aggregate endpoint exists.** Composed from `GET /notifications/unread-count`, `GET /approvals?status=pending`, `GET /cod/overview`, `GET /money/earnings/platform`, `GET /system/health`, `GET /system/maintenance` | Union of `notifications.read`, `approvals.read`, `cod.overview.read`, `money.earnings.read`, `system.health.read`, `system.maintenance.read` — each tile independently gated | No `Dashboard` DTO. Each tile renders its own source object |
| **Users** | 6 routes under `/users` | `users.read` · `users.update` · `users.suspend` (+ `audit.read` on activity) | `User { id, email\|null, phone\|null, roles[], status, suspension\|null, createdAt, updatedAt }` + `profiles[]` on detail |
| **Vendors** | 11 routes under `/vendors` | `vendors.read` · `vendors.kyc.review` · `vendors.suspend` · `vendors.products.manage` · `vendors.settings.manage` (+ `audit.read`) | `Vendor` + `store`, `account`, `verification`, `contact`, `addresses[]`, `policies`, `settings`, `counts` · `VendorProduct` |
| **Agencies** | 8 routes under `/agencies` | `agencies.read` · `agencies.verify` · `agencies.deactivate` · `agencies.reactivate` (+ `agents.read`, `audit.read`) | `Agency` + `kyc`, `policies`, `coverageAreas[]` · `AgentContract` · `ContractHistoryEvent` |
| **Agents** | 15 routes under `/agents` | `agents.read` · `agents.status.set` · `agents.kyc.review` · `agents.tracking.set` · `agents.cod_threshold.set` · `agents.ban` · `agents.transfer` (+ `agencies.read`, `audit.read`) | `Agent` + `operational`, `kyc`, `ban`, `tracking`, `capacity`, `cod`, `vehicle`, `homeBase` · 3 delegated verdict objects |
| **Orders** | 10 routes under `/orders` | `orders.read` · `orders.disputes.read` · `orders.disputes.resolve` · `orders.intervene` · `orders.refund` (+ `audit.read`) | `Order` + `priceBreakdown`, `dispute`, `completion`, `deliveryAddress`, `items[]` · `TimelineEvent` · `RefundEligibility` |
| **Accounts** | 5 routes under `/accounts/:ownerType/:ownerId` | Composite: `money.earnings.read` + `billing.plans.read` + `cod.overview.read`; sub-routes narrow to one family. **No `accounts` permission family exists** | `Account { owner, profile, subscription, balances{earnings,credits,codCash}, codExposure, payouts, flags }` · `ActivityEntry` (cursor) · `CreditEntry` · `CashLedgerEntry` |
| **Administrators** | 17 routes under `/administrators` | `administrators.read/create/update/suspend/tier.set/sessions.read/sessions.revoke/password.reset/mfa.reset` (+ `audit.read`; `me` routes are *self*) | `Administrator { id, email, displayName, tier, tierLabel, status, jobTitle, department, timezone, preferredLanguage, mfaEnrolled, lastLoginAt, createdBy, suspended*, tierChanged*, createdAt }` · `AdminSession` |
| **Audit** | 8 routes under `/audit` | `audit.read` (row-scoped) · `audit.export` | `AuditEntry { occurredAt, completedAt, correlationId, action, actionFamily, status, sensitive, actor, target, relatedTarget, request, outcome, viaApprovalId, delegated, exportedAt, purgeAfter }` (+ `payload`/`before`/`after` on detail) · `AuditExport` · `LegacyAuditRow` (different shape) |
| **Notifications** | 10 routes under `/notifications` | `notifications.read`; preferences are *self* | `Notification { id, type, severity, title, body, source, target, actionPath, occurredAt, readAt, archivedAt, isRead, isArchived }` · `NotificationSource` · `NotificationPreference` |
| **System** | 17 routes under `/system` | `system.health.read` · `system.workers.read` · `system.outbox.read` · `system.metrics.read` · `system.maintenance.read` · `system.errors.read` · `developer_tools.config.read` · `developer_tools.logs.read` · `developer_tools.cache.inspect` · `developer_tools.database.inspect` | wi-admin: `{ dependencies, audit }`, `{ config }`, `{ depth, oldestPendingAt, maxAttempts, totalUnsent }`. Platform reads pass through the platform's own objects. `ErrorJournalEntry` in **three projections** |
| **Developer Tools** | 9 routes under `/dev-tools` | `developer_tools.feature_flags.read/set` · `developer_tools.workers.trigger` · `developer_tools.outbox.replay/prune` · `developer_tools.catalogue.vectorise` · `developer_tools.maintenance.set` · `developer_tools.cache.flush` · `system.workers.read` | `FeatureFlag { name, enabled, default, consumer, summary }`; every other response is the platform's own result object |

### Modules the request did not list but the contract requires

| Frontend module | Backend endpoint(s) | Permission(s) | Data model |
|---|---|---|---|
| **Auth** (login, MFA, own session) | 11 routes under `/auth` | **None** — every route acts on the caller's own identity | `AdminProfile` · `Session` · `MfaEnrolment { secret, otpauthUri }` |
| **Permissions** | 3 routes under `/permissions` | `catalog` + `me` are *self*; `tiers` needs `permissions.read` | `PermissionCatalog { families[], permissions[], total: 110 }` · `MyPermissions { adminId, tier, tierLabel, permissions[] }` · `TierMatrix` |
| **Approvals** (four eyes) | 5 routes under `/approvals` | `approvals.read`; approve/reject are **dynamic** (the pending action's own permission); withdraw is *self* | `Approval { id, action, description, status, requestedBy, requestedByTier(Label), targetType, targetId, payload, approverId, decidedAt, decisionNote, failureReason, expiresAt, createdAt }` |
| **Shipments** | 6 routes under `/shipments` | `shipments.read` · `shipments.reassign` · `shipments.cancel` (+ `agents.read`, `audit.read`) | `Shipment` + `assignment`, `statusHistory[]`, `handover`, `deliveryFailures[]`, `rejection`, `cod`, `offers[]`, `items[]`, `tracking.outbox` · `ShipmentOffer` |
| **COD** | 16 routes under `/cod` | `cod.overview.read` · `cod.holders.read` · `cod.remittances.read/confirm/reject` · `cod.deposits.read/create/confirm/reject` · `cod.discrepancies.read/resolve` · `cod.trust.adjust` (+ `agents.read`) | `CodHolder` · `Remittance` + `cashMovements[]` · `Deposit` + `cashMovements[]` · `Discrepancy` + `deposit`, `trustEvents[]` · `TrustEvent` |
| **Billing** | 8 routes under `/billing` | `billing.plans.read` · `billing.plans.manage` · `billing.plans.delete` · `billing.subscriptions.assign` | `PricingPlan { role, code, name, price, currency, termDays, creditAllowance, limits{}, isActive, sortOrder, archivedAt }` · `Subscription { owner, plan, status, startedAt, expiresAt, assignedBy, paymentReference, allowanceGranted }` |
| **Money** | 14 routes under `/money` | `money.earnings.read` · `money.payouts.read` · `money.payouts.mark_paid` · `money.payouts.reject` · `money.payouts.destination.read` · `money.payments.read` (+ `audit.read`) | `EarningsLedgerEntry` · `Allocation` + `movements`, `siblings` · `Payout` + `destination{masked,full}` · `PaymentTransaction` · `Refund` |

**Total: 179 versioned endpoints across 18 route groups, plus 2 unversioned health probes**
(`GET /health/live`, `GET /health/ready`). Counted per group below; the sum matches the figure stated
in `docs/admin/api/README.md`.

---

# Module detail

Legend — **Transport**: `direct` = read served from the platform database by wi-admin ·
`delegated` = executed by jovi-mall on the dashboard's behalf (can return `502`/`503` or
`PLATFORM_OPERATION_REJECTED` with `details.platformCode`) · `local` = wi-admin's own state.

---

## 1. Dashboard (home)

**Verified: there is no dashboard endpoint.** The 18 built route groups are `/auth`,
`/administrators`, `/permissions`, `/approvals`, `/audit`, `/users`, `/vendors`, `/agencies`,
`/agents`, `/orders`, `/shipments`, `/cod`, `/billing`, `/money`, `/accounts`, `/system`,
`/dev-tools`, `/notifications`. None of them exposes an aggregate, summary, KPI or stats route.

The home page must therefore be **composed from independently permissioned tiles**, each of which
disappears rather than erroring when the administrator does not hold its permission.

| Tile | Endpoint | Permission | Notes |
|---|---|---|---|
| Unread inbox badge | `GET /notifications/unread-count` | `notifications.read` | All three tiers. Polled — there is no realtime |
| Waiting for approval | `GET /approvals?status=pending` | `approvals.read` | Tiers 1–2. `status` already defaults to `pending` |
| Platform cash position | `GET /cod/overview` | `cod.overview.read` | Tiers 1–2. **Delegated** — can 502/503 |
| Platform earnings | `GET /money/earnings/platform` | `money.earnings.read` | Tiers 1–2. **Delegated**. Oversight only — the marketplace never pays itself out, so no payout pipeline on this account |
| Service health | `GET /system/health` | `system.health.read` | Tiers 1–2. Includes `audit.danglingIntents` |
| Maintenance banner | `GET /system/maintenance` | `system.maintenance.read` | **Render `effectiveMode`, not `storedMode`** — they differ once a window has passed its expiry |

**A Support (tier 3) administrator's home page has only the inbox tile.** Support holds none of the
other five permissions. This is the design, not a bug — plan the empty state deliberately.

**Gap D1:** no single-call KPI payload. Do not invent one; compose client-side.

---

## 2. Users — `/users` · 6 endpoints

Design record: `ADR-007-USER-MANAGEMENT.md`. A `users` row is the sign-in identity; vendor/agency/
agent/customer profiles hang off it.

| Method | Path | Permission | Transport | Audited |
|---|---|---|---|---|
| GET | `/users` | `users.read` | direct | — |
| GET | `/users/:userId` | `users.read` | direct | — |
| GET | `/users/:userId/activity` | `users.read` **+** `audit.read` | direct | — |
| PATCH | `/users/:userId` | `users.update` | **delegated** | ✅ |
| POST | `/users/:userId/suspend` | `users.suspend` | **delegated** | ✅ |
| POST | `/users/:userId/restore` | `users.suspend` | **delegated** | ✅ |

**Tiers:** `users.read` is Support-level. Both writes are Admin and above.

**List:** sort `createdAt` · `updatedAt` · `email`, default `-createdAt`. Filters `search` (email,
phone, or the user id when the term is 24-hex), `role` (`vendor|agency|agent|customer` — **`admin`
is deliberately absent**), `status`, `from`/`to` (max 366 days).

**Data model — `User`:** `id`, `email|null`, `phone|null` (the login identifiers, either may be
absent), `roles[]`, `status` (`active|suspended`), `suspension|null` (**present only while
suspended**; `{ at, reason, by: { id, source, name } }`), `createdAt`, `updatedAt`.

> **Corrected 2026-08-14, Phase 6.** This line previously claimed a `suspension.fromStatus`
> field. **There is no such field** — the DTO is built by name at
> `backend/admin/src/modules/users/controllers/user.controller.ts:91-102` and has exactly three
> keys. `users.md` documents only `suspension.by`, so the rest was inferred here and one of the
> three was wrong. `by.source` is `'platform' | 'admin'`
> (`backend/jovi-mall/src/core/types/actor-source.types.ts:33`), and an `'admin'` id resolves only
> in the wi-admin database — do not render it as a link to a platform user.

**Detail adds `profiles[]`** — one entry per role in `roles` order:
`{ role, id, name|null, verified|null (vendor+agency only), kycStatus|null (agent only), createdAt, missing?: true }`.
**`missing: true` must be rendered prominently** — the role is on the `users` row but its entity does
not exist, which stops the person signing in and is otherwise invisible.

**Write shapes:** `PATCH` body is **strict**, needs at least one of `email`/`phone`, both
**clearable** with `""` or `null`; format is validated by jovi-mall, not here, and comes back as
`PLATFORM_OPERATION_REJECTED` with `details.platformCode`. `suspend` requires `reason` (3–500).
`restore` takes no body. Note the **write responses use jovi-mall's flat DTO**
(`suspendedAt`/`suspendedReason`/`suspendedBy`) rather than the nested `suspension` object the reads
return — same facts, different shape.

**Gap D6:** `users.roles.manage`, `users.sessions.revoke` and `users.password.reset` are catalogued
permissions with **no routes**, each for a stated reason. No role editor, no force-sign-out, no
password reset on this screen.

---

## 3. Vendors — `/vendors` · 11 endpoints

Design record: `ADR-008-VENDOR-MANAGEMENT.md`.

| Method | Path | Permission | Transport | Audited |
|---|---|---|---|---|
| GET | `/vendors` | `vendors.read` | direct | — |
| GET | `/vendors/:vendorId` | `vendors.read` | direct | — |
| GET | `/vendors/:vendorId/products` | `vendors.read` | direct | — |
| GET | `/vendors/:vendorId/activity` | `vendors.read` **+** `audit.read` | direct | — |
| POST | `/vendors/:vendorId/suspend` | `vendors.suspend` | **delegated** | ✅ |
| POST | `/vendors/:vendorId/restore` | `vendors.suspend` | **delegated** | ✅ |
| POST | `/vendors/:vendorId/kyc/approve` | `vendors.kyc.review` | **delegated** | ✅ |
| POST | `/vendors/:vendorId/kyc/reject` | `vendors.kyc.review` | **delegated** | ✅ |
| POST | `/vendors/:vendorId/products/:productId/suspend` | `vendors.products.manage` | **delegated** | ✅ |
| POST | `/vendors/:vendorId/products/:productId/restore` | `vendors.products.manage` | **delegated** | ✅ |
| PATCH | `/vendors/:vendorId/settings` | `vendors.settings.manage` | **delegated** | ✅ |

**Three independent status axes — the commonest mistake on this screen:**

| Axis | Field | Means |
|---|---|---|
| Vendor status | `status` — `active` / `pending_verification` / `inactive` | May the shop trade? |
| Account status | `account.status` — `active` / `suspended` | May the person sign in at all? |
| Shop open | `store.isOpen` | The vendor's **own** vacation switch, not an admin action |

Status values are jovi-mall's verbatim — `inactive`, not a friendlier `suspended`.

**List:** sort `createdAt` · `updatedAt` · `email`, default `-createdAt`. **Business name is not
sortable** (it lives on `stores`). Filters `search`, `status`, `kycStatus`
(`pending|verified|rejected`), `onboarding` (`complete|incomplete`), `country` (ISO-3166 alpha-2),
`from`/`to` (366 days). Extra meta: **`businessNameMatchesTruncated: true`** → render a "results may
be incomplete" hint.

**`onboardingStep: 0` means COMPLETE** — the inversion is easy to read backwards; `onboardingComplete`
is computed for you.

**Detail:** `store|null`, `account|null`, `suspension|null` (only when `status === "inactive"`),
`verification { status, verified, rejectionReason, verifiedAt, reviewedBy|null }`, `contact`,
`addresses[]` (**never payout details**), `policies` (presence, not content),
`settings { autoRedirectOrdersToAgency, autoRedirectThresholdAmount, autoCancelUnpaidDays, notifyDaysBeforeExpiry }`,
`defaultDeliveryAgencyId`, `counts { products{}, orders{}, agencyConnections{} }`.

**Products sub-list:** filters `search`, `status`, `type`, `mode`, and **`suspensionReason`** — the
filter that answers "which listings did *we* take down vs their agency": `platform_oversight` is the
reason set by the admin takedown. Sort `createdAt` · `updatedAt` · `lastOrderedAt`.

**Cascade behaviour to render:** suspending a vendor takes the whole catalogue off sale in one
transaction and returns `suspendedProductCount`. Restore returns `restoredProductCount` +
`restoredProducts[]` and **fewer usually come back than went down — that is correct**; show both
numbers. A product suspended by `platform_oversight` is **never** republished by a vendor restore.

**Settings PATCH is strict** and accepts only `autoCancelUnpaidDays` (1–90),
`autoRedirectOrdersToAgency`, `autoRedirectThresholdAmount` (≥0, `null` clears the cap).
`notifyDaysBeforeExpiry` and commission are deliberately **not** editable — commission lives on the
billing `PricingPlan`.

---

## 4. Agencies — `/agencies` · 8 endpoints

Design record: `ADR-009-DELIVERY-NETWORK.md`.

| Method | Path | Permission | Transport | Audited |
|---|---|---|---|---|
| GET | `/agencies` | `agencies.read` | direct | — |
| GET | `/agencies/:agencyId` | `agencies.read` | direct | — |
| GET | `/agencies/:agencyId/agents` | `agencies.read` **+** `agents.read` | direct | — |
| GET | `/agencies/:agencyId/contract-history` | `agencies.read` | direct | — |
| GET | `/agencies/:agencyId/activity` | `agencies.read` **+** `audit.read` | direct | — |
| POST | `/agencies/:agencyId/verify` | `agencies.verify` | **delegated** | ✅ |
| POST | `/agencies/:agencyId/deactivate` | `agencies.deactivate` | **delegated** | ✅ |
| POST | `/agencies/:agencyId/reactivate` | `agencies.reactivate` | **delegated** | ✅ |

**List:** sort `createdAt` · `updatedAt` · `status`, default `-createdAt`. Business name not sortable
(it lives on the Magazin). Filters `search`, `status`, `verified`, `autoAssign`, `country`,
`from`/`to`.

**`verified` and `verifiedLegacyMirror` are both returned deliberately** — written together, so a
**disagreement means a hand-edited document**. Show both. `verified` and `status` can also
legitimately disagree: nothing enforces verification today, so an `active` unverified agency is real
and finding those is why the filter exists.

**Detail adds:** `email`, `emailVerified`, `phone`, `phoneVerified`, `coverageAreas[]`,
`kyc { registrationNumber, transportLicenseId, verifiedAt, verifiedBy }` (**`verifiedBy` present only
while verified**), `policies|null` (read-only here), `policyVersion`, `timezone`, `preferredLanguage`.

**Roster (`/agents`)** returns `AgentContract` rows: `status`, `origin`, `isPrimary`,
`cod { threshold, outstandingBalance, lastSettledAt }`,
`payment { outstandingToAgent, lastPaidAt }`, `terms`, `lifecycle`, and a joined `agent|null`.
Three reading traps stated in the docs:

- **`terms.coverageRegions: []` means NO RESTRICTION — render "all regions"**, not "covers nowhere".
- **`terms.proposedBy`, not `origin`, decides whose turn it is** on a pending contract.
- **`agent: null` is a broken row preserved on purpose** — a contract pointing at a missing agent,
  which is exactly what an administrator opens this screen to find.
- Filters: `status` (bounded string 1–40, **not a pinned enum**), `primaryOnly`. Every contract status
  including terminal ones is returned by default.

**`/contract-history` is what *everyone* did** (`actorRole` ∈ `agent|agency|admin|system`);
`/activity` is what **administrators** did. Two endpoints, not one merged feed, because they live in
two databases. On history rows, **read the role, not `actorUserId`** — an `admin` id resolves in
neither platform collection.

**Deactivate cascades**: every vendor product defaulting to the agency is suspended and in-flight
order items are put on hold. `reason` is **required** (3–500) and lives only in the audit row.
Counts come back in **`meta`** (`{ products, orderItems }`) because they describe what the write
*did*. Reactivate's `reason` is optional, and fewer products usually return than went down.

**Verify** takes a strict `{}` body — **no reason field**, deliberately. It is the exit from
`pending_verification`.

**Not offered:** editing policies (every edit bumps `policyVersion`, which pauses every vendor
connection for re-approval), un-verifying, creating an agency.

---

## 5. Agents — `/agents` · 15 endpoints

Design record: `ADR-009-DELIVERY-NETWORK.md`.

| Method | Path | Permission | Transport | Audited |
|---|---|---|---|---|
| POST | `/agents/transfer` | `agents.transfer` | **delegated** | ✅ |
| GET | `/agents` | `agents.read` | direct | — |
| GET | `/agents/:agentId` | `agents.read` | direct | — |
| GET | `/agents/:agentId/contracts` | `agents.read` **+** `agencies.read` | direct | — |
| GET | `/agents/:agentId/contract-history` | `agents.read` | direct | — |
| GET | `/agents/:agentId/activity` | `agents.read` **+** `audit.read` | direct | — |
| GET | `/agents/:agentId/tracking-policy` | `agents.read` | **delegated** | — |
| GET | `/agents/:agentId/cod-allocation` | `agents.read` | **delegated** | — |
| GET | `/agents/:agentId/eligibility` | `agents.read` | **delegated** | — |
| PUT | `/agents/:agentId/status` | `agents.status.set` | **delegated** | ✅ |
| PUT | `/agents/:agentId/kyc` | `agents.kyc.review` | **delegated** | ✅ |
| PUT | `/agents/:agentId/tracking` | `agents.tracking.set` | **delegated** | ✅ |
| PUT | `/agents/:agentId/cod-threshold` | `agents.cod_threshold.set` | **delegated** | ✅ |
| POST | `/agents/:agentId/ban` | `agents.ban` | **delegated** | ✅ |
| POST | `/agents/:agentId/unban` | `agents.ban` | **delegated** | ✅ |

**Four independent state axes, and the API refuses to collapse them — neither should the UI:**

| Axis | Field | Written by |
|---|---|---|
| Account status | `status` — `pending_verification|active|inactive|suspended` | Admin |
| Availability | `operational.availability` — `online|offline|on_break` | The agent |
| Working state | `operational.workingState` — `idle|working|at_capacity` | The platform |
| Tracking | `trackingAllowed` | Admin |
| (plus) Ban | `banned` | Admin — a platform-wide override |
| (plus) KYC | `kycStatus` — `unverified|pending|verified|rejected` | Admin |

Six independent filters exist precisely so an administrator can ask conjunctions: "who is active but
unverified", "who is banned and still marked available", "who has tracking off".

**List:** sort `createdAt` · `updatedAt` · `trustScore`, default `-createdAt`. `name` is not
sortable. **`trustScore` is index-served only when `status`, `kycStatus` and `banned` are all
supplied** — unfiltered it is a blocking sort.

**Detail adds:** `emailVerified`, `phoneVerified`, `vehicle`, `homeBase` (**label and radius only** —
the point is a person's residence and is not projected), `kyc`, `ban`, `tracking`, `device`,
`capacity { max, active, reconciledAt }`, `cod { trustScore, maxThreshold }`, `trustSignals`,
`settings`, `timezone`, `preferredLanguage`.

> ### ⚠️ `tracking.lastKnown` is a stale business mirror, not a live position
> `isStale` is computed on read: **`true` when the report is older than 2 minutes**, or absent.
> **Render as "last seen", never as a live marker on a map** — a live marker would simply stop moving
> and nobody would be told. The authoritative answer is `GET /agents/:agentId/tracking-policy`.
> wi-admin has **no data door into geo-tracker**.

**The three delegated verdict reads** are the platform's own answers and are never recomputed here:
- `tracking-policy` → `{ trackingAllowed, denyReason? }` where `denyReason` ∈
  `tracking_disabled | agent_not_active | no_approved_agency`.
- `cod-allocation` → the pool, its per-contract slices, and remaining headroom.
- `eligibility` → **requires `?agencyId=` (strict, no other parameter)**. Eligibility is pairwise;
  there is no agency-free answer. Reports **every failed rule at once**.

**Write shapes (all strict bodies):**
- `PUT /status` — `status` required; `reason` (3–500) **required when `suspended`, refused otherwise**.
- `PUT /kyc` — `status` required; optional `reference` (≤200); `rejectionReason` (3–500) **required
  when `rejected`**. Moving off `verified` makes the agent undispatchable immediately.
- `PUT /tracking` — `allowed` required; `reason` (3–500) **required when disabling**. Disabling
  blocks new dispatch and suppresses the live position, but does **not** close tracking sessions or
  revoke existing watchers — state both halves.
- `PUT /cod-threshold` — `maxThreshold` (finite, non-negative). Lowering below what contracts have
  already allocated is refused by the platform.
- `POST /ban` — `reason` required. **Not a cascade over contracts**: a contract-level reactivation
  while the ban stands writes `active` and the agent stays unusable, so **a dashboard showing a
  contract as active must also show the ban**.
- `POST /transfer` — `{ agentId, fromAgencyId, toAgencyId, reason }`, destination must differ.

**Not offered:** a live position, editing contract terms, creating an agent.

---

## 6. Orders — `/orders` · 10 endpoints

Design record: `ADR-010-ORDERS-AND-SHIPMENTS.md`.

| Method | Path | Permission | Transport | Audited |
|---|---|---|---|---|
| GET | `/orders` | `orders.read` | direct | — |
| GET | `/orders/disputes` | `orders.disputes.read` | direct | — |
| GET | `/orders/:orderId` | `orders.read` | direct | — |
| GET | `/orders/:orderId/timeline` | `orders.read` | direct | — |
| GET | `/orders/:orderId/activity` | `orders.read` **+** `audit.read` | direct | — |
| GET | `/orders/:orderId/refund-eligibility` | **`orders.refund`** | **delegated** | — |
| POST | `/orders/:orderId/dispute/resolve` | `orders.disputes.resolve` | **delegated** | ✅ |
| POST | `/orders/:orderId/cancel` | `orders.intervene` | **delegated** | ✅ |
| POST | `/orders/:orderId/dispatch` | `orders.intervene` | **delegated** | ✅ |
| POST | `/orders/:orderId/refund` | `orders.refund` | **delegated** | ✅ |

Note `refund-eligibility` sits behind **`orders.refund`, not `orders.read`** — its answer is a
ceiling on money, not a record.

**Two status vocabularies are validated by format, not membership** — jovi-mall owns both state
machines and extends them without asking. An unrecognised value returns an **empty page**, not a
`400`. Values in use today: `paymentStatus` ∈ `pending`, **`AWAITING_PAYMENT`** (really stored in
SCREAMING_SNAKE beside snake_case), `partially_paid`, `paid`, `disputed`, `failed`, `refunded`;
`fulfillmentStatus` ∈ `pending`, `processing`, `partially_shipped`, `shipped`,
`partially_delivered`, `delivered`, `fulfilled`, `cancelled`, `returned`.

**List:** sort `createdAt` **only**, default `-createdAt` (`totalAmount` and `updatedAt` are not
sortable — no index). Filters `search` (order-number **prefix**, or a 24-hex id of an order,
customer, vendor or checkout group), `orderType`, `paymentMethod`, `paymentStatus`,
`fulfillmentStatus`, `vendorId`, `customerId`, `disputed`, **`completed`** (the escrow gate,
orthogonal to fulfilment), `from`/`to`.

**`checkoutGroupId`** is the cart id — one checkout splits into one order per vendor, all sharing it.

**Detail:** `priceBreakdown`, `paymentIntentId`, `dispute` (**`null` when never disputed** — absent
rather than a block of nulls), `completion { confirmedAt, confirmedBy, auto }`, **`deliveryAddress`
(textual only** — coordinates and raw customer input are excluded by projection *and* mapping),
`items[]` each with `delivery { agencyId, shipmentId, status, freeDelivery, hold, pickup }`.

**Refund flow — build it in this order:**
1. `GET /refund-eligibility` → two nested ceilings: the outer `maxRefundable`/`remaining` is **the
   platform's money invariant, never waivable**; the inner `vendorPolicy` is the vendor's commercial
   terms, which **are** waivable.
2. If `overrides[]` is non-empty, show the operator **exactly which vendor gates** would be crossed.
3. `POST /refund` with `overridePolicy: true`.

Without the flag a policy-crossing refund is a **422** naming the gates. `amount` absent means the
full remaining refundable balance, **not** the vendor's policy cap.

**Dispatch returns `200` with `shipmentsAssigned: 0`** and the message "Nothing to dispatch" when
nothing was pending — **that is not an error; branch on the count.**

**Dispute resolve** takes `{ outcome: "won" | "lost" }` — from the **platform's** point of view.

### ⚠ Corrections found in Phase 9, verified against the running service

1. ✅ **FIXED 2026-08-20 — three writes returned jovi-mall's raw Mongoose document, not the
   camelCase DTO.** `cancel`, `dispute/resolve` and dispatch's `data.order` were all
   `await OrderModel.findById(orderId)` forwarded untouched
   (`jovi-mall/src/modules/orders/admin-order.controller.ts:107,139,162`). The line above once
   called dispatch "the one documented place the storage casing surfaces" — it was three places,
   and `orders.md` described the other two as "the updated order". **It was also the whole
   document**, including the `delivery_address.coordinates` and `raw_input` the read projection
   deliberately withholds — `DATA-EXPOSURE-REGISTER.md` §6.

   All three now answer with an **`OrderDetailDto`**, re-read through `ORDER_DETAIL_PROJECTION`
   and mapped by the same function `GET /orders/:orderId` uses — one function, so the write and
   the read cannot disagree. Dispatch keeps `{ shipmentsAssigned, order }`; only the `order` half
   changed. `orders.md` is corrected in all three places.

   ⚠ **Keep discarding the bodies anyway.** `orders.service.ts` returning only `{ message }` /
   `{ shipmentsAssigned }` is structural rather than disciplinary — there is no order object for a
   call site to reach into — and `OrderDetail.test.tsx`'s coordinate assertion is defence in
   depth against the *next* delegated write, not only this one. This fix is not a reason to
   "clean it up"; adopting the returned DTO is a separate, optional change that would save a
   refetch.
2. **`GET /orders` can answer `meta.searchMatchesTruncated: true`**, undocumented. Set when the
   customer or vendor name pre-match hits its cap of 200 each. The analogue of the vendor
   directory's `businessNameMatchesTruncated`, and read with the same strict `=== true`.
3. **`disputedAt` is the dispute queue's default sort key and is not on the list row.**
   `OrderListItemDto` carries `disputeHeld` and no timestamp, so the column can order the queue and
   cannot display what it orders by.
4. **The order detail carries no shipments block.** `shipment.read.repository.ts:208` declares a
   `findForOrder` whose docstring claims it serves "the compact block the order detail carries", and
   it is called nowhere. Cross-link via `GET /shipments?orderId=` instead.
5. **`priceBreakdown` and `completion` are nullable objects with nullable members**, where the
   example shows populated numbers throughout.
6. **`refund-eligibility` carries a top-level `reasonCode?`** the docs show only inside
   `vendorPolicy`. Its `overrides[]` and `reasonCode` also differ in casing *and* naming between the
   two doc sets (`RETURN_WINDOW_EXPIRED` vs `return_window_expired`; `vendorPolicy.reasonCode` vs
   `vendorReasonCode`) — treat all three as opaque strings and render them raw.
7. **A `502`/`503` on refund is genuinely ambiguous.** The gateway call happens outside any
   transaction, so a lost answer leaves a `pending` `RefundTransaction` and no way for a client to
   learn which side of the call it died on. The dashboard says "reload and check" and offers no
   retry — the one endpoint where it overrides `isRetryable`. A reconciliation read would fix this.
8. **No path from `order.customerId` to a user account.** It is a `customers._id`; `/users/:userId`
   and `?search=` key on `users._id`. See `DATA-EXPOSURE-REGISTER.md`'s cross-reference.

---

## 7. Accounts — `/accounts` · 5 endpoints

Design record: `ADR-011-ACCOUNTS-AND-FINANCE.md`. **Read-only — there are no writes on this mount.**

| Method | Path | Permission |
|---|---|---|
| GET | `/accounts/:ownerType/:ownerId` | `money.earnings.read` **+** `billing.plans.read` **+** `cod.overview.read` |
| GET | `/accounts/:ownerType/:ownerId/activity` | `money.earnings.read` **+** `billing.plans.read` |
| GET | `/accounts/:ownerType/:ownerId/payouts` | `money.payouts.read` **alone** |
| GET | `/accounts/:ownerType/:ownerId/credits` | `billing.plans.read` |
| GET | `/accounts/:ownerType/:ownerId/cash-ledger` | `cod.overview.read` |

`:ownerType` is a **pinned enum** — `vendor` · `agency` · `agent`. A bad value is a `400`.
**`platform` is excluded deliberately**; the marketplace's own account lives at
`/money/earnings/platform`.

### The three balance models, which must never mix

| Balance | `unit` | `direction` | What it is |
|---|---|---|---|
| Earnings | `money` | `owed_to_owner` | What the platform owes them |
| Credits | `credit` | `spendable_by_owner` | Metered-action units. **Not money.** No currency, no expiry, never payable out |
| COD cash | `money` | `owed_to_platform` / `owed_to_agency` | **A liability** — cash held and owed onward |

Four mechanisms enforce it: no top-level `balance`/`total`/`amount`; every balance object carries
`unit` + `currency` + `direction`; **no grand total exists at any level**; and **`null` means "does
not apply to this owner kind"**, distinct from `0` meaning "applies, currently empty". A vendor's
`codCash` is `null`; an agent's `codCash: { held: 0 }` means they can and currently do not.

**Detail blocks:** `owner`, `profile`, `subscription` (incl. `entitlements`, a delegated verdict),
`balances`, `codExposure` (**`null` for a vendor**; `contracts[].maxThreshold: 0` **blocks all COD**
and does not mean "no limit"; `reserveHolds` is **agency only**), `payouts` (**`destination.full` is
always `null` here**), `flags { openDiscrepancies, unsettledCollections, shipmentCapAlertedAt, overCodThreshold }`.

**`profile.kycStatus` (vendor + agent) and `profile.kycVerified` (agency + vendor) are not
interchangeable** — each is `null` where it does not apply.

**`/activity` is the one cursor-paged list in the service.** `?before=` + `meta.nextCursor` /
`meta.hasMore`, **no `total`, no `pages`**, no sorting and **no filters, not even by category** — a
filter the cursor does not encode would silently resume a walk in the wrong place. It merges five
collections (plans, credit top-ups, credit transactions, earnings ledger, payouts). **The COD cash
ledger is deliberately not in this feed** — it is a liability, not owner value.

**Errors:** `400 VALIDATION_ERROR` (bad `ownerType`, malformed `ownerId`, **or any query parameter** —
the detail route is strict), `404 ACCOUNT_OWNER_NOT_FOUND`. An owner with no balances is **not** a
404 — it reports zeroes. `cash-ledger` accepts `agent` and `agency` only; `ownerType=vendor` is a
`400` naming the reason.

---

## 8. Administrators — `/administrators` · 17 endpoints

| Method | Path | Permission | Audited |
|---|---|---|---|
| GET | `/administrators/me` | *self* | — |
| PATCH | `/administrators/me` | *self* | ✅ |
| GET | `/administrators/me/activity` | *self* | — |
| GET | `/administrators` | `administrators.read` | — |
| POST | `/administrators` | `administrators.create` | ✅ |
| GET | `/administrators/:adminId` | `administrators.read` | — |
| PATCH | `/administrators/:adminId` | `administrators.update` | ✅ |
| GET | `/administrators/:adminId/activity` | `audit.read` | — |
| GET | `/administrators/:adminId/history` | `audit.read` | — |
| POST | `/administrators/:adminId/suspend` | `administrators.suspend` | ✅ **may 202** |
| POST | `/administrators/:adminId/reinstate` | `administrators.suspend` | ✅ **may 202** |
| PUT | `/administrators/:adminId/tier` | `administrators.tier.set` | ✅ **may 202** |
| GET | `/administrators/:adminId/sessions` | `administrators.sessions.read` | — |
| DELETE | `/administrators/:adminId/sessions` | `administrators.sessions.revoke` | ✅ |
| DELETE | `/administrators/:adminId/sessions/:sessionId` | `administrators.sessions.revoke` | ✅ |
| POST | `/administrators/:adminId/password-reset` | `administrators.password.reset` | ✅ |
| POST | `/administrators/:adminId/mfa-reset` | `administrators.mfa.reset` | ✅ |

**Support (tier 3) holds no `administrators.*` permission at all** — this whole module is invisible
to them, which is also why `audit.read` is row-scoped.

**There is deliberately no `DELETE`.** Suspension is the model.

**Escalation rules run on every write**, after the permission check, and are not overridable:
`AUTHZ_SELF_ACTION_FORBIDDEN` (acting on yourself), `AUTHZ_TARGET_TIER_PROTECTED` (target at or above
your level), `AUTHZ_TIER_ESCALATION_FORBIDDEN` (assigning a level at or above your own). Messages
name the **rule**, never the caller's standing. **Lower number = more privilege** — a tier-2 Admin
may act on tier 3 only.

**Dual control (→ `202`, not a refusal):** `PUT /tier` when the requested tier is 1; `suspend` and
`reinstate` when the **target** is a Developer. An identical repeat returns the same pending approval
("An identical request is already awaiting approval") — a double-clicked button does not queue two.

**Data model — `Administrator`:** `id`, `email`, `displayName`, `tier`, `tierLabel`, `status`,
`jobTitle|null`, `department|null`, `timezone`, `preferredLanguage`, `mfaEnrolled`, `lastLoginAt|null`,
`createdBy|null`, `suspendedAt|null`, `suspendedBy|null`, `suspendedReason|null`, `tierChangedAt|null`,
`tierChangedBy|null`, `createdAt`. **Never contains `passwordHash` or `mfaSecret`.**

> **Reinstating clears `suspendedAt`/`suspendedBy`/`suspendedReason`.** A lifted suspension leaves no
> trace on the record — **`GET /:adminId/history` is the only place it survives.**

**List has no `sort`** — a fixed compound order (by level, then newest within a level) that one sort
key cannot express. Filters `tier`, `status`, `search`.

**`POST /administrators` returns `oneTimePassword` — shown once, stored nowhere else.** There is no
email delivery in this service, so the creating administrator is the delivery channel. Display it,
let it be copied, do **not** persist it client-side. Same for `password-reset`.
Creating directly at Developer level is **`409 AUTHZ_APPROVAL_REQUIRED`** — create lower, then
request a promotion.

**Two audit feeds, keyed on opposite halves of the row:** `/activity` = what this administrator
**did**; `/history` = what was done **to** the account.

**`PUT /tier` is idempotent** — a target already at that tier returns `200` unchanged and records
nothing. A level change ends the target's sessions with `endReason: "tier_changed"`.

**`AdminSession`:** `sessionId`, `startedAt`, `absoluteExpiresAt`, `ip`, `userAgent`, `mfaUsed`,
`current` (always `false` here), `endedAt`, `endReason`, `lastSeenAt`, `tierAtLogin`. `?includeEnded=true`
returns the durable history with one of **eleven** `endReason` values (`logout`, `logout_all`,
`revoked_by_admin`, `account_suspended`, `tier_changed`, `password_reset`, `mfa_reset`,
`refresh_reuse_detected`, `idle_expired`, `absolute_expired`).

---

## 9. Audit — `/audit` · 8 endpoints

Design records: `ADR-006-AUDIT.md`, `ADR-012-AUDIT-COMPLETION.md`.

| Method | Path | Permission | Audited |
|---|---|---|---|
| GET | `/audit` | `audit.read` | — |
| GET | `/audit/actions` | `audit.read` | — |
| GET | `/audit/:auditId` | `audit.read` | — |
| POST | `/audit/exports` | `audit.export` | ✅ |
| GET | `/audit/exports` | `audit.export` | — |
| GET | `/audit/exports/:exportId` | `audit.export` | — |
| GET | `/audit/exports/:exportId/download` | `audit.export` | — |
| GET | `/audit/legacy` | `audit.read` | — |

**Row-level read scope.** `audit.read` is held by all three tiers, but Support sees only rows whose
subject is a **platform actor or record**, plus anything they did themselves. Rows classed `internal`
(administrators, admin sessions, approval requests, audit exports, feature flags, workers,
maintenance windows) are invisible to them. **A row outside your scope answers `404`, not `403`.**

**Filters:** `actorId`, `action` (one of **80** catalogued names — get them from `/audit/actions`,
do not hard-code), `actionFamily` (one of 21), `status` (`attempted|succeeded|failed|denied|queued`),
`targetType` (22 values incl. `none`), `targetId` (1–128, **not** validated as an ObjectId),
`correlationId`, `sensitiveOnly`, `search`, `from`/`to` — **max span 92 days here, not 366**.
`action`, `actionFamily`, `status` and `targetType` are **pinned enums**: a typo is a `400` naming
the valid values.

**Sort is `occurredAt` only**, default `-occurredAt`.

**Extra meta:** `retentionDays` and **`oldestRetainedAt`** — render it, or the feed looks broken at
its boundary rather than merely retained-out.

**`AuditEntry`:** `id`, `occurredAt`, `completedAt|null`, `correlationId`, `action`,
`actionSummary|null`, `actionFamily`, `status`, `sensitive`,
`actor { kind, id, email, displayName, tier, sessionId }` (**`actor.tier` is the level held at the
time**, not now; `kind` ∈ `administrator|system|anonymous`),
`target { type, id, label, subjectClass }`, `relatedTarget|null`, `request`,
`outcome { code, statusCode, message, denialKind, requiredPermissions[], platformCode }`,
`viaApprovalId|null`, `delegated`, `exportedAt|null`, **`purgeAfter|null`** (null until exported —
retention is exported-AND-aged).
**`payload`, `before` and `after` are not on list rows** — fetch the detail, which adds them plus
`stateTruncated`.

**Exports:** `POST` requires **both** `from` and `to` (unlike the feed) and is `201`.
`422 AUDIT_EXPORT_TOO_LARGE` over 50 000 rows → narrow the range or use the CLI.
**Exporting does not purge** — show the API's message verbatim. Download is
`application/x-ndjson`, **the one endpoint that does not answer with the JSON envelope**, with
`X-Content-SHA256` to verify against. Its errors *do* use the envelope: `409 AUDIT_EXPORT_INCOMPLETE`,
**`410 AUDIT_EXPORT_FILE_MISSING`** (gap D9 — multi-instance deployment).

⚠️ **`GET /audit/legacy` IS GONE** — deleted at Phase 5 Part D with the legacy surface it
reported on, along with its `audit.legacy_feed` flag and the `AUDIT_LEGACY_FEED_DISABLED` code.
It now 404s like any unknown path. **Remove the call and the `LegacyAuditRow` type**; there is
no replacement and none is needed — `GET /audit` is the compliance record and always was, which
is exactly what `meta.legacy: true` and `meta.retiresAtCutover: true` existed to say on every
page that feed ever returned.

The rows themselves are not lost: `admin_action_log` survives in the platform database. What
went is this service's read of it, because after cutover every new row there duplicates a
wi-admin audit row for the same operation, written with a real administrator identity and a
catalogued action. See [`audit.md`](../../admin/api/audit.md) § `GET /audit/legacy`.

---

## 10. Notifications — `/notifications` · 10 endpoints

Design record: `ADR-013-NOTIFICATIONS.md`.

| Method | Path | Access | Audited |
|---|---|---|---|
| GET | `/notifications` | `notifications.read` | — |
| GET | `/notifications/unread-count` | `notifications.read` | — |
| GET | `/notifications/sources` | `notifications.read` | — |
| GET | `/notifications/preferences` | *self* | — |
| PATCH | `/notifications/preferences` | *self* | ✅ |
| POST | `/notifications/read-all` | `notifications.read` | **❌ deliberately** |
| PATCH | `/notifications/:notificationId/read` | `notifications.read` | ❌ |
| PATCH | `/notifications/:notificationId/unread` | `notifications.read` | ❌ |
| POST | `/notifications/:notificationId/archive` | `notifications.read` | ❌ |
| POST | `/notifications/:notificationId/unarchive` | `notifications.read` | ❌ |

`notifications.read` is held by **all three tiers**. Preferences are *self*-service.

**Three properties to build against:**
1. **Nothing here creates a notification** — no `POST /notifications`. Every row is derived by a
   background projector.
2. **The permission does not decide which notifications you see.** Which rows are in the inbox is
   decided **per row** from the permission each source declares. Two administrators at the same level
   can legitimately have different inboxes.
3. **Five writes are deliberately unaudited** (read/unread/archive/unarchive/read-all).

**Vocabulary — ten types, closed list:** `cod.discrepancy.opened`, `cod.remittance.declared`,
`money.payout.requested`, `orders.dispute.opened`, `agencies.verification.pending`,
`vendors.kyc.pending`, `system.tracking_dispatch.failed`, `approvals.requested`, `approvals.decided`,
`audit.export.finished`. Severities `info` · `warning` · `critical`.

**List:** sort `occurredAt` · `createdAt` · `severity`, default **`-occurredAt`** — `createdAt` is
when the projector noticed, `occurredAt` is when the thing happened, and they genuinely differ.
`status` defaults to **`unread`**. `meta.unreadCount` rides alongside the pagination fields and is
computed with **the same filters** — badge and list must not disagree.

**`Notification`:** `id`, `type`, `severity`, `title`, `body`, `source`,
`target { type, id, label }`, **`actionPath`** (a relative **dashboard** route — the routing table
must be able to satisfy these), `occurredAt`, `readAt|null`, `archivedAt|null`, `isRead`, `isArchived`.

**`/sources`** answers "why do I never see these" — each entry carries **`requiredPermission`**
(`null` when ungated), so an administrator can tell "none have happened" from "I am not entitled to
them". Build the source filter from this, not a hard-coded list.

**Preferences** have **three states**: key absent = leave alone; `true`/`false` = explicit override;
**`null` = remove the override** so the type tracks the catalog default again.
`enabled === defaultEnabled` does **not** imply `overridden === false`.
**Preferences apply at fan-out** — muting stops the *next* one and does not clean the inbox. The API
says so in its `message`; **show it.**

**`read-all` is scoped by the same filters plus `before`** — send the `occurredAt` of the newest row
you rendered, so the gesture means "mark read what I was looking at".

**One error code on this whole surface:** `404 NOTIFICATION_NOT_FOUND`, covering "no such row",
"exists, addressed to somebody else" and "exists, but your level no longer holds the permission it is
gated on" — all 404, never 403.

**Archiving is the only deletion path** — there is no `DELETE`. Retention 30 days.

**Gap D7:** `notifications.manage` is catalogued, granted, and **unrouted**.

### Correction — seven places `notifications.md` disagrees with the service (Phase 13)

All read from `backend/admin/src/modules/notifications/**` while building the module. The first two
were live defects in this dashboard, shipped in Phase 4 and fixed here.

1. **`read-all` answers `{ marked }`, not `{ updated }`.** `notification.controller.ts` ends with
   `sendSuccess(res, { marked }, …)`. Phase 4's client read `updated`, and
   `Number(undefined ?? 0)` is a perfectly good `0` — so the confirmation reported zero however
   many rows it touched, silently, on every call.
2. **The Phase 4 client sent no `read-all` body at all**, so the button marked everything read
   including whatever arrived between the page rendering and the click — the exact harm the
   endpoint's four body fields exist to prevent.
3. **`?status=all` still excludes archived rows.** `notification.repository.ts` maps `all` to
   `{ archived_at: { $exists: false } }`, i.e. read *and* unread but never archived;
   `?status=archived` is how the drawer opens. The endpoint page names the value and says nothing —
   only `ADR-013-NOTIFICATIONS.md` states it. **Rendering it as "All" is a lie**, so the dashboard
   labels it *"Read and unread"*.
4. **`before` on `read-all` is inclusive** (`occurred_at: { $lte: before }`), the opposite bound to
   the identically-named cursor on `GET /accounts/:ownerType/:ownerId/activity`, which
   `docs/admin/api/README.md` defines as "strictly older than. Never inclusive."
5. **`body` is nullable and `target` is not.** The model declares `body: { default: null }` and
   `target_type: { required: true }`, so `toNotificationDto` always builds the target object while
   `target.id` and `target.label` are independently nullable. The doc's example implies the reverse.
6. **`?source=` is a `z.enum` over the *live registry ids*.** Not a bounded string — an id the
   registry does not produce is a `400`, not an empty page. A hand-written option list is a defect
   waiting on a deploy, which is why the filter is built from `GET /notifications/sources`.
7. **`createdAt` is in the sort allowlist but is not on the row.** `NOTIFICATION_SORT` permits it;
   `toNotificationDto` does not emit it. Ordering by it is legal and shows nothing to read it off.

**Also, and not drift:** `actionPath` is described two different ways —
`docs/admin/api/notifications.md` calls it "a dashboard route, relative" while ADR-013 says it is
"this service's own **API** path, **not** a dashboard route". `src/lib/notification-path.ts` needs
no change either way: it fails closed against `routeRequirement()`, so a value that resolves to no
declared route renders as text rather than as a link to a 404. **Do not "fix" this to follow one
document over the other.**

And `severity` sorts the stored *string*, so ascending yields `critical, info, warning` — critical
first by spelling rather than by urgency. The dashboard offers no "most severe first" option
because the database is not producing one.

---

## 11. System — `/system` · 17 endpoints

Design records: `ADR-014-SYSTEM-OPERATIONS.md`, `ADR-015-DEVELOPER-TOOLS.md`, `ADR-016-ERROR-SYSTEM.md`.
**Every route is a `GET` and none is audited.**

| Path | Permission | Subject | Transport |
|---|---|---|---|
| `/system/health` | `system.health.read` | **wi-admin** | direct |
| `/system/outbox` | `system.outbox.read` | platform | direct read |
| `/system/config` | `developer_tools.config.read` | **wi-admin** | local |
| `/system/workers` | `system.workers.read` | platform | delegated |
| `/system/dependencies` | `system.health.read` | platform | delegated |
| `/system/integrations` | `system.health.read` | platform | delegated |
| `/system/cache` | `system.health.read` | platform | delegated |
| `/system/queues` | `system.outbox.read` | platform | delegated |
| `/system/metrics` | `system.metrics.read` | platform | delegated |
| `/system/maintenance` | `system.maintenance.read` | platform | delegated |
| `/system/errors` | **any of** `developer_tools.logs.read`, `system.errors.read`, `support.errors.lookup` | platform | delegated |
| `/system/platform/config` | `developer_tools.config.read` | platform | delegated |
| `/system/platform/logs` | `developer_tools.logs.read` | platform | delegated |
| `/system/platform/cache/keys` | `developer_tools.cache.inspect` | platform | delegated |
| `/system/platform/database` | `developer_tools.database.inspect` | platform | delegated |
| `/system/geo-tracker` | `system.health.read` | **geo-tracker** | direct probe |
| `/system/geo-tracker/metrics` | `system.metrics.read` | **geo-tracker** | direct probe |

Tier note: the `system.*` reads reach Admin (tier 2); every `developer_tools.*` read is **Developer
only**. So this module renders at two very different depths.

**`GET /system/errors` is the one `any`-mode guard and returns three different projections**, each
tagged with **`view`**:

| `view` | Tier | Adds |
|---|---|---|
| `support` | 3 | `at`, `requestId`, `category`, `code`, `statusCode`, `method`, `routeGroup`, `actorRole`, client `message`, per-category `hint`. Only rows whose actor was a vendor/agency/agent/customer or anonymous |
| `admin` | 2 | `path`, `actorId`, `errorType`, `masked`, **`internalMessage`**, **unmasked `details`**. Every error the platform recorded |
| `developer` | 1 | plus `stack`, `causeMessage`, `raw` |

**Render `view`** — without it a Support agent cannot tell "there is nothing more to know" from "I am
not being shown it", and would escalate a resolved incident.
**A tier-3 query must supply either a `requestId`, or a `code` *and* a `since`**, else
`400 SYSTEM_ERROR_QUERY_TOO_BROAD` — **400, not 403**; the remedy is a narrower query.
`before` is a **cursor, not an offset**, on both `/system/errors` and `/system/platform/logs`.

**`/system/maintenance` reports `storedMode` and `effectiveMode` separately** — they differ once a
window has passed its expiry, because a read path must never write. **Render `effectiveMode`.**

**`/system/health`** returns `dependencies { admin, platform, redis, joviMall }` and
`audit { danglingIntents, danglingIntentsCappedAt: 100, oldestDanglingAt, retentionDays }`. A
dangling intent is an `attempted` audit row whose outcome never landed; resolve by grepping
jovi-mall for the same `correlationId`. **`danglingIntentsCappedAt` is stated so 100 is never read as
"exactly a hundred".**

**`/system/outbox` and `/system/queues` are both kept on purpose** — `/queues` is delegated and
returns 503 during a platform incident, exactly when an operator wants queue depth; `/system/outbox`
reads the collection directly and still answers. Prefer it on an incident screen.

**`/system/platform/cache/keys` requires `db` as the database NAME, upper-case** (e.g.
`SLOT_LOCK_DB`), never an index — an index is a `400`. It returns key **names**, types and TTLs,
**never values**, and takes **no `confirm`** (looking is not clearing).

**`/system/workers` supersedes `GET /dev-tools/workers`**, which returns a narrower legacy shape with
a single `running` flag conflating three conditions. Use the `/system` one.

**`/system/geo-tracker` can never fail** — `configured: false` and an unhealthy report are the two
ways it says "no". Service-level only: no positions, no trails, no session content.

**Not here:** live agent positions (no door exists), wi-admin's own logs (not built; `/system/logs` is
reserved), and any write (those are `/dev-tools`).

### ⚠ Corrections found in Phase 14, verified against `backend/admin` source

Eight places `docs/admin/api/system.md` disagrees with the service. Four of them break a client
written from the docs.

1. **`GET /system/config` returns an ARRAY, not an object.** The controller sends
   `{ config: exposedConfig() }` and `exposed-config.ts:101-116` returns `[{ key, value }]`;
   `system.md:143-164` shows a flat object keyed by name. **A client written from that example reads
   `data.config.NODE_ENV` and gets `undefined` on all thirteen keys.** `getExposedConfig()` normalises
   both shapes and warns once in dev.
2. **`ADMIN_DASHBOARD_ORIGINS` arrives comma-joined**, not as the documented array — the mapper
   `String()`s anything non-scalar so the wire shape stays flat. Scalars pass through, so the value
   type is `string | number | boolean | null`.
3. **The two config endpoints are shaped differently.** `/system/config` is `[{key, value}]`;
   `/system/platform/config` is `{ service, entries: [{key, value, set}], wiring, note }`. Only the
   platform's carries `set`, and only its page documents it honestly.
4. **`GET /system/errors` has four undocumented top-level fields** — `sourceUsed`, `sourceReason`,
   **`nextBefore`** and `meta`. The page shows only `view` and `entries`, and names the `before`
   *parameter* without ever naming the response field that feeds it.
5. **A short error page does not mean the end of the feed.** `isVisibleToTier` filters entries in
   wi-admin **after** the platform returned the page, so a support-level caller can get three rows
   against `limit=100` with `nextBefore` still set. **Page off `nextBefore` alone.**
6. **`GET /system/integrations` carries undocumented `googleCalendar: {connectedVendors,
   failingRefresh}` and `rule`.**
7. **Eight `/system` routes publish no response shape anywhere in the bundle** — `/dependencies`,
   `/metrics`, `/platform/config`, `/platform/logs`, `/platform/cache/keys`, `/platform/database`,
   `/geo-tracker/metrics`, and `/system/workers`' element shape. Five more (`/workers`, `/cache`,
   `/queues`, `/maintenance`, `/integrations`) are prose-only. The dashboard types them from
   `system.gateway.ts` and `docs/jovi-mall/admin/system.md`; **that belongs in `system.md`.**
8. **`/health/ready` and `/system/health` describe the same four dependencies in two shapes under two
   key sets — and the two Mongo names invert.** `admin`/`platform` there are
   `mongoAdmin`/`mongoPlatform` on the probe. Label by meaning; `SYSTEM_DEPENDENCY_LABELS` does the
   reconciliation once. Separately, **`/health/ready` reports `joviMall` but excludes it from
   `required`**, contradicting its own in-code comment that "Phase 4 makes it required" — that never
   happened.

---

## 12. Developer Tools — `/dev-tools` · 9 endpoints

**Almost everything here is Developer (tier 1) only, and every write is audited.**

| Method | Path | Permission | Behind `dev_tools.enabled` | Audited |
|---|---|---|---|---|
| GET | `/dev-tools/feature-flags` | `developer_tools.feature_flags.read` | ❌ | — |
| PUT | `/dev-tools/feature-flags/:flag` | `developer_tools.feature_flags.set` | ❌ | ✅ |
| GET | `/dev-tools/workers` | `system.workers.read` | ❌ | — |
| POST | `/dev-tools/workers/:workerKey/run` | `developer_tools.workers.trigger` | ✅ | ✅ |
| POST | `/dev-tools/outbox/replay` | `developer_tools.outbox.replay` | ✅ | ✅ |
| POST | `/dev-tools/outbox/prune` | `developer_tools.outbox.prune` | ✅ | ✅ |
| POST | `/dev-tools/catalogue/vectorise` | `developer_tools.catalogue.vectorise` | ✅ | ✅ |
| PUT | `/dev-tools/maintenance` | `developer_tools.maintenance.set` | ❌ | ✅ |
| POST | `/dev-tools/cache/flush` | `developer_tools.cache.flush` | ✅ | ✅ |

**Two gates answering different questions.** The permission asks "may this person?"; the
**`dev_tools.enabled` flag, which defaults OFF**, asks "is the service accepting these right now?".
When off: **`409 DEV_TOOLS_DISABLED`, not 403** — you hold the permission and the service is refusing.
A 403 would send an administrator to look at their own grants, the wrong place. The UI must say so.

Three carve-outs are not behind the flag: the two feature-flag routes (a switch that turns off its
own switch is a trap), `PUT /maintenance` (its failure mode is losing the ability to undo it), and
`GET /workers` (a read).

**Confirmation-typing is real, and asymmetric:**
- `outbox/prune` — `confirm` must **repeat `olderThanDays`**; `status` must be the **literal
  `"sent"`** (not an enum — pruning `failed` destroys the input to replay); `olderThanDays` is 7–365;
  **`dryRun` defaults to `true` on the platform's side**.
- `cache/flush` — `confirm` must **repeat `db`** (the upper-case NAME); `dryRun` defaults `true`;
  three databases refuse a whole-database flush.
- `cache/keys` (read) — deliberately takes **no** `confirm`.

**Show the API's `message` verbatim on three routes**, per explicit instruction in the docs:
- feature-flag set → "…is now on **on this instance**. Other instances converge within the flag
  cache TTL." The change is **not instant across the fleet**.
- maintenance set → carries `previousMode`, `changed` and **`convergenceSeconds`**.
- prune / flush → **the message leads with the dry-run state**; an operator who cannot tell at a
  glance whether anything was deleted will assume the worse and act on it. `truncated: true` means
  the run must be repeated, with a cursor to resume from.

**`PUT /maintenance`:** `mode` ∈ `off|readonly|down`; `reason` (8–500) **required for anything but
`off`** and is shown to every refused caller; `expiresInMinutes` 1–1440.
Two path groups (`/api/internal/agents/*`, `/api/tracking/*`) stay reachable in **every** mode —
blocking them would turn a maintenance window into a geo-tracker outage.

**Worker keys are not pinned** (`^[a-z][a-z0-9-]*$`) — the registry lives in the platform. The two
worker failures arrive as **`details.platformCode`**, not `error.code`: `DEV_TOOLS_WORKER_UNKNOWN`
(404) and `DEV_TOOLS_WORKER_BUSY` (409). **Branch on `details.platformCode`.**

**Bulk vectorisation is synchronous** and returns a full result — expect a long-running request, not
fire-and-forget.

**Gap D8:** `developer_tools.webhooks.redeliver` is catalogued with no route, deliberately.

### ⚠ Corrections found in Phase 14, verified against `backend/admin` source

Seven places `docs/admin/api/dev-tools.md` — and this file above — disagree with the service.

1. **`GET /dev-tools/feature-flags` returns TEN fields, not the five shown.** `dev-tools.md:77-106`
   lists `name`, `enabled`, `default`, `consumer`, `summary` **with no ellipsis**, so it reads as
   complete; `feature-flag.service.ts:36-48` also returns `isDefault`, `reason`, `updatedBy`,
   `updatedByEmail` and `updatedAt`. **§12's own table above repeated the same five and is corrected
   by this note.** `isDefault` is not derivable from `enabled === default` — a flag set to the value
   the catalog already had is *overridden*, and that is the whole provenance question.
2. **`ran` on a worker run is optional and its ABSENCE means `true`.** Stated only in
   `dev-tools.gateway.ts:108-118`. **A screen branching on `ran === true` reports "did not run"
   against any jovi-mall predating the overlap lock.** `runWorker()` resolves it so no call site can
   repeat the mistake. And `ran: false` is a **200** — a neutral outcome, distinct from
   `409 DEV_TOOLS_WORKER_BUSY`, which means *this instance* is already running it.
3. **`POST /dev-tools/cache/flush` uses `db` for two types in two directions.** Going out it is the
   upper-case NAME; coming back it is the numeric Redis index, and the name returns as `constant`.
4. **Its `cursor` is typed `string` in the gateway but shown as `null` in the docs example.**
   `string | null` is the only reading that survives both.
5. **`POST /dev-tools/outbox/prune` returns `status`, `cutoff` and `oldestRemainingSentAt`** on top of
   the five keys the example shows. `oldestRemainingSentAt` is what makes "is another pass worth it"
   answerable without re-deriving the cutoff.
6. **`PUT /dev-tools/maintenance` returns no `setBy`**, unlike `GET /system/maintenance`. A screen
   that wants to show who opened the window must refetch after writing.
7. **`GET /dev-tools/workers` carries an undocumented `runningIsProcessLocal`.** Not consumed — this
   dashboard calls `/system/workers` instead, as the docs advise.

**Also, and not drift:** four of the five bulk tools audit with `target: { type: 'none', id: null }` —
replay, prune, flush and vectorise act on a filtered *set* rather than one record, so a "view in the
audit trail" link keyed on `targetId` finds nothing for any of them. Only `feature_flag`, `worker` and
`maintenance_window` carry a real target.

**And a gap in the backend's own suites:** there is **no `verify:devtools`**. Unlike orders, COD, money
and audit, this surface has never been exercised against a running server.

---

# Additional modules

## 13. Auth — `/auth` · 11 endpoints · **no permission on any route**

| Method | Path | Access | Audited |
|---|---|---|---|
| POST | `/auth/login` | **public** | ✅ every outcome |
| POST | `/auth/mfa/verify` | **public** | ✅ |
| POST | `/auth/refresh` | **public** | only on reuse detection |
| GET | `/auth/me` | authenticated *(mid-enrolment ok)* | — |
| GET | `/auth/sessions` | self | — |
| POST | `/auth/logout` | authenticated *(mid-enrolment ok)* | ✅ |
| POST | `/auth/logout-all` | self | ✅ |
| POST | `/auth/password` | self | ✅ |
| DELETE | `/auth/sessions/:sessionId` | self | ✅ |
| POST | `/auth/mfa/enroll` | authenticated *(mid-enrolment ok)* | ✅ |
| POST | `/auth/mfa/activate` | authenticated *(mid-enrolment ok)* | ✅ |

Those first three are **the only unauthenticated routes on the service**, and the list is closed and
enforced at boot. `/login`, `/mfa/verify`, `/refresh` and `/password` sit behind the strict credential
limiter: **10 requests per IP per minute**.

**`AdminProfile`** (identical from login, mfa/verify, refresh and `/auth/me`): `id`, `email`,
`displayName`, `tier`, `status`, `jobTitle|null`, `department|null`, `timezone|null`,
`preferredLanguage|null`, `mfaEnrolled`, `mfaRequired`, `lastLoginAt|null`, `createdAt`.

**`Session`** (from `/auth/me`): `sessionId` (UUID), `authenticatedAt`, `expiresAt` (the **absolute**
cap; idle expiry is enforced separately and not shown), `authMethod` (`cookie|bearer` — **this is
what tells the client whether CSRF applies to its writes**).

Full flow detail is in the Architecture Assessment §5. Defaults: access token 900 s, idle 8 h,
absolute 7 d, lockout after 5 attempts for 15 min, MFA challenge 5 min, MFA mandatory at tier ≤ 1.

---

## 14. Permissions — `/permissions` · 3 endpoints

| Method | Path | Permission |
|---|---|---|
| GET | `/permissions/catalog` | *self* — the vocabulary a dashboard is written against |
| GET | `/permissions/me` | *self* — **build navigation from this** |
| GET | `/permissions/tiers` | `permissions.read` (tiers 1–2) |

`catalog` → `{ families[], permissions[], total: 110 }`; each permission carries `name`, `family`,
`action` (`read|write|approve`), `summary` (**written for an administrator — safe to render**),
`financial`, `escalation`, `destructive`, `dualControl`, `scoped`, `phase`. **The dual-control
*predicate* is never exposed** — only whether one exists.

`me` → `{ adminId, tier, tierLabel, permissions[] }`, resolved for the caller's **current** level.
Call it after login and again after any `/auth/refresh` that follows a level change.

`tiers` → the full level → permission matrix, alphabetical within each level. For the administrator
screen: what changes when you move someone from Support to Admin.

---

## 15. Approvals — `/approvals` · 5 endpoints

| Method | Path | Permission | Audited |
|---|---|---|---|
| GET | `/approvals` | `approvals.read` | — |
| GET | `/approvals/:approvalId` | `approvals.read` | — |
| POST | `/approvals/:approvalId/approve` | **dynamic** — the pending action's own permission | ✅ |
| POST | `/approvals/:approvalId/reject` | **dynamic** — that permission **or** be the requester | ✅ |
| DELETE | `/approvals/:approvalId` | *self*, own requests only | ✅ |

**There is no `approvals.approve` permission, deliberately** — a single "may approve things"
permission would let someone commit an action they could not have performed themselves.

**Exactly three actions queue:** `PUT /administrators/:id/tier` (to tier 1),
`POST /administrators/:id/suspend|reinstate` (target is a Developer),
`POST /money/payouts/:id/mark-paid` (**≥ 2 000 000 XAF**). Rejecting a payout and demoting an admin
are **never** queued — quorum sits on the irreversible direction only.

**`Approval`:** `id`, `action`, `description` (one line written for the approver — render it),
`status` (`pending|approved|rejected|expired|withdrawn`), `requestedBy`, `requestedByTier`,
`requestedByTierLabel`, `targetType`, `targetId` (**not necessarily a Mongo id**), `payload`,
`approverId|null`, `decidedAt|null`, `decisionNote|null`, **`failureReason|null`** (approved but the
action was refused on re-check), `expiresAt`, `createdAt`.

**Approving performs the action** — a `200` means the promotion happened, not that it was scheduled.
The precondition is **re-checked at approval time** (`409 PAYOUT_NOT_PENDING`).
Errors: `403 AUTHZ_APPROVAL_SELF_APPROVAL`, `404 AUTHZ_APPROVAL_NOT_FOUND`,
`409 AUTHZ_APPROVAL_ALREADY_RESOLVED`, `409 AUTHZ_APPROVAL_EXPIRED` (24 h default).
The `note` (1–500) on approve/reject is **the field a later audit review actually reads**.
`GET /approvals` defaults to `status=pending`; no sort is offered (newest first).

---

## 16. Shipments — `/shipments` · 6 endpoints

| Method | Path | Permission | Transport | Audited |
|---|---|---|---|---|
| GET | `/shipments` | `shipments.read` | direct | — |
| GET | `/shipments/:shipmentId` | `shipments.read` | direct | — |
| GET | `/shipments/:shipmentId/offers` | `shipments.read` **+** `agents.read` | direct | — |
| GET | `/shipments/:shipmentId/activity` | `shipments.read` **+** `audit.read` | direct | — |
| POST | `/shipments/:shipmentId/reassign` | `shipments.reassign` | **delegated** | ✅ |
| POST | `/shipments/:shipmentId/cancel` | `shipments.cancel` | **delegated** | ✅ |

**No status transition exists, deliberately** — driving `picked_up → in_transit → delivered` is the
agent's and the agency desk's job. **`delivered` is not reachable by any admin transition.**

**`cancel` reaches only `assigned`** — it maps to the platform's `reject`, which refuses anything past
pickup. **Disable the button outside `assigned`**; the `422` carries `details.status`.

Status is validated by format, not membership (it is a cross-service contract also implemented in
geo-tracker's Go). Values today: `pending`, `assigned`, `handing_over`, `picked_up`, `in_transit`,
`agent_delivered`, `delivered`, `failed`, `returned`, `rejected`, `pending_agency_reassignment`.
**`assignmentState` is a separate axis** — `unassigned|offered|accepted`.

**Compare-and-set on the from-status**: losers surface as `PLATFORM_OPERATION_REJECTED` with
`details.platformCode: "SHIPMENT_STATUS_CONFLICT"` at 409 — reload and retry.

**Detail blocks:** `order`, `assignment { state, currentOfferId, offeredAgentId, updatedAt, offerCount }`,
`statusHistory[]` (`byRole` ∈ `agent|agency|admin|system`), **`handover` (textual only** — its
`source` is often a delivery agent's last GPS position, which does not leave through here),
`deliveryFailures[]`, `agentCancellation`, `rejection`, `customerConfirmation`, `hold`,
**`cod` (never the delivery code** — `codePlain`/`codeHash` are excluded twice over),
`offers[]`, `items[]`, `deliveryProofFileId`, and
**`tracking.outbox { pending, failed, lastEventAt, lastError }`** — outbox **health**, not a
trackability verdict. `failed > 0` on a just-reassigned shipment means a tracking session may be open
on an agent who is no longer delivering. Worth its own panel.

**`/offers` is unpaginated** — bounded by the assignment rounds. `sessionId` is `null` for a manual
offer; `createdBy` is set only on one.

**`reassign`:** `agentId` optional **pre-pickup** (auto-assign down a fresh ranking) and **required
past pickup** (`SHIPMENT_REASSIGN_REQUIRES_MANUAL_AGENT`); `reason` required; optional
`pickupLocation`. The old agent is **released, not terminated**, and the new agent's tracking session
opens only on accept — two agents are never tracked at once.

**`cancel`:** `note` **required** (3–200) and stored **on the shipment**, not only in the audit trail;
`reason` defaults to `platform_intervention`.

### ⚠ Corrections found in Phase 9, verified against the running service

1. **`SHIPMENT_NO_ELIGIBLE_AGENTS` (422) is a partial success, not a refusal**, and it is absent from
   every published error table. By the time it throws, `reassignAgent` has already run — the previous
   agent is detached, the assignment session deleted and capacity recomputed
   (`shipment-assignment.service.ts:750-757`). **The shipment is now unassigned.** A client treating
   it as "nothing happened" leaves an operator believing a delivery still has an agent.
2. **`assignment.offerCount` is a capped read, not a total.** `findForShipment(shipmentId,
   limit = 50)` serves both the embedded `offers` and `GET /:id/offers`, and `offerCount` is that
   capped length. No `meta` reports the truncation, so at 50 it means "at least 50". A `truncated`
   flag would fix it, as `searchMatchesTruncated` already does elsewhere.
3. **`rejection.by.source` is `'platform' | 'admin'`, never `"wi-admin"`.** `shipments.md:159` shows
   the latter; the DTO defaults to `'platform'` (`shipment.dto.ts:249`). **Fourth doc page carrying
   this same error** — `/users`, `/vendors` and `/agencies` all had it.
4. **`GET /shipments` can answer `meta.searchMatchesTruncated: true`**, undocumented. The
   order-number pre-match is capped at 200.
5. **Four detail blocks have no published shape.** `handover` (8 fields), `agentCancellation` (5),
   `customerConfirmation` (3) and `hold` (2) all show as `null` in the example. Read from
   `shipment.dto.ts:45-130`.
6. **Tracking numbers are `ACR-YYMMDD-HHMMSS-XXXXX`**, not the docs' `WM-SH-2026-114402`, and the
   search is an **uppercase-anchored prefix** on both surfaces — a partial word from the middle
   matches nothing by design, because the alternative is a collection scan requestable by query
   string. Worth stating, since a client that does not know it will report the search as broken.
7. **`SHIPMENT_REJECTION_REASONS` is not published.** Only `platform_intervention` is named anywhere,
   so the dashboard sends that one explicitly and offers no choice. Exporting the set would let the
   cancel dialog offer the others.

---

## 17. COD — `/cod` · 16 endpoints

Design records: `ADR-004-DOMAIN-OWNERSHIP.md`, `ADR-011-ACCOUNTS-AND-FINANCE.md`.
**Nothing on this surface is Support's.** Seven permissions here are `financial`.

| Method | Path | Permission | Transport | Audited |
|---|---|---|---|---|
| GET | `/cod/overview` | `cod.overview.read` | delegated | — |
| GET | `/cod/holders` | `cod.holders.read` | direct | — |
| GET | `/cod/remittances` | `cod.remittances.read` | delegated | — |
| GET | `/cod/remittances/:id` | `cod.remittances.read` | direct | — |
| POST | `/cod/remittances/:id/confirm` | `cod.remittances.confirm` | delegated | ✅ |
| POST | `/cod/remittances/:id/reject` | `cod.remittances.reject` | delegated | ✅ |
| GET | `/cod/deposits` | `cod.deposits.read` | delegated | — |
| POST | `/cod/deposits` | `cod.deposits.create` | delegated | ✅ (**201**) |
| GET | `/cod/deposits/:id` | `cod.deposits.read` | direct | — |
| POST | `/cod/deposits/:id/confirm` | `cod.deposits.confirm` | delegated | ✅ |
| POST | `/cod/deposits/:id/reject` | `cod.deposits.reject` | delegated | ✅ |
| GET | `/cod/discrepancies` | `cod.discrepancies.read` | direct | — |
| GET | `/cod/discrepancies/:id` | `cod.discrepancies.read` | direct | — |
| POST | `/cod/discrepancies/:id/resolve` | `cod.discrepancies.resolve` | delegated | ✅ |
| GET | `/cod/agents/:agentId/trust-events` | `cod.holders.read` **+** `agents.read` | direct | — |
| POST | `/cod/agents/:agentId/trust-adjustment` | `cod.trust.adjust` | delegated | ✅ |

**The cash model:** liability flows upward in two layers — an agent owes their agency, an agency owes
the platform. **There is no `platform` holder**; `ownerType=platform` is refused on `/holders`.
Two settlement paths: a **remittance** (agency → platform, confirming settles collections FIFO and
unlocks the agency's earnings) and a **deposit** (agent → agency normally, or `recipient: "platform"`
which skipped the middle leg). **A confirmed platform deposit carries two cash-ledger movements, an
agency deposit one** — that asymmetry *is* the model, and reading two `balanceAfter` values is how an
operator sees it.

`/holders` sorts `balance` · `lastMovementAt` · `createdAt`, default **`-balance`**. `version` is the
compare-and-set counter surfaced so a stale screen is detectable — **not a balance, do not compute
with it**. `trust` is **`null` for an agency** (does not apply, not unknown).
`includeSettled` defaults `false`.

`cashMovements[]` are **empty for a `declared` or `rejected` remittance, and that emptiness is the
point** — a declaration is a claim and nothing has moved until confirmed.

`POST /cod/deposits` is a **strict** body: `agentId`, `agencyId`, `amount` (positive integer),
`reference` (1–200, required), optional `note`. It is the one route here that asserts money arrived.

`discrepancies`: `amount` is **`null` for a non-monetary flag — not zero**. `raisedBy` ∈
`system|agency|admin|agent` (**the last is how an agent disputes**). On the detail,
**`trustEvents` is often empty and that is the system working** — `deposit_not_confirmed` is the
agency's failure and carries no agent penalty.
`resolve` takes `{ resolution: "resolved" | "written_off", note }` — **`written_off` means the
platform took the loss**; the note is required either way and neither outcome undoes the other.

`trust-adjustment` takes `{ delta: -100…100, note }` and is gated on **`cod.trust.adjust` alone** —
moving the score does not read the conduct record, so it does not need `agents.read`. The result is
clamped by the platform. **There is no cross-agent trust feed.**

---

## 18. Billing — `/billing` · 8 endpoints

| Method | Path | Permission | Transport | Audited |
|---|---|---|---|---|
| GET | `/billing/plans` | `billing.plans.read` | direct | — |
| GET | `/billing/plans/:planId` | `billing.plans.read` | direct | — |
| GET | `/billing/plans/:planId/subscribers` | `billing.plans.read` | direct | — |
| POST | `/billing/plans` | `billing.plans.manage` | delegated | ✅ (**201**) |
| PATCH | `/billing/plans/:planId` | `billing.plans.manage` | delegated | ✅ |
| DELETE | `/billing/plans/:planId` | `billing.plans.delete` | delegated | ✅ |
| GET | `/billing/subscriptions` | `billing.plans.read` | direct | — |
| POST | `/billing/subscriptions/:ownerType/:ownerId` | `billing.subscriptions.assign` | delegated | ✅ |

**Nothing here is Support's.** One owner-scoped engine across vendor/agency/agent; a plan's `role`
decides which limit fields it carries, so **about half the `limits` block is `null` on any plan** and
**`limits.* === null` means unlimited**. `termDays === null` means never expires.

**`archivedAt` is a soft-delete stamp, always present.** `DELETE` archives: the row stays and every
owner already on the tier keeps running on it until their term ends. Read it back with
`?includeArchived=true`; `data` is `null` on the delete response.

Plans sort `sortOrder` (default, **ascending**) · `price` · `name` · `createdAt` — `sortOrder` is the
field the platform put there to say what order the tiers belong in.

`role` and `code` are **immutable**; sending either on `PATCH` is a **400**, not a silent discard.
`commissionPercent` is **what every future order's split multiplies by** and does not retroactively
re-price anything.

**`/billing/subscriptions` exists for two questions nothing else can answer:** which terms are about
to lapse (**`expiringBefore`**, an instant rather than a day count — "the next seven days" differs by
timezone) and which owners have a plan queued behind their current one (`status=pending_activation`,
which silently becomes active without anybody acting).

`plan.code` comes off the subscription row itself, so it answers even when the plan lookup found
nothing — **`plan.name: null` beside a present `plan.code` is how a dangling reference shows itself**.
`assignedBy: null` means nobody assigned it (self-service, or the lazily created free default).
`expiresAt: null` is the never-expiring free tier, not "unknown".

Assignment is refused by the platform for `BILLING_PLAN_INACTIVE` and `BILLING_PLAN_ROLE_MISMATCH`
(both as `details.platformCode`), neither pre-checked here.
**Plan and credit purchases create no `PaymentTransaction`.**

---

## 19. Money — `/money` · 14 endpoints

| Method | Path | Permission | Transport | Audited |
|---|---|---|---|---|
| GET | `/money/earnings/platform` | `money.earnings.read` | delegated | — |
| GET | `/money/earnings/platform/ledger` | `money.earnings.read` | direct | — |
| GET | `/money/earnings/accounts` | `money.earnings.read` | delegated | — |
| GET | `/money/earnings/allocations` | `money.earnings.read` | direct | — |
| GET | `/money/earnings/allocations/:id` | `money.earnings.read` | direct | — |
| GET | `/money/payouts` | `money.payouts.read` | direct | — |
| GET | `/money/payouts/:payoutId` | `money.payouts.read` | direct | — |
| GET | `/money/payouts/:payoutId/destination` | **`money.payouts.destination.read`** | direct | ✅ **audited read** |
| GET | `/money/payouts/:payoutId/activity` | `money.payouts.read` **+** `audit.read` | direct | — |
| POST | `/money/payouts/:payoutId/mark-paid` | `money.payouts.mark_paid` | delegated | ✅ **dual-controlled** |
| POST | `/money/payouts/:payoutId/reject` | `money.payouts.reject` | delegated | ✅ |
| GET | `/money/payments` | `money.payments.read` | direct | — |
| GET | `/money/payments/:transactionId` | `money.payments.read` | direct | — |
| GET | `/money/refunds` | `money.payments.read` | direct | — |

**Support holds exactly one permission here — `money.payments.read`** (gateway payments and refunds).
The sharp fields (raw gateway payload, payload hash, idempotency key) are removed by **projection,
for everyone**, not by permission.

**The transport rule: read the record, delegate the balance and every write.**

**Payout destinations — the most easily misread part of the service.**
On `GET /money/payouts` and everywhere else, **the digits are absent because they were never read** —
the query projection does not name them. So `masked.mobileMoney.phoneNumberMasked` is **`null`**, not
`••••3456`; `masked.bank.accountNumberMasked` is `null`; `provider`, `bankName` and `accountName` are
present; `masked.card` is present in full (`last4` is the entire number the platform holds).
**`full.*` is always present as a key and always `null` here** — a key appearing only on the
disclosure endpoint would make "not disclosed" and "out-of-date client" indistinguishable.
**An operator recognises a destination by provider + account name**, e.g. "MTN · Nadège Mbarga".

`GET /payouts/:id/destination` is **the one route that emits an account number**, the only `financial`
**read** in the catalog, and **every call is audited** — the row commits *before* the value is read.
Make it an explicit action, never part of the detail load. `full.card` is permanently `null` by
design. `422 PAYOUT_DESTINATION_ABSENT` is distinct from `404` on purpose.
`GET /payouts/:id/activity` is where somebody reads back **who saw an account number**.

**`mark-paid` has no `amount` in the body, and that is load-bearing** — the controller builds the
dual-control payload from the row, so the 2 000 000 XAF threshold is evaluated against the money that
will actually move. Sending `amount` is a **400**, not a silently ignored field. Under the threshold →
`200`. At or above → **`202` with an `Approval`; nothing has been paid.** `409 PAYOUT_NOT_PENDING` is
raised on the pre-flight *and* again at approval time.
`reject` is **never dual-controlled at any amount** — the funds simply return to the owner's balance.

**Earnings ledger `amount` is the positive magnitude, never signed.** Direction is `entryType`'s job
(`hold` · `release` · `reversal` · `reserve_hold` · `reserve_release`). A client that subtracts on
sign gets `reserve_hold` backwards — it moves money *sideways* (pending → reserve).

**Allocations are the collection that had no admin surface anywhere** — one row per
`(source, beneficiary)`. `snapshots { gross, commissionPercent }` are the split's frozen inputs;
`release.holdReleaseAt: null` means the source has not completed at all; `requiresCashSettlement: true`
alongside `cashSettledAt: null` is exactly "the cash is not here", and **`unsettledOnly`** is the
filter for that two-field predicate. The detail adds `movements` (**a `held` allocation with no ledger
rows is a real and alarming state**) and `siblings` (**the only place a split is visible as a whole** —
do the parts sum to the gross?).

**Payments `settles`:** exactly one of `orderId` / `orderIds`+`cartId` / `bookingId` is set. **A
multi-vendor checkout is one payment settling N orders**, so a row whose `orderId` is `null` is not an
incomplete record. `payer.kind` is always `"customer_or_user"` — a deliberate *unknown* rather than a
guess. `gatewayRef` is the string quoted in a dispute.

**Refunds** sit under `money.payments.read`, not `orders.refund` — gating the read on the write's
permission would mean nobody could check a refund without being able to issue one. The date range
filters `createdAt`, **not `completedAt`**, so `pending`/`failed` rows are not silently dropped.
`initiatedBy.role` is who **asked** (`vendor|admin|customer`), not who approved.

---

# Cross-cutting rules every module inherits

| Rule | Detail |
|---|---|
| **Envelope** | Success `{ success, data, meta?, message? }` — `data` always present (object, array or `null`). Error `{ success, requestId, error { code, message, statusCode, category, details? } }`. **Branch on `error.code`, never `message`.** `details` is **omitted** when absent |
| **Nine categories** | `authentication` · `authorization` · `validation` · `not_found` · `conflict` · `business_rule` · `rate_limit` · `external_service` · `internal`. Derived from `(code, statusCode)`. The right key for generic handling: re-login / hide affordance / show field errors / back off / escalate |
| **camelCase** | Both databases are snake_case; the translation happens in wi-admin and never leaks. Do not copy field names from `docs/jovi-mall/`. **No exceptions as of 2026-08-20** — the three delegated order writes were the last snake_case leak and now answer with `OrderDetailDto` |
| **Money** | A plain number in the account currency (default `XAF`). **Never divide by 100** |
| **Pagination** | `page` ≥1 default 1; `limit` default 20, **hard max 100 everywhere**; no `?limit=all`. `meta = { total, page, limit, pages }` where **an empty list reports `pages: 0`**. One cursor-paged exception: `/accounts/:t/:id/activity` |
| **Sorting** | One key, `?sort=field` / `?sort=-field`, per-endpoint allowlist; an undeclared field is a `400` naming the permitted set. Some lists offer no `sort` at all (`/administrators`, `/approvals`, `/cod/remittances`, `/cod/deposits`, `/money/earnings/accounts`, `/audit/legacy`) |
| **Dates** | Half-open `[from, to)`; **date-only values are refused**. The client resolves the day in the operator's timezone (`admin.timezone`) and sends ISO-8601 instants with an explicit zone. `maxDays` 366 on most lists, **92 on `/audit`** |
| **Clearing fields** | Omit the key → unchanged; `null`/`""`/whitespace → cleared (returned `null`); a value → validated. Fields recording an assertion reject `""`. On output an existing field is always present; absent data is `null`, never omitted, never `""`, never `0`. Arrays are `[]`, never `null` |
| **Unknown enums** | **Render the raw string.** Adding a member is additive and non-breaking, so a closed `switch` breaks on a routine deploy |
| **Search** | `?search=` trimmed 1–120 chars; an **empty one is rejected** — send no parameter instead |
| **Booleans** | `true`/`false`/`1`/`0`; **`false` means false** |
| **Ids** | 24-hex ObjectIds, opaque. Session/challenge/approval ids are UUIDs (approval ids are 24-hex). A malformed path id is `400`, not `404` |
| **`404` is the denial** for out-of-scope records — a 403 on an id would confirm the id exists |
| **`X-Request-Id`** | Send it, it is echoed back and exposed to browsers. Surface it in generic error toasts |
| **Rate limits** | Global 3000/min/IP; per-identity 2400 (T1) / 1800 (T2) / 1200 (T3) per minute; **credential routes 10/min/IP**. All `429 RATE_LIMIT_EXCEEDED` with `details.retryAfterSeconds` and `draft-7` headers |
| **Body** | JSON, **1 MB max**, `413 REQUEST_BODY_TOO_LARGE`. **No multipart anywhere.** Endpoints marked *strict* reject unknown fields with a `400` |
| **Audit** | Every mutation is audited before it answers, in the same transaction. A `2xx` on a write means the audit row committed. The five inbox-hygiene routes are the deliberate exception; `GET /money/payouts/:id/destination` is the one audited **read** |
| **Delegated failures** | `PLATFORM_OPERATION_REJECTED` at jovi-mall's original status with its code in **`details.platformCode`** — branch on that, not on `error.code`. `SERVICE_DEPENDENCY_UNAVAILABLE` (502/503) means no answer came back |

---

# Gap register

Carried from the Architecture Assessment §10 so both documents agree.

| # | Gap | Impact |
|---|---|---|
| D1 | No dashboard/overview aggregate endpoint | Home page composed from six independently gated tiles; Support sees one |
| ~~D2~~ | ~~No file-URL resolution for any `*FileId`~~ | **✅ CLOSED 2026-08-17.** `GET /api/v1/files?ids=` and `GET /api/v1/files/:fileId` under `files.resolve`, held by every tier. Delegated to jovi-mall, so ADR-009 D-6 stands — this service still owns no storage layer. See [files.md](../api/files.md). ⚠️ The batch response may be **shorter than the request and is not in request order** (files are swept); key by `id`, and check `mimeType` before rendering an `<img>` |
| D3 | No QR renderer in any sibling | New frontend dependency needed for MFA enrolment (Phase 2) |
| D4 | No realtime (no WS, no SSE, no push) | Inbox, approvals and health must be polled; intervals are a client decision |
| D5 | No `/support`, `/content`, `/broadcast`, `/customers` surface | **27** † permissions with no endpoint (was 28). **Support's headline job (tickets) still has no surface**; do not build those screens. `/files` is no longer on this list — but only `files.resolve` is mounted, and `files.orphans.read` remains † and tier-1-only |
| D6 | `users.roles.manage` / `sessions.revoke` unrouted | **`users.password.reset` is now routed** (2026-08-17) — `POST /users/:userId/password-reset-link`, plus a new `users.login_link.send` for the customer sign-in link. Both tier 1–2 only, never Support. The other two stay unrouted for the reasons `users.md` gives |
| D7 | `notifications.manage` unrouted | No global notification-source configuration screen |
| D8 | `developer_tools.webhooks.redeliver` unrouted | Use `POST /dev-tools/outbox/replay` |
| D9 | Audit export download is instance-local | Handle `410 AUDIT_EXPORT_FILE_MISSING` explicitly |
| D10 | No purge from the API | Export screen must state that nothing was deleted |
| D11 | **CORS allowlist** `ADMIN_DASHBOARD_ORIGINS` must include the dev origin | `http://localhost:5175` has to be added backend-side or every browser call is blocked |
| D12 | Polling intervals unspecified by the contract | **Resolved in Phase 4.** `GET /notifications/unread-count` every **60 s** (`env.notificationsPollMs`, overridable with `VITE_NOTIFICATIONS_POLL_MS`, floored at 10 s). Paused while `document.hidden` and refetched once on return; not started at all without `notifications.read`. There is no realtime transport on this platform, so polling is the only mechanism available |
