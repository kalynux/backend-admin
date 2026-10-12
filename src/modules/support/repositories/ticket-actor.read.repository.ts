import { Document, Filter, ObjectId } from 'mongodb';
import { COLLECTIONS } from '../../../infra/platform/collections';
import { PlatformCollection } from '../../../infra/platform/platform-collections';
import { PlatformReadRepository } from '../../../infra/platform/platform.repository';
import { AdminAccountRepository } from '../../admin-identity/repositories/admin-account.repository';
import { AgencyReadRepository } from '../../agencies/repositories/agency.read.repository';
import { StoreReadRepository } from '../../vendors/repositories/store.read.repository';

/**
 * WHO is on a ticket — the person who opened it, the actor it was routed to, its followers.
 *
 * ── Why this exists ───────────────────────────────────────────────────────────
 * A ticket row names its people by `(users._id, role)` and nothing else, and until
 * 2026-10-10 that is all this surface returned: the support screen showed "customer" where
 * an operator needs a name and a number to call. The answer is spread over three places —
 * the phone and e-mail on `users`, the person's name on the role profile, the BUSINESS name
 * on `stores` / `agency_magazins` — so it is resolved here, once, for a whole page.
 *
 * ── Batched by role, never per row ────────────────────────────────────────────
 * One query on `users`, one per role actually present, and one each for the two business
 * names. A hundred-row queue costs the same handful of reads as a single ticket.
 *
 * ── `name` is the PERSON, `businessName` is the business ──────────────────────
 * `vendors.display_name` and `delivery_agencies.display_name` are the CONTACT PERSON; the
 * shop and the agency are named on `stores.name` and `agency_magazins.name`. Both are
 * returned, separately, because merging them is the mislabelling BR-006 corrected — a
 * human's name printed under a heading that says the business. `businessName` is `null` for
 * a customer and an agent, who have none.
 *
 * ── The projections are this narrow on purpose ────────────────────────────────
 * `users` carries `password_hash`; the role profiles carry KYC documents, payout
 * destinations and saved addresses. This reads three fields of the first and four of the
 * others. The phone and e-mail are not new disclosure for any tier: `users.read` — which
 * Support holds, because answering a ticket means knowing who wrote it — already returns
 * both on `/users`.
 */

export interface TicketActorRef {
    userId: string;
    role: string;
}

export interface TicketActor {
    userId: string;
    role: string;
    /** The role entity's own id — `customers._id`, `vendors._id`, … — for linking to its screen. */
    profileId: string | null;
    /** The person. For an `admin` actor, the administrator's display name. */
    name: string | null;
    /** The shop or the agency. `null` for every other role. */
    businessName: string | null;
    phone: string | null;
    email: string | null;
}

export function ticketActorKey(userId: string, role: string): string {
    return `${userId}:${role}`;
}

interface ActorContactRead extends Document {
    _id: ObjectId;
    login_phone?: string | null;
    login_email?: string | null;
}

class ActorContactRepository extends PlatformReadRepository<ActorContactRead> {
    constructor() {
        super(COLLECTIONS.USER, { _id: 1, login_phone: 1, login_email: 1 });
    }

    async findByIds(ids: ObjectId[]): Promise<Map<string, ActorContactRead>> {
        if (ids.length === 0) return new Map();
        const rows = await this.findBy({ _id: { $in: ids } } as Filter<ActorContactRead>, { limit: ids.length });
        return new Map(rows.map((row) => [row._id.toString(), row]));
    }
}

interface ActorProfileRead extends Document {
    _id: ObjectId;
    user_id: ObjectId;
    /** Customer and agent. */
    name?: string | null;
    /** Vendor and agency — the contact person, never the business. */
    display_name?: string | null;
}

class ActorProfileRepository extends PlatformReadRepository<ActorProfileRead> {
    constructor(collection: PlatformCollection) {
        super(collection, { _id: 1, user_id: 1, name: 1, display_name: 1 });
    }

    findByUserIds(userIds: ObjectId[]): Promise<ActorProfileRead[]> {
        return this.findBy({ user_id: { $in: userIds } } as Filter<ActorProfileRead>, { limit: userIds.length });
    }
}

type PlatformActorRole = 'customer' | 'vendor' | 'agency' | 'agent';

const PROFILE_COLLECTIONS: Readonly<Record<PlatformActorRole, PlatformCollection>> = Object.freeze({
    customer: COLLECTIONS.CUSTOMER,
    vendor: COLLECTIONS.VENDOR,
    agency: COLLECTIONS.DELIVERY_AGENCY,
    agent: COLLECTIONS.DELIVERY_AGENT,
});

function isPlatformActorRole(role: string): role is PlatformActorRole {
    return role in PROFILE_COLLECTIONS;
}

export class TicketActorReadRepository {
    private readonly contacts = new ActorContactRepository();
    private readonly profiles: Readonly<Record<PlatformActorRole, ActorProfileRepository>> = Object.freeze({
        customer: new ActorProfileRepository(PROFILE_COLLECTIONS.customer),
        vendor: new ActorProfileRepository(PROFILE_COLLECTIONS.vendor),
        agency: new ActorProfileRepository(PROFILE_COLLECTIONS.agency),
        agent: new ActorProfileRepository(PROFILE_COLLECTIONS.agent),
    });
    private readonly stores = new StoreReadRepository();
    private readonly agencies = new AgencyReadRepository();
    private readonly administrators = new AdminAccountRepository();

    /**
     * Resolve `(userId, role)` pairs, keyed by `ticketActorKey`.
     *
     * A pair that resolves to nothing is simply ABSENT from the map — a deleted profile, or a
     * malformed id. The DTO renders that as the id and the role with every other field
     * `null`, which is the truth: the ticket still names them, and the platform no longer can.
     *
     * An `admin` actor is an administrator of THIS service (`admin_accounts`), or the
     * platform's own system identity — neither is a `users` row, so there is no phone or
     * e-mail to read and none is invented. Only the display name is resolved; the system
     * identity matches no account and stays absent, and the caller falls back to the profile
     * snapshot stored on the ticket.
     */
    async resolve(refs: readonly TicketActorRef[]): Promise<Map<string, TicketActor>> {
        const idsByRole = new Map<string, Set<string>>();
        for (const { userId, role } of refs) {
            if (!userId || !ObjectId.isValid(userId)) continue;
            if (!idsByRole.has(role)) idsByRole.set(role, new Set());
            idsByRole.get(role)!.add(userId);
        }

        const result = new Map<string, TicketActor>();
        if (idsByRole.size === 0) return result;

        const platformUserIds = [...idsByRole]
            .filter(([role]) => isPlatformActorRole(role))
            .flatMap(([, ids]) => [...ids]);
        const contacts = await this.contacts.findByIds([...new Set(platformUserIds)].map((id) => new ObjectId(id)));

        await Promise.all([...idsByRole].map(async ([role, idSet]) => {
            const userIds = [...idSet];

            if (role === 'admin') {
                const names = await this.administrators.findDisplayNamesByIds(userIds);
                for (const [adminId, name] of names) {
                    result.set(ticketActorKey(adminId, role), {
                        userId: adminId, role, profileId: null, name, businessName: null, phone: null, email: null,
                    });
                }
                return;
            }
            if (!isPlatformActorRole(role)) return;

            const profiles = await this.profiles[role].findByUserIds(userIds.map((id) => new ObjectId(id)));
            const profileIds = profiles.map((profile) => profile._id);
            const businessNames =
                role === 'vendor' ? await this.stores.findNamesByVendorIds(profileIds)
                : role === 'agency' ? await this.agencies.findBusinessNamesByIds(profileIds)
                : new Map<string, string | null>();

            const profileByUser = new Map(profiles.map((profile) => [profile.user_id.toString(), profile]));
            for (const userId of userIds) {
                const profile = profileByUser.get(userId);
                const contact = contacts.get(userId);
                // Neither a profile nor an account: nothing is known, so say nothing.
                if (!profile && !contact) continue;

                result.set(ticketActorKey(userId, role), {
                    userId,
                    role,
                    profileId: profile ? profile._id.toString() : null,
                    name: profile?.name ?? profile?.display_name ?? null,
                    businessName: profile ? businessNames.get(profile._id.toString()) ?? null : null,
                    phone: contact?.login_phone ?? null,
                    email: contact?.login_email ?? null,
                });
            }
        }));

        return result;
    }
}

/**
 * A ticket's follower rows.
 *
 * Reached only after `loadScoped` has proved the caller may see the ticket, and keyed on the
 * TICKET — the same shape, and the same reasoning, as `TicketAttachmentFileReadRepository`.
 */
export interface TicketFollowerRead extends Document {
    _id: ObjectId;
    ticket_id: ObjectId;
    user_id: ObjectId;
    role: string;
    /** Absent on rows written before 2026-10-09. */
    source?: string | null;
    added_at?: Date | null;
}

export class TicketFollowerReadRepository extends PlatformReadRepository<TicketFollowerRead> {
    constructor() {
        super(COLLECTIONS.TICKET_FOLLOWER, { _id: 1, ticket_id: 1, user_id: 1, role: 1, source: 1, added_at: 1 });
    }

    /** Oldest first — the creator leads, as on every other reading of this list. */
    findByTicket(ticketId: string): Promise<TicketFollowerRead[]> {
        return this.findBy({ ticket_id: new ObjectId(ticketId) } as Filter<TicketFollowerRead>, {
            sort: { added_at: 1, _id: 1 },
        });
    }
}
