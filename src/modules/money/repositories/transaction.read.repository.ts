import { Document, Filter, ObjectId } from 'mongodb';
import { COLLECTIONS } from '../../../infra/platform/collections';
import { PlatformReadRepository } from '../../../infra/platform/platform.repository';
import {
    TRANSACTION_SOURCES,
    TransactionSource,
    TransactionSummaryRaw,
    buildSummaryPipeline,
} from '../domain/transaction-sources';
import { TRANSACTION_KINDS, TransactionKind } from '../read-models/transaction.dto';

/**
 * The readers behind `GET /money/transactions` — one per kind, each over its own collection
 * with its own narrow whitelist (`domain/transaction-sources.ts` holds both).
 *
 * ── Why eleven repositories and not one `$unionWith` ────────────────────────────
 * `PlatformReadRepository` takes one collection and one projection at construction, and a
 * eleven-way union would need a single reader projecting the union of eleven schemas — the
 * widened projection the two-lock convention exists to prevent. So each source answers its
 * own query and the merge is application code; see `mergeTransactionPage` for why a keyset
 * makes that merge exact.
 *
 * Three queries, all read-only by construction (the base class has no write method): a page,
 * one row, and a grouped count. The filter is built by `buildSourceFilter` and never by a
 * caller, so nothing here can be pointed at a kind the viewer may not read.
 */
export class TransactionSourceReadRepository extends PlatformReadRepository<Document> {
    constructor(readonly source: TransactionSource) {
        super(source.collection, source.projection);
    }

    /** `limit` rows in the given order. The caller asks for one more than it will show. */
    async page(filter: Document, sort: Record<string, 1 | -1>, limit: number): Promise<Document[]> {
        return this.findBy(filter as Filter<Document>, { sort, limit });
    }

    /**
     * One row of this kind, or `null`.
     *
     * The source's `base` filter applies here too: a `delivery_fee_refunds` row the gateway
     * settled is not a transaction of this kind (it is the `refund` kind's row), so opening
     * it by id under this kind is a 404, the same answer the list gives by omission.
     */
    async findById(rowId: string): Promise<Document | null> {
        if (!/^[a-f\d]{24}$/i.test(rowId)) return null;
        const byId = { _id: new ObjectId(rowId) };
        const filter = this.source.base ? { $and: [byId, this.source.base] } : byId;
        return this.findOneBy(filter as Filter<Document>);
    }

    async summarise(filter: Document): Promise<TransactionSummaryRaw[]> {
        return this.aggregateBy<TransactionSummaryRaw>(buildSummaryPipeline(this.source, filter));
    }
}

/** One reader per kind, built once. */
export const TRANSACTION_REPOSITORIES: Readonly<Record<TransactionKind, TransactionSourceReadRepository>> =
    Object.freeze(
        Object.fromEntries(
            TRANSACTION_KINDS.map((kind) => [kind, new TransactionSourceReadRepository(TRANSACTION_SOURCES[kind])]),
        ) as Record<TransactionKind, TransactionSourceReadRepository>,
    );

// ─────────────────────────────────────────────────────────────────────────────
// A ledger row's currency
// ─────────────────────────────────────────────────────────────────────────────

interface AccountCurrencyReadModel extends Document {
    _id: ObjectId;
    currency?: string | null;
}

/**
 * One label, and the projection cannot express anything else — no balance of any kind is
 * named here. `earnings_ledgers` rows carry no currency of their own; their account does.
 * The same reasoning, and the same single field, as `EarningsCurrencyReadRepository` on the
 * account view, which looks an account up by owner where this needs it by account id.
 */
const ACCOUNT_CURRENCY_PROJECTION = { _id: 1, currency: 1 } as const;

export class EarningsAccountCurrencyReadRepository extends PlatformReadRepository<AccountCurrencyReadModel> {
    constructor() {
        super(COLLECTIONS.EARNINGS_ACCOUNT, ACCOUNT_CURRENCY_PROJECTION);
    }

    /** `earnings_accounts._id` → currency, for the accounts on one page. One batched read. */
    async findCurrencies(accountIds: string[]): Promise<Map<string, string>> {
        const ids = [...new Set(accountIds)].filter((value) => /^[a-f\d]{24}$/i.test(value));
        if (ids.length === 0) return new Map();

        const rows = await this.findBy(
            { _id: { $in: ids.map((value) => new ObjectId(value)) } } as Filter<AccountCurrencyReadModel>,
            { limit: ids.length },
        );
        return new Map(
            rows.flatMap((row) => (row.currency ? [[row._id.toString(), row.currency] as [string, string]] : [])),
        );
    }
}
