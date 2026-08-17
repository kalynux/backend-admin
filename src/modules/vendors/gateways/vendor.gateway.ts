import { platformRequest } from '../../../infra/platform/platform.client';
import { auditedAttempt } from '../../audit/domain/audit.writer';
import { ActorContext } from '../../audit/domain/audit-context';
import { AuditAction } from '../../audit/domain/audit.catalog';

/**
 * The vendor domain's WRITE half, reached over jovi-mall's internal admin API.
 *
 * ── Why a vendor write is delegated when the read is not ──────────────────────
 * The read is a query and protects nothing. The write is the opposite, and here the gap is
 * wider than it was for users. Suspending a vendor is not a column: it takes their entire
 * catalogue off sale inside the same transaction, and reinstating them re-runs the
 * activation gate on every listing so that one which went stale meanwhile stays down. A
 * second writer would move the status, miss the cascade, and leave a "suspended" vendor
 * still selling.
 *
 * That asymmetry — direct read, delegated write, in the SAME domain — is ADR-004 D-2, and
 * it is why this file sits beside `vendor.read.repository.ts`.
 *
 * The thin methods below are the whole point: this file should never grow logic.
 */

/**
 * What the vendor looked like before the write.
 *
 * Captured by the caller from its own direct read — the one it already performed to answer
 * 404 — and handed here so the audit row can record what actually changed rather than only
 * what was asked for.
 */
export type VendorSnapshot = Record<string, unknown> | null;

/**
 * Wrap a delegated vendor mutation in an audit intent.
 *
 * ── Why here rather than in the controller ────────────────────────────────────
 * The same reason the COD and user gateways do it: this is the transport boundary, every
 * delegated write leaves through `platformRequest` below, and wrapping at this layer means
 * a method added later inherits auditing by construction rather than by its author
 * remembering.
 *
 * ── Why intent → outcome rather than a transaction ────────────────────────────
 * The write lands in jovi-mall's database, inside jovi-mall's transaction, which a
 * `wi-admin` ClientSession cannot join. So the intent row is committed FIRST — if that
 * fails, the HTTP call is never made — and the outcome is stamped when jovi-mall answers.
 * A crash in between leaves a row at `attempted`, resolved by grepping jovi-mall for the
 * same `correlation_id`, which already travels as `X-Request-Id` on every call.
 */
function auditedDelegation<T>(
    action: AuditAction,
    context: ActorContext,
    target: { id: string; label: string | null },
    payload: Record<string, unknown> | null,
    before: VendorSnapshot,
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
            target: { type: 'vendor', id: target.id, label: target.label },
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
 * Not the whole response: an audit row storing every field of every write becomes
 * unreadable. These are the fields this surface can change — plus the two CASCADE COUNTS,
 * which are the part that cannot be reconstructed later. "This suspension took 47 listings
 * off sale, and reinstating it brought 44 back" is a fact only this row will ever hold,
 * because the three missing ones failed the activation gate and left no trace of having
 * been considered.
 */
function asState(result: unknown): Record<string, unknown> | null {
    const vendor = result as PlatformVendor | null;
    if (!vendor || typeof vendor !== 'object') return null;

    const state: Record<string, unknown> = {
        status: vendor.status ?? null,
        suspendedReason: vendor.suspension?.reason ?? null,
        kycStatus: vendor.verification?.status ?? null,
        kycRejectionReason: vendor.verification?.rejectionReason ?? null,
    };

    if (typeof vendor.suspendedProductCount === 'number') {
        state.suspendedProductCount = vendor.suspendedProductCount;
    }
    if (typeof vendor.restoredProductCount === 'number') {
        state.restoredProductCount = vendor.restoredProductCount;
    }

    return state;
}

/** jovi-mall's vendor DTO — `toAdminVendorDto` on the other side. */
export interface PlatformVendor {
    id: string;
    userId: string;
    displayName: string | null;
    email: string | null;
    phone: string | null;
    country: string | null;
    status: string;
    suspension: {
        at: string | null;
        reason: string | null;
        fromStatus: string | null;
        by: { id: string | null; source: string; name: string | null };
    } | null;
    verification: {
        status: string;
        verified: boolean;
        rejectionReason: string | null;
        verifiedAt: string | null;
        reviewedBy: { id: string | null; source: string; name: string | null } | null;
    };
    onboardingStep: number;
    createdAt: string;
    updatedAt: string;
    /** Present on the suspend response only. */
    suspendedProductIds?: string[];
    suspendedProductCount?: number;
    /** Present on the restore response only. */
    restoredProducts?: { productId: string; status: string }[];
    restoredProductCount?: number;
}

export interface PlatformVendorSettings {
    autoCancelUnpaidDays: number;
    autoRedirectOrdersToAgency: boolean;
    autoRedirectThresholdAmount: number | null;
}

/**
 * Suspend a vendor.
 *
 * jovi-mall refuses with `VENDOR_STATUS_CONFLICT` (409) when the vendor is already
 * suspended — a compare-and-set, because two administrators can hold one vendor's screen
 * open and the loser must be told the state moved rather than overwrite the winner's
 * reason. That code reaches the dashboard unchanged, in `details.platformCode`.
 */
export async function suspend(
    vendorId: string,
    reason: string,
    before: VendorSnapshot,
    context: ActorContext,
): Promise<PlatformVendor> {
    return auditedDelegation(
        'vendors.suspend',
        context,
        { id: vendorId, label: labelOf(before) },
        { reason },
        before,
        async () => {
            const result = await platformRequest<PlatformVendor>({
                method: 'POST',
                path: `/vendors/${vendorId}/suspend`,
                body: { reason },
                actor: context.actor,
                requestId: context.requestId,
            });
            return result.data;
        },
    );
}

/**
 * Lift a suspension.
 *
 * Its own audit action rather than a flag on `vendors.suspend`: reinstatement is the act
 * that CLEARS the reason and the actor stamp off the vendor row, so this row is the only
 * surviving record that the suspension happened at all — and the only record of how many
 * listings did not come back.
 */
export async function restore(
    vendorId: string,
    before: VendorSnapshot,
    context: ActorContext,
): Promise<PlatformVendor> {
    return auditedDelegation(
        'vendors.reinstate',
        context,
        { id: vendorId, label: labelOf(before) },
        null,
        before,
        async () => {
            const result = await platformRequest<PlatformVendor>({
                method: 'POST',
                path: `/vendors/${vendorId}/restore`,
                actor: context.actor,
                requestId: context.requestId,
            });
            return result.data;
        },
    );
}

/** Approve a vendor's business verification. */
export async function approveKyc(
    vendorId: string,
    note: string | undefined,
    before: VendorSnapshot,
    context: ActorContext,
): Promise<PlatformVendor> {
    return auditedDelegation(
        'vendors.kyc.approve',
        context,
        { id: vendorId, label: labelOf(before) },
        note ? { note } : null,
        before,
        async () => {
            const result = await platformRequest<PlatformVendor>({
                method: 'POST',
                path: `/vendors/${vendorId}/kyc/approve`,
                body: note ? { note } : {},
                actor: context.actor,
                requestId: context.requestId,
            });
            return result.data;
        },
    );
}

/**
 * Reject it.
 *
 * The reason is forwarded rather than kept here, because jovi-mall stores it on the vendor
 * row: this service's audit trail lives in a database jovi-mall cannot read, so a reason
 * held only here could never be shown to the vendor it is about.
 */
export async function rejectKyc(
    vendorId: string,
    reason: string,
    before: VendorSnapshot,
    context: ActorContext,
): Promise<PlatformVendor> {
    return auditedDelegation(
        'vendors.kyc.reject',
        context,
        { id: vendorId, label: labelOf(before) },
        { reason },
        before,
        async () => {
            const result = await platformRequest<PlatformVendor>({
                method: 'POST',
                path: `/vendors/${vendorId}/kyc/reject`,
                body: { reason },
                actor: context.actor,
                requestId: context.requestId,
            });
            return result.data;
        },
    );
}

/**
 * Take one listing off sale.
 *
 * The audit row targets the VENDOR, with the product in `payload` — see the note in
 * `audit.catalog.ts`. A `product` target type would split the vendor's activity feed and
 * hide exactly the row somebody opening that vendor is looking for.
 */
/**
 * One product, in full — the ONE delegated read on this gateway.
 *
 * ── Why it is not a direct query like every other vendor read ────────────────
 * Two things in the payload can only be built where they live. `media` needs
 * `storage.getPublicUrl(key)`, and which provider that is comes from `STORAGE_PROVIDER` —
 * this service has no storage layer and must not grow one (ADR-009 D-6), because a second
 * copy of that configuration in a second deployment is the drift the split exists to
 * prevent. `storage` needs `quoteStorageFee`, and a copy of that arithmetic here would be
 * a second opinion about what a vendor owes their agency.
 *
 * NOT audited. It is a read, and ADR-006 D-5 audits exactly one of those on this service —
 * the payout destination, where the disclosure IS the action. A product listing is not.
 *
 * The payload is passed through untyped on purpose: it is jovi-mall's own admin DTO, it is
 * documented in `vendors.md` against that source, and re-declaring twenty fields here would
 * be a second definition that drifts silently. What must NOT happen is a mapper appearing
 * in this file — the shape belongs to the service that computes it.
 */
export async function product(
    vendorId: string,
    productId: string,
    context: ActorContext,
): Promise<unknown> {
    const result = await platformRequest<unknown>({
        method: 'GET',
        path: `/vendors/${vendorId}/products/${productId}`,
        actor: context.actor,
        requestId: context.requestId,
    });
    return result.data;
}

export async function suspendProduct(
    vendorId: string,
    productId: string,
    note: string,
    before: VendorSnapshot,
    context: ActorContext,
): Promise<{ productId: string }> {
    return auditedDelegation(
        'vendors.products.suspend',
        context,
        { id: vendorId, label: labelOf(before) },
        { productId, note },
        before,
        async () => {
            const result = await platformRequest<{ productId: string }>({
                method: 'POST',
                path: `/vendors/${vendorId}/products/${productId}/suspend`,
                body: { note },
                actor: context.actor,
                requestId: context.requestId,
            });
            return result.data;
        },
    );
}

/** Put one back. Refused by jovi-mall unless platform oversight is what took it down. */
export async function restoreProduct(
    vendorId: string,
    productId: string,
    before: VendorSnapshot,
    context: ActorContext,
): Promise<{ productId: string; status: string }> {
    return auditedDelegation(
        'vendors.products.restore',
        context,
        { id: vendorId, label: labelOf(before) },
        { productId },
        before,
        async () => {
            const result = await platformRequest<{ productId: string; status: string }>({
                method: 'POST',
                path: `/vendors/${vendorId}/products/${productId}/restore`,
                actor: context.actor,
                requestId: context.requestId,
            });
            return result.data;
        },
    );
}

/** Change the platform-governed settings. */
export async function updateSettings(
    vendorId: string,
    input: Record<string, unknown>,
    before: VendorSnapshot,
    context: ActorContext,
): Promise<PlatformVendorSettings> {
    return auditedDelegation(
        'vendors.settings.update',
        context,
        { id: vendorId, label: labelOf(before) },
        { ...input },
        before,
        async () => {
            const result = await platformRequest<PlatformVendorSettings>({
                method: 'PATCH',
                path: `/vendors/${vendorId}/settings`,
                body: input,
                actor: context.actor,
                requestId: context.requestId,
            });
            return result.data;
        },
    );
}

/**
 * A human-readable snapshot for the audit row, so a feed reads without a join.
 *
 * The BUSINESS name first, because that is what an administrator recognises a vendor by
 * six months later — the display name is the person behind it, and the email is neither.
 */
function labelOf(before: VendorSnapshot): string | null {
    if (!before) return null;
    const businessName = typeof before.businessName === 'string' ? before.businessName : null;
    const displayName = typeof before.displayName === 'string' ? before.displayName : null;
    const email = typeof before.email === 'string' ? before.email : null;
    return businessName ?? displayName ?? email;
}
