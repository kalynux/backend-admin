import { Response } from 'express';

/**
 * Standard success-response envelope.
 *
 * Ported UNCHANGED from `jovi-mall/src/core/responses.ts`. This shape is already the
 * contract every frontend on the platform is written against, and it is documented in
 * `jovi-mall/api-doc/README.md`. The admin dashboard is a different client, but making
 * it parse a different envelope would buy nothing and cost every engineer who moves
 * between the two services.
 *
 *   success → { success: true,  data, meta?, message? }
 *   error   → { success: false, requestId, error: { code, message, statusCode, details? } }
 *
 * - `data`    always present on success (object, array, or `null`)
 * - `meta`    only on paginated/list responses; may carry extra summary fields
 * - `message` optional human-readable note
 *
 * Do NOT hand-roll `res.json({ success: true, ... })` — use these so the shape cannot drift.
 */

export interface PaginationMeta {
    total: number;
    page: number;
    limit: number;
    pages: number;
    /** Optional list-level summary fields. */
    [key: string]: number | string | boolean | null | undefined;
}

interface SuccessOptions {
    /** HTTP status code. Defaults to 200. */
    status?: number;
    /** Optional human-readable note. */
    message?: string;
    /** Pagination / list-level summary. Omitted from the body when undefined. */
    meta?: PaginationMeta | Record<string, unknown>;
}

/** Send `{ success: true, data, meta?, message? }`. */
export function sendSuccess<T>(res: Response, data: T, options: SuccessOptions = {}): void {
    const { status = 200, message, meta } = options;
    res.status(status).json({
        success: true,
        data,
        ...(meta !== undefined ? { meta } : {}),
        ...(message !== undefined ? { message } : {}),
    });
}

/** Send a `201 Created` envelope. Use for resource-creation endpoints. */
export function sendCreated<T>(res: Response, data: T, options: Omit<SuccessOptions, 'status'> = {}): void {
    sendSuccess(res, data, { ...options, status: 201 });
}

/** Send a paginated list: `{ success: true, data: [...], meta: { total, page, limit, pages, ... } }`. */
export function sendPaginated<T>(
    res: Response,
    data: T[],
    meta: PaginationMeta,
    options: Omit<SuccessOptions, 'meta'> = {},
): void {
    sendSuccess(res, data, { ...options, meta });
}

/** Send a message-only success: `{ success: true, data: null, message }`. */
export function sendMessage(res: Response, message: string, options: { status?: number } = {}): void {
    sendSuccess(res, null, { message, status: options.status });
}
