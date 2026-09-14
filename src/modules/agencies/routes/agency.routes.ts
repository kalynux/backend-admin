import { Router } from 'express';
import { defineRoute, permission, records } from '../../../api/route-manifest';
import { AgencyController } from '../controllers/agency.controller';
import {
    AgencyIdParamSchema,
    DeactivateAgencySchema,
    ListAgencyActivityQuerySchema,
    ListContractEventsQuerySchema,
    ListRosterQuerySchema,
    ReactivateAgencySchema,
    SearchAgenciesQuerySchema,
    RejectAgencySchema,
    VerifyAgencySchema,
} from '../validators/agency.validator';

/**
 * `/api/v1/agencies` — delivery-agency administration.
 *
 * PHASE-0 found four endpoints here — list, detail, deactivate, reactivate — and no way to
 * approve an agency at all. Eight routes now cover it: the directory gains search and
 * filters, the roster and the two histories are new, and `verify` is the verb the domain
 * was missing.
 *
 * ── Read and write hold different permissions ─────────────────────────────────
 * `agencies.read` is a Support-tier lookup — answering a ticket about a stalled delivery
 * needs it. The three writes are not: `agencies.verify` and `agencies.reactivate` reach
 * tier 2 through `allInFamily('agencies')`, which Support's grant does not include, and
 * `agencies.deactivate` is flagged `destructive`, so `allInFamily` refuses to expand it
 * and a human had to type it into the tier-2 list by name.
 *
 * ── Route order ──────────────────────────────────────────────────────────────
 * Every sub-route sits under a distinct second segment, so Express matches them without
 * ambiguity against `/:agencyId`. Keep it that way: a future literal SIBLING of
 * `/:agencyId` — say `/export` — MUST be declared above it, or it is read as an id.
 */
const router = Router();
const mountedAt = '/agencies';

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/',
    access: permission('agencies.read'),
    validate: { query: SearchAgenciesQuerySchema },
    handler: AgencyController.search,
});

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/:agencyId',
    access: permission('agencies.read'),
    validate: { params: AgencyIdParamSchema },
    handler: AgencyController.get,
});

/**
 * The identity documents behind the verification verdict.
 *
 * ⚠ **`agencies.read`, the Support-tier lookup**, deliberately rather than a review-scoped
 * permission: Support answers "why was my agency rejected" tickets and cannot do it from a
 * status alone. The verdict WRITE (`/verify`, `/reject`) is the act with consequences and keeps
 * its own permission.
 *
 * Metadata and file HANDLES only, never bytes — the picture comes from
 * `GET /api/v1/files/:fileId/content`, behind `files.content.read` and **audited**.
 *
 * A DELEGATED read, unlike the detail above. Two reasons, both in the gateway: the documents
 * are in a private storage tree whose rule must not be re-implemented here, and an agency's
 * depot addresses live on the **Magazin** rather than on the agency document.
 *
 * Declared above `/:agencyId/roster` and the rest; no `/:agencyId/…` sibling can shadow it.
 */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/:agencyId/verification',
    access: permission('agencies.read'),
    validate: { params: AgencyIdParamSchema },
    handler: AgencyController.verification,
});

/**
 * The roster needs BOTH permissions, in `all` mode.
 *
 * `agencies.read` because the subject is an agency, and `agents.read` because the rows
 * carry agents — their names, their statuses, their KYC and ban state. Requiring only the
 * first would make this a second door onto the agent directory that bypasses the
 * permission governing it. Both tiers that hold either hold both, so this costs nobody
 * access; it states the dependency so a future tier change cannot quietly open a side door.
 */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/:agencyId/agents',
    access: permission('agencies.read', 'agents.read'),
    validate: { params: AgencyIdParamSchema, query: ListRosterQuerySchema },
    handler: AgencyController.roster,
});

/**
 * The contract history is jovi-mall's own record and is gated by `agencies.read` alone —
 * it is not audit data and the audit read scope does not apply to it. Contrast
 * `/activity` below, which is.
 */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/:agencyId/contract-history',
    access: permission('agencies.read'),
    validate: { params: AgencyIdParamSchema, query: ListContractEventsQuerySchema },
    handler: AgencyController.contractHistory,
});

/**
 * The activity feed needs `audit.read` as well, for the reason `/users/:id/activity`
 * documents: the rows ARE audit rows and the repository applies the audit read scope to
 * them. Requiring only `agencies.read` would make this a second door onto the trail.
 */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/:agencyId/activity',
    access: permission('agencies.read', 'audit.read'),
    validate: { params: AgencyIdParamSchema, query: ListAgencyActivityQuerySchema },
    handler: AgencyController.activity,
});

/**
 * The three writes are POST sub-resources rather than a `PATCH { status }`.
 *
 * ADR-005 D-4: the permission and the audit row attach to the ACTION. All three move
 * `status`, but they hold three different permissions and write three different audit
 * actions, and a status field on a PATCH body could not require a reason on one direction
 * and make it optional on another.
 *
 * jovi-mall spells the last two `PATCH`; porting is not transcription.
 */
defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/:agencyId/verify',
    access: permission('agencies.verify'),
    validate: { params: AgencyIdParamSchema, body: VerifyAgencySchema },
    audit: records('agencies.verify'),
    handler: AgencyController.verify,
});

/**
 * The other verdict. It holds `agencies.verify` — the review CAPABILITY, named for its
 * happy path — exactly as `vendors.kyc.review` and `agents.kyc.review` each cover both of
 * their outcomes. ADR-005 D-4 attaches the permission and the audit row to the action, and
 * here the two verdicts are one action with two results: the **audit action** is what
 * separates them, so `agencies.reject` is its own row while the permission is shared.
 *
 * Renaming `agencies.verify` to `agencies.kyc.review` would read better and was not done:
 * Phase 5 closed the permission register at 111 with every entry granted by tier, and a
 * rename is a migration of those grants for a cosmetic gain.
 */
defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/:agencyId/reject',
    access: permission('agencies.verify'),
    validate: { params: AgencyIdParamSchema, body: RejectAgencySchema },
    audit: records('agencies.reject'),
    handler: AgencyController.reject,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/:agencyId/deactivate',
    access: permission('agencies.deactivate'),
    validate: { params: AgencyIdParamSchema, body: DeactivateAgencySchema },
    audit: records('agencies.deactivate'),
    handler: AgencyController.deactivate,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/:agencyId/reactivate',
    access: permission('agencies.reactivate'),
    validate: { params: AgencyIdParamSchema, body: ReactivateAgencySchema },
    audit: records('agencies.reactivate'),
    handler: AgencyController.reactivate,
});

export const agencyRoutes = router;
