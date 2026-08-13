import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express {
        interface Request {
            requestId: string;
        }
    }
}

/**
 * Correlation-id middleware.
 *
 *  - reads `X-Request-Id` from an upstream proxy/client when present
 *  - generates a UUIDv4 otherwise
 *  - attaches it as `req.requestId`
 *  - echoes it as a response header so a client can quote it in an incident
 *
 * MUST be registered first: the logger, the error envelope, the platform client and
 * every audit row key off this value.
 *
 * ── Why the inbound value is sanitised, unlike jovi-mall's version ────────────
 * This was ported verbatim, and verbatim meant taking a caller-supplied header as-is.
 * That was survivable while the id only reached a log line. It is not survivable now
 * that the id is an INDEXED field on every audit row, for two reasons:
 *
 *  1. **It could refuse an administrator's action.** A value over ~1 KB overflows the
 *     WiredTiger index key limit and the insert fails — and the audit subsystem is
 *     deliberately fail-closed, so a refused audit write refuses the action it was
 *     recording. A header would become a denial-of-service on administration.
 *  2. **It could forge a link.** Correlation ids join rows across this service and
 *     jovi-mall. A caller who picks someone else's id makes their own action appear,
 *     to anyone reading the trail, to be part of that request.
 *
 * So an inbound id is accepted only if it already looks like one: a bounded run of the
 * characters ids are actually written in. Anything else is replaced rather than
 * rejected — a malformed header is not worth failing a request over, and every request
 * must have an id regardless.
 */

/** Bounded, and no wider than the shapes real ids use (UUID, ULID, hex, dotted trace ids). */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export function sanitiseRequestId(candidate: unknown): string {
    if (typeof candidate === 'string' && REQUEST_ID_PATTERN.test(candidate)) return candidate;
    return randomUUID();
}

export const requestIdMiddleware = (req: Request, res: Response, next: NextFunction): void => {
    // A repeated header arrives as an array; `sanitiseRequestId` rejects the non-string
    // and mints a fresh id rather than silently reading element zero.
    const id = sanitiseRequestId(req.headers['x-request-id']);
    req.requestId = id;
    res.setHeader('X-Request-Id', id);
    next();
};
