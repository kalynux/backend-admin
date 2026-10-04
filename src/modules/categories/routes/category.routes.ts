import { Router } from 'express';
import { defineRoute, permission, records } from '../../../api/route-manifest';
import { CategoryController } from '../controllers/category.controller';
import {
    CategoryIdParamSchema,
    ListCategoriesQuerySchema,
    MergeCategorySchema,
    RenameCategorySchema,
} from '../validators/category.validator';

/**
 * `/api/v1/categories` — the shared product-category list (2026-10-04).
 *
 * Vendors create categories themselves while editing a product, through jovi-mall's
 * duplicate check: spelling variants are merged silently and look-alikes are asked about.
 * What no spelling rule can catch — a translation ("Chaussures" / "Shoes"), a synonym — is
 * cleaned up here. A merge is REMEMBERED: the merged spelling becomes an alias of the
 * survivor, so the next vendor who types it lands on the survivor without a question.
 *
 * Reads hold `catalog.categories.read` (Support and up); the three writes hold
 * `catalog.categories.manage`, flagged destructive and named by hand for tier 2.
 *
 * Design record: PRODUCTION-READINESS/PRODUCT-CATEGORIES-PLAN.md (decision C-4).
 */
const router = Router();
const mountedAt = '/categories';

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/',
    access: permission('catalog.categories.read'),
    validate: { query: ListCategoriesQuerySchema },
    handler: CategoryController.list,
});

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/:categoryId',
    access: permission('catalog.categories.read'),
    validate: { params: CategoryIdParamSchema },
    handler: CategoryController.get,
});

defineRoute(router, {
    mountedAt,
    method: 'patch',
    path: '/:categoryId',
    access: permission('catalog.categories.manage'),
    validate: { params: CategoryIdParamSchema, body: RenameCategorySchema },
    audit: records('catalog.categories.rename'),
    handler: CategoryController.rename,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/:categoryId/merge',
    access: permission('catalog.categories.manage'),
    validate: { params: CategoryIdParamSchema, body: MergeCategorySchema },
    audit: records('catalog.categories.merge'),
    handler: CategoryController.merge,
});

defineRoute(router, {
    mountedAt,
    method: 'delete',
    path: '/:categoryId',
    access: permission('catalog.categories.manage'),
    validate: { params: CategoryIdParamSchema },
    audit: records('catalog.categories.delete'),
    handler: CategoryController.remove,
});

export const categoryRoutes = router;
