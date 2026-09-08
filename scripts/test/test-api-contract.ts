/**
 * Test: the Phase 5 API contract — the shared request vocabulary, the list contract, and
 * the error format.
 *
 * DB-free by construction: every rule asserted here is a Zod schema, a pure function or a
 * frozen constant, which is the whole reason they were extracted out of the modules that
 * used to copy them.
 *
 * The point of the file is that a convention nobody can enforce drifts within a week. Four
 * validators had already grown four copies of the 24-hex id regex and four copies of the
 * `page`/`limit` pair before this existed, and `pages` was computed three different ways —
 * two of which disagreed about an empty list. Each section below pins one of those rules so
 * the seventy-six endpoints still to port cannot each answer it differently.
 *
 * Run: npm run test:contract
 */
import { z } from 'zod';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Request, Response } from 'express';
import { suite, throws } from './_assert';
import {
    boolFlag,
    dateRangeFields,
    dateRangeRule,
    idParam,
    isoDateTime,
    objectId,
    reasonText,
    searchTerm,
} from '../../src/core/validation/common.schemas';
import {
    LIMIT_DEFAULT,
    LIMIT_MAX,
    PAGE_DEFAULT,
    listQuery,
    paginationFields,
    sortSchema,
    toPageMeta,
} from '../../src/core/http/list-query';
import { containsInsensitive, escapeRegex, matchAnyField, toMongoSort } from '../../src/core/data/mongo-list';
import {
    classifyBodyParserFailure,
    errorHandlerMiddleware,
} from '../../src/api/middlewares/error-handler.middleware';
import { ERROR_CODES } from '../../src/core/errors/error-codes';
import { createAppError } from '../../src/core/errors/app-error';
import { sendCreated, sendPaginated, sendSuccess } from '../../src/core/http/responses';

// The handler logs through pino; silence it so a passing run is readable.
process.env.LOG_LEVEL = 'silent';

const t = suite('wi-admin API contract');

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface CapturedResponse {
    status: number;
    body: Record<string, unknown>;
}

/** A `res` double that records what a handler sent, with no HTTP involved. */
function captureResponse(): { res: Response; captured: CapturedResponse } {
    const captured: CapturedResponse = { status: 0, body: {} };
    const res = {
        status(code: number) {
            captured.status = code;
            return this;
        },
        json(payload: Record<string, unknown>) {
            captured.body = payload;
            return this;
        },
    } as unknown as Response;
    return { res, captured };
}

function fakeRequest(): Request {
    return { requestId: 'req_test', path: '/api/v1/things', method: 'POST' } as unknown as Request;
}

/** Run the global error handler over one error and return what a client would receive. */
function render(err: unknown): CapturedResponse {
    const { res, captured } = captureResponse();
    errorHandlerMiddleware(err, fakeRequest(), res, () => undefined);
    return captured;
}

const errorOf = (captured: CapturedResponse) => captured.body.error as Record<string, unknown>;

// ─── 1. Identifiers ──────────────────────────────────────────────────────────

t.section('1. IDs — 24-hex ObjectId strings, validated at the edge');

t.assert('a 24-hex string is accepted', () => objectId.safeParse('507f1f77bcf86cd799439011').success);
t.assert('uppercase hex is accepted', () => objectId.safeParse('507F1F77BCF86CD799439011').success);
t.assert('23 characters is rejected', () => !objectId.safeParse('507f1f77bcf86cd79943901').success);
t.assert('25 characters is rejected', () => !objectId.safeParse('507f1f77bcf86cd7994390111').success);
t.assert('non-hex is rejected', () => !objectId.safeParse('507f1f77bcf86cd79943901z').success);
t.assert('the empty string is rejected', () => !objectId.safeParse('').success);
t.assert('a number is rejected (no coercion)', () => !objectId.safeParse(1234).success);

t.assert('idParam builds a schema keyed by the param name', () =>
    idParam('agentId').safeParse({ agentId: '507f1f77bcf86cd799439011' }).success);

t.assert('idParam names the resource in its message', () => {
    const result = idParam('agentId', 'agent').safeParse({ agentId: 'nope' });
    return !result.success && result.error.issues[0].message === 'Not a valid agent id';
});

// ─── 2. Pagination ───────────────────────────────────────────────────────────

t.section('2. Pagination — one definition of page, limit and pages');

const pager = z.object(paginationFields);

t.assert('page defaults to 1 and limit to 20', () => {
    const parsed = pager.parse({});
    return parsed.page === PAGE_DEFAULT && parsed.limit === LIMIT_DEFAULT;
});

t.assert('query strings are coerced to numbers', () => {
    const parsed = pager.parse({ page: '3', limit: '50' });
    return parsed.page === 3 && parsed.limit === 50;
});

t.assert('page 0 is rejected — pages are 1-indexed', () => !pager.safeParse({ page: '0' }).success);
t.assert('a negative page is rejected', () => !pager.safeParse({ page: '-1' }).success);
t.assert('a fractional page is rejected', () => !pager.safeParse({ page: '1.5' }).success);
t.assert(`limit ${LIMIT_MAX} is the ceiling`, () => pager.safeParse({ limit: String(LIMIT_MAX) }).success);
t.assert(`limit ${LIMIT_MAX + 1} is rejected`, () => !pager.safeParse({ limit: String(LIMIT_MAX + 1) }).success);
t.assert('limit 0 is rejected', () => !pager.safeParse({ limit: '0' }).success);

t.section('2b. toPageMeta — the formula that used to have three copies');

t.assert('an empty list has ZERO pages, not one', () => toPageMeta(0, 1, 20).pages === 0);
t.assert('one row is one page', () => toPageMeta(1, 1, 20).pages === 1);
t.assert('an exact multiple does not round up', () => toPageMeta(40, 1, 20).pages === 2);
t.assert('a partial last page counts', () => toPageMeta(41, 1, 20).pages === 3);
t.assert('page and limit are echoed unchanged', () => {
    const meta = toPageMeta(41, 2, 20);
    return meta.total === 41 && meta.page === 2 && meta.limit === 20;
});

// ─── 3. Sorting ──────────────────────────────────────────────────────────────

t.section('3. Sorting — an allowlist, and a stable order');

const THING_SORT = { createdAt: 'created_at', name: 'display_name' } as const;
const thingSort = sortSchema(THING_SORT, '-createdAt');

t.assert('an absent sort falls back to the declared default', () => {
    const parsed = thingSort.parse(undefined);
    return parsed.field === 'createdAt' && parsed.direction === -1;
});

t.assert('a leading - means descending', () => thingSort.parse('-name').direction === -1);
t.assert('no prefix means ascending', () => thingSort.parse('name').direction === 1);
t.assert('the parsed field is the WIRE name, not the column', () => thingSort.parse('name').field === 'name');

t.assert('an undeclared field is refused', () => !thingSort.safeParse('password').success);

t.assert('the refusal lists what IS sortable', () => {
    const result = thingSort.safeParse('password');
    return !result.success && result.error.issues[0].message.includes('createdAt, name');
});

t.assert('a database column name is NOT accepted as a wire name', () =>
    !thingSort.safeParse('created_at').success);

t.assert('a default outside the sortable set fails at build time, not per request', () =>
    throws(() => sortSchema(THING_SORT, '-nope')));

t.assert('an empty sortable map fails at build time', () => throws(() => sortSchema({}, 'x')));

t.section('3b. toMongoSort — translation plus a tiebreaker');

t.assert('the wire name is translated to the column', () =>
    toMongoSort({ field: 'name', direction: 1 }, THING_SORT).display_name === 1);

t.assert('_id is appended so skip/limit paging is stable', () => {
    const sort = toMongoSort({ field: 'createdAt', direction: -1 }, THING_SORT);
    return Object.keys(sort).join(',') === 'created_at,_id' && sort._id === -1;
});

t.assert('the tiebreaker follows the primary direction', () =>
    toMongoSort({ field: 'createdAt', direction: 1 }, THING_SORT)._id === 1);

t.assert('sorting BY _id does not duplicate the key', () => {
    const sort = toMongoSort({ field: 'id', direction: -1 }, { id: '_id' });
    return Object.keys(sort).length === 1 && sort._id === -1;
});

t.assert('a hand-built spec outside the map throws rather than querying', () =>
    throws(() => toMongoSort({ field: 'password', direction: 1 }, THING_SORT)));

t.section('3c. listQuery — pagination + sort + the endpoint’s own filters');

const ThingQuery = listQuery(THING_SORT, '-createdAt', {
    search: searchTerm.optional(),
    status: z.enum(['active', 'archived']).optional(),
});

t.assert('an empty query yields every default', () => {
    const parsed = ThingQuery.parse({});
    return parsed.page === 1 && parsed.limit === 20 && parsed.sort.field === 'createdAt';
});

t.assert('the endpoint’s own filters are parsed alongside', () => {
    const parsed = ThingQuery.parse({ status: 'archived', search: '  ada  ', limit: '5' });
    return parsed.status === 'archived' && parsed.search === 'ada' && parsed.limit === 5;
});

t.assert('an unknown filter value is refused', () => !ThingQuery.safeParse({ status: 'deleted' }).success);
t.assert('unknown keys are stripped, not rejected', () => {
    const parsed = ThingQuery.parse({ nonsense: 'x' }) as Record<string, unknown>;
    return parsed.nonsense === undefined;
});

// ─── 4. Search ───────────────────────────────────────────────────────────────

t.section('4. Search — the term is a literal, never a pattern');

t.assert('regex metacharacters are escaped', () => escapeRegex('a.b*c') === 'a\\.b\\*c');
t.assert('backslashes are escaped', () => escapeRegex('a\\b') === 'a\\\\b');

t.assert('a dot matches a literal dot, not any character', () => {
    const pattern = containsInsensitive('a.b');
    return pattern.test('xa.by') && !pattern.test('axb');
});

t.assert('matching is case-insensitive', () => containsInsensitive('ADA').test('ada lovelace'));

t.assert('a catastrophic-backtracking term is defused', () => {
    // Unescaped, /(a+)+$/ against a long non-matching string is the classic ReDoS.
    const pattern = containsInsensitive('(a+)+$');
    const started = Date.now();
    pattern.test('a'.repeat(2_000) + 'b');
    return Date.now() - started < 100;
});

t.assert('matchAnyField builds an $or across the named fields', () => {
    const fragment = matchAnyField(['email', 'phone'], 'ada') as { $or: Record<string, RegExp>[] };
    return fragment.$or.length === 2 && fragment.$or[0].email instanceof RegExp;
});

t.assert('a blank term yields NO constraint rather than an empty $or', () =>
    Object.keys(matchAnyField(['email'], '   ')).length === 0);

t.assert('no fields yields no constraint', () => Object.keys(matchAnyField([], 'ada')).length === 0);

t.assert('searchTerm trims and rejects the empty string', () =>
    searchTerm.parse('  ada  ') === 'ada' && !searchTerm.safeParse('   ').success);

t.assert('searchTerm is bounded — an unbounded pattern is a query-planner attack', () =>
    !searchTerm.safeParse('x'.repeat(121)).success);

// ─── 5. Dates ────────────────────────────────────────────────────────────────

t.section('5. Dates — ISO-8601 instants, half-open ranges');

t.assert('a UTC instant is accepted and becomes a Date', () => {
    const parsed = isoDateTime.parse('2026-08-11T09:00:00.000Z');
    return parsed instanceof Date && parsed.toISOString() === '2026-08-11T09:00:00.000Z';
});

t.assert('an offset instant is accepted', () => isoDateTime.safeParse('2026-08-11T09:00:00+01:00').success);

t.assert('a DATE-ONLY value is refused — it is not an instant', () =>
    !isoDateTime.safeParse('2026-08-11').success);

t.assert('a zone-less datetime is refused', () => !isoDateTime.safeParse('2026-08-11T09:00:00').success);
t.assert('prose is refused', () => !isoDateTime.safeParse('yesterday').success);

const RangeQuery = z.object(dateRangeFields()).superRefine(dateRangeRule({ maxDays: 92 }));

t.assert('a valid range passes', () =>
    RangeQuery.safeParse({ from: '2026-08-01T00:00:00Z', to: '2026-08-11T00:00:00Z' }).success);

t.assert('`from` alone is allowed (since)', () => RangeQuery.safeParse({ from: '2026-08-01T00:00:00Z' }).success);
t.assert('`to` alone is allowed (until)', () => RangeQuery.safeParse({ to: '2026-08-01T00:00:00Z' }).success);
t.assert('neither is allowed (no filter)', () => RangeQuery.safeParse({}).success);

t.assert('a reversed range is refused', () =>
    !RangeQuery.safeParse({ from: '2026-08-11T00:00:00Z', to: '2026-08-01T00:00:00Z' }).success);

t.assert('an empty range is refused — the interval is half-open', () =>
    !RangeQuery.safeParse({ from: '2026-08-11T00:00:00Z', to: '2026-08-11T00:00:00Z' }).success);

t.assert('the failure is attributed to `to`', () => {
    const result = RangeQuery.safeParse({ from: '2026-08-11T00:00:00Z', to: '2026-08-01T00:00:00Z' });
    return !result.success && result.error.issues[0].path.join('.') === 'to';
});

t.assert('a range beyond maxDays is refused', () =>
    !RangeQuery.safeParse({ from: '2026-01-01T00:00:00Z', to: '2026-08-01T00:00:00Z' }).success);

t.assert('a range at exactly maxDays is allowed', () => {
    const from = new Date('2026-01-01T00:00:00.000Z');
    const to = new Date(from.getTime() + 92 * 86_400_000);
    return RangeQuery.safeParse({ from: from.toISOString(), to: to.toISOString() }).success;
});

t.assert('with no maxDays, any ordered range passes', () => {
    const Unbounded = z.object(dateRangeFields()).superRefine(dateRangeRule());
    return Unbounded.safeParse({ from: '2000-01-01T00:00:00Z', to: '2030-01-01T00:00:00Z' }).success;
});

// ─── 6. Booleans ─────────────────────────────────────────────────────────────

t.section('6. Boolean flags — the `z.coerce.boolean()` trap');

t.assert("'false' is FALSE — the whole reason this helper exists", () => boolFlag.parse('false') === false);
t.assert("'true' is true", () => boolFlag.parse('true') === true);
t.assert("'0' is false", () => boolFlag.parse('0') === false);
t.assert("'1' is true", () => boolFlag.parse('1') === true);
t.assert('a real boolean passes through', () => boolFlag.parse(true) === true && boolFlag.parse(false) === false);
t.assert('anything else is rejected rather than guessed', () => !boolFlag.safeParse('yes').success);

t.assert('z.coerce.boolean() would have got this wrong — the trap is real', () =>
    z.coerce.boolean().parse('false') === true);

// ─── 7. The error envelope ───────────────────────────────────────────────────

t.section('7. Error format — one shape, a machine-readable code, never a parsed message');

t.assert('an AppError renders the documented envelope', () => {
    const captured = render(createAppError(ERROR_CODES.NOT_FOUND, 404));
    const error = errorOf(captured);
    return (
        captured.status === 404
        && captured.body.success === false
        && captured.body.requestId === 'req_test'
        && error.code === ERROR_CODES.NOT_FOUND
        && error.statusCode === 404
        && typeof error.message === 'string'
    );
});

t.assert('details travel when supplied', () => {
    const captured = render(createAppError(ERROR_CODES.AUTHZ_PERMISSION_DENIED, 403, undefined, { required: ['a.b.c'] }));
    return (errorOf(captured).details as { required: string[] }).required[0] === 'a.b.c';
});

t.assert('details are OMITTED, not null, when there are none', () => {
    const captured = render(createAppError(ERROR_CODES.NOT_FOUND, 404));
    return !('details' in errorOf(captured));
});

t.assert('a ZodError becomes 400 VALIDATION_ERROR with per-field details', () => {
    const result = z.object({ email: z.string().email() }).safeParse({ email: 'nope' });
    if (result.success) return false;

    const captured = render(result.error);
    const fields = (errorOf(captured).details as { fields: { path: string }[] }).fields;
    return captured.status === 400 && errorOf(captured).code === ERROR_CODES.VALIDATION_ERROR && fields[0].path === 'email';
});

t.assert('an unknown error is a 500 that never leaks a stack', () => {
    const captured = render(new Error('internal detail'));
    return (
        captured.status === 500
        && errorOf(captured).code === ERROR_CODES.INTERNAL_SERVER_ERROR
        && !('stack' in errorOf(captured))
    );
});

t.section('7b. Body-parser rejections — the caller’s payload, not our fault');

const bodyParserError = (type: string, status: number) => Object.assign(new SyntaxError('boom'), { type, status });

t.assert('malformed JSON is 400 REQUEST_BODY_INVALID, not 500', () => {
    const captured = render(bodyParserError('entity.parse.failed', 400));
    return captured.status === 400 && errorOf(captured).code === ERROR_CODES.REQUEST_BODY_INVALID;
});

t.assert('an oversized body is 413', () => {
    const captured = render(bodyParserError('entity.too.large', 413));
    return captured.status === 413 && errorOf(captured).code === ERROR_CODES.REQUEST_BODY_TOO_LARGE;
});

t.assert('an unsupported charset is 415', () => {
    const captured = render(bodyParserError('charset.unsupported', 415));
    return captured.status === 415 && errorOf(captured).code === ERROR_CODES.REQUEST_MEDIA_TYPE_UNSUPPORTED;
});

t.assert('an aborted request is a 400, not a server fault', () =>
    render(bodyParserError('request.aborted', 400)).status === 400);

t.assert('a 5xx-tagged body-parser fault stays OURS (500 with a stack logged)', () =>
    classifyBodyParserFailure(bodyParserError('stream.encoding.set', 500)) === null);

t.assert('a plain Error is not mistaken for one', () => classifyBodyParserFailure(new Error('x')) === null);

t.assert('an object that merely has type+status is not mistaken for one', () =>
    classifyBodyParserFailure({ type: 'user', status: 400 }) === null);

// ─── 8. The error-code registry ──────────────────────────────────────────────

t.section('8. Error codes — stable, machine-readable, never parsed prose');

t.assert('every key equals its value, so a code cannot be renamed on one side', () =>
    Object.entries(ERROR_CODES).every(([key, value]) => key === value));

t.assert('every code is SCREAMING_SNAKE', () =>
    Object.values(ERROR_CODES).every((code) => /^[A-Z][A-Z0-9_]*$/.test(code)));

t.assert('the registry is frozen', () => Object.isFrozen(ERROR_CODES));

t.assert('every code renders a message — none falls back to the generic default', () =>
    Object.values(ERROR_CODES).every((code) => {
        const message = createAppError(code, 400).message;
        return message !== 'An error occurred' && message.length > 0;
    }));

t.assert('a 5xx is non-operational (logged with a stack); a 4xx is not', () =>
    createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 500).isOperational === false
    && createAppError(ERROR_CODES.NOT_FOUND, 404).isOperational === true);

// ─── 9. The success envelope ─────────────────────────────────────────────────

t.section('9. Success format — data always present, meta only on lists');

t.assert('sendSuccess is { success: true, data } at 200', () => {
    const { res, captured } = captureResponse();
    sendSuccess(res, { id: '1' });
    return captured.status === 200 && captured.body.success === true && !('meta' in captured.body);
});

t.assert('data survives being null — it is always present', () => {
    const { res, captured } = captureResponse();
    sendSuccess(res, null);
    return 'data' in captured.body && captured.body.data === null;
});

t.assert('sendCreated is 201', () => {
    const { res, captured } = captureResponse();
    sendCreated(res, { id: '1' });
    return captured.status === 201;
});

t.assert('a non-default status is honoured — 202 for a queued action', () => {
    const { res, captured } = captureResponse();
    sendSuccess(res, { id: '1' }, { status: 202, message: 'Awaiting a second administrator' });
    return captured.status === 202 && captured.body.message === 'Awaiting a second administrator';
});

t.assert('sendPaginated puts the rows in data and the counts in meta', () => {
    const { res, captured } = captureResponse();
    sendPaginated(res, [{ id: '1' }], toPageMeta(1, 1, 20));
    const meta = captured.body.meta as Record<string, number>;
    return Array.isArray(captured.body.data) && meta.total === 1 && meta.pages === 1;
});

// ─── 10. Reason text ─────────────────────────────────────────────────────────

t.section('10. Reasons — required, trimmed, and specific about which form');

t.assert('a reason is trimmed', () => reasonText('why?').parse('  because  ') === 'because');
t.assert('a blank reason is refused', () => !reasonText('why?').safeParse('   ').success);
t.assert('the endpoint’s own message is used', () => {
    const result = reasonText('A reason is required to suspend an administrator').safeParse('');
    return !result.success && result.error.issues[0].message.includes('suspend an administrator');
});

// ─── 11. The detail boundary — what a caller actually receives ────────────────

/**
 * Three refusals whose `details` were silently deleted at the boundary, and the two rules
 * that must keep deleting everything else.
 *
 * All three were the SAME defect and none was visible from the throw site: the filter is
 * keyed on the KEY NAME and on the category, so a field named for its meaning at the point
 * it is raised can be dropped for a reason belonging to a different feature entirely. The
 * password form attached `problems`, which is the boot assertions' internal diagnostic and
 * is dropped from every category; the tracking door attached `upstreamCode`, which the
 * `external_service` branch did not recognise. In both cases the contract page promised a
 * detail the client could never receive.
 *
 * These assertions render through the REAL global handler, so they fail if either the throw
 * site or the policy moves — which is the pairing that was missing when the defects landed.
 */
t.section('11. Error details — what survives the boundary, and what must not');

t.assert('a weak password names the rules it broke', () => {
    const err = createAppError(ERROR_CODES.ADMIN_AUTH_PASSWORD_WEAK, 422, undefined, {
        failedRules: ['must be at least 12 characters', 'is too common'],
    });
    const details = errorOf(render(err)).details as Record<string, unknown> | undefined;
    return Array.isArray(details?.failedRules) && details.failedRules.length === 2;
});

t.assert('…but `problems` is STILL dropped — the deny-list was not widened to rescue it', () => {
    const err = createAppError(ERROR_CODES.ADMIN_AUTH_PASSWORD_WEAK, 422, undefined, {
        problems: ['must be at least 12 characters'],
    });
    return !('details' in errorOf(render(err)));
});

t.assert('the password throw site attaches failedRules, not problems', () => {
    const source = readFileSync(
        join(__dirname, '../../src/modules/admin-identity/domain/password.service.ts'),
        'utf8',
    );
    const thrown = source.slice(source.indexOf('ADMIN_AUTH_PASSWORD_WEAK'));
    return thrown.includes('failedRules: policy.problems') && !/^\s*problems: policy/m.test(thrown);
});

t.assert('a refused tracking read carries geo-tracker’s own code', () => {
    const err = createAppError(ERROR_CODES.TRACKING_DOOR_REFUSED, 502, undefined, {
        upstreamCode: 'SERVICE_SCOPE_FORBIDDEN',
        upstreamStatus: 403,
    });
    const details = errorOf(render(err)).details as Record<string, unknown> | undefined;
    return details?.upstreamCode === 'SERVICE_SCOPE_FORBIDDEN' && details.upstreamStatus === 403;
});

t.assert('jovi-mall’s pair still survives too — the two upstreams stay distinguishable', () => {
    const err = createAppError(ERROR_CODES.PLATFORM_OPERATION_REJECTED, 502, undefined, {
        platformCode: 'ORDER_NOT_FOUND',
        platformStatus: 404,
    });
    const details = errorOf(render(err)).details as Record<string, unknown> | undefined;
    return details?.platformCode === 'ORDER_NOT_FOUND' && details.platformStatus === 404;
});

t.assert('an upstream MESSAGE never survives — the allowlist stayed narrow', () => {
    const err = createAppError(ERROR_CODES.TRACKING_DOOR_REFUSED, 502, undefined, {
        upstreamCode: 'SERVICE_SCOPE_FORBIDDEN',
        upstreamMessage: 'agent 64f… is outside scope agent:position',
        upstream: { host: 'geo-tracker.internal' },
    });
    const details = errorOf(render(err)).details as Record<string, unknown>;
    return details.upstreamCode === 'SERVICE_SCOPE_FORBIDDEN'
        && !('upstreamMessage' in details)
        && !('upstream' in details);
});

t.assert('the tracking throw site still uses the allowlisted key names', () => {
    const source = readFileSync(
        join(__dirname, '../../src/modules/agents/domain/tracking-disclosure.ts'),
        'utf8',
    );
    return source.includes('upstreamCode: result.code') && source.includes('upstreamStatus: result.status');
});

t.assert('a malformed automation report is its own code, not generic validation', () => {
    const err = createAppError(ERROR_CODES.AUTOMATION_REPORT_MALFORMED, 400, undefined, {
        fields: [{ path: 'workflowId', message: 'Required', code: 'invalid_type' }],
    });
    const error = errorOf(render(err));
    const details = error.details as Record<string, unknown> | undefined;
    return error.code === ERROR_CODES.AUTOMATION_REPORT_MALFORMED
        && error.category === 'validation'
        && Array.isArray(details?.fields);
});

process.exit(t.finish());
