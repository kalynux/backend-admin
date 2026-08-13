import { z } from 'zod';
import { listQuery, paginationFields } from '../../../core/http/list-query';
import {
    boolFlag,
    dateRangeFields,
    dateRangeRule,
    idParam,
    objectId,
    reasonText,
} from '../../../core/validation/common.schemas';
import { AUDIT_ACTION_NAMES, AuditAction } from '../../audit/domain/audit.catalog';
import { AUDIT_STATUSES } from '../../audit/domain/audit.types';

/** Request shapes for `/api/v1/money`. */

export const PayoutIdParamSchema = idParam('payoutId', 'payout request');
export const AllocationIdParamSchema = idParam('allocationId', 'earnings allocation');
export const TransactionIdParamSchema = idParam('transactionId', 'payment transaction');

/** How far back one page of a money list may reach (ADR-005 D-14). */
export const MONEY_MAX_RANGE_DAYS = 366;

/**
 * ── Every jovi-mall vocabulary on this mount is a BOUNDED STRING, not an enum ──
 *
 * The opposite call from `BILLING_OWNER_TYPES`, and for the reason that validator gives
 * for making it: **this service writes against none of them.** The two writes here —
 * `mark-paid` and `reject` — carry a payout id, an optional reference and a reason. Not
 * one of them names a status, an owner type, a gateway or an entry type, so there is no
 * request this service can build that a pinned copy would protect.
 *
 * What a pinned copy WOULD do is go stale in silence. `PaymentStatus` has six members
 * today and `EarningsLedgerReasonCode` seven; a value added on the other side turns a
 * filter into a 400 for a row the list is already showing. ADR-005 D-17: a vocabulary that
 * is not ours is validated for shape, not membership.
 *
 * The one thing a bounded string costs is that `?status=PAID` (wrong case) answers an
 * empty page rather than a 400. That is honest — it is a filter matching nothing, which is
 * exactly what it is.
 */
const platformTerm = z.string().trim().min(1).max(40);

// ─────────────────────────────────────────────────────────────────────────────
// Earnings — the platform ledger and the allocations behind it
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the platform ledger may be ordered by.
 *
 * `earnings_ledgers` carries exactly one index — `{owner_type, owner_id, created_at: -1}` —
 * and this endpoint is always scoped to the platform singleton, so `-createdAt` is served
 * by it end to end. `amount` is offered because "the largest movement in this window" is a
 * real question, and it is an in-memory sort over the matched set rather than a scan: the
 * owner terms still select through the index first.
 */
export const LEDGER_SORT = {
    createdAt: 'created_at',
    amount: 'amount',
} as const;

/**
 * `GET /money/earnings/platform/ledger`.
 *
 * `entryType` is the filter this endpoint exists for. A `hold` is money arriving in escrow
 * and a `release` is the same money becoming withdrawable — reading a page that mixes them
 * without being able to separate them is how a ledger gets double-counted by eye.
 */
export const ListPlatformLedgerQuerySchema = listQuery(LEDGER_SORT, '-createdAt', {
    entryType: platformTerm.optional(),
    reasonCode: platformTerm.optional(),
    sourceType: platformTerm.optional(),
    ...dateRangeFields(),
}).superRefine(dateRangeRule({ maxDays: MONEY_MAX_RANGE_DAYS }));

/**
 * `GET /money/earnings/accounts` — delegated (D-7), so no sort of ours.
 *
 * jovi-mall ranks these itself, by what is withdrawable, and a `sort` parameter here would
 * be a promise this service cannot keep: the ordering happens in the other process, over
 * rows it never sends. Page and filter only.
 */
export const ListEarningsAccountsQuerySchema = z
    .object({
        ...paginationFields,
        ownerType: platformTerm.optional(),
    })
    .strict();

export const ALLOCATION_SORT = {
    createdAt: 'created_at',
    amount: 'amount',
    holdReleaseAt: 'hold_release_at',
} as const;

/**
 * `GET /money/earnings/allocations` — the collection with no admin surface at all until now.
 *
 * Three filters carry the whole point of the endpoint, and they answer one question in
 * three ways: **why has this money not been released?**
 *
 *   `status=held` + `holdReleaseAt` sort   the hold window has not elapsed
 *   `requiresCashSettlement=true`          COD, and the platform has not physically
 *                                          received the cash yet
 *   `unsettledOnly=true`                   the narrow form of the above — cash is required
 *                                          and `cash_settled_at` is still null, which is
 *                                          the state a stuck remittance produces
 *
 * The last is a filter rather than something a client derives, because "required AND not
 * yet settled" is a two-field predicate and a client that composes it wrongly gets a
 * plausible page instead of an error.
 */
export const ListAllocationsQuerySchema = listQuery(ALLOCATION_SORT, '-createdAt', {
    beneficiaryType: platformTerm.optional(),
    beneficiaryId: objectId.optional(),
    status: platformTerm.optional(),
    sourceType: platformTerm.optional(),
    sourceId: objectId.optional(),
    requiresCashSettlement: boolFlag.optional(),
    unsettledOnly: boolFlag.default(false),
    ...dateRangeFields(),
}).superRefine(dateRangeRule({ maxDays: MONEY_MAX_RANGE_DAYS }));

// ─────────────────────────────────────────────────────────────────────────────
// Payout requests — the queue where money leaves the platform
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `payout_requests` carries `{status, created_at: -1}` and `{owner_type, owner_id, status}`,
 * which is exactly how this queue is opened: the pending ones, newest first, or one owner's
 * history. `amount` is the third question an operator asks — "what is the largest thing
 * waiting" — and `resolvedAt` orders the settled tail.
 */
export const PAYOUT_SORT = {
    createdAt: 'created_at',
    amount: 'amount',
    resolvedAt: 'resolved_at',
} as const;

export const ListPayoutsQuerySchema = listQuery(PAYOUT_SORT, '-createdAt', {
    status: platformTerm.optional(),
    ownerType: platformTerm.optional(),
    ownerId: objectId.optional(),
    /** `manual` (the owner asked) vs `auto_threshold` (the platform opened it for them). */
    origin: platformTerm.optional(),
    ...dateRangeFields(),
}).superRefine(dateRangeRule({ maxDays: MONEY_MAX_RANGE_DAYS }));

export const PAYOUT_ACTIVITY_SORT = { occurredAt: 'occurred_at' } as const;

/**
 * DERIVED from the audit catalog, never typed out — the same rule `AGENT_AUDIT_ACTIONS`
 * follows. A fourth `money.payouts.*` action should widen this filter automatically, or the
 * dashboard cannot filter on a row it is already showing.
 */
export const PAYOUT_AUDIT_ACTIONS = AUDIT_ACTION_NAMES.filter((action) =>
    action.startsWith('money.payouts.'),
) as [AuditAction, ...AuditAction[]];

export const ListPayoutActivityQuerySchema = listQuery(PAYOUT_ACTIVITY_SORT, '-occurredAt', {
    action: z.enum(PAYOUT_AUDIT_ACTIONS).optional(),
    status: z.enum(AUDIT_STATUSES as unknown as [string, ...string[]]).optional(),
    ...dateRangeFields(),
}).superRefine(dateRangeRule({ maxDays: MONEY_MAX_RANGE_DAYS }));

/**
 * Mark a payout paid. The body is a reference and nothing else — **the amount is not here**,
 * and that is the subtlety the dual-control rule turns on.
 *
 * `LARGE_PAYOUT.when` reads a payload, and the amount lives on the row rather than in the
 * request. The controller therefore reads the payout first and builds the payload from what
 * it found, so the threshold is evaluated against the money that will actually move rather
 * than against a number the caller supplied. A client that could name the amount could name
 * 1,999,999 and skip the second administrator.
 *
 * `.strict()` for that reason and no other: an `amount` key arriving here must be a 400,
 * not a silently ignored field.
 */
export const MarkPaidSchema = z
    .object({
        reference: z.string().trim().min(1).max(200).optional(),
    })
    .strict();

/**
 * Reject a payout — the money returns to the owner's available balance.
 *
 * jovi-mall requires the reason too. Validating it here means the caller hears it in this
 * service's error shape rather than as a wrapped `PLATFORM_OPERATION_REJECTED`, and the
 * reason reaches the audit payload whether or not the delegated call succeeds.
 */
export const RejectPayoutSchema = z
    .object({
        reason: reasonText('A reason is required to reject a payout request', { min: 1, max: 500 }),
    })
    .strict();

// ─────────────────────────────────────────────────────────────────────────────
// Gateway settlements — what a customer actually paid, and what came back
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `payment_transactions` is the one collection on this mount whose fields are **camelCase
 * in the database**. It predates the platform's snake_case convention and was never
 * migrated, so the map below looks like an identity mapping and is not one: `amount` on the
 * wire is `amountSnapshot` in Mongo.
 *
 * `{gateway, status, createdAt: -1}` and `{userId, createdAt: -1}` are the indexes behind
 * the two ways this list is opened.
 */
export const PAYMENT_SORT = {
    createdAt: 'createdAt',
    amount: 'amountSnapshot',
} as const;

export const ListPaymentsQuerySchema = listQuery(PAYMENT_SORT, '-createdAt', {
    status: platformTerm.optional(),
    gateway: platformTerm.optional(),
    method: platformTerm.optional(),
    /** `primary` or `booking_balance` — a booking can be paid twice. */
    purpose: platformTerm.optional(),
    orderId: objectId.optional(),
    bookingId: objectId.optional(),
    /**
     * The payer. NOT one kind of id: an order payment stores a CUSTOMER id and a booking
     * payment a USER id, and which one a row carries depends on how it was created. The
     * filter matches whichever is stored, which is the only thing it can honestly do.
     */
    userId: objectId.optional(),
    ...dateRangeFields(),
}).superRefine(dateRangeRule({ maxDays: MONEY_MAX_RANGE_DAYS }));

/**
 * Refunds are grouped by `completedAt` for analytics, never by the original order date —
 * that is the collection's own stated rule — so both instants are sortable and the default
 * is creation order, which is the one that always has a value.
 */
export const REFUND_SORT = {
    createdAt: 'createdAt',
    completedAt: 'completedAt',
    amount: 'refundAmount',
} as const;

export const ListRefundsQuerySchema = listQuery(REFUND_SORT, '-createdAt', {
    status: platformTerm.optional(),
    gateway: platformTerm.optional(),
    vendorId: objectId.optional(),
    orderId: objectId.optional(),
    bookingId: objectId.optional(),
    paymentTransactionId: objectId.optional(),
    ...dateRangeFields(),
}).superRefine(dateRangeRule({ maxDays: MONEY_MAX_RANGE_DAYS }));

export type ListPlatformLedgerQuery = z.infer<typeof ListPlatformLedgerQuerySchema>;
export type ListEarningsAccountsQuery = z.infer<typeof ListEarningsAccountsQuerySchema>;
export type ListAllocationsQuery = z.infer<typeof ListAllocationsQuerySchema>;
export type ListPayoutsQuery = z.infer<typeof ListPayoutsQuerySchema>;
export type ListPayoutActivityQuery = z.infer<typeof ListPayoutActivityQuerySchema>;
export type ListPaymentsQuery = z.infer<typeof ListPaymentsQuerySchema>;
export type ListRefundsQuery = z.infer<typeof ListRefundsQuerySchema>;
export type MarkPaidBody = z.infer<typeof MarkPaidSchema>;
export type RejectPayoutBody = z.infer<typeof RejectPayoutSchema>;
