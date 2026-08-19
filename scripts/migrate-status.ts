/**
 * What this service's migration ledger says. Plan step 2.C.5.
 *
 *   npm run migrate:status
 *
 * ── One migration, and no runner ──────────────────────────────────────────────
 * jovi-mall has fifteen migration programs and therefore a runner: a declared order, a
 * spawner, per-script checksums. This service has exactly one migration-shaped script,
 * `ensure:indexes`, which records its own row inline. So the only thing missing was a way
 * to READ the ledger — "was it run here, and from which version of the target list" — which
 * is what this is.
 *
 * If a second migration ever lands here, the honest move is to port jovi-mall's
 * `scripts/migrate.ts` rather than grow this file: the moment there are two, ORDER becomes a
 * fact somebody has to declare, and a status report that cannot express order is misleading.
 *
 * It exits non-zero when anything is not `applied`, so it works as a deploy check.
 */
import 'dotenv/config';
import { env } from '../src/config/env';
import { connectAll, closeAll } from '../src/infra/mongo/connections';
import {
    SchemaMigrationModel,
    MigrationStatus,
    resolveMigrationStatus,
} from '../src/infra/mongo/schema-migration.model';
import { closeRedisClients } from '../src/infra/redis/redis.factory';
import { MIGRATION_NAME, checksumOfThisScript } from './ensure-indexes';

const ENVIRONMENT = process.env.NODE_ENV || 'development';

const LABEL: Record<MigrationStatus, string> = {
    applied: '✔ applied',
    not_applied: '· NOT APPLIED',
    changed: '⚠ applied-but-changed',
    failed: '✖ failed',
};

const CONSEQUENCE =
    'while unapplied: four-eyes is not idempotent (no partial unique on request_key), '
    + 'the audit TTL does not exist, and the notification projector duplicates every sweep';

async function main(): Promise<number> {
    env();
    await connectAll();

    const checksum = checksumOfThisScript();
    const rows = await SchemaMigrationModel()
        .find({ name: MIGRATION_NAME, environment: ENVIRONMENT })
        .select('checksum applied_at outcome applied_by duration_ms note')
        .sort({ applied_at: -1 })
        .lean()
        .exec();

    const status = resolveMigrationStatus(rows, checksum);

    process.stdout.write(`\nLedger: admin_schema_migrations · environment "${ENVIRONMENT}"\n\n`);
    process.stdout.write(`  ${MIGRATION_NAME.padEnd(18)} ${LABEL[status].padEnd(22)} ${checksum.slice(0, 8)}\n`);

    if (rows.length === 0) {
        process.stdout.write(`  ${' '.repeat(18)} ↳ never run in this environment\n`);
        process.stdout.write(`  ${' '.repeat(18)} ↳ ${CONSEQUENCE}\n`);
    } else {
        for (const row of rows.slice(0, 5)) {
            process.stdout.write(
                `  ${' '.repeat(18)} ↳ ${row.applied_at.toISOString()}  ${row.outcome.padEnd(7)}  `
                + `${row.checksum.slice(0, 8)}  by ${row.applied_by} in ${row.duration_ms}ms`
                + (row.note ? `  — ${row.note}` : '') + '\n',
            );
        }
        if (rows.length > 5) {
            process.stdout.write(`  ${' '.repeat(18)} ↳ …and ${rows.length - 5} earlier run(s)\n`);
        }
    }

    if (status === 'changed') {
        process.stdout.write(
            `\n  ⚠ ensure-indexes.ts has been EDITED since it last ran here — most likely a collection\n`
            + `    was added to its target list. The current version has never been applied.\n`
            + `    Run: npm run ensure:indexes\n`,
        );
    }
    if (status === 'failed') {
        process.stdout.write(`\n  ✖ The most recent run FAILED. See the note above.\n`);
    }

    process.stdout.write('\n');
    return status === 'applied' ? 0 : 1;
}

main()
    .then(async (code) => {
        await closeAll();
        await closeRedisClients();
        process.exit(code);
    })
    .catch(async (error) => {
        process.stderr.write(`\n[migrate:status] failed: ${error instanceof Error ? error.message : String(error)}\n\n`);
        await closeAll().catch(() => undefined);
        await closeRedisClients().catch(() => undefined);
        process.exit(1);
    });
