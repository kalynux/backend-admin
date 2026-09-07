import { Router } from 'express';
import { defineRoute, noAudit, serviceToken } from '../../../api/route-manifest';
import { AutomationController } from '../controllers/automation.controller';

/**
 * `/api/internal/automation` — THE ONLY DOOR ON THIS SERVICE A MACHINE CAN OPEN (ADR-022).
 *
 * Outside `/api/v1` on purpose. That prefix is the versioned contract the admin dashboard
 * consumes and every route on it answers to an administrator; this answers to a shared
 * secret and promises a dashboard nothing. Putting it inside the versioned surface would
 * mean the one endpoint with no tier, no permission and no person sitting in the middle of
 * the surface whose defining property is that every endpoint has all three.
 *
 * ── The boundary, stated once ─────────────────────────────────────────────────
 * A service route may only WRITE something the machine observed about ITSELF. It may never
 * read platform data, because there is no tier to grade the answer by. That is why the
 * read half of this feature lives on `/api/v1/automation` behind three permissions instead
 * of being a second verb here — and it is the line to point the next "just one more
 * machine endpoint" request at.
 *
 * `SERVICE_ROUTE_ALLOWLIST` holds this one path, and the boot assertion refuses to start
 * if anything else declares `serviceToken()` without being added to it.
 */
const router = Router();
const mountedAt = '/automation';

defineRoute(router, {
    apiPrefix: '/api/internal',
    mountedAt,
    method: 'post',
    path: '/failures',
    access: serviceToken('The n8n automation layer reporting its own failures — no administrator identity exists'),
    audit: noAudit('No administrator acted; the report itself is the durable record'),
    handler: AutomationController.report,
});

export const automationInternalRoutes = router;
