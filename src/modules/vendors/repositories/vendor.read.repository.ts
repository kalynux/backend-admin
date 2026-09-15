import { Document, Filter, ObjectId } from 'mongodb';
import { Types } from 'mongoose';
import { containsInsensitive, toMongoSort } from '../../../core/data/mongo-list';
import { ListQueryBase } from '../../../core/http/list-query';
import { COLLECTIONS } from '../../../infra/platform/collections';
import { Paginated, PlatformReadRepository } from '../../../infra/platform/platform.repository';
import { VENDOR_SORT } from '../validators/vendor.validator';

/**
 * Reading platform vendors straight out of `jovi_mall`.
 *
 * ── Why this domain reads directly instead of delegating ──────────────────────
 * The same reasoning as `users`: there is no vendor-administration read service in
 * jovi-mall to call, and a read has no invariant to protect — nothing about
 * `find({ status: 'inactive' })` can leave the database inconsistent.
 *
 * The WRITES are the opposite and go over the internal API (ADR-004 D-2), and here the
 * asymmetry is starker than it was for users: suspending a vendor takes their whole
 * catalogue off sale inside one transaction, and reinstating them re-runs the activation
 * gate on every listing. `PlatformReadRepository` has no write method, so that rule is not
 * something this file could break by accident.
 */

/**
 * What a vendor looks like to the admin dashboard.
 *
 * Note the two fields that are ABSENT, and are absent by projection rather than by being
 * deleted afterwards: `payout_details` (bank and mobile-money destinations) and
 * `kyc_details.national_id_number` (a national identity number). Neither has any business
 * on an administrative screen, and a field that never leaves the database cannot leak from
 * a serialiser somebody forgets to update.
 */
export interface VendorReadModel extends Document {
    _id: ObjectId;
    user_id: ObjectId;
    display_name?: string;
    email?: string;
    phone?: string;
    email_verified?: boolean;
    phone_verified?: boolean;
    country?: string | null;
    status: 'active' | 'pending_verification' | 'inactive';
    suspended_at?: Date | null;
    suspended_reason?: string | null;
    suspended_from_status?: string | null;
    suspended_by_user_id?: ObjectId | null;
    suspended_by_source?: 'platform' | 'admin';
    suspended_by_name?: string | null;
    kyc_details?: {
        legit_verified?: boolean;
        status?: string;
        verified_at?: Date | null;
        rejection_reason?: string | null;
        reviewed_by_user_id?: ObjectId | null;
        reviewed_by_source?: 'platform' | 'admin';
        reviewed_by_name?: string | null;
    };
    onboarding_step: number;
    policy_version?: number;
    default_delivery_agency_id?: ObjectId | null;
    timezone?: string;
    preferred_language?: string;
    wa?: { verified?: boolean };
    /**
     * The vendor's own commercial terms — returns, cancellation, support, and up to two
     * off-platform document links. Roughly thirty fields, mapped by name in
     * `read-models/vendor-policies.dto.ts`; untyped here because the mapper is the
     * definition and a second declaration would drift from it.
     */
    policies?: Record<string, unknown> | null;
    business_addresses?: {
        _id?: ObjectId;
        label?: string;
        address_line1?: string;
        address_line2?: string;
        city?: string;
        state?: string;
    }[];
    created_at: Date;
    updated_at: Date;
}

/**
 * The list whitelist. Every field the directory may see, named.
 *
 * A whitelist rather than `{ payout_details: 0 }`: an exclusion list protects only what
 * somebody thought of, so a sensitive field added to `vendors` next year would arrive here
 * automatically. This way it does not.
 *
 * Note `'kyc_details.legit_verified'` and `'kyc_details.status'` as DOTTED paths. A bare
 * `kyc_details: 1` would ship `national_id_number` along with the flag — the single most
 * important line in this file, and what `test-vendors.ts` scans the whole module for.
 */
const VENDOR_LIST_PROJECTION = {
    _id: 1,
    user_id: 1,
    display_name: 1,
    email: 1,
    phone: 1,
    email_verified: 1,
    phone_verified: 1,
    country: 1,
    status: 1,
    suspended_at: 1,
    suspended_reason: 1,
    suspended_from_status: 1,
    suspended_by_user_id: 1,
    suspended_by_source: 1,
    suspended_by_name: 1,
    'kyc_details.legit_verified': 1,
    'kyc_details.status': 1,
    onboarding_step: 1,
    created_at: 1,
    updated_at: 1,
} as const;

/**
 * The detail adds the review provenance, the contact/locale block, the policy presence
 * flags and the postal part of the business addresses.
 *
 * `business_addresses.geo` and `.location` are deliberately NOT projected. A verification
 * review needs the textual address; the precise coordinates of somebody's premises are a
 * different thing, and a dotted projection is what keeps them out rather than a promise.
 *
 * ── `policies` is taken WHOLE, and that changed deliberately ─────────────────
 * It used to be three dotted leaf paths reduced to presence booleans, on the reasoning
 * that a detail screen asks "have they set this up" rather than "what does it say". That
 * turned out to be exactly backwards for the screen that matters: a dispute lands on what
 * the return policy SAYS, and an administrator could not see it.
 *
 * Taken whole for the same reason the agency's is, and the argument is stronger here: an
 * agency's terms are visible to every vendor connected to it, and a vendor's return and
 * cancellation policy is published to every CUSTOMER on the storefront. There is no field
 * that could be added to them which this surface should not see.
 *
 * The wide projection is safe because `read-models/vendor-policies.dto.ts` names every
 * field — a field added upstream reaches this read model and stops at the mapper.
 * Nothing sensitive lives in this sub-document: `payout_details` and
 * `kyc_details.national_id_number` are elsewhere and remain unprojected.
 */
const VENDOR_DETAIL_PROJECTION = {
    ...VENDOR_LIST_PROJECTION,
    'kyc_details.verified_at': 1,
    'kyc_details.rejection_reason': 1,
    'kyc_details.reviewed_by_user_id': 1,
    'kyc_details.reviewed_by_source': 1,
    'kyc_details.reviewed_by_name': 1,
    policy_version: 1,
    default_delivery_agency_id: 1,
    timezone: 1,
    preferred_language: 1,
    'wa.verified': 1,
    policies: 1,
    'business_addresses._id': 1,
    'business_addresses.label': 1,
    'business_addresses.address_line1': 1,
    'business_addresses.address_line2': 1,
    'business_addresses.city': 1,
    'business_addresses.state': 1,
} as const;

export interface VendorSearchQuery extends ListQueryBase {
    /** Business name, display name, email, phone — or a vendor/user id. */
    search?: string;
    status?: 'active' | 'pending_verification' | 'inactive';
    kycStatus?: 'pending' | 'verified' | 'rejected';
    onboarding?: 'complete' | 'incomplete';
    country?: string;
    /** Half-open `[from, to)` over `created_at`. */
    from?: Date;
    to?: Date;
}

export class VendorReadRepository extends PlatformReadRepository<VendorReadModel> {
    constructor() {
        super(COLLECTIONS.VENDOR, VENDOR_LIST_PROJECTION);
    }

    /**
     * One page of the directory.
     *
     * `storeMatchIds` are the vendors whose BUSINESS name matched the search term,
     * resolved by the caller against `stores` before this runs — see the note on
     * `searchClause`. Passing them in rather than querying here is what keeps
     * `buildFilter` pure and therefore testable without a database.
     */
    async search(
        query: VendorSearchQuery,
        storeMatchIds: ObjectId[] = [],
    ): Promise<Paginated<VendorReadModel>> {
        return this.findPage(buildFilter(query, storeMatchIds), {
            page: query.page,
            limit: query.limit,
            sort: toMongoSort(query.sort, VENDOR_SORT),
        });
    }

    async findById(vendorId: string): Promise<VendorReadModel | null> {
        if (!Types.ObjectId.isValid(vendorId)) return null;
        return this.findOneBy({ _id: new ObjectId(vendorId) } as Filter<VendorReadModel>);
    }

    /**
     * Where each of these vendors' KYC review stands — the raw verdict string, batched.
     *
     * ⚠ **Returns the STRING, not a boolean, and interpreting it is the caller's job.**
     * `money/domain/owner-verification.ts` does that, fail-closed, for all three roles at
     * once. A repository that returned `verified: boolean` would be a third place holding
     * an opinion about which values count as approval, and the three would drift.
     *
     * Here rather than in the money module for the reason `findNamesByIds` gives: a second
     * projection of this collection declared elsewhere is a second thing to get right.
     *
     * `null` for a row whose `kyc_details.status` is absent, which is a different fact from a
     * verdict this service has not been taught — the caller treats both as unverified, but
     * only after being told which it got.
     */
    async findKycVerdictsByIds(ids: ObjectId[]): Promise<Map<string, string | null>> {
        if (ids.length === 0) return new Map();
        const rows = await this.findBy({ _id: { $in: ids } } as Filter<VendorReadModel>, {
            projection: { _id: 1, 'kyc_details.status': 1 },
            limit: ids.length,
        });
        return new Map(rows.map((row) => [row._id.toString(), row.kyc_details?.status ?? null]));
    }

    /** The detail view — the wider projection, one document. */
    async findDetailById(vendorId: string): Promise<VendorReadModel | null> {
        if (!Types.ObjectId.isValid(vendorId)) return null;
        const rows = await this.findBy(
            { _id: new ObjectId(vendorId) } as Filter<VendorReadModel>,
            { projection: VENDOR_DETAIL_PROJECTION, limit: 1 },
        );
        return rows[0] ?? null;
    }
}

/**
 * Built here rather than in the controller so the scope cannot be dropped by a caller —
 * the same reasoning as `users`, and exported for `test-vendors.ts`, which asserts every
 * branch without a database.
 *
 * Pure: `storeMatchIds` arrives as a parameter precisely so this function never queries.
 */
export function buildFilter(
    query: VendorSearchQuery,
    storeMatchIds: ObjectId[] = [],
): Filter<VendorReadModel> {
    const clauses: Record<string, unknown>[] = [];

    if (query.status) clauses.push({ status: query.status });
    if (query.country) clauses.push({ country: query.country });

    if (query.kycStatus) clauses.push(kycClause(query.kycStatus));

    if (query.onboarding) {
        // `onboarding_step === 0` is COMPLETED — see `VendorOnboardingStep` in jovi-mall,
        // where 0 is the finished state and 1+ are the remaining steps. The inversion is
        // easy to get backwards, which is why it is written down here rather than inlined.
        clauses.push(
            query.onboarding === 'complete'
                ? { onboarding_step: 0 }
                : { onboarding_step: { $ne: 0 } },
        );
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
    if (search) clauses.push(searchClause(search, storeMatchIds));

    if (clauses.length === 0) return {} as Filter<VendorReadModel>;
    if (clauses.length === 1) return clauses[0] as Filter<VendorReadModel>;

    /**
     * `$and`, not `Object.assign`.
     *
     * TWO of the clauses above can be `$or`-shaped — the search, and `kycStatus=pending`.
     * Merging by assignment would silently drop one of them, which is how
     * `audit-subject.ts` documents a Support administrator being handed the entire
     * administrator directory. Composing under `$and` cannot do that, and costs a nested
     * document.
     */
    return { $and: clauses } as Filter<VendorReadModel>;
}

/**
 * The verification filter, tolerant of rows written before `kyc_details.status` existed.
 *
 * Every vendor created before this phase has a `legit_verified` boolean and no `status`,
 * so a naive `{ 'kyc_details.status': 'pending' }` would report the entire existing roster
 * as "not pending" and the review queue would open empty. The second branch is what makes
 * the queue correct on day one, with or without a backfill.
 *
 * `approved` reads the boolean rather than the status for the same reason — it is the
 * field that has always been written, and the two are kept in step on every write.
 */
function kycClause(status: 'pending' | 'verified' | 'rejected'): Record<string, unknown> {
    if (status === 'verified') return { 'kyc_details.legit_verified': true };
    if (status === 'rejected') return { 'kyc_details.status': 'rejected' };

    return {
        $or: [
            { 'kyc_details.status': 'pending' },
            {
                'kyc_details.status': { $exists: false },
                'kyc_details.legit_verified': { $ne: true },
            },
        ],
    };
}

/**
 * Match a business name, a display name, an email, a phone number — or an id.
 *
 * ── Two id branches, not one ──────────────────────────────────────────────────
 * A 24-hex term is tried as the VENDOR id and as the USER id. The second matters as much
 * as the first: every other admin screen — the user directory, an order, an audit row —
 * identifies this person by their user id, so that is what gets pasted into the only
 * search box on the vendor directory. A directory that answers "no results" to an id the
 * operator just copied from the next tab looks broken rather than strict.
 *
 * ── Why the business name arrives as ids ──────────────────────────────────────
 * The name lives on `stores`. Resolving it to `vendor_id`s first costs one indexed query
 * and keeps the vendor page on its own index; joining instead would force the sort into
 * memory. See `VENDOR_SORT`'s header for the trade recorded there.
 *
 * The term is escaped by `containsInsensitive` before it reaches a `$regex`: an unescaped
 * one is both a correctness bug (`a.b` matching `axb`) and a catastrophic-backtracking
 * pattern the caller supplies.
 */
function searchClause(term: string, storeMatchIds: ObjectId[]): Record<string, unknown> {
    const pattern = containsInsensitive(term);
    const branches: Record<string, unknown>[] = [
        { display_name: pattern },
        { email: pattern },
        { phone: pattern },
    ];

    if (Types.ObjectId.isValid(term) && term.length === 24) {
        branches.push({ _id: new ObjectId(term) });
        branches.push({ user_id: new ObjectId(term) });
    }

    if (storeMatchIds.length > 0) {
        branches.push({ _id: { $in: storeMatchIds } });
    }

    return { $or: branches };
}
