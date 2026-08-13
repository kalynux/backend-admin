import express, { Express } from 'express';
import cors, { CorsOptions } from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';
import { env } from './config/env';
import { logger } from './core/logging/logger';
import { requestIdMiddleware } from './api/middlewares/request-id.middleware';
import { errorHandlerMiddleware } from './api/middlewares/error-handler.middleware';
import { notFoundMiddleware } from './api/middlewares/not-found.middleware';
import { globalRateLimiter } from './api/middlewares/rate-limit.middleware';
import { ensureAuthRateLimiter } from './api/middlewares/auth-rate-limit.middleware';
import { healthRoutes } from './api/routes/health.routes';
import { assertRouteManifestComplete } from './api/route-manifest';
import { assertAuditCoverageComplete } from './api/audit-coverage';
import { assertFeatureFlagCatalogValid } from './modules/dev-tools/domain/feature-flag.catalog';
import { assertExposedConfigSafe } from './modules/system/domain/exposed-config';
import {
    assertNotificationCoverageComplete,
    assertSourcePermissionsExist,
} from './modules/notifications/domain/notification.coverage';
import { assertGrantTableValid } from './modules/authorization/domain/tier-grants';
import { assertDualControlHandlersRegistered } from './modules/dual-control/domain/dual-control.registry';
import { assertAuditCatalogValid } from './modules/audit/domain/audit.catalog';
import { installAuditDenialSink } from './modules/audit/domain/audit.writer';
import { apiV1 } from './api';

/**
 * Express application assembly.
 *
 * The ORDER below is the contract. Each entry notes why it sits where it does; several
 * are direct corrections of defects catalogued in `docs/PHASE-0-DISCOVERY.md`.
 */
export function createApp(): Express {
    const config = env();
    const app = express();

    // Build the credential-endpoint limiter here, where config is known valid. Doing it
    // at import time would run before validation; doing it inside a request handler is
    // what express-rate-limit warns against.
    ensureAuthRateLimiter();

    // ── 0. Authorization policy ───────────────────────────────────────────────
    // Before any route exists. A service running on an inconsistent grant table is worse
    // than one that is down: it looks like it is working, and the failure mode is someone
    // reaching what they should not. The route-manifest half runs after mounting, below.
    assertGrantTableValid();
    assertDualControlHandlersRegistered();
    assertAuditCatalogValid();
    // Phase 12: the two registries the operations surface adds. Both fail closed for the
    // same reason as the catalogs above — a flag nothing reads or a config key naming a
    // secret is worse than a service that will not start.
    assertFeatureFlagCatalogValid();
    assertExposedConfigSafe();
    // Phase 13, and the same argument one subsystem over: a notification type nothing
    // produces is invisible — it appears in the filter allowlist and on the preferences
    // screen and simply never arrives. That is precisely the state jovi-mall's eight
    // undelivered `agent_contract.*` situations were in, and the state this service's own
    // `approvals.*` audit actions were in until Phase 12. Both were found by reading code.
    assertNotificationCoverageComplete();
    assertSourcePermissionsExist();

    // Denials become durable audit rows from here on. Installed rather than imported by
    // `denial.recorder.ts`, so the dependency runs audit → authorization and the guard
    // stays loadable by processes with no database (the bootstrap CLI, the DB-free suites).
    installAuditDenialSink();

    // ── 1. Correlation id ─────────────────────────────────────────────────────
    // First, unconditionally: every log line, error envelope and (Phase 3) audit row
    // keys off req.requestId, so nothing may run before it exists.
    app.use(requestIdMiddleware);

    // ── 2. Request logging ────────────────────────────────────────────────────
    // Immediately after, so even a request rejected by helmet or CORS is recorded.
    app.use(
        pinoHttp({
            logger: logger(),
            genReqId: (req) => (req as express.Request).requestId,
            // Client errors are the caller's problem, not an incident — logging them at
            // `error` would bury real faults in 404 noise.
            customLogLevel: (_req, res, err) => {
                if (err || res.statusCode >= 500) return 'error';
                if (res.statusCode >= 400) return 'warn';
                return 'info';
            },
            // Health probes fire every few seconds forever; at info level they would be
            // the overwhelming majority of the log.
            autoLogging: { ignore: (req) => (req.url ?? '').startsWith('/health') },
        }),
    );

    // ── 3. Proxy trust ────────────────────────────────────────────────────────
    // Before anything reads an IP. Behind a reverse proxy with this unset, every client
    // appears to be the proxy: the rate limiter throttles all admins as one, and the
    // Phase 3 audit log records the proxy's address for every action.
    app.set('trust proxy', config.TRUST_PROXY);

    // Nothing here serves HTML, so advertise less about the stack.
    app.disable('x-powered-by');

    // ── 4. Security headers ───────────────────────────────────────────────────
    // helmet's defaults, unrelaxed. jovi-mall widens `script-src` to 'unsafe-inline' to
    // serve a dev login page; this service returns JSON only and needs no such hole.
    app.use(helmet());

    // ── 5. CORS — explicit allowlist ──────────────────────────────────────────
    // jovi-mall runs `cors({ origin: true, credentials: true })`, which reflects ANY
    // origin and permits credentialed cross-origin reads from anywhere. For the service
    // holding platform administration that is not acceptable at any stage.
    app.use(cors(buildCorsOptions(config.ADMIN_DASHBOARD_ORIGINS)));

    // ── 6. Body parsing ───────────────────────────────────────────────────────
    // An explicit ceiling; jovi-mall sets none, so a single request can allocate
    // unbounded memory.
    app.use(express.json({ limit: '1mb' }));
    app.use(express.urlencoded({ extended: true, limit: '1mb' }));

    // ── 7. Cookies ────────────────────────────────────────────────────────────
    // Phase 2 issues the admin session as an httpOnly cookie.
    app.use(cookieParser());

    // ── 8. Health — before the rate limiter ───────────────────────────────────
    // A probe must never be throttled: a burst of real traffic would otherwise trip the
    // limiter, fail the readiness check, and pull a perfectly healthy instance out of
    // rotation — turning load into an outage.
    app.use('/health', healthRoutes);

    // ── 9. Rate limiting ──────────────────────────────────────────────────────
    app.use(globalRateLimiter);

    // ── 10. Versioned API ─────────────────────────────────────────────────────
    app.use('/api/v1', apiV1);

    // ── 10b. Every route declared who may call it ─────────────────────────────
    // Immediately after mounting, and before the 404 handler, because it inspects what
    // Express actually registered. A route that reached the router without going through
    // `defineRoute()` — and therefore declares no access rule — stops the process here
    // rather than serving unguarded traffic. So does one claiming to be public without
    // being on `PUBLIC_ROUTE_ALLOWLIST`.
    assertRouteManifestComplete(app);

    // ── 10c. ...and every mutation declared what it records ───────────────────
    // The audit half of the same idea, and the half that was missing until Phase 12: a
    // mutating route with no audit declaration, one naming an action the catalog does not
    // know, or a catalogued action that NOTHING produces, all stop the process here.
    //
    // That last case is why this exists. Five `approvals.*` actions and both `audit.*`
    // actions were catalogued and written by nothing for two phases — the whole four-eyes
    // decision path and the only operation that deletes an audit row, believed done and
    // silently recording nothing, with no mechanism able to notice.
    assertAuditCoverageComplete();

    // ── 11. Unmatched routes ──────────────────────────────────────────────────
    app.use(notFoundMiddleware);

    // ── 12. Global error handler — must be last ───────────────────────────────
    app.use(errorHandlerMiddleware);

    return app;
}

/**
 * Exact-match origin allowlist.
 *
 * Requests with no `Origin` header (server-to-server, curl, health probes) are allowed:
 * CORS is a browser mechanism, and rejecting them would break probes while stopping no
 * attacker. A browser request from an unlisted origin gets no `Access-Control-Allow-Origin`
 * header, so the browser blocks it — which is the enforcement point.
 */
function buildCorsOptions(allowedOrigins: string[]): CorsOptions {
    const allowed = new Set(allowedOrigins);

    return {
        origin(origin, callback) {
            if (!origin || allowed.has(origin)) {
                callback(null, true);
                return;
            }
            logger().warn({ origin }, 'CORS: rejected disallowed origin');
            // `false`, not an Error: this omits the CORS headers (which is the correct
            // browser-visible outcome) instead of turning a blocked read into a 500.
            callback(null, false);
        },
        credentials: true,
        methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
        // `X-CSRF-Token` is not optional here. The dashboard is a separate origin, so
        // every cookie-authenticated write is a preflighted cross-origin request, and
        // `requireCsrfToken` refuses it without that header — a header the browser will
        // not send unless it is listed in `Access-Control-Allow-Headers`. Omitting it made
        // every mutating call fail preflight for a browser client while passing every
        // `verify:*` script, because those are Node clients and CORS is a browser
        // mechanism. See ADR-005 §D-5.
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'X-CSRF-Token'],
        exposedHeaders: ['X-Request-Id'],
        maxAge: 600,
    };
}
