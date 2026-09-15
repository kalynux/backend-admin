import { Request, Response } from 'express';
import { ObjectId } from 'mongodb';
import { createAppError } from '../../../core/errors/app-error';
import { ERROR_CODES } from '../../../core/errors/error-codes';
import { asyncHandler } from '../../../core/http/async-handler';
import { cursorMeta, toPageMeta } from '../../../core/http/list-query';
import { sendPaginated, sendSuccess } from '../../../core/http/responses';
import { AgencyReadRepository } from '../../agencies/repositories/agency.read.repository';
import { ContractReadRepository } from '../../agencies/repositories/contract.read.repository';
import { AgentReadRepository } from '../../agents/repositories/agent.read.repository';
import { actorContextOf } from '../../audit/domain/audit-context';
import { BillingSettingsReadRepository } from '../../billing/repositories/billing-settings.read.repository';
import { PricingPlanReadRepository } from '../../billing/repositories/pricing-plan.read.repository';
import { SubscriberPlanReadRepository } from '../../billing/repositories/subscriber-plan.read.repository';
import { CodDiscrepancyReadRepository } from '../../cod/repositories/cod-record.read.repository';
import {
    CodCashAccountReadRepository,
    CodCashLedgerReadRepository,
} from '../../cod/repositories/cod-cash.read.repository';
import {
    EarningsLedgerReadRepository,
    EarningsAllocationReadRepository,
    EarningsReserveHoldReadRepository,
} from '../../money/repositories/earnings.read.repository';
import { PayoutRequestReadRepository } from '../../money/repositories/payout-request.read.repository';
import { verificationOf } from '../../money/domain/owner-verification';
import { toPayoutListItemDto, ownerKey, MoneyOwnerNames, MoneyOwnerVerifications } from '../../money/read-models/money.dto';
import { StoreReadRepository } from '../../vendors/repositories/store.read.repository';
import { VendorReadRepository } from '../../vendors/repositories/vendor.read.repository';
import * as gateway from '../gateways/account.gateway';
import {
    ActivityCandidate,
    EarningsCurrencyReadRepository,
    mergeActivity,
} from '../repositories/account-activity.read.repository';
import {
    CreditTopupReadRepository,
    CreditTransactionReadRepository,
    CreditWalletReadRepository,
} from '../repositories/credit.read.repository';
import { PlanPurchaseReadRepository } from '../repositories/plan-purchase.read.repository';
import {
    AccountActivityDto,
    AccountOwnerRow,
    AccountSources,
    toAccountDto,
    toCashLedgerEntryDto,
    toCreditActivity,
    toCreditTransactionDto,
    toCreditWalletDto,
    toEarningActivity,
    toPayoutActivity,
    toPlanPurchaseActivity,
    toTopupActivity,
} from '../read-models/account.dto';
import {
    AccountOwnerType,
    ListAccountPayoutsQuery,
    ListActivityQuery,
    ListCashLedgerQuery,
    ListCreditsQuery,
} from '../validators/account.validator';

/**
 * `/api/v1/accounts` — one party's money, in one place.
 *
 * ── Why this is its own mount, and not `/money/accounts` ──────────────────────
 * **The subject here is a PARTY, not a money record.** `/money` holds rows — ledgers,
 * allocations, payouts, settlements — and every one of them is gated on a `money.*`
 * permission. This page's subject is a vendor, an agency or an agent, and its answer spans
 * three unrelated balance models plus a subscription and a COD liability.
 *
 * Putting it under `/money` would smuggle billing and COD data behind a `money.*` gate: an
 * administrator holding `money.earnings.read` would read a subscriber plan and a cash
 * balance they were never granted. That is exactly the side door
 * `permission('shipments.read', 'agents.read')` exists to prevent, so every route here is an
 * `all`-mode composition of the permissions its DATA belongs to — and no `accounts`
 * permission family is added, because a new family would need entries that duplicate
 * `money.earnings.read` + `billing.plans.read` + `cod.overview.read` semantically.
 *
 * The other rejected shape was `/vendors/:id/account` × 3. Three per-role copies is how
 * jovi-mall's `maskPayoutMethods` ended up with three copies. One mount, one `ownerType`
 * discriminator.
 *
 * ── What is delegated, and what is not ────────────────────────────────────────
 * Two verdicts: the four earnings balances, and the plan's entitlements. Everything else on
 * this mount is a direct read — which means the three sub-lists keep answering when
 * jovi-mall is down, and the account overview does not. That asymmetry is deliberate: an
 * overview that silently rendered `balances.earnings: null` would be indistinguishable from
 * an owner who is owed nothing.
 */

const vendors = new VendorReadRepository();
const stores = new StoreReadRepository();
const agencies = new AgencyReadRepository();
const agents = new AgentReadRepository();
const contracts = new ContractReadRepository();
const subscriptions = new SubscriberPlanReadRepository();
const plans = new PricingPlanReadRepository();
const billingSettings = new BillingSettingsReadRepository();
const wallets = new CreditWalletReadRepository();
const creditTransactions = new CreditTransactionReadRepository();
const creditTopups = new CreditTopupReadRepository();
const planPurchases = new PlanPurchaseReadRepository();
const earningsLedger = new EarningsLedgerReadRepository();
const allocations = new EarningsAllocationReadRepository();
const reserveHolds = new EarningsReserveHoldReadRepository();
const earningsCurrency = new EarningsCurrencyReadRepository();
const payouts = new PayoutRequestReadRepository();
const cashAccounts = new CodCashAccountReadRepository();
const cashLedger = new CodCashLedgerReadRepository();
const discrepancies = new CodDiscrepancyReadRepository();

/** One row, newest first — the shape of every "just tell me the latest one" read here. */
const ONE_NEWEST = { page: 1, limit: 1, sort: { field: 'createdAt', direction: -1 as const } };

/**
 * How many contracts and reserve holds the overview carries.
 *
 * A bound, not a page: an agent has a handful of agency contracts and an agency's reserve
 * holds mature within days. Paging either would be a control with nothing to page — and if
 * an owner ever exceeds this, the truncation is visible as a full array rather than silent,
 * because `codExposure` is a summary block and the phase plan's own rule (ADR-005 D-13) is
 * that a bound must be legible.
 */
const EXPOSURE_LIMIT = 50;

export class AccountController {
    /**
     * GET /api/v1/accounts/:ownerType/:ownerId — the whole account.
     *
     * Three waves, and the order is forced rather than chosen: the owner must resolve before
     * anything else is worth reading (a 404 for an id that names nobody), the plan NAME needs
     * the subscription row that wave two fetches, and everything in between is independent
     * and therefore parallel.
     */
    static getAccount = asyncHandler(async (req: Request, res: Response) => {
        const { ownerType, ownerId } = ownerParams(req);
        const context = actorContextOf(req);

        const owner = await loadOwnerOr404(ownerType, ownerId);

        const [
            ownerName,
            balances,
            entitlements,
            subscription,
            settings,
            wallet,
            codCash,
            exposure,
            holds,
            pendingPayout,
            lastPaidPayout,
            openDiscrepancies,
            unsettledCollections,
        ] = await Promise.all([
            loadOwnerName(ownerType, ownerId),
            gateway.ownerBalances(ownerType, ownerId, context),
            gateway.entitlements(ownerType, ownerId, context),
            subscriptions.findActiveForOwner(ownerType, ownerId),
            billingSettings.findForOwner(ownerType, ownerId),
            wallets.findForOwner(ownerType, ownerId),
            loadCodCashAccount(ownerType, ownerId),
            loadContracts(ownerType, ownerId),
            ownerType === 'agency' ? reserveHolds.listForOwner(ownerId, EXPOSURE_LIMIT) : Promise.resolve([]),
            loadPayout(ownerType, ownerId, 'pending', 'createdAt'),
            loadPayout(ownerType, ownerId, 'paid', 'resolvedAt'),
            countOpenDiscrepancies(ownerType, ownerId),
            countUnsettledCollections(ownerType, ownerId),
        ]);

        // Third wave, and the only one that depends on a previous answer.
        const planName = subscription
            ? (await plans.findRefsByIds([subscription.plan_id])).get(subscription.plan_id.toString())?.name ?? null
            : null;

        const sources: AccountSources = {
            ownerType,
            ownerId,
            owner,
            ownerName,
            balances,
            entitlements,
            subscription,
            planName,
            billingSettings: settings,
            wallet,
            codCash,
            contracts: exposure,
            reserveHolds: holds,
            pendingPayout,
            lastPaidPayout,
            openDiscrepancies,
            unsettledCollections,
        };

        sendSuccess(res, toAccountDto(sources));
    });

    /**
     * GET /api/v1/accounts/:ownerType/:ownerId/activity — five collections, one feed.
     *
     * **The only cursor-paged list in the service**, and it reports no `total` and no
     * `pages`. Offset paging over a merge is not merely expensive, it is wrong: `skip(40)`
     * applied to five sources independently does not compose into rows 40–60 of the merged
     * order. See `account-activity.read.repository.ts` for the merge and the tie rule.
     *
     * Every source fetches `limit + 1` rows: one more than could possibly be shown, which is
     * exactly what tells the merge whether there is another page.
     */
    static getActivity = asyncHandler(async (req: Request, res: Response) => {
        const { ownerType, ownerId } = ownerParams(req);
        const query = req.query as unknown as ListActivityQuery;

        await loadOwnerOr404(ownerType, ownerId);

        const before = query.before ? new Date(query.before) : undefined;
        const fetch = query.limit + 1;

        const [purchases, topups, credits, ledger, payoutRows, currency] = await Promise.all([
            planPurchases.listBefore(ownerType, ownerId, before, fetch),
            creditTopups.listBefore(ownerType, ownerId, before, fetch),
            creditTransactions.listBefore(ownerType, ownerId, before, fetch),
            earningsLedger.listBefore(ownerType, ownerId, before, fetch),
            payouts.listBefore(ownerType, ownerId, before, fetch),
            earningsCurrency.findCurrency(ownerType, ownerId),
        ]);

        const sources: ActivityCandidate<AccountActivityDto>[][] = [
            purchases.map((row) => candidate(toPlanPurchaseActivity(row), row.created_at, row._id)),
            topups.map((row) => candidate(toTopupActivity(row), row.created_at, row._id)),
            credits.map((row) => candidate(toCreditActivity(row), row.created_at, row._id)),
            ledger.map((row) => candidate(toEarningActivity(row, currency), row.created_at, row._id)),
            payoutRows.map((row) => candidate(toPayoutActivity(row), row.created_at, row._id)),
        ];

        const page = mergeActivity(sources, query.limit);

        sendSuccess(res, page.items, { meta: cursorMeta(page.nextCursor, query.limit) });
    });

    /**
     * GET /api/v1/accounts/:ownerType/:ownerId/payouts — this owner's payout history.
     *
     * The same rows `/money/payouts?ownerId=` returns, through the same repository and the
     * same masked projection, and gated on the same `money.payouts.read`. It exists as a
     * separate path because the account page should not have to know the queue's query
     * shape — not because the data differs.
     */
    static getPayouts = asyncHandler(async (req: Request, res: Response) => {
        const { ownerType, ownerId } = ownerParams(req);
        const query = req.query as unknown as ListAccountPayoutsQuery;

        // The 404 guard's row is KEPT here, where `getActivity` above discards it: it
        // already carries this owner's KYC verdict under the projection both branches use,
        // so the badge below costs no extra read.
        const owner = await loadOwnerOr404(ownerType, ownerId);

        const [page, name] = await Promise.all([
            payouts.search({
                ownerType,
                ownerId,
                status: query.status,
                page: query.page,
                limit: query.limit,
                sort: query.sort,
            }),
            loadOwnerName(ownerType, ownerId),
        ]);

        // One owner, one name — resolved once rather than per row.
        const names: MoneyOwnerNames = new Map([[ownerKey(ownerType, ownerId), name]]);

        /**
         * ⚠ **Hydrated here even though the owner is already named on the page**, and
         * leaving it out was the tempting mistake. `toPayoutListItemDto` defaults an
         * unhydrated row to `unverified` — fail-closed, which is right for a missing
         * lookup and WRONG as a permanent answer on a screen that has the owner in hand.
         * Every row of a verified vendor's history would have rendered "unverified" beside
         * their name. See the field's docstring on `PayoutListItemDto`.
         */
        const verifications: MoneyOwnerVerifications = new Map([
            [ownerKey(ownerType, ownerId), verificationOf(ownerKycVerdict(owner))],
        ]);

        sendPaginated(
            res,
            page.items.map((row) => toPayoutListItemDto(row, names, verifications)),
            toPageMeta(page.total, page.page, page.limit),
        );
    });

    /**
     * GET /api/v1/accounts/:ownerType/:ownerId/credits — the credit ledger.
     *
     * The wallet balance rides in `meta` rather than as a row: a running balance is not a
     * movement, and putting it in `data` would make the first item of a list mean something
     * different from the rest. `meta` already carries list-level summary fields elsewhere in
     * this service.
     *
     * Top-up rows are excluded by the repository — a paid top-up writes both a `credit_topups`
     * row and a `credit_transactions` one, and showing both double-counts a single event.
     * They appear on the activity feed, once, as the top-up.
     */
    static getCredits = asyncHandler(async (req: Request, res: Response) => {
        const { ownerType, ownerId } = ownerParams(req);
        const query = req.query as unknown as ListCreditsQuery;

        await loadOwnerOr404(ownerType, ownerId);

        const [page, wallet] = await Promise.all([
            creditTransactions.search(ownerType, ownerId, {
                type: query.type,
                reasonCode: query.reasonCode,
                page: query.page,
                limit: query.limit,
                sort: query.sort,
            }),
            wallets.findForOwner(ownerType, ownerId),
        ]);

        /**
         * `sendSuccess` rather than `sendPaginated`, for one reason: the wallet is a BALANCE
         * OBJECT and it stays one. `PaginationMeta`'s index signature admits scalars only, so
         * routing this through `sendPaginated` would mean flattening `unit`, `currency`,
         * `direction` and `balance` to the top of `meta` — stripping a balance of exactly the
         * three fields the account DTO gives it to stop somebody adding it to something else.
         */
        sendSuccess(res, page.items.map(toCreditTransactionDto), {
            meta: {
                ...toPageMeta(page.total, page.page, page.limit),
                wallet: toCreditWalletDto(wallet),
            },
        });
    });

    /**
     * GET /api/v1/accounts/:ownerType/:ownerId/cash-ledger — the COD liability's movements.
     *
     * **Separate from `/activity`, and that is the single most important layout decision on
     * this mount.** COD cash is not owner value: it is money the owner is holding and owes
     * onward — to their agency if they are an agent, to the platform if they are an agency.
     * Merging it into the activity feed would put a liability and an asset in one column
     * under one running order, which is the misreading the whole account DTO is shaped to
     * prevent.
     *
     * The route's own params schema accepts only `agent` and `agency`, so a vendor is a 400
     * naming the reason rather than an empty page that reads as "no movements" when the
     * truth is "cannot have movements".
     */
    static getCashLedger = asyncHandler(async (req: Request, res: Response) => {
        const { ownerType, ownerId } = ownerParams(req);
        const query = req.query as unknown as ListCashLedgerQuery;

        await loadOwnerOr404(ownerType, ownerId);

        const page = await cashLedger.listForOwner(ownerType, ownerId, {
            entryType: query.entryType,
            page: query.page,
            limit: query.limit,
            sort: query.sort,
        });

        sendPaginated(
            res,
            page.items.map(toCashLedgerEntryDto),
            toPageMeta(page.total, page.page, page.limit),
        );
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Loading one owner, whichever kind it is
// ─────────────────────────────────────────────────────────────────────────────

function ownerParams(req: Request): { ownerType: AccountOwnerType; ownerId: string } {
    return {
        ownerType: req.params.ownerType as AccountOwnerType,
        ownerId: req.params.ownerId,
    };
}

/**
 * The owner document, or a 404 that says which id failed.
 *
 * `ACCOUNT_OWNER_NOT_FOUND` rather than the generic `NOT_FOUND`, because on this mount the
 * distinction is worth making: every route takes a PAIR, and "no vendor with this id" is a
 * different fix from "this id is an agent, not a vendor". The code lets a dashboard say so.
 *
 * Read through each domain's own repository rather than a projection declared here —
 * `delivery_agents` holds `legal_identity` and `payout_details`, and a second whitelist of
 * that collection would be a second thing to get right.
 */
async function loadOwnerOr404(
    ownerType: AccountOwnerType,
    ownerId: string,
): Promise<AccountOwnerRow> {
    const owner = ownerType === 'vendor'
        ? await vendors.findDetailById(ownerId)
        : ownerType === 'agency'
            ? await agencies.findById(ownerId)
            : await agents.findById(ownerId);

    if (!owner) {
        throw createAppError(
            ERROR_CODES.ACCOUNT_OWNER_NOT_FOUND,
            404,
            `No ${ownerType} account with this id`,
            { ownerType, ownerId },
        );
    }
    return owner;
}

/**
 * This owner's KYC verdict, off the row `loadOwnerOr404` already fetched.
 *
 * ⚠ **The agent's verdict lives on `kyc`, the vendor's and the agency's on
 * `kyc_details`.** One name would have been nicer; renaming either is a data migration, so
 * the difference is handled rather than papered over with an `??` chain that would read
 * `undefined` off whichever shape it met second.
 *
 * Returns the raw string. `verificationOf` decides what counts as approval, in one place,
 * fail-closed — including for the case this function returns `null` on, which is an agent
 * document whose `kyc` block has never been written.
 */
function ownerKycVerdict(owner: AccountOwnerRow): string | null {
    if ('kyc' in owner) return owner.kyc?.status ?? null;
    return owner.kyc_details?.status ?? null;
}

/**
 * The BUSINESS name wherever there is one — a vendor's Store, an agency's Magazin. That is
 * what the owner is called on every other screen in the dashboard. An agent has no business
 * identity, so their own name is the answer.
 */
async function loadOwnerName(ownerType: AccountOwnerType, ownerId: string): Promise<string | null> {
    const oid = new ObjectId(ownerId);

    if (ownerType === 'vendor') {
        return (await stores.findForVendors([oid])).get(ownerId)?.name ?? null;
    }
    if (ownerType === 'agency') {
        return (await agencies.findNamesByIds([oid])).get(ownerId) ?? null;
    }
    return (await agents.findNamesByIds([oid])).get(ownerId) ?? null;
}

/**
 * The COD cash account, at ANY balance.
 *
 * `includeSettled: true` is the whole point: the holders list defaults to `balance > 0`,
 * because that is what "holder" means there. Here a settled account is exactly what we want
 * to show — `held: 0` says "applies, currently empty", which is a different fact from the
 * `null` a vendor gets.
 */
async function loadCodCashAccount(ownerType: AccountOwnerType, ownerId: string) {
    if (ownerType === 'vendor') return null;

    const page = await cashAccounts.search({ ...ONE_NEWEST, ownerType, ownerId, includeSettled: true });
    return page.items[0] ?? null;
}

/** An agent's contracts with their agencies, or an agency's with its agents. */
async function loadContracts(ownerType: AccountOwnerType, ownerId: string) {
    const query = { page: 1, limit: EXPOSURE_LIMIT, sort: { field: 'createdAt', direction: -1 as const } };

    if (ownerType === 'agent') return (await contracts.listForAgent(ownerId, query)).items;
    if (ownerType === 'agency') return (await contracts.listForAgency(ownerId, query)).items;
    return [];
}

/**
 * The newest payout in one state.
 *
 * `payout_requests` carries a partial unique index on `(owner_type, owner_id)` where
 * `status: 'pending'`, so the pending call returns at most one row by construction — which is
 * why the account DTO reports `pendingCount` as 0 or 1 rather than aggregating a total.
 */
async function loadPayout(
    ownerType: AccountOwnerType,
    ownerId: string,
    status: string,
    sortField: string,
) {
    const page = await payouts.search({
        ownerType,
        ownerId,
        status,
        page: 1,
        limit: 1,
        sort: { field: sortField, direction: -1 },
    });
    return page.items[0] ?? null;
}

/**
 * Unresolved cash discrepancies against this owner. `null` for a vendor — mechanism 4 of the
 * account DTO: a vendor cannot have one, which is not the same as having none.
 */
async function countOpenDiscrepancies(
    ownerType: AccountOwnerType,
    ownerId: string,
): Promise<number | null> {
    if (ownerType === 'vendor') return null;

    const page = await discrepancies.search({
        ...ONE_NEWEST,
        status: 'open',
        ...(ownerType === 'agent' ? { agentId: ownerId } : { agencyId: ownerId }),
    });
    return page.total;
}

/**
 * Allocations whose COD cash the platform has allocated and NOT physically received — the
 * earnings-side view of a stuck remittance, and the reason a balance can sit `held` with its
 * release date long past.
 */
async function countUnsettledCollections(
    ownerType: AccountOwnerType,
    ownerId: string,
): Promise<number> {
    const page = await allocations.search({
        ...ONE_NEWEST,
        beneficiaryType: ownerType,
        beneficiaryId: ownerId,
        unsettledOnly: true,
    });
    return page.total;
}

// ─────────────────────────────────────────────────────────────────────────────
// Small shapers
// ─────────────────────────────────────────────────────────────────────────────

/** A feed row plus its sort keys, read off the SOURCE document rather than the DTO. */
function candidate(
    row: AccountActivityDto,
    at: Date,
    id: { toString(): string },
): ActivityCandidate<AccountActivityDto> {
    return { row, at, id: id.toString() };
}

