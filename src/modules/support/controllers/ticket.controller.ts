import { Request, Response } from 'express';
import { asyncHandler } from '../../../core/http/async-handler';
import { createAppError } from '../../../core/errors/app-error';
import { ERROR_CODES } from '../../../core/errors/error-codes';
import { sendCreated, sendPaginated, sendSuccess } from '../../../core/http/responses';
import { requestLogger } from '../../../core/logging/logger';
import { requireAdminIdentity } from '../../admin-identity/domain/admin-identity.types';
import { AdminAccountRepository } from '../../admin-identity/repositories/admin-account.repository';
import { actorContextOf } from '../../audit/domain/audit-context';
import { resolveScope } from '../../authorization/domain/resource-scope';
import { assignableTiers, mayActOnTicket, mayClaim } from '../domain/assignment-authority';
import { snapshotOf } from '../domain/admin-snapshot';
import * as gateway from '../gateways/ticket.gateway';
import { TicketEntityReadRepository } from '../repositories/ticket-entity.read.repository';
import {
    TicketAttachmentFileReadRepository,
    TicketAttachmentReadRepository,
    TicketReadRepository,
} from '../repositories/ticket.read.repository';
import { assignmentStateOf, toTicketDetailDto, toTicketDto } from '../read-models/ticket.dto';
import {
    AddFollowerBody,
    AssignTicketBody,
    AttachFileBody,
    CreateNoteBody,
    CreateTicketBody,
    SearchTicketsQuery,
    UpdatePriorityBody,
    UpdateStatusBody,
    UpdateTicketBody,
} from '../validators/ticket.validator';

/**
 * `/api/v1/support/tickets` — the support queue.
 *
 * Both halves of ADR-004 meet here: the queue, the detail, the notes and the attachments are
 * **direct reads**; every mutation is **delegated**. The reason is not symmetry — jovi-mall
 * publishes four in-process events per ticket write, and a second writer would move the row
 * and leave the customer un-notified.
 *
 * ── Two layers decide who may touch a ticket, and they are the same rule ──────
 * `resolveScope('tickets')` is the QUERY form: which rows come back at all. A record outside
 * it is **not found**, so a Support administrator probing for an Admin's ticket gets a 404
 * rather than a 403 that would confirm it exists.
 *
 * `mayActOnTicket` / `assignableTiers` are the SINGLE-RECORD form, applied to a row the
 * scope already returned. Both read the same policy; the second exists because reaching a
 * ticket and being allowed to reassign it are different questions, and only the first can be
 * expressed as a filter.
 *
 * ── What this surface deliberately does NOT offer ─────────────────────────────
 *  - **Unassigning.** A ticket leaves an administrator by being assigned onward, which the
 *    tier rules govern. Returning one to the pool would be a way around them: drop it, let
 *    anyone claim it.
 *  - **Deleting a ticket.** jovi-mall soft-deletes on its own schedule and the attachment
 *    cleanup worker keys off the terminal-status clock; a delete from here would strand it.
 *  - **Editing somebody else's note.** A note is an append-only record of what was said.
 */

const tickets = new TicketReadRepository();
const attachments = new TicketAttachmentReadRepository();
/** The `fileId` stamp on the attachment list. See `withFileIds`. */
const attachmentFiles = new TicketAttachmentFileReadRepository();
const accounts = new AdminAccountRepository();
/** Makes `about` navigable — one read on the DETAIL only. See the repository's header. */
const ticketEntities = new TicketEntityReadRepository();

/** The caller's own snapshot, for the assigner stamp and the D-10 refresh. */
async function callerSnapshot(adminId: string) {
    const account = await accounts.findById(adminId);
    if (!account) {
        // The session is valid but the account is gone — a state only a concurrent deletion
        // produces. Fail rather than write a ticket stamped with a name we cannot read.
        throw createAppError(ERROR_CODES.ADMIN_ACCOUNT_NOT_FOUND, 404, 'Your administrator account was not found');
    }
    return snapshotOf(account);
}

/**
 * Load a ticket the caller may reach, or 404.
 *
 * The scope is in the query, so "not yours" and "does not exist" are one answer by
 * construction rather than by a branch somebody remembered to write the same way twice.
 */
async function loadScoped(req: Request, ticketId: string) {
    const identity = requireAdminIdentity(req);
    const ticket = await tickets.findScoped(ticketId, resolveScope(identity, 'tickets'));
    if (!ticket) {
        throw createAppError(ERROR_CODES.TICKET_NOT_FOUND, 404, 'Support ticket not found');
    }
    return { identity, ticket };
}

/**
 * Refuse a write the tier rules do not allow, AFTER the scope has already let the row
 * through.
 *
 * A 403 here rather than a 404 is deliberate and is the opposite call from the scope: the
 * caller can already see this ticket, so refusing to say why would be unhelpful without
 * concealing anything they do not already know.
 */
function assertMayAct(req: Request, ticket: Parameters<typeof assignmentStateOf>[0]): void {
    const identity = requireAdminIdentity(req);
    if (!mayActOnTicket(identity.tier, identity.adminId, assignmentStateOf(ticket))) {
        throw createAppError(
            ERROR_CODES.AUTHZ_PERMISSION_DENIED,
            403,
            'This ticket is held by an administrator whose work you may not act on',
        );
    }
}

/**
 * Stamp each delegated attachment row with `fileId` — the id of the File it points at.
 *
 * ── Why the list is delegated but this field is not ───────────────────────────
 * The row itself has to come from jovi-mall: its `url` is `storage.getPublicUrl(key)` on
 * the active provider, which is machinery this service does not own (ADR-018 D-4). The file
 * ID is the opposite kind of value — a plain reference sitting on the attachment row in the
 * shared database, needing nothing to resolve — so it is read here rather than waiting on a
 * jovi-mall release. That split is ADR-009 D-1: delegate the projection that needs the other
 * service's machinery, read the record directly.
 *
 * ── Why a row can come back with `fileId: null` ──────────────────────────────
 * The two reads are not one transaction: an attachment deleted between jovi-mall's answer
 * and this lookup has a row and no id. The key is still present, because a client that must
 * branch on `'fileId' in row` learns nothing a `null` does not tell it, and an omitted key
 * looks like an older service rather than a raced delete.
 *
 * Anything that is not a list of rows is passed through untouched — this decorates jovi-mall's
 * answer, and it is not this route's job to decide that answer was malformed.
 */
async function withFileIds(ticketId: string, delegated: unknown): Promise<unknown> {
    if (!Array.isArray(delegated) || delegated.length === 0) return delegated;

    const fileIds = await attachmentFiles.findFileIdsByTicket(ticketId);

    return delegated.map((row) => {
        if (row === null || typeof row !== 'object') return row;
        const id = (row as { id?: unknown }).id;
        return { ...row, fileId: typeof id === 'string' ? fileIds.get(id) ?? null : null };
    });
}

export class SupportTicketController {

    static search = asyncHandler(async (req: Request, res: Response) => {
        const identity = requireAdminIdentity(req);
        const query = req.query as unknown as SearchTicketsQuery;

        const page = await tickets.search(query, resolveScope(identity, 'tickets'), identity.adminId);

        sendPaginated(
            res,
            page.items.map((ticket) => toTicketDto(ticket, identity)),
            { total: page.total, page: page.page, limit: page.limit, pages: page.pages },
        );
    });

    /**
     * One ticket, with its `about` made navigable (BR-016 § 7).
     *
     * `entity.vendorId` is the field that unblocks it: a product's detail route needs a
     * vendor id and a product id, and the ticket carries one. The label beside it is a
     * convenience — the destination screen supplies the name once the link exists.
     *
     * The queue does not do this, deliberately: one lookup per row would be a hundred reads
     * across three collections to decorate a column that shows an id.
     */
    static get = asyncHandler(async (req: Request, res: Response) => {
        const { identity, ticket } = await loadScoped(req, req.params.ticketId);
        const entity = await ticketEntities.resolve(ticket.entity_type, ticket.entity_id);

        sendSuccess(res, toTicketDetailDto(ticket, identity, entity));
    });

    static create = asyncHandler(async (req: Request, res: Response) => {
        const identity = requireAdminIdentity(req);
        const body = req.body as CreateTicketBody;

        const created = await gateway.createTicket(
            body as unknown as Record<string, unknown>,
            await callerSnapshot(identity.adminId),
            actorContextOf(req),
        );

        sendCreated(res, created);
    });

    static update = asyncHandler(async (req: Request, res: Response) => {
        const { ticket } = await loadScoped(req, req.params.ticketId);
        assertMayAct(req, ticket);

        const body = req.body as UpdateTicketBody;
        const updated = await gateway.updateTicket(
            req.params.ticketId,
            body as Record<string, unknown>,
            ticket,
            actorContextOf(req),
        );

        await refreshHolder(req, ticket);
        sendSuccess(res, updated);
    });

    static setStatus = asyncHandler(async (req: Request, res: Response) => {
        const { ticket } = await loadScoped(req, req.params.ticketId);
        assertMayAct(req, ticket);

        const { status } = req.body as UpdateStatusBody;
        const updated = await gateway.setStatus(req.params.ticketId, status, ticket, actorContextOf(req));

        await refreshHolder(req, ticket);
        sendSuccess(res, updated);
    });

    static setPriority = asyncHandler(async (req: Request, res: Response) => {
        const { ticket } = await loadScoped(req, req.params.ticketId);
        assertMayAct(req, ticket);

        const { priority } = req.body as UpdatePriorityBody;
        const updated = await gateway.setPriority(req.params.ticketId, priority, ticket, actorContextOf(req));

        await refreshHolder(req, ticket);
        sendSuccess(res, updated);
    });

    /**
     * Hand the ticket to another administrator.
     *
     * The target's tier comes from THEIR `admin_accounts` row, never from the request — it
     * decides, through the scope's `alsoTiers` clause, who may subsequently see the ticket.
     */
    static assign = asyncHandler(async (req: Request, res: Response) => {
        const { identity, ticket } = await loadScoped(req, req.params.ticketId);
        assertMayAct(req, ticket);

        const { administratorId } = req.body as AssignTicketBody;

        const target = await accounts.findById(administratorId);
        if (!target || target.status !== 'active') {
            throw createAppError(
                ERROR_CODES.TICKET_NOT_FOUND,
                404,
                'No active administrator with that id',
            );
        }

        const allowed = assignableTiers(identity.tier, identity.adminId, assignmentStateOf(ticket));
        if (!allowed.includes(target.tier)) {
            throw createAppError(
                ERROR_CODES.AUTHZ_PERMISSION_DENIED,
                403,
                `You may not hand this ticket to a tier ${target.tier} administrator`,
            );
        }

        const updated = await gateway.assign(
            req.params.ticketId,
            'support.tickets.assign',
            snapshotOf(target),
            await callerSnapshot(identity.adminId),
            ticket,
            actorContextOf(req),
        );

        sendSuccess(res, updated);
    });

    /**
     * Claim an unassigned ticket. Open to every tier — unclaimed work nobody may pick up is
     * a queue that stops moving, and every system ticket starts there.
     */
    static claim = asyncHandler(async (req: Request, res: Response) => {
        const { identity, ticket } = await loadScoped(req, req.params.ticketId);

        if (!mayClaim(assignmentStateOf(ticket))) {
            throw createAppError(
                ERROR_CODES.TICKET_ALREADY_ASSIGNED,
                409,
                'This ticket is already held by an administrator',
            );
        }

        const updated = await gateway.assign(
            req.params.ticketId,
            'support.tickets.claim',
            await callerSnapshot(identity.adminId),
            // A claim records no assigner — that is what distinguishes it, and the tier rules
            // read `assigned_by` to decide where a ticket may go next.
            null,
            ticket,
            actorContextOf(req),
        );

        sendSuccess(res, updated);
    });

    static close = asyncHandler(async (req: Request, res: Response) => {
        const { ticket } = await loadScoped(req, req.params.ticketId);
        assertMayAct(req, ticket);

        const updated = await gateway.close(req.params.ticketId, ticket, actorContextOf(req));
        sendSuccess(res, updated);
    });

    static reopen = asyncHandler(async (req: Request, res: Response) => {
        const { ticket } = await loadScoped(req, req.params.ticketId);
        assertMayAct(req, ticket);

        const updated = await gateway.reopen(req.params.ticketId, ticket, actorContextOf(req));
        sendSuccess(res, updated);
    });

    static addFollower = asyncHandler(async (req: Request, res: Response) => {
        const { ticket } = await loadScoped(req, req.params.ticketId);
        assertMayAct(req, ticket);

        const body = req.body as AddFollowerBody;
        const updated = await gateway.addFollower(req.params.ticketId, body, ticket, actorContextOf(req));
        sendSuccess(res, updated);
    });

    static removeFollower = asyncHandler(async (req: Request, res: Response) => {
        const { ticket } = await loadScoped(req, req.params.ticketId);
        assertMayAct(req, ticket);

        const updated = await gateway.removeFollower(
            req.params.ticketId,
            req.params.userId,
            ticket,
            actorContextOf(req),
        );
        sendSuccess(res, updated);
    });

    static listNotes = asyncHandler(async (req: Request, res: Response) => {
        await loadScoped(req, req.params.ticketId);
        sendSuccess(res, await gateway.listNotes(req.params.ticketId, actorContextOf(req)));
    });

    static createNote = asyncHandler(async (req: Request, res: Response) => {
        const { ticket } = await loadScoped(req, req.params.ticketId);
        assertMayAct(req, ticket);

        const body = req.body as CreateNoteBody;
        const created = await gateway.createNote(req.params.ticketId, body, ticket, actorContextOf(req));
        sendCreated(res, created);
    });

    static listAttachments = asyncHandler(async (req: Request, res: Response) => {
        await loadScoped(req, req.params.ticketId);
        const rows = await gateway.listAttachments(req.params.ticketId, actorContextOf(req));
        sendSuccess(res, await withFileIds(req.params.ticketId, rows));
    });

    static attachFile = asyncHandler(async (req: Request, res: Response) => {
        const { ticket } = await loadScoped(req, req.params.ticketId);
        assertMayAct(req, ticket);

        const { fileId } = req.body as AttachFileBody;
        const created = await gateway.attachFile(req.params.ticketId, fileId, ticket, actorContextOf(req));
        sendCreated(res, created);
    });

    /**
     * Delete an attachment — scoped through its ticket, in three reads.
     *
     * ── Why this one is keyed on the ATTACHMENT and every neighbour is not ────────
     * jovi-mall's route is `DELETE /tickets/attachments/:id`: the attachment id is the whole
     * address, and the attachment row is the only thing that names its ticket. So the scope
     * cannot be applied first here the way it is everywhere else on this surface — it has to
     * be *reached*, by resolving the attachment to its ticket and then loading that ticket
     * exactly as `update`, `assign` and `attachFile` do. **Do not "simplify" the lookup away**
     * on the grounds that the gateway already takes an attachment id; the lookup is not
     * plumbing, it is the only thing standing between this route and any attachment on the
     * platform.
     *
     * ── The two checks, in the same order as every other write ────────────────────
     * `loadScoped` is the tier scope — a ticket outside it is **not found**, 404, so nobody
     * can map another tier's queue by watching statuses change. `assertMayAct` is the
     * assignment lock — 403, because by then the caller can already see the ticket and
     * concealing the reason would protect nothing.
     *
     * ── Why a missing attachment answers TICKET_NOT_FOUND ─────────────────────────
     * The same code and the same message as an out-of-scope ticket, deliberately. Two 404s
     * that differ only in their `error.code` are still an existence oracle: a Support-tier
     * administrator holding an attachment id could otherwise learn that it exists on a ticket
     * they may not see. Identical answers make the two indistinguishable by construction,
     * which is the same argument `TICKET_NOT_FOUND`'s own docstring makes for 404-over-403.
     */
    static deleteAttachment = asyncHandler(async (req: Request, res: Response) => {
        const ticketId = await attachments.findTicketIdByAttachment(req.params.attachmentId);
        if (!ticketId) {
            throw createAppError(ERROR_CODES.TICKET_NOT_FOUND, 404, 'Support ticket not found');
        }

        const { ticket } = await loadScoped(req, ticketId);
        assertMayAct(req, ticket);

        const removed = await gateway.deleteAttachment(req.params.attachmentId, actorContextOf(req));
        sendSuccess(res, removed);
    });

    static referenceOrders = asyncHandler(async (req: Request, res: Response) => {
        const search = (req.query as { search?: string }).search;
        sendSuccess(res, await gateway.referenceLookup('orders', search, actorContextOf(req)));
    });

    static referenceProducts = asyncHandler(async (req: Request, res: Response) => {
        const search = (req.query as { search?: string }).search;
        sendSuccess(res, await gateway.referenceLookup('products', search, actorContextOf(req)));
    });
}

/**
 * Keep the assignee's snapshot current (D-10), without letting it break the request.
 *
 * A ticket update that succeeded must not report failure because a cosmetic name refresh
 * did, so this swallows. It is also a no-op when the ticket is unassigned, and jovi-mall
 * guards the write on the assignee id — so a refresh racing a reassignment loses harmlessly
 * rather than overwriting the new holder.
 *
 * ── Swallowed is not the same as unobserved (G-6) ─────────────────────────────
 * Swallowing is right; swallowing *silently* was not. The snapshot is the only record of
 * this administrator there will ever be on jovi-mall's side, so a failure here means a
 * rename stays unpropagated — visible to a customer reading the ticket, and to nobody else.
 * The `warn` carries the three identifiers that make it actionable: without the holder id it
 * answers "something failed", with it, "this administrator's rename did not propagate",
 * which is the question.
 *
 * **Do not add a counter here.** wi-admin has no Prometheus registry — `GET
 * /api/v1/system/metrics` delegates to *jovi-mall's*, and `infra/geo/prom-text.ts` only
 * parses geo-tracker's exposition. Adding one means `prom-client`, an exposition route, a
 * scrape target and a decision about whether this service joins the metrics estate: an ADR,
 * not a line in a `catch`. A log carrying the three ids answers "did this rename propagate",
 * which is the whole question this signal exists for.
 *
 * The missing-account branch stays silent deliberately, and is a different fault: an
 * assignment pointing at an account that no longer exists is not a rename failing to
 * propagate, and the place to catch it is the assign path, not a best-effort refresh.
 */
async function refreshHolder(req: Request, ticket: Parameters<typeof assignmentStateOf>[0]): Promise<void> {
    const holderId = assignmentStateOf(ticket).holderId;
    if (!holderId) return;

    const context = actorContextOf(req);
    try {
        const account = await accounts.findById(holderId);
        if (!account) return;
        await gateway.refreshSnapshot(String(ticket._id), snapshotOf(account), context);
    } catch (err) {
        // Swallowed — the write it accompanies already succeeded — but never unobserved.
        requestLogger(context.requestId).warn(
            {
                ticketId: String(ticket._id),
                holderId,
                err: err instanceof Error ? err.message : String(err),
            },
            'support: assignee snapshot refresh failed — this administrator’s details may be stale on the ticket',
        );
    }
}
