import {
    ReferralPartnerReadModel,
    ReferralPerson,
    ReferralRelationshipReadModel,
    ReferralRewardReadModel,
    ReferralSettingsReadModel,
    ReferralWalletReadModel,
} from '../repositories/referral.read.repository';

/**
 * What administrators read. Unlike the partner's own view in jovi-mall, this names the people and
 * the order or booking behind a reward (owner R-8).
 *
 * ⚠ **The commission figures are amounts of what the platform earned**, which the owner keeps at
 * tier 1 (`money.earnings.platform.read`, BR-030). Below it they are `null` and
 * `commissionWithheld` says why, so a dashboard does not read that as zero.
 */

const REFERRAL_DEFAULTS = {
    enabled: false,
    ratePercent: 3,
    durationMonths: 6,
    minPayoutAmount: 1_000,
    rewardWaitDays: 14,
} as const;

/** `provider` since 2026-11-08 (jovi-mall RS-3): a service provider, earning on what it pays Wi-Mall. */
const CATEGORIES = ['vendor', 'customer', 'agency', 'provider'] as const;

/** jovi-mall's `paymentKindOf`: what a provider reward came from. Null on a commission reward. */
const PAYMENT_KIND: Record<string, 'plan' | 'credits'> = { plan_purchase: 'plan', credit_topup: 'credits' };

export function toSettingsDto(row: ReferralSettingsReadModel | null) {
    return {
        enabled: row?.enabled ?? REFERRAL_DEFAULTS.enabled,
        terms: Object.fromEntries(
            CATEGORIES.map((category) => [
                category,
                {
                    ratePercent: row?.terms?.[category]?.rate_percent ?? REFERRAL_DEFAULTS.ratePercent,
                    durationMonths: row?.terms?.[category]?.duration_months ?? REFERRAL_DEFAULTS.durationMonths,
                },
            ]),
        ),
        minPayoutAmount: row?.min_payout_amount ?? REFERRAL_DEFAULTS.minPayoutAmount,
        rewardWaitDays: row?.reward_wait_days ?? REFERRAL_DEFAULTS.rewardWaitDays,
        updatedAt: row?.updated_at ?? null,
        updatedBy: row?.updated_by_name ?? null,
    };
}

function walletDto(wallet: ReferralWalletReadModel | undefined) {
    return {
        currency: wallet?.currency ?? 'XAF',
        pending: wallet?.pending_balance ?? 0,
        available: wallet?.available_balance ?? 0,
        requested: wallet?.requested_balance ?? 0,
        clawback: wallet?.clawback_balance ?? 0,
    };
}

export function toPartnerListItemDto(
    row: ReferralPartnerReadModel,
    person: ReferralPerson | undefined,
    wallet: ReferralWalletReadModel | undefined,
) {
    return {
        id: row._id.toString(),
        userId: row.user_id.toString(),
        name: person?.name ?? null,
        phone: person?.phone ?? null,
        email: person?.email ?? null,
        appliedAsRole: row.applied_as_role,
        status: row.status,
        code: row.code ?? null,
        appliedAt: row.applied_at,
        approvedAt: row.approved_at ?? null,
        balances: walletDto(wallet),
    };
}

export function toPartnerDetailDto(
    row: ReferralPartnerReadModel,
    person: ReferralPerson | undefined,
    wallet: ReferralWalletReadModel | undefined,
    settings: ReturnType<typeof toSettingsDto>,
    counts: { referred: number; earning: number },
) {
    const custom = row.custom_terms ?? {};
    return {
        ...toPartnerListItemDto(row, person, wallet),
        motivation: row.motivation ?? null,
        termsAcceptedAt: row.terms_accepted_at ?? null,
        statusReason: row.status_reason ?? null,
        canReapply: row.can_reapply ?? false,
        /** Suspended or terminated, and nobody has released the balance yet (owner R-9). */
        balanceFrozen: row.status !== 'active' && !row.balance_released,
        balanceReleased: row.balance_released
            ? { at: row.balance_released.at, by: row.balance_released.actor_name ?? null, reason: row.balance_released.reason }
            : null,
        /** Each field says what applies and whether it is this partner's own value (document § 9). */
        terms: Object.fromEntries(
            CATEGORIES.map((category) => {
                const own = custom[category];
                const global = (settings.terms as Record<string, { ratePercent: number; durationMonths: number }>)[category];
                return [
                    category,
                    {
                        ratePercent: own?.rate_percent ?? global.ratePercent,
                        rateIsCustom: typeof own?.rate_percent === 'number',
                        durationMonths: own?.duration_months ?? global.durationMonths,
                        durationIsCustom: typeof own?.duration_months === 'number',
                    },
                ];
            }),
        ),
        referred: counts,
        history: (row.status_history ?? []).map((change) => ({
            from: change.from,
            to: change.to,
            at: change.at,
            by: change.actor_name ?? null,
            reason: change.reason ?? null,
        })),
    };
}

export function toReferredDto(row: ReferralRelationshipReadModel, person: ReferralPerson | undefined, earned: number) {
    const expiresAt = row.expires_at ?? null;
    return {
        id: row._id.toString(),
        partnerId: row.partner_id.toString(),
        userId: row.referred_user_id.toString(),
        name: person?.name ?? null,
        phone: person?.phone ?? null,
        category: row.category,
        codeUsed: row.code_used,
        channel: row.channel,
        registeredAt: row.registered_at,
        expiresAt,
        earning: !!expiresAt && expiresAt.getTime() > Date.now(),
        totalEarned: earned,
    };
}

export function toRewardDto(
    row: ReferralRewardReadModel,
    person: ReferralPerson | undefined,
    seesCommission: boolean,
) {
    return {
        id: row._id.toString(),
        partnerId: row.partner_id.toString(),
        relationshipId: row.relationship_id.toString(),
        referredUserId: row.referred_user_id.toString(),
        referredName: person?.name ?? null,
        category: row.category,
        sourceType: row.source_type,
        orderId: row.order_id ? row.order_id.toString() : null,
        bookingId: row.booking_id ? row.booking_id.toString() : null,
        vendorId: row.vendor_id.toString(),
        /** Null on a provider reward (2026-11-08), which comes from a payment, not a commission. */
        commissionId: row.commission_allocation_id ? row.commission_allocation_id.toString() : null,
        commissionWithheld: !seesCommission,
        commissionEarned: seesCommission && row.commission_allocation_id ? row.commission_earned : null,
        /**
         * A provider reward's source (RS-3, RS-7): the plan purchase or credit top-up, its kind, and
         * the price paid — the reward's base (RS-6). A plan's price is public, so every tier sees it;
         * the PARTNER never does (their own DTO carries the kind alone). Null on a commission reward.
         */
        paymentKind: PAYMENT_KIND[row.source_type] ?? null,
        payment: PAYMENT_KIND[row.source_type]
            ? { kind: PAYMENT_KIND[row.source_type], id: row.source_id.toString(), amountPaid: row.commission_earned }
            : null,
        /** The participant's part of the commission: 100, except a prepaid order's agency (owner R-7). */
        sharePercent: Math.round((row.share.numerator / row.share.denominator) * 10_000) / 100,
        ratePercent: row.rate_percent,
        rateSource: row.rate_source,
        amount: row.amount,
        clawedAmount: row.clawed_amount,
        remaining: row.amount - row.clawed_amount,
        currency: row.currency,
        status: row.status,
        earnedAt: row.earned_at,
        availableFrom: row.matures_at,
        releasedAt: row.released_at ?? null,
        reversedAt: row.reversed_at ?? null,
        adjustments: (row.adjustments ?? []).map((adjustment) => ({
            at: adjustment.at,
            refundKey: adjustment.refund_key ?? null,
            commissionRetained: seesCommission ? adjustment.commission_retained : null,
            amountBefore: adjustment.amount_before,
            amountAfter: adjustment.amount_after,
        })),
    };
}
