import { Request, Response } from 'express';
import { ObjectId } from 'mongodb';
import { asyncHandler } from '../../../core/http/async-handler';
import { createAppError } from '../../../core/errors/app-error';
import { ERROR_CODES } from '../../../core/errors/error-codes';
import { toPageMeta } from '../../../core/http/list-query';
import { sendPaginated, sendSuccess } from '../../../core/http/responses';
import { actorContextOf } from '../../audit/domain/audit-context';
import { requireAdminIdentity } from '../../admin-identity/domain/admin-identity.types';
import { hasPermission } from '../../authorization/domain/permission.resolver';
import * as gateway from '../gateways/referral.gateway';
import {
    toPartnerDetailDto,
    toPartnerListItemDto,
    toReferredDto,
    toRewardDto,
    toSettingsDto,
} from '../read-models/referral.dto';
import {
    ReferralPartnerReadModel,
    ReferralPartnerReadRepository,
    ReferralPeopleReadRepository,
    ReferralRelationshipReadRepository,
    ReferralRewardReadModel,
    ReferralRewardReadRepository,
    ReferralSettingsReadRepository,
    ReferralWalletReadRepository,
} from '../repositories/referral.read.repository';
import {
    ListPartnersQuery,
    ListReferredQuery,
    ListRewardsQuery,
    OptionalReasonBody,
    RequiredReasonBody,
    SummaryQuery,
    UpdatePartnerTermsBody,
    UpdateSettingsBody,
} from '../validators/referral.validator';

const settingsRepo = new ReferralSettingsReadRepository();
const partners = new ReferralPartnerReadRepository();
const relationships = new ReferralRelationshipReadRepository();
const rewards = new ReferralRewardReadRepository();
const wallets = new ReferralWalletReadRepository();
const people = new ReferralPeopleReadRepository();

/** Amounts of what the platform earned stay at tier 1 (BR-030). See `referral.dto.ts`. */
const COMMISSION_PERMISSION = 'money.earnings.platform.read' as const;

async function partnerOr404(partnerId: string): Promise<ReferralPartnerReadModel> {
    const partner = await partners.findById(partnerId);
    if (!partner) throw createAppError(ERROR_CODES.NOT_FOUND, 404, 'Referral partner not found');
    return partner;
}

function auditState(partner: ReferralPartnerReadModel): Record<string, unknown> {
    return {
        status: partner.status,
        code: partner.code ?? null,
        canReapply: partner.can_reapply ?? false,
        balanceReleased: !!partner.balance_released,
        customTerms: partner.custom_terms ?? null,
    };
}

async function readPartnerDetail(partner: ReferralPartnerReadModel) {
    const [person, wallet, settings, referred, earning] = await Promise.all([
        people.findByUserIds([partner.user_id]),
        wallets.findByPartners([partner._id]),
        settingsRepo.find(),
        relationships.countForPartner(partner._id),
        relationships.countForPartner(partner._id, true),
    ]);
    return toPartnerDetailDto(
        partner,
        person.get(partner.user_id.toString()),
        wallet.get(partner._id.toString()),
        toSettingsDto(settings),
        { referred, earning },
    );
}

/** A write answers with the fresh detail; null after a commit rather than a misleading 404. */
async function respondAfterWrite(res: Response, partnerId: string, result: unknown, message: string) {
    const partner = await partners.findById(partnerId);
    sendSuccess(res, { partner: partner ? await readPartnerDetail(partner) : null, result }, { message });
}

function rewardRows(req: Request, rows: ReferralRewardReadModel[], names: Awaited<ReturnType<ReferralPeopleReadRepository['findByUserIds']>>) {
    const seesCommission = hasPermission(requireAdminIdentity(req).tier, COMMISSION_PERMISSION);
    return rows.map((row) => toRewardDto(row, names.get(row.referred_user_id.toString()), seesCommission));
}

/** `/api/v1/referrals` (REFERRAL-PROGRAM-PLAN § 5.9). */
export class ReferralController {
    static settings = asyncHandler(async (_req: Request, res: Response) => {
        sendSuccess(res, toSettingsDto(await settingsRepo.find()));
    });

    static updateSettings = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as UpdateSettingsBody;
        const before = toSettingsDto(await settingsRepo.find());
        await gateway.updateSettings(body, before, actorContextOf(req));
        sendSuccess(res, toSettingsDto(await settingsRepo.find()), { message: 'Referral settings updated' });
    });

    /** What the program costs, and how many partners are where. */
    static summary = asyncHandler(async (req: Request, res: Response) => {
        const query = req.query as unknown as SummaryQuery;
        const [totals, partnerCounts] = await Promise.all([
            rewards.totals(query.from, query.to),
            partners.countsByStatus(),
        ]);
        sendSuccess(res, { rewards: totals, partners: partnerCounts });
    });

    static listPartners = asyncHandler(async (req: Request, res: Response) => {
        const query = req.query as unknown as ListPartnersQuery;
        const matches = query.search ? await people.idsMatching(query.search) : [];
        const page = await partners.search(query, matches);
        const [names, walletRows] = await Promise.all([
            people.findByUserIds(page.items.map((row) => row.user_id)),
            wallets.findByPartners(page.items.map((row) => row._id)),
        ]);
        sendPaginated(
            res,
            page.items.map((row) => toPartnerListItemDto(row, names.get(row.user_id.toString()), walletRows.get(row._id.toString()))),
            toPageMeta(page.total, page.page, page.limit),
        );
    });

    static partnerDetail = asyncHandler(async (req: Request, res: Response) => {
        sendSuccess(res, await readPartnerDetail(await partnerOr404(req.params.partnerId)));
    });

    static partnerReferred = asyncHandler(async (req: Request, res: Response) => {
        await partnerOr404(req.params.partnerId);
        const query = req.query as unknown as ListReferredQuery;
        const page = await relationships.listForPartner(req.params.partnerId, query);
        const [names, earned] = await Promise.all([
            people.findByUserIds(page.items.map((row) => row.referred_user_id)),
            rewards.earnedByRelationship(page.items.map((row) => row._id)),
        ]);
        sendPaginated(
            res,
            page.items.map((row) => toReferredDto(row, names.get(row.referred_user_id.toString()), earned.get(row._id.toString()) ?? 0)),
            toPageMeta(page.total, page.page, page.limit),
        );
    });

    static partnerRewards = asyncHandler(async (req: Request, res: Response) => {
        await partnerOr404(req.params.partnerId);
        const page = await rewards.search(req.query as unknown as ListRewardsQuery, req.params.partnerId);
        const names = await people.findByUserIds(page.items.map((row) => row.referred_user_id));
        sendPaginated(res, rewardRows(req, page.items, names), toPageMeta(page.total, page.page, page.limit));
    });

    static listRewards = asyncHandler(async (req: Request, res: Response) => {
        const page = await rewards.search(req.query as unknown as ListRewardsQuery);
        const names = await people.findByUserIds(page.items.map((row) => row.referred_user_id));
        sendPaginated(res, rewardRows(req, page.items, names), toPageMeta(page.total, page.page, page.limit));
    });

    /** One reward, with every referred account that generated a reward on the same commission (document § 16). */
    static rewardDetail = asyncHandler(async (req: Request, res: Response) => {
        const reward = await rewards.findById(req.params.rewardId);
        if (!reward) throw createAppError(ERROR_CODES.NOT_FOUND, 404, 'Referral reward not found');
        const siblings = await rewards.findForCommission(reward.commission_allocation_id as ObjectId);
        const names = await people.findByUserIds(siblings.map((row) => row.referred_user_id));
        const dtos = rewardRows(req, siblings, names);
        sendSuccess(res, {
            reward: dtos.find((dto) => dto.id === reward._id.toString()) ?? null,
            onSameCommission: dtos.filter((dto) => dto.id !== reward._id.toString()),
        });
    });

    static approve = asyncHandler(async (req: Request, res: Response) => {
        const id = req.params.partnerId;
        const result = await gateway.approve(id, req.body as OptionalReasonBody, auditState(await partnerOr404(id)), actorContextOf(req));
        await respondAfterWrite(res, id, result, 'Application approved');
    });

    static reject = asyncHandler(async (req: Request, res: Response) => {
        const id = req.params.partnerId;
        const result = await gateway.reject(id, req.body as RequiredReasonBody, auditState(await partnerOr404(id)), actorContextOf(req));
        await respondAfterWrite(res, id, result, 'Application rejected');
    });

    static suspend = asyncHandler(async (req: Request, res: Response) => {
        const id = req.params.partnerId;
        const result = await gateway.suspend(id, req.body as RequiredReasonBody, auditState(await partnerOr404(id)), actorContextOf(req));
        await respondAfterWrite(res, id, result, 'Partner suspended');
    });

    static reinstate = asyncHandler(async (req: Request, res: Response) => {
        const id = req.params.partnerId;
        const result = await gateway.reinstate(id, req.body as OptionalReasonBody, auditState(await partnerOr404(id)), actorContextOf(req));
        await respondAfterWrite(res, id, result, 'Partner reinstated');
    });

    static terminate = asyncHandler(async (req: Request, res: Response) => {
        const id = req.params.partnerId;
        const result = await gateway.terminate(id, req.body as RequiredReasonBody, auditState(await partnerOr404(id)), actorContextOf(req));
        await respondAfterWrite(res, id, result, 'Partnership ended');
    });

    static allowReapply = asyncHandler(async (req: Request, res: Response) => {
        const id = req.params.partnerId;
        const result = await gateway.allowReapply(id, auditState(await partnerOr404(id)), actorContextOf(req));
        await respondAfterWrite(res, id, result, 'This person may apply again');
    });

    static releaseBalance = asyncHandler(async (req: Request, res: Response) => {
        const id = req.params.partnerId;
        const result = await gateway.releaseBalance(id, req.body as RequiredReasonBody, auditState(await partnerOr404(id)), actorContextOf(req));
        await respondAfterWrite(res, id, result, 'Balance released for withdrawal');
    });

    static updateTerms = asyncHandler(async (req: Request, res: Response) => {
        const id = req.params.partnerId;
        const result = await gateway.updateTerms(id, req.body as UpdatePartnerTermsBody, auditState(await partnerOr404(id)), actorContextOf(req));
        await respondAfterWrite(res, id, result, 'Partner terms updated');
    });
}
