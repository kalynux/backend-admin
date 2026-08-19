/**
 * Build the indexes the `wi-admin` collections declare.
 *
 * Mongoose auto-builds indexes only when `autoIndex` is on, which
 * `infra/mongo/connections.ts` disables in production — correct, because an index build
 * triggered by a deploy is an unannounced load spike. So production needs this run
 * deliberately, as a migration step.
 *
 * It matters more than usual for two collections.
 *
 * `admin_approval_requests`: its partial unique index on `request_key` is what makes
 * four-eyes idempotent. Without it, a double-clicked button queues two approvals for one
 * intent and approving both performs the action twice.
 *
 * `admin_audit_log`: its TTL index is the ONLY thing that removes exported rows once they
 * pass the retention floor. If this is never run in production the index silently does
 * not exist, and the collection grows without bound while the compliance story says it
 * does not — a failure that is invisible until storage runs out. (It fails safe rather
 * than dangerously: no index means nothing is deleted, never the reverse.)
 *
 *   npm run ensure:indexes
 *   npm run migrate:status      ← what this ledger says about the run above
 *
 * Safe to re-run — `syncIndexes()` is idempotent, and it also DROPS indexes the schemas no
 * longer declare, so a renamed index does not linger.
 *
 * ── It now LEDGERS itself (plan step 2.C.5) ───────────────────────────────────
 * Everything above was already true and already written down, and none of it made "was this
 * run on this deployment" answerable. Each run writes one row to `admin_schema_migrations`
 * carrying the sha256 of THIS FILE — so adding a collection to `targets` below and not
 * re-running reports as `applied-but-changed` rather than hiding inside `applied`. That is
 * the failure mode this service is most exposed to: the list grows every phase.
 *
 * A failed run is recorded too, before the connections close. A ledger that only remembers
 * successes answers the easy question.
 */
import 'dotenv/config';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { hostname, userInfo } from 'os';
import { env } from '../src/config/env';
import { connectAll, closeAll } from '../src/infra/mongo/connections';
import { SchemaMigrationModel } from '../src/infra/mongo/schema-migration.model';
import { closeRedisClients } from '../src/infra/redis/redis.factory';
import { AdminAccountModel } from '../src/modules/admin-identity/models/admin-account.model';
import { AdminSessionModel } from '../src/modules/admin-identity/models/admin-session.model';
import { ApprovalRequestModel } from '../src/modules/dual-control/models/approval-request.model';
import { AuditLogModel } from '../src/modules/audit/models/audit-log.model';
import { AuditExportModel } from '../src/modules/audit/models/audit-export.model';
import { FeatureFlagModel } from '../src/modules/dev-tools/models/feature-flag.model';
import { AdminNotificationModel } from '../src/modules/notifications/models/admin-notification.model';
import { NotificationPreferenceModel } from '../src/modules/notifications/models/notification-preference.model';
import { NotificationWatermarkModel } from '../src/modules/notifications/models/notification-watermark.model';

export const MIGRATION_NAME = 'ensure:indexes';

/**
 * sha256 of this file, with line endings normalised.
 *
 * The normalisation is not cosmetic: this repository is developed on Windows and deployed
 * on Linux, and a checkout under `core.autocrlf=true` would otherwise produce a different
 * digest for a byte-identical script — reporting it as `changed` on its first run in a
 * container. `scripts/migrate-status.ts` computes the same digest the same way.
 */
export function checksumOfThisScript(): string {
    // `__filename` is the .ts path: `tsc` does not compile `scripts/`, so this always runs
    // through ts-node.
    const source = readFileSync(__filename, 'utf-8').replace(/\r\n/g, '\n');
    return createHash('sha256').update(source).digest('hex');
}

/**
 * Write one ledger row. Never throws — a ledger write that takes the run down would turn a
 * successful index sync into a failed deploy, which inverts what this is for.
 */
async function ledger(outcome: 'success' | 'failed', durationMs: number, note: string): Promise<void> {
    try {
        await SchemaMigrationModel().create({
            name: MIGRATION_NAME,
            checksum: checksumOfThisScript(),
            environment: process.env.NODE_ENV || 'development',
            applied_at: new Date(),
            applied_by: `${userInfo().username}@${hostname()}`,
            duration_ms: durationMs,
            outcome,
            note,
        });
        process.stdout.write(`[indexes] ledgered: ${outcome}\n`);
    } catch (error) {
        process.stderr.write(
            `[indexes] LEDGER WRITE FAILED (the index sync itself ${outcome === 'success' ? 'succeeded' : 'failed'}): ` +
            `${error instanceof Error ? error.message : String(error)}\n`,
        );
    }
}

/** Returns the one-line summary that goes into the ledger's `note`. */
async function main(): Promise<string> {
    env();
    await connectAll();

    const targets = [
        { name: 'admin_accounts', model: AdminAccountModel() },
        { name: 'admin_sessions', model: AdminSessionModel() },
        { name: 'admin_approval_requests', model: ApprovalRequestModel() },
        { name: 'admin_audit_log', model: AuditLogModel() },
        { name: 'admin_audit_exports', model: AuditExportModel() },
        // Phase 12. Small, but its unique index on `name` is what makes `setFlag`'s upsert
        // atomic — without it two concurrent flips create two rows and the reader picks one.
        { name: 'admin_feature_flags', model: FeatureFlagModel() },
        // Phase 13. The unique `{ source_key, admin_id }` on `admin_notifications` is not a
        // nicety: it is the projector's entire exactly-once guarantee, so a deploy that skips
        // this script turns every sweep into a duplicate generator.
        { name: 'admin_notifications', model: AdminNotificationModel() },
        { name: 'admin_notification_preferences', model: NotificationPreferenceModel() },
        { name: 'admin_notification_watermarks', model: NotificationWatermarkModel() },
    ];

    // The ledger's own index, built here rather than through `targets` above: it has to
    // exist before the run that would create it has finished, and it is the one index whose
    // absence makes the ledger itself unreadable rather than a collection unhealthy.
    await SchemaMigrationModel().createIndexes();

    let synced = 0;
    for (const target of targets) {
        const dropped = await target.model.syncIndexes();
        const indexes = await target.model.listIndexes();
        synced += indexes.length;
        process.stdout.write(
            `  ${target.name.padEnd(26)} ${indexes.length} index(es)` +
            (dropped.length > 0 ? `, dropped ${dropped.join(', ')}` : '') +
            '\n',
        );
    }

    return `${targets.length} collection(s), ${synced} index(es) in place`;
}

/**
 * Run only when INVOKED, never when imported.
 *
 * `scripts/migrate-status.ts` imports `MIGRATION_NAME` and `checksumOfThisScript` from here
 * so the ledger's identity and its digest are defined once, beside the thing they identify.
 * Without this guard that import would SYNC EVERY INDEX as a side effect of asking whether
 * they had been synced — the read would perform the write it exists to report on.
 */
if (require.main === module) {
    process.stdout.write('\n[indexes] syncing wi-admin indexes\n\n');

    const started = Date.now();

    main()
        .then(async (summary) => {
            // Ledger BEFORE closing the connections — there is no writing anything afterwards.
            await ledger('success', Date.now() - started, summary);
            process.stdout.write('\n[indexes] done\n\n');
            await closeAll();
            await closeRedisClients();
            process.exit(0);
        })
        .catch(async (error) => {
            const message = error instanceof Error ? error.message : String(error);
            process.stderr.write(`\n[indexes] failed: ${message}\n\n`);
            // Best-effort: `connectAll()` may be what failed, in which case there is nothing
            // to write to and `ledger()` says so rather than throwing over the real error.
            await ledger('failed', Date.now() - started, message);
            await closeAll().catch(() => undefined);
            await closeRedisClients().catch(() => undefined);
            process.exit(1);
        });
}
