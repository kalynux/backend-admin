import { ContractReadModel } from '../../agencies/repositories/contract.read.repository';
import { AgencyReadModel } from '../../agencies/repositories/agency.read.repository';
import { AgentReadModel } from '../../agents/repositories/agent.read.repository';
import { BillingSettingsReadModel } from '../../billing/repositories/billing-settings.read.repository';
import { SubscriberPlanReadModel } from '../../billing/repositories/subscriber-plan.read.repository';
import { CodCashAccountReadModel, CodCashLedgerReadModel } from '../../cod/repositories/cod-cash.read.repository';
import { EarningsLedgerReadModel, EarningsReserveHoldReadModel } from '../../money/repositories/earnings.read.repository';
import { PayoutRequestReadModel } from '../../money/repositories/payout-request.read.repository';
import { PayoutDestinationDto, toMaskedDestinationDto } from '../../money/read-models/payout-destination.dto';
import { VendorReadModel } from '../../vendors/repositories/vendor.read.repository';
import { PlatformBalances, PlatformEntitlements } from '../gateways/account.gateway';
import {
    CreditTopupReadModel,
    CreditTransactionReadModel,
    CreditWalletReadModel,
} from '../repositories/credit.read.repository';
import { PlanPurchaseReadModel } from '../repositories/plan-purchase.read.repository';
import { AccountOwnerType } from '../validators/account.validator';

/**
 * One party's financial account, on the wire.
 *
 * ── The problem this shape exists to solve ────────────────────────────────────
 * An owner has **three unrelated balance models** — a credit wallet, an earnings account and
 * a COD cash account — plus per-contract counters. They are denominated differently, they
 * point in opposite directions, and two of them are not even money. Adding any two of them
 * produces a number that means nothing, and the failure is silent: it renders.
 *
 * Five mechanisms make that mistake hard to make rather than merely discouraged.
 *
 *   1. **No top-level `balance`, `total` or `amount`.** Every number lives inside a named
 *      object, so nothing can be summed without first naming what it is.
 *   2. **Every balance object carries `unit`** — `'money'` or `'credit'`. A credit balance's
 *      `currency` is `null`, not `'XAF'`, because a credit is not denominated in anything.
 *   3. **Every balance object carries `direction`**, which is the field that actually stops
 *      the arithmetic: earnings are `owed_to_owner`, credits are `spendable_by_owner`, and
 *      COD cash is a LIABILITY the owner owes. Two balances with opposite directions are not
 *      addable, and the DTO says so in the data rather than in a comment.
 *   4. **`null` means "does not apply to this owner kind"; `0` means "applies, currently
 *      empty".** A vendor gets `codCash: null` — a vendor never collects cash and *cannot*
 *      owe it. A settled agent gets `codCash: { held: 0 }`. Conflating those is the
 *      difference between *cannot owe* and *owes nothing*.
 *   5. **There is no grand total, and this is the comment that says why.** Even
 *      `pending + available + reserve + requested` is omitted: that arithmetic belongs to
 *      jovi-mall and `getBalances` does not return it, so producing it here would be this
 *      service inventing a number the platform never states.
 *
 * ── Two places this deviates from the phase plan, deliberately ────────────────
 *  - **`codCash.direction` is `owed_to_agency` for an AGENT**, not `owed_to_platform`. The
 *    plan wrote one value for both; `cod-cash-account.model.ts` says otherwise in as many
 *    words — an agent's cash is owed to their AGENCY, and the agency's is owed to the
 *    PLATFORM, which is exactly why a deposit and a remittance are different verbs. A
 *    liability label naming the wrong creditor is the class of error this DTO exists to
 *    prevent, so it names the real one.
 *  - **`subscription` is always an object**, with `planId`/`status`/`expiresAt` null when
 *    there is no active plan. The plan sketched it nullable, but `entitlements` lives inside
 *    it, and a null subscription would take the entitlements block with it — making "no
 *    plan" and "we could not determine the plan" the same shape. Every owner kind on this
 *    mount can hold a plan, so by mechanism 4 the object applies and its FIELDS are what go
 *    null.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Balances
// ─────────────────────────────────────────────────────────────────────────────

/** What a balance is denominated in. `'credit'` is not money and never converts to it. */
export type BalanceUnit = 'money' | 'credit';

/**
 * Who owes whom. The field that stops two balances being added.
 *
 * `owed_to_agency` exists because an agent's COD cash is owed to their agency rather than to
 * the platform — see the header.
 */
export type BalanceDirection =
    | 'owed_to_owner'
    | 'spendable_by_owner'
    | 'owed_to_platform'
    | 'owed_to_agency';

/**
 * What the platform owes this owner, as jovi-mall reconciles it.
 *
 * A DELEGATED verdict, not a read of `earnings_accounts` — the four sub-balances only move
 * inside jovi-mall's transactions and a second derivation of them would be a second opinion
 * about how much money exists. They are NOT summed here; see mechanism 5.
 */
export interface EarningsBalanceDto {
    unit: 'money';
    currency: string | null;
    direction: 'owed_to_owner';
    /** In escrow — allocated and not yet releasable. */
    pending: number;
    /** Withdrawable now. */
    available: number;
    /** An agency's COD rolling reserve, held back against discrepancies. */
    reserve: number;
    /** Already asked for through a payout request and not yet paid. */
    requested: number;
}

/** Metered-action units. No currency, no expiry, and they can never be paid out. */
export interface CreditBalanceDto {
    unit: 'credit';
    /** Always `null`. A credit is not denominated in anything — mechanism 2. */
    currency: null;
    direction: 'spendable_by_owner';
    balance: number;
    /**
     * `false` when the owner has no wallet row yet — it is created lazily, on the first
     * allowance or top-up. The balance still reads `0`, because a missing wallet and an
     * empty one are the same amount of credit; this flag is what tells them apart for
     * anybody debugging why a grant did not land.
     */
    walletExists: boolean;
}

/** Cash the owner is holding and owes onward. A LIABILITY, which `direction` states. */
export interface CodCashBalanceDto {
    unit: 'money';
    currency: string | null;
    direction: 'owed_to_platform' | 'owed_to_agency';
    held: number;
    lastMovementAt: string | null;
}

export interface AccountBalancesDto {
    earnings: EarningsBalanceDto;
    credits: CreditBalanceDto;
    /** `null` for a vendor — mechanism 4. A vendor never collects cash and cannot owe it. */
    codCash: CodCashBalanceDto | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// The rest of the account
// ─────────────────────────────────────────────────────────────────────────────

export interface AccountOwnerDto {
    type: AccountOwnerType;
    id: string;
    /** The BUSINESS name where there is one — a vendor's Store, an agency's Magazin. */
    name: string | null;
    /** The platform user behind the party. The join key for `/users/:id`. */
    userId: string | null;
    status: string;
    suspended: boolean;
    suspendedReason: string | null;
    createdAt: string | null;
}

/**
 * Contact and verification, named per owner kind.
 *
 * **The two KYC fields are not interchangeable and each is `null` where its owner kind does
 * not record it.** A vendor and an agent carry a KYC *status* string; an agency carries a
 * verification *boolean* and no status enum at all. Collapsing the two would mean inventing
 * a status word for agencies — a vocabulary this service does not own and jovi-mall never
 * writes.
 */
export interface AccountProfileDto {
    email: string | null;
    emailVerified: boolean;
    phone: string | null;
    phoneVerified: boolean;
    country: string | null;
    timezone: string | null;
    preferredLanguage: string | null;
    /** Vendor and agent only. `null` for an agency, which records `kycVerified` instead. */
    kycStatus: string | null;
    /** Agency and vendor only. `null` for an agent, whose `kycStatus` carries it. */
    kycVerified: boolean | null;
    kycVerifiedAt: string | null;
    kycRejectionReason: string | null;
    onboardingStep: number | null;
}

export interface ActorStampDto {
    id: string;
    /** `'admin'` means a wi-admin id, which resolves in NEITHER database's users. */
    source: string;
    name: string | null;
}

export interface EntitlementsDto {
    planCode: string | null;
    commissionPercent: number | null;
    maxActiveProducts: number | null;
    maxStorageBytes: number | null;
    maxUnterminatedShipments: number | null;
    liveTrackingEnabled: boolean | null;
}

export interface SubscriptionDto {
    subscriberPlanId: string | null;
    planId: string | null;
    planCode: string | null;
    planName: string | null;
    /** `null` means no active plan — the whole block's fields go null together. */
    status: string | null;
    startedAt: string | null;
    expiresAt: string | null;
    /**
     * From `billing_settings`, so "expires in N days" is rendered against the platform's own
     * notice period rather than a number this service picked.
     */
    notifyDaysBeforeExpiry: number | null;
    assignedBy: ActorStampDto | null;
    paymentReference: string | null;
    allowanceGranted: boolean | null;
    /** A DELEGATED verdict — what the plan allows, as the platform itself computes it. */
    entitlements: EntitlementsDto;
}

export interface CodContractExposureDto {
    contractId: string;
    agencyId: string;
    agentId: string;
    status: string;
    /** Cash collected under this contract and not yet settled to the agency. */
    outstandingBalance: number | null;
    /** Fees the agency owes the agent for completed work. The other direction. */
    outstandingToAgent: number | null;
    /** The contract's own COD ceiling. `0` **blocks all COD** rather than meaning no limit. */
    maxThreshold: number | null;
    lastSettledAt: string | null;
}

export interface ReserveHoldDto {
    id: string;
    amount: number;
    currency: string | null;
    heldAt: string | null;
    releaseAt: string | null;
    released: boolean;
}

export interface CodExposureDto {
    contracts: CodContractExposureDto[];
    /**
     * Agency only — the rolling-reserve slices waiting to mature. `null` for an agent, who
     * has no reserve: `earnings_reserve_holds.owner_type` is fixed to `'agency'`.
     */
    reserveHolds: ReserveHoldDto[] | null;
}

export interface AccountPayoutsSummaryDto {
    pendingCount: number;
    pendingAmount: number | null;
    currency: string | null;
    lastPaidAt: string | null;
    lastPaidAmount: number | null;
    /**
     * MASKED, always — `full: null, revealed: false`. Where the owner's most recent request
     * was addressed, which is a hint about where the next one would go rather than a promise:
     * each request freezes its own snapshot, which is the whole point of snapshotting it.
     *
     * The digits live behind `GET /money/payouts/:payoutId/destination` alone, which is
     * gated on its own permission and audited on every call.
     */
    destination: PayoutDestinationDto | null;
}

/**
 * The four things that make an account worth looking at, as opposed to worth reading.
 *
 * `null` on a flag carries mechanism 4's meaning: the question does not apply to this owner
 * kind, which is different from "no, none".
 */
export interface AccountFlagsDto {
    /** Unresolved cash discrepancies. `null` for a vendor, who has none by construction. */
    openDiscrepancies: number | null;
    /** Allocations whose COD cash the platform has NOT physically received. */
    unsettledCollections: number;
    /** When the owner was last warned they were at their shipment cap. */
    shipmentCapAlertedAt: string | null;
    /**
     * Agent only: their held cash has reached `cod.max_threshold`, the ceiling that stops
     * further dispatch. `null` for a vendor (no cash) and for an agency (no single ceiling —
     * an agency's exposure is bounded per contract, which `codExposure` shows instead).
     */
    overCodThreshold: boolean | null;
}

export interface AccountDto {
    owner: AccountOwnerDto;
    profile: AccountProfileDto;
    subscription: SubscriptionDto;
    balances: AccountBalancesDto;
    /** Agent and agency only — a vendor has no COD exposure of any kind. */
    codExposure: CodExposureDto | null;
    payouts: AccountPayoutsSummaryDto;
    flags: AccountFlagsDto;
}

// ─────────────────────────────────────────────────────────────────────────────
// The activity feed
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `plan` · `credit` · `earning` · `payout`.
 *
 * jovi-mall's `TransactionCategory`, and `payout` is the one it declared and never filled —
 * "reserved for when cash-out is built", says its docstring. Cash-out has been built for a
 * while; this feed is where those rows finally appear.
 */
export const ACTIVITY_CATEGORIES = ['plan', 'credit', 'earning', 'payout'] as const;
export type ActivityCategory = (typeof ACTIVITY_CATEGORIES)[number];

/**
 * One normalised movement.
 *
 * Modelled on jovi-mall's `VendorTransaction` so the two feeds read the same, with one
 * systematic change: its optional `currency?` / `credits?` / `gateway?` / `source?` are
 * **required-and-nullable** here (ADR-005 D-16). A key that vanishes makes "this row has no
 * gateway" and "this client is out of date" indistinguishable.
 */
export interface AccountActivityDto {
    /** The SOURCE document's id — not synthetic, so a row can be looked up where it lives. */
    id: string;
    category: ActivityCategory;
    /** `plan_purchase` · `credit_topup` · `credit_allowance` · `earning_hold` · `payout_request` … */
    type: string;
    status: string;
    unit: BalanceUnit;
    /** From the OWNER's perspective: value arriving vs leaving. */
    direction: 'in' | 'out';
    /** Magnitude in `unit`, always positive. The sign lives in `direction`. */
    amount: number;
    currency: string | null;
    /** Credits granted or moved. `null` on a row that moves no credit. */
    credits: number | null;
    description: string;
    gateway: string | null;
    source: { type: string; id: string } | null;
    createdAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// The three sub-list rows
// ─────────────────────────────────────────────────────────────────────────────

export interface CreditTransactionDto {
    id: string;
    /** `allowance` · `topup` · `debit` · `adjustment` · `refund`. */
    type: string;
    reasonCode: string;
    /** **Signed** here, unlike the activity feed: this is the ledger, and it reads as one. */
    amount: number;
    balanceAfter: number;
    /** Whatever caused it — a product id, a message id, a plan id. Free-form in jovi-mall. */
    ref: string | null;
    createdAt: string | null;
}

export interface CashLedgerEntryDto {
    id: string;
    entryType: string;
    amount: number;
    balanceAfter: number;
    ref: { type: string; id: string } | null;
    createdAt: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mappers
// ─────────────────────────────────────────────────────────────────────────────

function toIso(value: Date | null | undefined): string | null {
    if (!value) return null;
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toId(value: { toString(): string } | null | undefined): string | null {
    return value ? value.toString() : null;
}

/** The owner document, whichever kind it is. Narrowed by `ownerType` at every read. */
export type AccountOwnerRow = VendorReadModel | AgencyReadModel | AgentReadModel;

/** Everything one account view needs, gathered by the controller and mapped here. */
export interface AccountSources {
    ownerType: AccountOwnerType;
    ownerId: string;
    owner: AccountOwnerRow;
    /** The BUSINESS name — a vendor's Store, an agency's Magazin, an agent's own name. */
    ownerName: string | null;
    balances: PlatformBalances;
    entitlements: PlatformEntitlements;
    subscription: SubscriberPlanReadModel | null;
    planName: string | null;
    billingSettings: BillingSettingsReadModel | null;
    wallet: CreditWalletReadModel | null;
    codCash: CodCashAccountReadModel | null;
    contracts: ContractReadModel[];
    reserveHolds: EarningsReserveHoldReadModel[];
    pendingPayout: PayoutRequestReadModel | null;
    lastPaidPayout: PayoutRequestReadModel | null;
    openDiscrepancies: number | null;
    unsettledCollections: number;
}

export function toAccountDto(sources: AccountSources): AccountDto {
    return {
        owner: toOwnerDto(sources),
        profile: toProfileDto(sources),
        subscription: toSubscriptionDto(sources),
        balances: toBalancesDto(sources),
        codExposure: toCodExposureDto(sources),
        payouts: toPayoutsSummaryDto(sources),
        flags: toFlagsDto(sources),
    };
}

function toOwnerDto(sources: AccountSources): AccountOwnerDto {
    const owner = sources.owner as Record<string, unknown>;
    const suspendedAt = owner.suspended_at as Date | null | undefined;
    const banned = (owner.platform_ban as { banned?: boolean; reason?: string | null } | undefined);

    /**
     * Two owner kinds record a stop differently and this is the one place that is reconciled:
     * a vendor is `suspended_at`, an agent is `platform_ban.banned`. An agency has neither —
     * it is deactivated through `status` — so `suspended` is false and `status` carries it.
     */
    const suspended = Boolean(suspendedAt) || Boolean(banned?.banned);

    return {
        type: sources.ownerType,
        id: sources.ownerId,
        name: sources.ownerName,
        userId: toId(owner.user_id as { toString(): string } | undefined),
        status: String(owner.status ?? 'unknown'),
        suspended,
        suspendedReason: suspended
            ? ((owner.suspended_reason as string | null | undefined)
                ?? banned?.reason
                ?? (owner.status_reason as string | null | undefined)
                ?? null)
            : null,
        createdAt: toIso(owner.created_at as Date | undefined),
    };
}

function toProfileDto(sources: AccountSources): AccountProfileDto {
    const owner = sources.owner as Record<string, unknown>;
    const kycDetails = owner.kyc_details as Record<string, unknown> | undefined;
    const agentKyc = owner.kyc as Record<string, unknown> | undefined;
    const kyc = sources.ownerType === 'agent' ? agentKyc : kycDetails;

    return {
        email: (owner.email as string | null | undefined) ?? null,
        emailVerified: Boolean(owner.email_verified),
        phone: (owner.phone as string | null | undefined) ?? null,
        phoneVerified: Boolean(owner.phone_verified),
        country: (owner.country as string | null | undefined) ?? null,
        timezone: (owner.timezone as string | null | undefined) ?? null,
        preferredLanguage: (owner.preferred_language as string | null | undefined) ?? null,
        // An agency has no KYC status enum, only a boolean — see the interface.
        kycStatus: sources.ownerType === 'agency' ? null : ((kyc?.status as string | undefined) ?? null),
        kycVerified: sources.ownerType === 'agent'
            ? null
            : Boolean(
                (owner.legit_verified as boolean | undefined)
                ?? (kycDetails?.legit_verified as boolean | undefined),
            ),
        kycVerifiedAt: toIso(kyc?.verified_at as Date | null | undefined),
        kycRejectionReason: (kyc?.rejection_reason as string | null | undefined) ?? null,
        onboardingStep: (owner.onboarding_step as number | undefined) ?? null,
    };
}

function toSubscriptionDto(sources: AccountSources): SubscriptionDto {
    const row = sources.subscription;

    return {
        subscriberPlanId: row ? row._id.toString() : null,
        planId: row ? toId(row.plan_id) : null,
        planCode: row?.plan_code ?? null,
        planName: sources.planName,
        status: row?.status ?? null,
        startedAt: toIso(row?.started_at),
        expiresAt: toIso(row?.expires_at),
        notifyDaysBeforeExpiry: sources.billingSettings?.notify_days_before_expiry ?? null,
        // Keyed on the id: a stamp rendered without checking whether there IS an actor reads
        // as "assigned by nobody, source platform", which is a claim rather than an absence.
        assignedBy: row?.assigned_by
            ? {
                id: row.assigned_by.toString(),
                source: row.assigned_by_source ?? 'platform',
                name: row.assigned_by_name ?? null,
            }
            : null,
        paymentReference: row?.payment_reference ?? null,
        allowanceGranted: row ? Boolean(row.allowance_granted) : null,
        entitlements: {
            planCode: sources.entitlements.planCode ?? null,
            commissionPercent: sources.entitlements.commissionPercent ?? null,
            maxActiveProducts: sources.entitlements.maxActiveProducts ?? null,
            maxStorageBytes: sources.entitlements.maxStorageBytes ?? null,
            maxUnterminatedShipments: sources.entitlements.maxUnterminatedShipments ?? null,
            liveTrackingEnabled: sources.entitlements.liveTrackingEnabled ?? null,
        },
    };
}

function toBalancesDto(sources: AccountSources): AccountBalancesDto {
    return {
        earnings: {
            unit: 'money',
            currency: sources.balances.currency ?? null,
            direction: 'owed_to_owner',
            pending: sources.balances.pending ?? 0,
            available: sources.balances.available ?? 0,
            reserve: sources.balances.reserve ?? 0,
            requested: sources.balances.requested ?? 0,
        },
        credits: {
            unit: 'credit',
            currency: null,
            direction: 'spendable_by_owner',
            balance: sources.wallet?.balance ?? 0,
            walletExists: sources.wallet !== null,
        },
        codCash: holdsCodCash(sources.ownerType)
            ? {
                unit: 'money',
                currency: sources.codCash?.currency ?? null,
                // An agent owes their AGENCY; an agency owes the PLATFORM. See the header.
                direction: sources.ownerType === 'agent' ? 'owed_to_agency' : 'owed_to_platform',
                held: sources.codCash?.balance ?? 0,
                lastMovementAt: toIso(sources.codCash?.updated_at),
            }
            : null,
    };
}

function toCodExposureDto(sources: AccountSources): CodExposureDto | null {
    if (!holdsCodCash(sources.ownerType)) return null;

    return {
        contracts: sources.contracts.map((contract) => ({
            contractId: contract._id.toString(),
            agencyId: contract.agency_id.toString(),
            agentId: contract.agent_id.toString(),
            status: contract.status,
            outstandingBalance: contract.cod?.outstanding_balance ?? null,
            outstandingToAgent: contract.payment?.outstanding_to_agent ?? null,
            maxThreshold: contract.cod?.threshold ?? null,
            lastSettledAt: toIso(contract.cod?.last_settled_at),
        })),
        // Fixed to agencies by the collection itself — an agent has no rolling reserve.
        reserveHolds: sources.ownerType === 'agency'
            ? sources.reserveHolds.map((hold) => ({
                id: hold._id.toString(),
                amount: hold.amount,
                currency: hold.currency ?? null,
                heldAt: toIso(hold.held_at),
                releaseAt: toIso(hold.release_at),
                released: hold.status === 'released',
            }))
            : null,
    };
}

function toPayoutsSummaryDto(sources: AccountSources): AccountPayoutsSummaryDto {
    const pending = sources.pendingPayout;
    const paid = sources.lastPaidPayout;

    /**
     * The pending request first, then the last paid one. `payout_requests` carries a partial
     * unique index on `(owner_type, owner_id)` where `status: 'pending'`, so there is at most
     * ONE pending request per owner — which is why `pendingCount` is 0 or 1 and never a
     * count worth aggregating.
     */
    const withDestination = pending ?? paid;

    return {
        pendingCount: pending ? 1 : 0,
        pendingAmount: pending?.amount ?? null,
        currency: pending?.currency ?? paid?.currency ?? null,
        lastPaidAt: toIso(paid?.resolved_at),
        lastPaidAmount: paid?.amount ?? null,
        destination: toMaskedDestinationDto(withDestination?.payout_method_snapshot),
    };
}

function toFlagsDto(sources: AccountSources): AccountFlagsDto {
    const agent = sources.ownerType === 'agent' ? (sources.owner as AgentReadModel) : null;
    const ceiling = agent?.cod?.max_threshold ?? null;

    return {
        openDiscrepancies: sources.openDiscrepancies,
        unsettledCollections: sources.unsettledCollections,
        shipmentCapAlertedAt: toIso(sources.billingSettings?.shipment_cap_alerted_at),
        // `>=`, not `>`: `max_threshold` is the ceiling dispatch refuses AT, and a `0`
        // threshold blocks all COD rather than meaning "no limit".
        overCodThreshold: ceiling === null
            ? null
            : (sources.codCash?.balance ?? 0) >= ceiling,
    };
}

/** Vendors never collect cash. Agents and agencies do, in opposite directions. */
function holdsCodCash(ownerType: AccountOwnerType): boolean {
    return ownerType === 'agent' || ownerType === 'agency';
}

// ─────────────────────────────────────────────────────────────────────────────
// Activity mappers — one per source, mirroring jovi-mall's VendorTransactionService
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reason code → the fine-grained `type` and the human description, copied from jovi-mall's
 * `VendorTransactionService` so the same movement reads the same on both surfaces.
 *
 * The two top-up reason codes are absent on purpose: those rows never reach this mapper,
 * because `credit_topups` already describes the event and the repository filters them out.
 */
const CREDIT_TYPE_BY_REASON: Record<string, string> = {
    plan_allowance: 'credit_allowance',
    vectorisation: 'credit_usage',
    whatsapp_template: 'credit_usage',
    admin_adjustment: 'credit_adjustment',
};

const CREDIT_DESCRIPTION_BY_REASON: Record<string, string> = {
    plan_allowance: 'Plan credit allowance',
    vectorisation: 'Product vectorisation',
    whatsapp_template: 'WhatsApp template message',
    admin_adjustment: 'Admin credit adjustment',
};

export function toPlanPurchaseActivity(row: PlanPurchaseReadModel): AccountActivityDto {
    return {
        id: row._id.toString(),
        category: 'plan',
        type: 'plan_purchase',
        status: row.status,
        unit: 'money',
        direction: 'out',
        amount: row.price,
        currency: row.currency,
        credits: null,
        description: `Plan purchase — ${row.plan_code}`,
        gateway: row.gateway ?? null,
        source: { type: 'plan', id: row.plan_code },
        createdAt: toIso(row.created_at) ?? '',
    };
}

/**
 * The one row that is money AND credits: the owner paid `price` and received `credits`.
 *
 * `unit: 'money'` because the MOVEMENT being described is the payment — the credits arriving
 * are reported beside it rather than as a second row, which is how jovi-mall renders it and
 * the only way a reader can see the exchange rate they actually got.
 */
export function toTopupActivity(row: CreditTopupReadModel): AccountActivityDto {
    return {
        id: row._id.toString(),
        category: 'credit',
        type: 'credit_topup',
        status: row.status,
        unit: 'money',
        direction: 'out',
        amount: row.price,
        currency: row.currency,
        credits: row.credits,
        description: `Credit top-up — ${row.credits} credits (${row.pack_code})`,
        gateway: row.gateway ?? null,
        source: { type: 'pack', id: row.pack_code },
        createdAt: toIso(row.created_at) ?? '',
    };
}

export function toCreditActivity(row: CreditTransactionReadModel): AccountActivityDto {
    return {
        id: row._id.toString(),
        category: 'credit',
        type: CREDIT_TYPE_BY_REASON[row.reason_code] ?? 'credit_movement',
        // A credit ledger row is written inside the transaction that moved the balance, so
        // it is complete the moment it exists — there is no pending credit movement.
        status: 'completed',
        unit: 'credit',
        direction: row.amount >= 0 ? 'in' : 'out',
        amount: Math.abs(row.amount),
        currency: null,
        credits: Math.abs(row.amount),
        description: CREDIT_DESCRIPTION_BY_REASON[row.reason_code] ?? 'Credit movement',
        gateway: null,
        source: row.ref ? { type: 'credit', id: row.ref } : null,
        createdAt: toIso(row.created_at) ?? '',
    };
}

/**
 * `earnings_ledgers` rows carry no currency of their own — the account holds it, and the
 * caller reads it once for the page. `null` when the owner has no earnings account, which is
 * consistent: no account means no ledger rows either.
 */
export function toEarningActivity(
    row: EarningsLedgerReadModel,
    currency: string | null,
): AccountActivityDto {
    const description = row.entry_type === 'hold'
        ? `Earning held from ${row.source_type} sale`
        : row.entry_type === 'release'
            ? 'Earning released to available balance'
            : 'Earning reversed (refund)';

    return {
        id: row._id.toString(),
        category: 'earning',
        type: `earning_${row.entry_type}`,
        // The entry type IS the status on an append-only ledger: a `hold` row does not later
        // become a `release` one, a second row does.
        status: row.entry_type,
        unit: 'money',
        direction: row.entry_type === 'reversal' ? 'out' : 'in',
        amount: row.amount,
        currency,
        credits: null,
        description,
        gateway: null,
        source: { type: row.source_type, id: row.source_id.toString() },
        createdAt: toIso(row.created_at) ?? '',
    };
}

/**
 * The `payout` category jovi-mall reserved and never filled.
 *
 * `direction: 'out'` — money leaving the owner's platform balance for their bank. It is the
 * counterpart of `earning_release`, which is `in`, and the pair is what makes the feed add
 * up when read from top to bottom.
 *
 * **No destination**, masked or otherwise. A feed row is not the place to reason about where
 * money was sent, and putting one here would put a beneficiary's details on an endpoint
 * whose permission set does not include `money.payouts.destination.read`.
 */
export function toPayoutActivity(row: PayoutRequestReadModel): AccountActivityDto {
    return {
        id: row._id.toString(),
        category: 'payout',
        type: 'payout_request',
        status: row.status,
        unit: 'money',
        direction: 'out',
        amount: row.amount,
        currency: row.currency,
        credits: null,
        description: row.origin === 'auto_threshold'
            ? 'Automatic payout at the withdrawal threshold'
            : 'Payout requested',
        gateway: null,
        source: row.ticket_id ? { type: 'ticket', id: row.ticket_id.toString() } : null,
        createdAt: toIso(row.created_at) ?? '',
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-list mappers
// ─────────────────────────────────────────────────────────────────────────────

export function toCreditTransactionDto(row: CreditTransactionReadModel): CreditTransactionDto {
    return {
        id: row._id.toString(),
        type: row.type,
        reasonCode: row.reason_code,
        amount: row.amount,
        balanceAfter: row.balance_after,
        ref: row.ref ?? null,
        createdAt: toIso(row.created_at),
    };
}

export function toCashLedgerEntryDto(row: CodCashLedgerReadModel): CashLedgerEntryDto {
    return {
        id: row._id.toString(),
        entryType: row.entry_type,
        amount: row.amount,
        balanceAfter: row.balance_after,
        ref: row.ref_type && row.ref_id
            ? { type: row.ref_type, id: row.ref_id.toString() }
            : null,
        createdAt: toIso(row.created_at),
    };
}

export function toCreditWalletDto(wallet: CreditWalletReadModel | null): CreditBalanceDto {
    return {
        unit: 'credit',
        currency: null,
        direction: 'spendable_by_owner',
        balance: wallet?.balance ?? 0,
        walletExists: wallet !== null,
    };
}
