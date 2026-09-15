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

/**
 * Request shapes for `/api/v1/cod`.
 *
 * ── How much to validate on a DELEGATED route ─────────────────────────────────
 * jovi-mall validates these again — it has to, since the internal API is reachable by
 * anything holding the service token. So the rule there is: validate what this service can
 * decide **without knowing jovi-mall's domain**, and let jovi-mall decide the rest.
 *
 * That means shape and bounds (is this an id, is `limit` sane) but NOT domain rules (is
 * this remittance still `declared`, does the amount exceed the liability). Re-implementing
 * a domain rule here would be a second copy that drifts — the exact thing ADR-004 exists
 * to prevent — and it would answer 400 for a state jovi-mall answers 409 for.
 *
 * ── The rule is different for a DIRECT read, and that split is new at Phase 11 ─
 * A direct read's query reaches Mongo through a filter this service builds, so its bounds
 * are not a courtesy — they are the whole guard. Those schemas carry a `SortMap`, a date
 * range cap and an id format, because nothing downstream will check them.
 */

export const RemittanceIdParamSchema = idParam('remittanceId', 'remittance');
export const DepositIdParamSchema = idParam('depositId', 'deposit');
export const DiscrepancyIdParamSchema = idParam('discrepancyId', 'discrepancy');
export const AgentIdParamSchema = idParam('agentId', 'agent');

/** How far back one page of a COD list may reach (ADR-005 D-14). */
export const COD_MAX_RANGE_DAYS = 366;

// ─────────────────────────────────────────────────────────────────────────────
// The two delegated lists — paged here, sorted there
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `paginationFields` rather than `listQuery`: the ordering of a delegated list is
 * jovi-mall's — it owns the query — and declaring a `SortMap` here would be this service
 * asserting a set of field paths in a collection it does not read. When jovi-mall's COD
 * endpoints grow a `sort` parameter, it is forwarded as an opaque string, not re-derived.
 *
 * These two stayed delegated at Phase 11 while their DETAILS became direct reads. See the
 * router header for why, and `cod.dto.ts` for the drift guard that keeps the two halves
 * naming their fields the same way.
 */
export const ListRemittancesQuerySchema = z.object({
    // Left as a loose string rather than an enum: the status vocabulary belongs to
    // jovi-mall, and pinning a copy here means a new status is silently unfilterable
    // until somebody remembers this file.
    status: z.string().min(1).optional(),
    agencyId: objectId.optional(),
    ...paginationFields,
});

export const ListDepositsQuerySchema = z.object({
    status: z.string().min(1).optional(),
    recipient: z.string().min(1).optional(),
    agencyId: objectId.optional(),
    ...paginationFields,
});

// ─────────────────────────────────────────────────────────────────────────────
// The direct reads
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Which side of the cash chain a holder is on.
 *
 * **Pinned**, and `platform` is refused — which is the point of pinning rather than a
 * side effect. `cod_cash_accounts` models a LIABILITY, and the platform is the creditor at
 * the top of the chain: an agent owes their agency, an agency owes the platform, and
 * nobody owes the platform's own account because it does not have one. A caller asking for
 * `ownerType=platform` has misread the model, and an empty 200 would let them go on
 * misreading it.
 */
export const COD_HOLDER_TYPES = ['agent', 'agency'] as const;
export type CodHolderType = (typeof COD_HOLDER_TYPES)[number];

/**
 * The holders list is ordered by BALANCE, largest first, and that is the default rather
 * than recency because the question this screen answers is "who is holding the most of our
 * money". `cod_cash_accounts` carries one index — the `(owner_type, owner_id)` unique —
 * so this is an in-memory sort over the filtered set. That set is bounded by the number of
 * agents and agencies on the platform, which is the same population jovi-mall's own
 * `listAgentsForAdmin` sorts the same way.
 */
export const HOLDER_SORT = {
    balance: 'balance',
    lastMovementAt: 'updated_at',
    createdAt: 'created_at',
} as const;

export const ListHoldersQuerySchema = listQuery(HOLDER_SORT, '-balance', {
    ownerType: z.enum(COD_HOLDER_TYPES).optional(),
    ownerId: objectId.optional(),
    /**
     * A settled account — balance zero — is not a holder, so it is out of scope by
     * default. It is still a row worth reading when reconciling ("did this agency's
     * liability actually reach zero"), which is what the flag is for.
     */
    includeSettled: boolFlag.default(false),
});

/**
 * The discrepancy queue.
 *
 * `status` and `type` stay loose strings: both vocabularies are jovi-mall's, this service
 * writes neither (a resolution moves `status`, and it is sent as `resolution`, validated
 * separately below), and `CodDiscrepancyType` has already grown once — `deposit_not_confirmed`
 * arrived with the two-sided deposit flow.
 */
export const DISCREPANCY_SORT = {
    createdAt: 'created_at',
    openedAt: 'opened_at',
    resolvedAt: 'resolved_at',
} as const;

export const ListDiscrepanciesQuerySchema = listQuery(DISCREPANCY_SORT, '-createdAt', {
    status: z.string().trim().min(1).max(40).optional(),
    type: z.string().trim().min(1).max(40).optional(),
    agencyId: objectId.optional(),
    agentId: objectId.optional(),
    ...dateRangeFields(),
}).superRefine(dateRangeRule({ maxDays: COD_MAX_RANGE_DAYS }));

/**
 * An agent's trust history — why their COD ceiling moved.
 *
 * Scoped to one agent by the path and by nothing else: there is no cross-agent trust feed,
 * because the question "what happened to this agent's score" is the only one the
 * collection answers, and a platform-wide list of score movements is a report rather than
 * a screen.
 */
export const TRUST_EVENT_SORT = { createdAt: 'created_at' } as const;

export const ListTrustEventsQuerySchema = listQuery(TRUST_EVENT_SORT, '-createdAt', {
    eventType: z.string().trim().min(1).max(40).optional(),
    ...dateRangeFields(),
}).superRefine(dateRangeRule({ maxDays: COD_MAX_RANGE_DAYS }));

// ─────────────────────────────────────────────────────────────────────────────
// The delegated writes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A reviewer's endorsement of a declared remittance or deposit.
 *
 * `.strict()` like its siblings: a body that could name a verdict could name "confirm", and
 * this route must never be a second way to settle cash. The only thing it accepts is a note.
 */
export const TriageCodSchema = z
    .object({
        note: z.string().trim().min(1).max(500).optional(),
    })
    .strict();

export type TriageCodBody = z.infer<typeof TriageCodSchema>;

export const RejectRemittanceSchema = z.object({
    reason: reasonText('A reason is required to reject a remittance'),
});

/**
 * Record cash an agent paid the platform DIRECTLY, bypassing the agency.
 *
 * `amount` is an integer in MINOR UNITS, matching jovi-mall's schema. It is bounded here
 * only for shape — positive, whole, and within a range that cannot overflow a JSON number
 * on the way through. Whether this particular agent may hand over this particular amount
 * is `AgentDepositService.assertDepositable`'s answer and stays there: it is bounded by
 * the CONTRACT's outstanding balance, which this service does not read and must not guess.
 *
 * `.strict()` because every field here is money or the evidence for it. A mistyped
 * `reference` silently dropped would record cash arriving with nothing tying the claim to
 * a bank statement.
 */
export const RecordDepositSchema = z
    .object({
        agentId: objectId,
        agencyId: objectId,
        amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        reference: z.string().trim().min(1).max(200),
        note: z.string().trim().max(500).optional(),
    })
    .strict();

export const RejectDepositSchema = z.object({
    reason: reasonText('A reason is required to reject a declared deposit'),
});

/**
 * Close a discrepancy.
 *
 * `resolution` IS pinned, unlike the `status` filter above, and the asymmetry is the rule
 * rather than an inconsistency: this service SENDS this value. Two outcomes exist —
 * `resolved` (recovered or explained) and `written_off` (the platform took the loss) — and
 * they mean very different things to whoever absorbs the shortfall. A third value would be
 * refused by jovi-mall anyway; refusing it here says which two are available.
 *
 * The note is required in both directions. Unlike a deactivation, neither outcome is the
 * "undo" of the other — writing money off is a decision in its own right.
 */
export const ResolveDiscrepancySchema = z.object({
    resolution: z.enum(['resolved', 'written_off']),
    note: reasonText('A resolution note is required', { min: 1 }),
});

/**
 * Move an agent's trust score by hand.
 *
 * The bounds mirror jovi-mall's (`-100..100`, integer): the score itself is `0..100`, so a
 * single adjustment can span the whole range in either direction and no more. The
 * resulting score is clamped there, not here — `CodTrustService` owns the arithmetic, and
 * this service does not compute what the score becomes.
 *
 * The note is required because this is the one trust movement no rule produced. Every
 * other row in `cod_trust_events` is explained by the discrepancy it references; this one
 * is explained only by the person who made it.
 */
export const TrustAdjustmentSchema = z.object({
    delta: z.number().int().min(-100).max(100),
    note: reasonText('A justification note is required', { min: 1 }),
});

export type ListRemittancesQuery = z.infer<typeof ListRemittancesQuerySchema>;
export type ListDepositsQuery = z.infer<typeof ListDepositsQuerySchema>;
export type ListHoldersQuery = z.infer<typeof ListHoldersQuerySchema>;
export type ListDiscrepanciesQuery = z.infer<typeof ListDiscrepanciesQuerySchema>;
export type ListTrustEventsQuery = z.infer<typeof ListTrustEventsQuerySchema>;
export type RejectRemittanceBody = z.infer<typeof RejectRemittanceSchema>;
export type RecordDepositBody = z.infer<typeof RecordDepositSchema>;
export type RejectDepositBody = z.infer<typeof RejectDepositSchema>;
export type ResolveDiscrepancyBody = z.infer<typeof ResolveDiscrepancySchema>;
export type TrustAdjustmentBody = z.infer<typeof TrustAdjustmentSchema>;
