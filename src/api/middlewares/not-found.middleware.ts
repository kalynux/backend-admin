import { Request, Response, NextFunction } from 'express';
import { createAppError } from '../../core/errors/app-error';
import { ERROR_CODES } from '../../core/errors/error-codes';

/**
 * Catch-all for unmatched routes. Registered after every router and before the error
 * handler, so a wrong URL returns the same envelope as every other failure rather than
 * Express's default HTML error page.
 */
export const notFoundMiddleware = (req: Request, _res: Response, next: NextFunction): void => {
    next(createAppError(ERROR_CODES.NOT_FOUND, 404, 'Route not found', { path: req.path, method: req.method }));
};
