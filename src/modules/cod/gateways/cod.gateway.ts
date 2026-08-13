import { platformRequest } from '../../../infra/platform/platform.client';
import { auditedAttempt } from '../../audit/domain/audit.writer';
import { ActorContext } from '../../audit/domain/audit-context';
import { AuditAction } from '../../audit/domain/audit.catalog';
import { AuditTarget } from '../../audit/domain/audit.types';

/**
 * The COD domain's DELEGATED half: every write, plus the one read whose answer is a
 * derivation rather than a record.
 *
 * ── Why a gateway and not a repository ────────────────────────────────────────
 * The name matters. A repository implies this service owns the data and decides how it is
 * shaped; a gateway says the opposite — jovi-mall owns the cash chain, and this is the
 * door. Nothing here interprets a result or enforces a rule, because every rule that
 * matters (FIFO settlement, the guarded compare-and-set on a cash balance, whether a
 * remittance may still be confirmed) lives on the other side and must stay there.
 *
 * ── Why every COD WRITE is delegated ──────────────────────────────────────────
 * Confirming a remittance is one transaction that lowers an agency's liability, settles
 * its collections FIFO, and unlocks the escrow those collections back — then emits an
 * event whose subscribers write agent and agency notifications. Recording a direct deposit
 * settles BOTH legs of the chain at once, because the cash physically skipped the middle
 * one. A second process could reproduce the transactions; it could not reproduce the
 * in-process subscribers, and the failure would be silent. See ADR-004 D-2.
 *
 * ── Why ONE read is here and the rest left at Phase 11 ────────────────────────
 * `GET /cod/overview` sums every cash account and cross-references unsettled collections.
 * That total is a **derivation** the platform's own dashboard branches on, and a copy of
 * the arithmetic here would be a second opinion about how much money exists. The records —
 * remittances, deposits, discrepancies, cash accounts, ledgers, trust events — moved to
 * direct reads in `../repositories/`, which is ADR-009 D-1 applied to this module.
 *
 * The thin methods below are the whole point: this file should never grow logic.
 */

/**
 * Wrap a delegated MUTATION in an audit intent.
 *
 * ── Why here rather than in the controller ────────────────────────────────────
 * This file's header says it should never grow logic, and this is not logic — it is the
 * transport boundary, which is exactly where the audit belongs. Every delegated write
 * leaves through `platformRequest` a few lines below, so wrapping at this layer means the
 * nine COD endpoints still to port at Phase 5 inherit auditing by construction rather than
 * by each author remembering. A wrapper one layer up would let a new gateway method ship
 * unaudited.
 *
 * ── Why intent → outcome rather than a transaction ────────────────────────────
 * The write lands in jovi-mall's database, inside jovi-mall's transaction, which a
 * `wi-admin` ClientSession cannot join. So the intent row is committed FIRST — if that
 * fails, the HTTP call is never made — and the outcome is stamped when jovi-mall answers.
 * A crash in between leaves a row at `attempted`, which is resolved by grepping jovi-mall
 * for the same `correlation_id`: the id already travels as `X-Request-Id` on every call.
 */
/**
 * ── Widened at Phase 11, in three ways ───────────────────────────────────────
 *  - the TARGET is a whole `AuditTarget`. Phase 4 could hardcode `remittance | deposit`;
 *    this module now writes against `discrepancy` and `agent` as well, and a create has to
 *    fill its id in AFTER the write because the row does not exist when the intent commits.
 *  - a `before` is carried. Phase 4 had none because nothing here could read the record it
 *    was about to change; the records are direct reads now, so every write can say what it
 *    changed FROM. A COD audit row without that says an administrator confirmed something
 *    and not what state it was in — which on a cash chain is most of the question.
 *  - the caller supplies the `after` mapping, because the four write shapes return three
 *    different documents.
 */
function auditedDelegation<T>(
    action: AuditAction,
    context: ActorContext,
    target: AuditTarget,
    payload: Record<string, unknown> | null,
    before: Record<string, unknown> | null,
    asState: (result: T) => Record<string, unknown> | null,
    perform: () => Promise<{ result: T; target?: Partial<AuditTarget> }>,
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
 * `before` is read out of `jovi_mall` by this service in camelCase and `after` comes back
 * over HTTP, so the two halves have to be mapped onto one vocabulary or a row renders as
 * every field having changed. Three functions rather than one that inspects the response,
 * for the reason `billing.gateway.ts` gives: guessing which document came back from the
 * keys present fails quietly the first time either schema gains a field.
 */
function cashRecordState(result: PlatformCodRecord | null): Record<string, unknown> | null {
    if (!result || typeof result !== 'object') return null;
    return {
        status: result.status ?? null,
        amount: result.amount ?? null,
        resolvedAt: result.resolvedAt ?? null,
        rejectionReason: result.rejectionReason ?? null,
    };
}

function discrepancyState(result: PlatformDiscrepancy | null): Record<string, unknown> | null {
    if (!result || typeof result !== 'object') return null;
    return {
        status: result.status ?? null,
        resolutionNote: result.resolution_note ?? result.resolutionNote ?? null,
        resolvedAt: result.resolved_at ?? result.resolvedAt ?? null,
    };
}

function trustState(result: PlatformTrustResult | null): Record<string, unknown> | null {
    if (!result || typeof result !== 'object') return null;
    return { trustScore: result.trustScore ?? null };
}

/** jovi-mall's remittance and deposit DTOs, as much of them as this gateway names. */
export interface PlatformCodRecord {
    id?: string;
    status?: string;
    amount?: number;
    resolvedAt?: string | null;
    rejectionReason?: string | null;
    [key: string]: unknown;
}

/**
 * The discrepancy write answers with the raw Mongoose document rather than a DTO —
 * `codDiscrepancyService.resolve` returns the model — so both spellings are read. That is
 * a note about jovi-mall's shape, not a preference: naming only one of them would make the
 * audit `after` silently null the day the other is used.
 */
export interface PlatformDiscrepancy {
    _id?: string;
    status?: string;
    resolution_note?: string | null;
    resolutionNote?: string | null;
    resolved_at?: string | null;
    resolvedAt?: string | null;
    [key: string]: unknown;
}

export interface PlatformTrustResult {
    agentId?: string;
    trustScore?: number;
    [key: string]: unknown;
}

export interface ListRemittancesQuery {
    status?: string;
    agencyId?: string;
    page: number;
    limit: number;
}

export interface ListDepositsQuery {
    status?: string;
    recipient?: string;
    agencyId?: string;
    page: number;
    limit: number;
}

/**
 * jovi-mall paginates as `{ success, data: [...], meta: { total, page, limit, pages } }` —
 * `meta` is a SIBLING of `data`, not nested inside it. `platformRequest` already splits the
 * envelope into `{ data, meta }`, so a page is reassembled from both halves rather than
 * read off one.
 *
 * Getting this wrong is invisible at compile time and empties the list at runtime, which is
 * why `verify-platform-live.ts` asserts the pagination fields explicitly.
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

export async function listRemittances(
    query: ListRemittancesQuery,
    context: ActorContext,
): Promise<PlatformPage<unknown>> {
    return toPage(await platformRequest<unknown[]>({
        method: 'GET',
        path: '/cod/remittances',
        query: { status: query.status, agencyId: query.agencyId, page: query.page, limit: query.limit },
        actor: context.actor,
        requestId: context.requestId,
    }));
}

/**
 * Confirm cash receipt.
 *
 * This is the operation the whole delegation design exists for: it settles collections
 * FIFO inside jovi-mall's transaction and unlocks the earnings those collections back.
 * The actor headers carry the administrator, which lands on the remittance as
 * `resolved_by_user_id` + `resolved_by_source: 'admin'` + a name snapshot.
 */
export async function confirmRemittance(
    remittanceId: string,
    audit: { label: string | null; before: Record<string, unknown> | null },
    context: ActorContext,
): Promise<PlatformCodRecord> {
    return auditedDelegation(
        'cod.remittances.confirm',
        context,
        { type: 'remittance', id: remittanceId, label: audit.label },
        null,
        audit.before,
        cashRecordState,
        async () => {
            const result = await platformRequest<PlatformCodRecord>({
                method: 'POST',
                path: `/cod/remittances/${remittanceId}/confirm`,
                actor: context.actor,
                requestId: context.requestId,
            });
            return { result: result.data };
        },
    );
}

export async function rejectRemittance(
    remittanceId: string,
    reason: string,
    audit: { label: string | null; before: Record<string, unknown> | null },
    context: ActorContext,
): Promise<PlatformCodRecord> {
    return auditedDelegation(
        'cod.remittances.reject',
        context,
        { type: 'remittance', id: remittanceId, label: audit.label },
        { reason },
        audit.before,
        cashRecordState,
        async () => {
            const result = await platformRequest<PlatformCodRecord>({
                method: 'POST',
                path: `/cod/remittances/${remittanceId}/reject`,
                body: { reason },
                actor: context.actor,
                requestId: context.requestId,
            });
            return { result: result.data };
        },
    );
}

export async function listDeposits(
    query: ListDepositsQuery,
    context: ActorContext,
): Promise<PlatformPage<unknown>> {
    return toPage(await platformRequest<unknown[]>({
        method: 'GET',
        path: '/cod/deposits',
        query: {
            status: query.status,
            recipient: query.recipient,
            agencyId: query.agencyId,
            page: query.page,
            limit: query.limit,
        },
        actor: context.actor,
        requestId: context.requestId,
    }));
}

/**
 * Confirm an agent's declared direct-to-platform hand-over.
 *
 * The other half of the exit gate: unlike remittance confirmation, this one emits
 * `cod.deposit.recorded`, which has two live subscribers writing agent and agency
 * notification rows. Those rows are the observable proof that delegation makes in-process
 * subscribers fire — which is the property no direct database write could have.
 */
export async function confirmDeposit(
    depositId: string,
    audit: { label: string | null; before: Record<string, unknown> | null },
    context: ActorContext,
): Promise<PlatformCodRecord> {
    return auditedDelegation(
        'cod.deposits.confirm',
        context,
        { type: 'deposit', id: depositId, label: audit.label },
        null,
        audit.before,
        cashRecordState,
        async () => {
            const result = await platformRequest<PlatformCodRecord>({
                method: 'POST',
                path: `/cod/deposits/${depositId}/confirm`,
                actor: context.actor,
                requestId: context.requestId,
            });
            return { result: result.data };
        },
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Ported at Phase 11
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The platform-wide cash position — the ONE read left on this gateway.
 *
 * `codSummaryService.adminOverview()` groups every `cod_cash_accounts` row by owner type
 * and cross-references collected-but-unsettled cash. Three totals, and the platform's own
 * dashboard branches on all three. That is a derivation in the sense ADR-009 D-1 means it,
 * and a copy of the arithmetic here would be a second opinion about how much money exists.
 *
 * Not audited: a read leaves no state to reconstruct, so the permission gate is the whole
 * control. (The one audited read in this service is the payout-destination disclosure,
 * whose output is the material a fraudulent payout instruction is built from. A cash
 * total is not that.)
 */
export async function overview(context: ActorContext): Promise<unknown> {
    const result = await platformRequest<unknown>({
        method: 'GET',
        path: '/cod/overview',
        actor: context.actor,
        requestId: context.requestId,
    });
    return result.data;
}

/**
 * Record cash an agent paid the PLATFORM directly, bypassing the agency.
 *
 * The heaviest write on this surface. It settles BOTH legs in one transaction — the
 * agent's liability and the contract balance fall, and so does the agency's, whose
 * collections are FIFO-settled exactly as a confirmed remittance would settle them —
 * because the cash physically skipped the middle leg. It is bounded by the agency's live
 * liability, and `AgentDepositService.assertDepositable` is what enforces that. None of it
 * is reproducible from here.
 *
 * The intent's target id is `null` and is filled in from the response: the deposit does not
 * exist when the row commits. The `label` carries the reference, so even a FAILED create
 * leaves a row naming the money it was about.
 */
export async function recordDeposit(
    input: { agentId: string; agencyId: string; amount: number; reference: string; note?: string },
    audit: { agentLabel: string | null; agencyLabel: string | null },
    context: ActorContext,
): Promise<PlatformCodRecord> {
    return auditedDelegation(
        'cod.deposits.create',
        context,
        { type: 'deposit', id: null, label: input.reference },
        // The whole validated body, plus the two party names. The row has to read six
        // months later without a join into a database this service's audit store cannot
        // reach — the amount and the reference are what a bank statement is reconciled
        // against, and the names are who the cash came from.
        { ...input, agent: audit.agentLabel, agency: audit.agencyLabel },
        null,
        cashRecordState,
        async () => {
            const result = await platformRequest<PlatformCodRecord>({
                method: 'POST',
                path: '/cod/deposits',
                body: input,
                actor: context.actor,
                requestId: context.requestId,
            });
            return {
                result: result.data,
                target: { id: result.data?.id ? String(result.data.id) : null },
            };
        },
    );
}

/** Reject an agent's declared direct-to-platform hand-over. Nothing settles. */
export async function rejectDeposit(
    depositId: string,
    reason: string,
    audit: { label: string | null; before: Record<string, unknown> | null },
    context: ActorContext,
): Promise<PlatformCodRecord> {
    return auditedDelegation(
        'cod.deposits.reject',
        context,
        { type: 'deposit', id: depositId, label: audit.label },
        { reason },
        audit.before,
        cashRecordState,
        async () => {
            const result = await platformRequest<PlatformCodRecord>({
                method: 'POST',
                path: `/cod/deposits/${depositId}/reject`,
                body: { reason },
                actor: context.actor,
                requestId: context.requestId,
            });
            return { result: result.data };
        },
    );
}

/**
 * Close a discrepancy: `resolved` (recovered or explained) or `written_off` (the platform
 * took the loss).
 *
 * Delegated for a reason that is not the transaction: an OPEN discrepancy blocks the
 * agency's rolling-reserve releases, and an open `cash_shortfall` blocks new COD
 * assignments to that agent. Closing one therefore unblocks money and dispatch on the
 * other side, through code that lives there.
 */
export async function resolveDiscrepancy(
    discrepancyId: string,
    input: { resolution: string; note: string },
    audit: { label: string | null; before: Record<string, unknown> | null },
    context: ActorContext,
): Promise<PlatformDiscrepancy> {
    return auditedDelegation(
        'cod.discrepancies.resolve',
        context,
        { type: 'discrepancy', id: discrepancyId, label: audit.label },
        { ...input },
        audit.before,
        discrepancyState,
        async () => {
            const result = await platformRequest<PlatformDiscrepancy>({
                method: 'POST',
                path: `/cod/discrepancies/${discrepancyId}/resolve`,
                body: input,
                actor: context.actor,
                requestId: context.requestId,
            });
            return { result: result.data };
        },
    );
}

/**
 * Move an agent's trust score by hand.
 *
 * Targets the **agent**, not a COD record, and that is deliberate: the score belongs to
 * the person and the row belongs on `GET /agents/:id/activity`, which is where somebody
 * asking "why did this agent's ceiling change" will look. Same reasoning as splitting the
 * plan assignment into three actions at step 3.
 *
 * jovi-mall computes and clamps the resulting score and appends the `cod_trust_events` row
 * inside the same write. This gateway sends a delta and a note; it does not know what the
 * score becomes until the answer comes back.
 */
export async function adjustTrust(
    agentId: string,
    input: { delta: number; note: string },
    audit: { label: string | null; before: Record<string, unknown> | null },
    context: ActorContext,
): Promise<PlatformTrustResult> {
    return auditedDelegation(
        'cod.trust.adjust',
        context,
        { type: 'agent', id: agentId, label: audit.label },
        { ...input },
        audit.before,
        trustState,
        async () => {
            const result = await platformRequest<PlatformTrustResult>({
                method: 'POST',
                path: `/cod/agents/${agentId}/trust-adjustment`,
                body: input,
                actor: context.actor,
                requestId: context.requestId,
            });
            return { result: result.data };
        },
    );
}
