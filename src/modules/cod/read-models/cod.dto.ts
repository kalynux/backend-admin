import {
    AgencyRemittanceReadModel,
    AgentDepositReadModel,
    CodDiscrepancyReadModel,
} from '../repositories/cod-record.read.repository';
import {
    CodCashAccountReadModel,
    CodCashLedgerReadModel,
    CodTrustEventReadModel,
} from '../repositories/cod-cash.read.repository';

/**
 * Wire shapes for `/api/v1/cod`.
 *
 * Named-field mapping throughout, **never a spread**.
 *
 * ── The one rule this file exists to hold, and it is not a leak rule ──────────
 * These DTOs are a strict **superset of jovi-mall's own COD DTOs, field name for field
 * name**. That is load-bearing rather than tidy: `GET /cod/remittances` and
 * `GET /cod/deposits` stayed DELEGATED at Phase 11 while their details became direct
 * reads, so one resource is now served through two transports — a list re-enveloped from
 * `AgencyRemittanceService.toDto`, and a detail mapped here from the raw document. If the
 * two spell a field differently, a dashboard rendering a row and then opening it sees two
 * different objects for one remittance.
 *
 * So: every field jovi-mall's list DTO emits appears here under the same name, and
 * `test-cod.ts` asserts that by reading jovi-mall's source. What this side ADDS is the
 * part an administrative surface needs and the owner-facing one does not — the actor
 * stamps, the party names, and the ledger movements the record caused.
 *
 * ── What is deliberately absent ──────────────────────────────────────────────
 * Nothing in this module reads `cash_collections`. Its ban list — `code_plain`,
 * `code_hash`, `verification.location`/`.ip`/`.device_info` — is enforced by there being
 * no projection of that collection here at all; the one declaration lives in
 * `shipments/repositories/shipment-context.read.repository.ts` and is reused rather than
 * copied. `test-cod.ts` asserts both halves of that: the names are absent, and so is a
 * second `COLLECTIONS.CASH_COLLECTION` repository.
 */

function toIso(value: Date | null | undefined): string | null {
    if (!value) return null;
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** A party on the cash chain. `name` is `null`, never `""` — absent data is absent. */
export interface PartyRef {
    id: string;
    name: string | null;
}

/**
 * Who resolved something, and which identity space their id belongs to.
 *
 * `source` is not decoration here. On `agent_deposits.recorded_by` it is the ONLY way to
 * tell an agency user's id from an administrator's — the same three methods are reached by
 * the agency desk and by the platform — and an `'admin'` id resolves in neither database's
 * `users` collection, which is why the name is a snapshot rather than a join.
 */
export interface ActorStampDto {
    id: string | null;
    source: string;
    name: string | null;
}

/** Party names for a page, keyed by id. Built once per list, never once per row. */
export interface CodPartyNames {
    agents: Map<string, string | null>;
    agencies: Map<string, string | null>;
}

// ─────────────────────────────────────────────────────────────────────────────
// The cash ledger — the shared block both record details carry
// ─────────────────────────────────────────────────────────────────────────────

export interface CashLedgerEntryDto {
    id: string;
    ownerType: string;
    ownerId: string;
    entryType: string;
    /** Signed: positive raises the liability, negative discharges it. */
    amount: number;
    /** What the balance BECAME. The number a remittance row cannot tell you. */
    balanceAfter: number;
    refType: string;
    refId: string;
    createdAt: string | null;
}

export function toCashLedgerEntryDto(row: CodCashLedgerReadModel): CashLedgerEntryDto {
    return {
        id: row._id.toString(),
        ownerType: row.owner_type,
        ownerId: row.owner_id.toString(),
        entryType: row.entry_type,
        amount: row.amount,
        balanceAfter: row.balance_after,
        refType: row.ref_type,
        refId: row.ref_id.toString(),
        createdAt: toIso(row.created_at),
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Remittances
// ─────────────────────────────────────────────────────────────────────────────

export interface RemittanceDto {
    id: string;
    agencyId: string;
    agency: PartyRef;
    amount: number;
    currency: string | null;
    /** The external bank/transfer/receipt id — evidence, not a credential. */
    reference: string | null;
    note: string | null;
    status: string;
    declaredAt: string | null;
    declaredByUserId: string | null;
    resolvedAt: string | null;
    /**
     * `null` while the remittance is still `declared`, keyed on the id rather than on the
     * status: a stamp rendered without checking reads as "resolved by nobody", which is a
     * claim rather than an absence.
     */
    resolvedBy: ActorStampDto | null;
    rejectionReason: string | null;
    /**
     * The reviewer's endorsement, or null when nobody has reviewed it.
     *
     * ⚠ **Advisory, never a precondition.** An un-endorsed record is exactly as confirmable as
     * an endorsed one — do not disable a confirm control on a null here.
     *
     * There is no rejected verdict: a triage rejection is terminal and shows up as
     * `status: "rejected"` with a `rejectionReason`, like any other.
     */
    triage: {
        verdict: string;
        note: string | null;
        by: { id: string | null; name: string | null };
        at: string | null;
    } | null;
    createdAt: string | null;
    updatedAt: string | null;
}

export interface RemittanceDetailDto extends RemittanceDto {
    /**
     * What confirming it MOVED — usually one row against the agency's account.
     *
     * Empty for a `declared` or `rejected` remittance, and that emptiness is the point: a
     * declaration is a claim, and nothing has moved until an administrator confirms it.
     */
    cashMovements: CashLedgerEntryDto[];
}

export function toRemittanceDto(
    row: AgencyRemittanceReadModel,
    names: CodPartyNames,
): RemittanceDto {
    const agencyId = row.agency_id.toString();
    return {
        id: row._id.toString(),
        // Both the flat id AND the party block: the flat one is what jovi-mall's list DTO
        // emits, and dropping it here would break the superset rule this file is built on.
        agencyId,
        agency: { id: agencyId, name: names.agencies.get(agencyId) ?? null },
        amount: row.amount,
        currency: row.currency ?? null,
        reference: row.reference ?? null,
        note: row.note ?? null,
        status: row.status,
        declaredAt: toIso(row.declared_at),
        declaredByUserId: row.declared_by_user_id ? row.declared_by_user_id.toString() : null,
        resolvedAt: toIso(row.resolved_at),
        resolvedBy: row.resolved_by_user_id
            ? {
                id: row.resolved_by_user_id.toString(),
                // Defaults to 'platform' exactly as the schema does — a row written
                // before the admin split carries neither field and IS a platform row.
                source: row.resolved_by_source ?? 'platform',
                name: row.resolved_by_name ?? null,
            }
            : null,
        rejectionReason: row.rejection_reason ?? null,
        triage: row.triage
            ? {
                  verdict: row.triage.verdict,
                  note: row.triage.note ?? null,
                  by: { id: row.triage.by_admin_id ?? null, name: row.triage.by_name ?? null },
                  at: row.triage.at ? new Date(row.triage.at).toISOString() : null,
              }
            : null,
        createdAt: toIso(row.created_at),
        updatedAt: toIso(row.updated_at),
    };
}

export function toRemittanceDetailDto(
    row: AgencyRemittanceReadModel,
    names: CodPartyNames,
    movements: CodCashLedgerReadModel[],
): RemittanceDetailDto {
    return {
        ...toRemittanceDto(row, names),
        cashMovements: movements.map(toCashLedgerEntryDto),
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Deposits
// ─────────────────────────────────────────────────────────────────────────────

export interface DepositDto {
    id: string;
    agentId: string;
    agencyId: string;
    agent: PartyRef;
    agency: PartyRef;
    amount: number;
    currency: string | null;
    note: string | null;
    /** `agency` is the normal route; `platform` skipped the middle leg. */
    recipient: string;
    status: string;
    reference: string | null;
    declaredAt: string | null;
    declaredByUserId: string | null;
    resolvedAt: string | null;
    /** The stamp whose `source` carries BOTH an agency user and an administrator. */
    recordedBy: ActorStampDto | null;
    rejectionReason: string | null;
    /**
     * The reviewer's endorsement, or null when nobody has reviewed it.
     *
     * ⚠ **Advisory, never a precondition.** An un-endorsed record is exactly as confirmable as
     * an endorsed one — do not disable a confirm control on a null here.
     *
     * There is no rejected verdict: a triage rejection is terminal and shows up as
     * `status: "rejected"` with a `rejectionReason`, like any other.
     */
    triage: {
        verdict: string;
        note: string | null;
        by: { id: string | null; name: string | null };
        at: string | null;
    } | null;
    /** jovi-mall's name for `created_at` on this record. Kept, per the superset rule. */
    recordedAt: string | null;
    createdAt: string | null;
    updatedAt: string | null;
}

export interface DepositDetailDto extends DepositDto {
    /**
     * **Two rows for a confirmed `platform` deposit, one for an `agency` one.**
     *
     * That asymmetry is the whole cash model made visible. A deposit to the agency lowers
     * the agent's liability alone; a deposit that skipped the agency and went straight to
     * the platform settles BOTH legs, because the cash physically bypassed the middle one.
     * Reading two `balance_after` values on one deposit is how an operator sees that
     * without being told.
     */
    cashMovements: CashLedgerEntryDto[];
}

export function toDepositDto(row: AgentDepositReadModel, names: CodPartyNames): DepositDto {
    const agentId = row.agent_id.toString();
    const agencyId = row.agency_id.toString();

    return {
        id: row._id.toString(),
        agentId,
        agencyId,
        agent: { id: agentId, name: names.agents.get(agentId) ?? null },
        agency: { id: agencyId, name: names.agencies.get(agencyId) ?? null },
        amount: row.amount,
        currency: row.currency ?? null,
        note: row.note ?? null,
        recipient: row.recipient,
        status: row.status,
        reference: row.reference ?? null,
        declaredAt: toIso(row.declared_at),
        declaredByUserId: row.declared_by_user_id ? row.declared_by_user_id.toString() : null,
        resolvedAt: toIso(row.resolved_at),
        recordedBy: row.recorded_by_user_id
            ? {
                id: row.recorded_by_user_id.toString(),
                source: row.recorded_by_source ?? 'platform',
                name: row.recorded_by_name ?? null,
            }
            : null,
        rejectionReason: row.rejection_reason ?? null,
        triage: row.triage
            ? {
                  verdict: row.triage.verdict,
                  note: row.triage.note ?? null,
                  by: { id: row.triage.by_admin_id ?? null, name: row.triage.by_name ?? null },
                  at: row.triage.at ? new Date(row.triage.at).toISOString() : null,
              }
            : null,
        recordedAt: toIso(row.created_at),
        createdAt: toIso(row.created_at),
        updatedAt: toIso(row.updated_at),
    };
}

export function toDepositDetailDto(
    row: AgentDepositReadModel,
    names: CodPartyNames,
    movements: CodCashLedgerReadModel[],
): DepositDetailDto {
    return {
        ...toDepositDto(row, names),
        cashMovements: movements.map(toCashLedgerEntryDto),
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Discrepancies
// ─────────────────────────────────────────────────────────────────────────────

export interface DiscrepancyDto {
    id: string;
    agentId: string;
    agencyId: string;
    agent: PartyRef;
    agency: PartyRef;
    type: string;
    /** `null` for a non-monetary flag — not zero, which would mean "nothing at stake". */
    amount: number | null;
    currency: string | null;
    status: string;
    /** `system` | `agency` | `admin` | `agent`. The last one is how an agent disputes. */
    raisedBy: string;
    raisedByUserId: string | null;
    /** The deposit at issue, for `deposit_not_confirmed` and agent disputes. */
    depositId: string | null;
    note: string | null;
    resolutionNote: string | null;
    /**
     * Who closed the flag — **the full stamp, as `RemittanceDto.resolvedBy` already was.**
     *
     * ⚠ This **replaced `resolvedByUserId`** in Phase 4 step 22 (J7). That field was a bare
     * id string, and resolving a discrepancy is an admin-only act — so since the admin split
     * it has been a wi-admin id that resolves in neither database, rendered beside a
     * remittance on the same screen that shows a name. One shape for an actor stamp across
     * this surface, or the two disagree about what an id means.
     *
     * `null` while the flag is still `open`, keyed on the id rather than on the status: a
     * stamp rendered without checking reads as "resolved by nobody", which is a claim rather
     * than an absence.
     */
    resolvedBy: ActorStampDto | null;
    openedAt: string | null;
    resolvedAt: string | null;
    createdAt: string | null;
    updatedAt: string | null;
}

export interface DiscrepancyDetailDto extends DiscrepancyDto {
    /** The deposit this flag is about, resolved — `null` when it names none. */
    deposit: DepositDto | null;
    /**
     * The trust movements this flag caused. **Often empty, and that is the system
     * working**: `deposit_not_confirmed` is the AGENCY's failure and deliberately carries
     * no agent penalty, while `late_deposit` costs the agent once no matter how many
     * agencies are owed.
     */
    trustEvents: TrustEventDto[];
}

export function toDiscrepancyDto(
    row: CodDiscrepancyReadModel,
    names: CodPartyNames,
): DiscrepancyDto {
    const agentId = row.agent_id.toString();
    const agencyId = row.agency_id.toString();

    return {
        id: row._id.toString(),
        agentId,
        agencyId,
        agent: { id: agentId, name: names.agents.get(agentId) ?? null },
        agency: { id: agencyId, name: names.agencies.get(agencyId) ?? null },
        type: row.type,
        amount: row.amount ?? null,
        currency: row.currency ?? null,
        status: row.status,
        raisedBy: row.raised_by,
        raisedByUserId: row.raised_by_user_id ? row.raised_by_user_id.toString() : null,
        depositId: row.deposit_id ? row.deposit_id.toString() : null,
        note: row.note ?? null,
        resolutionNote: row.resolution_note ?? null,
        resolvedBy: row.resolved_by_user_id
            ? {
                id: row.resolved_by_user_id.toString(),
                // Defaults to 'platform' exactly as the schema does, and exactly as the
                // remittance mapper above. `backfill:actor-source` makes the stored data
                // agree with this, so the fallback is a redundancy rather than a guess.
                source: row.resolved_by_source ?? 'platform',
                name: row.resolved_by_name ?? null,
            }
            : null,
        openedAt: toIso(row.opened_at),
        resolvedAt: toIso(row.resolved_at),
        createdAt: toIso(row.created_at),
        updatedAt: toIso(row.updated_at),
    };
}

export function toDiscrepancyDetailDto(
    row: CodDiscrepancyReadModel,
    names: CodPartyNames,
    context: { deposit: AgentDepositReadModel | null; trustEvents: CodTrustEventReadModel[] },
): DiscrepancyDetailDto {
    return {
        ...toDiscrepancyDto(row, names),
        deposit: context.deposit ? toDepositDto(context.deposit, names) : null,
        trustEvents: context.trustEvents.map(toTrustEventDto),
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Holders and trust
// ─────────────────────────────────────────────────────────────────────────────

export interface HolderDto {
    /** `agent` owes their agency; `agency` owes the platform. Two layers, one model. */
    ownerType: string;
    owner: PartyRef;
    /** Outstanding liability, minor units. Never negative. */
    balance: number;
    currency: string | null;
    /**
     * The compare-and-set counter on the account, surfaced so a stale screen is
     * detectable. It is not a balance and nothing should compute with it.
     */
    version: number;
    /**
     * When the balance last moved.
     *
     * Read off the account's `updated_at` rather than the newest ledger row: the two are
     * written in the same transaction, and joining the ledger for a page of holders would
     * be one query per row for a value already on the document.
     */
    lastMovementAt: string | null;
    /**
     * `null` for an AGENCY, and that is the "does not apply to this owner kind" rule, not
     * "unknown". A trust score bounds how much cash one PERSON may carry; an agency's
     * exposure is bounded by its contracts, which is a different mechanism entirely.
     */
    trust: { score: number; maxThreshold: number } | null;
}

export interface AgentCodContext {
    name: string | null;
    trustScore: number | null;
    maxThreshold: number | null;
}

export function toHolderDto(
    row: CodCashAccountReadModel,
    names: CodPartyNames,
    agentContext: Map<string, AgentCodContext>,
): HolderDto {
    const ownerId = row.owner_id.toString();
    const isAgent = row.owner_type === 'agent';
    const context = isAgent ? agentContext.get(ownerId) : undefined;

    return {
        ownerType: row.owner_type,
        owner: {
            id: ownerId,
            name: isAgent
                ? (context?.name ?? names.agents.get(ownerId) ?? null)
                : (names.agencies.get(ownerId) ?? null),
        },
        balance: row.balance,
        currency: row.currency ?? null,
        version: row.version ?? 0,
        lastMovementAt: toIso(row.updated_at),
        trust: isAgent
            ? {
                // The schema defaults: a fresh agent starts fully trusted at 100 and with
                // no ceiling configured. Reporting them as the numbers they are beats
                // reporting `null`, which would read as "this agent has no trust model".
                score: context?.trustScore ?? 100,
                maxThreshold: context?.maxThreshold ?? 0,
            }
            : null,
    };
}

export interface TrustEventDto {
    id: string;
    agentId: string;
    /** `null` for a platform-wide adjustment that names no agency. */
    agencyId: string | null;
    eventType: string;
    /** Signed. Negative is a penalty. */
    delta: number;
    /** The score immediately after — the audit snapshot, not a recomputation. */
    scoreAfter: number;
    refType: string | null;
    refId: string | null;
    note: string | null;
    createdAt: string | null;
}

export function toTrustEventDto(row: CodTrustEventReadModel): TrustEventDto {
    return {
        id: row._id.toString(),
        agentId: row.agent_id.toString(),
        agencyId: row.agency_id ? row.agency_id.toString() : null,
        eventType: row.event_type,
        delta: row.delta,
        scoreAfter: row.score_after,
        refType: row.ref_type ?? null,
        refId: row.ref_id ? row.ref_id.toString() : null,
        note: row.note ?? null,
        createdAt: toIso(row.created_at),
    };
}
