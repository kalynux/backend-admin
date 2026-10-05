/**
 * The refund queue's vocabularies — contract § 11.1 of REFUND-FLOW-PLAN.md, copied.
 *
 * ── Why these are PINNED enums when the money module's are bounded strings ─────
 * The money module validates jovi-mall vocabularies for shape, not membership, because it
 * writes against none of them. This module does write: it sends `reasonKind`, `sourceKind` and
 * an external-settlement `method`, and a value jovi-mall does not know is a request that cannot
 * succeed. The statuses are pinned for a second reason: they are the queue's columns, fixed by
 * the cross-workstream contract, and the dashboard renders one tab per status.
 *
 * A status added on the jovi-mall side without this file moving turns `?status=<new>` into a
 * 400 rather than an empty page — loud, which is the direction to fail in for a money queue.
 */

export const REFUND_SOURCE_KINDS = ['order', 'booking', 'plan_purchase', 'credit_topup'] as const;
export type RefundSourceKind = (typeof REFUND_SOURCE_KINDS)[number];

export const REFUND_REQUEST_STATUSES = [
    'awaiting_approval',
    'approved',
    'waiting_for_cash',
    'sending',
    'completed',
    'failed',
    'rejected',
] as const;
export type RefundRequestStatus = (typeof REFUND_REQUEST_STATUSES)[number];

/** The statuses the partial unique index `refund_one_open_per_source` treats as OPEN. */
export const OPEN_REFUND_STATUSES: readonly RefundRequestStatus[] = [
    'awaiting_approval',
    'approved',
    'waiting_for_cash',
    'sending',
    'failed',
];

export const REFUND_REQUESTER_ROLES = ['vendor', 'admin', 'support', 'system', 'customer'] as const;
export const REFUND_CHANNELS = ['card_refund', 'payout', 'external'] as const;
export const REFUND_PAYMENT_CHANNELS = ['card', 'mobile_money', 'cod', 'billing'] as const;
export const REFUND_REASON_KINDS = ['cancellation', 'return', 'goodwill', 'dispute_settlement'] as const;
export const EXTERNAL_SETTLEMENT_METHODS = ['mobile_money', 'cash', 'bank', 'other'] as const;

/**
 * `refund_requests.earnings_impact`: `clawback` (the default — completing the refund recovers
 * earnings and the request pauses them while open) or `none` (delivery money that was never
 * allocated to anybody, e.g. a delivery-fee decrease refunded through the queue: nothing is
 * paused, nothing clawed back). A row written before the field existed reads as `clawback`.
 */
export const REFUND_EARNINGS_IMPACTS = ['clawback', 'none'] as const;

/**
 * Which statuses each verb may act on — the PRE-FLIGHT, not the control. jovi-mall enforces
 * the same rules under its own compare-and-set; this exists so a doomed action is refused here
 * with a clear code rather than queued for a second administrator who then cannot succeed.
 *
 * ⛔ `sending` appears in exactly one list: `resolveUnknown`. Rejecting or settling a request
 * whose transfer may already be in flight could pay the customer twice (plan § 3.1).
 */
export const ACTIONABLE_FROM = {
    approve: ['awaiting_approval'],
    reject: ['awaiting_approval', 'failed'],
    /**
     * `approved` too: a send refused BEFORE its claim (payouts switched off, a short float)
     * leaves the request `approved` with `transfer.failureReason`, and jovi-mall's claim starts
     * from `approved | failed` (`CLAIMABLE_STATUSES`). Without it such a request could only be
     * settled externally.
     */
    retry: ['approved', 'failed'],
    settleExternal: ['awaiting_approval', 'approved', 'waiting_for_cash', 'failed'],
    resolveUnknown: ['sending'],
} as const satisfies Record<string, readonly RefundRequestStatus[]>;

export type RefundVerb = keyof typeof ACTIONABLE_FROM;

/** The approve four-eyes threshold — `LARGE_REFUND` in the permission catalog, restated for docs. */
export const REFUND_FOUR_EYES_THRESHOLD = 2_000_000;
