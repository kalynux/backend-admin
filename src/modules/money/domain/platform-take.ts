/**
 * Withholding the platform's own AMOUNTS from one order's money split (BR-030 § 3b).
 *
 * The owner's rule: Admin and Support see the platform's commission and bargain fee as
 * rates, never as amounts. `GET /money/orders/:orderId/split` stays open to every tier —
 * "why did the vendor receive this amount" is theirs to answer — so below
 * `money.earnings.platform.read` the figures the platform takes are removed here, on the
 * server, and the response says so.
 *
 * ── What is withheld, exactly ─────────────────────────────────────────────────
 *   lines whose beneficiary is `platform` / `platform_ai`   `amount`, `clawedAmount`
 *   `goods.commission.amount`                                the commission in money
 *   `goods.bargainFee.amount`, and each `lines[].fee`        the bargain fee in money
 *   `totals.platform`                                        the three sums
 *   adjustments against a platform account                   their four amounts
 *
 * ── What stays, deliberately ──────────────────────────────────────────────────
 * Every RATE (`commission.percent`, `bargainFee.percent`, `bargainFeePercent`), the
 * commission `base`, each bargained line's price, floor and `uplift`, the vendor's, the
 * agencies' and the agents' figures, what the customer was charged, and the reconciliation.
 *
 * ⚠ **This is not a confidentiality boundary and must not be described as one.** What the
 * customer paid, less what the vendor keeps, less the delivery lines, IS the platform's
 * share, and those are exactly the numbers Support is here to read. What changes is that the
 * service no longer STATES the platform's amounts. The owner was told so (BR-030 § 3b).
 *
 * ── `null` already means something on this route ──────────────────────────────
 * A line's `amount` is `null` for an agent's share nobody can know yet. So a withheld
 * figure is never left as a bare `null`: every line and basis block it touches carries
 * `withheld: true`, and the response carries `platformAmountsWithheld`. A screen must print
 * "not shown at your level", never "not known yet".
 *
 * Pure, and tolerant of a shape it does not fully know: the split is jovi-mall's payload,
 * passed through loosely typed, and a field added there must not turn this into a throw on a
 * read. It rebuilds what it changes and never mutates its input.
 */

const PLATFORM_BENEFICIARIES: readonly string[] = ['platform', 'platform_ai'];

type Loose = Record<string, unknown>;

function isObject(value: unknown): value is Loose {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPlatformBeneficiary(value: unknown): boolean {
    return isObject(value) && isObject(value.beneficiary) && PLATFORM_BENEFICIARIES.includes(String(value.beneficiary.type));
}

function withholdLine(line: unknown): unknown {
    if (!isPlatformBeneficiary(line)) return line;
    return { ...(line as Loose), amount: null, clawedAmount: null, withheld: true };
}

function withholdGoods(goods: unknown): unknown {
    if (!isObject(goods)) return goods;

    const bargainFee = isObject(goods.bargainFee)
        ? {
              ...goods.bargainFee,
              amount: null,
              lines: Array.isArray(goods.bargainFee.lines)
                  ? goods.bargainFee.lines.map((item) => (isObject(item) ? { ...item, fee: null } : item))
                  : goods.bargainFee.lines,
              withheld: true,
          }
        : goods.bargainFee;
    const commission = isObject(goods.commission)
        ? { ...goods.commission, amount: null, withheld: true }
        : goods.commission;

    return { ...goods, bargainFee, commission };
}

function withholdAdjustment(adjustment: unknown): unknown {
    if (!isPlatformBeneficiary(adjustment)) return adjustment;
    return {
        ...(adjustment as Loose),
        amount: null,
        goodsAmount: null,
        deliveryAmount: null,
        takenFrom: null,
        withheld: true,
    };
}

/** The split as a caller WITH the permission receives it: untouched, and saying so. */
export function withPlatformAmounts<T extends object>(split: T): T & { platformAmountsWithheld: false } {
    return { ...split, platformAmountsWithheld: false };
}

/** The split as everybody else receives it. */
export function withholdPlatformAmounts<T extends object>(split: T): T & { platformAmountsWithheld: true } {
    const source = split as Loose;

    const sections = Array.isArray(source.sections)
        ? source.sections.map((section) =>
              isObject(section)
                  ? {
                        ...section,
                        goods: withholdGoods(section.goods),
                        lines: Array.isArray(section.lines) ? section.lines.map(withholdLine) : section.lines,
                    }
                  : section)
        : source.sections;

    const totals = isObject(source.totals) ? { ...source.totals, platform: null } : source.totals;

    const adjustments = Array.isArray(source.adjustments)
        ? source.adjustments.map(withholdAdjustment)
        : source.adjustments;

    return { ...split, sections, totals, adjustments, platformAmountsWithheld: true } as T & { platformAmountsWithheld: true };
}
