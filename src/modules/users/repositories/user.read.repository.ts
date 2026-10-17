import { Document, Filter, ObjectId } from 'mongodb';
import { Types } from 'mongoose';
import { containsInsensitive, toMongoSort } from '../../../core/data/mongo-list';
import { ListQueryBase } from '../../../core/http/list-query';
import { COLLECTIONS } from '../../../infra/platform/collections';
import { Paginated, PlatformReadRepository } from '../../../infra/platform/platform.repository';
import { USER_SORT } from '../validators/user.validator';
import { isWholeId } from './role-profile.read.repository';

/**
 * Reading platform users straight out of `jovi_mall`.
 *
 * ── Why this domain reads directly instead of delegating ──────────────────────
 * There is no user-administration read service in jovi-mall to call — PHASE-0 found the
 * domain has no admin surface at all. Building one there just to call it from here would
 * put new code in the service that is being migrated away from. And a read has no
 * invariant to protect: nothing about `find({ roles: 'vendor' })` can leave the database
 * inconsistent.
 *
 * Writes are the opposite and go over the internal API (ADR-004 D-2) — suspending a user
 * is only *real* by virtue of the checks in jovi-mall's `requireAuth`, `login` and
 * refresh rotation. `PlatformReadRepository` has no write method, so that rule is not
 * something this file could break by accident.
 */

/**
 * What a user looks like to the admin dashboard.
 *
 * Note what is absent: `password_hash`. It is excluded by the projection below rather than
 * deleted after the fact — a field that never leaves the database cannot leak from a
 * serialiser somebody forgets to update.
 */
export interface UserReadModel extends Document {
    _id: ObjectId;
    login_email?: string;
    login_phone?: string;
    roles: string[];
    status: 'active' | 'suspended' | 'closed';
    suspended_at?: Date | null;
    suspended_reason?: string | null;
    suspended_by_user_id?: ObjectId | null;
    suspended_by_source?: 'platform' | 'admin';
    suspended_by_name?: string | null;
    /** Set only on a closed account — jovi-mall's ADR-A02 stamp. Null everywhere else. */
    closed_at?: Date | null;
    created_at: Date;
    updated_at: Date;
}

/**
 * The whitelist. Every field the admin surface may see, named.
 *
 * A whitelist rather than `{ password_hash: 0 }`: an exclusion list protects only what
 * somebody thought of, so a credential-shaped field added to `users` next year would
 * arrive here automatically. This way it does not.
 */
const USER_PROJECTION = {
    _id: 1,
    login_email: 1,
    login_phone: 1,
    roles: 1,
    status: 1,
    suspended_at: 1,
    suspended_reason: 1,
    suspended_by_user_id: 1,
    suspended_by_source: 1,
    suspended_by_name: 1,
    // ⚠ ENUMERATED, so a new jovi-mall field is invisible here until it is named. That is the
    // whitelist working as intended and it is also the seam Phase 4 kept finding: `closed_at`
    // is listed for the same reason `compositeScore` had to be.
    closed_at: 1,
    created_at: 1,
    updated_at: 1,
} as const;

export interface UserSearchQuery extends ListQueryBase {
    /** Substring of email or phone — or, when it is a 24-hex string, a user or profile id. */
    search?: string;
    role?: string;
    status?: 'active' | 'suspended' | 'closed';
    /** Half-open `[from, to)` over `created_at`. */
    from?: Date;
    to?: Date;
}

export class UserReadRepository extends PlatformReadRepository<UserReadModel> {
    constructor() {
        super(COLLECTIONS.USER, USER_PROJECTION);
    }

    /**
     * One page of the directory.
     *
     * `profileUserIds` are the accounts behind a PROFILE id the search term named, resolved
     * by the caller before this runs (`findProfileOwners`). Passing them in rather
     * than querying here is what keeps `buildFilter` pure.
     */
    async search(
        query: UserSearchQuery,
        profileUserIds: ObjectId[] = [],
    ): Promise<Paginated<UserReadModel>> {
        return this.findPage(buildFilter(query, profileUserIds), {
            page: query.page,
            limit: query.limit,
            // The spec was validated against USER_SORT by the route's schema; this
            // translates the same map's wire names to field paths and appends the `_id`
            // tiebreaker that makes skip/limit paging stable.
            sort: toMongoSort(query.sort, USER_SORT),
        });
    }

    async findById(userId: string): Promise<UserReadModel | null> {
        if (!Types.ObjectId.isValid(userId)) return null;
        return this.findOneBy({ _id: new ObjectId(userId) } as Filter<UserReadModel>);
    }

    /**
     * Whether an account has this id — a count on `_id`, reading no field.
     *
     * For `meta.idMatch` (BR-029), which describes a pasted id whatever the other filters
     * are. It is deliberately NOT `search(...).total > 0`: under `role=vendor` a customer's
     * own user id produces an empty page and is still a user id.
     */
    async existsById(userId: string): Promise<boolean> {
        if (!isWholeId(userId)) return false;
        return (await this.countBy({ _id: new ObjectId(userId) } as Filter<UserReadModel>)) > 0;
    }
}

/**
 * Built here rather than in the controller so the scope cannot be dropped by a caller.
 *
 * The same reasoning as jovi-mall's `findByIdAndAgency` convention: a filter assembled at
 * the query layer is one nobody can forget to apply.
 *
 * Exported for `test-users.ts`, which asserts the search branches without a database —
 * the id branch in particular is the kind of thing that is only ever tested by hand once.
 *
 * Pure: `profileUserIds` arrives as a parameter precisely so this function never queries.
 */
export function buildFilter(
    query: UserSearchQuery,
    profileUserIds: ObjectId[] = [],
): Filter<UserReadModel> {
    const clauses: Record<string, unknown>[] = [];

    if (query.role) clauses.push({ roles: query.role });
    if (query.status) clauses.push({ status: query.status });

    if (query.from || query.to) {
        const range: Record<string, Date> = {};
        if (query.from) range.$gte = query.from;
        // Half-open `[from, to)`, matching `dateRangeFields` — consecutive ranges tile
        // exactly and no row is counted twice at a boundary.
        if (query.to) range.$lt = query.to;
        clauses.push({ created_at: range });
    }

    const search = query.search?.trim();
    if (search) clauses.push(searchClause(search, profileUserIds));

    if (clauses.length === 0) return {} as Filter<UserReadModel>;
    if (clauses.length === 1) return clauses[0] as Filter<UserReadModel>;

    /**
     * `$and`, not `Object.assign`.
     *
     * The search clause is an `$or`, and so would a second `$or`-shaped filter be. Merging
     * by assignment is how `audit-subject.ts` documents a Support administrator getting
     * handed the whole administrator directory: the later `$or` silently replaces the
     * earlier one. Composing under `$and` cannot do that, and costs a nested document.
     */
    return { $and: clauses } as Filter<UserReadModel>;
}

/**
 * Match an email, a phone number, or a user id.
 *
 * The id branch matters more than it looks. Every other admin screen — an order, a
 * ticket, an audit row — identifies a person by their user id, so pasting one into the
 * only search box on the user directory is the obvious move, and a directory that
 * answers "no results" to a valid id looks broken rather than strict.
 *
 * ── A user id, or the id of one of the person's profiles (BR-028) ─────────────
 * The id on an order is a `customers._id` and the id on a vendor's page is a
 * `vendors._id`; neither is a `users._id`, and until 2026-10-12 neither found anybody
 * here. `profileUserIds` carries the accounts those ids belong to, resolved by the caller
 * from the four role collections. It is empty for a term that is not an id, and for an id
 * that is nobody's profile.
 *
 * An id matches WHOLE or not at all — exactly 24 hexadecimal characters. A shorter term is
 * never read as part of an id; it is matched against the email and the phone like any other
 * text. That is deliberate: a run of eight or more digits is far more often part of a phone
 * number than the start of an id, and reading it as both would return people whose phone
 * does not contain what was typed.
 *
 * The term is escaped by `containsInsensitive` before it reaches a `$regex`: an
 * unescaped one is both a correctness bug (`a.b` matching `axb`) and a
 * catastrophic-backtracking pattern the caller supplies.
 */
function searchClause(term: string, profileUserIds: ObjectId[]): Record<string, unknown> {
    const pattern = containsInsensitive(term);
    const branches: Record<string, unknown>[] = [
        { login_email: pattern },
        { login_phone: pattern },
    ];

    // `isWholeId` is also what decides whether the response carries `meta.idMatch`, so the
    // filter and the description of the id cannot disagree about what counts as one.
    if (isWholeId(term)) {
        branches.push({ _id: new ObjectId(term) });
    }

    if (profileUserIds.length > 0) {
        branches.push({ _id: { $in: profileUserIds } });
    }

    return { $or: branches };
}
