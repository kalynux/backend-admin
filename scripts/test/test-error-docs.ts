/**
 * Test: `api-doc/api/errors.md` against the live `ERROR_CODES` registry.
 *
 * ── Why this exists, and why the gap was real ─────────────────────────────────
 * `errors.md` opens with *"Every code the service can return"*, and nothing on this side
 * checked it. Three codes went missing from it silently (the `AUTOMATION_*` family, ADR-022)
 * and three codes that no registry defines went INTO it. Both classes are the same failure:
 * a client branches on a string the backend never sends, or fails to handle one it does.
 *
 * The only guard that existed lived in the DASHBOARD repository — `error-catalog.test.ts`
 * parses this page and diffs it against the frontend's translation map — so wi-admin learnt
 * about its own registry drifting only when a frontend suite went red. That is the wrong end:
 * the page and the registry are both in this repository, and the diff belongs here too.
 *
 * ── What it asserts, and what it deliberately does not ────────────────────────
 * It is a SOURCE SCAN, not a behaviour test. It reads the markdown and the registry and
 * compares three things:
 *
 *   1. every declared code appears in the page          — no silent omission
 *   2. every code the page names is declared            — no phantom code
 *   3. every documented status is one the code is
 *      actually raised at, or is a boot-time-only code  — no wrong status column
 *
 * It does NOT check the Meaning column, the category column against `categoryFor()`, or
 * whether a code is reachable — `DOC-PROGRAM/tools/doc-error-reachability.js` covers the
 * last, and the first two are prose a scan cannot judge.
 *
 * ⚠ **Codes documented as arriving from jovi-mall are still OUR codes here.** Several rows
 * describe a value that reaches a client as `details.platformCode` rather than as
 * `error.code`; they are in `ERROR_CODES` because the registry is also the source of the
 * default-message table, so rule 2 covers them like any other. What the page must NOT name
 * is a code no registry anywhere defines.
 *
 * Run: npm run test:error-docs
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { suite } from './_assert';
import { ERROR_CODES } from '../../src/core/errors/error-codes';

const ERRORS_MD = join(__dirname, '..', '..', 'api-doc', 'api', 'errors.md');
const SRC = join(__dirname, '..', '..', 'src');

const page = readFileSync(ERRORS_MD, 'utf8');
const declared = new Set<string>(Object.keys(ERROR_CODES));

/**
 * jovi-mall's registry, read as text rather than imported.
 *
 * A sibling repository is not on this one's module path, and importing across the two would
 * make this suite depend on that build compiling. The page documents jovi-mall codes on
 * purpose — several rows describe a value that reaches a client as `details.platformCode`
 * rather than as `error.code` — so rule 2 has to accept them, or it reports the page for
 * doing exactly what it is for.
 *
 * Absent (a checkout of this repository alone) the set is empty and rule 2 narrows to
 * wi-admin's own codes, which is the weaker but still useful check.
 */
function platformCodes(): Set<string> {
    const file = join(__dirname, '..', '..', '..', 'jovi-mall', 'src', 'core', 'error-codes.ts');
    try {
        const text = readFileSync(file, 'utf8');
        return new Set([...text.matchAll(/^\s+([A-Z0-9_]+):\s*'/gm)].map((m) => m[1]));
    } catch {
        return new Set<string>();
    }
}

const platform = platformCodes();

/**
 * A registry row, as the page writes one:
 *
 *     | `CODE` | 409 | `conflict` | Meaning… |
 *
 * Anchored to the start of a table row so a code merely MENTIONED in prose is not read as a
 * registry entry — the page names several deliberately to say they do not exist, and a
 * scanner that could not tell the difference would report the record of an earlier fix as a
 * defect. That is the same trap `doc-error-codes.js` documents at length.
 */
const ROW = /^\|\s*`([A-Z][A-Z0-9_]+)`\s*\|\s*([0-9]{3})\s*\|/;

interface DocRow { code: string; status: number; line: number }

function documentedRows(): DocRow[] {
    const rows: DocRow[] = [];
    const lines = page.split(/\r?\n/);
    lines.forEach((line, index) => {
        const match = ROW.exec(line);
        if (match) rows.push({ code: match[1], status: Number(match[2]), line: index + 1 });
    });
    return rows;
}

const rows = documentedRows();
const documented = new Set(rows.map((row) => row.code));

/**
 * Every status a code is raised at anywhere in `src/`.
 *
 * Read from the call sites rather than from a table, because there is no table: the same
 * code is deliberately raised at different statuses at different sites, which is exactly
 * why `categoryFor()` takes both. A code with no call site is boot-time-only or arrives as
 * a `platformCode`, and rule 3 skips it rather than guessing.
 */
function raisedStatuses(): Map<string, Set<number>> {
    const found = new Map<string, Set<number>>();
    const stack = [SRC];
    const files: string[] = [];
    while (stack.length) {
        const dir = stack.pop() as string;
        for (const entry of require('fs').readdirSync(dir, { withFileTypes: true })) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) stack.push(full);
            else if (entry.name.endsWith('.ts')) files.push(full);
        }
    }
    for (const file of files) {
        const text = readFileSync(file, 'utf8');
        for (const match of text.matchAll(/ERROR_CODES\.([A-Z0-9_]+),\s*\n?\s*([0-9]{3})/g)) {
            const set = found.get(match[1]) ?? new Set<number>();
            set.add(Number(match[2]));
            found.set(match[1], set);
        }
    }
    return found;
}

const raised = raisedStatuses();

const t = suite('error documentation');

t.section('1 · the page is complete');

/**
 * Completeness is checked against a BACKTICKED MENTION anywhere on the page, not against a
 * table row.
 *
 * Three codes are documented outside the row shape on purpose and would otherwise report as
 * missing: `PLATFORM_OPERATION_REJECTED` and `SERVICE_DEPENDENCY_UNAVAILABLE` carry a prose status
 * (jovi-mall's original 4xx; 502 / 503), and `AUTOMATION_REPORT_MALFORMED` carries an em dash
 * because nothing raises it. Requiring a numeric status column would push the page toward
 * inventing one for each, which is worse than the looser check.
 */
const mentioned = new Set([...page.matchAll(/`([A-Z][A-Z0-9_]+)`/g)].map((m) => m[1]));
const undocumented = [...declared].filter((code) => !mentioned.has(code)).sort();
t.assert(
    `every one of the ${declared.size} declared codes is named in errors.md`
    + (undocumented.length ? ` — missing: ${undocumented.join(', ')}` : ''),
    () => undocumented.length === 0,
);

t.section('2 · the page invents nothing');

const phantom = [...documented].filter((code) => !declared.has(code) && !platform.has(code)).sort();
t.assert(
    `every code in a registry row is declared by wi-admin or by jovi-mall (${platform.size} platform codes loaded)`
    + (phantom.length ? ` — phantom: ${phantom.join(', ')}` : ''),
    () => phantom.length === 0,
);

t.section('3 · the status column matches a real throw site');

const wrongStatus = rows
    .filter((row) => declared.has(row.code))
    .filter((row) => {
        const statuses = raised.get(row.code);
        // No call site: boot-time-only, or a value that arrives as `details.platformCode`.
        // Rule 1 already asserts it is documented; there is no status here to disagree with.
        if (!statuses || statuses.size === 0) return false;
        return !statuses.has(row.status);
    })
    .map((row) => `${row.code} documented ${row.status}, raised ${[...(raised.get(row.code) as Set<number>)].join('/')} (errors.md:${row.line})`);

t.assert(
    'no documented status contradicts every throw site for that code'
    + (wrongStatus.length ? ` — ${wrongStatus.join(' · ')}` : ''),
    () => wrongStatus.length === 0,
);

t.section('4 · the scan itself is not vacuous');

t.assert('the page yielded registry rows to check', () => rows.length > 50);
t.assert('the registry was loaded', () => declared.size > 50);
t.assert('at least one throw site was found per scan', () => raised.size > 20);
t.assert("jovi-mall's registry was reachable — rule 2 is at full strength", () => platform.size > 100);

process.exit(t.finish());
