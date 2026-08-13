import { z } from 'zod';
import { listQuery } from '../../../core/http/list-query';
import {
    boolFlag,
    dateRangeFields,
    dateRangeRule,
    idParam,
    objectId,
    reasonText,
    searchTerm,
} from '../../../core/validation/common.schemas';
import { AUDIT_ACTION_NAMES, AuditAction } from '../../audit/domain/audit.catalog';
import { AUDIT_STATUSES } from '../../audit/domain/audit.types';

/** Request shapes for `/api/v1/agents`. */

export const AgentIdParamSchema = idParam('agentId', 'delivery agent');

/**
 * jovi-mall's agent vocabularies, pinned.
 *
 * Pinned — unlike the contract-status filter, which is a bounded string — because this
 * service WRITES all three. A filter offering a value no verb here can produce, or a write
 * body accepting one jovi-mall would refuse, is worse than a compile-time copy: the first
 * advertises a search that returns nothing, the second turns a typo into a 400 from
 * another service.
 */
export const AGENT_STATUSES = ['pending_verification', 'active', 'inactive', 'suspended'] as const;
export const AGENT_KYC_STATUSES = ['unverified', 'pending', 'verified', 'rejected'] as const;
export const AGENT_AVAILABILITY_STATES = ['online', 'offline', 'on_break'] as const;
export const AGENT_WORKING_STATES = ['idle', 'working', 'at_capacity'] as const;

/**
 * What this list may be ordered by: **wire name → `jovi_mall` field path**.
 *
 * `createdAt` and `updatedAt` are backed by indexes added in the same change —
 * `delivery_agents` had five indexes and none on a timestamp, so the default order was a
 * collection scan plus a blocking sort requestable from a query string.
 *
 * `trustScore` is the one entry with a caveat worth stating: it is served from the
 * directory index `{status, kyc.status, platform_ban.banned, cod.trust_score:-1}` only
 * when all three leading keys are equality-bound, i.e. when the corresponding filters are
 * supplied. Unfiltered it is a blocking sort — acceptable, because sorting a whole roster
 * by trust is a report, not a screen, and the bound is one page.
 *
 * `name` is deliberately absent: no index, and ADR-005 D-13 — nobody orders a collection
 * by an unindexed field from a query string.
 */
export const AGENT_SORT = {
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    trustScore: 'cod.trust_score',
} as const;

export const AGENT_MAX_RANGE_DAYS = 366;

export const SearchAgentsQuerySchema = listQuery(AGENT_SORT, '-createdAt', {
    /** Matches the name, the email, the phone, or — when it is a 24-hex string — the id. */
    search: searchTerm.optional(),
    status: z.enum(AGENT_STATUSES).optional(),
    kycStatus: z.enum(AGENT_KYC_STATUSES).optional(),
    availability: z.enum(AGENT_AVAILABILITY_STATES).optional(),
    workingState: z.enum(AGENT_WORKING_STATES).optional(),
    /**
     * The four independent axes, each filterable on its own.
     *
     * They are separate because collapsing any two makes "is this agent offline, or just
     * full?" unanswerable — the agent model says so by name. An administrator asking "who
     * is banned but still shows as active" is asking a question only independent filters
     * can express.
     */
    banned: boolFlag.optional(),
    trackingAllowed: boolFlag.optional(),
    /** `boolFlag`, never `z.coerce.boolean()` — the latter reads `"false"` as true. */
    ...dateRangeFields(),
}).superRefine(dateRangeRule({ maxDays: AGENT_MAX_RANGE_DAYS }));

/**
 * The agent's contracts. `status` is a bounded string, not a pinned enum: `ContractStatus`
 * is jovi-mall's seven-value vocabulary and this service never writes it, so ADR-005 D-17
 * says validate the shape and let the owner own the membership. It gained `withdrawn`
 * recently; a copy here would have gone stale silently.
 */
export const ListContractsQuerySchema = listQuery(
    { createdAt: 'created_at' } as const,
    '-createdAt',
    {
        status: z.string().trim().min(1).max(40).optional(),
        primaryOnly: boolFlag.optional(),
    },
);

/**
 * Eligibility is PAIRWISE — `evaluate(agentId, agencyId)` — so the agency is required.
 *
 * Not defaulted to "any": there is no such verdict. An agent is eligible to be dispatched
 * BY a particular agency, because the rule set includes having an approved contract with
 * that agency. A single-argument answer would have to pick one silently, and would report
 * a blocker the caller was not asking about.
 */
export const EligibilityQuerySchema = z.object({
    agencyId: objectId,
}).strict();

export const AGENT_ACTIVITY_SORT = { occurredAt: 'occurred_at' } as const;

/**
 * DERIVED from the audit catalog, never typed out — adding an eighth `agents.*` action
 * should widen this filter automatically, or the dashboard cannot filter on a row it is
 * already showing.
 */
export const AGENT_AUDIT_ACTIONS = AUDIT_ACTION_NAMES.filter((action) =>
    action.startsWith('agents.'),
) as [AuditAction, ...AuditAction[]];

export const ListAgentActivityQuerySchema = listQuery(AGENT_ACTIVITY_SORT, '-occurredAt', {
    action: z.enum(AGENT_AUDIT_ACTIONS).optional(),
    status: z.enum(AUDIT_STATUSES as unknown as [string, ...string[]]).optional(),
    ...dateRangeFields(),
}).superRefine(dateRangeRule({ maxDays: AGENT_MAX_RANGE_DAYS }));

// ─────────────────────────────────────────────────────────────────────────────
// Writes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Set the account status. A reason is required to suspend, and refused otherwise.
 *
 * Refused rather than ignored: a reason silently dropped on an activation would be a
 * message an administrator believes they recorded and did not. jovi-mall enforces the
 * requirement too; validating here means the caller hears it in this service's error
 * shape rather than as a wrapped `PLATFORM_OPERATION_REJECTED`.
 */
export const SetAgentStatusSchema = z
    .object({
        status: z.enum(AGENT_STATUSES),
        reason: reasonText('A reason is required to suspend an agent').optional(),
    })
    .strict()
    .superRefine((body, ctx) => {
        if (body.status === 'suspended' && !body.reason) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['reason'],
                message: 'A reason is required to suspend an agent',
            });
        }
    });

/**
 * Review the identity documents. This is the write that decides whether an agent may work
 * at all — `assertEligible` passes only on `verified`.
 *
 * `rejectionReason` is required on `rejected` for the same reason a suspension reason is:
 * the agent is told, and "your documents were rejected" with no cause is an unactionable
 * message that generates a support ticket by construction.
 */
export const ReviewAgentKycSchema = z
    .object({
        status: z.enum(AGENT_KYC_STATUSES),
        /** Free-form pointer to whatever document set was checked, off-platform. */
        reference: z.string().trim().max(200).optional(),
        rejectionReason: reasonText('Say why the documents were rejected').optional(),
    })
    .strict()
    .superRefine((body, ctx) => {
        if (body.status === 'rejected' && !body.rejectionReason) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['rejectionReason'],
                message: 'A reason is required to reject an agent’s documents',
            });
        }
    });

/**
 * Set whether the agent may be tracked.
 *
 * A reason is required to DISABLE. This is the field an agent is most likely to dispute —
 * it makes them undispatchable — and unlike KYC there is no document to point at.
 */
export const SetTrackingSchema = z
    .object({
        allowed: z.boolean(),
        reason: reasonText('Say why tracking is being disabled').optional(),
    })
    .strict()
    .superRefine((body, ctx) => {
        if (!body.allowed && !body.reason) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['reason'],
                message: 'A reason is required to disable tracking',
            });
        }
    });

/**
 * Set the agent's whole COD pool, which every contract sub-allocates from.
 *
 * The bounds are NOT validated here beyond being a non-negative finite number.
 * jovi-mall owns `COD_THRESHOLD_MIN`/`MAX` and, more importantly, owns the rule this write
 * can actually fail: lowering the pool below what its contracts have already allocated is
 * refused there, and that check needs the contracts. A copy of the bounds here would be a
 * second definition of a limit this service does not own, drifting silently.
 */
export const SetThresholdSchema = z
    .object({
        maxThreshold: z.number().finite().nonnegative(),
    })
    .strict();

/** Banning is permanent-shaped and always carries a reason. */
export const BanAgentSchema = z.object({
    reason: reasonText('A reason is required to ban an agent'),
});

/**
 * Moving an agent between agencies. Admin-only for a reason worth restating: an agency
 * must not be able to pull an agent off a rival's roster.
 */
export const TransferAgentSchema = z
    .object({
        agentId: objectId,
        fromAgencyId: objectId,
        toAgencyId: objectId,
        reason: reasonText('Say why the agent is being transferred'),
    })
    .strict()
    .refine((body) => body.fromAgencyId !== body.toAgencyId, {
        path: ['toAgencyId'],
        message: 'The destination agency must differ from the source',
    });

export type SearchAgentsQuery = z.infer<typeof SearchAgentsQuerySchema>;
export type ListContractsQuery = z.infer<typeof ListContractsQuerySchema>;
export type EligibilityQuery = z.infer<typeof EligibilityQuerySchema>;
export type ListAgentActivityQuery = z.infer<typeof ListAgentActivityQuerySchema>;
export type SetAgentStatusBody = z.infer<typeof SetAgentStatusSchema>;
export type ReviewAgentKycBody = z.infer<typeof ReviewAgentKycSchema>;
export type SetTrackingBody = z.infer<typeof SetTrackingSchema>;
export type SetThresholdBody = z.infer<typeof SetThresholdSchema>;
export type BanAgentBody = z.infer<typeof BanAgentSchema>;
export type TransferAgentBody = z.infer<typeof TransferAgentSchema>;
