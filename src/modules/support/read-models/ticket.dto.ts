import { AdminTier } from '../../admin-identity/domain/admin-identity.types';
import { assignableTiers, mayClaim, TicketAssignmentState } from '../domain/assignment-authority';
import { TicketActor, TicketFollowerRead, ticketActorKey } from '../repositories/ticket-actor.read.repository';
import { TicketEntityRef } from '../repositories/ticket-entity.read.repository';
import { AdminSnapshotRead, TicketReadModel } from '../repositories/ticket.read.repository';

/**
 * What `/api/v1/support/tickets` returns.
 *
 * ── The administrator snapshot is shown IN FULL here, unlike in jovi-mall ─────
 * jovi-mall narrows it through `publicAdminSnapshot()` before a customer, vendor, agency or
 * agent sees it, dropping `id`, `source` and above all `tier`. This is the administrator's
 * own dashboard, so the whole block travels: the tier is what the queue screen groups and
 * filters by, and hiding it here would hide the thing the D-3 rules are about.
 *
 * The two audiences and the two shapes are the point — the same stored block, narrowed at one
 * boundary and not at the other, rather than two stored blocks that could disagree.
 */

export interface AdminSnapshotDto {
    id: string;
    name: string;
    tier: AdminTier;
    jobTitle: string | null;
    department: string | null;
    /**
     * **Reserved — always `null` today** (G-2, closed 2026-08-20 by documenting it).
     *
     * `admin_accounts` stores no avatar and wi-admin has no write-side file surface at all —
     * its `files` module is two GETs delegating to jovi-mall, and there is no `multer`
     * anywhere — so an administrator picture would be a storage decision, a permission, a
     * route and a moderation question, not a field. Deferred until one is actually wanted.
     *
     * The field stays on the wire because the stored shape has it and because a customer
     * seeing a face is the point of D-5: the day an avatar exists, `snapshotOf` is the only
     * line that changes. Removing it here would also leave jovi-mall still promising it —
     * `avatar_url` is a field of `PublicAdminSnapshot`, the projection every non-admin reader
     * is shown — which is a worse-shaped promise, not a smaller one.
     *
     * **Clients: render the initials fallback and do not branch on this.** It is documented
     * as reserved in `api-doc/api/support.md`; what made a permanently-null field a broken
     * promise was that it was undocumented.
     */
    avatarUrl: string | null;
}

export interface TicketAssignmentDto {
    admin: AdminSnapshotDto;
    /** Null when the ticket was claimed from the pool rather than handed over. */
    assignedBy: AdminSnapshotDto | null;
    assignedAt: string;
}

/**
 * One person on a ticket — who opened it, who it was routed to, who follows it (2026-10-10).
 *
 * The screen used to be handed a role and an id and nothing else. `userId` and `role` come
 * from the ticket and are always present; everything after them is LOOKED UP, and is `null`
 * when the lookup finds nothing — a deleted profile, a closed and anonymised account, a
 * vendor mid-onboarding with no shop yet. Render the id in that case; do not hide the row.
 *
 * ⚠ `name` is the PERSON and `businessName` is the shop or the agency. For a vendor or an
 * agency both are usually set and they are different things; a customer and an agent have
 * no `businessName`. Showing `name` under a heading that says "Vendor" prints a human where
 * a business belongs.
 *
 * An `admin` actor is an administrator of this service or the platform's automatic
 * identity: it has a `name` and no phone, e-mail, profile or business.
 */
export interface TicketActorDto {
    role: string;
    /** `users._id` for a platform actor; an `admin_accounts` id for `role: 'admin'`. */
    userId: string;
    /** The role entity's own id (`vendors._id`, `delivery_agents._id`, …) — what that role's detail route takes. */
    profileId: string | null;
    name: string | null;
    businessName: string | null;
    phone: string | null;
    email: string | null;
}

export interface TicketFollowerDto extends TicketActorDto {
    /**
     * Why they follow: `creator` · `assignee` · `order_party` (added automatically as a party
     * of the order the ticket is about) · `admin` (added by an administrator). `null` on a row
     * written before 2026-10-09, which recorded no reason.
     */
    source: string | null;
    addedAt: string | null;
    /**
     * FACTS, not permissions. jovi-mall refuses to remove the creator, the current assignee
     * and an `admin` follower (`403 TICKET_ACCESS_DENIED`); these are the inputs to that rule,
     * so the screen can hide the remove button without this service keeping a second copy of it.
     */
    isCreator: boolean;
    isAssignee: boolean;
}

export interface TicketDto {
    id: string;
    subject: string;
    type: string;
    status: string;
    priority: string;
    priorityLocked: boolean;
    /**
     * This ticket keeps its order's or booking's earnings PAUSED (2026-10-10): the customer
     * reported a problem while the money was still held. Resolving or closing the ticket as an
     * administrator lifts the pause, and that is final for the purchase — so the dashboard
     * confirms before either. See `FRONTEND-CHANGELOG-wi-mall-protection.md`.
     */
    holdsEarnings: boolean;
    importance: string;
    /**
     * What the ticket is about — `(type, id)`, polymorphic.
     *
     * `type` is one of **eleven** values, and the set is **CLOSED at the platform**:
     * jovi-mall's `EntityType` is a TypeScript enum, its ticket schema declares
     * `enum: ENTITY_TYPE_VALUES` on a required column, and its create and list validators
     * both `z.enum` the same array. So a stored value outside the eleven is not reachable
     * through any write path. See `api-doc/api/support.md` for the list.
     *
     * ⚠ **This service still validates the token by SHAPE, not membership** (ADR-005 D-17,
     * and `entityType` on the search schema is a bounded string). That is not a
     * contradiction: the vocabulary is jovi-mall's to grow, and pinning a copy here is how a
     * filter goes stale silently. A client may rely on the eleven for routing and should
     * still render an unrecognised token as plain text.
     */
    entity: {
        type: string;
        id: string;
        /**
         * The product's vendor — set for `type: 'PRODUCT'`, `null` otherwise (BR-016 § 7).
         *
         * Without it a product ticket cannot be linked anywhere: the product detail route is
         * `/vendors/:vendorId/products/:productId` and the ticket carries one id.
         *
         * `null` also when the product row is gone — a deleted listing is exactly what a
         * catalogue complaint tends to end in, so the ticket survives with no link rather
         * than being given a fabricated one.
         */
        vendorId: string | null;
        /**
         * Something an operator recognises, where one read can supply it: the order number,
         * the tracking number, the product title. `null` for every other type and for a
         * missing record — a nice-to-have, never a substitute for the id.
         */
        label: string | null;
    };
    trackingNumber: string | null;
    /**
     * Who opened it. `administrator` is set — and is the fuller answer — when an administrator
     * or the platform itself did; the identity fields beside it then carry the same name and
     * nothing else.
     */
    createdBy: Omit<TicketActorDto, 'userId'> & { userId: string | null; administrator: AdminSnapshotDto | null };
    /**
     * The platform actor a ticket was routed to, which is NOT the administrator holding it.
     * Every field is `null` when it was routed to nobody, or to the admin pool (`role: 'admin'`,
     * no `userId`).
     */
    assignedTo: Omit<TicketActorDto, 'role' | 'userId'> & { role: string | null; userId: string | null };
    /** Null means the unassigned pool — a real state, not missing data. */
    assignment: TicketAssignmentDto | null;
    /**
     * What THIS caller may do, derived from the one authority table the service enforces
     * with. Rendering a button from a second copy of the rules is how a dashboard offers a
     * verb the API refuses.
     */
    availableActions: {
        claim: boolean;
        assignableTiers: readonly AdminTier[];
    };
    terminalAt: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface TicketDetailDto extends TicketDto {
    description: string;
    /**
     * Everyone following the ticket, oldest first — the detail only. A follower sees the
     * ticket in their own app and reads its public notes.
     */
    followers: TicketFollowerDto[];
}

/** Nobody resolved — every looked-up field renders `null`. */
const NO_ACTORS: ReadonlyMap<string, TicketActor> = new Map();

type TicketActorIdentity = Pick<TicketActorDto, 'profileId' | 'name' | 'businessName' | 'phone' | 'email'>;

/** The looked-up half of an actor, or all-`null` when nothing was found. */
function identityOf(
    userId: string | null,
    role: string | null,
    actors: ReadonlyMap<string, TicketActor>,
): TicketActorIdentity {
    const actor = userId && role ? actors.get(ticketActorKey(userId, role)) : undefined;

    return {
        profileId: actor?.profileId ?? null,
        name: actor?.name ?? null,
        businessName: actor?.businessName ?? null,
        phone: actor?.phone ?? null,
        email: actor?.email ?? null,
    };
}

/** Every `(userId, role)` a set of tickets names — what the controller hands the resolver. */
export function actorRefsOf(
    tickets: readonly TicketReadModel[],
    followers: readonly TicketFollowerRead[] = [],
): { userId: string; role: string }[] {
    const refs: { userId: string; role: string }[] = [];
    for (const ticket of tickets) {
        if (ticket.created_by_user_id) {
            refs.push({ userId: ticket.created_by_user_id.toString(), role: ticket.created_by_role });
        }
        if (ticket.assigned_to_user_id && ticket.assigned_to_role) {
            refs.push({ userId: ticket.assigned_to_user_id.toString(), role: ticket.assigned_to_role });
        }
    }
    for (const follower of followers) {
        refs.push({ userId: follower.user_id.toString(), role: follower.role });
    }
    return refs;
}

function toSnapshotDto(snapshot: AdminSnapshotRead | null | undefined): AdminSnapshotDto | null {
    if (!snapshot) return null;

    return {
        id: snapshot.id,
        name: snapshot.name,
        tier: snapshot.tier as AdminTier,
        jobTitle: snapshot.job_title ?? null,
        department: snapshot.department ?? null,
        avatarUrl: snapshot.avatar_url ?? null,
    };
}

/** The assignment state the authority table reasons over, read off the row. */
export function assignmentStateOf(ticket: TicketReadModel): TicketAssignmentState {
    const assignment = ticket.admin_assignment ?? null;

    return {
        holderId: assignment?.admin?.id ?? null,
        holderTier: (assignment?.admin?.tier as AdminTier | undefined) ?? null,
        assignedByTier: (assignment?.assigned_by?.tier as AdminTier | undefined) ?? null,
    };
}

/**
 * Nothing resolved — what the QUEUE passes.
 *
 * The list deliberately does not resolve entities: a hundred-row page would be a hundred
 * lookups across three collections to decorate a column that shows an id. The detail is one
 * ticket and one query, which is what makes the decoration affordable there.
 */
const UNRESOLVED_ENTITY: TicketEntityRef = { vendorId: null, label: null };

export function toTicketDto(
    ticket: TicketReadModel,
    caller: { adminId: string; tier: AdminTier },
    entity: TicketEntityRef = UNRESOLVED_ENTITY,
    actors: ReadonlyMap<string, TicketActor> = NO_ACTORS,
): TicketDto {
    const state = assignmentStateOf(ticket);
    const assignment = ticket.admin_assignment ?? null;

    const creatorId = ticket.created_by_user_id?.toString() ?? null;
    const creator = identityOf(creatorId, ticket.created_by_role, actors);
    const creatorSnapshot = toSnapshotDto(ticket.created_by_admin);
    const assigneeId = ticket.assigned_to_user_id?.toString() ?? null;

    return {
        id: ticket._id.toString(),
        subject: ticket.subject,
        type: ticket.type,
        status: ticket.status,
        priority: ticket.priority,
        priorityLocked: ticket.priority_locked ?? false,
        holdsEarnings: ticket.holds_earnings === true,
        importance: ticket.importance,
        entity: {
            type: ticket.entity_type,
            id: ticket.entity_id,
            vendorId: entity.vendorId,
            label: entity.label,
        },
        trackingNumber: ticket.tracking_number ?? null,
        createdBy: {
            role: ticket.created_by_role,
            userId: creatorId,
            ...creator,
            // The snapshot on the row is the stored answer for an administrator or the
            // platform's automatic identity — the latter matches no account to look up.
            name: creator.name ?? creatorSnapshot?.name ?? null,
            administrator: creatorSnapshot,
        },
        assignedTo: {
            role: ticket.assigned_to_role ?? null,
            userId: assigneeId,
            ...identityOf(assigneeId, ticket.assigned_to_role ?? null, actors),
        },
        assignment: assignment
            ? {
                admin: toSnapshotDto(assignment.admin) as AdminSnapshotDto,
                assignedBy: toSnapshotDto(assignment.assigned_by),
                assignedAt: assignment.assigned_at.toISOString(),
            }
            : null,
        availableActions: {
            claim: mayClaim(state),
            assignableTiers: assignableTiers(caller.tier, caller.adminId, state),
        },
        terminalAt: ticket.terminalAt ? ticket.terminalAt.toISOString() : null,
        createdAt: ticket.createdAt.toISOString(),
        updatedAt: ticket.updatedAt.toISOString(),
    };
}

export function toTicketDetailDto(
    ticket: TicketReadModel,
    caller: { adminId: string; tier: AdminTier },
    entity: TicketEntityRef = UNRESOLVED_ENTITY,
    actors: ReadonlyMap<string, TicketActor> = NO_ACTORS,
    followers: readonly TicketFollowerRead[] = [],
): TicketDetailDto {
    const creatorId = ticket.created_by_user_id?.toString() ?? null;
    const assigneeId = ticket.assigned_to_user_id?.toString() ?? null;

    return {
        ...toTicketDto(ticket, caller, entity, actors),
        description: ticket.description ?? '',
        followers: followers.map((follower) => {
            const userId = follower.user_id.toString();
            const identity = identityOf(userId, follower.role, actors);
            const isCreator = userId === creatorId;

            return {
                role: follower.role,
                userId,
                ...identity,
                // The platform's automatic identity follows the tickets it opens and matches
                // no account; its name is the snapshot stored on the ticket.
                name: identity.name
                    ?? (isCreator && follower.role === 'admin' ? ticket.created_by_admin?.name ?? null : null),
                source: follower.source ?? null,
                addedAt: follower.added_at ? follower.added_at.toISOString() : null,
                isCreator,
                isAssignee: assigneeId !== null && userId === assigneeId,
            };
        }),
    };
}
