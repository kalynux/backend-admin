import { env } from '../../../config/env';
import { platformRequest, platformStream, platformUpload } from '../../../infra/platform/platform.client';
import { ActorContext, auditActorOf } from '../../audit/domain/audit-context';
import { AuditAction } from '../../audit/domain/audit.catalog';
import { AuditTarget } from '../../audit/domain/audit.types';
import { auditedAttempt } from '../../audit/domain/audit.writer';

/**
 * The refund queue's DELEGATED half — every write, the eligibility verdict and the proof bytes,
 * all against jovi-mall `/api/internal/admin/refunds/*` (REFUND-FLOW-PLAN § 11.7), behind
 * `requireAdminCaller` and `JOVI_MALL_SERVICE_TOKEN`, carrying the acting administrator in the
 * same `X-Actor-Id` / `X-Actor-Name` / `X-Actor-Tier` headers every gateway sends
 * (`platformRequest` sets them per call).
 *
 * ── Why every write is delegated ──────────────────────────────────────────────
 * A refund transition is never one column. Opening a request pauses the seller's earnings;
 * approving claims a payout transfer behind a double-send guard; completion writes
 * `refund_transactions`, claws earnings back and tells the customer. A second writer would move
 * the status and fire none of it — ADR-004 D-2, at its most expensive.
 *
 * ── Audited FAIL-CLOSED, here at the transport boundary ───────────────────────
 * `auditedAttempt` commits the intent row BEFORE `platformRequest` is called and does not catch
 * a failure of that write: with the audit store down, no refund moves. Wrapping here rather than
 * in the controller means a verb added later inherits it by construction (the money gateway's
 * argument). The approve verb may be performed by a SECOND administrator through four-eyes, so
 * it threads `viaApprovalId` — the pair reads as "X asked, Y did it".
 *
 * The thin functions below are the point: this file should never grow logic.
 */

/** jovi-mall's refund request DTO (camelCase of § 11.1) — as much of it as this file names. */
export interface PlatformRefundRequest {
    id: string;
    status?: string;
    grossAmount?: number;
    feeAmount?: number;
    netAmount?: number;
    channel?: string | null;
    destination?: { source?: string | null } | null;
    [key: string]: unknown;
}

/** One row of `attributionPreview.byReasonKind`: what that reason would refund, and net of the fee. */
export interface PlatformAttributionPreviewRow {
    maxRefundable: number;
    goods: number;
    delivery: number;
    feeAmount: number;
    netAmount: number;
}

/**
 * `GET /refunds/eligibility` — passed through; it is jovi-mall's verdict, not a record
 * (`payments/services/refund-eligibility.service.ts` → `RefundEligibilityDto`).
 */
export interface PlatformRefundEligibility {
    sourceKind: string;
    sourceId: string;
    /** GROSS ceiling for the selected reason: min(attribution rule, money still refundable). */
    maxRefundable: number;
    currency: string;
    paymentChannel: string;
    hasPayerPhone: boolean;
    payerPhoneMasked: string | null;
    attributionPreview: {
        reasonKind: string;
        itemDefective: boolean | null;
        goods: number;
        delivery: number;
        goodsAmount: number;
        deliveryAmountPaid: number;
        delivered: boolean;
        remaining: number;
        feeAmount: number;
        netAmount: number;
        byReasonKind: Record<string, PlatformAttributionPreviewRow>;
        [key: string]: unknown;
    };
    returnShippingPayer: string | null;
    /** `return_window_expired` · `policy_disabled` · `order_not_paid` · `above_policy_maximum`. */
    overrides: string[];
    codCoverage: unknown[];
    feePercent: number;
    [key: string]: unknown;
}

/** The eligibility query, exactly the five keys jovi-mall's STRICT schema accepts. */
export interface RefundEligibilityInput {
    sourceKind: string;
    sourceId: string;
    reasonKind?: string;
    itemDefective?: boolean;
    amount?: number;
}

/** What the caller already read about the request, so the audit row needs no second lookup. */
export interface RefundAuditContext {
    refundId: string | null;
    label: string | null;
    before: Record<string, unknown> | null;
    /** The order or booking the request is about — `related_target_*` on the row. */
    related: AuditTarget | null;
}

/** jovi-mall's answer, reduced to the keys `toRefundAuditState` writes for `before`. */
function refundState(result: PlatformRefundRequest | null): Record<string, unknown> | null {
    if (!result || typeof result !== 'object') return null;
    return {
        status: result.status ?? null,
        grossAmount: result.grossAmount ?? null,
        feeAmount: result.feeAmount ?? null,
        netAmount: result.netAmount ?? null,
        channel: result.channel ?? null,
        destinationSource: result.destination?.source ?? null,
    };
}

function auditedRefundWrite(
    action: AuditAction,
    context: ActorContext,
    audit: RefundAuditContext,
    payload: Record<string, unknown> | null,
    call: { method: 'POST'; path: string; body: Record<string, unknown> },
    viaApprovalId: string | null = null,
): Promise<PlatformRefundRequest> {
    return auditedAttempt(
        {
            action,
            actor: auditActorOf(context.actor),
            // `id: null` on a create — unknowable until jovi-mall answers, stamped from it.
            target: { type: 'refund', id: audit.refundId, label: audit.label },
            relatedTarget: audit.related,
            context,
            payload,
            viaApprovalId,
        },
        async () => {
            const result = await platformRequest<PlatformRefundRequest>({
                method: call.method,
                path: call.path,
                body: call.body,
                actor: context.actor,
                requestId: context.requestId,
            });
            const created = result.data;
            return {
                result: created,
                target: audit.refundId === null && created?.id ? { id: String(created.id) } : undefined,
                before: audit.before,
                after: refundState(created),
            };
        },
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// The verdict read
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What may be refunded on one source, through which channel, to which number, and what the
 * customer would receive. DELEGATED: "how much is this customer owed" is jovi-mall's refund
 * arithmetic, and a copy here would be a second definition of it. Not audited — a read that
 * moves nothing; the payer number arrives MASKED.
 */
export async function refundEligibility(
    query: RefundEligibilityInput,
    context: ActorContext,
): Promise<PlatformRefundEligibility> {
    // Named key by key: jovi-mall's query is `.strict()`, so anything else would be its 400.
    // Absent keys are OMITTED (never `undefined` → "undefined" on the wire).
    const forwarded: Record<string, string> = { sourceKind: query.sourceKind, sourceId: query.sourceId };
    if (query.reasonKind !== undefined) forwarded.reasonKind = query.reasonKind;
    if (query.itemDefective !== undefined) forwarded.itemDefective = query.itemDefective ? 'true' : 'false';
    if (query.amount !== undefined) forwarded.amount = String(query.amount);
    const result = await platformRequest<PlatformRefundEligibility>({
        method: 'GET',
        path: '/refunds/eligibility',
        query: forwarded,
        actor: context.actor,
        requestId: context.requestId,
    });
    return result.data;
}

// ─────────────────────────────────────────────────────────────────────────────
// The writes
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateRefundInput {
    sourceKind: string;
    sourceId: string;
    amount: number | null;
    reasonKind: string;
    reason: string;
    itemDefective: boolean | null;
    overridePolicy: boolean | null;
    /** `name` is optional on jovi-mall's side too; omitted rather than sent empty. */
    destination: { phone: string; name?: string } | null;
    destinationProofFileId: string | null;
    /** The support ticket the request was raised from, passed through. */
    ticketId: string | null;
    /** Decided by this service from the caller's permissions — never from the body. */
    requestedByRole: 'admin' | 'support';
}

/**
 * Raise a request — `awaiting_approval`, earnings paused (C-4).
 *
 * ⚠ `approveNow` is ALWAYS sent `false`. When an administrator asks to approve straight away,
 * this service approves in a second call through the ordinary approve path, so the four-eyes
 * threshold is evaluated against the CREATED row's `gross_amount` — which jovi-mall computes,
 * and which this side cannot know before it exists. See `domain/refund-actions.ts`.
 *
 * ⛔ The payload carries the destination's SOURCE, never the typed phone: the audit store is
 * readable by every tier, and the number is the customer's.
 *
 * Refusals that matter to the form, all arriving as `PLATFORM_OPERATION_REJECTED` with
 * `details.platformCode` (and jovi-mall's `details`, which this client forwards for a 4xx):
 *  - `422 REFUND_POLICY_OVERRIDE_REQUIRED` + `details.overrides` — an order refund past the
 *    vendor's return policy without `overridePolicy: true`. Never retried with the flag here:
 *    the administrator confirms the named overrides and re-sends.
 *  - `422 REFUND_DESTINATION_PROOF_REQUIRED` + `details.reason: 'proof_not_found'` — the proof id
 *    is not a live file in the private `refund-proofs` tree (upload it through `/refunds/proofs`).
 */
export async function createRefundRequest(
    input: CreateRefundInput,
    audit: RefundAuditContext,
    context: ActorContext,
): Promise<PlatformRefundRequest> {
    return auditedRefundWrite(
        'orders.refund.request',
        context,
        audit,
        {
            sourceKind: input.sourceKind,
            sourceId: input.sourceId,
            amount: input.amount,
            reasonKind: input.reasonKind,
            reason: input.reason,
            itemDefective: input.itemDefective,
            overridePolicy: input.overridePolicy,
            destinationTyped: input.destination !== null,
            destinationProofFileId: input.destinationProofFileId,
            ticketId: input.ticketId,
            requestedByRole: input.requestedByRole,
        },
        {
            method: 'POST',
            path: '/refunds',
            // Optional keys are OMITTED rather than sent null: the contract declares them
            // optional, and an explicit null against an `.optional()` schema is a 400 there.
            body: {
                sourceKind: input.sourceKind,
                sourceId: input.sourceId,
                ...(input.amount !== null && { amount: input.amount }),
                reasonKind: input.reasonKind,
                reason: input.reason,
                ...(input.itemDefective !== null && { itemDefective: input.itemDefective }),
                ...(input.overridePolicy !== null && { overridePolicy: input.overridePolicy }),
                ...(input.destination !== null && {
                    destination: {
                        phone: input.destination.phone,
                        ...(input.destination.name !== undefined && { name: input.destination.name }),
                    },
                }),
                ...(input.destinationProofFileId !== null && { destinationProofFileId: input.destinationProofFileId }),
                ...(input.ticketId !== null && { ticketId: input.ticketId }),
                requestedByRole: input.requestedByRole,
                approveNow: false,
            },
        },
    );
}

/** Approve — the act that lets money leave. Performed by the approver on a four-eyes path. */
export async function approveRefundRequest(
    refundId: string,
    audit: RefundAuditContext & { amount: number; currency: string },
    context: ActorContext,
    viaApprovalId: string | null = null,
): Promise<PlatformRefundRequest> {
    return auditedRefundWrite(
        'orders.refund.approve',
        context,
        audit,
        { refundId, amount: audit.amount, currency: audit.currency },
        { method: 'POST', path: `/refunds/${refundId}/approve`, body: {} },
        viaApprovalId,
    );
}

/** Reject — only from `awaiting_approval` or `failed`; the refund hold on earnings lifts. */
export async function rejectRefundRequest(
    refundId: string,
    reason: string,
    audit: RefundAuditContext,
    context: ActorContext,
): Promise<PlatformRefundRequest> {
    return auditedRefundWrite(
        'orders.refund.reject',
        context,
        audit,
        { refundId, reason },
        { method: 'POST', path: `/refunds/${refundId}/reject`, body: { reason } },
    );
}

/** Retry a `failed` transfer — jovi-mall claims again and REUSES the transfer reference. */
export async function retryRefundRequest(
    refundId: string,
    audit: RefundAuditContext,
    context: ActorContext,
): Promise<PlatformRefundRequest> {
    return auditedRefundWrite(
        'orders.refund.retry',
        context,
        audit,
        { refundId },
        { method: 'POST', path: `/refunds/${refundId}/retry`, body: {} },
    );
}

/**
 * Record a payment made OUTSIDE the platform, with its picture proof (R-7b). Completes it.
 * A `proofFileId` that is not a live `refund-proofs` file is jovi-mall's
 * `422 REFUND_EXTERNAL_PROOF_REQUIRED` (`details.reason: 'proof_not_found'`).
 */
export async function settleRefundExternally(
    refundId: string,
    input: { method: string; reference: string | null; proofFileId: string },
    audit: RefundAuditContext,
    context: ActorContext,
): Promise<PlatformRefundRequest> {
    return auditedRefundWrite(
        'orders.refund.settle_external',
        context,
        audit,
        { refundId, method: input.method, reference: input.reference, proofFileId: input.proofFileId },
        {
            method: 'POST',
            path: `/refunds/${refundId}/settle-external`,
            body: {
                method: input.method,
                ...(input.reference !== null && { reference: input.reference }),
                proofFileId: input.proofFileId,
            },
        },
    );
}

/** Decide a transfer stuck in `sending` (ADR-024's resolve-unknown verb, for refunds). */
export async function resolveUnknownRefund(
    refundId: string,
    input: { outcome: 'arrived' | 'failed'; note: string },
    audit: RefundAuditContext,
    context: ActorContext,
): Promise<PlatformRefundRequest> {
    return auditedRefundWrite(
        'orders.refund.resolve_unknown',
        context,
        audit,
        { refundId, outcome: input.outcome, note: input.note },
        {
            method: 'POST',
            path: `/refunds/${refundId}/resolve-unknown`,
            body: { outcome: input.outcome, note: input.note },
        },
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Proof pictures — the PRIVATE `refund-proofs` tree, never `/files/upload`
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ── ⚠ NOT `/files/upload` ─────────────────────────────────────────────────────
 * That route writes `by-type`, whose six trees are all PUBLIC. A proof picture is a customer's
 * phone number and a personal conversation (plan § 7), so it goes to jovi-mall's dedicated
 * route, which writes the private `refund-proofs` tree — the staff-identity precedent
 * (`employees/gateways/employee-document.gateway.ts`, ADR-023 D-4). The two routes differ in one
 * path and that path is the whole privacy mechanism.
 *
 * ── ⛔ No byte touches this service's disk ─────────────────────────────────────
 * The body is the inbound `req`, unread (`express.json` is content-type gated, so a multipart
 * request reaches the handler still flowing) and piped straight at jovi-mall by `platformUpload`,
 * which counts bytes and destroys the stream past `ADMIN_UPLOAD_MAX_BYTES`. No multer, no temp
 * file, no buffer — `test-refunds.ts` scans this module for all three.
 */
export interface UploadedRefundProof {
    fileId: string;
}

export interface RefundProofUploadInput {
    body: NodeJS.ReadableStream;
    contentType: string;
    contentLength: number | null;
}

/**
 * Audited FAIL-CLOSED: the intent commits before a byte is streamed. Filed against the FILE,
 * whose id only exists once jovi-mall answers (an `attempted` row with a null target after a
 * crash means a file MAY exist). The payload names the byte count and never the content.
 */
export async function uploadRefundProof(
    input: RefundProofUploadInput,
    context: ActorContext,
): Promise<UploadedRefundProof> {
    const maxBytes = env().ADMIN_UPLOAD_MAX_BYTES;

    return auditedAttempt(
        {
            action: 'orders.refund.proof.upload',
            actor: auditActorOf(context.actor),
            target: { type: 'file', id: null, label: 'refund proof' },
            context,
            payload: { declaredBytes: input.contentLength, contentType: input.contentType, maxBytes },
        },
        async () => {
            const result = await platformUpload<UploadedRefundProof>({
                path: '/refunds/proofs',
                body: input.body,
                contentType: input.contentType,
                contentLength: input.contentLength,
                maxBytes,
                actor: context.actor,
                requestId: context.requestId,
            });
            const fileId = result.data?.fileId ? String(result.data.fileId) : null;
            return {
                result: { fileId: fileId ?? '' },
                target: fileId ? { id: fileId } : undefined,
                after: { fileId },
            };
        },
    );
}

export interface RefundProofContent {
    stream: NodeJS.ReadableStream;
    contentType: string;
    contentLength: number | null;
    contentDisposition: string | null;
}

/**
 * Open a proof picture — a DISCLOSURE, audited fail-closed exactly like `files.content.read`:
 * the intent row commits before jovi-mall is asked and its failure is not caught, so with the
 * audit store down nothing is shown. `after` is stamped from the response headers (type, size),
 * never the content.
 */
export async function openRefundProof(
    fileId: string,
    audit: { refundId: string; label: string | null },
    context: ActorContext,
): Promise<RefundProofContent> {
    return auditedAttempt(
        {
            action: 'orders.refund.proof.read',
            actor: auditActorOf(context.actor),
            target: { type: 'file', id: fileId, label: audit.label },
            relatedTarget: { type: 'refund', id: audit.refundId },
            context,
            payload: { fileId, refundId: audit.refundId },
        },
        async () => {
            const result = await platformStream({
                method: 'GET',
                path: `/refunds/proofs/${fileId}`,
                actor: context.actor,
                requestId: context.requestId,
            });
            return {
                result,
                after: { disclosed: true, mimeType: result.contentType, size: result.contentLength },
            };
        },
    );
}
