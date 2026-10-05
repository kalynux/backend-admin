/**
 * Review moderation — wi-admin's half (2026-10-05).
 *
 * Every review publishes the moment it is written (owner decision). jovi-mall owns the
 * collection and every write; this service reads `reviews` directly and delegates unpublish /
 * republish / delete. What can break on THIS side, silently:
 *
 *   §1  the read pins `deletedAt: null` — a deleted review must not reappear on the list it
 *       was deleted from;
 *   §2  the permission split, and the owner's decision that SUPPORT holds all three — which
 *       needed a named exception to "Support holds nothing destructive";
 *   §3  every write is audited against a `review` target, with a catalogued action;
 *   §4  the gateway's paths are routes jovi-mall actually serves — there is no shared package,
 *       so this cross-repo scan is the contract copy;
 *   §5  the status vocabulary matches jovi-mall's, and the two old values are refused.
 *
 * Run: npm run test:reviews
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
import { buildReviewFilter } from '../../src/modules/reviews/repositories/review.read.repository';
import { PERMISSION_CATALOG as PERMISSIONS } from '../../src/modules/authorization/domain/permission.catalog';
import { TIER_GRANTS } from '../../src/modules/authorization/domain/tier-grants';
import { AUDIT_CATALOG as AUDIT_ACTIONS } from '../../src/modules/audit/domain/audit.catalog';
import { subjectClassOf } from '../../src/modules/audit/domain/audit-subject';
import {
    ListReviewsQuerySchema,
    REVIEW_STATUSES,
    RepublishReviewSchema,
    ReviewReasonSchema,
} from '../../src/modules/reviews/validators/review.validator';

const t = suite('reviews');

const SRC = resolve(__dirname, '../../src');
const JOVI = resolve(__dirname, '../../../jovi-mall/src');
const read = (root: string, rel: string): string => readFileSync(join(root, rel), 'utf-8');
const code = (root: string, rel: string): string =>
    read(root, rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ─── §1 ──────────────────────────────────────────────────────────────────────
t.section('§1 the read');

t.assert('the filter pins deletedAt: null, with no other filter', () =>
    JSON.stringify(buildReviewFilter({})) === JSON.stringify({ $and: [{ deletedAt: null }] }));
t.assert('…and still pins it first alongside every filter', () => {
    const f = buildReviewFilter({
        status: 'unpublished', subjectType: 'product', authorRole: 'customer', rating: 1,
        productId: '507f1f77bcf86cd799439011', search: 'rude', hasText: true,
    }) as { $and: unknown[] };
    return JSON.stringify(f.$and[0]) === JSON.stringify({ deletedAt: null }) && f.$and.length === 8;
});
t.assert('the search term is escaped (a regex metacharacter is literal)', () => {
    const f = buildReviewFilter({ search: 'a.b' }) as { $and: Array<{ $or?: Array<{ title: RegExp }> }> };
    return f.$and[1].$or![0].title.test('a.b') && !f.$and[1].$or![0].title.test('axb');
});
t.assert('hasText=true matches a non-blank title OR body; hasText=false excludes both', () => {
    const yes = JSON.stringify(buildReviewFilter({ hasText: true }));
    const no = JSON.stringify(buildReviewFilter({ hasText: false }));
    return yes.includes('"$or"') && yes.includes('"title"') && yes.includes('"body"') && no.includes('"$nor"');
});
t.assert('the list defaults to newest first and refuses an unknown sort', () => {
    const parsed = ListReviewsQuerySchema.safeParse({});
    return parsed.success && parsed.data.sort.field === 'createdAt' && parsed.data.sort.direction === -1
        && !ListReviewsQuerySchema.safeParse({ sort: 'author_user_id' }).success;
});
t.assert('wi-admin never writes reviews itself (no write on the raw driver)', () =>
    !/insertOne|updateOne|updateMany|deleteOne|deleteMany|findOneAndUpdate/.test(
        code(SRC, 'modules/reviews/repositories/review.read.repository.ts')));

// ─── §2 ──────────────────────────────────────────────────────────────────────
t.section('§2 permissions');

t.assert('reviews.read is a plain read', () => {
    const p = PERMISSIONS['reviews.read'] as { family: string; action: string; destructive?: boolean };
    return p.family === 'reviews' && p.action === 'read' && !p.destructive;
});
t.assert('reviews.moderate is a write and NOT destructive (both verbs are reversible)', () => {
    const p = PERMISSIONS['reviews.moderate'] as { action: string; destructive?: boolean };
    return p.action === 'write' && !p.destructive;
});
t.assert('⛔ reviews.delete is DESTRUCTIVE (no undelete; it frees the author to write again)', () =>
    (PERMISSIONS['reviews.delete'] as { destructive?: boolean }).destructive === true);
t.assert('owner decision: SUPPORT holds all three', () =>
    ['reviews.read', 'reviews.moderate', 'reviews.delete'].every((n) => TIER_GRANTS[3].includes(n as never)));
t.assert('Admin and Developer hold all three', () =>
    ['reviews.read', 'reviews.moderate', 'reviews.delete'].every(
        (n) => TIER_GRANTS[2].includes(n as never) && TIER_GRANTS[1].includes(n as never)));
t.assert('Support\'s delete rides a NAMED exception, not a weakened rule', () => {
    const grants = code(SRC, 'modules/authorization/domain/tier-grants.ts');
    return /TIER_3_DESTRUCTIVE_ALLOWLIST[^=]*=\s*\['reviews\.delete'\]/.test(grants)
        && grants.includes('spec.destructive && !TIER_3_DESTRUCTIVE_ALLOWLIST.includes(name)');
});

// ─── §3 ──────────────────────────────────────────────────────────────────────
t.section('§3 audit');

const AUDITED = {
    'reviews.unpublish': 'reviews.moderate',
    'reviews.republish': 'reviews.moderate',
    'reviews.delete': 'reviews.delete',
} as const;
for (const [action, perm] of Object.entries(AUDITED)) {
    t.assert(`${action}: catalogued, delegated, target review, under ${perm}`, () => {
        const a = AUDIT_ACTIONS[action as keyof typeof AUDIT_ACTIONS] as { permission: string; target: string; transport: string };
        return a.permission === perm && a.target === 'review' && a.transport === 'delegated';
    });
}
t.assert('a review audit row is a platform_record (Support may read what was done to one)', () =>
    subjectClassOf('review') === 'platform_record');
t.assert('every write route records its audit action', () => {
    const src = code(SRC, 'modules/reviews/routes/review.routes.ts');
    return ['unpublish', 'republish', 'delete'].every((v) => src.includes(`records('reviews.${v}')`));
});
t.assert('every write route checks the right permission', () => {
    const src = code(SRC, 'modules/reviews/routes/review.routes.ts');
    return (src.match(/permission\('reviews\.moderate'\)/g) ?? []).length === 2
        && (src.match(/permission\('reviews\.delete'\)/g) ?? []).length === 1
        && (src.match(/permission\('reviews\.read'\)/g) ?? []).length === 2;
});

// ─── §4 ──────────────────────────────────────────────────────────────────────
t.section('§4 the cross-repo path contract');

const gw = code(SRC, 'modules/reviews/gateways/review.gateway.ts');
const joviRoutes = code(JOVI, 'modules/reviews/routes/admin-review.routes.ts');
const joviMount = code(JOVI, 'api/routes/internal-admin.routes.ts');
const joviValidator = read(JOVI, 'modules/reviews/validators/review.validator.ts');

t.assert('jovi-mall mounts the admin review router at /reviews, internal only', () =>
    /router\.use\('\/reviews',\s*buildAdminReviewRouter\(\[requireAdminCaller\]\)\)/.test(joviMount));
t.assert('POST /reviews/:id/unpublish is served by jovi-mall', () =>
    gw.includes("call('POST', `/reviews/${reviewId}/unpublish`") && joviRoutes.includes("router.post('/:id/unpublish'"));
t.assert('POST /reviews/:id/republish is served by jovi-mall', () =>
    gw.includes("call('POST', `/reviews/${reviewId}/republish`") && joviRoutes.includes("router.post('/:id/republish'"));
t.assert('DELETE /reviews/:id is served by jovi-mall', () =>
    gw.includes("call('DELETE', `/reviews/${reviewId}`") && joviRoutes.includes("router.delete('/:id'"));
t.assert('the reason bound (3–500) is the same on both sides', () =>
    joviValidator.includes('reason: z.string().trim().min(3).max(500)')
    && read(SRC, 'modules/reviews/validators/review.validator.ts').includes('reason: z.string().trim().min(3).max(500)'));

// ─── §5 ──────────────────────────────────────────────────────────────────────
t.section('§5 vocabulary');

t.assert('two statuses, matching jovi-mall', () =>
    REVIEW_STATUSES.join(',') === 'published,unpublished'
    && read(JOVI, 'modules/reviews/models/review.model.ts').includes("REVIEW_STATUSES: ReviewStatus[] = ['published', 'unpublished']"));
t.assert('the retired statuses are refused by the list filter', () =>
    !ListReviewsQuerySchema.safeParse({ status: 'pending' }).success
    && !ListReviewsQuerySchema.safeParse({ status: 'rejected' }).success);
t.assert('unpublish/delete need a reason; republish does not; all strict', () =>
    !ReviewReasonSchema.safeParse({}).success
    && ReviewReasonSchema.safeParse({ reason: 'Abusive language' }).success
    && RepublishReviewSchema.safeParse({}).success
    && !ReviewReasonSchema.safeParse({ reason: 'Abusive', notifyAuthor: true }).success);

process.exit(t.finish());
