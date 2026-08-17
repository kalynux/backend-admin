import { Document, Filter, ObjectId } from 'mongodb';
import { Types } from 'mongoose';
import { COLLECTIONS } from '../../../infra/platform/collections';
import { PlatformReadRepository } from '../../../infra/platform/platform.repository';

/**
 * The three supporting reads behind a vendor detail — settings, agency connections, and
 * the order tally.
 *
 * ── Why these three, and nothing else ─────────────────────────────────────────
 * The brief asks for "account information" and "product-related operational information".
 * These answer the operational half of that: how the vendor's orders are configured to
 * flow, who they are contracted to deliver through, and whether they trade at all.
 *
 * What is deliberately NOT here is money. `earnings_accounts`, `payout_requests` and
 * `subscriber_plans` sit behind `money.read` and `billing.read`, and assembling them into
 * this response would let `vendors.read` ALONE reach data those permissions exist to gate
 * — the same reasoning `user.controller.ts` gives for keeping orders and shipments out of
 * the user activity feed. The detail returns the vendor id; a billing panel composes
 * itself from the billing module when that surface lands.
 *
 * The order read is a COUNT and a date, never a sum. Totalling order amounts here would be
 * revenue, and revenue is money.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Settings
// ─────────────────────────────────────────────────────────────────────────────

export interface VendorSettingsReadModel extends Document {
    _id: ObjectId;
    vendor_id: ObjectId;
    notify_days_before_expiry?: number;
    auto_redirect_orders_to_agency?: boolean;
    auto_redirect_threshold_amount?: number | null;
    auto_cancel_unpaid_days?: number;
}

/**
 * `customer_flags` is NOT projected.
 *
 * It is the vendor's own CRM vocabulary — their labels for their customers — and each
 * flag's embedded `_id` is referenced by `VendorCustomer.flag_ids`. It is not
 * administrative information, and the settings PATCH refuses to write it for the same
 * reason. A projection is the honest place to state that: what is not fetched cannot be
 * rendered by a screen somebody builds later.
 */
const VENDOR_SETTINGS_PROJECTION = {
    _id: 1,
    vendor_id: 1,
    notify_days_before_expiry: 1,
    auto_redirect_orders_to_agency: 1,
    auto_redirect_threshold_amount: 1,
    auto_cancel_unpaid_days: 1,
} as const;

export class VendorSettingsReadRepository extends PlatformReadRepository<VendorSettingsReadModel> {
    constructor() {
        super(COLLECTIONS.VENDOR_SETTINGS, VENDOR_SETTINGS_PROJECTION);
    }

    /**
     * Null is a real answer, not an error: the settings document is created lazily by
     * jovi-mall on first read or write, so a vendor who has never touched a setting simply
     * has none. The controller reports jovi-mall's own defaults in that case.
     */
    async findForVendor(vendorId: string): Promise<VendorSettingsReadModel | null> {
        if (!Types.ObjectId.isValid(vendorId)) return null;
        return this.findOneBy({
            vendor_id: new ObjectId(vendorId),
        } as Filter<VendorSettingsReadModel>);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Agency connections
// ─────────────────────────────────────────────────────────────────────────────

export interface ConnectionReadModel extends Document {
    _id: ObjectId;
    vendor_id: ObjectId;
    agency_id: ObjectId;
    status: string;
}

const CONNECTION_PROJECTION = { _id: 1, vendor_id: 1, agency_id: 1, status: 1 } as const;

/** Counts per connection status, in the vocabulary `ConnectionStatus` defines. */
export interface ConnectionCounts {
    total: number;
    active: number;
    pending: number;
    pausedReapproval: number;
    rejected: number;
    withdrawn: number;
    terminated: number;
}

export class VendorConnectionReadRepository extends PlatformReadRepository<ConnectionReadModel> {
    constructor() {
        super(COLLECTIONS.VENDOR_AGENCY_CONNECTION, CONNECTION_PROJECTION);
    }

    /** One `$group`, served by the existing `{ vendor_id, status }` index. */
    async countByStatus(vendorId: string): Promise<ConnectionCounts> {
        const empty: ConnectionCounts = {
            total: 0, active: 0, pending: 0, pausedReapproval: 0,
            rejected: 0, withdrawn: 0, terminated: 0,
        };

        if (!Types.ObjectId.isValid(vendorId)) return empty;

        const rows = await this.aggregateBy<{ _id: string; n: number }>([
            { $match: { vendor_id: new ObjectId(vendorId) } },
            { $group: { _id: '$status', n: { $sum: 1 } } },
        ]);

        return rows.reduce<ConnectionCounts>((counts, row) => {
            counts.total += row.n;
            if (row._id === 'active') counts.active = row.n;
            else if (row._id === 'pending') counts.pending = row.n;
            else if (row._id === 'paused_reapproval') counts.pausedReapproval = row.n;
            else if (row._id === 'rejected') counts.rejected = row.n;
            else if (row._id === 'withdrawn') counts.withdrawn = row.n;
            else if (row._id === 'terminated') counts.terminated = row.n;
            return counts;
        }, { ...empty });
    }

    /**
     * How many of an AGENCY's connections are awaiting re-approval.
     *
     * The mirror of `countByStatus` above, from the other side. It exists because
     * `policyVersion` on the agency detail is the field with the largest blast radius on
     * that screen — bumping it pauses every vendor connection — and there was no way to
     * see how many were sitting in that state as a result. The vendor side has had
     * `counts.agencyConnections.pausedReapproval` all along.
     *
     * One count rather than the full breakdown, because one question is being asked. A
     * `$countDocuments` on `{agency_id, status}` rather than a `$group`: the agency detail
     * is a single-document read and does not need the other six numbers.
     */
    async countPausedReapprovalForAgency(agencyId: string): Promise<number> {
        if (!Types.ObjectId.isValid(agencyId)) return 0;

        return this.countBy({
            agency_id: new ObjectId(agencyId),
            status: 'paused_reapproval',
        });
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Orders — a tally, never a total
// ─────────────────────────────────────────────────────────────────────────────

export interface VendorOrderReadModel extends Document {
    _id: ObjectId;
    vendor_id: ObjectId;
    created_at: Date;
}

/**
 * Two fields. `total_amount` is deliberately absent — see the file header: a revenue
 * figure behind `vendors.read` alone would reach past what that permission governs.
 */
const ORDER_TALLY_PROJECTION = { _id: 1, vendor_id: 1, created_at: 1 } as const;

export class VendorOrderReadRepository extends PlatformReadRepository<VendorOrderReadModel> {
    constructor() {
        super(COLLECTIONS.ORDER, ORDER_TALLY_PROJECTION);
    }

    /**
     * How many orders, and when the last one arrived.
     *
     * Both served by the existing `{ vendor_id, created_at: -1 }` index — the count as a
     * range scan, the latest as its first key.
     */
    async tallyForVendor(vendorId: string): Promise<{ total: number; lastOrderAt: Date | null }> {
        if (!Types.ObjectId.isValid(vendorId)) return { total: 0, lastOrderAt: null };

        const filter = { vendor_id: new ObjectId(vendorId) } as Filter<VendorOrderReadModel>;

        const [total, latest] = await Promise.all([
            this.countBy(filter),
            this.findBy(filter, { sort: { created_at: -1 }, limit: 1 }),
        ]);

        return { total, lastOrderAt: latest[0]?.created_at ?? null };
    }
}
