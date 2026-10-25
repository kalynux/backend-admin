import { platformRequest } from '../../../infra/platform/platform.client';
import { auditedAttempt } from '../../audit/domain/audit.writer';
import { ActorContext } from '../../audit/domain/audit-context';

/**
 * Damage claims on an agency (owner decision F-8, 2026-10-22) — DELEGATED to jovi-mall's
 * `/api/internal/admin/agency-claims`, reads and write alike.
 *
 * ── Why the reads are delegated too ─────────────────────────────────────────
 * The claim itself is a record (`agency_claims`), but what an administrator needs before
 * making one is a VERDICT: is the parcel inside the agency's own window, what is its per-item
 * limit, has it been claimed already. That is jovi-mall's liability rule
 * (`earnings/domain/courier-liability.ts`) read against the parcel's history and the
 * customer's problem reports. A second implementation here would be a second opinion on
 * whether an agency owes money. ADR-009 D-1: delegate a verdict, read a record — and the list
 * is served beside the verdict so the two cannot disagree about which claims exist.
 *
 * ── The charge ──────────────────────────────────────────────────────────────
 * Audited fail-closed, filed against the AGENCY (its activity feed is where "why was this
 * agency charged" is looked for): the intent row commits before jovi-mall is asked.
 */

export interface PlatformAgencyClaim {
    id: string;
    kind: 'damage';
    shipmentId: string;
    orderId: string;
    orderNumber: string | null;
    trackingNumber: string | null;
    agencyId: string;
    vendorId: string | null;
    refundRequestId: string | null;
    itemCount: number;
    claimedAmount: number;
    maxPerItem: number;
    cap: number;
    amount: number;
    investigationFee: number;
    currency: string;
    deliveredAt: string;
    raisedAt: string;
    windowDays: number;
    note: string;
    createdBy: { id: string | null; name: string | null };
    reasonCode: string;
    reasonParams: Record<string, unknown>;
    explanation: string;
    takenFrom: { pending: number; reserve: number; available: number; debt: number };
    createdAt: string;
}

export interface PlatformAgencyClaimEligibility {
    shipmentId: string;
    orderId: string;
    orderNumber: string | null;
    trackingNumber: string | null;
    agencyId: string | null;
    vendorId: string | null;
    currency: string;
    deliveredAt: string | null;
    firstProblemAt: string | null;
    raisedAt: string;
    windowDays: number;
    windowEndsAt: string | null;
    insideWindow: boolean;
    maxPerItem: number;
    investigationFee: number;
    existingClaimId: string | null;
    eligible: boolean;
    /** `not_delivered` · `no_agency` · `no_per_item_limit` · `outside_window` · `already_claimed`. */
    reason: string | null;
}

export interface PlatformPage<T> {
    data: T[];
    meta: { total: number; page: number; limit: number; pages: number };
}

export async function listAgencyClaims(
    query: { page: number; limit: number; agencyId?: string; vendorId?: string; shipmentId?: string },
    context: ActorContext,
): Promise<PlatformPage<PlatformAgencyClaim>> {
    const forwarded: Record<string, string> = { page: String(query.page), limit: String(query.limit) };
    if (query.agencyId) forwarded.agencyId = query.agencyId;
    if (query.vendorId) forwarded.vendorId = query.vendorId;
    if (query.shipmentId) forwarded.shipmentId = query.shipmentId;
    const result = await platformRequest<PlatformAgencyClaim[]>({
        method: 'GET',
        path: '/agency-claims',
        query: forwarded,
        actor: context.actor,
        requestId: context.requestId,
    });
    return {
        data: result.data ?? [],
        meta: (result.meta as PlatformPage<PlatformAgencyClaim>['meta']) ?? { total: 0, page: query.page, limit: query.limit, pages: 0 },
    };
}

export async function agencyClaim(claimId: string, context: ActorContext): Promise<PlatformAgencyClaim> {
    const result = await platformRequest<PlatformAgencyClaim>({
        method: 'GET',
        path: `/agency-claims/${claimId}`,
        actor: context.actor,
        requestId: context.requestId,
    });
    return result.data;
}

export async function agencyClaimEligibility(
    query: { shipmentId: string; refundRequestId?: string },
    context: ActorContext,
): Promise<PlatformAgencyClaimEligibility> {
    const result = await platformRequest<PlatformAgencyClaimEligibility>({
        method: 'GET',
        path: '/agency-claims/eligibility',
        query: { shipmentId: query.shipmentId, ...(query.refundRequestId ? { refundRequestId: query.refundRequestId } : {}) },
        actor: context.actor,
        requestId: context.requestId,
    });
    return result.data;
}

/**
 * Charge a damage claim. `eligibility` is the caller's own read just before — the row's `before`
 * and the agency it is filed against. jovi-mall refuses with `AGENCY_CLAIM_OUTSIDE_WINDOW`,
 * `AGENCY_CLAIM_EXCEEDS_CAP`, `AGENCY_CLAIM_EXISTS` or `AGENCY_CLAIM_NOT_ELIGIBLE` (in
 * `details.platformCode`), and the audit row is stamped `failed` with it.
 */
export async function chargeAgencyClaim(
    body: { shipmentId: string; itemCount: number; amount: number; note: string; refundRequestId?: string },
    eligibility: PlatformAgencyClaimEligibility,
    agencyLabel: string | null,
    context: ActorContext,
): Promise<PlatformAgencyClaim> {
    return auditedAttempt(
        {
            action: 'agencies.claims.charge',
            actor: {
                kind: 'administrator',
                id: context.actor.adminId,
                email: context.actor.email,
                displayName: context.actor.displayName,
                tier: context.actor.tier,
                sessionId: context.actor.sessionId,
            },
            target: { type: 'agency', id: eligibility.agencyId ?? body.shipmentId, label: agencyLabel },
            context: {
                method: context.method,
                path: context.path,
                requestId: context.requestId,
                ip: context.ip,
                userAgent: context.userAgent,
            },
            payload: {
                shipmentId: body.shipmentId,
                orderNumber: eligibility.orderNumber,
                itemCount: body.itemCount,
                amount: body.amount,
                note: body.note,
                refundRequestId: body.refundRequestId ?? null,
            },
        },
        async () => {
            const result = await platformRequest<PlatformAgencyClaim>({
                method: 'POST',
                path: '/agency-claims',
                body: {
                    shipmentId: body.shipmentId,
                    itemCount: body.itemCount,
                    amount: body.amount,
                    note: body.note,
                    ...(body.refundRequestId ? { refundRequestId: body.refundRequestId } : {}),
                },
                actor: context.actor,
                requestId: context.requestId,
            });
            const claim = result.data;
            return {
                result: claim,
                before: {
                    insideWindow: eligibility.insideWindow,
                    windowDays: eligibility.windowDays,
                    maxPerItem: eligibility.maxPerItem,
                    investigationFee: eligibility.investigationFee,
                },
                after: { claimId: claim.id, amount: claim.amount, investigationFee: claim.investigationFee, takenFrom: claim.takenFrom },
            };
        },
    );
}
