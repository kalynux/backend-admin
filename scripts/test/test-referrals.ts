/**
 * Test: the referral program's administrator surface (REFERRAL-PROGRAM-PLAN § 5.9). DB-free.
 *
 *   1. Who holds what: the owner's R-10, tier by tier.
 *   2. Commission amounts stay at tier 1.
 *   3. The filters.
 *   4. Wiring: every write is audited and delegated; no payout destination is read here.
 *   5. The two repositories agree: defaults and bounds (there is no shared package).
 *
 * Run: npm run test:referrals
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { ObjectId } from 'mongodb';
import { TIER_GRANTS } from '../../src/modules/authorization/domain/tier-grants';
import { permissionSpec } from '../../src/modules/authorization/domain/permission.catalog';
import { toRewardDto, toSettingsDto, toPartnerDetailDto } from '../../src/modules/referrals/read-models/referral.dto';
import {
    buildPartnerFilter,
    buildRewardFilter,
    ReferralPartnerReadModel,
    ReferralRewardReadModel,
} from '../../src/modules/referrals/repositories/referral.read.repository';
import {
    ListRewardsQuerySchema,
    RequiredReasonSchema,
    UpdatePartnerTermsSchema,
    UpdateSettingsSchema,
} from '../../src/modules/referrals/validators/referral.validator';

let passed = 0;
let failed = 0;

function assert(name: string, condition: boolean): void {
    if (condition) {
        console.log(`  ✅ ${name}`);
        passed++;
    } else {
        console.error(`  ❌ FAIL: ${name}`);
        failed++;
    }
}

const ROOT = join(__dirname, '..', '..');
const read = (rel: string): string => readFileSync(join(ROOT, 'src', rel), 'utf8');
const holds = (tier: 1 | 2 | 3, name: string): boolean => (TIER_GRANTS[tier] as readonly string[]).includes(name);

console.log('\n1. Who holds what');
{
    for (const tier of [1, 2, 3] as const) {
        assert(`tier ${tier} reads the program`, holds(tier, 'referrals.read'));
        assert(`tier ${tier} approves, rejects, suspends and terminates`, holds(tier, 'referrals.partners.decide'));
    }
    assert('rates and durations are tier 1 only', holds(1, 'referrals.settings.write') && !holds(2, 'referrals.settings.write') && !holds(3, 'referrals.settings.write'));
    assert('a frozen balance is tiers 1 and 2', holds(1, 'referrals.partners.balance') && holds(2, 'referrals.partners.balance') && !holds(3, 'referrals.partners.balance'));
    assert('both are flagged financial, so no family sweep hands them out',
        permissionSpec('referrals.settings.write').financial === true && permissionSpec('referrals.partners.balance').financial === true);
}

console.log('\n2. Commission amounts stay at tier 1');
{
    assert('Support does not hold the platform-earnings permission', !holds(3, 'money.earnings.platform.read') && !holds(2, 'money.earnings.platform.read'));
    const reward = {
        _id: new ObjectId(),
        partner_id: new ObjectId(),
        relationship_id: new ObjectId(),
        referred_user_id: new ObjectId(),
        category: 'vendor',
        commission_allocation_id: new ObjectId(),
        source_type: 'order',
        source_id: new ObjectId(),
        order_id: new ObjectId(),
        vendor_id: new ObjectId(),
        commission_earned: 7_000,
        share: { numerator: 6_000, denominator: 10_000 },
        rate_percent: 3,
        rate_source: 'global',
        amount: 126,
        clawed_amount: 54,
        currency: 'XAF',
        status: 'released',
        earned_at: new Date(),
        matures_at: new Date(),
        adjustments: [{ at: new Date(), commission_retained: 4_000, amount_before: 126, amount_after: 72 }],
    } as unknown as ReferralRewardReadModel;

    const full = toRewardDto(reward, { name: 'Vera', phone: null, email: null }, true);
    assert('tier 1 sees the commission', full.commissionEarned === 7_000 && full.commissionWithheld === false && full.adjustments[0].commissionRetained === 4_000);
    const withheld = toRewardDto(reward, undefined, false);
    assert('below it the figures are null, and it says so', withheld.commissionEarned === null && withheld.commissionWithheld === true && withheld.adjustments[0].commissionRetained === null);
    assert('the reward itself stays visible', withheld.amount === 126 && withheld.remaining === 72 && withheld.sharePercent === 60);
}

console.log('\n3. Settings and detail');
{
    const empty = toSettingsDto(null);
    assert('no settings document reads as the defaults, with the program off',
        empty.enabled === false && empty.minPayoutAmount === 1_000 && empty.rewardWaitDays === 14
        && (empty.terms as any).vendor.ratePercent === 3 && (empty.terms as any).agency.durationMonths === 6);

    const partner = {
        _id: new ObjectId(),
        user_id: new ObjectId(),
        applied_as_role: 'customer',
        status: 'suspended',
        applied_at: new Date(),
        created_at: new Date(),
        custom_terms: { vendor: { rate_percent: 5, duration_months: null }, agency: null },
    } as unknown as ReferralPartnerReadModel;
    const detail = toPartnerDetailDto(partner, undefined, undefined, empty, { referred: 2, earning: 1 });
    assert('a custom rate is marked, and its duration still inherits', (detail.terms as any).vendor.ratePercent === 5 && (detail.terms as any).vendor.rateIsCustom === true
        && (detail.terms as any).vendor.durationMonths === 6 && (detail.terms as any).vendor.durationIsCustom === false);
    assert('a category with no custom terms inherits both', (detail.terms as any).agency.ratePercent === 3 && (detail.terms as any).agency.rateIsCustom === false);
    assert('a suspended partner with no release is frozen', detail.balanceFrozen === true);
    assert('a detail carries no payout destination', !('payoutDetails' in detail) && !JSON.stringify(detail).includes('phone_number'));
}

console.log('\n4. Filters and validators');
{
    const userId = new ObjectId();
    const filter = buildPartnerFilter({ status: 'pending', search: 'ulrich' }, [userId]) as any;
    assert('a search matches a code by prefix, upper-cased', filter.$or[0].code.source === '^ULRICH');
    assert('and the people it resolved to', filter.$or[1].user_id.$in[0] === userId);
    assert('a term matching nobody still only matches codes', buildPartnerFilter({ search: 'x' }, []).$or !== undefined);
    assert('the regex is escaped', (buildPartnerFilter({ search: 'a.b' }, []) as any).$or[0].code.source.includes('\\.'));

    const orderId = new ObjectId().toString();
    const parsed = ListRewardsQuerySchema.parse({ orderId });
    assert('rewards can be found by order', (buildRewardFilter(parsed) as any).order_id.toString() === orderId);

    assert('a rate above 25 is refused', !UpdateSettingsSchema.safeParse({ terms: { vendor: { ratePercent: 25.5 } } }).success);
    assert('25 is allowed', UpdateSettingsSchema.safeParse({ terms: { vendor: { ratePercent: 25 } } }).success);
    assert('a rate has at most two decimals', !UpdateSettingsSchema.safeParse({ terms: { vendor: { ratePercent: 3.123 } } }).success);
    assert('a duration is whole months', !UpdateSettingsSchema.safeParse({ terms: { vendor: { durationMonths: 1.5 } } }).success);
    assert('there is no agent rate to set', !UpdateSettingsSchema.safeParse({ terms: { agent: { ratePercent: 3 } } }).success);
    assert('null resets a per-partner field', UpdatePartnerTermsSchema.safeParse({ terms: { vendor: { ratePercent: null } } }).success);
    assert('a global rate cannot be null', !UpdateSettingsSchema.safeParse({ terms: { vendor: { ratePercent: null } } }).success);
    assert('rejecting needs a reason', !RequiredReasonSchema.safeParse({}).success);
}

console.log('\n5. Wiring');
{
    const routes = read('modules/referrals/routes/referral.routes.ts');
    const writes = routes.split('defineRoute(router,').slice(1).filter((block) => /method: '(post|patch)'/.test(block));
    assert('every write route records an audit action', writes.length === 9 && writes.every((block) => block.includes('audit: records(')));
    assert('no route is a raw router call', !/router\.(get|post|patch|put|delete)\(/.test(routes));

    const gateway = read('modules/referrals/gateways/referral.gateway.ts');
    assert('writes go through the audited attempt', gateway.includes('auditedAttempt('));
    assert('and only to jovi-mall', gateway.includes('/api/internal/admin/referrals') && gateway.includes('platformRequest'));

    const repository = read('modules/referrals/repositories/referral.read.repository.ts');
    assert('payout_details is never projected', !/^\s+payout_details: 1/m.test(repository));
}

console.log('\n6. The two repositories agree');
{
    const rules = readFileSync(join(ROOT, '..', 'jovi-mall', 'src', 'modules', 'referrals', 'domain', 'referral-rules.ts'), 'utf8');
    const dto = read('modules/referrals/read-models/referral.dto.ts');
    assert('the rate cap is 25 on both sides', rules.includes('RATE_MAX_PERCENT = 25') && read('modules/referrals/validators/referral.validator.ts').includes('.max(25)'));
    assert('the duration cap is 120 on both sides', rules.includes('DURATION_MAX_MONTHS = 120') && read('modules/referrals/validators/referral.validator.ts').includes('.max(120)'));
    for (const [key, value] of [['ratePercent', '3'], ['durationMonths', '6'], ['minPayoutAmount', '1_000'], ['rewardWaitDays', '14'], ['enabled', 'false']]) {
        assert(`the default ${key} matches`, rules.includes(`${key}: ${value},`) && dto.includes(`${key}: ${value},`));
    }
}

console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
