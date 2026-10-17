import { Document, Filter, ObjectId } from 'mongodb';
import { COLLECTIONS } from '../../../infra/platform/collections';
import { PlatformCollection } from '../../../infra/platform/platform-collections';
import { PlatformReadRepository } from '../../../infra/platform/platform.repository';
import {
    CodRestrictionDto,
    StoredCodRestriction,
    toCodRestrictionDto,
} from '../../cod/read-models/cod-restriction.dto';

/**
 * The role entities behind a `users` row.
 *
 * ── Why the detail endpoint needs this at all ─────────────────────────────────
 * `users.roles` is an array of strings. It says a person is a vendor; it cannot say
 * whether their vendor profile is verified, whether their agent account is banned, or
 * when any of it was created — and those are the questions an administrator opening a
 * user actually has. Four collections hold that, keyed by `user_id`.
 *
 * ── Why the projections are this narrow ───────────────────────────────────────
 * These are the richest documents on the platform: `delivery_agents` alone carries
 * `legal_identity`, `payout_details`, `emergency_contact` and live device telemetry, and
 * the vendor and agency rows carry KYC documents and payout destinations. None of it is
 * needed to answer "what is this person on the platform", and all of it would be shipped
 * by a `find()` with no projection.
 *
 * So each entry below names four or five fields. Anything more belongs on that role's own
 * admin screen, behind that role's own permission — `vendors.read`, `agents.read` — not
 * smuggled in as a sub-object of the user detail, where `users.read` alone would reach it.
 * That is the same reasoning `AgentDirectoryMapper` applies in jovi-mall.
 */

interface RoleProfileDocument extends Document {
    _id: ObjectId;
    user_id: ObjectId;
    status?: string;
    created_at?: Date;
    // Present on some roles only — see ROLE_SOURCES.
    name?: string;
    display_name?: string;
    /** Agency only. The vendor's equivalent moved into `kyc_details`. */
    legit_verified?: boolean;
    /** Vendor only, and narrowed to the one flag — never the whole sub-document. */
    kyc_details?: { legit_verified?: boolean };
    kyc?: { status?: string };
    /** Customer only. `null` or absent = cash on delivery is not restricted. */
    cod_restriction?: StoredCodRestriction | null;
}

export type UserRoleName = 'customer' | 'vendor' | 'agency' | 'agent';

/**
 * One entry per role, naming its collection, its display field and its projection.
 *
 * A table rather than four repository classes: they differ only in those three things,
 * and four near-identical classes is how one of them ends up with a projection somebody
 * widened for a screen that no longer exists.
 */
const ROLE_SOURCES: Readonly<
    Record<UserRoleName, { collection: PlatformCollection; projection: Document }>
> = Object.freeze({
    customer: {
        collection: COLLECTIONS.CUSTOMER,
        /**
         * `cod_restriction` — the administrator's cash-on-delivery switch (2026-10-10), so
         * the user detail can show a badge without a second call.
         *
         * It is here, on the user screen, because a customer has no admin screen of its
         * own: `users.read` IS the permission for this role. Dotted paths rather than the
         * whole sub-document, so a field added to it upstream does not arrive uninvited.
         * The agency carries the same field and it is NOT projected below — an agency's
         * restriction is shown on the agency detail, behind `agencies.read`.
         */
        projection: {
            _id: 1, user_id: 1, name: 1, status: 1, created_at: 1,
            'cod_restriction.reason': 1,
            'cod_restriction.restricted_at': 1,
            'cod_restriction.restricted_by_user_id': 1,
            'cod_restriction.restricted_by_source': 1,
            'cod_restriction.restricted_by_name': 1,
        },
    },
    vendor: {
        collection: COLLECTIONS.VENDOR,
        /**
         * `kyc_details.legit_verified` — the business-verification verdict, and the one
         * thing about a vendor a user-management screen genuinely needs.
         *
         * The DOTTED path, not a bare `legit_verified`. This projected the top-level
         * mirror until the vendor-management phase, and that field never existed on disk
         * for any vendor created after its schema path was commented out — so this screen
         * reported `verified: null` for a verified vendor and, worse, a stale `true` for
         * an older one. It is also why the whole `kyc_details` object must never be
         * projected here: `national_id_number` lives beside this flag.
         */
        projection: {
            _id: 1, user_id: 1, display_name: 1, status: 1,
            'kyc_details.legit_verified': 1, created_at: 1,
        },
    },
    agency: {
        collection: COLLECTIONS.DELIVERY_AGENCY,
        projection: { _id: 1, user_id: 1, display_name: 1, status: 1, legit_verified: 1, created_at: 1 },
    },
    agent: {
        collection: COLLECTIONS.DELIVERY_AGENT,
        // `kyc.status` only — never the documents behind it, and never `legal_identity`.
        projection: { _id: 1, user_id: 1, name: 1, status: 1, 'kyc.status': 1, created_at: 1 },
    },
});

/** A role profile as the admin API reports it. */
export interface RoleProfile {
    role: UserRoleName;
    id: string;
    /** The person's or business's display name on that role, when the role carries one. */
    name: string | null;
    status: string | null;
    /** Business verification — vendor and agency only; `null` where the role has none. */
    verified: boolean | null;
    /** Identity verification — agent only. */
    kycStatus: string | null;
    createdAt: string | null;
    /**
     * The administrator's cash-on-delivery restriction — **present on a `customer` profile
     * only**: the restriction, or `null` when there is none.
     *
     * ⚠ The key is ABSENT on every other role rather than `null`, and that is the opposite
     * of `verified` and `kycStatus` above on purpose. `null` here is a statement — "not
     * restricted" — and an agency CAN be restricted; printing `null` on an agency profile
     * this projection never looked at would be a claim about a field nobody read.
     */
    codRestriction?: CodRestrictionDto | null;
}

/**
 * A read repository bound to one role's collection.
 *
 * Instantiated per role from the table above. `PlatformReadRepository` requires the
 * collection name to be in the access table, so a role added here that nobody classified
 * in `platform-collections.ts` is a compile error rather than an unauthorised read.
 */
class RoleProfileRepository extends PlatformReadRepository<RoleProfileDocument> {
    constructor(collection: PlatformCollection, projection: Document) {
        super(collection, projection);
    }

    findForUser(userId: ObjectId): Promise<RoleProfileDocument | null> {
        return this.findOneBy({ user_id: userId } as Filter<RoleProfileDocument>);
    }

    /** Display names for a page of role-entity ids, batched. One query, never one per row. */
    async findNamesByIds(ids: ObjectId[]): Promise<Map<string, string | null>> {
        if (ids.length === 0) return new Map();
        const rows = await this.findBy({ _id: { $in: ids } } as Filter<RoleProfileDocument>, {
            projection: { _id: 1, name: 1 },
            limit: ids.length,
        });
        return new Map(rows.map((row) => [row._id.toString(), row.name ?? null]));
    }

    /** The same, keyed by the OWNING `users._id` rather than the role entity's own id. */
    async findNamesByUserIds(userIds: ObjectId[]): Promise<Map<string, string | null>> {
        if (userIds.length === 0) return new Map();
        const rows = await this.findBy({ user_id: { $in: userIds } } as Filter<RoleProfileDocument>, {
            projection: { _id: 0, user_id: 1, name: 1 },
            limit: userIds.length,
        });
        return new Map(rows.map((row) => [row.user_id.toString(), row.name ?? null]));
    }

    /** The `users._id` that owns this role entity, or `null`. One point read on `_id`. */
    async findOwnerUserId(profileId: ObjectId): Promise<ObjectId | null> {
        const [row] = await this.findBy({ _id: profileId } as Filter<RoleProfileDocument>, {
            projection: { _id: 0, user_id: 1 },
            limit: 1,
        });
        return row?.user_id ?? null;
    }
}

const REPOSITORIES: Readonly<Record<UserRoleName, RoleProfileRepository>> = Object.freeze(
    Object.fromEntries(
        (Object.keys(ROLE_SOURCES) as UserRoleName[]).map((role) => [
            role,
            new RoleProfileRepository(ROLE_SOURCES[role].collection, ROLE_SOURCES[role].projection),
        ]),
    ) as Record<UserRoleName, RoleProfileRepository>,
);

export function isUserRoleName(value: string): value is UserRoleName {
    return value in ROLE_SOURCES;
}

/**
 * Customer display names for a page of `customers._id` values (BR-015).
 *
 * ── Why it lives here rather than beside its one caller ───────────────────────
 * The media library resolves a file's owner name across five role collections, and
 * `customers` is one of them. Declaring a second projection of that collection next to the
 * files module would be a second thing to get right: `customers` carries `saved_addresses`
 * (with geocoded coordinates on a person's home) and `saved_payment_methods`, and this file
 * already exists precisely to keep one narrow whitelist per role. Same reasoning as
 * `AgentReadRepository.findNamesByIds`, which is here for the same collection-ownership
 * reason on the richest document of the lot.
 *
 * ── Deliberately NOT generic over `UserRoleName` ──────────────────────────────
 * The obvious shape is `findRoleEntityNames(role, ids)`, and it would be a trap. `vendors`
 * and `delivery_agencies` carry `display_name`, which is the CONTACT PERSON — their
 * business name lives on `stores` / `agency_magazins`, and a generic helper returning the
 * contact would print a human's name in a column headed "Vendor". Both of those already
 * have a correct resolver on their own module's repository, so this one is narrowed to the
 * role that has no such split.
 *
 * ⚠ **The id space is `customers._id`, not `users._id`,** and the distinction is load-bearing
 * for the caller. jovi-mall's upload path stamps `ownerId` from `req.auth.role_entity._id`
 * — the Customer document — for every role. Its own `GET /api/files` then scopes a customer
 * to `ownerId: userId`, the USER id, which is a pre-existing mismatch on that side (a
 * customer cannot list their own uploads there). Nothing here is affected: the library reads
 * the value the uploader actually wrote.
 */
export async function findCustomerNamesByIds(ids: ObjectId[]): Promise<Map<string, string | null>> {
    return REPOSITORIES.customer.findNamesByIds(ids);
}

/**
 * Customer display names keyed by **`users._id`** — the id space a review's author lives in
 * (`reviews.author_user_id`, 2026-10-05). Customer-only for the reason the function above
 * gives: vendors and agencies have a business name elsewhere, and the review list resolves
 * those through the owning modules' own resolvers.
 */
export async function findCustomerNamesByUserIds(userIds: ObjectId[]): Promise<Map<string, string | null>> {
    return REPOSITORIES.customer.findNamesByUserIds(userIds);
}

/**
 * The accounts behind a PROFILE id — for the user directory's search box (BR-028).
 *
 * ── Why the directory needs it ────────────────────────────────────────────────
 * Most ids an administrator can copy for a person are not user ids. A vendor, an agency,
 * an agent and a customer each have a role entity with its own `_id`, and that is the id
 * printed on their page, on an order (`customer_id`, `vendor_id`) and on a shipment. Pasted
 * into the directory it matched nothing, on a screen whose search exists so that "an id
 * copied out of an order … finds the person". For the customer there was no other route at
 * all: there is no customer directory, and `customers.user_id` is the only join.
 *
 * ── What it costs, and what it reads ──────────────────────────────────────────
 * Four point reads on `_id`, and only for a term that is id-shaped. Each projects `user_id`
 * and nothing else, so no field of the richest documents on the platform is read to answer
 * it. All four are asked rather than the first hit returned: the id spaces are separate
 * collections, and nothing but probability stops one value existing in two of them.
 *
 * A caller passes the owners' ids to `buildFilter`, which keeps that function free of
 * queries and testable without a database, the same split as the vendor directory's
 * `storeMatchIds`.
 *
 * Each hit keeps its ROLE (BR-029): the directory tells the dashboard which kind of id the
 * term was, and that is known here and nowhere later. The order is `ROLE_SOURCES`' own.
 *
 * Returns `[]` for anything that is not exactly 24 hexadecimal characters.
 */
export async function findProfileOwners(term: string): Promise<ProfileOwner[]> {
    if (!isWholeId(term)) return [];

    const profileId = new ObjectId(term);
    const roles = Object.keys(REPOSITORIES) as UserRoleName[];
    const owners = await Promise.all(roles.map((role) => REPOSITORIES[role].findOwnerUserId(profileId)));

    return roles.flatMap((role, index) => {
        const userId = owners[index];
        return userId ? [{ role, userId }] : [];
    });
}

/** A role entity a search term named, and the account that owns it. */
export interface ProfileOwner {
    role: UserRoleName;
    userId: ObjectId;
}

/**
 * Whether a search term is read as an id: exactly 24 hexadecimal characters, either case.
 *
 * One definition for the two things that must agree on it. The filter tries such a term as
 * an id, and the response says what the id turned out to be (`meta.idMatch`); a term the
 * filter never tried as an id must not be described as one.
 */
export function isWholeId(term: string): boolean {
    return term.length === 24 && ObjectId.isValid(term);
}

/** What a pasted id can turn out to be: the account's own id, or one of its profiles'. */
export type IdMatchKind = 'user' | UserRoleName;

/**
 * The kinds of id a term IS, for `meta.idMatch.kinds` on the user directory (BR-029).
 *
 * `user` first, then the profile kinds in `ROLE_SOURCES` order. A list because the five id
 * spaces are separate collections and nothing but probability stops one value existing in
 * two of them. Empty when the id is nobody's, which is a different answer from "the term
 * was not an id" and is why the caller omits the block for the second and sends `[]` for
 * the first.
 *
 * It describes the ID, not the page. A customer id searched under `role=vendor` is still a
 * customer's id when the page it produced is empty.
 */
export function idMatchKinds(isUserId: boolean, owners: readonly ProfileOwner[]): IdMatchKind[] {
    const kinds: IdMatchKind[] = isUserId ? ['user'] : [];
    for (const owner of owners) {
        if (!kinds.includes(owner.role)) kinds.push(owner.role);
    }
    return kinds;
}

/**
 * Resolve the profiles for the roles a user holds.
 *
 * ── Driven by `users.roles`, and reporting what it does not find ──────────────
 * Only the roles the user claims are queried — four unconditional lookups per detail
 * view would be three wasted round trips for the customer that most users are. But a
 * claimed role whose entity is missing is REPORTED (`id: null`) rather than dropped,
 * because that state is a real one: `requireAuth` answers 401
 * `AUTH_ROLE_PROFILE_NOT_FOUND` for it, so the person cannot use that role at all, and a
 * screen that silently omitted the row would leave an administrator unable to see why.
 *
 * Roles outside the table (`admin`, or anything added upstream) are skipped: this service
 * has no profile to show for them and inventing an empty one would be a lie.
 */
export async function findRoleProfiles(
    userId: ObjectId,
    roles: readonly string[],
): Promise<(RoleProfile | MissingRoleProfile)[]> {
    const known = roles.filter(isUserRoleName);

    const found = await Promise.all(
        known.map(async (role) => {
            const document = await REPOSITORIES[role].findForUser(userId);
            return document ? toRoleProfile(role, document) : missingProfile(role);
        }),
    );

    return found;
}

export interface MissingRoleProfile {
    role: UserRoleName;
    id: null;
    name: null;
    status: null;
    verified: null;
    kycStatus: null;
    createdAt: null;
    /** The role is on the `users` row but its entity does not exist — sign-in fails. */
    missing: true;
}

function missingProfile(role: UserRoleName): MissingRoleProfile {
    return {
        role,
        id: null,
        name: null,
        status: null,
        verified: null,
        kycStatus: null,
        createdAt: null,
        missing: true,
    };
}

/** Named-field mapping, never a spread — the second lock behind the projection. */
function toRoleProfile(role: UserRoleName, document: RoleProfileDocument): RoleProfile {
    // Two roles carry a business-verification flag and they keep it in different places:
    // the vendor's is inside `kyc_details`, the agency's is still the top-level mirror.
    // Reading both, in that order, is what stops this reporting `null` for a verified
    // vendor — which is exactly what it did while it projected the vendor's dead
    // top-level copy.
    const verified = document.kyc_details?.legit_verified ?? document.legit_verified;

    return {
        role,
        id: document._id.toString(),
        name: document.display_name ?? document.name ?? null,
        status: document.status ?? null,
        verified: typeof verified === 'boolean' ? verified : null,
        kycStatus: document.kyc?.status ?? null,
        createdAt: document.created_at ? document.created_at.toISOString() : null,
        // Customer only — see the field's note for why the other roles omit the key.
        ...(role === 'customer' ? { codRestriction: toCodRestrictionDto(document.cod_restriction) } : {}),
    };
}
