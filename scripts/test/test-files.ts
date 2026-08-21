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
 *
 * Mutation-tested. Each of these four edits must turn this suite red:
 *   - add `key: row.key` to `toOrphanFile`                                  → §2
 *   - change the controller's guard to `confirmFileId === fileId`           → §3
 *   - move the `/orphans` route below `/:fileId` in `file.routes.ts`        → §4
 *   - drop `destructive: true` from `files.delete` in the catalog           → §5
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

import { FileController } from '../../src/modules/files/controllers/file.controller';
import {
    OrphanFile,
    PlatformOrphanFile,
    toOrphanFile,
} from '../../src/modules/files/gateways/file.gateway';
import {
    HardDeleteFileBodySchema,
    OrphansQuerySchema,
    ResolveFilesQuerySchema,
} from '../../src/modules/files/validators/file.validator';
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

t.assert('the scan finds all four routes — it is looking at something', () =>
    DECLARED.length === 4);

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

t.assert('each route declares the permission Part B assigned it', () =>
    /path: '\/orphans'[\s\S]{0,200}?permission\('files\.orphans\.read'\)/.test(ROUTES_CODE)
    && /path: '\/:fileId\/permanent'[\s\S]{0,200}?permission\('files\.delete'\)/.test(ROUTES_CODE));

t.assert('the delete validates BOTH the path id and the confirmation body', () =>
    /path: '\/:fileId\/permanent'[\s\S]{0,300}?params: FileIdParamSchema[\s\S]{0,80}?body: HardDeleteFileBodySchema/
        .test(ROUTES_CODE));

t.assert('the delete is the only audited route on the mount', () =>
    (ROUTES_CODE.match(/audit: /g) ?? []).length === 1
    && /path: '\/:fileId\/permanent'[\s\S]{0,300}?audit: records\('files\.delete'\)/.test(ROUTES_CODE));

t.assert('no route on this mount is registered directly on the router', () =>
    !/\brouter\s*\.\s*(get|post|put|patch|delete|all|use)\s*\(/.test(ROUTES_CODE));

// ─────────────────────────────────────────────────────────────────────────────
t.section('5. The tier split, and the mechanism behind it');

const has = (tier: 1 | 2 | 3, name: string): boolean =>
    (TIER_GRANTS[tier] as readonly string[]).includes(name);

t.assert('`files.resolve` is held by every tier — it resolves an id the caller has', () =>
    has(1, 'files.resolve') && has(2, 'files.resolve') && has(3, 'files.resolve'));

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

/** Both reads on this mount stay unaudited — ADR-006 D-5. */
t.assert('there is no catalogued action for either read', () =>
    (Object.keys(AUDIT_CATALOG) as string[]).filter((a) => a.startsWith('files.')).length === 1);

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

}

void (async (): Promise<void> => {
    await runDrivenChecks();
    await runRemainingChecks();
    process.exit(t.finish());
})();
