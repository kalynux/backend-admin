import { Document, Filter, ObjectId } from 'mongodb';
import { Types } from 'mongoose';
import { containsInsensitive, toMongoSort } from '../../../core/data/mongo-list';
import { ListQueryBase } from '../../../core/http/list-query';
import { COLLECTIONS } from '../../../infra/platform/collections';
import { Paginated, PlatformReadRepository } from '../../../infra/platform/platform.repository';
import { AGENT_SORT } from '../validators/agent.validator';

/**
 * Reading delivery agents straight out of `jovi_mall`.
 *
 * ── Why this domain reads directly, when ADR-004 said HTTP ────────────────────
 * ADR-004 assigned agents `read: HTTP`. ADR-009 amends that one cell, and the reason is
 * not "there is no service to call" — jovi-mall HAS an agent read service,
 * `AgentDirectoryService`, and it is the wrong one. Its hard filter is
 * `assertCanHoldContract` plus completed onboarding, because listing an agent who cannot
 * accept a contract renders a button whose request dead-ends. That filter excludes
 * precisely the population an administrator opens this screen to find: unverified KYC,
 * banned, suspended, mid-onboarding. Delegating would mean writing a SECOND directory
 * service in the service being migrated away from, whose only consumer is this one.
 *
 * What stays delegated is the three reads whose answer is a verdict the platform acts on —
 * eligibility, tracking policy, COD allocation. Those live in `agent.gateway.ts`.
 *
 * Every WRITE is delegated. `PlatformReadRepository` has no write method, so that is not
 * something this file could break by accident.
 */

export interface AgentReadModel extends Document {
    _id: ObjectId;
    user_id: ObjectId;
    name?: string | null;
    email?: string | null;
    email_verified?: boolean;
    phone?: string | null;
    phone_verified?: boolean;
    avatar_file_id?: ObjectId | null;
    status: string;
    status_reason?: string | null;
    onboarding_step?: number;
    kyc?: {
        status?: string;
        verified_at?: Date | null;
        verified_by_user_id?: ObjectId | null;
        verified_by_source?: 'platform' | 'admin';
        verified_by_name?: string | null;
        rejection_reason?: string | null;
        reference?: string | null;
    };
    platform_ban?: {
        banned?: boolean;
        reason?: string | null;
        banned_at?: Date | null;
        banned_by_user_id?: ObjectId | null;
        banned_by_source?: 'platform' | 'admin';
        banned_by_name?: string | null;
    };
    availability?: { state?: string; changed_at?: Date | null; reason?: string | null };
    working_state?: { state?: string; active_shipment_count?: number; computed_at?: Date | null };
    capacity?: {
        max_active_shipments?: number;
        active_shipment_count?: number;
        reconciled_at?: Date | null;
    };
    tracking?: {
        allowed?: boolean;
        reason?: string | null;
        changed_at?: Date | null;
        changed_by_user_id?: ObjectId | null;
        changed_by_role?: string | null;
        changed_by_source?: 'platform' | 'admin';
        changed_by_name?: string | null;
    };
    device?: {
        platform?: string | null;
        app_version?: string | null;
        location_permission?: string | null;
        location_services_enabled?: boolean | null;
        background_location_enabled?: boolean | null;
        battery_optimization_exempt?: boolean | null;
        push_enabled?: boolean | null;
        reported_at?: Date | null;
    };
    last_known_tracking_state?: {
        status?: string;
        last_position?: { type?: string; coordinates?: number[] } | null;
        last_reported_at?: Date | null;
        source?: string | null;
        /**
         * A resolved name for `last_position` — "Bonapriso, Douala".
         *
         * Written by jovi-mall when the position arrives, reverse-geocoded once per
         * position and cached against it, never resolved on read. `null` when nothing
         * resolved.
         */
        last_place?: { label?: string; source?: string; resolved_at?: Date } | null;
    };
    /**
     * `trust_override` is the ADMINISTRATOR's pinned score, and it OUTRANKS `trust_score`
     * at every gate in jovi-mall (O-7). Projecting only the computed one — which is what
     * this read model did until Phase 6.J — means every screen here reports a number the
     * platform is not using, on precisely the agents where a human decided it should not.
     */
    cod?: {
        trust_score?: number;
        max_threshold?: number;
        trust_override?: {
            score?: number;
            reason?: string;
            set_at?: Date;
            set_by_name?: string | null;
        } | null;
    };
    trust_signals?: {
        on_time_rate?: number | null;
        assignment_response_rate?: number | null;
        completed_shipments?: number | null;
        customer_rating_avg?: number | null;
        customer_rating_count?: number | null;
        agency_rating_avg?: number | null;
        agency_rating_count?: number | null;
        vendor_rating_avg?: number | null;
        vendor_rating_count?: number | null;
        cod_clean_return_count?: number | null;
        cod_discrepancy_count?: number | null;
        cod_volume_returned?: number | null;
        composite_score?: number | null;
        computed_at?: Date | null;
    };
    vehicle_info?: {
        vehicle_type?: string | null;
        plate_number?: string | null;
        color?: string | null;
        photo_file_id?: ObjectId | null;
    } | null;
    home_base?: { service_radius_km?: number | null; label?: string | null };
    settings?: { auto_accept_assignments?: boolean };
    preferences?: { navigation_app?: string };
    timezone?: string;
    preferred_language?: string;
    created_at: Date;
    updated_at: Date;
}

/**
 * The list whitelist — what a directory row may see.
 *
 * A whitelist rather than an exclusion list, and on this collection that choice carries
 * the most weight of anywhere in the service: `delivery_agents` holds government identity
 * documents, payout destinations and a third party's phone number. An exclusion list
 * protects only what somebody thought of.
 */
const AGENT_LIST_PROJECTION = {
    _id: 1,
    user_id: 1,
    name: 1,
    email: 1,
    phone: 1,
    avatar_file_id: 1,
    status: 1,
    status_reason: 1,
    'kyc.status': 1,
    'platform_ban.banned': 1,
    'availability.state': 1,
    'availability.changed_at': 1,
    'working_state.state': 1,
    'capacity.max_active_shipments': 1,
    'capacity.active_shipment_count': 1,
    'tracking.allowed': 1,
    'cod.trust_score': 1,
    // The pinned score travels with the computed one EVERYWHERE, list included. A row
    // showing 35 next to a dispatch that succeeded is the confusion this closes.
    'cod.trust_override.score': 1,
    'cod.trust_override.reason': 1,
    'cod.trust_override.set_at': 1,
    'cod.trust_override.set_by_name': 1,
    onboarding_step: 1,
    created_at: 1,
    updated_at: 1,
} as const;

/**
 * What the DETAIL adds. The base gets the narrow one, so this is the visible diff.
 *
 * ── Never projected, and why each ────────────────────────────────────────────
 *
 * | `legal_identity`    | `drivers_license_number`, `national_id_number` — government
 * |                     | identity documents. The agent profile DTO in jovi-mall carries
 * |                     | SECURITY comments on this field for the same reason.
 * | `payout_details`    | Bank account numbers and mobile-money MSISDNs, masked even for
 * |                     | the agent themselves.
 * | `emergency_contact` | A THIRD PARTY's name and phone. The only field on this document
 * |                     | whose subject is not on the platform at all, and the one most
 * |                     | likely to be added back by somebody who has not thought about it.
 * | `home_base.location`| A 2dsphere point on a person's residence. `home_base.label`
 * |                     | ("Douala — Akwa") answers the operational question without it.
 * | `wa`, `avatar_url`  | A messaging-channel binding, and a deprecated field.
 *
 * ── `trust_signals` is enumerated, not taken whole ───────────────────────────
 * `trust_signals: 1` and the dotted paths below are DIFFERENT guarantees. The former lets
 * a sensitive field added to that sub-document next year arrive here automatically, which
 * is the exact failure a whitelist exists to prevent. The one sub-document taken whole in
 * this phase is the AGENCY's `policies`, and that is argued for on its own terms — those
 * are commercial terms already visible to every connected vendor.
 *
 * ── `last_known_tracking_state.last_position` IS projected ───────────────────
 * Deliberately, and with a caveat the DTO carries onto the wire. jovi-mall's legacy admin
 * detail already serves it, so withholding it would be a silent parity break somebody
 * re-adds as a missing-field bug. It is a business MIRROR, stale by construction — the
 * source of truth for a live position is geo-tracker, which this service has no door to —
 * so the DTO ships it beside `isStale` and never as a live position.
 */
const AGENT_DETAIL_EXTRAS = {
    email_verified: 1,
    phone_verified: 1,
    'vehicle_info.vehicle_type': 1,
    'vehicle_info.plate_number': 1,
    'vehicle_info.color': 1,
    'vehicle_info.photo_file_id': 1,
    'kyc.verified_at': 1,
    'kyc.verified_by_user_id': 1,
    'kyc.verified_by_source': 1,
    'kyc.verified_by_name': 1,
    'kyc.rejection_reason': 1,
    'kyc.reference': 1,
    'platform_ban.reason': 1,
    'platform_ban.banned_at': 1,
    'platform_ban.banned_by_user_id': 1,
    'platform_ban.banned_by_source': 1,
    'platform_ban.banned_by_name': 1,
    'availability.reason': 1,
    'working_state.active_shipment_count': 1,
    'working_state.computed_at': 1,
    'capacity.reconciled_at': 1,
    'tracking.reason': 1,
    'tracking.changed_at': 1,
    'tracking.changed_by_user_id': 1,
    'tracking.changed_by_role': 1,
    'tracking.changed_by_source': 1,
    'tracking.changed_by_name': 1,
    'device.platform': 1,
    'device.app_version': 1,
    'device.location_permission': 1,
    'device.location_services_enabled': 1,
    'device.background_location_enabled': 1,
    'device.battery_optimization_exempt': 1,
    'device.push_enabled': 1,
    'device.reported_at': 1,
    'last_known_tracking_state.status': 1,
    'last_known_tracking_state.last_position': 1,
    'last_known_tracking_state.last_reported_at': 1,
    'last_known_tracking_state.source': 1,
    // Enumerated field by field like everything else in this projection, not taken whole:
    // the block is jovi-mall's to grow, and a whitelist is what stops a field added there
    // arriving here on its own.
    'last_known_tracking_state.last_place.label': 1,
    'last_known_tracking_state.last_place.source': 1,
    'last_known_tracking_state.last_place.resolved_at': 1,
    'cod.max_threshold': 1,
    // The detail projection extends the list one, which already carries `trust_score` and
    // the four `trust_override` paths.
    'trust_signals.on_time_rate': 1,
    'trust_signals.assignment_response_rate': 1,
    'trust_signals.completed_shipments': 1,
    'trust_signals.customer_rating_avg': 1,
    'trust_signals.customer_rating_count': 1,
    'trust_signals.agency_rating_avg': 1,
    'trust_signals.agency_rating_count': 1,
    'trust_signals.vendor_rating_avg': 1,
    'trust_signals.vendor_rating_count': 1,
    'trust_signals.cod_clean_return_count': 1,
    'trust_signals.cod_discrepancy_count': 1,
    'trust_signals.cod_volume_returned': 1,
    'trust_signals.composite_score': 1,
    'trust_signals.computed_at': 1,
    'home_base.label': 1,
    'home_base.service_radius_km': 1,
    'settings.auto_accept_assignments': 1,
    'preferences.navigation_app': 1,
    timezone: 1,
    preferred_language: 1,
} as const;

export interface AgentSearchQuery extends ListQueryBase {
    search?: string;
    status?: string;
    kycStatus?: string;
    availability?: string;
    workingState?: string;
    banned?: boolean;
    trackingAllowed?: boolean;
    from?: Date;
    to?: Date;
}

export class AgentReadRepository extends PlatformReadRepository<AgentReadModel> {
    constructor() {
        // The NARROW projection is the default — the safe direction. `findById` names the
        // extras explicitly, where they are a visible diff.
        super(COLLECTIONS.DELIVERY_AGENT, AGENT_LIST_PROJECTION);
    }

    /**
     * The directory. A plain `findPage` — no join, because nothing on a directory row
     * comes from another collection, and the roster join belongs on the agency side.
     */
    async search(query: AgentSearchQuery): Promise<Paginated<AgentReadModel>> {
        return this.findPage(buildAgentFilter(query), {
            page: query.page,
            limit: query.limit,
            sort: toMongoSort(query.sort, AGENT_SORT),
        });
    }

    async findById(agentId: string): Promise<AgentReadModel | null> {
        if (!Types.ObjectId.isValid(agentId)) return null;
        return this.aggregateOne<AgentReadModel>(
            [{ $match: { _id: new ObjectId(agentId) } }],
            AGENT_DETAIL_EXTRAS,
        );
    }

    /**
     * Display names for a page of ids, batched.
     *
     * Here rather than in the shipments module because the alternative is a second
     * projection of `delivery_agents` declared somewhere else — and this collection holds
     * `legal_identity`, `payout_details` and device telemetry, so a second projection of it
     * is a second thing to get right. One name-only read, owned by the module that owns the
     * collection. Same reasoning as `vendor.controller.ts` reusing `UserReadRepository`.
     */
    async findNamesByIds(ids: ObjectId[]): Promise<Map<string, string | null>> {
        if (ids.length === 0) return new Map();
        const rows = await this.findBy({ _id: { $in: ids } } as Filter<AgentReadModel>, {
            projection: { _id: 1, name: 1 },
            limit: ids.length,
        });
        return new Map(rows.map((row) => [row._id.toString(), row.name ?? null]));
    }

    /**
     * Where each of these agents' KYC review stands — the raw verdict string, batched.
     *
     * ⚠ **Returns the STRING, not a boolean, and interpreting it is the caller's job.**
     * `money/domain/owner-verification.ts` does that, fail-closed, for all three roles at
     * once. A repository that returned `verified: boolean` would be a third place holding
     * an opinion about which values count as approval, and the three would drift.
     *
     * Here rather than in the money module for the reason `findNamesByIds` gives: a second
     * projection of this collection declared elsewhere is a second thing to get right. And this one holds
     * `legal_identity` and `payout_details`, so that reason is at its strongest here.
     *
     * `null` for a row whose `kyc.status` is absent, which is a different fact from a
     * verdict this service has not been taught — the caller treats both as unverified, but
     * only after being told which it got.
     */
    async findKycVerdictsByIds(ids: ObjectId[]): Promise<Map<string, string | null>> {
        if (ids.length === 0) return new Map();
        const rows = await this.findBy({ _id: { $in: ids } } as Filter<AgentReadModel>, {
            // ⚠ The agent's verdict lives on `kyc`; the vendor's and the agency's on
            // `kyc_details`. One name would have been nicer — renaming either is a data
            // migration, so the difference is spelled out at each of the three call sites
            // rather than papered over.
            projection: { _id: 1, 'kyc.status': 1 },
            limit: ids.length,
        });
        return new Map(rows.map((row) => [row._id.toString(), row.kyc?.status ?? null]));
    }

    /**
     * The COD context for a page of holders: the name, plus the trust score and the
     * ceiling it drives.
     *
     * Here rather than in the COD module for the same reason as the method above, and it
     * matters more: `delivery_agents` is the collection holding `legal_identity` and
     * `payout_details`, and a second projection of it declared next door is a second thing
     * to get right. This one names four fields and nothing else.
     *
     * `cod.trust_score` and `cod.max_threshold` are DENORMALISED onto the agent by the COD
     * subsystem — `cod_trust_events` is the history and this is the current value — so the
     * holders list reads them off the agent rather than folding the event log per row.
     */
    async findCodContextByIds(ids: ObjectId[]): Promise<Map<string, AgentCodProfile>> {
        if (ids.length === 0) return new Map();
        const rows = await this.findBy({ _id: { $in: ids } } as Filter<AgentReadModel>, {
            projection: { _id: 1, name: 1, 'cod.trust_score': 1, 'cod.max_threshold': 1 },
            limit: ids.length,
        });
        return new Map(
            rows.map((row) => [
                row._id.toString(),
                {
                    name: row.name ?? null,
                    trustScore: row.cod?.trust_score ?? null,
                    maxThreshold: row.cod?.max_threshold ?? null,
                },
            ]),
        );
    }
}

/** What the COD holders list needs off an agent, and nothing more. */
export interface AgentCodProfile {
    name: string | null;
    trustScore: number | null;
    maxThreshold: number | null;
}

/**
 * Built here rather than in the controller so the scope cannot be dropped by a caller,
 * and exported so `test-agents.ts` can assert the branches without a database.
 */
export function buildAgentFilter(query: AgentSearchQuery): Filter<AgentReadModel> {
    const clauses: Record<string, unknown>[] = [];

    if (query.status) clauses.push({ status: query.status });
    if (query.kycStatus) clauses.push({ 'kyc.status': query.kycStatus });
    if (query.availability) clauses.push({ 'availability.state': query.availability });
    if (query.workingState) clauses.push({ 'working_state.state': query.workingState });

    if (query.banned !== undefined) {
        // `platform_ban.banned` has a schema default of `false`, so an equality match on
        // `false` is correct rather than needing a `$ne: true` — every document written
        // through the model carries the field.
        clauses.push({ 'platform_ban.banned': query.banned });
    }
    if (query.trackingAllowed !== undefined) {
        clauses.push({ 'tracking.allowed': query.trackingAllowed });
    }

    if (query.from || query.to) {
        const range: Record<string, Date> = {};
        if (query.from) range.$gte = query.from;
        // Half-open `[from, to)` — consecutive ranges tile exactly and no row is counted
        // twice at a boundary.
        if (query.to) range.$lt = query.to;
        clauses.push({ created_at: range });
    }

    const search = query.search?.trim();
    if (search) clauses.push(agentSearchClause(search));

    if (clauses.length === 0) return {} as Filter<AgentReadModel>;
    if (clauses.length === 1) return clauses[0] as Filter<AgentReadModel>;

    /**
     * `$and`, not `Object.assign` — the search clause is an `$or`, and merging two
     * `$or`-shaped filters by assignment silently drops the earlier one.
     */
    return { $and: clauses } as Filter<AgentReadModel>;
}

/**
 * Match a name, an email, a phone number, or an agent id.
 *
 * The id branch matters more than it looks: every other admin screen — a shipment, a COD
 * discrepancy, an audit row — identifies an agent by their id, so pasting one into the
 * only box on the directory is the obvious move, and a directory that answers "no results"
 * to a valid id looks broken rather than strict.
 *
 * `containsInsensitive` escapes the term before it reaches a `$regex`: an unescaped one is
 * both a correctness bug and a catastrophic-backtracking pattern the caller supplies.
 */
function agentSearchClause(term: string): Record<string, unknown> {
    const pattern = containsInsensitive(term);
    const branches: Record<string, unknown>[] = [
        { name: pattern },
        { email: pattern },
        { phone: pattern },
    ];

    if (Types.ObjectId.isValid(term) && term.length === 24) {
        branches.push({ _id: new ObjectId(term) });
    }

    return { $or: branches };
}
