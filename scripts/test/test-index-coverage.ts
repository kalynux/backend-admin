/**
 * Every model wi-admin declares must be in `scripts/ensure-indexes.ts`.
 *
 * ── Why this exists ───────────────────────────────────────────────────────────
 * `ensure-indexes.ts` enumerates its collections by a HAND-WRITTEN import list. That list
 * is the only thing that decides which indexes exist in production, because
 * `infra/mongo/connections.ts` turns `autoIndex` off there — so a model missing from it has
 * its indexes built in development, where `autoIndex` is on, and nowhere else.
 *
 * The script's own header names this as the danger — *"the failure mode this service is most
 * exposed to: the list grows every phase"* — and on 2026-09-13 it was found to have already
 * happened. `AutomationFailureModel` (ADR-022) landed on 2026-09-07 and was never added, so
 * for six days its six indexes did not exist in production, including:
 *
 *   { workflow_id, execution_id, kind } UNIQUE (partial)   the failure board's dedup
 *   { purge_after } TTL                                    the purge
 *
 * The second is the one that bites quietly. With no TTL the collection grows without bound
 * on an 8 GB host — the identical unbounded-growth failure `admin_audit_log`'s TTL is called
 * out for in that same header, arriving through the door the list leaves open.
 *
 * ── Why a source scan rather than a behaviour test ────────────────────────────
 * The defect is an ABSENCE, and an absence has no behaviour to test: the script runs
 * perfectly, reports success, and syncs every collection it was told about. Nothing at
 * runtime can distinguish "there are nine collections" from "there are ten and one was
 * forgotten". Only the source can, which puts this in the same family as jovi-mall's
 * `test:env` and this repo's `test:authz` and `test:devtools`.
 *
 * ── What it deliberately does NOT check ───────────────────────────────────────
 * It does not check that the `name` in each target matches the model's real collection
 * name; that value is used for a log line only, so a wrong one is cosmetic. It checks the
 * one thing whose absence is silent and permanent.
 *
 * Run:  npm run test:index-coverage
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';
import { suite } from './_assert';

const ROOT = join(__dirname, '..', '..');
const SRC = join(ROOT, 'src');
const ENSURE = join(ROOT, 'scripts', 'ensure-indexes.ts');

const t = suite('index coverage — every model reaches ensure:indexes');

/**
 * Models that deliberately have no entry in `targets`, each with the reason.
 *
 * `schema-migration.model` is the ledger's own, and `ensure-indexes.ts` builds it by hand
 * with `SchemaMigrationModel().createIndexes()` BEFORE the loop — it has to exist before the
 * run that would otherwise create it has finished. Covered, just not through `targets`.
 */
const DELIBERATELY_ABSENT = new Map<string, string>([
    ['schema-migration.model.ts', 'built directly before the loop — the ledger must be writable first'],
]);

function everyModelFile(dir: string, found: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) everyModelFile(full, found);
        else if (entry.endsWith('.model.ts')) found.push(full);
    }
    return found;
}

const ensureSource = readFileSync(ENSURE, 'utf-8');
const modelFiles = everyModelFile(SRC).sort();

t.section(`${modelFiles.length} model file(s) under src/`);

// A model is "reached" when ensure-indexes.ts imports it BY PATH. Matching on the import
// path rather than the exported symbol is deliberate: a symbol can appear in a comment, and
// this check must not be satisfiable by prose.
for (const file of modelFiles) {
    const base = file.split(sep).pop()!;
    const importPath = relative(join(ROOT, 'scripts'), file).split(sep).join('/').replace(/\.ts$/, '');
    const reason = DELIBERATELY_ABSENT.get(base);

    t.assert(
        `${base}${reason ? '  (exempt)' : ''}`,
        () => (reason !== undefined) || ensureSource.includes(importPath),
    );
}

// The exemption list must not rot either: an entry naming a file that no longer exists is a
// hole somebody could walk a real model through.
t.section('the exemption list is honest');
for (const [base, reason] of DELIBERATELY_ABSENT) {
    t.assert(`${base} still exists — ${reason}`, () =>
        modelFiles.some((file) => file.endsWith(sep + base)));
}

// The regression itself, pinned by name. The general scan above would catch it, but this
// says out loud which absence was real, so a future reader knows the check was not
// theoretical.
t.section('the 2026-09-13 regression stays closed');
t.assert('automation-failure.model is imported by ensure-indexes.ts', () =>
    ensureSource.includes('automation/models/automation-failure.model'));
t.assert('…and appears in the targets list, not only as an import', () =>
    /\{\s*name:\s*'admin_automation_failures',\s*model:\s*AutomationFailureModel\(\)\s*\}/.test(ensureSource));

process.exit(t.finish());
