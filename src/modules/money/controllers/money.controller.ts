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
import { VendorReadRepository } from '../../vendors/repositories/vendor.read.repository';
import { verificationOf } from '../domain/owner-verification';
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
import { DeliveryFeeRefundReadModel, DeliveryFeeRefundReadRepository } from '../repositories/delivery-fee.read.repository';
import { toDeliveryFeeRefundDto } from '../read-models/delivery-fee.dto';
import { OrderReadRepository } from '../../orders/repositories/order.read.repository';
import {
    MoneyOwnerNames,
    MoneyOwnerVerifications,
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
    ListDeliveryFeeRefundsQuery,
    SettleDeliveryFeeRefundBody,
    ListEarningsAccountsQuery,
    ListPaymentsQuery,
    ListPayoutActivityQuery,
    ListPayoutsQuery,
    ListPlatformLedgerQuery,
    ListRefundsQuery,
    MarkPaidBody,
    PlatformEarningsSummaryQuery,
    RejectPayoutBody,
    ResolveUnknownPayoutBody,
    TriagePayoutBody,
    ListEarningsPausesQuery,
    PauseEarningsBody,
    PauseTargetParams,
    ResumeEarningsBody,
} from '../validators/money.validator';
import { ledgerOwnerTypesOf, toPlatformEarnedSummaries } from '../domain/platform-earnings';

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
const deliveryFeeRefunds = new DeliveryFeeRefundReadRepository();
const orderNumbers = new OrderReadRepository();
const auditEntries = new AuditRepository();

// The owner directories, for the display names a money row cannot carry. Owned by the
// modules that own those collections — `delivery_agents` holds `legal_identity` and
// `payout_details`, so a second projection of it declared here would be a second thing to
// get right. Same rule `hydrateNames` follows in the COD and billing controllers.
const stores = new StoreReadRepository();
const vendors = new VendorReadRepository();
const agencies = new AgencyReadRepository();
const agents = new AgentReadRepository();

/*
 * The platform singletons' owner terms are `ledgerOwnerTypesOf(account)` — `platform`
 * (commission) and/or `platform_ai` (bargain fee). `owner_id` is genuinely `null` on those
 * rows — that is what "the marketplace's own account" looks like in this schema — so the
 * ledger filter is given `null` explicitly rather than having the term omitted. Omitting it
 * would return every owner's ledger under the platform's heading.
 */

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

/**
 * Where each owner's KYC review stands, for a page of payout rows — one batched read per
 * owner type present, never one per row, exactly as `hydrateOwnerNames` above.
 *
 * ── Why this is computed here and not forwarded ──────────────────────────────
 * ⚠ **The payout queue is a DIRECT read, not a delegated one**, so jovi-mall's own
 * `verification` field (added to its admin DTO on 2026-09-15) never passes through this
 * service. There is nothing to carry through; the verdict is resolved against the same
 * three collections, by the same fail-closed rule. See `domain/owner-verification.ts`,
 * which carries the whole argument and the BR-026 § 1 reference.
 *
 * ⚠ **Read fresh on every request, deliberately** — unlike `destination`, which is a
 * snapshot frozen at request time so a later profile edit cannot redirect money in flight.
 * A frozen verdict would produce the opposite harm: an "unverified" badge against a
 * business approved an hour ago sends the reviewer chasing documents already on file.
 *
 * ⚠ **Note `vendors`, not `stores`.** The display name comes off the vendor's Store; the
 * verdict is on the vendor. Two collections, two reads, and reaching for the one already
 * in `hydrateOwnerNames` would silently return nothing for every vendor row.
 *
 * A `platform` owner has no directory row and never gets one — it is the marketplace's own
 * commission account — so it is not queried, falls through the map and renders as
 * unverified. That is the honest answer for a row that is not a vetted business, and the
 * queue does not show platform payouts anyway.
 */
async function hydrateOwnerVerifications(rows: OwnerRow[]): Promise<MoneyOwnerVerifications> {
    const idsFor = (type: string): ObjectId[] =>
        [
            ...new Set(
                rows
                    .filter((row) => row.ownerType === type && row.ownerId)
                    .map((row) => row.ownerId as string),
            ),
        ].map((id) => new ObjectId(id));

    const [vendorVerdicts, agencyVerdicts, agentVerdicts] = await Promise.all([
        vendors.findKycVerdictsByIds(idsFor('vendor')),
        agencies.findKycVerdictsByIds(idsFor('agency')),
        agents.findKycVerdictsByIds(idsFor('agent')),
    ]);

    const verifications: MoneyOwnerVerifications = new Map();
    const absorb = (type: string, verdicts: Map<string, string | null>): void => {
        verdicts.forEach((verdict, id) => {
            verifications.set(ownerKey(type, id), verificationOf(verdict));
        });
    };
    absorb('vendor', vendorVerdicts);
    absorb('agency', agencyVerdicts);
    absorb('agent', agentVerdicts);

    return verifications;
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

        // Both platform singletons by default — commission AND the bargain fee (2026-10-04).
        // Each row still names its own `owner.type`, so the two stay distinguishable.
        const page = await ledger.listForOwner(ledgerOwnerTypesOf(query.account), null, {
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
     * GET /api/v1/money/earnings/platform/summary — what the marketplace earned in a window,
     * commission and bargain fee side by side. A DIRECT read: a sum of allocation records,
     * not a balance. See `domain/platform-earnings.ts`.
     */
    static platformSummary = asyncHandler(async (req: Request, res: Response) => {
        const query = req.query as unknown as PlatformEarningsSummaryQuery;
        const rows = await allocations.platformEarnedBetween(query.from, query.to);
        sendSuccess(res, {
            from: query.from ?? null,
            to: query.to ?? null,
            currencies: toPlatformEarnedSummaries(rows),
        });
    });

    /**
     * GET /api/v1/money/orders/:orderId/split — who gets what from one order, and why.
     *
     * DELEGATED (the figures before a split exist only as jovi-mall's split arithmetic), then
     * given display names here with the same batched lookup every money list uses. A name is
     * ADDED beside each id, never replacing it: `platform` and `platform_ai` carry `name: null`
     * (they have no directory row — see `hydrateOwnerNames`), and a customer is left unnamed
     * on purpose; this view explains money to a vendor, and the customer's identity is not
     * part of that explanation.
     */
    static orderSplit = asyncHandler(async (req: Request, res: Response) => {
        if (!(await orderNumbers.findById(req.params.orderId))) {
            throw createAppError(ERROR_CODES.NOT_FOUND, 404, 'Order not found');
        }
        const split = await gateway.orderMoneySplit(req.params.orderId, actorContextOf(req));

        const owners: OwnerRow[] = [{ ownerType: 'vendor', ownerId: split.order.vendorId }];
        for (const section of split.sections) {
            if (section.shipment) {
                owners.push({ ownerType: 'agency', ownerId: section.shipment.agencyId });
                owners.push({ ownerType: 'agent', ownerId: section.shipment.agentId });
            }
            for (const line of section.lines) {
                owners.push({ ownerType: line.beneficiary.type, ownerId: line.beneficiary.id });
            }
        }
        const names = await hydrateOwnerNames(owners);
        const nameOf = (type: string, id: string | null): string | null =>
            id ? names.get(ownerKey(type, id)) ?? null : null;

        sendSuccess(res, {
            ...split,
            order: { ...split.order, vendorName: nameOf('vendor', split.order.vendorId) },
            sections: split.sections.map((section) => ({
                ...section,
                shipment: section.shipment
                    ? {
                          ...section.shipment,
                          agencyName: nameOf('agency', section.shipment.agencyId),
                          agentName: nameOf('agent', section.shipment.agentId),
                      }
                    : null,
                lines: section.lines.map((line) => ({
                    ...line,
                    beneficiary: { ...line.beneficiary, name: nameOf(line.beneficiary.type, line.beneficiary.id) },
                })),
            })),
        });
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

        // Both hydrations run over the same owner rows and neither depends on the other,
        // so the queue costs one extra round trip in parallel rather than one per row.
        const owners = payoutOwners(page.items);
        const [names, verifications] = await Promise.all([
            hydrateOwnerNames(owners),
            hydrateOwnerVerifications(owners),
        ]);

        sendPaginated(
            res,
            page.items.map((row) => toPayoutListItemDto(row, names, verifications)),
            toPageMeta(page.total, page.page, page.limit),
        );
    });

    /** GET /api/v1/money/payouts/:payoutId — the same shape, one row, same masking. */
    static getPayout = asyncHandler(async (req: Request, res: Response) => {
        const row = await payoutWrites.loadPayoutOr404(req.params.payoutId);
        const owners = payoutOwners([row]);
        const [names, verifications] = await Promise.all([
            hydrateOwnerNames(owners),
            hydrateOwnerVerifications(owners),
        ]);

        sendSuccess(res, toPayoutListItemDto(row, names, verifications));
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
     * POST /api/v1/money/payouts/:payoutId/triage — a reviewer vouches for this request.
     *
     * The only write on this surface a Support administrator can perform, and it is
     * deliberately the weakest one in the module: it moves no money, changes no status and
     * gates nothing. A payout nobody has endorsed is exactly as payable as one that has been.
     *
     * Never queued for a second administrator at any amount. There is nothing to have a
     * quorum about — the act being recorded is an opinion, and the irreversible step it
     * precedes has its own.
     */
    static triagePayout = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as TriagePayoutBody;
        const before = await payoutWrites.loadPayoutOr404(req.params.payoutId);

        const result = await gateway.triagePayout(
            req.params.payoutId,
            body.note ?? null,
            payoutWrites.auditContextOfPayout(before),
            actorContextOf(req),
        );

        sendSuccess(res, result, {
            message: 'Payout request endorsed — final approval is still required before money moves',
        });
    });

    /**
     * POST /api/v1/money/payouts/:payoutId/send — the platform sends the money itself.
     *
     * Rides `money.payouts.mark_paid` and therefore the same four-eyes threshold: at or above
     * 2,000,000 XAF this answers **202** with an approval id and sends nothing until a second
     * administrator agrees. Below it, the transfer goes now.
     *
     * ⚠ **A 200 here does not mean the money arrived.** The usual answer is a payout in
     * `processing` — accepted by the gateway, confirmed later by callback. Only `paid` is
     * settled, and `failed` means the transfer was refused and the funds are still held.
     */
    static sendPayout = asyncHandler(async (req: Request, res: Response) => {
        const identity = requireAdminIdentity(req);

        const outcome = await payoutWrites.markPaid(
            identity,
            req.params.payoutId,
            null,
            actorContextOf(req),
            'gateway',
        );

        if (outcome.kind === 'applied') {
            sendSuccess(res, outcome.payout, {
                message:
                    outcome.payout.status === 'paid'
                        ? 'Payout sent and confirmed'
                        : outcome.payout.status === 'failed'
                          ? 'The gateway refused the transfer — the funds remain held'
                          : 'Payout submitted to the gateway — it is not settled until the gateway confirms it',
            });
            return;
        }

        sendSuccess(res, outcome.approval, {
            status: 202,
            message: outcome.created
                ? 'This payout is above the four-eyes threshold — submitted for a second administrator\u2019s approval'
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

    /**
     * POST /api/v1/money/payouts/:payoutId/resolve-unknown — decide a transfer nobody can ask
     * about.
     *
     * `failed` answers 200 with the payout in `failed` and the funds still held. `paid` answers
     * 200 settled, or **202** with an approval at or above the four-eyes threshold, exactly as
     * `/mark-paid` does. Every rule lives in `domain/payout-dual-control.ts`.
     */
    static resolveUnknownPayout = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as ResolveUnknownPayoutBody;
        const identity = requireAdminIdentity(req);

        const outcome = await payoutWrites.resolveUnknown(
            identity,
            req.params.payoutId,
            { outcome: body.outcome, reason: body.reason, evidence: body.evidence ?? null },
            actorContextOf(req),
        );

        if (outcome.kind === 'applied') {
            sendSuccess(res, outcome.payout, {
                message:
                    outcome.payout.status === 'paid'
                        ? 'Transfer confirmed as paid — the payout is settled'
                        : 'Transfer recorded as failed — the funds remain held; retry the transfer or reject the request',
            });
            return;
        }

        sendSuccess(res, outcome.approval, {
            status: 202,
            message: outcome.created
                ? 'This payout is above the four-eyes threshold — submitted for a second administrator’s approval'
                : 'An identical request is already awaiting approval',
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
            reference: query.reference,
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
     * refund looks like — and on the mobile rails that state is expected rather than exotic:
     * My-CoolPay's API has no refund endpoint at all, and NotchPay's is implemented but
     * disabled on the merchant account, so both settle by manual payout against a HIGH
     * support ticket until that changes.
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

    // ── Delivery-fee refunds (jovi-mall ADR-A11 W-E2, owner decision D-12) ─────────

    /**
     * GET /api/v1/money/delivery-fee-refunds — the queue of delivery money owed back to a
     * customer that a PERSON must send (COD cash, mobile money, a gateway with refunds off).
     *
     * A direct read of `delivery_fee_refunds` — the record, not a verdict. `money.payments.read`,
     * like `/refunds`: reading what is owed is not settling it, and Support answering "where is
     * my delivery refund" needs exactly this.
     */
    static listDeliveryFeeRefunds = asyncHandler(async (req: Request, res: Response) => {
        const query = req.query as unknown as ListDeliveryFeeRefundsQuery;
        const page = await deliveryFeeRefunds.search(query);
        const numbers = await orderNumbers.findNumbersByIds(page.items.map((r) => r.order_id.toString()));

        sendPaginated(
            res,
            page.items.map((r) => toDeliveryFeeRefundDto(r, numbers.get(r.order_id.toString()) ?? null)),
            toPageMeta(page.total, page.page, page.limit),
        );
    });

    /** GET /api/v1/money/delivery-fee-refunds/:refundId — one row, automatic ones included. */
    static getDeliveryFeeRefund = asyncHandler(async (req: Request, res: Response) => {
        const row = await loadDeliveryFeeRefundOr404(req.params.refundId);
        const numbers = await orderNumbers.findNumbersByIds([row.order_id.toString()]);
        sendSuccess(res, toDeliveryFeeRefundDto(row, numbers.get(row.order_id.toString()) ?? null));
    });

    /**
     * POST /api/v1/money/delivery-fee-refunds/:refundId/settle — record that the money was
     * returned by hand, or was already covered by a refund of the whole order.
     *
     * Read first for the 404 and the audit `before`; whether the row may be settled is NOT
     * pre-checked here — that rule (and the never-paid-twice ceiling) is jovi-mall's, and its
     * refusals arrive as `PLATFORM_OPERATION_REJECTED` + `details.platformCode`. Answers through
     * this service's own read of the row(s) afterwards, so the write and the GET cannot disagree
     * in shape.
     */
    static settleDeliveryFeeRefund = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as SettleDeliveryFeeRefundBody;
        const row = await loadDeliveryFeeRefundOr404(req.params.refundId);
        const orderId = row.order_id.toString();
        const numbers = await orderNumbers.findNumbersByIds([orderId]);
        const orderNumber = numbers.get(orderId) ?? null;

        const result = await gateway.settleDeliveryFeeRefund(
            req.params.refundId,
            { method: body.method, reference: body.reference ?? null, note: body.note ?? null },
            {
                orderId,
                label: orderNumber,
                amount: row.amount,
                currency: row.currency,
                before: { refundId: row._id.toString(), status: row.status, amount: row.amount, settlementMethod: null },
            },
            actorContextOf(req),
        );

        const [settled, remainder] = await Promise.all([
            deliveryFeeRefunds.findById(req.params.refundId),
            result.remainder?.id ? deliveryFeeRefunds.findById(result.remainder.id) : Promise.resolve(null),
        ]);

        sendSuccess(
            res,
            {
                refund: settled ? toDeliveryFeeRefundDto(settled, orderNumber) : null,
                remainder: remainder ? toDeliveryFeeRefundDto(remainder, orderNumber) : null,
            },
            {
                message: result.remainder
                    ? 'Partly covered by a refund of the whole order — the rest is still owed'
                    : 'Delivery-fee refund marked settled',
            },
        );
    });
}

// ── Earnings pauses (2026-10-05) ─────────────────────────────────────────────
// A static class would be the house style, but these four only call the gateway and the
// order-number reader, so they sit beside the helpers rather than inside the long class.

/** GET /api/v1/money/earnings/pauses — the queue of paused money. DELEGATED read. */
export const listEarningsPauses = asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as unknown as ListEarningsPausesQuery;
    sendPlatformPage(res, await gateway.listEarningsPauses(query, actorContextOf(req)));
});

/** GET /api/v1/money/earnings/pauses/:kind/:id — one order's or booking's pause record. */
export const getEarningsPause = asyncHandler(async (req: Request, res: Response) => {
    const { kind, id } = req.params as unknown as PauseTargetParams;
    sendSuccess(res, await gateway.earningsPause(kind, id, actorContextOf(req)));
});

/** POST /api/v1/money/earnings/pauses/:kind/:id/pause — pause by hand, with a note. */
export const pauseEarnings = asyncHandler(async (req: Request, res: Response) => {
    const { kind, id } = req.params as unknown as PauseTargetParams;
    const { note } = req.body as PauseEarningsBody;
    sendSuccess(res, await setPause('pause', kind, id, note, req), { message: 'Earnings paused' });
});

/**
 * POST /api/v1/money/earnings/pauses/:kind/:id/resume — lift any pause, whoever raised it.
 * The hold continues where it stopped; the paused time never counts.
 */
export const resumeEarnings = asyncHandler(async (req: Request, res: Response) => {
    const { kind, id } = req.params as unknown as PauseTargetParams;
    const { note } = req.body as ResumeEarningsBody;
    sendSuccess(res, await setPause('resume', kind, id, note ?? null, req), { message: 'Earnings resumed' });
});

async function setPause(
    verb: 'pause' | 'resume',
    kind: gateway.PauseKind,
    id: string,
    note: string | null,
    req: Request,
): Promise<gateway.PlatformPauseView> {
    const context = actorContextOf(req);
    // The current record first: it is the audit row's `before`, and it 404s an unknown id
    // before any audit intent is written about a record that does not exist.
    const current = await gateway.earningsPause(kind, id, context);
    const label = kind === 'order' ? ((await orderNumbers.findNumbersByIds([id])).get(id) ?? null) : null;
    return gateway.setEarningsPause(verb, kind, id, note, { label, before: current.pause }, context);
}

async function loadAllocationOr404(allocationId: string): Promise<EarningsAllocationReadModel> {
    const row = await allocations.findById(allocationId);
    if (!row) throw createAppError(ERROR_CODES.NOT_FOUND, 404, 'Earnings allocation not found');
    return row;
}

async function loadDeliveryFeeRefundOr404(refundId: string): Promise<DeliveryFeeRefundReadModel> {
    const row = await deliveryFeeRefunds.findById(refundId);
    if (!row) throw createAppError(ERROR_CODES.NOT_FOUND, 404, 'Delivery-fee refund not found');
    return row;
}
