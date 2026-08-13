import { z } from 'zod';
import { PaginationMeta } from './responses';
// One-way: `common.schemas` imports zod and nothing else, so this cannot cycle.
import { isoDateTime } from '../validation/common.schemas';

/**
 * The list contract: how a collection endpoint is asked for a page, and how it answers.
 *
 * ── One definition, because two already disagreed ─────────────────────────────
 * Before this file, `pages` was computed in three places by hand.
 * `PlatformReadRepository.findPage` used `Math.max(1, ceil(total / limit))` while both
 * controllers used a bare `Math.ceil(...)`, so an empty result set reported `pages: 1` from
 * `/users` and `pages: 0` from `/administrators`. A dashboard that renders a pager from
 * `meta.pages` shows a phantom page one on exactly one of those screens. Nobody wrote that
 * inconsistency deliberately; it is what three copies of a two-line formula produce.
 *
 * `toPageMeta` is now the only place the arithmetic exists, and it matches the platform
 * contract documented in `jovi-mall/api-doc/README.md`: **`pages = ceil(total / limit)`, so
 * an empty list has zero pages.**
 *
 * ── The sort allowlist is not decoration ──────────────────────────────────────
 * A client names a *wire* field (`-createdAt`); the schema refuses anything the endpoint
 * has not declared sortable, and `toMongoSort` translates the survivor to its database
 * path. Two things follow from that indirection, and both are the point:
 *
 *   1. no client-supplied string ever reaches a Mongo `sort` document, so nobody can sort
 *      a million-row collection by an unindexed field and take the database down with a
 *      query string
 *   2. the wire name is decoupled from the column, which is what lets this service present
 *      camelCase over jovi-mall's snake_case schema without a translation table per handler
 */

// ─────────────────────────────────────────────────────────────────────────────
// Pagination
// ─────────────────────────────────────────────────────────────────────────────

export const PAGE_DEFAULT = 1;
export const LIMIT_DEFAULT = 20;

/**
 * The hard ceiling on page size, everywhere.
 *
 * Not per-endpoint: an administrator exporting "everything" is a real need, and the answer
 * to it is a paged export or a report — never a `?limit=100000` that pins a Node process
 * while it serialises the result.
 */
export const LIMIT_MAX = 100;

/**
 * `page` / `limit`, coerced from the strings Express puts in `req.query`.
 *
 * Spread into a schema when an endpoint needs paging but no sort — `listQuery` below is
 * the usual entry point.
 */
export const paginationFields = {
    page: z.coerce.number().int().min(1).default(PAGE_DEFAULT),
    limit: z.coerce.number().int().min(1).max(LIMIT_MAX).default(LIMIT_DEFAULT),
};

/** `{ total, page, limit, pages }` — the only place `pages` is computed. */
export function toPageMeta(total: number, page: number, limit: number): PaginationMeta {
    return {
        total,
        page,
        limit,
        // ceil(0 / n) is 0: an empty list has no pages, and a pager rendered from this
        // shows nothing rather than an empty page one.
        pages: Math.ceil(total / limit),
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cursor pagination — the deliberate exception
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every list in this service is offset-paged with `toPageMeta`. **One is not**, and the
 * exception is narrow enough to be worth stating rather than generalising.
 *
 * `GET /accounts/:ownerType/:ownerId/activity` merges FIVE independent collections —
 * plan purchases, credit top-ups, credit transactions, earnings ledger rows and payout
 * requests — into one chronological feed. There is no query that can page that:
 *
 *   - `$unionWith` is unavailable. `PlatformReadRepository` takes one collection and one
 *     projection at construction, and a five-way union would need a single repository
 *     projecting the union of five schemas — the widened projection the two-lock
 *     convention exists to prevent.
 *   - An exact `total` costs five `countDocuments` on every page.
 *   - Offset paging over a merge is WRONG even with the counts: `skip(40)` applied to
 *     five sources independently does not compose into rows 40–60 of the merged order.
 *
 * So this feed is cursor-paged and reports no `total` and no `pages`. That is honest
 * rather than lossy: ADR-005 D-13 forbids silent truncation, and a page count that drifts
 * as you walk it is exactly that, dressed as a number.
 *
 * Do not reach for this on an ordinary list. One collection means `toPageMeta`.
 */

/** `?before=<ISO instant>&limit=` — the cursor form of `paginationFields`. */
export const cursorFields = {
    /**
     * Strictly-older-than, never inclusive. An inclusive cursor repeats the boundary row
     * on every page, which on a money feed reads as a duplicate transaction.
     */
    before: isoDateTime.optional(),
    limit: z.coerce.number().int().min(1).max(LIMIT_MAX).default(LIMIT_DEFAULT),
};

/** A cursor-paged list's `meta`. Deliberately carries no `total` and no `pages`. */
export interface CursorMeta {
    limit: number;
    /** Pass back as `?before=` for the next page. `null` at the end of the feed. */
    nextCursor: string | null;
    hasMore: boolean;
    [key: string]: number | string | boolean | null | undefined;
}

/**
 * Build a cursor page's `meta`.
 *
 * `hasMore` is derived from the cursor rather than from a count: a caller fetches
 * `limit + 1` rows, and a non-null `nextCursor` is exactly "there was an extra one".
 * Keeping both on the wire means a client never has to infer one from the other.
 */
export function cursorMeta(nextCursor: string | null, limit: number): CursorMeta {
    return { limit, nextCursor, hasMore: nextCursor !== null };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sorting
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What an endpoint may be sorted by: **wire field name → database path**.
 *
 * Declared `as const` beside the endpoint's schema and handed to both `listQuery` (which
 * validates against its keys) and `toMongoSort` (which reads its values), so the allowlist
 * and the translation cannot drift apart.
 *
 * @example
 *   export const USER_SORT = { createdAt: 'created_at', updatedAt: 'updated_at' } as const;
 */
export type SortMap = Readonly<Record<string, string>>;

/** A parsed `sort` parameter. `field` is the WIRE name — translate before querying. */
export interface SortSpec {
    field: string;
    direction: 1 | -1;
}

/** `-createdAt` → descending, `createdAt` → ascending. Total: never throws. */
function parseSortToken(raw: string): SortSpec {
    const descending = raw.startsWith('-');
    return { field: descending ? raw.slice(1) : raw, direction: descending ? -1 : 1 };
}

/**
 * The `sort` query parameter, validated against an endpoint's allowlist.
 *
 * @param sortable the endpoint's `SortMap`
 * @param fallback the order used when the client sends none, e.g. `'-createdAt'`. A list
 *        with no explicit order is a list whose paging is undefined — Mongo may return the
 *        same document on two pages — so a default is required, not optional.
 */
export function sortSchema(sortable: SortMap, fallback: string) {
    const allowed = Object.keys(sortable);

    if (allowed.length === 0) {
        throw new RangeError('sortSchema() needs at least one sortable field');
    }
    if (!allowed.includes(parseSortToken(fallback).field)) {
        // A typo in the default would otherwise 400 every request to the endpoint that has
        // it — including the ones that sent no `sort` at all. Fail at import instead.
        throw new RangeError(`Default sort "${fallback}" is not in the sortable set: ${allowed.join(', ')}`);
    }

    return z
        .string()
        .default(fallback)
        .superRefine((raw, ctx) => {
            const { field } = parseSortToken(raw);
            if (!allowed.includes(field)) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: `Cannot sort by "${field}". Sortable fields: ${allowed.join(', ')} (prefix with - for descending)`,
                });
            }
        })
        .transform(parseSortToken);
}

// ─────────────────────────────────────────────────────────────────────────────
// The builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A list endpoint's query schema: pagination + a validated sort + whatever else it filters
 * on.
 *
 * @example
 *   const USER_SORT = { createdAt: 'created_at' } as const;
 *
 *   export const SearchUsersQuerySchema = listQuery(USER_SORT, '-createdAt', {
 *       search: searchTerm.optional(),
 *       status: z.enum(['active', 'suspended']).optional(),
 *   });
 *
 * Add a cross-field rule with `.superRefine(...)` — see `dateRangeRule` in
 * `core/validation/common.schemas.ts`.
 */
export function listQuery<Shape extends z.ZodRawShape = Record<string, never>>(
    sortable: SortMap,
    defaultSort: string,
    shape: Shape = {} as Shape,
) {
    return z
        .object({
            ...paginationFields,
            sort: sortSchema(sortable, defaultSort),
        })
        .extend(shape);
}

/** The shape every `listQuery` result carries, for handlers that take one generically. */
export interface ListQueryBase {
    page: number;
    limit: number;
    sort: SortSpec;
}
