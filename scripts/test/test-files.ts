/**
 * Files — the delegated file surface, with no infrastructure.
 *
 * Phase 5 Part B put two housekeeping routes beside the resolver that already lived here.
 * Nothing about them is complicated; what makes them worth their own suite is that **every
 * safeguard on them fails silently**. A projection that leaks the storage key still answers
 * 200. A confirmation guard that compares the wrong two values still deletes. A `/:fileId`
 * declared above `/orphans` still returns a plausible 400. None of that shows up as an
 * error anywhere, which is exactly the shape `test:public-catalog` and `test:uploads` exist
 * for in the other repository.
 *
 * Four sections carry the weight:
 *
 *   §2  **the D-10 leak assertion.** `toOrphanFile` is built from a row carrying every
 *       field jovi-mall's `File` entity has — key, provider, checksum, ownerId, the
 *       soft-delete stamps — and the serialised result is asserted to contain none of them.
 *       Asserting this by source scan would prove the code SAYS the right thing rather than
 *       that it DOES it.
 *   §3  **the D-9 confirmation, driven for real.** The controller is called with a real
 *       request shape and the error is caught off `next`. A mismatch must never reach the
 *       gateway, and this is the assertion that proves it rather than assuming it.
 *   §4  **the route declaration order.** `/orphans` above `/:fileId`, read out of the
 *       source in declaration order. Reversed, the listing is swallowed and answers a 400
 *       about a malformed id — a failure that reads like a client bug.
 *   §5  **the tier split.** The listing is tiers 1–2 and the delete is tier 1 alone, and
 *       the mechanism is `destructive: true` rather than anybody typing a list. This
 *       section pins BOTH the outcome and the mechanism, because the outcome is reachable
 *       by accident.
 *   §8  **the L-3 drift check** (BR-015). `infra/storage/storage-trees.ts` is a VERBATIM
 *       COPY of jovi-mall's classification, and this section re-reads jovi-mall's file from
 *       disk and diffs the two maps — the same mechanism `test:data-access` § 2 applies to
 *       `COLLECTIONS`, for a worse failure. A tree reclassified there and not here makes
 *       this service publish a public URL for a private file: a delivery proof or a vendor's
 *       saleable product, fetchable by anyone with the link, forever. Nothing throws,
 *       nothing logs, and the URL looks correct.
 *   §9  **the media-library row** (BR-015). Built from a row carrying every field jovi-mall's
 *       `File` entity has, exactly as §2 builds the orphan row, plus the query contract and
 *       the filter builder — including that a search term reaches Mongo **escaped**.
 *
 * Mutation-tested. Each of these edits must turn this suite red:
 *   - add `key: row.key` to `toOrphanFile`                                  → §2
 *   - change the controller's guard to `confirmFileId === fileId`           → §3
 *   - move the `/orphans` or `/library` route below `/:fileId`              → §4
 *   - drop `destructive: true` from `files.delete` in the catalog           → §5
 *   - flip any tree in `infra/storage/storage-trees.ts`                     → §8
 *   - add `audit:` to the `/library` route                                  → §4
 *   - replace `containsInsensitive` with a bare `new RegExp` in the filter  → §9
 *
 *   npm run test:files
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { suite } from './_assert';

// Env must be set before importing anything that reads config at module load.
process.env.NODE_ENV = 'test';
process.env.MONGO_URI_PLATFORM = 'mongodb://localhost:27017/jovi_mall_test';
process.env.MONGO_URI_ADMIN = 'mongodb://localhost:27017/wi_admin_test';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.ADMIN_JWT_SECRET = 'test-access-secret-value-32-chars-long';
process.env.ADMIN_JWT_REFRESH_SECRET = 'test-refresh-secret-value-32-chars-long';
process.env.ADMIN_DASHBOARD_ORIGINS = 'http://localhost:5173';

/**
 * ⚠ **Set so § 9 exercises URL CONSTRUCTION rather than the unconfigured path** (BR-015 · L-3).
 *
 * With `STORAGE_PROVIDER` unset every `FileDetail.url` is `null` and a warning is logged
 * once — the correct inert behaviour, and useless as a test: the public/private split would
 * pass while producing `null` for both. These two values make the local provider's form
 * reproducible here, and they are jovi-mall's own defaults, so the string § 9 asserts is
 * the one that deployment actually emits.
 */
process.env.STORAGE_PROVIDER = 'local';
process.env.STORAGE_LOCAL_URL = 'http://localhost:8022/api/files';

import { ObjectId } from 'mongodb';
import { FileController } from '../../src/modules/files/controllers/file.controller';
import {
    OrphanFile,
    PlatformOrphanFile,
    toOrphanFile,
} from '../../src/modules/files/gateways/file.gateway';
import {
    FileLibraryQuerySchema,
    HardDeleteFileBodySchema,
    OrphansQuerySchema,
    ResolveFilesQuerySchema,
} from '../../src/modules/files/validators/file.validator';
import {
    STORAGE_TREE_VISIBILITY,
    isPrivateStorageKey,
} from '../../src/infra/storage/storage-trees';
import { toLibraryFile } from '../../src/modules/files/read-models/file-library.dto';
import {
    StoredFileReadModel,
    buildLibraryFilter,
} from '../../src/modules/files/repositories/file-library.read.repository';
import { adminUploadLimits } from '../../src/modules/files/domain/upload-limits';
import { AUDIT_CATALOG, AuditAction } from '../../src/modules/audit/domain/audit.catalog';
import { subjectClassOf } from '../../src/modules/audit/domain/audit-subject';
import { AUDIT_TARGET_TYPES } from '../../src/modules/audit/domain/audit.types';
import { PERMISSION_CATALOG } from '../../src/modules/authorization/domain/permission.catalog';
import { TIER_GRANTS, allInFamily } from '../../src/modules/authorization/domain/tier-grants';
// The legacy endpoint map was imported here and is DELETED (Phase 5 Part D).
import { ERROR_CODES } from '../../src/core/errors/error-codes';
import { createAppError } from '../../src/core/errors/app-error';

const t = suite('files (Phase 5 Part B)');

const SRC = join(__dirname, '..', '..', 'src');
const ROUTES_SRC = readFileSync(join(SRC, 'modules', 'files', 'routes', 'file.routes.ts'), 'utf8');

/** Strip comments before scanning — this file's headers quote the anti-patterns they forbid. */
function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const ROUTES_CODE = stripComments(ROUTES_SRC);

/**
 * The gateway's source, for the BR-011 ordering scan. Comments stripped for the same
 * reason as above — that file's header quotes `recordEvent` while explaining why the
 * content read must NOT use it, and an unstripped scan would read the explanation as the
 * violation.
 */
const GATEWAY_CODE = stripComments(
    readFileSync(join(SRC, 'modules', 'files', 'gateways', 'file.gateway.ts'), 'utf8'),
);

// ─────────────────────────────────────────────────────────────────────────────
t.section('1. The two shapes on this mount — resolve, and enumerate');

t.assert('`?ids=` still refuses an empty set — this is a resolver, not a listing', () =>
    !ResolveFilesQuerySchema.safeParse({ ids: '' }).success);

t.assert('`?ids=` is capped at 100, one page of this service', () => {
    const under = Array.from({ length: 100 }, () => 'a'.repeat(24)).join(',');
    const over = Array.from({ length: 101 }, () => 'a'.repeat(24)).join(',');
    return ResolveFilesQuerySchema.safeParse({ ids: under }).success
        && !ResolveFilesQuerySchema.safeParse({ ids: over }).success;
});

/**
 * The 24-hour floor, and it is enforced on both sides of the hop deliberately —
 * jovi-mall's `OrphansQuerySchema` refuses the same thing. Repeating it means the refusal
 * arrives before the hop rather than after it, the shape `PruneOutboxSchema` already uses
 * for its 7-day retention floor.
 */
const hoursAgo = (h: number): string => new Date(Date.now() - h * 3_600_000).toISOString();

t.assert('`olderThan` inside the last 24 hours is refused', () =>
    !OrphansQuerySchema.safeParse({ olderThan: hoursAgo(1) }).success
    && !OrphansQuerySchema.safeParse({ olderThan: hoursAgo(23) }).success);

t.assert('`olderThan` older than 24 hours is accepted', () =>
    OrphansQuerySchema.safeParse({ olderThan: hoursAgo(25) }).success
    && OrphansQuerySchema.safeParse({ olderThan: hoursAgo(24 * 30) }).success);

t.assert('a future `olderThan` is refused — it is past the floor in the wrong direction', () =>
    !OrphansQuerySchema.safeParse({ olderThan: new Date(Date.now() + 3_600_000).toISOString() }).success);

/**
 * Absent is legal, and it must be: jovi-mall defaults the cutoff to seven days ago, and
 * one default in one place is why this schema does not restate it. A `.default()` here
 * would be a second copy that can disagree with the `meta.olderThan` it comes back with.
 */
t.assert('`olderThan` is optional, and this side supplies no default of its own', () => {
    const parsed = OrphansQuerySchema.safeParse({});
    return parsed.success
        && parsed.data.olderThan === undefined
        && !stripComments(readFileSync(
            join(SRC, 'modules', 'files', 'validators', 'file.validator.ts'), 'utf8',
        )).includes('.default(');
});

t.assert('a date-only `olderThan` is refused — a day is not an instant', () =>
    !OrphansQuerySchema.safeParse({ olderThan: '2026-01-01' }).success);

// ─────────────────────────────────────────────────────────────────────────────
t.section('2. D-10 — the orphan row withholds the storage key');

/**
 * Every field jovi-mall's `File` domain entity carries (`repositories/mappers/file.mapper.ts`),
 * so this is the whole of what could leak rather than the fields somebody remembered.
 */
const RAW_ROW: PlatformOrphanFile = {
    id: '6612a4f0c1a2b3d4e5f60718',
    key: 'vendors/665a1b2c3d4e5f6071829304/logo-1f2e3d.png',
    provider: 'firebase',
    mimeType: 'image/png',
    size: 48_213,
    checksum: 'd41d8cd98f00b204e9800998ecf8427e',
    originalName: 'shop-logo.png',
    ownerType: 'vendor',
    ownerId: '665a1b2c3d4e5f6071829304',
    orphanedAt: '2026-08-01T09:00:00.000Z',
    createdAt: '2026-07-04T11:22:33.000Z',
    updatedAt: '2026-08-01T09:00:00.000Z',
    deletedAt: null,
    purgeAt: null,
};

const projected: OrphanFile = toOrphanFile(RAW_ROW);
const serialised = JSON.stringify(projected);

t.assert('the storage key is ABSENT from the projection, not null', () =>
    !('key' in projected) && !serialised.includes('vendors/') && !serialised.includes('"key"'));

/**
 * The key is the headline, but a spread would have published all of these too, and each
 * says something about the platform's storage that an operator judging a file does not
 * need. `provider` and `checksum` describe the bucket; `ownerId` names the party.
 */
t.assert('provider, checksum, ownerId and the storage timestamps are absent too', () =>
    !serialised.includes('firebase')
    && !serialised.includes('d41d8cd98f00b204')
    && !serialised.includes('665a1b2c3d4e5f6071829304')
    && !('orphanedAt' in projected)
    && !('purgeAt' in projected)
    && !('deletedAt' in projected));

/**
 * The other half of D-10: the operator must be able to JUDGE the file. A projection that
 * withheld everything would be safe and useless, and the six fields below are the whole of
 * what makes an unrecoverable delete a decision rather than a coin toss.
 */
t.assert('the six fields an operator judges on are all present', () =>
    Object.keys(projected).sort().join(',')
    === 'createdAt,id,mimeType,originalName,ownerType,size');

t.assert('a file with no original name or owner projects nulls, never undefined', () => {
    const bare = toOrphanFile({
        id: '6612a4f0c1a2b3d4e5f60719',
        key: 'misc/orphan.bin',
        mimeType: 'application/octet-stream',
        size: 12,
        createdAt: '2026-07-04T11:22:33.000Z',
    });
    return bare.originalName === null
        && bare.ownerType === null
        && JSON.stringify(bare).includes('"originalName":null');
});

/**
 * The projection is the gateway's, not the controller's, and that is what makes it hold for
 * a route added later. Both new routes must go through the gateway rather than reaching
 * `platformRequest` themselves.
 */
t.assert('the controller never speaks to the platform client directly', () => {
    const code = stripComments(readFileSync(
        join(SRC, 'modules', 'files', 'controllers', 'file.controller.ts'), 'utf8',
    ));
    return !code.includes('platformRequest') && !code.includes('platform.client');
});

// ─────────────────────────────────────────────────────────────────────────────
t.section('3. D-9 — the delete requires the id repeated in the body');

t.assert('the body schema requires a well-formed `confirmFileId`', () =>
    HardDeleteFileBodySchema.safeParse({ confirmFileId: 'a'.repeat(24) }).success
    && !HardDeleteFileBodySchema.safeParse({}).success
    && !HardDeleteFileBodySchema.safeParse({ confirmFileId: 'nope' }).success);

/**
 * Driven rather than scanned, because a guard comparing the wrong two values deletes
 * exactly as happily as a correct one does and looks identical in a diff.
 *
 * ⚠ **Awaited, and that is not a formality.** `asyncHandler` wraps the handler in
 * `Promise.resolve(fn(...)).catch(next)`, so even a synchronous throw inside an `async`
 * function reaches `next` a microtask later. Reading the captured error without awaiting
 * gives `null` every time — the first version of this file did exactly that and reported
 * three failures against code that was correct. The harness header makes the same point
 * about assertions that return a Promise: await first, assert on the result.
 *
 * Runs with no jovi-mall, no Mongo and no Redis: the mismatch branch throws before any
 * gateway call, which is precisely the property this section is about.
 */
async function driveHardDelete(fileId: string, confirmFileId: unknown): Promise<Error | null> {
    let captured: Error | null = null;

    const req = {
        params: { fileId },
        body: { confirmFileId },
        query: {},
        method: 'DELETE',
        path: `/api/v1/files/${fileId}/permanent`,
        headers: {},
        auth: undefined,
    } as unknown as Parameters<typeof FileController.hardDelete>[0];

    const res = {
        status() { return this; },
        json() { return this; },
    } as unknown as Parameters<typeof FileController.hardDelete>[1];

    await new Promise<void>((resolve) => {
        FileController.hardDelete(req, res, ((err: Error) => {
            captured = err;
            resolve();
        }) as never);
        // A guard that let the request through calls no `next`, so the drive must not
        // hang: give the microtask queue a turn and report `null`.
        setTimeout(resolve, 0);
    });

    return captured;
}

const codeOf = (err: Error | null): string | null =>
    (err as unknown as { code?: string } | null)?.code ?? null;

async function runDrivenChecks(): Promise<void> {
    const mismatch = await driveHardDelete('6612a4f0c1a2b3d4e5f60718', '6612a4f0c1a2b3d4e5f60719');
    const missing = await driveHardDelete('6612a4f0c1a2b3d4e5f60718', undefined);

    t.assert('a mismatched confirmation is refused', () =>
        codeOf(mismatch) === ERROR_CODES.FILE_DELETE_NOT_CONFIRMED);

    t.assert('the refusal is a 400 — a body that failed a rule, not a state that moved', () =>
        (mismatch as unknown as { statusCode?: number } | null)?.statusCode === 400);

    t.assert('a missing confirmation is refused, not treated as consent', () =>
        missing !== null);

    /**
     * The one that says the guard is not cosmetic: a refused delete must not have REACHED
     * jovi-mall. With `JOVI_MALL_BASE_URL` unset a gateway call raises
     * `SERVICE_DEPENDENCY_UNAVAILABLE`, so this is stated POSITIVELY — the code is the
     * confirmation refusal, not merely "not the dependency one". The negative form passes
     * when nothing was captured at all, which is the shape of a test that cannot fail.
     */
    t.assert('a refused delete never reaches the platform', () =>
        codeOf(mismatch) === ERROR_CODES.FILE_DELETE_NOT_CONFIRMED
        && codeOf(mismatch) !== ERROR_CODES.SERVICE_DEPENDENCY_UNAVAILABLE);

    t.assert('the code renders a message naming the remedy', () => {
        const message = createAppError(ERROR_CODES.FILE_DELETE_NOT_CONFIRMED, 400).message;
        return message !== 'An error occurred' && /confirm/i.test(message);
    });
}

/**
 * Everything from section 4 on is synchronous again; it is wrapped only so the awaited
 * section above prints before it. Sections print in call order, and a suite whose output
 * order does not match its file order is one nobody can read against the source.
 */
async function runRemainingChecks(): Promise<void> {

// ─────────────────────────────────────────────────────────────────────────────
t.section('4. Route declaration order and shape');

/** Route paths in the order `defineRoute` is called, which IS Express's matching order. */
function declaredRoutes(source: string): Array<{ method: string; path: string }> {
    const routes: Array<{ method: string; path: string }> = [];
    for (const block of source.split('defineRoute(').slice(1)) {
        const body = block.split('});')[0];
        const method = /method: '(\w+)'/.exec(body)?.[1];
        const path = /path: '([^']*)'/.exec(body)?.[1];
        if (method && path !== undefined) routes.push({ method, path });
    }
    return routes;
}

const DECLARED = declaredRoutes(ROUTES_CODE);

/**
 * One route's declaration block, isolated.
 *
 * ⚠ **A character-window regex is not good enough for a NEGATIVE assertion on this mount,
 * and that is not hypothetical — it is how the L-5 check first failed.** `/library` and
 * `/upload` are declared adjacently, so `/path: '\/library'[\s\S]{0,400}?audit:/` reached
 * straight past the library's own block into the upload's `audit: records('files.upload')`
 * and reported the library as audited. A window that is wide enough to cover a block is
 * wide enough to cover the next one, and shrinking it just moves the failure.
 *
 * So: split on `defineRoute(`, take the block whose `path:` matches, and search only that.
 * A positive assertion tolerates a window; a negative one has to be exact, because it is
 * asserting that something is ABSENT and the neighbour's copy of it is indistinguishable.
 */
function routeBlock(path: string, method?: string): string | null {
    for (const block of ROUTES_CODE.split('defineRoute(').slice(1)) {
        const body = block.split('});')[0];
        if (!new RegExp(`path: '${path.replace(/[/:]/g, (c) => `\\${c}`)}'`).test(body)) continue;
        if (method && !new RegExp(`method: '${method}'`).test(body)) continue;
        return body;
    }
    return null;
}

t.assert('the scan finds all seven routes — it is looking at something', () =>
    DECLARED.length === 7);

/**
 * ⚠ The assertion this suite exists for most. Express matches in declaration order, so
 * `/:fileId` above `/orphans` swallows the listing: the request reaches the single-file
 * handler, fails the 24-hex param schema, and answers a 400 about a malformed id — for a
 * route that exists and that the caller is permitted to reach.
 */
t.assert('`/orphans` is declared BEFORE `/:fileId`', () => {
    const orphans = DECLARED.findIndex((r) => r.method === 'get' && r.path === '/orphans');
    const single = DECLARED.findIndex((r) => r.method === 'get' && r.path === '/:fileId');
    return orphans !== -1 && single !== -1 && orphans < single;
});

/**
 * ⚠ **The same assertion for the media library** (BR-015), and it is a second instance of
 * the rule rather than a copy of a passing test: `/library` is a literal segment on the
 * same mount, so `/:fileId` above it swallows it exactly as it would swallow `/orphans` —
 * and the symptom is the same plausible 400 about a malformed id, on a route the caller is
 * permitted to reach.
 *
 * Asserted separately from `/orphans` on purpose. One combined assertion would pass while
 * only one of the two literals was correctly placed, which is precisely the state a later
 * edit produces.
 */
t.assert('`/library` is declared BEFORE `/:fileId`', () => {
    const library = DECLARED.findIndex((r) => r.method === 'get' && r.path === '/library');
    const single = DECLARED.findIndex((r) => r.method === 'get' && r.path === '/:fileId');
    return library !== -1 && single !== -1 && library < single;
});

/**
 * `POST /upload` cannot collide with `GET /:fileId` — different methods — so this is a
 * convention assertion rather than a correctness one, and it is worth having for that
 * reason: a literal below a parameter is a shape nobody should have to re-derive as safe
 * each time they read the file.
 */
t.assert('`/upload` is declared BEFORE `/:fileId` too', () => {
    const upload = DECLARED.findIndex((r) => r.method === 'post' && r.path === '/upload');
    const single = DECLARED.findIndex((r) => r.method === 'get' && r.path === '/:fileId');
    return upload !== -1 && single !== -1 && upload < single;
});

t.assert('each route declares the permission Part B assigned it', () =>
    /path: '\/orphans'[\s\S]{0,200}?permission\('files\.orphans\.read'\)/.test(ROUTES_CODE)
    && /path: '\/:fileId\/permanent'[\s\S]{0,200}?permission\('files\.delete'\)/.test(ROUTES_CODE));

/**
 * The two BR-015 routes declare their own names — neither is folded onto `files.resolve`.
 *
 * This is the mount's standing rule in its third and fourth instances: a route that
 * ENUMERATES, or that WRITES, gets its own permission. `files.resolve` is grantable to
 * every tier only because it resolves an id set the caller already holds, and neither of
 * these does that.
 */
t.assert('the library and the upload declare their own permissions', () =>
    /path: '\/library'[\s\S]{0,300}?permission\('files\.library\.read'\)/.test(ROUTES_CODE)
    && /path: '\/upload'[\s\S]{0,300}?permission\('files\.upload'\)/.test(ROUTES_CODE)
    && !/path: '\/library'[\s\S]{0,300}?permission\('files\.resolve'\)/.test(ROUTES_CODE));

/**
 * ⚠ **The upload declares NO body schema, and that is asserted rather than left implicit.**
 *
 * The body is `multipart/form-data` and this service never parses one (ADR-021 D-2) — it is
 * piped to jovi-mall unread. A `body:` schema here would be handed `{}`, Express's default
 * for a request no parser matched, and would either pass meaninglessly or reject every
 * upload. Somebody adding one to "tidy up the missing validation" is the failure this pins.
 */
t.assert('the upload declares no body schema — there is no parsed body to validate', () => {
    const block = routeBlock('/upload', 'post');
    return block !== null && !block.includes('body:');
});

t.assert('the delete validates BOTH the path id and the confirmation body', () =>
    /path: '\/:fileId\/permanent'[\s\S]{0,300}?params: FileIdParamSchema[\s\S]{0,80}?body: HardDeleteFileBodySchema/
        .test(ROUTES_CODE));

t.assert('the content read declares its own permission, not `files.resolve`', () =>
    /path: '\/:fileId\/content'[\s\S]{0,200}?permission\('files\.content\.read'\)/.test(ROUTES_CODE));

/**
 * ⚠ **This assertion inverted at BR-011, and the count is the point.**
 *
 * It used to read "the delete is the only audited route on the mount", pinning
 * `audit:` to exactly one occurrence. That was true and worth pinning while every read
 * here was metadata: auditing a read that discloses nothing is volume with nothing to say,
 * and it dilutes a trail whose value depends on being sparse.
 *
 * `GET /:fileId/content` is the exception the rule already had elsewhere — the output IS
 * the disclosure, the same test that made `money.payouts.destination.read` and the two
 * tracking reads audited.
 *
 * ⚠ **BR-015 moved it to THREE, and the shape of the change is the point.** The upload is a
 * WRITE, so it needs no exception argument at all — every write on this service is audited.
 * The media library is a READ that ENUMERATES, and the dashboard argued that alone should
 * earn a row; it was weighed and declined (L-5, ADR-021 D-6), so the count did **not** go to
 * four. Still pinned to an exact number rather than a minimum: a fourth audited route here
 * would mean somebody decided a metadata read discloses something, and that decision should
 * not pass silently.
 */
t.assert('exactly three audited routes — the delete, the content disclosure, the upload', () =>
    (ROUTES_CODE.match(/audit: /g) ?? []).length === 3
    && /path: '\/:fileId\/permanent'[\s\S]{0,300}?audit: records\('files\.delete'\)/.test(ROUTES_CODE)
    && /path: '\/:fileId\/content'[\s\S]{0,300}?audit: records\('files\.content\.read'\)/.test(ROUTES_CODE)
    && /path: '\/upload'[\s\S]{0,300}?audit: records\('files\.upload'\)/.test(ROUTES_CODE));

/**
 * ⚠ The other half of L-5, and it must be asserted POSITIVELY rather than as "the count is
 * three": the library must carry no `audit:` of its own. A regression that added one would
 * take the count to four and fail the assertion above — but so would any other new audited
 * route, and the two mean completely different things.
 */
t.assert('the media library is NOT audited — L-5, and it is a decision', () => {
    const block = routeBlock('/library', 'get');
    return block !== null && !block.includes('audit:');
});

t.assert('no route on this mount is registered directly on the router', () =>
    !/\brouter\s*\.\s*(get|post|put|patch|delete|all|use)\s*\(/.test(ROUTES_CODE));

// ─────────────────────────────────────────────────────────────────────────────
t.section('5. The tier split, and the mechanism behind it');

const has = (tier: 1 | 2 | 3, name: string): boolean =>
    (TIER_GRANTS[tier] as readonly string[]).includes(name);

t.assert('`files.resolve` is held by every tier — it resolves an id the caller has', () =>
    has(1, 'files.resolve') && has(2, 'files.resolve') && has(3, 'files.resolve'));

/**
 * `files.content.read` is ALSO held by every tier, and it is a separate assertion on
 * purpose — the two are one grant table apart and a completely different decision.
 *
 * `files.resolve` reaches tier 3 because it discloses nothing new. This reaches tier 3
 * because Support answers the proof-photo disputes and refusing them escalates every
 * ticket — a trade that IS a real disclosure, paid for with the audit row asserted in § 6.
 * Folding the two into one assertion would let the audit be removed while this still
 * passed, which is precisely the pairing that must not come apart.
 */
t.assert('`files.content.read` reaches Support too — and § 6 is what pays for it', () =>
    has(1, 'files.content.read') && has(2, 'files.content.read') && has(3, 'files.content.read'));

/**
 * ⚠ The distinctness assertion. The whole argument of BR-011 is that opening a file is not
 * the same act as resolving its name, so the two must never collapse into one permission —
 * which would silently hand every `files.resolve` holder the bytes.
 */
t.assert('opening a file is a DIFFERENT permission from resolving one', () =>
    'files.content.read' in PERMISSION_CATALOG
    && 'files.resolve' in PERMISSION_CATALOG
    && !/path: '\/:fileId\/content'[\s\S]{0,200}?permission\('files\.resolve'\)/.test(ROUTES_CODE));

/**
 * ⚠ This assertion is a plan correction as much as a test. Four comments in this repository
 * described `files.orphans.read` as "tier-1-only"; the grant table has always said tiers 1
 * and 2, because `allInFamily('files')` sweeps it into Admin and no flag keeps a read out.
 * The claim was a forecast written at catalog time and never reconciled — the same class of
 * drift the `phase` field's docstring warns about. Pinned here in the form the source
 * actually holds, so the next person reads the table rather than the sentence.
 */
t.assert('`files.orphans.read` is tiers 1 and 2 — Support does not enumerate files', () =>
    has(1, 'files.orphans.read') && has(2, 'files.orphans.read') && !has(3, 'files.orphans.read'));

/**
 * The media library draws the SAME line as the orphan listing, and for the same reason:
 * both enumerate. Support answers tickets about records they were pointed at; browsing
 * every file on the platform is a different question, and `files.resolve` — which Support
 * does hold — cannot answer it, because it resolves an explicit id set.
 */
t.assert('`files.library.read` is tiers 1 and 2 — Support does not enumerate', () =>
    has(1, 'files.library.read') && has(2, 'files.library.read') && !has(3, 'files.library.read'));

/**
 * ⚠ **The upload is a WRITE at tier 2, and the asymmetry with `content.articles.write` is
 * deliberate rather than an oversight.** Support may write prose (Phase 5 A.6) and may not
 * put a file on the platform, so a Support administrator can fix a typo in a live article
 * and cannot add a picture to it. That follows the same line every other `files.*` name
 * draws and is worth pinning, because "Support can already edit the article" is exactly the
 * argument that would widen it without anyone revisiting the enumeration question.
 */
t.assert('`files.upload` is tiers 1 and 2 — Support writes prose, not files', () =>
    has(1, 'files.upload') && has(2, 'files.upload') && !has(3, 'files.upload'));

t.assert('`files.delete` is tier 1 alone — unrecoverable', () =>
    has(1, 'files.delete') && !has(2, 'files.delete') && !has(3, 'files.delete'));

/**
 * The outcome above is reachable by accident — somebody could type the same list by hand
 * and it would drift the first time a `files.*` name is added. What makes it structural is
 * `destructive: true`, so that is pinned separately.
 */
t.assert('`destructive: true` is what keeps the delete out of the family sweep', () =>
    PERMISSION_CATALOG['files.delete'].destructive === true
    && !allInFamily('files').includes('files.delete')
    && allInFamily('files').includes('files.orphans.read'));

t.assert('the listing and the resolver are genuinely different names', () =>
    PERMISSION_CATALOG['files.orphans.read'] !== undefined
    && PERMISSION_CATALOG['files.resolve'] !== undefined
    && PERMISSION_CATALOG['files.orphans.read'].family === 'files'
    && PERMISSION_CATALOG['files.resolve'].family === 'files');

// ─────────────────────────────────────────────────────────────────────────────
t.section('6. Audit — one action, delegated, targeting the file');

const spec = AUDIT_CATALOG['files.delete' as AuditAction];

t.assert('`files.delete` is catalogued', () => spec !== undefined);

t.assert('it is governed by the permission its route declares', () =>
    spec.permission === 'files.delete');

/**
 * `delegated`, not `wi_admin_txn`: the write lands in jovi-mall's database over HTTP, and a
 * `wi-admin` ClientSession cannot join it. Intent → outcome, the shape every delegated
 * family uses.
 */
t.assert('the transport is `delegated`', () => spec.transport === 'delegated');

/**
 * `target: 'file'` rather than `none`, because this addresses exactly one record and the id
 * is the only handle left afterwards. A `none` row would put the id in the payload and
 * nothing in the column an operator searches.
 */
t.assert('the target is `file`, and `file` is a declared target type', () =>
    spec.target === 'file' && (AUDIT_TARGET_TYPES as readonly string[]).includes('file'));

t.assert('`file` classifies as a platform record, not this service’s machinery', () =>
    subjectClassOf('file') === 'platform_record');

/**
 * The two METADATA reads stay unaudited — ADR-006 D-5. `files.content.read` is the
 * exception BR-011 added, and it is catalogued, so the family holds exactly two actions.
 */
t.assert('the three metadata reads have no catalogued action', () => {
    const actions = (Object.keys(AUDIT_CATALOG) as string[]).filter((a) => a.startsWith('files.'));
    return actions.length === 3
        && actions.includes('files.delete')
        && actions.includes('files.content.read')
        && actions.includes('files.upload')
        // The three unaudited reads, named so the assertion says WHICH silences are decided.
        && !actions.includes('files.resolve')
        && !actions.includes('files.orphans.read')
        && !actions.includes('files.library.read');
});

/**
 * The upload's own spec (BR-015).
 *
 * `transport: 'delegated'` is the load-bearing field here for the same reason it is on the
 * content read: it selects `auditedAttempt` over `recordEvent`, so the intent commits before
 * the body is streamed. `target: 'file'` with an id filled from the outcome — the file does
 * not exist when the row is written, and a placeholder id would name a record that never was.
 */
t.assert('`files.upload` is catalogued as a delegated write against a file', () => {
    const upload = AUDIT_CATALOG['files.upload' as keyof typeof AUDIT_CATALOG];
    return upload !== undefined
        && upload.permission === 'files.upload'
        && upload.target === 'file'
        && upload.transport === 'delegated';
});

/**
 * ⚠ The ordering assertion for the upload, by source scan — the same shape as `openContent`
 * below, and it matters more here because the work is a STREAM. `auditedAttempt` commits the
 * intent before `platformUpload` is called; reversing the two would look identical in every
 * passing test and would mean a crash mid-transfer left no record that an upload was
 * attempted at all.
 */
t.assert('`uploadFiles` records through the fail-closed writer, not `recordEvent`', () =>
    /export async function uploadFiles[\s\S]{0,900}?auditedAttempt\(/.test(GATEWAY_CODE)
    && !/export async function uploadFiles[\s\S]{0,1400}?recordEvent\(/.test(GATEWAY_CODE));

/**
 * The content disclosure's own spec, asserted the same way the delete's is above.
 *
 * `transport: 'delegated'` is the load-bearing field: it is what selects `auditedAttempt`
 * over `recordEvent`, and therefore what makes the read **fail closed**. `recordEvent` is
 * best-effort and swallows a write failure — right for a login, which already happened on
 * its own terms, and wrong here, where the row IS the control and an unreachable audit
 * store must disclose nothing.
 */
t.assert('`files.content.read` is catalogued as a delegated read against a file', () => {
    const content = AUDIT_CATALOG['files.content.read' as keyof typeof AUDIT_CATALOG];
    return content !== undefined
        && content.permission === 'files.content.read'
        && content.target === 'file'
        && content.transport === 'delegated';
});

/**
 * ⚠ The ordering assertion, by source scan, because nothing behavioural can see it.
 *
 * `auditedAttempt` commits the intent BEFORE the work and does not catch a failure of that
 * write. Reversing the two — fetching the bytes and then recording — would look identical
 * in every passing test and would silently remove the fail-closed property the tier-3
 * grant rests on. So: the gateway's content path must go through `auditedAttempt`, and
 * must not reach for the best-effort writer.
 */
t.assert('`openContent` records through the fail-closed writer, not `recordEvent`', () =>
    /export async function openContent[\s\S]{0,600}?auditedAttempt\(/.test(GATEWAY_CODE)
    && !/export async function openContent[\s\S]{0,900}?recordEvent\(/.test(GATEWAY_CODE));

// ─────────────────────────────────────────────────────────────────────────────
t.section('7. The legacy checklist is GONE');

/**
 * Two assertions stood here — "neither file row survives in the legacy map" and "no row
 * anywhere still maps to a `files.*` permission" — written in the "gone from the checklist"
 * form because a count pinned at the pre-port number fails for the success
 * (`PHASE-17-STATUS.md` § 7).
 *
 * **Phase 5 Part D went one step further and deleted the checklist.** Both would now pass by
 * having nothing to read, which is the same failure wearing the opposite face. The surviving
 * fact — the map is gone and nothing reconstructs it — is asserted once in `test-authz.ts`
 * § 9. What guards this domain is § 3 above, which reads the routes off a real Express mount.
 */


// ─────────────────────────────────────────────────────────────────────────────
t.section('8. L-3 containment — the storage-tree copy has not drifted from jovi-mall');

/**
 * ⚠ **The assertion this section exists for, and the reason BR-015 needed containment at
 * all.**
 *
 * Decision L-3 put URL construction in THIS service, which means `infra/storage/
 * storage-trees.ts` is a second copy of a classification that lives in jovi-mall. A tree
 * reclassified there and not here does not throw, does not log and does not fail a request:
 * it makes this service publish a **public URL for a private file** — a delivery-proof
 * photograph or a vendor's saleable digital product, fetchable by anyone holding the link,
 * forever. That is precisely the defect ADR-A01 D-2 closed on the other side, reintroduced
 * in a service whose whole audience is administrators.
 *
 * The mechanism is the one `test:data-access` § 2 already applies to `COLLECTIONS`: re-read
 * the upstream file from disk and diff the data. It is modelled on that check deliberately
 * — same shape, same failure mode, same reasoning — because a verbatim copy with no
 * automated diff is a copy that will drift, and this is the copy where drifting is a leak.
 */
const JOVI_TREES_PATH = join(
    __dirname, '..', '..', '..', 'jovi-mall', 'src', 'core', 'storage', 'storage-trees.ts',
);

let joviTreesSource: string | null = null;
try {
    joviTreesSource = readFileSync(JOVI_TREES_PATH, 'utf8');
} catch {
    joviTreesSource = null;
}

t.assert('jovi-mall\'s storage-trees.ts is readable from here', () => joviTreesSource !== null);

if (joviTreesSource) {
    /**
     * Parse `tree: 'public',` pairs out of the `STORAGE_TREE_VISIBILITY` block only.
     *
     * The optional quotes matter: hyphenated trees (`'vendor-policy-documents'`,
     * `'ticket-attachments'`) are not valid bare identifiers, so a pattern that only
     * matched bare keys would silently skip exactly the entries whose names are least
     * guessable — including one of the three private ones.
     */
    const treeBlock = joviTreesSource.slice(joviTreesSource.indexOf('export const STORAGE_TREE_VISIBILITY'));
    const upstream = new Map<string, string>();
    for (const match of treeBlock.matchAll(/^\s{4}'?([a-zA-Z0-9_-]+)'?:\s*'(public|private)',/gm)) {
        upstream.set(match[1], match[2]);
    }

    t.assert('the source block parsed — it is looking at something', () => upstream.size >= 10);

    t.assert('every tree this service copied still has the SAME verdict upstream', () => {
        const mismatches: string[] = [];
        for (const [tree, visibility] of Object.entries(STORAGE_TREE_VISIBILITY)) {
            const theirs = upstream.get(tree);
            if (theirs === undefined) {
                mismatches.push(`${tree}: removed upstream`);
            } else if (theirs !== visibility) {
                mismatches.push(`${tree}: copy says "${visibility}", jovi-mall says "${theirs}"`);
            }
        }
        if (mismatches.length > 0) console.error(`      ${mismatches.join('\n      ')}`);
        return mismatches.length === 0;
    });

    /**
     * ⚠ **The other direction, and it is the one that actually leaks.** A tree present
     * upstream and missing here fails CLOSED — `isPrivateStorageKey` treats an unknown tree
     * as private, so the file renders as a missing image rather than being published. That
     * is the safe direction and it is still a failure: it silently breaks a screen.
     *
     * A tree present HERE and gone upstream is the dangerous one, and it is covered by the
     * assertion above (`removed upstream`). Both directions are checked because "the two
     * files agree" is the only statement worth making.
     */
    t.assert('this service has no tree jovi-mall does not declare, and vice versa', () => {
        const ours = new Set(Object.keys(STORAGE_TREE_VISIBILITY));
        const missingHere = [...upstream.keys()].filter((tree) => !ours.has(tree));
        const extraHere = [...ours].filter((tree) => !upstream.has(tree));
        if (missingHere.length > 0) console.error(`      missing from the copy: ${missingHere.join(', ')}`);
        if (extraHere.length > 0) console.error(`      not in jovi-mall: ${extraHere.join(', ')}`);
        return missingHere.length === 0 && extraHere.length === 0;
    });
}

/**
 * The fail-closed rule, driven rather than read. An unclassified tree must be PRIVATE — the
 * opposite default is the original defect's own failure mode, and it is also what makes a
 * stale copy degrade safely rather than dangerously.
 */
t.assert('an unrecognised tree is PRIVATE — fails closed', () =>
    isPrivateStorageKey('some-tree-nobody-classified/2026/08/x.png')
    && isPrivateStorageKey('')
    && isPrivateStorageKey('/'));

/**
 * ⚠ Backslashes are real. jovi-mall's local provider builds keys with `path.join`, so a key
 * written on a Windows host carries `\` — and this service reads those keys straight out of
 * Mongo. Without normalisation "is this private?" answers differently depending on which
 * machine wrote the file, which is a leak that cannot be reproduced on the reviewer's laptop.
 */
t.assert('a Windows-style key resolves to the same tree as a POSIX one', () =>
    isPrivateStorageKey('shipments\\2026\\08\\proof.jpg')
    && !isPrivateStorageKey('images\\2026\\08\\logo.png'));

t.assert('the three private trees are private, and the six by-type folders are not', () =>
    ['digital', 'shipments', 'ticket-attachments']
        .every((tree) => isPrivateStorageKey(`${tree}/2026/08/x.bin`))
    && ['images', 'videos', 'audio', 'documents', 'archives', 'other']
        .every((tree) => !isPrivateStorageKey(`${tree}/2026/08/x.bin`)));

/**
 * ⚠ **The one that closes the blog half of BR-015.** An administrator's upload goes through
 * `folder: 'by-type'`, which `resolveTypeFolder` maps onto one of the six above — so an
 * uploaded cover image lands in `images/`, resolves `access: 'public'` and carries a real
 * URL. The BR asked for a definitive answer because an article's `cover.url` is a stored
 * string served to anonymous readers, and a private tree would make the picker useless
 * there. Pinned so a reclassification of `images/` fails here rather than silently emptying
 * every article cover on the marketing site.
 */
t.assert('a by-type admin upload is PUBLIC — the blog half of BR-015 depends on it', () =>
    STORAGE_TREE_VISIBILITY.images === 'public'
    && STORAGE_TREE_VISIBILITY.documents === 'public');

// ─────────────────────────────────────────────────────────────────────────────
t.section('9. The media-library row — projection, owner and usage (BR-015)');

/**
 * Every field jovi-mall's `File` domain entity carries, so this is the whole of what could
 * leak rather than the fields somebody remembered — the same construction § 2 uses for the
 * orphan row, and for the same reason: a projection asserted by source scan proves the code
 * SAYS the right thing rather than that it DOES it.
 */
const RAW_LIBRARY_ROW = {
    _id: new ObjectId('6612a4f0c1a2b3d4e5f60718'),
    key: 'images/2026/08/1f2e3d_logo.png',
    provider: 'firebase',
    mimeType: 'image/png',
    size: 48_213,
    checksum: 'd41d8cd98f00b204e9800998ecf8427e',
    originalName: 'shop-logo.png',
    ownerType: 'admin',
    ownerId: new ObjectId('6511aabbccddeeff00112233'),
    orphanedAt: null,
    createdAt: new Date('2026-08-11T09:14:00.000Z'),
    updatedAt: new Date('2026-08-12T10:00:00.000Z'),
    deletedAt: null,
    purgeAt: null,
} as unknown as StoredFileReadModel;

const libraryRow = toLibraryFile(RAW_LIBRARY_ROW, 'Ada Mensah', {
    referenceCount: 2,
    references: [
        {
            _id: new ObjectId('6680a4f0c1a2b3d4e5f60001'),
            fileId: RAW_LIBRARY_ROW._id,
            entityType: 'ticket',
            entityId: new ObjectId('6680a4f0c1a2b3d4e5f60002'),
            field: 'attachments',
        },
    ],
} as never);

const librarySerialised = JSON.stringify(libraryRow);

t.assert('the row carries exactly the fields BR-015 asked for', () =>
    Object.keys(libraryRow).sort().join(',')
    === 'access,createdAt,id,key,mimeType,originalName,owner,size,url,usage');

/**
 * ⚠ **`key` IS published here, unlike on the orphan row, and the difference is deliberate.**
 * D-10 withholds it from an orphan listing because the question there is "may I destroy
 * this", which a filename answers. The library's question is "show me this picture", and
 * after L-3 the key is what the URL is built FROM. It is already on the wire on every other
 * file route on this service, so nothing new is disclosed — but the two rows genuinely
 * differ, and a reader comparing them should find the reason asserted rather than inferred.
 */
t.assert('`key` is present — the library is not the orphan row', () =>
    libraryRow.key === 'images/2026/08/1f2e3d_logo.png');

t.assert('the checksum and the storage timestamps never leave the database', () =>
    !librarySerialised.includes('d41d8cd98f00b204')
    && !('checksum' in libraryRow)
    && !('orphanedAt' in libraryRow)
    && !('purgeAt' in libraryRow)
    && !('deletedAt' in libraryRow)
    && !('updatedAt' in libraryRow));

/**
 * `provider` is filtered on and never echoed. Asserted rather than left to the projection,
 * because a client that saw it would reasonably build a URL from it — and `buildPublicUrl`
 * keys on the deployment's ACTIVE provider instead, so the two answers can differ.
 */
t.assert('`provider` is not published, although the route filters on it', () =>
    !librarySerialised.includes('firebase') && !('provider' in libraryRow));

t.assert('the owner is a triple of type, id and resolved name', () =>
    libraryRow.owner.type === 'admin'
    && libraryRow.owner.id === '6511aabbccddeeff00112233'
    && libraryRow.owner.name === 'Ada Mensah');

/**
 * ⚠ **`null`, never `''` and never the id substituted silently** (ADR-005). Four different
 * situations produce it — `system`, a deleted role record, an owner with no business name
 * yet, and an administrator removed from this service — and a client renders all four the
 * same way, which is why they are not distinguished.
 */
t.assert('an unresolvable owner name is null, never an empty string or the id', () => {
    const unresolved = toLibraryFile(RAW_LIBRARY_ROW, null, undefined);
    return unresolved.owner.name === null
        && JSON.stringify(unresolved).includes('"name":null')
        && unresolved.owner.name !== unresolved.owner.id;
});

t.assert('a system-owned file reports no owner id and no name', () => {
    const system = toLibraryFile(
        { ...RAW_LIBRARY_ROW, ownerType: 'system', ownerId: null } as unknown as StoredFileReadModel,
        null,
        undefined,
    );
    return system.owner.type === 'system' && system.owner.id === null && system.owner.name === null;
});

t.assert('usage carries the count and the reference rows, with a best-effort null label', () =>
    libraryRow.usage.referenceCount === 2
    && libraryRow.usage.references.length === 1
    && libraryRow.usage.references[0].entityType === 'ticket'
    && libraryRow.usage.references[0].field === 'attachments'
    && libraryRow.usage.references[0].label === null);

/**
 * ⚠ **The truncation the dashboard asked for by name**: *"a `referenceCount` with a
 * truncated `references` array is the right answer; a page that quietly drops the rest is
 * not."* The count is the TRUE total and the array is capped — so the two legitimately
 * disagree, and `meta.referenceSampleCap` is what lets a client tell that apart from a bug.
 */
t.assert('referenceCount is the TRUE total, not the length of the sample', () =>
    libraryRow.usage.referenceCount > libraryRow.usage.references.length);

t.assert('a file nothing references reports zero and an empty array, never null', () => {
    const unused = toLibraryFile(RAW_LIBRARY_ROW, null, undefined);
    return unused.usage.referenceCount === 0 && Array.isArray(unused.usage.references)
        && unused.usage.references.length === 0;
});

/**
 * The URL half of L-3, driven end to end with `STORAGE_PROVIDER=local` set at the top of
 * this file: a public tree gets a real URL built from `STORAGE_LOCAL_URL`, and a private one
 * gets `null` with `access: 'authorized'`. That construction is asserted to be
 * byte-identical to jovi-mall's by `verify:files` § 6 — this proves it runs at all.
 */
t.assert('a public-tree row resolves to a real URL and access `public`', () =>
    libraryRow.access === 'public'
    && libraryRow.url === 'http://localhost:8022/api/files/images/2026/08/1f2e3d_logo.png');

t.assert('a private-tree row resolves to url null and access `authorized`', () => {
    const priv = toLibraryFile(
        { ...RAW_LIBRARY_ROW, key: 'shipments/2026/08/9c8b7a_proof.jpg' } as unknown as StoredFileReadModel,
        null,
        undefined,
    );
    return priv.url === null && priv.access === 'authorized';
});

// ─── The query contract ───────────────────────────────────────────────────────

const parseLibrary = (query: Record<string, unknown>) => FileLibraryQuerySchema.safeParse(query);

t.assert('`limit` is wi-admin\'s 100, not jovi-mall\'s 50 — L-4', () =>
    parseLibrary({ limit: '100' }).success && !parseLibrary({ limit: '101' }).success);

/**
 * ⚠ jovi-mall's own `ListFilesQuerySchema` caps at 50, and the BR asked which wins. It is
 * this one, because the read no longer passes through that validator at all — nothing on
 * this request reaches jovi-mall. Pinned so the answer stays the documented one.
 */
t.assert('50 is not a ceiling here — the request never reaches jovi-mall\'s validator', () =>
    parseLibrary({ limit: '75' }).success);

t.assert('`entityType` and `entityId` must be sent together, or neither', () =>
    parseLibrary({}).success
    && parseLibrary({ entityType: 'ticket', entityId: 'a'.repeat(24) }).success
    && !parseLibrary({ entityType: 'ticket' }).success
    && !parseLibrary({ entityId: 'a'.repeat(24) }).success);

t.assert('a size range and a date range must not be inverted', () =>
    !parseLibrary({ minSize: '500', maxSize: '100' }).success
    && !parseLibrary({
        createdAfter: '2026-08-11T00:00:00.000Z',
        createdBefore: '2026-08-01T00:00:00.000Z',
    }).success);

/**
 * A date-only value is refused, where jovi-mall coerces it. A bare `2026-08-01` means a
 * different 24 hours in Douala than in Lisbon, so a filter boundary that depends on the
 * server's timezone is one nobody can reproduce — the same rule `isoDateTime` enforces on
 * every other list on this service.
 */
t.assert('a date-only `createdAfter` is refused — a day is not an instant', () =>
    !parseLibrary({ createdAfter: '2026-08-01' }).success);

t.assert('`usage` is a closed set of two', () =>
    parseLibrary({ usage: 'used' }).success
    && parseLibrary({ usage: 'unused' }).success
    && !parseLibrary({ usage: 'orphaned' }).success);

/**
 * The provider filter accepts all SIX values `IFile.provider`'s Mongoose enum permits, not
 * the three jovi-mall implements — refusing `s3` would refuse a value the column is
 * schema-permitted to hold. It answers honestly instead: the page is empty because nothing
 * is stored that way. BR-015's filter table repeats the six as though all were available.
 */
t.assert('the provider filter is the model enum — six values, three real', () =>
    ['local', 's3', 'gcs', 'r2', 'firebase', 'cloudinary']
        .every((provider) => parseLibrary({ provider }).success)
    && !parseLibrary({ provider: 'azure' }).success);

// ─── The filter builder ───────────────────────────────────────────────────────

const libraryQuery = (over: Record<string, unknown> = {}) => {
    const parsed = FileLibraryQuerySchema.safeParse(over);
    if (!parsed.success) throw new Error('fixture query did not parse');
    return parsed.data;
};

t.assert('soft-deleted files are excluded from every library query', () => {
    const filter = buildLibraryFilter(libraryQuery(), null) as Record<string, unknown>;
    return filter.deletedAt === null;
});

/**
 * ⚠ **`usage=used` is NOT the exact complement of `referenceCount > 0`**, and the filter is
 * pinned in the form the model actually supports. `orphanedAt` is `null` both for a
 * referenced file and for one never attached to anything — the field's own docstring says
 * so — so a never-used upload reports `used` here while its row carries a count of `0`. The
 * count is the precise answer; this is the indexed one.
 */
t.assert('`usage` filters on orphanedAt, and `used` means "not orphaned"', () => {
    const used = buildLibraryFilter(libraryQuery({ usage: 'used' }), null) as Record<string, unknown>;
    const unused = buildLibraryFilter(libraryQuery({ usage: 'unused' }), null) as Record<string, unknown>;
    return used.orphanedAt === null
        && JSON.stringify(unused.orphanedAt) === JSON.stringify({ $ne: null });
});

/**
 * ⚠ **An empty entity result must produce an EMPTY PAGE, not the whole library.** `null` is
 * "no entity filter was asked for" and `[]` is "this ticket references nothing"; collapsing
 * the two would answer a question nobody asked with every file on the platform.
 */
t.assert('an entity filter with no matches yields `$in: []`, never no filter', () => {
    const empty = buildLibraryFilter(libraryQuery(), []) as Record<string, unknown>;
    const none = buildLibraryFilter(libraryQuery(), null) as Record<string, unknown>;
    return JSON.stringify(empty._id) === JSON.stringify({ $in: [] }) && !('_id' in none);
});

/**
 * ⚠ **The search term reaches a `$regex`, so it must arrive escaped.** Unescaped, `a.b`
 * matches anything an administrator did not ask for, and `(a+)+$` is catastrophic
 * backtracking served from a search box — injection and denial of service from the same
 * hole. `containsInsensitive` is the only sanctioned builder on this service, and this
 * asserts the OUTPUT rather than scanning for the call, because a scan passes on a call that
 * was later replaced.
 */
t.assert('the search term is regex-escaped before it reaches Mongo', () => {
    const filter = buildLibraryFilter(libraryQuery({ search: 'a.b(c+)+$' }), null) as Record<string, unknown>;
    const pattern = filter.originalName as RegExp;
    return pattern instanceof RegExp
        && pattern.source.includes('a\\.b\\(c\\+\\)\\+\\$')
        && pattern.flags.includes('i');
});

/**
 * `category` expands to jovi-mall's own matcher, mirrored verbatim. The `other` branch is
 * the one worth pinning: it is a NEGATION, and the tempting simplification ("not image,
 * video or audio") silently reclassifies every PDF, spreadsheet and archive as `other`.
 */
t.assert('`category` expands to a mimeType matcher, and `other` stays a negation', () => {
    const image = buildLibraryFilter(libraryQuery({ category: 'image' }), null) as Record<string, unknown>;
    const other = buildLibraryFilter(libraryQuery({ category: 'other' }), null) as Record<string, unknown>;
    return JSON.stringify(image.mimeType).includes('^image/')
        && JSON.stringify(other.mimeType).includes('$not');
});

t.assert('an explicit `mimeType` wins over `category`, as it does in jovi-mall', () => {
    const filter = buildLibraryFilter(
        libraryQuery({ mimeType: 'image/png', category: 'document' }), null,
    ) as Record<string, unknown>;
    return filter.mimeType === 'image/png';
});

/**
 * The picker's one parameter. `?ownerType=admin` is the whole of "only files uploaded by the
 * administration", and it is a filter on data that has always been on the row.
 */
t.assert('`ownerType=admin` is a plain equality — the picker\'s only filter', () => {
    const filter = buildLibraryFilter(libraryQuery({ ownerType: 'admin' }), null) as Record<string, unknown>;
    return filter.ownerType === 'admin';
});

// ─── The upload contract ──────────────────────────────────────────────────────

/**
 * ⚠ **Declared, not discovered** — the BR asked for exactly this. A client that has to learn
 * a ceiling by hitting it shows an operator a failed upload where it could have shown a
 * disabled button.
 */
t.assert('the upload limits are declared, and sized for an administrator', () => {
    const limits = adminUploadLimits();
    return limits.maxBytes === 32 * 1024 * 1024
        && limits.maxFiles === 10
        && limits.fieldName === 'files'
        && limits.acceptedMimeTypes.includes('image/png')
        && limits.acceptedMimeTypes.includes('application/pdf');
});

/**
 * ⚠ jovi-mall's figure for an administrator is **2 GB**, chosen for a surface an
 * administrator can no longer reach at all. It still resolves — `requireAdminCaller`
 * fabricates `role: 'admin'` — so a proxy that declared nothing would inherit it by
 * accident. This service declares its own and refuses before the hop.
 */
t.assert('this service\'s ceiling is its own, not jovi-mall\'s 2 GB role limit', () =>
    adminUploadLimits().maxBytes < 2 * 1024 * 1024 * 1024);

/**
 * The MIME list is PUBLISHED and not policed here — seeing a per-part content type means
 * parsing, and this service never parses a multipart body. Pinned as a closed list anyway,
 * because publishing a type jovi-mall's pipeline then refuses is a refusal a client cannot
 * explain. `video/mp4` is the live example: it is commented OUT of jovi-mall's general
 * upload config.
 */
t.assert('the published MIME list matches jovi-mall\'s general pipeline, video excluded', () =>
    !adminUploadLimits().acceptedMimeTypes.includes('video/mp4')
    && adminUploadLimits().acceptedMimeTypes.length === 8);
}

void (async (): Promise<void> => {
    await runDrivenChecks();
    await runRemainingChecks();
    process.exit(t.finish());
})();
