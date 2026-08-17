/**
 * A vendor's commercial terms — returns, cancellation and support — mapped field by field.
 *
 * ── Why this exists, and the asymmetry it closes ─────────────────────────────
 * The vendor detail used to carry three booleans: `hasReturnPolicy`,
 * `hasCancellationPolicy`, `hasSupportPolicy`. "Presence, not content", deliberately —
 * `vendors.md` said so, and noted that ~30 fields of the vendor's own terms existed
 * upstream and were not projected. So an administrator could see THAT a vendor had a
 * return policy and not WHAT it said, which is precisely the question a dispute lands on.
 *
 * Meanwhile the agency detail projects its `policies` whole, argued on the grounds that
 * "these are commercial terms already visible to every connected vendor, so there is no
 * field that could be added to them which this surface should not see."
 *
 * **That argument carries here a fortiori, which is why the asymmetry is closed rather
 * than explained.** A vendor's return and cancellation policy is shown to every CUSTOMER
 * on the storefront — a strictly wider audience than an agency's terms, which are seen
 * only by the vendors connected to it. Withholding from an administrator what is published
 * to the public was the part that read as an oversight.
 *
 * The presence booleans stay, derived from the content rather than replaced by it: a
 * client may want to know whether to render a block before it renders one, and removing
 * them would be a second breaking change for no gain.
 *
 * ── Still read-only ──────────────────────────────────────────────────────────
 * Nothing here writes, and this request did not ask for one. Every edit bumps
 * `policy_version`, which pauses every agency connection for re-approval.
 *
 * ── One field is NOT the vendor's ────────────────────────────────────────────
 * `returns.inspector` is administrator-controlled upstream and never vendor input, the
 * same way `damage.inspector` is on the agency side. It is projected with the rest because
 * it is part of the same commercial record, but it does not describe a term the vendor set.
 */

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

function strList(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export interface VendorReturnPolicyDto {
    /** Whether the vendor accepts returns at all. Everything below is moot when false. */
    returnEligible: boolean | null;
    returnWindowDays: number | null;
    /** `full` · `partial` · `none`. Decides whether `refundPercentage` means anything. */
    refundType: string | null;
    refundPercentage: number | null;
    /** `vendor` · `customer` · `customer_reimbursed_if_defect`. */
    returnShippingPayer: string | null;
    refundProcessingDays: number | null;
    returnConditionNotes: string | null;
    /** **Administrator-controlled, never vendor input** — `admin` · `vendor` · `platform`. */
    inspector: string | null;
}

export interface VendorCancellationPolicyDto {
    cancellable: boolean | null;
    /** When cancellation stops being free — a five-value vocabulary jovi-mall owns. */
    cancellationDeadline: string | null;
    cancellationDeadlineDays: number | null;
    /** `none` · `fixed` · `percentage` · `full_non_refundable`. */
    cancellationFeeType: string | null;
    cancellationFeeValue: number | null;
    lateCancellationRefundType: string | null;
    lateCancellationRefundValue: number | null;
}

export interface VendorSupportPolicyDto {
    /** Where a customer reaches them. `contact` is the address on that channel. */
    channels: { type: string | null; contact: string | null }[];
    eligibilityNotes: string | null;
    /** `order_number` · `product_photo_video` · `tracking_number`. */
    requiredInfo: string[];
    /** `24_7` · `business_hours` · `limited`. */
    availability: string | null;
    availabilityDescription: string | null;
    /** ISO language codes the vendor answers in. */
    languages: string[];
}

export interface VendorPoliciesDto {
    returns: VendorReturnPolicyDto | null;
    cancellation: VendorCancellationPolicyDto | null;
    support: VendorSupportPolicyDto | null;
    /** Up to two links to off-platform terms. Render as links; nothing here fetches them. */
    documents: string[];
}

export function toVendorPoliciesDto(raw: Raw): VendorPoliciesDto | null {
    if (!raw) return null;

    const returns = sub(raw.return_policy);
    const cancellation = sub(raw.cancellation_policy);
    const support = sub(raw.support_policy);

    return {
        returns: returns
            ? {
                  returnEligible: typeof returns.return_eligible === 'boolean' ? returns.return_eligible : null,
                  returnWindowDays: num(returns.return_window_days),
                  refundType: str(returns.refund_type),
                  refundPercentage: num(returns.refund_percentage),
                  returnShippingPayer: str(returns.return_shipping_payer),
                  refundProcessingDays: num(returns.refund_processing_days),
                  returnConditionNotes: str(returns.return_condition_notes),
                  inspector: str(returns.inspector),
              }
            : null,
        cancellation: cancellation
            ? {
                  cancellable: typeof cancellation.cancellable === 'boolean' ? cancellation.cancellable : null,
                  cancellationDeadline: str(cancellation.cancellation_deadline),
                  cancellationDeadlineDays: num(cancellation.cancellation_deadline_days),
                  cancellationFeeType: str(cancellation.cancellation_fee_type),
                  cancellationFeeValue: num(cancellation.cancellation_fee_value),
                  lateCancellationRefundType: str(cancellation.late_cancellation_refund_type),
                  lateCancellationRefundValue: num(cancellation.late_cancellation_refund_value),
              }
            : null,
        support: support
            ? {
                  channels: (Array.isArray(support.channels) ? support.channels : [])
                      .map((channel) => sub(channel))
                      .filter((channel): channel is Record<string, unknown> => channel !== null)
                      .map((channel) => ({ type: str(channel.type), contact: str(channel.contact) })),
                  eligibilityNotes: str(support.eligibility_notes),
                  requiredInfo: strList(support.required_info),
                  availability: str(support.availability),
                  availabilityDescription: str(support.availability_description),
                  languages: strList(support.languages),
              }
            : null,
        documents: strList(raw.documents),
    };
}
