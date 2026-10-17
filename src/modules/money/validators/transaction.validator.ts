import { z } from 'zod';
import { LIMIT_DEFAULT, LIMIT_MAX } from '../../../core/http/list-query';
import { dateRangeFields, dateRangeRule, objectId } from '../../../core/validation/common.schemas';
import {
    TRANSACTION_MAX_RANGE_DAYS,
    TRANSACTION_SORT_FIELDS,
    TransactionSort,
    TransactionSortField,
    decodeCursor,
    sortToken,
} from '../domain/transaction-sources';
import {
    TRANSACTION_DIRECTIONS,
    TRANSACTION_GROUPS,
    TRANSACTION_KINDS,
    TRANSACTION_OUTCOMES,
    TRANSACTION_ROLES,
} from '../read-models/transaction.dto';

/**
 * Request shapes for `/api/v1/money/transactions` (BR-027).
 *
 * ── Both query schemas are `.strict()` ────────────────────────────────────────
 * On a money list a misspelt filter that answers the unfiltered page is the worst outcome
 * available — `?amountMn=50000` reading as "everything". These routes are new, so nothing
 * depends on them being lenient; an unknown parameter is a 400. Listed in
 * `api-doc/api/README.md` § Filtering and pinned by `test:list-strictness`.
 */

/** How many values one "is any of" filter may carry. */
const MAX_VALUES = 20;

/**
 * An "is any of" filter: `?kind=payment,refund`, or the key repeated. Both arrive here —
 * Express hands a repeated key over as an array — and both become one de-duplicated list.
 */
function anyOf<Item extends z.ZodTypeAny>(item: Item) {
    return z
        .union([z.string(), z.array(z.string())])
        .transform((raw) => [
            ...new Set(
                (Array.isArray(raw) ? raw : [raw])
                    .flatMap((value) => value.split(','))
                    .map((value) => value.trim())
                    .filter((value) => value.length > 0),
            ),
        ])
        .pipe(z.array(item).min(1).max(MAX_VALUES));
}

/**
 * A jovi-mall vocabulary — a status, a gateway, a provider, a method, a ledger reason code.
 * Validated for SHAPE, not membership (ADR-005 D-17): this service writes against none of
 * them, and a pinned copy would turn a value added upstream into a 400 for a row the list is
 * already showing.
 */
const platformTerm = z.string().min(1).max(40);

/** An amount bound. Not `.int()`: a comparison against 0.5 is a legitimate question to ask. */
const amount = z.coerce.number().finite().min(0);

const filterFields = {
    kind: anyOf(z.enum(TRANSACTION_KINDS)).optional(),
    group: anyOf(z.enum(TRANSACTION_GROUPS)).optional(),
    direction: anyOf(z.enum(TRANSACTION_DIRECTIONS)).optional(),
    role: anyOf(z.enum(TRANSACTION_ROLES)).optional(),
    partyId: objectId.optional(),
    provider: anyOf(platformTerm).optional(),
    gateway: anyOf(platformTerm).optional(),
    method: anyOf(platformTerm).optional(),
    outcome: anyOf(z.enum(TRANSACTION_OUTCOMES)).optional(),
    status: anyOf(platformTerm).optional(),
    /** Equal to. */
    amount: amount.optional(),
    /** At least / at most — inclusive. */
    amountMin: amount.optional(),
    amountMax: amount.optional(),
    /** Greater than / less than — exclusive, so a client never has to send `n ± 1`. */
    amountGt: amount.optional(),
    amountLt: amount.optional(),
    reasonCode: anyOf(platformTerm).optional(),
    /** Exact, against every reference the kind carries. 128 for the reason `/money/payments` gives. */
    reference: z.string().trim().min(1).max(128).optional(),
    orderId: objectId.optional(),
    bookingId: objectId.optional(),
    ...dateRangeFields(),
};

interface AmountBounds {
    amountMin?: number;
    amountMax?: number;
    amountGt?: number;
    amountLt?: number;
}

/** A range that can contain nothing is a 400, not an empty page that looks like an answer. */
function amountRule(value: AmountBounds, ctx: z.RefinementCtx): void {
    const lower = Math.max(value.amountMin ?? -Infinity, value.amountGt ?? -Infinity);
    const upper = Math.min(value.amountMax ?? Infinity, value.amountLt ?? Infinity);
    if (lower > upper) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['amountMax'],
            message: 'The amount bounds exclude every amount — the lower bound is above the upper one',
        });
    }
}

const SORT_TOKENS = TRANSACTION_SORT_FIELDS.flatMap((field) => [field, `-${field}`]);

const sort = z
    .string()
    .default('-createdAt')
    .refine((raw) => SORT_TOKENS.includes(raw), {
        message: `Sortable fields: ${TRANSACTION_SORT_FIELDS.join(', ')} (prefix with - for descending)`,
    })
    .transform((raw): TransactionSort => {
        const descending = raw.startsWith('-');
        return {
            field: (descending ? raw.slice(1) : raw) as TransactionSortField,
            direction: descending ? -1 : 1,
        };
    });

/**
 * `GET /money/transactions`.
 *
 * Cursor-paged: `cursor` is the `meta.nextCursor` of the previous page, opaque, and valid
 * only under the sort it was issued for — walking `-amount` with a `-createdAt` cursor would
 * resume from a position that means nothing in the new order, so it is refused here.
 */
export const ListTransactionsQuerySchema = z
    .object({
        limit: z.coerce.number().int().min(1).max(LIMIT_MAX).default(LIMIT_DEFAULT),
        cursor: z.string().min(1).max(200).optional(),
        sort,
        ...filterFields,
    })
    .strict()
    .superRefine(dateRangeRule({ maxDays: TRANSACTION_MAX_RANGE_DAYS }))
    .superRefine(amountRule)
    .superRefine((value, ctx) => {
        if (!value.cursor) return;
        const cursor = decodeCursor(value.cursor);
        if (!cursor) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['cursor'], message: 'Not a cursor this list issued' });
        } else if (cursor.sort !== sortToken(value.sort)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['cursor'],
                message: `This cursor was issued for sort "${cursor.sort}" — start again without it to change the sort`,
            });
        }
    });

/** `GET /money/transactions/summary` — the same filters, no paging. */
export const TransactionSummaryQuerySchema = z
    .object(filterFields)
    .strict()
    .superRefine(dateRangeRule({ maxDays: TRANSACTION_MAX_RANGE_DAYS }))
    .superRefine(amountRule);

/** `GET /money/transactions/:kind/:id`. `kind` is ours, so it is pinned. */
export const TransactionParamSchema = z
    .object({ kind: z.enum(TRANSACTION_KINDS), id: objectId })
    .strict();

export type ListTransactionsQuery = z.infer<typeof ListTransactionsQuerySchema>;
export type TransactionSummaryQuery = z.infer<typeof TransactionSummaryQuerySchema>;
export type TransactionParams = z.infer<typeof TransactionParamSchema>;
