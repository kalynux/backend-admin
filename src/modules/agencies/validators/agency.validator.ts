import { z } from 'zod';
import { listQuery } from '../../../core/http/list-query';
import {
    boolFlag,
    dateRangeFields,
    dateRangeRule,
    idParam,
    reasonText,
    searchTerm,
} from '../../../core/validation/common.schemas';
import { AUDIT_ACTION_NAMES, AuditAction } from '../../audit/domain/audit.catalog';
import { AUDIT_STATUSES } from '../../audit/domain/audit.types';

/** Request shapes for `/api/v1/agencies`. */

export const AgencyIdParamSchema = idParam('agencyId', 'delivery agency');

/**
 * jovi-mall's agency status vocabulary, pinned.
 *
 * Pinned rather than a bounded string — unlike the contract-event types below — because
 * this one is a THREE-value enum this service also writes against: `verify` moves
 * `pending_verification → active` and `deactivate` moves anything → `inactive`. A filter
 * that could name a fourth value would be a filter for a state no verb here produces.
 */
export const AGENCY_STATUSES = ['active', 'pending_verification', 'inactive'] as const;

/**
 * What this list may be ordered by: **wire name → `jovi_mall` field path**.
 *
 * Read by the schema below (as the allowlist) and by `AgencyReadRepository` (as the
 * translation), so a field can never be sortable-but-untranslatable.
 *
 * Every entry is backed by an index added in the same change — `delivery_agencies`
 * declared NONE before Phase 9 beyond the unique `user_id`. `{created_at: -1}` and
 * `{status: 1, created_at: -1}` cover the default order and its filtered form; `status`
 * sorts off the leading key of the second.
 *
 * **The business name is deliberately absent.** It lives on the Magazin, and this list
 * reaches it through a `$lookup`, so no index on the joined collection can serve a sort on
 * it — jovi-mall's own `findAllForAdmin` does exactly that and pays for it with a blocking
 * in-memory sort. Making it indexable would mean driving the pipeline from
 * `agency_magazins`, which loses every agency not yet provisioned one. The dashboard sorts
 * a rendered page by name instead.
 */
export const AGENCY_SORT = {
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    status: 'status',
} as const;

/** How far back one page of the directory may reach (ADR-005 D-14). */
export const AGENCY_MAX_RANGE_DAYS = 366;

export const SearchAgenciesQuerySchema = listQuery(AGENCY_SORT, '-createdAt', {
    /**
     * Matches the contact name, the email, the phone, the **business name** on the
     * Magazin, or — when the term is a 24-hex id — the agency id.
     *
     * The business-name branch is the reason this list cannot use the cheap paginate-then-
     * join shape: a filter on a joined field has to run before the page is cut. That is a
     * deliberate, documented cost at this collection's size, and it is the branch an
     * administrator actually types into — nobody searches an agency by its contact's
     * personal name.
     */
    search: searchTerm.optional(),
    status: z.enum(AGENCY_STATUSES).optional(),
    /**
     * Whether the business verification flag is set. Distinct from `status`, and worth its
     * own filter precisely because the two can disagree: `legit_verified` gates nothing
     * today (`requireLegitBusiness` has no call sites), so an agency can be `active` and
     * unverified. Finding those is the reason this filter exists.
     */
    verified: boolFlag.optional(),
    /** Whether the agency opted into auto-assignment. */
    autoAssign: boolFlag.optional(),
    country: z.string().trim().length(2).toUpperCase().optional(),
    ...dateRangeFields(),
}).superRefine(dateRangeRule({ maxDays: AGENCY_MAX_RANGE_DAYS }));

/**
 * The roster: which agents this agency holds contracts with.
 *
 * `status` is a bounded string rather than a pinned enum, and that is the opposite call
 * from `AGENCY_STATUSES` above — deliberately. `ContractStatus` is a seven-value
 * vocabulary jovi-mall owns and this service never writes; ADR-005 D-17 says a vocabulary
 * that is not ours gets validated for shape, not membership. Pinning it would mean a copy
 * that goes stale the moment jovi-mall adds an eighth (it added `withdrawn` recently), and
 * the failure mode of drift is a filter that silently matches nothing.
 */
export const ListRosterQuerySchema = listQuery(
    { createdAt: 'created_at' } as const,
    '-createdAt',
    {
        status: z.string().trim().min(1).max(40).optional(),
        /** Only the contracts that currently allocate COD headroom. */
        primaryOnly: boolFlag.optional(),
    },
);

/**
 * The contract-history feed — `agent_membership_events` for this agency.
 *
 * `type` is bounded-string for the same reason, and more sharply: that vocabulary has 24
 * values and has ALREADY drifted against its own Mongoose enum once in jovi-mall, which
 * silently stopped eight notification situations from ever being delivered. A second copy
 * here would be a third place to keep in step.
 */
export const CONTRACT_EVENT_SORT = { occurredAt: 'occurred_at' } as const;

export const ListContractEventsQuerySchema = listQuery(CONTRACT_EVENT_SORT, '-occurredAt', {
    type: z.string().trim().min(1).max(60).optional(),
    actorRole: z.enum(['agent', 'agency', 'admin', 'system']).optional(),
    ...dateRangeFields(),
}).superRefine(dateRangeRule({ maxDays: AGENCY_MAX_RANGE_DAYS }));

/**
 * The activity feed's query — the wi-admin audit trail, narrowed to one agency.
 *
 * Actions are DERIVED from the audit catalog, never typed out: adding a fourth
 * `agencies.*` action should widen this filter automatically, or the dashboard cannot
 * filter on a row it is already showing.
 */
export const AGENCY_AUDIT_ACTIONS = AUDIT_ACTION_NAMES.filter((action) =>
    action.startsWith('agencies.'),
) as [AuditAction, ...AuditAction[]];

export const AGENCY_ACTIVITY_SORT = { occurredAt: 'occurred_at' } as const;

export const ListAgencyActivityQuerySchema = listQuery(AGENCY_ACTIVITY_SORT, '-occurredAt', {
    action: z.enum(AGENCY_AUDIT_ACTIONS).optional(),
    status: z.enum(AUDIT_STATUSES as unknown as [string, ...string[]]).optional(),
    ...dateRangeFields(),
}).superRefine(dateRangeRule({ maxDays: AGENCY_MAX_RANGE_DAYS }));

/**
 * Approving a verification takes no body — there is nothing to say beyond "yes".
 *
 * A `reason` would be theatre: the act is an approval, the actor is stamped on the agency
 * and on the audit row, and a free-text field nobody is required to fill produces a column
 * of empty strings. Compare `deactivate` below, where the reason IS the record.
 */
export const VerifyAgencySchema = z.object({}).strict();

/**
 * Refusing a verification. The reason is required, and unlike the deactivation reason
 * below it is **forwarded to jovi-mall and stored there**, on
 * `kyc_details.rejection_reason`.
 *
 * That difference is the whole point of the two-sided rule ADR-006 D-7 draws: a
 * deactivation reason exists for an *administrator* reviewing the decision later, so the
 * audit row is the right home. A rejection reason exists for the **agency**, who has to
 * know what to fix and cannot read this database. Keeping it only in the audit trail
 * would leave them re-submitting the same unchanged application blind — and cost a
 * second review of it.
 *
 * The bound matches jovi-mall's `AdminRejectAgencyKycSchema` and the vendor's; a limit
 * only one side enforces is one the other side can violate.
 */
export const RejectAgencySchema = z.object({
    reason: reasonText('A reason is required to reject an agency’s verification'),
});

/**
 * Deactivation requires a reason, and this is new — jovi-mall's endpoint takes none.
 *
 * The cascade this triggers suspends every vendor product defaulting to the agency and
 * holds their in-flight order items. Vendors will ask why their listings went dark, and
 * without this the only answer available is "an administrator did it".
 *
 * It is carried in the AUDIT ROW's payload and nowhere else. No column is added to
 * `delivery_agencies`: ADR-006 D-7's reason for the `users.suspended_reason` column was
 * that a screen renders the block to the suspended party, and no agency-facing screen
 * shows a deactivation reason. Add the column when such a screen exists.
 */
export const DeactivateAgencySchema = z.object({
    reason: reasonText('A reason is required to deactivate an agency'),
});

/**
 * Reactivation's reason is optional, and the asymmetry is deliberate rather than an
 * oversight. Undoing a restriction needs no justification; imposing one does.
 */
export const ReactivateAgencySchema = z.object({
    reason: reasonText('Give a reason or omit it').optional(),
});

/*
 * `DelegatedPageQuerySchema` — a `.strict()` page schema for the delegated lists — was
 * declared here and **bound to no route**, verified by scan and removed 2026-09-12 (BR-022).
 * A strict schema nothing validates with is worse than none: it makes a `grep '.strict()'`
 * over-report which endpoints refuse an unknown parameter, which is precisely the question
 * BR-022 asked and the answer a reader would have got wrong. If a delegated list ever needs
 * its own query shape, declare it AND put it on the route's `validate.query` in one change.
 */

export type SearchAgenciesQuery = z.infer<typeof SearchAgenciesQuerySchema>;
export type ListRosterQuery = z.infer<typeof ListRosterQuerySchema>;
export type ListContractEventsQuery = z.infer<typeof ListContractEventsQuerySchema>;
export type ListAgencyActivityQuery = z.infer<typeof ListAgencyActivityQuerySchema>;
export type RejectAgencyBody = z.infer<typeof RejectAgencySchema>;
export type DeactivateAgencyBody = z.infer<typeof DeactivateAgencySchema>;
export type ReactivateAgencyBody = z.infer<typeof ReactivateAgencySchema>;
