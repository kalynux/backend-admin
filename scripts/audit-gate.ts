/**
 * The CI dependency gate: `npm audit --omit=dev`, with a named and EXPIRING allowlist.
 *
 *   npm run audit:gate
 *
 * The gate stays as hard as the bare `npm audit --omit=dev` it replaces — any advisory, at
 * any severity, fails the build — with one difference: an advisory that cannot be fixed
 * without a major upgrade can be accepted HERE, by id, with the reason and the mitigation
 * written beside it. `npm audit` has no ignore option, which is why this file exists at all.
 *
 * ⚠ Every entry carries an `expires` date and fails the build once it passes. An allowlist
 * without one is how "temporary" becomes permanent; the date forces the question to be asked
 * again rather than letting the exception age silently.
 *
 * An entry whose advisory no longer appears is reported as stale, so it gets deleted with
 * the upgrade that fixed it.
 */
import { spawnSync } from 'child_process';

interface AcceptedAdvisory {
    id: string;
    pkg: string;
    reason: string;
    /** YYYY-MM-DD — the gate fails from this day on. */
    expires: string;
}

const ACCEPTED: AcceptedAdvisory[] = [
    {
        id: 'GHSA-mrhx-c7xc-m3w5',
        pkg: 'zod',
        reason:
            'Fixed only in zod 4.6.6; this service is on zod 3 and the move is a major upgrade. '
            + 'Mitigated by MAX_BODY_ARRAY_LENGTH in src/core/validation/validate.ts, which refuses '
            + 'an oversized array before Zod runs (a schema .max() does not help on zod 3). '
            + 'Delete this entry and that guard together when the service moves to zod 4.',
        expires: '2026-12-31',
    },
];

interface AuditAdvisory {
    name: string;
    title: string;
    url: string;
    severity: string;
}

interface AuditReport {
    vulnerabilities?: Record<string, { via: (AuditAdvisory | string)[] }>;
}

const advisoryId = (url: string): string => url.split('/').pop() ?? url;

const run = spawnSync('npm', ['audit', '--omit=dev', '--json'], { encoding: 'utf8', shell: true });
let report: AuditReport;
try {
    report = JSON.parse(run.stdout) as AuditReport;
} catch {
    console.error('npm audit did not return JSON — failing closed.\n', run.stdout, run.stderr);
    process.exit(1);
}

// Root advisories only: a `via` that is a string names another vulnerable package, whose own
// entry carries the advisory object.
const found = new Map<string, AuditAdvisory>();
for (const entry of Object.values(report.vulnerabilities ?? {})) {
    for (const via of entry.via) {
        if (typeof via === 'object') found.set(advisoryId(via.url), via);
    }
}

const today = new Date().toISOString().slice(0, 10);
let failed = false;

for (const [id, advisory] of found) {
    const accepted = ACCEPTED.find((entry) => entry.id === id);
    if (!accepted) {
        console.error(`✗ ${advisory.severity.padEnd(8)} ${advisory.name} — ${advisory.title} (${advisory.url})`);
        failed = true;
    } else if (today >= accepted.expires) {
        console.error(`✗ EXPIRED  ${advisory.name} ${id} — accepted until ${accepted.expires}. Fix it or re-decide.`);
        failed = true;
    } else {
        console.log(`~ accepted ${advisory.name} ${id} until ${accepted.expires} — ${accepted.reason}`);
    }
}

for (const entry of ACCEPTED) {
    if (!found.has(entry.id)) console.log(`! stale    ${entry.pkg} ${entry.id} — no longer reported; delete the entry.`);
}

console.log(failed ? '\nDependency gate FAILED.' : `\nDependency gate passed (${found.size} advisory/ies, all accepted).`);
process.exit(failed ? 1 : 0);
