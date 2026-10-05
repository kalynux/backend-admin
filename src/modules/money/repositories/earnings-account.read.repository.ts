import { Document, Filter, ObjectId } from 'mongodb';
import { Types } from 'mongoose';
import { toMongoSort } from '../../../core/data/mongo-list';
import { ListQueryBase } from '../../../core/http/list-query';
import { COLLECTIONS } from '../../../infra/platform/collections';
import { Paginated, PlatformReadRepository } from '../../../infra/platform/platform.repository';
import { CLAWBACK_SORT } from '../validators/money.validator';

/**
 * Refund DEBT — `earnings_accounts.clawback_balance` (REFUND-FLOW-PLAN § 6.1), read DIRECTLY.
 *
 * ── Why this balance is read when the other four are asked for ────────────────
 * The money module delegates `pending` / `available` / `reserve` / `requested` because they are
 * `getBalances` reconciling sub-balances only jovi-mall's transactions move (ADR-009 D-1). The
 * debt is one column with no reconciliation behind it: jovi-mall's own invariant is that it is
 * moved only inside the netting updates that write it, and its value IS the record. Reading it is
 * reading a record, so the read-direct rule applies. It is also never summed with the other four
 * — they are what the platform owes the owner; this is what the owner owes the platform.
 *
 * ── Projection ────────────────────────────────────────────────────────────────
 * The owner, the currency, the debt and when it last moved. Nothing else on the account is read.
 */

export interface EarningsAccountDebtReadModel extends Document {
    _id: ObjectId;
    owner_type: string;
    owner_id?: ObjectId | null;
    currency: string;
    /** Absent on a row older than `migrate:earnings-clawback-fields` — read as 0. */
    clawback_balance?: number;
    updated_at?: Date | null;
}

const DEBT_PROJECTION = {
    _id: 1,
    owner_type: 1,
    owner_id: 1,
    currency: 1,
    clawback_balance: 1,
    updated_at: 1,
} as const;

/** Owner types that can owe a refund debt. The platform singletons never do. */
export const DEBT_OWNER_TYPES = ['vendor', 'agency', 'agent'] as const;
export type DebtOwnerType = (typeof DEBT_OWNER_TYPES)[number];

export interface DebtorSearchQuery extends ListQueryBase {
    ownerType?: string;
}

export const debtKey = (ownerType: string, ownerId: string): string => `${ownerType}:${ownerId}`;

export class EarningsAccountDebtReadRepository extends PlatformReadRepository<EarningsAccountDebtReadModel> {
    constructor() {
        super(COLLECTIONS.EARNINGS_ACCOUNT, DEBT_PROJECTION);
    }

    /** Owners who owe something now, largest debt first. */
    async debtors(query: DebtorSearchQuery): Promise<Paginated<EarningsAccountDebtReadModel>> {
        return this.findPage(buildDebtorFilter(query.ownerType), {
            page: query.page,
            limit: query.limit,
            sort: toMongoSort(query.sort, CLAWBACK_SORT),
        });
    }

    /**
     * The whole filtered debt, per currency — the one number a page cannot give. A plain `find`
     * summed here (this module runs no aggregation, `test-money.ts` § 7): debtor rows are few —
     * debt only exists where a refund outran every later earning.
     */
    async debtTotals(ownerType?: string): Promise<Array<{ currency: string; clawback: number; owners: number }>> {
        const rows = await this.findBy(buildDebtorFilter(ownerType));
        const byCurrency = new Map<string, { clawback: number; owners: number }>();
        for (const row of rows) {
            const entry = byCurrency.get(row.currency) ?? { clawback: 0, owners: 0 };
            entry.clawback += row.clawback_balance ?? 0;
            entry.owners += 1;
            byCurrency.set(row.currency, entry);
        }
        return [...byCurrency].map(([currency, entry]) => ({ currency, ...entry }));
    }

    /** One owner's account, or null. */
    async findOwner(ownerType: string, ownerId: string): Promise<EarningsAccountDebtReadModel | null> {
        if (!Types.ObjectId.isValid(ownerId) || ownerId.length !== 24) return null;
        return this.findOneBy({
            owner_type: ownerType,
            owner_id: new ObjectId(ownerId),
        } as Filter<EarningsAccountDebtReadModel>);
    }

    /**
     * The debt of each owner on a page of `GET /money/earnings/accounts` — one query, keyed by
     * `debtKey`. An owner with no row, or a legacy row, reads as 0.
     */
    async debtFor(owners: Array<{ ownerType: string; ownerId: string | null }>): Promise<Map<string, number>> {
        const terms = owners
            .filter((o) => o.ownerId && Types.ObjectId.isValid(o.ownerId) && o.ownerId.length === 24)
            .map((o) => ({ owner_type: o.ownerType, owner_id: new ObjectId(o.ownerId as string) }));
        const debts = new Map<string, number>();
        if (terms.length === 0) return debts;

        const rows = await this.findBy({ $or: terms } as Filter<EarningsAccountDebtReadModel>);
        for (const row of rows) {
            if (row.owner_id) debts.set(debtKey(row.owner_type, row.owner_id.toString()), row.clawback_balance ?? 0);
        }
        return debts;
    }
}

/** Pure, and exported so `test-money.ts` can assert it without a database. */
export function buildDebtorFilter(ownerType?: string): Filter<EarningsAccountDebtReadModel> {
    const filter: Record<string, unknown> = { clawback_balance: { $gt: 0 } };
    if (ownerType) filter.owner_type = ownerType;
    return filter as Filter<EarningsAccountDebtReadModel>;
}
