import { Router } from 'express';
import { defineRoute, permission, records } from '../../../api/route-manifest';
import { SupportTicketController } from '../controllers/ticket.controller';
import {
    AddFollowerSchema,
    AssignTicketSchema,
    AttachFileSchema,
    AttachmentIdParamSchema,
    ClaimTicketSchema,
    CreateNoteSchema,
    CreateTicketSchema,
    LifecycleSchema,
    ReferenceQuerySchema,
    SearchTicketsQuerySchema,
    TicketFollowerParamSchema,
    TicketIdParamSchema,
    UpdatePrioritySchema,
    UpdateStatusSchema,
    UpdateTicketSchema,
} from '../validators/ticket.validator';

/**
 * `/api/v1/support/tickets` — the support queue.
 *
 * The eleven `support.tickets.*` permissions were catalogued at Phase 3 and had no endpoint
 * until now; this is the surface they were written for. jovi-mall's own `/api/admin/tickets`
 * mount is **deleted**, so this is the only administrative door onto tickets.
 *
 * ── Read and write hold different permissions, and so do the writes ───────────
 * `support.tickets.read` is a Support-tier lookup and every tier holds it. The writes split
 * four ways on purpose — `update` for the content, `assign` for who holds it, `lifecycle`
 * for open/closed, `followers.manage` for who is on it — because they are four different
 * jobs and a single `support.tickets.write` would mean anyone who can rename a ticket can
 * also reassign it.
 *
 * ── Route order ──────────────────────────────────────────────────────────────
 * `/reference/*` and `/attachments/:attachmentId` are literal siblings of `/:ticketId`, so
 * they are declared FIRST. Express matches in registration order; below `/:ticketId` they
 * would be read as ids, silently, and only for those paths.
 */
const router = Router();
const mountedAt = '/support/tickets';

// ─── Literals, before `/:ticketId` ───────────────────────────────────────────

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/reference/orders',
    access: permission('support.reference.read'),
    validate: { query: ReferenceQuerySchema },
    handler: SupportTicketController.referenceOrders,
});

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/reference/products',
    access: permission('support.reference.read'),
    validate: { query: ReferenceQuerySchema },
    handler: SupportTicketController.referenceProducts,
});

/**
 * Deleting an attachment is keyed on the ATTACHMENT, matching jovi-mall's own route — so
 * unlike every sibling it cannot take its ticket scope from the path. The handler resolves
 * the attachment to its ticket first and then applies the same `loadScoped` + `assertMayAct`
 * pair as the rest of the surface; `test:authz` asserts it, derived from these declarations
 * rather than from a list, so a mutating route added here is covered by construction.
 */
defineRoute(router, {
    mountedAt,
    method: 'delete',
    path: '/attachments/:attachmentId',
    access: permission('support.tickets.attachments.write'),
    validate: { params: AttachmentIdParamSchema },
    audit: records('support.tickets.attachments.delete'),
    handler: SupportTicketController.deleteAttachment,
});

// ─── The queue ───────────────────────────────────────────────────────────────

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/',
    access: permission('support.tickets.read'),
    validate: { query: SearchTicketsQuerySchema },
    handler: SupportTicketController.search,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/',
    access: permission('support.tickets.create'),
    validate: { body: CreateTicketSchema },
    audit: records('support.tickets.create'),
    handler: SupportTicketController.create,
});

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/:ticketId',
    access: permission('support.tickets.read'),
    validate: { params: TicketIdParamSchema },
    handler: SupportTicketController.get,
});

defineRoute(router, {
    mountedAt,
    method: 'patch',
    path: '/:ticketId',
    access: permission('support.tickets.update'),
    validate: { params: TicketIdParamSchema, body: UpdateTicketSchema },
    audit: records('support.tickets.update'),
    handler: SupportTicketController.update,
});

/**
 * Status and priority are POST/PATCH sub-resources rather than fields on the ticket PATCH.
 *
 * ADR-005 D-4: the permission and the audit row attach to the ACTION. All three move a
 * column, and they record three different actions — folding them into one body would mean
 * one audit row that cannot say which of them happened.
 */
defineRoute(router, {
    mountedAt,
    method: 'patch',
    path: '/:ticketId/status',
    access: permission('support.tickets.update'),
    validate: { params: TicketIdParamSchema, body: UpdateStatusSchema },
    audit: records('support.tickets.status.set'),
    handler: SupportTicketController.setStatus,
});

defineRoute(router, {
    mountedAt,
    method: 'patch',
    path: '/:ticketId/priority',
    access: permission('support.tickets.update'),
    validate: { params: TicketIdParamSchema, body: UpdatePrioritySchema },
    audit: records('support.tickets.priority.set'),
    handler: SupportTicketController.setPriority,
});

// ─── Who holds it ────────────────────────────────────────────────────────────

defineRoute(router, {
    mountedAt,
    method: 'patch',
    path: '/:ticketId/assign',
    access: permission('support.tickets.assign'),
    validate: { params: TicketIdParamSchema, body: AssignTicketSchema },
    audit: records('support.tickets.assign'),
    handler: SupportTicketController.assign,
});

/**
 * Claiming is its own route, not `assign` pointed at yourself.
 *
 * It records a different audit action, it takes no target, and above all it is open to every
 * tier where assignment is not — a Support administrator may claim from the pool but may only
 * ever *assign* upward to Tier 2. One endpoint would have to encode that as a special case.
 */
defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/:ticketId/claim',
    access: permission('support.tickets.assign'),
    validate: { params: TicketIdParamSchema, body: ClaimTicketSchema },
    audit: records('support.tickets.claim'),
    handler: SupportTicketController.claim,
});

// ─── Lifecycle ───────────────────────────────────────────────────────────────

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/:ticketId/close',
    access: permission('support.tickets.lifecycle'),
    validate: { params: TicketIdParamSchema, body: LifecycleSchema },
    audit: records('support.tickets.close'),
    handler: SupportTicketController.close,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/:ticketId/reopen',
    access: permission('support.tickets.lifecycle'),
    validate: { params: TicketIdParamSchema, body: LifecycleSchema },
    audit: records('support.tickets.reopen'),
    handler: SupportTicketController.reopen,
});

// ─── Followers ───────────────────────────────────────────────────────────────

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/:ticketId/followers',
    access: permission('support.tickets.followers.manage'),
    validate: { params: TicketIdParamSchema, body: AddFollowerSchema },
    audit: records('support.tickets.followers.add'),
    handler: SupportTicketController.addFollower,
});

defineRoute(router, {
    mountedAt,
    method: 'delete',
    path: '/:ticketId/followers/:userId',
    access: permission('support.tickets.followers.manage'),
    validate: { params: TicketFollowerParamSchema },
    audit: records('support.tickets.followers.remove'),
    handler: SupportTicketController.removeFollower,
});

// ─── Notes ───────────────────────────────────────────────────────────────────

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/:ticketId/notes',
    access: permission('support.tickets.notes.read'),
    validate: { params: TicketIdParamSchema },
    handler: SupportTicketController.listNotes,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/:ticketId/notes',
    access: permission('support.tickets.notes.write'),
    validate: { params: TicketIdParamSchema, body: CreateNoteSchema },
    audit: records('support.tickets.notes.create'),
    handler: SupportTicketController.createNote,
});

// ─── Attachments ─────────────────────────────────────────────────────────────

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/:ticketId/attachments',
    access: permission('support.tickets.attachments.read'),
    validate: { params: TicketIdParamSchema },
    handler: SupportTicketController.listAttachments,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/:ticketId/attachments',
    access: permission('support.tickets.attachments.write'),
    validate: { params: TicketIdParamSchema, body: AttachFileSchema },
    audit: records('support.tickets.attachments.attach'),
    handler: SupportTicketController.attachFile,
});

export const supportTicketRoutes = router;
