import { Request, Response } from 'express';
import { actorContextOf } from '../../audit/domain/audit-context';
import { asyncHandler } from '../../../core/http/async-handler';
import { createAppError } from '../../../core/errors/app-error';
import { ERROR_CODES } from '../../../core/errors/error-codes';
import { toPageMeta } from '../../../core/http/list-query';
import { sendPaginated, sendSuccess } from '../../../core/http/responses';
import * as gateway from '../gateways/category.gateway';
import {
    CategoryReadModel,
    CategoryReadRepository,
    CategoryUsageReadRepository,
} from '../repositories/category.read.repository';
import { ListCategoriesQuery, MergeCategoryBody, RenameCategoryBody } from '../validators/category.validator';

const categories = new CategoryReadRepository();
const usage = new CategoryUsageReadRepository();

function toIso(value: Date | string | undefined | null): string | null {
    return value ? new Date(value).toISOString() : null;
}

/**
 * The wire shape. `aliasKeys` are the normalised spellings that resolve to this category —
 * its own previous names and every category merged into it — shown so an administrator can
 * see what the duplicate check will already catch. `match_key` itself is internal and absent.
 */
function toCategoryDto(row: CategoryReadModel, counts: { live: number; active: number } | undefined) {
    return {
        id: row._id.toString(),
        name: row.name,
        slug: row.slug,
        aliasKeys: row.alias_keys ?? [],
        createdSource: row.created_source ?? null,
        createdByVendorId: row.created_by_vendor_id?.toString() ?? null,
        productCount: counts?.live ?? 0,
        activeProductCount: counts?.active ?? 0,
        createdAt: toIso(row.createdAt),
        updatedAt: toIso(row.updatedAt),
    };
}

async function loadOr404(categoryId: string): Promise<CategoryReadModel> {
    const row = await categories.findById(categoryId);
    if (!row) throw createAppError(ERROR_CODES.NOT_FOUND, 404, 'Category not found');
    return row;
}

const snapshotOf = (row: CategoryReadModel) => ({ name: row.name, slug: row.slug, aliasKeys: row.alias_keys ?? [] });

export class CategoryController {
    /** GET /api/v1/categories — the shared list, with usage counts for the page. */
    static list = asyncHandler(async (req: Request, res: Response) => {
        const query = req.query as unknown as ListCategoriesQuery;
        const page = await categories.search(query);
        const counts = await usage.countsFor(page.items.map((r) => r._id));
        sendPaginated(
            res,
            page.items.map((r) => toCategoryDto(r, counts.get(r._id.toString()))),
            toPageMeta(page.total, page.page, page.limit),
        );
    });

    /** GET /api/v1/categories/:categoryId */
    static get = asyncHandler(async (req: Request, res: Response) => {
        const row = await loadOr404(req.params.categoryId);
        const counts = await usage.countsFor([row._id]);
        sendSuccess(res, toCategoryDto(row, counts.get(row._id.toString())));
    });

    /** PATCH /api/v1/categories/:categoryId — 409 CATEGORY_NAME_TAKEN means "merge instead". */
    static rename = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as RenameCategoryBody;
        const row = await loadOr404(req.params.categoryId);
        const result = await gateway.rename(req.params.categoryId, body.name, snapshotOf(row), actorContextOf(req));
        sendSuccess(res, result, { message: 'Category renamed' });
    });

    /** POST /api/v1/categories/:categoryId/merge — moves every product into `targetId`. */
    static merge = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as MergeCategoryBody;
        const row = await loadOr404(req.params.categoryId);
        const result = await gateway.merge(req.params.categoryId, body.targetId, snapshotOf(row), actorContextOf(req));
        sendSuccess(res, result, { message: 'Category merged' });
    });

    /** DELETE /api/v1/categories/:categoryId — only an unused category. */
    static remove = asyncHandler(async (req: Request, res: Response) => {
        const row = await loadOr404(req.params.categoryId);
        const result = await gateway.remove(req.params.categoryId, snapshotOf(row), actorContextOf(req));
        sendSuccess(res, result, { message: 'Category deleted' });
    });
}
