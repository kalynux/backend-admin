import { ContractEventReadModel } from '../repositories/contract-event.read.repository';
import { ContractReadModel } from '../repositories/contract.read.repository';

/**
 * Wire shapes for the agent↔agency relationship, shared by both modules.
 *
 * One file rather than one per module, for the reason the repositories beside it give:
 * the agency roster and the agent's contract list are the same rows read from opposite
 * ends, and two copies of a mapping over money fields is the kind of drift that shows up
 * as two screens disagreeing about what an agent is owed.
 *
 * Named-field mapping throughout, never a spread — the second of the two locks that keep
 * a widened projection from reaching the wire on its own.
 */

function toIso(value: Date | null | undefined): string | null {
    if (!value) return null;
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * How the agent is engaged. Excluded from negotiation upstream — it has its own route and
 * the agency sets it unilaterally — which is why it is not part of the proposal cycle.
 */
export interface EmploymentTermsDto {
    /** `employee` · `contractor` · `freelancer`. jovi-mall's vocabulary, not pinned here. */
    type: string | null;
    /** The agency's own staff reference, free text. */
    employeeRef: string | null;
    startedAt: string | null;
    /** `null` on an open-ended engagement — which is most of them. */
    endsAt: string | null;
}

/** When the agent has to hand cash back, and how much grace they get. */
export interface RemittanceTermsDto {
    /** `per_delivery` · `daily` · `weekly` · `biweekly` · `monthly` · `on_demand`. */
    cadence: string | null;
    /**
     * ⚠ **`0` is Sunday**, not Monday and not "unset". Only meaningful on a `weekly`
     * cadence; `null` otherwise.
     */
    dayOfWeek: number | null;
    /** 1–28 on a `monthly` cadence — never 29–31, so February cannot skip a remittance. */
    dayOfMonth: number | null;
    /** How long after the due moment before the agent is late. */
    graceHours: number | null;
}

/**
 * What the agent earns per delivery.
 *
 * ⚠ The only money block on a contract that carries a `currency`. `cod` and `payment` do
 * not, so a client rendering those has no symbol to print from the contract alone.
 */
export interface FeeSplitTermsDto {
    /** `percentage` · `flat`. Decides which of the two amounts below is meaningful. */
    model: string | null;
    agentSharePercent: number | null;
    agentFlatFee: number | null;
    currency: string | null;
}

function str(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * `null` when jovi-mall stored no sub-document at all — which is different from one whose
 * fields are individually unset, and a client deciding whether to render a block needs the
 * distinction.
 */
function toEmploymentTerms(raw: Record<string, unknown> | undefined): EmploymentTermsDto | null {
    if (!raw) return null;
    return {
        type: str(raw.employment_type),
        employeeRef: str(raw.employee_ref),
        startedAt: toIso(raw.started_at as Date | null | undefined),
        endsAt: toIso(raw.ends_at as Date | null | undefined),
    };
}

function toRemittanceTerms(raw: Record<string, unknown> | undefined): RemittanceTermsDto | null {
    if (!raw) return null;
    return {
        cadence: str(raw.cadence),
        dayOfWeek: num(raw.day_of_week),
        dayOfMonth: num(raw.day_of_month),
        graceHours: num(raw.grace_hours),
    };
}

function toFeeSplitTerms(raw: Record<string, unknown> | undefined): FeeSplitTermsDto | null {
    if (!raw) return null;
    return {
        model: str(raw.model),
        agentSharePercent: num(raw.agent_share_percent),
        agentFlatFee: num(raw.agent_flat_fee),
        currency: str(raw.currency),
    };
}

/** The terms and money common to both directions. */
interface ContractCoreDto {
    id: string;
    agentId: string;
    agencyId: string;
    status: string;
    origin: string | null;
    isPrimary: boolean;
    cod: {
        /** This contract's slice of the agent's global COD pool. */
        threshold: number;
        /** What the agent currently owes THIS agency. */
        outstandingBalance: number;
        lastSettledAt: string | null;
    };
    payment: {
        /** What this agency currently owes the agent. */
        outstandingToAgent: number;
        lastPaidAt: string | null;
    };
    terms: {
        /**
         * ⚠ **These three were the contract's largest casing leak, and are now mapped.**
         *
         * They shipped as `Record<string, unknown>` — jovi-mall's sub-documents assigned
         * whole — so `employment_type`, `day_of_week` and `agent_share_percent` reached
         * the browser in the storage casing, against README's "the translation happens in
         * this service and never leaks". Every field is named now, which also means
         * `agencies.md` can document them instead of printing `{ "…": "…" }`.
         *
         * Named mapping is also what makes the projection safe to leave wide: a field
         * added to any of these upstream lands in the read model and stops here.
         */
        employment: EmploymentTermsDto | null;
        remittance: RemittanceTermsDto | null;
        feeSplit: FeeSplitTermsDto | null;
        coverageRegions: string[];
        shipmentValueCeiling: number | null;
        /**
         * Who made the standing proposal. This — not `origin` — is what decides whose turn
         * it is to answer on a pending contract, and the two disagree the moment anybody
         * counters. Surfacing `origin` alone is how a dashboard renders the wrong button.
         */
        proposedBy: string | null;
        version: number;
    };
    lifecycle: {
        approvedAt: string | null;
        suspendedAt: string | null;
        suspensionReason: string | null;
        deactivatedAt: string | null;
        deactivationReason: string | null;
        withdrawnAt: string | null;
        withdrawalReason: string | null;
    };
    createdAt: string;
    updatedAt: string;
}

function toContractCore(contract: ContractReadModel): ContractCoreDto {
    const cod = contract.cod ?? {};
    const payment = contract.payment ?? {};

    return {
        id: contract._id.toString(),
        agentId: contract.agent_id?.toString() ?? '',
        agencyId: contract.agency_id?.toString() ?? '',
        status: contract.status,
        origin: contract.origin ?? null,
        isPrimary: contract.is_primary === true,
        cod: {
            threshold: cod.threshold ?? 0,
            outstandingBalance: cod.outstanding_balance ?? 0,
            lastSettledAt: toIso(cod.last_settled_at),
        },
        payment: {
            outstandingToAgent: payment.outstanding_to_agent ?? 0,
            lastPaidAt: toIso(payment.last_paid_at),
        },
        terms: {
            employment: toEmploymentTerms(contract.employment),
            remittance: toRemittanceTerms(contract.remittance_terms),
            feeSplit: toFeeSplitTerms(contract.fee_split),
            // Empty means NO RESTRICTION, not "covers nowhere" — jovi-mall's coverage rule
            // fails open, and it has to: an empty array is the schema default on every
            // contract ever written, so the strict reading would make the whole roster
            // undispatchable at once. A dashboard rendering this must say "all regions".
            coverageRegions: contract.coverage?.regions ?? [],
            shipmentValueCeiling: contract.shipment_value_ceiling ?? null,
            proposedBy: contract.terms_proposed_by ?? null,
            version: contract.terms_version ?? 0,
        },
        lifecycle: {
            approvedAt: toIso(contract.approved_at),
            suspendedAt: toIso(contract.suspended_at),
            suspensionReason: contract.suspension_reason ?? null,
            deactivatedAt: toIso(contract.deactivated_at),
            deactivationReason: contract.deactivation_reason ?? null,
            withdrawnAt: toIso(contract.withdrawn_at),
            withdrawalReason: contract.withdrawal_reason ?? null,
        },
        createdAt: toIso(contract.created_at) ?? String(contract.created_at),
        updatedAt: toIso(contract.updated_at) ?? String(contract.updated_at),
    };
}

/**
 * A row on the agency's roster: the contract, plus enough of the agent to recognise them.
 *
 * `agent` is null when the joined row is missing — a contract pointing at an agent that
 * does not exist. That is a broken state and precisely the one an administrator opens
 * this screen to find, which is why the join preserves the row rather than dropping it.
 */
export function toRosterEntryDto(contract: ContractReadModel) {
    const agent = contract.agent;
    return {
        ...toContractCore(contract),
        agent: agent
            ? {
                  id: agent._id.toString(),
                  name: agent.name ?? null,
                  status: agent.status ?? null,
                  kycStatus: (agent as Record<string, unknown>).kyc
                      ? ((agent as { kyc?: { status?: string } }).kyc?.status ?? null)
                      : null,
                  availability: (agent as { availability?: { state?: string } }).availability?.state ?? null,
                  banned: (agent as { platform_ban?: { banned?: boolean } }).platform_ban?.banned === true,
              }
            : null,
    };
}

/**
 * A row on the agent's contract list: the contract, plus which agency it is with.
 *
 * ── `businessName` is here now, and the old reasoning has been overturned ────
 * It used to be withheld: the name lives on the Magazin, and a second `$lookup` per page
 * was judged not worth it for "a label the dashboard can resolve from the agency id".
 * That holds for ONE agency and not for a page of rows, and it assumed a cost the client
 * could pay silently — with no batch-by-ids route anywhere on this service, the client's
 * alternative is one request per distinct agency, in every client ever built against this
 * endpoint. One `$lookup` is cheaper than that, and it is bounded: it runs inside
 * `aggregatePage`'s `join` half, after skip/limit, so it touches at most one page.
 *
 * ⚠ **`contactName` is a PERSON and `businessName` is the business.** `display_name` on a
 * `delivery_agencies` row is the agency's contact individual, and the dashboard's "Agency"
 * column has been rendering a human's name because it was the only name on the payload.
 * Both are returned, distinctly named, so that cannot recur.
 *
 * `businessName` is `null` where the Magazin has none — an agency mid-onboarding
 * legitimately has no business name yet and must still be identifiable by its id. `null`,
 * never `''`, and never silently substituted with `contactName`.
 */
export function toAgentContractDto(contract: ContractReadModel) {
    const agency = contract.agency;
    return {
        ...toContractCore(contract),
        agency: agency
            ? {
                  id: agency._id.toString(),
                  businessName: (agency as { magazin?: { name?: string } }).magazin?.name ?? null,
                  status: agency.status ?? null,
                  contactName: (agency as { display_name?: string }).display_name ?? null,
                  country: (agency as { country?: string }).country ?? null,
              }
            : null,
    };
}

/**
 * ONE contract, carrying BOTH decorations — the addressable form.
 *
 * The roster and the agent's list are the same rows read from opposite ends, each
 * decorated with the party the reader does not already know. A contract opened by its own
 * id has no such reader, so it carries both: whoever followed the link needs to know who
 * is on each side of it.
 *
 * That addressability is the point of the endpoint on its own merits, independent of the
 * writes beside it. Until now an operator could not send a colleague a link to a contract,
 * and a support ticket naming a contract id had nowhere to point.
 */
export function toContractDetailDto(contract: ContractReadModel) {
    return {
        ...toRosterEntryDto(contract),
        ...toAgentContractDto(contract),
    };
}

/**
 * One entry in the contract history.
 *
 * `actorUserId` carries no `source` companion, unlike the actor stamps on the agent and
 * agency documents: `agent_membership_events` predates that convention and jovi-mall
 * writes `actor_role: 'admin'` there instead. Read the role, not the id — an `admin` row's
 * id belongs to the wi-admin database and resolves to nothing in `jovi_mall`.
 */
export function toContractEventDto(event: ContractEventReadModel) {
    return {
        id: event._id.toString(),
        contractId: event.membership_id?.toString() ?? null,
        agentId: event.agent_id?.toString() ?? '',
        agencyId: event.agency_id?.toString() ?? '',
        type: event.type,
        fromStatus: event.from_status ?? null,
        toStatus: event.to_status ?? null,
        actorRole: event.actor_role ?? null,
        actorUserId: event.actor_user_id?.toString() ?? null,
        reason: event.reason ?? null,
        occurredAt: toIso(event.occurred_at) ?? String(event.occurred_at),
    };
}
