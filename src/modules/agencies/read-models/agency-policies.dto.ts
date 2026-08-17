/**
 * An agency's commercial terms, mapped field by field.
 *
 * ── Why this file exists ─────────────────────────────────────────────────────
 * The block used to be `policies: agency.policies ?? null` — jovi-mall's sub-document
 * assigned whole. That made it the largest of the five casing leaks the dashboard
 * reported: four nested blocks of `snake_case` reaching the browser against README's "the
 * translation happens in this service and never leaks", and undocumented besides, so the
 * dashboard's types were read out of `delivery-agency.model.ts` rather than out of the
 * contract.
 *
 * ── The projection stays wide, and that is now safe ──────────────────────────
 * `agency.read.repository.ts` takes `policies: 1` whole, which is the ONE place in that
 * module a sub-document is not enumerated. The argument for it is sound and unchanged:
 * these are commercial terms already visible to every connected vendor, so there is no
 * field that could be added to them which this surface should not see. What was missing is
 * the second lock — a named mapper — so that a field added upstream reaches the read model
 * and stops here rather than appearing on the wire uninvited.
 *
 * ── Still read-only, and that is not in question ─────────────────────────────
 * Nothing here writes. Pricing, returns and damage terms are the agency's own commercial
 * record, negotiated with the vendors connected to it, and every edit bumps
 * `policy_version` — which pauses EVERY vendor connection for re-approval. An
 * administrator changing a price on their behalf would silently re-open every relationship
 * they have.
 */

/** A sub-document that jovi-mall has not written at all is `null`, never `{}`. */
type Raw = Record<string, unknown> | undefined | null;

function sub(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function num(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function bool(value: unknown): boolean {
    return value === true;
}

export interface AgencyPoliciesDto {
    pricing: {
        /**
         * The warehousing arrangement. `enabled: false` means the agency does not offer
         * storage at all — which is different from offering it at zero, and a screen must
         * say so rather than printing a rate nobody agreed to.
         */
        storageBased: {
            enabled: boolean;
            monthlyStorageFeePerSku: number | null;
            pickPackFeePerOrder: number | null;
            localDeliveryFee: number | null;
            outOfRegionDeliveryFee: number | null;
        } | null;
        /** The collect-from-the-vendor arrangement. The two are not exclusive. */
        pickupBased: {
            enabled: boolean;
            baseRateFirstKg: number | null;
            additionalPerKg: number | null;
            outOfRegionSurcharge: number | null;
        } | null;
        additionalFees: {
            /** `type` decides how `value` reads: a percentage of the COD, or a flat fee. */
            codHandlingFee: { type: string | null; value: number | null } | null;
            failedDeliveryFee: number | null;
            /** Return to origin — charged when a delivery comes back undelivered. */
            rtoFee: number | null;
            /** Optional; `null` means the agency levies none. */
            peakSeasonSurcharge: number | null;
        } | null;
        notes: string | null;
    } | null;
    returns: {
        /** Who pays to bring it back — `vendor` · `agency` · `customer`. */
        payer: string | null;
        handlingFee: number | null;
        returnWindowDays: number | null;
        notes: string | null;
    } | null;
    damage: {
        claimDeadlineDays: number | null;
        maxRefundPerItem: number | null;
        /**
         * Who adjudicates a damage claim. **Administrator-controlled upstream**, not the
         * agency's to set — which is why it can differ from everything else in this block.
         */
        inspector: string | null;
        investigationFee: number | null;
        notes: string | null;
    } | null;
    cod: {
        enabled: boolean;
        /** `null` means no ceiling, not zero. Zero would block every COD order. */
        maxOrderAmount: number | null;
    } | null;
    /**
     * Up to two links to off-platform term sheets.
     *
     * URLs to somewhere else entirely. Render them as links; this service resolves no file
     * URLs and never fetches these.
     */
    documents: string[];
}

export function toAgencyPoliciesDto(raw: Raw): AgencyPoliciesDto | null {
    if (!raw) return null;

    const pricing = sub(raw.pricing);
    const storageBased = pricing ? sub(pricing.storage_based) : null;
    const pickupBased = pricing ? sub(pricing.pickup_based) : null;
    const additionalFees = pricing ? sub(pricing.additional_fees) : null;
    const codHandlingFee = additionalFees ? sub(additionalFees.cod_handling_fee) : null;
    const returns = sub(raw.returns);
    const damage = sub(raw.damage);
    const cod = sub(raw.cod);

    return {
        pricing: pricing
            ? {
                  storageBased: storageBased
                      ? {
                            enabled: bool(storageBased.enabled),
                            monthlyStorageFeePerSku: num(storageBased.monthly_storage_fee_per_sku),
                            pickPackFeePerOrder: num(storageBased.pick_pack_fee_per_order),
                            localDeliveryFee: num(storageBased.local_delivery_fee),
                            outOfRegionDeliveryFee: num(storageBased.out_of_region_delivery_fee),
                        }
                      : null,
                  pickupBased: pickupBased
                      ? {
                            enabled: bool(pickupBased.enabled),
                            baseRateFirstKg: num(pickupBased.base_rate_first_kg),
                            additionalPerKg: num(pickupBased.additional_per_kg),
                            outOfRegionSurcharge: num(pickupBased.out_of_region_surcharge),
                        }
                      : null,
                  additionalFees: additionalFees
                      ? {
                            codHandlingFee: codHandlingFee
                                ? { type: str(codHandlingFee.type), value: num(codHandlingFee.value) }
                                : null,
                            failedDeliveryFee: num(additionalFees.failed_delivery_fee),
                            rtoFee: num(additionalFees.rto_fee),
                            peakSeasonSurcharge: num(additionalFees.peak_season_surcharge),
                        }
                      : null,
                  notes: str(pricing.notes),
              }
            : null,
        returns: returns
            ? {
                  payer: str(returns.payer),
                  handlingFee: num(returns.handling_fee),
                  returnWindowDays: num(returns.return_window_days),
                  notes: str(returns.notes),
              }
            : null,
        damage: damage
            ? {
                  claimDeadlineDays: num(damage.claim_deadline_days),
                  maxRefundPerItem: num(damage.max_refund_per_item),
                  inspector: str(damage.inspector),
                  investigationFee: num(damage.investigation_fee),
                  notes: str(damage.notes),
              }
            : null,
        cod: cod
            ? {
                  enabled: bool(cod.enabled),
                  maxOrderAmount: num(cod.max_order_amount),
              }
            : null,
        documents: Array.isArray(raw.documents)
            ? (raw.documents as unknown[]).filter((doc): doc is string => typeof doc === 'string')
            : [],
    };
}
