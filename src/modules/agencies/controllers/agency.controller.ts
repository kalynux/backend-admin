import { Request, Response } from 'express';
import { actorContextOf } from '../../audit/domain/audit-context';
import { asyncHandler } from '../../../core/http/async-handler';
import { createAppError } from '../../../core/errors/app-error';
import { ERROR_CODES } from '../../../core/errors/error-codes';
import { toPageMeta } from '../../../core/http/list-query';
import { sendPaginated, sendSuccess } from '../../../core/http/responses';
import { requireAdminIdentity } from '../../admin-identity/domain/admin-identity.types';
import { toAuditEntryDto } from '../../audit/domain/audit.dto';
import { AuditRepository } from '../../audit/repositories/audit.repository';
import { ListAuditQuery } from '../../audit/validators/audit.validator';
import * as gateway from '../gateways/agency.gateway';
import { AgencyReadModel, AgencyReadRepository } from '../repositories/agency.read.repository';
import { ContractEventReadRepository, distinctAgentIds } from '../repositories/contract-event.read.repository';
import { ContractReadRepository } from '../repositories/contract.read.repository';
import { toContractEventDto, toRosterEntryDto } from '../read-models/contract.dto';
import { AgencyPoliciesDto, toAgencyPoliciesDto } from '../read-models/agency-policies.dto';
/**
 * The contract-history feed names agents, and this is the name-only read of them.
 *
 * Imported from the agents module rather than declared here for the reason that repository
 * states: `delivery_agents` holds `legal_identity`, `payout_details` and device telemetry,
 * so a second projection of it declared next door is a second thing to get right. Same
 * direction the roster's own `$lookup` already takes, and the same direction
 * `agent.controller.ts` imports this module's validators.
 */
import { AgentReadRepository } from '../../agents/repositories/agent.read.repository';
import { VendorConnectionReadRepository } from '../../vendors/repositories/vendor-context.read.repository';
import {
    DeactivateAgencyBody,
    ListAgencyActivityQuery,
    ListContractEventsQuery,
    ListRosterQuery,
    ReactivateAgencyBody,
    RejectAgencyBody,
    SearchAgenciesQuery,
} from '../validators/agency.validator';

/**
 * `/api/v1/agencies` — delivery-agency administration.
 *
 * Both halves of ADR-004 meet here: the directory, the detail, the roster and the two
 * feeds are **direct reads**; verify, deactivate and reactivate are **delegated**. The
 * reason is not symmetry — deactivation is a cascade across products and order items
 * paired with post-commit events, and reproducing the transaction from here would get the
 * rows right and the notifications silently wrong.
 *
 * ── What this surface deliberately does NOT offer ─────────────────────────────
 *  - **Editing an agency's policies.** Pricing, returns and damage terms are the agency's
 *    own commercial record, negotiated with the vendors connected to it, and every edit
 *    bumps `policy_version`, which pauses those connections for re-approval. An
 *    administrator changing a price on their behalf would silently re-open every
 *    relationship they have.
 *  - **Un-verifying.** Revoking a verification that gates nothing (`requireLegitBusiness`
 *    has no call sites) would be theatre. `deactivate` is the real lever, and it is the
 *    one with teeth.
 *  - **Creating an agency.** Onboarding is a four-step flow with a Magazin provisioned
 *    along the way; a row inserted from here would be missing it, and every later read
 *    would report a business with no name.
 */

const agencies = new AgencyReadRepository();
const contracts = new ContractReadRepository();
const contractEvents = new ContractEventReadRepository();
const agents = new AgentReadRepository();
const audit = new AuditRepository();
/**
 * Reached for one number: how many vendor connections a policy bump has left waiting.
 *
 * The collection belongs to the vendor module's context repository, which already counts
 * it from the other side — reusing that is what keeps the vendor's
 * `counts.agencyConnections.pausedReapproval` and this figure counting the same rows.
 */
const vendorConnections = new VendorConnectionReadRepository();

interface AgencyDto {
    id: string;
    userId: string;
    /** From the Magazin. `null`, never `""` (ADR-005 D-16) — absent data is absent. */
    businessName: string | null;
    /** An opaque id. This service resolves no file URLs — see ADR-008 D-6. */
    logoFileId: string | null;
    contactName: string | null;
    country: string | null;
    status: string;
    onboardingComplete: boolean;
    /**
     * Both mirrors, deliberately. `kyc_details.legit_verified` is canonical and the
     * top-level one is deprecated; they are written together by the one writer there is,
     * so a disagreement means a hand-edited document — and only showing both makes that
     * visible instead of picking a winner and hiding the fact.
     */
    verified: boolean;
    verifiedLegacyMirror: boolean;
    autoAssignEnabled: boolean;
    createdAt: string;
    updatedAt: string;
}

interface AgencyDetailDto extends AgencyDto {
    email: string | null;
    emailVerified: boolean;
    phone: string | null;
    phoneVerified: boolean;
    coverageAreas: string[];
    kyc: {
        registrationNumber: string | null;
        transportLicenseId: string | null;
        /**
         * The verdict, added Phase 6 Step 4. **Not derivable from the agency's `status`**:
         * `pending_verification` is where an agency sits both before a review and after a
         * refused one, which is exactly the ambiguity this removes. A review queue filters
         * on this; a dispatch decision reads `status`.
         */
        status: 'pending' | 'verified' | 'rejected';
        /** Set on `rejected` — and shown to the agency, who has to know what to fix. */
        rejectionReason: string | null;
        verifiedAt: string | null;
        verifiedBy: { id: string | null; source: string; name: string | null } | null;
    };
    policies: AgencyPoliciesDto | null;
    policyVersion: number;
    /**
     * How many vendor connections are sitting in `paused_reapproval` right now.
     *
     * `policyVersion` is the field with the largest blast radius on this screen — bumping
     * it pauses EVERY vendor connection for re-approval — and until now there was no way
     * to see how many were in that state as a result. The vendor side has
     * `counts.agencyConnections.pausedReapproval`; this is the agency's equivalent, and
     * the two are counted off the same collection so they cannot disagree.
     */
    policyVersionPausedConnections: number;
    timezone: string | null;
    preferredLanguage: string | null;
}

/**
 * Named-field mapping, not a spread.
 *
 * The projection already excludes everything sensitive; naming the fields is the second
 * of the two locks, and the one that survives somebody widening the projection for a new
 * screen.
 */
function toAgencyDto(agency: AgencyReadModel): AgencyDto {
    return {
        id: agency._id.toString(),
        userId: agency.user_id?.toString() ?? '',
        businessName: agency.magazin?.name ?? null,
        logoFileId: agency.magazin?.logo_file_id?.toString() ?? null,
        contactName: agency.display_name ?? null,
        country: agency.country ?? null,
        status: agency.status,
        // `0` is the COMPLETED sentinel in jovi-mall's onboarding constants, not a
        // "nothing done yet" — reading it as falsy is the obvious way to get this backwards.
        onboardingComplete: agency.onboarding_step === 0,
        verified: agency.kyc_details?.legit_verified === true,
        verifiedLegacyMirror: agency.legit_verified === true,
        autoAssignEnabled: agency.assignment_settings?.auto_assign_enabled === true,
        createdAt: toIso(agency.created_at) ?? String(agency.created_at),
        updatedAt: toIso(agency.updated_at) ?? String(agency.updated_at),
    };
}

function toAgencyDetailDto(agency: AgencyReadModel, pausedConnections: number): AgencyDetailDto {
    const kyc = agency.kyc_details ?? {};
    return {
        ...toAgencyDto(agency),
        email: agency.email ?? null,
        emailVerified: agency.email_verified === true,
        phone: agency.phone ?? null,
        phoneVerified: agency.phone_verified === true,
        coverageAreas: agency.magazin?.coverage_areas ?? [],
        kyc: {
            registrationNumber: kyc.registration_number ?? null,
            transportLicenseId: kyc.transport_license_id ?? null,
            // `?? 'pending'` covers rows written before the field existed. That reads as
            // the truth about them: nobody has reached a verdict.
            status: kyc.status ?? 'pending',
            rejectionReason: kyc.rejection_reason ?? null,
            verifiedAt: toIso(kyc.verified_at),
            // Present only once verified. An unverified agency carrying a stale approver
            // would read as approved on any screen rendering the block without checking
            // the flag first — the same rule the user DTO applies to a suspension.
            //
            // ⚠ Deliberately NOT widened to cover a rejection, even though the same three
            // fields now hold the rejecter. This field's NAME is a claim ("verified by"),
            // and a rejecter surfacing under it is worse than an absent one. Who refused
            // an application, and when, is the `agencies.reject` audit row — the same
            // place the vendor lifecycle puts it, and the reason its model docstring
            // clears `verified_at` on rejection rather than repurposing it.
            verifiedBy:
                kyc.legit_verified === true
                    ? {
                          id: kyc.verified_by_user_id?.toString() ?? null,
                          source: kyc.verified_by_source ?? 'platform',
                          name: kyc.verified_by_name ?? null,
                      }
                    : null,
        },
        /**
         * ⚠ **camelCase as of the dashboard-request round.** This shipped as
         * `agency.policies ?? null` — jovi-mall's sub-document assigned whole, four nested
         * blocks of `snake_case` on the wire against README's camelCase promise, and
         * undocumented besides. Every field is named now; see
         * `read-models/agency-policies.dto.ts`, which also explains why the projection can
         * stay wide.
         */
        policies: toAgencyPoliciesDto(agency.policies),
        policyVersion: agency.policy_version ?? 0,
        policyVersionPausedConnections: pausedConnections,
        timezone: agency.timezone ?? null,
        preferredLanguage: agency.preferred_language ?? null,
    };
}

function toIso(value: Date | null | undefined): string | null {
    if (!value) return null;
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** The fields a write can change, as the audit row's `before`. */
function toAuditState(agency: AgencyReadModel): Record<string, unknown> {
    return {
        status: agency.status,
        verified: agency.kyc_details?.legit_verified === true,
        businessName: agency.magazin?.name ?? null,
    };
}

/**
 * Load or 404 — and return the row, because every write needs it twice: to refuse a
 * request against an agency that does not exist, and as the audit `before`.
 *
 * Reading before delegating costs one indexed lookup and buys the two things the gateway
 * cannot get from jovi-mall's answer: the previous state, and a 404 that says "no such
 * agency" rather than a `PLATFORM_OPERATION_REJECTED` wrapping one.
 */
async function loadOr404(agencyId: string): Promise<AgencyReadModel> {
    const agency = await agencies.findById(agencyId);
    if (!agency) throw createAppError(ERROR_CODES.NOT_FOUND, 404, 'Delivery agency not found');
    return agency;
}

export class AgencyController {
    /**
     * GET /api/v1/agencies — search and filter the delivery network.
     *
     * `search` matches the business name, the contact name, the email, the phone or the
     * agency id. `verified` is worth its own filter beside `status` precisely because the
     * two can disagree: nothing enforces `legit_verified`, so an `active` unverified
     * agency is a real and findable state.
     */
    static search = asyncHandler(async (req: Request, res: Response) => {
        const query = req.query as unknown as SearchAgenciesQuery;

        const page = await agencies.search({
            search: query.search,
            status: query.status,
            verified: query.verified,
            autoAssign: query.autoAssign,
            country: query.country,
            from: query.from,
            to: query.to,
            page: query.page,
            limit: query.limit,
            sort: query.sort,
        });

        sendPaginated(res, page.items.map(toAgencyDto), toPageMeta(page.total, page.page, page.limit));
    });

    /** GET /api/v1/agencies/:agencyId */
    static get = asyncHandler(async (req: Request, res: Response) => {
        const agency = await loadOr404(req.params.agencyId);

        // One extra indexed count, for the number that makes `policyVersion` legible: how
        // many vendor connections the last bump left waiting for re-approval.
        const pausedConnections = await vendorConnections.countPausedReapprovalForAgency(
            req.params.agencyId,
        );

        sendSuccess(res, toAgencyDetailDto(agency, pausedConnections));
    });

    /**
     * GET /api/v1/agencies/:agencyId/agents — the roster.
     *
     * Every contract status by default, terminal rows included. A live-only default would
     * make a relationship's history impossible to fetch, which on an administrative
     * surface is most of what the screen is for.
     *
     * Note what a roster is NOT: a list of agents this agency can dispatch to. That is an
     * eligibility question, it is pairwise, and it lives on the agent surface behind the
     * delegated `eligibility` read.
     */
    static roster = asyncHandler(async (req: Request, res: Response) => {
        const query = req.query as unknown as ListRosterQuery;
        await loadOr404(req.params.agencyId);

        const page = await contracts.listForAgency(req.params.agencyId, {
            status: query.status,
            primaryOnly: query.primaryOnly,
            page: query.page,
            limit: query.limit,
            sort: query.sort,
        });

        sendPaginated(res, page.items.map(toRosterEntryDto), toPageMeta(page.total, page.page, page.limit));
    });

    /**
     * GET /api/v1/agencies/:agencyId/contract-history
     *
     * jovi-mall's own record of what happened to this agency's relationships — and its
     * `actorRole` is `agent | agency | admin | system`, so it is what EVERYONE did. The
     * sibling `/activity` is what administrators did. They are two endpoints rather than
     * one merged feed because they live in two databases reached by two MongoClients,
     * where a merged page total would be a sum of two counts and `meta.pages` a lie.
     *
     * It is also the only one of the two with any history in it today: jovi-mall's audit
     * logger is a console stub, so every deactivation before this phase is unrecoverable.
     *
     * ── The agent's NAME, resolved after the page is cut (BR-016 § 1) ─────────
     * This is the agency's view of the relationship, so every row names an agent the reader
     * does not already know — and `agentId` alone made the table a column of 24-hex ids. The
     * lookup runs on the page that came back, never on the matched set, so it touches at
     * most `limit` distinct agents however deep the history goes.
     */
    static contractHistory = asyncHandler(async (req: Request, res: Response) => {
        const query = req.query as unknown as ListContractEventsQuery;
        await loadOr404(req.params.agencyId);

        const page = await contractEvents.list(
            { agencyId: req.params.agencyId },
            {
                type: query.type,
                actorRole: query.actorRole,
                from: query.from,
                to: query.to,
                page: query.page,
                limit: query.limit,
                sort: query.sort,
            },
        );

        const agentNames = await agents.findNamesByIds(distinctAgentIds(page.items));

        sendPaginated(
            res,
            page.items.map((event) => toContractEventDto(event, agentNames)),
            toPageMeta(page.total, page.page, page.limit),
        );
    });

    /**
     * GET /api/v1/agencies/:agencyId/activity — what administrators did to this agency.
     *
     * The audit trail filtered to this agency as its target: every verification,
     * deactivation and reactivation, who made it, from where, and whether it succeeded.
     *
     * It is NOT the agency's platform activity — its shipments, its orders, its COD
     * remittances. Those live in other domains behind other permissions, and assembling
     * them here would let `agencies.read` alone reach data those permissions exist to
     * gate. The audit repository applies its own per-tier read scope on top of this
     * filter; `agency` rows are `platform_actor`, which every tier may read.
     */
    static activity = asyncHandler(async (req: Request, res: Response) => {
        const identity = requireAdminIdentity(req);
        const query = req.query as unknown as ListAgencyActivityQuery;

        // 404 first: an activity feed for an agency that does not exist should say so, not
        // answer an empty page that reads as "nothing ever happened".
        await loadOr404(req.params.agencyId);

        const page = await audit.search(
            {
                page: query.page,
                limit: query.limit,
                sort: query.sort,
                action: query.action,
                status: query.status,
                from: query.from,
                to: query.to,
                // Fixed by the path — a caller cannot widen it.
                targetType: 'agency',
                targetId: req.params.agencyId,
            } as ListAuditQuery,
            identity,
        );

        sendPaginated(res, page.items.map(toAuditEntryDto), page.meta);
    });

    /**
     * POST /api/v1/agencies/:agencyId/verify — approve the business verification.
     *
     * The exit from `pending_verification`, which had none before this phase: nothing
     * moved an agency off that status except `reactivate`, an endpoint whose name says the
     * opposite and which also runs the product-restore cascade.
     *
     * jovi-mall performs it as a compare-and-set and answers 409 on a miss, so two
     * administrators on one screen cannot overwrite each other's stamp.
     */
    static verify = asyncHandler(async (req: Request, res: Response) => {
        const before = await loadOr404(req.params.agencyId);

        const updated = await gateway.verify(
            req.params.agencyId,
            toAuditState(before),
            actorContextOf(req),
        );

        sendSuccess(res, updated, { message: 'Agency verified — it may now operate' });
    });

    /**
     * POST /api/v1/agencies/:agencyId/reject — refuse the business verification.
     *
     * The second verdict, added in Phase 6 Step 4. Until it existed,
     * `kyc_details.legit_verified: false` meant both "never reviewed" and "reviewed and
     * refused", so this queue could not tell an untouched application from one a colleague
     * had already turned down, and the agency was never told what to fix.
     *
     * It holds `agencies.verify` rather than a permission of its own: that permission is
     * the *review* capability, named for its happy path, exactly as `vendors.kyc.review`
     * and `agents.kyc.review` cover both of their outcomes. The **audit action** is what
     * distinguishes the two verdicts, per ADR-005 D-4.
     */
    static reject = asyncHandler(async (req: Request, res: Response) => {
        const before = await loadOr404(req.params.agencyId);
        const body = req.body as RejectAgencyBody;

        const updated = await gateway.reject(
            req.params.agencyId,
            toAuditState(before),
            actorContextOf(req),
            body.reason,
        );

        sendSuccess(res, updated, { message: 'Agency verification rejected' });
    });

    /**
     * POST /api/v1/agencies/:agencyId/deactivate
     *
     * A POST sub-resource rather than jovi-mall's `PATCH`: ADR-005 D-2 — the permission
     * and the audit row attach to the ACTION, and porting is not transcription.
     *
     * The counts come back in `meta` because they describe what the write DID rather than
     * what the agency now is. They are the number a vendor's support ticket will be about.
     */
    static deactivate = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as DeactivateAgencyBody;
        const before = await loadOr404(req.params.agencyId);

        const { agency, counts } = await gateway.deactivate(
            req.params.agencyId,
            body.reason,
            toAuditState(before),
            actorContextOf(req),
        );

        sendSuccess(res, agency, {
            meta: counts,
            message:
                `Agency deactivated. ${counts.products} product(s) suspended, `
                + `${counts.orderItems} order item(s) put on hold.`,
        });
    });

    /**
     * POST /api/v1/agencies/:agencyId/reactivate
     *
     * The counts here are the ones worth reading twice: a listing that no longer passes
     * its own activation gate stays suspended, so `products` restored can legitimately be
     * lower than the number deactivation suspended. That gap is not a bug and the audit
     * row's `after` is where it becomes visible.
     */
    static reactivate = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as ReactivateAgencyBody;
        const before = await loadOr404(req.params.agencyId);

        const { agency, counts } = await gateway.reactivate(
            req.params.agencyId,
            body.reason,
            toAuditState(before),
            actorContextOf(req),
        );

        sendSuccess(res, agency, {
            meta: counts,
            message:
                `Agency reactivated. ${counts.products} product(s) restored, `
                + `${counts.orderItems} order item(s) resumed.`,
        });
    });
}
