import { Router } from 'express';
import { anyPermission, defineRoute, permission, records } from '../../../api/route-manifest';
import { MoneyController } from '../controllers/money.controller';
/**
 * Imported for SIDE EFFECT, and the import is load-bearing.
 *
 * `payout-dual-control.ts` calls `registerDualControlHandler` at module scope, and
 * `createApp()` runs `assertDualControlHandlersRegistered()` at boot. Without this line the
 * service refuses to start with "Dual-controlled actions with no registered handler:
 * money.payouts.mark_paid" — which is designed behaviour and far better than discovering it
 * at approval time, after a request has sat in the queue and somebody has agreed to it.
 *
 * The controller imports the same module for `markPaid`, so today this line is technically
 * redundant. It stays because the day somebody refactors the controller to stop importing
 * it, the failure would be a service that will not boot rather than an action that cannot
 * be approved — and stating the dependency here is what makes that diff readable.
 */
import '../domain/payout-dual-control';
import {
    AllocationIdParamSchema,
    ListAllocationsQuerySchema,
    ListEarningsAccountsQuerySchema,
    ListPaymentsQuerySchema,
    ListPayoutActivityQuerySchema,
    ListPayoutsQuerySchema,
    ListPlatformLedgerQuerySchema,
    ListRefundsQuerySchema,
    MarkPaidSchema,
    PayoutIdParamSchema,
    RejectPayoutSchema,
    TriagePayoutSchema,
    SendPayoutSchema,
    TransactionIdParamSchema,
} from '../validators/money.validator';

/**
 * `/api/v1/money` — earnings, payouts and gateway settlements.
 *
 * Fourteen routes; eight of them had no legacy equivalent. The transport split follows
 * ADR-009 D-1 applied to money: **read the record, delegate the balance and every write.**
 *
 *   delegated   `GET /earnings/platform` and `GET /earnings/accounts` — balances are
 *               `getBalances` reconciling four sub-balances only jovi-mall's transactions
 *               move. Plus both WRITES, without exception.
 *   direct      the RECORDS — the ledger, the allocations, the payout rows, the payment and
 *               refund settlements.
 *
 * ── Route order ──────────────────────────────────────────────────────────────
 * Every literal under `/earnings` sits at the same depth as the other literals and never
 * beside a `:param`: `platform`, `accounts` and `allocations` are siblings, and the only
 * parameter on the mount's second level is `/earnings/allocations/:allocationId`, one level
 * below. Keep it that way — a literal `/earnings/summary` added later is safe, but a
 * `/earnings/:ownerType` would swallow all three and Express would not warn.
 *
 * `/payouts/:payoutId/activity` cannot be shadowed by `/payouts/:payoutId` — they differ in
 * depth — and neither can `/payouts/:payoutId/destination` beside it.
 */
const router = Router();
const mountedAt = '/money';

// ── Earnings ─────────────────────────────────────────────────────────────────

/**
 * The platform's own commission account. DELEGATED: a balance is a verdict.
 *
 * `money.earnings.read` is unflagged, so `allInFamily('money')` sweeps it into the tiers
 * that hold the family. That is right — reading what the marketplace has earned is not the
 * kind of money permission the `financial` flag exists to fence off, and the flag's own
 * docstring says so in as many words.
 */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/earnings/platform',
    access: permission('money.earnings.read'),
    handler: MoneyController.platformEarnings,
});

/** Its ledger. A DIRECT read of the same account the route above delegates. */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/earnings/platform/ledger',
    access: permission('money.earnings.read'),
    validate: { query: ListPlatformLedgerQuerySchema },
    handler: MoneyController.platformLedger,
});

/**
 * Every owner's balances, ranked (D-7). DELEGATED, for the reason `/earnings/platform` is.
 *
 * Declared above `/earnings/allocations` for readability only; the two differ in their
 * second segment, so neither shadows the other.
 */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/earnings/accounts',
    access: permission('money.earnings.read'),
    validate: { query: ListEarningsAccountsQuerySchema },
    handler: MoneyController.earningsAccounts,
});

/**
 * Net-new — `earnings_allocations` had no admin surface anywhere.
 *
 * The only place `requires_cash_settlement`, `cash_settled_at` and `hold_release_at` are
 * visible, which between them are the whole answer to *why has this money not been released*.
 */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/earnings/allocations',
    access: permission('money.earnings.read'),
    validate: { query: ListAllocationsQuerySchema },
    handler: MoneyController.listAllocations,
});

/** Net-new detail: the movements this allocation caused, and its siblings on the same sale. */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/earnings/allocations/:allocationId',
    access: permission('money.earnings.read'),
    validate: { params: AllocationIdParamSchema },
    handler: MoneyController.getAllocation,
});

// ── Payouts: where money leaves the platform ─────────────────────────────────

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/payouts',
    access: permission('money.payouts.read'),
    validate: { query: ListPayoutsQuerySchema },
    handler: MoneyController.listPayouts,
});

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/payouts/:payoutId',
    access: permission('money.payouts.read'),
    validate: { params: PayoutIdParamSchema },
    handler: MoneyController.getPayout,
});

/**
 * The digits — the one route on this service that emits a beneficiary's account number.
 *
 * Its own permission, and `money.payouts.destination.read` is the only `financial` READ in
 * the catalog. The flag is doing real work rather than describing a money movement: it keeps
 * the name out of `allInFamily('money')` and refuses it to Support at boot, which is why
 * tier-grants names it by hand.
 *
 * **Audited on every call**, and that is a deliberate exception to "reads are not actions" —
 * argued at length in `domain/payout-disclosure.ts` and in the audit catalog entry. The row
 * commits BEFORE the read, so with the audit store down nothing is disclosed.
 *
 * Cannot be shadowed by `/payouts/:payoutId`: they differ in depth. It sits beside
 * `/activity`, which is where its own audit rows come back out.
 */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/payouts/:payoutId/destination',
    access: permission('money.payouts.destination.read'),
    validate: { params: PayoutIdParamSchema },
    audit: records('money.payouts.destination.read'),
    handler: MoneyController.revealDestination,
});

/**
 * Needs BOTH permissions, in `all` mode.
 *
 * `audit.read` as well as `money.payouts.read`, for the reason `/users/:id/activity`
 * documents: these rows ARE audit rows and the repository applies the audit read scope to
 * them, so requiring only the payout permission would make this a second door onto the
 * trail. Same shape as `/agents/:agentId/activity`.
 *
 * It matters more here than on the agent feed, because this is where every destination
 * disclosure appears — the row whose whole purpose is that somebody can read back who saw a
 * beneficiary's account number.
 */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/payouts/:payoutId/activity',
    access: permission('money.payouts.read', 'audit.read'),
    validate: { params: PayoutIdParamSchema, query: ListPayoutActivityQuerySchema },
    handler: MoneyController.payoutActivity,
});

/**
 * Record that money has left the platform — the one DUAL-CONTROLLED action outside the
 * administrator directory.
 *
 * At or above 2,000,000 XAF (`EARNINGS_CONFIG.AUTO_PAYOUT_THRESHOLD`) this answers **202**
 * with an approval id and performs nothing; a second administrator's approval is what
 * commits it. Below it, 200 and the write happens now.
 *
 * The threshold reads the amount off the ROW, never the body — see
 * `domain/payout-dual-control.ts`, and note `MarkPaidSchema` is `.strict()` so an `amount`
 * key is a 400 rather than a silently ignored field.
 */
defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/payouts/:payoutId/mark-paid',
    access: permission('money.payouts.mark_paid'),
    validate: { params: PayoutIdParamSchema, body: MarkPaidSchema },
    audit: records('money.payouts.mark_paid'),
    handler: MoneyController.markPaid,
});

/**
 * A reviewer endorses the request as genuine.
 *
 * The one route in this module a Support administrator can reach, and the permission is the
 * only `financial` one their tier holds — see `TIER_3_FINANCIAL_ALLOWLIST` in tier-grants
 * for why that exception exists and what bounds it.
 *
 * Not dual-controlled at any amount: nothing moves, so there is nothing for a quorum to
 * protect. A triage REJECTION is not here — it is `/reject` below, the same terminal write a
 * tier-1/2 administrator performs, because one outcome deserves one code path.
 */
defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/payouts/:payoutId/triage',
    access: permission('money.payouts.triage'),
    validate: { params: PayoutIdParamSchema, body: TriagePayoutSchema },
    audit: records('money.payouts.triage'),
    handler: MoneyController.triagePayout,
});

/**
 * Send the money through the payment gateway — the automated half of marking a payout paid.
 *
 * ⚠ **`money.payouts.mark_paid`, not a permission of its own**, and the reuse is deliberate:
 * `LARGE_PAYOUT` already hangs off that name, so a gateway send inherits the 2,000,000 XAF
 * four-eyes rule with no second threshold to drift from the first. Giving this its own
 * permission would have created one silently.
 *
 * Answers **202** above the threshold, exactly as `/mark-paid` does. Below it, **200** with
 * the payout usually in `processing` rather than `paid` — the gateway confirms by callback.
 */
defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/payouts/:payoutId/send',
    access: permission('money.payouts.mark_paid'),
    validate: { params: PayoutIdParamSchema, body: SendPayoutSchema },
    audit: records('money.payouts.mark_paid'),
    handler: MoneyController.sendPayout,
});

/**
 * Reject it — the funds return to the owner's available balance.
 *
 * Not dual-controlled at any amount. The asymmetry with mark-paid is the design: this
 * direction is reversible by the owner simply requesting again, and nothing leaves the
 * platform. A quorum belongs on the irreversible direction only.
 */
/**
 * ⚠ **`anyPermission`, and this is the route that makes `money.payouts.triage` financial.**
 *
 * A reviewer's rejection is TERMINAL — the same write an approver makes, closing the request and
 * releasing the hold back to the owner's available balance. It is not a recommendation, and there
 * is deliberately no second "reject" verdict on `/triage`: one outcome, one code path, one set of
 * fields. Two routes writing the same terminal state is how a record ends up closed two different
 * ways.
 *
 * So Support reaches this route with `money.payouts.triage` and an approver reaches it with
 * `money.payouts.reject`, and both perform exactly the same thing. That release is a money
 * movement, which is why `money.payouts.triage` carries `financial: true` honestly and why the
 * grant table takes a named exemption for it (`TIER_3_FINANCIAL_ALLOWLIST`). Without this route
 * accepting it, that flag and that exemption would be describing a capability the permission did
 * not actually have.
 *
 * ⛔ Note what this does NOT open. Rejecting is the reversible direction — nothing leaves the
 * platform and the owner can simply request again — which is the same asymmetry that keeps this
 * route out of dual control at any amount. Sending remains `money.payouts.mark_paid`, which
 * Support does not hold and cannot reach from here.
 */
defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/payouts/:payoutId/reject',
    access: anyPermission('money.payouts.reject', 'money.payouts.triage'),
    validate: { params: PayoutIdParamSchema, body: RejectPayoutSchema },
    audit: records('money.payouts.reject'),
    handler: MoneyController.rejectPayout,
});

// ── Gateway settlements ──────────────────────────────────────────────────────

/**
 * `money.payments.read` — a permission of its own (D-5) rather than a
 * `money.earnings.read` + `orders.read` composition neither summary describes.
 *
 * Unflagged on purpose: a settlement row carries an amount, a status and a gateway
 * reference, and it is the record Support needs to answer "did my payment go through". The
 * fields that would make it sharp — the raw gateway payload, the payload hash, the
 * idempotency key — are excluded by projection, not by permission.
 */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/payments',
    access: permission('money.payments.read'),
    validate: { query: ListPaymentsQuerySchema },
    handler: MoneyController.listPayments,
});

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/payments/:transactionId',
    access: permission('money.payments.read'),
    validate: { params: TransactionIdParamSchema },
    handler: MoneyController.getPayment,
});

/**
 * Refunds, under the same permission as payments and deliberately not under `orders.refund`.
 *
 * `orders.refund` is the verb that CREATES one, and it lives on `/orders/:orderId/refund`
 * because a refund calls a gateway and reverses escrow across every actor on the order.
 * This is the record afterwards. Gating a read on the write's permission would mean nobody
 * could check a refund without being able to issue one.
 */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/refunds',
    access: permission('money.payments.read'),
    validate: { query: ListRefundsQuerySchema },
    handler: MoneyController.listRefunds,
});

export const moneyRoutes = router;
