/**
 * Export the audit trail to a file, and — with `--purge` — delete what has aged out.
 *
 * ── The retention rule this enforces ──────────────────────────────────────────
 * A row leaves the database ONLY when both hold: it has been exported to a durable file,
 * AND it is at least `ADMIN_AUDIT_RETENTION_DAYS` old. Exporting a row early does not
 * shorten its life — it still waits out the remainder, and the TTL index removes it then.
 *
 * ── Why a CLI as well as `POST /api/v1/audit/exports` ────────────────────────
 * They share one implementation (`audit-export.service.ts`); what differs is the bound.
 * The API refuses above `ADMIN_AUDIT_EXPORT_API_MAX_ROWS` because serialising for minutes
 * inside a request is the shape ADR-005 D-10 forbids, and it never purges — deletion one
 * misclick away from irreversible does not belong on a dashboard. This has no cap and is
 * the only place `--purge` exists. Run it from cron.
 *
 *   npm run audit:export -- --from 2026-01-01T00:00:00Z --to 2026-04-01T00:00:00Z
 *   npm run audit:export -- --purge                       # everything, then purge the aged
 *   npm run audit:export -- --restamp                     # after changing the retention days
 *   npm run audit:export -- --dry-run                     # what would be exported, and nothing else
 *
 * Safe to re-run: every step is a `$set` of a computed value or a filtered `deleteMany`.
 */
import 'dotenv/config';
import { randomUUID } from 'crypto';
import { env } from '../src/config/env';
import { connectAll, closeAll } from '../src/infra/mongo/connections';
import { closeRedisClients } from '../src/infra/redis/redis.factory';
import { AuditLogModel } from '../src/modules/audit/models/audit-log.model';
import { runExport, restampRetention } from '../src/modules/audit/domain/audit-export.service';
import { systemActor, systemContext } from '../src/modules/audit/domain/audit-context';

interface Args {
    from?: Date;
    to?: Date;
    purge: boolean;
    restamp: boolean;
    dryRun: boolean;
}

function usage(problem?: string): never {
    if (problem) process.stderr.write(`\n[audit-export] ${problem}\n`);
    process.stderr.write(
        '\nUsage: npm run audit:export -- [--from ISO] [--to ISO] [--purge] [--restamp] [--dry-run]\n\n'
        + '  --from ISO   start of the half-open range [from, to). Omit for "from the beginning".\n'
        + '  --to ISO     end, exclusive. Omit for "up to now".\n'
        + '  --purge      after the file is durable, delete the exported rows that have\n'
        + '               passed the retention floor. Rows younger than it are kept and\n'
        + '               expire on their own.\n'
        + '  --restamp    recompute purge dates for ALREADY-exported rows using the current\n'
        + '               ADMIN_AUDIT_RETENTION_DAYS. Run this after changing that value —\n'
        + '               without it, existing rows keep the schedule they were stamped with.\n'
        + '  --dry-run    report what would be exported; write nothing.\n\n',
    );
    process.exit(problem ? 1 : 0);
}

function parseArgs(argv: string[]): Args {
    const args: Args = { purge: false, restamp: false, dryRun: false };

    for (let i = 0; i < argv.length; i++) {
        const flag = argv[i];
        switch (flag) {
            case '--from':
            case '--to': {
                const raw = argv[++i];
                if (!raw) usage(`${flag} needs an ISO-8601 instant`);
                const parsed = new Date(raw);
                if (Number.isNaN(parsed.getTime())) usage(`${flag}: "${raw}" is not a valid instant`);
                if (flag === '--from') args.from = parsed;
                else args.to = parsed;
                break;
            }
            case '--purge': args.purge = true; break;
            case '--restamp': args.restamp = true; break;
            case '--dry-run': args.dryRun = true; break;
            case '--help':
            case '-h': usage();
                break;
            default: usage(`unknown argument "${flag}"`);
        }
    }

    if (args.from && args.to && args.to.getTime() <= args.from.getTime()) {
        usage('--to must be after --from; the range is half-open, [from, to)');
    }

    return args;
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const config = env();
    await connectAll();

    if (args.restamp) {
        const restamped = await restampRetention(config.ADMIN_AUDIT_RETENTION_DAYS);
        process.stdout.write(
            `  restamped ${restamped} exported row(s) to ${config.ADMIN_AUDIT_RETENTION_DAYS}-day retention\n`,
        );
        if (!args.from && !args.to && !args.purge) return;
    }

    const filter: Record<string, unknown> = {};
    if (args.from || args.to) {
        const range: Record<string, Date> = {};
        if (args.from) range.$gte = args.from;
        if (args.to) range.$lt = args.to;
        filter.occurred_at = range;
    }

    const matching = await AuditLogModel().countDocuments(filter);

    if (args.dryRun) {
        const purgeable = await AuditLogModel().countDocuments({
            ...filter,
            export_id: { $type: 'objectId' },
            purge_after: { $lte: new Date() },
        });
        process.stdout.write(
            `  DRY RUN — ${matching} row(s) would be exported\n`
            + `            ${purgeable} already-exported row(s) are past retention and would be deleted with --purge\n`
            + '            nothing was written\n',
        );
        return;
    }

    if (matching === 0) {
        process.stdout.write('  nothing to export in that range\n');
        return;
    }

    /**
     * The CLI's actor is `system`, not a fabricated administrator.
     *
     * Nobody authenticates to run this — it is an operator on a shell — so naming a person
     * would be the kind of lie the trail exists to prevent. `systemActor` labels it, and
     * the correlation id is shared with the manifest so the row and the file join.
     */
    const correlationId = randomUUID();

    const result = await runExport({
        from: args.from ?? null,
        to: args.to ?? null,
        source: 'cli',
        requestedBy: null,
        correlationId,
        purge: args.purge,
        actor: systemActor('audit export CLI'),
        context: systemContext('scripts/audit-export.ts', correlationId),
    });

    process.stdout.write(
        `\n  file      ${result.manifest.file_name}\n`
        + `  rows      ${result.rowCount}\n`
        + `  bytes     ${result.manifest.byte_size}\n`
        + `  sha256    ${result.manifest.sha256}\n`
        + `  stamped   ${result.stampedCount} row(s) marked exported\n`
        + `  purged    ${result.purgedCount} row(s) deleted`
        + (args.purge ? '' : ' (pass --purge to delete aged rows)')
        + '\n',
    );
}

process.stdout.write('\n[audit-export] starting\n\n');

main()
    .then(async () => {
        process.stdout.write('\n[audit-export] done\n\n');
        await closeAll();
        await closeRedisClients();
        process.exit(0);
    })
    .catch(async (error) => {
        process.stderr.write(`\n[audit-export] failed: ${error instanceof Error ? error.message : String(error)}\n\n`);
        await closeAll().catch(() => undefined);
        await closeRedisClients().catch(() => undefined);
        process.exit(1);
    });
