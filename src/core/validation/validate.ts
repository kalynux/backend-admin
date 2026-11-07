import { Request, Response, NextFunction, RequestHandler } from 'express';
import { AnyZodObject, ZodError, ZodIssueCode, ZodTypeAny } from 'zod';

/**
 * The longest array any request body may contain, at any depth — checked BEFORE Zod runs.
 *
 * ⚠ This is the only mitigation of GHSA-mrhx-c7xc-m3w5 on Zod 3, and a schema `.max()` is
 * NOT one. Zod 3's `ZodArray` records `too_big` and then parses every element anyway
 * (`node_modules/zod/v3/types.js`, `ZodArray._parse`), one issue per failing element, and the
 * error handler copies each into `details.fields`. Measured 2026-10-25: a 1 MB body of
 * `[1,1,1,…]` (524,288 elements) against an object array costs 142 MB of heap and ~0.6 s of
 * blocked event loop — with or without `.max(400)`. The advisory's fix is Zod 4.6.6, so this
 * guard and the CI allowlist entry for that advisory go away together, when this service moves
 * to Zod 4.
 *
 * 1000 is the largest cap any schema here declares (`dev-tools` `eventIds`), so no request a
 * schema would accept is refused by it. Query strings need no guard: qs stops at 1000
 * parameters.
 */
export const MAX_BODY_ARRAY_LENGTH = 1000;

/** The path of the first array longer than the ceiling, or `null`. Iterative: a body may nest deeply. */
export function findOversizedArray(value: unknown, max = MAX_BODY_ARRAY_LENGTH): (string | number)[] | null {
    const stack: { node: unknown; path: (string | number)[] }[] = [{ node: value, path: [] }];
    while (stack.length > 0) {
        const { node, path } = stack.pop()!;
        if (node === null || typeof node !== 'object') continue;
        if (Array.isArray(node)) {
            if (node.length > max) return path;
            node.forEach((item, index) => stack.push({ node: item, path: [...path, index] }));
        } else {
            for (const [key, item] of Object.entries(node)) stack.push({ node: item, path: [...path, key] });
        }
    }
    return null;
}

/** Thrown as a ZodError so the caller gets the same `VALIDATION_ERROR` envelope as any other rule. */
function oversizedArrayError(path: (string | number)[]): ZodError {
    return new ZodError([
        {
            code: ZodIssueCode.too_big,
            maximum: MAX_BODY_ARRAY_LENGTH,
            type: 'array',
            inclusive: true,
            exact: false,
            path,
            message: `Array must contain at most ${MAX_BODY_ARRAY_LENGTH} element(s)`,
        },
    ]);
}

/**
 * Request-validation middleware.
 *
 * jovi-mall validates inline in every controller (`const input = Schema.parse(req.body)`),
 * which works but scatters the contract across ~200 handlers and makes it invisible at the
 * route table. Declaring the schema on the route puts the contract where the path is — and
 * in Phase 2 it sits directly beside that route's `minTier`, so what a request must look
 * like and who may send it are read together.
 *
 * The parsed result REPLACES the request member, so handlers receive coerced, defaulted,
 * stripped values rather than raw strings. That is the point of validating at all —
 * `req.query.page` arrives as `'2'` and should reach the handler as `2`.
 *
 * ZodErrors are thrown, not caught: the global error handler already renders them into the
 * documented `VALIDATION_ERROR` envelope with per-field details, and duplicating that here
 * would create a second format for the same failure.
 */
export interface ValidationTargets {
    body?: AnyZodObject | ZodTypeAny;
    query?: AnyZodObject | ZodTypeAny;
    params?: AnyZodObject | ZodTypeAny;
}

export const validate = (targets: ValidationTargets): RequestHandler =>
    (req: Request, _res: Response, next: NextFunction): void => {
        try {
            if (targets.params) req.params = targets.params.parse(req.params);
            if (targets.query) {
                // Express 4 exposes `req.query` as a plain own property, so it is assignable.
                // (Express 5 makes it a getter — if this service ever upgrades, the parsed
                // value has to be carried on a separate property instead.)
                req.query = targets.query.parse(req.query);
            }
            if (targets.body) {
                const oversized = findOversizedArray(req.body);
                if (oversized) throw oversizedArrayError(oversized);
                req.body = targets.body.parse(req.body);
            }
            next();
        } catch (error) {
            next(error);
        }
    };
