import { Request, Response } from 'express';
import { ObjectId } from 'mongodb';
import { actorContextOf } from '../../audit/domain/audit-context';
import { asyncHandler } from '../../../core/http/async-handler';
import { createAppError } from '../../../core/errors/app-error';
import { ERROR_CODES } from '../../../core/errors/error-codes';
import { toPageMeta } from '../../../core/http/list-query';
import { sendCreated, sendPaginated, sendSuccess } from '../../../core/http/responses';
import { AgencyReadRepository } from '../../agencies/repositories/agency.read.repository';
import { AgentCodProfile, AgentReadRepository } from '../../agents/repositories/agent.read.repository';
import * as cod from '../gateways/cod.gateway';
import {
    AgencyRemittanceReadModel,
    AgencyRemittanceReadRepository,
    AgentDepositReadModel,
    AgentDepositReadRepository,
    CodDiscrepancyReadModel,
    CodDiscrepancyReadRepository,
} from '../repositories/cod-record.read.repository';
import {
    CodCashAccountReadRepository,
    CodCashLedgerReadRepository,
    CodTrustEventReadRepository,
} from '../repositories/cod-cash.read.repository';
import {
    CodPartyNames,
    toDepositDetailDto,
    toDiscrepancyDetailDto,
    toDiscrepancyDto,
    toHolderDto,
    toRemittanceDetailDto,
    toTrustEventDto,
} from '../read-models/cod.dto';
import {
    ListDepositsQuery,
    ListDiscrepanciesQuery,
    ListHoldersQuery,
    ListRemittancesQuery,
    ListTrustEventsQuery,
    RecordDepositBody,
    RejectDepositBody,
    RejectRemittanceBody,
    TriageCodBody,
    ResolveDiscrepancyBody,
    TrustAdjustmentBody,
} from '../validators/cod.validator';

/**
 * `/api/v1/cod` — the cash-on-delivery surface.
 *
 * ── This module used to be a pure pass-through, and stopped being one at Phase 11 ──
 * Phase 4 delegated all five of its endpoints and said so plainly: "reads are delegated
 * too, not read from the shared database." The refinement ADR-009 D-1 made — **delegate a
 * verdict, read a record** — puts the line somewhere narrower, and this module is where
 * that shows most:
 *
 *   delegated   the OVERVIEW (three totals summed across every cash account, which the
 *               platform's own dashboard branches on), and every WRITE
 *   direct      the records — remittances, deposits, discrepancies, cash accounts, the
 *               cash ledger, trust events
 *
 * The writes stay delegated for the reason Phase 4 gave and it has not weakened: confirming
 * a remittance settles collections FIFO and unlocks the escrow they back; recording a
 * direct deposit settles both legs at once and emits `cod.deposit.recorded`, whose two
 * in-process subscribers write the agent's and the agency's notification rows.
 *
 * ── Every write reads its record first, and that is new here ─────────────────
 * Phase 4's audit rows carried no `before`, because nothing in this service could read the
 * record it was about to change. Now that they are direct reads, each write costs one
 * indexed lookup and buys three things the gateway cannot get from jovi-mall's answer: a
 * 404 that says "no such deposit" rather than a `PLATFORM_OPERATION_REJECTED` wrapping
 * one, the previous state for the audit diff, and a label that makes the row readable six
 * months later without a join into a database the audit store cannot reach.
 */

const remittances = new AgencyRemittanceReadRepository();
const deposits = new AgentDepositReadRepository();
const discrepancies = new CodDiscrepancyReadRepository();
const cashAccounts = new CodCashAccountReadRepository();
const cashLedger = new CodCashLedgerReadRepository();
const trustEvents = new CodTrustEventReadRepository();

// The party directories, owned by the modules that own those collections.
// `delivery_agents` holds `legal_identity` and `payout_details`, so a second projection of
// it declared here would be a second thing to get right.
const agents = new AgentReadRepository();
const agencies = new AgencyReadRepository();

/**
 * jovi-mall's page shape and this service's are the same fields in a different envelope,
 * so a DELEGATED list is re-wrapped rather than re-counted.
 */
function sendPlatformPage(res: Response, page: cod.PlatformPage<unknown>): void {
    sendPaginated(res, page.data, {
        total: page.meta.total,
        page: page.meta.page,
        limit: page.meta.limit,
        pages: page.meta.pages,
    });
}

function toIds(values: (string | null | undefined)[]): ObjectId[] {
    return [...new Set(values.filter((v): v is string => Boolean(v)))].map((id) => new ObjectId(id));
}

/**
 * Agent and agency names for a page of records — at most two batched reads, never one per
 * row.
 *
 * An agent's name is `delivery_agents.name`; an agency's is its Magazin's business name,
 * falling back to `display_name`. Both lookups live on Phase 9's own repositories.
 */
async function hydrateNames(
    rows: { agent_id?: ObjectId | null; agency_id?: ObjectId | null }[],
): Promise<CodPartyNames> {
    const agentIds = toIds(rows.map((r) => r.agent_id?.toString()));
    const agencyIds = toIds(rows.map((r) => r.agency_id?.toString()));

    const [agentNames, agencyNames] = await Promise.all([
        agents.findNamesByIds(agentIds),
        agencies.findNamesByIds(agencyIds),
    ]);

    return { agents: agentNames, agencies: agencyNames };
}

async function loadRemittanceOr404(remittanceId: string): Promise<AgencyRemittanceReadModel> {
    const row = await remittances.findById(remittanceId);
    if (!row) throw createAppError(ERROR_CODES.NOT_FOUND, 404, 'Remittance not found');
    return row;
}

async function loadDepositOr404(depositId: string): Promise<AgentDepositReadModel> {
    const row = await deposits.findById(depositId);
    if (!row) throw createAppError(ERROR_CODES.NOT_FOUND, 404, 'Deposit not found');
    return row;
}

async function loadDiscrepancyOr404(discrepancyId: string): Promise<CodDiscrepancyReadModel> {
    const row = await discrepancies.findById(discrepancyId);
    if (!row) throw createAppError(ERROR_CODES.NOT_FOUND, 404, 'Discrepancy not found');
    return row;
}

/**
 * The audit `before` for a cash record — in the camelCase the gateway's `after` mappers
 * emit, so the two halves of one row line up.
 */
function toCashRecordAuditState(
    row: AgencyRemittanceReadModel | AgentDepositReadModel,
): Record<string, unknown> {
    return {
        status: row.status,
        amount: row.amount,
        resolvedAt: row.resolved_at ? row.resolved_at.toISOString() : null,
        rejectionReason: row.rejection_reason ?? null,
    };
}

function toDiscrepancyAuditState(row: CodDiscrepancyReadModel): Record<string, unknown> {
    return {
        status: row.status,
        resolutionNote: row.resolution_note ?? null,
        resolvedAt: row.resolved_at ? row.resolved_at.toISOString() : null,
    };
}

/**
 * How an administrator recognises a cash record in a feed.
 *
 * The external money-movement reference where there is one — that is the string somebody
 * quotes against a bank statement — falling back to the amount, which is at least a
 * quantity a person remembers. Never the id: the row already carries it.
 */
function labelOfCashRecord(row: AgencyRemittanceReadModel | AgentDepositReadModel): string | null {
    if (row.reference) return row.reference;
    return row.currency ? `${row.currency} ${row.amount}` : String(row.amount);
}

export class CodController {
    /**
     * GET /api/v1/cod/overview — the platform-wide cash position.
     *
     * The one DELEGATED read on this surface. Three totals summed across every cash
     * account, cross-referenced against collected-but-unsettled cash — a derivation, and
     * one the platform itself acts on.
     */
    static overview = asyncHandler(async (req: Request, res: Response) => {
        sendSuccess(res, await cod.overview(actorContextOf(req)));
    });

    /**
     * GET /api/v1/cod/holders — who is currently holding platform cash.
     *
     * jovi-mall's `GET /cod/agents` and `GET /cod/agencies` were one question about two
     * owner types; `?ownerType=` is the discriminator that makes them one route. The two
     * layers are not interchangeable and the DTO says so: an agent owes their AGENCY, an
     * agency owes the PLATFORM, and only the agent has a trust score.
     *
     * What this deliberately does NOT carry, unlike the legacy pair: the party's email,
     * phone and account status. Those are agent- and agency-directory fields behind
     * `agents.read` / `agencies.read`, and a surface gated on `cod.holders.read` alone must
     * not be a side door onto them. The id links to the directory for the rest.
     */
    static listHolders = asyncHandler(async (req: Request, res: Response) => {
        const query = req.query as unknown as ListHoldersQuery;

        const page = await cashAccounts.search({
            ownerType: query.ownerType,
            ownerId: query.ownerId,
            includeSettled: query.includeSettled,
            page: query.page,
            limit: query.limit,
            sort: query.sort,
        });

        // `owner_id` is polymorphic — an agent id or an agency id, discriminated by
        // `owner_type` — so the two name lookups are split by that field rather than run
        // over the whole page.
        const agentIds = toIds(
            page.items.filter((a) => a.owner_type === 'agent').map((a) => a.owner_id.toString()),
        );
        const agencyIds = toIds(
            page.items.filter((a) => a.owner_type === 'agency').map((a) => a.owner_id.toString()),
        );

        const [agentContext, agencyNames] = await Promise.all([
            agents.findCodContextByIds(agentIds),
            agencies.findNamesByIds(agencyIds),
        ]);

        const names: CodPartyNames = { agents: new Map(), agencies: agencyNames };

        sendPaginated(
            res,
            page.items.map((account) => toHolderDto(account, names, agentContext)),
            toPageMeta(page.total, page.page, page.limit),
        );
    });

    // ── Remittances ──────────────────────────────────────────────────────────

    /**
     * GET /api/v1/cod/remittances — still DELEGATED, and that is a decision rather than an
     * oversight.
     *
     * Its detail below is a direct read. Leaving the list where Phase 4 put it keeps a
     * live endpoint's response shape byte-identical, and jovi-mall's own DTO for it is
     * already a named-field mapping rather than a raw document — so nothing is leaking and
     * there is nothing to fix. What that costs is one resource served through two
     * transports, and `cod.dto.ts` pays for it with a superset rule the suite asserts:
     * every field jovi-mall's list emits appears on the detail under the same name.
     */
    static listRemittances = asyncHandler(async (req: Request, res: Response) => {
        const query = req.query as unknown as ListRemittancesQuery;
        sendPlatformPage(res, await cod.listRemittances(query, actorContextOf(req)));
    });

    /**
     * GET /api/v1/cod/remittances/:remittanceId — net-new.
     *
     * The legacy surface had a list and no way to open one row. What the detail adds is the
     * part the row cannot state: the **cash movements** confirming it caused, each carrying
     * the balance the agency's liability BECAME. A remittance says an amount; the ledger
     * says what it did.
     */
    static getRemittance = asyncHandler(async (req: Request, res: Response) => {
        const row = await loadRemittanceOr404(req.params.remittanceId);

        const [names, movements] = await Promise.all([
            hydrateNames([row]),
            cashLedger.findForRef(req.params.remittanceId),
        ]);

        sendSuccess(res, toRemittanceDetailDto(row, names, movements));
    });

    /**
     * POST /api/v1/cod/remittances/:remittanceId/confirm
     *
     * Settles the agency's collections FIFO inside jovi-mall's transaction and unlocks the
     * earnings they back. A 200 here means the money moved there.
     */
    static confirmRemittance = asyncHandler(async (req: Request, res: Response) => {
        const before = await loadRemittanceOr404(req.params.remittanceId);

        const result = await cod.confirmRemittance(
            req.params.remittanceId,
            { label: labelOfCashRecord(before), before: toCashRecordAuditState(before) },
            actorContextOf(req),
        );

        sendSuccess(res, result, { message: 'Remittance confirmed' });
    });

    /**
     * POST /api/v1/cod/remittances/:remittanceId/triage — a reviewer vouches for it.
     *
     * Moves no cash and gates nothing. The weakest write on this surface, and the only one a
     * Support administrator can reach.
     */
    static triageRemittance = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as TriageCodBody;
        const before = await loadRemittanceOr404(req.params.remittanceId);

        const result = await cod.triageRemittance(
            req.params.remittanceId,
            body.note ?? null,
            { label: labelOfCashRecord(before), before: toCashRecordAuditState(before) },
            actorContextOf(req),
        );

        sendSuccess(res, result, {
            message: 'Remittance endorsed — confirmation is still required before the liability moves',
        });
    });

    /**
     * POST /api/v1/cod/deposits/:depositId/triage — a reviewer vouches for it.
     *
     * ⚠ Refused by jovi-mall on an AGENCY-recipient deposit, and deliberately: that handover
     * is already counter-signed by two organisations, and the platform has no way to verify
     * cash it never received. Only platform-recipient deposits are reviewable here.
     */
    static triageDeposit = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as TriageCodBody;
        const before = await loadDepositOr404(req.params.depositId);

        const result = await cod.triageDeposit(
            req.params.depositId,
            body.note ?? null,
            { label: labelOfCashRecord(before), before: toCashRecordAuditState(before) },
            actorContextOf(req),
        );

        sendSuccess(res, result, {
            message: 'Deposit endorsed — confirmation is still required before the cash chain settles',
        });
    });

    /** POST /api/v1/cod/remittances/:remittanceId/reject */
    static rejectRemittance = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as RejectRemittanceBody;
        const before = await loadRemittanceOr404(req.params.remittanceId);

        const result = await cod.rejectRemittance(
            req.params.remittanceId,
            body.reason,
            { label: labelOfCashRecord(before), before: toCashRecordAuditState(before) },
            actorContextOf(req),
        );

        sendSuccess(res, result, { message: 'Remittance declaration rejected' });
    });

    // ── Deposits ─────────────────────────────────────────────────────────────

    /** GET /api/v1/cod/deposits — delegated, for the reason the remittance list gives. */
    static listDeposits = asyncHandler(async (req: Request, res: Response) => {
        const query = req.query as unknown as ListDepositsQuery;
        sendPlatformPage(res, await cod.listDeposits(query, actorContextOf(req)));
    });

    /**
     * GET /api/v1/cod/deposits/:depositId — net-new.
     *
     * The cash movements here are the two-sided settlement made visible: a confirmed
     * `platform` deposit produces TWO ledger rows, one lowering the agent's liability and
     * one lowering the agency's, because the cash physically skipped the middle leg. An
     * `agency` deposit produces one. Nothing else on this surface shows that difference.
     */
    static getDeposit = asyncHandler(async (req: Request, res: Response) => {
        const row = await loadDepositOr404(req.params.depositId);

        const [names, movements] = await Promise.all([
            hydrateNames([row]),
            cashLedger.findForRef(req.params.depositId),
        ]);

        sendSuccess(res, toDepositDetailDto(row, names, movements));
    });

    /**
     * POST /api/v1/cod/deposits — record cash paid to the platform directly.
     *
     * 201: this is the one route on the mount that creates a record. The two party names
     * are resolved before delegating so the audit row reads without a join — and so a
     * mistyped agent id is a 404 from here rather than a wrapped platform error.
     */
    static recordDeposit = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as RecordDepositBody;

        const [agentNames, agencyNames] = await Promise.all([
            agents.findNamesByIds([new ObjectId(body.agentId)]),
            agencies.findNamesByIds([new ObjectId(body.agencyId)]),
        ]);

        if (agentNames.size === 0) {
            throw createAppError(ERROR_CODES.NOT_FOUND, 404, 'No agent with that id');
        }
        if (agencyNames.size === 0) {
            throw createAppError(ERROR_CODES.NOT_FOUND, 404, 'No delivery agency with that id');
        }

        const created = await cod.recordDeposit(
            body,
            {
                agentLabel: agentNames.get(body.agentId) ?? null,
                agencyLabel: agencyNames.get(body.agencyId) ?? null,
            },
            actorContextOf(req),
        );

        sendCreated(res, created, {
            message: 'Direct deposit recorded — the agent and the agency were both cleared',
        });
    });

    /**
     * POST /api/v1/cod/deposits/:depositId/confirm
     *
     * Clears the agent and the agency in one transaction, then emits
     * `cod.deposit.recorded` — whose subscribers write the notification rows that prove
     * delegation reaches jovi-mall's in-process handlers.
     */
    static confirmDeposit = asyncHandler(async (req: Request, res: Response) => {
        const before = await loadDepositOr404(req.params.depositId);

        const result = await cod.confirmDeposit(
            req.params.depositId,
            { label: labelOfCashRecord(before), before: toCashRecordAuditState(before) },
            actorContextOf(req),
        );

        sendSuccess(res, result, {
            message: 'Deposit confirmed — the agent and the agency were both cleared',
        });
    });

    /** POST /api/v1/cod/deposits/:depositId/reject — nothing settles. */
    static rejectDeposit = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as RejectDepositBody;
        const before = await loadDepositOr404(req.params.depositId);

        const result = await cod.rejectDeposit(
            req.params.depositId,
            body.reason,
            { label: labelOfCashRecord(before), before: toCashRecordAuditState(before) },
            actorContextOf(req),
        );

        sendSuccess(res, result, { message: 'Deposit declaration rejected — nothing was settled' });
    });

    // ── Discrepancies ────────────────────────────────────────────────────────

    /**
     * GET /api/v1/cod/discrepancies — a DIRECT read, unlike the two lists above.
     *
     * Ported rather than left delegated because this one gained filters and a date range
     * this service builds itself, and because the collection is a plain record store: a
     * flag row protects no invariant that a second reader could disturb.
     */
    static listDiscrepancies = asyncHandler(async (req: Request, res: Response) => {
        const query = req.query as unknown as ListDiscrepanciesQuery;

        const page = await discrepancies.search({
            status: query.status,
            type: query.type,
            agencyId: query.agencyId,
            agentId: query.agentId,
            from: query.from,
            to: query.to,
            page: query.page,
            limit: query.limit,
            sort: query.sort,
        });

        const names = await hydrateNames(page.items);

        sendPaginated(
            res,
            page.items.map((row) => toDiscrepancyDto(row, names)),
            toPageMeta(page.total, page.page, page.limit),
        );
    });

    /**
     * GET /api/v1/cod/discrepancies/:discrepancyId — net-new.
     *
     * Two things the row cannot say. The **deposit** it is about, resolved, because a
     * `deposit_not_confirmed` flag is meaningless without the declaration it names. And the
     * **trust events** it caused — often none, which is the system working rather than a
     * gap: `deposit_not_confirmed` is the agency's failure and carries no agent penalty.
     */
    static getDiscrepancy = asyncHandler(async (req: Request, res: Response) => {
        const row = await loadDiscrepancyOr404(req.params.discrepancyId);

        const [deposit, events] = await Promise.all([
            row.deposit_id ? deposits.findById(row.deposit_id.toString()) : Promise.resolve(null),
            trustEvents.findForDiscrepancy(req.params.discrepancyId),
        ]);

        // The joined deposit can name a different agent from the flag itself, so both rows
        // feed the name lookup rather than only the discrepancy.
        const names = await hydrateNames(deposit ? [row, deposit] : [row]);

        sendSuccess(res, toDiscrepancyDetailDto(row, names, { deposit, trustEvents: events }));
    });

    /**
     * POST /api/v1/cod/discrepancies/:discrepancyId/resolve
     *
     * Closing one unblocks the agency's rolling-reserve releases, and closing an open
     * `cash_shortfall` unblocks new COD assignments to that agent. Both effects live in
     * jovi-mall, which is why this is delegated rather than a status write.
     */
    static resolveDiscrepancy = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as ResolveDiscrepancyBody;
        const before = await loadDiscrepancyOr404(req.params.discrepancyId);

        const result = await cod.resolveDiscrepancy(
            req.params.discrepancyId,
            body,
            { label: before.type, before: toDiscrepancyAuditState(before) },
            actorContextOf(req),
        );

        sendSuccess(res, result, { message: `Discrepancy ${body.resolution}` });
    });

    // ── Trust ────────────────────────────────────────────────────────────────

    /**
     * GET /api/v1/cod/agents/:agentId/trust-events — net-new: why an agent's ceiling moved.
     *
     * `cod_trust_events` had no admin surface at all. The score is denormalised onto the
     * agent and visible on their profile; this is the history behind it, and the only place
     * a penalty can be traced back to the discrepancy that caused it.
     *
     * Requires `agents.read` as well as `cod.holders.read` — the rows are about one named
     * agent's conduct, and a surface gated on the COD permission alone would be a second
     * door onto the agent record.
     */
    static listTrustEvents = asyncHandler(async (req: Request, res: Response) => {
        const query = req.query as unknown as ListTrustEventsQuery;

        // 404 first: a trust history for an agent who does not exist should say so, not
        // answer an empty page that reads as "nothing ever happened".
        await loadAgentOr404(req.params.agentId);

        const page = await trustEvents.listForAgent(req.params.agentId, {
            eventType: query.eventType,
            from: query.from,
            to: query.to,
            page: query.page,
            limit: query.limit,
            sort: query.sort,
        });

        sendPaginated(
            res,
            page.items.map(toTrustEventDto),
            toPageMeta(page.total, page.page, page.limit),
        );
    });

    /**
     * POST /api/v1/cod/agents/:agentId/trust-adjustment — move the score by hand.
     *
     * The audit row targets the AGENT, so it lands on `GET /agents/:id/activity` — where
     * somebody asking why this person's COD ceiling changed will actually look. The
     * `before` carries the score as it stood, which is the only record of it: jovi-mall
     * appends the new value to `cod_trust_events` and overwrites the denormalised one.
     */
    static adjustTrust = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as TrustAdjustmentBody;
        const before = await loadAgentOr404(req.params.agentId);

        const result = await cod.adjustTrust(
            req.params.agentId,
            body,
            {
                label: before.name,
                before: { trustScore: before.trustScore, maxThreshold: before.maxThreshold },
            },
            actorContextOf(req),
        );

        sendSuccess(res, result, { message: 'Trust score adjusted' });
    });
}

/**
 * Load the agent's COD context or 404.
 *
 * Uses the narrow COD projection rather than the full agent read: this surface needs the
 * name and the two trust numbers, and nothing else off a collection that holds government
 * identity documents.
 */
async function loadAgentOr404(agentId: string): Promise<AgentCodProfile> {
    const context = await agents.findCodContextByIds([new ObjectId(agentId)]);
    const profile = context.get(agentId);
    if (!profile) throw createAppError(ERROR_CODES.NOT_FOUND, 404, 'Delivery agent not found');
    return profile;
}
