import { Request, Response, NextFunction, RequestHandler } from 'express';
import { AnyZodObject, ZodTypeAny } from 'zod';

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
            if (targets.body) req.body = targets.body.parse(req.body);
            next();
        } catch (error) {
            next(error);
        }
    };
