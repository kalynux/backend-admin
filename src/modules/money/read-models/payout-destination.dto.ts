import {
    MaskedPayoutMethodSnapshot,
    PayoutDestinationReadModel,
} from '../repositories/payout-request.read.repository';

/**
 * Where a payout is addressed — the one field on this service's surface that is not shown
 * by default.
 *
 * ── One type, two mappers ─────────────────────────────────────────────────────
 * `toMaskedDestinationDto` renders what the queue, the detail and the account view show.
 * Its counterpart `toRevealedDestinationDto` — reachable only from
 * `GET /money/payouts/:payoutId/destination`, which is gated on
 * `money.payouts.destination.read` and writes an audit row on every call — is the only
 * function in this service that ever puts a plaintext account number on the wire.
 *
 * One DTO for both, because a client rendering a destination must not have to branch on
 * which endpoint it came from, and because `revealed` says which it is **explicitly**. That
 * flag is the discriminator and it is never inferred from `full` being non-null: a mapper
 * that forgot to set it would then look like a masked one, which is the wrong direction for
 * a mistake to fail in.
 *
 * ── `full` is ALWAYS present, and always `null` here ──────────────────────────
 * ADR-005 D-16: required-and-nullable, never absent. A key that appears only on the
 * disclosure endpoint makes "this was not disclosed" and "this client is out of date"
 * indistinguishable at the point where it matters most.
 *
 * ── Why the masked values are `null` rather than `••••3456` on the masked path ─
 * `toMaskedDestinationDto` CANNOT render a last-four, because it never receives the digits:
 * `PAYOUT_LIST_PROJECTION` does not name `mobile_money.phone_number` or
 * `bank.account_number`, so the values never leave the database on this path. That is the
 * stronger property and it is the one this service buys — a masker is a call somebody can
 * forget on the next endpoint; a projection is a property of every query the repository can
 * run.
 *
 * The consequence, stated so nobody reads it as a bug: on `/money/payouts` an operator
 * recognises a destination by its **provider and account name** ("MTN · Jean Dupont"), not
 * by its last four digits. jovi-mall's own admin queue still renders the last four, and
 * both are right for their surface — that one is a single screen behind a single role, and
 * this one is the service that has to answer "who has seen a beneficiary's account number".
 *
 * `card` is the exception and needs no exception made for it: jovi-mall never stores a PAN
 * (storing one would put the whole database in PCI-DSS scope), so `last4` is the entire
 * number that exists and rendering it is not a disclosure.
 */

export interface PayoutDestinationMobileMoney {
    provider: string | null;
    /**
     * `null` on every endpoint but the disclosure — the digits were never read. See the
     * header; this is not "no number on file", which is `mobileMoney: null` itself.
     */
    phoneNumberMasked: string | null;
    accountName: string | null;
}

export interface PayoutDestinationBank {
    bankName: string | null;
    /** `null` on every endpoint but the disclosure. Same reading as `phoneNumberMasked`. */
    accountNumberMasked: string | null;
    accountName: string | null;
    country: string | null;
}

/**
 * A card destination, in full — because "in full" is only four digits.
 *
 * Nothing is redacted here that was not already absent: `last4` is all jovi-mall holds, and
 * `numberMasked` is rendered FROM it purely so a client can print all three method kinds
 * through one code path.
 */
export interface PayoutDestinationCard {
    brand: string | null;
    last4: string | null;
    numberMasked: string | null;
    cardHolderName: string | null;
    expiryMonth: number | null;
    expiryYear: number | null;
    issuingBank: string | null;
    country: string | null;
}

export interface PayoutDestinationDto {
    /**
     * `mobile_money` · `bank` · `card`.
     *
     * A bounded string rather than a `z.enum`, matching every other jovi-mall vocabulary on
     * this mount: the platform owns which kinds exist, and this service never writes one.
     */
    method: string | null;
    /**
     * A snapshot has no position in a list — and it WAS the preferred method at the moment
     * it was frozen, which is why jovi-mall's own masker takes this as a parameter rather
     * than deriving it. Always `true` for a payout snapshot.
     */
    isPreferred: boolean;
    masked: {
        mobileMoney: PayoutDestinationMobileMoney | null;
        bank: PayoutDestinationBank | null;
        card: PayoutDestinationCard | null;
    };
    /**
     * The routing values. **Always present, `null` on every endpoint but the audited
     * disclosure** (ADR-005 D-16).
     */
    full: {
        mobileMoney: { phoneNumber: string } | null;
        bank: { accountNumber: string } | null;
        /**
         * Typed `null`, permanently, and the narrowing is deliberate.
         *
         * The operational need this whole endpoint serves is "where do I send the money" —
         * an MSISDN or an account number. Nobody sends money *to* a card gateway token; it
         * is a PULL credential, and a card destination's only number is the `last4` already
         * on the masked side. So the disclosure has nothing to add for a card, and
         * `card.gateway_token` is never revealed, not even there.
         */
        card: null;
    } | null;
    /** The discriminator. Never inferred from `full` — see the header. */
    revealed: boolean;
}

/**
 * A snapshot whose routing values were never projected → a destination DTO.
 *
 * Used by `/money/payouts`, `/money/payouts/:payoutId` and (from step 7) the account view.
 * It hard-codes `full: null, revealed: false`, and it would still do so if it were handed a
 * document carrying the plaintext — `test-money.ts` feeds it exactly that. Two locks: the
 * projection is the one that holds in production, and this mapper is the one that holds if
 * somebody widens the projection.
 *
 * `null` in, `null` out. Legacy payout rows predate the snapshot entirely and carry no
 * destination at all; `null` says so, where an object full of nulls would read as "a
 * destination with no details".
 */
export function toMaskedDestinationDto(
    snapshot: MaskedPayoutMethodSnapshot | null | undefined,
): PayoutDestinationDto | null {
    if (!snapshot) return null;

    return {
        method: snapshot.method ?? null,
        isPreferred: true,
        masked: {
            mobileMoney: snapshot.mobile_money
                ? {
                    provider: snapshot.mobile_money.provider ?? null,
                    phoneNumberMasked: null,
                    accountName: snapshot.mobile_money.account_name ?? null,
                }
                : null,
            bank: snapshot.bank
                ? {
                    bankName: snapshot.bank.bank_name ?? null,
                    accountNumberMasked: null,
                    accountName: snapshot.bank.account_name ?? null,
                    country: snapshot.bank.country ?? null,
                }
                : null,
            card: snapshot.card
                ? {
                    brand: snapshot.card.brand ?? null,
                    last4: snapshot.card.last4 ?? null,
                    numberMasked: snapshot.card.last4
                        ? formatMaskedCardNumber(snapshot.card.last4)
                        : null,
                    cardHolderName: snapshot.card.card_holder_name ?? null,
                    expiryMonth: snapshot.card.expiry_month ?? null,
                    expiryYear: snapshot.card.expiry_year ?? null,
                    issuingBank: snapshot.card.issuing_bank ?? null,
                    country: snapshot.card.country ?? null,
                }
                : null,
        },
        full: null,
        revealed: false,
    };
}

/**
 * The same destination, WITH the digits — the one mapper that discloses.
 *
 * Reachable from `GET /money/payouts/:payoutId/destination` and from nowhere else. It is
 * fed by `PayoutDestinationReadRepository`, whose narrow projection is the only query in
 * this service that reads a routing value at all, and the endpoint that calls it commits an
 * audit row BEFORE this function ever runs (`domain/payout-disclosure.ts`).
 *
 * ── The masked half is DELEGATED to the mapper above, deliberately ────────────
 * The labels are identical on both paths — the two projections name the same label fields —
 * so building them twice would create two renderings of one destination that could disagree
 * about, say, whether an absent `issuing_bank` is `null` or missing. This mapper therefore
 * calls `toMaskedDestinationDto` for the labels and overrides exactly two values: the two
 * this path has and that one does not. The sub-object spreads below are spreads of a value
 * that mapper produced, never of a database document — it is handed no plaintext at all,
 * so a field added to it can only ever be a label.
 *
 * ── What `full` means, and why it is an object of nulls rather than null ──────
 * `full === null` is "not disclosed" and is what every other endpoint emits. Here `full` is
 * always an object and its members say what there was: a bank destination discloses
 * `bank.accountNumber` and leaves `mobileMoney` null. A CARD destination discloses nothing
 * — `full.card` is permanently typed `null`, because the only number a card has here is the
 * `last4` already on the masked side — so it answers `{ mobileMoney: null, bank: null, card:
 * null }` with `revealed: true`. That reads correctly: this WAS the disclosure, and there
 * was nothing further to give.
 *
 * `null` in, `null` out — a payout predating the snapshot has no destination on file, and
 * the caller turns that into `PAYOUT_DESTINATION_ABSENT` (422) rather than a 404, so a
 * dashboard can tell "no such payout" from "nothing to reveal".
 */
export function toRevealedDestinationDto(
    row: PayoutDestinationReadModel,
): PayoutDestinationDto | null {
    const labels = toMaskedDestinationDto(row.payout_method_snapshot);
    if (!labels) return null;

    const phoneNumber = presentString(row.revealed_mobile_money_number);
    const accountNumber = presentString(row.revealed_bank_account_number);

    return {
        method: labels.method,
        isPreferred: labels.isPreferred,
        masked: {
            mobileMoney: labels.masked.mobileMoney
                ? {
                    ...labels.masked.mobileMoney,
                    phoneNumberMasked: phoneNumber ? maskTail(phoneNumber) : null,
                }
                : null,
            bank: labels.masked.bank
                ? {
                    ...labels.masked.bank,
                    accountNumberMasked: accountNumber ? maskTail(accountNumber) : null,
                }
                : null,
            card: labels.masked.card,
        },
        full: {
            mobileMoney: phoneNumber ? { phoneNumber } : null,
            bank: accountNumber ? { accountNumber } : null,
            card: null,
        },
        revealed: true,
    };
}

/**
 * Which KINDS were revealed — for the audit row's `after`, never the values.
 *
 * Derived from the DTO rather than from the document so it cannot describe a disclosure
 * that did not happen: it names what this response actually carries. A card destination
 * yields `[]`, which is the honest answer — the call was made, the permission was used, and
 * nothing was handed over.
 */
export function revealedMethodsOf(destination: PayoutDestinationDto): string[] {
    const kinds: string[] = [];
    if (destination.full?.mobileMoney) kinds.push('mobile_money');
    if (destination.full?.bank) kinds.push('bank');
    return kinds;
}

/** A projected-but-empty value is "no number on file", not a number of length zero. */
function presentString(value: string | null | undefined): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Keep the last 4 digits; everything before becomes bullets.
 *
 * **The fourth copy of this function**, and the duplication is stated rather than pretended
 * away: jovi-mall holds it privately in `core/types/payout.types.ts` and the two services
 * are separate packages with no shared library, so there is nothing to import. What stops
 * the copies drifting is `test-money.ts`, which reads jovi-mall's source and asserts both
 * agree on a fixed vector — the same guard `test-data-access.ts` uses for the collection
 * constants, and the reason this is a named cost rather than an unnoticed one.
 *
 * Note it is only reachable from the DISCLOSURE path. Every other endpoint renders
 * `phoneNumberMasked: null`, because the digits a mask is computed from were never read.
 */
export function maskTail(value: string): string {
    if (value.length <= 4) return '••••';
    return '•'.repeat(value.length - 4) + value.slice(-4);
}

/**
 * A 16-digit-looking rendering of a card we only hold 4 digits of.
 *
 * A copy of jovi-mall's `formatMaskedCardNumber`, and the duplication is named rather than
 * pretended away: the two services are separate packages with no shared library, so this is
 * a second implementation of a one-line format. `test-money.ts` asserts the two agree on a
 * fixed vector by reading jovi-mall's source, which is the same drift guard
 * `test-data-access.ts` uses for the collection constants.
 */
export function formatMaskedCardNumber(last4: string): string {
    return `•••• •••• •••• ${last4}`;
}
