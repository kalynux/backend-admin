import { Document, Filter, ObjectId } from 'mongodb';
import { Types } from 'mongoose';
import { containsInsensitive, toMongoSort } from '../../../core/data/mongo-list';
import { ListQueryBase } from '../../../core/http/list-query';
import { COLLECTIONS } from '../../../infra/platform/collections';
import { Paginated, PlatformReadRepository } from '../../../infra/platform/platform.repository';
import { AGENCY_SORT } from '../validators/agency.validator';

/**
 * Reading delivery agencies straight out of `jovi_mall`.
 *
 * ── Why this domain reads directly (ADR-008 D-1) ──────────────────────────────
 * The rule: **delegate a read whose answer is a verdict the platform acts on; read
 * directly a read whose answer is a record.** An agency row is a record. Nothing about
 * `find({ status: 'inactive' })` can leave the database inconsistent, and jovi-mall's own
 * `findAllForAdmin` is a query with no logic in it worth calling over HTTP.
 *
 * Every WRITE is the opposite and goes over the internal API. Deactivation in particular
 * suspends every vendor product defaulting to this agency and holds their order items, in
 * one transaction paired with post-commit events — a second writer would get the rows
 * right and silently get the notifications wrong. `PlatformReadRepository` has no write
 * method, so that is not something this file could break by accident.
 */

/** The agency's business surface, joined from `agency_magazins`. */
export interface AgencyMagazinRef extends Document {
    name?: string;
    logo_file_id?: ObjectId | null;
    coverage_areas?: string[];
}

export interface AgencyReadModel extends Document {
    _id: ObjectId;
    user_id: ObjectId;
    display_name?: string | null;
    email?: string | null;
    email_verified?: boolean;
    phone?: string | null;
    phone_verified?: boolean;
    country?: string | null;
    status: 'active' | 'pending_verification' | 'inactive';
    onboarding_step?: number;
    legit_verified?: boolean;
    kyc_details?: {
        registration_number?: string | null;
        transport_license_id?: string | null;
        legit_verified?: boolean;
        status?: 'pending' | 'verified' | 'rejected';
        rejection_reason?: string | null;
        verified_at?: Date | null;
        verified_by_user_id?: ObjectId | null;
        verified_by_source?: 'platform' | 'admin';
        verified_by_name?: string | null;
    };
    policies?: Record<string, unknown> | null;
    assignment_settings?: { auto_assign_enabled?: boolean };
    policy_version?: number;
    timezone?: string;
    preferred_language?: string;
    created_at: Date;
    updated_at: Date;
    /** Present only on the list/detail aggregate, from the `$lookup`. */
    magazin?: AgencyMagazinRef | null;
}

/**
 * The list whitelist — what a directory row may see.
 *
 * Narrower than the detail projection on purpose. A registration number in a hundred-row
 * response is a hundred registration numbers in a browser for a screen that renders none.
 *
 * A whitelist rather than an exclusion list: an exclusion protects only what somebody
 * thought of, so a sensitive field added to `delivery_agencies` next year would arrive
 * here automatically. This way it does not.
 */
const AGENCY_LIST_PROJECTION = {
    _id: 1,
    user_id: 1,
    display_name: 1,
    country: 1,
    status: 1,
    onboarding_step: 1,
    legit_verified: 1,
    'kyc_details.legit_verified': 1,
    'assignment_settings.auto_assign_enabled': 1,
    created_at: 1,
    updated_at: 1,
} as const;

/**
 * What the DETAIL adds on top of the list.
 *
 * Expressed as the delta rather than the whole set because that is what the base class
 * takes: `aggregateOne`/`aggregatePage` spread the repository's own projection first and
 * let a caller only ADD. So the narrow one is the default — the safe direction — and this
 * is the visible diff naming what a detail screen is additionally allowed to see.
 *
 * `policies` is taken as a WHOLE sub-document, and it is the one place in this module
 * that happens. That is a considered exception, not an inconsistency: those are pricing
 * and returns terms already visible to every vendor connected to the agency, so there is
 * no field that could be added to them which this surface should not see. Contrast
 * `trust_signals` on the agent read model, which is enumerated field by field.
 *
 * ── Never projected, and why ─────────────────────────────────────────────────
 *  - `payout_details` — bank account numbers and mobile-money MSISDNs. The same shape
 *    whose maskers exist across three DTOs precisely because the raw form must not leave.
 *  - `wa` — the WhatsApp channel binding. A messaging identifier, not administrative data.
 */
const AGENCY_DETAIL_EXTRAS = {
    email: 1,
    email_verified: 1,
    phone: 1,
    phone_verified: 1,
    'kyc_details.registration_number': 1,
    'kyc_details.transport_license_id': 1,
    // The verdict, added Phase 6 Step 4. Enumerated like everything else here — the
    // whole point of the dotted-path whitelist is that a field added to that sub-document
    // next year does NOT arrive automatically.
    'kyc_details.status': 1,
    'kyc_details.rejection_reason': 1,
    'kyc_details.verified_at': 1,
    'kyc_details.verified_by_user_id': 1,
    'kyc_details.verified_by_source': 1,
    'kyc_details.verified_by_name': 1,
    policies: 1,
    policy_version: 1,
    timezone: 1,
    preferred_language: 1,
} as const;

/**
 * What the `$lookup` may take off the Magazin.
 *
 * The inner `$project` is not optional. Without it whole Magazin documents enter the
 * aggregation and survive to the output — the same reasoning that makes the base
 * projection mandatory, applied to the joined side, where it is easier to forget.
 *
 * ── `_id: 0` is legal HERE and illegal one stage later ────────────────────────
 * This runs as the `$lookup` pipeline's own `$project`, where dropping `_id` is an ordinary
 * exclusion. The same object used as a NESTED value in the outer `$project` — `{ magazin:
 * MAGAZIN_PROJECTION }` — is an exclusion inside an inclusion projection, which Mongo
 * refuses outright ("Cannot do exclusion on field _id in inclusion projection"). Both read
 * paths below therefore name the joined field as `magazin: 1` and let THIS stage be the
 * whitelist. See the note at each call site.
 */
const MAGAZIN_PROJECTION = {
    _id: 0,
    name: 1,
    logo_file_id: 1,
    coverage_areas: 1,
} as const;

/**
 * How the outer `$project` keeps the joined sub-document: by NAME, not by re-stating its
 * shape.
 *
 * Restating it looked like defence in depth and was in fact a 500 on every request — the
 * detail and the directory both, from Phase 9 until Phase 11 found it. Nothing is lost:
 * `magazinLookup()`'s inner `$project` has already narrowed the joined document to three
 * fields, so `magazin: 1` admits exactly those three and no more.
 */
const KEEP_MAGAZIN = { magazin: 1 } as const;

export interface AgencySearchQuery extends ListQueryBase {
    search?: string;
    status?: string;
    verified?: boolean;
    autoAssign?: boolean;
    country?: string;
    from?: Date;
    to?: Date;
}

export class AgencyReadRepository extends PlatformReadRepository<AgencyReadModel> {
    constructor() {
        // The NARROW projection is the default. Both joined read paths spread it first and
        // may only add, so the widest thing this repository can leak by accident is a
        // directory row.
        super(COLLECTIONS.DELIVERY_AGENCY, AGENCY_LIST_PROJECTION);
    }

    /**
     * The directory.
     *
     * ── Why the `$lookup` is in `match` and not `join` ───────────────────────
     * `aggregatePage` offers a fast path — page first, then enrich at most `limit`
     * documents. This list cannot take it, because `search` matches the **business name**,
     * which lives on the Magazin: a filter on a joined field has to run before the page is
     * cut. So the join goes in the narrowing half and the sort is a blocking in-memory one.
     *
     * That is a real cost, accepted knowingly and bounded by the collection's size (an
     * agency is a business relationship, not a user account). jovi-mall's own
     * `findAllForAdmin` already does exactly this. The alternative — dropping business-name
     * search — would leave an administrator unable to find an agency by the only name they
     * know it by, since `display_name` here is a *contact person*.
     */
    async search(query: AgencySearchQuery): Promise<Paginated<AgencyReadModel>> {
        return this.aggregatePage<AgencyReadModel>(
            {
                page: query.page,
                limit: query.limit,
                sort: toMongoSort(query.sort, AGENCY_SORT),
            },
            {
                match: [
                    ...this.magazinLookup(),
                    { $match: buildAgencyFilter(query) },
                ],
                // `KEEP_MAGAZIN`, never `{ magazin: MAGAZIN_PROJECTION }` — the nested form
                // carries `_id: 0` into an inclusion projection and Mongo refuses the query.
                project: KEEP_MAGAZIN,
            },
        );
    }

    /** One agency, with its business surface and the detail-only fields. */
    async findById(agencyId: string): Promise<AgencyReadModel | null> {
        if (!Types.ObjectId.isValid(agencyId)) return null;

        return this.aggregateOne<AgencyReadModel>(
            [{ $match: { _id: new ObjectId(agencyId) } }, ...this.magazinLookup()],
            { ...AGENCY_DETAIL_EXTRAS, ...KEEP_MAGAZIN },
        );
    }

    /**
     * Business names for a page of agency ids, batched.
     *
     * Reuses `magazinLookup()` rather than querying `agency_magazins` directly, so the
     * "which name is the agency's business name" question keeps one answer — including the
     * `preserveNullAndEmptyArrays` behaviour that keeps an agency with no Magazin in the
     * result instead of silently dropping it. Falls back to `display_name`, because a
     * shipment must still name its agency while onboarding is incomplete.
     */
    async findNamesByIds(ids: ObjectId[]): Promise<Map<string, string | null>> {
        if (ids.length === 0) return new Map();

        // `aggregateBy` applies no projection of its own, so the `$project` is the last
        // stage here — name only, nothing else off either collection.
        const rows = await this.aggregateBy<{
            _id: ObjectId;
            display_name?: string | null;
            magazin?: { name?: string | null } | null;
        }>([
            { $match: { _id: { $in: ids } } },
            ...this.magazinLookup(),
            { $project: { _id: 1, display_name: 1, 'magazin.name': 1 } },
        ]);

        return new Map(
            rows.map((row) => [row._id.toString(), row.magazin?.name ?? row.display_name ?? null]),
        );
    }

    /**
     * The BUSINESS name only — the Magazin's, or `null`.
     *
     * ── How this differs from `findNamesByIds`, and why both exist ──────────────
     * That one falls back to `display_name`, deliberately: its callers are money and
     * billing rows that must name their counterparty somehow, and "no label at all" is
     * useless on a payout list.
     *
     * This one refuses the fallback, because its callers render `businessName` BESIDE
     * `contactName`, and `display_name` IS the contact name — an agency's contact person.
     * Falling back would print the same human's name in a column headed "Agency" and a
     * sub-line headed "Contact person", which is precisely the mislabelling the dashboard
     * reported: the column has been showing a person where a business belongs.
     *
     * `null` where the Magazin has none — an agency mid-onboarding legitimately has no
     * business name yet and must still be identifiable by its id. `null`, never `''`.
     */
    async findBusinessNamesByIds(ids: ObjectId[]): Promise<Map<string, string | null>> {
        if (ids.length === 0) return new Map();

        const rows = await this.aggregateBy<{ _id: ObjectId; magazin?: { name?: string | null } | null }>([
            { $match: { _id: { $in: ids } } },
            ...this.magazinLookup(),
            { $project: { _id: 1, 'magazin.name': 1 } },
        ]);

        return new Map(rows.map((row) => [row._id.toString(), row.magazin?.name ?? null]));
    }

    /**
     * The directory ROW for a page of agency ids — business name, contact name, status,
     * country — batched into one query.
     *
     * ── Why a batched hydrate rather than a `$lookup` on the caller's list ─────
     * `GET /vendors/:vendorId/agencies` (BR-018) needs the same four-field decoration
     * `toAgentContractDto` puts on a contract row. It could join `delivery_agencies` and
     * then `agency_magazins` from inside the connections aggregation — that is what
     * `ContractReadRepository.agencyLookup()` does — but it would be a SECOND pipeline
     * answering "what is this agency called", in a module that does not own agencies. The
     * Magazin join is subtle enough (`preserveNullAndEmptyArrays` on both levels, `_id: 0`
     * legal in the inner `$project` and fatal in the outer) that two copies of it is how
     * two screens end up disagreeing.
     *
     * So the page is cut on its own index first and its agencies are hydrated here, in one
     * indexed `$in` — the same shape `VendorController.search` uses to hydrate a page of
     * stores, and bounded by `limit` for the same reason.
     *
     * The LIST projection, not the detail one: this is a decoration, not an agency record.
     * A row whose agency was hard-deleted is simply absent from the map, and the caller
     * renders `null` rather than dropping the connection — that broken state is exactly
     * what an administrator opens the panel to find.
     */
    async findRowsByIds(ids: ObjectId[]): Promise<Map<string, AgencyReadModel>> {
        if (ids.length === 0) return new Map();

        const rows = await this.aggregatePage<AgencyReadModel>(
            // One page, sized to the request. `aggregatePage` rather than `aggregateBy`
            // because only the former applies this repository's own projection — the whole
            // point of the base class, and the guarantee `aggregateBy` does not carry.
            { page: 1, limit: ids.length, sort: { _id: 1 } },
            {
                match: [{ $match: { _id: { $in: ids } } }],
                join: this.magazinLookup(),
                project: KEEP_MAGAZIN,
            },
        );

        return new Map(rows.items.map((row) => [row._id.toString(), row]));
    }

    /**
     * The join, in one place so the list and the detail cannot drift.
     *
     * `$unwind` with `preserveNullAndEmptyArrays` rather than a plain unwind: an agency
     * whose Magazin has not been provisioned yet is a real state — it is exactly the state
     * an administrator opens this screen to find — and a plain `$unwind` would drop those
     * rows from the directory entirely.
     */
    private magazinLookup(): Document[] {
        return [
            {
                $lookup: {
                    from: COLLECTIONS.AGENCY_MAGAZIN,
                    localField: '_id',
                    foreignField: 'agency_id',
                    pipeline: [{ $project: MAGAZIN_PROJECTION }],
                    as: 'magazin',
                },
            },
            { $unwind: { path: '$magazin', preserveNullAndEmptyArrays: true } },
        ];
    }
}

/**
 * Built here rather than in the controller so the scope cannot be dropped by a caller,
 * and exported so `test-agencies.ts` can assert the branches without a database.
 */
export function buildAgencyFilter(query: AgencySearchQuery): Filter<AgencyReadModel> {
    const clauses: Record<string, unknown>[] = [];

    if (query.status) clauses.push({ status: query.status });
    if (query.country) clauses.push({ country: query.country });

    if (query.verified !== undefined) {
        // Read from `kyc_details`, the canonical location — the top-level `legit_verified`
        // is the deprecated mirror. Both are written together by the one writer there is,
        // so a disagreement means a hand-edited document; the DTO surfaces both so that is
        // visible, but the FILTER commits to one, or a query would return rows that
        // contradict the column beside them.
        clauses.push({ 'kyc_details.legit_verified': query.verified });
    }
    if (query.autoAssign !== undefined) {
        clauses.push({ 'assignment_settings.auto_assign_enabled': query.autoAssign });
    }

    if (query.from || query.to) {
        const range: Record<string, Date> = {};
        if (query.from) range.$gte = query.from;
        // Half-open `[from, to)`, matching `dateRangeFields` — consecutive ranges tile
        // exactly and no row is counted twice at a boundary.
        if (query.to) range.$lt = query.to;
        clauses.push({ created_at: range });
    }

    const search = query.search?.trim();
    if (search) clauses.push(agencySearchClause(search));

    if (clauses.length === 0) return {} as Filter<AgencyReadModel>;
    if (clauses.length === 1) return clauses[0] as Filter<AgencyReadModel>;

    /**
     * `$and`, not `Object.assign`. The search clause is an `$or`; merging two `$or`-shaped
     * filters by assignment silently drops the earlier one, which is how `audit-subject.ts`
     * documents a Support administrator being handed the whole administrator directory.
     */
    return { $and: clauses } as Filter<AgencyReadModel>;
}

/**
 * Match a business name, a contact name, an email, a phone — or an agency id.
 *
 * `magazin.name` first because it is what an administrator actually types: the agency is
 * known to the platform by its business name, and `display_name` here is a contact
 * person. This branch is the reason the join runs before the page is cut.
 *
 * The id branch matters for the same reason it does on the user directory: every other
 * screen identifies an agency by its id, so pasting one into the only search box is the
 * obvious move, and a directory that answers "no results" to a valid id looks broken.
 *
 * `containsInsensitive` escapes the term before it reaches a `$regex` — an unescaped one
 * is both a correctness bug (`a.b` matching `axb`) and a catastrophic-backtracking pattern
 * supplied by the caller.
 */
function agencySearchClause(term: string): Record<string, unknown> {
    const pattern = containsInsensitive(term);
    const branches: Record<string, unknown>[] = [
        { 'magazin.name': pattern },
        { display_name: pattern },
        { email: pattern },
        { phone: pattern },
    ];

    if (Types.ObjectId.isValid(term) && term.length === 24) {
        branches.push({ _id: new ObjectId(term) });
    }

    return { $or: branches };
}
