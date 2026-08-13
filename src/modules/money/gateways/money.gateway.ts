import { platformRequest } from '../../../infra/platform/platform.client';
import { auditedAttempt } from '../../audit/domain/audit.writer';
import { ActorContext } from '../../audit/domain/audit-context';
import { AuditAction } from '../../audit/domain/audit.catalog';
import { AuditTarget } from '../../audit/domain/audit.types';

/**
 * The money domain's DELEGATED half: the two BALANCE reads, and both writes.
 *
 * ── The split this module makes, in one line ──────────────────────────────────
 * **The ledger is read; the balance is asked for.** An `earnings_ledgers` row is
 * append-only and says what MOVED; a balance says what IS, and it is `getBalances`
 * reconciling four sub-balances that only jovi-mall's transactions move. Reproducing that
 * arithmetic here would be a second opinion about how much money exists. ADR-009 D-1,
 * applied to the sharpest case the platform has.
 *
 * Same for `GET /earnings/accounts` (D-7): it is tempting to page `earnings_accounts`
 * directly — it is one collection and the fields are right there — and it would show
 * balances without the reconciliation `getBalances` performs.
 *
 * ── Why both WRITES are delegated ─────────────────────────────────────────────
 * `mark-paid` debits `requested_balance` inside one jovi-mall transaction, stamps the
 * payout, resolves the linked support ticket and emits `payout.paid`. `reject` returns the
 * money to `available_balance` in the same shape and emits `payout.rejected`. A second
 * writer could reproduce the balance moves; it could not reproduce the in-process
 * subscribers, and the failure would be silent — which is the argument ADR-004 D-2 makes
 * and the one the COD gateway's header makes at more length.
 *
 * The thin methods below are the whole point: this file should never grow logic.
 */

/** What the payout looked like before the write, captured from the caller's own read. */
export type PayoutSnapshot = Record<string, unknown> | null;

/**
 * Wrap a delegated money mutation in an audit intent.
 *
 * In the gateway rather than the controller, matching every other gateway here: this is the
 * transport boundary, every delegated write leaves through `platformRequest` a few lines
 * below, and wrapping at this layer means a method added later inherits auditing by
 * construction rather than by its author remembering.
 *
 * Intent → outcome rather than a transaction, because the write lands in jovi-mall's
 * database inside jovi-mall's transaction, which a `wi-admin` ClientSession cannot join. The
 * intent row commits FIRST — if that fails the HTTP call is never made — and the outcome is
 * stamped when jovi-mall answers. A crash in between leaves a row at `attempted`, resolved
 * by grepping jovi-mall for the same `correlation_id`.
 *
 * ── `viaApprovalId`, which the billing and COD gateways have no need of ───────
 * This is the first gateway whose write can be performed by somebody other than the person
 * who asked for it. When a mark-paid crosses the dual-control threshold, the APPROVER's
 * request performs it, so the audit row's actor is the approver and `via_approval_id` is
 * what ties it back to the request — the pair reads as "X asked, Y did it". Threaded
 * through rather than looked up, because only the caller knows whether it came from an
 * approval.
 */
function auditedDelegation<T>(
    action: AuditAction,
    context: ActorContext,
    target: AuditTarget,
    payload: Record<string, unknown> | null,
    before: PayoutSnapshot,
    asState: (result: T) => Record<string, unknown> | null,
    perform: () => Promise<{ result: T; target?: Partial<AuditTarget> }>,
    viaApprovalId: string | null = null,
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
            target,
            context: {
                method: context.method,
                path: context.path,
                requestId: context.requestId,
                ip: context.ip,
                userAgent: context.userAgent,
            },
            payload,
            viaApprovalId,
        },
        async () => {
            const outcome = await perform();
            return {
                result: outcome.result,
                target: outcome.target,
                before,
                after: asState(outcome.result),
            };
        },
    );
}

/**
 * Reduce jovi-mall's answer to the fields worth diffing — **in the controller's spelling**.
 *
 * `before` is read out of `jovi_mall` by this service and `after` comes back over HTTP, so
 * the two halves have to be mapped onto one vocabulary or a row renders as every field
 * having changed. Both writes here return the same document, so one function is enough —
 * unlike the billing and COD gateways, which needed one per shape.
 *
 * The destination is deliberately NOT in the diff. It cannot change (the snapshot is frozen
 * at request time, which is the whole point of snapshotting it), and putting it here would
 * put a beneficiary's account details in the audit store — the one place they would then be
 * readable without the permission that gates them.
 */
function payoutState(result: PlatformPayoutRequest | null): Record<string, unknown> | null {
    if (!result || typeof result !== 'object') return null;
    return {
        status: result.status ?? null,
        amount: result.amount ?? null,
        currency: result.currency ?? null,
        resolvedAt: result.resolvedAt ?? null,
        paidReference: result.paidReference ?? null,
        rejectionReason: result.rejectionReason ?? null,
    };
}

/**
 * jovi-mall's `AdminPayoutRequestDto`, as much of it as this gateway names.
 *
 * Note what it does NOT name: `destination`. jovi-mall masks it to the last four before
 * answering (`admin-payout-request.dto.ts`), so nothing sensitive arrives — and nothing
 * here reads it either way, because this service's own destination handling goes through
 * the projection in `payout-request.read.repository.ts`.
 */
export interface PlatformPayoutRequest {
    id?: string;
    ownerType?: string;
    ownerId?: string;
    amount?: number;
    currency?: string;
    status?: string;
    resolvedAt?: string | null;
    paidReference?: string | null;
    rejectionReason?: string | null;
    [key: string]: unknown;
}

/**
 * jovi-mall paginates as `{ success, data: [...], meta: { total, page, limit, pages } }` —
 * `meta` is a SIBLING of `data`. `platformRequest` splits the envelope into `{ data, meta }`,
 * so a page is reassembled from both halves rather than read off one.
 */
export interface PlatformPage<T> {
    data: T[];
    meta: { total: number; page: number; limit: number; pages: number };
}

const EMPTY_META = { total: 0, page: 1, limit: 0, pages: 0 };

function toPage<T>(result: { data: unknown; meta?: unknown }): PlatformPage<T> {
    return {
        data: (result.data as T[]) ?? [],
        meta: (result.meta as PlatformPage<T>['meta']) ?? EMPTY_META,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// The two delegated READS — both of them balances
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The platform's own commission account: `{ pending, available, reserve, requested,
 * currency }`.
 *
 * The singleton, and the only earnings account that is not somebody's. `owner_id` is null
 * on its rows, which is why the ledger endpoint beside this one passes `null` explicitly
 * rather than omitting the term.
 *
 * Not audited: a read leaves no state to reconstruct, so the permission gate is the whole
 * control. (The one audited read in this service is the payout-destination disclosure,
 * whose output is the material a fraudulent payout instruction is built from. A balance is
 * not that.)
 */
export async function platformEarnings(context: ActorContext): Promise<unknown> {
    const result = await platformRequest<unknown>({
        method: 'GET',
        path: '/earnings/platform',
        actor: context.actor,
        requestId: context.requestId,
    });
    return result.data;
}

/**
 * Every owner's balances, ranked by what is withdrawable (D-7).
 *
 * Delegated rather than a page of `earnings_accounts`, and the distinction is not
 * pedantic: `EarningsAccountRepository.listForAdmin` — added at step 1, because the
 * repository could find ONE account or every account over the auto-payout threshold and
 * nothing in between — returns the balances jovi-mall reconciles, and excludes the platform
 * singleton, which belongs at `/money/earnings/platform` rather than in a list of parties
 * the platform owes.
 */
export async function earningsAccounts(
    query: { ownerType?: string; page: number; limit: number },
    context: ActorContext,
): Promise<PlatformPage<unknown>> {
    return toPage(await platformRequest<unknown[]>({
        method: 'GET',
        path: '/earnings/accounts',
        query: { ownerType: query.ownerType, page: query.page, limit: query.limit },
        actor: context.actor,
        requestId: context.requestId,
    }));
}

// ─────────────────────────────────────────────────────────────────────────────
// The two WRITES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How an administrator recognises a payout in a feed.
 *
 * The amount and currency, plus who it was for. Not the destination — see `payoutState` —
 * and not the id, which the row already carries. Built by the caller from its own read, so
 * the label and the `before` diff cannot describe two different payouts.
 */
export interface PayoutAuditContext {
    label: string | null;
    before: PayoutSnapshot;
    /** Carried into the payload so the row reads without a join into the other database. */
    ownerType: string;
    ownerId: string;
    amount: number;
    currency: string;
}

/**
 * Mark a payout paid — record that money has left the platform.
 *
 * The heaviest write on this surface, and the only dual-controlled one in the service
 * outside the administrator directory. jovi-mall debits `requested_balance`, stamps
 * `resolved_by` + `resolved_by_source: 'admin'` + a name snapshot (which exists because of
 * step 0's F-B — before it, an administrator's id landed in a column that resolves in no
 * collection with nothing saying so), resolves the linked ticket and emits `payout.paid`.
 *
 * The payload carries the amount and the currency, and that is not decoration: it is what
 * the approver signed for on a queued request, and the handler re-checks the row against it
 * before performing the write.
 */
export async function markPayoutPaid(
    payoutId: string,
    reference: string | null,
    audit: PayoutAuditContext,
    context: ActorContext,
    viaApprovalId: string | null = null,
): Promise<PlatformPayoutRequest> {
    return auditedDelegation(
        'money.payouts.mark_paid',
        context,
        { type: 'payout', id: payoutId, label: audit.label },
        {
            ownerType: audit.ownerType,
            ownerId: audit.ownerId,
            amount: audit.amount,
            currency: audit.currency,
            reference,
        },
        audit.before,
        payoutState,
        async () => {
            const result = await platformRequest<PlatformPayoutRequest>({
                method: 'POST',
                path: `/payout-requests/${payoutId}/mark-paid`,
                // `reference` is omitted rather than sent as null: jovi-mall's `MarkPaidSchema`
                // declares it `.optional()`, not nullable, so an explicit null is a 400.
                body: reference === null ? {} : { reference },
                actor: context.actor,
                requestId: context.requestId,
            });
            return { result: result.data };
        },
        viaApprovalId,
    );
}

/**
 * Reject a payout request — the money returns to the owner's available balance.
 *
 * Not dual-controlled at any amount, and the asymmetry with `mark-paid` is deliberate
 * rather than an omission. Rejecting moves money back INTO the owner's withdrawable
 * balance: the mistake it can make is reversible by the owner simply requesting again, and
 * nothing leaves the platform. Marking paid asserts that money is gone, which nothing on
 * either side can undo. A quorum belongs on the irreversible direction only — the same
 * reasoning that leaves a DEMOTION out of `PROMOTE_TO_DEVELOPER`.
 */
export async function rejectPayout(
    payoutId: string,
    reason: string,
    audit: PayoutAuditContext,
    context: ActorContext,
): Promise<PlatformPayoutRequest> {
    return auditedDelegation(
        'money.payouts.reject',
        context,
        { type: 'payout', id: payoutId, label: audit.label },
        {
            ownerType: audit.ownerType,
            ownerId: audit.ownerId,
            amount: audit.amount,
            currency: audit.currency,
            reason,
        },
        audit.before,
        payoutState,
        async () => {
            const result = await platformRequest<PlatformPayoutRequest>({
                method: 'POST',
                path: `/payout-requests/${payoutId}/reject`,
                body: { reason },
                actor: context.actor,
                requestId: context.requestId,
            });
            return { result: result.data };
        },
    );
}
