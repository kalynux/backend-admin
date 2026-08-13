import mongoose, { Connection } from 'mongoose';
import { env } from '../../config/env';
import { logger } from '../../core/logging/logger';
import { createAppError } from '../../core/errors/app-error';
import { ERROR_CODES } from '../../core/errors/error-codes';

/**
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║  THE RULE: register models with `connection.model(...)`, NEVER               ║
 * ║  `mongoose.model(...)`.                                                      ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 *
 * This service talks to TWO databases, so there is no such thing as "the" connection:
 *
 *   • platform (`jovi_mall`) — shared with the jovi-mall service. Everything about
 *     users, orders, shipments, money. This service is a second writer here, which is
 *     why domain events must cross processes (see Redis pub/sub, Phase 1 infra).
 *   • admin (`wi-admin`)     — private to this service. Admin identity, sessions,
 *     audit log, admin notifications. jovi-mall has no access and never will.
 *
 * `mongoose.connect()` sets ONE global default connection and cannot represent two
 * databases, so it is not used at all here — `createConnection()` is called twice.
 * The consequence is the rule above: a model registered through the global
 * `mongoose.model(...)` binds to the default connection, which this service never
 * opens. It will not throw. Every query against it hangs until the request times out.
 * That failure looks like a database problem and is not one.
 *
 * Two separate URIs rather than one connection plus `.useDb()`: both point at the same
 * mongod today, as decided, but a separate URI means moving `wi-admin` to its own host
 * later is a config change with no code change. The cost is a second connection pool
 * against the same server, which is negligible.
 */

export type ConnectionName = 'platform' | 'admin';

interface ManagedConnection {
    name: ConnectionName;
    uri: string;
    connection: Connection;
}

const managed = new Map<ConnectionName, ManagedConnection>();

function baseOptions(): mongoose.ConnectOptions {
    return {
        // Fail a query fast when the server is gone, rather than buffering it forever.
        // Mongoose's default (`bufferCommands: true`, no server-selection deadline of our
        // own) turns an outage into hung requests instead of errors readiness can see.
        serverSelectionTimeoutMS: 5_000,
        // Index builds are a deployment step, not a boot side effect. jovi-mall leaves
        // autoIndex on and its own CLAUDE.md records the result: a failed 2dsphere index
        // fails SILENTLY at boot. Keep it on in dev for convenience, off in production.
        autoIndex: env().NODE_ENV !== 'production',
    };
}

function attachLifecycleLogging(name: ConnectionName, connection: Connection): void {
    const log = logger().child({ mongo: name });

    connection.on('connected', () => log.info({ db: connection.name }, 'mongo connected'));
    connection.on('disconnected', () => log.warn('mongo disconnected'));
    connection.on('reconnected', () => log.info('mongo reconnected'));
    // Never log the error object wholesale — a connection error can carry the URI, and
    // the URI carries credentials.
    connection.on('error', (err: Error) => log.error({ err: err.message }, 'mongo connection error'));
}

/**
 * Open both connections. Called by `server.ts` BEFORE the HTTP server binds — the
 * service must never accept a request it cannot serve.
 */
export async function connectAll(): Promise<void> {
    const config = env();

    const targets: Array<{ name: ConnectionName; uri: string }> = [
        { name: 'platform', uri: config.MONGO_URI_PLATFORM },
        { name: 'admin', uri: config.MONGO_URI_ADMIN },
    ];

    for (const target of targets) {
        if (managed.has(target.name)) continue;

        const connection = mongoose.createConnection(target.uri, baseOptions());
        attachLifecycleLogging(target.name, connection);

        // `createConnection` is lazy; `asPromise()` is what actually waits for the
        // handshake, so a bad URI surfaces here at boot instead of on first query.
        await connection.asPromise();

        managed.set(target.name, { name: target.name, uri: target.uri, connection });
    }
}

function get(name: ConnectionName): Connection {
    const entry = managed.get(name);
    if (!entry) {
        throw createAppError(
            ERROR_CODES.SERVICE_DEPENDENCY_UNAVAILABLE,
            503,
            `The '${name}' database connection has not been opened. connectAll() must run before any model or query.`,
            { connection: name },
        );
    }
    return entry.connection;
}

/** The shared `jovi_mall` database. Models for platform data register here. */
export const platformConnection = (): Connection => get('platform');

/** The private `wi-admin` database. Admin identity, sessions and audit register here. */
export const adminConnection = (): Connection => get('admin');

/**
 * Refuse to start unless the `wi-admin` database can run multi-document transactions.
 *
 * Called from `startServer()` BEFORE the port binds. An audited write is a state change
 * and its audit row committing together; without transactions that becomes two writes
 * that can disagree, and the service would degrade to "audited, probably" — the one
 * guarantee the subsystem exists to make — while looking perfectly healthy.
 *
 * This is not a theoretical guard. Two plausible configurations break it silently:
 *
 *  • `MONGO_URI_ADMIN` carries no `replicaSet=` parameter, so it works today only by
 *    driver topology discovery. Adding `directConnection=true` while debugging pins the
 *    driver to a single server and every audited write starts failing.
 *  • `IMPLEMENTATION-BLUEPRINT.md` still lists `wi-admin` placement as open. A standalone
 *    `mongod` would break every audited write in production, on the first suspension.
 *
 * Failing at boot turns both into a startup error an operator reads, rather than a 500
 * the first time somebody suspends an administrator.
 */
export async function assertAuditStoreTransactional(): Promise<void> {
    const connection = get('admin');

    if (!connection.db) {
        throw createAppError(
            ERROR_CODES.SERVICE_DEPENDENCY_UNAVAILABLE,
            503,
            'The wi-admin database connection is not ready',
        );
    }

    const hello = (await connection.db.admin().command({ hello: 1 })) as {
        setName?: string;
        msg?: string;
    };

    // A replica set reports `setName`; a mongos reports `msg: 'isdbgrid'`. Either can
    // run a transaction. A standalone reports neither.
    const transactional = Boolean(hello.setName) || hello.msg === 'isdbgrid';

    if (!transactional) {
        throw createAppError(
            ERROR_CODES.AUDIT_STORE_NOT_TRANSACTIONAL,
            500,
            'The wi-admin database is a standalone mongod. Administrator actions are audited inside a '
            + 'transaction, which requires a replica set (even a single-node one) or a sharded cluster. '
            + 'Set MONGO_URI_ADMIN to a replica-set member and include replicaSet=<name>.',
            { database: connection.name },
        );
    }

    logger().info({ replicaSet: hello.setName ?? 'mongos' }, 'wi-admin store is transactional');
}

export interface PingResult {
    ok: boolean;
    /** The database actually connected to — surfaced so readiness can prove it is the right one. */
    database: string | null;
    durationMs: number;
    error?: string;
}

/**
 * Round-trip a real command to the server. `readyState === 1` only reports what the
 * driver believes; an `admin.ping()` proves the server answers.
 */
export async function pingConnection(name: ConnectionName): Promise<PingResult> {
    const startedAt = Date.now();
    try {
        const connection = get(name);
        if (!connection.db) {
            return { ok: false, database: null, durationMs: Date.now() - startedAt, error: 'not connected' };
        }
        await connection.db.admin().command({ ping: 1 });
        return { ok: true, database: connection.name, durationMs: Date.now() - startedAt };
    } catch (error) {
        return {
            ok: false,
            database: null,
            durationMs: Date.now() - startedAt,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

/** Close both connections. Part of the graceful-shutdown sequence. */
export async function closeAll(): Promise<void> {
    const log = logger();
    for (const [name, entry] of managed.entries()) {
        try {
            await entry.connection.close();
            log.info({ mongo: name }, 'mongo connection closed');
        } catch (error) {
            log.error(
                { mongo: name, err: error instanceof Error ? error.message : String(error) },
                'failed to close mongo connection',
            );
        }
    }
    managed.clear();
}
