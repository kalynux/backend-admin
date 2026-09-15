import { platformRequest } from '../../../infra/platform/platform.client';
import { auditedAttempt } from '../../audit/domain/audit.writer';
import { ActorContext } from '../../audit/domain/audit-context';
import { AuditAction } from '../../audit/domain/audit.catalog';

/**
 * The agency domain's WRITE half, reached over jovi-mall's internal admin API.
 *
 * ── Why an agency write is delegated when the read is not ─────────────────────
 * Not for symmetry. Deactivating an agency is not a column: it suspends every vendor
 * product that defaults to that agency, suspends every product whose own override points
 * at it, and puts every pending or assigned order item riding it on hold — all inside one
 * transaction, followed by post-commit vectorisation events. A second process could
 * reproduce the transaction and would still miss the events, silently. Reactivation is the
 * same cascade in reverse, and `verify` is a compare-and-set on a status jovi-mall's own
 * vendor-browse query filters on.
 *
 * That asymmetry — direct read, delegated write, in the SAME domain — is ADR-004 D-2 at
 * its clearest, which is why this file sits beside `agency.read.repository.ts`.
 *
 * The thin methods below are the whole point: this file should never grow logic.
 */

/** What the agency looked like before the write, captured from the caller's own read. */
export type AgencySnapshot = Record<string, unknown> | null;

/**
 * Wrap a delegated agency mutation in an audit intent.
 *
 * In the gateway rather than the controller, matching the COD and user gateways: this is
 * the transport boundary, every delegated write leaves through `platformRequest` a few
 * lines below, and wrapping here means a method added later inherits auditing by
 * construction rather than by its author remembering.
 *
 * Intent → outcome rather than a transaction, because the write lands in jovi-mall's
 * database inside jovi-mall's transaction, which a `wi-admin` ClientSession cannot join.
 * The intent row commits FIRST — if that fails the HTTP call is never made — and the
 * outcome is stamped when jovi-mall answers. A crash in between leaves a row at
 * `attempted`, resolved by grepping jovi-mall for the same `correlation_id`, which already
 * travels as `X-Request-Id` on every call.
 */
function auditedDelegation<T>(
    action: AuditAction,
    context: ActorContext,
    target: { id: string; label: string | null },
    payload: Record<string, unknown> | null,
    before: AgencySnapshot,
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
            target: { type: 'agency', id: target.id, label: target.label },
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
 * Not the whole response — an audit row storing every field of every write becomes
 * unreadable. These are the fields this surface can change, so a diff over them is
 * complete by construction.
 */
function asState(result: unknown): Record<string, unknown> | null {
    const agency = result as PlatformAgency | null;
    if (!agency || typeof agency !== 'object') return null;

    return {
        status: agency.status ?? null,
        verified: agency.legitVerified ?? null,
        businessName: agency.businessName ?? null,
    };
}

/** jovi-mall's `AdminAgencyListItemDto`, as much of it as this gateway names. */
export interface PlatformAgency {
    id: string;
    status: string;
    businessName?: string | null;
    legitVerified?: boolean;
    [key: string]: unknown;
}

/**
 * The counts a cascade moved. jovi-mall returns them in `meta`, not `data` — they describe
 * what the write DID rather than what the agency now is, and the audit row wants both.
 */
// A type alias rather than an interface, so it carries the implicit index signature that
// `sendSuccess`'s `meta` (a `Record<string, unknown>`) requires. An interface does not.
export type CascadeCounts = {
    products: number;
    orderItems: number;
};

interface CascadeResult {
    agency: PlatformAgency;
    counts: CascadeCounts;
}

/**
 * Approve the agency's business verification — record that a human has vetted it.
 *
 * ⚠ **It does NOT activate the agency, and this comment used to say it compared on
 * `status: 'pending_verification'`.** Since 2026-09-15 an agency promotes itself on a proved
 * phone, so `status` and the KYC verdict are two questions with two owners, and jovi-mall's
 * compare-and-set moved to the verdict axis.
 *
 * It is predicated on the verdict NOT already being `verified`, so it refuses a repeat and
 * admits everything else — a rejected agency is approvable, which is the re-review loop, and
 * two administrators on one screen still produce one winner and one `409`. jovi-mall answers
 * `DELIVERY_AGENCY_VERIFICATION_CONFLICT` (renamed from `DELIVERY_AGENCY_STATUS_CONFLICT` in
 * the same change, because the old name pointed at a field it no longer touches — BR-026 § 3).
 * That code reaches the dashboard unchanged in `details.platformCode`.
 */
export async function verify(
    agencyId: string,
    before: AgencySnapshot,
    context: ActorContext,
): Promise<PlatformAgency> {
    return auditedDelegation(
        'agencies.verify',
        context,
        { id: agencyId, label: labelOf(before) },
        null,
        before,
        async () => {
            const result = await platformRequest<PlatformAgency>({
                method: 'POST',
                path: `/agencies/${agencyId}/verify`,
                actor: context.actor,
                requestId: context.requestId,
            });
            return result.data;
        },
    );
}

/**
 * Refuse the agency's business verification.
 *
 * The same compare-and-set as `verify` above, mirrored onto this verdict: refused only when
 * the agency is already `rejected`, answering the same
 * `409 DELIVERY_AGENCY_VERIFICATION_CONFLICT` — one review, two possible verdicts, and the
 * loser of a race is told rather than allowed to overwrite.
 *
 * ⚠ **The reason is FORWARDED, not just audited** — the opposite of `deactivate` below.
 * jovi-mall stores it on `kyc_details.rejection_reason` because the agency is shown it,
 * and they cannot read this database. It is in the audit payload as well; the two serve
 * different readers.
 *
 * Note what jovi-mall does *not* do with this: it changes no status. ⚠ **This paragraph used
 * to add "the agency stays `pending_verification`, which is already refused by product
 * activation, pickup resolution, COD eligibility and vendor default-agency selection", and
 * since 2026-09-15 neither half holds** — a refused agency that proved its phone is `active`,
 * and three of those four gate on `active`. What a refusal costs is cash: COD eligibility
 * tests the KYC flag explicitly now, and an unverified owner's payouts can be capped.
 *
 * There is still no un-reject verb and none is needed — a fixed application goes back through
 * `verify`, whose predicate admits a rejected agency.
 */
export async function reject(
    agencyId: string,
    before: AgencySnapshot,
    context: ActorContext,
    reason: string,
): Promise<PlatformAgency> {
    return auditedDelegation(
        'agencies.reject',
        context,
        { id: agencyId, label: labelOf(before) },
        { reason },
        before,
        async () => {
            const result = await platformRequest<PlatformAgency>({
                method: 'POST',
                path: `/agencies/${agencyId}/reject`,
                body: { reason },
                actor: context.actor,
                requestId: context.requestId,
            });
            return result.data;
        },
    );
}

/**
 * Deactivate an agency, and everything riding on it.
 *
 * The `reason` is this service's addition — jovi-mall's endpoint takes none — and it is
 * carried in the AUDIT PAYLOAD rather than forwarded. Sending a field the receiving
 * endpoint does not read would look like it was recorded there; it is not, and the audit
 * row is the only place it lives.
 */
export async function deactivate(
    agencyId: string,
    reason: string,
    before: AgencySnapshot,
    context: ActorContext,
): Promise<CascadeResult> {
    return auditedDelegation(
        'agencies.deactivate',
        context,
        { id: agencyId, label: labelOf(before) },
        { reason },
        before,
        async () => {
            const result = await platformRequest<PlatformAgency>({
                method: 'PATCH',
                path: `/agencies/${agencyId}/deactivate`,
                actor: context.actor,
                requestId: context.requestId,
            });
            return { agency: result.data, counts: countsOf(result.meta) };
        },
    ) as Promise<CascadeResult>;
}

/** Reverse the cascade. Its own audit action — see the catalog for why. */
export async function reactivate(
    agencyId: string,
    reason: string | undefined,
    before: AgencySnapshot,
    context: ActorContext,
): Promise<CascadeResult> {
    return auditedDelegation(
        'agencies.reactivate',
        context,
        { id: agencyId, label: labelOf(before) },
        reason ? { reason } : null,
        before,
        async () => {
            const result = await platformRequest<PlatformAgency>({
                method: 'PATCH',
                path: `/agencies/${agencyId}/reactivate`,
                actor: context.actor,
                requestId: context.requestId,
            });
            return { agency: result.data, counts: countsOf(result.meta) };
        },
    ) as Promise<CascadeResult>;
}

/**
 * jovi-mall names these differently on each direction (`suspendedProductCount` /
 * `restoredProductCount`, `heldOrderItemCount` / `unheldOrderItemCount`) because its
 * message strings read from them. One shape here, because a caller comparing "what did
 * this action move" across the two directions should not have to know which verb it used.
 */
function countsOf(meta: unknown): CascadeCounts {
    const m = (meta ?? {}) as Record<string, unknown>;
    return {
        products: num(m.suspendedProductCount ?? m.restoredProductCount),
        orderItems: num(m.heldOrderItemCount ?? m.unheldOrderItemCount),
    };
}

function num(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * A human-readable snapshot for the audit row, so a feed reads without a join — and
 * without a join is the only way it can read, since the trail lives in a different
 * database from the agency.
 *
 * The BUSINESS name, not the contact's: that is what the agency is called on every other
 * screen, and it is what makes a row recognisable six months later.
 */
function labelOf(before: AgencySnapshot): string | null {
    if (!before) return null;
    const name = before.businessName;
    return typeof name === 'string' && name.length > 0 ? name : null;
}
