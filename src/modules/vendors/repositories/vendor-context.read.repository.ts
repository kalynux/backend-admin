import { Document, Filter, ObjectId } from 'mongodb';
import { Types } from 'mongoose';
import { toMongoSort } from '../../../core/data/mongo-list';
import { ListQueryBase } from '../../../core/http/list-query';
import { COLLECTIONS } from '../../../infra/platform/collections';
import { Paginated, PlatformReadRepository } from '../../../infra/platform/platform.repository';

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

export interface ConnectionRejection {
    reason?: string | null;
    rejected_by_role?: string;
    rejected_by_user_id?: ObjectId;
    rejected_at?: Date;
}

export interface ConnectionWithdrawal {
    withdrawn_by_role?: string;
    withdrawn_by_user_id?: ObjectId;
    withdrawn_at?: Date;
}

export interface ConnectionTermination {
    terminated_by_role?: string;
    terminated_by_user_id?: ObjectId;
    terminated_at?: Date;
    /** `unilateral` or `reapproval_declined`. jovi-mall's vocabulary, not pinned here. */
    reason?: string;
    note?: string | null;
}

export interface ConnectionReadModel extends Document {
    _id: ObjectId;
    vendor_id: ObjectId;
    agency_id: ObjectId;
    status: string;
    /** Present only on the row read — see `CONNECTION_ROW_EXTRAS`. */
    requester_role?: string;
    requested_at?: Date;
    responded_at?: Date | null;
    vendor_policy_version_at_approval?: number | null;
    agency_policy_version_at_approval?: number | null;
    reapproval_required_from?: string | null;
    paused_at?: Date | null;
    paused_reason?: string | null;
    rejection?: ConnectionRejection | null;
    withdrawal?: ConnectionWithdrawal | null;
    termination?: ConnectionTermination | null;
    created_at?: Date;
    updated_at?: Date;
}

const CONNECTION_PROJECTION = { _id: 1, vendor_id: 1, agency_id: 1, status: 1 } as const;

/**
 * What the ROW read adds on top of the four fields the counts need (BR-018).
 *
 * Expressed as the delta rather than as a second projection, for the reason
 * `AGENCY_DETAIL_EXTRAS` gives: `aggregatePage` spreads the repository's own projection
 * first and lets a caller only ADD, so the narrow one stays the default — the safe
 * direction — and this is the visible diff naming what a list row may additionally see.
 *
 * ── `status_history` is deliberately absent ──────────────────────────────────
 * It is an unbounded array on every document, and a list row does not want it: a page of
 * twenty connections would carry a page of twenty trails. The dashboard did not ask for
 * it. If a connection DETAIL read is ever built, that is where it belongs — and it will
 * name the field here as its own extra.
 *
 * The three event blocks are taken WHOLE rather than by dotted path. That is the same
 * exception `policies` is on the agency read model: they are closed sub-documents of a
 * relationship both parties already see in full, so there is no field that could be added
 * to them which this surface should not show. The DTO names every field regardless, which
 * is the second lock.
 */
const CONNECTION_ROW_EXTRAS = {
    requester_role: 1,
    requested_at: 1,
    responded_at: 1,
    vendor_policy_version_at_approval: 1,
    agency_policy_version_at_approval: 1,
    reapproval_required_from: 1,
    paused_at: 1,
    paused_reason: 1,
    rejection: 1,
    withdrawal: 1,
    termination: 1,
    created_at: 1,
    updated_at: 1,
} as const;

/**
 * What a connection list may be ordered by: **wire name → `jovi_mall` field path**.
 *
 * ⚠ **Neither entry is fully index-backed, and that is accepted rather than overlooked.**
 * `{ vendor_id, status }` has no `created_at` trailer and cannot carry the `_id`
 * tiebreaker `toMongoSort` appends, so both orders are blocking sorts. They are bounded by
 * ONE vendor's connection count — a vendor contracts with a handful of agencies, not a
 * thousand — which is the same argument `ContractReadRepository.listForAgent` makes for
 * the mirror-image read. An index for a nine-row sort costs more than the sort.
 *
 * `status` is offered because it groups the screen the way an operator reads it: the
 * pending and paused rows are the ones they opened the panel to act on.
 */
export const VENDOR_AGENCY_CONNECTION_SORT = {
    createdAt: 'created_at',
    status: 'status',
} as const;

export interface ConnectionListQuery extends ListQueryBase {
    status?: string;
}

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

    /**
     * The vendor's connections as ROWS — the panel BR-018 asked for.
     *
     * ── Why this is a direct read ─────────────────────────────────────────────
     * BR-018 proposed `Transport: Delegated`. It is not, and the rule that decides it is
     * ADR-004 D-2 as amended by ADR-009 D-1 / ADR-011 D-1: **delegate a read whose answer
     * is a VERDICT the platform acts on; read directly a read whose answer is a RECORD.**
     * A connection document is a record — nothing about listing it can leave the database
     * inconsistent, and `vendor_agency_connections` has been declared `access: 'read'` in
     * the platform access table since Phase 6, which is what `countByStatus` above already
     * reads. Delegating would have meant building this query in jovi-mall behind an
     * endpoint whose only caller is this service.
     *
     * Every WRITE stays delegated, and here the reason is concrete: a status change on one
     * of these rows suspends and restores the vendor's products in the same transaction.
     *
     * The four narrow fields plus `CONNECTION_ROW_EXTRAS`; the agency decoration is
     * hydrated for the page by the controller, not joined here — see there for why.
     */
    async listForVendor(
        vendorId: string,
        query: ConnectionListQuery,
    ): Promise<Paginated<ConnectionReadModel>> {
        return this.aggregatePage<ConnectionReadModel>(
            {
                page: query.page,
                limit: query.limit,
                sort: toMongoSort(query.sort, VENDOR_AGENCY_CONNECTION_SORT),
            },
            {
                match: [{ $match: buildConnectionFilter(vendorId, query) }],
                project: CONNECTION_ROW_EXTRAS,
            },
        );
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

/**
 * Built here rather than in the controller so the vendor scope cannot be dropped by a
 * caller, and exported so `test-vendors.ts` can assert the branches without a database.
 *
 * Every status by default, terminal rows included — the same call the agency roster makes.
 * A live-only default would make a relationship's history impossible to fetch, which on an
 * administrative surface is most of what the screen is for: a `rejected` row is precisely
 * what an operator opens this panel to explain.
 */
export function buildConnectionFilter(
    vendorId: string,
    query: ConnectionListQuery,
): Filter<ConnectionReadModel> {
    // Pinned first and never overridable by input, for the reason `buildProductFilter`
    // states about `deletedAt`: a scope enforced at the call site is a habit, and a scope
    // enforced in the builder is a rule the next method inherits.
    const filter: Record<string, unknown> = { vendor_id: toConnectionObjectId(vendorId) };

    if (query.status) filter.status = query.status;

    return filter as Filter<ConnectionReadModel>;
}

/**
 * A malformed id must not become an `ObjectId` constructor throw inside the repository.
 *
 * The route's `idParam` already refuses one with a 400, so this branch is unreachable
 * through Express — it exists because the builder is exported and a future caller might
 * not have validated. Matching a string against an `ObjectId` column simply finds nothing,
 * which is the right answer for an id that cannot exist.
 */
function toConnectionObjectId(id: string): ObjectId | string {
    return Types.ObjectId.isValid(id) && id.length === 24 ? new ObjectId(id) : id;
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
