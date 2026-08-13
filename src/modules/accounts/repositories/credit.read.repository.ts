import { Document, Filter, ObjectId } from 'mongodb';
import { Types } from 'mongoose';
import { toMongoSort } from '../../../core/data/mongo-list';
import { ListQueryBase } from '../../../core/http/list-query';
import { COLLECTIONS } from '../../../infra/platform/collections';
import { Paginated, PlatformReadRepository } from '../../../infra/platform/platform.repository';
import { CREDIT_SORT } from '../validators/account.validator';

/**
 * The credit side of an account: the wallet, its ledger, and the top-ups that fund it.
 *
 * ── Credits are not money, and this file is where that starts being enforced ───
 * A credit is a metered-action unit. It has no currency, it never expires, and it cannot be
 * paid out — plan allowances, purchased packs and leftovers from a previous plan all
 * accumulate in one wallet. Adding a credit balance to an earnings balance is not a number,
 * which is why `account.dto.ts` gives every balance a `unit` and a `direction` and refuses
 * to emit a grand total.
 *
 * The one place the two DO meet is a top-up: money out, credits in, one row. jovi-mall
 * models that as a `credit_topups` row carrying BOTH `price`/`currency` and `credits`, and
 * this service renders it the same way rather than splitting it into two feed entries that
 * would each look like half a fact.
 *
 * ── The dedup rule, carried over rather than rediscovered ─────────────────────
 * A paid top-up writes a `credit_topups` row AND a `credit_transactions` row
 * (`reason_code: 'topup_purchase'`); a reversal writes another (`'topup_reversal'`). Both
 * describe an event the top-up row already describes. `TOPUP_REASON_CODES` below excludes
 * them from every ledger read on this surface, exactly as
 * `jovi-mall/src/modules/transactions/services/vendor-transaction.service.ts` does — without
 * it, every top-up appears twice on the activity feed and the credits column double-counts.
 */

// ─────────────────────────────────────────────────────────────────────────────
// The wallet — one row per owner
// ─────────────────────────────────────────────────────────────────────────────

export interface CreditWalletReadModel extends Document {
    _id: ObjectId;
    owner_type: string;
    owner_id: ObjectId;
    balance: number;
    /** Always the literal `'credit'` — jovi-mall stores it for explicitness, and so do we. */
    currency_unit?: string;
    created_at: Date;
    updated_at: Date;
}

/**
 * `version` is deliberately absent: it is the optimistic-locking counter jovi-mall's debit
 * path compare-and-sets on, and it means nothing to a reader. A field with no reader does
 * not belong in a whitelist.
 */
const CREDIT_WALLET_PROJECTION = {
    _id: 1,
    owner_type: 1,
    owner_id: 1,
    balance: 1,
    currency_unit: 1,
    created_at: 1,
    updated_at: 1,
} as const;

export class CreditWalletReadRepository extends PlatformReadRepository<CreditWalletReadModel> {
    constructor() {
        super(COLLECTIONS.CREDIT_WALLET, CREDIT_WALLET_PROJECTION);
    }

    /**
     * `null` means the owner has never had a wallet — it is created lazily, on first
     * allowance or top-up.
     *
     * That is NOT the same as a zero balance, and `account.dto.ts` keeps them apart: a
     * missing wallet still renders `credits: { balance: 0 }` because a vendor CAN hold
     * credits, where `codCash: null` on the same response means a vendor cannot owe COD
     * cash at all. "Applies, currently empty" and "does not apply" are different facts.
     */
    async findForOwner(ownerType: string, ownerId: string): Promise<CreditWalletReadModel | null> {
        if (!Types.ObjectId.isValid(ownerId)) return null;
        return this.findOneBy({
            owner_type: ownerType,
            owner_id: new ObjectId(ownerId),
        } as Filter<CreditWalletReadModel>);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// The credit ledger
// ─────────────────────────────────────────────────────────────────────────────

export interface CreditTransactionReadModel extends Document {
    _id: ObjectId;
    wallet_id: ObjectId;
    owner_type: string;
    owner_id: ObjectId;
    /** `allowance` · `topup` · `debit` · `adjustment` · `refund`. */
    type: string;
    /** **Signed**: positive credits the wallet, negative debits it. */
    amount: number;
    balance_after: number;
    /** `plan_allowance` · `topup_purchase` · `vectorisation` · `whatsapp_template` · … */
    reason_code: string;
    /** Free-form reference to whatever caused it — a product id, a message id, a plan id. */
    ref?: string | null;
    created_at: Date;
}

const CREDIT_TRANSACTION_PROJECTION = {
    _id: 1,
    wallet_id: 1,
    owner_type: 1,
    owner_id: 1,
    type: 1,
    amount: 1,
    balance_after: 1,
    reason_code: 1,
    ref: 1,
    created_at: 1,
} as const;

/**
 * The two reason codes whose event is already represented by a `credit_topups` row.
 *
 * Excluded from every read here. See the file header — this is the dedup rule, and dropping
 * it makes every top-up appear twice.
 */
export const TOPUP_REASON_CODES = ['topup_purchase', 'topup_reversal'] as const;

/**
 * The filter terms, split from the paging ones so `listBefore` can build a filter without
 * inventing a `page`/`limit`/`sort` it does not use. The cursor feed pages by `before`; the
 * offset list pages by `page`. One set of terms, two ways of walking them.
 */
export interface CreditFilterQuery {
    type?: string;
    reasonCode?: string;
    /** The activity feed's cursor — strictly older than, never inclusive. */
    before?: Date;
}

export interface CreditSearchQuery extends ListQueryBase, CreditFilterQuery {}

export class CreditTransactionReadRepository extends PlatformReadRepository<CreditTransactionReadModel> {
    constructor() {
        super(COLLECTIONS.CREDIT_TRANSACTION, CREDIT_TRANSACTION_PROJECTION);
    }

    /** `GET /accounts/:ownerType/:ownerId/credits` — offset-paged, one collection. */
    async search(
        ownerType: string,
        ownerId: string,
        query: CreditSearchQuery,
    ): Promise<Paginated<CreditTransactionReadModel>> {
        return this.findPage(buildCreditFilter(ownerType, ownerId, query), {
            page: query.page,
            limit: query.limit,
            sort: toMongoSort(query.sort, CREDIT_SORT),
        });
    }

    /** One source of the merged activity feed. See `account-activity.read.repository.ts`. */
    async listBefore(
        ownerType: string,
        ownerId: string,
        before: Date | undefined,
        limit: number,
    ): Promise<CreditTransactionReadModel[]> {
        return this.findBy(
            buildCreditFilter(ownerType, ownerId, { before }),
            { sort: { created_at: -1, _id: -1 }, limit },
        );
    }
}

/**
 * Pure, and exported so `test-accounts.ts` can assert the dedup term is always present
 * without a database. **The owner terms are not the caller's** — the route already decided
 * whose ledger this is, and building them here is what stops a future caller composing a
 * query that reads every owner's credits at once.
 */
export function buildCreditFilter(
    ownerType: string,
    ownerId: string,
    query: CreditFilterQuery,
): Filter<CreditTransactionReadModel> {
    const clauses: Record<string, unknown>[] = [
        { owner_type: ownerType },
        { owner_id: toObjectIdOrNothing(ownerId) },
        // Never optional, never behind a flag: a top-up is one event and the `credit_topups`
        // row is the one that describes it.
        { reason_code: { $nin: [...TOPUP_REASON_CODES] } },
    ];

    if (query.type) clauses.push({ type: query.type });
    if (query.reasonCode) clauses.push({ reason_code: query.reasonCode });
    if (query.before) clauses.push({ created_at: { $lt: query.before } });

    return { $and: clauses } as Filter<CreditTransactionReadModel>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Top-ups — the one row that is money AND credits
// ─────────────────────────────────────────────────────────────────────────────

export interface CreditTopupReadModel extends Document {
    _id: ObjectId;
    owner_type: string;
    owner_id: ObjectId;
    pack_code: string;
    credits: number;
    /** What the owner PAID, in `currency`. The credits bought are `credits`. */
    price: number;
    currency: string;
    /** `pending` · `paid` · `failed` · `reversed`. */
    status: string;
    gateway?: string | null;
    gateway_ref?: string | null;
    payment_transaction_id?: ObjectId | null;
    created_at: Date;
    updated_at: Date;
}

const CREDIT_TOPUP_PROJECTION = {
    _id: 1,
    owner_type: 1,
    owner_id: 1,
    pack_code: 1,
    credits: 1,
    price: 1,
    currency: 1,
    status: 1,
    gateway: 1,
    gateway_ref: 1,
    payment_transaction_id: 1,
    created_at: 1,
    updated_at: 1,
} as const;

export class CreditTopupReadRepository extends PlatformReadRepository<CreditTopupReadModel> {
    constructor() {
        super(COLLECTIONS.CREDIT_TOPUP, CREDIT_TOPUP_PROJECTION);
    }

    async listBefore(
        ownerType: string,
        ownerId: string,
        before: Date | undefined,
        limit: number,
    ): Promise<CreditTopupReadModel[]> {
        return this.findBy(
            ownerScopedFilter<CreditTopupReadModel>(ownerType, ownerId, before),
            { sort: { created_at: -1, _id: -1 }, limit },
        );
    }
}

/**
 * `{owner_type, owner_id}` plus the cursor — the filter every activity source but the
 * credit ledger uses. That one needs the dedup term as well, so it builds its own.
 */
export function ownerScopedFilter<T extends Document>(
    ownerType: string,
    ownerId: string,
    before: Date | undefined,
): Filter<T> {
    const clauses: Record<string, unknown>[] = [
        { owner_type: ownerType },
        { owner_id: toObjectIdOrNothing(ownerId) },
    ];
    if (before) clauses.push({ created_at: { $lt: before } });
    return { $and: clauses } as Filter<T>;
}

/** A malformed id becomes a term matching nothing, rather than a thrown BSONError. */
function toObjectIdOrNothing(value: string): ObjectId | { $in: [] } {
    return Types.ObjectId.isValid(value) && value.length === 24
        ? new ObjectId(value)
        : { $in: [] };
}
