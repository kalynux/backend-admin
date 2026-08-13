import { z } from 'zod';

/**
 * Clearable optional field for PATCH bodies.
 *
 * Ported verbatim from `jovi-mall/src/core/validation/zod.helpers.ts` — it is an
 * established platform convention, and admin profile editing needs exactly it.
 *
 * `.optional()` alone only means "the key may be absent" — once the key is present, the
 * value must still satisfy the wrapped constraint. A field validated as
 * `z.string().url().optional()` can therefore never be emptied again: `''` fails `.url()`
 * and `null` fails the string type check.
 *
 * `clearable()` adds the missing "clear" semantics:
 *
 *   - key absent            → leave the field unchanged
 *   - `null`, `''`, `'  '`  → clear the field (mappers receive `null`)
 *   - anything else         → must satisfy the wrapped schema
 *
 * Empty/whitespace-only strings normalise to `null` because an emptied form input
 * naturally submits `''`; frontends should not have to special-case that.
 *
 * Usage:
 *   jobTitle: clearable(z.string().min(1).max(100)),
 */
export function clearable<T extends z.ZodTypeAny>(schema: T) {
    return z.preprocess(
        (value) => (typeof value === 'string' && value.trim() === '' ? null : value),
        schema.nullable().optional(),
    );
}

/**
 * Comma-separated string → trimmed, non-empty string array.
 *
 * Used by the env schema for `ADMIN_DASHBOARD_ORIGINS`. Kept here rather than inline in
 * the config so the CSV parsing rule has one definition and one test.
 */
export const csvList = z
    .string()
    .transform((value) => value.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0));

/**
 * A bare HTTP(S) **origin** — `scheme://host[:port]`, nothing more.
 *
 * `z.string().url()` is NOT sufficient here and the difference is a real misconfiguration:
 * `new URL('localhost:5175')` parses happily, reading `localhost:` as the scheme and
 * `5175` as the path, so `.url()` accepts it. A browser's `Origin` header is always a
 * full `scheme://host[:port]`, so that entry would sit in the allowlist matching nothing
 * — the dashboard would be blocked by CORS with a config file that looks correct.
 *
 * Also rejects a path, query or fragment for the same reason: `https://x.test/admin` can
 * never equal an `Origin` header either.
 *
 * The value is normalised to `URL.origin`, so a trailing slash is accepted on input and a
 * byte-exact comparison against the header is safe at request time.
 */
export const httpOrigin = z
    .string()
    .superRefine((value, ctx) => {
        let parsed: URL;
        try {
            parsed = new URL(value);
        } catch {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `"${value}" is not a valid origin — expected scheme://host[:port], e.g. https://admin.example.com`,
            });
            return;
        }

        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `"${value}" must use http:// or https:// (got "${parsed.protocol}")`,
            });
            return;
        }

        const hasExtra = (parsed.pathname !== '' && parsed.pathname !== '/') || parsed.search !== '' || parsed.hash !== '';
        if (hasExtra) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `"${value}" must be a bare origin with no path, query or fragment`,
            });
        }
    })
    .transform((value) => new URL(value).origin);
