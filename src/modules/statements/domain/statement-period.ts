import { createAppError } from '../../../core/errors/app-error';
import { ERROR_CODES } from '../../../core/errors/error-codes';

/**
 * The statement's clock.
 *
 * ── One fixed zone, stated on the document ────────────────────────────────────
 * The platform operates in Cameroon, and `Africa/Douala` is UTC+01:00 with no daylight
 * saving, so a fixed offset is exact rather than an approximation — and it needs no timezone
 * library in a service that has none. Every date on a statement is printed in this zone and
 * the summary page says so. If the platform ever serves a zone with DST, this is the one
 * place that has to learn about it.
 */
export const STATEMENT_TZ_OFFSET_MINUTES = 60;
export const STATEMENT_TZ_LABEL = 'Africa/Douala (UTC+01:00)';

/** Owner decision A-6: a statement covers at most a year. */
export const STATEMENT_MAX_DAYS = 366;

const DAY_MS = 24 * 60 * 60 * 1000;
const OFFSET_MS = STATEMENT_TZ_OFFSET_MINUTES * 60 * 1000;

export interface StatementPeriod {
    from: string;
    to: string;
    /** Inclusive start instant: local midnight at the start of `from`. */
    start: Date;
    /** EXCLUSIVE end instant: local midnight after `to`. Query with `$lt`, never `$lte`. */
    end: Date;
}

/**
 * `from`/`to` are local calendar days, both INCLUSIVE.
 *
 * The exclusive `end` is the point: jovi-mall's vendor analytics parsed `to` as UTC midnight
 * and filtered `$lte`, which silently dropped the last day of every range. A statement that
 * lost its last day would be a financial record missing its most recent transactions.
 */
export function toStatementPeriod(from: string, to: string): StatementPeriod {
    const startUtc = parseDay(from, 'from');
    const endUtc = parseDay(to, 'to');
    if (startUtc > endUtc) {
        throw createAppError(ERROR_CODES.VALIDATION_ERROR, 400, '`from` must not be after `to`', { field: 'from' });
    }
    const days = Math.round((endUtc - startUtc) / DAY_MS) + 1;
    if (days > STATEMENT_MAX_DAYS) {
        throw createAppError(
            ERROR_CODES.VALIDATION_ERROR,
            400,
            `A statement covers at most ${STATEMENT_MAX_DAYS} days`,
            { field: 'to', maxDays: STATEMENT_MAX_DAYS },
        );
    }
    return {
        from,
        to,
        start: new Date(startUtc - OFFSET_MS),
        end: new Date(endUtc + DAY_MS - OFFSET_MS),
    };
}

function parseDay(value: string, field: string): number {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    const ms = match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : NaN;
    // Round-trip check: `2026-02-31` parses to March 3rd and must be refused, not moved.
    if (!match || Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== value) {
        throw createAppError(ERROR_CODES.VALIDATION_ERROR, 400, `\`${field}\` must be a real YYYY-MM-DD date`, {
            field,
        });
    }
    return ms;
}

/**
 * The instant shifted so its UTC fields read as the statement's wall clock.
 *
 * For the xlsx: exceljs writes a `Date` as a UTC serial, so an unshifted instant would print
 * an hour early in Excel.
 */
export function toWallClock(instant: Date): Date {
    return new Date(instant.getTime() + OFFSET_MS);
}

/** `2026-09-27 14:05` in the statement's zone. For the pdf and for text cells. */
export function formatLocal(instant: Date | null | undefined): string {
    if (!instant) return '';
    return toWallClock(instant).toISOString().slice(0, 16).replace('T', ' ');
}
