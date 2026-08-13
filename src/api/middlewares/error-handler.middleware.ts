import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { AppError, DEFAULT_MESSAGES } from '../../core/errors/app-error';
import { ERROR_CODES, ErrorCode } from '../../core/errors/error-codes';
import { ERROR_CATEGORIES, ErrorCategory } from '../../core/errors/error-category';
import { projectDetails, projectMessage } from '../../core/errors/detail-policy';
import { requestLogger } from '../../core/logging/logger';

/**
 * Global error handler. MUST be the LAST middleware registered.
 *
 * Ported from `jovi-mall/src/api/middlewares/error-handler.middleware.ts`, with three
 * changes: the Multer branch is dropped (this service accepts no uploads), logging goes
 * through pino instead of `console.*` so credentials in an error payload are redacted
 * rather than printed, and a **body-parser branch** was added.
 *
 * The response contract is byte-identical to jovi-mall's, deliberately — one error shape
 * across the platform:
 *
 *   { success: false, requestId, error: { code, message, statusCode, category, details? } }
 *
 * `category` is Phase 16 and additive. `details` is omitted entirely when there is none —
 * never `null`, never `{}`.
 *
 * ── Phase 16: what a caller may be told is decided by CATEGORY ────────────────
 * The only `NODE_ENV` gate used to be on the unknown-error branch, so a 5xx `AppError` sent
 * its message and its `details` verbatim in production. Three request-time 500s in
 * `dual-control/domain/approval.service.ts` carry internal prose, and the nineteen boot
 * assertions carry `{ problemCount, problems: string[] }` — a full internal diagnostic that
 * reaches no client today only because the process exits first, which is not a boundary.
 *
 * Now `internal` and `external_service` are masked to the code's registry message with no
 * `details`, in EVERY environment. `test:contract` asserts development and production
 * produce identical output for those two, which is the assertion that keeps the rule real.
 *
 * Stack traces are NEVER sent to a client.
 */
export const errorHandlerMiddleware = (
    err: unknown,
    req: Request,
    res: Response,
    _next: NextFunction,
): void => {
    const requestId = req.requestId ?? 'unknown';

    // ── 1. AppError — our own domain errors ───────────────────────────────────
    if (err instanceof AppError) {
        respond(req, res, requestId, {
            code: err.code,
            statusCode: err.statusCode,
            category: err.category,
            thrownMessage: err.message,
            details: err.details,
            isOperational: err.isOperational,
            error: err,
        });
        return;
    }

    // ── 2. ZodError — schema validation, from validate() or a direct parse ────
    if (err instanceof ZodError) {
        respond(req, res, requestId, {
            code: ERROR_CODES.VALIDATION_ERROR,
            statusCode: 400,
            category: ERROR_CATEGORIES.VALIDATION,
            thrownMessage: 'Validation failed',
            details: {
                fields: err.errors.map((issue) => ({
                    path: issue.path.join('.'),
                    message: issue.message,
                    code: issue.code,
                })),
            },
            isOperational: true,
            error: err,
        });
        return;
    }

    // ── 3. Body-parser rejection — malformed before any schema saw it ─────────
    // Express rejects these inside `express.json()`, so no route and no Zod schema is ever
    // reached. Without this branch they fall through to case 6 and a caller sending
    // malformed JSON is told `500 — Something went wrong`: our fault, unactionable, and
    // wrong. They are the caller's payload, and each has a different remedy.
    const bodyFailure = classifyBodyParserFailure(err);
    if (bodyFailure) {
        respond(req, res, requestId, {
            code: bodyFailure.code,
            statusCode: bodyFailure.statusCode,
            category: ERROR_CATEGORIES.VALIDATION,
            thrownMessage: bodyFailure.message,
            details: undefined,
            isOperational: true,
            error: err,
        });
        return;
    }

    // ── 4. Mongoose CastError — a malformed ObjectId in a path param ──────────
    if (isMongooseCastError(err)) {
        respond(req, res, requestId, {
            code: ERROR_CODES.NOT_FOUND,
            statusCode: 404,
            category: ERROR_CATEGORIES.NOT_FOUND,
            thrownMessage: 'Resource not found',
            details: undefined,
            isOperational: true,
            error: err,
        });
        return;
    }

    // ── 5. Mongoose duplicate key (11000) ────────────────────────────────────
    if (isMongooseDuplicateKeyError(err)) {
        const keyValue = (err as { keyValue?: Record<string, unknown> }).keyValue ?? {};
        respond(req, res, requestId, {
            code: ERROR_CODES.DATABASE_UNIQUE_CONSTRAINT_VIOLATION,
            statusCode: 409,
            category: ERROR_CATEGORIES.CONFLICT,
            thrownMessage: 'A record with this value already exists',
            details: { keyValue },
            isOperational: true,
            error: err,
        });
        return;
    }

    // ── 6. Unknown / unexpected ──────────────────────────────────────────────
    respond(req, res, requestId, {
        code: ERROR_CODES.INTERNAL_SERVER_ERROR,
        statusCode: 500,
        category: ERROR_CATEGORIES.INTERNAL,
        thrownMessage: err instanceof Error ? err.message : String(err),
        details: undefined,
        isOperational: false,
        error: err,
    });
};

// ─────────────────────────────────────────────────────────────────────────────
// The one exit
// ─────────────────────────────────────────────────────────────────────────────

interface Outcome {
    code: ErrorCode;
    statusCode: number;
    category: ErrorCategory;
    /** What the code threw. Masked before it reaches the caller when the category says so. */
    thrownMessage: string;
    /** Unfiltered. Journaled in full; filtered on the way out. */
    details: Record<string, unknown> | undefined;
    isOperational: boolean;
    /** The original throwable, for its stack. */
    error: unknown;
}

/**
 * Journal the full truth, send the projected copy.
 *
 * Six branches each building their own response is how a contract drifts; funnelling them
 * through one exit is what makes "no 5xx ever carries details" a property of the file
 * rather than of six people remembering.
 */
function respond(req: Request, res: Response, requestId: string, outcome: Outcome): void {
    const log = requestLogger(requestId);
    const registryDefault = DEFAULT_MESSAGES[outcome.code];
    const clientMessage = projectMessage(outcome.category, outcome.thrownMessage, registryDefault);
    const clientDetails = projectDetails(outcome.category, outcome.details);
    const masked = clientMessage !== outcome.thrownMessage;

    const context = {
        httpError: {
            category: outcome.category,
            code: outcome.code,
            statusCode: outcome.statusCode,
            adminId: req.admin?.adminId ?? null,
            tier: req.admin?.tier ?? null,
            clientMessage,
            internalMessage: outcome.thrownMessage,
            details: outcome.details ?? null,
            masked,
        },
        path: req.path,
        method: req.method,
    };

    if (outcome.isOperational) {
        log.warn(context, `${outcome.category} ${outcome.statusCode} — ${outcome.code}`);
    } else {
        const stack = outcome.error instanceof Error ? outcome.error.stack : undefined;
        log.error({ ...context, stack }, `${outcome.category} ${outcome.statusCode} — ${outcome.code}`);
    }

    res.status(outcome.statusCode).json({
        success: false,
        requestId,
        error: {
            code: outcome.code,
            message: clientMessage,
            statusCode: outcome.statusCode,
            category: outcome.category,
            ...(clientDetails !== undefined && { details: clientDetails }),
        },
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Type guards
// ─────────────────────────────────────────────────────────────────────────────

interface BodyParserFailure {
    code: ErrorCode;
    statusCode: number;
    message: string;
    type: string;
}

/**
 * Recognise a rejection raised by `express.json()` / `express.urlencoded()`.
 *
 * body-parser tags every one with a stable `type` string (and a `status`), which is what is
 * matched here — not the message, which is prose. The three outcomes are the three
 * different things a client has to do about it: fix the JSON, send less, or send a
 * different `Content-Type`.
 *
 * Exported for `scripts/test/test-api-contract.ts`.
 */
export function classifyBodyParserFailure(err: unknown): BodyParserFailure | null {
    if (typeof err !== 'object' || err === null) return null;

    const candidate = err as { type?: unknown; status?: unknown; message?: unknown };
    if (typeof candidate.type !== 'string' || typeof candidate.status !== 'number') return null;

    // body-parser types are all dotted namespaces; the guard above would otherwise match
    // any object that happens to carry a `type` and a `status`.
    if (!candidate.type.includes('.')) return null;

    switch (candidate.type) {
        case 'entity.too.large':
        case 'parameters.too.many':
            return {
                code: ERROR_CODES.REQUEST_BODY_TOO_LARGE,
                statusCode: 413,
                message: 'The request body is too large',
                type: candidate.type,
            };

        case 'charset.unsupported':
        case 'encoding.unsupported':
            return {
                code: ERROR_CODES.REQUEST_MEDIA_TYPE_UNSUPPORTED,
                statusCode: 415,
                message: 'Unsupported content type — send application/json; charset=utf-8',
                type: candidate.type,
            };

        default:
            // `entity.parse.failed`, `request.aborted`, `request.size.invalid`, and
            // anything body-parser adds later. A 5xx-tagged one is genuinely ours, so it
            // is left to the unknown branch, which logs a stack.
            if (candidate.status >= 500) return null;
            return {
                code: ERROR_CODES.REQUEST_BODY_INVALID,
                statusCode: 400,
                message: 'The request body could not be read as JSON',
                type: candidate.type,
            };
    }
}

function isMongooseCastError(err: unknown): boolean {
    return typeof err === 'object' && err !== null && (err as { name?: string }).name === 'CastError';
}

function isMongooseDuplicateKeyError(err: unknown): boolean {
    return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}
