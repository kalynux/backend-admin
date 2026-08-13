import { z } from 'zod';

/**
 * The shared request vocabulary — the field types that recur across every module.
 *
 * ── Why these are here and not in each validator ──────────────────────────────
 * By Phase 4 the 24-hex id regex had been written out four times (users, cod,
 * administrators, approvals) and the `page`/`limit` pair four times. Four copies of a rule
 * is four chances for the fifth to be subtly different — a `max(200)` here, a missing
 * `.trim()` there — and the difference only ever shows up as a dashboard bug. With 76
 * endpoints still to port, a shared vocabulary is the difference between one contract and
 * seventy-six near-identical ones.
 *
 * Everything here is pure and DB-free, which is why `scripts/test/test-api-contract.ts`
 * can assert all of it without infrastructure.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Identifiers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A MongoDB ObjectId as it travels on the wire: a 24-character hex string.
 *
 * Validated at the edge rather than left to Mongoose's CastError, because a 404 produced
 * by a cast failure says "not found" for a request that was never well-formed. A caller
 * sending `?agencyId=null` should be told the id is malformed.
 */
export const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Not a valid id');

/**
 * A path-parameter schema for a single id.
 *
 * @example
 *   validate: { params: idParam('agentId', 'agent') }   // → "Not a valid agent id"
 */
export function idParam<Name extends string>(name: Name, label?: string) {
    const message = label ? `Not a valid ${label} id` : 'Not a valid id';
    return z.object({ [name]: z.string().regex(/^[a-f\d]{24}$/i, message) } as Record<
        Name,
        z.ZodString
    >);
}

// ─────────────────────────────────────────────────────────────────────────────
// Text
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A free-text search term.
 *
 * Trimmed, bounded, and never empty: `?search=` with no value is the same request as no
 * `search` at all, and letting an empty string through means every repository has to
 * decide separately whether to build a filter for it.
 *
 * The bound matters more than it looks. This term reaches a regex (see
 * `core/data/mongo-list.ts`), and an unbounded one is a pattern-length attack on the query
 * planner even after escaping.
 */
export const searchTerm = z.string().trim().min(1).max(120);

/**
 * A required, trimmed reason — for the actions that refuse to happen unexplained.
 *
 * The message is a parameter and has no default worth relying on: "A reason is required to
 * reject a remittance" tells an administrator which of the two forms on their screen is
 * incomplete, and "A reason is required" does not.
 */
export function reasonText(message: string, { min = 3, max = 500 } = {}) {
    return z.string().trim().min(min, message).max(max);
}

// ─────────────────────────────────────────────────────────────────────────────
// Booleans in query strings
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A boolean query flag — `?includeArchived=true`.
 *
 * **Do not reach for `z.coerce.boolean()`.** It applies JavaScript truthiness, so the
 * string `'false'` coerces to `true` and a client explicitly switching a flag off switches
 * it on. That is not a hypothetical: it is the single most common Zod-in-a-query-string
 * defect, and it fails silently in exactly the direction that shows more data.
 */
export const boolFlag = z
    .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
    .transform((value) => value === true || value === 'true' || value === '1');

// ─────────────────────────────────────────────────────────────────────────────
// Time
// ─────────────────────────────────────────────────────────────────────────────

/**
 * An instant, as ISO-8601 with an explicit zone (`2026-08-11T09:00:00.000Z`, or an offset).
 *
 * **Date-only values are refused on purpose.** "2026-08-11" is not an instant — it is a
 * day in some timezone, and the server cannot know which. jovi-mall has already paid for
 * that guess once: availability rules defaulted to `'UTC'` and every vendor's working day
 * shifted when the server moved. An admin filtering "yesterday's remittances" from Douala
 * means a different 24 hours than one filtering from Lisbon, so the client resolves the day
 * and sends the instants.
 */
export const isoDateTime = z
    .string()
    .datetime({ offset: true, message: 'Expected an ISO-8601 instant with a zone, e.g. 2026-08-11T09:00:00.000Z' })
    .transform((value) => new Date(value));

/**
 * The `from` / `to` pair for a time-filtered list.
 *
 * **The interval is half-open: `[from, to)`.** An inclusive end forces every client to send
 * `23:59:59.999` and every server to decide whether milliseconds count; half-open makes
 * consecutive ranges tile exactly and never double-count a row that lands on the boundary.
 * Both sides are optional — `from` alone is "since", `to` alone is "until".
 */
export function dateRangeFields() {
    return {
        from: isoDateTime.optional(),
        to: isoDateTime.optional(),
    };
}

/**
 * The cross-field rule for the pair above, as a `superRefine` callback.
 *
 * Separate from the fields because Zod can only express a rule spanning two keys at the
 * object level:
 *
 *   listQuery(SORT, '-createdAt', { ...dateRangeFields() })
 *       .superRefine(dateRangeRule({ maxDays: 92 }))
 *
 * `maxDays` is not politeness. These ranges become unindexed scans over collections with
 * millions of rows, and an unbounded one is a query an administrator can point at the
 * production database by accident.
 */
export function dateRangeRule({ maxDays }: { maxDays?: number } = {}) {
    return (value: { from?: Date; to?: Date }, ctx: z.RefinementCtx): void => {
        const { from, to } = value;
        if (!from || !to) return;

        if (to.getTime() <= from.getTime()) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['to'],
                message: '`to` must be after `from` — the range is half-open, [from, to)',
            });
            return;
        }

        if (maxDays !== undefined) {
            const spanDays = (to.getTime() - from.getTime()) / 86_400_000;
            if (spanDays > maxDays) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ['to'],
                    message: `The range may not exceed ${maxDays} days (asked for ${Math.ceil(spanDays)})`,
                });
            }
        }
    };
}
