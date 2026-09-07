import { platformRequest } from '../../../infra/platform/platform.client';
import { auditedAttempt } from '../../audit/domain/audit.writer';
import { ActorContext } from '../../audit/domain/audit-context';
import { AuditAction } from '../../audit/domain/audit.catalog';
import { AdminSnapshotPayload } from '../validators/ticket.validator';

/**
 * The support domain's WRITE half, reached over jovi-mall's internal admin API.
 *
 * ── Why a ticket write is delegated when the read is not ──────────────────────
 * Not for symmetry, and not precautionary. jovi-mall creates tickets **in-process** from the
 * payout-request, dispute and booking-refund paths, so this service could never own the
 * collection; and every ticket write publishes on jovi-mall's in-process event bus —
 * `ticket.created`, `ticket.assigned`, `ticket.status_changed`, `ticket.priority_changed`.
 * A write from this service's own connection would move the row and notify nobody: the
 * customer waiting on the ticket simply never hears. That is ADR-004 D-2's failure mode, and
 * it is not one that shows up in testing.
 *
 * ── The snapshot travels on every write, not just the assignment ──────────────
 * `refreshSnapshot` is called by the controller on every mutation, because the block answers
 * "who is handling this **now**" rather than "who acted then" — a stale name is a wrong
 * answer, not a historical record (D-10). jovi-mall guards the refresh on the assignee id, so
 * one racing a reassignment cannot overwrite the new holder.
 *
 * The thin methods below are the whole point: this file should never grow logic.
 */

/** What the ticket looked like before the write, captured from the caller's own read. */
export type TicketSnapshot = Record<string, unknown> | null;

/** jovi-mall's enriched ticket, as much of it as this gateway names. */
export interface PlatformTicket {
    id?: string;
    _id?: string;
    subject?: string;
    status?: string;
    priority?: string;
    [key: string]: unknown;
}

/**
 * Wrap a delegated ticket mutation in an audit intent.
 *
 * In the gateway rather than the controller, matching the COD, user and agency gateways:
 * this is the transport boundary, every delegated write leaves through `platformRequest` a
 * few lines below, and wrapping here means a method added later inherits auditing by
 * construction rather than by its author remembering.
 *
 * Intent → outcome rather than a transaction, because the write lands in jovi-mall's database
 * inside jovi-mall's transaction, which a wi-admin ClientSession cannot join. The intent row
 * commits FIRST — if that fails the HTTP call is never made — and the outcome is stamped when
 * jovi-mall answers. A crash in between leaves a row at `attempted`, resolved by grepping
 * jovi-mall for the same `correlation_id`, which already travels as `X-Request-Id`.
 */
function auditedDelegation<T>(
    action: AuditAction,
    context: ActorContext,
    target: { id: string; label: string | null },
    payload: Record<string, unknown> | null,
    before: TicketSnapshot,
    perform: () => Promise<T>,
): Promise<T> {
    return auditedAttempt(
        {
            action,
            actor: {
                kind: 'administrator',
                id: context.actor.adminId,
                email: context.actor.email,
                displayName: context.actor.displayName,
                tier: context.actor.tier,
                sessionId: context.actor.sessionId,
            },
            target: { type: 'ticket', id: target.id, label: target.label },
            context: {
                method: context.method,
                path: context.path,
                requestId: context.requestId,
                ip: context.ip,
                userAgent: context.userAgent,
            },
            payload,
        },
        async () => {
            const result = await perform();
            return { result, before, after: asState(result) };
        },
    );
}

/**
 * Reduce jovi-mall's answer to the fields worth diffing.
 *
 * Not the whole ticket — an audit row storing every field of every write becomes unreadable,
 * and a ticket carries up to 700 characters of customer free text that has no business being
 * copied into the compliance record on each edit.
 */
function asState(result: unknown): Record<string, unknown> | null {
    const ticket = result as PlatformTicket | null;
    if (!ticket || typeof ticket !== 'object') return null;

    return {
        status: ticket.status ?? null,
        priority: ticket.priority ?? null,
        assignedAdminId: readAssignedAdminId(ticket),
    };
}

function readAssignedAdminId(ticket: PlatformTicket): string | null {
    const assignment = ticket.admin_assignment as { admin?: { id?: string } } | null | undefined;
    return assignment?.admin?.id ?? null;
}

/** A human-readable label so an audit feed reads without a cross-database join. */
export function labelOf(before: TicketSnapshot): string | null {
    if (!before) return null;
    const subject = before.subject;
    return typeof subject === 'string' && subject.length > 0 ? subject : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Writes
// ─────────────────────────────────────────────────────────────────────────────

export async function createTicket(
    body: Record<string, unknown>,
    admin: AdminSnapshotPayload,
    context: ActorContext,
): Promise<PlatformTicket> {
    return auditedDelegation(
        'support.tickets.create',
        context,
        { id: 'new', label: String(body.subject ?? '') || null },
        { subject: body.subject, type: body.type, entityType: body.entityType },
        null,
        async () => {
            const result = await platformRequest<PlatformTicket>({
                method: 'POST',
                path: '/tickets',
                // The creating administrator, so "opened by" renders to the customer it was
                // opened for rather than a placeholder.
                body: { ...body, admin },
                actor: context.actor,
                requestId: context.requestId,
            });
            return result.data;
        },
    );
}

export async function updateTicket(
    ticketId: string,
    body: Record<string, unknown>,
    before: TicketSnapshot,
    context: ActorContext,
): Promise<PlatformTicket> {
    return auditedDelegation(
        'support.tickets.update',
        context,
        { id: ticketId, label: labelOf(before) },
        body,
        before,
        async () => {
            const result = await platformRequest<PlatformTicket>({
                method: 'PATCH',
                path: `/tickets/${ticketId}`,
                body,
                actor: context.actor,
                requestId: context.requestId,
            });
            return result.data;
        },
    );
}

export async function setStatus(
    ticketId: string,
    status: string,
    before: TicketSnapshot,
    context: ActorContext,
): Promise<PlatformTicket> {
    return auditedDelegation(
        'support.tickets.status.set',
        context,
        { id: ticketId, label: labelOf(before) },
        { status },
        before,
        async () => {
            const result = await platformRequest<PlatformTicket>({
                method: 'PATCH',
                path: `/tickets/${ticketId}/status`,
                body: { status },
                actor: context.actor,
                requestId: context.requestId,
            });
            return result.data;
        },
    );
}

export async function setPriority(
    ticketId: string,
    priority: string,
    before: TicketSnapshot,
    context: ActorContext,
): Promise<PlatformTicket> {
    return auditedDelegation(
        'support.tickets.priority.set',
        context,
        { id: ticketId, label: labelOf(before) },
        { priority },
        before,
        async () => {
            const result = await platformRequest<PlatformTicket>({
                method: 'PATCH',
                path: `/tickets/${ticketId}/priority`,
                body: { priority },
                actor: context.actor,
                requestId: context.requestId,
            });
            return result.data;
        },
    );
}

/**
 * Hand a ticket over, or claim it.
 *
 * One gateway method for both, because jovi-mall has one endpoint for both — `assignedBy`
 * being absent IS the claim. Two audit ACTIONS though, chosen by the caller: "took this
 * ticket" and "gave this ticket to X" are different acts to read six months later, and the
 * `agencies.deactivate` / `.reactivate` precedent says a different act gets a different name.
 */
export async function assign(
    ticketId: string,
    action: Extract<AuditAction, 'support.tickets.assign' | 'support.tickets.claim'>,
    admin: AdminSnapshotPayload,
    assignedBy: AdminSnapshotPayload | null,
    before: TicketSnapshot,
    context: ActorContext,
): Promise<PlatformTicket> {
    return auditedDelegation(
        action,
        context,
        { id: ticketId, label: labelOf(before) },
        { administratorId: admin.id, administratorTier: admin.tier },
        before,
        async () => {
            const result = await platformRequest<PlatformTicket>({
                method: 'PATCH',
                path: `/tickets/${ticketId}/assign`,
                body: assignedBy ? { admin, assignedBy } : { admin },
                actor: context.actor,
                requestId: context.requestId,
            });
            return result.data;
        },
    );
}

export async function close(
    ticketId: string,
    before: TicketSnapshot,
    context: ActorContext,
): Promise<PlatformTicket> {
    return auditedDelegation(
        'support.tickets.close',
        context,
        { id: ticketId, label: labelOf(before) },
        null,
        before,
        async () => {
            const result = await platformRequest<PlatformTicket>({
                method: 'POST',
                path: `/tickets/${ticketId}/close`,
                actor: context.actor,
                requestId: context.requestId,
            });
            return result.data;
        },
    );
}

export async function reopen(
    ticketId: string,
    before: TicketSnapshot,
    context: ActorContext,
): Promise<PlatformTicket> {
    return auditedDelegation(
        'support.tickets.reopen',
        context,
        { id: ticketId, label: labelOf(before) },
        null,
        before,
        async () => {
            const result = await platformRequest<PlatformTicket>({
                method: 'POST',
                path: `/tickets/${ticketId}/reopen`,
                actor: context.actor,
                requestId: context.requestId,
            });
            return result.data;
        },
    );
}

export async function addFollower(
    ticketId: string,
    body: { userId: string; role: string },
    before: TicketSnapshot,
    context: ActorContext,
): Promise<PlatformTicket> {
    return auditedDelegation(
        'support.tickets.followers.add',
        context,
        { id: ticketId, label: labelOf(before) },
        body,
        before,
        async () => {
            const result = await platformRequest<PlatformTicket>({
                method: 'POST',
                path: `/tickets/${ticketId}/followers`,
                body,
                actor: context.actor,
                requestId: context.requestId,
            });
            return result.data;
        },
    );
}

export async function removeFollower(
    ticketId: string,
    userId: string,
    before: TicketSnapshot,
    context: ActorContext,
): Promise<PlatformTicket> {
    return auditedDelegation(
        'support.tickets.followers.remove',
        context,
        { id: ticketId, label: labelOf(before) },
        { userId },
        before,
        async () => {
            const result = await platformRequest<PlatformTicket>({
                method: 'DELETE',
                path: `/tickets/${ticketId}/followers/${userId}`,
                actor: context.actor,
                requestId: context.requestId,
            });
            return result.data;
        },
    );
}

/**
 * Add an internal note.
 *
 * ── `isPublic` is TRANSLATED here, and it used to be dropped ──────────────────
 * jovi-mall's `CreateNoteSchema` names the field **`visibility`** — a `'public' | 'private'`
 * enum defaulting to `'public'` — and it is a plain `z.object()`, so an `isPublic` key was
 * *stripped* rather than refused and every note this service created was filed **public**
 * whatever the flag said. A staff note on somebody's support case, shown to them, answered
 * `201`, by a validator whose docstring promised the opposite. Found writing
 * `api-doc/api/support.md` (Phase 4, step 21).
 *
 * The wire name stays `isPublic`: a boolean is the right shape for the one choice this
 * surface offers, and the translation belongs at the transport boundary, which is the only
 * layer that knows what jovi-mall calls it.
 */
export async function createNote(
    ticketId: string,
    body: { content: string; isPublic: boolean },
    before: TicketSnapshot,
    context: ActorContext,
): Promise<unknown> {
    return auditedDelegation(
        'support.tickets.notes.create',
        context,
        { id: ticketId, label: labelOf(before) },
        // The note's TEXT is deliberately not in the audit payload. It is staff commentary on
        // somebody's support case, the note row is itself the durable record, and copying it
        // into the compliance trail duplicates personal data into a store with a different
        // retention rule. What is recorded is that a note was added, and whether it was public.
        { isPublic: body.isPublic, length: body.content.length },
        before,
        async () => {
            const result = await platformRequest<unknown>({
                method: 'POST',
                path: `/tickets/${ticketId}/notes`,
                // ⚠ `visibility`, not `isPublic` — see the docstring. jovi-mall's schema is
                // non-strict, so the wrong key is dropped silently and the note defaults to
                // `'public'`: the failure mode is a 201 with the customer reading staff
                // commentary.
                body: { content: body.content, visibility: body.isPublic ? 'public' : 'private' },
                actor: context.actor,
                requestId: context.requestId,
            });
            return result.data;
        },
    );
}

export async function attachFile(
    ticketId: string,
    fileId: string,
    before: TicketSnapshot,
    context: ActorContext,
): Promise<unknown> {
    return auditedDelegation(
        'support.tickets.attachments.attach',
        context,
        { id: ticketId, label: labelOf(before) },
        { fileId },
        before,
        async () => {
            const result = await platformRequest<unknown>({
                method: 'POST',
                path: `/tickets/${ticketId}/attachments`,
                body: { fileId },
                actor: context.actor,
                requestId: context.requestId,
            });
            return result.data;
        },
    );
}

/**
 * Delete an attachment.
 *
 * Keyed on the ATTACHMENT id, not the ticket's — that is jovi-mall's route shape
 * (`DELETE /tickets/attachments/:id`), and it is why this is the one write on the surface
 * whose audit target cannot be resolved to a ticket label without a second read. The row
 * records the attachment id; the ticket it belonged to is on the attachment.
 */
export async function deleteAttachment(
    attachmentId: string,
    context: ActorContext,
): Promise<unknown> {
    return auditedDelegation(
        'support.tickets.attachments.delete',
        context,
        { id: attachmentId, label: null },
        { attachmentId },
        null,
        async () => {
            const result = await platformRequest<unknown>({
                method: 'DELETE',
                path: `/tickets/attachments/${attachmentId}`,
                actor: context.actor,
                requestId: context.requestId,
            });
            return result.data;
        },
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Reads that are NOT records — delegated for a reason
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The reference lookups behind the ticket-creation form, and the notes and attachment lists.
 *
 * These are delegated even though ADR-009 D-1 would allow reading the rows: they are
 * jovi-mall's own enrichment (an order joined to its customer, a note joined to its author),
 * and reproducing the joins here would be a second implementation of a projection that exists
 * only to render one form. Nothing on this path decides anything, so nothing is audited.
 */
export async function referenceLookup(
    resource: 'orders' | 'products',
    search: string | undefined,
    context: ActorContext,
): Promise<unknown> {
    const result = await platformRequest<unknown>({
        method: 'GET',
        path: `/tickets/reference/${resource}`,
        // ⚠ `q`, not `search`. jovi-mall's `TicketReferenceController.parsePagination` reads
        // `req.query.q`; a `search` parameter was accepted here, forwarded, and ignored there
        // — so the lookup always answered the unfiltered first page while looking as though
        // it had searched. Found writing `api-doc/api/support.md` (Phase 4, step 21).
        query: search ? { q: search } : undefined,
        actor: context.actor,
        requestId: context.requestId,
    });
    return result.data;
}

export async function listNotes(ticketId: string, context: ActorContext): Promise<unknown> {
    const result = await platformRequest<unknown>({
        method: 'GET',
        path: `/tickets/${ticketId}/notes`,
        actor: context.actor,
        requestId: context.requestId,
    });
    return result.data;
}

export async function listAttachments(ticketId: string, context: ActorContext): Promise<unknown> {
    const result = await platformRequest<unknown>({
        method: 'GET',
        path: `/tickets/${ticketId}/attachments`,
        actor: context.actor,
        requestId: context.requestId,
    });
    return result.data;
}

/**
 * Re-stamp the assignee's profile from this service's current record (D-10).
 *
 * Called on every mutation rather than on a schedule: the block is current-state, wi-admin
 * has already read the administrator to decide whether the write is allowed, and jovi-mall
 * guards the update on the assignee id so a refresh racing a reassignment is a no-op rather
 * than a corruption.
 *
 * **Never audited and never allowed to fail the request.** It records nothing an operator
 * decided — it copies a name — and a ticket update that succeeded must not report failure
 * because a cosmetic refresh did.
 */
export async function refreshSnapshot(
    ticketId: string,
    admin: AdminSnapshotPayload,
    context: ActorContext,
): Promise<void> {
    // ⚠ NOT `/assign`. Sending a bare `admin` there means "this administrator now holds it,
    // claimed" — routing a refresh through it would reassign the ticket on every edit and
    // clear `assigned_by`, the field the tier rules depend on.
    await platformRequest<unknown>({
        method: 'PATCH',
        path: `/tickets/${ticketId}/admin-snapshot`,
        body: { admin },
        actor: context.actor,
        requestId: context.requestId,
    });
}
