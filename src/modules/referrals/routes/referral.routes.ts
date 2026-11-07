import { Router } from 'express';
import { defineRoute, permission, records } from '../../../api/route-manifest';
import { ReferralController } from '../controllers/referral.controller';
import {
    EmptyBodySchema,
    ListPartnersQuerySchema,
    ListReferredQuerySchema,
    ListRewardsQuerySchema,
    OptionalReasonSchema,
    PartnerIdParamSchema,
    RequiredReasonSchema,
    RewardIdParamSchema,
    SummaryQuerySchema,
    UpdatePartnerTermsSchema,
    UpdateSettingsSchema,
} from '../validators/referral.validator';

/**
 * `/api/v1/referrals` — the referral program's administration (REFERRAL-PROGRAM-PLAN § 5.9).
 *
 * | Permission | Tiers | What |
 * |---|---|---|
 * | `referrals.read`             | 1 2 3 | settings, partners, referred accounts, rewards |
 * | `referrals.partners.decide`  | 1 2 3 | approve, reject, suspend, reinstate, terminate, allow re-application (owner R-10) |
 * | `referrals.partners.balance` | 1 2   | unfreeze a suspended or terminated partner's balance |
 * | `referrals.settings.write`   | 1     | global and per-partner rates and durations, and switching the program on or off (owner R-10) |
 *
 * ── Route order ───────────────────────────────────────────────────────────────
 * `/settings`, `/summary`, `/partners` and `/rewards` are all literal; nothing here is a bare
 * `/:id`, so there is no order to get wrong.
 */
const router = Router();
const mountedAt = '/referrals';

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/settings',
    access: permission('referrals.read'),
    handler: ReferralController.settings,
});

defineRoute(router, {
    mountedAt,
    method: 'patch',
    path: '/settings',
    access: permission('referrals.settings.write'),
    validate: { body: UpdateSettingsSchema },
    audit: records('referrals.settings.update'),
    handler: ReferralController.updateSettings,
});

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/summary',
    access: permission('referrals.read'),
    validate: { query: SummaryQuerySchema },
    handler: ReferralController.summary,
});

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/rewards',
    access: permission('referrals.read'),
    validate: { query: ListRewardsQuerySchema },
    handler: ReferralController.listRewards,
});

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/rewards/:rewardId',
    access: permission('referrals.read'),
    validate: { params: RewardIdParamSchema },
    handler: ReferralController.rewardDetail,
});

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/partners',
    access: permission('referrals.read'),
    validate: { query: ListPartnersQuerySchema },
    handler: ReferralController.listPartners,
});

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/partners/:partnerId',
    access: permission('referrals.read'),
    validate: { params: PartnerIdParamSchema },
    handler: ReferralController.partnerDetail,
});

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/partners/:partnerId/referred',
    access: permission('referrals.read'),
    validate: { params: PartnerIdParamSchema, query: ListReferredQuerySchema },
    handler: ReferralController.partnerReferred,
});

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/partners/:partnerId/rewards',
    access: permission('referrals.read'),
    validate: { params: PartnerIdParamSchema, query: ListRewardsQuerySchema },
    handler: ReferralController.partnerRewards,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/partners/:partnerId/approve',
    access: permission('referrals.partners.decide'),
    validate: { params: PartnerIdParamSchema, body: OptionalReasonSchema },
    audit: records('referrals.partner.approve'),
    handler: ReferralController.approve,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/partners/:partnerId/reject',
    access: permission('referrals.partners.decide'),
    validate: { params: PartnerIdParamSchema, body: RequiredReasonSchema },
    audit: records('referrals.partner.reject'),
    handler: ReferralController.reject,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/partners/:partnerId/suspend',
    access: permission('referrals.partners.decide'),
    validate: { params: PartnerIdParamSchema, body: RequiredReasonSchema },
    audit: records('referrals.partner.suspend'),
    handler: ReferralController.suspend,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/partners/:partnerId/reinstate',
    access: permission('referrals.partners.decide'),
    validate: { params: PartnerIdParamSchema, body: OptionalReasonSchema },
    audit: records('referrals.partner.reinstate'),
    handler: ReferralController.reinstate,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/partners/:partnerId/terminate',
    access: permission('referrals.partners.decide'),
    validate: { params: PartnerIdParamSchema, body: RequiredReasonSchema },
    audit: records('referrals.partner.terminate'),
    handler: ReferralController.terminate,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/partners/:partnerId/allow-reapply',
    access: permission('referrals.partners.decide'),
    validate: { params: PartnerIdParamSchema, body: EmptyBodySchema },
    audit: records('referrals.partner.allow_reapply'),
    handler: ReferralController.allowReapply,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/partners/:partnerId/release-balance',
    access: permission('referrals.partners.balance'),
    validate: { params: PartnerIdParamSchema, body: RequiredReasonSchema },
    audit: records('referrals.partner.release_balance'),
    handler: ReferralController.releaseBalance,
});

defineRoute(router, {
    mountedAt,
    method: 'patch',
    path: '/partners/:partnerId/terms',
    access: permission('referrals.settings.write'),
    validate: { params: PartnerIdParamSchema, body: UpdatePartnerTermsSchema },
    audit: records('referrals.partner.terms_update'),
    handler: ReferralController.updateTerms,
});

export const referralRoutes = router;
