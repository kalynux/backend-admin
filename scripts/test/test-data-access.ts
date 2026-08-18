/**
 * Data access and domain boundaries — the rules, with no infrastructure.
 *
 * Everything here is a pure function of code: the access table, the copied collection
 * constants, the actor headers, the error mapping. No Mongo, no Redis, no jovi-mall.
 * `verify-platform-live.ts` proves the same rules through two running services.
 *
 * The load-bearing assertion is §2's drift check: this service holds a COPY of jovi-mall's
 * collection names, and a rename there would otherwise turn every direct read into a
 * silently empty result set.
 *
 *   npm run test:data-access
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { AxiosError } from 'axios';
import { suite, throws } from './_assert';

// Env must be set before importing anything that reads config at module load.
process.env.NODE_ENV = 'test';
process.env.MONGO_URI_PLATFORM = 'mongodb://localhost:27017/jovi_mall_test';
process.env.MONGO_URI_ADMIN = 'mongodb://localhost:27017/wi_admin_test';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.ADMIN_JWT_SECRET = 'test-access-secret-value-32-chars-long';
process.env.ADMIN_JWT_REFRESH_SECRET = 'test-refresh-secret-value-32-chars-long';
process.env.ADMIN_DASHBOARD_ORIGINS = 'http://localhost:5173';

import { COLLECTIONS } from '../../src/infra/platform/collections';
import {
    PLATFORM_COLLECTIONS,
    PLATFORM_COLLECTION_NAMES,
    isPlatformCollection,
    platformCollectionSpec,
} from '../../src/infra/platform/platform-collections';
import {
    ACTOR_HEADERS,
    actorHeaders,
    isPlatformConfigured,
    platformRequest,
    resetPlatformClient,
    toAppError,
} from '../../src/infra/platform/platform.client';
import { AppError } from '../../src/core/errors/app-error';
import { ERROR_CODES } from '../../src/core/errors/error-codes';
import { AdminIdentity } from '../../src/modules/admin-identity/domain/admin-identity.types';
import { resetEnvCache } from '../../src/config/env';

const t = suite('data access');

function identity(): AdminIdentity {
    return {
        adminId: '65f0000000000000000000aa',
        sessionId: 'sess-1',
        email: 'ops@example.test',
        displayName: 'Ada Ngo',
        tier: 2,
        status: 'active',
        mfaEnrolled: true,
        pendingMfaEnrolment: false,
        authenticatedAt: new Date(),
        sessionExpiresAt: new Date(Date.now() + 3_600_000),
        authMethod: 'cookie',
        ip: '127.0.0.1',
    };
}

// ─────────────────────────────────────────────────────────────────────────────
t.section('1. The access table');

t.assert('the table is not empty', () => PLATFORM_COLLECTION_NAMES.length > 0);

t.assert('every entry names a collection jovi-mall actually declares', () => {
    const known = new Set<string>(Object.values(COLLECTIONS));
    return PLATFORM_COLLECTION_NAMES.every((name) => known.has(name));
});

t.assert('every entry carries a justification, not a description', () =>
    PLATFORM_COLLECTION_NAMES.every((name) => platformCollectionSpec(name).note.trim().length > 20));

/**
 * A `read` collection is written through the internal API — or, since Phase 12, not written
 * from this service at all.
 *
 * `'none'` was added for `admin_action_log`: jovi-mall's own `/admin/*` middleware writes
 * it and nothing else ever does. Labelling that `'internal-api'` would assert an endpoint
 * exists to write it through, and there must never be one — an HTTP ingest into an audit
 * collection would let a caller author audit rows, which is precisely the property
 * `audit.writer.ts` being the only writer exists to guarantee.
 *
 * `'direct'` remains illegal on a `read` collection, which is the part this always guarded.
 */
t.assert('no `read` entry claims a DIRECT write', () =>
    PLATFORM_COLLECTION_NAMES
        .filter((name) => platformCollectionSpec(name).access === 'read')
        .every((name) => platformCollectionSpec(name).writes !== 'direct'));

t.assert('`writes: none` is used only where nothing in this service writes at all', () => {
    const unwritten = PLATFORM_COLLECTION_NAMES
        .filter((name) => platformCollectionSpec(name).writes === 'none');

    // One today. Named rather than counted loosely, so a second one is a deliberate edit
    // here and gets the same scrutiny.
    return unwritten.length === 1 && unwritten[0] === COLLECTIONS.ADMIN_ACTION_LOG;
});

/**
 * The type already makes this a compile error — `PlatformOwnedRepository`'s parameter
 * accepts only `access: 'owned'` collections. Asserted anyway because the failure mode if
 * the type ever loosened is a silent second writer on an audit collection.
 */
t.assert('nothing owns a `writes: none` collection', () =>
    PLATFORM_COLLECTION_NAMES
        .filter((name) => platformCollectionSpec(name).writes === 'none')
        .every((name) => platformCollectionSpec(name).access === 'read'));

t.assert('every `owned` entry is owned by admin and written directly', () =>
    PLATFORM_COLLECTION_NAMES
        .filter((name) => platformCollectionSpec(name).access === 'owned')
        .every((name) => {
            const spec = platformCollectionSpec(name);
            return spec.owner === 'admin' && spec.writes === 'direct';
        }));

// The rule stated as a test: nothing but the two blog collections may be written directly.
t.assert('exactly two collections are owned — the blog pair (ADR-004 D-4)', () => {
    const owned = PLATFORM_COLLECTION_NAMES.filter((n) => platformCollectionSpec(n).access === 'owned');
    return owned.length === 2
        && owned.includes(COLLECTIONS.ARTICLE)
        && owned.includes(COLLECTIONS.ARTICLE_AUTHOR);
});

t.assert('the money collections are read-only here', () =>
    [
        COLLECTIONS.AGENCY_REMITTANCE,
        COLLECTIONS.AGENT_DEPOSIT,
        COLLECTIONS.COD_CASH_ACCOUNT,
        COLLECTIONS.CASH_COLLECTION,
        COLLECTIONS.PAYOUT_REQUEST,
        COLLECTIONS.EARNINGS_ACCOUNT,
    ].every((name) => platformCollectionSpec(name).access === 'read'));

t.assert('users are read-only here', () => platformCollectionSpec(COLLECTIONS.USER).access === 'read');

t.assert('isPlatformCollection accepts a listed collection', () => isPlatformCollection(COLLECTIONS.USER));
t.assert('isPlatformCollection rejects an unlisted one', () => !isPlatformCollection('carts'));
t.assert('isPlatformCollection rejects a prototype key', () => !isPlatformCollection('toString'));

t.assert('the table is frozen', () => Object.isFrozen(PLATFORM_COLLECTIONS));

// ─────────────────────────────────────────────────────────────────────────────
t.section('2. The copied constants have not drifted from jovi-mall');

/**
 * The reason this file exists.
 *
 * `collections.ts` is a verbatim copy of jovi-mall's, because a Mongoose model cannot be
 * imported across the boundary. A rename there and not here does not throw — it returns an
 * empty result set, which reads as "no users" rather than "wrong collection".
 */
const JOVI_COLLECTIONS_PATH = join(
    __dirname, '..', '..', '..', 'jovi-mall', 'src', 'core', 'database', 'collections.ts',
);

let joviSource: string | null = null;
try {
    joviSource = readFileSync(JOVI_COLLECTIONS_PATH, 'utf8');
} catch {
    joviSource = null;
}

t.assert('jovi-mall\'s collections.ts is readable from here', () => joviSource !== null);

if (joviSource) {
    /** Parse `KEY: 'value',` pairs out of the COLLECTIONS block only. */
    const collectionsBlock = joviSource.slice(joviSource.indexOf('export const COLLECTIONS'));
    const declared = new Map<string, string>();
    for (const match of collectionsBlock.matchAll(/^\s{2}([A-Z0-9_]+):\s*'([^']+)',/gm)) {
        declared.set(match[1], match[2]);
    }

    t.assert('the source block parsed', () => declared.size > 50);

    t.assert('every key this service copied still maps to the same string upstream', () => {
        const mismatches: string[] = [];
        for (const [key, value] of Object.entries(COLLECTIONS)) {
            const upstream = declared.get(key);
            if (upstream === undefined) {
                mismatches.push(`${key}: removed upstream`);
            } else if (upstream !== value) {
                mismatches.push(`${key}: copy says "${value}", jovi-mall says "${upstream}"`);
            }
        }
        if (mismatches.length > 0) console.error(`      ${mismatches.join('\n      ')}`);
        return mismatches.length === 0;
    });

    t.assert('every collection the access table names still exists upstream', () => {
        const upstreamValues = new Set(declared.values());
        return PLATFORM_COLLECTION_NAMES.every((name) => upstreamValues.has(name));
    });
}

// ─────────────────────────────────────────────────────────────────────────────
t.section('3. Actor headers');

t.assert('the administrator id travels as X-Actor-Id', () =>
    actorHeaders(identity(), 'req-1')[ACTOR_HEADERS.ID] === '65f0000000000000000000aa');

t.assert('the display name travels, for the snapshot jovi-mall writes', () =>
    actorHeaders(identity(), 'req-1')[ACTOR_HEADERS.NAME] === 'Ada Ngo');

t.assert('the tier travels as a string, advisory only', () =>
    actorHeaders(identity(), 'req-1')[ACTOR_HEADERS.TIER] === '2');

t.assert('the correlation id travels, so one action is traceable across both services', () =>
    actorHeaders(identity(), 'req-42')[ACTOR_HEADERS.REQUEST_ID] === 'req-42');

t.assert('no credential is in the actor headers — the token is on the client instance', () => {
    const headers = actorHeaders(identity(), 'req-1');
    return !Object.keys(headers).some((key) => /token|secret|authorization/i.test(key));
});

// ─────────────────────────────────────────────────────────────────────────────
t.section('4. Unconfigured platform fails accurately');

t.assert('isPlatformConfigured is false with no base URL', () => {
    delete process.env.JOVI_MALL_BASE_URL;
    resetEnvCache();
    resetPlatformClient();
    return !isPlatformConfigured();
});

/**
 * The one asynchronous assertion in the suite. ts-node compiles to CommonJS, which has no
 * top-level await, so it is resolved before the assertions and read synchronously below —
 * the same shape `test-auth.ts` uses.
 */
let unconfiguredError: unknown = null;

async function captureUnconfiguredCall(): Promise<void> {
    try {
        await platformRequest({
            method: 'GET', path: '/cod/remittances', actor: identity(), requestId: 'req-1',
        });
    } catch (error) {
        unconfiguredError = error;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
t.section('5. Error mapping');

/**
 * These exercise the REAL `toAppError` from the client — not a copy. The mapping matters
 * because the two services keep separate code registries: a 4xx must arrive as a 4xx with
 * jovi-mall's own code preserved in `details`, and a 5xx must become a dependency failure
 * rather than being reported as the caller's fault.
 */
const mapPlatformError = (error: AxiosError): Error =>
    toAppError(error, { method: 'POST', path: '/cod/remittances/x/confirm' });

function axiosErrorWith(status: number, body: unknown): AxiosError {
    const error = new Error('Request failed') as AxiosError;
    error.isAxiosError = true;
    error.name = 'AxiosError';
    error.response = {
        status,
        statusText: '',
        data: body,
        headers: {},
        config: {} as never,
    } as never;
    return error;
}

t.assert('a jovi-mall 4xx keeps its status', () => {
    const mapped = mapPlatformError(axiosErrorWith(409, {
        success: false,
        error: { code: 'COD_REMITTANCE_ALREADY_RESOLVED', message: 'Already resolved', statusCode: 409 },
    }));
    return mapped instanceof AppError && mapped.statusCode === 409;
});

t.assert('...and carries jovi-mall\'s own code in details, not remapped', () => {
    const mapped = mapPlatformError(axiosErrorWith(409, {
        success: false,
        error: { code: 'COD_REMITTANCE_ALREADY_RESOLVED', message: 'Already resolved' },
    })) as AppError;
    return mapped.code === ERROR_CODES.PLATFORM_OPERATION_REJECTED
        && mapped.details?.platformCode === 'COD_REMITTANCE_ALREADY_RESOLVED';
});

t.assert('...and keeps the message a dashboard can show', () => {
    const mapped = mapPlatformError(axiosErrorWith(422, {
        success: false, error: { code: 'COD_REMITTANCE_INVALID_AMOUNT', message: 'Amount must be positive' },
    })) as AppError;
    return mapped.message === 'Amount must be positive';
});

t.assert('a jovi-mall 5xx becomes a 502 dependency failure, not the caller\'s fault', () => {
    const mapped = mapPlatformError(axiosErrorWith(500, {
        success: false, error: { code: 'INTERNAL_SERVER_ERROR', message: 'boom' },
    })) as AppError;
    return mapped.statusCode === 502
        && mapped.code === ERROR_CODES.SERVICE_DEPENDENCY_UNAVAILABLE
        && mapped.details?.platformStatus === 500;
});

t.assert('a 5xx is non-operational, so it is logged with a stack', () => {
    const mapped = mapPlatformError(axiosErrorWith(503, { success: false })) as AppError;
    return mapped.isOperational === false;
});

t.assert('a 4xx is operational', () => {
    const mapped = mapPlatformError(axiosErrorWith(404, { success: false })) as AppError;
    return mapped.isOperational === true;
});

// ─────────────────────────────────────────────────────────────────────────────
t.section('6. Repository shape — the read-only rule');

/**
 * The compile-time half of this rule cannot be asserted at runtime: `PlatformOwnedRepository`
 * takes `OwnedCollection`, so pointing one at `users` fails to compile. `tsc --noEmit` in
 * CI is what proves it, and `scripts/test/fixtures/owned-repository.ts-invalid` holds the
 * counter-example with the error it should produce.
 *
 * What IS assertable here: the read base exposes no write method at all.
 */
const READ_ONLY_SURFACE = ['findOneBy', 'findBy', 'findPage', 'countBy', 'aggregateBy', 'aggregatePage'];
const WRITE_METHODS = ['insertOneDoc', 'updateOneBy', 'deleteOneBy', 'insertOne', 'updateOne', 'deleteOne'];

t.assert('PlatformReadRepository exposes no write method', () => {
     
    const { PlatformReadRepository } = require('../../src/infra/platform/platform.repository');
    const surface = Object.getOwnPropertyNames(PlatformReadRepository.prototype);
    return !WRITE_METHODS.some((method) => surface.includes(method));
});

t.assert('PlatformReadRepository exposes the expected read surface', () => {
     
    const { PlatformReadRepository } = require('../../src/infra/platform/platform.repository');
    const surface = Object.getOwnPropertyNames(PlatformReadRepository.prototype);
    return READ_ONLY_SURFACE.every((method) => surface.includes(method));
});

/**
 * The projection guarantee, on the path that did not used to have one.
 *
 * `aggregateBy` passes its pipeline straight through, so the constructor's promise — "an
 * omitted projection returns whole documents, which is how a credential ends up in a
 * response" — held for `findPage` and not for a join. The delivery-network list is the
 * first read model needing a `$lookup`; these three assertions are what stop the fix from
 * being quietly undone by a later edit that lets the caller supply the `$project` again.
 */
t.assert('aggregatePage applies the repository’s OWN projection, not the caller’s', () => {
    const source = readFileSync(
        join(__dirname, '..', '..', 'src', 'infra', 'platform', 'platform.repository.ts'),
        'utf8',
    );
    const body = source.slice(source.indexOf('protected async aggregatePage'));
    // Spread FIRST, so a caller's key can add but never remove one of ours.
    return /\{\s*\.\.\.this\.projection,\s*\.\.\.spec\.project\s*\}/.test(body)
        && body.includes('$project: projection');
});

t.assert('aggregatePage refuses an exclusion in the caller’s extra projection', () => {
    const source = readFileSync(
        join(__dirname, '..', '..', 'src', 'infra', 'platform', 'platform.repository.ts'),
        'utf8',
    );
    return source.includes('function assertInclusionOnly')
        && /value === 0 \|\| value === false/.test(source)
        && source.includes('assertInclusionOnly(spec.project)');
});

/**
 * ...at ANY DEPTH, and this one was found the expensive way.
 *
 * The guard checked only the top level until Phase 11. The agency directory and detail both
 * passed `{ magazin: MAGAZIN_PROJECTION }`, whose NESTED `_id: 0` is an exclusion inside an
 * inclusion projection — which Mongo refuses outright, so `GET /agencies` and
 * `GET /agencies/:id` answered **500 on every request** from Phase 9 until an accounts route
 * read an agency through the same repository.
 *
 * No DB-free assertion could have caught the shape itself: it is legal TypeScript, legal
 * JSON, and illegal only to `$project`. What CAN be caught is the guard failing to recurse,
 * which is what this asserts — and it is asserted by RUNNING the guard rather than by
 * scanning for a keyword, because the bug was a missing traversal, not a missing line.
 */
t.assert('...at any depth — a nested `_id: 0` is refused, not just a top-level one', () => {
     
    const { assertInclusionOnly } = require('../../src/infra/platform/platform.repository');
    return throws(() => assertInclusionOnly({ magazin: { _id: 0, name: 1 } }))
        && throws(() => assertInclusionOnly({ a: { b: { c: false } } }))
        && !throws(() => assertInclusionOnly({ magazin: 1 }))
        && !throws(() => assertInclusionOnly({ agent: { _id: 1, name: 1 } }));
});

/**
 * The two call sites that were broken, pinned by shape: an outer projection may NAME a
 * joined sub-document, never restate its inner whitelist. The `$lookup`'s own `$project` is
 * that whitelist and it is the one allowed to exclude `_id`.
 */
t.assert('the agency read paths keep their joined document by NAME, not by restating it', () => {
    const raw = readFileSync(
        join(__dirname, '..', '..', 'src', 'modules', 'agencies', 'repositories', 'agency.read.repository.ts'),
        'utf8',
    );
    // Comments stripped: the call sites now CARRY the counter-example in prose ("never
    // `{ magazin: MAGAZIN_PROJECTION }`"), which a raw scan would read as the bug itself.
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    return !/magazin:\s*MAGAZIN_PROJECTION/.test(code)
        && code.includes('KEEP_MAGAZIN')
        && code.includes('pipeline: [{ $project: MAGAZIN_PROJECTION }]');
});

t.assert('aggregatePage refuses $out and $merge on both stage lists', () => {
    const source = readFileSync(
        join(__dirname, '..', '..', 'src', 'infra', 'platform', 'platform.repository.ts'),
        'utf8',
    );
    // Both lists, not just `match` — a `$merge` hidden in a join stage is still a write.
    return source.includes('assertReadOnlyPipeline([...spec.match, ...join])');
});

t.assert('PlatformOwnedRepository does expose writes', () => {
     
    const { PlatformOwnedRepository } = require('../../src/infra/platform/platform.repository');
    const surface = Object.getOwnPropertyNames(PlatformOwnedRepository.prototype);
    return ['insertOneDoc', 'updateOneBy', 'deleteOneBy'].every((m) => surface.includes(m));
});

t.assert('the users read repository projects away password_hash', () => {
    const source = readFileSync(
        join(__dirname, '..', '..', 'src', 'modules', 'users', 'repositories', 'user.read.repository.ts'),
        'utf8',
    );
    // A whitelist, so the assertion is that the field is absent rather than excluded.
    return !source.includes('password_hash: 1') && source.includes('const USER_PROJECTION');
});

// ─────────────────────────────────────────────────────────────────────────────
t.section('7. Delegated modules hold no domain logic');

/**
 * A gateway that grows a rule is the first step to a second opinion about the cash chain.
 * This is a crude check on purpose — it catches the shape, not every possible rule.
 */
/**
 * ── This used to ban the WORD `amount`, and that stopped working ─────────────
 * Phase 11 ported `POST /cod/deposits`, which carries an amount in its body — so the
 * gateway now names the field while doing nothing to it. The tempting fix when this
 * failed was to rename the variable; the right fix was to assert what the rule actually
 * says, which is that no arithmetic and no threshold comparison happens here. A gateway
 * that grows either is the first step to a second opinion about the cash chain.
 */
t.assert('the COD gateway contains no arithmetic or comparison on amounts', () => {
    const source = readFileSync(
        join(__dirname, '..', '..', 'src', 'modules', 'cod', 'gateways', 'cod.gateway.ts'),
        'utf8',
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const comparesToLiteral = /[<>]=?\s*\d/.test(code);
    const doesArithmetic = /\bamount\w*\s*[-+*/]|[-+*/]\s*\bamount\w*/i.test(code);
    return !comparesToLiteral && !doesArithmetic;
});

/**
 * ── Narrowed at Phase 11, because the COD module is now MIXED-transport ──────
 * It used to name the controller as well, on the premise that nothing in the module
 * touched the shared database. That premise is gone: the COD *records* — remittances,
 * deposits, discrepancies, cash accounts, ledgers, trust events — are direct reads now,
 * and only the *derivations* (the overview) stay delegated. See ADR-009 D-1.
 *
 * The assertion is kept and pointed at the GATEWAY alone, where it still means something:
 * the delegation transport must not grow a second way to reach the data it delegates. It
 * was left listing the controller — where it would have gone on passing while no longer
 * asserting anything — deliberately not, because a green check that tests nothing is
 * worse than no check.
 */
t.assert('the COD gateway never imports the platform repository bases', () => {
    const source = readFileSync(
        join(__dirname, '..', '..', 'src', 'modules', 'cod', 'gateways', 'cod.gateway.ts'),
        'utf8',
    );
    return !source.includes('platform.repository');
});

t.assert('the users module never imports the delegation client', () => {
    const source = readFileSync(
        join(__dirname, '..', '..', 'src', 'modules', 'users', 'repositories', 'user.read.repository.ts'),
        'utf8',
    );
    return !source.includes('platform.client');
});

// ─────────────────────────────────────────────────────────────────────────────
// The async tail — see §4.
captureUnconfiguredCall()
    .then(() => {
        t.section('8. Unconfigured platform, through the client');

        t.assert('a delegated call answers 503 — the route exists, the dependency does not', () =>
            unconfiguredError instanceof AppError
            && unconfiguredError.statusCode === 503
            && unconfiguredError.code === ERROR_CODES.SERVICE_DEPENDENCY_UNAVAILABLE);

        t.assert('...and says which variable is missing, so the fix is obvious', () =>
            unconfiguredError instanceof AppError
            && unconfiguredError.message.includes('JOVI_MALL_BASE_URL'));

        process.exit(t.finish());
    })
    .catch((error) => {
        console.error('\n❌ test:data-access failed to run\n', error);
        process.exit(1);
    });
