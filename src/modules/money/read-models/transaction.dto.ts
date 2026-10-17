import { AllocationDto } from './money.dto';

/**
 * Wire shapes for `/api/v1/money/transactions` — one row per money movement, whatever
 * collection it lives in (BR-027, 2026-10-12).
 *
 * This file is the contract copy: `api-doc/api/transactions.md` names it, and the dashboard
 * mirrors it rather than transcribing a table. Vocabulary and shapes only — how a source row
 * becomes one of these is `domain/transaction-sources.ts`.
 *
 * ── Every field is required-and-nullable (ADR-005 D-16) ───────────────────────
 * `null`, never absent. A kind that has no gateway says `gateway: null`; it does not drop
 * the key.
 */

// ─────────────────────────────────────────────────────────────────────────────
// The vocabularies that are OURS — pinned enums, unlike the pass-through ones
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Which record a row is. `(kind, id)` names the source document.
 *
 * Eleven. BR-027 listed eight; `delivery_fee_refund` is delivery money an administrator
 * returned to a customer BY HAND, which writes no `refund_transactions` row (BR-027 D-3).
 * `cod_collection` (a customer paying cash at the door) and `earnings_adjustment` (refund debt
 * forgiven, or paid down by a returned payout) were added on the owner’s decision, BR-030.
 */
export const TRANSACTION_KINDS = [
    'payment',
    'plan_purchase',
    'credit_topup',
    'refund',
    'delivery_fee_refund',
    'payout',
    'cod_deposit',
    'cod_remittance',
    'cod_collection',
    'ledger_entry',
    'earnings_adjustment',
] as const;
export type TransactionKind = (typeof TRANSACTION_KINDS)[number];

/** `provider` — money on a payment rail · `cash` — COD cash handed over · `internal` — the earnings ledger. A property of the KIND. */
export const TRANSACTION_GROUPS = ['provider', 'cash', 'internal'] as const;
export type TransactionGroup = (typeof TRANSACTION_GROUPS)[number];

/**
 * From the PLATFORM's side — the opposite reading from the account feed, which is the owner's.
 *
 * ⚠ **A property of the kind, never of the status.** A failed payment is still `in`; `outcome`
 * says it failed. So "pay-ins that failed" is `direction=in&outcome=failed`, and nothing has
 * to be re-derived per status. The one row-dependent case is a COD deposit: `in` when the
 * agent paid the platform, `internal` when they paid their agency (the cash never reached us).
 */
export const TRANSACTION_DIRECTIONS = ['in', 'out', 'internal'] as const;
export type TransactionDirection = (typeof TRANSACTION_DIRECTIONS)[number];

/**
 * One word across every kind, beside the source's own `status`.
 *
 *   succeeded  the movement happened
 *   pending    opened, not finished
 *   failed     it did not happen: failed, cancelled or rejected
 *   reversed   it happened and was undone (a refunded payment, a reversed purchase)
 *   unknown    a status this service does not know yet — never guessed into another bucket
 */
export const TRANSACTION_OUTCOMES = ['succeeded', 'pending', 'failed', 'reversed', 'unknown'] as const;
export type TransactionOutcome = (typeof TRANSACTION_OUTCOMES)[number];

/** The `?role=` filter. A row's `party.role` may also read `platform_ai` (the bargain-fee account), which `role=platform` matches. */
export const TRANSACTION_ROLES = ['customer', 'vendor', 'agency', 'agent', 'platform'] as const;
export type TransactionRole = (typeof TRANSACTION_ROLES)[number];

// ─────────────────────────────────────────────────────────────────────────────
// The row
// ─────────────────────────────────────────────────────────────────────────────

export interface TransactionPartyDto {
    /** `customer` · `vendor` · `agency` · `agent` · `platform` · `platform_ai`. */
    role: string;
    /** `null` for the platform's own accounts, which have no id. */
    id: string | null;
    /** The business name where there is one (a Store, a Magazin). `null` when unresolved — never a guess. */
    name: string | null;
}

/** Ids of what the row touches. Fixed keys; `null` (or `[]`) where the kind has none. */
export interface TransactionLinksDto {
    orderIds: string[];
    bookingId: string | null;
    shipmentId: string | null;
    paymentTransactionId: string | null;
    refundRequestId: string | null;
    ticketId: string | null;
    allocationId: string | null;
    planId: string | null;
    vendorId: string | null;
    agencyId: string | null;
    /** The agent holding the cash of a `cod_collection`. */
    agentId: string | null;
    /** The payout whose return paid a debt down, on an `earnings_adjustment`. */
    payoutId: string | null;
}

export interface TransactionRowDto {
    kind: TransactionKind;
    /** The SOURCE document's id. */
    id: string;
    group: TransactionGroup;
    direction: TransactionDirection;
    /** Who paid or was paid. */
    party: TransactionPartyDto;
    /** Positive magnitude. The sign lives in `direction`. A refund's is the GROSS. */
    amount: number;
    /** `null` on a `ledger_entry` whose account could not be read. */
    currency: string | null;
    /** The source's own word, unchanged (`SUCCEEDED`, `paid`, `confirmed`, `hold`, …). */
    status: string;
    outcome: TransactionOutcome;
    /** The aggregator that carried it. `null` when no aggregator did. */
    gateway: string | null;
    /** What the payer paid with (`MTN` · `ORANGE` · `MOOV` · `CARD`); on a payout, the destination's own label. */
    provider: string | null;
    /** How it travelled: a payment's method, a payout's destination type, a refund's channel, a hand settlement's method. */
    method: string | null;
    reason: {
        /** Why the money moved. An open string — see the contract page for the set. */
        code: string;
        /** The stored human text where there is one (a refund's reason, a rejection reason, a plan code). */
        text: string | null;
    };
    /** The provider's or the payer's reference. */
    reference: string | null;
    /** OUR reference (`jm_…`), where the kind has one. */
    merchantRef: string | null;
    links: TransactionLinksDto;
    createdAt: string | null;
    /** When the money actually moved (paid, completed, confirmed). `null` until it has. */
    completedAt: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// The detail read
// ─────────────────────────────────────────────────────────────────────────────

/** What the six kinds with no page of their own carry beyond the row. One shape per kind, tagged. */
export type TransactionRecordDto =
    | {
          kind: 'refund';
          /** `card_refund` · `payout` · `external`; `null` on a legacy row. */
          channel: string | null;
          /** What the platform kept. `amount` on the row is the gross. */
          feeAmount: number | null;
          /** What the customer received. */
          netAmount: number | null;
          /** Who ASKED — not who approved. */
          initiatedBy: { id: string | null; role: string };
          vendor: { id: string | null; name: string | null };
      }
    | {
          kind: 'plan_purchase';
          planId: string | null;
          planCode: string;
          /** The subscription this purchase produced. `null` on a `paid` row means it was never applied. */
          subscriberPlanId: string | null;
      }
    | {
          kind: 'credit_topup';
          packCode: string;
          /** Credits bought. NOT money — never add it to `amount`. */
          credits: number;
      }
    | {
          kind: 'ledger_entry';
          accountId: string | null;
          entryType: string;
          balancesAfter: { pending: number; available: number };
          source: { type: string; id: string | null };
          /** The allocation this entry moved, with its hold and release dates. */
          allocation: AllocationDto | null;
      }
    | {
          kind: 'cod_collection';
          /** `order` (the goods, with any delivery fee) or `delivery_fee` (a fee alone, on an order paid online). */
          collects: string;
          /** The goods part of the row’s `amount`. */
          itemsAmount: number;
          /** The customer-paid delivery part of it. */
          deliveryFeeAmount: number;
          /** How much of this cash has reached the platform through confirmed remittances. */
          settledAmount: number;
          /** When the last of it did. `null` while any is still out. */
          settledAt: string | null;
          /** Who is holding the cash. */
          agent: { id: string | null; name: string | null };
      }
    | {
          kind: 'earnings_adjustment';
          /** `write_off` or `clawback_recovery` — the stored kind. */
          adjustment: string;
          /** The administrator who forgave the debt. `null` on a recovery, which nobody performs. */
          actor: { id: string | null; name: string | null } | null;
          /** On a recovery: what returned the payout — `rejected` or `ticket_failed`. `null` on a write-off. */
          payoutEvent: string | null;
      };

export interface TransactionDetailDto {
    transaction: TransactionRowDto;
    /** Kind-specific facts for the six kinds with no full read of their own; `null` for the rest. */
    record: TransactionRecordDto | null;
    /** The existing full read of this record (`/money/payments/<id>` …), for the kinds that have one. Relative to `/api/v1`. */
    recordPath: string | null;
    related: {
        orders: { id: string; orderNumber: string | null }[];
        /**
         * Every OTHER transaction on the same order(s) or booking that the caller may read,
         * oldest first. Empty for a kind with no order or booking.
         */
        transactions: TransactionRowDto[];
        /** `true` when there were more than the cap; filter the list by `orderId` for the rest. */
        truncated: boolean;
    };
}

/** What the caller was not sent, so a screen can say the list is partial. */
export interface TransactionWithheldDto {
    /** Kinds this caller holds no read for. */
    kinds: TransactionKind[];
    /** `true` when the platform's own ledger rows (`platform`, `platform_ai`) were left out. */
    platformAccounts: boolean;
}

/** One cell of `GET /money/transactions/summary` — a group-by of the list's own columns. */
export interface TransactionSummaryGroupDto {
    kind: TransactionKind;
    direction: TransactionDirection;
    outcome: TransactionOutcome;
    /** `null` for `ledger_entry` — ledger rows carry no currency of their own. */
    currency: string | null;
    count: number;
    /** Σ `amount` of the rows in this cell. */
    amount: number;
}
