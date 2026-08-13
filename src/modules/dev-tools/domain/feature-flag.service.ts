import { Types } from 'mongoose';
import { env } from '../../../config/env';
import { AdminIdentity } from '../../admin-identity/domain/admin-identity.types';
import { auditedTransaction } from '../../audit/domain/audit.writer';
import { auditActorOf } from '../../audit/domain/audit-context';
import { AuditContext } from '../../audit/domain/audit.types';
import { FeatureFlagModel, IFeatureFlag } from '../models/feature-flag.model';
import {
    FEATURE_FLAG_NAMES,
    FeatureFlagName,
    featureFlagSpec,
} from './feature-flag.catalog';

/**
 * Reading and flipping feature flags.
 *
 * ── The cache is a cache, not a circuit breaker ───────────────────────────────
 * `flagEnabled()` is on request paths, so it holds a short in-process cache
 * (`ADMIN_FEATURE_FLAG_CACHE_MS`, default 5s). `setFlag` clears it locally; OTHER instances
 * converge within the TTL.
 *
 * State that plainly rather than implying otherwise: turning a flag off is not immediate
 * fleet-wide, and nothing here should be relied on to stop something *right now*. If a
 * capability needs an instant kill, it needs a different mechanism — an env var and a
 * restart, or the permission taken away, both of which are immediate and neither of which
 * is this.
 */

interface CacheEntry {
    enabled: boolean;
    readAt: number;
}

const cache = new Map<FeatureFlagName, CacheEntry>();

export interface FeatureFlagView {
    name: FeatureFlagName;
    enabled: boolean;
    /** True when no row exists — the value comes from the catalog. */
    isDefault: boolean;
    default: boolean;
    consumer: string;
    summary: string;
    reason: string | null;
    updatedBy: string | null;
    updatedByEmail: string | null;
    updatedAt: string | null;
}

/**
 * Is this flag on?
 *
 * Falls back to the catalog default on ANY failure, including a database outage. A flag
 * lookup must not be able to fail a request — the feature it gates is the point, not the
 * flag — and the default is the value the code was written against.
 */
export async function flagEnabled(name: FeatureFlagName): Promise<boolean> {
    const ttl = env().ADMIN_FEATURE_FLAG_CACHE_MS;
    const hit = cache.get(name);
    if (hit && Date.now() - hit.readAt < ttl) return hit.enabled;

    try {
        const row = await FeatureFlagModel().findOne({ name }).lean();
        const enabled = row ? row.enabled : featureFlagSpec(name).default;
        cache.set(name, { enabled, readAt: Date.now() });
        return enabled;
    } catch {
        return featureFlagSpec(name).default;
    }
}

/** Every flag, catalog defaults merged with whatever has been changed. */
export async function listFlags(): Promise<FeatureFlagView[]> {
    const rows = await FeatureFlagModel().find().lean();
    const byName = new Map(rows.map((row) => [row.name, row]));

    return FEATURE_FLAG_NAMES.map((name) => toView(name, byName.get(name) ?? null));
}

/**
 * Turn a flag on or off.
 *
 * `wi_admin_txn`: the row and the audit row commit together, which is the whole reason the
 * collection lives in this database. `reason` is required — a flag flipped with no stated
 * reason is a mystery to whoever finds it six weeks later, and the row is the only place
 * that context can live.
 */
export async function setFlag(
    name: FeatureFlagName,
    enabled: boolean,
    reason: string,
    actor: AdminIdentity,
    context: AuditContext,
): Promise<FeatureFlagView> {
    const before = await FeatureFlagModel().findOne({ name }).lean();
    const previous = before ? before.enabled : featureFlagSpec(name).default;

    const updated = await auditedTransaction<IFeatureFlag>(
        {
            action: 'developer_tools.feature_flags.set',
            actor: auditActorOf(actor),
            target: { type: 'feature_flag', id: name, label: name },
            context,
            payload: { flag: name, enabled, reason },
        },
        async (session) => {
            const result = await FeatureFlagModel().findOneAndUpdate(
                { name },
                {
                    $set: {
                        enabled,
                        reason,
                        updated_by: new Types.ObjectId(actor.adminId),
                        updated_by_email: actor.email,
                    },
                },
                { new: true, upsert: true, session },
            );

            return {
                result,
                before: { enabled: previous, wasDefault: before === null },
                after: { enabled, reason },
            };
        },
    );

    // Local only — other instances pick it up within the TTL. See the header.
    cache.delete(name);

    return toView(name, updated);
}

/** Test-only: drop the cache so a suite is not reading a previous case's value. */
export function resetFlagCache(): void {
    cache.clear();
}

function toView(name: FeatureFlagName, row: Pick<
    IFeatureFlag,
    'enabled' | 'reason' | 'updated_by' | 'updated_by_email' | 'updated_at'
> | null): FeatureFlagView {
    const spec = featureFlagSpec(name);

    return {
        name,
        enabled: row ? row.enabled : spec.default,
        isDefault: row === null,
        default: spec.default,
        consumer: spec.consumer,
        summary: spec.summary,
        reason: row?.reason ?? null,
        updatedBy: row?.updated_by ? row.updated_by.toString() : null,
        updatedByEmail: row?.updated_by_email ?? null,
        updatedAt: row?.updated_at ? row.updated_at.toISOString() : null,
    };
}
