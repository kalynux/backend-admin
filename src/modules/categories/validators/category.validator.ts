import { z } from 'zod';
import { listQuery } from '../../../core/http/list-query';
import { idParam, objectId, searchTerm } from '../../../core/validation/common.schemas';

/** Request shapes for `/api/v1/categories`. */

export const CategoryIdParamSchema = idParam('categoryId', 'category');

/** camelCase on both sides — `product_categories` uses Mongoose's default timestamps. */
export const CATEGORY_SORT = {
    name: 'name',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
} as const;

/** Who created a category — jovi-mall's `CATEGORY_CREATED_SOURCES`, verbatim. */
export const CATEGORY_CREATED_SOURCES = ['vendor', 'admin', 'migration'] as const;

export const ListCategoriesQuerySchema = listQuery(CATEGORY_SORT, 'name', {
    search: searchTerm.optional(),
    createdSource: z.enum(CATEGORY_CREATED_SOURCES).optional(),
});
export type ListCategoriesQuery = z.infer<typeof ListCategoriesQuerySchema>;

/**
 * The name is judged by jovi-mall's `cleanCategoryName` (2–60 characters, at least one
 * letter or digit) — the bound here is only a size guard, so a bad name answers jovi-mall's
 * category-specific `CATEGORY_NAME_INVALID` rather than a generic validation error.
 */
export const RenameCategorySchema = z.object({
    name: z.string().min(1).max(200),
}).strict();
export type RenameCategoryBody = z.infer<typeof RenameCategorySchema>;

export const MergeCategorySchema = z.object({
    targetId: objectId,
}).strict();
export type MergeCategoryBody = z.infer<typeof MergeCategorySchema>;
