import { AdminTier } from '../../admin-identity/domain/admin-identity.types';
import { assignableTiers, mayClaim, TicketAssignmentState } from '../domain/assignment-authority';
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
     * as reserved in `docs/api/support.md`; what made a permanently-null field a broken
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

export interface TicketDto {
    id: string;
    subject: string;
    type: string;
    status: string;
    priority: string;
    priorityLocked: boolean;
    importance: string;
    entity: { type: string; id: string };
    trackingNumber: string | null;
    createdBy: { role: string; userId: string | null; administrator: AdminSnapshotDto | null };
    /** The platform actor a ticket was routed to, which is NOT the administrator holding it. */
    assignedTo: { role: string | null; userId: string | null };
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

export function toTicketDto(
    ticket: TicketReadModel,
    caller: { adminId: string; tier: AdminTier },
): TicketDto {
    const state = assignmentStateOf(ticket);
    const assignment = ticket.admin_assignment ?? null;

    return {
        id: ticket._id.toString(),
        subject: ticket.subject,
        type: ticket.type,
        status: ticket.status,
        priority: ticket.priority,
        priorityLocked: ticket.priority_locked ?? false,
        importance: ticket.importance,
        entity: { type: ticket.entity_type, id: ticket.entity_id },
        trackingNumber: ticket.tracking_number ?? null,
        createdBy: {
            role: ticket.created_by_role,
            userId: ticket.created_by_user_id?.toString() ?? null,
            administrator: toSnapshotDto(ticket.created_by_admin),
        },
        assignedTo: {
            role: ticket.assigned_to_role ?? null,
            userId: ticket.assigned_to_user_id?.toString() ?? null,
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
): TicketDetailDto {
    return {
        ...toTicketDto(ticket, caller),
        description: ticket.description ?? '',
    };
}
