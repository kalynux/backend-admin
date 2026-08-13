import { SortMap, SortSpec } from '../http/list-query';

/**
 * Turning a validated list query into a Mongo query.
 *
 * The counterpart to `core/http/list-query.ts`: that file decides what a client is allowed
 * to ask for, this one decides what the database is asked. Both halves are used by the
 * platform read repositories AND by this service's own Mongoose repositories, because the
 * two hazards below are properties of Mongo, not of which database it is.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Sorting
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Translate a validated `SortSpec` into a Mongo sort document.
 *
 * **`_id` is appended as a tiebreaker, always.** Skip/limit paging over a non-unique sort
 * key is not stable: two documents sharing a `created_at` may be ordered differently
 * between the query for page 1 and the query for page 2, so one of them appears twice and
 * the other never appears at all. It is rare enough to survive testing and common enough to
 * be reported as "a record is missing from the list", which is unfalsifiable from a bug
 * report. A unique final key removes the whole class.
 *
 * @throws RangeError if the field is not in the map — which cannot happen through a
 *         `listQuery` schema (it validates against the same map), so reaching it means a
 *         handler built a `SortSpec` by hand and skipped validation.
 */
export function toMongoSort(spec: SortSpec, sortable: SortMap): Record<string, 1 | -1> {
    const path = sortable[spec.field];

    if (!path) {
        throw new RangeError(
            `"${spec.field}" is not a sortable field (${Object.keys(sortable).join(', ')}). `
            + 'A SortSpec must come from a listQuery() schema built with the same SortMap.',
        );
    }

    if (path === '_id') return { _id: spec.direction };

    return { [path]: spec.direction, _id: spec.direction };
}

// ─────────────────────────────────────────────────────────────────────────────
// Search
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Neutralise every regex metacharacter in a user-supplied search term.
 *
 * Mongo's `$regex` takes a pattern, and an admin searching for `a.b` must not have the `.`
 * read as "any character" — that is a correctness bug the searcher can see. The one they
 * cannot see is worse: `(a+)+$` is a catastrophic-backtracking pattern, and an unescaped
 * search box is a denial-of-service endpoint that looks like a feature.
 *
 * The escape must therefore be impossible to skip, which is why no repository builds a
 * `RegExp` from a raw term — they call `containsInsensitive` or `matchAnyField`.
 */
export function escapeRegex(term: string): string {
    return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A case-insensitive "contains" pattern, safely escaped. */
export function containsInsensitive(term: string): RegExp {
    return new RegExp(escapeRegex(term), 'i');
}

/**
 * A `$or` fragment matching a search term against any of several fields.
 *
 * Spread into a filter:
 *
 *   if (query.search) Object.assign(filter, matchAnyField(['login_email', 'login_phone'], query.search));
 *
 * Returns `{}` for a blank term so a caller cannot accidentally build `{ $or: [] }`, which
 * Mongo rejects at query time rather than treating as "no constraint".
 */
export function matchAnyField(fields: readonly string[], term: string): Record<string, unknown> {
    const trimmed = term.trim();
    if (trimmed === '' || fields.length === 0) return {};

    const pattern = containsInsensitive(trimmed);
    return { $or: fields.map((field) => ({ [field]: pattern })) };
}
