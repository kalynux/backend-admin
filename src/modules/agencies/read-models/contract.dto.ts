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
        employment: Record<string, unknown> | null;
        remittance: Record<string, unknown> | null;
        feeSplit: Record<string, unknown> | null;
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
            employment: contract.employment ?? null,
            remittance: contract.remittance_terms ?? null,
            feeSplit: contract.fee_split ?? null,
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
 * The business name is NOT here. It lives on the Magazin, and joining a second collection
 * to decorate a list that is already a join would cost a second `$lookup` per page for a
 * label the dashboard can resolve from the agency id it is being handed. `/agencies/:id`
 * is one request away.
 */
export function toAgentContractDto(contract: ContractReadModel) {
    const agency = contract.agency;
    return {
        ...toContractCore(contract),
        agency: agency
            ? {
                  id: agency._id.toString(),
                  status: agency.status ?? null,
                  contactName: (agency as { display_name?: string }).display_name ?? null,
                  country: (agency as { country?: string }).country ?? null,
              }
            : null,
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
