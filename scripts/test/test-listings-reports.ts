/**
 * test:listings-reports — the lead-report half of `/api/v1/listings` (SERVICE-LISTINGS-PLAN L-25,
 * L-29, L-31, § C-3, § C-6): the lead reads, the reveal refund, the block and its lift, and the
 * lead context on a `LISTING_LEAD_REPORT` ticket. DB-free: the route manifest, the permission and
 * audit catalogues, the pure DTO helpers, and source scans across BOTH repositories — the
 * delegation targets are jovi-mall's routes, and a path that drifts on one side fails silently.
 *
 * Run: npm run test:listings-reports
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
import { PERMISSION_CATALOG as PERMISSIONS } from '../../src/modules/authorization/domain/permission.catalog';
import { TIER_GRANTS } from '../../src/modules/authorization/domain/tier-grants';
import { AUDIT_CATALOG as AUDIT_ACTIONS } from '../../src/modules/audit/domain/audit.catalog';
import { routeManifest } from '../../src/api/route-manifest';
import '../../src/modules/listings/routes/listing.routes';
import { revealIdsOf, wantsOf, withheldTicketContext } from '../../src/modules/listings/read-models/listing-lead.dto';
import {
    BlockCustomerSchema,
    LiftBlockSchema,
    RefundRevealSchema,
} from '../../src/modules/listings/validators/listing-reports.validator';

const t = suite('listing reports');

const SRC = resolve(__dirname, '../../src');
const JOVI = resolve(__dirname, '../../../jovi-mall/src');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const code = (root: string, rel: string): string => strip(readFileSync(join(root, rel), 'utf-8'));

const OID = '507f1f77bcf86cd799439011';

// ─── §1 ──────────────────────────────────────────────────────────────────────
t.section('§1 the routes, their permissions and their audit');

const routes = routeManifest().filter((r) => r.fullPath.startsWith('/api/v1/listings'));
const route = (method: string, path: string) => routes.find((r) => r.method === method && r.fullPath === `/api/v1/listings${path}`);
const permsOf = (r: ReturnType<typeof route>) => (r && r.access.kind === 'permission' ? [...r.access.permissions] : []);
const actionsOf = (r: ReturnType<typeof route>): string[] => {
    const a = r?.audit as { kind?: string; actions?: readonly string[] } | null | undefined;
    return a && a.kind === 'records' ? [...(a.actions ?? [])] : [];
};

const TABLE: Array<[string, string, string, string | null]> = [
    ['get', '/leads/:leadId', 'catalog.listings.read', null],
    ['get', '/:listingId/leads', 'catalog.listings.read', null],
    ['post', '/reveals/:revealId/refund', 'catalog.listings.reveals.refund', 'catalog.listings.reveals.refund'],
    ['post', '/:listingId/reveal-blocks/:customerId', 'catalog.listings.reveal-block', 'catalog.listings.reveal_block'],
    ['delete', '/:listingId/reveal-blocks/:customerId', 'catalog.listings.reveal-block', 'catalog.listings.reveal_unblock'],
];
for (const [method, path, perm, audit] of TABLE) {
    t.assert(`${method.toUpperCase()} /api/v1/listings${path} → ${perm}${audit ? ` · records ${audit}` : ' · unaudited read'}`, () => {
        const r = route(method, path);
        if (!r) return false;
        const p = permsOf(r);
        const a = actionsOf(r);
        return p.length === 1 && p[0] === perm && (audit === null ? r.audit === null : a.length === 1 && a[0] === audit);
    });
}
t.assert('⛔ /leads/:leadId is declared BEFORE /:listingId, so "leads" is never read as a listing id', () => {
    const order = routes.map((r) => `${r.method} ${r.fullPath}`);
    return order.indexOf('get /api/v1/listings/leads/:leadId') >= 0
        && order.indexOf('get /api/v1/listings/leads/:leadId') < order.indexOf('get /api/v1/listings/:listingId');
});
t.assert('⛔ every report audit action has a producer now (no catalogued action left producer-less)', () =>
    ['catalog.listings.reveals.refund', 'catalog.listings.reveal_block', 'catalog.listings.reveal_unblock']
        .every((a) => routes.some((r) => actionsOf(r).includes(a))));

// ─── §2 ──────────────────────────────────────────────────────────────────────
t.section('§2 the tiers (O-14): the refund moves credits, the block does not');

const holds = (tier: 1 | 2 | 3, name: string) => (TIER_GRANTS[tier] as readonly string[]).includes(name);
const spec = (name: string) => (PERMISSIONS as unknown as Record<string, { financial?: boolean } | undefined>)[name];
t.assert('catalog.listings.reveals.refund is financial and held by tiers 1 + 2, never Support', () =>
    spec('catalog.listings.reveals.refund')?.financial === true
    && holds(1, 'catalog.listings.reveals.refund') && holds(2, 'catalog.listings.reveals.refund') && !holds(3, 'catalog.listings.reveals.refund'));
t.assert('catalog.listings.reveal-block is held by all three tiers (O-14)', () =>
    [1, 2, 3].every((tier) => holds(tier as 1 | 2 | 3, 'catalog.listings.reveal-block')));
const action = (name: string) => (AUDIT_ACTIONS as unknown as Record<string, { target?: string; transport?: string } | undefined>)[name];
t.assert('the refund audits a listing_reveal; the block and lift audit a listing; all delegated', () =>
    action('catalog.listings.reveals.refund')?.target === 'listing_reveal'
    && action('catalog.listings.reveal_block')?.target === 'listing' && action('catalog.listings.reveal_unblock')?.target === 'listing'
    && ['catalog.listings.reveals.refund', 'catalog.listings.reveal_block', 'catalog.listings.reveal_unblock'].every((a) => action(a)?.transport === 'delegated'));

// ─── §3 ──────────────────────────────────────────────────────────────────────
t.section('§3 ⛔ the delegation targets exist in jovi-mall, with the same bodies');

const gateway = code(SRC, 'modules/listings/gateways/listing-reports.gateway.ts');
const joviRoutes = code(JOVI, 'modules/listings/routes/admin-listing.routes.ts');
const joviInternal = code(JOVI, 'api/routes/internal-admin.routes.ts');
const joviValidators = code(JOVI, 'modules/listings/validators/listing.validator.ts');
t.assert('refund: wi-admin POSTs /listing-reveals/:id/refund; jovi-mall mounts /listing-reveals with POST /:revealId/refund', () =>
    gateway.includes("call('POST', `/listing-reveals/${target.revealId}/refund`")
    && /router\.use\('\/listing-reveals', buildAdminListingRevealRouter\(\[requireAdminCaller\]\)\)/.test(joviInternal)
    && joviRoutes.includes("router.post('/:revealId/refund', AdminListingController.refundReveal)"));
t.assert('block / lift: wi-admin POSTs and DELETEs /listings/:id/reveal-blocks/:customerId; jovi-mall routes both', () =>
    gateway.includes("call('POST', `/listings/${target.listingId}/reveal-blocks/${target.customerId}`")
    && gateway.includes("call('DELETE', `/listings/${target.listingId}/reveal-blocks/${target.customerId}`")
    && joviRoutes.includes("router.post('/:id/reveal-blocks/:customerId', AdminListingController.blockCustomer)")
    && joviRoutes.includes("router.delete('/:id/reveal-blocks/:customerId', AdminListingController.liftBlock)"));
t.assert('jovi-mall accepts what wi-admin sends: refund { ticketId?, note } · block { reason, ticketId? } · lift { note? }', () =>
    /AdminRefundRevealSchema = z\.object\(\{\s*ticketId: ObjectIdSchema\.nullable\(\)\.optional\(\),\s*note: z\.string\(\)\.trim\(\)\.min\(3\)\.max\(500\),/.test(joviValidators)
    && /AdminBlockCustomerSchema = z\.object\(\{\s*reason: z\.string\(\)\.trim\(\)\.min\(3\)\.max\(500\),\s*ticketId: ObjectIdSchema\.nullable\(\)\.optional\(\),/.test(joviValidators)
    && /AdminLiftBlockSchema = z\.object\(\{\s*note: z\.string\(\)\.trim\(\)\.min\(3\)\.max\(500\)\.nullable\(\)\.optional\(\),/.test(joviValidators));
t.assert('wi-admin\'s own bodies are the same shape (note 3–500; reason 3–500; ticket id optional)', () =>
    RefundRevealSchema.safeParse({ note: 'Drain confirmed' }).success
    && !RefundRevealSchema.safeParse({ note: 'no' }).success
    && BlockCustomerSchema.safeParse({ reason: 'Drainer', ticketId: OID }).success
    && LiftBlockSchema.safeParse({}).success);

// ─── §4 ──────────────────────────────────────────────────────────────────────
t.section('§4 the lead on a report ticket');

const ticketCtrl = code(SRC, 'modules/support/controllers/ticket.controller.ts');
t.assert('the ticket detail asks for the lead context ONLY on a LISTING_LEAD ticket, with the caller\'s tier', () =>
    /ticket\.entity_type === 'LISTING_LEAD'\s*\?\s*await ticketLeadContextOf\(ticket\.entity_id, \(ticket\.metadata \?\? null\) as TicketLeadMetadata \| null, identity\.tier\)\s*:\s*null/.test(ticketCtrl));
const ticketRepo = code(SRC, 'modules/support/repositories/ticket.read.repository.ts');
t.assert('metadata is read on the DETAIL projection only, never on the list', () => {
    const list = ticketRepo.slice(ticketRepo.indexOf('const TICKET_LIST_PROJECTION'), ticketRepo.indexOf('const TICKET_DETAIL_PROJECTION'));
    const detail = ticketRepo.slice(ticketRepo.indexOf('const TICKET_DETAIL_PROJECTION'), ticketRepo.indexOf('} as const;', ticketRepo.indexOf('const TICKET_DETAIL_PROJECTION')));
    return !/metadata: 1/.test(list) && /metadata: 1/.test(detail);
});
const meta = { listingId: OID, wants: ['refund', 'bogus', 3], revealIds: [OID, 7] };
t.assert('the metadata is read defensively: known wishes and real ids only, an unknown token dropped', () =>
    wantsOf(meta).join() === 'refund' && revealIdsOf(meta).join() === OID && wantsOf(null).length === 0);
const withheld = withheldTicketContext(OID, meta) as unknown as Record<string, unknown>;
t.assert('⛔ a tier without catalog.listings.read gets ids and wishes, never the customer or the reveals', () =>
    !JSON.stringify(withheld).includes('phone') && !('namedReveals' in withheld && Array.isArray(withheld.namedReveals) && (withheld.namedReveals as unknown[]).length > 0));
const joviTicketValidator = code(JOVI, 'modules/tickets/validators/ticket.validator.ts');
t.assert('⛔ jovi-mall refuses a LISTING_LEAD_REPORT through the generic ticket form (wi-admin\'s create included)', () =>
    /data\.type === 'LISTING_LEAD_REPORT' \|\| data\.entityType === EntityType\.LISTING_LEAD/.test(joviTicketValidator));

process.exit(t.finish());
