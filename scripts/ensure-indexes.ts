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
 *
 * Safe to re-run — `syncIndexes()` is idempotent, and it also DROPS indexes the schemas no
 * longer declare, so a renamed index does not linger.
 */
import 'dotenv/config';
import { env } from '../src/config/env';
import { connectAll, closeAll } from '../src/infra/mongo/connections';
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

async function main(): Promise<void> {
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

    for (const target of targets) {
        const dropped = await target.model.syncIndexes();
        const indexes = await target.model.listIndexes();
        process.stdout.write(
            `  ${target.name.padEnd(26)} ${indexes.length} index(es)` +
            (dropped.length > 0 ? `, dropped ${dropped.join(', ')}` : '') +
            '\n',
        );
    }
}

process.stdout.write('\n[indexes] syncing wi-admin indexes\n\n');

main()
    .then(async () => {
        process.stdout.write('\n[indexes] done\n\n');
        await closeAll();
        await closeRedisClients();
        process.exit(0);
    })
    .catch(async (error) => {
        process.stderr.write(`\n[indexes] failed: ${error instanceof Error ? error.message : String(error)}\n\n`);
        await closeAll().catch(() => undefined);
        await closeRedisClients().catch(() => undefined);
        process.exit(1);
    });
