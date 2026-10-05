import { Request, Response } from 'express';
import { ObjectId } from 'mongodb';
import { env } from '../../../config/env';
import { createAppError } from '../../../core/errors/app-error';
import { ERROR_CODES } from '../../../core/errors/error-codes';
import { asyncHandler } from '../../../core/http/async-handler';
import { toPageMeta } from '../../../core/http/list-query';
import { sendCreated, sendPaginated, sendSuccess } from '../../../core/http/responses';
import { requireAdminIdentity } from '../../admin-identity/domain/admin-identity.types';
import { actorContextOf } from '../../audit/domain/audit-context';
import { toAuditEntryDto } from '../../audit/domain/audit.dto';
import { AuditRepository } from '../../audit/repositories/audit.repository';
import { ListAuditQuery } from '../../audit/validators/audit.validator';
import { StoreReadRepository } from '../../vendors/repositories/store.read.repository';
import * as actions from '../domain/refund-actions';
import * as gateway from '../gateways/refund.gateway';
import { RefundDtoView, toRefundRequestDto } from '../read-models/refund-request.dto';
import { RefundRequestReadModel, RefundRequestReadRepository } from '../repositories/refund-request.read.repository';
import {
    CreateRefundRequestBody,
    ListRefundActivityQuery,
    ListRefundRequestsQuery,
    RefundEligibilityQuery,
    RejectRefundBody,
    ResolveUnknownRefundBody,
    SettleExternalRefundBody,
} from '../validators/refund.validator';

/**
 * `/api/v1/refunds` — the refund queue (REFUND-FLOW-PLAN § 7).
 *
 * **The records are read here; every write is delegated.** The list, the detail and the
 * activity feed are direct reads of `refund_requests` and the audit trail. The eligibility
 * verdict, every transition and the proof bytes go to jovi-mall `/api/internal/admin/refunds/*`.
 * Every write is audited fail-closed in the gateway.
 *
 * Writes answer the request as THIS service reads it afterwards, so a write and a GET cannot
 * disagree in shape — the delivery-fee settle's rule.
 */

const requests = new RefundRequestReadRepository();
const stores = new StoreReadRepository();
const auditEntries = new AuditRepository();

/** The multipart field name jovi-mall's refund-proof route reads (contract § 11.7). */
export const PROOF_FIELD_NAME = 'file';

async function vendorNamesOf(rows: RefundRequestReadModel[]): Promise<Map<string, string | null>> {
    const ids = [...new Set(rows.filter((r) => r.vendor_id).map((r) => r.vendor_id!.toString()))].map(
        (id) => new ObjectId(id),
    );
    const found = await stores.findForVendors(ids);
    const names = new Map<string, string | null>();
    found.forEach((store, vendorId) => names.set(vendorId, store.name ?? null));
    return names;
}

async function toDto(row: RefundRequestReadModel, view: RefundDtoView) {
    const names = await vendorNamesOf([row]);
    return toRefundRequestDto(row, view, row.vendor_id ? names.get(row.vendor_id.toString()) ?? null : null);
}

const QUEUED_MESSAGE =
    'This refund is at or above the four-eyes threshold — submitted for a second administrator’s approval';

export class RefundController {
    /** GET /api/v1/refunds — the queue. Destination phones are MASKED here. */
    static list = asyncHandler(async (req: Request, res: Response) => {
        const query = req.query as unknown as ListRefundRequestsQuery;
        const page = await requests.search({
            status: query.status,
            open: query.open,
            sourceKind: query.sourceKind,
            sourceId: query.sourceId,
            vendorId: query.vendorId,
            customerId: query.customerId,
            requesterRole: query.requesterRole,
            requesterId: query.requesterId,
            channel: query.channel,
            paymentChannel: query.paymentChannel,
            from: query.from,
            to: query.to,
            page: query.page,
            limit: query.limit,
            sort: query.sort,
        });
        const names = await vendorNamesOf(page.items);
        sendPaginated(
            res,
            page.items.map((row) =>
                toRefundRequestDto(row, 'list', row.vendor_id ? names.get(row.vendor_id.toString()) ?? null : null)),
            toPageMeta(page.total, page.page, page.limit),
        );
    });

    /** GET /api/v1/refunds/:refundId — one request, destination in FULL (the approver compares it). */
    static detail = asyncHandler(async (req: Request, res: Response) => {
        const row = await actions.loadRefundOr404(req.params.refundId);
        sendSuccess(res, await toDto(row, 'detail'));
    });

    /** GET /api/v1/refunds/eligibility — jovi-mall's verdict on one source, passed through. */
    static eligibility = asyncHandler(async (req: Request, res: Response) => {
        const query = req.query as unknown as RefundEligibilityQuery;
        sendSuccess(
            res,
            await gateway.refundEligibility(
                {
                    sourceKind: query.sourceKind,
                    sourceId: query.sourceId,
                    reasonKind: query.reasonKind,
                    itemDefective: query.itemDefective,
                    amount: query.amount,
                },
                actorContextOf(req),
            ),
        );
    });

    /**
     * POST /api/v1/refunds — raise a request. **201** with the request; `meta.approveNow` says
     * what became of an `approveNow` (applied · queued for four-eyes · refused under R-7 · failed).
     */
    static create = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as CreateRefundRequestBody;
        const actor = requireAdminIdentity(req);

        const outcome = await actions.createRequest(
            actor,
            {
                sourceKind: body.sourceKind,
                sourceId: body.sourceId,
                amount: body.amount ?? null,
                reasonKind: body.reasonKind,
                reason: body.reason,
                itemDefective: body.itemDefective ?? null,
                overridePolicy: body.overridePolicy ?? null,
                destination: body.destination ?? null,
                destinationProofFileId: body.destinationProofFileId ?? null,
                ticketId: body.ticketId ?? null,
                approveNow: body.approveNow === true,
            },
            actorContextOf(req),
        );

        const data = outcome.request ? await toDto(outcome.request, 'detail') : { id: outcome.createdId };
        sendCreated(res, data, {
            meta: { approveNow: outcome.approveNow },
            message:
                outcome.approveNow.status === 'queued'
                    ? `Refund request raised. ${QUEUED_MESSAGE}`
                    : outcome.approveNow.status === 'applied'
                      ? 'Refund request raised and approved'
                      : 'Refund request raised — it is waiting for an approver, and the seller’s earnings are on hold',
        });
    });

    /** POST /:refundId/approve — **200** applied, or **202** with the pending approval. */
    static approve = asyncHandler(async (req: Request, res: Response) => {
        const outcome = await actions.approve(requireAdminIdentity(req), req.params.refundId, actorContextOf(req));
        if (outcome.kind === 'applied') {
            sendSuccess(res, await toDto(outcome.request, 'detail'), { message: 'Refund approved' });
            return;
        }
        sendSuccess(res, outcome.approval, {
            status: 202,
            message: outcome.created ? QUEUED_MESSAGE : 'An identical request is already awaiting approval',
        });
    });

    static reject = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as RejectRefundBody;
        const row = await actions.reject(req.params.refundId, body.reason, actorContextOf(req));
        sendSuccess(res, await toDto(row, 'detail'), {
            message: 'Refund request rejected — the seller’s earnings are no longer held for it',
        });
    });

    static retry = asyncHandler(async (req: Request, res: Response) => {
        const row = await actions.retry(req.params.refundId, actorContextOf(req));
        sendSuccess(res, await toDto(row, 'detail'), {
            message: 'Transfer retried — it is not settled until the gateway confirms it',
        });
    });

    static settleExternal = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as SettleExternalRefundBody;
        const row = await actions.settleExternally(
            req.params.refundId,
            { method: body.method, reference: body.reference ?? null, proofFileId: body.proofFileId },
            actorContextOf(req),
        );
        sendSuccess(res, await toDto(row, 'detail'), { message: 'Refund recorded as paid outside the platform' });
    });

    static resolveUnknown = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as ResolveUnknownRefundBody;
        const row = await actions.resolveUnknown(
            req.params.refundId,
            { outcome: body.outcome, note: body.note },
            actorContextOf(req),
        );
        sendSuccess(res, await toDto(row, 'detail'), {
            message: body.outcome === 'arrived'
                ? 'Transfer confirmed as arrived — the refund is completed'
                : 'Transfer recorded as failed — retry it, settle it externally, or reject the request',
        });
    });

    /**
     * POST /api/v1/refunds/proofs — stream ONE picture to jovi-mall's private `refund-proofs`
     * tree. Multipart, field `file`. The body is never parsed here (ADR-021 D-2): a content type
     * and a declared length are the only facts checked before it is piped through.
     */
    static uploadProof = asyncHandler(async (req: Request, res: Response) => {
        const contentType = req.headers['content-type'] ?? '';
        if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
            throw createAppError(
                ERROR_CODES.FILE_UPLOAD_NOT_MULTIPART,
                415,
                `Send the proof as multipart/form-data under the \`${PROOF_FIELD_NAME}\` field`,
                { fieldName: PROOF_FIELD_NAME, received: contentType || null },
            );
        }

        const maxBytes = env().ADMIN_UPLOAD_MAX_BYTES;
        const declared = Number(req.headers['content-length']);
        const contentLength = Number.isFinite(declared) ? declared : null;
        if (contentLength !== null && contentLength > maxBytes) {
            throw createAppError(
                ERROR_CODES.FILE_UPLOAD_TOO_LARGE,
                413,
                'This upload is larger than the administration upload limit',
                { maxBytes, declaredBytes: contentLength },
            );
        }

        const uploaded = await gateway.uploadRefundProof({ body: req, contentType, contentLength }, actorContextOf(req));
        sendCreated(res, uploaded, { meta: { maxBytes, fieldName: PROOF_FIELD_NAME } });
    });

    /**
     * GET /api/v1/refunds/proofs/:fileId — the picture's BYTES, streamed from jovi-mall.
     *
     * Served ONLY when a refund request names the file (as its destination proof or its
     * external-settlement proof), so this cannot become a reader of any private file whose id
     * somebody holds; the 404 comes before the audit row, so a typo is not recorded as a
     * disclosure. Headers are set before the pipe; a mid-stream failure destroys the response.
     */
    static openProof = asyncHandler(async (req: Request, res: Response) => {
        const { fileId } = req.params;
        const owner = await requests.findByProofFile(fileId);
        if (!owner) {
            throw createAppError(ERROR_CODES.FILE_NOT_FOUND, 404, 'No refund request names this proof file');
        }

        const content = await gateway.openRefundProof(
            fileId,
            { refundId: owner._id.toString(), label: owner.order_number ?? null },
            actorContextOf(req),
        );

        res.setHeader('Content-Type', content.contentType);
        if (content.contentLength !== null) res.setHeader('Content-Length', String(content.contentLength));
        if (content.contentDisposition !== null) res.setHeader('Content-Disposition', content.contentDisposition);
        res.setHeader('Cache-Control', 'private, no-store');
        content.stream.on('error', () => res.destroy());
        content.stream.pipe(res);
    });

    /**
     * GET /:refundId/activity — what administrators did to this request (needs `audit.read` too:
     * these rows ARE audit rows). A request still waiting for a SECOND administrator is at
     * `GET /approvals?targetId=<refundId>`; once committed, its row appears here.
     */
    static activity = asyncHandler(async (req: Request, res: Response) => {
        const identity = requireAdminIdentity(req);
        const query = req.query as unknown as ListRefundActivityQuery;
        await actions.loadRefundOr404(req.params.refundId);

        const page = await auditEntries.search(
            {
                page: query.page,
                limit: query.limit,
                sort: query.sort,
                action: query.action,
                status: query.status,
                from: query.from,
                to: query.to,
                targetType: 'refund',
                targetId: req.params.refundId,
            } as ListAuditQuery,
            identity,
        );
        sendPaginated(res, page.items.map(toAuditEntryDto), page.meta);
    });
}
