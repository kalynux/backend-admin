import { PlanRef, PricingPlanReadModel } from '../repositories/pricing-plan.read.repository';
import { SubscriberPlanReadModel } from '../repositories/subscriber-plan.read.repository';

/**
 * Wire shapes for `/api/v1/billing`.
 *
 * Named-field mapping throughout, **never a spread**. `pricing_plans` and
 * `subscriber_plans` hold no credential today, so the argument here is the weaker of the
 * two the convention rests on — but it is the one that survives somebody widening a
 * projection for a new screen, and this module's DTOs are the ones the account view will
 * reuse in step 7, where the neighbouring blocks do carry money.
 *
 * ── camelCase on the wire, snake_case in the database ─────────────────────────
 * The translation happens here on the way out and in `billing.gateway.ts` on the way in.
 * Neither direction is a lookup table maintained by hand somewhere else; each is the one
 * function that knows both names, which is what stops the two halves drifting.
 */

function toIso(value: Date | null | undefined): string | null {
    if (!value) return null;
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * Who assigned a plan.
 *
 * `source` says which database `id` resolves in — `'admin'` ids resolve in neither, being
 * `admin_accounts` rows in wi-admin's own database — and `name` is the snapshot taken at
 * write time, which is the only record there will ever be for those. Defaulting `source`
 * to `'platform'` matches the schema: a row written before the admin split carries
 * neither field and IS a platform row.
 */
export interface ActorStampDto {
    id: string | null;
    source: string;
    name: string | null;
}

export interface PlanDto {
    id: string;
    role: string;
    code: string;
    name: string;
    price: number;
    currency: string | null;
    /** `null` = never expires. Every role's free tier. */
    termDays: number | null;
    creditAllowance: number;
    /**
     * The role-specific caps, grouped rather than flattened.
     *
     * A plan carries only the limits its role uses — a vendor tier has
     * `maxActiveProducts` and `commissionPercent`, an agency or agent tier has
     * `maxUnterminatedShipments` — so at any given moment about half of these are `null`.
     * Nested, that reads as "the limits block, partly inapplicable". Flattened beside
     * `price` and `name`, it reads as a plan with half its fields missing.
     *
     * `null` is jovi-mall's own "unlimited" for every one of them except
     * `liveTrackingEnabled`, which is a boolean the entitlement service reads directly.
     */
    limits: {
        maxActiveProducts: number | null;
        maxStorageBytes: number | null;
        /** What every future order's split multiplies by. The reason plan detail exists. */
        commissionPercent: number | null;
        maxUnterminatedShipments: number | null;
        liveTrackingEnabled: boolean | null;
    };
    /** Whether the tier is purchasable. A defined-but-not-yet-sold tier is a real state. */
    isActive: boolean;
    sortOrder: number;
    /**
     * When the plan was archived, or `null`.
     *
     * Present on every row (ADR-005 D-16: required-and-nullable, never absent) so a
     * client rendering the catalog with `includeArchived=true` can tell the two apart
     * without inferring it from the absence of a key.
     */
    archivedAt: string | null;
    createdAt: string | null;
    updatedAt: string | null;
}

/**
 * Named-field mapping, not a spread.
 *
 * `deletedAt` becomes `archivedAt` on the wire deliberately: "deleted" is what the column
 * is called and not what it means — the row is still there, subscribers are still on it,
 * and jovi-mall never removes it.
 */
export function toPlanDto(plan: PricingPlanReadModel): PlanDto {
    return {
        id: plan._id.toString(),
        role: plan.role,
        code: plan.code,
        name: plan.name,
        price: plan.price,
        currency: plan.currency ?? null,
        termDays: plan.term_days ?? null,
        creditAllowance: plan.credit_allowance ?? 0,
        limits: {
            maxActiveProducts: plan.max_active_products ?? null,
            maxStorageBytes: plan.max_storage_bytes ?? null,
            commissionPercent: plan.commission_percent ?? null,
            maxUnterminatedShipments: plan.max_unterminated_shipments ?? null,
            liveTrackingEnabled: plan.live_tracking_enabled ?? null,
        },
        // `?? true` and `?? 0` are the schema's own defaults, applied to a legacy row
        // written before the field existed rather than reported as absent.
        isActive: plan.is_active ?? true,
        sortOrder: plan.sort_order ?? 0,
        archivedAt: toIso(plan.deletedAt),
        createdAt: toIso(plan.created_at),
        updatedAt: toIso(plan.updated_at),
    };
}

export interface OwnerRef {
    type: string;
    id: string;
    /** The BUSINESS name where there is one — a Store, a Magazin. `null`, never `""`. */
    name: string | null;
}

export interface SubscriptionDto {
    id: string;
    owner: OwnerRef;
    /**
     * The plan, resolved.
     *
     * `code` comes off the subscription row itself — jovi-mall denormalises it there — so
     * it answers even when the plan lookup found nothing, which is exactly the case a
     * dangling `plan_id` produces. `name` is `null` in that case, and the difference
     * between the two is how a hand-edited row makes itself visible.
     */
    plan: { id: string; code: string | null; name: string | null };
    status: string;
    startedAt: string | null;
    /** `null` on the never-expiring free tier — not "unknown". */
    expiresAt: string | null;
    /**
     * `null` when nobody assigned it: the self-service purchase path and the lazily
     * created free default both leave this unset, and that is a different fact from an
     * administrator whose name failed to snapshot.
     */
    assignedBy: ActorStampDto | null;
    paymentReference: string | null;
    /** Whether the one-time credit allowance has been granted. Guards a double grant. */
    allowanceGranted: boolean;
    createdAt: string | null;
    updatedAt: string | null;
}

/** Owner display names for a page, keyed `"<ownerType>:<ownerId>"`. */
export type OwnerNames = Map<string, string | null>;

/** The key both the resolver and the mapper build, so the two cannot disagree. */
export function ownerKey(ownerType: string, ownerId: string): string {
    return `${ownerType}:${ownerId}`;
}

export function toSubscriptionDto(
    row: SubscriberPlanReadModel,
    plans: Map<string, PlanRef>,
    owners: OwnerNames,
): SubscriptionDto {
    const ownerId = row.owner_id.toString();
    const planId = row.plan_id.toString();
    const plan = plans.get(planId);

    return {
        id: row._id.toString(),
        owner: {
            type: row.owner_type,
            id: ownerId,
            name: owners.get(ownerKey(row.owner_type, ownerId)) ?? null,
        },
        plan: {
            id: planId,
            code: row.plan_code ?? plan?.code ?? null,
            name: plan?.name ?? null,
        },
        status: row.status,
        startedAt: toIso(row.started_at),
        expiresAt: toIso(row.expires_at),
        // Keyed on the id, exactly as the agency DTO keys `verifiedBy` on the flag beside
        // it: a stamp rendered without checking whether there is an actor reads as
        // "assigned by nobody, source platform", which is a claim rather than an absence.
        assignedBy: row.assigned_by
            ? {
                id: row.assigned_by.toString(),
                source: row.assigned_by_source ?? 'platform',
                name: row.assigned_by_name ?? null,
            }
            : null,
        paymentReference: row.payment_reference ?? null,
        allowanceGranted: row.allowance_granted ?? false,
        createdAt: toIso(row.created_at),
        updatedAt: toIso(row.updated_at),
    };
}
