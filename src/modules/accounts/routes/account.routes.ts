import { Router } from 'express';
import { defineRoute, permission, records } from '../../../api/route-manifest';
import { StatementController } from '../../statements/controllers/statement.controller';
import { CreateStatementBodySchema } from '../../statements/validators/statement.validator';
import { AccountController } from '../controllers/account.controller';
import {
    AccountOwnerParamsSchema,
    CashLedgerOwnerParamsSchema,
    ListAccountPayoutsQuerySchema,
    ListActivityQuerySchema,
    ListCashLedgerQuerySchema,
    ListCreditsQuerySchema,
} from '../validators/account.validator';

/**
 * `/api/v1/accounts` — what one party holds, is owed, and owes.
 *
 * Five routes, all net-new: nothing on the legacy admin surface could answer *what does this
 * account hold, what is it owed, what does it owe, and what has moved through it* for a
 * single vendor, agency or agent. `AdminEarningsController` served the platform singleton
 * and nothing else.
 *
 * ── Every route is an `all`-mode COMPOSITION, and no new permission family exists ─
 * This is the whole authorization design of the mount. The account view carries earnings
 * balances, a subscriber plan and a COD liability, so it requires the permission that owns
 * each of those — `money.earnings.read` AND `billing.plans.read` AND `cod.overview.read`.
 * Gating it on one `accounts.read` would be a side door onto all three, which is exactly
 * what `permission('shipments.read', 'agents.read')` on the shipment detail exists to
 * prevent.
 *
 * The sub-routes then narrow to the single family whose data they carry: payouts need
 * `money.payouts.read` and nothing else, the cash ledger needs `cod.overview.read` and
 * nothing else. An administrator who may see a payout queue but not a COD position gets
 * exactly that, on the same account.
 *
 * ── Route order ──────────────────────────────────────────────────────────────
 * `/:ownerType/:ownerId` is the only two-segment path here and everything else sits one
 * level below it, so no literal is at risk of being swallowed by a parameter. **Do not add a
 * literal first segment** — `/accounts/summary` would be captured by `:ownerType` and
 * rejected by its enum as a 400, not routed. If one is ever needed it belongs above these
 * declarations, and the enum on `:ownerType` is what makes that failure loud rather than
 * silent.
 */
const router = Router();
const mountedAt = '/accounts';

/**
 * The account itself — three balance models, the subscription, the COD exposure and the
 * flags, in one response.
 *
 * The heaviest read on the service: two delegated verdicts and eleven direct reads, fanned
 * out in parallel. It is one endpoint rather than four because the answer is a comparison —
 * an agent owing 400,000 in cash while owed 380,000 in earnings is a fact about the pair,
 * and a dashboard assembling it from four calls would render the halves at different
 * moments.
 */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/:ownerType/:ownerId',
    access: permission('money.earnings.read', 'billing.plans.read', 'cod.overview.read'),
    validate: { params: AccountOwnerParamsSchema },
    handler: AccountController.getAccount,
});

/**
 * The merged movement feed — **the one cursor-paged list in this service.**
 *
 * `money.earnings.read` + `billing.plans.read`, and NOT `cod.overview.read`: the feed
 * carries plan purchases, credit movements, earnings and payouts, and deliberately no cash
 * movements. Those are a liability rather than owner value and live at `/cash-ledger` behind
 * their own permission — merging them would put an asset and a liability in one running
 * order, which is the single most likely way somebody misreads this account.
 *
 * No `total` and no `pages`; see `cursorMeta` and ADR-005 D-13.
 */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/:ownerType/:ownerId/activity',
    access: permission('money.earnings.read', 'billing.plans.read'),
    validate: { params: AccountOwnerParamsSchema, query: ListActivityQuerySchema },
    handler: AccountController.getActivity,
});

/**
 * This owner's payout history — the same rows, projection and masking as `/money/payouts`,
 * scoped to one party.
 *
 * `money.payouts.read` alone. Reading where an owner's money went is a payout question, and
 * requiring the account view's full composition here would mean an administrator who may
 * work the payout queue could not open the account it belongs to.
 */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/:ownerType/:ownerId/payouts',
    access: permission('money.payouts.read'),
    validate: { params: AccountOwnerParamsSchema, query: ListAccountPayoutsQuerySchema },
    handler: AccountController.getPayouts,
});

/**
 * The credit ledger, with the wallet balance in `meta`.
 *
 * `billing.plans.read`: credits are a billing artefact — granted by a plan allowance, bought
 * as a pack, spent on metered actions — and they are not money. Nothing here needs a
 * `money.*` permission and requiring one would say they were.
 */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/:ownerType/:ownerId/credits',
    access: permission('billing.plans.read'),
    validate: { params: AccountOwnerParamsSchema, query: ListCreditsQuerySchema },
    handler: AccountController.getCredits,
});

/**
 * The COD liability's movements — **a different unit of meaning from `/activity`**, which is
 * why it is a different endpoint rather than a filter on that one.
 *
 * `cod.overview.read`, and a narrower params schema: only `agent` and `agency` reach the
 * handler, so a vendor is a 400 that says why instead of an empty page that reads as "no
 * movements".
 */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/:ownerType/:ownerId/cash-ledger',
    access: permission('cod.overview.read'),
    validate: { params: CashLedgerOwnerParamsSchema, query: ListCashLedgerQuerySchema },
    handler: AccountController.getCashLedger,
});

/**
 * An account STATEMENT — every order, fee, COD settlement, payout, credit and plan movement in
 * a period, as xlsx or pdf, downloaded or emailed to the account holder.
 *
 * `money.statements.send` alone, held by every tier (owner decision 2026-09-27). The
 * composition rule above does not apply, and on purpose: a statement is its own disclosure
 * with its own audit row, not a view assembled from the three families. It is a POST because
 * it records (and may send mail), not because it writes platform state.
 *
 * Computed HERE from `jovi_mall` directly; jovi-mall only relays the mail and chooses the
 * recipient. See `modules/statements/` and
 * `PRODUCTION-READINESS/ACCOUNT-STATEMENTS-AND-ANALYTICS-PLAN.md`.
 */
defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/:ownerType/:ownerId/statements',
    access: permission('money.statements.send'),
    validate: { params: AccountOwnerParamsSchema, body: CreateStatementBodySchema },
    audit: records('money.statements.send_vendor', 'money.statements.send_agency', 'money.statements.send_agent'),
    handler: StatementController.create,
});

export const accountRoutes = router;
