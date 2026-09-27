/**
 * What each deduction on one sale was — READ back from the allocations jovi-mall wrote,
 * never recomputed from a rate.
 *
 * ── Why nothing here multiplies by a percentage ───────────────────────────────
 * Two services now read the same money (owner decision O-8): jovi-mall for the dashboards,
 * this one for statements. If this file computed `commission = gross × plan%` it would be a
 * second implementation of the split, right up until a plan changed mid-period or a rounding
 * rule moved on one side only. Instead every figure is an amount jovi-mall already persisted,
 * or the residual of amounts it persisted:
 *
 *   - `bargainFee` — the `platform_ai` allocation on the same source
 *   - `commission` — the `platform` allocation on the same source
 *   - `net`        — the vendor's own allocation
 *   - `deliveryFee + codFee` — the residual `gross − bargainFee − commission − net`, which is
 *     exact because jovi-mall's split is `vendorNet = gross − aiMargin − commission −
 *     deliveryFee − codFee` (`earnings-split.service.ts` `splitOrder` / `splitCodCollection`)
 *
 * The residual is split in two with the one per-shipment number jovi-mall also persisted:
 * `shipments.delivery_fee_snapshot`. A prepaid order carries no COD fee, so its whole residual
 * is delivery.
 *
 * ⚠ **NET_FORMULA is a contract copy.** jovi-mall's analytics state the same formula, and
 * each repo's test asserts it against this literal — the ADR-016 taxonomy pattern, because
 * there is no shared package to import it from.
 */
export const NET_FORMULA = 'net = gross - bargainFee - commission - deliveryFee - codFee';

export interface VendorSaleInput {
    /** `order` = prepaid, `cod_collection` = cash on delivery. */
    sourceType: 'order' | 'cod_collection';
    /** The allocation's `gross_snapshot`: the order total, or the collection's expected amount. */
    gross: number;
    /** The vendor allocation's `amount`. */
    net: number;
    /** The `platform` allocation on the same source; 0 when absent (a 0% plan writes no row). */
    commission: number;
    /** The `platform_ai` allocation on the same source; 0 on an un-bargained sale. */
    bargainFee: number;
    /** Σ `delivery_fee_snapshot` of the shipments this source paid for; `null` when none recorded. */
    deliveryFeeSnapshot: number | null;
}

export interface VendorSaleBreakdown {
    gross: number;
    bargainFee: number;
    commission: number;
    /** `null` only when the residual cannot be split (COD with no fee snapshot). */
    deliveryFee: number | null;
    codFee: number | null;
    /** Always known: the residual itself. Equals `deliveryFee + codFee` whenever both are known. */
    deliveryAndCod: number;
    net: number;
}

export function vendorSaleBreakdown(input: VendorSaleInput): VendorSaleBreakdown {
    const deliveryAndCod = input.gross - input.bargainFee - input.commission - input.net;
    const base = {
        gross: input.gross,
        bargainFee: input.bargainFee,
        commission: input.commission,
        deliveryAndCod,
        net: input.net,
    };

    if (input.sourceType === 'order') {
        return { ...base, deliveryFee: deliveryAndCod, codFee: 0 };
    }

    const snapshot = input.deliveryFeeSnapshot;
    if (snapshot === null || snapshot < 0 || snapshot > deliveryAndCod) {
        // Refuse to invent a split. The statement prints the combined figure, and the
        // summary note explains the blank — a wrong number here would be worse than none.
        return { ...base, deliveryFee: null, codFee: null };
    }
    return { ...base, deliveryFee: snapshot, codFee: deliveryAndCod - snapshot };
}

export interface AgencyEarningInput {
    sourceType: 'shipment' | 'cod_collection';
    /** The agency allocation's `amount`. */
    agencyNet: number;
    /** The sibling `agent` allocation's `amount`; 0 when no agent was bound. */
    agentCut: number;
    /**
     * Prepaid: the shipment allocation's `gross_snapshot` (the fee RESERVED at payment).
     * COD: the shipment's `delivery_fee_snapshot`.
     */
    deliveryFee: number | null;
}

export interface AgencyEarningBreakdown {
    /** What the run earned before the agent's share: agencyNet + agentCut − codFee. */
    earnedDeliveryFee: number | null;
    agentCut: number;
    codFee: number | null;
    agencyNet: number;
}

/**
 * The agency's side of one delivery.
 *
 * jovi-mall writes ONE agency row per source: prepaid → `earnedFee − agentCut`; COD →
 * `deliveryFee − agentCut + codFee` (`computeAgencyCut`). So for COD the handling fee is the
 * residual `agencyNet + agentCut − deliveryFee`. For prepaid there is no COD fee, and the
 * earned fee is `agencyNet + agentCut` — which is LESS than the reserved `deliveryFee` on a
 * return, the difference having gone back to the vendor.
 */
export function agencyEarningBreakdown(input: AgencyEarningInput): AgencyEarningBreakdown {
    const earnedBeforeCod = input.agencyNet + input.agentCut;
    if (input.sourceType === 'shipment') {
        return { earnedDeliveryFee: earnedBeforeCod, agentCut: input.agentCut, codFee: 0, agencyNet: input.agencyNet };
    }
    if (input.deliveryFee === null || input.deliveryFee > earnedBeforeCod) {
        return { earnedDeliveryFee: null, agentCut: input.agentCut, codFee: null, agencyNet: input.agencyNet };
    }
    return {
        earnedDeliveryFee: input.deliveryFee,
        agentCut: input.agentCut,
        codFee: earnedBeforeCod - input.deliveryFee,
        agencyNet: input.agencyNet,
    };
}

export interface BargainLine {
    lineId: string;
    unitPricePaid: number;
    quantity: number;
    negotiatedUnitPrice: number | null;
    floorPriceSnapshot: number | null;
}

/**
 * The order's total bargain fee, apportioned to its lines by uplift.
 *
 * jovi-mall computes `floor(pct × uplift)` PER LINE and persists only the sum (the
 * `platform_ai` allocation). Rather than learn the percentage — a second copy of a config
 * value — this apportions the persisted total by each line's share of the uplift, with the
 * rounding remainder given to the largest line so the lines always sum to the total exactly.
 * For a one-line order (the common case) it IS the persisted figure.
 */
export function apportionBargainFee(lines: BargainLine[], totalBargainFee: number): Map<string, number> {
    const uplifts = lines.map((line) => ({
        lineId: line.lineId,
        uplift:
            line.negotiatedUnitPrice !== null && line.floorPriceSnapshot !== null
                ? Math.max(0, (line.negotiatedUnitPrice - line.floorPriceSnapshot) * line.quantity)
                : 0,
    }));
    const totalUplift = uplifts.reduce((sum, u) => sum + u.uplift, 0);
    const result = new Map<string, number>(lines.map((line) => [line.lineId, 0]));
    if (totalUplift <= 0 || totalBargainFee <= 0) return result;

    let assigned = 0;
    let largest = uplifts[0];
    for (const u of uplifts) {
        const share = Math.floor((totalBargainFee * u.uplift) / totalUplift);
        result.set(u.lineId, share);
        assigned += share;
        if (u.uplift > largest.uplift) largest = u;
    }
    result.set(largest.lineId, (result.get(largest.lineId) ?? 0) + (totalBargainFee - assigned));
    return result;
}
