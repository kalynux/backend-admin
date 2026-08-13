import { Document, Filter, ObjectId } from 'mongodb';
import { COLLECTIONS } from '../../../infra/platform/collections';
import { PlatformCollection } from '../../../infra/platform/platform-collections';
import { PlatformReadRepository } from '../../../infra/platform/platform.repository';

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
        projection: { _id: 1, user_id: 1, name: 1, status: 1, created_at: 1 },
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
    };
}
