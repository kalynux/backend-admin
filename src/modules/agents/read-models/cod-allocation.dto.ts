import { AgencyReadModel } from '../../agencies/repositories/agency.read.repository';

/**
 * The wire shape of `GET /api/v1/agents/:agentId/cod-allocation`.
 *
 * ── Why a mapper at all, on a DELEGATED read ─────────────────────────────────
 * Every other delegated read on this surface passes jovi-mall's payload through untyped and
 * documents it against that source, deliberately: re-declaring a shape this service does not
 * own is a second definition that drifts silently. This one is different in two ways, and
 * both are BR-016 § 2:
 *
 *   1. It gains a field jovi-mall cannot produce. The agency's business name lives on the
 *      Magazin, which `AgentCodThresholdService.getAllocation` does not join and has no
 *      reason to — its subject is a number, not a directory. Decorating a payload means
 *      owning its shape.
 *   2. It was **the only route in the `/agents` group with no documented response shape at
 *      all**, so the dashboard's type was transcribed off the wire. This repository has one
 *      expensive lesson about transcribed contracts (BR-014), and the fix for a transcribed
 *      contract is a written one, which needs a mapper to be written against.
 *
 * Named-field mapping throughout, never a spread — the usual rule, and here it also means a
 * field added to `ThresholdAllocation` upstream lands nowhere until somebody names it.
 */

/**
 * jovi-mall's `ThresholdAllocation`, as much of it as this mapper names.
 *
 *   source: jovi-mall/src/modules/agents/domain/services/agent-cod-threshold.service.ts
 *
 * A structural pin, not a re-declaration of the domain: it exists so the mapping below is
 * type-checked rather than a chain of `as`. Every field is optional because it describes an
 * HTTP payload, and a payload that arrived short must produce a `null` on the wire rather
 * than a `TypeError` in the mapper.
 */
interface PlatformThresholdAllocation {
    agentId?: string;
    maxThreshold?: number;
    allocated?: number;
    headroom?: number;
    overAllocatedBy?: number;
    pool?: {
        maxThreshold?: number;
        ceiling?: number;
        source?: string;
        planCode?: string | null;
        selfLimited?: boolean;
        syncedAt?: string | null;
    };
    override?: {
        amount?: number;
        reason?: string;
        setAt?: string;
        setByUserId?: string | null;
        setBySource?: string;
        setByName?: string | null;
    } | null;
    contracts?: {
        contractId?: string;
        agencyId?: string;
        status?: string;
        threshold?: number;
        outstandingBalance?: number;
    }[];
}

export interface CodAllocationSliceDto {
    contractId: string | null;
    agencyId: string | null;
    /**
     * The agency this slice is held with — the same object `GET /agents/:agentId/contracts`
     * returns, narrowed to the three fields that identify it (BR-016 § 2).
     *
     * `null` when the agency row is gone, which is a broken state worth showing rather than
     * a row to hide: the slice still consumes the pool.
     */
    agency: {
        id: string;
        /**
         * The Magazin's name. `null` where the Magazin has none — an agency mid-onboarding
         * legitimately has no business name yet and must still be identifiable by its id.
         *
         * ⚠ `null`, never `''`, and **never silently substituted with `display_name`**:
         * that column is the agency's contact PERSON, and printing a human under a heading
         * that says "Agency" is the exact mislabelling BR-006 corrected.
         * `findRowsByIds` returns the row, so this mapper reads the Magazin explicitly and
         * has no fallback to reach for.
         */
        businessName: string | null;
        /** The AGENCY's account status — `active` · `pending_verification` · `inactive`. */
        status: string | null;
    } | null;
    /**
     * ⚠ The **CONTRACT's** status, not the agency's — they sit side by side and mean
     * different things. This one decides whether the slice consumes the pool
     * (`ALLOCATING_CONTRACT_STATUSES`: `active`, `paused` and `suspended` all do,
     * `deactivated` does not); `agency.status` decides whether the agency may trade at all.
     */
    status: string | null;
    /** This contract's slice of the agent's global pool. */
    threshold: number;
    /** What the agent currently owes THIS agency. */
    outstandingBalance: number;
}

export interface CodAllocationDto {
    agentId: string | null;
    /** The agent's global COD pool. */
    maxThreshold: number;
    /** Sum of `threshold` across the ALLOCATING contracts below. */
    allocated: number;
    /** `maxThreshold - allocated`. Never negative. */
    headroom: number;
    /**
     * `allocated - maxThreshold` when contracts hold MORE than the pool, else 0 (2026-09-21).
     *
     * Only an automatic change produces it — a plan downgrade, or a KYC verdict revoked —
     * because the platform cannot rewrite what agencies agreed. While it is above 0 no slice
     * can be raised, and jovi-mall caps every dispatch at the pool rather than at the larger
     * slice. A screen should say so rather than show a headroom of 0 with no explanation.
     */
    overAllocatedBy: number;
    /**
     * Where `maxThreshold` comes from (2026-09-21) — the pool is the agent's plan value once
     * KYC is `verified`, 0 while it is not, or an administrator's pin. `selfLimited` is the
     * agent choosing to carry less than `ceiling`. `source` is for display, never a branch.
     */
    pool: {
        ceiling: number;
        source: 'not_verified' | 'override' | 'plan';
        planCode: string | null;
        selfLimited: boolean;
        syncedAt: string | null;
    };
    /** The administrator's pin — reason and author included. `null` = no pin. */
    override: {
        amount: number;
        reason: string | null;
        setAt: string | null;
        setByName: string | null;
        setBySource: string | null;
    } | null;
    /**
     * One entry per allocating contract, unpaginated.
     *
     * Unpaginated is jovi-mall's shape and is kept: the list is bounded by one agent's
     * contract count, which is single digits — an agent serves a handful of agencies, not a
     * thousand. That is also what makes the agency decoration affordable here without the
     * after-skip/limit argument the paged feeds need.
     */
    contracts: CodAllocationSliceDto[];
}

type PoolSource = 'not_verified' | 'override' | 'plan';
/** An unknown value reads as the fail-closed one — a pool of unknown origin is not assumed to be the plan. */
const POOL_SOURCES: readonly PoolSource[] = ['not_verified', 'override', 'plan'];

function num(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function str(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * @param agencies the rows resolved for the slices' `agencyId`s, in ONE batched read. An
 *   id absent from the map renders `agency: null` — never an id in a name's place.
 */
export function toCodAllocationDto(
    raw: unknown,
    agencies: Map<string, AgencyReadModel>,
): CodAllocationDto {
    const allocation = (raw ?? {}) as PlatformThresholdAllocation;

    return {
        agentId: str(allocation.agentId),
        maxThreshold: num(allocation.maxThreshold),
        allocated: num(allocation.allocated),
        headroom: num(allocation.headroom),
        overAllocatedBy: num(allocation.overAllocatedBy),
        pool: {
            ceiling: num(allocation.pool?.ceiling),
            source: POOL_SOURCES.includes(allocation.pool?.source as PoolSource)
                ? (allocation.pool?.source as PoolSource)
                : 'not_verified',
            planCode: str(allocation.pool?.planCode),
            selfLimited: allocation.pool?.selfLimited === true,
            syncedAt: str(allocation.pool?.syncedAt),
        },
        override: allocation.override && typeof allocation.override.amount === 'number'
            ? {
                amount: allocation.override.amount,
                reason: str(allocation.override.reason),
                setAt: str(allocation.override.setAt),
                setByName: str(allocation.override.setByName),
                setBySource: str(allocation.override.setBySource),
            }
            : null,
        contracts: (allocation.contracts ?? []).map((slice) => {
            const agencyId = str(slice.agencyId);
            const agency = agencyId ? agencies.get(agencyId) : undefined;

            return {
                contractId: str(slice.contractId),
                agencyId,
                agency: agency
                    ? {
                        id: agency._id.toString(),
                        businessName: agency.magazin?.name ?? null,
                        status: agency.status ?? null,
                    }
                    : null,
                status: str(slice.status),
                threshold: num(slice.threshold),
                outstandingBalance: num(slice.outstandingBalance),
            };
        }),
    };
}

/** The distinct agencies a delegated allocation names. Pure, so the mapper stays DB-free. */
export function allocationAgencyIds(raw: unknown): string[] {
    const allocation = (raw ?? {}) as PlatformThresholdAllocation;
    const seen = new Set<string>();
    for (const slice of allocation.contracts ?? []) {
        const id = str(slice.agencyId);
        if (id) seen.add(id);
    }
    return [...seen];
}
