import { z } from 'zod';
import { listQuery } from '../../../core/http/list-query';
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
import {
    EXTERNAL_SETTLEMENT_METHODS,
    REFUND_CHANNELS,
    REFUND_PAYMENT_CHANNELS,
    REFUND_REASON_KINDS,
    REFUND_REQUESTER_ROLES,
    REFUND_REQUEST_STATUSES,
    REFUND_SOURCE_KINDS,
} from '../domain/refund-vocabulary';

/**
 * Request shapes for `/api/v1/refunds`.
 *
 * ── Strictness, decided per shape ─────────────────────────────────────────────
 * Every WRITE body is `.strict()`, for the money module's reason (`MarkPaidSchema`): the
 * four-eyes amount is read off the ROW, and a body able to name an `amount` on approve could
 * name 1,999,999 and skip the second administrator — so an unexpected key is a 400, never a
 * silently dropped field. The list query uses `listQuery` and is lenient like every other list
 * (`api-doc/api/README.md` § Filtering); the eligibility query is a lookup and lenient too.
 */

export const RefundIdParamSchema = idParam('refundId', 'refund request');

/** Sources whose refund reverses a purchase, and is therefore full only. */
const BILLING_SOURCE_KINDS: ReadonlySet<string> = new Set(['plan_purchase', 'credit_topup']);
export const ProofFileIdParamSchema = idParam('fileId', 'proof file');

/** How far back one page of the queue may reach — the money mount's bound. */
export const REFUND_MAX_RANGE_DAYS = 366;

export const REFUND_REQUEST_SORT = {
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    grossAmount: 'gross_amount',
} as const;

/**
 * `GET /refunds` — the queue. `?open=true` is the working view: the five statuses the
 * one-open-per-source index treats as open. An explicit `status` wins over it.
 */
export const ListRefundRequestsQuerySchema = listQuery(REFUND_REQUEST_SORT, '-createdAt', {
    status: z.enum(REFUND_REQUEST_STATUSES).optional(),
    open: boolFlag.optional(),
    sourceKind: z.enum(REFUND_SOURCE_KINDS).optional(),
    sourceId: objectId.optional(),
    vendorId: objectId.optional(),
    customerId: objectId.optional(),
    requesterRole: z.enum(REFUND_REQUESTER_ROLES).optional(),
    /** An administrator's wi-admin id, or a vendor's user id — whoever raised it. */
    requesterId: objectId.optional(),
    channel: z.enum(REFUND_CHANNELS).optional(),
    paymentChannel: z.enum(REFUND_PAYMENT_CHANNELS).optional(),
    ...dateRangeFields(),
}).superRefine(dateRangeRule({ maxDays: REFUND_MAX_RANGE_DAYS }));

/**
 * `GET /refunds/eligibility` — what may be refunded on one source, and how. Delegated.
 *
 * jovi-mall's query is `.strict()` (an unknown parameter is a 400 there), so the gateway
 * forwards exactly these five keys and nothing else; this side stays lenient like every lookup
 * and DROPS anything it does not name rather than passing it on. The three optional keys steer
 * the preview, never the money: `reasonKind` picks which row `maxRefundable` reports,
 * `itemDefective` matters only under `customer_reimbursed_if_defect`, and `amount` decides
 * whether `above_policy_maximum` appears in `overrides`.
 */
export const RefundEligibilityQuerySchema = z.object({
    sourceKind: z.enum(REFUND_SOURCE_KINDS),
    sourceId: objectId,
    reasonKind: z.enum(REFUND_REASON_KINDS).optional(),
    itemDefective: boolFlag.optional(),
    /** Whole XAF — jovi-mall refuses a fraction. */
    amount: z.coerce.number().int().positive().optional(),
});

/**
 * A mobile-money number an administrator TYPES (R-7). E.164 after whitespace is removed —
 * jovi-mall normalises the payer's stored number (D-6) but refuses a typed one it cannot read,
 * so this refuses it first, in this service's error shape.
 */
const typedPhone = z
    .string()
    .transform((value) => value.replace(/[\s().-]/g, ''))
    .pipe(z.string().regex(/^\+[1-9]\d{7,14}$/, 'Type the number in international form, e.g. +237 6XX XXX XXX'));

/**
 * `POST /refunds` — raise a request.
 *
 * ── R-7, enforced at the door ─────────────────────────────────────────────────
 * A typed `destination` without `destinationProofFileId` (the picture of the customer's
 * message giving that number) is a 400 here rather than a wrapped 422
 * `REFUND_DESTINATION_PROOF_REQUIRED` from jovi-mall — and a proof with no typed destination
 * is refused too, because it would attach a picture to nothing.
 *
 * `approveNow` asks this service to approve straight after creating. It is honoured only when
 * the caller holds `orders.refund` AND the destination was not typed (a typed number needs a
 * SECOND administrator), and it goes through the same approve path as `/approve`, four-eyes
 * included. There is no `requestedByRole`: this service decides it from the caller.
 */
export const CreateRefundRequestSchema = z
    .object({
        sourceKind: z.enum(REFUND_SOURCE_KINDS),
        sourceId: objectId,
        /** Whole XAF. Omitted → jovi-mall refunds the maximum refundable. */
        amount: z.number().int().positive().optional(),
        reasonKind: z.enum(REFUND_REASON_KINDS),
        reason: reasonText('Say why this refund is owed', { min: 3, max: 1000 }),
        itemDefective: z.boolean().optional(),
        /**
         * Confirms going past the VENDOR's return policy (the eligibility read's `overrides[]`).
         * Passed through exactly as sent and NEVER set by this service: without it, a refund the
         * policy would not allow is jovi-mall's `422 REFUND_POLICY_OVERRIDE_REQUIRED` carrying
         * `details.overrides`, and the administrator re-sends with it once they have read them.
         */
        overridePolicy: z.boolean().optional(),
        destination: z
            .object({
                phone: typedPhone,
                /** Optional: the name on the customer's message, when it gives one. */
                name: z.string().trim().min(1).max(120).optional(),
            })
            .strict()
            .optional(),
        destinationProofFileId: objectId.optional(),
        approveNow: z.boolean().optional(),
        /** The support ticket this refund was raised from — stored on the request as `ticketId`. */
        ticketId: objectId.optional(),
    })
    .strict()
    .superRefine((body, ctx) => {
        // Billing (plan purchase / credit top-up): completing the refund REVERSES what was
        // bought — the plan downgraded, the credits debited back — and neither reverses in part,
        // so jovi-mall refuses anything but the full amount (`422 REFUND_NOT_ELIGIBLE`, reason
        // `billing_full_refund_only`). Stricter here: `amount` is not taken at all — omitted
        // means "the full remaining amount", which is the only refund there is.
        if (BILLING_SOURCE_KINDS.has(body.sourceKind) && body.amount !== undefined) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['amount'],
                message: 'A plan purchase or credit top-up is refunded in full — omit the amount',
            });
        }
        if (body.destination && !body.destinationProofFileId) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['destinationProofFileId'],
                message: 'A typed number needs a picture of the customer’s message giving it (upload it first)',
            });
        }
        if (!body.destination && body.destinationProofFileId) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['destinationProofFileId'],
                message: 'A destination proof only makes sense with a typed destination',
            });
        }
    });

/** Approving takes no body. `.strict()` on an empty object — see the header. */
export const ApproveRefundSchema = z.object({}).strict();

export const RejectRefundSchema = z
    .object({
        reason: reasonText('A reason is required to reject a refund request', { min: 3, max: 500 }),
    })
    .strict();

/** Retrying a failed transfer takes no body: the same reference is reused by jovi-mall. */
export const RetryRefundSchema = z.object({}).strict();

/**
 * Record a refund paid OUTSIDE the platform (R-7b). The proof is mandatory — the picture is the
 * only evidence money left by a channel the platform cannot see.
 */
export const SettleExternalRefundSchema = z
    .object({
        method: z.enum(EXTERNAL_SETTLEMENT_METHODS),
        reference: z.string().trim().min(1).max(200).optional(),
        proofFileId: objectId,
    })
    .strict();

/**
 * Decide a transfer stuck in `sending` — the gateway never answered. `note` is the only record
 * of why the administrator believed it did or did not arrive; jovi-mall refuses a request
 * younger than the reconciliation sweep's minimum age.
 */
export const ResolveUnknownRefundSchema = z
    .object({
        outcome: z.enum(['arrived', 'failed']),
        note: reasonText('Say why — at least 10 characters', { min: 10, max: 500 }),
    })
    .strict();

export const REFUND_ACTIVITY_SORT = { occurredAt: 'occurred_at' } as const;

/** DERIVED from the audit catalog, like `PAYOUT_AUDIT_ACTIONS`, so it cannot drift. */
export const REFUND_AUDIT_ACTIONS = AUDIT_ACTION_NAMES.filter((action) =>
    action.startsWith('orders.refund.'),
) as [AuditAction, ...AuditAction[]];

export const ListRefundActivityQuerySchema = listQuery(REFUND_ACTIVITY_SORT, '-occurredAt', {
    action: z.enum(REFUND_AUDIT_ACTIONS).optional(),
    status: z.enum(AUDIT_STATUSES as unknown as [string, ...string[]]).optional(),
    ...dateRangeFields(),
}).superRefine(dateRangeRule({ maxDays: REFUND_MAX_RANGE_DAYS }));

export type ListRefundRequestsQuery = z.infer<typeof ListRefundRequestsQuerySchema>;
export type RefundEligibilityQuery = z.infer<typeof RefundEligibilityQuerySchema>;
export type CreateRefundRequestBody = z.infer<typeof CreateRefundRequestSchema>;
export type RejectRefundBody = z.infer<typeof RejectRefundSchema>;
export type SettleExternalRefundBody = z.infer<typeof SettleExternalRefundSchema>;
export type ResolveUnknownRefundBody = z.infer<typeof ResolveUnknownRefundSchema>;
export type ListRefundActivityQuery = z.infer<typeof ListRefundActivityQuerySchema>;
