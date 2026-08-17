import { Router } from 'express';

/**
 * The `/api/v1` router — the versioned surface the admin dashboard consumes.
 *
 *   Phase 2  /auth                      admin identity, sessions, MFA
 *   Phase 3  /administrators            administrator management (create, level, suspend)
 *            /permissions               the policy, and what the caller holds of it
 *            /approvals                 the four-eyes queue
 *   Phase 3.5 /audit                    the audit log query + export surface ✅
 *   Phase 5  the 81 ported endpoints    agents, cod, agencies, orders, shipments,
 *                                       tickets, articles, files — the money ones
 *                                       (billing, earnings, payouts) landed at Phase 11
 *   Phase 6  /users ✅, /vendors ✅,     the domains that existed nowhere
 *            /customers, /shipments
 *   Phase 7  /system, /dev-tools        operations surface
 *
 * ── A hazard this service must not inherit ─────────────────────────────────────
 * jovi-mall stacks FIVE routers on the bare `/admin` prefix. Express runs each one's
 * `router.use` guards for every request matching the prefix, so `GET /admin/profile`
 * re-resolves authentication up to five times (~10 Mongo queries before the handler),
 * and two routers declaring the same path silently makes the later one dead code — a bug
 * that has already bitten that codebase once, on `/agent`.
 *
 * THE RULE HERE: one mount per path prefix. Every `apiV1.use('/x', ...)` below must have
 * a distinct `/x`, and the authorization guard attaches per route, never as a prefix-wide
 * `router.use` — which `defineRoute()` in `route-manifest.ts` is what enforces.
 */
const apiV1 = Router();

// Administrator authentication: login, MFA, refresh, logout, sessions.
// Guards attach per route inside this router — it mixes public (login/refresh) with
// authenticated paths, so a router-wide guard would make the public ones unreachable.
import { authRoutes } from '../modules/admin-identity/routes/auth.routes';
apiV1.use('/auth', authRoutes);

// Administrator management. The escalation-critical surface: creating administrators,
// changing levels, suspension, and signing someone else out. Until Phase 3 the bootstrap
// CLI was the only way an administrator came into existence.
import { administratorRoutes } from '../modules/administrators/routes/administrator.routes';
apiV1.use('/administrators', administratorRoutes);

// The permission catalog, the caller's effective set, and the level matrix. The dashboard
// builds its navigation from these rather than from the 403s it would otherwise collect.
import { permissionsRoutes } from '../modules/authorization/routes/permissions.routes';
apiV1.use('/permissions', permissionsRoutes);

// Four-eyes. Actions one administrator requested and a different one must commit.
import { approvalRoutes } from '../modules/dual-control/routes/approval.routes';
apiV1.use('/approvals', approvalRoutes);

// The audit trail: every administrator action, who did it, to what, and how it ended.
// Read-scoped per tier inside the repository — Support sees platform activity and its own
// actions, never this service's own machinery.
import { auditRoutes } from '../modules/audit/routes/audit.routes';
apiV1.use('/audit', auditRoutes);

/**
 * The interim feed of administrative actions still performed ON jovi-mall (Phase 12).
 *
 * A SECOND router on `/audit`, which is the one place this service knowingly breaks its own
 * "one mount per prefix" rule — and it is safe here for the reason that rule exists: neither
 * router attaches a prefix-wide `router.use` guard, so nothing is re-resolved, and the paths
 * cannot collide (`/legacy` is a literal at a depth `/:auditId` does not reach).
 *
 * Separate rather than merged into `auditRoutes` because the whole module is deleted at
 * cutover, and a deletion that is one `rm -r` plus one line beats untangling a shared file.
 *
 * ⚠️ Deleted when `LEGACY_ENDPOINT_COUNT` reaches 0 — `test-authz.ts` asserts that.
 */
import { legacyAuditRoutes } from '../modules/legacy-audit/routes/legacy-audit.routes';
apiV1.use('/audit', legacyAuditRoutes);

// ── Platform domains (Phase 4) — the two access paths, one example of each ────
//
// Cash on delivery: DELEGATED to jovi-mall over `/api/internal/admin/cod`. Its writes are
// transactions paired with post-commit events, and a second implementation would get the
// money right and the notifications wrong.
import { codRoutes } from '../modules/cod/routes/cod.routes';
apiV1.use('/cod', codRoutes);

// Users: the domain where BOTH transports meet. The list, the detail and the activity
// feed read `jovi_mall` DIRECTLY — there is no service to call and a read protects no
// invariant. The three writes are DELEGATED, because a suspension is only real by virtue
// of jovi-mall's auth path refusing a non-active account, and a login identifier is only
// safe because that service owns its uniqueness index and its format rule.
//
// Which domain takes which path is recorded once, in `docs/ADR-004-DOMAIN-OWNERSHIP.md`;
// this one is written up in `docs/ADR-007-USER-MANAGEMENT.md`.
import { userRoutes } from '../modules/users/routes/user.routes';
apiV1.use('/users', userRoutes);

// Vendors: the same split as users, taken further. The directory, the detail, the vendor's
// CATALOGUE and the activity feed are direct reads. The seven writes are delegated,
// because a vendor suspension is not a status column — it takes their whole catalogue off
// sale inside one jovi-mall transaction, and reinstating them re-runs the activation gate
// on every listing rather than blindly republishing. A second writer would move the status
// and miss all of it.
//
// This is also where two capabilities that had existed in jovi-mall as dead code with zero
// callers finally acquire a caller: business verification and vendor suspension.
// Written up in `docs/ADR-008-VENDOR-MANAGEMENT.md`.
import { vendorRoutes } from '../modules/vendors/routes/vendor.routes';
apiV1.use('/vendors', vendorRoutes);

// The delivery network — agencies and delivery agents, two prefixes and one domain.
//
// It refines the read half of the split above rather than repeating it. The rule
// (ADR-009 D-1): **delegate a read whose answer is a VERDICT the platform acts on; read
// directly a read whose answer is a RECORD.** So the directories, the rosters and the
// contract histories are direct reads, while an agent's eligibility, tracking policy and
// COD allocation are delegated — those three are answers the dispatcher itself branches
// on, and a copy here would be a second definition of who may be sent a delivery.
//
// It is also where jovi-mall's agent list acquires an existence: PHASE-0 found
// `GET /api/admin/agents/:agentId` and no `GET /api/admin/agents`, so an administrator
// could not find an agent they did not already have the id of.
//
// Written up in `docs/ADR-009-DELIVERY-NETWORK.md`.
import { agencyRoutes } from '../modules/agencies/routes/agency.routes';
apiV1.use('/agencies', agencyRoutes);

/**
 * Support tickets (Phase 17) — the eleven `support.tickets.*` permissions catalogued at
 * Phase 3 finally have a surface. jovi-mall's `/api/admin/tickets` mount is deleted, so this
 * is the only administrative door onto tickets.
 */
import { supportTicketRoutes } from '../modules/support/routes/ticket.routes';
apiV1.use('/support/tickets', supportTicketRoutes);

import { agentRoutes } from '../modules/agents/routes/agent.routes';
apiV1.use('/agents', agentRoutes);

// Commerce — orders and shipments, the last large domain with no administrative surface.
//
// PHASE-0 found TWO order endpoints (a dispute queue and a manual dispute resolution) and
// NOTHING for shipments at all — no route, no controller, no api-doc page. An administrator
// holding an order number could not look it up, and an administrator asked why a delivery
// had not moved for three days could see the order and the agency and nothing in between.
//
// The split is ADR-004 D-2 again, and here it is at its sharpest. Directories, details,
// both order histories and the shipment's offer trail are direct reads — records. The six
// writes are delegated, because none of them is a status column:
//
//   - a refund calls a payment gateway, writes its ledger row BEFORE the call, and reverses
//     escrow across every actor on the order
//   - a cancellation runs six guards spanning three collections and notifies two audiences
//   - a dispatch mints shipments and starts the auto-assignment broadcast
//   - a REASSIGNMENT emits the outbox row that closes the old agent's live tracking session
//     in geo-tracker — move `agent_id` from here and the row is right while a person who is
//     no longer delivering keeps being watched
//
// One read is delegated too, and it is the exception that states the rule (ADR-008 D-1):
// `refund-eligibility` answers a VERDICT the platform acts on rather than a record, so a
// copy of that arithmetic here would be a second definition of what a customer is owed.
//
// Written up in `docs/ADR-010-ORDERS-AND-SHIPMENTS.md`.
import { orderRoutes } from '../modules/orders/routes/order.routes';
apiV1.use('/orders', orderRoutes);

import { shipmentRoutes } from '../modules/shipments/routes/shipment.routes';
apiV1.use('/shipments', shipmentRoutes);

// Billing — the subscription catalog and who is on it (Phase 11).
//
// The first of the three money mounts, and the one where the read/write split is at its
// least symmetrical. `pricing_plans` and `subscriber_plans` are RECORDS, so the catalog,
// the plan detail, its subscriber list and the cross-owner queue are direct reads. All
// four writes are delegated — and not because the inserts are hard. Creating a plan
// collides against a partial unique index jovi-mall turns into a specific code; editing
// one moves `commission_percent`, the multiplier every future order's split uses; and
// ASSIGNING one expires the current term, grants a credit allowance exactly once inside
// the same transaction that activates it, and emits `plan.activated`, which
// `AgentPlanCapacityConsumer` reads in-process to resize an agent's shipment capacity. A
// second writer would move the rows and leave every agent on that plan at their old cap.
//
// Three of the eight routes had no legacy equivalent: a plan DETAIL (the catalog was
// list-only, so its commission could only be seen by scanning a page), the list of
// subscribers ON a plan — the question asked immediately before editing that commission,
// which every read of `subscriber_plans` in jovi-mall is too owner-scoped to answer — and
// a cross-owner queue of terms about to lapse.
//
// Written up in `docs/ADR-011-ACCOUNTS-AND-FINANCE.md`.
import { billingRoutes } from '../modules/billing/routes/billing.routes';
apiV1.use('/billing', billingRoutes);

// Money — earnings, payouts and gateway settlements (Phase 11).
//
// The second money mount, and the one where the read/write line is sharpest. **The records
// are read; the balances are asked for.** An `earnings_ledgers` row is append-only and says
// what MOVED; a balance is `getBalances` reconciling four sub-balances that only jovi-mall's
// transactions move, and a second implementation of that arithmetic would be a second
// opinion about how much money exists. So the ledger, the allocations, the payout rows and
// the gateway settlements are direct reads, while `/earnings/platform`,
// `/earnings/accounts` and both writes are delegated.
//
// Eight of the fourteen routes had no legacy equivalent. `AdminEarningsController` served the
// platform singleton and nothing else; `earnings_allocations` — the unique
// `(source, beneficiary)` row every split is computed from — had NO admin surface anywhere,
// which left `hold_release_at`, `requires_cash_settlement` and `cash_settled_at` (between
// them the whole answer to "why has this money not been released") readable only in a
// database shell; and `payment_transactions` / `refund_transactions` had none either.
//
// Two properties are worth knowing before extending it:
//
//   - **The payout destination is masked by PROJECTION, not by a mapper.** The beneficiary's
//     plaintext MSISDN and bank account number are never read on this path, so the queue
//     shows a provider and an account name rather than a last-four. The digits are served by
//     `GET /money/payouts/:payoutId/destination` alone, behind its own permission and
//     written to the audit trail on every call.
//   - **`money.payouts.mark_paid` is dual-controlled at 2,000,000 XAF**, the platform's own
//     `AUTO_PAYOUT_THRESHOLD`. It answers 202 with an approval id, and the second
//     administrator's request performs the write. Rejecting is never queued — that direction
//     is reversible, and a quorum belongs on the irreversible one.
//
// Written up in `docs/ADR-011-ACCOUNTS-AND-FINANCE.md`.
import { moneyRoutes } from '../modules/money/routes/money.routes';
apiV1.use('/money', moneyRoutes);

// Accounts — what ONE party holds, is owed, and owes (Phase 11).
//
// The third money mount, and the only one whose subject is a PARTY rather than a record.
// `/billing` holds plans, `/money` holds ledgers and payouts; this holds a vendor, an agency
// or an agent, and answers the four questions the brief asks about an account: its status,
// its details, its balances, and what has moved through it.
//
// Not under `/money`, and the reason is authorization rather than taste. The account view
// carries a subscriber plan and a COD liability as well as earnings, so `/money/accounts/:id`
// gated on `money.earnings.read` would be a side door onto billing and COD data. Every route
// here is instead an `all`-mode COMPOSITION of the permissions that own its data, and **no
// `accounts` permission family is added** — a new family would need entries duplicating
// `money.earnings.read` + `billing.plans.read` + `cod.overview.read` semantically.
//
// Three things worth knowing before extending it:
//
//   - **Three unrelated balance models share one response**, and the DTO is built to make
//     mixing them impossible: no top-level `balance`/`total`/`amount`, every balance object
//     carrying `unit` + `currency` + `direction`, `null` meaning "does not apply to this
//     owner kind" against `0` meaning "applies, currently empty", and no grand total anywhere.
//   - **The activity feed is the one CURSOR-paged list in the service.** It merges five
//     collections in application code — `$unionWith` would need one repository projecting the
//     union of five schemas — so it reports no `total` and no `pages` rather than a page count
//     that drifts as you walk it (ADR-005 D-13).
//   - **The COD cash ledger is deliberately NOT in that feed.** It is a liability, not owner
//     value, and merging the two is the single most likely way somebody misreads the account.
//
// Written up in `docs/ADR-011-ACCOUNTS-AND-FINANCE.md`.
import { accountRoutes } from '../modules/accounts/routes/account.routes';
apiV1.use('/accounts', accountRoutes);

/**
 * The operations surface (Phase 12), reserved in the header above since Phase 1.
 *
 * `/system` is reads: dependency health richer than the probe's, worker state, outbox
 * depth, and the whitelisted runtime configuration. `/dev-tools` is the writes — feature
 * flags plus the three tools that re-run a side effect against live data.
 *
 * They are separate mounts rather than one, because they answer to different permission
 * families and different tiers: `system.*` reaches tier 2, `developer_tools.*` is tier 1
 * only and is refused to every other tier by a boot assertion. One mount would have made
 * that distinction invisible in the URL.
 *
 * The `developer_tools.*` permissions were catalogued at Phase 3 with no routes at all —
 * policy decided years before the surface. Phase 12 built the surface and, more to the
 * point, the audit actions: "developer tool execution" was in the brief and was
 * unrecordable until now.
 */
import { systemRoutes } from '../modules/system/routes/system.routes';
apiV1.use('/system', systemRoutes);

import { devToolsRoutes } from '../modules/dev-tools/routes/dev-tools.routes';
apiV1.use('/dev-tools', devToolsRoutes);

/**
 * The administrator inbox — the fifth notification stack.
 *
 * jovi-mall has carried four since long before this service existed (vendor, agency, agent,
 * customer); `PHASE-0:124` recorded that the administrator, alone among the five roles, had
 * none, and `PHASE-0:307` named what the missing one owed: disputes, COD discrepancies,
 * payouts, failed webhooks.
 *
 * Nothing here creates a notification. Every row is DERIVED by a background projector from
 * a row that some other part of the platform already committed — `source.registry.ts` is
 * the complete list, and a declared type with no source in it stops the service booting.
 * That is what makes "do not invent notification events" a property of the code rather than
 * a promise in a document.
 *
 * Written up in `docs/ADR-013-NOTIFICATIONS.md`.
 */
import notificationRoutes from '../modules/notifications/routes/notification.routes';
apiV1.use('/notifications', notificationRoutes);

/**
 * Files — one operation, and it exists because an id cannot become a picture on this side.
 *
 * Every DTO here ships `logoFileId` / `avatarFileId` / `bannerFileId` /
 * `deliveryProofFileId` as opaque ids, and the contract explains why (ADR-009 D-6: no
 * storage layer here, ever). What it did not provide was anywhere for the dashboard to
 * take one, since the dashboard talks to this service alone. Delegated, so
 * `STORAGE_PROVIDER` stays configured in one place.
 *
 * ⚠ It resolves; it does not enumerate. `files.orphans.read` is the listing and is not
 * mounted here.
 */
import { fileRoutes } from '../modules/files/routes/file.routes';
apiV1.use('/files', fileRoutes);

/**
 * Contracts — one agent↔agency relationship, by its own id.
 *
 * Its own prefix rather than a path under `/agents` or `/agencies`, because it belongs to
 * both and to neither: hanging it off either directory would make the url claim a primary
 * party that does not exist, and would force a caller holding only a contract id — which
 * is what a support ticket carries — to look up an agent first.
 *
 * The read needs both directories' permissions. The three writes freeze or end a
 * relationship and touch no terms; see the router.
 */
import { contractRoutes } from '../modules/agencies/routes/contract.routes';
apiV1.use('/contracts', contractRoutes);

export { apiV1 };
