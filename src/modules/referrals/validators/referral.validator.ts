import { z } from 'zod';
import { listQuery } from '../../../core/http/list-query';
import { dateRangeFields, dateRangeRule, idParam, objectId, reasonText, searchTerm } from '../../../core/validation/common.schemas';
import { platformStatus } from '../../orders/validators/order.validator';

/** Request shapes for `/api/v1/referrals` (REFERRAL-PROGRAM-PLAN § 5.9). */

export const PartnerIdParamSchema = idParam('partnerId', 'partner');
export const RewardIdParamSchema = idParam('rewardId', 'reward');

export const REFERRAL_PARTNER_SORT = { appliedAt: 'applied_at' } as const;
export const REFERRAL_RELATIONSHIP_SORT = { registeredAt: 'registered_at' } as const;
export const REFERRAL_REWARD_SORT = { earnedAt: 'earned_at' } as const;

export const ListPartnersQuerySchema = listQuery(REFERRAL_PARTNER_SORT, '-appliedAt', {
    /** A code (prefix), or the partner's login phone or email (prefix). */
    search: searchTerm.optional(),
    status: platformStatus.optional(),
});
export type ListPartnersQuery = z.infer<typeof ListPartnersQuerySchema>;

export const ListReferredQuerySchema = listQuery(REFERRAL_RELATIONSHIP_SORT, '-registeredAt', {
    category: platformStatus.optional(),
});
export type ListReferredQuery = z.infer<typeof ListReferredQuerySchema>;

export const ListRewardsQuerySchema = listQuery(REFERRAL_REWARD_SORT, '-earnedAt', {
    status: platformStatus.optional(),
    category: platformStatus.optional(),
    orderId: objectId.optional(),
    bookingId: objectId.optional(),
    ...dateRangeFields(),
}).superRefine(dateRangeRule({ maxDays: 366 }));
export type ListRewardsQuery = z.infer<typeof ListRewardsQuerySchema>;

export const SummaryQuerySchema = z.object({ ...dateRangeFields() }).superRefine(dateRangeRule({ maxDays: 366 }));
export type SummaryQuery = z.infer<typeof SummaryQuerySchema>;

const RatePercent = z.number().min(0).max(25).refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-9, {
    message: 'A rate has at most two decimals',
});
const DurationMonths = z.number().int().min(1).max(120);

const GlobalCategoryTerms = z
    .object({ ratePercent: RatePercent.optional(), durationMonths: DurationMonths.optional() })
    .strict();

export const UpdateSettingsSchema = z
    .object({
        enabled: z.boolean().optional(),
        terms: z
            .object({
                vendor: GlobalCategoryTerms.optional(),
                customer: GlobalCategoryTerms.optional(),
                agency: GlobalCategoryTerms.optional(),
            })
            .strict()
            .optional(),
        minPayoutAmount: z.number().int().min(1).optional(),
        rewardWaitDays: z.number().int().min(0).max(365).optional(),
    })
    .strict();
export type UpdateSettingsBody = z.infer<typeof UpdateSettingsSchema>;

/** `null` returns a field to the global value (document § 9). */
const PartnerCategoryTerms = z
    .object({ ratePercent: RatePercent.nullable().optional(), durationMonths: DurationMonths.nullable().optional() })
    .strict();

export const UpdatePartnerTermsSchema = z
    .object({
        terms: z
            .object({
                vendor: PartnerCategoryTerms.optional(),
                customer: PartnerCategoryTerms.optional(),
                agency: PartnerCategoryTerms.optional(),
            })
            .strict(),
    })
    .strict();
export type UpdatePartnerTermsBody = z.infer<typeof UpdatePartnerTermsSchema>;

const REASON_REQUIRED = 'A reason is required, and the partner is shown it';

export const RequiredReasonSchema = z.object({ reason: reasonText(REASON_REQUIRED, { max: 1000 }) }).strict();
export type RequiredReasonBody = z.infer<typeof RequiredReasonSchema>;

export const OptionalReasonSchema = z.object({ reason: reasonText(REASON_REQUIRED, { max: 1000 }).optional() }).strict();
export type OptionalReasonBody = z.infer<typeof OptionalReasonSchema>;

export const EmptyBodySchema = z.object({}).strict();
