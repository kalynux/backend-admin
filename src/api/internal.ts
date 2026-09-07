import { Router } from 'express';
import { automationInternalRoutes } from '../modules/automation/routes/automation-internal.routes';

/**
 * The `/api/internal` router — the machine surface (ADR-022).
 *
 * ── Why this exists as a separate prefix ──────────────────────────────────────
 * `/api/v1` is the versioned contract the admin dashboard consumes, and its defining
 * property is that every route on it resolves to an administrator with a tier. This
 * service had NO other kind of caller until ADR-022; the n8n automation layer is the
 * first, it holds a shared secret rather than an identity, and it consumes nothing this
 * service promises a dashboard.
 *
 * Keeping it out of `/api/v1` makes "no route on the versioned surface is reachable
 * without an administrator" true by construction rather than by a check somebody can get
 * wrong later.
 *
 * ── One mount per prefix, same as `api/index.ts` ──────────────────────────────
 * Express runs every `router.use` guard for each request matching a prefix, so two routers
 * on one prefix silently makes the later one dead code. The rule that avoids it is the
 * same here, and cheap to keep while this holds a single module.
 *
 * ⚠ Mounted AFTER the global rate limiter in `app.ts`, unlike `/health`. A burst of
 * failure reports during an outage is exactly when a ceiling earns its keep — and the
 * limiter fails OPEN when Redis is down (ADR-016), so it cannot turn a Redis wobble into
 * a refused report.
 */
const apiInternal = Router();

apiInternal.use('/automation', automationInternalRoutes);

export { apiInternal };
