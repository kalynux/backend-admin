import { Router } from 'express';
import { defineRoute, permission, records } from '../../../api/route-manifest';
import { CodController } from '../controllers/cod.controller';
import {
    AgentIdParamSchema,
    DepositIdParamSchema,
    DiscrepancyIdParamSchema,
    ListDepositsQuerySchema,
    ListDiscrepanciesQuerySchema,
    ListHoldersQuerySchema,
    ListRemittancesQuerySchema,
    ListTrustEventsQuerySchema,
    RecordDepositSchema,
    RejectDepositSchema,
    RejectRemittanceSchema,
    RemittanceIdParamSchema,
    ResolveDiscrepancySchema,
    TrustAdjustmentSchema,
} from '../validators/cod.validator';

/**
 * `/api/v1/cod` — platform oversight of the cash-on-delivery chain.
 *
 * Phase 4 ported FIVE of the thirteen legacy endpoints, chosen because between them they
 * prove both halves of the transport:
 *
 *   remittance confirm → FIFO settlement inside jovi-mall's transaction
 *   deposit confirm    → `cod.deposit.recorded`, whose two subscribers write notifications
 *
 * Phase 11 completes it: the remaining eight, plus four reads that never existed. Sixteen
 * routes now, and the eight legacy rows are gone from `legacy-endpoint-map.ts`.
 *
 * ── THIS MODULE IS MIXED-TRANSPORT, and its old header said otherwise ────────
 * Phase 4 asserted here that "reads are delegated too, not read from the shared database…
 * a second implementation would be a second opinion about how much money exists." That
 * was right about the overview and wrong as a general rule, and ADR-009 D-1 puts the line
 * where it actually falls — **delegate a verdict, read a record**:
 *
 *   delegated   `GET /overview`, which sums every cash account and cross-references
 *               unsettled collections. Three totals the platform itself branches on.
 *               Plus every WRITE, without exception.
 *   direct      the RECORDS — remittances, deposits, discrepancies, cash accounts, the
 *               cash ledger and trust events. A remittance row is append-only in spirit
 *               and `find({status: 'declared'})` cannot leave anything inconsistent.
 *
 * Two reads sit on the delegated side for a narrower reason and it is worth knowing:
 * `GET /remittances` and `GET /deposits` have been live since Phase 4, jovi-mall's own DTOs
 * for them are named-field mappings rather than raw documents, and converting them would
 * change the shape of two endpoints for no gain. Their DETAILS are direct reads, so one
 * resource is served through two transports — which `cod.dto.ts` pays for with a superset
 * rule the suite asserts against jovi-mall's source.
 *
 * ── Route order ──────────────────────────────────────────────────────────────
 * Every sub-route sits under a distinct second segment, and no literal is a sibling of a
 * `:param` at the same depth. Keep it that way: a literal `/deposits/export` would have to
 * be declared above `/deposits/:depositId`, or it is read as an id.
 */
const router = Router();
const mountedAt = '/cod';

/**
 * The one delegated READ. Its permission is its own, and PHASE-0:274 flagged why: the
 * legacy surface put this read and the deposit-creating write behind one identical guard.
 */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/overview',
    access: permission('cod.overview.read'),
    handler: CodController.overview,
});

/**
 * `GET /cod/agents` and `GET /cod/agencies` became ONE route, because they answered one
 * question about two owner types — the two layers of a single liability model, where an
 * agent owes their agency and the agency owes the platform.
 *
 * `cod.holders.read` alone, and the DTO is narrowed to earn that: it carries the cash
 * position, the party's name and (for an agent) the trust context, and NOT the email,
 * phone and account status the legacy pair returned. Those are directory fields behind
 * `agents.read` / `agencies.read`, and this must not be a second door onto them.
 */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/holders',
    access: permission('cod.holders.read'),
    validate: { query: ListHoldersQuerySchema },
    handler: CodController.listHolders,
});

// ── Remittances: the agency handing cash up to the platform ──────────────────

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/remittances',
    access: permission('cod.remittances.read'),
    validate: { query: ListRemittancesQuerySchema },
    handler: CodController.listRemittances,
});

/** Net-new. The legacy surface had a list and no way to open a row. */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/remittances/:remittanceId',
    access: permission('cod.remittances.read'),
    validate: { params: RemittanceIdParamSchema },
    handler: CodController.getRemittance,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/remittances/:remittanceId/confirm',
    access: permission('cod.remittances.confirm'),
    validate: { params: RemittanceIdParamSchema },
    audit: records('cod.remittances.confirm'),
    handler: CodController.confirmRemittance,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/remittances/:remittanceId/reject',
    access: permission('cod.remittances.reject'),
    validate: { params: RemittanceIdParamSchema, body: RejectRemittanceSchema },
    audit: records('cod.remittances.reject'),
    handler: CodController.rejectRemittance,
});

// ── Deposits: the agent handing cash back ────────────────────────────────────

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/deposits',
    access: permission('cod.deposits.read'),
    validate: { query: ListDepositsQuerySchema },
    handler: CodController.listDeposits,
});

/**
 * Record cash an agent paid the PLATFORM directly, bypassing the agency.
 *
 * Declared ABOVE `/deposits/:depositId` only for readability — they differ in method, so
 * Express would not confuse them. `cod.deposits.create` is flagged `financial`: this is
 * the one route here that asserts money arrived, and it settles both legs of the chain.
 */
defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/deposits',
    access: permission('cod.deposits.create'),
    validate: { body: RecordDepositSchema },
    audit: records('cod.deposits.create'),
    handler: CodController.recordDeposit,
});

/** Net-new. Its cash movements are the two-sided settlement made visible. */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/deposits/:depositId',
    access: permission('cod.deposits.read'),
    validate: { params: DepositIdParamSchema },
    handler: CodController.getDeposit,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/deposits/:depositId/confirm',
    access: permission('cod.deposits.confirm'),
    validate: { params: DepositIdParamSchema },
    audit: records('cod.deposits.confirm'),
    handler: CodController.confirmDeposit,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/deposits/:depositId/reject',
    access: permission('cod.deposits.reject'),
    validate: { params: DepositIdParamSchema, body: RejectDepositSchema },
    audit: records('cod.deposits.reject'),
    handler: CodController.rejectDeposit,
});

// ── Discrepancies: a flagged problem in the chain ────────────────────────────

/** A DIRECT read, unlike the two lists above — see the header. */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/discrepancies',
    access: permission('cod.discrepancies.read'),
    validate: { query: ListDiscrepanciesQuerySchema },
    handler: CodController.listDiscrepancies,
});

/** Net-new: the flag plus the deposit it names and the trust penalty it caused. */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/discrepancies/:discrepancyId',
    access: permission('cod.discrepancies.read'),
    validate: { params: DiscrepancyIdParamSchema },
    handler: CodController.getDiscrepancy,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/discrepancies/:discrepancyId/resolve',
    access: permission('cod.discrepancies.resolve'),
    validate: { params: DiscrepancyIdParamSchema, body: ResolveDiscrepancySchema },
    audit: records('cod.discrepancies.resolve'),
    handler: CodController.resolveDiscrepancy,
});

// ── Trust: why an agent's COD ceiling moved ──────────────────────────────────

/**
 * Needs BOTH permissions, in `all` mode.
 *
 * `cod.holders.read` because the subject is the cash chain, and `agents.read` because the
 * rows are a named agent's conduct record — every penalty they have taken and why.
 * Requiring only the first would make this a second door onto the agent's history that
 * bypasses the permission governing it. Both tiers that hold either hold both, so it costs
 * nobody access; it states the dependency so a future tier change cannot quietly open a
 * side door. Same shape as `/agencies/:agencyId/agents`.
 */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/agents/:agentId/trust-events',
    access: permission('cod.holders.read', 'agents.read'),
    validate: { params: AgentIdParamSchema, query: ListTrustEventsQuerySchema },
    handler: CodController.listTrustEvents,
});

/**
 * The write is `cod.trust.adjust` ALONE, and the asymmetry with the read above is
 * deliberate rather than an oversight.
 *
 * Reading the history exposes the agent's conduct record, which is agent data. Moving the
 * score does not read it — it sends a delta and a note, and jovi-mall computes what the
 * score becomes. A permission set is the answer to "what does this reach", not "how
 * serious is it": `cod.trust.adjust` is already `financial`, because the score bounds how
 * much cash the person may carry.
 */
defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/agents/:agentId/trust-adjustment',
    access: permission('cod.trust.adjust'),
    validate: { params: AgentIdParamSchema, body: TrustAdjustmentSchema },
    audit: records('cod.trust.adjust'),
    handler: CodController.adjustTrust,
});

export const codRoutes = router;
