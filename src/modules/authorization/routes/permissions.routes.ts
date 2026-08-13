import { Router } from 'express';
import { defineRoute, permission, selfService } from '../../../api/route-manifest';
import { PermissionsController } from '../controllers/permissions.controller';

/**
 * `/api/v1/permissions` — the policy, readable.
 *
 * `catalog` and `me` are `selfService`: withholding them from a tier does not protect
 * anything, it just produces a dashboard full of buttons that 403. The full tier matrix
 * needs `permissions.read`, which Support does not hold — not because it is sensitive,
 * but because Support has no screen that renders it.
 */
const router = Router();
const mountedAt = '/permissions';

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/catalog',
    access: selfService('The permission vocabulary is what a dashboard is written against'),
    handler: PermissionsController.catalog,
});

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/me',
    access: selfService('An administrator must be able to discover what they may do'),
    handler: PermissionsController.me,
});

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/tiers',
    access: permission('permissions.read'),
    handler: PermissionsController.tiers,
});

export const permissionsRoutes = router;
