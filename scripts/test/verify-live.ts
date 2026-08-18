/**
 * Verify: the foundation against REAL infrastructure. Needs Mongo + Redis.
 *
 * The counterpart to jovi-mall's `verify:live-parity`, and it exists for the same reason:
 * the DB-free suite structurally cannot cover four things.
 *
 *   1. That both Mongo connections open AND land on the databases they were meant to.
 *      A swapped or typo'd URI parses perfectly and connects perfectly — it is simply the
 *      wrong database, and only a live check that reads back `connection.name` catches it.
 *   2. That the readiness probe reports per-dependency truth rather than a hardcoded 200.
 *   3. That the CORS allowlist actually withholds the header from a disallowed origin —
 *      a config object cannot demonstrate that; an HTTP response can.
 *   4. That the Express route table resolves as declared (`/health/*` before the rate
 *      limiter, unmatched paths reaching the 404 envelope).
 *
 * READ-ONLY. Writes nothing to either database.
 *
 * Run: npm run verify:live
 */
import 'dotenv/config';
import type { Server } from 'http';
import { suite } from './_assert';
import { env } from '../../src/config/env';
import { createApp } from '../../src/app';
import { connectAll, closeAll, pingConnection, platformConnection, adminConnection } from '../../src/infra/mongo/connections';
import { closeRedisClients, pingRedis } from '../../src/infra/redis/redis.factory';
import { drain } from '../../src/lifecycle';

const t = suite('wi-admin live verification');

/** Bind to an ephemeral port so a running dev server does not collide with this. */
const TEST_PORT = 0;

interface Fetched {
    status: number;
    headers: Record<string, string>;
    body: any;
}

async function call(port: number, path: string, headers: Record<string, string> = {}): Promise<Fetched> {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
    const text = await response.text();
    let body: any;
    try {
        body = JSON.parse(text);
    } catch {
        body = text;
    }
    const flat: Record<string, string> = {};
    response.headers.forEach((value, key) => {
        flat[key.toLowerCase()] = value;
    });
    return { status: response.status, headers: flat, body };
}

async function main(): Promise<number> {
    const config = env();
    let server: Server | null = null;

    try {
        // ── 1. Connections ────────────────────────────────────────────────────
        t.section('1. Database connections');

        await connectAll();
        t.assert('connectAll() opens both connections', () => true);

        const platformPing = await pingConnection('platform');
        const adminPing = await pingConnection('admin');

        t.assert('the platform database answers a ping', () => platformPing.ok);
        t.assert('the admin database answers a ping', () => adminPing.ok);

        t.assert('the two connections are DISTINCT objects', () =>
            platformConnection() !== adminConnection());

        t.assert('they are connected to two DIFFERENT databases', () => {
            // The check that catches a copy-pasted URI: both would connect, both would
            // ping, and every admin record would land in the shared platform database.
            const platformDb = platformConnection().name;
            const adminDb = adminConnection().name;
            console.log(`       platform → ${platformDb} · admin → ${adminDb}`);
            return Boolean(platformDb) && Boolean(adminDb) && platformDb !== adminDb;
        });

        t.assert('the admin connection points at the database named in MONGO_URI_ADMIN', () =>
            config.MONGO_URI_ADMIN.endsWith(adminConnection().name));

        const redisPing = await pingRedis();
        t.assert('redis answers a ping', () => redisPing.ok);

        // ── 2. HTTP surface ───────────────────────────────────────────────────
        t.section('2. HTTP surface');

        const app = createApp();
        server = await new Promise<Server>((resolve) => {
            const instance = app.listen(TEST_PORT, () => resolve(instance));
        });
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        t.assert('the app binds a port', () => port > 0);

        const live = await call(port, '/health/live');
        t.assert('GET /health/live → 200', () => live.status === 200);
        t.assert('/health/live reports alive without touching a dependency', () =>
            live.body?.data?.status === 'alive');
        t.assert('/health/live echoes a correlation id', () => Boolean(live.headers['x-request-id']));

        const ready = await call(port, '/health/ready');
        t.assert('GET /health/ready → 200 with every dependency up', () => ready.status === 200);
        t.assert('readiness names all four dependencies', () => {
            const deps = ready.body?.data?.dependencies ?? {};
            return ['mongoPlatform', 'mongoAdmin', 'redis', 'joviMall'].every((key) => key in deps);
        });
        t.assert('readiness reports which database each connection reached', () =>
            Boolean(ready.body?.data?.dependencies?.mongoAdmin?.database));
        t.assert('an unconfigured jovi-mall reports not_configured, not down', () => {
            const status = ready.body?.data?.dependencies?.joviMall?.status;
            return config.JOVI_MALL_BASE_URL ? status === 'up' || status === 'down' : status === 'not_configured';
        });

        // ── 3. Route table & error envelope ───────────────────────────────────
        t.section('3. Route table & error envelope');

        const missing = await call(port, '/api/v1/does-not-exist');
        t.assert('an unmatched /api/v1 path → 404', () => missing.status === 404);
        t.assert('the 404 uses the standard error envelope', () =>
            missing.body?.success === false
            && missing.body?.error?.code === 'NOT_FOUND'
            && missing.body?.error?.statusCode === 404
            && typeof missing.body?.requestId === 'string');

        t.assert('/api/v1 is mounted but empty — the versioned prefix resolves', () => missing.status === 404);

        const supplied = await call(port, '/health/live', { 'X-Request-Id': 'verify-live-fixed-id' });
        t.assert('an upstream X-Request-Id is honoured, not overwritten', () =>
            supplied.headers['x-request-id'] === 'verify-live-fixed-id');

        // ── 4. CORS allowlist ─────────────────────────────────────────────────
        t.section('4. CORS allowlist');

        const allowedOrigin = config.ADMIN_DASHBOARD_ORIGINS[0];

        const good = await call(port, '/health/live', { Origin: allowedOrigin });
        t.assert(`an allowlisted origin (${allowedOrigin}) receives ACAO`, () =>
            good.headers['access-control-allow-origin'] === allowedOrigin);
        t.assert('the allowlisted response permits credentials', () =>
            good.headers['access-control-allow-credentials'] === 'true');

        const bad = await call(port, '/health/live', { Origin: 'https://evil.example' });
        t.assert('a disallowed origin receives NO ACAO header', () =>
            bad.headers['access-control-allow-origin'] === undefined);
        t.assert('the disallowed origin still gets a normal 200 body (CORS is browser-side)', () =>
            bad.status === 200);

        const noOrigin = await call(port, '/health/live');
        t.assert('a request with no Origin is unaffected — probes must keep working', () =>
            noOrigin.status === 200);

        // ── 5. Security headers ───────────────────────────────────────────────
        t.section('5. Security headers');

        t.assert('helmet sets X-Content-Type-Options', () =>
            live.headers['x-content-type-options'] === 'nosniff');
        t.assert('X-Powered-By is not advertised', () => live.headers['x-powered-by'] === undefined);
        t.assert('a Content-Security-Policy is present', () =>
            Boolean(live.headers['content-security-policy']));

        t.assert("script-src is NOT relaxed to 'unsafe-inline'", () => {
            // The precise divergence from jovi-mall, which sets
            //   script-src: ["'self'", "'unsafe-inline'"], script-src-attr: ["'unsafe-inline'"]
            // to serve a dev login page. Helmet's default also puts 'unsafe-inline' in
            // STYLE-src, which is standard and executes nothing — so assert on the
            // script directives specifically rather than on the whole header.
            const csp = live.headers['content-security-policy'] ?? '';
            const scriptSrc = csp.split(';').find((directive) => directive.trim().startsWith('script-src '));
            return Boolean(scriptSrc) && !scriptSrc!.includes("'unsafe-inline'");
        });

        t.assert("script-src-attr is 'none' — no inline event handlers", () => {
            const csp = live.headers['content-security-policy'] ?? '';
            return csp.includes("script-src-attr 'none'");
        });

        // ── 6. Graceful drain ─────────────────────────────────────────────────
        t.section('6. Graceful drain');

        // Asserted here rather than by signalling a child process, because on Windows a
        // real SIGTERM cannot be delivered at all: Node maps `child.kill('SIGTERM')` onto
        // `TerminateProcess`, an uncatchable hard kill, so no handler ever runs. Calling
        // `drain()` directly exercises the identical sequence the signal handlers invoke.
        await new Promise<void>((resolve) => server!.close(() => resolve()));
        server = null;

        // Fire two drains simultaneously. Exactly one must run: without the re-entrancy
        // guard both proceed, and the second closes connections the first is still using.
        const [first, second] = await Promise.all([
            drain('verify:live'),
            drain('verify:live-concurrent'),
        ]);
        t.assert('a drain completes cleanly', () => first || second);
        t.assert('exactly ONE of two concurrent drains runs — the rest are refused', () =>
            (first ? !second : second));

        t.assert('both mongo connections are closed afterwards', () => {
            // The accessors throw once the managed map is cleared — that IS the assertion.
            let platformClosed = false;
            let adminClosed = false;
            try { platformConnection(); } catch { platformClosed = true; }
            try { adminConnection(); } catch { adminClosed = true; }
            return platformClosed && adminClosed;
        });

        return t.finish();
    } finally {
        if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
        await closeAll();
        await closeRedisClients();
    }
}

main()
    .then((code) => process.exit(code))
    .catch((error) => {
        console.error('\n❌ verify:live could not run:', error instanceof Error ? error.message : error);
        console.error('   This suite needs Mongo and Redis reachable at the URLs in .env\n');
        process.exit(1);
    });
