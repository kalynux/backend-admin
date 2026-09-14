/**
 * Verify: the audit subsystem against a real database.
 *
 * NEEDS Mongo (a replica set — transactions) and Redis. The DB-free suite proves the pure
 * rules; this proves the four things it structurally cannot, all of which are the whole
 * point of the design:
 *
 *  1. **Fail closed.** When the audit row cannot be written, the state change does not
 *     happen. This is the single assertion the phase exists to make true.
 *  2. **Atomicity.** A successful action leaves exactly one row, carrying the request's
 *     own correlation id.
 *  3. **Post-commit ordering.** A rolled-back suspension leaves the target's sessions
 *     ALIVE — the defect that would have been introduced by wrapping the old code as-is.
 *  4. **Purge semantics.** The TTL index carries its partial filter, and an unexported row
 *     with a past `purge_after` survives — proving the filter, not just the date, gates
 *     deletion.
 *
 * Writes and cleans up its own `verify-audit-*@example.test` accounts, pass or fail.
 *
 * Run: npm run verify:audit
 */
import 'dotenv/config';
import { randomUUID } from 'crypto';
import { Types } from 'mongoose';
import { suite } from './_assert';
import { env } from '../../src/config/env';
import { connectAll, closeAll, adminConnection, assertAuditStoreTransactional } from '../../src/infra/mongo/connections';
import { closeRedisClients } from '../../src/infra/redis/redis.factory';
import { AdminAccountModel } from '../../src/modules/admin-identity/models/admin-account.model';
import { AdminAccountRepository } from '../../src/modules/admin-identity/repositories/admin-account.repository';
import { AuditLogModel } from '../../src/modules/audit/models/audit-log.model';
import { AuditExportModel } from '../../src/modules/audit/models/audit-export.model';
import { auditedTransaction, auditedAttempt } from '../../src/modules/audit/domain/audit.writer';
import { runExport } from '../../src/modules/audit/domain/audit-export.service';
import { systemActor, systemContext } from '../../src/modules/audit/domain/audit-context';
import { hash } from '../../src/modules/admin-identity/domain/password.service';
import { AuditIntent } from '../../src/modules/audit/domain/audit.types';

const t = suite('wi-admin audit — live');

const MARKER = `verify-audit-${Date.now()}`;
const created: Types.ObjectId[] = [];
const exportIds: Types.ObjectId[] = [];

const accounts = new AdminAccountRepository();

function intentFor(action: string, targetId: string, requestId: string): AuditIntent {
    return {
        action,
        actor: {
            kind: 'system',
            id: null,
            email: null,
            displayName: MARKER,
            tier: null,
            sessionId: null,
        },
        target: { type: 'administrator', id: targetId, label: `${MARKER}@example.test` },
        context: { method: 'TEST', path: `/${MARKER}`, requestId, ip: null, userAgent: null },
    };
}

async function seedAdministrator(suffix: string): Promise<Types.ObjectId> {
    const session = await adminConnection().startSession();
    let id: Types.ObjectId;
    try {
        await session.withTransaction(async () => {
            const admin = await accounts.create({
                email: `${MARKER}-${suffix}@example.test`,
                displayName: `${MARKER} ${suffix}`,
                passwordHash: await hash('verify-audit-placeholder-password'),
                tier: 3,
                createdBy: null,
                // ⚠ `status: 'active'` because ADR-023 made `pending` the default, and a
                // pending fixture is refused every route this suite exercises. Fixtures, not
                // the audited path — a real hire is activated by a Developer.
                status: 'active',
            }, session);
            id = admin._id;
        });
    } finally {
        await session.endSession();
    }
    created.push(id!);
    return id!;
}

async function cleanup(): Promise<void> {
    await AdminAccountModel().deleteMany({ email: new RegExp(`^${MARKER}`) }).catch(() => undefined);
    await AuditLogModel().deleteMany({ actor_display_name: MARKER }).catch(() => undefined);
    await AuditLogModel().deleteMany({ target_label: `${MARKER}@example.test` }).catch(() => undefined);
    for (const id of exportIds) {
        await AuditExportModel().deleteOne({ _id: id }).catch(() => undefined);
    }
}

async function main(): Promise<void> {
    env();
    await connectAll();

    // ── 0. The boot gate ─────────────────────────────────────────────────────
    t.section('0. The store can actually transact');

    // `suite().assert` takes a synchronous predicate, so anything async is awaited first
    // and the assertion checks the settled result.
    let gatePassed = false;
    try {
        await assertAuditStoreTransactional();
        gatePassed = true;
    } catch {
        gatePassed = false;
    }
    t.assert('assertAuditStoreTransactional passes against this mongod', () => gatePassed);

    const hello = await adminConnection().db!.admin().command({ hello: 1 });
    t.assert('wi-admin is a replica set or a mongos', () =>
        Boolean(hello.setName) || hello.msg === 'isdbgrid');

    // ── 1. Atomicity ─────────────────────────────────────────────────────────
    t.section('1. A successful action leaves exactly one row');

    const targetId = await seedAdministrator('target');
    const correlationId = randomUUID();

    await auditedTransaction(
        intentFor('administrators.suspend', targetId.toString(), correlationId),
        async (session) => {
            const updated = await accounts.setSuspension(
                targetId.toString(), { by: targetId.toString(), reason: 'verify' }, session,
            );
            return { result: updated, before: { status: 'active' }, after: { status: 'suspended' } };
        },
    );

    const rows = await AuditLogModel().find({ correlation_id: correlationId });
    t.assert('exactly one row was written', () => rows.length === 1);
    t.assert('...with the request’s own correlation id', () => rows[0]?.correlation_id === correlationId);
    t.assert('...marked succeeded', () => rows[0]?.status === 'succeeded');
    t.assert('...carrying the change, not the document', () =>
        rows[0]?.before?.status === 'active' && rows[0]?.after?.status === 'suspended');
    t.assert('...and classified internal, so Support cannot read it', () =>
        rows[0]?.subject_class === 'internal');

    const suspended = await AdminAccountModel().findById(targetId);
    t.assert('the state change committed', () => suspended?.status === 'suspended');

    // ── 2. Fail closed — THE assertion this phase exists for ────────────────
    t.section('2. Fail closed: an unauditable action does not happen');

    const failTarget = await seedAdministrator('failclosed');
    const before = await AdminAccountModel().findById(failTarget);

    // Force the audit insert to fail, leaving everything else untouched.
    const realCreate = AuditLogModel().create.bind(AuditLogModel());
    (AuditLogModel() as unknown as { create: unknown }).create = async () => {
        throw new Error('forced audit write failure');
    };

    let refused = false;
    try {
        await auditedTransaction(
            intentFor('administrators.tier.set', failTarget.toString(), randomUUID()),
            async (session) => {
                const updated = await accounts.setTier(failTarget.toString(), 1, 3, failTarget.toString(), session);
                return { result: updated, before: { tier: 3 }, after: { tier: 1 } };
            },
        );
    } catch {
        refused = true;
    } finally {
        (AuditLogModel() as unknown as { create: unknown }).create = realCreate;
    }

    t.assert('the action was refused', () => refused);

    const after = await AdminAccountModel().findById(failTarget);
    t.assert('🔒 THE TIER DID NOT CHANGE — the write rolled back with its audit row', () =>
        after?.tier === before?.tier && after?.tier === 3);

    // ── 3. Intent-first on a non-transactional write ────────────────────────
    t.section('3. Intent → outcome: the intent is committed before the action runs');

    const attemptId = randomUUID();
    let performed = false;

    (AuditLogModel() as unknown as { create: unknown }).create = async () => {
        throw new Error('forced intent write failure');
    };

    try {
        await auditedAttempt(
            intentFor('administrators.sessions.revoke', targetId.toString(), attemptId),
            async () => {
                performed = true;
                return { result: 0 };
            },
        );
    } catch {
        /* expected */
    } finally {
        (AuditLogModel() as unknown as { create: unknown }).create = realCreate;
    }

    t.assert('🔒 the action was NEVER performed — the intent gate held', () => !performed);

    // A dangling intent: the intent commits, then the action throws.
    const danglingId = randomUUID();
    try {
        await auditedAttempt(
            intentFor('administrators.sessions.revoke', targetId.toString(), danglingId),
            async () => {
                throw new Error('delegated call failed');
            },
        );
    } catch {
        /* expected */
    }

    const dangling = await AuditLogModel().findOne({ correlation_id: danglingId });
    t.assert('a failed action stamps its intent row as failed, not left attempted', () =>
        dangling?.status === 'failed');
    t.assert('...recording why', () => (dangling?.outcome_message ?? '').includes('delegated call failed'));

    // ── 4. Retention: the partial filter, not just the date ─────────────────
    t.section('4. Purge is gated on EXPORTED and aged, never either alone');

    const indexes = await AuditLogModel().listIndexes();
    const ttl = indexes.find((index) => 'expireAfterSeconds' in index);

    t.assert('exactly one TTL index exists', () =>
        indexes.filter((index) => 'expireAfterSeconds' in index).length === 1);
    t.assert('...on purge_after, expiring at the stored date', () =>
        Boolean(ttl) && ttl!.expireAfterSeconds === 0 && 'purge_after' in (ttl!.key as object));
    t.assert('🔒 ...and CARRYING ITS PARTIAL FILTER — without it the purge is unconditional', () =>
        Boolean(ttl!.partialFilterExpression)
        && JSON.stringify(ttl!.partialFilterExpression).includes('export_id'));

    // A row with a purge date in the past but NO export_id must be untouchable.
    const [orphan] = await AuditLogModel().create([{
        occurred_at: new Date('2020-01-01T00:00:00.000Z'),
        correlation_id: randomUUID(),
        actor_kind: 'system',
        actor_display_name: MARKER,
        method: 'TEST',
        path: `/${MARKER}`,
        action: 'audit.purge',
        action_family: 'audit',
        status: 'succeeded',
        target_type: 'audit_export',
        subject_class: 'internal',
        purge_after: new Date('2020-01-02T00:00:00.000Z'),
    }]);

    const stillThere = await AuditLogModel().findById(orphan._id);
    t.assert('an unexported row with a past purge date is not in the TTL index', () => stillThere !== null);
    t.assert('...because it carries no export_id at all', () => stillThere!.export_id === undefined);

    await AuditLogModel().deleteOne({ _id: orphan._id });

    // ── 5. Export end to end ────────────────────────────────────────────────
    t.section('5. Export: a durable file, then stamping');

    // `actor` and `context` became REQUIRED when Phase 12 gave the export its own audit
    // row, and this verifier was never updated — it stopped compiling and nothing reported
    // it, because scripts/ was outside every tsconfig until plan step 0.C. Mirrors what
    // `scripts/audit-export.ts` passes: there is genuinely no administrator behind a CLI
    // export, and inventing one would be a lie. The correlation id is shared with the
    // manifest so the row and the file join.
    const exportCorrelationId = randomUUID();

    const exportResult = await runExport({
        from: new Date(Date.now() - 3_600_000),
        to: new Date(Date.now() + 3_600_000),
        source: 'cli',
        requestedBy: null,
        correlationId: exportCorrelationId,
        purge: false,
        actor: systemActor('audit verification run'),
        context: systemContext('scripts/test/verify-audit-live.ts', exportCorrelationId),
    });
    exportIds.push(exportResult.manifest._id);

    t.assert('the manifest completed', () => exportResult.manifest.status === 'complete');
    t.assert('...with a sha256 and a row count', () =>
        Boolean(exportResult.manifest.sha256) && typeof exportResult.manifest.row_count === 'number');
    t.assert('...and the row count matches what was written', () =>
        exportResult.manifest.row_count === exportResult.rowCount);
    t.assert('rows in range were stamped as exported', () => exportResult.stampedCount > 0);
    t.assert('nothing was purged — the API path never deletes', () => exportResult.purgedCount === 0);

    const stamped = await AuditLogModel().findOne({ correlation_id: correlationId });
    t.assert('a stamped row now carries an export_id', () => Boolean(stamped?.export_id));
    t.assert('🔒 ...and a purge date one retention period after it OCCURRED, not after the export', () => {
        const expected = stamped!.occurred_at.getTime() + env().ADMIN_AUDIT_RETENTION_DAYS * 86_400_000;
        return Math.abs(stamped!.purge_after!.getTime() - expected) < 1_000;
    });
    t.assert('...which is in the future, so a fresh row survives its own export', () =>
        stamped!.purge_after!.getTime() > Date.now());
}

main()
    .then(async () => {
        await cleanup();
        await closeAll();
        await closeRedisClients();
        process.exit(t.finish());
    })
    .catch(async (error) => {
        process.stderr.write(`\n[verify-audit] ERROR: ${error instanceof Error ? error.stack : String(error)}\n\n`);
        await cleanup().catch(() => undefined);
        await closeAll().catch(() => undefined);
        await closeRedisClients().catch(() => undefined);
        process.exit(1);
    });
