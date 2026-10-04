/**
 * The shared product-category list — wi-admin's half (2026-10-04).
 *
 * jovi-mall owns the list, the duplicate check and every write; this service reads the list
 * directly and delegates rename / merge / delete. What can break on THIS side, silently:
 *
 *   §1  the read pins `deletedAt: null` — a merged-away category must not reappear;
 *   §2  the permission split — Support reads, only tiers 1 + 2 curate, and the curating
 *       permission is DESTRUCTIVE so no family sweep can hand it to a lower tier later;
 *   §3  every write is audited against a `category` target, with a catalogued action;
 *   §4  the gateway's paths are routes jovi-mall actually serves — there is no shared
 *       package, so this cross-repo scan is the contract copy;
 *   §5  the vendor catalogue row carries `categories` and the deprecated `category`.
 *
 * Run: npm run test:categories
 */
import { suite } from './_assert';

process.env.NODE_ENV = 'test';
process.env.MONGO_URI_PLATFORM = 'mongodb://localhost:27017/jovi_mall_test';
process.env.MONGO_URI_ADMIN = 'mongodb://localhost:27017/wi_admin_test';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.ADMIN_JWT_SECRET = 'test-access-secret-value-32-chars-long';
process.env.ADMIN_JWT_REFRESH_SECRET = 'test-refresh-secret-value-32-chars-long';
process.env.ADMIN_DASHBOARD_ORIGINS = 'http://localhost:5173';

import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { buildCategoryFilter } from '../../src/modules/categories/repositories/category.read.repository';
import { PERMISSION_CATALOG as PERMISSIONS } from '../../src/modules/authorization/domain/permission.catalog';
import { TIER_GRANTS } from '../../src/modules/authorization/domain/tier-grants';
import { AUDIT_CATALOG as AUDIT_ACTIONS } from '../../src/modules/audit/domain/audit.catalog';
import { subjectClassOf } from '../../src/modules/audit/domain/audit-subject';
import { RenameCategorySchema, MergeCategorySchema, ListCategoriesQuerySchema } from '../../src/modules/categories/validators/category.validator';

const t = suite('categories');

const SRC = resolve(__dirname, '../../src');
const JOVI = resolve(__dirname, '../../../jovi-mall/src');
const read = (root: string, rel: string): string => readFileSync(join(root, rel), 'utf-8');
const code = (root: string, rel: string): string =>
    read(root, rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ─── §1 ──────────────────────────────────────────────────────────────────────
t.section('§1 the read');

t.assert('the filter pins deletedAt: null, with no search', () =>
    JSON.stringify(buildCategoryFilter({})) === JSON.stringify({ $and: [{ deletedAt: null }] }));
t.assert('…and still pins it alongside a search and a source filter', () => {
    const f = buildCategoryFilter({ search: 'shoe', createdSource: 'vendor' }) as { $and: unknown[] };
    return JSON.stringify(f.$and[0]) === JSON.stringify({ deletedAt: null }) && f.$and.length === 3;
});
t.assert('the search term is escaped (a regex metacharacter is literal)', () => {
    const f = buildCategoryFilter({ search: 'a.b' }) as { $and: Array<{ $or?: Array<{ name: RegExp }> }> };
    return f.$and[1].$or![0].name.test('a.b') && !f.$and[1].$or![0].name.test('axb');
});
t.assert('the list query defaults to name order and refuses an unknown sort', () =>
    ListCategoriesQuerySchema.safeParse({}).success
    && !ListCategoriesQuerySchema.safeParse({ sort: 'match_key' }).success);
t.assert('rename and merge bodies are strict', () =>
    !RenameCategorySchema.safeParse({ name: 'Shoes', slug: 'x' }).success
    && !MergeCategorySchema.safeParse({ targetId: '507f1f77bcf86cd799439011', force: true }).success
    && MergeCategorySchema.safeParse({ targetId: '507f1f77bcf86cd799439011' }).success);

// ─── §2 ──────────────────────────────────────────────────────────────────────
t.section('§2 permissions');

t.assert('catalog.categories.read exists and is not sensitive', () => {
    const p = PERMISSIONS['catalog.categories.read'] as { family: string; action: string; destructive?: boolean };
    return p.family === 'catalog' && p.action === 'read' && !p.destructive;
});
t.assert('⛔ catalog.categories.manage is DESTRUCTIVE (a merge rewrites many vendors\' products)', () =>
    (PERMISSIONS['catalog.categories.manage'] as { destructive?: boolean }).destructive === true);
t.assert('Support reads the list and cannot curate it', () =>
    TIER_GRANTS[3].includes('catalog.categories.read') && !TIER_GRANTS[3].includes('catalog.categories.manage'));
t.assert('Admin and Developer curate it', () =>
    TIER_GRANTS[2].includes('catalog.categories.manage') && TIER_GRANTS[1].includes('catalog.categories.manage'));

// ─── §3 ──────────────────────────────────────────────────────────────────────
t.section('§3 audit');

for (const action of ['catalog.categories.rename', 'catalog.categories.merge', 'catalog.categories.delete'] as const) {
    t.assert(`${action}: catalogued, delegated, target category, under the manage permission`, () => {
        const a = AUDIT_ACTIONS[action] as { permission: string; target: string; transport: string };
        return a.permission === 'catalog.categories.manage' && a.target === 'category' && a.transport === 'delegated';
    });
}
t.assert('a category audit row is a platform_record (Support may read what was done to the list)', () =>
    subjectClassOf('category') === 'platform_record');
t.assert('every write route records its audit action', () => {
    const src = code(SRC, 'modules/categories/routes/category.routes.ts');
    return ['rename', 'merge', 'delete'].every((v) => src.includes(`records('catalog.categories.${v}')`));
});

// ─── §4 ──────────────────────────────────────────────────────────────────────
t.section('§4 the cross-repo path contract');

const gw = code(SRC, 'modules/categories/gateways/category.gateway.ts');
const joviRoutes = code(JOVI, 'modules/categories/routes/admin-category.routes.ts');
const joviMount = code(JOVI, 'api/routes/internal-admin.routes.ts');

t.assert('jovi-mall mounts the admin category router at /categories, internal only', () =>
    /router\.use\('\/categories',\s*buildAdminCategoryRouter\(\[requireAdminCaller\]\)\)/.test(joviMount));
t.assert('PATCH /categories/:id — rename — is served by jovi-mall', () =>
    /method:\s*'PATCH',\s*path:\s*`\/categories\/\$\{categoryId\}`/.test(gw) && joviRoutes.includes("router.patch('/:id'"));
t.assert('POST /categories/:id/merge — merge — is served by jovi-mall', () =>
    /method:\s*'POST',\s*path:\s*`\/categories\/\$\{categoryId\}\/merge`/.test(gw) && joviRoutes.includes("router.post('/:id/merge'"));
t.assert('DELETE /categories/:id — delete — is served by jovi-mall', () =>
    /method:\s*'DELETE',\s*path:\s*`\/categories\/\$\{categoryId\}`/.test(gw) && joviRoutes.includes("router.delete('/:id'"));
t.assert('the merge body names `targetId` on both sides', () =>
    gw.includes('body: { targetId }') && read(JOVI, 'modules/categories/validators/category.validator.ts').includes('targetId: objectId'));
t.assert('wi-admin never writes product_categories itself (no insert/update on the raw driver)', () =>
    !/insertOne|updateOne|updateMany|deleteOne|findOneAndUpdate/.test(code(SRC, 'modules/categories/repositories/category.read.repository.ts')));

// ─── §5 ──────────────────────────────────────────────────────────────────────
t.section('§5 the vendor catalogue row');

const vendorController = code(SRC, 'modules/vendors/controllers/vendor.controller.ts');
t.assert('the product projection reads categoryIds, not the retired free-text field', () => {
    const repo = code(SRC, 'modules/vendors/repositories/vendor-product.read.repository.ts');
    return /categoryIds:\s*1/.test(repo) && !/^\s*category:\s*1,/m.test(repo);
});
t.assert('the row carries `categories` and the deprecated primary `category`', () =>
    /categories,\s*\n\s*category:\s*categories\[0\]\?\.name \?\? null/.test(vendorController));
t.assert('category names are batched once per page, not looked up per row', () =>
    vendorController.includes('categoryReads.findRefsByIds(categoryIds)'));

process.exit(t.finish());
