import { Schema } from 'mongoose';
import { z } from 'zod';

/**
 * ─── Where the company pays a member of its own staff ────────────────────────
 *
 * The same three destination kinds a vendor, an agency and an agent configure, under the
 * same rules, because "how do I get paid" is one question and an employee asking it should
 * see the same form and hit the same validation.
 *
 * ── ⚠ THIS IS A DELIBERATE COPY of jovi-mall's `core/types/payout.types.ts` ──
 * There is no shared package between the two services, by the architecture's own statement,
 * and this shape has to exist on both sides: jovi-mall's belongs to platform owners whose
 * money moves through its earnings engine, and this one belongs to staff whose salary does
 * not touch that engine at all. It is copied rather than delegated for the reason wi-admin
 * keeps a copy of `storage-trees.ts`: pure frozen constants with no behaviour and no
 * dependency graph.
 *
 * ⚠ **Unlike `storage-trees.ts`, NOTHING keeps this in step with the original, and it does
 * not need to.** That file is copied because a stale copy publishes a private URL — the two
 * sides describe one fact and must agree. These two describe DIFFERENT facts: a vendor's
 * payout destination and an employee's salary destination are separate records about
 * separate people, and the day the platform enables bank payouts for vendors is not
 * automatically the day it starts paying salaries into bank accounts. Diverging is allowed
 * here; that is the point of not sharing a switch.
 *
 * ── What is NOT copied, and must never be ────────────────────────────────────
 * The card branch stores brand + last4 + holder + expiry and **never a PAN or a CVV**. That
 * rule came from jovi-mall and it travels with the shape: storing a card number here would
 * put wi-admin's database into PCI-DSS scope to save an employee from typing four digits.
 */

// ─── Mongoose sub-schemas ────────────────────────────────────────────────────

const MobileMoneySubSchema = new Schema(
    {
        provider: { type: String, required: true, trim: true },
        phone_number: { type: String, required: true, trim: true },
        account_name: { type: String, required: true, trim: true },
    },
    { _id: false },
);

const BankSubSchema = new Schema(
    {
        bank_name: { type: String, required: true, trim: true },
        account_number: { type: String, required: true, trim: true },
        account_name: { type: String, required: true, trim: true },
        country: { type: String, required: true, trim: true },
    },
    { _id: false },
);

/** Lowercase and closed, so a dashboard badge is not keying off "Visa"/"VISA"/"visa ". */
export const CARD_BRANDS = [
    'visa', 'mastercard', 'amex', 'discover', 'unionpay', 'jcb', 'diners', 'verve', 'other',
] as const;

export type CardBrand = (typeof CARD_BRANDS)[number];

const CardSubSchema = new Schema(
    {
        brand: { type: String, enum: CARD_BRANDS, required: true },
        /** Last 4 PAN digits. Display only — never the routing value, and never the PAN. */
        last4: { type: String, required: true, trim: true },
        card_holder_name: { type: String, required: true, trim: true },
        expiry_month: { type: Number, required: true, min: 1, max: 12 },
        expiry_year: { type: Number, required: true },
        issuing_bank: { type: String, default: null, trim: true },
        country: { type: String, required: true, trim: true },
    },
    { _id: false },
);

export const PayoutMethodSchema = new Schema(
    {
        method: { type: String, enum: ['mobile_money', 'bank', 'card'], required: true },
        mobile_money: { type: MobileMoneySubSchema, default: null },
        bank: { type: BankSubSchema, default: null },
        card: { type: CardSubSchema, default: null },
    },
    { _id: false },
);

// ─── TypeScript ──────────────────────────────────────────────────────────────

export interface IMobileMoneyPayout {
    provider: string;
    phone_number: string;
    account_name: string;
}

export interface IBankPayout {
    bank_name: string;
    account_number: string;
    account_name: string;
    country: string;
}

export interface ICardPayout {
    brand: CardBrand;
    last4: string;
    card_holder_name: string;
    expiry_month: number;
    expiry_year: number;
    issuing_bank: string | null;
    country: string;
}

export type PayoutMethodKind = 'mobile_money' | 'bank' | 'card';

export const ALL_PAYOUT_METHODS: readonly PayoutMethodKind[] = ['mobile_money', 'bank', 'card'];

/**
 * ─── THE SWITCH ─────────────────────────────────────────────────────────────
 *
 * Payout kinds open for NEW configuration right now. All three are built, validated, masked
 * and documented — bank and card are switched off at the WRITE PATH only, mirroring
 * jovi-mall's own switch, which today enables `mobile_money` alone.
 *
 * A write-path gate rather than a schema deletion, so a stored entry of a disabled kind still
 * reads back and still masks correctly. The one consequence worth knowing: a write is a FULL
 * REPLACE, so an employee whose stored list contains a disabled kind cannot re-send it
 * unchanged — they must replace that entry. Omitting the field leaves the stored list alone.
 *
 * ⚠ **This is wi-admin's own switch and it is free to differ from jovi-mall's.** See the
 * header: the two lists describe different people's money.
 */
export const ENABLED_PAYOUT_METHODS: readonly PayoutMethodKind[] = ['mobile_money'];

const PAYOUT_METHOD_LABELS: Record<PayoutMethodKind, string> = {
    mobile_money: 'Mobile money',
    bank: 'Bank transfer',
    card: 'Card',
};

export function isPayoutMethodEnabled(method: string): boolean {
    return (ENABLED_PAYOUT_METHODS as readonly string[]).includes(method);
}

export function payoutMethodUnavailableMessage(method: PayoutMethodKind): string {
    const enabled = ENABLED_PAYOUT_METHODS.map((m) => PAYOUT_METHOD_LABELS[m].toLowerCase());
    return `${PAYOUT_METHOD_LABELS[method]} payouts are not available right now. Currently accepted: ${enabled.join(', ')}.`;
}

export interface IEmployeePayoutMethod {
    method: PayoutMethodKind;
    mobile_money: IMobileMoneyPayout | null;
    bank: IBankPayout | null;
    card: ICardPayout | null;
}

// ─── Read-side masking ───────────────────────────────────────────────────────

/**
 * A payout destination as it is safe to READ BACK: enough to recognise it, never enough to
 * reconstruct the account.
 *
 * ⚠ **Masked even for the OWNER, and even for a tier-1 Developer.** The applicant-side rule
 * is the same and the reasoning carries: payout details are write-mostly, echoing a full
 * account number to any client that can read a profile turns a session hijack into a banking
 * leak, and nobody actually needs to read the digits back — the employee knows their own
 * number and the company pays from a payroll system, not from this screen.
 */
export interface PayoutMethodMasked {
    method: PayoutMethodKind;
    /** The first entry of the ordered list is the one a payout would actually use. */
    isPreferred: boolean;
    mobileMoney: { provider: string; phoneNumberMasked: string; accountName: string } | null;
    bank: {
        bankName: string;
        accountNumberMasked: string;
        accountName: string;
        country: string;
    } | null;
    card: {
        brand: CardBrand;
        last4: string;
        numberMasked: string;
        cardHolderName: string;
        expiryMonth: number;
        expiryYear: number;
        issuingBank: string | null;
        country: string;
    } | null;
}

/** Keep the last 4 characters; everything before becomes bullets. */
function maskTail(value: string): string {
    if (value.length <= 4) return '••••';
    return '•'.repeat(value.length - 4) + value.slice(-4);
}

export function formatMaskedCardNumber(last4: string): string {
    return `•••• •••• •••• ${last4}`;
}

/**
 * True once the card's expiry month has fully passed. A card is valid THROUGH the last day of
 * its expiry month, so equality on both parts is not expired. `now` is injectable so the rule
 * stays testable without freezing the clock.
 */
export function isCardExpired(
    expiryMonth: number,
    expiryYear: number,
    now: Date = new Date(),
): boolean {
    const currentYear = now.getUTCFullYear();
    const currentMonth = now.getUTCMonth() + 1;
    if (expiryYear !== currentYear) return expiryYear < currentYear;
    return expiryMonth < currentMonth;
}

export function maskPayoutMethod(
    method: IEmployeePayoutMethod,
    isPreferred: boolean,
): PayoutMethodMasked {
    return {
        method: method.method,
        isPreferred,
        mobileMoney: method.mobile_money
            ? {
                provider: method.mobile_money.provider,
                phoneNumberMasked: maskTail(method.mobile_money.phone_number),
                accountName: method.mobile_money.account_name,
            }
            : null,
        bank: method.bank
            ? {
                bankName: method.bank.bank_name,
                accountNumberMasked: maskTail(method.bank.account_number),
                accountName: method.bank.account_name,
                country: method.bank.country,
            }
            : null,
        card: method.card
            ? {
                brand: method.card.brand,
                last4: method.card.last4,
                numberMasked: formatMaskedCardNumber(method.card.last4),
                cardHolderName: method.card.card_holder_name,
                expiryMonth: method.card.expiry_month,
                expiryYear: method.card.expiry_year,
                issuingBank: method.card.issuing_bank ?? null,
                country: method.card.country,
            }
            : null,
    };
}

export function maskPayoutMethods(
    methods: IEmployeePayoutMethod[] | null | undefined,
): PayoutMethodMasked[] {
    if (!methods) return [];
    return methods.map((m, index) => maskPayoutMethod(m, index === 0));
}

// ─── Zod ─────────────────────────────────────────────────────────────────────

/**
 * `.trim()` BEFORE `.min(1)`, everywhere in this file. Zod applies checks in chain order, so
 * `z.string().min(1).trim()` measures the UNTRIMMED value and accepts `"   "` — storing a
 * blank account name that passed validation. On a payout destination that is not cosmetic: a
 * blank account name is a transfer somebody has to chase.
 */
const requiredText = (message: string) => z.string().trim().min(1, message);

/**
 * Full E.164 — a leading `+`, a country code, 7 to 15 digits total.
 *
 * ⚠ Enforced HERE rather than imported: jovi-mall's `core/validation/phone.ts` is not
 * reachable from this service, and a national number on a payout destination is not merely
 * untidy — it is an instruction nobody can execute.
 */
const E164 = z
    .string()
    .trim()
    .regex(/^\+[1-9]\d{6,14}$/, 'Must be a full international number, e.g. +237670000000');

const MobileMoneyZodSchema = z.object({
    provider: requiredText('Provider is required'),
    phone_number: E164,
    account_name: requiredText('Account name is required'),
});

const BankZodSchema = z.object({
    bank_name: requiredText('Bank name is required'),
    account_number: requiredText('Account number is required'),
    account_name: requiredText('Account name is required'),
    country: requiredText('Country is required'),
});

/**
 * Fields whose presence means the client tried to send a real card number or security code.
 *
 * REFUSED rather than stripped: Zod would silently drop an unknown key, and a client reading
 * a 200 back would reasonably conclude the PAN it sent is now on file — the worst possible
 * outcome for a value that is never wanted and never stored.
 */
const FORBIDDEN_CARD_FIELDS = [
    'number', 'card_number', 'pan', 'account_number', 'cvv', 'cvc', 'cvn', 'security_code',
] as const;

export const CARD_PAN_REJECTED_MESSAGE =
    'Card numbers and security codes are never accepted or stored. Send only brand, last4, holder, expiry and country.';

const CardZodSchema = z
    .object({
        brand: z.preprocess(
            (v) => (typeof v === 'string' ? v.trim().toLowerCase() : v),
            z.enum(CARD_BRANDS),
        ),
        last4: z.string().trim().regex(/^\d{4}$/, 'last4 must be exactly 4 digits'),
        card_holder_name: requiredText('Card holder name is required'),
        expiry_month: z.number().int().min(1).max(12),
        expiry_year: z.number().int().min(2000).max(2100),
        issuing_bank: z.string().trim().max(100).nullable().optional(),
        country: requiredText('Country is required'),
    })
    // Passthrough so the forbidden-field check below can SEE what was sent. The transform
    // rebuilds the object key-by-key, so nothing extra survives into Mongo.
    .passthrough();

/**
 * The SHAPE of a payout entry — what one IS, independent of whether it may be configured
 * today. Exported so the disabled kinds stay under test while they are off: a rule nothing
 * exercises is a rule that rots.
 *
 * **Do not validate requests with this.** Use {@link PayoutMethodZodSchema}.
 */
export const PayoutMethodShapeZodSchema = z
    .discriminatedUnion('method', [
        z.object({
            method: z.literal('mobile_money'),
            mobile_money: MobileMoneyZodSchema,
            bank: z.null().optional(),
            card: z.null().optional(),
        }),
        z.object({
            method: z.literal('bank'),
            mobile_money: z.null().optional(),
            bank: BankZodSchema,
            card: z.null().optional(),
        }),
        z.object({
            method: z.literal('card'),
            mobile_money: z.null().optional(),
            bank: z.null().optional(),
            card: CardZodSchema,
        }),
    ])
    .superRefine((data, ctx) => {
        if (data.method !== 'card') return;
        for (const field of FORBIDDEN_CARD_FIELDS) {
            if (field in data.card) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ['card', field],
                    message: CARD_PAN_REJECTED_MESSAGE,
                });
            }
        }
        // An expired card is a payment that will bounce. Refusing it at write time is the
        // only moment anybody is looking; by payroll time the employee is not in the room.
        if (isCardExpired(data.card.expiry_month, data.card.expiry_year)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['card', 'expiry_year'],
                message: 'Card has expired',
            });
        }
    })
    .transform((data): IEmployeePayoutMethod => {
        if (data.method === 'mobile_money') {
            return { method: 'mobile_money', mobile_money: data.mobile_money, bank: null, card: null };
        }
        if (data.method === 'bank') {
            return { method: 'bank', mobile_money: null, bank: data.bank, card: null };
        }
        const card = data.card;
        return {
            method: 'card',
            mobile_money: null,
            bank: null,
            card: {
                brand: card.brand,
                last4: card.last4,
                card_holder_name: card.card_holder_name,
                expiry_month: card.expiry_month,
                expiry_year: card.expiry_year,
                issuing_bank: card.issuing_bank ?? null,
                country: card.country,
            },
        };
    });

/**
 * Validates one payout entry for a REQUEST: the switch, then the shape.
 *
 * The gate runs FIRST, as a separate piped stage, so a client still rendering a switched-off
 * form is told "bank payouts are not available right now" rather than being walked through
 * the field errors of a form it may not submit at all. Inside one `superRefine` the
 * sub-object would be validated first and a partial body would never reach the gate.
 */
export const PayoutMethodZodSchema = z
    .unknown()
    .superRefine((value, ctx) => {
        const method = (value as { method?: unknown } | null)?.method;
        if (typeof method !== 'string') return; // not our error — the shape reports it
        if (!ALL_PAYOUT_METHODS.includes(method as PayoutMethodKind)) return;
        if (isPayoutMethodEnabled(method)) return;
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['method'],
            message: payoutMethodUnavailableMessage(method as PayoutMethodKind),
        });
    })
    .pipe(PayoutMethodShapeZodSchema);

/**
 * An ordered list of payout destinations. The FIRST entry is the preferred one.
 *
 * ⚠ Minimum ZERO, unlike jovi-mall's, which requires at least one. A vendor configures payout
 * details as part of onboarding and has no reason to hold an empty list; an employee's record
 * is built up over several sittings and must be saveable half-finished. The requirement that
 * one destination exists is enforced at ACTIVATION instead (`employee-readiness.ts`), which is
 * the moment it actually matters.
 */
export const PayoutMethodsZodSchema = z
    .array(PayoutMethodZodSchema)
    .max(3, 'You may add at most 3 payout destinations');
