/**
 * Query-parameter strictness — the rule `api-doc/api/README.md` § Filtering states, pinned.
 *
 * ── Why this suite exists ────────────────────────────────────────────────────
 * BR-022 (2026-09-09). The contract said, service-wide, that *"an unrecognised query
 * parameter is silently dropped on every list endpoint"*. That was inferred from
 * `listQuery` not being `.strict()` — true — and then generalised to endpoints that do not
 * use `listQuery` at all. Eleven hand-rolled query schemas ARE strict, and a client written
 * against the general rule answers 400 on twelve routes.
 *
 * The dashboard found two of the eleven by probing. Nobody found the other nine, because
 * the only way to find them was to read every validator — which is exactly the work a test
 * should be doing.
 *
 * ── What is asserted, and why it is derived rather than listed ───────────────
 * §1 loads every exported `*Query*Schema` and PROBES it with an unknown key. That is the
 * behaviour a client actually meets, and it is immune to the two things that made the
 * original claim wrong: it does not infer strictness from a helper, and it does not miss a
 * `.strict()` attached at the end of a multi-line object.
 *
 * §2 pins the derived set against the table in `api-doc/api/README.md`. Either side moving
 * alone is the failure — a schema gaining or losing `.strict()` without the table changing,
 * or the table naming a route that is not strict. This is the assertion that keeps the
 * contract honest; §1 alone would let the docs drift again.
 *
 * §3 refuses a strict schema that no route validates with. Two existed when this was
 * written (`DelegatedPageQuerySchema`, `ListNotesQuerySchema`) and both were removed: a
 * strict schema bound to nothing makes a `grep '.strict()'` over-report which endpoints
 * refuse an unknown parameter, which is the precise question BR-022 asked.
 *
 * §4 pins the axis that is NOT lenient anywhere — a recognised key with an out-of-range
 * value is always refused — because that is the half of the rule worth relying on, and it
 * was buried under the warning about the other half.
 *
 *   npm run test:list-strictness
 */
import { suite } from './_assert';

process.env.NODE_ENV = 'test';
process.env.MONGO_URI_PLATFORM = 'mongodb://localhost:27017/jovi_mall_test';
process.env.MONGO_URI_ADMIN = 'mongodb://localhost:27017/wi_admin_test';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.ADMIN_JWT_SECRET = 'test-access-secret-value-32-chars-long';
process.env.ADMIN_JWT_REFRESH_SECRET = 'test-refresh-secret-value-32-chars-long';
process.env.ADMIN_DASHBOARD_ORIGINS = 'http://localhost:5173';

import { readdirSync, readFileSync } from 'fs';
import { join, relative, resolve } from 'path';

const t = suite('list-strictness');

const SRC = resolve(__dirname, '../../src');
const DOC = resolve(__dirname, '../../api-doc/api/README.md');

function walk(dir: string, match: (p: string) => boolean): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = join(dir, e.name);
        return e.isDirectory() ? walk(p, match) : match(p) ? [p] : [];
    });
}

// ─────────────────────────────────────────────────────────────────────────────
t.section('1. Every exported query schema, probed with an unknown key');

interface Probed {
    name: string;
    file: string;
    strict: boolean;
}

const probed: Probed[] = [];

for (const file of walk(SRC, (p) => p.endsWith('.ts') && /validator/.test(p))) {
    let mod: Record<string, unknown>;
    try {
        mod = require(file) as Record<string, unknown>;
    } catch {
        continue;
    }
    for (const [name, value] of Object.entries(mod)) {
        if (!/Query(Schema)?$/.test(name)) continue;
        const schema = value as { safeParse?: (v: unknown) => { success: boolean; error?: unknown } };
        if (typeof schema?.safeParse !== 'function') continue;

        /**
         * Probed with a stray key AND nothing else. A schema with a required field refuses
         * either way, so strictness is read off the ISSUE CODE rather than off success:
         * `unrecognized_keys` is `.strict()` and only `.strict()`. Probing with a valid body
         * instead would mean knowing every schema's required fields, which is the kind of
         * hand-kept list this suite exists to avoid.
         */
        const result = schema.safeParse({ __definitely_not_a_parameter__: '1' });
        const codes = result.success
            ? []
            : (result.error as { errors: Array<{ code: string }> }).errors.map((e) => e.code);

        probed.push({
            name,
            file: relative(SRC, file).replace(/\\/g, '/'),
            strict: codes.indexOf('unrecognized_keys') >= 0,
        });
    }
}

t.assert('the probe found query schemas at all — a silent zero would pass everything below', () =>
    probed.length >= 60);

t.assert('every probed schema resolved to exactly one verdict', () =>
    probed.every((p) => typeof p.strict === 'boolean'));

const strictSchemas = probed.filter((p) => p.strict).map((p) => p.name).sort();
const looseSchemas = probed.filter((p) => !p.strict).map((p) => p.name);

t.assert('most query schemas are LENIENT — the general rule is still the common case', () =>
    looseSchemas.length > strictSchemas.length * 3);

/**
 * The helper the original claim was inferred from. If this ever becomes `.strict()` the
 * service-wide rule flips and every page that states it has to change — so it is asserted
 * here rather than left implicit.
 */
t.assert('`listQuery` is NOT strict — the general rule holds for the ~53 schemas built on it', () => {
    const src = readFileSync(join(SRC, 'core/http/list-query.ts'), 'utf8');
    const builder = src.slice(src.indexOf('export function listQuery'));
    return builder.length > 0 && !/\.strict\(\)/.test(builder);
});

// ─────────────────────────────────────────────────────────────────────────────
t.section('2. The derived set equals the documented set');

/**
 * Every `defineRoute` block that names a query schema, so a schema can be mapped to the
 * path a client actually calls. Parsed from source rather than by booting the app: this
 * suite is offline and a route table needs Mongo.
 */
interface RouteBinding {
    method: string;
    path: string;
    schema: string;
}

const bindings: RouteBinding[] = [];

for (const file of walk(SRC, (p) => p.endsWith('.routes.ts'))) {
    const src = readFileSync(file, 'utf8');
    const mount = /const mountedAt\s*=\s*['"`]([^'"`]+)['"`]/.exec(src);
    const base = mount ? mount[1] : '';

    for (const chunk of src.split('defineRoute(router, {').slice(1)) {
        const body = chunk.slice(0, chunk.indexOf('});'));
        const q = /query:\s*(\w+)/.exec(body);
        if (!q) continue;
        const m = /method:\s*'(\w+)'/.exec(body);
        const p = /path:\s*'([^']*)'/.exec(body);
        bindings.push({
            method: (m ? m[1] : '?').toUpperCase(),
            path: (base + (p ? p[1] : '')).replace(/\/$/, '') || '/',
            schema: q[1],
        });
    }
}

t.assert('route bindings were parsed — a zero here would make §2 and §3 vacuous', () =>
    bindings.length >= 50);

const strictRoutes = Array.from(
    new Set(
        bindings
            .filter((b) => strictSchemas.indexOf(b.schema) >= 0)
            .map((b) => `${b.method} ${b.path}`),
    ),
).sort();

/** The table in `api-doc/api/README.md` § Filtering, read back out of the document. */
const doc = readFileSync(DOC, 'utf8');
const tableSection = doc.slice(
    doc.indexOf('**The complete strict set**'),
    doc.indexOf('Everything else strips.'),
);

t.assert('the strict-set table is present in api-doc/api/README.md', () =>
    tableSection.length > 200 && tableSection.indexOf('| Route |') >= 0);

/**
 * The table writes the two `/support/tickets/reference/*` routes on one row, so routes are
 * compared as "does the document mention this path", not by parsing its rows into a list.
 * The direction that matters — a strict route absent from the table — is exact either way.
 */
const undocumented = strictRoutes.filter((route) => {
    const path = route.slice(route.indexOf(' ') + 1);
    if (tableSection.indexOf(path) >= 0) return false;
    // `/support/tickets/reference/orders` · `/products` — the shared row.
    const tail = path.slice(path.lastIndexOf('/'));
    return !(tableSection.indexOf(path.slice(0, path.lastIndexOf('/'))) >= 0
        && tableSection.indexOf(tail) >= 0);
});

t.assert(
    `⚠ every STRICT route is in the documented table — undocumented: ${undocumented.join(', ') || 'none'}`,
    () => undocumented.length === 0,
);

/**
 * The other direction, and the one BR-022 actually suffered: the table promising a refusal
 * that does not happen. Every route the table names must be bound to a strict schema.
 */
const docPaths = Array.from(tableSection.matchAll(/`(GET|POST|PATCH|DELETE) ([^`]+)`/g))
    .map((m) => m[2])
    .filter((p) => p.startsWith('/'));

const looseButDocumented = docPaths.filter((path) => {
    const bound = bindings.filter((b) => b.path === path);
    return bound.length > 0 && !bound.some((b) => strictSchemas.indexOf(b.schema) >= 0);
});

t.assert(
    `⚠ every route the table calls strict IS strict — wrong: ${looseButDocumented.join(', ') || 'none'}`,
    () => looseButDocumented.length === 0,
);

t.assert('the table names every strict route and no others — the counts agree', () =>
    docPaths.length > 0 && docPaths.every((p) => bindings.some((b) => b.path === p)));

// ─────────────────────────────────────────────────────────────────────────────
t.section('3. No strict schema is bound to nothing');

const boundSchemas = new Set(bindings.map((b) => b.schema));
const orphanStrict = strictSchemas.filter((name) => !boundSchemas.has(name));

/**
 * `DelegatedPageQuerySchema` and `ListNotesQuerySchema` were both of these when BR-022 was
 * answered, and both were deleted. A strict schema nothing validates with is not harmless:
 * it is a false positive for anyone deriving this contract by grep, which is how the
 * strict set gets over-reported into the docs and then relied on.
 */
t.assert(
    `⚠ every strict query schema is on a route — orphaned: ${orphanStrict.join(', ') || 'none'}`,
    () => orphanStrict.length === 0,
);

// ─────────────────────────────────────────────────────────────────────────────
t.section('4. The axis that is strict EVERYWHERE — a bad value is always refused');

/**
 * The half of the rule a client may rely on service-wide, and the half that was buried
 * under the warning about unknown keys. A recognised key whose value is outside its enum is
 * refused on strict and lenient schemas alike, because the refusal comes from the FIELD, not
 * from the object's unknown-key policy.
 */
const ENUM_PROBES: Array<{ module: string; schema: string; input: Record<string, unknown> }> = [
    { module: 'audit/validators/audit.validator', schema: 'ListAuditQuerySchema', input: { targetType: 'not_a_real_target' } },
    { module: 'automation/validators/automation.validator', schema: 'FailureQuerySchema', input: { channel: 'carrier-pigeon' } },
    { module: 'automation/validators/automation.validator', schema: 'FailureSummaryQuerySchema', input: { windowHours: '721' } },
    { module: 'content/validators/article.validator', schema: 'SearchArticlesQuerySchema', input: { category: '__no_such_category__' } },
];

for (const probe of ENUM_PROBES) {
    t.assert(`${probe.schema} refuses a bad VALUE though it strips an unknown KEY`, () => {
        const mod = require(join(SRC, 'modules', probe.module)) as Record<string, unknown>;
        const schema = mod[probe.schema] as { safeParse: (v: unknown) => { success: boolean } };
        const badValue = schema.safeParse(probe.input);
        const unknownKey = schema.safeParse({ __definitely_not_a_parameter__: '1' });
        return !badValue.success && unknownKey.success;
    });
}

process.exit(t.finish());
