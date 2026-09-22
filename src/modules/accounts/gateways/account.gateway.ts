import { platformRequest } from '../../../infra/platform/platform.client';
import { ActorContext } from '../../audit/domain/audit-context';

/**
 * The account view's DELEGATED half: two verdicts, and nothing else.
 *
 * ── Why this mount has a gateway at all, when it has no writes ────────────────
 * Every other gateway in this service exists for a write. This one exists for two READS,
 * and they are here rather than in a repository because of what they are, not where they
 * live: a **balance** and an **entitlement** are derivations jovi-mall owns, and a second
 * implementation of either would be a second opinion — about how much money exists, and
 * about what an owner is allowed to do. ADR-009 D-1: delegate the verdict, read the record.
 *
 * The line is sharp on this page. The subscriber-plan ROW is read directly (which plan,
 * when it started, who assigned it); what that plan ENTITLES the owner to is asked for. The
 * earnings LEDGER is read directly (what moved); the four balances are asked for.
 *
 * ── Neither call is audited, and that is the rule rather than an omission ─────
 * A read leaves no state to reconstruct, so the permission gate is the whole control. The
 * one audited read in this service is the payout-destination disclosure, whose output is
 * the material a fraudulent payout instruction is built from; a balance is not that.
 *
 * ── What happens when jovi-mall is down ───────────────────────────────────────
 * These two throw and the account view fails with jovi-mall's own code in
 * `details.platformCode`. That is deliberate and it is the honest failure: an account page
 * that silently rendered `balances.earnings: null` would be indistinguishable from an owner
 * who is owed nothing. The three SUB-lists (`/payouts`, `/credits`, `/cash-ledger`) are
 * entirely direct and keep answering — which is the point of the split.
 */

/** jovi-mall's `getBalances`, for one owner. Four sub-balances plus the currency. */
export interface PlatformBalances {
    ownerType?: string;
    ownerId?: string;
    pending?: number;
    available?: number;
    reserve?: number;
    requested?: number;
    currency?: string;
    [key: string]: unknown;
}

/**
 * What the owner's active plan allows. Every field is nullable on the platform side and
 * means "no active plan" as a set — not "unlimited".
 */
export interface PlatformEntitlements {
    ownerType?: string;
    ownerId?: string;
    planCode?: string | null;
    maxActiveProducts?: number | null;
    maxStorageBytes?: number | null;
    commissionPercent?: number | null;
    maxUnterminatedShipments?: number | null;
    /** Agent plans (2026-09-21). `null` for other roles and for "no active plan". */
    maxCodPool?: number | null;
    liveTrackingEnabled?: boolean | null;
    [key: string]: unknown;
}

/**
 * `GET /api/internal/admin/earnings/balances/:ownerType/:ownerId`.
 *
 * Net-new at step 1 of this phase, and a route onto logic that already existed rather than
 * new arithmetic: `earningsAccountService.getBalances` was always generic over the owner and
 * had only ever been called with `'platform'`.
 */
export async function ownerBalances(
    ownerType: string,
    ownerId: string,
    context: ActorContext,
): Promise<PlatformBalances> {
    const result = await platformRequest<PlatformBalances>({
        method: 'GET',
        path: `/earnings/balances/${ownerType}/${ownerId}`,
        actor: context.actor,
        requestId: context.requestId,
    });
    return result.data;
}

/**
 * `GET /api/internal/admin/billing/entitlements/:ownerType/:ownerId`.
 *
 * These are numbers the platform itself branches on — `max_active_products` refuses a
 * publish, `max_unterminated_shipments` resizes an agent's capacity, `commission_percent`
 * multiplies every future order's split. Recomputing them here from `pricing_plans` would
 * work right up until the resolution rules changed on one side only.
 */
export async function entitlements(
    ownerType: string,
    ownerId: string,
    context: ActorContext,
): Promise<PlatformEntitlements> {
    const result = await platformRequest<PlatformEntitlements>({
        method: 'GET',
        path: `/billing/entitlements/${ownerType}/${ownerId}`,
        actor: context.actor,
        requestId: context.requestId,
    });
    return result.data;
}
