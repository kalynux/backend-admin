import { Router } from 'express';
import { anyPermission, defineRoute } from '../../../api/route-manifest';
import { AutomationController } from '../controllers/automation.controller';

/**
 * `/api/v1/automation` — what the n8n automation layer reported about its own failures
 * (ADR-022).
 *
 * Both routes are GETs and neither is audited, the ordinary rule: ADR-006 D-5 records what
 * MOVED, and the one read this service audits is a DISCLOSURE of a beneficiary's account
 * number. Nothing here discloses anything about a person — the subject is a machine.
 *
 * ── `anyPermission`, not `permission` ─────────────────────────────────────────
 * All three rungs reach the same route and the projection decides what each one gets. The
 * alternative — three routes — would mean a dashboard choosing a URL based on the
 * administrator's own level, which is exactly the thing a server should decide. Same
 * reasoning, same shape, as `/system/errors`.
 *
 * ── Why tier 1 reuses a `developer_tools` name ────────────────────────────────
 * The stack trace. `tier-grants.ts` refuses the `developer_tools` family to any tier but 1
 * at boot, which is precisely the guarantee wanted for raw internal state — and it is why
 * this needs two NEW names for the tiers below rather than one name for all three.
 */
const router = Router();
const mountedAt = '/automation';

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/failures',
    access: anyPermission(
        'developer_tools.logs.read',
        'system.automation.read',
        'support.automation.lookup',
    ),
    handler: AutomationController.failures,
});

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/summary',
    access: anyPermission(
        'developer_tools.logs.read',
        'system.automation.read',
        'support.automation.lookup',
    ),
    handler: AutomationController.summary,
});

export const automationRoutes = router;
