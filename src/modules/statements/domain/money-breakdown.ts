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
 * The residual is split in two with the per-shipment numbers jovi-mall also persisted:
 * `shipments.delivery_fee_snapshot` (what the AGENCY is paid) less what the CUSTOMER paid for
 * that run — see `vendorBorneDeliveryFee`. A prepaid order carries no COD fee, so its whole
 * residual is delivery.
 *
 * ── Customer-paid delivery (jovi-mall ADR-A11, 2026-10-03) ─────────────────────
 * Since a shop may make the customer pay delivery, two things changed upstream and both are
 * absorbed here without touching the formula:
 *
 *   - `gross_snapshot` is the ITEMS gross on every vendor row — never `total_amount`, which now
 *     includes customer-paid delivery. So `gross` is what the goods sold for.
 *   - `deliveryFee` in NET_FORMULA means the VENDOR-BORNE part of the delivery fee:
 *     `max(0, fee − customer_delivery_fee)` — the whole fee on a vendor-paid shipment, normally
 *     0 on a customer-paid one. jovi-mall's split deducts exactly that, so the residual stays
 *     exact. Splitting a COD residual with the AGENCY's fee instead would, on a customer-paid
 *     shipment, find the fee larger than the residual and blank the row (`deliveryFee: null`).
 *
 * ⚠ **NET_FORMULA is a contract copy.** jovi-mall's analytics state the same formula, and
 * each repo's test asserts it against this literal — the ADR-016 taxonomy pattern, because
 * there is no shared package to import it from.
 */
export const NET_FORMULA = 'net = gross - bargainFee - commission - deliveryFee - codFee';

export interface VendorSaleInput {
    /** `order` = prepaid, `cod_collection` = cash on delivery. */
    sourceType: 'order' | 'cod_collection';
    /**
     * The allocation's `gross_snapshot`: the ITEMS gross — the order's goods for a prepaid
     * order, the collection's `items_amount` for COD. Since ADR-A11 it is neither
     * `total_amount` nor `expected_amount`, both of which may include customer-paid delivery.
     */
    gross: number;
    /** The vendor allocation's `amount`. */
    net: number;
    /** The `platform` allocation on the same source; 0 when absent (a 0% plan writes no row). */
    commission: number;
    /** The `platform_ai` allocation on the same source; 0 on an un-bargained sale. */
    bargainFee: number;
    /**
     * The VENDOR-BORNE delivery fee of the shipment this source paid for —
     * `vendorBorneDeliveryFee(shipment)`, not the raw `delivery_fee_snapshot`; `null` when no
     * fee was recorded. Only read for a COD source. The name is kept identical to jovi-mall's
     * twin (`vendors/analytics/net-revenue.ts`) so the two readers stay diffable.
     */
    deliveryFeeSnapshot: number | null;
}

/** The shipment fields `vendorBorneDeliveryFee` reads. */
export interface ShipmentFeeFacts {
    /** What the agency is paid for the run. */
    delivery_fee_snapshot?: number | null;
    /** `null`/absent on shipments before customer-paid delivery — read as `vendor`. */
    delivery_payer?: 'vendor' | 'customer' | null;
    /** What the customer was charged for the run; counts only when `delivery_payer` is `customer`. */
    customer_delivery_fee?: number | null;
}

/**
 * What the customer paid for a shipment's delivery — 0 on a vendor-paid (or older) shipment.
 * Informational on a statement, never part of a vendor's net.
 *
 * Mirrors jovi-mall's `customerDeliveryFeeOf(null, shipment)` (`orders/domain/delivery-payer.ts`)
 * exactly as its vendor analytics call it: the SHIPMENT's own payer, `vendor` when unset, and a
 * fee that counts only when it is a positive finite number. ⚠ Never falls back to
 * `delivery_fee_snapshot` — a shipment created after checkout gets a snapshot the customer
 * never paid.
 */
export function customerPaidDeliveryFee(shipment: ShipmentFeeFacts): number {
    if (shipment.delivery_payer !== 'customer') return 0;
    const paid = shipment.customer_delivery_fee;
    return typeof paid === 'number' && Number.isFinite(paid) && paid > 0 ? paid : 0;
}

/**
 * The part of a shipment's delivery fee the VENDOR bears — NET_FORMULA's `deliveryFee` term.
 * `null` when no fee was recorded (the caller then refuses to split the residual).
 *
 * Mirrors `deliveryFeeShares(fee, customerFee).vendorBorne` = `max(0, fee − customerFee)`.
 * Reading two persisted numbers, not a rate: nothing here prices a delivery.
 */
export function vendorBorneDeliveryFee(shipment: ShipmentFeeFacts): number | null {
    const fee = shipment.delivery_fee_snapshot;
    if (fee === null || fee === undefined) return null;
    return Math.max(0, Math.max(0, fee) - customerPaidDeliveryFee(shipment));
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

/**
 * A COD collection's cash split into goods and customer-paid delivery — mirrors jovi-mall's
 * `collectionBreakdownOf`. Rows written before ADR-A11 carry no breakdown: all their cash was
 * goods. Informational: the cash total is still `expected_amount`.
 */
export function collectionCashBreakdown(collection: {
    expected_amount: number;
    items_amount?: number | null;
    delivery_fee_amount?: number | null;
}): { itemsAmount: number; deliveryFeeAmount: number } {
    const deliveryFeeAmount = Math.max(0, collection.delivery_fee_amount ?? 0);
    const itemsAmount =
        typeof collection.items_amount === 'number' ? collection.items_amount : collection.expected_amount - deliveryFeeAmount;
    return { itemsAmount, deliveryFeeAmount };
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
    /** The vendor's minimum as snapshotted at checkout; null = not bargainable, no fee. */
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
 *
 * ⚠ The uplift is measured from the price PAID, on every line with a floor — haggled or not.
 * Since 2026-09-28 jovi-mall charges the fee on an un-haggled sale of a bargainable variant too
 * (`bargainLineOf` in its earnings split), so keying on `negotiated_unit_price` here would put the
 * whole fee on the haggled lines of a mixed order and none on the un-haggled ones that also paid it.
 */
export function apportionBargainFee(lines: BargainLine[], totalBargainFee: number): Map<string, number> {
    const uplifts = lines.map((line) => ({
        lineId: line.lineId,
        uplift:
            line.floorPriceSnapshot !== null
                ? Math.max(0, (line.unitPricePaid - line.floorPriceSnapshot) * line.quantity)
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
