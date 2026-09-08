# ADR-010 — Orders and shipments

**Verified against source on 2026-09-08** — the ten `/orders` and eight `/shipments` routes against the live manifest, and the nine-value closed `eventType` union at `jovi-mall/src/modules/orders/order-timeline.model.ts:22-31`. Every route, error code, permission and audit action this page names was re-checked against the live route manifest and the four registries — `permission.catalog.ts`, `audit.catalog.ts`, and both services' `error-codes.ts`. ⚠ **This is a dated design record.** Its *Context* sections describe what PHASE-0 or the phase found **at the time** and are correct as history, not as a description of the service today; where a decision is still the live rule it says so at its own D-item.

**Status:** accepted · **Implements:** the commerce brief; the `orders` and `shipments`
halves of blueprint Phase 6 · **Follows:** [ADR-004](./ADR-004-DOMAIN-OWNERSHIP.md)
(ownership), [ADR-005](./ADR-005-API-CONTRACT.md) (contract),
[ADR-008](./ADR-008-VENDOR-MANAGEMENT.md) (the shape this mirrors)

> Numbered **010**, not 009: `api/index.ts` already cites
> `ADR-009-DELIVERY-NETWORK.md`, which the delivery phase owes.

---

## Context

PHASE-0 found the two largest commerce collections almost entirely unadministrable.

**Orders had two endpoints.** `GET /api/admin/orders/disputes` and
`POST /api/admin/orders/:id/dispute/resolve`, both in `modules/orders/admin-order.routes.ts`.
There was no list, no detail, no timeline. An administrator holding an order number could
do nothing with it.

**Shipments had none at all.** No `/api/admin/shipments*` route existed anywhere in
jovi-mall, no admin controller imported `ShipmentService`, and `api-doc/admin/` had no
shipments page. An administrator asked why a delivery had not moved in three days could see
the order and the agency and nothing in between.

Five defects were found alongside, and all five are fixed here because this phase makes
each of them reachable. They are recorded in the same voice ADR-008 used for
`setLegitVerified`: found while building, fixed because building on top of them would have
been worse.

| # | Defect | Where |
|---|---|---|
| **F-1** | `OfferCreator.role` was `'agency' \| 'system'` and `shipment_assignment_offers.created_by.role` declared the matching two-value Mongoose enum. An admin reassign would throw a `ValidationError` **at the offer write — after `reassignAgent` had already detached the old agent**, leaving the shipment agentless with no replacement offered. | `shipment-assignment.service.ts:51`, `shipment-assignment-offer.model.ts:176` |
| **F-2** | `ShipmentRepository.applyRejection` was a bare `findByIdAndUpdate` with no `status` and no `agency_id` predicate, guarded only by a read-then-check in `ShipmentService.reject`. Two concurrent rejects both won; a reject racing a pickup clobbered it; the post-commit block (offer cancellation, capacity release, vendor notification) fired for a status nobody was in. | `shipment.repository.ts:494` |
| **F-3** | `cash_collections.code_plain` — the customer's plaintext COD delivery OTP — is protected in jovi-mall by Mongoose `select: false`. **wi-admin reads with the raw MongoDB driver, which does not honour it.** | `cash-collection.model.ts:120` |
| **F-4** | `initiateCartPayment` **always** writes `{ cartId, orderIds[] }` and never `orderId` (the model's pre-save hook enforces exactly one source field). `refundPayment` looked up `{ orderId }`, so **every cart-checkout order was unrefundable — on the vendor's own endpoint** — with `REFUND_PAYMENT_NOT_FOUND`. `VendorRefundService.getEligibility` had the same lookup and therefore the same lie. | `payment-orchestrator.service.ts:337,436` |
| **F-5** | `adminResolveOrder` returned early when nothing was disputed, so the endpoint answered `200 Dispute resolved as won` for an order that was never disputed. Idempotency is right for a Stripe webhook and wrong for an operator. | `dispute.service.ts` |

A sixth thing was not a defect but was in the way: **the cancellation rules lived in a
controller.** `CANCELLABLE_FULFILLMENT_STATES` and `COD_NON_CANCELLABLE_SHIPMENT_STATUSES`
were module-private `const`s in `customer-order.controller.ts`, and the six-guard sequence
was inline in the handler. `OrderService.cancelOrder` itself guards only idempotency,
deliberately, so the unpaid-order sweep can call it. A second actor meant the rules had to
move or be copied — see D-3.

---

## Decisions

### D-1 · Admin is a third actor on an existing domain service, never a parallel implementation

jovi-mall already demonstrates the pattern: `ShipmentService.updateStatus` (agency) and
`updateStatusByAgent` (agent) are thin ownership-scoping wrappers over one shared
`_transitionStatus` with a discriminated actor union. Every write in this phase takes the
same shape.

The consequence is that widening an actor union by one member is correct and copying a
service is not. What actually changed in jovi-mall is six one-line widenings, one guard
extraction, one compare-and-set and one new policy service — and nothing else.

### D-2 · The owning scope is resolved FROM THE RECORD, not from the session

Every shipment command path in jovi-mall is hard-scoped by `findByIdAndAgency`. An
administrator has no agency of their own, so the tempting move is an unscoped variant of
each method — which is a second implementation of the assignment rules, the compare-and-set
and the post-commit effects.

Instead, `AdminShipmentController` performs one unscoped read, takes the shipment's own
`agency_id`, and calls the ordinary agency path with a different `creator.role`:

```ts
const shipment = await shipmentRepository.findById(shipmentId);
if (!shipment) throw createAppError(ERROR_CODES.SHIPMENT_NOT_FOUND, 404);
await shipmentAssignmentService.reassign(
    shipment.agency_id.toString(), shipmentId, input,
    { role: 'admin', userId: actor.id, name: actor.name },
);
```

`findByIdAndAgency(shipmentId, agencyId)` becomes a tautology, which is correct — and
`REASSIGNABLE_STATUSES`, the post-pickup manual-agent rule, the replacement's eligibility
and contract-coverage checks, `HandoverPickupService.resolve`, the `claimForReassignment`
compare-and-set, the old agent's tracking release and capacity return, the COD re-open and
the session disposal all still happen, because it **is** that path.

**An administrator does not bypass the ownership scope. They supply it from the record
instead of from their session.** The same move appears in `AdminRefundService`, which takes
`vendorId` from `order.vendor_id`.

### D-3 · The cancellation guards move to the service; exactly one of them is waived

`OrderService.assertCancellable(order, { actorType, vendorPolicy })` now owns all six
guards, and both the customer controller and the admin controller call it.

| Guard | Customer | Admin |
|---|---|---|
| already cancelled → 409 | ✅ | ✅ |
| not in `CANCELLABLE_FULFILLMENT_STATES` → 422 | ✅ | ✅ |
| **the vendor's cancellation policy** | ✅ | **waived** |
| `payment_status === 'paid'` → `ORDER_CANCEL_REQUIRES_REFUND` | ✅ | ✅ |
| payment not `pending`/`AWAITING_PAYMENT` → 422 | ✅ | ✅ |
| COD physical with an in-flight shipment → 422 | ✅ | ✅ |

**The vendor's policy is the only waivable guard, and the reason is what makes it the only
one.** A return window is the vendor's commercial promise to their customer; the platform
is not party to it. Every other guard is physical (a parcel is in a van) or financial
(money was taken), and binds an administrator exactly as it binds a customer. A second
exemption needs a reason of that kind — the doc comment says so, because the next person
will be tempted.

Note what this is NOT: it is not a `skipGuards` flag. `actorType` selects one rule, named,
with its justification beside it.

### D-4 · `shipments.cancel` maps to `reject`, and inherits its narrowness

There is no `cancelled` shipment status and there deliberately is not: the enum is a
cross-service contract duplicated in geo-tracker's Go, so adding a member would be a
two-repo change. The domain's existing answer to "this shipment is not happening at this
agency" is `reject`, which sets `rejected`, puts every order item on hold at
`pending_agency_reassignment` through the same mechanism the agency-deactivation cascade
uses, cancels pending offers, releases agent capacity and notifies the vendor. The route is
named for the action the *permission* governs (ADR-005 D-4).

**`reject` refuses anything but `assigned`, and the admin path inherits that refusal rather
than widening it.** So `shipments.cancel` covers exactly one window: dispatched to an
agency, not yet picked up. A picked-up shipment is physically with an agent, and the
domain's answer there is a reassignment or a return. Widening `reject` to reach it would be
inventing the parallel implementation D-1 forbids.

This is narrower than the permission's own summary ("Cancel a shipment already in
progress") suggests. **The dashboard must disable the button outside `assigned`** — the 422
carries `details.status`.

### D-5 · A new `ShipmentRejectionReason`, disjoint from every agency-driven one

`platform_intervention`, added to the type union, the schema enum and the validator — from
**one exported array**, `SHIPMENT_REJECTION_REASONS`, rather than retyped in three places.
That follows the rule the notification stacks already pay for: derive the Mongoose enum from
the type union, never hand-maintain both.

Exact precedent for the reason itself: ADR-008 D-3 added `platform_oversight` to
`ProductSuspensionReason` so a reason an administrator owns is tellable apart from an
agency's. Folding admin cancellations into `other` would erase exactly that distinction.

### D-6 · The admin refund is a third policy layer over one money pipeline

`AdminRefundService` sits directly on `PaymentOrchestratorService.refundPayment`.

**Not `VendorRefundService`, and not a flag on it.** That layer is hard-scoped to a vendor
and enforces the vendor's four commercial gates. An administrator refunding *is* the act of
overriding those, so entering there means telling an operator "the vendor's 14-day window
expired" about an order the platform has already decided to refund. And a flag would be
worse than either: **a policy layer that can be told to skip itself is not a policy layer**,
and it would leave the vendor's own endpoint one boolean away from ignoring the vendor's
policy.

**Not the bare orchestrator either.** It requires a `vendorId` only the order knows and
never runs `recordFullRefund`, so an admin path calling it directly would silently drift
every refunded customer's denormalised lifetime spend away from the vendor path's.

What may and may not be overridden:

| MAY — the vendor's commercial terms | MUST NOT — the money invariants |
|---|---|
| `return_eligible === false` | more than the remaining refundable balance |
| `refund_type === 'none'` | an order with no `SUCCEEDED` payment |
| the return window | a gateway with no refund API (only Stripe has one) |
| `refund_percentage` — the admin ceiling is the full remaining balance | an already fully-refunded payment |
| | the pipeline shape: pending row → gateway call outside any transaction → atomic finalize → escrow reversal |

**`overridePolicy` never reaches the orchestrator.** Every entry in the right column already
lives inside `refundPayment` and none is reimplemented. The one guard this service adds is
COD (`REFUND_ORDER_IS_COD`, 422), which the orchestrator cannot express because it does not
know the source is COD.

Without the flag, a refund beyond the vendor's terms is **422
`REFUND_POLICY_OVERRIDE_REQUIRED`** carrying exactly which gates it would cross — so an
operator confirms a *specific* override, not a general one. `reason` is required where the
vendor's is optional: jovi-mall stores it on the `RefundTransaction`, and it has to, because
this service's audit trail lives in a database jovi-mall cannot read.

### D-7 · No admin shipment status transition

The declared permissions are read, reassign and cancel. Driving a delivery through
`picked_up → in_transit → delivered` is the agent's job and the agency desk's.

There is a mechanical reason as well as a jurisdictional one. An admin transition would need
a third member on `ShipmentStatusActor` carrying neither an `agencyId` nor an `agentId` —
and those two are what `applyStatusChangeIfCurrent` puts in its compare-and-set filter. A
third actor with neither would strip both ownership predicates out of the guard that makes
two actors on one shipment safe in the first place.

### D-8 · No admin fulfillment-status override

`partially_shipped`, `shipped`, `partially_delivered`, `delivered` and `fulfilled` are
**system-derived**: `OrderFulfillmentAggregationService.recomputeFulfillmentStatus` is their
only writer and it runs inside every shipment transition. An administrator writing one
directly would be erased by the next shipment event.

The two genuinely admin-driveable interventions are **cancel** and **dispatch**, and both
have real domain entry points. `orders.intervene` governs exactly those two.

### D-9 · Trackability is jovi-mall's policy; wi-admin reports outbox health

`TRACKABLE_SHIPMENT_STATUSES` and `shipmentTrackability()` are jovi-mall's, and the
platform's governing rule is explicit that visibility rules are never reimplemented outside
it. Recomputing "is this shipment trackable" here would be a second definition of who may
be watched.

What the shipment detail reports is a **record**: how many `tracking_outbox` rows for this
shipment are pending or failed, and when the last one went out. That is what makes the
platform's known non-transactional-outbox defect *visible* on the one screen that cares.

### D-10 · Status vocabularies are bounded strings, not enums

ADR-005 D-17, with a trap worth naming: `orders.payment_status` holds `'AWAITING_PAYMENT'`
in SCREAMING_SNAKE beside `'pending'` and the rest in snake_case, so the obvious bound
`/^[a-z_]+$/` would make the platform's own value the one thing the filter could not
express. The bound is `/^[A-Za-z_]+$/`.

Three vocabularies ARE pinned, and each for a stated reason: `order_type` (a closed
two-value set jovi-mall's own pre-save hook enforces), `payment_method` (same), and the
dispute `outcome` (not a stored status — it is this surface's own argument to
`adminResolveOrder`).

### D-11 · No new permissions and no grant-table change

All eight already existed in the catalog and were already granted: Support holds
`orders.read`, `orders.disputes.read`, `shipments.read`; Admin holds `allInFamily('orders')`
and `allInFamily('shipments')` plus the three sensitive ones by name. `PermissionSpec.phase`
already includes `6`. This phase touches neither `permission.catalog.ts` nor
`tier-grants.ts`.

Two access decisions are worth recording:

- **`refund-eligibility` is gated on `orders.refund`, not `orders.read`.** Its answer is a
  ceiling on money leaving the platform, not a record — a Support administrator must not see
  a refund ceiling. It is also the one READ this phase delegates, for the ADR-008 D-1
  reason: a copy of that arithmetic here would be a second definition of what a customer is
  owed.
- **`/shipments/:id/offers` additionally requires `agents.read`.** The rows name agents,
  their round and their refusal reasons; gating on `shipments.read` alone would make it a
  second door onto the agent directory.

---

## The surface

### `/api/v1/orders`

| Method | Path | Access | Transport |
|---|---|---|---|
| `GET` | `/` | `orders.read` | direct read |
| `GET` | `/disputes` | `orders.disputes.read` | direct read |
| `GET` | `/:orderId` | `orders.read` | direct read |
| `GET` | `/:orderId/timeline` | `orders.read` | direct read |
| `GET` | `/:orderId/activity` | `orders.read` + `audit.read` | wi-admin's own DB |
| `GET` | `/:orderId/refund-eligibility` | `orders.refund` | **delegated** |
| `POST` | `/:orderId/dispute/resolve` | `orders.disputes.resolve` | **delegated** |
| `POST` | `/:orderId/cancel` | `orders.intervene` | **delegated** |
| `POST` | `/:orderId/dispatch` | `orders.intervene` | **delegated** |
| `POST` | `/:orderId/refund` | `orders.refund` | **delegated** |

### `/api/v1/shipments`

| Method | Path | Access | Transport |
|---|---|---|---|
| `GET` | `/` | `shipments.read` | direct read |
| `GET` | `/:shipmentId` | `shipments.read` | direct read |
| `GET` | `/:shipmentId/offers` | `shipments.read` + `agents.read` | direct read |
| `GET` | `/:shipmentId/activity` | `shipments.read` + `audit.read` | wi-admin's own DB |
| `POST` | `/:shipmentId/reassign` | `shipments.reassign` | **delegated** |
| `POST` | `/:shipmentId/cancel` | `shipments.cancel` | **delegated** |

### Not offered, deliberately

- **A forced `fulfillment_status` transition** (D-8) — those states are system-derived, and
  a hand-written one is erased by the next shipment event.
- **An admin shipment status transition** (D-7) — it would strip the ownership predicates
  out of the compare-and-set that makes two actors on one shipment safe.
- **A shipment cancellation past pickup** (D-4) — `assigned` only; the domain's answer past
  that is a reassignment or a return.
- **Admin booking refunds** — there is no `bookings.*` permission; `orders.refund` is the
  only grant, and `RefundSource` stays unforked.
- **`shipment_assignment_sessions` reads** — a transient ranking disposed of on terminal
  status. The offer rows already tell the sequence.

---

## Consequences

**The cancellation rules now have two enforcers and one definition.** Before this phase they
had one enforcer and no way for a second caller to reach them; the alternative was a copy of
two constants and six guards, drifting on a money question.

**Two live defects are fixed on paths this phase does not own.** F-4 makes the *vendor's*
refund endpoint work for cart-checkout orders, which is the majority of them; F-2 turns a
silent double-reject into a 409 on the *agency's* endpoint. Both are net improvements
independent of wi-admin, which is the test for whether a change is domain preparation or
admin scaffolding.

**Nine new indexes on two hot collections.** Four on `orders`, four on `shipments`, one
multikey on `payment_transactions`. Taken deliberately: the alternative is a platform-wide
list that blocking-sorts the whole collection on every page, requestable by query string.
Two superseded single-field order indexes are dropped by a migration, because `autoIndex`
creates and never drops.

**`LEGACY_ENDPOINT_COUNT` 61 → 59.** Shipments contribute nothing — there was no legacy
shipment admin surface to retire. The jovi-mall `/api/admin/orders` mount stays live until
cutover because a dashboard consumes the dispute queue, but the four new capabilities are
**internal-only**: a refund moves money through a gateway, and `requireRole(['admin'])` on a
platform `users` row is a credential that predates this service's permission catalog.

### Deploy note

**Run the index migration before the endpoints are reachable.** On a large `orders`
collection `{created_at: -1}` is a background build measured in minutes, and `autoIndex`
fails **silently** — a failed build leaves no index and no error.

```bash
cd jovi-mall
npm run migrate:admin-order-indexes -- --dry-run   # shows what it would drop
npm run migrate:admin-order-indexes
npm run dev                                        # autoIndex creates the replacements
# then confirm, because a silent failure is the failure mode:
#   db.orders.getIndexes()   db.shipments.getIndexes()
```

**F-2 changes behaviour on a live path.** `POST /api/agency/shipments/:id/reject` now
answers **409 `SHIPMENT_STATUS_CONFLICT`** where it previously clobbered. Ship it before the
admin caller exists so any fallout is attributable to one change.

**`LEGACY_ENDPOINT_COUNT` is shared.** If `test:authz` fails on the count after a merge,
another phase moved it concurrently — reconcile rather than overwrite. It fails loudly by
construction.

---

## Still open

- **The tracking outbox is not transactional** with the state change it describes — the
  platform's own documented defect. An admin reassign can strand a tracking session exactly
  as an agency reassign can. Not fixed here; the shipment detail's outbox-health block is
  what makes it visible, which is the honest response.
- **Dual control on `orders.refund` above a threshold.** The four-eyes machinery exists
  (`modules/dual-control`) and this is the most obvious candidate for it in the service. Not
  wired, because nobody has named an amount.
- **`status_history` carries no actor source or name.** `changed_by_role` is already the
  discriminator `actorSourceOfRole` defines, and this is a high-cardinality append-only array
  on the platform's hottest write path. Considered and declined.
- **Non-Stripe gateways cannot refund at all.** `getEligibility` reports
  `gatewayRefundSupported: false` up front so an operator learns before pressing the button,
  but a mobile-money order simply has no refund path.
