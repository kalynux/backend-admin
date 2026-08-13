import { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Wraps an async Express handler so an unhandled promise rejection reaches the global
 * error handler via `next(err)` instead of hanging the request.
 *
 * Ported verbatim from `jovi-mall/src/api/middlewares/async-handler.ts`.
 *
 * Usage:
 *   router.get('/path', asyncHandler(myAsyncController));
 */
export const asyncHandler = (fn: RequestHandler): RequestHandler =>
    (req: Request, res: Response, next: NextFunction): void => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
