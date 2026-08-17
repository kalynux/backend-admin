import { Request, Response } from 'express';
import { ObjectId } from 'mongodb';
import { asyncHandler } from '../../../core/http/async-handler';
import { createAppError } from '../../../core/errors/app-error';
import { ERROR_CODES } from '../../../core/errors/error-codes';
import { toPageMeta } from '../../../core/http/list-query';
import { sendPaginated, sendSuccess } from '../../../core/http/responses';
import { requireAdminIdentity } from '../../admin-identity/domain/admin-identity.types';
import { actorContextOf } from '../../audit/domain/audit-context';
import { toAuditEntryDto } from '../../audit/domain/audit.dto';
import { AuditRepository } from '../../audit/repositories/audit.repository';
import { ListAuditQuery } from '../../audit/validators/audit.validator';
import { AgencyReadRepository } from '../../agencies/repositories/agency.read.repository';
import { AgentReadRepository } from '../../agents/repositories/agent.read.repository';
import { StoreReadRepository } from '../../vendors/repositories/store.read.repository';
import * as disclosure from '../domain/payout-disclosure';
import * as payoutWrites from '../domain/payout-dual-control';
import * as gateway from '../gateways/money.gateway';
import {
    EarningsAllocationReadModel,
    EarningsAllocationReadRepository,
    EarningsLedgerReadRepository,
} from '../repositories/earnings.read.repository';
import {
    PaymentTransactionReadRepository,
    RefundTransactionReadRepository,
} from '../repositories/payment-transaction.read.repository';
import { PayoutRequestReadModel, PayoutRequestReadRepository } from '../repositories/payout-request.read.repository';
import {
    MoneyOwnerNames,
    ownerKey,
    toAllocationDetailDto,
    toAllocationDto,
    toEarningsAccountDto,
    toLedgerEntryDto,
    toPaymentDetailDto,
    toPaymentDto,
    toPayoutListItemDto,
    toRefundDto,
} from '../read-models/money.dto';
import {
    ListAllocationsQuery,
    ListEarningsAccountsQuery,
    ListPaymentsQuery,
    ListPayoutActivityQuery,
    ListPayoutsQuery,
    ListPlatformLedgerQuery,
    ListRefundsQuery,
    MarkPaidBody,
    RejectPayoutBody,
} from '../validators/money.validator';

/**
 * `/api/v1/money` — earnings, payouts and gateway settlements.
 *
 * ── The split, in one sentence ────────────────────────────────────────────────
 * **The records are read here; the balances are asked for.** An `earnings_ledgers` row is
 * append-only and says what MOVED; an allocation is one row behind a unique index and says
 * what somebody is OWED; a payout row and a settlement row are the same kind of thing. All
 * of those are direct reads. A BALANCE is `getBalances` reconciling four sub-balances that
 * only jovi-mall's transactions move — a second implementation of that arithmetic would be
 * a second opinion about how much money exists — so `/earnings/platform` and
 * `/earnings/accounts` are delegated, as are both writes. ADR-009 D-1, applied to money.
 *
 * ── Eight of these fourteen had no legacy equivalent ──────────────────────────
 * `AdminEarningsController` served the platform singleton and nothing else.
 * `earnings_allocations` — the unique `(source, beneficiary)` row every split is computed
 * from — had **no admin surface anywhere**, which meant the three fields that answer *why
 * has this money not been released* (`hold_release_at`, `requires_cash_settlement`,
 * `cash_settled_at`) were readable only in a database shell. `payment_transactions` and
 * `refund_transactions` had none either, so "did this payment go through" was answered by
 * inferring it from the order's derived `payment_status`.
 *
 * ── What this surface deliberately does NOT offer ─────────────────────────────
 *  - **Any per-owner balance route.** `/money/earnings/accounts` is the cross-owner table
 *    and the singleton has its own path; one owner's balances are read *in context*, on the
 *    account view at step 7, beside the plan and the COD liability that give them meaning.
 *  - **A write on an allocation or a ledger row.** Both are append-only by design; the
 *    release worker and the split services are their only authors, and a hand-edited
 *    allocation would silently change what a beneficiary is paid with no record of why.
 *  - **A refund.** `orders.refund` owns that (`/orders/:orderId/refund`), because a refund
 *    calls a gateway and reverses escrow across every actor on the order. This mount READS
 *    the resulting rows; it does not create them.
 */

const ledger = new EarningsLedgerReadRepository();
const allocations = new EarningsAllocationReadRepository();
const payouts = new PayoutRequestReadRepository();
const payments = new PaymentTransactionReadRepository();
const refunds = new RefundTransactionReadRepository();
const auditEntries = new AuditRepository();

// The owner directories, for the display names a money row cannot carry. Owned by the
// modules that own those collections — `delivery_agents` holds `legal_identity` and
// `payout_details`, so a second projection of it declared here would be a second thing to
// get right. Same rule `hydrateNames` follows in the COD and billing controllers.
const stores = new StoreReadRepository();
const agencies = new AgencyReadRepository();
const agents = new AgentReadRepository();

/**
 * The platform singleton's owner terms.
 *
 * `owner_id` is genuinely `null` on those rows — that is what "the marketplace's own
 * commission account" looks like in this schema — so the ledger filter is given `null`
 * explicitly rather than having the term omitted. Omitting it would return every owner's
 * ledger under the platform's heading.
 */
const PLATFORM_OWNER_TYPE = 'platform';

interface OwnerRow {
    ownerType: string;
    ownerId: string | null;
}

/**
 * Display names for a page of money rows — one batched read per owner type present, never
 * one per row.
 *
 * The name is the BUSINESS one wherever there is one: a vendor's Store, an agency's
 * Magazin. That is what the owner is called on every other screen. An agent has no business
 * identity, so their own name is the answer.
 *
 * **`platform` resolves to `null`, and that is the answer rather than a gap.** The
 * marketplace's own account has no directory row in either database, and inventing a
 * display string here would put a label in the data layer that a dashboard is better placed
 * to choose. `owner.type === 'platform'` with `id: null` is unambiguous on the wire.
 */
async function hydrateOwnerNames(rows: OwnerRow[]): Promise<MoneyOwnerNames> {
    const idsFor = (type: string): ObjectId[] =>
        [
            ...new Set(
                rows
                    .filter((row) => row.ownerType === type && row.ownerId)
                    .map((row) => row.ownerId as string),
            ),
        ].map((id) => new ObjectId(id));

    const vendorIds = idsFor('vendor');
    const agencyIds = idsFor('agency');
    const agentIds = idsFor('agent');

    const [vendorStores, agencyNames, agentNames] = await Promise.all([
        stores.findForVendors(vendorIds),
        agencies.findNamesByIds(agencyIds),
        agents.findNamesByIds(agentIds),
    ]);

    const names: MoneyOwnerNames = new Map();
    vendorStores.forEach((store, vendorId) => {
        names.set(ownerKey('vendor', vendorId), store.name ?? null);
    });
    agencyNames.forEach((name, agencyId) => names.set(ownerKey('agency', agencyId), name));
    agentNames.forEach((name, agentId) => names.set(ownerKey('agent', agentId), name));

    return names;
}

/** A payout page's owner rows, in the shape `hydrateOwnerNames` reads. */
function payoutOwners(rows: PayoutRequestReadModel[]): OwnerRow[] {
    return rows.map((row) => ({ ownerType: row.owner_type, ownerId: row.owner_id.toString() }));
}

/** An allocation page's beneficiary rows. `platform` allocations carry a null id. */
function allocationOwners(rows: EarningsAllocationReadModel[]): OwnerRow[] {
    return rows.map((row) => ({
        ownerType: row.beneficiary_type,
        ownerId: row.beneficiary_id ? row.beneficiary_id.toString() : null,
    }));
}

/**
 * jovi-mall's page shape and this service's are the same fields in a different envelope, so
 * a DELEGATED list is re-wrapped rather than re-counted.
 *
 * `extra` carries list-level summary fields that are not scalars — `PaginationMeta`'s index
 * signature is scalar-only, and `totals` is an array of objects. Hence `sendSuccess` with an
 * explicit meta rather than `sendPaginated`: widening `PaginationMeta` for one caller would
 * loosen the type every list on the service is checked against.
 */
function sendPlatformPage(
    res: Response,
    page: gateway.PlatformPage<unknown>,
    data?: unknown[],
    extra?: Record<string, unknown>,
): void {
    sendSuccess(res, data ?? page.data, {
        meta: {
            total: page.meta.total,
            page: page.meta.page,
            limit: page.meta.limit,
            pages: page.meta.pages,
            ...(extra ?? {}),
        },
    });
}

export class MoneyController {
    // ── Earnings ─────────────────────────────────────────────────────────────

    /**
     * GET /api/v1/money/earnings/platform — the marketplace's own commission account.
     *
     * DELEGATED. Four sub-balances that only jovi-mall's transactions move, reconciled by
     * `getBalances`. The ledger below is the record; this is the verdict.
     */
    static platformEarnings = asyncHandler(async (req: Request, res: Response) => {
        sendSuccess(res, await gateway.platformEarnings(actorContextOf(req)));
    });

    /**
     * GET /api/v1/money/earnings/platform/ledger — every movement on that account.
     *
     * A DIRECT read, unlike the balance a line above, and the pair is the clearest example
     * of the split this module makes. Each row carries `pending_after`/`available_after`,
     * so the feed is auditable rather than merely readable: a reader can check that the
     * movements add up to the balance the endpoint above reports.
     */
    static platformLedger = asyncHandler(async (req: Request, res: Response) => {
        const query = req.query as unknown as ListPlatformLedgerQuery;

        const page = await ledger.listForOwner(PLATFORM_OWNER_TYPE, null, {
            entryType: query.entryType,
            reasonCode: query.reasonCode,
            sourceType: query.sourceType,
            from: query.from,
            to: query.to,
            page: query.page,
            limit: query.limit,
            sort: query.sort,
        });

        // No name lookup: every row on this feed belongs to the platform, which has none.
        const names: MoneyOwnerNames = new Map();

        sendPaginated(
            res,
            page.items.map((row) => toLedgerEntryDto(row, names)),
            toPageMeta(page.total, page.page, page.limit),
        );
    });

    /**
     * GET /api/v1/money/earnings/accounts — every owner's balances, ranked (D-7).
     *
     * DELEGATED, and it is the decision most worth reading twice on this mount. Paging
     * `earnings_accounts` directly is one query and the fields are right there — and it
     * would show balances without the reconciliation `getBalances` performs. jovi-mall
     * gained `EarningsAccountRepository.listForAdmin` at step 1 for exactly this, because
     * it could previously find ONE account or every account over the auto-payout threshold
     * and nothing in between.
     */
    static earningsAccounts = asyncHandler(async (req: Request, res: Response) => {
        const query = req.query as unknown as ListEarningsAccountsQuery;
        const page = await gateway.earningsAccounts(query, actorContextOf(req));

        /**
         * Hydrated HERE rather than by jovi-mall, because that is what this controller
         * already does four lines away for payouts and allocations — one batched read per
         * owner type present, never one per row. The directory has been showing ObjectIds
         * for want of this single call.
         *
         * It has to be server-side: twenty rows spanning three directories is twenty
         * client requests, each behind a permission a `money.earnings.read` holder need
         * not hold, which would turn this list into a side door onto `/vendors`,
         * `/agencies` and `/agents` — exactly what the accounts mount's composed
         * authorization exists to prevent.
         */
        const names = await hydrateOwnerNames(page.data);

        sendPlatformPage(
            res,
            page,
            page.data.map((row) => toEarningsAccountDto(row, names)),
            // Across the whole FILTERED result set, one entry per currency — the one
            // number on this screen a client cannot compute, because it cannot see past
            // the page it was handed.
            { totals: page.totals },
        );
    });

    /**
     * GET /api/v1/money/earnings/allocations — net-new, and the gap it fills is large.
     *
     * `earnings_allocations` is the source of truth for one beneficiary's share of one sale
     * and had no admin surface anywhere. This is the only place `requires_cash_settlement`,
     * `cash_settled_at` and `hold_release_at` are visible — which together are the entire
     * answer to *why has this beneficiary not been paid*.
     *
     * `?unsettledOnly=true` is the sharp end: cash is required and has not arrived, which is
     * what a stuck remittance looks like from the earnings side.
     */
    static listAllocations = asyncHandler(async (req: Request, res: Response) => {
        const query = req.query as unknown as ListAllocationsQuery;

        const page = await allocations.search({
            beneficiaryType: query.beneficiaryType,
            beneficiaryId: query.beneficiaryId,
            status: query.status,
            sourceType: query.sourceType,
            sourceId: query.sourceId,
            requiresCashSettlement: query.requiresCashSettlement,
            unsettledOnly: query.unsettledOnly,
            from: query.from,
            to: query.to,
            page: query.page,
            limit: query.limit,
            sort: query.sort,
        });

        const names = await hydrateOwnerNames(allocationOwners(page.items));

        sendPaginated(
            res,
            page.items.map((row) => toAllocationDto(row, names)),
            toPageMeta(page.total, page.page, page.limit),
        );
    });

    /**
     * GET /api/v1/money/earnings/allocations/:allocationId — net-new detail.
     *
     * Two things the row cannot state. The **movements** it caused, each carrying the
     * balances they produced — a `held` allocation with no ledger rows means money was
     * allocated and never entered anybody's balance, which is a real and alarming state
     * nothing else would surface. And its **siblings**: every allocation cut from the same
     * sale, which is the only view in which the split can be checked against the gross.
     */
    static getAllocation = asyncHandler(async (req: Request, res: Response) => {
        const row = await loadAllocationOr404(req.params.allocationId);

        const [movements, siblings] = await Promise.all([
            ledger.findForAllocation(req.params.allocationId),
            allocations.findForSource(row.source_type, row.source_id),
        ]);

        // The siblings name other beneficiaries, so all of them feed the lookup rather than
        // only the allocation asked for.
        const names = await hydrateOwnerNames(allocationOwners([row, ...siblings]));

        sendSuccess(res, toAllocationDetailDto(row, names, { movements, siblings }));
    });

    // ── Payouts ──────────────────────────────────────────────────────────────

    /**
     * GET /api/v1/money/payouts — the queue where money leaves the platform.
     *
     * The destination on every row is masked **by the projection**, not by the mapper: the
     * beneficiary's plaintext MSISDN and bank account number are never read. So the queue
     * shows the provider and the account name — "MTN · Jean Dupont" — and not the last four
     * digits that jovi-mall's own admin queue renders. That is a deliberate tightening; the
     * digits live behind `GET /money/payouts/:payoutId/destination`, which is gated on its
     * own permission and audited on every call.
     */
    static listPayouts = asyncHandler(async (req: Request, res: Response) => {
        const query = req.query as unknown as ListPayoutsQuery;

        const page = await payouts.search({
            status: query.status,
            ownerType: query.ownerType,
            ownerId: query.ownerId,
            origin: query.origin,
            from: query.from,
            to: query.to,
            page: query.page,
            limit: query.limit,
            sort: query.sort,
        });

        const names = await hydrateOwnerNames(payoutOwners(page.items));

        sendPaginated(
            res,
            page.items.map((row) => toPayoutListItemDto(row, names)),
            toPageMeta(page.total, page.page, page.limit),
        );
    });

    /** GET /api/v1/money/payouts/:payoutId — the same shape, one row, same masking. */
    static getPayout = asyncHandler(async (req: Request, res: Response) => {
        const row = await payoutWrites.loadPayoutOr404(req.params.payoutId);
        const names = await hydrateOwnerNames(payoutOwners([row]));

        sendSuccess(res, toPayoutListItemDto(row, names));
    });

    /**
     * GET /api/v1/money/payouts/:payoutId/destination — the digits, once, on the record.
     *
     * The only endpoint in this service that emits a beneficiary's account number, and the
     * only READ in it that writes an audit row. Both facts have one cause: this output is
     * the material a fraudulent payout instruction is built from, so the interesting
     * question is not who may read it but who did, and how often.
     *
     * Thin here on purpose — the ordering that makes it safe (commit the intent, THEN read
     * the routing values, and disclose nothing if the audit store is down) is a rule, not a
     * sequence of calls a controller should be free to rearrange. It lives in
     * `domain/payout-disclosure.ts`.
     *
     * Answers the same `PayoutDestinationDto` the payout detail carries, with `revealed:
     * true` and `full` populated, so a client renders a destination through one code path
     * whichever endpoint it came from and never infers disclosure from a shape.
     */
    static revealDestination = asyncHandler(async (req: Request, res: Response) => {
        sendSuccess(res, await disclosure.revealDestination(req.params.payoutId, actorContextOf(req)));
    });

    /**
     * GET /api/v1/money/payouts/:payoutId/activity — what administrators did to this payout.
     *
     * The audit trail filtered to this row: who marked it paid or rejected it, and every
     * time somebody revealed its destination. That last is the reason this endpoint is worth
     * having rather than leaving people to filter `/audit` by hand.
     *
     * Not the payout's own history: `status` moves exactly once and the row records the
     * whole of it. This is the administrative record beside it.
     *
     * A request still WAITING for a second administrator does not appear here — the queued
     * row targets the approval request rather than the payout. `GET /approvals?targetId=`
     * is where a pending mark-paid is found; see `payout-dual-control.ts`.
     */
    static payoutActivity = asyncHandler(async (req: Request, res: Response) => {
        const identity = requireAdminIdentity(req);
        const query = req.query as unknown as ListPayoutActivityQuery;

        // 404 first: an activity feed for a payout that does not exist should say so, not
        // answer an empty page that reads as "nothing ever happened to it".
        await payoutWrites.loadPayoutOr404(req.params.payoutId);

        const page = await auditEntries.search(
            {
                page: query.page,
                limit: query.limit,
                sort: query.sort,
                action: query.action,
                status: query.status,
                from: query.from,
                to: query.to,
                targetType: 'payout',
                targetId: req.params.payoutId,
            } as ListAuditQuery,
            identity,
        );

        sendPaginated(res, page.items.map(toAuditEntryDto), page.meta);
    });

    /**
     * POST /api/v1/money/payouts/:payoutId/mark-paid — record that money has left.
     *
     * **200 when it happened, 202 when it was queued.** At or above 2,000,000 XAF — the
     * platform's own `AUTO_PAYOUT_THRESHOLD` — this needs a second administrator, and the
     * approver's request is what performs the write. 202 rather than 403: the action was
     * accepted and is waiting, and answering 403 would report a permitted action as a
     * refused one.
     *
     * Every rule behind that lives in `domain/payout-dual-control.ts`, including the one
     * that decides the amount — which is read off the ROW, never taken from the body.
     */
    static markPaid = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as MarkPaidBody;
        const identity = requireAdminIdentity(req);

        const outcome = await payoutWrites.markPaid(
            identity,
            req.params.payoutId,
            body.reference ?? null,
            actorContextOf(req),
        );

        if (outcome.kind === 'applied') {
            sendSuccess(res, outcome.payout, { message: 'Payout marked paid' });
            return;
        }

        sendSuccess(res, outcome.approval, {
            status: 202,
            message: outcome.created
                ? 'This payout is above the four-eyes threshold — submitted for a second administrator’s approval'
                : 'An identical request is already awaiting approval',
        });
    });

    /**
     * POST /api/v1/money/payouts/:payoutId/reject — the money goes back.
     *
     * Never queued, at any amount, and the asymmetry with mark-paid is the design: rejecting
     * returns the funds to the owner's available balance and the owner can simply request
     * again, so the mistake it can make is reversible. Marking paid asserts money is gone,
     * which nothing on either side can undo. See the gateway.
     */
    static rejectPayout = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as RejectPayoutBody;
        const before = await payoutWrites.loadPayoutOr404(req.params.payoutId);

        const result = await gateway.rejectPayout(
            req.params.payoutId,
            body.reason,
            payoutWrites.auditContextOfPayout(before),
            actorContextOf(req),
        );

        sendSuccess(res, result, {
            message: 'Payout request rejected — the funds returned to the owner’s available balance',
        });
    });

    // ── Gateway settlements ──────────────────────────────────────────────────

    /**
     * GET /api/v1/money/payments — net-new: what customers actually paid.
     *
     * `money.payments.read` rather than a `money.earnings.read` + `orders.read` composition:
     * a settlement is neither an earnings record nor an order, and gating it on a pair
     * neither summary describes would make the policy unreadable (D-5). Unflagged, so
     * Support holds it — "did my payment go through" is the question this list answers.
     *
     * The three fields that would make it sharp are excluded by PROJECTION, not by
     * permission: the raw gateway payload, the payload hash and the idempotency key. See
     * the repository.
     */
    static listPayments = asyncHandler(async (req: Request, res: Response) => {
        const query = req.query as unknown as ListPaymentsQuery;

        const page = await payments.search({
            status: query.status,
            gateway: query.gateway,
            method: query.method,
            purpose: query.purpose,
            orderId: query.orderId,
            bookingId: query.bookingId,
            userId: query.userId,
            from: query.from,
            to: query.to,
            page: query.page,
            limit: query.limit,
            sort: query.sort,
        });

        sendPaginated(res, page.items.map(toPaymentDto), toPageMeta(page.total, page.page, page.limit));
    });

    /**
     * GET /api/v1/money/payments/:transactionId — one settlement and what came back.
     *
     * The refund rows are the half the payment cannot state: `totalRefunded` says how much
     * went back, and these say when, through which gateway and at whose request. A `pending`
     * or `failed` refund beside a `totalRefunded` that has not moved is exactly what a stuck
     * refund looks like — and NotchPay's and MyCoolPay's gateway refunds are explicit
     * placeholders, so that state is expected rather than exotic.
     */
    static getPayment = asyncHandler(async (req: Request, res: Response) => {
        const row = await payments.findById(req.params.transactionId);
        if (!row) throw createAppError(ERROR_CODES.NOT_FOUND, 404, 'Payment transaction not found');

        const related = await refunds.findForPayment(req.params.transactionId);

        sendSuccess(res, toPaymentDetailDto(row, related));
    });

    /**
     * GET /api/v1/money/refunds — net-new: the cross-payment refund queue.
     *
     * Ranged on `createdAt` rather than `completedAt`, against the collection's own
     * analytics convention and deliberately: `completedAt` is unset on a `pending` and on a
     * `failed` refund, so a window on it would silently drop exactly the rows somebody opens
     * this list to find. `?sort=-completedAt` is there for the analytics reading.
     */
    static listRefunds = asyncHandler(async (req: Request, res: Response) => {
        const query = req.query as unknown as ListRefundsQuery;

        const page = await refunds.search({
            status: query.status,
            gateway: query.gateway,
            vendorId: query.vendorId,
            orderId: query.orderId,
            bookingId: query.bookingId,
            paymentTransactionId: query.paymentTransactionId,
            from: query.from,
            to: query.to,
            page: query.page,
            limit: query.limit,
            sort: query.sort,
        });

        sendPaginated(res, page.items.map(toRefundDto), toPageMeta(page.total, page.page, page.limit));
    });
}

async function loadAllocationOr404(allocationId: string): Promise<EarningsAllocationReadModel> {
    const row = await allocations.findById(allocationId);
    if (!row) throw createAppError(ERROR_CODES.NOT_FOUND, 404, 'Earnings allocation not found');
    return row;
}
